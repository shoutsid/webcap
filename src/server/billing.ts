/**
 * The legacy credits-rail (API-key account) routes: wallet registration +
 * API-key minting (POST /v1/register), USDC credit invoices (POST
 * /v1/invoice), the credit-metered capture (POST /v1/capture), the merchant
 * revenue ledger (GET /v1/ledger), and the account balance view (GET
 * /v1/account). The x402 paid routes stay in ./routes.ts. Split out of
 * routes.ts as a pure function move (no behavior change).
 */
import type { FastifyInstance } from 'fastify';
import { clientIpOf } from '../util/client-ip.js';
import { getAddress, Wallet, ZeroAddress } from 'ethers';import {
  CAPTURE_COST_CREDITS,
  DEFAULT_CREDITS,
  DEFAULT_INVOICE_TTL_MS,
  PACKS,
  PRODUCT_CREDIT_COST,
  USDC_SCALE,
  USDC_UNITS_PER_CREDIT,
  WATCH_CREDIT_TOPUP_COST_CAPTURE,
  WATCH_CREDIT_TOPUP_COST_EXTRACT,
  WATCH_TOPUP_RUNS,
  getPack,
  usdcForCredits,
  usdcUnitsForCredits,
  type WebcapConfig,
} from '../config.js';
import { makeWatchRepo } from '../watch/store.js';
import { makeAccountsRepo } from '../db/accounts.js';
import { makeApiKeysRepo } from '../db/api_keys.js';
import { makeCreditsRepo } from '../db/credits.js';
import type { Db } from '../db/index.js';
import { makeInvoicesRepo, type InvoiceRow } from '../db/invoices.js';
import { makePaymentWebhooksRepo } from '../db/payment-webhooks.js';
import { makeRevenueRepo } from '../db/revenue.js';
import { CaptureError, VideoBusyError } from '../capture/errors.js';
import { captureVideo } from '../capture/video.js';
import { pinoServiceLogger } from '../util/logger.js';
import { runAuditCompute, runExtractCompute } from './product-cores.js';
import { discoverMapLiteUrls, parseMapLiteRequest } from './map-lite.js';
import { parseVideoRequest } from './video-parse.js';
import { parseAnalyzeTask, runAnalyzeOne } from './ml-routes.js';
import { HttpError, unprocessable } from '../util/errors.js';
import { generateApiKey, hashKey } from '../util/keys.js';
import { RateLimiter, rejectRateLimited } from '../util/ratelimit.js';
import { storeArtifact } from '../extract/service.js';
import { isRecord, parseFormat, parseOptions, validatedUrl } from './capture-parse.js';
import { authenticate } from './auth.js';
import type { AppDeps } from './server.js';

// Fixed 60s window for the registration per-peer budget below.
const RATE_LIMIT_WINDOW_MS = 60_000;
const REGISTER_RATE_LIMIT = 3;

/** Example body for a rejected POST /v1/register, so a 422 is a recipe. */
function registerHint(config: WebcapConfig): { example: { address: string }; guide: string } {
  return {
    example: { address: '0xYourWalletAddress' },
    guide: `${config.publicBaseUrl}/skill.md`,
  };
}

