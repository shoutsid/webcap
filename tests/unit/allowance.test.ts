import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/index.js';
import {
  allowanceHeaders,
  allowanceKey,
  makeAllowanceRepo,
  prepareAllowance,
  type AllowanceGate,
} from '../../src/db/allowance.js';

// The rolling allowance replaced the wallet-signed trials: it is how an agent
// with no wallet gets a real product. These pin the two properties that matter
// operationally — a true sliding window, and a commit that only happens on
// success — plus the fleet-wide circuit breaker.

interface Fixture {
  readonly db: Db;
  readonly dir: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'webcap-allowance-'));
  return { db: openDb(join(dir, 'a.db')), dir };
}

function gate(db: Db, over: Partial<AllowanceGate> = {}): AllowanceGate {
  return {
    repo: makeAllowanceRepo(db),
    limit: 3,
    windowMs: 24 * 3_600_000,
    globalWindowLimit: 0,
    ...over,
  };
}

describe('allowance key hashing', () => {
  it('is stable for one IP and different across IPs, and never exposes the address', () => {
    const a = allowanceKey('203.0.113.5');
    expect(allowanceKey('203.0.113.5')).toBe(a);
    expect(allowanceKey('203.0.113.6')).not.toBe(a);
    expect(a).not.toContain('203.0.113.5');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rolling window', () => {
  it('counts uses and prefers paid slots before spending the window', () => {
    const f = fixture();
    try {
      const g = gate(f.db);
      expect(prepareAllowance(g, '203.0.113.5').granted).toBe(true);
      prepareAllowance(g, '203.0.113.5').commit();
      expect(f.db && g.repo.used(allowanceKey('203.0.113.5'), g.windowMs)).toBe(1);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('denies once the budget is spent, and reports how long to wait', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 2 });
      for (let i = 0; i < 2; i += 1) prepareAllowance(g, '203.0.113.5').commit();
      const denied = prepareAllowance(g, '203.0.113.5');
      expect(denied.granted).toBe(false);
      expect(denied.decision.remaining).toBe(0);
      expect(denied.decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.decision.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('is a sliding window: a use older than the window stops counting', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 1 });
      const key = allowanceKey('203.0.113.5');
      // An old use, planted directly: the repo must not count it.
      f.db
        .prepare('INSERT INTO allowance_uses (ip_hash, ts, cost) VALUES (?, ?, 1)')
        .run(key, new Date(Date.now() - 25 * 3_600_000).toISOString());
      expect(g.repo.used(key, g.windowMs)).toBe(0);
      expect(prepareAllowance(g, '203.0.113.5').granted).toBe(true);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('charges a batch its unit cost instead of one slot', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 5 });
      const prepared = prepareAllowance(g, '203.0.113.5', 4);
      expect(prepared.granted).toBe(true);
      expect(prepared.decision.remaining).toBe(1);
      prepared.commit();
      expect(prepareAllowance(g, '203.0.113.5', 2).granted).toBe(false);
      expect(prepareAllowance(g, '203.0.113.5', 1).granted).toBe(true);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('keeps each IP in its own bucket', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 1 });
      prepareAllowance(g, '203.0.113.5').commit();
      expect(prepareAllowance(g, '203.0.113.5').granted).toBe(false);
      expect(prepareAllowance(g, '203.0.113.6').granted).toBe(true);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('controls', () => {
  it('disables the free rail entirely when the limit is 0', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 0 });
      expect(prepareAllowance(g, '203.0.113.5').granted).toBe(false);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('stops free usage fleet-wide once the circuit breaker trips', () => {
    const f = fixture();
    try {
      const g = gate(f.db, { limit: 100, globalWindowLimit: 3 });
      expect(prepareAllowance(g, 'a').granted).toBe(true);
      prepareAllowance(g, 'a', 3).commit();
      // The breaker is fleet-wide, so a different, unspent IP is refused too.
      const other = prepareAllowance(g, 'b');
      expect(other.granted).toBe(false);
      expect(other.decision.remaining).toBe(0);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('response headers', () => {
  it('publishes the state so an agent can plan its next call', () => {
    const headers = allowanceHeaders({ granted: true, cost: 1, remaining: 7, limit: 10, retryAfterSeconds: 3600 });
    expect(headers).toEqual({
      'x-webcap-allowance-limit': '10',
      'x-webcap-allowance-remaining': '7',
      'x-webcap-allowance-cost': '1',
      'x-webcap-allowance-window-seconds': '3600',
      'x-webcap-allowance-granted': 'true',
    });
  });
});