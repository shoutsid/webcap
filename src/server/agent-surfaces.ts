/**
 * The agent-facing discovery surfaces: GET /llms.txt (the llms.txt convention
 * document, so LLM agents that crawl well-known files find webcap) and
 * GET /skill.md (an installable agent skill file teaching the x402 flow).
 *
 * Both routes are free, unauthenticated, and static per deployment: the only
 * interpolated values come from config (base URL, x402 network/asset/payTo,
 * facilitator URL, the price points, and the priceUsdcUnits examples).
 * Everything else is literal prose — keep it in sync with the live routes
 * (src/server/routes.ts, src/server/watches.ts) and the config defaults
 * (DEFAULT_X402_PRICE_USDC_UNITS = $0.001,
 * DEFAULT_X402_EXTRACT_PRICE_USDC_UNITS = $0.01).
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USDC_SCALE, watchTopUpPriceUsdcUnits, type WebcapConfig } from '../config.js';
import { loadMppConfig, realmOf } from '../mpp/config.js';

/**
 * The repo-root agent guide (GET /AGENT.md), advertised by the front-door
 * `agentGuide` label. Resolved dist-relative so both layouts work: in dev
 * (tsx src/) it is the repo root file, in prod (node dist/) the copy that
 * scripts/copy-assets.mjs places next to dist/. The repo file carries a
 * `<webcap-url>` placeholder; it is interpolated to this deployment. A
 * missing file serves a pointer, never a 500 — same rule as the MPP block.
 */
function agentGuideText(publicBaseUrl: string): string {
  // NOTE (necessary): nearest-first dual lookup — prod serves from dist/
  // (one level up), dev from the repo root (two levels up). A single path
  // silently serves the fallback in one layout while passing tests in the other.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, '..', 'AGENT.md'), resolve(here, '..', '..', 'AGENT.md')]) {
    try {
      return readFileSync(candidate, 'utf8').replaceAll('<webcap-url>', publicBaseUrl);
    } catch {
      continue;
    }
  }
  return `# webcap agent guide\n\nThe full guide failed to load on this deployment. Use ${publicBaseUrl}/skill.md instead.\n`;
}

/**
 * Register the agent-facing discovery routes: GET /llms.txt and GET /skill.md.
 * Both are free (no x402 challenge, no auth) and served as text/markdown.
 *
 * MPP is advertised in both documents only when this deployment enables it
 * (MPP_SECRET_KEY set), so x402-only deployments keep a truthful story. A
 * malformed key is ignored here — the MPP plugin fails the boot before this
 * matters, and a discovery document must never 500.
 */
export function registerAgentSurfaces(app: FastifyInstance, config: WebcapConfig): void {
  const mppEnabled = mppEnabledFor(config);
  app.get('/llms.txt', async (_req, reply) => {
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(llmsTxt(config, mppEnabled));
  });

  app.get('/skill.md', async (_req, reply) => {
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(skillMd(config, mppEnabled));
  });

  const guide = agentGuideText(config.publicBaseUrl);
  app.get('/AGENT.md', async (_req, reply) => {
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return reply.send(guide);
  });
}

/** True when MPP_SECRET_KEY enables the second payment rail on this deployment. */
function mppEnabledFor(config: WebcapConfig): boolean {
  try {
    return loadMppConfig(process.env, config.publicBaseUrl, config.chainId).enabled;
  } catch {
    return false;
  }
}

/** Atomic 6-decimal USDC units → "$X.YYY" (1000 → "$0.001", 1000000 → "$1"). */
function usdc(units: number): string {
  return `$${units / USDC_SCALE}`;
}

/** Bare host for the MPP realm line; falls back to the configured base URL. */
function mppRealm(config: WebcapConfig): string {
  try {
    return realmOf(config.publicBaseUrl);
  } catch {
    return config.publicBaseUrl;
  }
}

