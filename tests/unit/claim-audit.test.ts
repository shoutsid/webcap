/**
 * The claim audit turns "an agent found a stale claim" into a command. Its
 * parsers are the part that can silently stop working (a regex that matches
 * nothing reports a clean bill of health, which is worse than no audit), so
 * they are pinned here — offline, against both fixtures and the real docs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractEndpointClaims,
  extractEnvPriceClaims,
  extractPriceClaims,
  extractServicePrices,
  isX402Path,
  PRICE_ENV_TO_PATH,
} from '../../scripts/claim-audit.js';

const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');

const SKILL_TABLE = [
  '| Purpose | Request | Price (USDC) |',
  '| --- | --- | --- |',
  '| Screenshot | POST /v1/x402/capture {"url"} | $0.001 |',
  '| Watch top-up (100 runs) | POST /v1/x402/watches/topup {"watchId", "runs": 100} | $0.1 (capture watch) / $1 (extract watch) |',
  '| Structured preview | GET /v1/extract/preview?url=… | free, rate-limited per IP |',
].join('\n');

describe('claim audit parsers', () => {
  it('finds METHOD /path claims and marks placeholder ids as families', () => {
    const text = [
      'GET /v1/health and POST /v1/x402/capture are documented.',
      'Poll the job at GET /v1/capture/jobs/{id} until it finishes.',
      'DELETE /v1/watches/:id removes it.',
      'Ignore the bare / and prose mentions.',
    ].join('\n');
    const claims = extractEndpointClaims(text, 'fixture');
    expect(claims.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/health',
      'POST /v1/x402/capture',
      'GET /v1/capture/jobs',
      'DELETE /v1/watches',
    ]);
    expect(claims.map((c) => c.template)).toEqual([false, false, true, true]);
  });

  it('reads exactly one price per table row and skips rows it cannot attribute', () => {
    const claims = extractPriceClaims(SKILL_TABLE, 'skill.md');
    // The top-up row quotes two prices (mode-dependent) and the preview row is
    // free: neither is a checkable per-route claim.
    expect(claims).toEqual([
      { method: 'POST', path: '/v1/x402/capture', usd: 0.001, source: 'skill.md' },
    ]);
  });

  it('maps configuration-table price rows to the route each one prices', () => {
    const claims = extractEnvPriceClaims(readme, 'README.md');
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) {
      expect(claim.path.startsWith('/v1/x402/')).toBe(true);
      expect(claim.method).toBe('POST');
    }
    expect(claims.map((c) => c.path)).toContain('/v1/x402/capture');
    expect(claims.map((c) => c.path)).toContain('/v1/x402/extract');
  });

  it('the real README yields the endpoints it advertises', () => {
    const paths = extractEndpointClaims(readme, 'README.md').map((c) => `${c.method} ${c.path}`);
    for (const expected of [
      'GET /v1/health',
      'GET /openapi.json',
      'GET /skill.md',
      'GET /llms.txt',
      'GET /v1/extract/preview',
      'GET /v1/x402/service',
      'GET /.well-known/x402',
      'POST /v1/watches',
      'POST /v1/stripe/checkout',
    ]) {
      expect(paths, `README should still advertise ${expected}`).toContain(expected);
    }
  });

  it('every price the audit maps points at a route that actually exists in the code', () => {
    // A mapping to a path nobody serves would sit in the audit forever,
    // checking nothing.
    const routeSources = ['src/server/x402/routes.ts', 'src/server/routes.ts', 'src/server/catalogs.ts']
      .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
      .join('\n');
    for (const [envVar, path] of Object.entries(PRICE_ENV_TO_PATH)) {
      expect(routeSources, `${envVar} maps to ${path}, which is not a served route`).toContain(path);
    }
  });

  it('reads paid prices from the service descriptor and ignores malformed rows', () => {
    const json = {
      paidEndpoints: [
        { method: 'POST', path: '/v1/x402/capture', priceUsdc: 0.001, atomicUnits: '1000' },
        { method: 'POST', path: '/v1/x402/extract', priceUsdc: 0.01 },
        { path: '/v1/x402/audit' }, // no price
        { priceUsdc: 0.002 }, // no path
        'nonsense',
      ],
    };
    expect(extractServicePrices(json)).toEqual([
      { path: '/v1/x402/capture', priceUsdc: 0.001 },
      { path: '/v1/x402/extract', priceUsdc: 0.01 },
    ]);
    expect(extractServicePrices({})).toEqual([]);
    expect(extractServicePrices(null)).toEqual([]);
  });

  it('probes every priced route down the paid path, not the free allowance', () => {
    // The allowance answers an unpaid POST with 200, so a priced route probed
    // without the bypass header would report a false failure and burn the
    // caller's free budget on a real product call.
    for (const path of Object.values(PRICE_ENV_TO_PATH)) {
      expect(isX402Path(path), `${path} must be probed down the paid path`).toBe(true);
    }
    expect(isX402Path('/v1/feedback')).toBe(false);
  });

  it('covers every price the README documents in its configuration table', () => {
    const documented = extractEnvPriceClaims(readme, 'README.md').map((c) => c.path);
    expect(documented.length).toBeGreaterThan(0);
    for (const path of documented) {
      expect(Object.values(PRICE_ENV_TO_PATH), `README prices ${path} but the audit does not map it`).toContain(path);
    }
  });
});
