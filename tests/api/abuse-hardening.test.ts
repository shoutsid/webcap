/**
 * Abuse hardening: rate limits keyed per caller — a forwarded client address is
 * trusted only from a local peer (the tunnel), never from the internet — plus
 * registration + watch-mutation budgets, and the ban on merchant
 * self-registration on live chains.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../../src/db/index.js';
import { makeAccountsRepo, type AccountsRepo } from '../../src/db/accounts.js';
import { makeArtifactRepo } from '../../src/db/artifacts.js';
import type { WebcapConfig } from '../../src/config.js';
import { buildApp } from '../../src/server/server.js';
import type { CaptureRequest, CaptureResult, StructuredCapture } from '../../src/capture/pipeline.js';
import type { OgResult } from '../../src/capture/og.js';
import { CUSTOMER_ADDRESS, MERCHANT_ADDRESS, closeApiFixture, errorEnvelope, makeApiFixture } from './fixture.js';

// Additional fixed anvil testnet accounts (public test keys, no secrets).
// Lowercase on purpose: ethers getAddress rejects mixed-case input with a wrong EIP-55 checksum.
const PAYER_B = '0x2b5ad5c47950e165eb55fc78c2e29a3bcd090881';
const PAYER_C = '0x2f4d02e1661807158b63455d5752a362e08db32b';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

/** The 429 contract: Retry-After header (integer seconds >= 1) + rate_limited envelope whose detail matches. */
function assertRateLimited(res: InjectedResponse): void {
  expect(res.statusCode).toBe(429);
  const header = res.headers['retry-after'];
  expect(typeof header).toBe('string');
  const seconds = Number(header);
  expect(Number.isInteger(seconds)).toBe(true);
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(60);
  const envelope = errorEnvelope(res);
  expect(envelope.code).toBe('rate_limited');
  expect(envelope.detail?.retryAfterSeconds).toBe(seconds);
}

const PREVIEW_URL = '/v1/extract/preview?url=https://example.com/';