/**
 * llms.txt MPP paragraph: '' when MPP is disabled, else a `\n## `-prefixed
 * section so the surrounding template's newlines render a clean block.
 */
function mppBlockLlms(config: WebcapConfig, mppEnabled: boolean): string {
  if (!mppEnabled) return '';
  return `\n## Paying with MPP (optional second rail)

Every paid route also answers the unpaid 402 with a \`WWW-Authenticate: Payment\` challenge (Machine Payments Protocol, method="evm", realm = ${mppRealm(config)}) priced identically to the x402 \`accepts[0]\` terms — same amount, same USDC asset, same merchant wallet, same network. If your stack speaks MPP rather than x402, read that header and charge the same gasless EIP-3009 authorization through your MPP client. Deployments without MPP_SECRET_KEY are x402-only.
`;
}

/** skill.md MPP section: '' when MPP is disabled, else a `\n## `-prefixed section. */
function mppBlockSkill(config: WebcapConfig, mppEnabled: boolean): string {
  if (!mppEnabled) return '';
  return `\n## Paying with MPP (optional)

If your stack speaks MPP instead of x402, read the 402's \`WWW-Authenticate: Payment\` header (method="evm", intent="charge", realm = ${mppRealm(config)}): it prices the identical USDC terms as \`accepts[0]\` on the same network and merchant wallet, so sign the same gasless EIP-3009 authorization and settle it through your MPP client. This deployment has MPP enabled; deployments without MPP_SECRET_KEY are x402-only.
`;
}

