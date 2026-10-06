/**
 * POST /mcp — the remote Streamable HTTP MCP transport.
 *
 * Why this exists: the customer is an autonomous agent, and the cheapest way
 * for one to reach webcap is an endpoint it can load with no install. The npm
 * path needs a registry package and a publish token (GitHub Packages would
 * even demand a personal access token on every install — friction a bot cannot
 * clear); a public HTTPS endpoint needs nothing, and it is the shape the
 * official MCP Registry accepts as a `remotes` entry.
 *
 * These tests pin the transport contract an MCP host depends on: a JSON-RPC
 * initialize/tools-list/tools-call round trip, the 202 for notification-only
 * bodies, the deliberate 405 on GET, real dispatch into the app (not a stub
 * echo), and the payment honesty rule — this endpoint holds no wallet, so a
 * paid tool answers with the live x402 challenge instead of spending an
 * operator's money on an anonymous caller's behalf.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeMockFacilitator } from '../helpers/facilitator.js';
import { openDb, type Db } from '../../src/db/index.js';
import { makeArtifactRepo } from '../../src/db/artifacts.js';
import { buildApp } from '../../src/server/server.js';
import { TOOLS } from '../../src/mcp/server.js';
import { MAX_BATCH_MESSAGES } from '../../src/mcp/http.js';
import type { WebcapConfig } from '../../src/config.js';
import type { CaptureRequest, CaptureResult, PageStructure, StructuredCapture } from '../../src/capture/pipeline.js';
import type { OgResult } from '../../src/capture/og.js';

const MERCHANT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const FAKE_STRUCTURE: PageStructure = {
  title: 'Stub Title',
  description: 'Stub description',
  headings: [{ level: 1, text: 'Heading One' }],
  paragraphs: ['A stub paragraph.'],
  links: [{ href: 'https://example.com/', text: 'home' }],
  images: [{ src: 'https://example.com/i.png', alt: 'stub' }],
  wordCount: 4,
  markdown: '# Stub Title\n\nA stub paragraph.',
};

interface Harness {
  readonly app: ReturnType<typeof buildApp>;
  readonly dir: string;
  readonly db: Db;
  readonly config: WebcapConfig;
}

/** x402-enabled app: paid calls get a live 402 challenge. */
function makeX402Harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'webcap-mcp-http-x402-'));
  const db = openDb(join(dir, 'x402.db'));
  const config: WebcapConfig = {
    chain: { name: 'base-sepolia', rpcUrl: 'https://sepolia.base.org', chainId: 84532, usdcContract: USDC_ADDRESS, explorer: '' },
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcAddress: USDC_ADDRESS,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: join(dir, 'x402.db'),
    x402Network: 'eip155:84532',
    x402Asset: USDC_ADDRESS,
    x402PayTo: MERCHANT_ADDRESS,
    x402PriceUsdcUnits: 1_000,
    x402ExtractPriceUsdcUnits: 10_000,
    x402AuditPriceUsdcUnits: 2_000,
    x402VideoPriceUsdcUnits: 5_000,
    computeCostUsdcUnitsPerRequest: 200,
    modelApiBaseUrl: '',
    modelApiKey: '',
    modelName: '',
    x402FacilitatorUrl: 'https://x402.org/facilitator',
    publicBaseUrl: 'http://localhost:8080',
    cdpApiKey: undefined,
  };
  const app = buildApp({
    db,
    config,
    capture: async (req: CaptureRequest): Promise<CaptureResult> => ({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      format: req.format ?? 'png',
      bytes: 4,
    }),
    captureStructured: async (): Promise<StructuredCapture> => ({ html: '<html></html>', structure: FAKE_STRUCTURE }),
    previewFallback: async (): Promise<PageStructure> => FAKE_STRUCTURE,
    og: async (req: { url: string }): Promise<OgResult> => ({ url: req.url, title: 'Stub Title' }),
    artifacts: makeArtifactRepo(db),
    x402Facilitator: makeMockFacilitator('eip155:84532').facilitator,
  });
  return { app, dir, db, config };
}