export function registerBillingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, config } = deps;
  const accounts = makeAccountsRepo(db);
  const keys = makeApiKeysRepo(db);
  const credits = makeCreditsRepo(db);
  const invoices = makeInvoicesRepo(db);
  const revenue = makeRevenueRepo(db);
  const merchantAddress = merchantAddressOf(config);
  const allowHosts = deps.captureAllowHosts;
  const registerLimiter = new RateLimiter(REGISTER_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);

  app.post('/v1/register', async (req, reply) => {
    const caller = clientIpOf(req);
    if (!registerLimiter.allow(caller)) {
      rejectRateLimited(reply, registerLimiter, caller, 'registration rate limit exceeded', registerHint(config));
    }
    const raw = isRecord(req.body) ? req.body.address : undefined;
    if (typeof raw !== 'string') throw unprocessable('address is required', registerHint(config));
    let address: string;
    try {
      address = getAddress(raw);
    } catch {
      throw unprocessable('invalid address', registerHint(config));
    }
    // A merchant/ledger-bearing account is exactly one whose address matches
    // config.merchantAddress (the /v1/ledger gate compares the same pair). On
    // live chains that identity is granted out-of-band by ops, never via this
    // unauthenticated endpoint.
    if (config.chain.name !== 'local' && address.toLowerCase() === config.merchantAddress.toLowerCase()) {
      throw new HttpError(403, 'forbidden', 'merchant registration is disabled on live chains; see the README ops runbook');
    }
    const accountId = accounts.findByAddress(address) ?? accounts.create(address);
    const apiKey = generateApiKey();
    keys.create(accountId, hashKey(apiKey));
    return reply.status(201).send({ address, apiKey, balance: 0 });
  });

  app.post('/v1/invoice', async (req, reply) => {
    const { account } = authenticate(req, db);
    const creditsAmount = parseCredits(req.body, config.defaultCredits ?? DEFAULT_CREDITS);
    const invoice = createInvoice(invoices, config, merchantAddress, account.id, creditsAmount);
    return reply.status(201).send({
      invoiceId: String(invoice.id),
      merchant: merchantAddress,
      token: config.chain.usdcContract,
      chainId: config.chain.chainId,
      requiredUsdc: usdcForCredits(creditsAmount),
      credits: creditsAmount,
      pack: packForCredits(creditsAmount),
      expiresAt: invoice.expires_at,
    });
  });

  app.post('/v1/capture', async (req) => {
    const { account } = authenticate(req, db);
    const body = req.body;
    const rawUrl = isRecord(body) ? body.url : undefined;
    if (typeof rawUrl !== 'string') throw unprocessable('url is required');
    const normalized = validatedUrl(rawUrl, allowHosts);
    const format = parseFormat(body);
    const options = parseOptions(body);

    const spendCap = config.spendCapCredits;
    if (spendCap !== undefined && credits.spentByAccount(account.id) >= spendCap) {
      const spent = credits.spentByAccount(account.id);
      throw new HttpError(429, 'spend_cap_exceeded', 'per-account spend cap exceeded', {
        payer: account.address,
        spent,
        cap: spendCap,
        reason: `per-account spend cap exceeded: spent ${spent} of ${spendCap} credits`,
      });
    }

    const balanceBefore = accounts.getBalance(account.id);
    if (balanceBefore < CAPTURE_COST_CREDITS) {
      const topUp = createInvoice(invoices, config, merchantAddress, account.id, CAPTURE_COST_CREDITS);
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', {
        invoiceId: String(topUp.id),
        requiredUsdc: usdcForCredits(CAPTURE_COST_CREDITS),
        balance: balanceBefore,
      });
    }
    if (!credits.recordCharge(account.id)) {
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', { balance: 0 });
    }

    let result;
    try {
      result = await deps.capture({ url: normalized, format, options });
    } catch (err) {
      credits.grantCredits(account.id, CAPTURE_COST_CREDITS, 'capture_refunded', req.id);
      if (err instanceof CaptureError) throw new HttpError(502, 'capture_failed', err.message);
      throw err;
    }
    const url = storeArtifact(deps.artifacts, config, normalized, result);
    return {
      artifact: { format: result.format, bytes: result.bytes, data: result.buffer.toString('base64'), url },
      creditsCharged: CAPTURE_COST_CREDITS,
      balance: accounts.getBalance(account.id),
    };
  });

  // --- Credit-metered products: every paid product buyable with a bearer
  // token (no signing key). Each call costs PRODUCT_CREDIT_COST credits,
  // charged before compute and refunded whenever the call does not return
  // 200 — so a 422 or a 502 never burns a credit, exactly like /v1/capture.
  const chargeForProduct = (account: { id: number; address: string }, _product: string): void => {
    const spendCap = config.spendCapCredits;
    if (spendCap !== undefined && credits.spentByAccount(account.id) >= spendCap) {
      const spent = credits.spentByAccount(account.id);
      throw new HttpError(429, 'spend_cap_exceeded', 'per-account spend cap exceeded', {
        payer: account.address,
        spent,
        cap: spendCap,
        reason: `per-account spend cap exceeded: spent ${spent} of ${spendCap} credits`,
      });
    }
    const balanceBefore = accounts.getBalance(account.id);
    if (balanceBefore < PRODUCT_CREDIT_COST) {
      const topUp = createInvoice(invoices, config, merchantAddress, account.id, PRODUCT_CREDIT_COST);
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', {
        invoiceId: String(topUp.id),
        requiredUsdc: usdcForCredits(PRODUCT_CREDIT_COST),
        balance: balanceBefore,
      });
    }
    if (!credits.recordCharge(account.id)) {
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', { balance: 0 });
    }
  };

  const refundForProduct = (reqId: string, accountId: number, product: string): void => {
    credits.grantCredits(accountId, PRODUCT_CREDIT_COST, `${product}_refunded`, reqId);
  };

  app.post('/v1/extract', async (req) => {
    const { account } = authenticate(req, db);
    chargeForProduct(account, 'extract');
    let computed;
    try {
      computed = await runExtractCompute(deps, config, pinoServiceLogger(req.log), req.body, allowHosts);
    } catch (err) {
      refundForProduct(req.id, account.id, 'extract');
      throw err;
    }
    return { results: computed.results, creditsCharged: PRODUCT_CREDIT_COST, balance: accounts.getBalance(account.id) };
  });

  app.post('/v1/audit', async (req) => {
    const { account } = authenticate(req, db);
    chargeForProduct(account, 'audit');
    let computed;
    try {
      computed = await runAuditCompute(deps, req.body, allowHosts);
    } catch (err) {
      refundForProduct(req.id, account.id, 'audit');
      throw err;
    }
    return { audit: { url: computed.url, ...computed.checks }, creditsCharged: PRODUCT_CREDIT_COST, balance: accounts.getBalance(account.id) };
  });

  app.post('/v1/map-lite', async (req) => {
    const { account } = authenticate(req, db);
    chargeForProduct(account, 'map-lite');
    let discovery;
    try {
      const { url, maxUrls } = parseMapLiteRequest(req.body, allowHosts);
      discovery = await discoverMapLiteUrls(url, maxUrls, allowHosts);
    } catch (err) {
      refundForProduct(req.id, account.id, 'map-lite');
      throw err;
    }
    return { urls: discovery.urls, creditsCharged: PRODUCT_CREDIT_COST, balance: accounts.getBalance(account.id) };
  });

  app.post('/v1/video', async (req) => {
    const { account } = authenticate(req, db);
    chargeForProduct(account, 'video');
    let result;
    try {
      const parsed = parseVideoRequest(req.body, allowHosts);
      result = await captureVideo({
        url: parsed.url,
        format: parsed.format,
        durationMs: parsed.durationMs,
        scrollSpeed: parsed.scrollSpeed,
        scrollEasing: parsed.scrollEasing,
        ...(parsed.viewport !== undefined ? { viewport: parsed.viewport } : {}),
        ...(parsed.extraHTTPHeaders !== undefined ? { extraHTTPHeaders: parsed.extraHTTPHeaders } : {}),
        ...(parsed.cookies !== undefined ? { cookies: parsed.cookies } : {}),
        ...(parsed.stealth !== undefined ? { stealth: parsed.stealth } : {}),
        ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
        ...(parsed.timezoneId !== undefined ? { timezoneId: parsed.timezoneId } : {}),
      });
    } catch (err) {
      refundForProduct(req.id, account.id, 'video');
      if (err instanceof VideoBusyError) throw new HttpError(429, err.code, err.message);
      if (err instanceof CaptureError) throw new HttpError(502, 'video_failed', err.message);
      throw err;
    }
    return {
      artifact: { mime: result.mime, bytes: result.bytes, data: result.buffer.toString('base64') },
      creditsCharged: PRODUCT_CREDIT_COST,
      balance: accounts.getBalance(account.id),
    };
  });

  app.post('/v1/analyze', async (req) => {
    const { account } = authenticate(req, db);
    const body = req.body;
    if (!isRecord(body)) throw unprocessable('body must be an object');
    const rawUrl = body.url;
    if (typeof rawUrl !== 'string') throw unprocessable('url is required');
    const url = validatedUrl(rawUrl, allowHosts);
    const task = parseAnalyzeTask(body.task);
    const context = typeof body.context === 'string' ? body.context : undefined;
    chargeForProduct(account, 'analyze');
    const started = performance.now();
    let result;
    try {
      result = await runAnalyzeOne(deps, config, url, task, context);
    } catch (err) {
      refundForProduct(req.id, account.id, 'analyze');
      throw err;
    }
    return { task, result, creditsCharged: PRODUCT_CREDIT_COST, balance: accounts.getBalance(account.id), latency_ms: Math.round(Math.max(0, performance.now() - started)) };
  });

  app.post('/v1/analyze/batch', async (req) => {
    const { account } = authenticate(req, db);
    const body = req.body;
    if (!isRecord(body)) throw unprocessable('body must be an object');
    const rawUrls = body.urls;
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) throw unprocessable('urls must be a non-empty array');
    if (rawUrls.length > 10) throw unprocessable('urls must contain at most 10 items');
    const task = parseAnalyzeTask(body.task);
    const context = typeof body.context === 'string' ? body.context : undefined;
    const urls: string[] = [];
    for (const rawUrl of rawUrls) {
      if (typeof rawUrl !== 'string') throw unprocessable('each url must be a string');
      urls.push(validatedUrl(rawUrl, allowHosts));
    }
    chargeForProduct(account, 'analyze-batch');
    const results: Array<{ url: string; status: 'ok' | 'error'; result?: unknown; error?: string }> = [];
    let failures = 0;
    for (const url of urls) {
      try {
        results.push({ url, status: 'ok', result: await runAnalyzeOne(deps, config, url, task, context) });
      } catch (err) {
        failures += 1;
        results.push({ url, status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (failures === urls.length) {
      refundForProduct(req.id, account.id, 'analyze-batch');
      throw new HttpError(502, 'analysis_failed', 'all urls failed to analyze');
    }
    return { results, task, creditsCharged: PRODUCT_CREDIT_COST, balance: accounts.getBalance(account.id) };
  });

  app.post('/v1/watches/:id/topup', async (req) => {
    const { account } = authenticate(req, db);
    const rawId = isRecord(req.params) ? req.params.id : undefined;
    if (typeof rawId !== 'string' || rawId === '') throw unprocessable('id is required');
    const body = req.body;
    if (!isRecord(body)) throw unprocessable('body must be an object');
    if (body.runs !== WATCH_TOPUP_RUNS) throw unprocessable(`runs must be ${WATCH_TOPUP_RUNS} (one pack)`);
    const watchRepo = makeWatchRepo(db);
    const watch = watchRepo.get(rawId);
    if (watch === null) throw new HttpError(404, 'not_found', 'watch not found');
    const cost = watch.mode === 'extract' ? WATCH_CREDIT_TOPUP_COST_EXTRACT : WATCH_CREDIT_TOPUP_COST_CAPTURE;
    const spendCap = config.spendCapCredits;
    if (spendCap !== undefined && credits.spentByAccount(account.id) + cost > spendCap) {
      const spent = credits.spentByAccount(account.id);
      throw new HttpError(429, 'spend_cap_exceeded', 'per-account spend cap exceeded', {
        payer: account.address,
        spent,
        cap: spendCap,
        reason: `per-account spend cap exceeded: spent ${spent} of ${spendCap} credits`,
      });
    }
    const balanceBefore = accounts.getBalance(account.id);
    if (balanceBefore < cost) {
      const topUp = createInvoice(invoices, config, merchantAddress, account.id, cost);
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', {
        invoiceId: String(topUp.id),
        requiredUsdc: usdcForCredits(cost),
        balance: balanceBefore,
      });
    }
    if (!accounts.spendN(account.id, cost, 'watch_topup_charged')) {
      throw new HttpError(402, 'insufficient_credits', 'insufficient credits', { balance: 0 });
    }
    const funded = watchRepo.topUp(rawId, WATCH_TOPUP_RUNS, new Date().toISOString());
    if (funded === null) {
      credits.grantCredits(account.id, cost, 'watch_topup_refunded', req.id);
      throw new HttpError(404, 'not_found', 'watch not found');
    }
    return { watchId: rawId, credits: funded, creditsCharged: cost, balance: accounts.getBalance(account.id) };
  });

  app.get('/v1/ledger', async (req) => {    const { account } = authenticate(req, db);
    if (account.address.toLowerCase() !== config.merchantAddress.toLowerCase()) {
      throw new HttpError(403, 'forbidden', 'ledger is merchant-only');
    }
    return { summary: revenue.summary(), recent: revenue.recent(50) };
  });

  app.get('/v1/account', async (req) => {
    const { account } = authenticate(req, db);
    return {
      address: account.address,
      balance: account.credits,
      invoices: invoices.listByAccount(account.id).map((inv) => ({
        id: String(inv.id),
        status: inv.status,
        credits: inv.usdc_amount / USDC_UNITS_PER_CREDIT,
        requiredUsdc: inv.usdc_amount / USDC_SCALE,
        createdAt: inv.created_at,
      })),
    };
  });

  // --- Payment webhooks ---

  /**
   * POST /v1/webhooks — Register a payment webhook.
   * Body: { "url": "https://..." }
   * Returns: { "id": 1, "url": "https://...", "events": ["payment.settled"] }
   */
  app.post('/v1/webhooks', async (req, reply) => {
    const { account } = authenticate(req, db);
    const body = req.body;
    const rawUrl = isRecord(body) ? body.url : undefined;
    if (typeof rawUrl !== 'string') throw unprocessable('url is required');
    // Validate URL format
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw unprocessable('invalid url');
    }
    if (parsed.protocol !== 'https:') throw unprocessable('webhook url must be https');
    // Generate a secret for signing
    const secret = generateApiKey();
    const webhooks = makePaymentWebhooksRepo(db);
    const id = webhooks.register(account.id, parsed.origin + parsed.pathname, secret);
    return reply.status(201).send({
      id,
      url: parsed.origin + parsed.pathname,
      events: ['payment.settled'],
      secret, // Only shown on creation — user must store it
    });
  });

  /**
   * GET /v1/webhooks — List payment webhooks for the authenticated account.
   */
  app.get('/v1/webhooks', async (req) => {
    const { account } = authenticate(req, db);
    const webhooks = makePaymentWebhooksRepo(db);
    const rows = webhooks.listByAccount(account.id);
    return {
      webhooks: rows.map((wh) => ({
        id: wh.id,
        url: wh.url,
        events: wh.events.split(','),
        active: wh.active === 1,
        createdAt: wh.created_at,
      })),
    };
  });

  /**
   * DELETE /v1/webhooks/:id — Deactivate a payment webhook.
   */
  app.delete('/v1/webhooks/:id', async (req) => {
    const { account } = authenticate(req, db);
    const id = Number((req.params as Record<string, string>).id);
    if (!Number.isInteger(id) || id <= 0) throw unprocessable('invalid webhook id');
    const webhooks = makePaymentWebhooksRepo(db);
    const deleted = webhooks.deactivate(id, account.id);
    if (!deleted) throw new HttpError(404, 'not_found', 'webhook not found');
    return { ok: true };
  });
}

