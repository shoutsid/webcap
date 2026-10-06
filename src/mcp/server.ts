/**
 * A dependency-free MCP (Model Context Protocol) server core for webcap.
 *
 * The customer is an autonomous agent; the cheapest way for one to actually
 * call webcap is to have it wired as an MCP tool. This module is the pure,
 * transport-free half: the tool table plus JSON-RPC handling. `stdio.ts` is the
 * executable half (newline-delimited JSON-RPC over stdin/stdout).
 *
 * Free tools (preview, OG, service catalog, health, revenue funnel) need no
 * wallet. Paid tools (capture/extract/audit/map-lite/video/analyze) go through
 * the injected `McpHttp`; when the host has no payer wired, the unpaid call's
 * 402 challenge is returned as text so the agent/host can pay with its own
 * x402 client. Nothing here talks to the network, so it is unit-testable.
 *
 * Tool-name readability. mcpmetrics.io scores this exact tool list for how
 * easily an LLM can pick the right tool. Its first audit flagged two names as
 * vague (`webcap_service` — a catalog of what?), flagged `webcap_extract` for
 * not stating that `url` and `urls` are alternatives, flagged the trial tools
 * for not reporting a malformed `signature`, and flagged `maxUrls` for not
 * stating its default. Each of those is a wasted call for an agent, so the
 * names, descriptions and schemas below are written to answer them:
 *
 *   - `webcap_service_catalog` names what it returns (was `webcap_service`);
 *   - every tool documents defaults/bounds where the field has them;
 *   - `webcap_extract` declares `oneOf url|urls` and rejects both;
 *   - a bad `payer`/`signature` fails locally with the exact expected message
 *     instead of spending a round trip on a 401.
 *
 * The same audit flagged overlapping tools, and a wide surface is its own
 * readability problem — every extra tool is another chance to pick wrong. So
 * the list is 8 tools, down from 18, with capability preserved by routing on a
 * mode parameter rather than by adding a name:
 *
 *   - `webcap_service_catalog` absorbs `webcap_health` (the catalog call is the
 *     liveness proof, and it already carries network/asset/payTo);
 *   - `webcap_video` is `webcap_capture` with `format: mp4|webm` (recorded as WebM/VP8);
 *   - `webcap_agent_funnel` and `webcap_feedback` left the tool surface
 *     entirely (operator telemetry and a support rail that no URL-to-artifact
 *     job needs). Both REST routes remain.
 *
 * The free rail is deliberately NOT a tool any more. It used to be the
 * wallet-signed trial rail (`webcap_trial` and four sibling claim tools), which
 * meant an agent had to hold a wallet and produce an EIP-191 signature before
 * it could try anything — the exact friction the charter forbids. Free access
 * is now the rolling per-IP allowance in src/db/allowance.ts: call the real
 * product and it runs free while the window lasts, no signature, no tool of
 * its own.
 *
 * Anything renamed here must be renamed in `src/server/tool-catalog.ts` too —
 * `tests/unit/tool-catalog-agreement.test.ts` pins the two surfaces together.
 */
import { isRecord } from '../server/capture-parse.js';

/** Protocol revision we implement. The client may request another; we echo it. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'webcap';
/**
 * The server version reported in `initialize` and in the registry manifest.
 * Mirrors package.json's version (kept here so the MCP transports do not have
 * to reach into the HTTP service's modules, or read package.json at runtime).
 */
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * The current (stateless) MCP revision. From this revision on, a request
 * declares its version, identity and capabilities in `_meta` instead of doing
 * the `initialize` handshake, `server/discover` is mandatory, and every result
 * carries `resultType: "complete"`. Revisions below it are "legacy".
 */
export const MCP_MODERN_VERSION = '2026-07-28';

/**
 * Every revision this server speaks, newest first. mcpmetrics.io labelled the
 * deployment "Legacy ⚠" because it only answered the `initialize` handshake;
 * `server/discover` + the per-request `_meta` path make it dual-era.
 */
export const MCP_SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** `_meta` keys defined by the 2026-07-28 revision. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export interface McpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The minimal HTTP seam; `stdio.ts` supplies a real (optionally paying) one. */
export interface McpHttp {
  request(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>): Promise<McpResponse>;
}

