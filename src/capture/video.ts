import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { newContext as baseNewContext, type ContextCookie, type ContextViewportOptions } from './browser.js';
import { CaptureError, VideoBusyError } from './errors.js';
import type { CaptureTimeouts } from './pipeline.js';
import { cookiesForUrl } from './pipeline.js';
import { DEFAULT_CAPTURE_TIMEOUT_CAP_MS, DEFAULT_CAPTURE_TIMEOUT_MS } from '../config.js';

/**
 * Requested container, kept for compatibility only. Playwright's recordVideo
 * always records WebM/VP8 (its bundled ffmpeg has no MP4 muxer and no H.264
 * encoder), so `mp4` is accepted as a legacy alias and both values yield
 * WebM bytes; the response mime tells that truth.
 */
export type VideoFormat = 'mp4' | 'webm';

/** The one mime every recording carries: Chromium screencast produces WebM/VP8. */
export type VideoMime = 'video/webm';

export type ScrollEasing = 'linear' | 'ease-in-out';

/** Hard ceiling for a scroll-capture recording (parse rejects anything above). */
export const VIDEO_MAX_DURATION_MS = 30_000;

export const VIDEO_DEFAULT_DURATION_MS = 5_000;

/** Prefix for per-capture video staging dirs under the OS tmp root. */
export const VIDEO_STAGING_PREFIX = 'webcap-video-';

/**
 * Pre-write ceiling for a staged recording (tmp-fill mitigation): a capture
 * whose staged file exceeds this rejects with CaptureError instead of
 * returning a giant buffer.
 */
export const VIDEO_STAGING_MAX_BYTES = 100_000_000;

/**
 * Orphan age cap for the startup sweep: staging dirs with mtime older than
 * this are treated as crash leftovers and reaped.
 */
export const VIDEO_STAGING_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

/**
 * Inline response ceiling for the recorded bytes (base64-in-JSON
 * mitigation): a capture whose recording exceeds this resolves with the
 * bytes DROPPED but metadata kept (empty buffer, original byte count, mime,
 * + note) instead of rejecting — inline-only, nothing is persisted here.
 * Stays under VIDEO_STAGING_MAX_BYTES (the tmp-fill guard, which still
 * rejects), so the drop path is reachable without risking tmp.
 */
export const VIDEO_INLINE_MAX_BYTES = 10_000_000;

/** Pixels scrolled per choreography step when the client sends no scrollSpeed. */
export const VIDEO_DEFAULT_SCROLL_SPEED = 800;

export const VIDEO_MAX_SCROLL_SPEED = 5_000;

/** Pause between scroll steps; the deadline math caps every wait at the remainder. */
export const VIDEO_SCROLL_STEP_MS = 250;

/**
 * Defense-in-depth step bound (240 x 250ms = 60s of instant waits): the hard
 * Date.now deadline always binds first when waits elapse in real time; this
 * caps the loop when waits resolve instantly (fakes, wedged timers).
 */
export const VIDEO_MAX_SCROLL_STEPS = 240;

/** Default cap on concurrent captureVideo recordings (VIDEO_MAX_CONCURRENT). */
export const VIDEO_MAX_CONCURRENT_DEFAULT = 2;

/**
 * Concurrent-recording cap: VIDEO_MAX_CONCURRENT when set to a positive int,
 * otherwise VIDEO_MAX_CONCURRENT_DEFAULT (fail-open on empty/junk).
 */
export function resolveVideoMaxConcurrent(raw: string | undefined = process.env.VIDEO_MAX_CONCURRENT): number {
  if (raw === undefined || raw.trim() === '') return VIDEO_MAX_CONCURRENT_DEFAULT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) return VIDEO_MAX_CONCURRENT_DEFAULT;
  return value;
}

let videoActiveCount = 0;

function tryAcquireVideoSlot(): boolean {
  if (videoActiveCount >= resolveVideoMaxConcurrent()) return false;
  videoActiveCount += 1;
  return true;
}

function releaseVideoSlot(): void {
  videoActiveCount = Math.max(0, videoActiveCount - 1);
}

