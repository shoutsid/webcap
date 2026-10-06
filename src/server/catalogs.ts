/**
 * Discovery catalog payload builders: the x402 well-known catalog, the A2A
 * agent card, the JSON front-door payload, and the sitemap. Pure functions of
 * WebcapConfig (no Fastify); served by the routes in ./discovery.ts.
 */
import { USDC_SCALE, WATCH_TOPUP_RUNS, watchTopUpPriceUsdcUnits, type ChainName, type WebcapConfig } from '../config.js';
import { MCP_SERVER_VERSION } from '../mcp/server.js';
import { ownershipProof } from './openapi/ownership.js';
import { serviceTools } from './tool-catalog.js';

/** Public paths advertised in the sitemap (the stable service surface). */
const SITEMAP_PATHS = [
  '/',
  '/openapi.json',
  '/icon.png',
  '/v1/x402/service',
  '/v1/x402/capture',
  '/v1/x402/extract',
  '/v1/x402/audit',
  '/v1/x402/map-lite',
  '/v1/x402/video',
  '/v1/x402/analyze',
  '/v1/x402/analyze/batch',
  '/v1/x402/watches/topup',
  '/v1/watches',
  '/v1/extract/preview',
  '/og-debugger',
  '/compare',
  '/transparency',
  '/feedback',
] as const;

/** XML-escape a value before embedding it in the sitemap (fixed list, stay correct). */
function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The sitemap must be protocol-absolute https, even for an http:// dev base URL. */
function httpsBase(base: string): string {
  return base.startsWith('http://') ? `https://${base.slice('http://'.length)}` : base;
}

/** Build the sitemap.xml payload: one <url> per public path, https-absolute. */
export function sitemapXml(config: WebcapConfig): string {
  const base = httpsBase(config.publicBaseUrl);
  const entries = SITEMAP_PATHS.map(
    (path) => `  <url>\n    <loc>${xmlEscape(`${base}${path}`)}</loc>\n  </url>`,
  ).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
    '',
  ].join('\n');
}

/** The chain phrase of the well-known catalog description, per configured chain (compiler-checked exhaustive). */
const CHAIN_COPY: Record<ChainName, string> = {
  base: 'Base mainnet',
  'base-sepolia': 'Base Sepolia (testnet)',
  local: 'a local Anvil dev chain',
};

/** x402 machine-discovery catalog: what to call, what it costs, how to pay. */
export async function x402WellKnown(config: WebcapConfig) {
  const base = httpsBase(config.publicBaseUrl);
  const ownershipProofs = await ownershipProof(config.publicBaseUrl, config.merchantPrivateKey);
  return {
    service: 'webcap',
    description: `Pay-per-call web capture on ${CHAIN_COPY[config.chain.name]}: one-time screenshots (PNG/JPEG/PDF + free Open Graph metadata), structured content extraction, and scheduled monitoring with change-detection webhooks. All paid routes settle gasless USDC via x402 (HTTP 402).`,
    network: config.x402Network ?? null,
    asset: config.x402Network === undefined ? null : config.x402Asset,
    payTo: config.x402Network === undefined ? null : config.x402PayTo,
    facilitator: config.x402FacilitatorUrl,
    endpoints: [
      {
        path: 'POST /v1/x402/capture',
        usdc: config.x402PriceUsdcUnits / USDC_SCALE,
        description: 'Screenshot any URL (PNG/JPEG/PDF) + free Open Graph metadata',
      },
      {
        path: 'POST /v1/x402/extract',
        usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE,
        description:
          'Structured extraction of the main content (title, headings, paragraphs, links, images, document-order markdown; nav/cookie/sidebar/footer excluded; optional maxContentWords budget); batch up to 50 URLs per payment',
      },
      {
        path: 'POST /v1/x402/audit',
        usdc: config.x402AuditPriceUsdcUnits / USDC_SCALE,
        description: 'SEO basics + link/OG health in one call (title, description, OG tags, link health)',
      },
      {
        path: 'POST /v1/x402/map-lite',
        usdc: config.x402AuditPriceUsdcUnits / USDC_SCALE,
        description: 'Map a site to its URL list via sitemap/robots plus a 1-hop same-host crawl in one call',
      },
      {
        path: 'POST /v1/x402/video',
        usdc: config.x402VideoPriceUsdcUnits / USDC_SCALE,
        description: 'Scroll-capture a URL as a WebM/VP8 video in one call',
      },
      {
        path: 'POST /v1/x402/analyze',
        usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE,
        description: 'AI-powered visual analysis: classification, accessibility, layout, entities, sentiment',
      },
      {
        path: 'POST /v1/x402/analyze/batch',
        usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE,
        description: 'Batch AI analysis of up to 10 URLs under one payment',
      },
      {
        path: 'POST /v1/x402/watches/topup',
        usdc:
          watchTopUpPriceUsdcUnits('capture', config) / USDC_SCALE,
        usdcMax: watchTopUpPriceUsdcUnits('extract', config) / USDC_SCALE,
        description: `Pre-pay ${WATCH_TOPUP_RUNS} scheduled monitor runs (capture-pack price shown; extract-pack is usdcMax; exact price quoted per watch via ?watchId=)`,
      },
    ],
    free: [
      { path: 'GET /v1/extract/preview?url=...', note: 'bounded structured preview (rate-limited)' },
      { path: 'GET /v1/og?url=...', note: 'Open Graph metadata' },
      { path: 'GET /v1/health', note: 'liveness + chain' },
      {
        path: 'POST /v1/x402/{capture,extract,audit,map-lite,video,analyze}',
        note: 'rolling free allowance: no wallet needed — an unpaid call runs the product free until the per-IP window is spent, then the same call answers the 402 challenge (X-Webcap-Allowance-* headers say where you stand)',
      },
      { path: 'POST /v1/feedback', note: 'free feedback for agents and humans (message required; rate-limited 60/hr)' },
    ],
    openapi: `${base}/openapi.json`,
    sitemap: `${base}/sitemap.xml`,
    // x402scan verified-ownership; omitted entirely when unsigned.
    ...(ownershipProofs.length > 0 ? { ownershipProofs } : {}),
  };
}