export interface McpContext {
  readonly baseUrl: string;
  readonly version: string;
  readonly http: McpHttp;
  /** True when a payer wallet is wired; drives paid-tool guidance text. */
  readonly canPay: boolean;
  /**
   * Operator-funded account key (WEBCAP_MCP_API_KEY): when set and no wallet
   * is wired, paid tools bill the credits rail with this Bearer key instead
   * of returning the x402 challenge — the host needs no wallet at all.
   */
  readonly creditKey?: string;
  /**
   * Replaces the default "no payer wallet is configured" advice. Each
   * transport knows its own truth: a local stdio host can set a wallet key,
   * while the public HTTPS endpoint holds no wallet at all and can only tell
   * the caller to pay with its own x402 client.
   */
  readonly noPayerHint?: string;
}

interface ToolRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly free: boolean;
  readonly build: (args: Record<string, unknown>) => ToolRequest;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function required(args: Record<string, unknown>, key: string, tool: string): string {
  const v = str(args, key);
  if (v === undefined) throw new Error(`${tool}: "${key}" must be a non-empty string`);
  return v;
}

/** A non-empty string that must also be an absolute http(s) URL. */
function httpUrl(value: string, label: string, tool: string): string {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${tool}: ${label} must be an absolute http(s) URL (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** The one required `url` argument, validated locally so a typo costs no round trip. */
function requiredUrl(args: Record<string, unknown>, key: string, tool: string): string {
  return httpUrl(required(args, key, tool), `"${key}"`, tool);
}

/**
 * An optional integer argument clamped to [min, max]. Absent (or null) means
 * "use the endpoint default", so it is simply omitted from the request body.
 */
function optionalInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  min: number,
  max: number,
): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(`${tool}: "${key}" must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)})`);
  }
  if (raw < min || raw > max) {
    throw new Error(`${tool}: "${key}" must be between ${min} and ${max} (got ${raw})`);
  }
  return raw;
}

const URL_PROP = {
  url: {
    type: 'string',
    format: 'uri',
    description: 'Absolute http(s) URL of the page to process, e.g. https://example.com/',
  },
} as const;

/** Artifact formats that scroll-record to a video instead of a still. */
const VIDEO_FORMATS = new Set(['mp4', 'webm']);

