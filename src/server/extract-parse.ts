import type { PageStructure } from '../capture/pipeline.js';
import type { PageClassification } from '../ml/deterministic.js';
import { unprocessable } from '../util/errors.js';
import { validateAgainstSchema, verifySpans, type Span } from '../extract/schema-validator.js';
import { isRecord, validatedUrl } from './capture-parse.js';

export const MAX_EXTRACT_BATCH = 50;

export type ExtractedContent = PageStructure & { readonly extracted?: Record<string, unknown>; readonly classification?: PageClassification };

export type ExtractResult =
  | { readonly url: string; readonly status: 'ok'; readonly data: ExtractedContent }
  | { readonly url: string; readonly status: 'error'; readonly error: string };

/** Normalize the extract request's targets: `urls` (string[], batch) or `url` (single string). */
export function parseExtractUrls(body: unknown, allowHosts: readonly string[] | undefined): string[] {
  if (!isRecord(body)) throw unprocessable('body must be an object');
  const rawBatch = body['urls'];
  const rawSingle = body['url'];
  const hasBatch = Array.isArray(rawBatch) && rawBatch.length > 0;
  const hasSingle = typeof rawSingle === 'string' && rawSingle.trim() !== '';
  // `url` and `urls` are alternatives, and the schema says so (`oneOf`). An
  // agent that sends both is guessing; previously `urls` silently won and the
  // `url` it also sent was dropped, which is worse than refusing loudly.
  if (hasBatch && hasSingle) {
    throw unprocessable('provide exactly one of url (string) or urls (string[]), not both');
  }
  const rawUrls: readonly unknown[] = hasBatch ? (rawBatch as readonly unknown[]) : hasSingle ? [rawSingle] : [];
  if (rawUrls.length === 0) throw unprocessable('provide url (string) or urls (string[])');
  if (rawUrls.length > MAX_EXTRACT_BATCH) throw unprocessable(`urls must be at most ${MAX_EXTRACT_BATCH} items`);
  return rawUrls.map((raw) => {
    if (typeof raw !== 'string') throw unprocessable('each url must be a string');
    return validatedUrl(raw, allowHosts);
  });
}

/** Optional model-extraction schema: a natural-language prompt string, or a plain JSON-schema object coerced via JSON.stringify. */
export function parseExtractSchema(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const raw = body['schema'];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    if (raw.trim() === '') throw unprocessable('schema must be a non-empty string');
    return raw.trim();
  }
  if (isRecord(raw)) {
    if (Object.keys(raw).length === 0) throw unprocessable('schema must be a non-empty string');
    let coerced: string;
    try {
      coerced = JSON.stringify(raw);
    } catch {
      throw unprocessable('schema must be a non-empty string');
    }
    if (coerced.trim() === '') throw unprocessable('schema must be a non-empty string');
    return coerced.trim();
  }
  throw unprocessable('schema must be a non-empty string');
}

/**
 * Typed-schema object path (deterministic, zero model calls). Returns the raw
 * schema object when `body.schema` is a non-empty plain object, otherwise
 * undefined. String schemas (model path) yield undefined here. Throws 422 on
 * an empty object, mirroring parseExtractSchema.
 */
export function parseTypedSchema(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const raw = body['schema'];
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return undefined;
  if (isRecord(raw)) {
    if (Object.keys(raw).length === 0) throw unprocessable('schema must be a non-empty string');
    return raw;
  }
  throw unprocessable('schema must be a non-empty string');
}

/** Optional span list for grounding checks. Returns [] when absent. Throws 422 on a non-array. */
export function parseExtractSpans(body: unknown): Span[] {
  if (!isRecord(body)) return [];
  const raw = body['spans'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw unprocessable('spans must be an array');
  return raw as Span[];
}

/**
 * Deterministic projection: keep only the top-level structure fields named in
 * `schema.properties` (when it is an object). Without declared properties,
 * fall back to the scalar headline subset. Never calls a model.
 */
export function filterExtractedBySchema(
  structure: PageStructure,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const source = structure as unknown as Record<string, unknown>;
  const properties = schema['properties'];
  if (isRecord(properties)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      if (key in source) out[key] = source[key];
    }
    return out;
  }
  return { title: structure.title, description: structure.description, markdown: structure.markdown };
}

/**
 * Reject unsupported schema keywords upfront (422, thrown by the validator
 * itself regardless of the value). Value-level errors are discarded here —
 * the per-URL extracted check reports those.
 */
export function assertSupportedSchema(schema: Record<string, unknown>): void {
  validateAgainstSchema({}, schema);
}

/**
 * Validate one deterministic extracted object against its typed schema and
 * ground its spans. Throws 422 on schema violations or ungrounded spans.
 * Unsupported keywords propagate the validator's own 422.
 */
export function assertTypedExtractValid(
  extracted: Record<string, unknown>,
  schema: Record<string, unknown>,
  spans: readonly Span[],
  markdownPages: readonly string[],
): void {
  const schemaErrors = validateAgainstSchema(extracted, schema);
  if (schemaErrors.length > 0) {
    throw unprocessable(`extracted does not match schema: ${schemaErrors.join('; ')}`, schemaErrors);
  }
  if (spans.length === 0) return;
  const spanErrors = verifySpans(extracted, spans, markdownPages);
  if (spanErrors.length > 0) {
    throw unprocessable(`span not grounded: ${spanErrors.join('; ')}`, spanErrors);
  }
}
