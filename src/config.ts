/**
 * The webcap deployment config: the WebcapConfig type, the DEFAULT_* fallbacks,
 * the env parse helpers, and loadConfig (parses + validates the WEBCAP_*
 * environment). The chain table + EIP-712 domains live in ./config/chains.ts
 * and the USDC pricing model in ./config/pricing.ts; everything moved is
 * re-exported here so every existing import from config.ts keeps resolving.
 */
import { isAddress, Wallet } from 'ethers';
import { CHAINS, X402_NETWORKS, type ChainConfig, type ChainName, type X402Network } from './config/chains.js';
import { USDC_SCALE } from './config/pricing.js';

export type { ChainConfig, ChainName, Eip712Domain, X402Network } from './config/chains.js';
export { EIP712_DOMAINS, X402_NETWORKS } from './config/chains.js';
export type { CreditPack, PackName } from './config/pricing.js';
export { CAPTURE_COST_CREDITS, CREDITS_PER_USDC, PACKS, PRICE_PER_CREDIT, PRODUCT_CREDIT_COST, USDC_SCALE, USDC_UNITS_PER_CREDIT, WATCH_CREDIT_TOPUP_COST_CAPTURE, WATCH_CREDIT_TOPUP_COST_EXTRACT, WATCH_TOPUP_RUNS } from './config/pricing.js';
export { creditsForUsdc, getPack, usdcForCredits, usdcUnitsForCredits, watchTopUpPriceUsdcUnits } from './config/pricing.js';
export { MODEL_EXTRACT_DISABLED_WARNING, modelExtractionDisabled } from './config/model.js';

