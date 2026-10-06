# webcap is agent-first — the customer charter

**Status:** authoritative. If any other document, plan, or stale draft disagrees
with this file, this file wins.
**Owner:** whoever holds the repo. **Last rewritten:** 2026-09-22 (takeover).

---

## 1. The customer (non-negotiable)

webcap's customer is an **autonomous agent** — an LLM, bot, or automated system
that calls the API on its own behalf, without a human in the loop, and pays for
the call programmatically.

That means, concretely:

- The buyer is software: an agent runtime, an MCP client, a scheduler, a
  CI/data pipeline, an agent framework loading tool manifests.
- The **decision to pay** is made by code, on-machine, using a machine
  protocol (x402 / MPP) — not by a human reading a pricing page.
- The **unit of value** is a single unattended call that returns usable output
  (a PNG artifact URL, structured JSON, a diff/webhook), not a dashboard,
  trial signup, or sales call.
- The **humans we serve** are the ones who *operate agent fleets* (developers
  wiring tools into agents, teams running monitoring bots). They are a
  distribution channel to agents, not a separate consumer product.

**Not the customer:** humans browsing a landing page, Hacker News readers,
SEO consultants clicking a web UI, "Show HN" upvotes, Discord communities.
Those audiences may exist incidentally. They are never the plan.

### The one-sentence test

Before any change, ask: **"Does this make it more likely that an autonomous
agent discovers webcap, pays for a call, and calls again — with no human
involved?"** If the answer is no, it is not a priority, however good it looks
in a marketing deck.

---

## 2. What the data actually says

These are the numbers at takeover (2026-09-22), read from the live container's
`/data/webcap.db` and `/v1/status`. They are the reason this charter exists.
Evidence refreshed 2026-09-23 and again 2026-09-25; the shape has not changed
(third column).

| Signal | Takeover | 2026-09-23 | 2026-09-25 | Meaning |
|---|---|---|---|---|
| Lifetime endpoint hits | 52,066 | 58,927 | 68,133 | Discovery is **not** the bottleneck |
| Lifetime paid calls | **1** (`revenue_ledger`) | **1** | **1** | Income is ~zero |
| Lifetime revenue | **$0.01** USDC (`revenue_ledger`) | **$0.01** | **$0.01** | One $0.01 extract on 2026-09-14 |
| Stripe payments / invoices | 0 / 0 | 0 / 0 | 0 / 3 (all dev account, expired) | Card rail unused |
| Trial claims | 2 (1 capture, 1 extract) | 3 | 6 (mostly our own harness) | Trials are almost untouched |
| Watches active | 0 | 0 | 0 | The recurring rail has no demand |
| `POST /v1/x402/capture` hits | 11,099 of 11,348 are `402` | 11,141 of 11,142 are `402` | 12,363 of 12,363 are `402` | Probed constantly, paid ~never |
| Capture probe rate (7d) | steady ~720/day | ~749/day | ~733/day | A **monitoring heartbeat**, not customers |
| Extract probe rate (7d) | — | ~586/day `402` | ~589/day `402` | Newer probe interest, same non-payment |
| Human landing funnel (24h) | 14 views → 0 previews | — (dead path, no longer tracked) | — (dead path, no longer tracked) | The human path is dead |
| Waitlist | 2 emails | 2 emails | 2 emails | Human signups are noise |

The single lifetime paid call is `revenue_ledger` row id 8: payer
`0xe3Badbd4f38214b9Eae528a1a5398f6678f63fB3`, endpoint `extract`, 10,000 USDC
units = **$0.01**, created 2026-09-14T19:53:05Z. That payer is not the merchant
wallet (`0xB25572...`), not `X402_CUSTOMER_PRIVATE_KEY` (`0xBAc498...`) and not
`X402_DOGFOOD_PRIVATE_KEY` (`0xDC879f...`), so the "1 lifetime paid call" is a
genuinely external, if tiny, customer signal. Of the 6 `trial_claims` rows, one
(`0xdc879f...`) is our own dogfood wallet, and three land inside one second on
2026-09-24 (04:56:36.730Z, 04:56:37.268Z, 04:56:37.594Z, sweeping
audit/extract/capture), the signature of our own `node` harness rather than
three independent agents. Six therefore overstates genuine external trial
interest. **The trial rail itself was retired on 2026-10-06** — wallet-signed
claims were friction a bot could not clear, so free access is now a rolling
per-IP allowance (`allowance_uses`), whose grants are the funnel's no-cost
step. The `trial_claims` numbers above are frozen history, not a live signal. The 3 `invoices` rows all belong to account_id 2, the hardhat dev
account `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`; their status is `open`
but they are long expired, so they are not customer invoices.

