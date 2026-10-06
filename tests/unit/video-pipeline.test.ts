import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CaptureError } from '../../src/capture/errors.js';
import {
  VIDEO_MAX_SCROLL_STEPS,
  VIDEO_SCROLL_STEP_MS,
  captureVideo,
  type ScrollStep,
  type VideoContext,
  type VideoContextOptions,
} from '../../src/capture/video.js';

interface Fakes {
  readonly newContext: (opts: VideoContextOptions) => Promise<VideoContext>;
  readonly contextOpts: VideoContextOptions[];
  readonly dirExistedAtCall: boolean[];
  readonly evaluatePixels: number[];
  readonly waitedMs: number[];
}

function makeFakes(videoPath: string | null, wait: 'immediate' | 'real'): Fakes {
  const contextOpts: VideoContextOptions[] = [];
  const dirExistedAtCall: boolean[] = [];
  const evaluatePixels: number[] = [];
  const waitedMs: number[] = [];
  const newContext = async (opts: VideoContextOptions): Promise<VideoContext> => {
    contextOpts.push(opts);
    dirExistedAtCall.push(existsSync(opts.recordVideo.dir));
    return {
      newPage: async () => ({
        goto: async (): Promise<void> => {},
        evaluate: async (_fn: (step: ScrollStep) => void, step: ScrollStep): Promise<void> => {
          evaluatePixels.push(step.pixels);
        },
        waitForTimeout:
          wait === 'real'
            ? async (ms: number): Promise<void> => {
                waitedMs.push(ms);
                await new Promise((resolve) => setTimeout(resolve, ms));
              }
            : async (ms: number): Promise<void> => {
                waitedMs.push(ms);
              },
        video: (): { readonly path: () => Promise<string> } | null =>
          videoPath === null ? null : { path: async () => videoPath },
        close: async (): Promise<void> => {},
      }),
      close: async (): Promise<void> => {},
    };
  };
  return { newContext, contextOpts, dirExistedAtCall, evaluatePixels, waitedMs };
}

describe('capture/video recordVideo pipeline', () => {
  it('passes a recordVideo staging dir to newContext and returns buffer+mime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    await writeFile(videoPath, bytes);
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      const result = await captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300, scrollSpeed: 600 },
        { newContext: fakes.newContext },
      );
      expect(fakes.contextOpts).toHaveLength(1);
      const stagingDir = fakes.contextOpts[0]?.recordVideo.dir ?? '';
      expect(stagingDir).toContain('webcap-video-');
      expect(stagingDir.startsWith(tmpdir())).toBe(true);
      expect(fakes.dirExistedAtCall).toEqual([true]);
      expect(result.buffer.equals(bytes)).toBe(true);
      // The mp4 alias is accepted, but recordVideo only produces WebM/VP8.
      expect(result.mime).toBe('video/webm');
      expect(result.bytes).toBe(bytes.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports video/webm for the webm format too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([9, 9, 9]));
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      const result = await captureVideo(
        { url: 'https://example.com/', format: 'webm', durationMs: 300, scrollSpeed: 600 },
        { newContext: fakes.newContext },
      );
      expect(result.mime).toBe('video/webm');
      expect(result.bytes).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes the requested viewport through to newContext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([1]));
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      await captureVideo(
        {
          url: 'https://example.com/',
          format: 'mp4',
          durationMs: 300,
          scrollSpeed: 600,
          viewport: { width: 1280, height: 800 },
        },
        { newContext: fakes.newContext },
      );
      expect(fakes.contextOpts[0]?.viewport).toEqual({ width: 1280, height: 800 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes session auth, stealth and locale through to newContext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([1]));
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      await captureVideo(
        {
          url: 'https://example.com/page',
          format: 'mp4',
          durationMs: 300,
          scrollSpeed: 600,
          extraHTTPHeaders: { authorization: 'Bearer s3cr3t' },
          cookies: [{ name: 'sid', value: 'abc', url: 'https://example.com/page' }],
          stealth: true,
          locale: 'de-DE',
          timezoneId: 'Europe/Berlin',
        },
        { newContext: fakes.newContext },
      );
      expect(fakes.contextOpts[0]).toMatchObject({
        extraHTTPHeaders: { authorization: 'Bearer s3cr3t' },
        cookies: [{ name: 'sid', value: 'abc', url: 'https://example.com/page' }],
        stealth: true,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drives scroll steps with the requested speed pixels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([1]));
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      await captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300, scrollSpeed: 450 },
        { newContext: fakes.newContext },
      );
      expect(fakes.evaluatePixels.length).toBeGreaterThan(0);
      for (const pixels of fakes.evaluatePixels) expect(pixels).toBe(450);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds the scroll choreography by the hard duration deadline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([1]));
    try {
      const fakes = makeFakes(videoPath, 'real');
      await captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300, scrollSpeed: 600 },
        { newContext: fakes.newContext },
      );
      expect(fakes.evaluatePixels.length).toBeGreaterThan(0);
      expect(fakes.evaluatePixels.length).toBeLessThanOrEqual(4);
      for (const ms of fakes.waitedMs) expect(ms).toBeLessThanOrEqual(VIDEO_SCROLL_STEP_MS);
      // The deadline bounds wall-clock; each wait is capped at the remainder.
      // setTimeout can resolve a hair early, so the sum of *requested* waits
      // may exceed the deadline by timer granularity even though elapsed time
      // stays inside it. Allow that slop; a loop that failed to stop would
      // overshoot by whole VIDEO_SCROLL_STEP_MS steps.
      const totalWaited = fakes.waitedMs.reduce((sum, ms) => sum + ms, 0);
      expect(totalWaited).toBeLessThanOrEqual(300 + 25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caps a max-duration capture at the scroll-step bound instead of looping', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-pipeline-expect-'));
    const videoPath = join(dir, 'video.webm');
    await writeFile(videoPath, Buffer.from([1]));
    try {
      const fakes = makeFakes(videoPath, 'immediate');
      const result = await captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 30_000, scrollSpeed: 600 },
        { newContext: fakes.newContext },
      );
      expect(fakes.evaluatePixels).toHaveLength(VIDEO_MAX_SCROLL_STEPS);
      expect(result.mime).toBe('video/webm');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws CaptureError when the staged recording is missing', async () => {
    const fakes = makeFakes(null, 'immediate');
    await expect(
      captureVideo(
        { url: 'https://example.com/', format: 'mp4', durationMs: 300, scrollSpeed: 600 },
        { newContext: fakes.newContext },
      ),
    ).rejects.toBeInstanceOf(CaptureError);
  });
});