export interface WebcapConfig {
  readonly chain: ChainConfig;
  /** Denormalized run fields: what main.ts needs without digging into `chain`. */
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly usdcAddress: string;
  readonly merchantAddress: string;
  readonly port: number;
  readonly pollIntervalMs: number;
  readonly merchantPrivateKey: string;
  readonly dbPath: string;
  /** x402 CAIP-2 network; undefined when the chain has no real USDC (local). */
  readonly x402Network: X402Network | undefined;
  /** ERC-20 asset paid on the x402 route (default: chain USDC). */
  readonly x402Asset: string;
  /** Public base URL this deployment is reachable at; artifact.url links are built from it. */
  readonly publicBaseUrl: string;
  /** x402 recipient address (default: merchant address). */
  readonly x402PayTo: string;
  /** x402 per-capture price in atomic 6-decimal USDC units. */
  readonly x402PriceUsdcUnits: number;
  /** Facilitator that verifies + settles x402 payments (gasless payer). */
  readonly x402FacilitatorUrl: string;
  /** x402 per-extract price in atomic 6-decimal USDC units (the "meaning" price, above capture). */
  readonly x402ExtractPriceUsdcUnits: number;
  /** x402 per-audit price in atomic 6-decimal USDC units. */
  readonly x402AuditPriceUsdcUnits: number;
  /**
   * x402 per-video price in atomic 6-decimal USDC units: 5x capture for the
   * sustained Chromium recording session (~30s vs a ~2-5s capture still) plus
   * video-bytes storage pressure. Ladder: audit/map-lite 2000 < video 5000 < extract 10000.
   */
  readonly x402VideoPriceUsdcUnits: number;
  /** Optional CDP API key pair (CDP_API_KEY_ID/CDP_API_KEY_SECRET) for CDP facilitator auth. */
  readonly cdpApiKey: { readonly id: string; readonly secret: string } | undefined;
  /** Amortized compute cost per paid request, in atomic 6-decimal USDC units (for the P&L ledger). */
  readonly computeCostUsdcUnitsPerRequest: number;
  /**
   * Rolling free allowance: free product calls per caller IP per window
   * (WEBCAP_ALLOWANCE_CALLS). 0 disables the free rail entirely and every call
   * returns the x402 402 challenge. This replaced the wallet-signed trials.
   *
   * Optional on purpose. `loadConfig` always sets it (default
   * DEFAULT_ALLOWANCE_CALLS), but a hand-built config that omits it gets NO
   * free rail rather than an accidental one — the same posture as
   * `previewRateLimit`. Embedded/test configs therefore keep the pay-per-call
   * contract unless they opt in.
   */
  readonly allowanceCalls?: number;
  /** Allowance window length in hours (WEBCAP_ALLOWANCE_WINDOW_HOURS). Evaluated as a sliding window. */
  readonly allowanceWindowHours?: number;
  /**
   * Fleet-wide free-call circuit breaker per window (WEBCAP_ALLOWANCE_GLOBAL_LIMIT).
   * When the window total reaches this, free usage stops for everyone (callers
   * still get a payable 402). 0 disables the breaker. This is a runaway-spend
   * guard, not a policy cap — budget the free rail with allowanceCalls.
   */
  readonly allowanceGlobalLimit?: number;
  /** Optional owner contact email, surfaced as info.contact.email in the OpenAPI document (directory ownership verification). */
  readonly contactEmail?: string;
  /**
   * Optional 402index domain-ownership proof (WEBCAP_402INDEX_VERIFY_HASH): the
   * SHA-256 of the registry's claim token, served verbatim at
   * /.well-known/402index-verify.txt. Empty/absent = no claim in progress.
   */
  readonly indexVerifyHash?: string;
  /**
   * Optional Glama MCP ownership claim token (WEBCAP_GLAMA_CLAIM): the opaque
   * `glama_claim_...` string from Glama's claim panel, served at
   * /.well-known/glama.json so Glama's crawler can verify HTTP ownership of
   * the remote connector on this origin. Empty/absent = not claimed. Never
   * put the Glama directory API key here: Glama's schema binds this file to a
   * claim token specifically, and their FAQ warns against publishing a
   * connector/API credential as ownership proof.
   */
  readonly glamaClaim?: string;
  /** Optional LLM endpoint for model-based extraction (OpenAI-compatible); empty = deterministic only. */
  readonly modelApiBaseUrl: string;
  readonly modelApiKey: string;
  readonly modelName: string;
  /**
   * Free preview endpoint: max requests per 60s window per peer IP
   * (WEBCAP_PREVIEW_RATE_LIMIT). loadConfig always sets this; hand-built test
   * configs may omit it, in which case DEFAULT_PREVIEW_RATE_LIMIT applies.
   */
  readonly previewRateLimit?: number;
  /**
   * The optional tunables below all follow the previewRateLimit pattern:
   * loadConfig always sets them (WEBCAP_* env vars); hand-built test configs
   * may omit any of them, in which case the matching DEFAULT_* applies at the
   * use site. Defaults equal the previously hardcoded behavior.
   */
  /** Fastify requestTimeout (ms); base64 capture artifacts need headroom. */
  readonly requestTimeoutMs?: number;
  /** Fastify bodyLimit (bytes). */
  readonly bodyLimitBytes?: number;
  /** Default page-load timeout (ms) for capture/og when the client sends none. */
  readonly captureTimeoutMs?: number;
  /** Hard cap (ms) applied to a client-specified capture timeoutMs. */
  readonly captureTimeoutCapMs?: number;
  /** Model extraction fetch timeout (ms). */
  readonly modelTimeoutMs?: number;
  /** x402 maxTimeout advertised in payment requirements (ms; wire field is seconds). */
  readonly x402MaxTimeoutMs?: number;
  /** Watch webhook delivery attempts per changed run. */
  readonly webhookRetries?: number;
  /** Per-attempt watch webhook delivery timeout (ms). */
  readonly webhookTimeoutMs?: number;
  /** Invoice expiry window (ms). */
  readonly invoiceTtlMs?: number;
  /** Credits minted by POST /v1/invoice when the body omits `credits`. */
  readonly defaultCredits?: number;
  /** Free preview slice: max headings returned. */
  readonly previewHeadingsLimit?: number;
  /** Free preview slice: max links returned. */
  readonly previewLinksLimit?: number;
  /** Free preview slice: max markdown characters returned (mirrored in the OpenAPI doc). */
  readonly previewMarkdownLimit?: number;
  /** CDP Bazaar catalog link on the public pages. */
  readonly bazaarCatalogUrl?: string;
  /** Artifact retention in days; 0 (default) disables the sweep. */
  readonly artifactRetentionDays?: number;
  /**
   * Per-payer x402 spend cap in atomic 6-decimal USDC units
   * (WEBCAP_SPEND_CAP_USDC_UNITS). Unset = unlimited: caps can never block
   * when this is undefined.
   */
  readonly spendCapUsdcUnits?: number;
  /**
   * Per-account credits-rail spend cap in credits
   * (WEBCAP_SPEND_CAP_CREDITS). Unset = unlimited: caps can never block
   * when this is undefined.
   */
  readonly spendCapCredits?: number;
  /**
   * Shared secret for signed artifact URLs (WEBCAP_ARTIFACT_HMAC_SECRET).
   * Optional: when set it signs/verifies `?exp=&sig=` (HMAC-SHA256 over
   * `${artifactId}.${exp}`); unset falls back to merchantPrivateKey; when
   * both are absent sign-verify is disabled and unsigned artifact URLs keep
   * serving (see registerDiscoveryRoutes). Never logged.
   */
  readonly artifactHmacSecret?: string;
  /**
   * Watch AI token budgets (fail-open only; consumed by the scheduler's
   * summarize gate in T11): max model tokens chargeable to one watch's
   * window (WATCH_AI_MAX_TOKENS_PER_RUN) and to the shared global window
   * (WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW). loadConfig always sets both;
   * hand-built test configs may omit them, in which case the matching
   * DEFAULT_* applies at the use site.
   */
  readonly watchAiMaxTokensPerRun?: number;
  readonly watchAiMaxTokensGlobalWindow?: number;
  /** Stripe secret key for fiat payments (STRIPE_SECRET_KEY). Optional: when set, enables the /v1/stripe/checkout endpoint. */
  readonly stripeSecretKey?: string;
  /** Stripe webhook secret for verifying webhook signatures (STRIPE_WEBHOOK_SECRET). Optional: required for /v1/stripe/webhook. */
  readonly stripeWebhookSecret?: string;
}