Clients seen in `endpoint_hits.user_agent` (7d to 2026-09-25): `CarbonMonitor/0.1`
healthcheck, `402explorer/0.1`, `x402-observer/1.0`, `x402-census-probe/2.1`,
`forum-labs-trust-prober/1.0`, `hermes-contact-discovery/1.0`,
`enclave402/verifier`, `x402watch/1`, `dexter-api/x402-schema-fetcher`,
`Dexter-Verifier/1.0`, `mako-pulse-prober/0.1`, `litebeam/0.4.1`
registry-sync, `BrickBlueBot/0.1` (agentic-web registry), `x402-client/1.0`,
`x402-reliability-probe/1.0`, plus `curl`/`node`.
Every named client is a discovery/trust **crawler**, not a paying agent,
with two footnotes: `x402-client/1.0` probed `POST /v1/x402/extract` 42x (402,
never paid) and `BrickBlueBot` POSTed `/` 91x (405s), which is why `POST /`
now answers 405 in the error envelope with a catalog pointer instead of the
framework default.

### The conclusion, stated plainly

webcap has solved **discovery** (it is registered with 402index, x402scan,
mppscan, CDP Bazaar, and crawled continuously) and has **zero paying demand**.

The steady ~720 capture 402s per day are robots verifying that the endpoint
exists. Optimising the challenge body for them cannot create revenue. The
problem to solve is **demand from agents that hold a wallet and a task** — and
the operators who fund them. Discovery work from here is only worth doing when
it lands webcap inside a runtime where a funded agent will actually call it.

---

## 3. North-star metric

**Primary: paid agent calls per week** — the count of settled paid invocations
by distinct payer wallets. Tracked from `revenue_ledger` (one row per settled
call, payer present).

**Guardrail: distinct paying wallets.** A single wallet looping is not demand.
Report both. A week with 100 calls from 1 wallet is a worse week than 5 calls
from 5 wallets.

**Secondary (funnel health, not vanity):**

| Stage | Definition | Source |
|---|---|---|
| Reach | distinct discovery clients hitting a discovery surface | `endpoint_hits.user_agent` on `/.well-known/*`, `/llms.txt`, `/skill.md`, `/v1/x402/service` |
| Challenge | 402 responses on a paid route | `endpoint_hits.status = 402` |
| Try | free product calls granted inside the rolling per-IP allowance | `allowance_uses` |
| First pay | wallets with exactly one `revenue_ledger` row | `revenue_ledger` |
| Repeat | wallets with >1 `revenue_ledger` row | `revenue_ledger` |
| Recurring | active watches with credits > 0 | `watches` |

**Anti-metrics (never present these as progress):** raw endpoint hits, raw 402
count, discovery-crawler request volume, landing-page views, HN/Reddit upvotes,
"MRR" computed from a target rather than from settled calls.

---

## 4. Decision rules for anyone who owns this repo

These are the standing rules. They exist so the project's focus survives a
change of agent, human, or mood.

**Do:**

1. **Make the machine path shorter, not the human path prettier.** Every paid
   route must be reachable and payable by an autonomous client with no account,
   no email, and no API key. Keep the flow: `402` → sign → retry → settled.
2. **Keep every machine-readable surface true.** `/.well-known/x402`,
   agent card, `llms.txt`, `skill.md`, `openapi.json`, `/v1/x402/service`, and
   the MCP/OpenAI tool manifests must agree on paths, methods, prices, and the
   payment flow. A surface that lies to an agent costs a real call.
