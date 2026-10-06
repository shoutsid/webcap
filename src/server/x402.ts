/**
 * The x402 payment entry for webcap: installs the x402 payment middleware
 * (onRequest verify / onSend settle / onError cancel) ahead of the routes and
 * exposes the payer address of a settled request (x402Payer). The 402-challenge
 * builders live in ./x402/challenges.ts and the route-table assembly in
 * ./x402/routes.ts; everything this module used to export is re-exported here,
 * so no import site changes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { paymentMiddlewareFromHTTPServer } from '@x402/fastify';
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { WebcapConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { makeRevenueRepo, type RevenueEntry } from '../db/revenue.js';
import { makeWatchRepo } from '../watch/store.js';
import { registerMppSettleHook } from '../mpp/plugin.js';
import { ALLOWANCE_MARKER, registerAllowanceHook } from './allowance-gate.js';
import { buildAllX402Routes } from './x402/routes.js';

export { BAZAAR_EXAMPLE_PAYER, buildUnpaidBody, topUpOutputExample, type UnpaidBazaarMetadata } from './x402/challenges.js';
export { X402_CAPTURE_PATH, X402_CAPTURE_PATTERN, X402_EXTRACT_PATH, X402_EXTRACT_PATTERN, X402_JOBS_PATH, X402_JOBS_PATTERN, X402_MAP_LITE_PATH, X402_MAP_LITE_PATTERN, X402_TOPUP_PATH, X402_TOPUP_PATTERN, X402_VIDEO_PATH, X402_VIDEO_PATTERN, X402_ANALYZE_PATH, X402_ANALYZE_PATTERN, X402_ANALYZE_BATCH_PATH, X402_ANALYZE_BATCH_PATTERN } from './x402/routes.js';
export { buildAllX402Routes, buildX402Requirement, buildX402Routes, buildX402TopUpRoute } from './x402/routes.js';

/**
 * Register the x402 payment hooks (onRequest verify / onSend settle /
 * onError cancel) ahead of the routes. No-op when x402 is disabled.
 * `db` supplies the watch store for the top-up route's per-request price.
 */
export function registerX402Middleware(
  app: FastifyInstance,
  config: WebcapConfig,
  facilitator: FacilitatorClient | undefined,
  db: Db,
): void {
  const network = config.x402Network;
  if (network === undefined) return;
  if (facilitator === undefined) {
    throw new Error('x402 is enabled but no facilitator client was provided');
  }
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());
  // The rolling free allowance registers FIRST: it decides the call and sets the
  // marker header that the two hooks below consult, so a granted call never
  // reaches a settle and a caller with no wallet still gets the real product.
  registerAllowanceHook(app, config, db);
  // MPP settle hooks register BEFORE paymentMiddleware so they run first:
  // the settle onRequest verifies ahead of x402's verify, the settle onSend
  // consumes the settled marker ahead of x402's settle (single settlement).
  // Disabled MPP registers zero hooks. The SAME resourceServer is shared.
  registerMppSettleHook(app, config, db, resourceServer);

  // Build the HTTP resource server ourselves (instead of paymentMiddleware) so
  // one method can be wrapped: `requiresPayment` is the paywall's only gate, and
  // returning false for an allowance-marked call is what makes the free rail
  // work without the middleware charging it. The adapter reads request headers,
  // so the marker the allowance hook set is visible here.
  const httpServer = new x402HTTPResourceServer(resourceServer, buildAllX402Routes(config, makeWatchRepo(db)));
  const baseRequiresPayment = httpServer.requiresPayment.bind(httpServer);
  httpServer.requiresPayment = (context) =>
    context.adapter.getHeader(ALLOWANCE_MARKER) === 'granted' ? false : baseRequiresPayment(context);
  paymentMiddlewareFromHTTPServer(app, httpServer);

  // Post-settlement revenue hook: runs AFTER x402's onSend settle.
  // Only records revenue when settlement actually succeeded (PAYMENT-RESPONSE
  // header present = facilitator confirmed on-chain transfer).
  const revenue = makeRevenueRepo(db);
  app.addHook('onSend', async (request, reply) => {
    const pending = (request as unknown as { _pendingRevenue?: RevenueEntry })._pendingRevenue;
    if (pending === undefined) return;
    // Clear so idempotent hooks don't double-record
    (request as unknown as { _pendingRevenue?: RevenueEntry })._pendingRevenue = undefined;
    // Only record if settlement succeeded: x402 middleware sets PAYMENT-RESPONSE
    // header on successful settlement. Absence means settlement was skipped
    // (free request) or failed (error already returned).
    const paymentResponse = reply.getHeader('payment-response');
    if (paymentResponse !== undefined && paymentResponse !== null) {
      revenue.record(pending);
    }
  });
}

/** Payer EOA address from the verified payment context, if any. */
export function x402Payer(req: FastifyRequest): string | undefined {
  const payload = req.x402Context?.paymentPayload?.payload;
  if (payload === undefined) return undefined;
  const auth = payload['authorization'];
  if (typeof auth !== 'object' || auth === null) return undefined;
  const from = (auth as { from?: unknown }).from;
  return typeof from === 'string' ? from : undefined;
}
