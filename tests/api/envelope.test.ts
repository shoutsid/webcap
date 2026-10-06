import { describe, expect, it } from 'vitest';
import { closeApiFixture, errorEnvelope, makeApiFixture, type ApiFixture } from './fixture.js';

async function withApp(fn: (fx: ApiFixture) => Promise<void>): Promise<void> {
  const fx = makeApiFixture();
  try {
    await fn(fx);
  } finally {
    await closeApiFixture(fx);
  }
}

describe('error envelope for route-not-found and method-not-allowed', () => {
  it('returns the not_found envelope for an unknown route (GET /nope)', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'GET', url: '/nope' });
      expect(res.statusCode).toBe(404);
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('not_found');
      expect(envelope.message).toBe('route not found');
    });
  });

  it('returns 405 with an Allow header and the method_not_allowed envelope for a wrong method (DELETE /v1/health)', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'DELETE', url: '/v1/health' });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD');
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('method_not_allowed');
      expect(envelope.message).toBe('method not allowed');
    });
  });

  it('returns 405 (not a body-parse 400) when the wrong-method request carries a JSON content-type', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({
        method: 'DELETE',
        url: '/v1/health',
        payload: '',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD');
      expect(errorEnvelope(res).code).toBe('method_not_allowed');
    });
  });

  it('lists every valid method for a parameterized path in Allow (POST /v1/watches/:id)', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/watches/abc123', payload: {} });
      expect(res.statusCode).toBe(405);
      expect(res.headers['allow']).toBe('GET, HEAD, DELETE');
      expect(errorEnvelope(res).code).toBe('method_not_allowed');
    });
  });

  it('returns the not_found envelope (not a body-parse 400) for an unknown path with a JSON content-type', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({
        method: 'DELETE',
        url: '/nope',
        payload: '',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
      expect(errorEnvelope(res).code).toBe('not_found');
    });
  });

  it('keeps the 401 unauthorized envelope for a capture without an API key', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/capture',
        payload: { url: 'https://example.com/' },
      });
      expect(res.statusCode).toBe(401);
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('unauthorized');
      expect(envelope.message).toBe('missing bearer token');
    });
  });

  it('points a keyless 401 at POST /v1/register with an example body', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/extract',
        payload: { url: 'https://example.com/' },
      });
      expect(res.statusCode).toBe(401);
      const detail = errorEnvelope(res).detail ?? {};
      expect(detail['register']).toBe('POST /v1/register');
      expect(detail['example']).toEqual({ address: '0xYourWalletAddress' });
      expect(typeof detail['guide']).toBe('string');
    });
  });

  it('points a bad-key 401 at POST /v1/register instead of dead-ending', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/extract',
        payload: { url: 'https://example.com/' },
        headers: { authorization: 'Bearer deadbeef' },
      });
      expect(res.statusCode).toBe(401);
      const envelope = errorEnvelope(res);
      expect(envelope.message).toBe('invalid api key');
      expect((envelope.detail ?? {})['register']).toBe('POST /v1/register');
    });
  });

  it('shows a register example on a shapeless POST /v1/register 422', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: {} });
      expect(res.statusCode).toBe(422);
      const envelope = errorEnvelope(res);
      expect(envelope.message).toBe('address is required');
      const detail = envelope.detail ?? {};
      expect(detail['example']).toEqual({ address: '0xYourWalletAddress' });
      expect(typeof detail['guide']).toBe('string');
    });
  });

  it('shows a register example on a malformed-address POST /v1/register 422', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: 'nope' } });
      expect(res.statusCode).toBe(422);
      expect(errorEnvelope(res).message).toBe('invalid address');
      expect((errorEnvelope(res).detail ?? {})['example']).toEqual({ address: '0xYourWalletAddress' });
    });
  });

  it('keeps the 400 bad_request envelope for a malformed watch body', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/watches', payload: {} });
      expect(res.statusCode).toBe(400);
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('bad_request');
      expect(envelope.message).toBe('url is required');
    });
  });

  it('shows a valid watch example on a malformed watch body 400', async () => {
    await withApp(async (fx) => {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/watches', payload: { every: 'never' } });
      expect(res.statusCode).toBe(400);
      const detail = errorEnvelope(res).detail ?? {};
      expect(detail['example']).toEqual({ url: 'https://example.com/', every: '1h', mode: 'capture' });
      expect(typeof detail['guide']).toBe('string');
    });
  });

  it('register 429 keeps retryAfterSeconds and points back at the register recipe', async () => {
    await withApp(async (fx) => {
      let res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: {} });
      expect(res.statusCode).toBe(422);
      for (let i = 0; i < 2; i++) {
        res = await fx.app.inject({
          method: 'POST',
          url: '/v1/register',
          payload: { address: '0x0000000000000000000000000000000000000001' },
        });
        expect(res.statusCode).toBe(201);
      }
      res = await fx.app.inject({
        method: 'POST',
        url: '/v1/register',
        payload: { address: '0x0000000000000000000000000000000000000001' },
      });
      expect(res.statusCode).toBe(429);
      const envelope = errorEnvelope(res);
      expect(envelope.code).toBe('rate_limited');
      const detail = envelope.detail ?? {};
      expect(typeof detail['retryAfterSeconds']).toBe('number');
      expect(detail['example']).toEqual({ address: '0xYourWalletAddress' });
    });
  });
});
