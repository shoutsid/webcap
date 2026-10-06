/**
 * The credits-rail (API-key account) path docs: POST /v1/register,
 * POST /v1/invoice, POST /v1/capture, the credit-metered products
 * (POST /v1/extract, /v1/audit, /v1/map-lite, /v1/video, /v1/analyze,
 * /v1/analyze/batch), the credit-metered watch top-up
 * (POST /v1/watches/{id}/topup), GET /v1/ledger, GET /v1/account —
 * plus GET /v1/og, which sits between /v1/ledger and /v1/account in the
 * original table and stays here so the key order (and thus the generated
 * JSON) is byte-identical. Split out of openapi.ts as a pure move (no
 * behavior change).
 */
import { CAPTURE_COST_CREDITS, PRODUCT_CREDIT_COST, WATCH_CREDIT_TOPUP_COST_CAPTURE, WATCH_TOPUP_RUNS, usdcForCredits, type WebcapConfig } from '../../config.js';
import {
  auditCreditResponse,
  auditRequestBody,
  captureCreditResponse,
  captureRequestBody,
  extractCreditResponse,
  extractRequestBody,
  mapLiteCreditResponse,
  mapLiteRequestBody,
  videoCreditResponse,
  videoRequestBody,
} from './schemas.js';
import { jsonContent, jsonError, type PathContext } from './shared.js';
import type { OpenapiPaths } from './types.js';

