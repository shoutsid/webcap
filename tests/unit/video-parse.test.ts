import { describe, expect, it } from 'vitest';
import { parseVideoRequest } from '../../src/server/video-parse.js';
import { HttpError } from '../../src/util/errors.js';

function expectVideoUnprocessable(body: unknown, fragment: string): void {
  try {
    parseVideoRequest(body, undefined);
    expect.unreachable('expected parseVideoRequest to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    if (err instanceof HttpError) {
      expect(err.status).toBe(422);
      expect(err.message).toContain(fragment);
    }
  }
}

describe('server/video-parse A-S1 valid scroll-capture options', () => {
  it('passes through full scroll opts (webm, duration, speed, easing, viewport)', () => {
    expect(
      parseVideoRequest(
        {
          url: 'https://example.com/page',
          format: 'webm',
          durationMs: 8000,
          scrollSpeed: 500,
          scrollEasing: 'ease-in-out',
          options: { viewport: { width: 1280, height: 800 } },
        },
        undefined,
      ),
    ).toEqual({
      url: 'https://example.com/page',
      format: 'webm',
      durationMs: 8000,
      scrollSpeed: 500,
      scrollEasing: 'ease-in-out',
      viewport: { width: 1280, height: 800 },
    });
  });

  it('applies defaults (webm, 5000ms, scrollSpeed 800, linear) when fields are omitted', () => {
    expect(parseVideoRequest({ url: 'https://example.com/' }, undefined)).toEqual({
      url: 'https://example.com/',
      format: 'webm',
      durationMs: 5000,
      scrollSpeed: 800,
      scrollEasing: 'linear',
    });
  });

  it('accepts the mp4 legacy alias explicitly and both easings of the subset', () => {
    // mp4 is kept as an accepted alias; the recording it produces is still WebM.
    expect(parseVideoRequest({ url: 'https://example.com/', format: 'mp4' }, undefined).format).toBe('mp4');
    expect(parseVideoRequest({ url: 'https://example.com/', scrollEasing: 'linear' }, undefined).scrollEasing).toBe(
      'linear',
    );
    expect(
      parseVideoRequest({ url: 'https://example.com/', scrollEasing: 'ease-in-out' }, undefined).scrollEasing,
    ).toBe('ease-in-out');
  });

  it('reuses the capture viewport clamp (width below 320 clamps up)', () => {
    expect(
      parseVideoRequest({ url: 'https://example.com/', options: { viewport: { width: 100, height: 800 } } }, undefined)
        .viewport,
    ).toEqual({ width: 320, height: 800 });
  });

  it('clamps scrollSpeed above the max down to the max', () => {
    expect(parseVideoRequest({ url: 'https://example.com/', scrollSpeed: 999_999 }, undefined).scrollSpeed).toBe(5000);
  });
});

describe('server/video-parse A-S2 invalid scroll-capture options', () => {
  it('rejects durationMs above 30s with 422', () => {
    expectVideoUnprocessable({ url: 'https://example.com/', durationMs: 30_001 }, 'durationMs');
    expectVideoUnprocessable({ url: 'https://example.com/', durationMs: 120_000 }, 'durationMs');
  });

  it.each([[0], [-1], [2.5], ['5000'], [null]])('rejects durationMs %o with 422', (durationMs) => {
    expectVideoUnprocessable({ url: 'https://example.com/', durationMs }, 'durationMs');
  });

  it.each([[0], [-10], [2.5], ['fast'], [null]])('rejects scrollSpeed %o with 422', (scrollSpeed) => {
    expectVideoUnprocessable({ url: 'https://example.com/', scrollSpeed }, 'scrollSpeed');
  });

  it.each([['bounce'], ['smooth'], [''], [42], [null]])('rejects scrollEasing %o with 422', (scrollEasing) => {
    expectVideoUnprocessable({ url: 'https://example.com/', scrollEasing }, 'scrollEasing');
  });

  it.each([['avi'], ['gif'], ['mov'], [42], ['']])('rejects format %o with 422', (format) => {
    expectVideoUnprocessable({ url: 'https://example.com/', format }, 'format');
  });

  it('rejects an SSRF-private url with 422', () => {
    expectVideoUnprocessable({ url: 'http://localhost:3000/x' }, 'url');
    expectVideoUnprocessable({ url: 'http://127.0.0.1/' }, 'url');
  });

  it.each([[undefined], [42], [null], [[]]])('rejects missing/non-string url %o with 422', (url) => {
    expectVideoUnprocessable({ url }, 'url');
  });

  it('rejects a non-object body with 422', () => {
    expectVideoUnprocessable('https://example.com/', 'object');
    expectVideoUnprocessable(null, 'object');
    expectVideoUnprocessable([], 'object');
  });
});

describe('server/video-parse session + locale options', () => {
  it('passes through auth, stealth, locale and timezoneId from options', () => {
    expect(
      parseVideoRequest(
        {
          url: 'https://example.com/page',
          options: {
            auth: {
              headers: { authorization: 'Bearer s3cr3t' },
              cookies: [{ name: 'sid', value: 'abc' }],
            },
            stealth: true,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
          },
        },
        undefined,
      ),
    ).toEqual({
      url: 'https://example.com/page',
      format: 'webm',
      durationMs: 5000,
      scrollSpeed: 800,
      scrollEasing: 'linear',
      extraHTTPHeaders: { authorization: 'Bearer s3cr3t' },
      cookies: [{ name: 'sid', value: 'abc' }],
      stealth: true,
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });
  });

  it('rejects a disallowed auth header with 422', () => {
    expectVideoUnprocessable(
      { url: 'https://example.com/', options: { auth: { headers: { 'x-evil': '1' } } } },
      'header',
    );
  });
});