/**
 * 502 sub-codes for the video failure taxonomy: every member stays instanceof
 * CaptureError, so the route keeps its 502 video_failed envelope — `code`
 * tells which path failed (timeout vs encode-fail vs missing-file).
 */
export type VideoFailureCode = 'video_timeout' | 'video_encode_failed' | 'video_missing_recording';

export class VideoCaptureError extends CaptureError {
  readonly code: VideoFailureCode;

  constructor(code: VideoFailureCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VideoCaptureError';
    this.code = code;
  }
}

/**
 * Every recording carries this mime regardless of the requested format: the
 * only artifacts captureVideo can produce are WebM/VP8. There is deliberately
 * no container map — an mp4/webm split would be a lie.
 */
export const VIDEO_MIME: VideoMime = 'video/webm';

export interface VideoCaptureRequest {
  readonly url: string;
  /** Requested container (compatibility field): recordings are always WebM/VP8. */
  readonly format: VideoFormat;
  readonly durationMs: number;
  readonly scrollSpeed?: number;
  readonly scrollEasing?: ScrollEasing;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly extraHTTPHeaders?: Record<string, string>;
  readonly cookies?: readonly ContextCookie[];
  readonly stealth?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
}

export interface VideoCaptureResult {
  readonly buffer: Buffer;
  readonly mime: VideoMime;
  readonly bytes: number;
  /** Present when the bytes were dropped by the inline cap: why, metadata kept. */
  readonly note?: string;
}

/** One scroll-choreography step (serializable: crosses page.evaluate). */
export interface ScrollStep {
  readonly pixels: number;
}

/**
 * Runs in the page context via page.evaluate, so it must stay self-contained
 * (no Node imports or outer closures): step down, wrap to top at the bottom.
 */
export function scrollPageBy(step: ScrollStep): void {
  window.scrollBy(0, step.pixels);
  const maxY = document.documentElement.scrollHeight - window.innerHeight;
  if (window.scrollY >= maxY) window.scrollTo(0, 0);
}

/** Narrow page contract the scroll choreography needs (real Page or a fake). */
export interface VideoPage {
  readonly goto: (url: string, options?: { readonly timeout?: number }) => Promise<void>;
  readonly evaluate: (fn: (step: ScrollStep) => void, step: ScrollStep) => Promise<void>;
  readonly waitForTimeout: (ms: number) => Promise<void>;
  readonly video: () => { readonly path: () => Promise<string> } | null;
  readonly close: () => Promise<void>;
}

/** Narrow context contract (real BrowserContext or a fake). */
export interface VideoContext {
  readonly newPage: () => Promise<VideoPage>;
  readonly close: () => Promise<void>;
}

export interface VideoContextOptions extends ContextViewportOptions {
  readonly recordVideo: { readonly dir: string };
}

export interface VideoCaptureDeps {
  readonly newContext?: (opts: VideoContextOptions) => Promise<VideoContext>;
}

/** Page-load timeout tuning + overall capture budget (mirrors pipeline.ts resolveTimeout). */
export type VideoTimeouts = CaptureTimeouts & { readonly overallMs?: number };

function resolveTimeout(timeouts?: VideoTimeouts): number {
  const requested = timeouts?.defaultMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  return Math.min(requested, timeouts?.capMs ?? DEFAULT_CAPTURE_TIMEOUT_CAP_MS);
}

function adaptPage(page: Page): VideoPage {
  return {
    goto: (url, options) =>
      page
        .goto(url, {
          ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
          waitUntil: 'load',
        })
        .then(() => undefined),
    evaluate: (fn, step) => page.evaluate(fn, step).then(() => undefined),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    video: () => {
      const recording = page.video();
      return recording === null ? null : { path: () => recording.path() };
    },
    close: () => page.close().then(() => undefined),
  };
}

function adaptContext(context: BrowserContext): VideoContext {
  return {
    newPage: async () => adaptPage(await context.newPage()),
    close: () => context.close(),
  };
}

async function defaultNewVideoContext(opts: VideoContextOptions): Promise<VideoContext> {
  return adaptContext(await baseNewContext(opts));
}

/**
 * Scroll choreography bounded by a hard deadline: at most
 * VIDEO_MAX_SCROLL_STEPS iterations and never past startedAt + durationMs
 * (capped at VIDEO_MAX_DURATION_MS). Every wait is capped at the remainder.
 */
