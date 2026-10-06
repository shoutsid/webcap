/**
 * The canonical agent tool catalog: one list of every capability an agent can
 * call, free or paid.
 *
 * Why this file exists. Before it, webcap published three tool catalogs that
 * barely overlapped:
 *
 *   - `/.well-known/openai-tools.json` and `/.well-known/mcp-tools.json` listed
 *     9 tools, all free, and not one paid product;
 *   - the MCP server's tool table listed 11 tools, including all 6 paid
 *     products and no trial.
 *
 * Their intersection was two tools. So an agent that wired webcap from a
 * manifest learned that we sell nothing, and an MCP host never learned that the
 * free trial rail exists. That is the exact failure the charter's rule 2
 * describes: a surface that lies to an agent costs a real call, and a crawler
 * that reads manifests is a customer's first impression.
 *
 * The membership, schemas and endpoints now live here once. `openaiTools` and
 * `mcpTools` are both derived from it, and
 * `tests/unit/tool-catalog-agreement.test.ts` pins the MCP server's own tool
 * table to the same names and the same parameter shapes, so the surfaces cannot
 * drift apart again.
 *
 * Condensation (18 tools -> 8) and the free rail. mcpmetrics scored the tool
 * list for how easily an LLM picks the right tool and flagged overlapping
 * functionality. A wide surface is itself a readability problem: every extra
 * tool is another chance to pick wrong. So capabilities that differ only by a
 * mode became one tool with a mode parameter, capabilities nothing else needs
 * are gone, and the free rail stopped being a tool at all:
 *
 *   - `webcap_health`         -> folded into `webcap_service_catalog` (the
 *                                catalog call is the liveness proof, and it
 *                                already carries network/asset/payTo);
 *   - `webcap_quick_thumbnail`-> gone; the free allowance serves the real
 *                                capture instead, so a teaser thumbnail is moot;
 *   - `webcap_video`          -> folded into `webcap_capture` via `format`;
 *   - the wallet-signed trial rail (`webcap_trial` + 4 more claim tools) ->
 *     GONE. Free access is now the rolling per-IP allowance, which is not a
 *     tool: an agent calls the real product and it is free while the window
 *     lasts. See src/db/allowance.ts and src/server/allowance-gate.ts. Removing
 *     the rail also removed the last reason for a caller to hold a wallet just
 *     to evaluate the service;
 *   - `webcap_feedback`       -> dropped from the TOOL surface. It is not part
 *                                of turning a URL into an artifact or data, so
 *                                it is noise in the agent's choice set; the
 *                                REST rail at POST /v1/feedback is unchanged.
 *
 * Every remaining tool answers a distinct question, and nothing a caller could
 * do before is unreachable now.
 */
import { USDC_SCALE, type WebcapConfig } from '../config.js';

export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly free: boolean;
  readonly method: 'GET' | 'POST';
  /** REST path. GET forms carry their query string, so the path is callable as written. */
  readonly path: string;
  readonly inputSchema: Record<string, unknown>;
  /** Atomic 6-decimal USDC units, paid tools only. */
  readonly priceUsdcUnits?: number;
}

const URL_PROP = {
  url: {
    type: 'string',
    format: 'uri',
    description: 'Absolute http(s) URL of the page to process, e.g. https://example.com/',
  },
} as const;

/** Atomic 6-decimal USDC units as the prose price used in every description. */
function usd(units: number): string {
  return `$${(units / USDC_SCALE).toString()}`;
}

/** Paid tools settle per call in USDC over x402; the price is stated in prose. */
function paidPrefix(units: number): string {
  return `PAID (${usd(units)}): `;
}

/**
 * Every agent-callable capability, in surface order: free discovery and the
 * then the paid products. Free calls are not a tool: see the allowance.
 */
