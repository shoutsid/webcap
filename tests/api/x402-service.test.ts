import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../../src/db/index.js';
import { makeArtifactRepo } from '../../src/db/artifacts.js';
import {
  USDC_SCALE,
  WATCH_TOPUP_RUNS,
  watchTopUpPriceUsdcUnits,
  type ChainName,
  type WebcapConfig,
} from '../../src/config.js';
import { buildApp } from '../../src/server/server.js';
import type { CaptureRequest, CaptureResult, PageStructure, StructuredCapture } from '../../src/capture/pipeline.js';
import type { OgResult } from '../../src/capture/og.js';
import { FAKE_PNG, MERCHANT_ADDRESS, closeApiFixture, errorEnvelope, makeApiFixture } from './fixture.js';
import { makeMockFacilitator } from '../helpers/facilitator.js';

type TestChain = 'base' | 'base-sepolia';

interface ChainSpec {
  readonly name: ChainName;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly usdc: string;
  readonly explorer: string;
  readonly network: 'eip155:8453' | 'eip155:84532';
}

const CHAIN_SPECS: Record<TestChain, ChainSpec> = {
  base: {
    name: 'base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: 'https://basescan.org',
    network: 'eip155:8453',
  },
  'base-sepolia': {
    name: 'base-sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
    network: 'eip155:84532',
  },
};

interface PaidEndpointEntry {
  readonly [key: string]: unknown;
}

interface X402Fixture {
  readonly app: FastifyInstance;
  readonly config: WebcapConfig;
  readonly dir: string;
  readonly db: Db;
}

/**
 * A real x402-enabled app (in-memory facilitator fake, no chain access) for the
 * given chain, so the descriptor/well-known routes answer instead of 503ing.
 */
function makeX402Fixture(chain: TestChain): X402Fixture {
  const spec = CHAIN_SPECS[chain];
  const dir = mkdtempSync(join(tmpdir(), `webcap-x402svc-${chain}-`));
  const db = openDb(join(dir, 'x402.db'));
  const config: WebcapConfig = {
    chain: { name: spec.name, rpcUrl: spec.rpcUrl, chainId: spec.chainId, usdcContract: spec.usdc, explorer: spec.explorer },
    chainId: spec.chainId,
    rpcUrl: spec.rpcUrl,
    usdcAddress: spec.usdc,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: join(dir, 'x402.db'),
    x402Network: spec.network,
    x402Asset: spec.usdc,
    x402PayTo: MERCHANT_ADDRESS,
    x402PriceUsdcUnits: 1_000,
    x402ExtractPriceUsdcUnits: 10_000,
    x402AuditPriceUsdcUnits: 2_000,
    x402VideoPriceUsdcUnits: 5_000,
    computeCostUsdcUnitsPerRequest: 200,
    modelApiBaseUrl: '',
    modelApiKey: '',
    modelName: '',
    x402FacilitatorUrl: 'https://x402.org/facilitator',
    publicBaseUrl: 'http://localhost:8080',
    cdpApiKey: undefined,
  };
  const capture = async (req: CaptureRequest): Promise<CaptureResult> => ({
    buffer: FAKE_PNG,
    format: req.format ?? 'png',
    bytes: FAKE_PNG.length,
  });
  const structure: PageStructure = {
    title: 'Stub Title',
    description: 'Stub description',
    headings: [],
    paragraphs: [],
    links: [],
    images: [],
    wordCount: 0,
    markdown: '',
  };
  const captureStructured = async (): Promise<StructuredCapture> => ({ html: '<html></html>', structure });
  const og = async (req: { url: string }): Promise<OgResult> => ({ url: req.url, title: 'Stub Title' });
  const app = buildApp({
    db,
    config,
    capture,
    captureStructured,
    og,
    artifacts: makeArtifactRepo(db),
    x402Facilitator: makeMockFacilitator(spec.network).facilitator,
  });
  return { app, config, dir, db };
}

