# Agent-first roadmap

Sequenced by one question: **what most increases settled paid calls from
autonomous agents?** Read `docs/strategy/agent-first.md` first — that charter
defines the customer and the rules; this file only sequences the work.

Evidence baseline (refreshed 2026-09-25): discovery solved, demand ~zero, 1
lifetime paid call ($0.01, external payer), 6 trial claims (one is our dogfood
wallet and three look like our own harness, so read the number as inflated), 0
active watches. See the charter for the full table.

---

## Phase 0 — Tell the truth, then measure it (now)

The product already has excellent agent surfaces; one operational gap remains.

- [x] **Advertise MPP inside `llms.txt` and `skill.md`.** MPP is live
      (`WWW-Authenticate: Payment`, `x-payment-info`) but the two documents an
      LLM actually reads never mentioned it — an MPP-native agent read the
      x402-only story and left. *Shipped in this takeover.*
- [x] **Agent-income funnel analytics.** Shipped: `GET /v1/agent-funnel`
      (public, aggregate-only) reports reach → challenge → free allowance →
      paid → retention → recurring in one call, derived from `endpoint_hits`
      (with `user_agent` attribution), `allowance_uses`, `revenue_ledger`,
      `watches`.
      Replaces the dead human path (`/v1/funnel`) as the number that matters.
      *Acceptance met: distinct paying wallets and client reach are one request
      away, no SQL.*
- [x] **Re-register the post-cutover origin.** Listings key on host, so
      `webcap.shoutsid.fyi` had to be re-asserted everywhere after the cutover.
      402index re-asserts itself (cron q6h, green 2026-09-23 06:00), x402scan
      was re-registered at cutover (origin `webcap.shoutsid.fyi`, 9 resources,
      SIWX), and mppscan is now registered for the new origin (`registered: 65,
      failed: 0`, 2026-09-23) — its audit also exposed 10 operations with no
      declared auth mode, which it silently skips; every operation now declares
      one (`apiKey`, `x-payment-info`, or explicit `security: []`), a test pins
      it, and the re-audit is clean (10 warnings → 1: the remaining
      `L2_ROUTE_COUNT_HIGH`, our 75 advertised operations).
      **CDP Bazaar was the last open piece.** Its index is keyed by full URL
      and only a **settled payment** adds or keeps an entry — there is no
      registration API, and the facilitator rejects self-sends
      (`self_send_not_allowed`), so the keepalive's $0.001 self-settlement can
      never do it; the two indexed entries are both the retired ngrok host.
      *Dropped 2026-09-26 (owner decision): the owner will not fund a
      non-merchant payer wallet, so this entry is permanently closed. The
      keeper cannot settle (the facilitator rejects self-sends), and the two
      indexed entries are the retired ngrok host anyway, so the 30-day
      no-settlement rule delists them around 2026-10-14 / 2026-10-05 —
      accepted. No customer revenue is affected: Bazaar is one of several
      directories, and a settled payment from an actual customer wallet would
      still re-index the current host if one ever lands.*
      Infra 2026-09-27: the **ngrok backup tunnel is gone from production
      entirely** (owner decision — the stable domain is the only edge now).
      Removed: the every-minute + `@reboot` ngrok-watchdog cron entries, the
      `bin/ngrok` binary and watchdog script, `logs/ngrok.log`,
      `state/ngrok-dead.count`, `ngrok.pid`, and `WEBCAP_FALLBACK_URL` from
      `.env`. The app never read the fallback var, so no restart was needed.
      Verified after removal: `https://webcap.shoutsid.fyi` serves health
      200, paid routes answer 402, and `POST /mcp` answers `initialize` —
      all through the Cloudflare tunnel alone (cron now holds only the
      cf-tunnel watchdog). `docker-compose.yml` notes the change; the ngrok
      URL in `artifacts/PROOF.md` stays as recorded history.

