/**
 * The monitoring (scheduled watch) routes.
 *
 * - POST /v1/watches          create a watch (free; it starts with 0 credits)
 * - GET  /v1/watches/:id      watch state + the last ~10 runs, newest first
 * - DELETE /v1/watches/:id    remove the watch and its runs
 * - POST /v1/x402/watches/topup  x402-paid 100-run pack, priced at the watch's
 *   mode unit price × 100 (the 402 challenge + settlement are wired in
 *   src/server/x402.ts exactly like the two existing paid routes)
 */
import type { FastifyInstance } from 'fastify';
import { WATCH_TOPUP_RUNS, watchTopUpPriceUsdcUnits } from '../config.js';
import { HttpError, badRequest } from '../util/errors.js';
import { RateLimiter, rejectRateLimited } from '../util/ratelimit.js';
import { clientIpOf } from '../util/client-ip.js';
import { validateCaptureUrl } from '../util/url.js';

import { makeWatchRepo, type WatchRepo, type WatchRow, type WatchRunRow, type WatchMode } from '../watch/store.js';
import { parseChannel, parseConditionsField, type WatchChannel, type WatchCondition } from '../watch/conditions.js';
import { WATCH_EVERIES, type WatchEvery } from '../watch/intervals.js';
import { isRecord } from './capture-parse.js';
import { x402Payer } from './x402.js';
import { registerPaidRoute } from './query-body.js';
import type { AppDeps } from './server.js';

const RUNS_PER_PAGE = 10;
const WATCH_MUTATION_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface WatchRunView {
  readonly id: number;
  readonly status: 'ok' | 'error' | 'no-credit';
  readonly changed: boolean;
  readonly artifactUrl?: string;
  readonly extract?: unknown;
  readonly diffSummary?: string;
  readonly aiSummary?: string;
  readonly webhook?: string;
  readonly error?: string;
  readonly createdAt: string;
}

export interface WatchStateView {
  readonly id: string;
  readonly url: string;
  readonly every: string;
  readonly mode: WatchMode;
  readonly schema?: string;
  readonly webhook?: string;
  readonly channel: WatchChannel;
  readonly conditions?: readonly WatchCondition[];
  readonly credits: number;
  readonly paused: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly runs: readonly WatchRunView[];
}

export function registerWatchRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, db } = deps;
  const repo = makeWatchRepo(db);
  const allowHosts = deps.captureAllowHosts;
  // One shared budget per caller across both mutation routes (create + delete),
  // resolved with clientIpOf (src/util/client-ip.ts) rather than the raw socket
  // peer, which is the tunnel for every caller.
  const watchMutationLimiter = new RateLimiter(WATCH_MUTATION_RATE_LIMIT, RATE_LIMIT_WINDOW_MS);

  app.post('/v1/watches', async (req, reply) => {
    const caller = clientIpOf(req);
    if (!watchMutationLimiter.allow(caller)) {
      rejectRateLimited(reply, watchMutationLimiter, caller, 'watch mutation rate limit exceeded');
    }
    const spec = parseCreateWatchBody(req.body, allowHosts, config.publicBaseUrl);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    // The first run is due immediately (next tick); with 0 credits it is
    // recorded as 'no-credit' and pauses the watch until the first top-up.
    repo.create({
      id,
      url: spec.url,
      every: spec.every,
      mode: spec.mode,
      schemaJson: spec.schemaJson,
      webhookUrl: spec.webhookUrl,
      conditionsJson: spec.conditionsJson,
      channel: spec.channel,
      credits: 0,
      nextRunAt: createdAt,
      createdAt,
    });
    const row = repo.get(id);
    if (row === null) throw new Error(`watch ${id} vanished after insert`);
    return reply.status(201).send({ id, state: watchState(repo, row) });
  });

  app.get('/v1/watches/:id', async (req) => {
    const row = repo.get(watchIdOf(req));
    if (row === null) throw new HttpError(404, 'not_found', 'watch not found');
    return watchState(repo, row);
  });

  app.delete('/v1/watches/:id', async (req, reply) => {
    const caller = clientIpOf(req);
    if (!watchMutationLimiter.allow(caller)) {
      rejectRateLimited(reply, watchMutationLimiter, caller, 'watch mutation rate limit exceeded');
    }
    const id = watchIdOf(req);
    if (!repo.delete(id)) throw new HttpError(404, 'not_found', 'watch not found');
    return reply.status(204).send();
  });

  registerPaidRoute(app, '/v1/x402/watches/topup', async (req) => {
    if (config.x402Network === undefined) {
      throw new HttpError(503, 'x402_disabled', 'x402 payment requires WEBCAP_CHAIN=base-sepolia or base');
    }
    const body = req.body;
    if (!isRecord(body)) throw badRequest('body must be an object');
    const rawWatchId = body['watchId'];
    if (typeof rawWatchId !== 'string' || rawWatchId === '') throw badRequest('watchId is required');
    if (body['runs'] !== WATCH_TOPUP_RUNS) throw badRequest(`runs must be ${WATCH_TOPUP_RUNS} (one pack)`);
    const watch = repo.get(rawWatchId);
    if (watch === null) throw new HttpError(404, 'not_found', 'watch not found');
    const priceUsdcUnits = watchTopUpPriceUsdcUnits(watch.mode, config);
    // credits += runs; paused resets to 0; next_run_at rescheduled when paused.
    const credits = repo.topUp(rawWatchId, WATCH_TOPUP_RUNS, new Date().toISOString());
    if (credits === null) throw new HttpError(404, 'not_found', 'watch not found');
    const payer = x402Payer(req) ?? 'unknown';
    (req as unknown as { _pendingRevenue?: { endpoint: string; payer: string; revenueUsdcUnits: number; costUsdcUnits: number } })._pendingRevenue = {
      endpoint: 'watch-topup',
      payer,
      revenueUsdcUnits: priceUsdcUnits,
      costUsdcUnits: 0,
    };
    return { watchId: rawWatchId, credits, priceUsdcUnits };
  });
}

