import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, type Db } from '../../src/db/index.js';
import { makeArtifactRepo } from '../../src/db/artifacts.js';
import type { WebcapConfig } from '../../src/config.js';
import { buildApp } from '../../src/server/server.js';
import { makeMockFacilitator, type MockFacilitator } from '../helpers/facilitator.js';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm';
import { x402Client, wrapAxiosWithPayment } from '@x402/axios';
import { MERCHANT_ADDRESS } from './fixture.js';

// The route calls the real Playwright pipeline; stub captureVideo at the
// module seam (keeping the real duration/speed constants video-parse.ts
// imports) so the paid-surface tests prove gating + ledger without Chromium.
vi.mock('../../src/capture/video.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/capture/video.js')>();
  return {
    ...actual,
    captureVideo: vi.fn(async () => ({
      buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      mime: 'video/webm',
      bytes: 4,
    })),
  };
});

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER_KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b786900';
const GOOD_URL = 'https://example.com/';

let dir: string;
let db: Db;
let app: FastifyInstance;
let baseUrl: string;
let mock: MockFacilitator;

function makePayer() {
  const account = privateKeyToAccount(PAYER_KEY_A);
  return { account, client: new x402Client().register('eip155:*', new ExactEvmScheme(account)) };
}

async function paidVideo(payload: unknown) {
  const { client } = makePayer();
  const api = wrapAxiosWithPayment(axios.create({ baseURL: baseUrl }), client);
  return api.post('/v1/x402/video', payload);
}

function responseOf(err: unknown): { status?: number; code?: string } {
  const response = (err as { response?: { status?: number; data?: { error?: { code?: string } } } }).response;
  return { status: response?.status, code: response?.data?.error?.code };
}

function ledgerRows(): Array<{ endpoint: string; revenue_usdc: number; cost_usdc: number; payer: string }> {
  return db
    .prepare<[], { endpoint: string; revenue_usdc: number; cost_usdc: number; payer: string }>(
      'SELECT endpoint, revenue_usdc, cost_usdc, payer FROM revenue_ledger',
    )
    .all();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'webcap-x402-video-'));
  db = openDb(join(dir, 'x402-video.db'));
  mock = makeMockFacilitator('eip155:84532');
  const config: WebcapConfig = {
    chain: {
      name: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      chainId: 84532,
      usdcContract: SEPOLIA_USDC,
      explorer: 'https://sepolia.basescan.org',
    },
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcAddress: SEPOLIA_USDC,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: join(dir, 'x402-video.db'),
    x402Network: 'eip155:84532',
    x402Asset: SEPOLIA_USDC,
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
  app = buildApp({
    db,
    config,
    capture: async () => {
      throw new Error('capture is not used in video tests');
    },
    captureStructured: async () => {
      throw new Error('captureStructured is not used in video tests');
    },
    og: async ({ url }) => ({ url, title: 'Stub' }),
    x402Facilitator: mock.facilitator,
    artifacts: makeArtifactRepo(db),
  });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('x402 video (v2 wire, mock facilitator, stubbed recordVideo)', () => {
  it('A-S1: an unpaid video returns 402 at the video price (5000), not capture/extract', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/x402/video', payload: { url: GOOD_URL } });
    expect(res.statusCode).toBe(402);
    const challenge = res.json() as { accepts: Array<{ amount: string }>; resource: { url: string } };
    expect(challenge.accepts[0]?.amount).toBe('5000');
    expect(challenge.resource.url).toContain('/v1/x402/video');
  });

  it('A-S1b: GET /v1/x402/video returns the identical 402 challenge (crawler discovery mirror)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/x402/video' });
    expect(res.statusCode).toBe(402);
    const challenge = res.json() as { accepts: Array<{ amount: string }>; resource: { url: string } };
    expect(challenge.accepts[0]?.amount).toBe('5000');
    expect(challenge.resource.url).toContain('/v1/x402/video');
  });

  it('A-S1c: a paid video returns the video artifact and records a 5000-unit ledger row', async () => {
    const { account } = makePayer();
    const before = ledgerRows().length;
    const res = await paidVideo({ url: GOOD_URL });
    expect(res.status).toBe(200);
    const body = res.data as {
      artifact: { mime: string; bytes: number; data: string };
      payment: { payer: string; priceUsdcUnits: number };
    };
    expect(body.artifact.mime).toBe('video/webm');
    expect(body.artifact.bytes).toBe(4);
    expect(typeof body.artifact.data).toBe('string');
    expect(Buffer.from(body.artifact.data, 'base64')).toHaveLength(4);
    expect(body.payment).toMatchObject({ payer: account.address, priceUsdcUnits: 5000 });
    const rows = ledgerRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows[rows.length - 1]).toMatchObject({ endpoint: 'video', payer: account.address, revenue_usdc: 5000 });
  });

  it('A-S2a: an over-cap durationMs returns 422 unprocessable and records nothing', async () => {
    const before = ledgerRows().length;
    let err: unknown;
    try {
      await paidVideo({ url: GOOD_URL, durationMs: 120_000 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const { status, code } = responseOf(err);
    expect(status).toBe(422);
    expect(code).toBe('unprocessable');
    expect(ledgerRows()).toHaveLength(before);
  });

  it('A-S2b: an invalid body (no url) returns 422 unprocessable and records nothing', async () => {
    const before = ledgerRows().length;
    let err: unknown;
    try {
      await paidVideo({ format: 'avi' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const { status, code } = responseOf(err);
    expect(status).toBe(422);
    expect(code).toBe('unprocessable');
    expect(ledgerRows()).toHaveLength(before);
  });
});
