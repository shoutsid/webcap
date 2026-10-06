import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CaptureError } from '../../src/capture/errors.js';
import * as videoModule from '../../src/capture/video.js';
import {
  VIDEO_STAGING_MAX_BYTES,
  captureVideo,
  type ScrollStep,
  type VideoContext,
  type VideoContextOptions,
} from '../../src/capture/video.js';

/**
 * RED suite for video error taxonomy + inline size cap (V-S3).
 *
 * 1. Taxonomy: timeout vs encode-fail vs missing-file reject with THREE
 *    distinct 502 sub-codes (err.code differs; every one stays instanceof
 *    CaptureError so the route keeps its 502 video_failed envelope).
 * 2. Inline size cap: a recording over VIDEO_INLINE_MAX_BYTES resolves with
 *    bytes DROPPED but metadata kept (empty buffer, original bytes count,
 *    mime, + note) — inline-only, no persist-to-DB change.
 * 3. Software-encode cost note: video.ts documents the CPU cost (comment/doc,
 *    no GPU work).
 *
 * New symbols are reached through namespace casts (V-S2b RED pattern) so
 * this file stays tsc-clean before the GREEN change lands; every assertion
 * FAILS against the current src/capture/video.ts at runtime.
 */

type VideoModuleWithTaxonomy = typeof videoModule & {
  readonly VIDEO_INLINE_MAX_BYTES?: unknown;
};

const taxonomy = videoModule as unknown as VideoModuleWithTaxonomy;

function codeOf(err: unknown): unknown {
  return (err as { readonly code?: unknown }).code;
}

function noteOf(result: unknown): unknown {
  return (result as { readonly note?: unknown }).note;
}

async function stageVideoFile(tag: string, size: number): Promise<{ readonly dir: string; readonly videoPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), `video-taxonomy-red-${tag}-`));
  const videoPath = join(dir, 'video.webm');
  await writeFile(videoPath, Buffer.alloc(size, 1));
  return { dir, videoPath };
}

function makeImmediateFakes(videoPath: string | null): {
  readonly newContext: (opts: VideoContextOptions) => Promise<VideoContext>;
} {
  const newContext = async (_opts: VideoContextOptions): Promise<VideoContext> => ({
    newPage: async () => ({
      goto: async (): Promise<void> => {},
      evaluate: async (_fn: (step: ScrollStep) => void, _step: ScrollStep): Promise<void> => {},
      waitForTimeout: async (_ms: number): Promise<void> => {},
      video: (): { readonly path: () => Promise<string> } | null =>
        videoPath === null ? null : { path: async () => videoPath },
      close: async (): Promise<void> => {},
    }),
    close: async (): Promise<void> => {},
  });
  return { newContext };
}

function makeEncodeFailingFakes(): {
  readonly newContext: (opts: VideoContextOptions) => Promise<VideoContext>;
} {
  const newContext = async (_opts: VideoContextOptions): Promise<VideoContext> => ({
    newPage: async () => ({
      goto: async (): Promise<void> => {},
      evaluate: async (_fn: (step: ScrollStep) => void, _step: ScrollStep): Promise<void> => {},
      waitForTimeout: async (_ms: number): Promise<void> => {},
      video: (): { readonly path: () => Promise<string> } | null => ({
        path: async () => {
          throw new Error('ffmpeg: failed to finalize recording (encode failed)');
        },
      }),
      close: async (): Promise<void> => {},
    }),
    close: async (): Promise<void> => {},
  });
  return { newContext };
}

function makeOverallBudgetFakes(): {
  readonly newContext: (opts: VideoContextOptions) => Promise<VideoContext>;
} {
  const newContext = async (_opts: VideoContextOptions): Promise<VideoContext> => ({
    newPage: async () => ({
      goto: async (): Promise<void> => {},
      evaluate: async (_fn: (step: ScrollStep) => void, _step: ScrollStep): Promise<void> => {},
      waitForTimeout: async (ms: number): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
      video: (): { readonly path: () => Promise<string> } | null => null,
      close: async (): Promise<void> => {},
    }),
    close: async (): Promise<void> => {},
  });
  return { newContext };
}

async function rejectWith(
  promise: Promise<unknown>,
): Promise<{ readonly settled: 'resolved' } | { readonly settled: 'rejected'; readonly err: unknown }> {
  return promise.then(
    () => ({ settled: 'resolved' as const }),
    (err: unknown) => ({ settled: 'rejected' as const, err }),
  );
}

