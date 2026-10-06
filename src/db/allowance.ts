/**
 * The rolling free allowance: every product, keyed by caller IP, over a rolling
 * window. This replaces the wallet-signed per-product trials.
 *
 * Why it exists. The customer is an autonomous agent, and the trial rail asked
 * that agent to hold a wallet and produce an EIP-191 signature before it could
 * try anything. That is exactly the friction the charter says never to put in
 * front of a bot. An allowance needs neither: call the product, get the real
 * product, free.
 *
 * Why it is generous. This is growth spend, not a defensive cap. Paying for
 * calls is the growth engine (docs/strategy/agent-first.md), and an agent that
 * has never been able to try the thing will never buy it. The default budget is
 * deliberately far above the old 3/day faucet because the marginal cost of a
 * free call is ~$0.0002 of amortized compute
 * (WEBCAP_COMPUTE_COST_USDC_PER_REQUEST) — see the table in docs/strategy/metrics.md.
 *
 * Two bounds keep the generosity from becoming unbounded spend:
 *
 *   1. A sliding window per IP. It is a true rolling window, not a fixed daily
 *      bucket, so an agent that calls at 23:59 does not get a fresh budget at
 *      00:00 and can plan against a stable `retryAfterSeconds`.
 *   2. A free batch cap. A 50-URL extract costs ~$0.01 of compute — the same as
 *      its price — so free batches are capped at FREE_BATCH_MAX_URLS. Single
 *      URLs are uncapped inside the window. The free rail therefore never gives
 *      away more compute than the paid call would have cost.
 *
 * Privacy: the bucket key is a salted hash of the IP (same scheme as the old
 * faucet), never the address itself. The salt is per-deployment and in-memory,
 * so hashes are not comparable across restarts or deployments.
 *
 * Sybil honesty: an IP is not an identity. A caller with proxies can mint
 * windows. That is an accepted cost of removing wallet friction, and it is why
 * {@link AllowanceRepo} keeps a global circuit breaker: if the whole fleet
 * starts burning budget, free usage can be stopped without a deploy.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './index.js';
import { nowIso } from '../util/time.js';
import {
  DEFAULT_ALLOWANCE_CALLS,
  DEFAULT_ALLOWANCE_WINDOW_HOURS,
} from '../config.js';

export { DEFAULT_ALLOWANCE_CALLS, DEFAULT_ALLOWANCE_WINDOW_HOURS };

/**
 * Free batch ceiling for webcap_extract. A 50-URL batch costs ~$0.01 in
 * compute, equal to the paid price, so the free rail caps batches well below
 * it. A single URL has no such ceiling.
 */
export const FREE_BATCH_MAX_URLS = 10;

/** Products a free allowance can cover. Every product; video included, since it is ~$0.002 not ~$0.02. */
export const ALLOWANCE_PRODUCTS = ['capture', 'extract', 'audit', 'map-lite', 'video', 'analyze'] as const;
export type AllowanceProduct = (typeof ALLOWANCE_PRODUCTS)[number];

export function isAllowanceProduct(value: unknown): value is AllowanceProduct {
  return typeof value === 'string' && (ALLOWANCE_PRODUCTS as readonly string[]).includes(value);
}

/** A rolling-window decision, shaped for the `X-Webcap-Allowance-*` response headers. */
export interface AllowanceDecision {
  readonly granted: boolean;
  /** Undiscounted units this call would consume (a batch costs its URL count). */
  readonly cost: number;
  /** Calls left in the window after this one; 0 when denied. */
  readonly remaining: number;
  readonly limit: number;
  /** Seconds until the oldest use in the window expires and frees a slot. */
  readonly retryAfterSeconds: number;
}

/** A prepared (not yet committed) allowance decision for one call. */
export interface PreparedAllowance {
  readonly granted: boolean;
  /** Undiscounted units this call consumes when committed. */
  readonly cost: number;
  readonly decision: AllowanceDecision;
  /**
   * Record the granted use. Call only AFTER the work succeeded, so a failed
   * capture does not burn the caller's allowance. No-op when denied.
   */
  commit(): number;
}

export interface AllowanceRepo {
  /** Used calls in the window right now (prunes expired rows as a side effect). */
  used(key: string, windowMs: number): number;
  /** Record `cost` calls; returns the new window total. */
  record(key: string, cost: number, windowMs: number): number;
  /** Free calls granted across all keys in the window (operator telemetry). */
  totalInWindow(windowMs: number): number;
  /**
   * Milliseconds until this key's oldest use falls out of the window, i.e. the
   * wait before a denied caller has at least one free slot again. 0 when the
   * key has no uses in the window.
   */
  retryAfterMs(key: string, windowMs: number): number;
}

/**
 * Allowance storage. One row per granted call (`ts`), so the window is a true
 * slide: expire rows older than the window and COUNT what is left. Rows are
 * pruned opportunistically on every check, so the table stays tiny.
 */