/** The llms.txt convention document (https://llmstxt.org) for this deployment. */
function llmsTxt(config: WebcapConfig, mppEnabled = false): string {
  return `# webcap — pay-per-call web capture

webcap turns any URL into a screenshot (PNG/JPEG/PDF) or structured text/JSON,
paid per call in USDC over x402 (HTTP 402). No API keys, no accounts: any EOA
holding USDC can pay, gaslessly — the payer signs an EIP-3009
transferWithAuthorization and the CDP facilitator verifies and settles it
on-chain. You pay USDC only, never ETH gas.

## Deployment

- Base URL: ${config.publicBaseUrl}
- Network: USDC on Base — ${config.x402Network ?? 'x402 disabled in this deployment'}
- USDC asset: ${config.x402Asset}
- Pay-to (merchant wallet): ${config.x402PayTo}
- Facilitator: ${config.x402FacilitatorUrl} (x402 v2 "exact" scheme)
- Service descriptor: ${config.publicBaseUrl}/v1/x402/service (JSON catalog with bazaar extension)
- OpenAPI 3.1: ${config.publicBaseUrl}/openapi.json
- Agent skill file: ${config.publicBaseUrl}/skill.md

## Paid endpoints (x402)

| Method + path | Price | Returns |
| --- | --- | --- |
| POST /v1/x402/capture | ${usdc(config.x402PriceUsdcUnits)} | Screenshot of one URL: base64 image (png/jpeg/pdf) + persistent public artifact URL |
| POST /v1/x402/extract | ${usdc(config.x402ExtractPriceUsdcUnits)} | Structured content (title, headings, paragraphs, links, images, markdown) from the page's main content — nav/cookie/sidebar/footer excluded; one payment covers a batch of up to 50 URLs |
| POST /v1/x402/audit | ${usdc(config.x402AuditPriceUsdcUnits)} | SEO basics + link/OG health in one call (title, description, OG tags, link health) |
| POST /v1/x402/map-lite | ${usdc(config.x402AuditPriceUsdcUnits)} | Site map in one call: URL list from sitemap/robots plus a 1-hop same-host crawl (maxUrls up to 50, default 20) |
| POST /v1/x402/video | ${usdc(config.x402VideoPriceUsdcUnits)} | Scroll-capture of one URL as WebM/VP8 video: base64 artifact (format "mp4" is a legacy alias — the artifact is always video/webm) |
| POST /v1/x402/analyze | ${usdc(config.x402ExtractPriceUsdcUnits)} | AI-powered visual analysis: classification, accessibility, layout, entities, sentiment |
| POST /v1/x402/analyze/batch | ${usdc(config.x402ExtractPriceUsdcUnits)} | Batch AI analysis (up to 10 URLs, one payment) |
| POST /v1/x402/watches/topup | ${usdc(watchTopUpPriceUsdcUnits('capture', config))}–${usdc(watchTopUpPriceUsdcUnits('extract', config))} | 100 scheduled re-capture runs for an existing watch (capture watch ${usdc(watchTopUpPriceUsdcUnits('capture', config))}, extract watch ${usdc(watchTopUpPriceUsdcUnits('extract', config))}) |

## Paid endpoints (credits rail, bearer token)

The same products are buyable without a signing key: register once
(POST /v1/register {"address"} → {apiKey}), fund with a plain USDC transfer
(POST /v1/invoice → {merchant, token, requiredUsdc}), then send
"Authorization: Bearer <apiKey>". Every call costs 1 credit and the charge is
refunded whenever the call does not return 200; an empty balance answers 402
with a 1-credit top-up invoice. Full spec: ${config.publicBaseUrl}/openapi.json
(tags: accounts).

| Method + path | Returns |
| --- | --- |
| POST /v1/extract | per-URL results + {creditsCharged, balance} |
| POST /v1/audit | audit report + {creditsCharged, balance} |
| POST /v1/map-lite | same-host URL list + {creditsCharged, balance} |
| POST /v1/video | video artifact + {creditsCharged, balance} |
| POST /v1/analyze | {task, result} + {creditsCharged, balance} |
| POST /v1/analyze/batch | per-URL results + {creditsCharged, balance} |
| POST /v1/watches/{id}/topup | +100 watch runs: capture pack 10 credits, extract pack 100 (x402-pack parity) |

### Request / response shapes

POST /v1/x402/capture
    {"url": "https://example.com", "format": "png"}   // format: png | jpeg | pdf (default: png)
    // options?: {"timeoutMs", "fullPage", "viewport": {"width", "height"}, "deviceScaleFactor", "isMobile", "userAgent", "stealth": true, "proxy", "waitFor", "actions", "maxContentWords", "auth": {"headers": {"authorization": "Bearer …"}, "cookies": [{"name", "value", "domain"?}]}}
  200 {"artifact": {"format": "png", "bytes": 123, "data": "<base64>", "url": "<base>/v1/artifacts/<uuid>"},
       "payment": {"payer": "0x…", "priceUsdcUnits": ${config.x402PriceUsdcUnits}}}

POST /v1/x402/extract
    {"url": "https://example.com"}                    // or "urls": string[] (up to 50) in one payment
    {"url": "https://example.com", "schema": "JSON with the fields: title, price"}  // optional schema-constrained extraction
  200 {"results": [{"url": "…", "status": "ok", "data": {"title": "…", "headings": […], "paragraphs": […], "links": […], "images": […], "markdown": "…"}}],
       "payment": {"payer": "0x…", "priceUsdcUnits": ${config.x402ExtractPriceUsdcUnits}}}

POST /v1/x402/map-lite
    {"url": "https://example.com"}                    // optional "maxUrls": 1–50 (default 20)
  200 {"urls": ["https://example.com/", "https://example.com/about"],
       "payment": {"payer": "0x…", "priceUsdcUnits": ${config.x402AuditPriceUsdcUnits}}}

POST /v1/x402/video
    {"url": "https://example.com", "format": "webm"}   // format: mp4 | webm (default webm; mp4 is a legacy alias — recordings are always WebM/VP8)
    // options?: {"durationMs" (default 5000, at most 30000), "scrollSpeed" (default 800, at most 5000), "scrollEasing": "linear" | "ease-in-out", "viewport": {"width", "height"}, "auth"?: {"headers", "cookies"} (logged-in recordings), "stealth"?, "locale"?, "timezoneId"?}
  200 {"artifact": {"mime": "video/webm", "bytes": 1048576, "data": "<base64>"},
       "payment": {"payer": "0x…", "priceUsdcUnits": ${config.x402VideoPriceUsdcUnits}}}

POST /v1/x402/analyze
    {"url": "https://example.com", "task": "classification"}   // task: classification | accessibility | layout | entities | sentiment
    // optional "context": "focus on product pricing"
  200 {"task": "classification", "result": {"category": "e-commerce", "confidence": 0.92, "tags": ["shopping", "retail"]},
       "payment": {"payer": "0x…", "priceUsdcUnits": 10000}, "latency_ms": 1234}

POST /v1/x402/analyze/batch
    {"urls": ["https://a.com", "https://b.com"], "task": "classification"}   // up to 10 URLs, one payment
  200 {"results": [{"url": "…", "status": "ok", "result": {"category": "article", "confidence": 0.88}}],
       "task": "classification", "payment": {"payer": "0x…", "priceUsdcUnits": 10000}}

POST /v1/x402/watches/topup
    {"watchId": "<id from POST /v1/watches>", "runs": 100}
  200 {"watchId": "…", "credits": 100, "priceUsdcUnits": ${watchTopUpPriceUsdcUnits('capture', config)}}

## Free endpoints (no payment)

- **Rolling free allowance — the products are free, no wallet needed.** An unpaid POST to any product path (capture, extract, audit, map-lite, video, analyze) runs the real product and returns it. You get a window of free calls per caller IP; every response carries x-webcap-allowance-limit, x-webcap-allowance-remaining, x-webcap-allowance-cost, x-webcap-allowance-window-seconds and x-webcap-allowance-granted, so you always know where you stand. When the window is spent the same call answers the normal x402 402 challenge — pay and retry. No signature, no account, no API key. A free extract batch is capped (10 URLs); a single URL is not, and one paid call still covers up to 50. A call that fails does not consume your allowance.
- GET /v1/extract/preview?url=… — bounded structured preview (title, headings, links, truncated markdown); rate-limited per IP. A teaser: the real products are free inside the allowance above, so call those instead.
- GET /v1/x402/service — the machine catalog: every paid endpoint with its exact price, the network, USDC asset, payTo, facilitator and the how-to-pay flow.
- Tool manifests for framework wiring: ${config.publicBaseUrl}/.well-known/openai-tools.json (OpenAI functions shape) and ${config.publicBaseUrl}/.well-known/mcp-tools.json (MCP tools/list shape + the HTTPS endpoint per tool). Agent card (A2A v1.0): ${config.publicBaseUrl}/.well-known/agent-card.json.
- Remote MCP endpoint (no install, no package, no account): POST ${config.publicBaseUrl}/mcp — Streamable HTTP, JSON-RPC 2.0 (initialize, tools/list, tools/call). Point an MCP host at it: {"mcpServers":{"webcap":{"url":"${config.publicBaseUrl}/mcp"}}}. Free tools run directly; this endpoint holds no wallet, so a paid tool call returns the live x402 402 challenge for you to settle with your own client.
- GET /v1/og?url=… — Open Graph metadata (title, description, image, icon)
- POST /v1/watches — create a scheduled re-capture watch (free; starts with 0 credits — top up via /v1/x402/watches/topup)
- GET /v1/watches/:id — watch state + recent runs · DELETE /v1/watches/:id — remove it
- GET /v1/health — liveness + chain info
- POST /v1/feedback — tell webcap something as an agent or human (message 8-4000 chars required; optional category bug|suggestion|pricing|docs|integration|other and the endpoint you were using). No account, rate-limited per client (60/hr), hashed payer. Human form: GET /feedback.

## Paying: minimal x402 flow

1. POST the endpoint unpaid → HTTP 402 with the x402 v2 challenge (JSON body, mirrored base64-encoded in the PAYMENT-REQUIRED header).
2. Read accepts[0] from the challenge ({ network, asset, amount, payTo, extra }) and sign a gasless EIP-3009 transferWithAuthorization: from = your EOA, to = payTo, value = amount (atomic 6-decimal USDC units), with the EIP-712 domain of the USDC contract (name/version from extra, chainId from network, verifyingContract = asset).
3. Retry the identical request with the header PAYMENT-SIGNATURE: <base64 payment payload>.
4. The facilitator verifies and settles on-chain; the 200 response carries the result plus a PAYMENT-RESPONSE settlement header (transaction hash, payer, amount).

Every paid path answers the challenge for GET as well as POST, and both are payable: POST takes the JSON body documented below, GET takes the same parameters in the query string (\`GET /v1/x402/map-lite?url=…&maxUrls=5\`, \`GET /v1/x402/extract?url=…&options={"maxContentWords":800}\`) — numeric and boolean parameters arrive typed, and arrays/objects are JSON-encoded, so the query stands in for the body. The challenge is advertised per method, so sign the challenge you were actually given and retry that same method: a payload signed for a POST is rejected on a GET (the bazaar extension echoes the request method).

Any x402 v2 client does steps 1–3 for you (e.g. @x402/axios with wrapAxiosWithPayment) — a ready-to-paste example lives in ${config.publicBaseUrl}/skill.md.
${mppBlockLlms(config, mppEnabled)}
## Spend caps

Deployments may cap spend per payer (x402, atomic USDC units) or per account
(credits rail) via WEBCAP_SPEND_CAP_USDC_UNITS / WEBCAP_SPEND_CAP_CREDITS. Past
the cap, paid submits answer 429 spend_cap_exceeded with detail {payer, spent,
cap, reason}. Unset means unlimited: a cap that isn't configured can never block.

## URL safety (SSRF)

Targets pass a static allowlist guard. Blocked hosts 422 with
detail {reason, dnsRebindingCaveat: true}, so a policy block is distinguishable
from a malformed URL. The guard's own caveat, quoted from the source:

> NOTE: this is a static (parse-time) guard only. DNS rebinding — a hostname
> that resolves publicly here but to a private IP at fetch time — is a
> documented residual risk and must be re-checked where the actual fetch
> happens. Do not add async DNS resolution to this function.

## Async capture + signed artifacts

POST /v1/capture/jobs {"url", "format"?, "webhookUrl"?} charges once and
returns 202 {jobId, status}. Poll GET /v1/capture/jobs/{id} (free, no auth)
until completed|failed; terminal states carry the payment receipt (payer,
priceUsdcUnits, plus creditsUsed/costUsdcUnits where applicable). An optional
https webhookUrl gets the terminal delivery. Artifact URLs accept signed query
?exp=&sig= (HMAC-SHA256 over "<id>.<exp>"): bad signatures 403, expired ones
410; unsigned fetches still serve.

## Extraction notes

One extract payment covers the whole batch (up to 50 URLs). Asking again costs
again: the price stays flat per batch while compute scales per URL.

What comes back is the page's main content, not the whole document: navigation,
cookie banners, sidebars and footers are excluded from "paragraphs" and
"markdown", and the response's "content" field says which container was used,
how many words it holds, and whether a budget cut it short. Size the output to
your context window with "options": {"maxContentWords": N}.

A JSON
object schema takes the deterministic path (zero model calls, no model needed):
the response data gains an "extracted" projection of the page structure, and
optional "spans" [{field, quote, page}] ground each quote as a verbatim
markdown substring. Object-schema failures 422 with dollar-rooted detail
strings (schema mismatch, ungrounded spans, or unsupported keywords
oneOf/anyOf/allOf/$ref/format).
`;
}

