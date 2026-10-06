/**
 * The MPP 402-challenge hook: attaches the `Payment` WWW-Authenticate header
 * to unpaid x402 402s (dual-protocol challenge) without touching body bytes.
 *
 * Fires ONLY when the reply is a 402 AND the request is one of the paid
 * patterns (GET/POST x capture/extract/topup/audit/map-lite/video, POST jobs). MPP disabled (no
 * MPP_SECRET_KEY -> loadMppConfig returns enabled:false) = no hook
 * registered, zero header change.
 *
 * Price resolution mirrors the x402 layer identically: static units for
 * capture/extract from config, dynamic top-up from `?watchId=` with the
 * capture-pack fallback (cf. topUpPriceUsdcUnitsForContext in
 * src/server/x402/routes.ts — reimplemented here from the query string
 * because that function is private; the request body is NEVER read).
 *
 * Hook-chain seam for settle (Task 4): reuse `resolveMppAmountUsdcUnits`
 * (same price the challenge binds) and `isMppPaidPattern` (same gate) so
 * credential verification prices identically to the challenge.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { withPrivateCacheControl, type x402ResourceServer } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';
import { DEFAULT_X402_MAX_TIMEOUT_MS, watchTopUpPriceUsdcUnits, type WebcapConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { ALLOWANCE_MARKER } from '../server/allowance-gate.js';
import { makeWatchRepo, type WatchRepo } from '../watch/store.js';
import { buildX402Requirement, X402_AUDIT_PATH, X402_CAPTURE_PATH, X402_EXTRACT_PATH, X402_JOBS_PATH, X402_MAP_LITE_PATH, X402_TOPUP_PATH, X402_VIDEO_PATH, X402_ANALYZE_PATH, X402_ANALYZE_BATCH_PATH } from '../server/x402/routes.js';
import { buildWwwAuthenticate, parseWwwAuthenticate } from './challenge.js';
import { loadMppConfig } from './config.js';
import { settleMppPayment } from './settle.js';

const PAID_PATHS: ReadonlySet<string> = new Set([X402_CAPTURE_PATH, X402_EXTRACT_PATH, X402_TOPUP_PATH, X402_AUDIT_PATH, X402_MAP_LITE_PATH, X402_VIDEO_PATH, X402_JOBS_PATH, X402_ANALYZE_PATH, X402_ANALYZE_BATCH_PATH]);

/** True when method+path is one of the paid patterns (GET/POST on the x402 paths, POST on the jobs submit). */
export function isMppPaidPattern(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  const path = url.split('?')[0];
  return PAID_PATHS.has(path ?? '');
}

/** First `watchId` query value, mirroring the x402 top-up context resolution. */
function watchIdOf(url: string): string | undefined {
  const query = url.split('?')[1];
  if (query === undefined) return undefined;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== 'watchId') continue;
    const raw = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (raw !== '') return raw;
  }
  return undefined;
}

export interface MppPriceInput {
  readonly method: string;
  readonly url: string;
  readonly config: WebcapConfig;
  readonly watchRepo: WatchRepo;
}

/**
 * Atomic USDC units bound into the MPP challenge: static units for
 * capture/extract, dynamic top-up from `?watchId=` (unknown/absent watch ->
 * capture-pack fallback). Never reads the request body.
 */
export function resolveMppAmountUsdcUnits(input: MppPriceInput): number {
  const path = input.url.split('?')[0];
  if (path === X402_CAPTURE_PATH) return input.config.x402PriceUsdcUnits;
  if (path === X402_EXTRACT_PATH) return input.config.x402ExtractPriceUsdcUnits;
  if (path === X402_AUDIT_PATH) return input.config.x402AuditPriceUsdcUnits;
  if (path === X402_MAP_LITE_PATH) return input.config.x402AuditPriceUsdcUnits;
  if (path === X402_VIDEO_PATH) return input.config.x402VideoPriceUsdcUnits;
  if (path === X402_ANALYZE_PATH || path === X402_ANALYZE_BATCH_PATH) return input.config.x402ExtractPriceUsdcUnits;
  if (path === X402_JOBS_PATH) return input.config.x402PriceUsdcUnits;
  if (path === X402_TOPUP_PATH) {
    const watchId = watchIdOf(input.url);
    const watch = watchId !== undefined ? input.watchRepo.get(watchId) : null;
    return watch !== null
      ? watchTopUpPriceUsdcUnits(watch.mode, input.config)
      : watchTopUpPriceUsdcUnits('capture', input.config);
  }
  throw new Error(`not an MPP paid path: ${path ?? input.url}`);
}