export function makeAllowanceRepo(db: Db): AllowanceRepo {
  const prune = db.prepare<[string], unknown>('DELETE FROM allowance_uses WHERE ts < ?');
  const sumFor = db.prepare<[string, string], { n: number }>(
    'SELECT COALESCE(SUM(cost), 0) AS n FROM allowance_uses WHERE ip_hash = ? AND ts >= ?',
  );
  const oldest = db.prepare<[string, string], { ts: string }>(
    'SELECT ts FROM allowance_uses WHERE ip_hash = ? AND ts >= ? ORDER BY ts ASC LIMIT 1',
  );
  const insert = db.prepare<[string, string, number], unknown>(
    'INSERT INTO allowance_uses (ip_hash, ts, cost) VALUES (?, ?, ?)',
  );
  const sumAll = db.prepare<[string], { n: number }>(
    'SELECT COALESCE(SUM(cost), 0) AS n FROM allowance_uses WHERE ts >= ?',
  );

  return {
    used(key: string, windowMs: number): number {
      const since = new Date(Date.now() - windowMs).toISOString();
      prune.run(since);
      return sumFor.get(key, since)?.n ?? 0;
    },
    record(key: string, cost: number, windowMs: number): number {
      const since = new Date(Date.now() - windowMs).toISOString();
      prune.run(since);
      insert.run(key, nowIso(), Math.max(1, Math.trunc(cost)));
      return sumFor.get(key, since)?.n ?? 0;
    },
    totalInWindow(windowMs: number): number {
      const since = new Date(Date.now() - windowMs).toISOString();
      prune.run(since);
      return sumAll.get(since)?.n ?? 0;
    },
    retryAfterMs(key: string, windowMs: number): number {
      const now = Date.now();
      const since = new Date(now - windowMs).toISOString();
      const row = oldest.get(key, since);
      if (row === undefined) return 0;
      const oldestMs = Date.parse(row.ts);
      if (!Number.isFinite(oldestMs)) return 0;
      // When the oldest use expires, that slot returns to the caller.
      return Math.max(0, oldestMs + windowMs - now);
    },
  };
}

/**
 * Per-deployment salt for IP hashing. In-memory on purpose: a restart rotates
 * it, so hashes cannot be joined across restarts, and nothing about a caller's
 * address is recoverable from storage.
 */
const ALLOWANCE_SALT = randomBytes(16);

/** Stable, non-reversible bucket key for a caller address. */
export function allowanceKey(ip: string): string {
  return createHash('sha256').update(`${ALLOWANCE_SALT.toString('hex')}:${ip}`).digest('hex');
}

export interface AllowanceGate {
  readonly repo: AllowanceRepo;
  /** Free units per IP per window. */
  readonly limit: number;
  readonly windowMs: number;
  /**
   * Global circuit breaker: when the window's fleet-wide total reaches this,
   * free usage stops (callers get the normal 402 and can pay). 0 disables the
   * breaker. This is the escape hatch for a runaway free-budget burn without
   * redeploying.
   */
  readonly globalWindowLimit: number;
}

/**
 * Prepare a decision for one call. `cost` is the undiscounted unit count (a
 * batch is its URL count), so a caller cannot buy 50 pages for the price of one
 * free slot.
 *
 * The returned handle separates PREPARE from COMMIT: the caller runs the real
 * product first and only records the use once it succeeded. A failed capture
 * must not consume the caller's allowance.
 */
export function prepareAllowance(gate: AllowanceGate, ip: string, cost = 1): PreparedAllowance {
  const { repo, limit, windowMs, globalWindowLimit } = gate;
  const key = allowanceKey(ip);
  const used = repo.used(key, windowMs);
  const cost2 = Math.max(1, Math.trunc(cost));
  const waitSeconds = (): number => Math.max(1, Math.ceil(repo.retryAfterMs(key, windowMs) / 1000));

  // Per-IP budget spent, or the free rail switched off.
  if (limit <= 0 || used + cost2 > limit) {
    return {
      granted: false,
      cost: cost2,
      commit: () => repo.used(key, windowMs),
      decision: {
        granted: false,
        cost: cost2,
        remaining: Math.max(0, limit - used),
        limit,
        retryAfterSeconds: waitSeconds(),
      },
    };
  }

  // Fleet-wide circuit breaker: free usage stops for everyone so a runaway burn
  // can be contained without a deploy. Callers still get the normal 402.
  if (globalWindowLimit > 0 && repo.totalInWindow(windowMs) >= globalWindowLimit) {
    return {
      granted: false,
      cost: cost2,
      commit: () => repo.used(key, windowMs),
      decision: { granted: false, cost: cost2, remaining: 0, limit, retryAfterSeconds: waitSeconds() },
    };
  }

  return {
    granted: true,
    cost: cost2,
    commit: () => repo.record(key, cost2, windowMs),
    decision: {
      granted: true,
      cost: cost2,
      remaining: Math.max(0, limit - used - cost2),
      limit,
      // Slots keep sliding back, so this is the window's worth of headroom.
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    },
  };
}

/** Render the allowance decision as response headers, so an agent can plan its next call. */
export function allowanceHeaders(decision: AllowanceDecision): Record<string, string> {
  return {
    'x-webcap-allowance-limit': String(decision.limit),
    'x-webcap-allowance-remaining': String(decision.remaining),
    'x-webcap-allowance-cost': String(decision.cost),
    'x-webcap-allowance-window-seconds': String(Math.ceil(decision.retryAfterSeconds)),
    'x-webcap-allowance-granted': decision.granted ? 'true' : 'false',
  };
}
