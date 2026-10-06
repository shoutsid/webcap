import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** Typed better-sqlite3 handle: WAL mode, foreign keys ON, schema applied. */
export type Db = Database.Database;

const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Column names of a table (via PRAGMA table_info), used by additive migrations. */
function tableColumns(db: Db, table: string): ReadonlySet<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name));
}

/**
 * Open (or create) the webcap database at `path` — a filesystem path or
 * `:memory:` for tests — and apply schema.sql. Caller owns the handle.
 */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaPath, 'utf8'));
  migrateWatchChatOps(db);
  migrateWatchJsonAuth(db);
  migrateWatchAiSummary(db);
  migrateCaptureJobs(db);
  migrateEndpointHits(db);
  migratePaymentWebhooks(db);
  migrateTrackingEvents(db);
  migratePreviewCache(db);
  migrateTrialClaims(db);
  migrateFaucetDays(db);
  migrateFeedback(db);
  migrateAllowanceUses(db);
  return db;
}

/**
 * Additive, nullable-tolerant migration for the T4-S1/S2 watch conditions +
 * ChatOps columns: existing rows stay valid (conditions NULL, channel
 * 'generic'); fresh databases already carry the columns via schema.sql.
 */
function migrateWatchChatOps(db: Db): void {
  const existing = tableColumns(db, 'watches');
  if (!existing.has('conditions_json')) db.exec('ALTER TABLE watches ADD COLUMN conditions_json TEXT');
  if (!existing.has('channel')) db.exec("ALTER TABLE watches ADD COLUMN channel TEXT NOT NULL DEFAULT 'generic'");
}

/**
 * Additive, nullable-tolerant migration for the watch JSON-mode + macro-auth
 * columns (headers/cookies/steps): existing rows stay valid (all three NULL,
 * i.e. legacy capture/extract behavior); fresh databases already carry the
 * columns via schema.sql.
 */
function migrateWatchJsonAuth(db: Db): void {
  const existing = tableColumns(db, 'watches');
  if (!existing.has('headers_json')) db.exec('ALTER TABLE watches ADD COLUMN headers_json TEXT');
  if (!existing.has('cookies_json')) db.exec('ALTER TABLE watches ADD COLUMN cookies_json TEXT');
  if (!existing.has('steps_json')) db.exec('ALTER TABLE watches ADD COLUMN steps_json TEXT');
}

/**
 * Additive, nullable-tolerant migration for the watch AI-summary columns
 * (watches.summary_prompt_append + watch_runs.ai_summary): existing rows stay
 * valid (both NULL, i.e. no prompt override and no cached summary); fresh
 * databases already carry the columns via schema.sql.
 */
function migrateWatchAiSummary(db: Db): void {
  const watchCols = tableColumns(db, 'watches');
  if (!watchCols.has('summary_prompt_append')) db.exec('ALTER TABLE watches ADD COLUMN summary_prompt_append TEXT');
  const runCols = tableColumns(db, 'watch_runs');
  if (!runCols.has('ai_summary')) db.exec('ALTER TABLE watch_runs ADD COLUMN ai_summary TEXT');
}

/**
 * Additive, nullable-tolerant migration for the async-capture capture_jobs
 * table: fresh databases already carry it via schema.sql; pre-existing
 * database files gain the table (or any missing nullable column) here so
 * they stay valid without a wipe. Every added column is nullable — existing
 * rows are untouched.
 */
function migrateCaptureJobs(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_jobs'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE capture_jobs (' +
        'id TEXT PRIMARY KEY, ' +
        'url TEXT NOT NULL, ' +
        'format TEXT, ' +
        'status TEXT NOT NULL, ' +
        'artifact_url TEXT, ' +
        'error TEXT, ' +
        'payer TEXT, ' +
        'price_usdc_units INTEGER, ' +
        'credits_used INTEGER, ' +
        'cost_usdc_units INTEGER, ' +
        "created_at TEXT NOT NULL, " +
        'updated_at TEXT NOT NULL)',
    );
    return;
  }
  const existing = tableColumns(db, 'capture_jobs');
  if (!existing.has('url')) db.exec('ALTER TABLE capture_jobs ADD COLUMN url TEXT NOT NULL DEFAULT \'\'');
  if (!existing.has('format')) db.exec('ALTER TABLE capture_jobs ADD COLUMN format TEXT');
  if (!existing.has('status')) db.exec("ALTER TABLE capture_jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'");
  if (!existing.has('artifact_url')) db.exec('ALTER TABLE capture_jobs ADD COLUMN artifact_url TEXT');
  if (!existing.has('error')) db.exec('ALTER TABLE capture_jobs ADD COLUMN error TEXT');
  if (!existing.has('payer')) db.exec('ALTER TABLE capture_jobs ADD COLUMN payer TEXT');
  if (!existing.has('price_usdc_units')) db.exec('ALTER TABLE capture_jobs ADD COLUMN price_usdc_units INTEGER');
  if (!existing.has('credits_used')) db.exec('ALTER TABLE capture_jobs ADD COLUMN credits_used INTEGER');
  if (!existing.has('cost_usdc_units')) db.exec('ALTER TABLE capture_jobs ADD COLUMN cost_usdc_units INTEGER');
  if (!existing.has('created_at')) db.exec("ALTER TABLE capture_jobs ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  if (!existing.has('updated_at')) db.exec("ALTER TABLE capture_jobs ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
}