- [x] **Cut the tool surface from 18 to 9, and answer the readability audit.**
      mcpmetrics.io measured `tools/list` at 18 tools and scored its first
      agent-readability audit 85: `webcap_service` was vague, `webcap_extract`
      did not say `url` and `urls` were alternatives, the trial tools did not
      report a malformed `signature`, and `maxUrls` did not state its default.
      A wide surface is itself a readability problem — every extra tool is
      another chance for an agent to pick wrong — so capabilities that differ
      only by a mode are now one tool with a mode parameter:
      `webcap_service_catalog` absorbs `webcap_health` and `webcap_trial_status`
      (optional `payer`), `webcap_preview` absorbs `webcap_quick_thumbnail`
      (`thumbnail: true`), the five per-product claim tools are one
      `webcap_trial` (`product`), and `webcap_video` is `webcap_capture` with
      `format: mp4|webm`. `webcap_agent_funnel` (operator telemetry broadcast to
      anonymous callers) and `webcap_feedback` (a support rail no URL-to-artifact
      job needs) left the tool surface, though both REST routes remain.
      `webcap_extract` declares `oneOf url|urls` and rejects both, `payer` and
      `signature` are validated locally with the exact message to sign, and every
      bounded field states its default.
      *Acceptance met: `tools/list` advertises 9 tools on all four surfaces, the
      agreement test pins names **and** parameter shapes, and the deployment is
      dual-era — `server/discover` plus per-request `_meta` for 2026-07-28
      clients, `initialize` for older ones — so it no longer reads as
      legacy-only.*

- [x] **Replace the trial rail with a rolling free allowance per IP.** The
      wallet-signed trial was still friction: an agent had to hold a wallet and
      produce an EIP-191 signature before it could try anything, which is the
      one thing the charter says never to put in front of a bot. Free access is
      now an allowance, not a tool — an unpaid POST to any product path
      (`capture`, `extract`, `audit`, `map-lite`, `video`, `analyze`) runs the
      real product inside a rolling per-IP window (default 50 calls / 24h), and
      the response carries `x-webcap-allowance-*` headers. When the window is
      spent the same call answers the normal x402 402 challenge, so the paid
      path is unchanged and the caller needs no new code. This is deliberately
      generous growth spend: at the $0.0002 amortized compute cost, 50 calls/day
      is ~$0.01 of compute per IP per day, bounded by a fleet-wide circuit
      breaker (`WEBCAP_ALLOWANCE_GLOBAL_LIMIT`). Two costs are stated rather
      than hidden: an IP is not an identity (proxies can mint windows — the
      accepted price of removing wallet friction), and a free 50-URL extract
      batch would cost as much as its price, so free batches cap at 10 URLs
      while single URLs are uncapped. The retired rails are gone, not shimmed:
      `trial-auth.ts`, `db/trials.ts`, the seven `/v1/x402/trial*` routes, the
      `webcap_trial` tool and the `trial_claims` funnel stage.
      *Acceptance met: `allowance_uses` is the new Try stage in
      `GET /v1/agent-funnel` and in the charter's metrics table; the tool
      surface is 8 tools; and `tests/api/allowance.test.ts` proves a granted
      call bypasses both the x402 and MPP paywalls, that a failed call does not
      consume the budget, and that a caller-supplied marker header cannot mint
      a free call.*

## Phase 1 — The first paying agent loop

Goal: one funded agent, calling unattended, more than once.

