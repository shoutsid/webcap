# webcap

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Try%20It%20Now-brightgreen)](https://webcap.shoutsid.fyi)

**Screenshot any URL, extract structured data, monitor pages for changes** — all via a single HTTP API call. Pay-per-call with no accounts, no API keys.

```
GET  /v1/extract/preview?url=...  →  Free preview (title, headings, links)
POST /v1/x402/capture             →  PNG/JPEG/PDF screenshot + persistent link
POST /v1/x402/extract             →  Structured JSON (title, headings, markdown)
POST /v1/x402/video               →  Scroll-capture video (WebM/VP8)
POST /v1/watches                  →  Scheduled monitoring with webhook alerts
```

**Pricing**: $0.001/screenshot · $0.01/extraction batch · No subscriptions, no minimums.

## Why webcap?

| Feature | webcap | Screenshot APIs (typical) |
|---|---|---|
| **Price** | $0.001/screenshot | $0.01–0.10/screenshot |
| **Accounts required** | No | Yes |
| **API keys** | No | Yes |
| **Payment** | Card (Stripe) or crypto (USDC) | Credit card only |
| **Batch support** | Up to 50 URLs per payment | Limited |
| **Self-hostable** | Yes (Docker) | No |
| **Open source** | Yes (MIT) | No |

## Features

| Endpoint | What you get | Price |
|---|---|---|
| `POST /v1/x402/capture` | Screenshot as PNG/JPEG/PDF (base64) + persistent public artifact link + OG metadata | $0.001 |
| `POST /v1/x402/extract` | Structured page data as JSON: title, description, headings, paragraphs, links, images, word count, markdown. Batch up to 50 URLs per payment. | $0.01 |
| `POST /v1/x402/audit` | SEO basics + link/OG health in one call | $0.002 |
| `POST /v1/x402/map-lite` | Site URL list from sitemap/robots + 1-hop crawl (up to 50 URLs) | $0.002 |
| `POST /v1/x402/video` | Scroll-capture a page as WebM/VP8 video | $0.005 |
| `POST /v1/watches` | Create a scheduled monitor (free to create, prepay 100-run packs) | $0.10–$1.00/pack |

### Bearer-token rail (no signing key)

The same products are buyable with an API key: `POST /v1/register`
(`{"address"}` → `{apiKey}`), fund with a plain USDC transfer via
`POST /v1/invoice`, then send `Authorization: Bearer <apiKey>` to
`POST /v1/extract`, `POST /v1/audit`, `POST /v1/map-lite`, `POST /v1/video`,
`POST /v1/analyze`, or `POST /v1/analyze/batch`. Every call costs 1 credit,
refunded whenever the call does not return 200; an empty balance answers 402
with a 1-credit top-up invoice. Watches fund the same way:
`POST /v1/watches/{id}/topup {"runs": 100}` (capture pack 10 credits, extract
pack 100). Full spec: `GET /openapi.json` (tags: accounts).

### Free endpoints (no payment)

| Endpoint | Description |
|---|---|
| `GET /v1/extract/preview?url=...` | Bounded preview: title, headings, links, word count (10 req/min/IP) |
| `GET /v1/og?url=...` | Open Graph link-preview metadata |
| `POST /v1/watches` | Create a scheduled monitor (free; prepay via top-up) |
| `GET /v1/health` | Liveness check |
| `POST /v1/feedback` | Tell webcap something (machine or human): `{"message":"…","category?"?:"bug\|suggestion\|pricing\|docs\|integration\|other","endpoint"?:"…"}`. No account, rate-limited 60/hr. Human form: [`GET /feedback`](/feedback) |

## Quick start

### Use as an MCP server (agent runtimes)

webcap ships an MCP server, so any MCP host (Claude Desktop, Cursor, agent
frameworks) can call it as a tool. Two ways to wire it: a **remote endpoint**
(no install at all) or the **stdio server** from a checkout.

The remote endpoint is the cheapest path for an agent — nothing to install, no
package registry, no account:

```json
{
  "mcpServers": {
    "webcap": { "url": "https://webcap.shoutsid.fyi/mcp" }
  }
}
```

`POST /mcp` speaks MCP Streamable HTTP (JSON-RPC 2.0 over HTTPS; GET is
deliberately 405 because the server never opens an SSE stream). It holds no
wallet, so it never spends on a caller's behalf: the free tools run directly,
and a paid tool returns the live x402 402 challenge for your own client to
settle. The endpoint is also described in
`/.well-known/mcp-tools.json` and `openapi.json`.

It is listed in the official MCP Registry as
**`io.github.shoutsid-lab/webcap`**, so a runtime that reads the registry can
discover it without this README:

```bash
curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=webcap'
```

The stdio server runs locally and can settle paid calls itself. The free tools
need no configuration; set `WEBCAP_MCP_WALLET_KEY` to a Base-mainnet USDC key to
let the paid tools settle automatically (gasless — the payer signs EIP-3009, the
facilitator pays gas). With no key, paid tools return the x402 402 challenge for
the host to pay. No wallet at all? Set `WEBCAP_MCP_API_KEY` to an
operator-funded account key instead (`POST /v1/register`, then fund via
`POST /v1/invoice`): paid tools bill 1 credit each from that balance. A
configured wallet wins over the key.

From a source checkout — `npm ci && npm run build` — then point `args` at
its `dist/mcp/stdio.js`:

```json
{
  "mcpServers": {
    "webcap": {
      "command": "node",
      "args": ["/absolute/path/to/webcap/dist/mcp/stdio.js"],
      "env": { "WEBCAP_MCP_WALLET_KEY": "0x..." }
    }
  }
}
```

(`npm run mcp` runs the TypeScript directly, so no build step is needed
there.) The npm release will be `@shoutsid/webcap` — the unscoped
`webcap` name belongs to an unrelated package, and it is not published yet —
so until then the remote endpoint above is the install-free option.

Tools, all 8 of them (every one is also in
`/.well-known/openai-tools.json` and `/.well-known/mcp-tools.json`):

- Free: `webcap_service_catalog` (every paid endpoint and price, the network and
  payTo, the how-to-pay flow, and the caller's remaining free allowance),
  `webcap_preview` (bounded peek), `webcap_og`
- Paid: `webcap_capture` (png/jpeg/pdf screenshot or PDF, or an mp4/webm scroll
  video — always recorded as WebM/VP8), `webcap_extract` (one URL or a batch of up to 50), `webcap_audit`,
  `webcap_map_lite`, `webcap_analyze`

The free rail is not a tool, it is an **allowance**: an unpaid call to any of
the five paid tools runs the real product, free, inside a rolling per-IP window
(default 50 calls / 24h). No wallet, signature or account — every response
carries `x-webcap-allowance-*` headers saying where you stand, and when the
window is spent the same call answers the normal x402 402 challenge. A failed
call does not consume the allowance. Tunable with `WEBCAP_ALLOWANCE_CALLS`,
`WEBCAP_ALLOWANCE_WINDOW_HOURS` and `WEBCAP_ALLOWANCE_GLOBAL_LIMIT`.

Feedback is a REST rail, not a tool: `POST /v1/feedback`.

### Capture a screenshot

```bash
# 1. POST without payment → HTTP 402 + a PAYMENT-REQUIRED header
curl -si -X POST "https://webcap.shoutsid.fyi/v1/x402/capture" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/"}'

# 2. Decode the base64 challenge → sign a gasless EIP-3009 transfer → retry with PAYMENT-SIGNATURE
```

### JavaScript (with x402 auto-payment)

```js
import axios from 'axios';
import { x402Client, wrapAxiosWithPayment } from '@x402/axios';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

// Needs USDC on Base mainnet (no ETH needed — facilitator pays gas)
const payer = privateKeyToAccount(process.env.PAYER_KEY);
const client = new x402Client().register('eip155:*', new ExactEvmScheme(payer));
const api = wrapAxiosWithPayment(
  axios.create({ baseURL: 'https://webcap.shoutsid.fyi' }),
  client,
);

// Capture a screenshot (auto: unpaid → 402 → sign → retry)
const { data } = await api.post('/v1/x402/capture', { url: 'https://example.com', format: 'png' });
console.log(data.artifact.url);  // persistent public screenshot link
```

### Python

```python
import os
from x402 import X402Client
from x402.schemes import ExactEvmScheme
from eth_account import Account

payer = Account.from_key(os.environ["PAYER_KEY"])
client = X402Client().register("eip155:*", ExactEvmScheme(payer))

response = client.post(
    "https://webcap.shoutsid.fyi/v1/x402/capture",
    json={"url": "https://example.com", "format": "png"},
)
print(response.json()["artifact"]["url"])  # persistent public screenshot link
```

### Extract structured data

```bash
# Single URL
curl -s -X POST "https://webcap.shoutsid.fyi/v1/x402/extract" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'

# Batch (up to 50 URLs, one payment covers the whole batch)
curl -s -X POST "https://webcap.shoutsid.fyi/v1/x402/extract" \
  -H 'content-type: application/json' \
  -d '{"urls":["https://a.com","https://b.com"],"schema":"company name + tagline"}'
```

## How payment works

The **live rail is crypto (x402, USDC on Base)** — no accounts, no API keys.
Card payments are an operator option, not a hosted feature: until an operator
sets `STRIPE_SECRET_KEY`, `POST /v1/stripe/checkout` answers
`stripe_not_configured` and points at the crypto rail. (The hosted deployment at
https://webcap.shoutsid.fyi is card-less today.)

### Card payments (Stripe, when configured)
1. `POST /v1/stripe/checkout` with a pack id — Stripe Checkout handles the rest.
2. Enter your card details. Credits are added to your account instantly.
3. Use API key authentication for subsequent calls.

### Crypto payments (x402 — no accounts needed)
webcap uses **x402 v2** — a gasless, accountless payment protocol built on HTTP 402:

1. **POST** a paid route with no payment → **HTTP 402** + a `PAYMENT-REQUIRED` header carrying a base64 x402 v2 challenge.
2. **Read** the challenge: USDC amount, merchant address, chain info.
3. **Sign** a gasless EIP-3009 `transferWithAuthorization` (from your wallet, to the merchant, for the amount). No ETH needed — the facilitator submits the tx and pays gas.
4. **Retry** the same request with the signed payload in the `PAYMENT-SIGNATURE` header. The facilitator verifies your USDC balance, settles on-chain, and returns the result.

No accounts. No API keys. No credits. Just HTTP + your choice of payment.

## Self-hosting

```bash
# Clone the repo
git clone https://github.com/shoutsid-lab/webcap.git
cd webcap

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings

# Build and run
npm run build
npm start
```

### From the release tarball (no npm registry account)

The packaged MCP server also ships as a GitHub release asset — install it like
any npm dependency, without publishing to npm:

```bash
# npm 12+ (Node 24) blocks remote tarball URLs by default — opt in explicitly:
npm install --allow-remote=all https://github.com/shoutsid-lab/webcap/releases/download/v0.1.0/shoutsid-webcap-0.1.0.tgz
# npm <= 11 accepts the URL without the flag:
npm install https://github.com/shoutsid-lab/webcap/releases/download/v0.1.0/shoutsid-webcap-0.1.0.tgz
npx webcap-mcp   # stdio MCP server
```

For MCP hosts the no-install path stays primary: point them at the remote
endpoint `https://webcap.shoutsid.fyi/mcp` (streamable HTTP, no package).

### Docker

```bash
docker compose build
docker compose up -d
```

The Docker setup includes health checks, resource limits, and persistent data volumes. See `docker-compose.yml` for details.

### Local development (Anvil testnet)

```bash
npm install
npm run chain:up    # Starts Anvil with mintable USDC

WEBCAP_CHAIN=local \
WEBCAP_USDC_ADDRESS=$(jq -r .usdcContract /tmp/webcap-chain.json) \
WEBCAP_MERCHANT_ADDRESS=$(jq -r .merchant.address /tmp/webcap-chain.json) \
npm start
```

## Configuration

All environment variables are documented in [`.env.example`](.env.example). Key ones:

| Variable | Description | Default |
|---|---|---|
| `WEBCAP_CHAIN` | Network: `base`, `base-sepolia`, or `local` | `base-sepolia` |
| `WEBCAP_PUBLIC_BASE_URL` | Public URL for artifact links | *required* |
| `WEBCAP_X402_PRICE_USDC` | Price per screenshot in USDC | `0.001` |
| `WEBCAP_X402_EXTRACT_PRICE_USDC` | Price per extraction in USDC | `0.01` |
| `X402_FACILITATOR_URL` | Payment facilitator endpoint | `https://x402.org/facilitator` |

## API reference

Full OpenAPI 3.1 spec: [`GET /openapi.json`](https://webcap.shoutsid.fyi/openapi.json)

Agent discovery: `GET /.well-known/x402`, `GET /v1/x402/service`, `GET /llms.txt`, `GET /skill.md`

## Tests

```bash
npm test           # full vitest suite (tests/**/*.test.ts, no exclusions)
npm run typecheck  # Type checking
```

Both must pass before a change ships. Deliberately no test/file counts here: they
have gone stale twice (a reader caught the second one in issue #1), and a number
nobody regenerates is worse than no number. `npm test` prints the current totals.

### Claim audit

```bash
npm run audit:claims                                        # against localhost:8080
npm run audit:claims -- --base-url https://webcap.shoutsid.fyi  # against a deployment
```

The tests check the code; this checks the **claims** — it reads `README.md`,
`/skill.md` and `/llms.txt` and verifies every `METHOD /path` they advertise is
actually served, that every documented price equals the 402 challenge amount, and
that the free surface describes the same prices as the paid routes. It exits
non-zero on any failure, so it can gate a deploy. Issue #1 was filed by an agent
that did this by hand; this is the same check as a command.

## License

MIT — see [LICENSE](LICENSE) for details.

## Links

- **Live API**: https://webcap.shoutsid.fyi
- **GitHub**: https://github.com/shoutsid-lab/webcap
- **OpenAPI docs**: https://webcap.shoutsid.fyi/openapi.json