/** The installable agent skill file (YAML frontmatter + usage instructions). */
function skillMd(config: WebcapConfig, mppEnabled = false): string {
  return `---
name: webcap
description: Pay-per-call web capture API — a PNG/JPEG/PDF screenshot or structured JSON from any URL, paid gaslessly in USDC on Base via x402 (HTTP 402).
---

# webcap — pay-per-call web capture

webcap converts any URL into a screenshot artifact (PNG/JPEG/PDF) or
structured text/JSON. Every paid call settles on-chain in USDC via x402
(x402 v2 "exact" scheme, HTTP 402): the request is answered with a 402
challenge, you sign a gasless EIP-3009 transferWithAuthorization from your
wallet, and retry with the PAYMENT-SIGNATURE header. The CDP facilitator
verifies and settles — your wallet pays USDC only, no gas. No API keys, no
accounts.

## When to use

- Screenshot: PNG/JPEG/PDF of a live page, with a persistent public artifact URL.
- Structured data: title, headings, paragraphs, links, images, markdown — or schema-constrained extraction (natural-language \`schema\` field; model-backed when the deployment has a model configured).
- Monitoring: scheduled re-capture (watches at 15m/1h/6h/24h) with change detection, run history, and an optional webhook.

## Endpoints and prices

Base URL: ${config.publicBaseUrl}

| Purpose | Request | Price (USDC) |
| --- | --- | --- |
| Screenshot | POST /v1/x402/capture {"url", "format"?, "options"? (viewport, deviceScaleFactor, isMobile, userAgent, stealth, auth {headers, cookies} for logged-in pages)} | ${usdc(config.x402PriceUsdcUnits)} |
| Extract (batch of up to 50 URLs, one payment) | POST /v1/x402/extract {"url" or "urls", "schema"?, "options": {"maxContentWords"?, "auth"? {headers, cookies}, "stealth"?}} | ${usdc(config.x402ExtractPriceUsdcUnits)} |
| Audit (SEO + OG + link health, one URL) | POST /v1/x402/audit {"url"} | ${usdc(config.x402AuditPriceUsdcUnits)} |
| Map-lite (site URL list, one call) | POST /v1/x402/map-lite {"url", "maxUrls"? (default 20, at most 50)} | ${usdc(config.x402AuditPriceUsdcUnits)} |
| Video (scroll-capture WebM/VP8, one URL) | POST /v1/x402/video {"url", "format"?, "durationMs"?, "scrollSpeed"?, "scrollEasing"?, "options"? (viewport, auth {headers, cookies} for logged-in recordings, stealth, locale, timezoneId)} | ${usdc(config.x402VideoPriceUsdcUnits)} |
| Analyze (AI visual analysis, one URL) | POST /v1/x402/analyze {"url", "task"} where task: classification\|accessibility\|layout\|entities\|sentiment | ${usdc(config.x402ExtractPriceUsdcUnits)} |
| Analyze batch (up to 10 URLs, one payment) | POST /v1/x402/analyze/batch {"urls": string[], "task"} | ${usdc(config.x402ExtractPriceUsdcUnits)} |
| Watch top-up (100 runs) | POST /v1/x402/watches/topup {"watchId", "runs": 100} | ${usdc(watchTopUpPriceUsdcUnits('capture', config))} (capture watch) / ${usdc(watchTopUpPriceUsdcUnits('extract', config))} (extract watch) |
| Structured preview (truncated) | GET /v1/extract/preview?url=… | free, rate-limited per IP |
| Any product, inside your allowance | POST /v1/x402/{capture,extract,audit,map-lite,video,analyze} with no payment header | free while the rolling per-IP window lasts, then the same call 402s; state in x-webcap-allowance-* headers. Free extract batches cap at 10 URLs |
| OG metadata | GET /v1/og?url=… | free |
| Feedback (agent) | POST /v1/feedback {"message": "…", "category"?:"bug|suggestion|pricing|docs|integration|other", "endpoint"?:"POST /v1/x402/capture"} | free, rate-limited per client (60/hr); payer hashed; human form at GET /feedback |
| Bearer-token rail (no signing key): register once, fund with a USDC transfer, then call with "Authorization: Bearer \<key\>" | POST /v1/register {"address"} → {apiKey}; POST /v1/invoice → {merchant, token, requiredUsdc}; then POST /v1/extract, POST /v1/audit, POST /v1/map-lite, POST /v1/video, POST /v1/analyze, POST /v1/analyze/batch, POST /v1/watches/{id}/topup (100-run pack) | 1 credit/call, watch packs at x402 parity, refunded on non-200; empty balance 402s with a top-up invoice |

Machine-readable catalog: ${config.publicBaseUrl}/v1/x402/service · Full spec: ${config.publicBaseUrl}/openapi.json · Tool manifests: ${config.publicBaseUrl}/.well-known/openai-tools.json + ${config.publicBaseUrl}/.well-known/mcp-tools.json · Agent card: ${config.publicBaseUrl}/.well-known/agent-card.json

Remote MCP endpoint (no install): POST ${config.publicBaseUrl}/mcp — Streamable HTTP, JSON-RPC 2.0 (initialize, tools/list, tools/call). Free tools run there directly; the endpoint holds no wallet, so a paid tool returns the x402 402 challenge for your own client to settle.

## Quick start (Node.js, @x402/axios)

\`\`\`js
import axios from 'axios';
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, wrapAxiosWithPayment } from '@x402/axios';
import { privateKeyToAccount } from 'viem/accounts';

const BASE = '${config.publicBaseUrl}';
const account = privateKeyToAccount(process.env.WALLET_KEY); // EOA holding USDC on Base
const client = new x402Client().register('${config.x402Network ?? 'eip155:8453'}', new ExactEvmScheme(account));
const api = wrapAxiosWithPayment(axios.create({ baseURL: BASE }), client);

// Screenshot — on 402 the client signs and retries for you (${usdc(config.x402PriceUsdcUnits)})
const shot = await api.post('/v1/x402/capture', { url: 'https://example.com', format: 'png' });
const pngBase64 = shot.data.artifact.data;
const artifactUrl = shot.data.artifact.url; // persistent, shareable

// Extract — one ${usdc(config.x402ExtractPriceUsdcUnits)} payment covers up to 50 urls
const page = await api.post('/v1/x402/extract', { url: 'https://example.com' });
const { title, headings, paragraphs, links, images } = page.data.results[0].data;
\`\`\`

## Raw EIP-3009 (no client library)

1. POST the endpoint with the JSON body → HTTP 402 challenge (JSON body; base64 in the PAYMENT-REQUIRED header).
2. Sign TransferWithAuthorization (EIP-712): from = your EOA, to = the challenge payTo, value = accepts[0].amount, nonce + validAfter/validBefore per EIP-3009; domain = the USDC contract (name + version from accepts[0].extra, chainId = the numeric suffix of accepts[0].network — eip155:8453 → 8453, verifyingContract = accepts[0].asset).
3. Retry the identical request with header PAYMENT-SIGNATURE: <base64 payment payload> (authorization + signature).

Every paid path answers that challenge for GET as well as POST and both are payable: POST
takes the JSON body, GET takes the same parameters in the query string
(\`GET ${config.publicBaseUrl}/v1/x402/map-lite?url=https://example.com&maxUrls=5\`), with numbers
and booleans typed on the wire and arrays/objects JSON-encoded. The challenge is advertised per
method — sign the challenge you were actually given and retry that same method, since a payload
signed for a POST is rejected on a GET.

${mppBlockSkill(config, mppEnabled)}
## Free preview (no wallet, no payment)

GET ${config.publicBaseUrl}/v1/extract/preview?url=https://example.com returns a truncated
structured preview (title, headings, links, a markdown slice) and is
rate-limited per IP — use it to peek at a page before paying; the paid
extract returns the full text plus images, batches, and optional model
extraction.

## Free allowance (no wallet, no signature, no account)

Every product is free inside a rolling per-IP window. POST any product path
without a payment header and the real product runs:

  capture   POST ${config.publicBaseUrl}/v1/x402/capture   {"url", "format"?: png|jpeg|pdf|mp4|webm, "fullPage"?, "durationMs"?}
  extract   POST ${config.publicBaseUrl}/v1/x402/extract   {"url"} or {"urls": [...]} (free batches cap at 10 URLs)
  audit     POST ${config.publicBaseUrl}/v1/x402/audit     {"url"}
  map-lite  POST ${config.publicBaseUrl}/v1/x402/map-lite  {"url", "maxUrls"?}
  video     POST ${config.publicBaseUrl}/v1/x402/video     {"url", "format"?: mp4|webm, "durationMs"?}
  analyze   POST ${config.publicBaseUrl}/v1/x402/analyze   {"url", "task"}

Every response states where you stand, in headers you can read without parsing
the body:

  x-webcap-allowance-limit             free calls in this window
  x-webcap-allowance-remaining         calls left after this one
  x-webcap-allowance-cost             units this call consumed (a batch costs its URL count)
  x-webcap-allowance-window-seconds    the length of the window
  x-webcap-allowance-granted           true when this call was free

It is a sliding window, not a daily reset, so the budget frees up continuously.
When it is spent the same call answers the normal x402 402 challenge — pay it
and retry; nothing else about the request changes. A call that fails (4xx/5xx)
does NOT consume your allowance, so a bad URL costs you nothing.

There is no menu to check and no signature to produce: just call the product.
GET ${config.publicBaseUrl}/v1/x402/service lists every paid endpoint with its
price and the how-to-pay flow for when the window runs out.

## Failure modes

- 402 again after retry: the authorization was rejected (wrong amount, payTo, network, signature, or expiry window) — fetch a fresh challenge and sign it again. On the credits rail / jobs submit, 402 means insufficient_credits and the detail names the 1-credit top-up invoice {invoiceId, requiredUsdc, balance}.
- 429 spend-cap exceeded: detail {payer, spent, cap, reason} (code spend_cap_exceeded; WEBCAP_SPEND_CAP_USDC_UNITS on x402, WEBCAP_SPEND_CAP_CREDITS on the credits rail; unset means unlimited) — wait for the window or raise the cap, retrying the same payment won't help.
- 429 on the free preview: rate-limited — the 429 body's detail.paidUpgrade carries the paid next-step (endpoint POST /v1/x402/extract, price, howToPay, skill guide); wait a minute, or pay for extract.
- 422 on blocked hosts: detail {reason, dnsRebindingCaveat: true} marks the SSRF policy block. Parse-time guard only: DNS rebinding (public here, private at fetch time) is a documented residual risk.
- 502: the upstream page capture failed — nothing is charged when capture fails; retry later.

## Async capture + signed artifacts

For slow pages, submit once and poll: POST /v1/capture/jobs
{"url", "format"?, "webhookUrl"?} returns 202 {jobId, status}; GET
/v1/capture/jobs/{id} is free without auth and ends in completed (with
result.artifactUrl) or failed (with error), always carrying the payment receipt
(payer, priceUsdcUnits, creditsUsed/costUsdcUnits where applicable). Share the
artifact with a signed URL (?exp=&sig=, HMAC-SHA256 over "<id>.<exp>"): bad
signatures 403, expired ones 410.

## Extraction notes

One payment covers the whole batch (up to 50 URLs); each re-run bills again
because compute scales per URL while the price stays flat.

The output is the page's main content, not the whole document — nav, cookie
banners, sidebars and footers are excluded from paragraphs/markdown, so you are
not paying context for chrome. Check "content": {source, words, truncated} to
see what was kept, and pass "options": {"maxContentWords": N} to fit a page to
your context window (it cuts at a block boundary and sets truncated: true).

A JSON object schema
skips the model entirely (deterministic, zero model calls): you get an
"extracted" projection plus optional "spans" grounding, and any mismatch 422s
with dollar-rooted detail strings.
`;
}