function watchIdOf(req: { params: unknown }): string {
  const rawId = isRecord(req.params) ? req.params.id : undefined;
  if (typeof rawId !== 'string' || rawId === '') throw badRequest('id is required');
  return rawId;
}

interface CreateWatchSpec {
  readonly url: string;
  readonly every: WatchEvery;
  readonly mode: WatchMode;
  readonly schemaJson: string | null;
  readonly webhookUrl: string | null;
  readonly conditionsJson: string | null;
  readonly channel: WatchChannel;
}

function parseCreateWatchBody(
  body: unknown,
  allowHosts: readonly string[] | undefined,
  publicBaseUrl: string,
): CreateWatchSpec {
  try {
    return parseWatchSpec(body, allowHosts);
  } catch (err) {
    if (err instanceof HttpError && err.status === 400 && err.detail === undefined) {
      throw badRequest(err.message, {
        example: { url: 'https://example.com/', every: '1h', mode: 'capture' },
        guide: `${publicBaseUrl}/skill.md`,
      });
    }
    throw err;
  }
}

function parseWatchSpec(body: unknown, allowHosts: readonly string[] | undefined): CreateWatchSpec {
  if (!isRecord(body)) throw badRequest('body must be an object');
  const rawUrl = body['url'];
  if (typeof rawUrl !== 'string' || rawUrl === '') throw badRequest('url is required');
  const url = validatedWatchUrl(rawUrl, allowHosts);
  const every = parseEvery(body['every']);
  const mode = parseMode(body['mode']);
  let schemaJson: string | null = null;
  const rawSchema = body['schema'];
  if (rawSchema !== undefined) {
    if (typeof rawSchema !== 'string' || rawSchema.trim() === '') throw badRequest('schema must be a non-empty string');
    schemaJson = rawSchema.trim();
  }
  let webhookUrl: string | null = null;
  const rawWebhook = body['webhook'];
  if (rawWebhook !== undefined) {
    if (typeof rawWebhook !== 'string' || rawWebhook === '') throw badRequest('webhook must be an https URL');
    webhookUrl = validatedWatchWebhook(rawWebhook);
  }
  const conditions = parseConditionsField(body['conditions']);
  const channel = parseChannel(body['channel']);
  return {
    url,
    every,
    mode,
    schemaJson,
    webhookUrl,
    conditionsJson: conditions === null ? null : JSON.stringify(conditions),
    channel,
  };
}

function parseEvery(raw: unknown): WatchEvery {
  if (raw === '15m' || raw === '1h' || raw === '6h' || raw === '24h') return raw;
  throw badRequest(`every must be one of: ${WATCH_EVERIES.join(', ')}`);
}

function parseMode(raw: unknown): WatchMode {
  if (raw === 'capture' || raw === 'extract') return raw;
  throw badRequest('mode must be capture or extract');
}

/** Watch targets are https-only; host policy reuses the capture URL guard. */
function validatedWatchUrl(raw: string, allowHosts: readonly string[] | undefined): string {
  let normalized: string;
  try {
    normalized = validateCaptureUrl(raw, { allowHosts });
  } catch {
    throw badRequest('url must be a valid https URL');
  }
  if (!normalized.startsWith('https://')) throw badRequest('url must be https');
  return normalized;
}

/** Webhook receivers are https-only and must not be private hosts (SSRF). */
function validatedWatchWebhook(raw: string): string {
  let normalized: string;
  try {
    normalized = validateCaptureUrl(raw);
  } catch {
    throw badRequest('webhook must be a valid https URL');
  }
  if (!normalized.startsWith('https://')) throw badRequest('webhook must be https');
  return normalized;
}

function watchState(repo: WatchRepo, row: WatchRow): WatchStateView {
  return {
    id: row.id,
    url: row.url,
    every: row.every,
    mode: row.mode,
    ...(row.schema_json !== null ? { schema: row.schema_json } : {}),
    ...(row.webhook_url !== null ? { webhook: row.webhook_url } : {}),
    channel: row.channel === 'slack' || row.channel === 'discord' ? row.channel : 'generic',
    ...(row.conditions_json !== null ? { conditions: JSON.parse(row.conditions_json) as WatchCondition[] } : {}),
    credits: row.credits,
    paused: row.paused === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    runs: repo.recentRuns(row.id, RUNS_PER_PAGE).map(runView),
  };
}

function runView(run: WatchRunRow): WatchRunView {
  return {
    id: run.id,
    status: run.status,
    changed: run.changed === 1,
    ...(run.artifact_url !== null ? { artifactUrl: run.artifact_url } : {}),
    ...(run.extract_json !== null ? { extract: JSON.parse(run.extract_json) } : {}),
    ...(run.diff_summary !== null ? { diffSummary: run.diff_summary } : {}),
    ...(run.ai_summary !== null ? { aiSummary: run.ai_summary } : {}),
    ...(run.webhook !== null ? { webhook: run.webhook } : {}),
    ...(run.error !== null ? { error: run.error } : {}),
    createdAt: run.created_at,
  };
}