/**
 * Additive, idempotent migration for the metrics endpoint_hits table: fresh
 * databases already carry it via schema.sql; pre-existing database files gain
 * the table (or any missing nullable column) here so they stay valid without
 * a wipe. The raw payer is never stored — only the sha256 slice (payer_hash).
 */
function migrateEndpointHits(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'endpoint_hits'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE endpoint_hits (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'endpoint TEXT NOT NULL, ' +
        'status INTEGER NOT NULL, ' +
        "payer_hash TEXT NOT NULL DEFAULT 'anonymous', " +
        'duration_ms INTEGER, ' +
        "user_agent TEXT NOT NULL DEFAULT '', " +
        'created_at TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_endpoint_hits_endpoint_created ON endpoint_hits(endpoint, created_at)');
    return;
  }
  const existing = tableColumns(db, 'endpoint_hits');
  if (!existing.has('endpoint')) db.exec("ALTER TABLE endpoint_hits ADD COLUMN endpoint TEXT NOT NULL DEFAULT ''");
  if (!existing.has('status')) db.exec('ALTER TABLE endpoint_hits ADD COLUMN status INTEGER NOT NULL DEFAULT 0');
  if (!existing.has('payer_hash')) db.exec("ALTER TABLE endpoint_hits ADD COLUMN payer_hash TEXT NOT NULL DEFAULT 'anonymous'");
  if (!existing.has('duration_ms')) db.exec('ALTER TABLE endpoint_hits ADD COLUMN duration_ms INTEGER');
  if (!existing.has('user_agent')) db.exec("ALTER TABLE endpoint_hits ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''");
  if (!existing.has('created_at')) db.exec("ALTER TABLE endpoint_hits ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_endpoint_hits_endpoint_created ON endpoint_hits(endpoint, created_at)');
}

/**
 * Payment webhooks: merchants register HTTPS URLs that receive a signed
 * POST when an invoice is settled (payment.settled event).
 */
function migratePaymentWebhooks(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_webhooks'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE payment_webhooks (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'account_id INTEGER NOT NULL REFERENCES accounts(id), ' +
        'url TEXT NOT NULL, ' +
        'secret TEXT NOT NULL, ' +
        "events TEXT NOT NULL DEFAULT 'payment.settled', " +
        'active INTEGER NOT NULL DEFAULT 1, ' +
        'created_at TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_payment_webhooks_account_id ON payment_webhooks(account_id)');
  }
}

/**
 * Preview cache: stores successful preview results keyed by normalized URL
 * and a content hash. Enables sub-50ms responses for repeat preview requests
 * (e.g., demo URLs like example.com, Wikipedia, etc.).
 */
function migratePreviewCache(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preview_cache'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE preview_cache (' +
        'url TEXT NOT NULL, ' +
        'hash TEXT NOT NULL, ' +
        'preview_json TEXT NOT NULL, ' +
        'hit_count INTEGER NOT NULL DEFAULT 1, ' +
        'created_at TEXT NOT NULL, ' +
        'expires_at TEXT NOT NULL, ' +
        'PRIMARY KEY (url, hash))',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_preview_cache_expires ON preview_cache(expires_at)');
  }
}

/**
 * Landing page conversion tracking: granular event storage for the HN launch
 * funnel. Stores event name, JSON metadata (URL, word counts, etc.), referrer,
 * user-agent hash, and IP hash. Fresh databases carry the table via schema.sql;
 * pre-existing databases gain it here.
 */
function migrateTrackingEvents(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracking_events'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE tracking_events (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'event TEXT NOT NULL, ' +
        'meta_json TEXT, ' +
        'referrer TEXT, ' +
        'user_agent TEXT, ' +
        'ip_hash TEXT, ' +
        'created_at TEXT NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_tracking_events_event_created ON tracking_events(event, created_at)');
  }
}

