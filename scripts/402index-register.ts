/**
 * 402index registry re-assertion (idempotent upsert keyed on (url, protocol)).
 *
 * 402index live-probes each URL and requires an x402 402 response, which our
 * POST mirrors satisfy (the probe body is the exact body that triggers the
 * challenge on each route). Re-asserted DAILY via bin/402index-reassert.sh
 * (cron) plus bin/webcap-keepalive.sh 2x/week (Mon+Thu); safe
 * to re-run any time: re-registering an existing url+protocol updates the row.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/402index-register.ts
 *
 * Env:
 *   X402INDEX_BASE_URL  webcap public base URL (default: WEBCAP_PUBLIC_BASE_URL
 *                       read from .env)
 */
import { readFileSync } from 'node:fs';

const REG_URL = 'https://402index.io/api/v1/register';
const TIMEOUT_MS = 30_000;

function envLine(name: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync('.env', 'utf8');
  } catch {
    return undefined;
  }
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  return line === undefined ? undefined : line.split('=').slice(1).join('=').trim();
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const base = (process.env.X402INDEX_BASE_URL ?? envLine('WEBCAP_PUBLIC_BASE_URL') ?? '').replace(/\/+$/, '');
if (base === '') {
  fail('base URL unknown — set X402INDEX_BASE_URL or WEBCAP_PUBLIC_BASE_URL in .env');
}

// Sent on every upsert: the registry keeps a per-service contact email, and a
// re-assert without it can blank the field (same reason the name/description
// are re-sent). Empty string omits the key.
const contactEmail = (process.env.WEBCAP_CONTACT_EMAIL ?? envLine('WEBCAP_CONTACT_EMAIL') ?? '').trim();

type RouteSpec = {
  route: string;
  path: string;
  name: string;
  description: string;
  probeBody: string;
  priceUsd: number;
  category: string;
  paymentNetwork: string;
};

const routes: RouteSpec[] = [
  {
    route: 'capture',
    path: '/v1/x402/capture',
    name: 'webcap — capture (screenshot + OG metadata)',
    description:
      'Capture a URL as PNG/JPEG/PDF plus free OG metadata. Gasless x402 USDC payment on Base (CDP facilitator).',
    probeBody: '{"url":"https://example.com"}',
    priceUsd: 0.001,
    category: 'media',
    paymentNetwork: 'Base',
  },
  {
    route: 'extract',
    path: '/v1/x402/extract',
    name: 'webcap — extract (structured content)',
    description:
      'Extract structured content (headings, links, text, metadata) from one URL or a batch. Gasless x402 USDC payment on Base.',
    probeBody: '{"url":"https://example.com"}',
    priceUsd: 0.01,
    category: 'web-scraping',
    paymentNetwork: 'Base',
  },
  {
    route: 'audit',
    path: '/v1/x402/audit',
    name: 'webcap — audit (SEO + link/OG health)',
    description:
      'SEO basics + link/OG health for any URL in one call. Gasless x402 USDC payment on Base.',
    probeBody: '{"url":"https://example.com"}',
    priceUsd: 0.002,
    category: 'web-scraping',
    paymentNetwork: 'Base',
  },
  {
    route: 'map-lite',
    path: '/v1/x402/map-lite',
    name: 'webcap — map-lite (single-URL site map)',
    description:
      'Single-URL site map (same-origin link graph) in one call. Gasless x402 USDC payment on Base.',
    probeBody: '{"url":"https://example.com"}',
    priceUsd: 0.002,
    category: 'web-scraping',
    paymentNetwork: 'Base',
  },
  {
    route: 'video',
    path: '/v1/x402/video',
    name: 'webcap — video (scroll-capture video)',
    description:
      'Scroll-capture any URL as a WebM/VP8 video in one call. Gasless x402 USDC payment on Base.',
    probeBody: '{"url":"https://example.com"}',
    priceUsd: 0.005,
    category: 'media',
    paymentNetwork: 'Base',
  },
  {
    route: 'analyze',
    path: '/v1/x402/analyze',
    name: 'webcap — analyze (AI visual analysis)',
    description:
      'AI-powered visual analysis of any URL: classification, accessibility, layout, entities, sentiment. Gasless x402 USDC payment on Base.',
    probeBody: '{"url":"https://example.com","task":"classification"}',
    priceUsd: 0.01,
    category: 'web-scraping',
    paymentNetwork: 'Base',
  },
  {
    route: 'topup',
    path: '/v1/x402/watches/topup',
    name: 'webcap — watch top-up (prepaid runs)',
    description:
      'Top up prepaid page-change watch runs (per-watch challenge, $0.10–$1.00 packs). Gasless x402 USDC payment on Base.',
    probeBody: '{"watchId":"00000000-0000-4000-8000-000000000000","runs":100}',
    priceUsd: 0.1,
    category: 'tools',
    paymentNetwork: 'Base',
  },
];

let failures = 0;
for (const r of routes) {
  try {
    const res = await fetch(REG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${base}${r.path}`,
        name: r.name,
        protocol: 'x402',
        http_method: 'POST',
        probe_body: r.probeBody,
        description: r.description,
        price_usd: r.priceUsd,
        payment_asset: 'USDC',
        payment_network: r.paymentNetwork,
        category: r.category,
        provider: 'webcap',
        ...(contactEmail !== '' ? { contact_email: contactEmail } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.status === 201) {
      console.log(`PASS: ${r.route} <- ${text.slice(0, 200)}`);
    } else {
      failures += 1;
      console.error(`FAIL: ${r.route} status=${res.status} body=${text.slice(0, 300)}`);
    }
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${r.route} ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