export function serviceTools(config: WebcapConfig): readonly CatalogTool[] {
  const capture = config.x402PriceUsdcUnits;
  const extract = config.x402ExtractPriceUsdcUnits;
  const audit = config.x402AuditPriceUsdcUnits;
  const video = config.x402VideoPriceUsdcUnits;
  return [
    // --- free: discovery (the free rail is the rolling allowance, not a tool) ---
    {
      name: 'webcap_service_catalog',
      description:
        `Free service catalog (no payment): every paid endpoint with its exact price in USDC, the settlement network, USDC asset, payTo address, facilitator and the step-by-step x402 how-to-pay flow, plus the free allowance this caller has left. Call this first to learn what webcap sells and what it costs.`,
      free: true,
      method: 'GET',
      path: '/v1/x402/service',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'webcap_preview',
      description:
        'Free bounded preview of a page: title, description, headings, links, word count and a truncated markdown slice. Use it to peek before the full extract. Rate-limited per IP. This is a teaser, not the product: the real products are free too inside the rolling per-IP allowance.',
      free: true,
      method: 'GET',
      path: '/v1/extract/preview?url=...',
      inputSchema: { type: 'object', properties: { ...URL_PROP }, required: ['url'] },
    },
    {
      name: 'webcap_og',
      description: 'Free Open Graph metadata for a URL: title, description, image, icon. No payment.',
      free: true,
      method: 'GET',
      path: '/v1/og?url=...',
      inputSchema: { type: 'object', properties: { ...URL_PROP }, required: ['url'] },
    },
    // --- paid: the products ---
    {
      name: 'webcap_capture',
      description:
        `${paidPrefix(capture)}turn a URL into a persistent public artifact. Image/PDF formats (png, jpeg, pdf) are ${usd(capture)} and include free OG metadata; video formats (mp4, webm) are ${usd(video)} and scroll-record the page as WebM/VP8. Settles gasless USDC over x402 — but an unpaid call runs free while the rolling per-IP allowance lasts, so just call it.`,
      free: false,
      method: 'POST',
      path: '/v1/x402/capture',
      priceUsdcUnits: capture,
      inputSchema: {
        type: 'object',
        properties: {
          ...URL_PROP,
          format: {
            type: 'string',
            enum: ['png', 'jpeg', 'pdf', 'mp4', 'webm'],
            default: 'png',
            description:
              `Artifact format, default png. png/jpeg/pdf = screenshot/PDF at ${usd(capture)} (POST /v1/x402/capture); mp4/webm = scroll video at ${usd(video)} (POST /v1/x402/video), always recorded as WebM/VP8 (mp4 is a legacy alias). The 402 challenge states the exact price for the format you chose.`,
          },
          fullPage: {
            type: 'boolean',
            default: false,
            description: 'Image/PDF only. true captures the whole scrollable page (default false: viewport only).',
          },
          durationMs: {
            type: 'integer',
            minimum: 1,
            maximum: 30000,
            default: 5000,
            description: 'Video formats only. Scroll duration in milliseconds, 1-30000; default 5000.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'webcap_extract',
      description:
        `${paidPrefix(extract)}structured content as JSON: title, headings, paragraphs, links, images, document-order markdown. One payment covers a batch of up to 50 URLs. Provide exactly one of "url" (single page) or "urls" (batch).`,
      free: false,
      method: 'POST',
      path: '/v1/x402/extract',
      priceUsdcUnits: extract,
      inputSchema: {
        type: 'object',
        // Exactly one target field: `url` is the single-page shorthand for `urls`.
        oneOf: [{ required: ['url'] }, { required: ['urls'] }],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description:
              'A single page to extract, e.g. https://example.com/. Shorthand for "urls": ["<url>"]. Mutually exclusive with "urls" — sending both is an error.',
          },
          urls: {
            type: 'array',
            items: { type: 'string', format: 'uri' },
            maxItems: 50,
            description:
              'Batch of pages for one payment, at most 50 items; a batch of one is allowed. Mutually exclusive with "url" — sending both is an error.',
          },
          schema: {
            type: 'string',
            description:
              'Optional natural-language description of the JSON to extract. Omit it to get the default page structure.',
          },
        },
      },
    },
    {
      name: 'webcap_audit',
      description: `${paidPrefix(audit)}SEO basics plus link and Open Graph health for one URL in a single call. Returns issues with severity, not just raw tags.`,
      free: false,
      method: 'POST',
      path: '/v1/x402/audit',
      priceUsdcUnits: audit,
      inputSchema: { type: 'object', properties: { ...URL_PROP }, required: ['url'] },
    },
    {
      name: 'webcap_map_lite',
      description: `${paidPrefix(audit)}discover a site's URLs from its sitemap and robots.txt plus a 1-hop same-host crawl, and return them as a JSON list. Cheaper than crawling each page with webcap_extract.`,
      free: false,
      method: 'POST',
      path: '/v1/x402/map-lite',
      priceUsdcUnits: audit,
      inputSchema: {
        type: 'object',
        properties: {
          ...URL_PROP,
          maxUrls: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            default: 20,
            description: 'Maximum number of URLs to return. Integer 1-50; default 20 when omitted.',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'webcap_analyze',
      description: `${paidPrefix(extract)}AI analysis of one URL. Pick the task that matches the question you are answering.`,
      free: false,
      method: 'POST',
      path: '/v1/x402/analyze',
      priceUsdcUnits: extract,
      inputSchema: {
        type: 'object',
        properties: {
          ...URL_PROP,
          task: {
            type: 'string',
            enum: ['classification', 'accessibility', 'layout', 'entities', 'sentiment'],
            description:
              'What to analyze (required, no default): classification = page type, accessibility = a11y issues, layout = structure and regions, entities = named entities and facts, sentiment = tone.',
          },
        },
        required: ['url', 'task'],
      },
    },
  ];
}

/** The names every tool surface must expose, for the agreement test. */
export function catalogToolNames(config: WebcapConfig): readonly string[] {
  return serviceTools(config).map((t) => t.name);
}