export const DEFAULT_X402_FACILITATOR_URL = 'https://x402.org/facilitator';
export const DEFAULT_X402_PRICE_USDC_UNITS = 1_000; // $0.001 in 6-decimal atomic units
export const DEFAULT_X402_EXTRACT_PRICE_USDC_UNITS = 10_000; // $0.01 — a "meaning" price, above raw capture
export const DEFAULT_X402_AUDIT_PRICE_USDC_UNITS = 2000; // $0.002 — audit price
export const DEFAULT_X402_VIDEO_PRICE_USDC_UNITS = 5_000; // $0.005 — video price (5x capture, below extract)
export const DEFAULT_COMPUTE_COST_USDC_UNITS_PER_REQUEST = 200; // $0.0002 amortized compute cost/page-load (override with your real infra/TPU cost)

/**
 * Rolling free-allowance defaults. Deliberately generous: this is growth spend
 * to seed usage, not a defensive cap, and at the $0.0002 amortized compute cost
 * above, 50 calls/day/IP is ~$0.01 of compute per IP per day.
 */
export const DEFAULT_ALLOWANCE_CALLS = 50;
export const DEFAULT_ALLOWANCE_WINDOW_HOURS = 24;
/**
 * Fleet-wide free-call circuit breaker per window. ~$4/day of worst-case
 * compute if fully spent. A runaway-spend guard, not a policy cap.
 */
export const DEFAULT_ALLOWANCE_GLOBAL_LIMIT = 20_000;
export const DEFAULT_PREVIEW_RATE_LIMIT = 10; // free preview requests/min/peer (override with WEBCAP_PREVIEW_RATE_LIMIT)