/** A2A v1.0 agent card with x402 payments info, for agent-card consumers. */
export async function agentCard(config: WebcapConfig) {
  const base = httpsBase(config.publicBaseUrl);
  const paid = (id: string, name: string, description: string, tags: string[]) => ({ id, name, description, tags });
  return {
    protocolVersion: '1.0',
    name: 'webcap',
    description: (await x402WellKnown(config)).description,
    // Compat: v0.x readers use top-level url; v1.0 readers use supportedInterfaces[0].
    url: base,
    supportedInterfaces: [{ url: base, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    iconUrl: `${base}/icon.png`,
    // The agent's own version, which is the service version: /v1/status,
    // MCP initialize and the npm package all report this same number, and a
    // card that disagrees with the service is a surface that lies.
    version: MCP_SERVER_VERSION,
    provider: { organization: 'webcap', url: 'https://github.com/shoutsid-lab/webcap' },
    documentationUrl: `${base}/skill.md`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    securitySchemes: {
      x402: { type: 'http', scheme: 'x402', description: 'Paid endpoints answer HTTP 402 with an x402 v2 challenge; retry with the PAYMENT-SIGNATURE header after a gasless EIP-3009 USDC signature.' },
    },
    skills: [
      paid(
        'free-allowance',
        'Free product calls (no wallet, no USDC)',
        'Every product is free inside a rolling per-IP allowance: POST /v1/x402/capture, /extract, /audit, /map-lite, /video or /analyze with no payment header runs the real product and returns X-Webcap-Allowance-* headers; once the window is spent the same call answers the x402 402 challenge. No signature, no account. The catalog (GET /v1/x402/service) lists every paid endpoint with its price and how to pay.',
        ['free', 'allowance', 'screenshot', 'extraction', 'audit', 'sitemap', 'analysis'],
      ),
      paid(
        'preview',
        'Free structured preview',
        'Bounded title/headings/links/markdown preview, rate-limited per IP: GET /v1/extract/preview?url=…. Free OG metadata: GET /v1/og?url=….',
        ['free', 'preview', 'scraping', 'extraction', 'opengraph'],
      ),
      paid(
        'capture',
        'Web capture',
        `Screenshot any URL as PNG/JPEG/PDF + free OG metadata — ${config.x402PriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['screenshot', 'capture', 'x402', 'usdc'],
      ),
      paid(
        'extract',
        'Structured extraction',
        `Main content only (nav/cookie/sidebar/footer excluded): title, headings, paragraphs, links, images, document-order markdown, with an optional maxContentWords context budget; batch up to 50 URLs — ${config.x402ExtractPriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['scraping', 'extraction', 'markdown', 'x402', 'usdc'],
      ),
      paid(
        'audit',
        'SEO audit',
        `SEO basics + link/OG health in one call — ${config.x402AuditPriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['seo', 'audit', 'links', 'opengraph', 'x402', 'usdc'],
      ),
      paid(
        'map-lite',
        'Site mapping',
        `Sitemap/robots + 1-hop same-host crawl URL list in one call — ${config.x402AuditPriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['sitemap', 'crawl', 'mapping', 'x402', 'usdc'],
      ),
      paid(
        'video',
        'Video capture',
        `Scroll-capture a URL as a WebM/VP8 video — ${config.x402VideoPriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['video', 'capture', 'x402', 'usdc'],
      ),
      paid(
        'analyze',
        'Visual analysis',
        `AI-powered page analysis: classification, accessibility, entities, sentiment — ${config.x402ExtractPriceUsdcUnits / USDC_SCALE} USDC via x402`,
        ['ai', 'analysis', 'classification', 'accessibility', 'x402', 'usdc'],
      ),
      paid(
        'watch',
        'Scheduled monitoring',
        `Pre-pay ${WATCH_TOPUP_RUNS} runs of a capture/extract monitor with change-detection webhooks — ${watchTopUpPriceUsdcUnits('capture', config) / USDC_SCALE}–${watchTopUpPriceUsdcUnits('extract', config) / USDC_SCALE} USDC per pack via x402`,
        ['monitoring', 'diff', 'webhook', 'x402', 'usdc'],
      ),
    ],
    // webcap extensions (non-A2A): payment + auth-scheme detail for x402 clients.
    authentication: { schemes: ['x402'] },
    payments: {
      provider: 'x402',
      network: config.x402Network ?? null,
      asset: config.x402Network === undefined ? null : config.x402Asset,
      payTo: config.x402Network === undefined ? null : config.x402PayTo,
      facilitator: config.x402FacilitatorUrl,
    },
  };
}

/**
 * Prompt-friendly tool definitions (OpenAI functions shape) for copy-paste agent
 * wiring. Derived from the canonical catalog, so it lists every capability an
 * agent can call — free and paid — instead of hiding the products we sell.
 */
export function openaiTools(config: WebcapConfig) {
  const base = httpsBase(config.publicBaseUrl);
  return {
    format: 'openai-functions',
    name: 'webcap',
    baseUrl: base,
    openapi: `${base}/openapi.json`,
    skill: `${base}/skill.md`,
    tools: serviceTools(config).map((t) => ({
      type: 'function',
      endpoint: { method: t.method, path: t.path },
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  };
}

/** Tool-router-friendly manifest (MCP tools/list shape + the HTTPS endpoint each tool maps to). */
export function mcpTools(config: WebcapConfig) {
  const base = httpsBase(config.publicBaseUrl);
  const tools = openaiTools(config).tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters,
    endpoint: t.endpoint,
  }));
  return {
    format: 'mcp-tools-list',
    server: { name: 'webcap', version: MCP_SERVER_VERSION, url: base, openapi: `${base}/openapi.json`, skill: `${base}/skill.md` },
    // The remote transport, so a host that speaks MCP can wire webcap with no
    // install: point it at this URL and it gets the same tool set as the
    // npm/stdio server. It holds no wallet, so paid tools answer the 402
    // challenge for the caller to settle with its own x402 client.
    mcp: {
      transport: 'streamable-http',
      url: `${base}/mcp`,
      method: 'POST',
      note: 'JSON-RPC 2.0 (initialize, tools/list, tools/call). No install, no session, no API key. Paid tool calls return the x402 402 challenge.',
    },
    payment: 'Paid endpoints settle gasless USDC via x402 (HTTP 402); every 409/402 response carries a paidNext pointer.',
    tools,
  };
}

/**
 * The MCP server descriptor at GET /.well-known/mcp.json.
 *
 * Requested by registry crawlers, notably BrickBlueBot (agentic-web registry),
 * which probed this exact path six times and got a 404: it reads descriptor
 * files to learn where a service's MCP endpoint is, instead of only guessing
 * endpoint paths. There is no ratified schema for this path, so this document
 * carries the fields such a reader needs and nothing it would have to
 * interpret: the transport and its URL, how authentication and payment work,
 * and pointers to the tool manifest and the registry listing. The tool list
 * itself is by reference on purpose, so there is one place it can drift.
 */
export function mcpDescriptor(config: WebcapConfig) {
  const base = httpsBase(config.publicBaseUrl);
  return {
    name: 'webcap',
    title: 'webcap',
    version: MCP_SERVER_VERSION,
    description: 'Screenshot, extract or audit any URL, paid per call in USDC over x402.',
    transports: [{ type: 'streamable-http', url: `${base}/mcp`, method: 'POST' }],
    authentication: {
      type: 'none',
      note: 'Free tools need no credential, account or API key. Paid tools settle per call over x402.',
    },
    payment:
      config.x402Network === undefined
        ? { protocol: 'x402', enabled: false, note: 'x402 disabled on this deployment' }
        : {
            protocol: 'x402',
            network: config.x402Network,
            asset: config.x402Asset,
            payTo: config.x402PayTo,
            note: 'HTTP 402 carries the challenge; the caller signs a gasless EIP-3009 authorization and retries.',
          },
    tools: `${base}/.well-known/mcp-tools.json`,
    openapi: `${base}/openapi.json`,
    skill: `${base}/skill.md`,
    registry: {
      name: 'io.github.shoutsid-lab/webcap',
      discovery: 'https://registry.modelcontextprotocol.io/v0/servers?search=webcap',
    },
  };
}

/** The JSON front-door payload, unchanged byte-for-byte for pure-JSON clients. */
export function frontDoorPayload(config: WebcapConfig) {
  return {
    service: 'webcap',
    tagline:
      'Capture any URL as a screenshot, or extract its structured content + clean document-order markdown — paid per-request in USDC over x402 (HTTP 402).',
    endpoints: {
      free: [
        { path: 'GET /v1/extract/preview?url=...', note: 'bounded structured preview (rate-limited)' },
        { path: 'GET /v1/og?url=...', note: 'OG metadata' },
        { path: 'GET /v1/health', note: 'liveness + chain' },
        {
          path: 'POST /v1/x402/{capture,extract,audit,map-lite,video,analyze}',
          note: 'rolling free allowance: no wallet needed — an unpaid call runs the product free until the per-IP window is spent, then the same call answers the 402 challenge (X-Webcap-Allowance-* headers say where you stand)',
        },
        { path: 'POST /v1/feedback', note: 'free feedback channel (#bug #suggestion #pricing #docs #integration); human form at GET /feedback' },
      ],
      paid: [
        { path: 'POST /v1/x402/capture', usdc: config.x402PriceUsdcUnits / USDC_SCALE, note: 'PNG/JPEG/PDF screenshot + free OG' },
        { path: 'POST /v1/x402/extract', usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE, note: 'structured JSON; batch up to 50 URLs for one payment' },
        { path: 'POST /v1/x402/audit', usdc: config.x402AuditPriceUsdcUnits / USDC_SCALE, note: 'SEO basics + link/OG health in one call' },
        { path: 'POST /v1/x402/map-lite', usdc: config.x402AuditPriceUsdcUnits / USDC_SCALE, note: 'site URL list via sitemap/robots plus a 1-hop same-host crawl' },
        { path: 'POST /v1/x402/video', usdc: config.x402VideoPriceUsdcUnits / USDC_SCALE, note: 'scroll-capture WebM/VP8 video in one call' },
        { path: 'POST /v1/x402/analyze', usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE, note: 'AI visual analysis: classification, accessibility, entities, sentiment' },
        { path: 'POST /v1/x402/analyze/batch', usdc: config.x402ExtractPriceUsdcUnits / USDC_SCALE, note: 'batch AI analysis of up to 10 URLs for one payment' },
      ],
    },
    catalog: 'GET /v1/x402/service — full agent-discoverable descriptor + the exact x402 payment flow',
    agentGuide: 'AGENT.md — how an AI agent discovers + pays (gasless EIP-3009, no ETH)',
    payment:
      config.x402Network === undefined
        ? 'x402 disabled (WEBCAP_CHAIN=local)'
        : `x402 v2 on ${config.x402Network}, asset ${config.x402Asset}, payTo ${config.x402PayTo}`,
  };
}
