import { describe, expect, it } from 'vitest';
import { closeApiFixture, makeApiFixture, USDC_ADDRESS } from './fixture.js';
import { landingHtml } from '../../src/server/pages.js';
import {
  loadConfig,
  USDC_SCALE,
  WATCH_TOPUP_RUNS,
  watchTopUpPriceUsdcUnits,
  type WebcapConfig,
} from '../../src/config.js';

/** A real config for a live chain (exactly what loadConfig produces in that deploy). */
function chainConfig(chain: 'base' | 'base-sepolia', extra: NodeJS.ProcessEnv = {}): WebcapConfig {
  return loadConfig({ WEBCAP_CHAIN: chain, WEBCAP_PUBLIC_BASE_URL: 'https://webcap.example.com', ...extra });
}

/** WCAG 2.x relative luminance of a #rrggbb sRGB color. */
function relativeLuminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio between two #rrggbb sRGB colors. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a #rrggbb custom property out of served CSS; throws if absent. */
function cssVar(css: string, name: string): string {
  const m = css.match(new RegExp(`--${name}:(#[0-9a-fA-F]{6})`));
  if (m === null) throw new Error(`css var --${name} not found in served CSS`);
  const value = m[1];
  if (value === undefined) throw new Error(`css var --${name} match has no capture group`);
  return value;
}