// WEBCAP_* tunables; every default preserves the previous on-the-wire behavior.
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000; // Fastify requestTimeout; base64 capture artifacts need headroom
export const DEFAULT_BODY_LIMIT_BYTES = 2_000_000; // Fastify bodyLimit
export const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000; // page-load timeout when the client sends none
export const DEFAULT_CAPTURE_TIMEOUT_CAP_MS = 60_000; // cap on a client-specified capture timeoutMs
export const DEFAULT_MODEL_TIMEOUT_MS = 30_000; // model extraction fetch timeout
export const DEFAULT_X402_MAX_TIMEOUT_MS = 300_000; // x402 maxTimeout (wire field is seconds: 300)
export const DEFAULT_WEBHOOK_RETRIES = 3; // watch webhook delivery attempts
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000; // per-attempt watch webhook timeout
export const DEFAULT_INVOICE_TTL_MS = 3_600_000; // invoice expiry window
export const DEFAULT_CREDITS = 100; // credits for POST /v1/invoice when the body omits `credits`
export const DEFAULT_PREVIEW_HEADINGS_LIMIT = 5; // free preview slice: headings
export const DEFAULT_PREVIEW_LINKS_LIMIT = 10; // free preview slice: links
export const DEFAULT_PREVIEW_MARKDOWN_LIMIT = 1_500; // free preview slice: markdown chars (mirrored in the OpenAPI doc)
export const DEFAULT_BAZAAR_CATALOG_URL = 'https://cdp.coinbase.com'; // CDP Bazaar catalog link
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 0; // 0 disables the artifact sweep
export const DEFAULT_WATCH_AI_MAX_TOKENS_PER_RUN = 10_000; // watch AI token budget: per-watch window (WATCH_AI_MAX_TOKENS_PER_RUN)
export const DEFAULT_WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW = 100_000; // watch AI token budget: shared global window (WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW)
export const ARTIFACT_SWEEP_INTERVAL_MS = 6 * 3_600_000; // retention sweep cadence
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid numeric env value: ${raw}`);
  return value;
}

/** Optional HMAC secret env (non-empty trimmed string); empty/unset -> undefined. */
function parseOptionalSecret(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

/** Optional spend-cap env (positive int); empty/unset -> undefined = unlimited. */
function parseOptionalCap(raw: string | undefined, envName: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${envName}: ${raw}`);
  return value;
}

/** Non-negative integer env (0 is a valid value, e.g. "retention disabled"); empty -> fallback. */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid non-negative integer env value: ${raw}`);
  return value;
}

/** Watch AI token budget env (positive int); empty/unset -> fallback, invalid names the env. */
function parseWatchAiBudget(raw: string | undefined, fallback: number, envName: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid ${envName}: ${raw}`);
  return value;
}

/** A human USDC price env (e.g. "0.001") -> atomic 6-decimal units; empty -> defaultUnits. */
function parseX402PriceUsdc(raw: string | undefined, defaultUnits: number, envName: string): number {
  if (raw === undefined || raw.trim() === '') return defaultUnits;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error(`invalid ${envName}: ${raw}`);
  const units = Math.round(usd * USDC_SCALE);
  if (units < 1) throw new Error(`${envName} too small (min 1 atomic unit): ${raw}`);
  return units;
}

/** A human USDC cost env (e.g. "0.002", may be "0") -> atomic 6-decimal units; empty -> defaultUnits. */
function parseComputeCostUsdcUnits(raw: string | undefined, defaultUnits: number): number {
  if (raw === undefined || raw.trim() === '') return defaultUnits;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid WEBCAP_COMPUTE_COST_USDC_PER_REQUEST: ${raw}`);
  return Math.round(usd * USDC_SCALE);
}

/** Optional address override env; empty/unset falls back, invalid throws. */
function parseAddressOverride(raw: string | undefined, fallback: string, name: string): string {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid address: ${raw}`);
  return raw;
}

function x402FacilitatorUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed !== '' ? trimmed : DEFAULT_X402_FACILITATOR_URL;
}

function bazaarCatalogUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed !== '' ? trimmed : DEFAULT_BAZAAR_CATALOG_URL;
}

/** Optional CDP key pair; both env vars set & non-empty, or both absent — exactly one throws. */
function parseCdpApiKey(env: NodeJS.ProcessEnv): { readonly id: string; readonly secret: string } | undefined {
  const id = (env.CDP_API_KEY_ID ?? '').trim();
  const secret = (env.CDP_API_KEY_SECRET ?? '').trim();
  if (id === '' && secret === '') return undefined;
  if (id === '' || secret === '') {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set together (both or neither)');
  }
  return { id, secret };
}

/** Public base URL (required); every capture's artifact.url is built from it. */
function parsePublicBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    throw new Error('WEBCAP_PUBLIC_BASE_URL is required (public base URL for artifact links)');
  }
  return trimmed;
}

