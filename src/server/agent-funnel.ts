/**
 * GET /v1/agent-funnel — the income funnel for the customer webcap actually
 * has: an autonomous agent.
 *
 * The legacy /v1/funnel tracks the human landing-page path (landing_view ->
 * preview_submit -> ...), which the traffic data shows is dead. This view
 * tracks the agent path instead, from the tables that already exist:
 *
 *   reach      discovery clients hitting the machine-readable surfaces
 *              (llms.txt, skill.md, /.well-known/*, openapi, x402 service)
 *   challenge  402s handed to paid routes (i.e. agents that found a price)
 *   freeAllowance  free product calls granted by the rolling per-IP window,
 *              the last no-cost step (replaced wallet-signed trial claims)
 *   paid       settled calls + distinct paying wallets (revenue_ledger)
 *   retention  first-pay vs repeat wallets — one looping wallet is not demand
 *   recurring  watches holding credits (the recurring rail)
 *
 * Aggregate only: counts and caller buckets, never a raw payer or IP address
 * (endpoint_hits stores a sha256 slice; allowance buckets are salted hashes and
 * revenue_ledger payers are never returned). Public and unauthenticated,
 * mirroring /v1/status.
 *
 * See docs/strategy/agent-first.md (north star) and docs/strategy/metrics.md.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { AppDeps } from './server.js';

/** Paid routes (x402 path family + the async jobs submit). */
const PAID_ROUTE_SQL =
  "(endpoint LIKE 'POST /v1/x402/%' OR endpoint LIKE 'GET /v1/x402/%' OR endpoint LIKE 'POST /v1/capture/jobs%')";

/** Machine-readable discovery surfaces an agent reads before paying. */
const DISCOVERY_ROUTES = [
  'GET /llms.txt',
  'GET /skill.md',
  'GET /.well-known/x402',
  'GET /.well-known/agent-card.json',
  'GET /v1/x402/service',
  'GET /openapi.json',
] as const;

/** Literal IN-list for DISCOVERY_ROUTES (hardcoded constants, not user input). */
const DISCOVERY_IN_LIST = DISCOVERY_ROUTES.map((route) => `'${route}'`).join(', ');

export interface ClientCount {
  readonly client: string;
  readonly requests: number;
}

export interface EndpointCount {
  readonly endpoint: string;
  readonly count: number;
}

export interface AgentFunnel {
  readonly windowHours: number;
  readonly reach: {
    readonly discoveryRequests: number;
    readonly topClients: ClientCount[];
  };
  readonly challenge: {
    readonly total: number;
    readonly topEndpoints: EndpointCount[];
  };
  readonly freeAllowance: {
    /** Free product calls granted in the window (every product, keyed by IP). */
    readonly grants: number;
    /** Distinct caller buckets that received at least one grant. */
    readonly callers: number;
  };
  readonly paid: {
    readonly calls: number;
    readonly wallets: number;
    readonly revenueUsdcUnits: number;
  };
  readonly retention: {
    readonly firstPayWallets: number;
    readonly repeatWallets: number;
  };
  readonly recurring: {
    readonly activePaidWatches: number;
  };
}

/** Empty funnel for a DB without the relevant tables (tests, fresh deploys). */
function emptyFunnel(windowHours: number): AgentFunnel {
  return {
    windowHours,
    reach: { discoveryRequests: 0, topClients: [] },
    challenge: { total: 0, topEndpoints: [] },
    freeAllowance: { grants: 0, callers: 0 },
    paid: { calls: 0, wallets: 0, revenueUsdcUnits: 0 },
    retention: { firstPayWallets: 0, repeatWallets: 0 },
    recurring: { activePaidWatches: 0 },
  };
}