function merchantAddressOf(config: WebcapConfig): string {
  if (config.merchantPrivateKey === '') return ZeroAddress;
  return new Wallet(config.merchantPrivateKey).address;
}

/** Mint the 1-credit top-up invoice quoted in a 402 insufficient_credits detail (shared with the jobs submit route). */
export function createInsufficientCreditsInvoice(db: Db, config: WebcapConfig, accountId: number): InvoiceRow {
  const invoices = makeInvoicesRepo(db);
  return createInvoice(invoices, config, merchantAddressOf(config), accountId, CAPTURE_COST_CREDITS);
}

function createInvoice(
  invoices: ReturnType<typeof makeInvoicesRepo>,
  config: WebcapConfig,
  merchantAddress: string,
  accountId: number,
  creditsAmount: number,
): InvoiceRow {
  const id = invoices.create({
    account_id: accountId,
    pack: packForCredits(creditsAmount),
    chain: config.chain.name,
    usdc_contract: config.chain.usdcContract,
    usdc_address: merchantAddress,
    amount_usd: usdcForCredits(creditsAmount),
    usdc_amount: usdcUnitsForCredits(creditsAmount),
    recipient: merchantAddress,
    expires_at: new Date(Date.now() + (config.invoiceTtlMs ?? DEFAULT_INVOICE_TTL_MS)).toISOString(),
  });
  const row = invoices.get(id);
  if (row === undefined) throw new Error(`invoice ${id} vanished after insert`);
  return row;
}

function packForCredits(creditsAmount: number): string {
  for (const [name, pack] of Object.entries(PACKS)) {
    if (pack.credits === creditsAmount) return name;
  }
  return 'custom';
}

function parseCredits(body: unknown, defaultCredits: number): number {
  if (!isRecord(body)) return defaultCredits;
  const raw = body.credits;
  const rawPack = body.pack;
  if (raw !== undefined && rawPack !== undefined) {
    throw unprocessable('specify either credits or pack, not both');
  }
  if (rawPack !== undefined) {
    if (typeof rawPack !== 'string') throw unprocessable('pack must be one of: starter, pro, max');
    try {
      return getPack(rawPack).credits;
    } catch {
      throw unprocessable('pack must be one of: starter, pro, max');
    }
  }
  if (raw === undefined) return defaultCredits;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw unprocessable('credits must be a positive integer');
  }
  return raw;
}