describe('video V-S3 inline size cap (RED)', () => {
  it('exposes a positive inline byte cap at or under the staging cap', () => {
    // RED: VIDEO_INLINE_MAX_BYTES does not exist yet (undefined is not a number).
    expect(typeof taxonomy.VIDEO_INLINE_MAX_BYTES).toBe('number');
    if (typeof taxonomy.VIDEO_INLINE_MAX_BYTES === 'number') {
      expect(taxonomy.VIDEO_INLINE_MAX_BYTES).toBeGreaterThan(0);
      expect(taxonomy.VIDEO_INLINE_MAX_BYTES).toBeLessThanOrEqual(VIDEO_STAGING_MAX_BYTES);
    }
  });

  it('drops oversize bytes but keeps metadata + note (inline-only)', async () => {
    const cap = taxonomy.VIDEO_INLINE_MAX_BYTES;
    // RED: no inline cap exists, so this gate fails before any capture runs.
    expect(typeof cap).toBe('number');
    if (typeof cap !== 'number') return;
    const { dir, videoPath } = await stageVideoFile('inline-drop', cap + 1);
    try {
      const fakes = makeImmediateFakes(videoPath);
      const result = await captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300 },
        { newContext: fakes.newContext },
      );
      // RED: no inline cap exists, so the full buffer resolves (no drop, no note).
      expect(result.buffer).toHaveLength(0);
      expect(result.bytes).toBe(cap + 1);
      expect(result.mime).toBe('video/webm');
      expect(String(noteOf(result))).toMatch(/drop|oversize|inline/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('video V-S3 error taxonomy (RED)', () => {
  it('timeout rejects with the timeout sub-code inside the 502 envelope', async () => {
    const fakes = makeOverallBudgetFakes();
    const outcome = await rejectWith(
      (
        captureVideo as unknown as (
          req: Parameters<typeof captureVideo>[0],
          deps?: Parameters<typeof captureVideo>[1],
          timeouts?: { readonly defaultMs?: number; readonly capMs?: number; readonly overallMs?: number },
        ) => ReturnType<typeof captureVideo>
      )(
        { url: 'https://example.com/', format: 'mp4', durationMs: 1200 },
        { newContext: fakes.newContext },
        { defaultMs: 30_000, capMs: 60_000, overallMs: 50 },
      ),
    );
    // RED: the overall-budget CaptureError carries no sub-code.
    expect(outcome.settled).toBe('rejected');
    if (outcome.settled === 'rejected') {
      expect(outcome.err).toBeInstanceOf(CaptureError);
      expect(codeOf(outcome.err)).toBe('video_timeout');
    }
  });

  it('encode failure rejects with the encode-failed sub-code inside the 502 envelope', async () => {
    const fakes = makeEncodeFailingFakes();
    const outcome = await rejectWith(
      captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300 },
        { newContext: fakes.newContext },
      ),
    );
    // RED: the wrapped failure is a codeless generic CaptureError.
    expect(outcome.settled).toBe('rejected');
    if (outcome.settled === 'rejected') {
      expect(outcome.err).toBeInstanceOf(CaptureError);
      expect(codeOf(outcome.err)).toBe('video_encode_failed');
    }
  });

  it('missing recording rejects with the missing-file sub-code inside the 502 envelope', async () => {
    const fakes = makeImmediateFakes(null);
    const outcome = await rejectWith(
      captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300 },
        { newContext: fakes.newContext },
      ),
    );
    // RED: the missing-recording CaptureError carries no sub-code.
    expect(outcome.settled).toBe('rejected');
    if (outcome.settled === 'rejected') {
      expect(outcome.err).toBeInstanceOf(CaptureError);
      expect(codeOf(outcome.err)).toBe('video_missing_recording');
    }
  });

  it('the three sub-codes are pairwise distinct', async () => {
    const timeoutOutcome = await rejectWith(
      (
        captureVideo as unknown as (
          req: Parameters<typeof captureVideo>[0],
          deps?: Parameters<typeof captureVideo>[1],
          timeouts?: { readonly defaultMs?: number; readonly capMs?: number; readonly overallMs?: number },
        ) => ReturnType<typeof captureVideo>
      )(
        { url: 'https://example.com/', format: 'mp4', durationMs: 1200 },
        { newContext: makeOverallBudgetFakes().newContext },
        { defaultMs: 30_000, capMs: 60_000, overallMs: 50 },
      ),
    );
    const encodeOutcome = await rejectWith(
      captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300 },
        { newContext: makeEncodeFailingFakes().newContext },
      ),
    );
    const missingOutcome = await rejectWith(
      captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300 },
        { newContext: makeImmediateFakes(null).newContext },
      ),
    );
    expect(timeoutOutcome.settled).toBe('rejected');
    expect(encodeOutcome.settled).toBe('rejected');
    expect(missingOutcome.settled).toBe('rejected');
    if (
      timeoutOutcome.settled === 'rejected' &&
      encodeOutcome.settled === 'rejected' &&
      missingOutcome.settled === 'rejected'
    ) {
      const codes = new Set([codeOf(timeoutOutcome.err), codeOf(encodeOutcome.err), codeOf(missingOutcome.err)]);
      // RED: all three carry undefined (one value, not three).
      expect(codes.size).toBe(3);
    }
  });
});

describe('video V-S3 software-encode cost note (RED)', () => {
  it('documents the software-encode CPU cost in video.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const videoSrc = readFileSync(join(here, '../../src/capture/video.ts'), 'utf8');
    // RED: no software-encode/CPU-cost note exists yet.
    expect(videoSrc).toMatch(/software.+encod|encod.+software|cpu.+cost|cost.+cpu/i);
  });
});
