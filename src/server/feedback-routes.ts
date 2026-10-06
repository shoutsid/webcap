/**
 * Feedback routes: POST /v1/feedback (machine + human form) and the merchant
 * view GET /v1/feedback/list.
 *
 * Two audiences, one endpoint. webcap's paying customer is an autonomous
 * agent, so POST /v1/feedback is a plain JSON route an agent can call with no
 * account and no human round-trip; the /feedback HTML form posts to the same
 * route. The route accepts both application/json and the urlencoded body the
 * form sends, and answers JSON in either case, so it is scriptable and
 * form-friendly at once.
 *
 * The endpoint is free and rate-limited per client like the preview trail.
 * `payer` and `contact` ids are hashed before storage (never stored raw), the
 * POST route itself is attributed into endpoint_hits (measurement, not a
 * vanity page), and the write is a deliberate action so the route reports the
 * stored row id back.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isRecord } from '../util/type-guards.js';
import { HttpError, unprocessable } from '../util/errors.js';
import { RateLimiter, rejectRateLimited } from '../util/ratelimit.js';
import { clientIpOf } from '../util/client-ip.js';
import { authenticate } from './auth.js';
import { FEEDBACK_CATEGORIES, type FeedbackCategory, insertFeedback, listFeedback } from '../db/feedback.js';
import { normalizeUserAgent } from '../db/hits.js';
import { feedbackHtml } from './pages/feedback.js';
import type { AppDeps } from './server.js';

/** How many feedback posts one client may make per window (generous but finite). */
const FEEDBACK_LIMIT = 60;
const FEEDBACK_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGE_LENGTH = 4000;
const MIN_MESSAGE_LENGTH = 8;

/** Validate the shared feedback payload (message required; category/caller optional). */
function parseFeedbackBody(body: unknown): { category: FeedbackCategory; message: string; endpoint?: string; contact?: string; payer?: string } {
  if (!isRecord(body)) throw unprocessable('feedback body must be a JSON object');
  const rawMessage = body.message;
  if (typeof rawMessage !== 'string') throw unprocessable('message is required');
  const message = rawMessage.trim();
  if (message.length < MIN_MESSAGE_LENGTH) throw unprocessable(`message must be at least ${MIN_MESSAGE_LENGTH} characters`);
  if (message.length > MAX_MESSAGE_LENGTH) throw unprocessable(`message must be at most ${MAX_MESSAGE_LENGTH} characters`);

  let category: FeedbackCategory = 'other';
  const rawCat = body.category;
  if (typeof rawCat === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(rawCat)) {
    category = rawCat as FeedbackCategory;
  }

  const endpoint = typeof body.endpoint === 'string' && body.endpoint.trim() !== '' ? body.endpoint.trim().slice(0, 120) : undefined;
  const contact = typeof body.contact === 'string' && body.contact.trim() !== '' ? body.contact.trim().slice(0, 200) : undefined;
  const payer = typeof body.payer === 'string' && body.payer.trim() !== '' ? body.payer.trim().slice(0, 200) : undefined;
  return { category, message, ...(endpoint !== undefined ? { endpoint } : {}), ...(contact !== undefined ? { contact } : {}), ...(payer !== undefined ? { payer } : {}) };
}

/**
 * True when the request body is an application/x-www-form-urlencoded form
 * (the /feedback page) vs a JSON object (the machine route). Fastify does not
 * parse urlencoded by default, so the route reads the raw body for the form case.
 */
function wantsForm(req: FastifyRequest): boolean {
  const ct = req.headers['content-type'];
  const type = typeof ct === 'string' ? ct.split(';')[0]?.trim().toLowerCase() ?? '' : '';
  return type === 'application/x-www-form-urlencoded';
}

function urlencodedToBody(req: FastifyRequest): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw !== 'string' || raw === '') throw unprocessable('message is required');
  const params = new URLSearchParams(raw);
  const out: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      // Repeated keys → array (unlikely in our form; keep it simple and loud).
      const prev = out[k];
      out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** True when a browser-form caller asked for HTML (a human form submit). */
function wantsHtml(req: FastifyRequest): boolean {
  const accept = req.headers.accept;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  return typeof value === 'string' && (value.includes('text/html') || value.includes('application/xhtml') || value.includes('*/*'));
}

export function registerFeedbackRoutes(app: FastifyInstance, deps: AppDeps): void {
  // Process-local limiter keyed by caller, like every other free-route limiter
  // in this codebase (src/util/ratelimit.ts).
  const limiter = new RateLimiter(FEEDBACK_LIMIT, FEEDBACK_WINDOW_MS);
  app.post('/v1/feedback', async (req, reply) => {
    // Rate limit before doing any work: a full-rate spoofed caller must still
    // be able to read the limiter's 429 without burning a write.
    const key = `ip:${clientIpOf(req)}`;
    if (!limiter.allow(key)) {
      throw rejectRateLimited(reply, limiter, key, 'feedback rate limit exceeded — try again shortly');
    }

    const body: unknown = wantsForm(req) ? urlencodedToBody(req) : req.body;
    let parsed: { category: FeedbackCategory; message: string; endpoint?: string; contact?: string; payer?: string };
    try {
      parsed = parseFeedbackBody(body);
    } catch (err) {
      // A rejected form (bad category/message) should render the page for a
      // browser, and the plain JSON envelope for a machine caller.
      if (wantsForm(req) && wantsHtml(req)) {
        const message = err instanceof HttpError ? err.message : 'invalid feedback';
        reply.header('content-type', 'text/html; charset=utf-8');
        return reply.send(feedbackHtml(deps.config, { state: 'rejected', message }));
      }
      throw err;
    }
    const { id } = insertFeedback(deps.db, {
      category: parsed.category,
      message: parsed.message,
      ...(parsed.endpoint !== undefined ? { endpoint: parsed.endpoint } : {}),
      ...(parsed.contact !== undefined ? { contact: parsed.contact } : {}),
      ...(parsed.payer !== undefined ? { payer: parsed.payer } : {}),
      userAgent: normalizeUserAgent(req.headers['user-agent']),
    });

    // A browser form wants the confirmation page; a machine caller wants JSON.
    if (wantsForm(req) && wantsHtml(req)) {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(feedbackHtml(deps.config, { state: 'ok', id }));
    }
    reply.header('content-type', 'application/json; charset=utf-8');
    return { ok: true, id, category: parsed.category };
  });

  // Merchant-only view: the sent feedback, newest first. Same auth gate as the
  // other admin views, so a caller without a merchant key answers 403.
  app.get('/v1/feedback/list', async (req) => {
    const { account } = authenticate(req, deps.db);
    if (account.address.toLowerCase() !== deps.config.merchantAddress.toLowerCase()) {
      throw new HttpError(403, 'forbidden', 'feedback list is merchant-only');
    }
    const query = (req.query ?? {}) as Record<string, unknown>;
    const category = typeof query.category === 'string' ? query.category : undefined;
    const limit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : 100;
    return { feedback: listFeedback(deps.db, category, limit) };
  });
}