async function closeX402Fixture(fx: X402Fixture): Promise<void> {
  await fx.app.close();
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

describe('GET /v1/x402/service (canonical agent descriptor)', () => {
  it('lists the watch top-up in paidEndpoints with the config-derived pack prices, after capture + extract', async () => {
    const fx = makeX402Fixture('base');
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/x402/service' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { service: string; paidEndpoints: PaidEndpointEntry[]; freeEndpoints: Array<{ method: string; path: string; note: string }> };
      expect(body.service).toBe('webcap');
      expect(body.paidEndpoints.map((e) => e.path)).toEqual([
        '/v1/x402/capture',
        '/v1/x402/extract',
        '/v1/x402/audit',
        '/v1/x402/map-lite',
        '/v1/x402/video',
        '/v1/x402/analyze',
        '/v1/x402/analyze/batch',
        '/v1/x402/watches/topup',
      ]);
      const capture = body.paidEndpoints[0];
      const extract = body.paidEndpoints[1];
      const topup = body.paidEndpoints.find((e) => e.path === '/v1/x402/watches/topup');
      expect(topup).toBeDefined();
      if (topup === undefined) throw new Error('topup entry missing from paidEndpoints');
      expect(topup.method).toBe('POST');
      // Pack prices are derived from config: watch mode unit price x WATCH_TOPUP_RUNS.
      expect(topup.priceUsdc).toBe(watchTopUpPriceUsdcUnits('capture', fx.config) / USDC_SCALE);
      expect(topup.atomicUnits).toBe(String(watchTopUpPriceUsdcUnits('capture', fx.config)));
      expect(topup.usdcMax).toBe(watchTopUpPriceUsdcUnits('extract', fx.config) / USDC_SCALE);
      expect(typeof topup.body).toBe('object');
      expect(String(topup.note)).toContain(String(WATCH_TOPUP_RUNS));
      // The pre-existing entries keep their config-derived prices (no drift).
      expect(capture?.priceUsdc).toBe(fx.config.x402PriceUsdcUnits / USDC_SCALE);
      expect(extract?.priceUsdc).toBe(fx.config.x402ExtractPriceUsdcUnits / USDC_SCALE);
      // The rolling free allowance is advertised in freeEndpoints, and the
      // retired wallet-signed trial rail no longer appears anywhere.
      const allowance = body.freeEndpoints.find((e) => String(e.path).startsWith('/v1/x402/{'));
      expect(allowance?.method).toBe('ANY');
      expect(String(allowance?.note)).toContain('rolling free allowance');
      expect(body.freeEndpoints.some((e) => String(e.path).includes('/trial'))).toBe(false);
      // The feedback route is a free endpoint on the canonical descriptor too.
      const feedback = body.freeEndpoints.find((e) => e.path === '/v1/feedback');
      expect(feedback?.method).toBe('POST');
      expect(String(feedback?.note)).toContain('rate-limited 60/hr');
    } finally {
      await closeX402Fixture(fx);
    }
  });

  it('advertises video + map-lite in paidEndpoints with config-derived prices (RED)', async () => {
    const fx = makeX402Fixture('base');
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/x402/service' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        paidEndpoints: PaidEndpointEntry[];
        howToPay: string;
      };
      expect(body.paidEndpoints.map((e) => e.path)).toEqual([
        '/v1/x402/capture',
        '/v1/x402/extract',
        '/v1/x402/audit',
        '/v1/x402/map-lite',
        '/v1/x402/video',
        '/v1/x402/analyze',
        '/v1/x402/analyze/batch',
        '/v1/x402/watches/topup',
      ]);
      const video = body.paidEndpoints.find((e) => e.path === '/v1/x402/video');
      const mapLite = body.paidEndpoints.find((e) => e.path === '/v1/x402/map-lite');
      expect(video).toBeDefined();
      expect(mapLite).toBeDefined();
      if (video === undefined || mapLite === undefined) throw new Error('video/map-lite entries missing');
      expect(video.method).toBe('POST');
      expect(video.atomicUnits).toBe(String(fx.config.x402VideoPriceUsdcUnits));
      expect(video.priceUsdc).toBe(fx.config.x402VideoPriceUsdcUnits / USDC_SCALE);
      expect(mapLite.method).toBe('POST');
      expect(mapLite.atomicUnits).toBe(String(fx.config.x402AuditPriceUsdcUnits));
      expect(mapLite.priceUsdc).toBe(fx.config.x402AuditPriceUsdcUnits / USDC_SCALE);
      expect(String(body.howToPay)).toContain('/v1/x402/video');
      expect(String(body.howToPay)).toContain('/v1/x402/map-lite');
    } finally {
      await closeX402Fixture(fx);
    }
  });
});

describe('GET /v1/extract/preview 429 back-off', () => {
  it('429 carries a Retry-After header (integer seconds >= 1) matching error.detail.retryAfterSeconds', async () => {
    const fx = makeApiFixture();
    try {
      let res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
      for (let i = 1; i < 11; i += 1) {
        res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
      }
      expect(res.statusCode).toBe(429);
      const header = res.headers['retry-after'];
      expect(typeof header).toBe('string');
      const retryAfterSeconds = Number(header);
      expect(Number.isInteger(retryAfterSeconds)).toBe(true);
      expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(retryAfterSeconds).toBeLessThanOrEqual(60);
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('rate_limited');
      expect(envelope.detail?.retryAfterSeconds).toBe(retryAfterSeconds);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('GET /.well-known/x402 catalog copy (chain-conditional)', () => {
  it('uses the Base mainnet copy on the base chain (byte-identical to the prior hardcoded copy)', async () => {
    const fx = makeX402Fixture('base');
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/.well-known/x402' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { description: string };
      expect(body.description).toBe(
        'Pay-per-call web capture on Base mainnet: one-time screenshots (PNG/JPEG/PDF + free Open Graph metadata), structured content extraction, and scheduled monitoring with change-detection webhooks. All paid routes settle gasless USDC via x402 (HTTP 402).',
      );
    } finally {
      await closeX402Fixture(fx);
    }
  });

  it('uses the Base Sepolia testnet copy on the base-sepolia chain', async () => {
    const fx = makeX402Fixture('base-sepolia');
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/.well-known/x402' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { description: string };
      expect(body.description).toContain('Pay-per-call web capture on Base Sepolia (testnet):');
      expect(body.description).not.toContain('mainnet');
      expect(body.description).toContain('scheduled monitoring with change-detection webhooks');
    } finally {
      await closeX402Fixture(fx);
    }
  });

  it('uses the local dev-chain copy on the local chain (default fixture)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/.well-known/x402' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { description: string };
      expect(body.description).toContain('Pay-per-call web capture on a local Anvil dev chain:');
      expect(body.description).not.toContain('mainnet');
    } finally {
      await closeApiFixture(fx);
    }
  });
});