/** Parse and validate the webcap environment. Throws on invalid config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebcapConfig {
  const rawChain = env.WEBCAP_CHAIN ?? 'base-sepolia';
  if (rawChain !== 'base-sepolia' && rawChain !== 'base' && rawChain !== 'local') {
    throw new Error(`unknown WEBCAP_CHAIN: ${rawChain}`);
  }
  const chainName: ChainName = rawChain;
  const base = CHAINS[chainName];

  let usdcContract = base.usdcContract;
  let rpcUrl = base.rpcUrl;
  if (chainName === 'local') {
    rpcUrl = env.WEBCAP_RPC_URL ?? 'http://127.0.0.1:8545';
    const localUsdc = env.LOCAL_USDC_CONTRACT ?? env.WEBCAP_USDC_ADDRESS;
    if (localUsdc === undefined || localUsdc === '') {
      throw new Error('LOCAL_USDC_CONTRACT (or WEBCAP_USDC_ADDRESS) is required when WEBCAP_CHAIN=local');
    }
    if (!isAddress(localUsdc)) {
      throw new Error(`LOCAL_USDC_CONTRACT is not a valid address: ${localUsdc}`);
    }
    usdcContract = localUsdc;
  }

  const merchantPrivateKey = env.USDC_MERCHANT_PRIVATE_KEY ?? '';
  const merchantAddress =
    merchantPrivateKey !== '' ? new Wallet(merchantPrivateKey).address : (env.WEBCAP_MERCHANT_ADDRESS ?? '');

  return {
    chain: { name: chainName, rpcUrl, chainId: base.chainId, usdcContract, explorer: base.explorer },
    chainId: base.chainId,
    rpcUrl,
    usdcAddress: usdcContract,
    merchantAddress,
    port: parsePositiveInt(env.WEBCAP_PORT, 8080),
    pollIntervalMs: parsePositiveInt(env.POLL_INTERVAL_MS, 30_000),
    merchantPrivateKey,
    dbPath: env.WEBCAP_DB ?? 'data/webcap.db',
    x402Network: chainName === 'local' ? undefined : X402_NETWORKS[chainName],
    x402Asset: parseAddressOverride(env.WEBCAP_X402_ASSET, usdcContract, 'WEBCAP_X402_ASSET'),
    x402PayTo: parseAddressOverride(env.WEBCAP_X402_PAY_TO, merchantAddress, 'WEBCAP_X402_PAY_TO'),
    x402PriceUsdcUnits: parseX402PriceUsdc(env.WEBCAP_X402_PRICE_USDC, DEFAULT_X402_PRICE_USDC_UNITS, 'WEBCAP_X402_PRICE_USDC'),
    x402ExtractPriceUsdcUnits: parseX402PriceUsdc(
      env.WEBCAP_X402_EXTRACT_PRICE_USDC,
      DEFAULT_X402_EXTRACT_PRICE_USDC_UNITS,
      'WEBCAP_X402_EXTRACT_PRICE_USDC',
    ),
    x402AuditPriceUsdcUnits: parseX402PriceUsdc(
      env.WEBCAP_X402_AUDIT_PRICE_USDC,
      DEFAULT_X402_AUDIT_PRICE_USDC_UNITS,
      'WEBCAP_X402_AUDIT_PRICE_USDC',
    ),
    x402VideoPriceUsdcUnits: parseX402PriceUsdc(
      env.WEBCAP_X402_VIDEO_PRICE_USDC,
      DEFAULT_X402_VIDEO_PRICE_USDC_UNITS,
      'WEBCAP_X402_VIDEO_PRICE_USDC',
    ),
    computeCostUsdcUnitsPerRequest: parseComputeCostUsdcUnits(
      env.WEBCAP_COMPUTE_COST_USDC_PER_REQUEST,
      DEFAULT_COMPUTE_COST_USDC_UNITS_PER_REQUEST,
    ),
    allowanceCalls: parseNonNegativeInt(env.WEBCAP_ALLOWANCE_CALLS, DEFAULT_ALLOWANCE_CALLS),
    allowanceWindowHours: parsePositiveInt(env.WEBCAP_ALLOWANCE_WINDOW_HOURS, DEFAULT_ALLOWANCE_WINDOW_HOURS),
    allowanceGlobalLimit: parseNonNegativeInt(env.WEBCAP_ALLOWANCE_GLOBAL_LIMIT, DEFAULT_ALLOWANCE_GLOBAL_LIMIT),
    contactEmail: (env.WEBCAP_CONTACT_EMAIL ?? '').trim() || undefined,
    indexVerifyHash: (env.WEBCAP_402INDEX_VERIFY_HASH ?? '').trim() || undefined,
    glamaClaim: (env.WEBCAP_GLAMA_CLAIM ?? '').trim() || undefined,
    modelApiBaseUrl: (env.MODEL_API_BASE_URL ?? '').trim(),
    modelApiKey: (env.MODEL_API_KEY ?? '').trim(),
    modelName: (env.MODEL_NAME ?? '').trim(),
    previewRateLimit: parsePositiveInt(env.WEBCAP_PREVIEW_RATE_LIMIT, DEFAULT_PREVIEW_RATE_LIMIT),
    x402FacilitatorUrl: x402FacilitatorUrl(env.X402_FACILITATOR_URL),
    cdpApiKey: parseCdpApiKey(env),
    publicBaseUrl: parsePublicBaseUrl(env.WEBCAP_PUBLIC_BASE_URL),
    requestTimeoutMs: parsePositiveInt(env.WEBCAP_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    bodyLimitBytes: parsePositiveInt(env.WEBCAP_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES),
    captureTimeoutMs: parsePositiveInt(env.WEBCAP_CAPTURE_TIMEOUT_MS, DEFAULT_CAPTURE_TIMEOUT_MS),
    captureTimeoutCapMs: parsePositiveInt(env.WEBCAP_CAPTURE_TIMEOUT_CAP_MS, DEFAULT_CAPTURE_TIMEOUT_CAP_MS),
    modelTimeoutMs: parsePositiveInt(env.WEBCAP_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS),
    x402MaxTimeoutMs: parsePositiveInt(env.WEBCAP_X402_MAX_TIMEOUT_MS, DEFAULT_X402_MAX_TIMEOUT_MS),
    webhookRetries: parsePositiveInt(env.WEBCAP_WEBHOOK_RETRIES, DEFAULT_WEBHOOK_RETRIES),
    webhookTimeoutMs: parsePositiveInt(env.WEBCAP_WEBHOOK_TIMEOUT_MS, DEFAULT_WEBHOOK_TIMEOUT_MS),
    invoiceTtlMs: parsePositiveInt(env.WEBCAP_INVOICE_TTL_MS, DEFAULT_INVOICE_TTL_MS),
    defaultCredits: parsePositiveInt(env.WEBCAP_DEFAULT_CREDITS, DEFAULT_CREDITS),
    previewHeadingsLimit: parsePositiveInt(env.WEBCAP_PREVIEW_HEADINGS_LIMIT, DEFAULT_PREVIEW_HEADINGS_LIMIT),
    previewLinksLimit: parsePositiveInt(env.WEBCAP_PREVIEW_LINKS_LIMIT, DEFAULT_PREVIEW_LINKS_LIMIT),
    previewMarkdownLimit: parsePositiveInt(env.WEBCAP_PREVIEW_MARKDOWN_LIMIT, DEFAULT_PREVIEW_MARKDOWN_LIMIT),
    bazaarCatalogUrl: bazaarCatalogUrl(env.WEBCAP_BAZAAR_CATALOG_URL),
    artifactRetentionDays: parseNonNegativeInt(env.WEBCAP_ARTIFACT_RETENTION_DAYS, DEFAULT_ARTIFACT_RETENTION_DAYS),
    spendCapUsdcUnits: parseOptionalCap(env.WEBCAP_SPEND_CAP_USDC_UNITS, 'WEBCAP_SPEND_CAP_USDC_UNITS'),
    spendCapCredits: parseOptionalCap(env.WEBCAP_SPEND_CAP_CREDITS, 'WEBCAP_SPEND_CAP_CREDITS'),
    artifactHmacSecret: parseOptionalSecret(env.WEBCAP_ARTIFACT_HMAC_SECRET),
    watchAiMaxTokensPerRun: parseWatchAiBudget(
      env.WATCH_AI_MAX_TOKENS_PER_RUN,
      DEFAULT_WATCH_AI_MAX_TOKENS_PER_RUN,
      'WATCH_AI_MAX_TOKENS_PER_RUN',
    ),
    watchAiMaxTokensGlobalWindow: parseWatchAiBudget(
      env.WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW,
      DEFAULT_WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW,
      'WATCH_AI_MAX_TOKENS_GLOBAL_WINDOW',
    ),
    stripeSecretKey: parseOptionalSecret(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: parseOptionalSecret(env.STRIPE_WEBHOOK_SECRET),
  };
}
