#!/usr/bin/env node
/**
 * webcap daily check — the numbers that decide whether anything changed.
 *
 * Reads ONLY the SQLite database (rule: metrics come from the DB, never from
 * targets). Prints a compact text report for one UTC day plus lifetime totals,
 * and ends with an ATTENTION block listing anything a human should react to.
 *
 * Usage (container, the normal case):
 *   docker cp scripts/daily-check.mjs webcap-webcap-1:/app/daily-check.mjs
 *   docker exec -w /app webcap-webcap-1 node daily-check.mjs
 *
 * Usage (any host copy of the DB, e.g. a restored backup):
 *   node scripts/daily-check.mjs --db /path/to/webcap.db
 *
 * Flags:
 *   --db <path>    SQLite file (default: $WEBCAP_DB or /data/webcap.db).
 *   --date YYYY-MM-DD   Report this single UTC day (default: today UTC).
 *   --days N       Report the trailing N UTC days ending --date (default 1;
 *                  the trend block always shows the last 7 days).
 *   --json         Emit one JSON object instead of the text report.
 *
 * Expanding: each section is one function returning a plain object; add a
 * section function, call it in buildReport(), and (if it should draw
 * attention) return a flag string from it. Sections tolerate missing tables
 * and return null rather than crash.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import process from 'node:process';

// ---------------------------------------------------------------------------
// args

function parseArgs(argv) {
  const out = { db: process.env.WEBCAP_DB ?? '/data/webcap.db', date: null, days: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--days') out.days = Number(argv[++i] ?? 1);
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--db=')) out.db = a.slice(5);
    else if (a.startsWith('--date=')) out.date = a.slice(7);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
  }
  const today = new Date().toISOString().slice(0, 10);
  out.date = out.date ?? today;
  out.days = Number.isFinite(out.days) && out.days >= 1 ? Math.floor(out.days) : 1;
  return out;
}

// ---------------------------------------------------------------------------
// helpers

const USDC_SCALE = 1_000_000;

const usdc = (units) => {
  const whole = Math.trunc(units / USDC_SCALE);
  const frac = String(units % USDC_SCALE).padStart(6, '0').replace(/0+$/, '');
  return frac === '' ? String(whole) : `${whole}.${frac}`;
};

/** UTC day boundaries as ISO strings (created_at compares lexicographically). */
function dayBounds(date, days = 1) {
  const startMs = Date.parse(`${date}T00:00:00Z`);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + days * 86_400_000).toISOString(),
  };
}

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

const qAll = (db, sql, ...params) => safe(() => db.prepare(sql).all(...params)) ?? [];
const qRow = (db, sql, ...params) => safe(() => db.prepare(sql).get(...params)) ?? {};

const truncate = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const pad = (n, w = 5) => String(n).padStart(w);

// ---------------------------------------------------------------------------
// sections — each returns a plain object, or null when the table is missing

function overview(db, start, end) {
  const hits = qRow(db, 'SELECT COUNT(*) n, COUNT(DISTINCT user_agent) ua FROM endpoint_hits WHERE created_at >= ? AND created_at < ?', start, end);
  const five = qAll(db, 'SELECT status, COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ? AND status >= 500 GROUP BY status ORDER BY n DESC', start, end);
  return {
    hits: hits.n ?? 0,
    distinctUas: hits.ua ?? 0,
    challenges402: qRow(db, 'SELECT COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ? AND status = 402', start, end).n ?? 0,
    fivexx: five,
  };
}

/**
 * Freshness: how long ago the newest recorded hit was. The failure mode that
 * cost a day (2026-10-06) is a container that stays "running" while wedged —
 * it stops recording hits without ever exiting, so no restart policy fires.
 * The gap since the newest hit is the cheapest downtime signal the DB holds.
 */
function freshness(db) {
  const newest = qRow(db, 'SELECT MAX(created_at) newest FROM endpoint_hits').newest ?? null;
  if (newest === null) return { newest: null, ageHours: null };
  const ageMs = Date.now() - Date.parse(newest);
  return { newest, ageHours: Number.isFinite(ageMs) ? Math.round((ageMs / 3_600_000) * 10) / 10 : null };
}