/** The credits-rail path docs (the last six paths of the table). */
export function accountPaths(config: WebcapConfig, ctx: PathContext): OpenapiPaths {
  return {
    '/v1/register': {
      post: {
        tags: ['accounts'],
        summary: 'Register a wallet and mint an API key (free, no auth)',
        description:
          'Idempotent per address: an existing account gets a fresh API key instead of a duplicate account. ' +
          'No payment: buy credits via POST /v1/invoice, or skip accounts entirely and pay per call over x402.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['address'],
                properties: {
                  address: { type: 'string', description: 'Ethereum address (hex, checksummed or not)' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Registered; {address, apiKey, balance}',
            content: jsonContent({
              type: 'object',
              properties: {
                address: { type: 'string' },
                apiKey: { type: 'string', description: 'Send as "Authorization: Bearer <key>" on subsequent requests' },
                balance: { type: 'integer', example: 0 },
              },
            }),
          },
          422: ctx.unprocessable('Missing or invalid address'),
        },
        security: [],
      },
    },
    '/v1/invoice': {
      post: {
        tags: ['accounts'],
        summary: 'Create a USDC credit invoice (manual ERC-20 transfer)',
        description:
          `Buy credits as USDC sent from your own wallet to the merchant address: the invoice names the token, the ` +
          `recipient, and the required amount for the chosen credit amount (neither field = 100 credits; a named ` +
          `pack — starter 100, pro 1000, max 10000 — selects the amount instead). Packs bill the nominal ` +
          `$0.01/credit rate on this rail (the card-pack prices on /buy do not apply to USDC transfers); the ` +
          `response always states the exact requiredUsdc. The API-key alternative to x402's per-call payment.`,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  credits: { type: 'integer', description: 'Credits to buy (default 100; not with pack)', example: 100 },
                  pack: { type: 'string', enum: ['starter', 'pro', 'max'], description: 'Named pack: starter 100, pro 1000, max 10000 credits (not with credits)', example: 'pro' },
                },
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Created; the USDC transfer details',
            content: jsonContent({
              type: 'object',
              properties: {
                invoiceId: { type: 'string' },
                merchant: { type: 'string', description: 'Send the USDC to this address' },
                token: { type: 'string', description: 'USDC ERC-20 contract' },
                chainId: { type: 'integer', example: config.chain.chainId },
                requiredUsdc: { type: 'number', example: usdcForCredits(100) },
                credits: { type: 'integer', example: 100 },
                pack: { type: 'string', description: 'Pack name for the amount (starter, pro, max) or custom', example: 'custom' },
                expiresAt: { type: 'string' },
              },
            }),
          },
          401: ctx.unauthorized,
          422: ctx.unprocessable('credits must be a positive integer, pack must be one of starter/pro/max, never both'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/capture': {
      post: {
        tags: ['accounts'],
        summary: `Capture a URL as a screenshot (paid, ${CAPTURE_COST_CREDITS} credit per call)`,
        description:
          'The credit-metered front door: charges 1 credit per capture (refunded when the capture fails). ' +
          'Prefer the x402 route for gasless USDC payment without an account.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: captureRequestBody } },
        },
        responses: {
          200: { description: 'The artifact (base64) + its canonical public URL, plus the credit charge and remaining balance', content: jsonContent(captureCreditResponse) },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url, format or options. SSRF-blocked hosts 422 with detail {reason, dnsRebindingCaveat: true}'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; detail {payer, spent, cap, reason}; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
          502: ctx.captureFailed,
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/extract': {
      post: {
        tags: ['accounts'],
        summary: `Extract structured content, single URL or batch (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered extract: same compute as POST /v1/x402/extract (deterministic structure, optional model schema, batch up to 50 URLs) for a bearer token instead of a signature. 1 credit per call, refunded when the call does not return 200.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: extractRequestBody } },
        },
        responses: {
          200: { description: 'Per-URL results (ok/error), plus the credit charge and remaining balance', content: jsonContent(extractCreditResponse) },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url(s), schema, or spans'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
          502: jsonError('502', 'All URLs in the batch failed to extract (error envelope, code extract_failed; the credit is refunded)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/audit': {
      post: {
        tags: ['accounts'],
        summary: `Audit a URL for SEO, OG tags, and link health (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered audit: same compute as POST /v1/x402/audit for a bearer token instead of a signature. 1 credit per call, refunded when the call does not return 200.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: auditRequestBody } },
        },
        responses: {
          200: { description: 'The audit report, plus the credit charge and remaining balance', content: jsonContent(auditCreditResponse) },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
          502: jsonError('502', 'Audit failed for the URL (error envelope, code audit_failed; the credit is refunded)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/map-lite': {
      post: {
        tags: ['accounts'],
        summary: `Map a site to a same-host URL list (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered map-lite: same compute as POST /v1/x402/map-lite (sitemap/robots plus a 1-hop crawl, maxUrls up to 50) for a bearer token instead of a signature. 1 credit per call, refunded when the call does not return 200.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: mapLiteRequestBody } },
        },
        responses: {
          200: { description: 'Discovered same-host URLs, plus the credit charge and remaining balance', content: jsonContent(mapLiteCreditResponse) },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url or maxUrls'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/video': {
      post: {
        tags: ['accounts'],
        summary: `Scroll-capture a page as video (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered video: same compute as POST /v1/x402/video (WebM/VP8 scroll-capture; the artifact is always video/webm) for a bearer token instead of a signature. 1 credit per call, refunded when the call does not return 200 (including 429 video-busy).',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: videoRequestBody } },
        },
        responses: {
          200: { description: 'The video artifact (base64, no persistent URL), plus the credit charge and remaining balance', content: jsonContent(videoCreditResponse) },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url, format, or recording options'),
          429: jsonError('429', 'Recorder busy or per-account spend cap exceeded (error envelope; the credit is refunded on recorder-busy)'),
          502: jsonError('502', 'Video capture failed (error envelope, code video_failed; the credit is refunded)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/analyze': {
      post: {
        tags: ['accounts'],
        summary: `AI-powered visual analysis of a page (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered analyze: same compute as POST /v1/x402/analyze (vision model when configured, deterministic DOM fallback otherwise) for a bearer token instead of a signature. 1 credit per call, refunded when the call does not return 200.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url', 'task'],
                properties: {
                  url: { type: 'string', format: 'uri', description: 'URL to analyze' },
                  task: { type: 'string', enum: ['classification', 'accessibility', 'layout', 'entities', 'sentiment'], description: 'Analysis task type' },
                  context: { type: 'string', description: 'Optional context for the analysis' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Analysis result (mode: "model" or "deterministic"), plus the credit charge and remaining balance',
            content: jsonContent({
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Analysis task performed' },
                result: { type: 'object', description: 'Task-specific result' },
                creditsCharged: { type: 'integer', example: PRODUCT_CREDIT_COST },
                balance: { type: 'integer', description: 'Credits remaining after the charge' },
                latency_ms: { type: 'number', description: 'Analysis latency in milliseconds' },
              },
            }),
          },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid url or task'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
          502: jsonError('502', 'Capture or analysis failed (error envelope; the credit is refunded)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/analyze/batch': {
      post: {
        tags: ['accounts'],
        summary: `Batch AI-powered visual analysis (paid, ${PRODUCT_CREDIT_COST} credit per call)`,
        description:
          'The credit-metered analyze batch: same compute as POST /v1/x402/analyze/batch (up to 10 URLs, one task) for a bearer token instead of a signature. 1 credit covers the whole batch, refunded when the call does not return 200.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['urls', 'task'],
                properties: {
                  urls: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 10, description: 'URLs to analyze (max 10)' },
                  task: { type: 'string', enum: ['classification', 'accessibility', 'layout', 'entities', 'sentiment'], description: 'Analysis task type' },
                  context: { type: 'string', description: 'Optional context for the analysis' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Per-URL analysis results, plus the credit charge and remaining balance',
            content: jsonContent({
              type: 'object',
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      url: { type: 'string' },
                      status: { type: 'string', enum: ['ok', 'error'] },
                      result: { type: 'object' },
                      error: { type: 'string' },
                    },
                  },
                },
                task: { type: 'string' },
                creditsCharged: { type: 'integer', example: PRODUCT_CREDIT_COST },
                balance: { type: 'integer', description: 'Credits remaining after the charge' },
              },
            }),
          },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the 1-credit top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          422: ctx.unprocessable('Invalid input: missing/invalid urls or task'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
          502: jsonError('502', 'All URLs in the batch failed to analyze (error envelope, code analysis_failed; the credit is refunded)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/watches/{id}/topup': {
      post: {
        tags: ['accounts'],
        summary: 'Top up a watch with a 100-run pack from account credits (Bearer auth)',
        description:
          'The credit-metered watch top-up: the same 100-run pack as POST /v1/x402/watches/topup, paid from the account credit balance instead of a signature. Capture-mode packs cost 10 credits ($0.10 nominal), extract-mode packs 100 credits ($1.00 nominal) — x402-pack parity. The charge is refunded if the watch vanishes mid-call.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
            description: 'Watch ID from POST /v1/watches',
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['runs'],
                properties: {
                  runs: { type: 'integer', enum: [WATCH_TOPUP_RUNS], description: `Pack size in runs (always ${WATCH_TOPUP_RUNS})` },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Watch funded; watch credit balance plus the account charge and remaining balance',
            content: jsonContent({
              type: 'object',
              properties: {
                watchId: { type: 'string' },
                credits: { type: 'integer', description: 'The watch credit balance after the top-up (pre-paid runs)' },
                creditsCharged: { type: 'integer', example: WATCH_CREDIT_TOPUP_COST_CAPTURE },
                balance: { type: 'integer', description: 'Account credits remaining after the charge' },
              },
            }),
          },
          401: ctx.unauthorized,
          402: jsonError('402', 'Insufficient credits; the error detail carries the pack-sized top-up invoice {invoiceId, requiredUsdc, balance} (error envelope, code insufficient_credits)'),
          404: jsonError('404', 'Watch not found (error envelope, code not_found; nothing is charged)'),
          422: ctx.unprocessable('Invalid input: missing id or runs is not exactly 100 (nothing is charged)'),
          429: jsonError('429', 'Per-account spend cap exceeded (error envelope, code spend_cap_exceeded; WEBCAP_SPEND_CAP_CREDITS, unset means unlimited)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/ledger': {
      get: {
        tags: ['accounts'],
        summary: 'Merchant revenue ledger (summary + last 50 paid requests)',
        description: 'Merchant-only: the P&L summary plus the 50 most recent paid requests (endpoint, payer, revenue and cost in USDC units).',
        responses: {
          200: {
            description: 'Revenue summary + recent entries',
            content: jsonContent({
              type: 'object',
              properties: {
                summary: { type: 'object' },
                recent: { type: 'array', items: { type: 'object' } },
              },
            }),
          },
          401: ctx.unauthorized,
          403: jsonError('403', 'The authenticated account is not the merchant (error envelope, code forbidden)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/admin/hits/summary': {
      get: {
        tags: ['accounts'],
        summary: 'Merchant hits summary (per-endpoint hits + paid counts + conversion)',
        description: 'Merchant-only: endpoint_hits counts joined with revenue_ledger paid counts per endpoint (conversion = paid/hits, 0 when hits is 0).',
        responses: {
          200: {
            description: 'Per-endpoint {endpoint, hits, paidCount, conversion}, most-hit first',
            content: jsonContent({
              type: 'object',
              properties: {
                summary: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      endpoint: { type: 'string' },
                      hits: { type: 'integer' },
                      paidCount: { type: 'integer' },
                      conversion: { type: 'number' },
                    },
                  },
                },
              },
            }),
          },
          401: ctx.unauthorized,
          403: jsonError('403', 'The authenticated account is not the merchant (error envelope, code forbidden)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/admin/analytics': {
      get: {
        tags: ['accounts'],
        summary: 'Merchant time-series API usage analytics',
        description:
          'Merchant-only: hourly request counts, error rates, and latency over a configurable window ' +
          '(?hours=N, default 24, max 168). Includes top endpoints, top user agents, and aggregate totals.',
        parameters: [
          {
            name: 'hours',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
            description: 'Hours of history to return (default 24, max 168)',
          },
        ],
        responses: {
          200: {
            description: 'Time-series analytics: hourly buckets, top endpoints, top user agents, aggregate totals',
            content: jsonContent({
              type: 'object',
              properties: {
                hoursBack: { type: 'integer' },
                totalRequests: { type: 'integer' },
                totalErrors: { type: 'integer' },
                avgDurationMs: { type: ['number', 'null'] },
                hourly: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      time_bucket: { type: 'string', description: 'ISO 8601 hourly bucket (e.g. 2026-09-08T14:00:00Z)' },
                      endpoint: { type: 'string' },
                      requests: { type: 'integer' },
                      errors: { type: 'integer' },
                      avg_duration_ms: { type: ['number', 'null'] },
                      p95_duration_ms: { type: ['number', 'null'] },
                    },
                  },
                },
                topEndpoints: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      endpoint: { type: 'string' },
                      requests: { type: 'integer' },
                      avgDurationMs: { type: ['number', 'null'] },
                    },
                  },
                },
                topUserAgents: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      userAgent: { type: 'string', description: 'Normalized User-Agent (trimmed, capped at 200 chars; empty when absent)' },
                      requests: { type: 'integer' },
                    },
                  },
                },
              },
            }),
          },
          401: ctx.unauthorized,
          403: jsonError('403', 'The authenticated account is not the merchant (error envelope, code forbidden)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/admin/waitlist': {
      get: {
        tags: ['accounts'],
        summary: 'Merchant email waitlist for mailing list export',
        description:
          'Merchant-only: returns all waitlist signup emails with signup dates. ' +
          'Supports ?format=json (default) or ?format=csv for CSV export.',
        parameters: [
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
            description: 'Response format: json (default) or csv',
          },
        ],
        responses: {
          200: {
            description: 'Waitlist entries with email and signup date',
            content: jsonContent({
              type: 'object',
              properties: {
                total: { type: 'integer', description: 'Total number of waitlist entries' },
                entries: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                      signedUpAt: { type: 'string', description: 'ISO 8601 timestamp' },
                    },
                  },
                },
              },
            }),
          },
          401: ctx.unauthorized,
          403: jsonError('403', 'The authenticated account is not the merchant (error envelope, code forbidden)'),
        },
        security: [{ apiKey: [] }],
      },
    },
    '/v1/og': {
      get: {
        tags: ['discovery'],
        summary: 'Free Open Graph metadata for a URL (no payment)',
        description:
          'Fetch the page and return its title/description/image (twitter: preferred over og:, ' +
          'falling back to the <title> tag and icon link) plus twitter:card/site/creator and ' +
          'article:published_time/author/section/tag. Free, no payment and no API key.',
        parameters: [
          { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'The page to fetch' },
        ],
        responses: {
          200: {
            description: 'The Open Graph metadata (absent fields are omitted)',
            content: jsonContent({
              type: 'object',
              required: ['url'],
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
                image: { type: 'string' },
                icon: { type: 'string' },
                twitterCard: { type: 'string' },
                twitterSite: { type: 'string' },
                twitterCreator: { type: 'string' },
                twitterTitle: { type: 'string' },
                twitterDescription: { type: 'string' },
                twitterImage: { type: 'string' },
                articlePublishedTime: { type: 'string' },
                articleAuthor: { type: 'string' },
                articleSection: { type: 'string' },
                articleTags: { type: 'array', items: { type: 'string' } },
              },
            }),
          },
          422: ctx.unprocessable('Missing or invalid url query parameter'),
          502: ctx.captureFailed,
        },
        security: [],
      },
    },
    '/v1/account': {
      get: {
        tags: ['accounts'],
        summary: 'Account balance + invoice history',
        responses: {
          200: {
            description: 'The address, credit balance, and the account\'s invoices',
            content: jsonContent({
              type: 'object',
              properties: {
                address: { type: 'string' },
                balance: { type: 'integer', description: 'Credits remaining' },
                invoices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: { type: 'string' },
                      credits: { type: 'number' },
                      requiredUsdc: { type: 'number' },
                      createdAt: { type: 'string' },
                    },
                  },
                },
              },
            }),
          },
          401: ctx.unauthorized,
        },
        security: [{ apiKey: [] }],
      },
    },
  };
}
