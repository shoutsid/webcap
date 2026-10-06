#!/usr/bin/env node
/**
 * Claim audit: read our own documentation and check it against the running
 * service.
 *
 * Issue #1 was filed by an agent that audited the README against the live API
 * and found a stale number. That is exactly what our customer does — an
 * automated buyer reading `/skill.md`, `/llms.txt` and the README as a
 * contract — so the audit should be a command, not a favour.
 *
 * What it checks, from the documents themselves (no second copy to rot):
 *   1. every `METHOD /path` the docs advertise actually exists (not 404/5xx);
 *   2. every price the docs advertise equals the 402 challenge amount;
 *   3. a price-bearing endpoint challenges when unpaid (it is not secretly free);
 *   4. the /v1/x402/service descriptor quotes the same prices as the live
 *      challenges.
 *
 * One thing about the paid path is load-bearing here. The rolling free
 * allowance answers an unpaid POST with 200 (it runs the real product), so
 * probing priced routes without a payment header would both miss the challenge
 * and spend the caller's free budget on a real capture. The audit instead
 * sends a deliberately unusable payment header on x402 routes: the allowance is
 * only granted to callers that brought no payment, so the paywall answers the
 * 402 challenge and no product is ever run.
 *
 * Usage:
 *   npx tsx scripts/claim-audit.ts                      # localhost:8080
 *   npx tsx scripts/claim-audit.ts --base-url https://webcap.shoutsid.fyi
 *   npx tsx scripts/claim-audit.ts --json                # machine-readable
 *
 * Exits non-zero if any claim fails, so it can gate a deploy.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TIMEOUT_MS = 15_000;
const USDC_SCALE = 1_000_000;
const PROBE_URL = 'https://example.com/';

/**
 * Forces a request down the paid path. The rolling free allowance is granted
 * only to callers that brought no payment (src/server/allowance-gate.ts), so a
 * request carrying any payment header is never granted it. Sending a
 * deliberately unusable one makes the paywall answer the 402 challenge — which
 * is what this audit needs to read a price, without running the product or
 * spending the caller's free budget.
 */
const ALLOWANCE_BYPASS: Readonly<Record<string, string>> = { 'payment-signature': 'claim-audit-probe' };

/** Routes the x402 middleware gates, where an unpaid call may be allowance-granted. */
export function isX402Path(path: string): boolean {
  return path.startsWith('/v1/x402/') || path.startsWith('/v1/capture/jobs');
}

export interface EndpointClaim {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PUT';
  readonly path: string;
  /** True when the docs wrote a placeholder id (`/v1/capture/jobs/{id}`): only the route family is checkable. */
  readonly template: boolean;
  readonly source: string;
}

export interface PriceClaim {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly usd: number;
  readonly source: string;
}

/** One row of GET /v1/x402/service's `paidEndpoints`, the second price surface. */
export interface ServiceEndpoint {
  readonly path: string;
  readonly priceUsdc: number;
}

/** Read the prices the service descriptor advertises, so they can be cross-checked. */
export function extractServicePrices(json: unknown): ServiceEndpoint[] {
  if (typeof json !== 'object' || json === null) return [];
  const paid = (json as { paidEndpoints?: unknown }).paidEndpoints;
  if (!Array.isArray(paid)) return [];
  const out: ServiceEndpoint[] = [];
  for (const raw of paid) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as { path?: unknown; priceUsdc?: unknown };
    const priceUsdc = Number(entry.priceUsdc);
    if (typeof entry.path !== 'string' || !Number.isFinite(priceUsdc)) continue;
    out.push({ path: entry.path, priceUsdc });
  }
  return out;
}

/** Env-var price rows in the README's configuration table -> the route they price. */
export const PRICE_ENV_TO_PATH: Readonly<Record<string, string>> = {
  WEBCAP_X402_PRICE_USDC: '/v1/x402/capture',
  WEBCAP_X402_EXTRACT_PRICE_USDC: '/v1/x402/extract',
  WEBCAP_X402_AUDIT_PRICE_USDC: '/v1/x402/audit',
  WEBCAP_X402_VIDEO_PRICE_USDC: '/v1/x402/video',
};