function revenue(db, start, end) {
  const life = qRow(db, 'SELECT COUNT(*) n, COUNT(DISTINCT payer) wallets, COALESCE(SUM(revenue_usdc),0) revenue, COALESCE(SUM(cost_usdc),0) cost FROM revenue_ledger');
  const day = qRow(db, 'SELECT COUNT(*) n, COUNT(DISTINCT payer) wallets, COALESCE(SUM(revenue_usdc),0) revenue FROM revenue_ledger WHERE created_at >= ? AND created_at < ?', start, end);
  const repeat = qRow(
    db,
    'SELECT COUNT(*) n FROM (SELECT payer FROM revenue_ledger GROUP BY payer HAVING COUNT(*) > 1)',
  ).n ?? 0;
  const top = qAll(
    db,
    'SELECT payer, COUNT(*) n, COALESCE(SUM(revenue_usdc),0) revenue FROM revenue_ledger GROUP BY payer ORDER BY revenue DESC, n DESC LIMIT 5',
  );
  return {
    lifetimeCalls: life.n ?? 0,
    lifetimeWallets: life.wallets ?? 0,
    lifetimeUsdcUnits: life.revenue ?? 0,
    lifetimeCostUnits: life.cost ?? 0,
    dayCalls: day.n ?? 0,
    dayWallets: day.wallets ?? 0,
    dayUsdcUnits: day.revenue ?? 0,
    repeatWallets: repeat,
    topPayers: top,
  };
}

/**
 * The free rail: the rolling per-IP allowance that replaced wallet-signed
 * trials. `allowance_uses` holds only the live window (rows are pruned
 * opportunistically on every check), so there is deliberately no lifetime
 * number here — read these as "free calls granted recently", never "ever".
 */
function allowance(db, start, end) {
  const day = qRow(
    db,
    'SELECT COALESCE(SUM(cost), 0) n, COUNT(DISTINCT ip_hash) callers FROM allowance_uses WHERE ts >= ? AND ts < ?',
    start,
    end,
  );
  const held = qRow(db, 'SELECT COALESCE(SUM(cost), 0) n, COUNT(DISTINCT ip_hash) callers FROM allowance_uses');
  return {
    dayGrants: day.n ?? 0,
    dayCallers: day.callers ?? 0,
    heldGrants: held.n ?? 0,
    heldCallers: held.callers ?? 0,
  };
}

function feedback(db, start, end) {
  const life = qRow(db, 'SELECT COUNT(*) n FROM feedback');
  const day = qRow(db, 'SELECT COUNT(*) n FROM feedback WHERE created_at >= ? AND created_at < ?', start, end);
  const byCategory = qAll(db, 'SELECT category, COUNT(*) n FROM feedback WHERE created_at >= ? AND created_at < ? GROUP BY category ORDER BY n DESC', start, end);
  const latest = qAll(
    db,
    'SELECT id, category, endpoint, user_agent, message, created_at FROM feedback ORDER BY created_at DESC LIMIT 5',
  );
  return { lifetime: life.n ?? 0, day: day.n ?? 0, byCategory, latest };
}

function watches(db, start, end) {
  const total = qRow(db, 'SELECT COUNT(*) n FROM watches').n ?? 0;
  const active = qRow(db, 'SELECT COUNT(*) n FROM watches WHERE paused = 0').n ?? 0;
  const funded = qRow(db, 'SELECT COUNT(*) n FROM watches WHERE credits > 0').n ?? 0;
  const runs = qRow(db, 'SELECT COUNT(*) n FROM watch_runs WHERE created_at >= ? AND created_at < ?', start, end).n ?? 0;
  return { total, active, funded, runsToday: runs };
}

function endpoints(db, start, end) {
  const top = qAll(
    db,
    'SELECT endpoint, COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ? GROUP BY endpoint ORDER BY n DESC LIMIT 10',
    start,
    end,
  );
  const mcp = qAll(
    db,
    'SELECT status, COUNT(*) n FROM endpoint_hits WHERE endpoint = ? AND created_at >= ? AND created_at < ? GROUP BY status ORDER BY n DESC',
    'POST /mcp',
    start,
    end,
  );
  const mcpByStatus = Object.fromEntries(mcp.map((r) => [r.status, r.n]));
  return { top, mcp: mcpByStatus, mcpTotal: mcp.reduce((s, r) => s + r.n, 0) };
}

