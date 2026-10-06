/**
 * The webcap OpenAPI 3.1 catalog served at GET /openapi.json.
 *
 * The document is config-driven (servers come from the deployment's public
 * base URL; 402 amounts mirror the live prices), and its 402 response shape
 * mirrors src/server/x402.ts byte-for-byte: the PAYMENT-REQUIRED response
 * header (base64-encoded JSON) plus the equivalent JSON body with accepts[]
 * + extensions.bazaar.
 *
 * This entry assembles the document from the modules in ./openapi/: the
 * shared types (types.ts), the error + x402 challenge builders (shared.ts),
 * the route schema components (schemas.ts), and the per-path docs
 * (paths-x402.ts, paths-free.ts, paths-web.ts, paths-accounts.ts). The
 * spread order below is the original single-table key order, so the served
 * JSON is byte-identical to the pre-split document (locked by
 * tests/api/openapi.test.ts).
 */
import {
  DEFAULT_PREVIEW_MARKDOWN_LIMIT,
  WATCH_TOPUP_RUNS,
  watchTopUpPriceUsdcUnits,
  type WebcapConfig,
} from '../config.js';
import { accountPaths } from './openapi/paths-accounts.js';
import { billingPaths } from './openapi/paths-billing.js';
import { freePaths } from './openapi/paths-free.js';
import { feedbackPaths } from './openapi/paths-feedback.js';
import { jobsPaths } from './openapi/paths-jobs.js';
import { mcpPaths } from './openapi/paths-mcp.js';
import { mlPaths } from './openapi/paths-ml.js';
import { webPaths } from './openapi/paths-web.js';
import { x402Paths } from './openapi/paths-x402.js';
import { jsonError, type PathContext } from './openapi/shared.js';
import { ownershipProof } from './openapi/ownership.js';
import type { OpenapiDocument } from './openapi/types.js';

/** Trimmed-decimal USDC amount for prose (6-decimal units -> '0.001', '0.01', '0.1', '1'). */
const usd = (units: number): string => (units / 1_000_000).toString();

