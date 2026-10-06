import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CaptureError } from '../../src/capture/errors.js';
import { closeApiFixture, errorEnvelope, makeApiFixture, type ApiFixture } from './fixture.js';

// The video route calls the real Playwright pipeline; stub captureVideo at the
// module seam (same pattern as tests/api/x402-video.test.ts) so the
// credit-rail tests prove gating + ledger without Chromium.
vi.mock('../../src/capture/video.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/capture/video.js')>();
  return {
    ...actual,
    captureVideo: vi.fn(async () => ({
      buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      mime: 'video/webm',
      bytes: 4,
    })),
  };
});

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/</loc></url>
<url><loc>https://example.com/about</loc></url>
</urlset>`;

/** Stub the map-lite discovery fetch plane: sitemap + robots resolve, everything else 404s. */
function stubDiscovery(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string) => {
      if (raw === 'https://example.com/sitemap.xml') return new Response(SITEMAP_XML, { status: 200 });
      if (raw === 'https://example.com/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200 });
      return new Response('not found', { status: 404 });
    }),
  );
}

function authed(fx: ApiFixture, url: string, payload: Record<string, unknown>) {
  return fx.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${fx.apiKey}` } });
}

describe('credit-metered products: auth gating', () => {
  let fx: ApiFixture;
  beforeAll(() => {
    fx = makeApiFixture();
  });
  afterAll(async () => {
    await closeApiFixture(fx);
  });

  it.each([
    ['/v1/extract', { url: 'https://example.com/' }],
    ['/v1/audit', { url: 'https://example.com/' }],
    ['/v1/map-lite', { url: 'https://example.com/' }],
    ['/v1/video', { url: 'https://example.com/' }],
    ['/v1/analyze', { url: 'https://example.com/', task: 'classification' }],
    ['/v1/analyze/batch', { urls: ['https://example.com/'], task: 'classification' }],
  ])('POST %s without a key is 401', async (url, payload) => {
    const res = await fx.app.inject({ method: 'POST', url, payload });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['/v1/extract', { url: 'https://example.com/' }],
    ['/v1/audit', { url: 'https://example.com/' }],
    ['/v1/map-lite', { url: 'https://example.com/' }],
    ['/v1/video', { url: 'https://example.com/' }],
    ['/v1/analyze', { url: 'https://example.com/', task: 'classification' }],
    ['/v1/analyze/batch', { urls: ['https://example.com/'], task: 'classification' }],
  ])('POST %s with an empty balance is 402 with a 1-credit top-up invoice', async (url, payload) => {
    const res = await authed(fx, url, payload);
    expect(res.statusCode).toBe(402);
    const err = errorEnvelope(res);
    expect(err.code).toBe('insufficient_credits');
    const detail = err.detail as Record<string, unknown>;
    expect(typeof detail.invoiceId).toBe('string');
    expect(detail.requiredUsdc).toBe(0.01);
    expect(detail.balance).toBe(0);
  });
});

describe('credit-metered products: happy paths charge 1 credit', () => {
  let fx: ApiFixture;
  beforeAll(() => {
    fx = makeApiFixture();
    stubDiscovery();
    fx.credits.grantCredits(fx.accountId, 20, 'credit-products-seed');
  });
  afterAll(async () => {
    await closeApiFixture(fx);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    stubDiscovery();
  });

  it('POST /v1/extract returns results + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/extract', { url: 'https://example.com/' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(19);
  });

  it('POST /v1/audit returns the audit + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/audit', { url: 'https://example.com/' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.audit).toBeDefined();
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(18);
  });

  it('POST /v1/map-lite returns discovered urls + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/map-lite', { url: 'https://example.com/', maxUrls: 5 });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(Array.isArray(json.urls)).toBe(true);
    expect((json.urls as unknown[]).length).toBeGreaterThan(0);
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(17);
  });

  it('POST /v1/video returns the artifact + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/video', { url: 'https://example.com/' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.artifact).toBeDefined();
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(16);
  });

  it('POST /v1/analyze returns the deterministic result + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/analyze', { url: 'https://example.com/', task: 'classification' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.task).toBe('classification');
    expect(json.result).toBeDefined();
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(15);
  });

  it('POST /v1/analyze/batch returns per-url results + creditsCharged + balance', async () => {
    const res = await authed(fx, '/v1/analyze/batch', {
      urls: ['https://example.com/', 'https://example.com/about'],
      task: 'accessibility',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as Record<string, unknown>;
    expect(json.task).toBe('accessibility');
    expect(Array.isArray(json.results)).toBe(true);
    expect((json.results as unknown[])).toHaveLength(2);
    expect(json.creditsCharged).toBe(1);
    expect(json.balance).toBe(14);
  });
});

describe('credit-metered products: the debit is refunded when compute fails', () => {
  it('extract refunds on 502', async () => {
    const fx = makeApiFixture({
      captureStructured: async (): Promise<never> => {
        throw new CaptureError('page load failed');
      },
    });
    try {
      fx.credits.grantCredits(fx.accountId, 3, 'credit-products-seed');
      const res = await authed(fx, '/v1/extract', { url: 'https://example.com/' });
      expect(res.statusCode).toBe(502);
      expect(errorEnvelope(res).code).toBe('extract_failed');
      expect(fx.accounts.getBalance(fx.accountId)).toBe(3);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('audit refunds on 502', async () => {
    const fx = makeApiFixture({
      captureStructured: async (): Promise<never> => {
        throw new CaptureError('page load failed');
      },
    });
    try {
      fx.credits.grantCredits(fx.accountId, 3, 'credit-products-seed');
      const res = await authed(fx, '/v1/audit', { url: 'https://example.com/' });
      expect(res.statusCode).toBe(502);
      expect(errorEnvelope(res).code).toBe('audit_failed');
      expect(fx.accounts.getBalance(fx.accountId)).toBe(3);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('analyze refunds on 502', async () => {
    const fx = makeApiFixture({
      captureStructured: async (): Promise<never> => {
        throw new CaptureError('page load failed');
      },
    });
    try {
      fx.credits.grantCredits(fx.accountId, 3, 'credit-products-seed');
      const res = await authed(fx, '/v1/analyze', { url: 'https://example.com/', task: 'sentiment' });
      expect(res.statusCode).toBe(502);
      expect(fx.accounts.getBalance(fx.accountId)).toBe(3);
    } finally {
      await closeApiFixture(fx);
    }
  });
});
