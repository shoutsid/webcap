import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CaptureError } from '../../src/capture/errors.js';
import type { PageStructure, StructuredCapture } from '../../src/capture/pipeline.js';
import { USDC_SCALE } from '../../src/config.js';
import { closeApiFixture, makeApiFixture } from './fixture.js';

const sha256 = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

describe('GET /v1/extract/preview (free, rate-limited funnel)', () => {
  it('GET / with Accept: application/json returns the service map (JSON front door)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json' } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { service: string; endpoints: { paid: Array<{ path: string }>; free: Array<{ path: string; note?: string }> } };
      expect(body.service).toBe('webcap');
      expect(body.endpoints.paid.map((p) => p.path)).toEqual(['POST /v1/x402/capture', 'POST /v1/x402/extract', 'POST /v1/x402/audit', 'POST /v1/x402/map-lite', 'POST /v1/x402/video', 'POST /v1/x402/analyze', 'POST /v1/x402/analyze/batch']);
      // The retired trial rail is gone; the rolling allowance replaces it.
      expect(body.endpoints.free.some((e) => e.path.includes('/trial'))).toBe(false);
      expect(body.endpoints.free.some((e) => String(e.note).includes('rolling free allowance'))).toBe(true);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('returns a truncated structured preview (no payment, no auth)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        url: string;
        preview: { title: string; wordCount: number; markdown: string };
        truncated: boolean;
        upgrade: { endpoint: string };
        freeAllowance: { note: string };
        paidUpgrade: { endpoint: string; priceUsdc: number; priceUsdcUnits: number; howToPay: string; guide: string };
      };
      expect(body.url).toBe('https://example.com/');
      expect(body.preview.title).toBe('Stub Title');
      expect(body.preview.wordCount).toBe(4);
      expect(typeof body.preview.markdown).toBe('string');
      expect(body.truncated).toBe(true);
      expect(body.upgrade.endpoint).toBe('POST /v1/x402/extract');
      expect(body.freeAllowance.note).toContain('rolling per-IP allowance');
      expect(body.paidUpgrade.endpoint).toBe('POST /v1/x402/extract');
      expect(body.paidUpgrade.priceUsdcUnits).toBe(fx.config.x402ExtractPriceUsdcUnits);
      expect(body.paidUpgrade.priceUsdc).toBe(fx.config.x402ExtractPriceUsdcUnits / USDC_SCALE);
      expect(body.paidUpgrade.guide.endsWith('/skill.md')).toBe(true);
      expect(Object.keys(body.paidUpgrade).sort()).toEqual(['endpoint', 'guide', 'howToPay', 'priceUsdc', 'priceUsdcUnits']);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('surfaces where the previewed content came from (source/words/truncated)', async () => {
    const fx = makeApiFixture({
      previewFallback: async (): Promise<PageStructure> => ({
        title: 'Scoped Title',
        description: '',
        headings: [{ level: 1, text: 'Scoped' }],
        paragraphs: ['Kept paragraph.'],
        links: [],
        images: [],
        wordCount: 120,
        markdown: '# Scoped\n\nKept paragraph.',
        content: { source: 'article', words: 3, truncated: false },
      }),
    });
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/scoped' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { preview: { content?: { source: string; words: number; truncated: boolean } } };
      expect(body.preview.content).toEqual({ source: 'article', words: 3, truncated: false });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('422 on a missing url', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview' });
      expect(res.statusCode).toBe(422);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('byte-pins the 422 envelope for a missing url (regression lock on today\'s bytes)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview' });
      expect(res.statusCode).toBe(422);
      expect(sha256(res.body)).toBe('42065384bf8e07ca97cab1f5fc7fb561e4326c9f2cf0c1f30f3507194b3607f7');
      expect(res.body).toBe('{"error":{"code":"unprocessable","message":"url query parameter is required"}}');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('byte-pins the 422 envelope for an invalid url (regression lock on today\'s bytes)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=not+a+url' });
      expect(res.statusCode).toBe(422);
      expect(sha256(res.body)).toBe('f9cd05a702d6b28e3bcbe7cf0dabf29fa953a7f67471839f59386aa8f26e3b3c');
      expect(res.body).toBe('{"error":{"code":"unprocessable","message":"invalid url"}}');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('falls back to HTTP-only extraction when structured capture fails', async () => {
    const fx = makeApiFixture({
      captureStructured: async (): Promise<StructuredCapture> => {
        throw new CaptureError('boom');
      },
    });
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
      // The fallback fetches the page via HTTP-only and returns a degraded preview
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        url: string;
        preview: { title: string; wordCount: number };
        truncated: boolean;
      };
      expect(body.url).toBe('https://example.com/');
      expect(typeof body.preview.title).toBe('string');
      expect(body.truncated).toBe(true);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('rate-limits per client (429 after the per-window budget is exhausted)', async () => {
    const fx = makeApiFixture();
    try {
      let last = 0;
      for (let i = 0; i < 15; i += 1) {
        const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
        last = res.statusCode;
      }
      expect(last).toBe(429);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('rate-limit 429 carries a machine-readable paidUpgrade next-step', async () => {
    const fx = makeApiFixture();
    try {
      let last429: Awaited<ReturnType<typeof fx.app.inject>> | undefined = undefined;
      for (let i = 0; i < 15; i += 1) {
        const res = await fx.app.inject({ method: 'GET', url: '/v1/extract/preview?url=https://example.com/' });
        if (res.statusCode === 429) {
          last429 = res;
        }
      }
      if (last429 === undefined) {
        throw new Error('expected a 429 preview response after exhausting the budget');
      }
      expect(last429.statusCode).toBe(429);
      const retryAfter = last429.headers['retry-after'];
      expect(typeof retryAfter).toBe('string');
      const retryAfterStr = retryAfter as string;
      expect(String(Number.parseInt(retryAfterStr, 10))).toBe(retryAfterStr);
      expect(Number.parseInt(retryAfterStr, 10)).toBeGreaterThanOrEqual(1);
      type RateLimitedEnvelope = {
        error: {
          code: string;
          message: string;
          detail: {
            retryAfterSeconds: number;
            paidUpgrade: {
              endpoint: string;
              priceUsdc: number;
              priceUsdcUnits: number;
              guide: string;
              howToPay: string;
            };
          };
        };
      };
      const body = last429.json() as RateLimitedEnvelope;
      expect(body.error.code).toBe('rate_limited');
      expect(typeof body.error.detail.retryAfterSeconds).toBe('number');
      expect({
        endpoint: body.error.detail.paidUpgrade.endpoint,
        priceUsdc: body.error.detail.paidUpgrade.priceUsdc,
        priceUsdcUnits: body.error.detail.paidUpgrade.priceUsdcUnits,
      }).toEqual({
        endpoint: 'POST /v1/x402/extract',
        priceUsdc: fx.config.x402ExtractPriceUsdcUnits / USDC_SCALE,
        priceUsdcUnits: fx.config.x402ExtractPriceUsdcUnits,
      });
      expect(typeof body.error.detail.paidUpgrade.guide).toBe('string');
      expect(body.error.detail.paidUpgrade.guide.endsWith('/skill.md')).toBe(true);
      expect(typeof body.error.detail.paidUpgrade.howToPay).toBe('string');
      expect(body.error.detail.paidUpgrade.howToPay.length).toBeGreaterThan(0);
    } finally {
      await closeApiFixture(fx);
    }
  });
});