export function agentFunnel(db: Db, hoursBack = 168): AgentFunnel {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();
  const out = emptyFunnel(hoursBack);
  const reach = { ...out.reach, topClients: [] as ClientCount[] };
  const challenge = { ...out.challenge, topEndpoints: [] as EndpointCount[] };
  const freeAllowance = { ...out.freeAllowance };
  const paid = { ...out.paid };
  const retention = { ...out.retention };
  const recurring = { ...out.recurring };

  // reach — discovery surfaces, attributed by the client's own User-Agent.
  try {
    const total = db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM endpoint_hits WHERE created_at >= ? AND endpoint IN (${DISCOVERY_IN_LIST})`,
      )
      .get(since);
    reach.discoveryRequests = total?.n ?? 0;
    reach.topClients = db
      .prepare<[string], ClientCount>(
        "SELECT CASE WHEN user_agent IS NULL OR user_agent = '' THEN '(unattributed)' ELSE user_agent END AS client, " +
          `COUNT(*) AS requests FROM endpoint_hits WHERE created_at >= ? AND endpoint IN (${DISCOVERY_IN_LIST}) ` +
          'GROUP BY client ORDER BY requests DESC LIMIT 10',
      )
      .all(since);
  } catch {
    /* endpoint_hits may not exist yet */
  }

  // challenge — 402s on paid routes, by endpoint.
  try {
    const total = db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM endpoint_hits WHERE created_at >= ? AND status = 402 AND ${PAID_ROUTE_SQL}`,
      )
      .get(since);
    challenge.total = total?.n ?? 0;
    challenge.topEndpoints = db
      .prepare<[string], EndpointCount>(
        `SELECT endpoint, COUNT(*) AS count FROM endpoint_hits WHERE created_at >= ? AND status = 402 AND ${PAID_ROUTE_SQL} ` +
          'GROUP BY endpoint ORDER BY count DESC LIMIT 10',
      )
      .all(since);
  } catch {
    /* endpoint_hits may not exist yet */
  }

  // freeAllowance — the free calls the rolling per-IP window granted. This is
  // the funnel's no-cost step now that wallet-signed trials are gone: it is the
  // stage that has to convert into `paid` below.
  try {
    const total = db
      .prepare<[string], { n: number; callers: number }>(
        'SELECT COALESCE(SUM(cost), 0) AS n, COUNT(DISTINCT ip_hash) AS callers FROM allowance_uses WHERE ts >= ?',
      )
      .get(since);
    freeAllowance.grants = total?.n ?? 0;
    freeAllowance.callers = total?.callers ?? 0;
  } catch {
    /* allowance_uses may not exist yet */
  }

  // paid — settled calls and distinct wallets.
  try {
    const total = db
      .prepare<[string], { n: number; wallets: number; revenue: number }>(
        'SELECT COUNT(*) AS n, COUNT(DISTINCT payer) AS wallets, COALESCE(SUM(revenue_usdc), 0) AS revenue ' +
          'FROM revenue_ledger WHERE created_at >= ?',
      )
      .get(since);
    paid.calls = total?.n ?? 0;
    paid.wallets = total?.wallets ?? 0;
    paid.revenueUsdcUnits = total?.revenue ?? 0;
    // Retention is lifetime, not windowed: a repeat buyer is a repeat buyer.
    const first = db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM (SELECT payer FROM revenue_ledger GROUP BY payer HAVING COUNT(*) = 1)',
      )
      .get();
    const repeat = db
      .prepare<[], { n: number }>(
        'SELECT COUNT(*) AS n FROM (SELECT payer FROM revenue_ledger GROUP BY payer HAVING COUNT(*) > 1)',
      )
      .get();
    retention.firstPayWallets = first?.n ?? 0;
    retention.repeatWallets = repeat?.n ?? 0;
  } catch {
    /* revenue_ledger may not exist yet */
  }

  // recurring — watches funded and unpaused.
  try {
    const row = db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM watches WHERE paused = 0 AND credits > 0')
      .get();
    recurring.activePaidWatches = row?.n ?? 0;
  } catch {
    /* watches table may not exist yet */
  }

  return {
    windowHours: hoursBack,
    reach,
    challenge,
    freeAllowance,
    paid,
    retention,
    recurring,
  };
}

const MAX_WINDOW_HOURS = 8760; // one year

/** Terminal-friendly rendering (?format=text), mirroring /v1/funnel. */
export function agentFunnelText(f: AgentFunnel): string {
  const lines: string[] = [];
  lines.push(`=== WEBCAP AGENT FUNNEL (last ${f.windowHours}h) ===`);
  lines.push('');
  lines.push(`REACH        ${String(f.reach.discoveryRequests).padStart(6)} discovery requests`);
  for (const c of f.reach.topClients) {
    lines.push(`  ${c.client.padEnd(40).slice(0, 40)} ${String(c.requests).padStart(6)}`);
  }
  lines.push(`CHALLENGE    ${String(f.challenge.total).padStart(6)} 402s on paid routes`);
  lines.push(`FREE         ${String(f.freeAllowance.grants).padStart(6)} free calls from ${f.freeAllowance.callers} callers`);
  lines.push(`PAID         ${String(f.paid.calls).padStart(6)} calls from ${f.paid.wallets} wallets`);
  lines.push(`REVENUE      ${String(f.paid.revenueUsdcUnits).padStart(6)} USDC units`);
  lines.push(`RETENTION    ${f.retention.firstPayWallets} first-pay / ${f.retention.repeatWallets} repeat wallets (lifetime)`);
  lines.push(`RECURRING    ${String(f.recurring.activePaidWatches).padStart(6)} funded watches`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  return lines.join('\n');
}

export function registerAgentFunnelRoute(app: FastifyInstance, deps: AppDeps): void {
  const { db } = deps;
  app.get('/v1/agent-funnel', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    let hoursBack = 168;
    if (typeof query.hours === 'string') {
      const parsed = Number.parseInt(query.hours, 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_WINDOW_HOURS) hoursBack = parsed;
    }
    const funnel = agentFunnel(db, hoursBack);
    if (query.format === 'text') {
      reply.header('content-type', 'text/plain; charset=utf-8');
      return reply.send(agentFunnelText(funnel));
    }
    return funnel;
  });
}
