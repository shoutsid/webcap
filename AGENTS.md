# Webcap Development Guide

## Customer mandate (non-negotiable)

**The customer is an autonomous agent** — an LLM, bot, or automated system that
calls the API and pays for the call programmatically, with no human in the
loop. Everything in this repo exists to make that loop happen more often.

Read [`docs/strategy/agent-first.md`](docs/strategy/agent-first.md) before
changing product behaviour, pricing, or any agent-facing surface. It is
authoritative and supersedes any dated plan.

Standing rules every agent or human owner must follow:

1. Optimise the **machine** path (402 → sign → retry → settled), never the
   human landing-page path.
2. Every machine-readable surface (`llms.txt`, `skill.md`, `openapi.json`,
   `/.well-known/x402`, agent card, MCP/OpenAI tool manifests,
   `/v1/x402/service`) must agree on paths, methods, prices, and the payment
   flow. A surface that lies to an agent costs a real call.
3. A change is not done until its effect is measurable in `revenue_ledger`,
   `allowance_uses`, or `endpoint_hits` attribution (see
   `docs/strategy/metrics.md`).
4. Never introduce friction a bot cannot clear (accounts, email, waitlists,
   CAPTCHAs, sales contact) into the paid path.
5. Do not plan human launch campaigns (HN/Reddit/Dev.to/SEO) as the growth
   engine, and never rewrite archived history. Dated docs live under
   `docs/archive/`.
6. Never report a target as a result. Metrics come from the database.

If you believe the customer is no longer an agent, change
`docs/strategy/agent-first.md` first, in a commit that says so — do not fork a
new plan or quietly drift.

## Project Structure
- `src/server/pages/` - HTML page generators (TypeScript)
  - `css.ts` - All CSS styles with light/dark theme support
  - `chrome.ts` - Top bar, footer, theme toggle, scroll detection
  - `landing.ts` - Landing page
  - `og-debugger.ts` - OG debugger tool
  - `format.ts` - Text helpers
  - `copy.ts` - Chain-conditional copy
- `src/server/pages.ts` - Artifact page + re-exports

## Theme System
- Light theme defined in `:root` (default)
- Dark theme via `@media(prefers-color-scheme:dark)` for system preference
- Manual override via `html[data-theme="dark"]` and `html[data-theme="light"]`
- Theme toggle button in nav bar persists to localStorage
- Scroll fade indicator on terminal blocks (`.term.is-scrollable::after`)

## Rebuild & Deploy (Docker)
```bash
# 1. Build TypeScript
npm run build

# 2. Rebuild Docker image
docker compose build webcap

# 3. Restart container
docker compose up -d webcap

# 4. Verify
curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/
```

## Take Screenshots
```bash
node screenshots/screenshot.mjs
```
- Saves to `screenshots/` directory
- Captures light/dark themes for desktop and mobile
- Requires Google Chrome at `/usr/bin/google-chrome`

## Environment Variables
Key ones from `.env`:
- `WEBCAP_PUBLIC_BASE_URL` - Public URL for artifacts
- `WEBCAP_CHAIN` - Network (base, base-sepolia, local)
- `WEBCAP_PORT` - Server port (default 8080)

## Tests
```bash
npm test           # Run all tests
npm run typecheck  # Type checking only
```
- WCAG contrast test validates `--faint` has >= 4.5:1 contrast against `--bg`

## Daily Check
```bash
docker cp scripts/daily-check.mjs webcap-webcap-1:/app/daily-check.mjs
docker exec -w /app webcap-webcap-1 node daily-check.mjs
```
Prints the day's endpoint hits, x402 challenges, 5xx, revenue/free-allowance/
feedback lifecycle and a 7-day trend straight from the live DB, ending with an
ATTENTION block for anything that needs a reaction. Runs readonly; flags
`--db <path>`, `--date YYYY-MM-DD`, `--days N`, `--json` (see the script
header). Add new sections as plain functions in `scripts/daily-check.mjs`.

## CSS Architecture
- `BASE_CSS` - Shared design tokens + primitives (top bar, footer, buttons, terminal)
- `LANDING_CSS` - Landing-specific (hero grid, pricing cards, steps, links)
- `ARTIFACT_CSS` - Artifact page (breadcrumb, meta grid, frame)
- `OG_DEBUGGER_CSS` - OG debugger (form, preview card, tag table)

## Key Design Decisions
1. **Hero layout**: Uses `.hero-inner` grid (text left, terminal right)
2. **Code blocks**: `overflow-x:auto` on `.term`, fade indicator via `::after` pseudo-element
3. **Theme toggle**: SVG icons (sun/moon), not emoji, for consistent rendering
4. **Mobile**: Kicker badge shrinks, steps list adjusts padding, code font reduces
