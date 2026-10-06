/**
 * The free / artifact / landing path docs: GET /v1/extract/preview,
 * GET /v1/artifacts/{id}, GET /v1/artifacts/{id}/page, GET /, GET /icon.png,
 * GET /openapi.json. Split out of openapi.ts as a pure move (no behavior
 * change); the key order within the table is preserved so the generated JSON
 * stays byte-identical.
 */
import { jsonContent, jsonError, type PathContext } from './shared.js';
import type { OpenapiPaths } from './types.js';

/** The free / artifact / landing path docs (the next six paths of the table). */
export function freePaths(ctx: PathContext): OpenapiPaths {
  return {
    '/v1/extract/preview': {
      get: {
        tags: ['extract'],
        summary: 'Free bounded structured preview (no payment, rate-limited)',
          description: `Sample the extract output without paying: a truncated preview (headings, links, first ${ctx.previewMarkdownLimit} chars of markdown from the page's main content, chrome excluded). Rate-limited per client.`,
        parameters: [
          { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'The page to preview' },
        ],
        responses: {
          200: {
            description: 'Truncated structured preview + upgrade pointer to the paid endpoint',
            content: jsonContent({
              type: 'object',
              properties: {
                url: { type: 'string' },
                preview: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    headings: { type: 'array', items: { type: 'object', properties: { level: { type: 'integer' }, text: { type: 'string' } } } },
                    links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, text: { type: 'string' } } } },
                    wordCount: { type: 'integer', description: 'Words on the whole page, chrome included' },
                    markdown: { type: 'string', description: `First ${ctx.previewMarkdownLimit} characters of the document-order markdown, taken from the page's main content (chrome excluded)` },
                    content: {
                      type: 'object',
                      description:
                        'What the markdown actually contains: source = the container it was taken from (article/main/body), words = words kept after chrome removal, truncated = cut short by the budget',
                      properties: {
                        source: { type: 'string', example: 'article' },
                        words: { type: 'integer' },
                        truncated: { type: 'boolean' },
                      },
                    },
                  },
                },
                truncated: { type: 'boolean', example: true },
                upgrade: {
                  type: 'object',
                  properties: {
                    endpoint: { type: 'string', example: 'POST /v1/x402/extract' },
                    note: { type: 'string' },
                  },
                },
                freeAllowance: {
                  type: 'object',
                  properties: {
                    note: { type: 'string', description: 'Pointer at the rolling free allowance: every product is free inside the per-IP window, no wallet needed' },
                  },
                },
                paidUpgrade: {
                  type: 'object',
                  properties: {
                    endpoint: { type: 'string', example: 'POST /v1/x402/extract', description: 'The paid extract endpoint (method + path) that returns the full result' },
                    priceUsdc: { type: 'number', example: 0.01, description: 'Per-extract price in USDC (priceUsdcUnits / 1e6), config-derived' },
                    priceUsdcUnits: { type: 'integer', example: 10000, description: 'Per-extract price in atomic 6-decimal USDC units (config x402ExtractPriceUsdcUnits)' },
                    howToPay: { type: 'string', description: 'The x402 v2 "exact" scheme payment flow: 402 challenge -> sign a gasless EIP-3009 USDC transferWithAuthorization -> retry with the PAYMENT-SIGNATURE header' },
                    guide: { type: 'string', description: 'The deployment agent skill guide URL (<public base URL>/skill.md), config-derived' },
                  },
                },
              },
            }),
          },
          422: ctx.unprocessable('Missing or invalid url query parameter'),
          429: jsonError('429', 'Preview rate limit exceeded (error envelope, code rate_limited; detail.retryAfterSeconds + detail.paidUpgrade{endpoint, priceUsdc, priceUsdcUnits, howToPay, guide} point at the paid extract endpoint)'),
          502: ctx.captureFailed,
        },
        security: [],
      },
    },
    '/og-debugger': {
      get: {
        tags: ['discovery'],
        summary: 'Free OG meta debugger tool page (no payment, rate-limited)',
        description:
          'Server-rendered link-preview debugger: omit url for the empty form, or pass ?url=… to see the Open Graph ' +
          '/ meta tags the free GET /v1/og endpoint returns for that page — a preview card plus a tag table, or an ' +
          'inline error for bad/unreachable URLs. Plain GET form, no JavaScript. Fetch is rate-limited per client.',
        parameters: [
          { name: 'url', in: 'query', required: false, schema: { type: 'string' }, description: 'The page to debug; omit for the empty form' },
        ],
        responses: {
          200: { description: 'The debugger page (text/html; charset=utf-8)', content: { 'text/html': { schema: { type: 'string' } } } },
        },
        security: [],
      },
    },
    '/v1/artifacts/{id}': {
      get: {
        tags: ['artifacts'],
        summary: 'Fetch a stored artifact (raw bytes, public)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: {
            description: 'The artifact bytes with its stored mime type (image/png, image/jpeg or application/pdf)',
            content: {
              'image/png': { schema: { type: 'string', format: 'binary' } },
              'image/jpeg': { schema: { type: 'string', format: 'binary' } },
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
            },
          },
          404: jsonError('404', 'Artifact not found (error envelope, code not_found)'),
          403: jsonError('403', 'Signed URL signature mismatch (error envelope, code forbidden)'),
          410: jsonError('410', 'Signed URL expired (error envelope, code gone)'),
        },
        security: [],
      },
    },
    '/v1/artifacts/{id}/page': {
      get: {
        tags: ['artifacts'],
        summary: 'Shareable HTML page for an artifact (Open Graph tags, public)',
        description:
          'Renders the capture with og:title/og:description/og:type/og:url/og:image (og:url and og:image are the ' +
          'artifact public URL), the embedded image, the source URL, and format/size/captured-at metadata.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          200: { description: 'The artifact page (text/html; charset=utf-8)', content: { 'text/html': { schema: { type: 'string' } } } },
          404: jsonError('404', 'Artifact not found (error envelope, code not_found)'),
        },
        security: [],
      },
    },
    '/': {
      get: {
        tags: ['discovery'],
        summary: 'Product landing page (content-negotiated)',
        description:
          'Returns the product landing page (text/html; charset=utf-8). Clients that send Accept: application/json ' +
          'without text/html receive the JSON service map instead (endpoints, prices, payment status).',
        responses: {
          200: {
            description: 'Landing page for HTML clients; JSON service map for pure-JSON clients',
            content: {
              'text/html': { schema: { type: 'string' } },
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    service: { type: 'string', example: 'webcap' },
                    tagline: { type: 'string' },
                    endpoints: { type: 'object', properties: { free: { type: 'array' }, paid: { type: 'array' } } },
                    catalog: { type: 'string' },
                    agentGuide: { type: 'string' },
                    payment: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        security: [],
      },
      post: {
        tags: ['discovery'],
        summary: 'Lost-agent handler: POST / is not a route (405 + catalog pointer)',
        description:
          'Registry crawlers sometimes POST the front door; instead of the framework default body, they get the error envelope with method_not_allowed plus the machine catalog (service) and openapi pointers, so the caller learns where to go. Free, no payment.',
        responses: {
          405: jsonError('405', 'Not a route (error envelope, code method_not_allowed; detail {service, openapi})'),
        },
        security: [],
      },
    },
    '/quickstart': {
      get: {
        tags: ['discovery'],
        summary: 'Quick start guide — step-by-step walkthrough from free preview to paid API',
        description:
          'Server-rendered quick start guide that walks developers through the entire flow: ' +
          'free preview, x402 payment challenge, client library, wallet setup. ' +
          'Reduces conversion friction by providing copy-paste commands.',
        responses: {
          200: { description: 'The quick start guide page (text/html; charset=utf-8)', content: { 'text/html': { schema: { type: 'string' } } } },
        },
        security: [],
      },
    },
    '/compare': {
      get: {
        tags: ['discovery'],
        summary: 'Pricing comparison page — webcap vs alternatives',
        description:
          'Server-rendered comparison page showing webcap pricing against SaaS alternatives. ' +
          'Highlights the cost advantage of pay-per-call with no subscriptions.',
        responses: {
          200: { description: 'The comparison page (text/html; charset=utf-8)', content: { 'text/html': { schema: { type: 'string' } } } },
        },
        security: [],
      },
    },
    '/buy': {
      get: {
        tags: ['discovery'],
        summary: 'Buy credits page — credit pack purchase with card and crypto',
        description:
          'Server-rendered credit pack purchase page with three tiers (Starter $0.50, Pro $3, Max $12). ' +
          'Shows pricing, credit usage, and payment instructions for both Stripe card and x402 crypto payments.',
        responses: {
          200: { description: 'The buy credits page (text/html; charset=utf-8)', content: { 'text/html': { schema: { type: 'string' } } } },
        },
        security: [],
      },
    },
    '/v1/stripe/checkout': {
      post: {
        tags: ['discovery'],
        summary: 'Create a Stripe Checkout session for credit pack purchase',
        description:
          'Creates a Stripe Checkout session for buying credit packs (Starter $0.50, Pro $3, Max $12). ' +
          'When Stripe is not configured, returns a helpful error with alternative payment instructions (x402 crypto or email purchase).',
        requestBody: {
          required: true,
          content: jsonContent({
            type: 'object',
            required: ['pack'],
            properties: {
              pack: { type: 'string', enum: ['starter', 'pro', 'max'], description: 'Credit pack to purchase' },
              address: { type: 'string', description: 'Optional Ethereum address to associate with the purchase' },
            },
          }),
        },
        responses: {
          200: {
            description: 'Stripe Checkout session URL (when configured) or payment alternatives (when not configured)',
            content: jsonContent({
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    checkoutUrl: { type: 'string', format: 'uri', description: 'URL to redirect to Stripe Checkout' },
                  },
                },
                {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'stripe_not_configured' },
                    message: { type: 'string' },
                    fallback: {
                      type: 'object',
                      properties: {
                        crypto: { type: 'string' },
                        email: { type: 'string' },
                      },
                    },
                  },
                },
              ],
            }),
          },
          422: ctx.unprocessable('Missing or invalid pack field'),
        },
        security: [],
      },
    },
    '/v1/demo': {
      get: {
        tags: ['discovery'],
        summary: 'Sample full extract response (no payment, no rate limit)',
        description:
          'Returns a hardcoded example extract response so users can see the actual JSON output format ' +
          'before paying. Useful for understanding the API response structure.',
        responses: {
          200: {
            description: 'Sample extract response with _demo flag',
            content: jsonContent({
              type: 'object',
              properties: {
                url: { type: 'string', example: 'https://example.com/' },
                results: { type: 'array', items: { type: 'object' } },
                _demo: { type: 'boolean', example: true },
                _note: { type: 'string' },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/icon.png': {
      get: {
        tags: ['discovery'],
        summary: 'Service icon (PNG)',
        responses: {
          200: { description: 'The webcap icon', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
          500: jsonError('500', 'Icon file missing on the server (error envelope, code internal)'),
        },
        security: [],
      },
    },
    '/openapi.json': {
      get: {
        tags: ['discovery'],
        summary: 'This OpenAPI catalog',
        responses: {
          200: { description: 'The OpenAPI 3.1 document', content: jsonContent({ $ref: '#/components/schemas/OpenapiDocument' }) },
        },
        security: [],
      },
    },
    '/v1/status': {
      get: {
        tags: ['discovery'],
        summary: 'Operational status dashboard (uptime, revenue totals, hit counts)',
        description:
          'Public, non-sensitive operational snapshot: server uptime, chain config, DB health, ' +
          'aggregate revenue totals (no payer-identifiable data), top endpoint hit counts, ' +
          'active watch count, and artifact count. Designed for status pages and monitoring.',
        responses: {
          200: {
            description: 'Operational status snapshot',
            content: jsonContent({
              type: 'object',
              properties: {
                status: { type: 'string', example: 'ok' },
                uptimeSeconds: { type: 'integer', description: 'Seconds since server start' },
                version: { type: 'string', example: '0.1.0' },
                chain: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer', example: 8453 },
                    name: { type: 'string', example: 'base' },
                    network: { type: 'string', example: 'eip155:8453' },
                  },
                },
                db: { type: 'object', properties: { ok: { type: 'boolean' } } },
                pricing: {
                  type: 'object',
                  properties: {
                    creditsPerUsdc: { type: 'integer' },
                    pricePerCredit: { type: 'number' },
                  },
                },
                revenue: {
                  type: 'object',
                  properties: {
                    totalRevenueUsdcUnits: { type: 'integer' },
                    totalCostUsdcUnits: { type: 'integer' },
                    netMarginUsdcUnits: { type: 'integer' },
                    requestCount: { type: 'integer' },
                  },
                },
                endpoints: {
                  type: 'object',
                  properties: {
                    topHits: { type: 'array', items: { type: 'object', properties: { endpoint: { type: 'string' }, hits: { type: 'integer' } } } },
                  },
                },
                watches: { type: 'object', properties: { active: { type: 'integer' } } },
                artifacts: { type: 'object', properties: { count: { type: 'integer' } } },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/v1/funnel': {
      get: {
        tags: ['discovery'],
        summary: 'Conversion funnel analytics (last 24h)',
        description:
          'Structured conversion funnel with stage-by-stage conversion rates, hourly breakdown, referrer sources, ' +
          'error type breakdown, and waitlist count. Pass ?format=text for human-readable terminal output (no jq needed). ' +
          'Public, non-sensitive analytics for monitoring landing page performance.',
        parameters: [
          { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'text'] }, description: 'Response format: json (default) or text for terminal-friendly output' },
        ],
        responses: {
          200: {
            description: 'Funnel analytics data',
            content: jsonContent({
              type: 'object',
              properties: {
                generatedAt: { type: 'string', format: 'date-time' },
                waitlistCount: { type: 'integer' },
                funnel: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Raw event counts by event name' },
                funnelStructured: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      stage: { type: 'string', example: 'page_view' },
                      count: { type: 'integer' },
                      conversionFromPrev: { type: ['number', 'null'], description: 'Percentage from previous stage, null for first/error stages' },
                    },
                  },
                },
                funnelHourly: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      hour: { type: 'string', example: '2026-09-09T14:00:00Z' },
                      events: { type: 'object', additionalProperties: { type: 'integer' } },
                    },
                  },
                },
                funnelReferrers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      referrer: { type: 'string', example: 'hacker_news' },
                      count: { type: 'integer' },
                    },
                  },
                },
                errorBreakdown: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      errorType: { type: 'string', example: 'capture_failed_502' },
                      count: { type: 'integer' },
                      sampleUrls: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/v1/agent-funnel': {
      get: {
        tags: ['discovery'],
        summary: 'Agent-income funnel (reach → challenge → free allowance → paid → retention → recurring)',
        description:
          'The conversion funnel for the customer this service actually has: an autonomous agent. Tracks reach ' +
          '(discovery clients reading llms.txt/skill.md/.well-known/openapi/x402-service), challenge (402s on paid ' +
          'routes), freeAllowance (free product calls granted by the rolling per-IP window), paid (settled calls + distinct paying wallets from the revenue ' +
          'ledger), retention (first-pay vs repeat wallets, lifetime) and recurring (funded, unpaused watches). ' +
          'Aggregate only — never a raw payer address. Pass ?format=text for terminal output. See ' +
          'docs/strategy/agent-first.md for the north-star definition. Public, no auth.',
        parameters: [
          { name: 'hours', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 8760, default: 168 }, description: 'Window in hours (default 168 = 7 days)' },
          { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'text'] }, description: 'Response format: json (default) or text for terminal-friendly output' },
        ],
        responses: {
          200: {
            description: 'Agent funnel counts (JSON, or text/plain when ?format=text)',
            content: jsonContent({
              type: 'object',
              properties: {
                windowHours: { type: 'integer', example: 168 },
                reach: {
                  type: 'object',
                  properties: {
                    discoveryRequests: { type: 'integer' },
                    topClients: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          client: { type: 'string', example: 'CarbonMonitor/0.1' },
                          requests: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
                challenge: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer', description: '402 responses on paid routes' },
                    topEndpoints: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { endpoint: { type: 'string' }, count: { type: 'integer' } },
                      },
                    },
                  },
                },
                freeAllowance: {
                  type: 'object',
                  properties: {
                    claims: { type: 'integer' },
                    wallets: { type: 'integer' },
                    byEndpoint: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { endpoint: { type: 'string' }, count: { type: 'integer' } },
                      },
                    },
                  },
                },
                paid: {
                  type: 'object',
                  properties: {
                    calls: { type: 'integer' },
                    wallets: { type: 'integer' },
                    revenueUsdcUnits: { type: 'integer', description: 'Atomic 6-decimal USDC units' },
                  },
                },
                retention: {
                  type: 'object',
                  properties: {
                    firstPayWallets: { type: 'integer', description: 'Wallets with exactly one settled call (lifetime)' },
                    repeatWallets: { type: 'integer', description: 'Wallets with more than one settled call (lifetime)' },
                  },
                },
                recurring: {
                  type: 'object',
                  properties: { activePaidWatches: { type: 'integer', description: 'Unpaused watches holding credits' } },
                },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/v1/status-badge': {
      get: {
        tags: ['discovery'],
        summary: 'Shields.io-compatible status badge endpoint',
        description:
          'Returns a shields.io-compatible JSON response for embedding a live API status badge in README files. ' +
          'Returns operational status based on DB health check.',
        responses: {
          200: {
            description: 'Status badge data',
            content: jsonContent({
              type: 'object',
              properties: {
                schemaVersion: { type: 'integer', example: 1 },
                label: { type: 'string', example: 'API Status' },
                message: { type: 'string', example: 'operational' },
                color: { type: 'string', example: 'brightgreen' },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/v1/waitlist': {
      post: {
        tags: ['discovery'],
        summary: 'Join the email waitlist',
        description:
          'Stores an email address for the waitlist/mailing list. ' +
          'No auth required; fire-and-forget from the landing page.',
        requestBody: {
          required: true,
          content: jsonContent({
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', format: 'email', description: 'Email address to add to the waitlist' },
            },
          }),
        },
        responses: {
          200: {
            description: 'Email added to waitlist',
            content: jsonContent({
              type: 'object',
              properties: {
                ok: { type: 'boolean', example: true },
                message: { type: 'string', example: 'Added to waitlist' },
              },
            }),
          },
          422: ctx.unprocessable('Missing or invalid email field'),
        },
        security: [],
      },
    },
    '/v1/track': {
      post: {
        tags: ['discovery'],
        summary: 'Lightweight landing page event tracking (fire-and-forget)',
        description:
          'Records page views, preview form submissions, and other conversion events for analytics. ' +
          'No auth required; fire-and-forget from client-side JavaScript.',
        requestBody: {
          required: true,
          content: jsonContent({
            type: 'object',
            required: ['event'],
            properties: {
              event: { type: 'string', description: 'Event name (e.g., landing_view, preview_submit)' },
              meta: { type: 'object', description: 'Optional event metadata' },
            },
          }),
        },
        responses: {
          200: {
            description: 'Event recorded',
            content: jsonContent({
              type: 'object',
              properties: {
                ok: { type: 'boolean', example: true },
                event: { type: 'string' },
              },
            }),
          },
          422: ctx.unprocessable('Missing or invalid event field'),
        },
        security: [],
      },
    },
  };
}