async function runScrollChoreography(page: VideoPage, req: VideoCaptureRequest, timeouts?: VideoTimeouts): Promise<void> {
  const durationMs = Math.min(req.durationMs, VIDEO_MAX_DURATION_MS);
  const pixels = req.scrollSpeed ?? VIDEO_DEFAULT_SCROLL_SPEED;
  const deadline = Date.now() + durationMs;
  const overallDeadline = timeouts?.overallMs !== undefined ? Date.now() + timeouts.overallMs : undefined;
  let steps = 0;
  while (steps < VIDEO_MAX_SCROLL_STEPS && Date.now() < deadline) {
    if (overallDeadline !== undefined && Date.now() >= overallDeadline) {
      throw new VideoCaptureError(
        'video_timeout',
        `video capture exceeded overall budget (${timeouts?.overallMs}ms) for ${req.url}`,
      );
    }
    await page.evaluate(scrollPageBy, { pixels });
    steps += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (overallDeadline !== undefined) {
      const overallRemaining = overallDeadline - Date.now();
      if (overallRemaining <= 0) {
        throw new VideoCaptureError(
          'video_timeout',
          `video capture exceeded overall budget (${timeouts?.overallMs}ms) for ${req.url}`,
        );
      }
      await page.waitForTimeout(Math.min(VIDEO_SCROLL_STEP_MS, remaining, overallRemaining));
    } else {
      await page.waitForTimeout(Math.min(VIDEO_SCROLL_STEP_MS, remaining));
    }
  }
}

async function findStagedVideo(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const videos = entries.filter((entry) => entry.endsWith('.webm')).sort();
  const first = videos[0] ?? [...entries].sort()[0];
  return first === undefined ? undefined : join(dir, first);
}

/**
 * Best-effort startup sweep for orphaned video staging dirs. Removes
 * `webcap-video-*` entries under `root` whose mtime exceeds `maxAgeMs`,
 * keeps fresh and non-matching entries, and returns the reaped count.
 * Never throws: unreadable roots or per-entry failures resolve to a skip,
 * so boot stays up even with a hostile tmp.
 */
export async function reapStaleVideoStaging(
  root: string = tmpdir(),
  maxAgeMs: number = VIDEO_STAGING_MAX_AGE_MS,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.startsWith(VIDEO_STAGING_PREFIX)) continue;
    const full = join(root, entry);
    try {
      const st = await stat(full);
      if (!st.isDirectory() || st.mtimeMs > cutoff) continue;
      await rm(full, { recursive: true, force: true });
      reaped += 1;
    } catch {
      continue;
    }
  }
  return reaped;
}

async function recordToBuffer(
  req: VideoCaptureRequest,
  factory: (opts: VideoContextOptions) => Promise<VideoContext>,
  stagingDir: string,
  timeouts?: VideoTimeouts,
): Promise<VideoCaptureResult> {
  const viewportOpts: ContextViewportOptions = {
    ...(req.viewport !== undefined ? { viewport: req.viewport } : {}),
    ...(req.extraHTTPHeaders !== undefined ? { extraHTTPHeaders: req.extraHTTPHeaders } : {}),
    ...(req.cookies !== undefined ? { cookies: cookiesForUrl(req.cookies, req.url) } : {}),
    ...(req.stealth === true ? { stealth: true as const } : {}),
    ...(req.locale !== undefined ? { locale: req.locale } : {}),
    ...(req.timezoneId !== undefined ? { timezoneId: req.timezoneId } : {}),
  };
  const context = await factory({ ...viewportOpts, recordVideo: { dir: stagingDir } });
  let videoPath: string | undefined;
  try {
    const page = await context.newPage();
    try {
      await page.goto(req.url, { timeout: resolveTimeout(timeouts) });
      await runScrollChoreography(page, req, timeouts);
      const recording = page.video();
      if (recording !== null) {
        try {
          videoPath = await recording.path();
        } catch (err) {
          throw new VideoCaptureError('video_encode_failed', `video capture encode failed for ${req.url}`, {
            cause: err,
          });
        }
      }
    } finally {
      await page.close();
    }
  } finally {
    // Context close finalizes the recording file before it is read below.
    await context.close();
  }
  videoPath ??= await findStagedVideo(stagingDir);
  if (videoPath === undefined) {
    throw new VideoCaptureError('video_missing_recording', `video capture produced no recording for ${req.url}`);
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(videoPath);
  } catch (err) {
    throw new VideoCaptureError('video_encode_failed', `video capture encode failed for ${req.url}`, { cause: err });
  }
  if (buffer.length > VIDEO_STAGING_MAX_BYTES) {
    throw new CaptureError(
      `video staging oversize (${buffer.length} bytes exceeds ${VIDEO_STAGING_MAX_BYTES} cap) for ${req.url}`,
    );
  }
  if (buffer.length > VIDEO_INLINE_MAX_BYTES) {
    return {
      buffer: Buffer.alloc(0),
      mime: VIDEO_MIME,
      bytes: buffer.length,
      note: `video inline oversize (${buffer.length} bytes exceeds ${VIDEO_INLINE_MAX_BYTES} inline cap) for ${req.url}: bytes dropped, metadata kept`,
    };
  }
  return { buffer, mime: VIDEO_MIME, bytes: buffer.length };
}