/** Build the full OpenAPI 3.1 document for a deployment. */
export async function openapiDocument(config: WebcapConfig): Promise<OpenapiDocument> {
  const previewMarkdownLimit = config.previewMarkdownLimit ?? DEFAULT_PREVIEW_MARKDOWN_LIMIT;
  const ownershipProofs = await ownershipProof(config.publicBaseUrl, config.merchantPrivateKey);
  const ctx: PathContext = {
    badInput: jsonError('400', 'Malformed JSON request body (error envelope, code bad_request)'),
    unprocessable: (message: string) => jsonError('422', `${message} (error envelope, code unprocessable)`),
    captureFailed: jsonError('502', 'Upstream page capture failed (error envelope, code capture_failed)'),
    unauthorized: jsonError('401', 'Missing or invalid Bearer API key (error envelope, code unauthorized)'),
    previewMarkdownLimit,
  };
  // mppscan/x402gle discovery: high-level agent usage guidance with config-derived prices.
  const guidance =
    'Agent usage: paid x402 endpoints settle per call in USDC - POST /v1/x402/capture ' +
    `(${usd(config.x402PriceUsdcUnits)} USDC), POST /v1/x402/extract (${usd(config.x402ExtractPriceUsdcUnits)} USDC, ` +
    'batch up to 50 URLs for one payment), POST /v1/x402/audit (' +
    `${usd(config.x402AuditPriceUsdcUnits)} USDC, SEO basics + link/OG health in one call), ` +
    'POST /v1/x402/map-lite (' +
    `${usd(config.x402AuditPriceUsdcUnits)} USDC, sitemap/robots + 1-hop crawl URL list), POST /v1/x402/video (` +
    `${usd(config.x402VideoPriceUsdcUnits)} USDC, scroll-capture WebM/VP8), ` +
    'and POST /v1/x402/watches/topup (dynamic ' +
    `${usd(watchTopUpPriceUsdcUnits('capture', config))}-${usd(watchTopUpPriceUsdcUnits('extract', config))} USDC ` +
    `per ${WATCH_TOPUP_RUNS}-run watch pack). Payment (x402 v2 "exact"): on HTTP 402 read the base64 ` +
    'PAYMENT-REQUIRED header, sign the gasless EIP-3009 USDC transferWithAuthorization, and retry with ' +
    'the PAYMENT-SIGNATURE header. Every paid path also answers and accepts the challenge for GET, with ' +
    'the same parameters in the query string (sign the challenge for the method you then retry). ' +
    'No API keys or accounts. Free entry point: GET /v1/extract/preview ' +
    'samples the extract output without paying; full catalog at GET /openapi.json, agent skill at GET /skill.md.';
  return {
    openapi: '3.1.0',
    // x402scan verified-ownership discovery; omitted entirely when unsigned.
    ...(ownershipProofs.length > 0 ? { 'x-discovery': { ownershipProofs } } : {}),
    info: {
      title: 'webcap',
      version: '0.1.0',
      description:
        'Pay-per-call web capture: any URL becomes a PNG/JPEG/PDF screenshot + free Open Graph metadata, ' +
        'or structured text/JSON via batch extract. Paid per call in USDC over x402 (HTTP 402, x402 v2 ' +
        '"exact" scheme, gasless EIP-3009 — the facilitator settles, no ETH or gas for the payer). ' +
        'No API keys, no accounts for x402 routes.',
      'x-guidance': guidance,
      ...(config.contactEmail !== undefined ? { contact: { email: config.contactEmail } } : {}),
    },
    // Single public server: directory auditors (x402gle) reject declarations
    // containing non-public URLs (e.g. localhost).
    servers: [{ url: config.publicBaseUrl, description: 'public deployment' }],
    tags: [
      { name: 'capture', description: 'URL → PNG/JPEG/PDF screenshot (+ free OG metadata)' },
      { name: 'extract', description: 'URL(s) → structured text/JSON' },
      { name: 'audit', description: 'URL → SEO basics + link/OG health report' },
      { name: 'map-lite', description: 'Seed URL → same-host URL list (sitemap/robots + 1-hop crawl)' },
      { name: 'monitoring', description: 'Scheduled watches: create, state, delete, x402 credit top-up' },
      { name: 'artifacts', description: 'Stored capture artifacts' },
      { name: 'accounts', description: 'API-key accounts, credit packs, and the credit-metered capture (non-x402 front door)' },
      { name: 'discovery', description: 'Service metadata, catalog, icon, SEO surface' },
      { name: 'ml', description: 'AI-powered visual analysis (classification, accessibility, entities, sentiment)' },
    ],
    paths: {
      ...x402Paths(config, ctx),
      ...mlPaths(config, ctx),
      ...freePaths(ctx),
      ...feedbackPaths(ctx),
      ...webPaths(config),
      ...accountPaths(config, ctx),
      ...billingPaths(ctx),
      ...jobsPaths(config, ctx),
      // Appended last on purpose: every pre-existing path keeps its key order,
      // so the generated JSON for them is unchanged by this addition.
      ...mcpPaths(config, ctx),
    },
    components: {
      // Every operation declares its auth mode: `apiKey` for the API-key
      // routes, a `x-payment-info` paid declaration for the x402 routes, and
      // `security: []` for the free ones. Directory auditors (mppscan) drop
      // operations with no declared mode from their listing, so an undeclared
      // route is an unlisted route — see tests/api/openapi.test.ts.
      securitySchemes: {
        // The conventional declaration for an `Authorization` header token:
        // `type: apiKey` in the header (the value carries the `Bearer ` prefix,
        // which the description spells out). Measured against mppscan
        // 2026-09-23: before these declarations its registration audit reported
        // 10 × `L2_AUTH_MODE_MISSING` and skipped those routes
        // (`skippedUnprotected`); after them the re-audit is clean — 1 warning,
        // `L2_ROUTE_COUNT_HIGH` (75 operations), and nothing skipped. Note that
        // its per-endpoint `authMode` field still only labels `x-payment-info`
        // ("paid") and no security ("unprotected"), so the audit is the
        // authority, not that field.
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description:
            'API key from POST /v1/register, sent as `Authorization: Bearer <key>`. Not needed on the x402 ' +
            'routes, which settle per call instead.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          description: 'The webcap error envelope returned for every non-2xx response',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'bad_request' },
                message: { type: 'string', example: 'url is required' },
                detail: { type: 'object', additionalProperties: true, description: 'Optional structured detail' },
              },
            },
          },
        },
        OpenapiDocument: {
          type: 'object',
          description: 'An OpenAPI 3.1 document (this catalog)',
          properties: {
            openapi: { type: 'string', example: '3.1.0' },
            info: { type: 'object' },
            servers: { type: 'array' },
            paths: { type: 'object' },
          },
        },
      },
    },
  };
}
