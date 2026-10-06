import { isRecord, parseOptions, validatedUrl } from './capture-parse.js';
import { unprocessable } from '../util/errors.js';
import type { ContextCookie } from '../capture/browser.js';
import {
  VIDEO_DEFAULT_DURATION_MS,
  VIDEO_DEFAULT_SCROLL_SPEED,
  VIDEO_MAX_DURATION_MS,
  VIDEO_MAX_SCROLL_SPEED,
  type ScrollEasing,
  type VideoFormat,
} from '../capture/video.js';

export type { ScrollEasing, VideoFormat };

export interface VideoRequest {
  readonly url: string;
  readonly format: VideoFormat;
  readonly durationMs: number;
  readonly scrollSpeed: number;
  readonly scrollEasing: ScrollEasing;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly extraHTTPHeaders?: Record<string, string>;
  readonly cookies?: readonly ContextCookie[];
  readonly stealth?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
}

const DEFAULT_VIDEO_FORMAT: VideoFormat = 'webm';

const DEFAULT_SCROLL_EASING: ScrollEasing = 'linear';

/**
 * Accepts both format values for compatibility. `mp4` is a legacy alias: the
 * capture always produces WebM/VP8, and the response mime says so.
 */
function parseVideoFormat(raw: unknown): VideoFormat {
  if (raw === undefined) return DEFAULT_VIDEO_FORMAT;
  if (raw === 'mp4' || raw === 'webm') return raw;
  throw unprocessable(`unsupported video format: ${String(raw)}`);
}

function parseDurationMs(raw: unknown): number {
  if (raw === undefined) return VIDEO_DEFAULT_DURATION_MS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw unprocessable('durationMs must be a positive integer');
  }
  if (raw > VIDEO_MAX_DURATION_MS) {
    throw unprocessable(`durationMs must not exceed ${VIDEO_MAX_DURATION_MS}`);
  }
  return raw;
}

function parseScrollSpeed(raw: unknown): number {
  if (raw === undefined) return VIDEO_DEFAULT_SCROLL_SPEED;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw unprocessable('scrollSpeed must be a positive integer');
  }
  return Math.min(raw, VIDEO_MAX_SCROLL_SPEED);
}

function parseScrollEasing(raw: unknown): ScrollEasing {
  if (raw === undefined) return DEFAULT_SCROLL_EASING;
  if (raw === 'linear' || raw === 'ease-in-out') return raw;
  throw unprocessable('scrollEasing must be one of linear, ease-in-out');
}

export function parseVideoRequest(body: unknown, allowHosts: readonly string[] | undefined): VideoRequest {
  if (!isRecord(body)) throw unprocessable('body must be an object');
  const rawUrl = body.url;
  if (typeof rawUrl !== 'string') throw unprocessable('url is required');
  const url = validatedUrl(rawUrl, allowHosts);
  const format = parseVideoFormat(body.format);
  const durationMs = parseDurationMs(body.durationMs);
  const scrollSpeed = parseScrollSpeed(body.scrollSpeed);
  const scrollEasing = parseScrollEasing(body.scrollEasing);
  const parsed = parseOptions(body);
  return {
    url,
    format,
    durationMs,
    scrollSpeed,
    scrollEasing,
    ...(parsed?.viewport !== undefined ? { viewport: parsed.viewport } : {}),
    ...(parsed?.extraHTTPHeaders !== undefined ? { extraHTTPHeaders: parsed.extraHTTPHeaders } : {}),
    ...(parsed?.cookies !== undefined ? { cookies: parsed.cookies } : {}),
    ...(parsed?.stealth !== undefined ? { stealth: parsed.stealth } : {}),
    ...(parsed?.locale !== undefined ? { locale: parsed.locale } : {}),
    ...(parsed?.timezoneId !== undefined ? { timezoneId: parsed.timezoneId } : {}),
  };
}