function userAgents(db, start, end) {
  return qAll(
    db,
    'SELECT user_agent, COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ? GROUP BY user_agent ORDER BY n DESC LIMIT 10',
    start,
    end,
  );
}

/**
 * Who actually got the x402 challenges? Monitors and directory crawlers probe
 * the paid path on purpose and never sign — a day whose 402 volume comes from
 * them is measurement, not intent. Reading the names is the point.
 */
function challengers(db, start, end) {
  return qAll(
    db,
    'SELECT user_agent, COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ? AND status = 402 GROUP BY user_agent ORDER BY n DESC LIMIT 8',
    start,
    end,
  );
}

function trend(db, date, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(date, -i);
    const { start, end } = dayBounds(d);
    out.push({
      date: d,
      hits: qRow(db, 'SELECT COUNT(*) n FROM endpoint_hits WHERE created_at >= ? AND created_at < ?', start, end).n ?? 0,
      paid: qRow(db, 'SELECT COUNT(*) n FROM revenue_ledger WHERE created_at >= ? AND created_at < ?', start, end).n ?? 0,
      revenue: qRow(db, 'SELECT COALESCE(SUM(revenue_usdc),0) n FROM revenue_ledger WHERE created_at >= ? AND created_at < ?', start, end).n ?? 0,
      allowance: qRow(db, 'SELECT COALESCE(SUM(cost), 0) n FROM allowance_uses WHERE ts >= ? AND ts < ?', start, end).n ?? 0,
      feedback: qRow(db, 'SELECT COUNT(*) n FROM feedback WHERE created_at >= ? AND created_at < ?', start, end).n ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// report

function buildReport(db, args) {
  const { start, end } = dayBounds(args.date, args.days);
  const r = {
    db: args.db,
    date: args.date,
    days: args.days,
    overview: overview(db, start, end),
    freshness: freshness(db),
    revenue: revenue(db, start, end),
    allowance: allowance(db, start, end),
    feedback: feedback(db, start, end),
    watches: watches(db, start, end),
    endpoints: endpoints(db, start, end),
    userAgents: userAgents(db, start, end),
    challengers: challengers(db, start, end),
    trend: trend(db, args.date, Math.max(args.days, 7)),
    flags: [],
  };
  const f = r.flags;
  if (r.revenue.dayCalls > 0) f.push(`$${usdc(r.revenue.dayUsdcUnits)} from ${r.revenue.dayCalls} paid call(s) today — revenue!`);
  if (r.revenue.repeatWallets > 0) f.push(`${r.revenue.repeatWallets} repeat buyer wallet(s) lifetime`);
  if (r.allowance.dayGrants > 0)
    f.push(
      `${r.allowance.dayGrants} free allowance grant(s) today (${r.allowance.dayCallers} caller(s)) — the last no-cost step before paid`,
    );
  if (r.feedback.day > 0) f.push(`${r.feedback.day} feedback submission(s) today — read the latest below`);
  if (r.overview.fivexx.length > 0)
    f.push(`5xx today: ${r.overview.fivexx.map((x) => `${x.status}×${x.n}`).join(', ')}`);
  if (r.overview.hits === 0 && r.days === 1) f.push('zero endpoint hits for the day — is the host reachable?');
  // Only meaningful for the current day: a historical --date is stale by design.
  if (
    args.days === 1 &&
    args.date === new Date().toISOString().slice(0, 10) &&
    r.freshness.ageHours !== null &&
    r.freshness.ageHours > 2
  )
    f.push(
      `no endpoint hits for ${r.freshness.ageHours}h — the API may be down or wedged; see docs/operations/incident-api-down.md`,
    );
  if (r.overview.challenges402 > 0) f.push(`${r.overview.challenges402} x402 challenge(s) served today (demand signal)`);
  if (r.endpoints.mcpTotal > 0) f.push(`POST /mcp ${r.endpoints.mcpTotal}× (${Object.entries(r.endpoints.mcp).map(([s, n]) => `${s}×${n}`).join(', ')})`);
  return r;
}

// ---------------------------------------------------------------------------
// rendering

function renderText(r) {
  const L = [];
  const row = (a, b) => L.push(`${String(a).padEnd(26)} ${b}`);
  L.push(`webcap daily check — ${r.date} (UTC) — db: ${r.db}`);
  L.push('-'.repeat(70));

  L.push('OVERVIEW');
  row('endpoint_hits', `${r.overview.hits} (${r.overview.distinctUas} user agents)`);
  row('x402 challenges', r.overview.challenges402);
  row('5xx', r.overview.fivexx.length ? r.overview.fivexx.map((x) => `${x.status}×${x.n}`).join(', ') : '0');
  row(
    'newest hit',
    r.freshness.newest === null ? 'none recorded' : `${r.freshness.newest} (${r.freshness.ageHours}h ago)`,
  );

  L.push('');
  L.push('REVENUE (revenue_ledger)');
  row('today', `${r.revenue.dayCalls} call(s), $${usdc(r.revenue.dayUsdcUnits)}, ${r.revenue.dayWallets} wallet(s)`);
  row('lifetime', `${r.revenue.lifetimeCalls} call(s), $${usdc(r.revenue.lifetimeUsdcUnits)}, ${r.revenue.lifetimeWallets} wallet(s)`);
  row('lifetime cost', `$${usdc(r.revenue.lifetimeCostUnits)}`);
  row('repeat buyers', r.revenue.repeatWallets);
  if (r.revenue.topPayers.length) {
    row('top payers', r.revenue.topPayers.map((p) => `${(p.payer || '?').slice(0, 10)}… ${p.n}× $${usdc(p.revenue)}`).join(' | '));
  }

  L.push('');
  L.push('FREE ALLOWANCE (allowance_uses — live window only, no lifetime)');
  row('today', `${r.allowance.dayGrants} grant(s) from ${r.allowance.dayCallers} caller(s)`);
  row('still in table', `${r.allowance.heldGrants} grant(s) from ${r.allowance.heldCallers} caller(s)`);

  L.push('');
  L.push(`FEEDBACK (${r.feedback.lifetime} lifetime, ${r.feedback.day} today)`);
  if (r.feedback.byCategory.length) row('by category', r.feedback.byCategory.map((c) => `${c.category}×${c.n}`).join(', '));
  for (const fb of r.feedback.latest) {
    L.push(`  #${fb.id} [${fb.category}] ${fb.created_at ?? ''} ${fb.endpoint ? `endpoint=${fb.endpoint}` : ''}`);
    L.push(`    ${truncate(fb.message, 220)}`);
    if (fb.user_agent) L.push(`    ua: ${truncate(fb.user_agent, 120)}`);
  }

  L.push('');
  L.push(`WATCHES (${r.watches.total} total, ${r.watches.active} active, ${r.watches.funded} funded)`);
  row('runs today', r.watches.runsToday);

  L.push('');
  L.push('ENDPOINTS TODAY');
  for (const e of r.endpoints.top) row(e.endpoint, e.n);
  if (r.endpoints.mcpTotal) row('POST /mcp breakdown', Object.entries(r.endpoints.mcp).map(([s, n]) => `${s}×${n}`).join(', '));

  L.push('');
  L.push('TOP USER AGENTS TODAY');
  for (const u of r.userAgents) row(truncate(u.user_agent, 40), u.n);

  L.push('');
  L.push('WHO GOT THE 402s TODAY (monitors probe and never sign — names matter)');
  for (const c of r.challengers) row(truncate(c.user_agent, 44), c.n);

  L.push('');
  L.push('TREND (hits | paid | $usdc | free | feedback)');
  for (const t of r.trend) row(t.date, `${pad(t.hits)} | ${pad(t.paid)} | ${usdc(t.revenue).padStart(8)} | ${pad(t.allowance)} | ${pad(t.feedback)}`);

  L.push('');
  L.push('='.repeat(70));
  if (r.flags.length) {
    L.push('ATTENTION');
    for (const f of r.flags) L.push(`  - ${f}`);
  } else {
    L.push('ATTENTION: nothing needs a reaction');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.db)) {
    console.error(`daily-check: db not found at ${args.db} (pass --db <path> or set WEBCAP_DB)`);
    process.exit(1);
  }
  const db = new Database(args.db, { readonly: true });
  try {
    const report = buildReport(db, args);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderText(report));
    }
  } finally {
    db.close();
  }
}