async function close(h: Harness): Promise<void> {
  await h.app.close();
  h.db.close();
  rmSync(h.dir, { recursive: true, force: true });
}

interface RpcResponse {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

function rpc(method: string, params?: unknown, id: unknown = 1): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

describe('POST /mcp — remote MCP transport', () => {
  it('answers initialize with the protocol version, tools capability and identity', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const body = res.json() as RpcResponse;
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      // The client's requested revision is echoed, so a newer host is not
      // downgraded by this server's own default.
      expect(body.result?.protocolVersion).toBe('2025-06-18');
      expect(body.result?.capabilities).toEqual({ tools: {} });
      expect(body.result?.serverInfo).toMatchObject({ name: 'webcap' });
      expect(String(body.result?.instructions)).toContain('webcap_service_catalog');
    } finally {
      await close(h);
    }
  });

  it('answers the mandatory server/discover over HTTP, so a modern client can pick a revision', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({ method: 'POST', url: '/mcp', payload: rpc('server/discover') });
      expect(res.statusCode).toBe(200);
      const result = (res.json() as RpcResponse).result ?? {};
      expect(result.resultType).toBe('complete');
      expect(result.supportedVersions).toContain('2026-07-28');
      expect(result._meta).toMatchObject({ 'io.modelcontextprotocol/serverInfo': { name: 'webcap' } });
    } finally {
      await close(h);
    }
  });

  it('honours the MCP-Protocol-Version header on a modern tools/list', async () => {
    // 2026-07-28 carries the revision in the header as well as in `_meta`; a
    // header-only client must not be silently served the legacy shape.
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-protocol-version': '2026-07-28' },
        payload: rpc('tools/list'),
      });
      expect(res.statusCode).toBe(200);
      const result = (res.json() as RpcResponse).result ?? {};
      expect(result.resultType).toBe('complete');
      expect(Array.isArray(result.tools)).toBe(true);
    } finally {
      await close(h);
    }
  });

  it('refuses an unknown protocol revision with -32022 and the versions it speaks', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { 'mcp-protocol-version': '1999-01-01' },
        payload: rpc('tools/list'),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      expect(body.error?.code).toBe(-32022);
      expect((body.error as { data?: { supported?: string[] } }).data?.supported).toContain('2026-07-28');
    } finally {
      await close(h);
    }
  });

  it('answers tools/list with every tool the shared core exposes', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({ method: 'POST', url: '/mcp', payload: rpc('tools/list') });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      const tools = (body.result?.tools ?? []) as Array<{ name: string; description: string; inputSchema: unknown }>;
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
      for (const tool of tools) {
        expect(tool.description, `${tool.name} must carry a description`).toBeTruthy();
        expect(tool.inputSchema, `${tool.name} must carry an input schema`).toBeTruthy();
      }
    } finally {
      await close(h);
    }
  });

  it('runs a free tool for real, dispatching into the app instead of echoing', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: rpc('tools/call', { name: 'webcap_preview', arguments: { url: 'https://example.com/' } }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      const content = (body.result?.content ?? []) as Array<{ type: string; text: string }>;
      expect(body.result?.isError).toBeFalsy();
      expect(content[0]?.type).toBe('text');
      // The stub preview's own title proves the call reached the real route.
      expect(content[0]?.text).toContain('Stub Title');
    } finally {
      await close(h);
    }
  });

  it('returns the live x402 challenge for a paid tool, holding no wallet of its own', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: rpc('tools/call', { name: 'webcap_extract', arguments: { url: 'https://example.com/' } }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      const text = ((body.result?.content ?? []) as Array<{ text: string }>)[0]?.text ?? '';
      // The challenge itself, not a generic failure: price, network and payTo.
      expect(text).toContain('requires payment (HTTP 402)');
      expect(text).toContain(MERCHANT_ADDRESS);
      expect(text).toContain('eip155:84532');
      expect(text).toContain('10000');
      // And the advice must fit this transport: there is no local wallet env
      // var to set here, so the caller is told to pay over HTTPS instead.
      expect(text).toContain('holds no wallet');
      expect(text).not.toContain('WEBCAP_MCP_WALLET_KEY');
    } finally {
      await close(h);
    }
  });

  it('reports a tool-level failure as isError rather than a protocol error', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: rpc('tools/call', { name: 'webcap_extract', arguments: {} }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      expect(body.result?.isError).toBe(true);
      expect(((body.result?.content ?? []) as Array<{ text: string }>)[0]?.text).toContain(
        'provide "url" (single page) or "urls"',
      );
    } finally {
      await close(h);
    }
  });

  it('answers 202 with no body when the request carries only notifications', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(res.statusCode).toBe(202);
      expect(res.body).toBe('');
    } finally {
      await close(h);
    }
  });

  it('handles a JSON-RPC batch and keeps per-message responses', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: [rpc('ping', undefined, 'a'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list', undefined, 'b')],
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse[];
      expect(Array.isArray(body)).toBe(true);
      expect(body.map((r) => r.id)).toEqual(['a', 'b']);
    } finally {
      await close(h);
    }
  });

  it('answers -32601 for an unknown method and -32600 for a malformed message', async () => {
    const h = makeX402Harness();
    try {
      const unknown = await h.app.inject({ method: 'POST', url: '/mcp', payload: rpc('resources/list') });
      expect(unknown.statusCode).toBe(200);
      expect((unknown.json() as RpcResponse).error?.code).toBe(-32601);

      const malformed = await h.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 9 } });
      expect(malformed.statusCode).toBe(200);
      expect((malformed.json() as RpcResponse).error?.code).toBe(-32600);

      const emptyBatch = await h.app.inject({ method: 'POST', url: '/mcp', payload: [] });
      expect(emptyBatch.statusCode).toBe(400);
      expect((emptyBatch.json() as RpcResponse).error?.code).toBe(-32600);
    } finally {
      await close(h);
    }
  });

  it('rejects an oversized batch instead of amplifying one POST into thousands of requests', async () => {
    // Every tools/call becomes a nested request, so the batch needs a work
    // bound of its own rather than only the request body limit.
    const h = makeX402Harness();
    try {
      const tooMany = Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, i) => rpc('ping', undefined, i));
      const res = await h.app.inject({ method: 'POST', url: '/mcp', payload: tooMany });
      expect(res.statusCode).toBe(400);
      expect((res.json() as RpcResponse).error?.message).toContain(String(MAX_BATCH_MESSAGES));

      // The cap itself is usable.
      const allowed = Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => rpc('ping', undefined, i));
      const ok = await h.app.inject({ method: 'POST', url: '/mcp', payload: allowed });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as RpcResponse[]).length).toBe(MAX_BATCH_MESSAGES);
    } finally {
      await close(h);
    }
  });

  it('does not serve GET: this server never opens a server-initiated SSE stream', async () => {
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({ method: 'GET', url: '/mcp' });
      // The app's not-found envelope: 405 with Allow, because POST is the only
      // method this path serves. Advertising an SSE GET we never open would be
      // a surface that lies to a host.
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    } finally {
      await close(h);
    }
  });

  it('advertises the endpoint in the .well-known/mcp-tools.json manifest', async () => {
    // A host that reads the manifest instead of our docs must still find the
    // remote transport; a manifest that omits it is a surface that lies.
    const h = makeX402Harness();
    try {
      const res = await h.app.inject({ method: 'GET', url: '/.well-known/mcp-tools.json' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        server?: { url?: string };
        mcp?: { transport: string; url: string; method: string };
      };
      expect(body.mcp?.transport).toBe('streamable-http');
      // Internally consistent with the manifest's own server URL (which is the
      // https-normalized public base), so the two cannot disagree.
      expect(body.server?.url).toBeTruthy();
      expect(body.mcp?.url).toBe(`${body.server?.url}/mcp`);
      expect(body.mcp?.method).toBe('POST');
    } finally {
      await close(h);
    }
  });

  it('forwards the caller identity into the nested request, keeping attribution and per-caller budgets', async () => {
    // The tool call becomes a real nested request against the same app, which
    // runs the free routes' per-peer limiter and the metrics hook. Without
    // forwarding, every MCP caller on the internet would share one loopback
    // rate-limit bucket and be recorded as "unknown" in endpoint_hits.
    const h = makeX402Harness();
    try {
      const call = (from: string, ua: string) =>
        h.app.inject({
          method: 'POST',
          url: '/mcp',
          remoteAddress: from,
          headers: { 'user-agent': ua },
          payload: rpc('tools/call', { name: 'webcap_preview', arguments: { url: 'https://example.com/' } }),
        });

      const ua = 'mcp-attribution-probe/1.0 (+https://example.org)';
      expect((await call('203.0.113.7', ua)).statusCode).toBe(200);

      const recorded = h.db
        .prepare("select user_agent from endpoint_hits where endpoint = 'GET /v1/extract/preview'")
        .all() as Array<{ user_agent: string }>;
      expect(recorded.map((r) => r.user_agent)).toContain(ua);

      // Exhaust caller A's free preview budget (default 10/min), then prove a
      // different caller B is untouched: the bucket is per caller, not shared.
      for (let i = 0; i < 10; i += 1) await call('203.0.113.7', ua);
      const exhausted = await call('203.0.113.7', ua);
      const exhaustedText = ((exhausted.json() as RpcResponse).result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '';
      expect(exhaustedText).toContain('rate limit');

      const other = await call('203.0.113.8', ua);
      const otherText = ((other.json() as RpcResponse).result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? '';
      expect(otherText, 'a different caller must keep its own budget').toContain('Stub Title');
    } finally {
      await close(h);
    }
  });

  it('serves the endpoint on an x402-disabled deployment too, with its own honest error', async () => {
    // The transport is not gated on the payment rail: free tools still work,
    // and a paid tool reports the app's real reason instead of pretending.
    const dir = mkdtempSync(join(tmpdir(), 'webcap-mcp-http-local-'));
    const db = openDb(join(dir, 'local.db'));
    try {
      const app = buildApp({
        db,
        config: {
          chain: { name: 'local', rpcUrl: 'http://127.0.0.1:8545', chainId: 31337, usdcContract: USDC_ADDRESS, explorer: '' },
          chainId: 31337,
          rpcUrl: 'http://127.0.0.1:8545',
          usdcAddress: USDC_ADDRESS,
          merchantAddress: MERCHANT_ADDRESS,
          port: 0,
          pollIntervalMs: 5_000,
          merchantPrivateKey: '',
          dbPath: join(dir, 'local.db'),
          x402Network: undefined,
          x402Asset: USDC_ADDRESS,
          x402PayTo: MERCHANT_ADDRESS,
          x402PriceUsdcUnits: 1_000,
          x402ExtractPriceUsdcUnits: 10_000,
          x402AuditPriceUsdcUnits: 2_000,
          x402VideoPriceUsdcUnits: 5_000,
          computeCostUsdcUnitsPerRequest: 200,
          modelApiBaseUrl: '',
          modelApiKey: '',
          modelName: '',
          x402FacilitatorUrl: 'https://x402.org/facilitator',
          publicBaseUrl: 'http://localhost:8080',
          cdpApiKey: undefined,
        },
        capture: async (): Promise<CaptureResult> => ({ buffer: Buffer.from([1]), format: 'png', bytes: 1 }),
        captureStructured: async (): Promise<StructuredCapture> => ({ html: '', structure: FAKE_STRUCTURE }),
        previewFallback: async (): Promise<PageStructure> => FAKE_STRUCTURE,
        og: async (req: { url: string }): Promise<OgResult> => ({ url: req.url, title: 'Stub Title' }),
        artifacts: makeArtifactRepo(db),
      });
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: rpc('tools/call', { name: 'webcap_extract', arguments: { url: 'https://example.com/' } }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as RpcResponse;
      expect(body.result?.isError).toBe(true);
      expect(((body.result?.content ?? []) as Array<{ text: string }>)[0]?.text).toContain('x402_disabled');
      await app.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
