import { describe, expect, it } from 'vitest';
import { recordHit } from '../../src/db/hits.js';
import type { AgentFunnel } from '../../src/server/agent-funnel.js';
import { closeApiFixture, makeApiFixture } from './fixture.js';

// The agent-income funnel is the metric the business actually needs: the
// legacy /v1/funnel only measures the dead human landing path. These tests
// pin the stage definitions from docs/strategy/agent-first.md so the number
// can't silently drift into probe noise.

function seedAllowance(fx: ReturnType<typeof makeApiFixture>, ipHash: string, cost = 1): void {
  fx.db
    .prepare('INSERT INTO allowance_uses (ip_hash, ts, cost) VALUES (?, ?, ?)')
    .run(ipHash, new Date().toISOString(), cost);
}

function seedRevenue(
  fx: ReturnType<typeof makeApiFixture>,
  payer: string,
  endpoint: string,
  units: number,
): void {
  fx.db
    .prepare(
      'INSERT INTO revenue_ledger (endpoint, payer, revenue_usdc, cost_usdc, net_margin_usdc, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(endpoint, payer, units, 200, units - 200, new Date().toISOString());
}

function seedWatch(fx: ReturnType<typeof makeApiFixture>, id: string, credits: number, paused = 0): void {
  fx.db
    .prepare(
      'INSERT INTO watches (id, url, every, mode, credits, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'https://example.com', '1h', 'extract', credits, paused, new Date().toISOString());
}

describe('agent-income funnel: reach → challenge → trial → paid → retention → recurring', () => {
  it('counts discovery clients, paid-route 402s, trials, wallets and revenue', async () => {
    const fx = makeApiFixture();
    try {
      // reach: discovery surfaces, attributed by client
      recordHit(fx.db, { endpoint: 'GET /llms.txt', status: 200, userAgent: 'CarbonMonitor/0.1' });
      recordHit(fx.db, { endpoint: 'GET /skill.md', status: 200, userAgent: 'CarbonMonitor/0.1' });
      recordHit(fx.db, { endpoint: 'GET /v1/x402/service', status: 200, userAgent: '402explorer/0.1' });
      // a discovery-surface 200 with no UA is unattributed, still reach
      recordHit(fx.db, { endpoint: 'GET /openapi.json', status: 200 });

      // challenge: 402s on paid routes; this 402 is NOT a paid route and must not count
      recordHit(fx.db, { endpoint: 'POST /v1/x402/capture', status: 402, userAgent: 'probe/1.0' });
      recordHit(fx.db, { endpoint: 'POST /v1/x402/capture', status: 402, userAgent: 'probe/1.0' });
      recordHit(fx.db, { endpoint: 'POST /v1/x402/extract', status: 402, userAgent: 'probe/1.0' });
      recordHit(fx.db, { endpoint: 'GET /v1/extract/preview', status: 402 });

      seedAllowance(fx, 'hash-a', 2);
      seedAllowance(fx, 'hash-b', 1);

      // one wallet paid once, one wallet paid twice -> repeat buyer
      seedRevenue(fx, '0xaaa', 'capture', 1_000);
      seedRevenue(fx, '0xbbb', 'extract', 10_000);
      seedRevenue(fx, '0xbbb', 'extract', 10_000);

      seedWatch(fx, 'w-funded', 100);
      seedWatch(fx, 'w-empty', 0);
      seedWatch(fx, 'w-paused', 100, 1);

      const res = await fx.app.inject({ method: 'GET', url: '/v1/agent-funnel' });
      expect(res.statusCode).toBe(200);
      const f = res.json() as AgentFunnel;

      expect(f.windowHours).toBe(168);
      expect(f.reach.discoveryRequests).toBe(4);
      expect(f.reach.topClients[0]).toEqual({ client: 'CarbonMonitor/0.1', requests: 2 });
      expect(f.reach.topClients).toContainEqual({ client: '(unattributed)', requests: 1 });

      // 3 paid-route 402s; the preview 402 is excluded
      expect(f.challenge.total).toBe(3);
      expect(f.challenge.topEndpoints[0]).toEqual({ endpoint: 'POST /v1/x402/capture', count: 2 });

      // 3 free calls granted across 2 caller buckets.
      expect(f.freeAllowance.grants).toBe(3);
      expect(f.freeAllowance.callers).toBe(2);

      // 3 calls across 2 distinct wallets (0xbbb paid twice)
      expect(f.paid.calls).toBe(3);
      expect(f.paid.wallets).toBe(2);
      expect(f.paid.revenueUsdcUnits).toBe(21_000);

      expect(f.retention.firstPayWallets).toBe(1); // 0xaaa
      expect(f.retention.repeatWallets).toBe(1); // 0xbbb

      expect(f.recurring.activePaidWatches).toBe(1); // funded + unpaused only
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('empty DB → zeros, never a null-crash', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/v1/agent-funnel' });
      expect(res.statusCode).toBe(200);
      const f = res.json() as AgentFunnel;
      expect(f.reach.discoveryRequests).toBe(0);
      expect(f.challenge.total).toBe(0);
      expect(f.freeAllowance).toEqual({ grants: 0, callers: 0 });
      expect(f.paid).toEqual({ calls: 0, wallets: 0, revenueUsdcUnits: 0 });
      expect(f.retention).toEqual({ firstPayWallets: 0, repeatWallets: 0 });
      expect(f.recurring.activePaidWatches).toBe(0);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('?hours=N sets the window and ?format=text renders for a terminal', async () => {
    const fx = makeApiFixture();
    try {
      recordHit(fx.db, { endpoint: 'GET /llms.txt', status: 200, userAgent: 'bot/1' });
      const json = await fx.app.inject({ method: 'GET', url: '/v1/agent-funnel?hours=24' });
      expect(json.statusCode).toBe(200);
      expect((json.json() as AgentFunnel).windowHours).toBe(24);

      const text = await fx.app.inject({ method: 'GET', url: '/v1/agent-funnel?format=text' });
      expect(text.statusCode).toBe(200);
      expect(text.headers['content-type']).toContain('text/plain');
      expect(text.body).toContain('WEBCAP AGENT FUNNEL');
      expect(text.body).toContain('REACH');
    } finally {
      await closeApiFixture(fx);
    }
  });
});