- [~] **Publish to where agents load tools.** An installable stdio MCP server
      now ships (`src/mcp/`, `npm run mcp` / the `webcap-mcp` bin), exposing all
      six paid endpoints plus five free ones as tools, auto-paying via x402 when
      a wallet key is configured. Packaging is now verified end-to-end: the
      tarball is 333 kB / 250 files (was 20 MB / 582 — a `files` whitelist),
      `npm run build` copies `dist/db/schema.sql` so `node dist/main.js` boots
      (previously the Dockerfile patched that by hand), and an installed tarball
      passes a real MCP handshake.
      Shipped and verified live 2026-09-25: a remote **Streamable-HTTP MCP
      endpoint at `POST /mcp`** (`src/mcp/http.ts`, registered in `buildApp`).
      An MCP host points at the URL with no install, no package, no account:
      `{"mcpServers":{"webcap":{"url":"https://webcap.shoutsid.fyi/mcp"}}}`.
      Verified against the running container: `initialize` echoes the requested
      revision, `tools/list` returns all 11 tools, a free tool executes for
      real (`webcap_preview` returned example.com's title), a notification-only
      body answers `202`, and a paid tool returns the live x402 402 challenge
      (payTo, `10000` units, and a pointer to pay over HTTPS) because the
      endpoint holds no wallet of its own. `GET /mcp` is 405 with `Allow: POST`
      on purpose: the server never opens a server-initiated SSE stream, and
      advertising one would be a surface that lies.
      Every surface agrees: `openapi.json` (75 paths), the
      `/.well-known/mcp-tools.json` manifest (a new `mcp` block), `llms.txt`,
      `skill.md`, `AGENT.md` and the README. `server.json` is committed for the
      official MCP Registry, carrying a `streamable-http` `remotes` entry and no
      `packages` (the npm path is not published, so claiming a package would be
      a lie); it is validated against the registry's published schema, and
      `tests/unit/mcp-registry-manifest.test.ts` pins its name, version,
      100-character description limit and the remote path the app serves. The
      registry accepts remote servers, so publishing no longer strictly needs an
      npm token.
      Measurable, as rule 3 requires: MCP calls land in `endpoint_hits` with the
      caller's user agent (`POST /mcp` plus the nested paid route's 402), and
      the caller's address is forwarded into the nested request so free-tool
      budgets stay per caller instead of collapsing into one shared loopback
      bucket (`tests/api/mcp-http.test.ts`, verified to fail without that
      forwarding). `BrickBlueBot` had already probed `POST /mcp` 6x against the
      404 while it was still source-only, which is the one piece of evidence
      that an agent wanted this before it existed. Its full probe list is worth
      reading as a spec: it also asked for `GET /.well-known/mcp.json` six times
      and got a 404, so that descriptor now exists
      (`src/server/catalogs.ts` -> `mcpDescriptor`), naming the transport, the
      auth mode, the payment flow and the registry listing. It probed three
      other endpoint spellings too (`/api/mcp`, `/mcp/v1`, `/sse`); those are
      deliberately not aliased, because one canonical endpoint plus a descriptor
      that names it is the honest design, and duplicating routes to reward path
      guessing would put three more operations in the catalog for no gain.

      The tool catalogs also disagree before this pass and now do not: the two
      manifests listed 9 tools, all free, and not one paid product, while the
      MCP server listed 11 including every product and no trial; their
      intersection was two tools. `src/server/tool-catalog.ts` is now the single
      source for membership, schemas and endpoints (19 tools: 13 free including
      the 6-tool trial rail plus webcap_feedback, 6 paid), all three surfaces are derived from it,
      and `tests/unit/tool-catalog-agreement.test.ts` fails if they drift
      again. The agent card and mcp-tools manifest also claimed version 1.1.0
      while `/v1/status`, the package and MCP `initialize` said 0.1.0; there is
      now one version.
      Published to the official MCP Registry on 2026-09-25, no npm token
      involved: `io.github.shoutsid-lab/webcap` version 0.1.0, status `active`,
      discovered through the registry's own API
      (`GET https://registry.modelcontextprotocol.io/v0/servers?search=webcap`)
      and resolved end to end from that listing to the advertised remote:
      the registry entry points at `https://webcap.shoutsid.fyi/mcp`, which
      answers `initialize` (11 tools). `mcp-publisher validate` confirms
      `server.json` against the live registry, and
      `tests/unit/mcp-registry-manifest.test.ts` pins the name, version,
      description limit and that the advertised path answers.
      Distribution 2026-09-26 (owner decision; npm permanently out): the
      stdio flavor now ships as a GitHub release instead — `v0.1.0`
      (https://github.com/shoutsid-lab/webcap/releases/tag/v0.1.0) carries the
      built tarball (`shoutsid-webcap-0.1.0.tgz`, 383 kB / 271 files), so a
      self-hoster embeds it with `npm install <release tarball URL>` — no npm
      registry account, no token. The no-install remote endpoint
      (https://webcap.shoutsid.fyi/mcp) remains the primary distribution.
      Remaining: register with the agent-tool directories that are not the
      MCP Registry.
      Progress 2026-09-27: **mcpbeat** (mcpbeat.com) is actively crawling our
      discovery surfaces (135 requests on 2026-09-27, holding elsewhere) but
      has not indexed webcap ("not found" on its site). Registration is
      login-gated (submission needs a human browser session), so it joins the
      owner-action directory list: mcpbeat, then smithery / mcp.so / PulseMCP.
      One more data point on who "discovery" is: of the 12,213 x402
      challenges served in the last 7 days, essentially all came from the
      x402 ecosystem's own monitors and verifiers (x402-observer, enclave402, 402explorer, GolemreachTrustBot, KnownGood-Verifier, CarbonMonitor) —
      measurement traffic that probes the paid path and never signs. Zero
      trial claims or payments in that window; the funnel's reach and
      challenge stages are fed by this census, not by buyers yet.
      Progress 2026-09-26: **Glama** (the largest MCP directory, glama.ai,
      90k+ servers) had already discovered and indexed webcap as a healthy
      remote connector (`io.github.shoutsid-lab/webcap`, 19 tools, last tested
      today) — its crawler probing `/.well-known/glama.json` 21x showed it was
      checking ownership. webcap is now **claimed and verified** on Glama:
      the claim token is wired as `WEBCAP_GLAMA_CLAIM`, served as Glama's
      connector.json schema at `/.well-known/glama.json` on the connector
      origin (config-gated, so an unclaimed deployment 404s), verified live
      over `https://webcap.shoutsid.fyi/.well-known/glama.json`. The directory
      API confirmed it on 2026-09-26 18:39Z: `publisherProfile` is populated
      (`operatorName shoutsid`, `operatorWebsite webcap.shoutsid.fyi`,
      `evidenceStatus publisher-declared`, endpointUrl verified), which is the
      field that is null on unclaimed connectors. Two tokens are distinct on
      purpose: the directory API key is a read credential and stays out of
      the public file; the claim file holds only the `glama_claim_...`
      ownership token Glama's schema accepts. The claim survives Glama's
      periodic re-crawl as long as the token stays published.
      Remaining: any further directory that is not the official MCP Registry
      or Glama (npm distribution permanently dropped — see above).
      *Acceptance: met for the MCP path — any MCP host can wire webcap from the
      registry listing alone, with no npm token and nothing read from our docs.*
- [x] **A feedback loop the customer can use.** An agent that hits a confusing
      challenge or a missing feature now has a one-request channel:
      `POST /v1/feedback` (message 8-4000 chars; optional category
      bug|suggestion|pricing|docs|integration|other and the endpoint in use).
      Free, no account, rate-limited 60/hr per client, `payer`/`contact`
      hashed before storage. The human `GET /feedback` page posts to the same
      route, so both audiences share one code path. The merchant reads entries
      at `GET /v1/feedback/list`; `endpoint_hits` measures submissions.
      *Acceptance met: catalog and MCP agree on the new free tool
      (`webcap_feedback`, so the manifest list is now 19 tools and the
      agreement test pins it), the OpenAPI FREE_OPS list documents it, and
      `tests/api/feedback.test.ts` (9 tests) covers machine JSON, the urlencoded
      form, hashed payer storage, the rate limit and the merchant-only list.*
      *Remaining: none for the channel itself; the value is whatever the
      feedback says — read it.*
- [~] **Shorten trial → first pay.** *Superseded 2026-10-06: the
      wallet-signed trial rail this bullet describes was retired for the rolling
      free allowance above, so `/v1/x402/trial/status`, the trial receipts and
      `trial_claims` no longer exist. The live form of "shorten the distance to
      first pay" is the allowance's `x-webcap-allowance-*` headers plus the
      `howToPay` block on every paid surface. Kept as record.* Shipped: every
      free surface now hands over the paid path instead of dead-ending.
      `GET /v1/x402/trial/status`
      always returns the full priced catalog (`paid`), the x402 payment flow
      (`howToPay`, with the same scheme/network/asset/payTo the 402 challenge
      carries), a concrete `nextStep`, and the recurring watch path — the case
      that mattered most is the wallet that has burned all five trials, which
      previously got `available: []` and nothing else. The five trial receipts,
      the 409 and the 429s carry `howToPay` too. A test pins the advertised
      prices to the live 402 challenge so the two cannot drift.
      Shipped: the prepaid **credit pack** an operator can buy once and let the
      agent spend without re-signing per call. `POST /v1/invoice` returns the
      named pack plus `credits` and `requiredUsdc` (starter 100 credits/$0.50,
      pro 1,000/$3, max 10,000/$12; `PACKS` in `src/config/pricing.ts`), and
      card checkout sells the same packs (`CREDIT_PACKS` in
      `src/server/stripe-routes.ts`).
      *Acceptance: ≥1 wallet with a `revenue_ledger` row that previously
      appears in `trial_claims`.*
- [x] **Sell document, not chrome.** The paid extract used to walk the whole
      DOM, so an agent paid $0.01 to put cookie banners, nav and footer link
      farms into its context window. Extraction is now content-aware: a
      readability-lite score picks the page's own container (trusting
      `<article>`/`<main>`/`[role=main]`, requiring volume from heuristic
      containers), chrome subtrees are skipped, `content` reports
      {source, words, truncated}, and `options.maxContentWords` sizes the output
      to a context window. The HTTP-only preview path — the free surface an
      agent reads first — got the same treatment (article/main scope, tag-level
      chrome removal) plus `content` in its response.
      *Acceptance: met — an agent can see what it is paying for and cap it.*
- [x] **Make `402` impossible to misread.** The flagged risk was real and
      already had a victim: the x402 middleware challenges GET as well as POST
      on every paid path (deliberately — indexers probe with GET), but only POST
      was registered, so a client that answered the GET challenge retried GET
      and got `405 method_not_allowed` *after* signing. `GET /v1/x402/*`
      answered a payable 402 with nothing behind it. A real agent hit this four
      times in one session and left (endpoint_hits: payer-tagged `GET
      /v1/x402/watches/topup`, all 405). No money was taken — the middleware
      cancels settlement on any response `>= 400` — but for an automated buyer
      that is indistinguishable from a broken endpoint, and a wrapper cannot
      reason its way to the right method.
      Now every paid path serves both forms from one handler: POST keeps the
      JSON body, GET takes the same parameters in the query string (numbers and
      booleans typed, arrays/objects JSON-encoded), and `exposeHeadRoute: false`
      keeps HEAD unserved because HEAD is not in the route table and would run
      unpaid. The catalog describes both forms (derived from the POST op, so the
      price cannot disagree), `skill.md` / `llms.txt` / `openapi.json` explain
      the convention, and the claim audit probes the GET form too.
      Two guards: a test that every GET-challenged path has a GET route and no
      HEAD route (verified to fail when one is reverted to POST-only), and a
      byte-check that the catalog documents every route the router serves.
      *Acceptance: met — method, price and network now agree on every surface.*
- [x] **Sell the paid products on the prepaid rail, not just x402.** Every paid
  product (extract, audit, map-lite, video, analyze, analyze/batch) is now
  buyable with a bearer token at `POST /v1/<product>` for a uniform 1 credit
  per call — nominal $0.01/credit, pack discounts below, refunded on any
  non-200 so a 422/502 never burns a credit. The x402 handlers and the credit
  routes share the same compute cores (`product-cores.ts`, `runAnalyzeOne`),
  the credit 200s derive from the x402 response schemas (`creditOf`), and the
  OpenAPI catalog + `skill.md`/`llms.txt`/`AGENT.md`/README document the rail.
  *Acceptance: a bearer-token runtime with no signing key can buy every
  product — pinned by `tests/api/credit-products.test.ts` (21 tests).*

## Phase 2 — Recurring agent demand

The cheapest revenue is an agent that keeps calling.

- [~] **Watches as the recurring rail.** Funding is now machine-completable on
  both rails: the x402 100-run pack (`POST /v1/x402/watches/topup`) plus the
  bearer-token pack (`POST /v1/watches/{id}/topup {"runs": 100}` — 10 credits
  capture, 100 extract, x402-pack parity, atomic multi-credit spend so
  concurrent top-ups can never oversell). The webhook is already a structured
  agent feed (`WatchAlert`: watchId/url/mode/diffSummary/at/artifactUrl/
  extract/summary, generic/slack/discord channels, signed delivery).
  *Remaining: ≥1 watch with credits > 0 on live — a funded *agent* wallet is
  needed, and the owner will not fund one (no owner pre-pay, ever); the
  funnel's `recurring` stage shows any watch an agent funds itself.*
- [x] **Batch/bulk pricing an agent can budget.** One extract payment covers up
  to 50 URLs and every agent surface states the per-batch economics as the
  default research call (`skill.md` extraction notes + endpoint table,
  `llms.txt` paid table, `AGENT.md` batch economics, README batch row).
- [x] **Reliability the customer can see.** `GET /v1/status` already publishes
  uptime, 1h avg/p50 latency, error rate + 5xx breakdown, and active watches
  at a stable machine-readable URL (plus a shields.io badge at
  `GET /v1/status-badge`); verified live 2026-09-23. An operator can gate on
  `status.ok + performance.errorRate` today — no build needed.

## Phase 3 — Widen the rails

- [ ] **MPP-first agents** — treat MPP as a peer rail in every surface, not a
      footnote; the mppscan/mpp-first directory family is an independent
      addressable market.
- [ ] **Cross-chain** (Solana and others) so agents whose treasury is not on
      Base can still pay.
- [ ] **Real-time intelligence feeds** (SSE/webhook) as a product for agents
      that react, not poll.

---

## Explicitly out of scope

Human launch campaigns, HN/Reddit/Dev.to sequences, SEO-pro positioning,
landing-page conversion polish, subscriptions/seats, and any "MRR target"
that is not derived from settled `revenue_ledger` rows. The old human-first
launch apparatus was test fiction, not real history, and was deleted from the
repo — do not reintroduce it as strategy.

## How to sequence anything new

1. Name the agent behaviour it changes.
2. Name the table that will show the change.
3. If neither can be named, it is not a Phase 0–3 item.
