/**
 * The rolling free-allowance gate: how a caller with no wallet gets a real
 * product for free.
 *
 * Shape. An `onRequest` hook registered AHEAD of the MPP and x402 hooks decides
 * the allowance for the call and, when granted, sets an internal marker header.
 * The x402 paywall is wrapped so `requiresPayment()` returns false for a marked
 * request, which means the request never reaches verify/settle and the real
 * route handler runs unpaid. An `onSend` hook then publishes the allowance
 * state to the caller and records the use — but only when the call succeeded,
 * so a failed capture does not consume the budget.
 *
 * Why the marker header. `requiresPayment(context)` only receives the HTTP
 * adapter, and `FastifyAdapter.getHeader` reads `request.headers`. A header is
 * therefore the one channel the gate and the paywall wrapper share. It is
 * NEVER client-trusted: the gate deletes any inbound copy before deciding, so a
 * caller cannot claim the allowance by sending the header itself.
 *
 * What it does not cover. The credits rail (`Bearer wc_…`) is operator-funded
 * prepaid; a free window there would let one key burn compute while breaking
 * balance math, so it stays paid. Watch top-ups are a different product and
 * stay paid. `/v1/x402/analyze/batch` is not on the agent tool surface, so it
 * stays paid too.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebcapConfig } from '../config.js';
import type { Db } from '../db/index.js';
import {
  DEFAULT_ALLOWANCE_WINDOW_HOURS,
  allowanceHeaders,
  makeAllowanceRepo,
  prepareAllowance,
  type AllowanceGate,
  type AllowanceProduct,
  type PreparedAllowance,
} from '../db/allowance.js';

/**
 * Internal marker header. Set by the gate when a call is granted, read by the
 * paywall wrapper and by handlers that need to alter free-call behaviour.
 * Always stripped from the inbound request first.
 */
export const ALLOWANCE_MARKER = 'x-webcap-allowance';

/** Request state the gate stashes for the commit hook. */
interface AllowanceRequest extends FastifyRequest {
  webcapAllowance?: PreparedAllowance;
}

/** The paid endpoint a free allowance can cover. Exactly the agent tool surface's paid paths. */
function productFor(method: string, path: string): AllowanceProduct | undefined {
  if (method !== 'POST') return undefined;
  switch (path) {
    case '/v1/x402/capture':
      return 'capture';
    case '/v1/x402/extract':
      return 'extract';
    case '/v1/x402/audit':
      return 'audit';
    case '/v1/x402/map-lite':
      return 'map-lite';
    case '/v1/x402/video':
      return 'video';
    case '/v1/x402/analyze':
      return 'analyze';
    default:
      return undefined;
  }
}

/** Whether this request was granted a free call (safe to call from any later hook or handler). */
export function allowanceGranted(request: FastifyRequest): boolean {
  return request.headers[ALLOWANCE_MARKER] === 'granted';
}

/**
 * Build the gate from config (limits live in config so an operator can retune
 * without a deploy). An omitted limit means NO free rail: only `loadConfig`
 * turns it on, so a hand-built config keeps the pay-per-call contract.
 */
export function allowanceGateFor(config: WebcapConfig, db: Db): AllowanceGate {
  return {
    repo: makeAllowanceRepo(db),
    limit: config.allowanceCalls ?? 0,
    windowMs: (config.allowanceWindowHours ?? DEFAULT_ALLOWANCE_WINDOW_HOURS) * 3_600_000,
    globalWindowLimit: config.allowanceGlobalLimit ?? 0,
  };
}

/**
 * Register the allowance hooks. MUST be called before the MPP settle hook and
 * before the x402 middleware: Fastify runs `onRequest` hooks in registration
 * order, and both of those must see the marker this hook sets.
 */
export function registerAllowanceHook(app: FastifyInstance, config: WebcapConfig, db: Db): void {
  const gate = allowanceGateFor(config, db);

  app.addHook('onRequest', async (request) => {
    const req = request as AllowanceRequest;
    // Strip any inbound marker first: the allowance is ours to decide, never
    // something a caller can assert.
    delete request.headers[ALLOWANCE_MARKER];
    req.webcapAllowance = undefined;

    if (gate.limit <= 0) return;
    const path = request.url.split('?')[0] ?? request.url;
    if (productFor(request.method, path) === undefined) return;
    // A caller that is actively paying takes the paid path and keeps its
    // receipt; the free rail is for callers that brought no payment.
    if (request.headers['payment-signature'] !== undefined || request.headers['x-payment'] !== undefined) return;

    const prepared = prepareAllowance(gate, request.ip);
    req.webcapAllowance = prepared;
    if (prepared.granted) request.headers[ALLOWANCE_MARKER] = 'granted';
  });

  app.addHook('onSend', async (request, reply) => {
    const prepared = (request as AllowanceRequest).webcapAllowance;
    if (prepared === undefined) return;
    (request as AllowanceRequest).webcapAllowance = undefined;
    // Publish the state either way so the caller can see where it stands.
    for (const [name, value] of Object.entries(allowanceHeaders(prepared.decision))) {
      reply.header(name, value);
    }
    // Commit only on success. A 4xx/5xx leaves the budget untouched, so a
    // failed capture never costs the caller a free call.
    if (reply.statusCode < 400) prepared.commit();
  });
}