/**
 * Scroll-capture a URL to an in-memory video: fresh staging dir under the OS
 * tmp root, Playwright recordVideo context, deadline-bounded scroll
 * choreography, then close (finalizes the file) -> guard -> read -> Buffer.
 * Persistence stays with the route wiring (existing storeArtifact); this
 * returns the artifact-ready result. recordVideo only — no transcoding
 * pipeline, so the artifact is always WebM/VP8.
 *
 * Orphan mitigation: the happy path removes the staging dir in `finally`,
 * but a SIGKILL/crash between mkdtemp and cleanup leaves `webcap-video-*`
 * dirs behind — call reapStaleVideoStaging() once at boot to sweep them.
 * The VIDEO_STAGING_MAX_BYTES guard bounds each capture so a runaway
 * recording fails fast instead of filling tmp.
 *
 * NOTE(encode-cost): recordVideo relies on Chromium software encoding — no
 * GPU in server containers, so sustained capture is CPU-bound. That cost is
 * why video is priced 5x capture and capped at VIDEO_MAX_CONCURRENT_DEFAULT
 * concurrent recordings; no transcoding pipeline exists by design.
 */
export async function captureVideo(
  req: VideoCaptureRequest,
  deps?: VideoCaptureDeps,
  timeouts?: VideoTimeouts,
): Promise<VideoCaptureResult> {
  // Fail-fast global semaphore: at most resolveVideoMaxConcurrent()
  // recordings at once; the overflow rejects with 429 video_busy instead of
  // queueing (no head-of-line blocking, FIFO trivially holds with no
  // waiters). The permit releases in `finally`, so success and failure paths
  // alike cannot leak a slot. Acquired before mkdtemp so a rejection leaves
  // no staging dir behind.
  const maxConcurrent = resolveVideoMaxConcurrent();
  if (!tryAcquireVideoSlot()) {
    throw new VideoBusyError(
      `video capture busy (${maxConcurrent} concurrent captures in use) for ${req.url}`,
    );
  }
  try {
    const factory = deps?.newContext ?? defaultNewVideoContext;
    const stagingDir = await mkdtemp(join(tmpdir(), 'webcap-video-'));
    try {
      return await recordToBuffer(req, factory, stagingDir, timeouts);
    } catch (err) {
      if (err instanceof VideoCaptureError) throw err;
      if (err instanceof CaptureError) throw err;
      if (isTimeoutLike(err)) {
        throw new VideoCaptureError(
          'video_timeout',
          `video capture timed out for ${req.url}: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      throw new VideoCaptureError(
        'video_encode_failed',
        `video capture failed for ${req.url}: ${errorMessage(err)}`,
        { cause: err },
      );
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  } finally {
    releaseVideoSlot();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutLike(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && (err as { readonly name?: unknown }).name === 'TimeoutError') {
    return true;
  }
  return /timeout|timed out|overall|budget|exceed/i.test(errorMessage(err));
}
