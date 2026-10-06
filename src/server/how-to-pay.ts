/**
 * How to actually pay, for an agent that has never used x402 before.
 *
 * Extracted verbatim from the retired trial gate (src/server/trial-auth.ts),
 * which was deleted when the wallet-signed trials were replaced by the rolling
 * free allowance. Field names mirror the 402 challenge (`accepts[0]`) so the
 * two agree: rail, scheme, network, asset and payTo are read from the same
 * config the challenges use.
 */
import { USDC_SCALE, type WebcapConfig } from '../config.js';

export interface HowToPay {
  readonly rail: 'x402';
  readonly scheme: 'exact';
  readonly network: string | null;
  readonly asset: string | null;
  readonly payTo: string | null;
  readonly flow: readonly string[];
  readonly guide: string;
  readonly openapi: string;
}

/**
 * One entry in the paid catalog an agent can move to once its free capacity is
 * spent. `endpoint` keeps the "METHOD /path" shape the paidNext pointers use.
 */
export interface PaidOption {
  readonly endpoint: string;
  readonly priceUsdcUnits: number;
  readonly priceUsdc: number;
  readonly note: string;
}

/**
 * The complete paid catalog, priced from config. This is the single source of
 * truth for every paidNext pointer, so an agent that exhausts its free calls
 * always receives the whole menu (prices included) instead of an empty one.
 * Prices mirror the 402 challenges; `analyze/batch` is not on the agent tool
 * surface and stays paid-only.
 */
export function paidCatalogFor(config: WebcapConfig): PaidOption[] {
  const rows: Array<[string, number, string]> = [
    ['POST /v1/x402/capture', config.x402PriceUsdcUnits, 'screenshot a URL as PNG/JPEG/PDF'],
    ['POST /v1/x402/extract', config.x402ExtractPriceUsdcUnits, 'structured content, or a batch of up to 50 URLs for one payment'],
    ['POST /v1/x402/audit', config.x402AuditPriceUsdcUnits, 'SEO + link/OG health audit'],
    ['POST /v1/x402/map-lite', config.x402AuditPriceUsdcUnits, 'site URL list'],
    ['POST /v1/x402/video', config.x402VideoPriceUsdcUnits, 'scroll-capture to WebM/VP8'],
    ['POST /v1/x402/analyze', config.x402ExtractPriceUsdcUnits, 'visual analysis (one URL)'],
    ['POST /v1/x402/analyze/batch', config.x402ExtractPriceUsdcUnits, 'batch visual analysis of up to 10 URLs for one payment'],
  ];
  return rows.map(([endpoint, priceUsdcUnits, note]) => ({
    endpoint,
    priceUsdcUnits,
    priceUsdc: priceUsdcUnits / USDC_SCALE,
    note,
  }));
}

export function howToPayFor(config: WebcapConfig): HowToPay {
  return {
    rail: 'x402',
    scheme: 'exact',
    // null when x402 is disabled (WEBCAP_CHAIN=local has no real USDC).
    network: config.x402Network ?? null,
    asset: config.x402Asset ?? null,
    payTo: config.x402PayTo ?? null,
    flow: [
      'POST the paid endpoint with your JSON body and no payment header',
      'read the 402 response: accepts[0] carries scheme/network/asset/amount/payTo',
      'sign a gasless EIP-3009 transferWithAuthorization from your wallet (the facilitator pays gas)',
      'retry the same POST with the PAYMENT-SIGNATURE header; the result is returned once it settles',
    ],
    guide: `${config.publicBaseUrl}/skill.md`,
    openapi: `${config.publicBaseUrl}/openapi.json`,
  };
}