/** Drop trailing punctuation and a template's dangling slash (`/v1/watches/` -> `/v1/watches`). */
const stripTrailing = (value: string): string => value.replace(/[.,;:`)\]/]+$/, '');

/** `METHOD /path` tokens anywhere in a document. */
export function extractEndpointClaims(text: string, source: string): EndpointClaim[] {
  const claims: EndpointClaim[] = [];
  const seen = new Set<string>();
  const matches = [...text.matchAll(/\b(GET|POST|DELETE|PUT)\s+(\/[A-Za-z0-9._\-/]*)/g)];
  for (const match of matches) {
    const method = match[1] as EndpointClaim['method'];
    const raw = stripTrailing(match[2] as string);
    if (raw === '' || raw === '/') continue;
    // `{id}` / `:id` / `<id>` after the match means the docs are describing a family.
    const after = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1);
    const template = after === '{' || after === ':' || after === '<';
    const key = `${method} ${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ method, path: raw, template, source });
  }
  return claims;
}

/** Price table rows: `| <something> METHOD /path {body} | $X |`. */
export function extractPriceClaims(text: string, source: string): PriceClaim[] {
  const claims: PriceClaim[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const priceCells = cells.filter((cell) => /^\$[0-9]+(?:\.[0-9]+)?$/.test(cell));
    // Exactly one unambiguous price per row: the top-up row quotes a range and
    // the free rows quote none, so neither is a checkable per-route claim.
    if (priceCells.length !== 1) continue;
    const usd = Number((priceCells[0] as string).slice(1));
    for (const cell of cells) {
      const match = /\b(GET|POST)\s+(\/[A-Za-z0-9._\-/]+)/.exec(cell);
      if (match === null) continue;
      const method = match[1] as PriceClaim['method'];
      const path = stripTrailing(match[2] as string);
      if (path === '') continue;
      const key = `${method} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ method, path, usd, source });
    }
  }
  return claims;
}

/** README configuration rows: `| \`WEBCAP_X402_PRICE_USDC\` | ... | \`0.001\` |`. */
export function extractEnvPriceClaims(text: string, source: string): PriceClaim[] {
  const claims: PriceClaim[] = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.replace(/`/g, '').trim());
    const envVar = cells.find((cell) => /^WEBCAP_[A-Z0-9_]+$/.test(cell));
    if (envVar === undefined) continue;
    const path = PRICE_ENV_TO_PATH[envVar];
    if (path === undefined) continue;
    const usd = Number(cells.findLast((cell) => /^[0-9]+(?:\.[0-9]+)?$/.test(cell)) ?? Number.NaN);
    if (!Number.isFinite(usd)) continue;
    claims.push({ method: 'POST', path, usd, source });
  }
  return claims;
}

/** Query params a route needs before it will answer (documented in the same tables). */
const REQUIRED_QUERY: Readonly<Record<string, string>> = {
  '/v1/extract/preview': `url=${PROBE_URL}`,
};

interface CheckResult {
  readonly claim: string;
  readonly source: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Challenge {
  readonly amountUsdc: number;
  readonly network: string;
  readonly asset: string;
}

async function request(
  baseUrl: string,
  claim: { method: string; path: string },
  body?: unknown,
): Promise<{ status: number; json: unknown; text: string }> {
  const query = REQUIRED_QUERY[claim.path];
  const url = `${baseUrl}${claim.path}${query !== undefined ? `?${query}` : ''}`;
  const bypass = isX402Path(claim.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: RequestInit = { method: claim.method, signal: controller.signal };
    if (claim.method === 'POST' || claim.method === 'PUT') {
      init.headers = { 'content-type': 'application/json', ...(bypass ? ALLOWANCE_BYPASS : {}) };
      init.body = JSON.stringify(body ?? { url: PROBE_URL });
    } else if (bypass) {
      init.headers = { ...ALLOWANCE_BYPASS };
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Did the route itself run? (Our envelope vs Fastify's built-in not-found body.) */
function routeRan(status: number, json: unknown): boolean {
  if (status !== 404) return true;
  if (typeof json !== 'object' || json === null) return false;
  const err = (json as { error?: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

function challengeOf(json: unknown): Challenge | null {
  if (typeof json !== 'object' || json === null) return null;
  const accepts = (json as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const first = accepts[0] as { amount?: unknown; network?: unknown; asset?: unknown };
  const amount = Number(first.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amountUsdc: amount / USDC_SCALE,
    network: String(first.network ?? ''),
    asset: String(first.asset ?? ''),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const baseUrlArg = args.indexOf('--base-url');
  const baseUrl = (baseUrlArg === -1 ? 'http://localhost:8080' : (args[baseUrlArg + 1] as string)).replace(/\/$/, '');
  const root = process.cwd();

  const documents: Array<{ name: string; text: string }> = [];
  const readDoc = (name: string, path: string): void => {
    try {
      documents.push({ name, text: readFileSync(resolve(root, path), 'utf8') });
    } catch {
      // A missing optional document (llms.txt is served, not stored) is not a claim failure.
    }
  };
  readDoc('README.md', 'README.md');

  // skill.md and llms.txt are the machine contract; fetch them from the service.
  for (const name of ['skill.md', 'llms.txt']) {
    try {
      const res = await fetch(`${baseUrl}/${name}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) documents.push({ name, text: await res.text() });
    } catch {
      // Reported by the endpoint checks below.
    }
  }

  const endpoints = documents.flatMap((doc) => extractEndpointClaims(doc.text, doc.name));
  const priceClaims = [
    ...documents.flatMap((doc) => extractPriceClaims(doc.text, doc.name)),
    ...documents.flatMap((doc) => extractEnvPriceClaims(doc.text, doc.name)),
  ];
  const docsWithPrice = new Map(priceClaims.map((claim) => [`POST ${claim.path}`, claim]));

  const results: CheckResult[] = [];
  const challenges = new Map<string, Challenge>();

  for (const claim of endpoints) {
    const priced = docsWithPrice.get(`${claim.method} ${claim.path}`);
    // A price-bearing POST must challenge; other documented routes only have to exist.
    // Probes must not create anything. `{}` is rejected by the watch route
    // before it inserts a row; every other POST needs only a url to answer.
    const body = claim.path === '/v1/watches' ? {} : undefined;
    let observed: { status: number; json: unknown; text: string };
    try {
      observed = await request(baseUrl, claim, body);
    } catch (err) {
      results.push({
        claim: `${claim.method} ${claim.path}`,
        source: claim.source,
        ok: false,
        detail: `unreachable (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }

    const challenge = challengeOf(observed.json);
    if (challenge !== null) challenges.set(claim.path, challenge);

    if (priced !== undefined) {
      const ok = observed.status === 402 && challenge !== null;
      results.push({
        claim: `${claim.method} ${claim.path}`,
        source: `${claim.source} (documented $${priced.usd})`,
        ok,
        detail: ok
          ? `402 as documented, asks ${challenge?.amountUsdc} USDC`
          : `documented as paid but answered ${observed.status}, no challenge`,
      });
      if (ok && challenge !== null && challenge.amountUsdc !== priced.usd) {
        results.push({
          claim: `${claim.method} ${claim.path} price`,
          source: claim.source,
          ok: false,
          detail: `docs say $${priced.usd}, challenge asks $${challenge.amountUsdc}`,
        });
      }
      continue;
    }

    // A 404 is ambiguous: the route may exist and the resource not. Our error
    // envelope (`{error:{code}}`) means the route ran; Fastify's raw
    // `{"message":"Route ... not found"}` means it does not exist.
    const exists = observed.status < 400 || observed.status === 404 ? routeRan(observed.status, observed.json) : observed.status < 500;
    results.push({
      claim: `${claim.method} ${claim.path}${claim.template ? ' (route family)' : ''}`,
      source: claim.source,
      ok: exists,
      detail: `HTTP ${observed.status}${claim.template ? ', placeholder id' : ''}${exists ? '' : ' (documented route not served)'}`,
    });
  }

  // Cross-surface agreement (charter rule 2): the service descriptor is a
  // second machine-readable surface, so the prices it advertises must equal the
  // challenges this audit just read.
  const service = await request(baseUrl, { method: 'GET', path: '/v1/x402/service' }).catch(() => null);
  for (const entry of extractServicePrices(service?.json)) {
    const challenge = challenges.get(entry.path);
    if (challenge === undefined) continue;
    const ok = entry.priceUsdc === challenge.amountUsdc;
    results.push({
      claim: `service descriptor quotes ${entry.path}`,
      source: 'GET /v1/x402/service',
      ok,
      detail: ok
        ? `$${entry.priceUsdc} matches the challenge`
        : `service says $${entry.priceUsdc}, challenge asks $${challenge.amountUsdc}`,
    });
  }

  const failures = results.filter((r) => !r.ok);
  if (jsonOut) {
    console.log(JSON.stringify({ baseUrl, checked: results.length, failures, results }, null, 2));
  } else {
    console.log(`claim audit against ${baseUrl}`);
    console.log(`documents: ${documents.map((d) => d.name).join(', ')}\n`);
    for (const result of results) {
      console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.claim.padEnd(34)} ${result.detail}  [${result.source}]`);
    }
    console.log(`\n${results.length - failures.length}/${results.length} claims hold`);
    if (failures.length > 0) console.log(`\n${failures.length} claim(s) FAILED`);
  }
  if (failures.length > 0) process.exitCode = 1;
}

// Only run when executed directly (so tests can import the parsers).
if (process.argv[1] !== undefined && process.argv[1].includes('claim-audit')) {
  void main();
}