describe('preview rate limit keying (abuse: X-Forwarded-For spoofing)', () => {
  it('a public peer cannot buy new budgets by rotating X-Forwarded-For', async () => {
    const fx = makeApiFixture();
    try {
      // A directly-connected caller that names its own address must not mint a
      // budget per value: a forwarded header is only honoured from a local peer.
      const spoofA = '203.0.113.10';
      const spoofB = '198.51.100.20';
      for (let i = 0; i < 10; i += 1) {
        const res = await fx.app.inject({
          method: 'GET',
          url: PREVIEW_URL,
          remoteAddress: '198.51.100.1',
          headers: { 'x-forwarded-for': i % 2 === 0 ? spoofA : spoofB },
        });
        expect(res.statusCode).toBe(200);
      }
      // 11th from the same peer with a fresh spoofed value: the spoof no longer
      // buys a new budget, so this must be blocked.
      const blocked = await fx.app.inject({
        method: 'GET',
        url: PREVIEW_URL,
        remoteAddress: '198.51.100.1',
        headers: { 'x-forwarded-for': '203.0.113.99' },
      });
      assertRateLimited(blocked);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('keys a local peer (the tunnel) on the forwarded caller, not the gateway', async () => {
    const fx = makeApiFixture();
    try {
      // Every external request arrives from the gateway address; keying on the
      // raw peer collapsed every agent into one budget (fixed 2026-10-06).
      const viaTunnel = { remoteAddress: '172.21.0.1' };
      const call = (ip: string) =>
        fx.app.inject({ method: 'GET', url: PREVIEW_URL, ...viaTunnel, headers: { 'cf-connecting-ip': ip } });
      for (let i = 0; i < 10; i += 1) expect((await call('203.0.113.10')).statusCode).toBe(200);
      // That caller is now spent...
      assertRateLimited(await call('203.0.113.10'));
      // ...while a different agent behind the same tunnel keeps its own budget.
      expect((await call('198.51.100.20')).statusCode).toBe(200);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('a different peer (socket address) gets its own budget even with a known-spoofed X-Forwarded-For', async () => {
    const fx = makeApiFixture();
    try {
      const spoof = '203.0.113.10';
      for (let i = 0; i < 10; i += 1) {
        const res = await fx.app.inject({ method: 'GET', url: PREVIEW_URL, headers: { 'x-forwarded-for': spoof } });
        expect(res.statusCode).toBe(200);
      }
      // Same peer is now blocked ...
      const blocked = await fx.app.inject({ method: 'GET', url: PREVIEW_URL, headers: { 'x-forwarded-for': spoof } });
      assertRateLimited(blocked);
      // ... but a different peer IP is, with the very same spoofed header.
      const otherPeer = await fx.app.inject({
        method: 'GET',
        url: PREVIEW_URL,
        remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': spoof },
      });
      expect(otherPeer.statusCode).toBe(200);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('POST /v1/register rate limit (abuse: infinite account/key creation)', () => {
  it('allows 3 registrations per window per peer, then 429 with the retry-after envelope', async () => {
    const fx = makeApiFixture();
    try {
      for (const address of [CUSTOMER_ADDRESS, PAYER_B, PAYER_C]) {
        const res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address } });
        expect(res.statusCode).toBe(201);
        const body = res.json() as { apiKey: string };
        expect(body.apiKey).toMatch(/^wc_live_[0-9a-f]{32}$/);
      }
      const blocked = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: PAYER_B } });
      assertRateLimited(blocked);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('watch mutation rate limit (POST + DELETE /v1/watches share one budget)', () => {
  it('the 11th mutation in the window is 429 with the retry-after envelope', async () => {
    const fx = makeApiFixture();
    try {
      const createBody = { url: 'https://example.com/', every: '1h', mode: 'capture' };
      const ids: string[] = [];
      for (let i = 0; i < 9; i += 1) {
        const res = await fx.app.inject({ method: 'POST', url: '/v1/watches', payload: createBody });
        expect(res.statusCode).toBe(201);
        ids.push((res.json() as { id: string }).id);
      }
      // 10th mutation is a DELETE: it draws from the same per-peer budget.
      const firstId = ids[0];
      if (firstId === undefined) throw new Error('no watch id returned');
      const del = await fx.app.inject({ method: 'DELETE', url: `/v1/watches/${firstId}` });
      expect(del.statusCode).toBe(204);
      // 11th mutation: blocked.
      const blocked = await fx.app.inject({ method: 'POST', url: '/v1/watches', payload: createBody });
      assertRateLimited(blocked);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('merchant registration on live chains (abuse: self-granting merchant access)', () => {
  it('local chain: registering the merchant address still succeeds (dev parity)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: MERCHANT_ADDRESS } });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { address: string; apiKey: string; balance: number };
      expect(body.address).toBe(MERCHANT_ADDRESS);
      expect(body.apiKey).toMatch(/^wc_live_[0-9a-f]{32}$/);
      expect(body.balance).toBe(0);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

interface BaseChainFixture {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly accounts: AccountsRepo;
  readonly dir: string;
}

/**
 * A base-mainnet app with x402 disabled (x402Network undefined, no facilitator):
 * enough chain config to exercise the live-chain guard without payment wiring.
 */
function makeBaseChainApp(): BaseChainFixture {
  const dir = mkdtempSync(join(tmpdir(), 'webcap-base-'));
  const db = openDb(join(dir, 'base.db'));
  const config: WebcapConfig = {
    chain: { name: 'base', rpcUrl: 'https://mainnet.base.org', chainId: 8453, usdcContract: BASE_USDC, explorer: 'https://basescan.org' },
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    usdcAddress: BASE_USDC,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: join(dir, 'base.db'),
    x402Network: undefined,
    x402Asset: BASE_USDC,
    x402PayTo: MERCHANT_ADDRESS,
    x402PriceUsdcUnits: 1_000,
    x402ExtractPriceUsdcUnits: 10_000,
    x402AuditPriceUsdcUnits: 2_000,
    x402VideoPriceUsdcUnits: 5_000,
    computeCostUsdcUnitsPerRequest: 200,
    modelApiBaseUrl: '',
    modelApiKey: '',
    modelName: '',
    x402FacilitatorUrl: 'https://x402.org/facilitator',
    publicBaseUrl: 'http://localhost:8080',
    cdpApiKey: undefined,
  };
  const capture = async (req: CaptureRequest): Promise<CaptureResult> => ({
    buffer: Buffer.alloc(0),
    format: req.format ?? 'png',
    bytes: 0,
  });
  const captureStructured = async (): Promise<StructuredCapture> => ({
    html: '<html></html>',
    structure: {
      title: '',
      description: '',
      headings: [],
      paragraphs: [],
      links: [],
      images: [],
      wordCount: 0,
      markdown: '',
    },
  });
  const og = async (req: { url: string }): Promise<OgResult> => ({ url: req.url, title: 'Stub' });
  const app = buildApp({ db, config, capture, captureStructured, og, artifacts: makeArtifactRepo(db) });
  return { app, db, accounts: makeAccountsRepo(db), dir };
}

async function closeBaseChainApp(fx: BaseChainFixture): Promise<void> {
  await fx.app.close();
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

describe('base chain app: merchant self-registration is forbidden', () => {
  it('merchant registration is 403 forbidden with the runbook pointer and creates no rows', async () => {
    const fx = makeBaseChainApp();
    try {
      const regular = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: CUSTOMER_ADDRESS } });
      expect(regular.statusCode).toBe(201);

      const merchant = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: MERCHANT_ADDRESS } });
      expect(merchant.statusCode).toBe(403);
      const envelope = errorEnvelope(merchant);
      expect(envelope.code).toBe('forbidden');
      expect(envelope.message).toBe('merchant registration is disabled on live chains; see the README ops runbook');
      expect(fx.accounts.findByAddress(MERCHANT_ADDRESS)).toBeUndefined();

      // The check is case-insensitive: lowercase wire forms are rejected too.
      const merchantLower = await fx.app.inject({
        method: 'POST',
        url: '/v1/register',
        payload: { address: MERCHANT_ADDRESS.toLowerCase() },
      });
      expect(merchantLower.statusCode).toBe(403);
      expect(errorEnvelope(merchantLower).code).toBe('forbidden');
      expect(fx.accounts.findByAddress(MERCHANT_ADDRESS)).toBeUndefined();
    } finally {
      await closeBaseChainApp(fx);
    }
  });

  it('non-merchant registration on the base chain still succeeds (201 + key)', async () => {
    const fx = makeBaseChainApp();
    try {
      const res = await fx.app.inject({ method: 'POST', url: '/v1/register', payload: { address: PAYER_B } });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { address: string; apiKey: string; balance: number };
      // The route stores/returns the EIP-55 checksummed form.
      expect(body.address.toLowerCase()).toBe(PAYER_B.toLowerCase());
      expect(body.apiKey).toMatch(/^wc_live_[0-9a-f]{32}$/);
      expect(body.balance).toBe(0);
    } finally {
      await closeBaseChainApp(fx);
    }
  });
});
