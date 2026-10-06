# Agent income metrics — how to read them

Metrics come from the database, never from targets. Every query below runs
against the live container DB:

```bash
docker exec webcap-webcap-1 node -e "
const D=require('better-sqlite3');const db=new D('/data/webcap.db',{readonly:true});
console.log(JSON.stringify(db.prepare('<SQL>').all(), null, 2));
"
```

**`GET /v1/agent-funnel`** is the whole table below, pre-computed (public,
aggregate-only, `?hours=N` default 168 = 7 days, `?format=text` for a
terminal). Prefer it over hand-writing SQL. `GET /v1/status` carries public
aggregates; `GET /v1/admin/analytics` adds the merchant-only per-client
breakdown.

## North star

**Paid agent calls per week** and **distinct paying wallets** — a loop from one
wallet is not demand.

```sql
-- distinct paying wallets, lifetime and last 7 days
SELECT COUNT(DISTINCT payer) AS wallets FROM revenue_ledger;
SELECT COUNT(DISTINCT payer) AS wallets_7d
  FROM revenue_ledger WHERE created_at >= datetime('now','-7 days');
```

Repeat buyers (the only real signal of product-market fit for an agent):

```sql
SELECT payer, COUNT(*) n FROM revenue_ledger
 GROUP BY payer HAVING n > 1 ORDER BY n DESC;
```

## The agent funnel

| Stage | Query |
|---|---|
| Reach (discovery clients) | `GET /v1/agent-funnel` → `reach.topClients` |
| Challenge (402s on paid routes) | `GET /v1/agent-funnel` → `challenge` |
| Try (free allowance grants) | `GET /v1/agent-funnel` → `freeAllowance` |
| First pay | `SELECT COUNT(*) FROM (SELECT payer FROM revenue_ledger GROUP BY payer HAVING COUNT(*)=1);` |
| Repeat | `SELECT COUNT(*) FROM (SELECT payer FROM revenue_ledger GROUP BY payer HAVING COUNT(*)>1);` |
| Recurring | `GET /v1/agent-funnel` → `recurring.activePaidWatches` |
| Feedback (what agents say) | `SELECT COUNT(*) FROM feedback;` (newest first: `GET /v1/feedback/list` merchant view) |

## Attribution

`endpoint_hits.user_agent` is stored raw (trimmed, 200-char cap) so discovery
crawlers can be separated from paying agents. Named crawlers observed so far:
`CarbonMonitor`, `402explorer`, `x402-observer`, `x402-census-probe`,
`forum-labs-trust-prober`, `Gold-402-Verifier`. Treat these as reach, never as
customers.

`endpoint_hits.payer_hash` is a 16-char sha256 slice — never the raw address.
Join to revenue by hashing, not by address.

## Reading rules

- A rising 402 count with flat `revenue_ledger` is **probe noise**. Ignore it.
- Landing-page funnel numbers (`/v1/funnel`: `landing_view`, `preview_submit`)
  describe a path the customer base does not use. Do not optimise them.
- If `revenue_ledger` is empty for a period, revenue was zero. Say so.