/**
 * Trial claims: one free trial per wallet per endpoint (capture, extract,
 * audit, map-lite, analyze). Fresh databases carry the table via schema.sql;
 * pre-existing v1 databases (payer PRIMARY KEY, capture-only) are migrated
 * here, preserving each row as a 'capture' claim (idempotent). Exported for
 * the migration unit test; production goes through openDb.
 */
export function migrateTrialClaims(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS trial_claims (' +
      'payer TEXT NOT NULL, ' +
      'endpoint TEXT NOT NULL, ' +
      'created_at TEXT NOT NULL, ' +
      'PRIMARY KEY (payer, endpoint))',
  );
  const cols = tableColumns(db, 'trial_claims');
  if (!cols.has('endpoint')) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS trial_claims_v2 (' +
        'payer TEXT NOT NULL, ' +
        'endpoint TEXT NOT NULL, ' +
        'created_at TEXT NOT NULL, ' +
        'PRIMARY KEY (payer, endpoint))',
    );
    db.exec(
      "INSERT OR IGNORE INTO trial_claims_v2 (payer, endpoint, created_at) " +
        "SELECT payer, 'capture', created_at FROM trial_claims",
    );
    db.exec('DROP TABLE trial_claims');
    db.exec('ALTER TABLE trial_claims_v2 RENAME TO trial_claims');
  }
}

/**
 * No-wallet faucet budget: daily per-IP-hash thumbnail count. Fresh databases
 * carry the table here (idempotent); rows for past days are pruned on read.
 */
function migrateFaucetDays(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS faucet_days (' +
      'ip_hash TEXT NOT NULL, ' +
      'day TEXT NOT NULL, ' +
      'count INTEGER NOT NULL, ' +
      'PRIMARY KEY (ip_hash, day))',
  );
}

/**
 * Additive, idempotent migration for the feedback table: fresh databases
 * carry it via schema.sql; pre-existing database files gain the table (or any
 * missing nullable column) here so they stay valid without a wipe. The raw
 * payer and contact are never stored, only their sha256 hashes.
 */
function migrateFeedback(db: Db): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback'")
    .get() as { name: string } | undefined;
  if (table === undefined) {
    db.exec(
      'CREATE TABLE feedback (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'category TEXT NOT NULL, ' +
        'message TEXT NOT NULL, ' +
        'endpoint TEXT, ' +
        "payer_hash TEXT NOT NULL DEFAULT 'anonymous', " +
        "user_agent TEXT NOT NULL DEFAULT '', " +
        "contact_hash TEXT NOT NULL DEFAULT 'anonymous', " +
        "source TEXT NOT NULL DEFAULT 'http', " +
        "created_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category)');
    return;
  }
  const existing = tableColumns(db, 'feedback');
  if (!existing.has('category')) db.exec("ALTER TABLE feedback ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  if (!existing.has('message')) db.exec('ALTER TABLE feedback ADD COLUMN message TEXT NOT NULL DEFAULT \'\'');
  if (!existing.has('endpoint')) db.exec('ALTER TABLE feedback ADD COLUMN endpoint TEXT');
  if (!existing.has('payer_hash')) db.exec("ALTER TABLE feedback ADD COLUMN payer_hash TEXT NOT NULL DEFAULT 'anonymous'");
  if (!existing.has('user_agent')) db.exec("ALTER TABLE feedback ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''");
  if (!existing.has('contact_hash')) db.exec("ALTER TABLE feedback ADD COLUMN contact_hash TEXT NOT NULL DEFAULT 'anonymous'");
  if (!existing.has('source')) db.exec("ALTER TABLE feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'http'");
  if (!existing.has('created_at')) db.exec("ALTER TABLE feedback ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category)');
}

/**
 * Rolling free-allowance budget: one row per granted free call, so the window
 * is a real slide (expire-and-count) rather than a calendar bucket. Fresh
 * databases carry the table here (idempotent); expired rows are pruned on every
 * check, so it stays small. `cost` lets a batch consume its URL count.
 *
 * A fresh table rather than an ALTER of `faucet_days`: the faucet was a fixed
 * UTC-day thumbnail budget with a different key and shape, and it stays in place
 * (unused by the allowance path) so earlier records remain readable history.
 */
function migrateAllowanceUses(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS allowance_uses (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
      'ip_hash TEXT NOT NULL, ' +
      'ts TEXT NOT NULL, ' +
      'cost INTEGER NOT NULL DEFAULT 1)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_allowance_uses_ip_ts ON allowance_uses(ip_hash, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_allowance_uses_ts ON allowance_uses(ts)');
}
