import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeMockFacilitator } from '../helpers/facilitator.js';
import { openDb, type Db } from '../../src/db/index.js';
import { makeArtifactRepo } from '../../src/db/artifacts.js';
import { buildApp } from '../../src/server/server.js';
import { FREE_BATCH_MAX_URLS } from '../../src/db/allowance.js';
import type { WebcapConfig } from '../../src/config.js';
import type { CaptureRequest, CaptureResult, PageStructure, StructuredCapture } from '../../src/capture/pipeline.js';
import type { OgResult } from '../../src/capture/og.js';

// The rolling free allowance is the replacement for the wallet-signed trials:
// an agent with no wallet calls a paid endpoint and gets the real product,
// until its window is spent. These tests prove the paywall actually stands
// down for a granted call, and that the controls around it hold.

const MERCHANT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const FAKE_STRUCTURE: PageStructure = {
  title: 'Stub Title',
  description: 'Stub description',
  headings: [{ level: 1, text: 'Heading One' }],
  paragraphs: ['A stub paragraph.'],
  links: [{ href: 'https://example.com/', text: 'home' }],
  images: [{ src: 'https://example.com/i.png', alt: 'stub' }],
  wordCount: 4,
  markdown: '# Stub Title\n\nA stub paragraph.',
};

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly dir: string;
  readonly db: Db;
}

function harness(allowance: Partial<Pick<WebcapConfig, 'allowanceCalls' | 'allowanceWindowHours' | 'allowanceGlobalLimit'>>): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'webcap-allowance-api-'));
  const db = openDb(join(dir, 'a.db'));
  const config: WebcapConfig = {
    chain: { name: 'base-sepolia', rpcUrl: 'https://sepolia.base.org', chainId: 84532, usdcContract: USDC_ADDRESS, explorer: '' },
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcAddress: USDC_ADDRESS,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: join(dir, 'a.db'),
    x402Network: 'eip155:84532',
    x402Asset: USDC_ADDRESS,
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
    ...allowance,
  };
  const app = buildApp({
    db,
    config,
    capture: async (req: CaptureRequest): Promise<CaptureResult> => ({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      format: req.format ?? 'png',
      bytes: 4,
    }),
    captureStructured: async (): Promise<StructuredCapture> => ({ html: '<html></html>', structure: FAKE_STRUCTURE }),
    previewFallback: async (): Promise<PageStructure> => FAKE_STRUCTURE,
    og: async (req: { url: string }): Promise<OgResult> => ({ url: req.url, title: 'Stub Title' }),
    artifacts: makeArtifactRepo(db),
    x402Facilitator: makeMockFacilitator('eip155:84532').facilitator,
  });
  return { app, dir, db };
}

async function close(h: Harness): Promise<void> {
  await h.app.close();
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

const CAPTURE_BODY = { url: 'https://example.com/' };

describe('rolling free allowance — paywall bypass', () => {
  it('serves a real capture for free, with the allowance state and no settlement receipt', async () => {
    const h = harness({ allowanceCalls: 3, allowanceWindowHours: 24 });
    try {
      const res = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: CAPTURE_BODY });
      expect(res.statusCode).toBe(200);
      // No facilitator settlement happened, so there is no receipt...
      expect(res.headers['payment-response']).toBeUndefined();
      // ...and the caller can see exactly where it stands.
      expect(res.headers['x-webcap-allowance-granted']).toBe('true');
      expect(res.headers['x-webcap-allowance-limit']).toBe('3');
      expect(res.headers['x-webcap-allowance-remaining']).toBe('2');
    } finally {
      await close(h);
    }
  });

  it('starts answering the 402 challenge once the window is spent', async () => {
    const h = harness({ allowanceCalls: 2, allowanceWindowHours: 24 });
    try {
      for (let i = 0; i < 2; i += 1) {
        const free = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: CAPTURE_BODY });
        expect(free.statusCode).toBe(200);
      }
      const paid = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: CAPTURE_BODY });
      expect(paid.statusCode).toBe(402);
      // The challenge is still the real one, so the caller can pay and retry.
      expect(paid.headers['payment-required']).toBeDefined();
      expect(paid.headers['x-webcap-allowance-granted']).toBe('false');
    } finally {
      await close(h);
    }
  });

  it('does not spend the allowance on a call that failed', async () => {
    const h = harness({ allowanceCalls: 1, allowanceWindowHours: 24 });
    try {
      // Missing url -> 422 from the handler. That must not cost the free call.
      const bad = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: {} });
      expect(bad.statusCode).toBe(422);

      const good = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: CAPTURE_BODY });
      expect(good.statusCode).toBe(200);
      expect(good.headers['x-webcap-allowance-remaining']).toBe('0');
    } finally {
      await close(h);
    }
  });

  it('ignores a client-supplied allowance marker', async () => {
    // The marker is an internal header. A caller asserting it must not mint a
    // free call when the rail is off.
    const h = harness({ allowanceCalls: 0, allowanceWindowHours: 24 });
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/x402/capture',
        headers: { 'x-webcap-allowance': 'granted' },
        payload: CAPTURE_BODY,
      });
      expect(res.statusCode).toBe(402);
    } finally {
      await close(h);
    }
  });

  it('leaves a paying caller on the paid path', async () => {
    const h = harness({ allowanceCalls: 5, allowanceWindowHours: 24 });
    try {
      // A caller that presents a payment header is not given the free rail, so
      // a bogus credential fails verification instead of being served gratis.
      const paying = await h.app.inject({
        method: 'POST',
        url: '/v1/x402/capture',
        headers: { 'payment-signature': 'not-a-real-payment' },
        payload: CAPTURE_BODY,
      });
      expect(paying.statusCode).not.toBe(200);

      // And that attempt did not consume the free budget.
      const free = await h.app.inject({ method: 'POST', url: '/v1/x402/capture', payload: CAPTURE_BODY });
      expect(free.statusCode).toBe(200);
      expect(free.headers['x-webcap-allowance-remaining']).toBe('4');
    } finally {
      await close(h);
    }
  });
});

describe('rolling free allowance — batch ceiling', () => {
  const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://example.com/page-${i}`);

  it(`serves a free batch up to ${FREE_BATCH_MAX_URLS} URLs`, async () => {
    const h = harness({ allowanceCalls: 10, allowanceWindowHours: 24 });
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/x402/extract',
        payload: { urls: urls(FREE_BATCH_MAX_URLS) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-webcap-allowance-granted']).toBe('true');
    } finally {
      await close(h);
    }
  });

  it('refuses a free batch above the ceiling, and does not spend the allowance', async () => {
    const h = harness({ allowanceCalls: 10, allowanceWindowHours: 24 });
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/x402/extract',
        payload: { urls: urls(FREE_BATCH_MAX_URLS + 1) },
      });
      expect(res.statusCode).toBe(422);
      expect(String(res.body)).toContain(String(FREE_BATCH_MAX_URLS));

      // Still granted afterwards: the refusal was not a free call.
      const single = await h.app.inject({ method: 'POST', url: '/v1/x402/extract', payload: { url: 'https://example.com/' } });
      expect(single.statusCode).toBe(200);
      expect(single.headers['x-webcap-allowance-remaining']).toBe('9');
    } finally {
      await close(h);
    }
  });
});