3. **Instrument the agent funnel.** A change is not "done" until its effect is
   visible in `revenue_ledger`, `allowance_uses`, or `endpoint_hits` attribution.
4. **Price for unattended spend.** Prefer flat, per-call, batch-friendly, and
   prepaid-credits pricing that a bot can budget. Never introduce a
   subscription or seat a machine cannot buy.
5. **Favour rails that let an agent pay without assumptions**: x402 USDC
   (Base) and MPP. Card/Stripe is a fallback for human operators funding a bot,
   never the primary rail.
6. **Land inside runtimes.** Distribution that matters is being loadable by an
   agent framework (MCP server, OpenAI function manifest, A2A card, an
   installable package — distributed via GitHub release, never npm — and
   directory listing). Directory registration is worth doing only
   because runtimes read those directories.

**Don't:**

7. **Don't plan human launch campaigns** (HN/Reddit/Dev.to/SEO-pro) as the
   growth engine. Dated launch copy is archived history; do not rewrite it and
   do not resurrect it as strategy.
8. **Don't add friction a bot cannot clear** — email capture, waitlists,
   "contact sales", dashboards, CAPTCHAs, or account creation in the paid path.
9. **Don't report targets as results.** `£1,000 MRR` was a goal, not a metric.
   Metrics come from the database.
10. **Don't chase probe traffic.** Optimising for the crawler heartbeat
    (hundreds of 402s/day that never pay) is false progress. Verify it still
    works, then ignore it.

**Resolved (2026-09-25, previously flagged):** the 402 challenge served on a
`GET` probe once advertised `info.input.method = "GET"` while only `POST` was
registered and payable, which could teach a machine-readable directory to
replay `GET` forever. Every paid route now serves both forms from one handler:
`registerPaidRoute` in `src/server/query-body.ts` registers `app.post(path,
handler)` and `app.get(path, { exposeHeadRoute: false, preValidation:
bodyFromQuery }, handler)`, so the advertised method matches the verb actually
served and payable (`exposeHeadRoute: false` keeps `HEAD` unserved because it
is not in the route table). The live extract 402 now reports
`extensions.bazaar.info.input.method = "GET"` with a working GET route behind
it. The invariant is pinned by `tests/api/paid-get.test.ts` and
`tests/e2e/x402.get-form.test.ts`.

---

## 5. Strategy in one paragraph

Discovery is done; **demand is the job**. The next phase is therefore to (a)
put webcap where funded agents already run — MCP registries, agent frameworks,
tool manifests, and the directories those runtimes read; (b) shrink the
distance from "agent sees the endpoint" to "agent's first settled call" (free
trials that need only a signature, MPP as a second rail, prepaid credit packs);
and (c) measure all of it from `revenue_ledger` and `allowance_uses` rather
than from hit counts. Everything else — human marketing, landing-page polish, probe
optimisation — is out of scope until a paying agent loop exists.

---

## 6. Owner protocol

Every new owner of webcap (agent or human) must:

1. **Read this charter first.** It supersedes dated plans.
2. **Start from the evidence**, not from the previous plan's optimism:
   `/v1/status`, `revenue_ledger`, `allowance_uses`, and
   `endpoint_hits.user_agent`.
3. **Keep exactly one strategy source of truth** — this file. Update its
   evidence section when the numbers move; do not fork a new master plan.
4. **Archive, never silently rewrite, superseded docs.** Genuine superseded
   docs belong under `docs/archive/` as historical record. (2026-09-23
   exception, recorded not rewritten: the human-first launch apparatus was
   test fiction, not real history, so it was deleted from the repo rather
   than archived. Do not reintroduce it.)
5. **Re-run the test suite before claiming a change works.** See `AGENTS.md`.

If a future owner believes the customer is no longer an agent, that is a
company-level decision. It requires changing **this file first**, in a commit
that says so, so the change is visible and deliberate.