/**
 * Register the MPP challenge `onSend` hook AFTER the x402 middleware (call
 * site: src/server/server.ts, next to registerX402Middleware). Payload bytes
 * pass through untouched; only the WWW-Authenticate header is set. Each
 * issued challenge is also cached by id (see `cacheChallenge`) so the settle
 * hook (registerMppSettleHook) can recover the exact header the credential
 * binds to — challenges are self-validating HMACs, but the paid request only
 * carries the credential, not the challenge.
 */
export function registerMppChallengeHook(app: FastifyInstance, config: WebcapConfig, db: Db): void {
  const mpp = loadMppConfig(process.env, config.publicBaseUrl, config.chainId);
  if (!mpp.enabled) return;
  const watchRepo = makeWatchRepo(db);
  const maxTimeoutSeconds = Math.round((config.x402MaxTimeoutMs ?? DEFAULT_X402_MAX_TIMEOUT_MS) / 1000);
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode !== 402) return payload;
    if (!isMppPaidPattern(request.method, request.url)) return payload;
    const header = buildWwwAuthenticate({
      amountUsdcUnits: resolveMppAmountUsdcUnits({ method: request.method, url: request.url, config, watchRepo }),
      recipient: config.x402PayTo,
      realm: mpp.realm,
      method: 'evm',
      intent: 'charge',
      secret: mpp.secret,
      expiresAtSec: Math.floor(Date.now() / 1000) + maxTimeoutSeconds,
      chainId: mpp.chainId,
    });
    reply.header('WWW-Authenticate', header);
    cacheChallenge(header);
    return payload;
  });
}

interface CachedChallenge {
  readonly header: string;
  readonly expiresMs: number;
}

// In-memory issue log of live challenges by HMAC id (single process; a
// multi-process deployment would need a shared store). Entries are
// self-validating (settleMppPayment recomputes the HMAC + expiry), so a stale
// entry can only fall through to the x402 402, never settle wrongly.
const CHALLENGE_CACHE = new Map<string, CachedChallenge>();
const CHALLENGE_CACHE_MAX = 1000;

const CREDENTIAL_PATTERN = /^Payment\s+credential="([^"]+)"$/;

/** Remember an issued challenge header for the settle hook's paid-request lookup. */
function cacheChallenge(header: string): void {
  let id: string;
  let expiresMs: number;
  try {
    const parsed = parseWwwAuthenticate(header);
    expiresMs = Date.parse(parsed.expires);
    if (!Number.isFinite(expiresMs)) return;
    id = parsed.id;
  } catch {
    return;
  }
  for (const [key, entry] of CHALLENGE_CACHE) {
    if (entry.expiresMs <= Date.now()) CHALLENGE_CACHE.delete(key);
  }
  if (CHALLENGE_CACHE.size >= CHALLENGE_CACHE_MAX) {
    const oldest = CHALLENGE_CACHE.keys().next();
    if (!oldest.done) CHALLENGE_CACHE.delete(oldest.value);
  }
  CHALLENGE_CACHE.set(id, { header, expiresMs });
}