describe('GET / (content negotiation: landing page + JSON front door)', () => {
  it('returns the landing page (200 text/html) by default, with pricing, OpenAPI and Bazaar links', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toBe('text/html; charset=utf-8');
      const html = res.payload;
      expect(html).toContain('$0.001');
      expect(html).toContain('$0.01');
      expect(html).toContain('/openapi.json');
      expect(html).toContain('Bazaar');
      expect(html).toContain('x402');
      expect(html).toContain('<link rel="icon" href="/icon.png">');
      expect(html).toContain('GET /v1/extract/preview');
      expect(html).toContain('href="#preview"');
      expect(html).toContain('Try it');
      // Hero now leads with value (screenshot, extract, monitor) — not payment rails
      expect(html).toContain('Free preview');
      expect(html).toContain('/v1/x402/capture');
    } finally {
      await closeApiFixture(fx);
    }
  });

  // A third-party trust record is keyed to the resource URL, so embedding a
  // badge id is only truthful while that record names the origin we advertise.
  // The kkj badges (ids 46929 capture / 46928 extract) were observed against
  // the pre-cutover ngrok host and were removed at cutover — they linked to
  // evidence for a domain we no longer serve. Re-add badges only together with
  // records for the current domain (`docs/operations/domain-cutover.md`).
  it('does not embed third-party trust records keyed to another host', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/' });
      const html = res.payload;
      expect(html).not.toContain('badge/x402/');
      expect(html).not.toContain('/x402/trust/');
      // The index itself stays referenced, host-agnostically.
      expect(html).toContain('x402 Trust Index');
      expect(html).toContain('https://5.75.142.199.sslip.io/x402/best');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('returns the pre-existing JSON front-door payload, deep-equal, for Accept: application/json', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json' } });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/json');
      // Snapshot of the pre-negotiation front-door shape (captured from the
      // running handler before the change); the payload must stay intact.
      expect(res.json()).toEqual({
        service: 'webcap',
        tagline:
          'Capture any URL as a screenshot, or extract its structured content + clean document-order markdown — paid per-request in USDC over x402 (HTTP 402).',
        endpoints: {
          free: [
            { path: 'GET /v1/extract/preview?url=...', note: 'bounded structured preview (rate-limited)' },
            { path: 'GET /v1/og?url=...', note: 'OG metadata' },
            { path: 'GET /v1/health', note: 'liveness + chain' },
            {
              path: 'POST /v1/x402/{capture,extract,audit,map-lite,video,analyze}',
              note: 'rolling free allowance: no wallet needed — an unpaid call runs the product free until the per-IP window is spent, then the same call answers the 402 challenge (X-Webcap-Allowance-* headers say where you stand)',
            },
            { path: 'POST /v1/feedback', note: 'free feedback channel (#bug #suggestion #pricing #docs #integration); human form at GET /feedback' },
          ],
          paid: [
            { path: 'POST /v1/x402/capture', usdc: 0.001, note: 'PNG/JPEG/PDF screenshot + free OG' },
            { path: 'POST /v1/x402/extract', usdc: 0.01, note: 'structured JSON; batch up to 50 URLs for one payment' },
            { path: 'POST /v1/x402/audit', usdc: 0.002, note: 'SEO basics + link/OG health in one call' },
            { path: 'POST /v1/x402/map-lite', usdc: 0.002, note: 'site URL list via sitemap/robots plus a 1-hop same-host crawl' },
            { path: 'POST /v1/x402/video', usdc: 0.005, note: 'scroll-capture WebM/VP8 video in one call' },
            { path: 'POST /v1/x402/analyze', usdc: 0.01, note: 'AI visual analysis: classification, accessibility, entities, sentiment' },
            { path: 'POST /v1/x402/analyze/batch', usdc: 0.01, note: 'batch AI analysis of up to 10 URLs for one payment' },
          ],
        },
        catalog: 'GET /v1/x402/service — full agent-discoverable descriptor + the exact x402 payment flow',
        agentGuide: 'AGENT.md — how an AI agent discovers + pays (gasless EIP-3009, no ETH)',
        payment: 'x402 disabled (WEBCAP_CHAIN=local)',
      });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('serves HTML when the client accepts both JSON and HTML', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/', headers: { accept: 'application/json, text/html' } });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toBe('text/html; charset=utf-8');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('serves HTML for wildcard Accept (curl/browser default)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toBe('text/html; charset=utf-8');
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('landing copy follows the configured chain', () => {
  it('base config: hero leads with value prop (not crypto payment details) and contains no sepolia/testnet wording', () => {
    const html = landingHtml(chainConfig('base'));
    const upper = html.toUpperCase();
    // Hero now leads with the product value, not payment method
    expect(upper).toContain('WEB CAPTURE API');
    expect(upper).toContain('SCREENSHOTS');
    expect(upper).toContain('EXTRACTION');
    expect(upper).not.toContain('SEPOLIA');
    expect(upper).not.toContain('TESTNET');
  });

  it('base config: hero shows value-led copy with free preview and capture examples', () => {
    const html = landingHtml(chainConfig('base'));
    // Hero now leads with value — capture, extract, analyze, then free preview
    expect(html).toContain('Free preview');
    expect(html).toContain('/v1/x402/capture');
    expect(html).toContain('/v1/x402/extract');
  });

  it('sepolia config: pricing section mentions testnet settlement, not mainnet', () => {
    const html = landingHtml(chainConfig('base-sepolia'));
    const upper = html.toUpperCase();
    // Pricing section shows the settlement info from copy.settlement
    expect(upper).toContain('BASE SEPOLIA');
    expect(upper).toContain('TESTNET');
    // Hero now leads with value, not network-specific payment details
    expect(html).toContain('WEB CAPTURE API');
  });

  it('local config: hero leads with value prop, not mainnet or sepolia', () => {
    const config = loadConfig({
      WEBCAP_CHAIN: 'local',
      LOCAL_USDC_CONTRACT: USDC_ADDRESS,
      WEBCAP_PUBLIC_BASE_URL: 'http://localhost:8080',
    });
    const upper = landingHtml(config).toUpperCase();
    // Hero now leads with the product value, not chain/payment details
    expect(upper).toContain('WEB CAPTURE API');
    expect(upper).not.toContain('MAINNET');
  });

  it('top-up price text equals the value computed from the config helpers', () => {
    // non-default prices: a hardcoded "$0.10"/"$1.00" page would fail these.
    const config = chainConfig('base', {
      WEBCAP_X402_PRICE_USDC: '0.002',
      WEBCAP_X402_EXTRACT_PRICE_USDC: '0.015',
    });
    const html = landingHtml(config);
    const captureTopUpUsd = (watchTopUpPriceUsdcUnits('capture', config) / USDC_SCALE).toFixed(2);
    const extractTopUpUsd = (watchTopUpPriceUsdcUnits('extract', config) / USDC_SCALE).toFixed(2);
    expect(captureTopUpUsd).toBe('0.20');
    expect(extractTopUpUsd).toBe('1.50');
    expect(html).toContain(`$${captureTopUpUsd} <small>/ ${WATCH_TOPUP_RUNS} runs</small>`);
    expect(html).toContain(`$${extractTopUpUsd} <small>/ ${WATCH_TOPUP_RUNS} runs</small>`);
    expect(html).toContain(`${WATCH_TOPUP_RUNS} × $0.002`);
    expect(html).toContain(`${WATCH_TOPUP_RUNS} × $0.015`);
  });

  it('capture copy does not claim OG metadata inside the capture (names GET /v1/og instead)', () => {
    const html = landingHtml(chainConfig('base'));
    expect(html).not.toContain('plus free OG metadata');
    expect(html).toContain('GET /v1/og');
  });
});

describe('landing CSS accessibility (served /)', () => {
  it('served CSS: --faint has >= 4.5:1 contrast against --bg (WCAG AA for small text)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/' });
      const css = res.payload;
      const ratio = contrastRatio(cssVar(css, 'faint'), cssVar(css, 'bg'));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('served CSS defines a :focus-visible rule (visible keyboard focus ring)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/' });
      expect(res.payload).toContain(':focus-visible');
    } finally {
      await closeApiFixture(fx);
    }
  });
});