/** The tool table: one entry per public capability. */
export const TOOLS: readonly ToolDef[] = [
  {
    name: 'webcap_service_catalog',
    description:
      'Free service catalog (no payment): every paid endpoint with its exact price in USDC, the settlement network, USDC asset, payTo address, facilitator and the step-by-step x402 how-to-pay flow, plus the free allowance this caller has left. Call this first to learn what webcap sells and what it costs.',
    inputSchema: { type: 'object', properties: {} },
    free: true,
    build: () => ({ method: 'GET', path: '/v1/x402/service' }),
  },
  {
    name: 'webcap_preview',
    description:
      'Free bounded preview of a page: title, description, headings, links, word count and a truncated markdown slice. Use it to peek before the full extract. Rate-limited per IP. This is a teaser, not the product: the real products are free too inside the rolling per-IP allowance.',
    inputSchema: {
      type: 'object',
      properties: { ...URL_PROP },
      required: ['url'],
    },
    free: true,
    build: (a) => ({
      method: 'GET',
      path: `/v1/extract/preview?url=${encodeURIComponent(requiredUrl(a, 'url', 'webcap_preview'))}`,
    }),
  },
  {
    name: 'webcap_og',
    description: 'Free Open Graph metadata for a URL: title, description, image, icon. No payment.',
    inputSchema: { type: 'object', properties: { ...URL_PROP }, required: ['url'] },
    free: true,
    build: (a) => ({ method: 'GET', path: `/v1/og?url=${encodeURIComponent(requiredUrl(a, 'url', 'webcap_og'))}` }),
  },
  {
    name: 'webcap_capture',
    description:
      'PAID ($0.001 image/PDF, $0.005 video): turn a URL into a persistent public artifact. png/jpeg/pdf are a screenshot or PDF and include free OG metadata; mp4/webm scroll-record the page as WebM/VP8 (mp4 is a legacy alias). Settles gasless USDC over x402 — but an unpaid call runs free while the rolling per-IP allowance lasts, so just call it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...URL_PROP,
        format: {
          type: 'string',
          enum: ['png', 'jpeg', 'pdf', 'mp4', 'webm'],
          default: 'png',
          description:
            'Artifact format, default png. png/jpeg/pdf = screenshot/PDF at $0.001 (POST /v1/x402/capture); mp4/webm = scroll video at $0.005 (POST /v1/x402/video), always recorded as WebM/VP8. The 402 challenge states the exact price for the format you chose.',
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
    free: false,
    build: (a) => {
      const url = requiredUrl(a, 'url', 'webcap_capture');
      const format = str(a, 'format') ?? 'png';
      const isVideo = VIDEO_FORMATS.has(format);
      const durationMs = optionalInt(a, 'durationMs', 'webcap_capture', 1, 30000);
      if (isVideo && a.fullPage !== undefined) {
        throw new Error('webcap_capture: "fullPage" applies to png/jpeg/pdf only; drop it for mp4/webm');
      }
      if (!isVideo && durationMs !== undefined) {
        throw new Error('webcap_capture: "durationMs" applies to mp4/webm only; drop it for png/jpeg/pdf');
      }
      return isVideo
        ? {
            method: 'POST',
            path: '/v1/x402/video',
            body: { url, format, ...(durationMs !== undefined ? { durationMs } : {}) },
          }
        : {
            method: 'POST',
            path: '/v1/x402/capture',
            body: { url, format, ...(typeof a.fullPage === 'boolean' ? { options: { fullPage: a.fullPage } } : {}) },
          };
    },
  },
  {
    name: 'webcap_extract',
    description:
      'PAID ($0.01, one payment covers a batch of up to 50 URLs): structured content as JSON — title, headings, paragraphs, links, images, document-order markdown. Provide exactly one of "url" (a single page) or "urls" (a batch); "url" is shorthand for a one-item "urls".',
    inputSchema: {
      type: 'object',
      // Exactly one target field: `url` is the single-page shorthand for `urls`.
      // Declared so a schema-driven caller cannot synthesise a body with both.
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
    free: false,
    build: (a) => {
      const rawUrls = a.urls;
      if (rawUrls !== undefined && !Array.isArray(rawUrls)) {
        throw new Error('webcap_extract: "urls" must be an array of URL strings');
      }
      const urls = (Array.isArray(rawUrls) ? rawUrls : []).map((u, i) => {
        if (typeof u !== 'string' || u.trim() === '') {
          throw new Error(`webcap_extract: "urls[${i}]" must be a non-empty string`);
        }
        return httpUrl(u.trim(), `"urls[${i}]"`, 'webcap_extract');
      });
      const url = str(a, 'url');
      if (url !== undefined && urls.length > 0) {
        throw new Error(
          'webcap_extract: provide exactly one of "url" (single page) or "urls" (batch), not both',
        );
      }
      if (url === undefined && urls.length === 0) {
        throw new Error('webcap_extract: provide "url" (single page) or "urls" (batch of at most 50)');
      }
      if (urls.length > 50) {
        throw new Error(`webcap_extract: "urls" accepts at most 50 items, got ${urls.length}`);
      }
      return {
        method: 'POST',
        path: '/v1/x402/extract',
        body: {
          ...(url !== undefined ? { url: httpUrl(url, '"url"', 'webcap_extract') } : {}),
          ...(urls.length > 0 ? { urls } : {}),
          ...(str(a, 'schema') !== undefined ? { schema: str(a, 'schema') } : {}),
        },
      };
    },
  },
  {
    name: 'webcap_audit',
    description:
      'PAID ($0.002): SEO basics plus link and Open Graph health for one URL in a single call. Returns issues with severity, not just raw tags.',
    inputSchema: { type: 'object', properties: { ...URL_PROP }, required: ['url'] },
    free: false,
    build: (a) => ({ method: 'POST', path: '/v1/x402/audit', body: { url: requiredUrl(a, 'url', 'webcap_audit') } }),
  },
  {
    name: 'webcap_map_lite',
    description:
      "PAID ($0.002): discover a site's URLs from its sitemap and robots.txt plus a 1-hop same-host crawl, and return them as a JSON list. Cheaper than crawling each page with webcap_extract.",
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
    free: false,
    build: (a) => {
      const maxUrls = optionalInt(a, 'maxUrls', 'webcap_map_lite', 1, 50);
      return {
        method: 'POST',
        path: '/v1/x402/map-lite',
        body: { url: requiredUrl(a, 'url', 'webcap_map_lite'), ...(maxUrls !== undefined ? { maxUrls } : {}) },
      };
    },
  },
  {
    name: 'webcap_analyze',
    description:
      'PAID ($0.01): AI analysis of one URL. Pick the task that matches the question you are answering.',
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
    free: false,
    build: (a) => ({
      method: 'POST',
      path: '/v1/x402/analyze',
      body: { url: requiredUrl(a, 'url', 'webcap_analyze'), task: required(a, 'task', 'webcap_analyze') },
    }),
  },
];

/** JSON-RPC result envelope. */
function result(id: unknown, value: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

/** JSON-RPC error envelope; `data` carries spec payloads such as the supported-version list. */
function error(id: unknown, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** MCP tool result: a single text block, JSON-encoded, plus isError on failure. */
function textResult(value: unknown, isError = false): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** The instructions text shared by `initialize` (legacy) and `server/discover` (modern). */
function serverInstructions(creditMode: boolean): string {
  return (
    'webcap turns a URL into a screenshot, structured JSON, or a page audit, paid per call in USDC over x402. ' +
    'Free tools need nothing; paid tools return a 402 challenge (price, network, payTo) when no wallet is wired. ' +
    'Call webcap_service_catalog to see every endpoint and price.' +
    (creditMode
      ? ' An operator account key is configured: paid tools bill 1 credit each from that balance instead of challenging.'
      : '')
  );
}

/** The `initialize` result: protocol revision (echoed), tools capability, identity. */
export function initializeResult(requestedVersion: unknown, version: string, creditMode = false): unknown {
  const protocolVersion = typeof requestedVersion === 'string' && requestedVersion.trim() !== ''
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version },
    instructions: serverInstructions(creditMode),
  };
}

/**
 * The `server/discover` result (2026-07-28, mandatory for every server): the
 * revisions we speak, our capabilities, our identity and the same instructions
 * `initialize` carries. `ttlMs`/`cacheScope` let a client cache it, since the
 * answer only changes when we deploy.
 */
export function discoverResult(version: string, creditMode = false): unknown {
  return {
    resultType: 'complete',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    instructions: serverInstructions(creditMode),
    _meta: { [META_SERVER_INFO]: { name: MCP_SERVER_NAME, version } },
    ttlMs: 3_600_000,
    cacheScope: 'public',
  };
}

/**
 * The revision a request declares in `params._meta` (2026-07-28 mode). Absent
 * means the caller is using the legacy `initialize` handshake.
 */
function declaredProtocolVersion(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.params)) return undefined;
  const meta = message.params._meta;
  if (!isRecord(meta)) return undefined;
  const raw = meta[META_PROTOCOL_VERSION];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** True when a revision uses the stateless `_meta` form rather than `initialize`. */
function isModernVersion(version: string): boolean {
  return version >= MCP_MODERN_VERSION;
}

/**
 * A modern request may declare its revision in the HTTP `MCP-Protocol-Version`
 * header as well as (or instead of) `params._meta`. Fold the header copy in so
 * the core reads one truth, without overwriting a `_meta` the client sent.
 */
export function declareProtocolVersion(message: unknown, version: string | undefined): unknown {
  if (version === undefined || version.trim() === '' || !isRecord(message)) return message;
  const params = isRecord(message.params) ? message.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  if (meta[META_PROTOCOL_VERSION] !== undefined) return message;
  return { ...message, params: { ...params, _meta: { ...meta, [META_PROTOCOL_VERSION]: version.trim() } } };
}

/** Paid-tool guidance text shown when the unpaid call returns a 402. */
function paymentGuidance(ctx: McpContext, tool: string, status: number, body: unknown): string {
  if (ctx.creditKey !== undefined && !ctx.canPay) {
    return [
      `${tool} is billed to the configured operator account key but the account cannot cover it (HTTP ${status}).`,
      'Fund the account with a plain USDC transfer: POST /v1/invoice names the merchant, token and requiredUsdc; the transfer is credited automatically.',
      'The service response is included below.',
      JSON.stringify(body, null, 2),
    ].join('\n');
  }
  return [
    `${tool} requires payment (HTTP ${status}).`,
    ctx.canPay
      ? 'A payer wallet is configured but the payment was not accepted — see the challenge below (check balance/network).'
      : (ctx.noPayerHint ??
        'No payer wallet is configured for this MCP server. Set WEBCAP_MCP_WALLET_KEY (or X402_CUSTOMER_PRIVATE_KEY) to a funded Base-mainnet USDC key to auto-pay, or pay with your own x402 client.'),
    'The x402 v2 challenge is included below: sign a gasless EIP-3009 transferWithAuthorization for accepts[0] and retry with the PAYMENT-SIGNATURE header.',
    JSON.stringify(body, null, 2),
  ].join('\n');
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null when no
 * response is due (notifications, and anything without an id).
 */
export async function handleRpc(message: unknown, ctx: McpContext): Promise<unknown | null> {
  if (!isRecord(message) || typeof message.method !== 'string') {
    return isRecord(message) && 'id' in message ? error(message.id, -32600, 'invalid request') : null;
  }
  const { method } = message;
  const hasId = 'id' in message;
  const id: unknown = hasId ? message.id : undefined;

  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  const creditMode = ctx.creditKey !== undefined && !ctx.canPay;
  const declared = declaredProtocolVersion(message);

  // A modern request names its revision; an unknown one is refused with the
  // versions we do speak (spec: UnsupportedProtocolVersionError, -32022), so a
  // client can pick one and retry instead of guessing.
  if (declared !== undefined && !(MCP_SUPPORTED_VERSIONS as readonly string[]).includes(declared)) {
    return error(id, -32022, 'Unsupported protocol version', {
      supported: [...MCP_SUPPORTED_VERSIONS],
      requested: declared,
    });
  }
  // Modern results carry `resultType` and the server identity in `_meta`.
  const modern = declared !== undefined && isModernVersion(declared);

  // Wrap a result for the revision the caller declared: modern results add
  // `resultType` and `_meta`, legacy results keep their historical shape.
  const reply = (value: unknown): unknown => {
    if (!modern) return result(id, value);
    const base = isRecord(value) ? value : { value };
    return result(id, {
      resultType: 'complete',
      ...base,
      _meta: {
        ...(isRecord(base._meta) ? base._meta : {}),
        [META_SERVER_INFO]: { name: MCP_SERVER_NAME, version: ctx.version },
      },
    });
  };

  switch (method) {
    case 'initialize':
      return reply(initializeResult(isRecord(message.params) ? message.params.protocolVersion : undefined, ctx.version, creditMode));
    case 'server/discover':
      return result(id, discoverResult(ctx.version, creditMode));
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const params = isRecord(message.params) ? message.params : {};
      const name = params.name;
      if (typeof name !== 'string') return error(id, -32602, 'tools/call: "name" is required');
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return error(id, -32602, `unknown tool: ${name}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      let req: ToolRequest;
      try {
        req = tool.build(args);
      } catch (err) {
        return reply(textResult(err instanceof Error ? err.message : String(err), true));
      }
      // Credit mode: no wallet, but an operator-funded account key — bill the
      // credits rail (same path minus the /x402 segment) with the Bearer key
      // instead of answering the x402 challenge. Free tools pass through.
      const billedToCredits = !tool.free && !ctx.canPay && ctx.creditKey !== undefined;
      const path = billedToCredits ? req.path.replace('/v1/x402/', '/v1/') : req.path;
      const headers = billedToCredits && ctx.creditKey !== undefined ? { authorization: `Bearer ${ctx.creditKey}` } : undefined;
      try {
        const res = await ctx.http.request(req.method, path, req.body, headers);
        if (res.status === 402 && !tool.free) {
          return reply(textResult(paymentGuidance(ctx, tool.name, res.status, res.body)));
        }
        if (res.status >= 400) {
          return reply(textResult({ status: res.status, body: res.body }, true));
        }
        return reply(textResult(res.body));
      } catch (err) {
        return reply(textResult(`webcap request failed: ${err instanceof Error ? err.message : String(err)}`, true));
      }
    }
    default:
      return hasId ? error(id, -32601, `method not found: ${method}`) : null;
  }
}