/** The challenge id a credential claims to be bound to (unverified; the HMAC check happens in settle). */
function challengeIdOfCredential(authorizationHeader: string): string | undefined {
  const match = CREDENTIAL_PATTERN.exec(authorizationHeader.trim());
  if (match?.[1] === undefined || match[1] === '') return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    if (typeof decoded === 'object' && decoded !== null) {
      const challengeId = (decoded as { challengeId?: unknown }).challengeId;
      if (typeof challengeId === 'string' && challengeId !== '') return challengeId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The exact issued challenge header for a credential's challenge id (undefined when unknown/expired). */
function issuedChallenge(challengeId: string): string | undefined {
  const entry = CHALLENGE_CACHE.get(challengeId);
  if (entry === undefined) return undefined;
  if (entry.expiresMs <= Date.now()) {
    CHALLENGE_CACHE.delete(challengeId);
    return undefined;
  }
  return entry.header;
}

/**
 * Register the MPP settle hooks BEFORE the x402 middleware (call site:
 * registerX402Middleware in src/server/x402.ts, ahead of paymentMiddleware —
 * Fastify runs hooks in registration order, so the settle onRequest runs
 * before x402's verify and the settle onSend runs before x402's settle).
 * No-op when MPP is disabled (zero hooks, zero behavior change).
 *
 * On a valid `Authorization: Payment credential="…"` for a live challenge the
 * hook settles EXACTLY ONCE through the shared resourceServer (same
 * verify+settle path as x402, same amount/recipient/expiry rigor), attaches
 * the standard x402 payer context (x402Payer-compatible, so routes record
 * revenue + payer unchanged), and hands x402's verify the derived v2 payload
 * as its `payment-signature` so the request passes the x402 gate with a full
 * context. The onSend hook then consumes the settled marker: it clears the
 * x402 context (x402 onSend sees none and skips its second settle) and echoes
 * the PAYMENT-RESPONSE receipt. On ANY failure (absent/malformed/tampered
 * credential, unknown challenge, failed settle) the hook touches nothing and
 * the request falls through to the existing x402 402 byte-identical.
 */
export function registerMppSettleHook(
  app: FastifyInstance,
  config: WebcapConfig,
  db: Db,
  resourceServer: x402ResourceServer,
): void {
  const mpp = loadMppConfig(process.env, config.publicBaseUrl, config.chainId);
  if (!mpp.enabled) return;
  const watchRepo = makeWatchRepo(db);
  const settled = new WeakMap<FastifyRequest, SettleResponse>();

  app.addHook('onRequest', async (request) => {
    // A rolling free allowance was granted for this call: do not settle it.
    // The allowance hook runs ahead of this one (registered earlier in
    // registerX402Middleware), so a free call is never charged through MPP.
    if (request.headers[ALLOWANCE_MARKER] === 'granted') return;
    if (!isMppPaidPattern(request.method, request.url)) return;
    const authorizationHeader = request.headers.authorization;
    if (authorizationHeader === undefined || authorizationHeader.trim() === '') return;
    const challengeId = challengeIdOfCredential(authorizationHeader);
    if (challengeId === undefined) return;
    const challengeHeader = issuedChallenge(challengeId);
    if (challengeHeader === undefined) return;
    let requirements: PaymentRequirements;
    try {
      requirements = buildX402Requirement(
        config,
        resolveMppAmountUsdcUnits({ method: request.method, url: request.url, config, watchRepo }),
      );
    } catch {
      return;
    }
    let result: Awaited<ReturnType<typeof settleMppPayment>>;
    try {
      result = await settleMppPayment({
        authorizationHeader,
        challengeHeader,
        requirements,
        secret: mpp.secret,
        realm: mpp.realm,
        resourceServer,
      });
    } catch {
      return;
    }
    if (!result.ok) return;
    request.headers['payment-signature'] = Buffer.from(JSON.stringify(result.paymentPayload), 'utf8').toString(
      'base64',
    );
    request.x402Context = { paymentPayload: result.paymentPayload } as FastifyRequest['x402Context'];
    settled.set(request, result.settlement);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const settlement = settled.get(request);
    if (settlement === undefined) return payload;
    settled.delete(request);
    // The settlement already happened in onRequest: clear the context so
    // x402's onSend skips its settle (exactly one settlement per request).
    request.x402Context = undefined;
    if (reply.statusCode < 400) {
      reply.header('PAYMENT-RESPONSE', encodePaymentResponseHeader(settlement));
      const existing = reply.getHeader('Cache-Control');
      reply.header('Cache-Control', withPrivateCacheControl(existing === undefined ? null : String(existing)));
    }
    return payload;
  });
}
