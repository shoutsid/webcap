/**
 * The web discovery path docs: GET /v1/x402/service, GET /v1/health,
 * GET /robots.txt, GET /sitemap.xml, GET /.well-known/x402,
 * GET /.well-known/agent-card.json, GET /llms.txt, GET /skill.md. Split out
 * of openapi.ts as a pure move (no behavior change); the key order within
 * the table is preserved so the generated JSON stays byte-identical (the two
 * agent-surface paths were appended last, after the pre-existing keys).
 */
import {
  CREDITS_PER_USDC,
  PRICE_PER_CREDIT,
  USDC_SCALE,
  WATCH_TOPUP_RUNS,
  watchTopUpPriceUsdcUnits,
  type WebcapConfig,
} from '../../config.js';
import { jsonContent, jsonError } from './shared.js';
import type { OpenapiPaths } from './types.js';

/** The web discovery path docs (the next six paths of the table). */
export function webPaths(config: WebcapConfig): OpenapiPaths {
  return {
    '/v1/x402/service': {
      get: {
        tags: ['discovery'],
        summary: 'Agent-discoverable x402 service descriptor',
        description:
          'Full descriptor of the paid endpoints, the x402 v2 "exact" scheme, the USDC asset, payTo, the facilitator ' +
          'and howToPay, plus the free endpoints. 503 when x402 is disabled on this deployment.',
        responses: {
          200: {
            description: 'The x402 service descriptor (paid endpoints, price, howToPay, free endpoints)',
            content: jsonContent({
              type: 'object',
              properties: {
                service: { type: 'string', example: 'webcap' },
                paymentProtocol: { type: 'string', example: 'x402' },
                x402Version: { type: 'integer', example: 2 },
                paidEndpoints: { type: 'array', items: { type: 'object' } },
                price: {
                  type: 'object',
                  properties: {
                    asset: { type: 'string' },
                    network: { type: 'string' },
                    payTo: { type: 'string' },
                    scheme: { type: 'string', example: 'exact' },
                  },
                },
                howToPay: { type: 'string' },
                facilitator: { type: 'string' },
                freeEndpoints: { type: 'array', items: { type: 'object' } },
              },
            }),
          },
          503: jsonError('503', 'x402 disabled on this deployment (WEBCAP_CHAIN=local)'),
        },
        security: [],
      },
    },
    '/v1/health': {
      get: {
        tags: ['discovery'],
        summary: 'Liveness + chain identity + uptime',
        responses: {
          200: {
            description: 'Liveness probe: ok (includes DB health check), uptime, chainId, creditsPerUsdc, pricePerCredit',
            content: jsonContent({
              type: 'object',
              properties: {
                ok: { type: 'boolean', example: true, description: 'true when the DB is responsive' },
                uptimeSeconds: { type: 'integer', example: 3600, description: 'Seconds since server start' },
                chainId: { type: 'integer', example: config.chain.chainId },
                creditsPerUsdc: { type: 'integer', example: CREDITS_PER_USDC },
                pricePerCredit: { type: 'number', example: PRICE_PER_CREDIT },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/robots.txt': {
      get: {
        tags: ['discovery'],
        summary: 'Crawler directives (allows all; points to the sitemap)',
        responses: {
          200: {
            description: 'text/plain; charset=utf-8 — User-agent: * / Allow: / / Sitemap: <base>/sitemap.xml',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/sitemap.xml': {
      get: {
        tags: ['discovery'],
        summary: 'XML sitemap of the stable public paths (https-absolute)',
        responses: {
          200: {
            description: 'application/xml; charset=utf-8 — one <loc> per public path, protocol-absolute https',
            content: { 'application/xml': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/.well-known/x402': {
      get: {
        tags: ['discovery'],
        summary: 'x402 machine-discovery catalog (endpoints, USDC prices, payTo, facilitator)',
        description:
          `What to call and what it costs: the paid endpoints with their USDC prices (the watch top-up shows the ` +
          `capture-mode pack price as usdc and the extract-mode pack price as usdcMax; the exact pack price is quoted ` +
          `per watch via ?watchId=), the free endpoints, and links to this catalog and the sitemap. network/asset/payTo ` +
          'are null when x402 is disabled on this deployment.',
        responses: {
          200: {
            description: 'The x402 discovery catalog',
            content: jsonContent({
              type: 'object',
              properties: {
                service: { type: 'string', example: 'webcap' },
                description: { type: 'string' },
                network: { type: ['string', 'null'], example: config.x402Network ?? null },
                asset: { type: ['string', 'null'], example: config.x402Network === undefined ? null : config.x402Asset },
                payTo: { type: ['string', 'null'], example: config.x402Network === undefined ? null : config.x402PayTo },
                facilitator: { type: 'string', example: config.x402FacilitatorUrl },
                endpoints: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string', example: 'POST /v1/x402/capture' },
                      usdc: { type: 'number', example: config.x402PriceUsdcUnits / USDC_SCALE },
                      usdcMax: {
                        type: 'number',
                        description: 'Top-up route only: the extract-mode pack price',
                        example: watchTopUpPriceUsdcUnits('extract', config) / USDC_SCALE,
                      },
                      description: { type: 'string' },
                    },
                  },
                },
                free: {
                  type: 'array',
                  items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } } },
                },
                openapi: { type: 'string', description: 'This catalog, https-absolute' },
                sitemap: { type: 'string', description: 'The sitemap, https-absolute' },
                ownershipProofs: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'EIP-191 personal_sign of the service origin, signed by the payTo key; x402scan verified-ownership',
                },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/.well-known/agent-card.json': {
      get: {
        tags: ['discovery'],
        summary: 'A2A v1.0 agent card with the x402 payments section',
        description:
          'One document for agent-card consumers: service capabilities, skills (the free allowance first), and the x402 ' +
          'payment parameters (network, asset, payTo, facilitator). network/asset/payTo are null when x402 is disabled.',
        responses: {
          200: {
            description: 'The agent card (application/json; charset=utf-8)',
            content: jsonContent({
              type: 'object',
              properties: {
                protocolVersion: { type: 'string', example: '1.0' },
                name: { type: 'string', example: 'webcap' },
                description: { type: 'string' },
                url: { type: 'string' },
                supportedInterfaces: { type: 'array', items: { type: 'object' } },
                iconUrl: { type: 'string' },
                version: { type: 'string', example: '1.1.0' },
                provider: { type: 'object' },
                documentationUrl: { type: 'string' },
                capabilities: {
                  type: 'object',
                  properties: { streaming: { type: 'boolean' }, pushNotifications: { type: 'boolean' } },
                },
                defaultInputModes: { type: 'array', items: { type: 'string' } },
                defaultOutputModes: { type: 'array', items: { type: 'string' } },
                securitySchemes: { type: 'object' },
                skills: { type: 'array', items: { type: 'object' } },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/.well-known/openai-tools.json': {
      get: {
        tags: ['discovery'],
        summary: 'Copy-paste tool definitions for LLM agents (OpenAI functions shape)',
        description:
          'One tool per agent-callable capability, free and paid: preview, OG, service catalog, health, agent funnel, ' +
          'the rolling per-IP allowance, and the paid products with their ' +
          'prices. Each entry names the exact HTTPS endpoint it maps to. Free, no payment to read.',
        responses: {
          200: {
            description: 'The tool manifest (application/json; charset=utf-8)',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/mcp-tools.json': {
      get: {
        tags: ['discovery'],
        summary: 'Tool-router manifest (MCP tools/list shape + HTTPS endpoint per tool)',
        description:
          'Same tool set as openai-tools.json in MCP tools/list shape, each with the HTTPS endpoint it maps to, ' +
          'for tool routers and MCP server configs. Free, no payment.',
        responses: {
          200: {
            description: 'The tool manifest (application/json; charset=utf-8)',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/mcp.json': {
      get: {
        tags: ['discovery'],
        summary: 'MCP server descriptor (transport, auth, payment, registry identity)',
        description:
          'The MCP server descriptor: name and version, the streamable-http transport and its URL, how ' +
          'authentication and payment work, and pointers to the tool manifest, the OpenAPI catalog and the ' +
          'official MCP Registry listing. Registry crawlers read this path to find the endpoint instead of ' +
          'guessing endpoint names. Free, no payment.',
        responses: {
          200: {
            description: 'The MCP server descriptor (application/json; charset=utf-8)',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/agent.json': {
      get: {
        tags: ['discovery'],
        summary: 'Agent card alias (byte-identical to agent-card.json)',
        description:
          'Same payload as /.well-known/agent-card.json, served under the alternate well-known name some agent crawlers probe. Free, no payment.',
        responses: {
          200: {
            description: 'The agent card (application/json; charset=utf-8)',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/agents.json': {
      get: {
        tags: ['discovery'],
        summary: 'Agent card alias (byte-identical to agent-card.json)',
        description:
          'Same payload as /.well-known/agent-card.json, served under the plural well-known name some agent crawlers probe. Free, no payment.',
        responses: {
          200: {
            description: 'The agent card (application/json; charset=utf-8)',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/x402.json': {
      get: {
        tags: ['discovery'],
        summary: 'x402 catalog alias (byte-identical to the extensionless catalog)',
        description:
          'Same payload as /.well-known/x402, served under the .json name some discovery crawlers probe. Free, no payment.',
        responses: {
          200: {
            description: 'The x402 discovery catalog',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/x402-resources': {
      get: {
        tags: ['discovery'],
        summary: 'x402 catalog alias (byte-identical to the extensionless catalog)',
        description:
          'Same payload as /.well-known/x402, served under the x402-resources name some discovery crawlers probe. Free, no payment.',
        responses: {
          200: {
            description: 'The x402 discovery catalog',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/x402-resources': {
      get: {
        tags: ['discovery'],
        summary: 'x402 catalog alias (byte-identical to the extensionless catalog)',
        description:
          'Same payload as /.well-known/x402, served at the bare path some discovery crawlers probe. Free, no payment.',
        responses: {
          200: {
            description: 'The x402 discovery catalog',
            content: jsonContent({ type: 'object' }),
          },
        },
        security: [],
      },
    },
    '/.well-known/security.txt': {      get: {
        tags: ['discovery'],
        summary: 'RFC 9116 security contact point',
        description: 'Security researcher contact (GitHub advisories) with a rolling 1-year expiry. Free, no payment.',
        responses: {
          200: {
            description: 'text/plain; charset=utf-8 — Contact / Expires / Preferred-Languages',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/transparency': {
      get: {
        tags: ['discovery'],
        summary: 'Public trust page: live revenue stats, prices, merchant wallet',
        description:
          'Human-readable trust page with live numbers from this deployment (paid calls settled, USDC revenue, ' +
          '402 challenges served), the per-endpoint price list, and the merchant wallet. Free, no payment.',
        responses: {
          200: {
            description: 'text/html; charset=utf-8 — the transparency page',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/.well-known/ai-plugin.json': {      get: {
        tags: ['discovery'],
        summary: 'AI plugin manifest (ChatGPT/Claude plugin discovery)',
        description:
          'ChatGPT/Claude-style plugin manifest pointing at this deployment\'s OpenAPI document, service icon, ' +
          'and contact info. Free, no payment.',
        responses: {
          200: {
            description: 'application/json; charset=utf-8 — the plugin manifest',
            content: jsonContent({
              type: 'object',
              properties: {
                schema_version: { type: 'string', example: 'v1' },
                name_for_human: { type: 'string', example: 'webcap' },
                name_for_model: { type: 'string', example: 'webcap' },
                description_for_human: { type: 'string' },
                description_for_model: { type: 'string' },
                auth: { type: 'object', properties: { type: { type: 'string', example: 'none' } } },
                api: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', example: 'openapi' },
                    url: { type: 'string', example: `${config.publicBaseUrl}/openapi.json` },
                  },
                },
                logo_url: { type: 'string' },
                contact_email: { type: 'string' },
                legal_info_url: { type: 'string' },
              },
            }),
          },
        },
        security: [],
      },
    },
    '/llms.txt': {
      get: {
        tags: ['discovery'],
        summary: 'llms.txt convention document for LLM agents (markdown)',
        description:
          'The llms.txt document: what webcap is, how to pay (x402, USDC on Base, gasless EIP-3009, CDP ' +
          'facilitator), the paid endpoints with prices and request/response shapes, the free endpoints, ' +
          'pointers to /v1/x402/service and /openapi.json, and a minimal x402 payment flow. Free, no payment.',
        responses: {
          200: {
            description: 'text/markdown; charset=utf-8 — the llms.txt document (base URL and prices from config)',
            content: { 'text/markdown': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/skill.md': {
      get: {
        tags: ['discovery'],
        summary: 'Installable agent skill file (markdown with YAML frontmatter)',
        description:
          'An agent skill (name: webcap) teaching how to call webcap with an x402 client (@x402/axios quick ' +
          'start, raw EIP-3009 fallback), with the pricing table and the free-preview alternative. Free, no payment.',
        responses: {
          200: {
            description: 'text/markdown; charset=utf-8 — YAML frontmatter (name, description) + usage instructions',
            content: { 'text/markdown': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/AGENT.md': {
      get: {
        tags: ['discovery'],
        summary: 'Agent guide (markdown, deployment-interpolated)',
        description:
          'The repo-root agent guide the front-door agentGuide label points at: discovery surfaces, paid ' +
          'endpoints with prices and bodies, watches, the x402 payment flow, and chain config. The served copy ' +
          'has the deployment base URL interpolated. Free, no payment.',
        responses: {
          200: {
            description: 'text/markdown; charset=utf-8 — the agent guide',
            content: { 'text/markdown': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
    '/compare': {
      get: {
        tags: ['discovery'],
        summary: 'Pricing comparison: webcap vs SaaS screenshot alternatives',
        description:
          'Side-by-side comparison of webcap pay-per-call pricing against Urlbox, ScreenshotAPI, Screenshotone, ' +
          'Browserless, and other screenshot API services. Shows per-call costs, payment methods, and account requirements.',
        responses: {
          200: {
            description: 'text/html; charset=utf-8 — the comparison page',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
        security: [],
      },
    },
  };
}
