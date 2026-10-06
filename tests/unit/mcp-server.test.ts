import { describe, expect, it } from 'vitest';
import { TOOLS, handleRpc, initializeResult, declareProtocolVersion, type McpHttp, type McpResponse } from '../../src/mcp/server.js';

// The MCP server is how an agent runtime finds webcap as a tool. These tests
// pin the protocol surface (initialize/tools list/tools call), the free-vs-paid
// split, and that a paid tool without a wallet returns the x402 challenge
// rather than a bare failure.

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

function fakeHttp(response: McpResponse): { http: McpHttp; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      async request(method, path, body, headers) {
        calls.push({ method, path, body, headers: headers ?? {} });
        return response;
      },
    },
  };
}

function ctx(response: McpResponse, canPay = false, creditKey?: string) {
  const f = fakeHttp(response);
  return {
    ...f,
    context: {
      baseUrl: 'https://webcap.shoutsid.fyi',
      version: '0.1.0',
      http: f.http,
      canPay,
      ...(creditKey !== undefined ? { creditKey } : {}),
    },
  };
}

function rpc(msg: unknown, c: ReturnType<typeof ctx>['context']) {
  return handleRpc(msg, c) as Promise<{ result?: any; error?: { code: number; message: string } } | null>;
}

describe('MCP server core', () => {
  it('initialize echoes the requested protocol version and advertises the tools capability', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, c.context);
    expect(res?.result.protocolVersion).toBe('2025-06-18');
    expect(res?.result.capabilities).toEqual({ tools: {} });
    expect(res?.result.serverInfo.name).toBe('webcap');
  });

  it('initialize falls back to our protocol revision when neither is given', () => {
    const r = initializeResult(undefined, '0.1.0') as { protocolVersion: string };
    expect(r.protocolVersion).toBe('2024-11-05');
  });

  it('tools/list exposes every tool with a JSON-Schema input', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, c.context);
    const tools = res?.result.tools as Array<{ name: string; description: string; inputSchema: { type: string } }>;
    expect(tools.length).toBe(TOOLS.length);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['webcap_preview', 'webcap_capture', 'webcap_extract', 'webcap_audit', 'webcap_analyze']),
    );
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('free tool calls the right path and returns the body as text content', async () => {
    const c = ctx({ status: 200, body: { title: 'Example Domain' } });
    const res = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'webcap_preview', arguments: { url: 'https://example.com/a b' } } },
      c.context,
    );
    expect(c.calls[0]?.method).toBe('GET');
    expect(c.calls[0]?.path).toBe('/v1/extract/preview?url=https%3A%2F%2Fexample.com%2Fa%20b');
    expect(res?.result.content[0].text).toContain('Example Domain');
    expect(res?.result.isError).toBeUndefined();
  });

  it('a paid tool with no wallet returns the 402 challenge as guidance, not a bare error', async () => {
    const c = ctx({ status: 402, body: { x402Version: 2, accepts: [{ amount: '1000', network: 'eip155:8453' }] } }, false);
    const res = await rpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'webcap_capture', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    const text = res?.result.content[0].text as string;
    expect(text).toContain('requires payment');
    expect(text).toContain('WEBCAP_MCP_WALLET_KEY');
    expect(text).toContain('eip155:8453');
    // guidance, not a tool error
    expect(res?.result.isError).toBeUndefined();
  });

  it('a paid tool that settles returns the paid body', async () => {
    const c = ctx({ status: 200, body: { artifact: { url: 'https://webcap.shoutsid.fyi/v1/artifacts/x' } } }, true);
    const res = await rpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'webcap_capture', arguments: { url: 'https://example.com', format: 'pdf' } } },
      c.context,
    );
    expect(c.calls[0]?.method).toBe('POST');
    expect(c.calls[0]?.body).toEqual({ url: 'https://example.com', format: 'pdf' });
    expect(res?.result.content[0].text).toContain('/v1/artifacts/x');
  });

  it('bad tool arguments surface as an isError result, not a crash', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'webcap_capture', arguments: {} } },
      c.context,
    );
    expect(res?.result.isError).toBe(true);
    expect(res?.result.content[0].text).toContain('url');
    expect(c.calls.length).toBe(0);
  });

  it('extract requires url or urls', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'webcap_extract', arguments: {} } },
      c.context,
    );
    expect(res?.result.isError).toBe(true);
  });

  it('unknown tool is a JSON-RPC error; unknown method too', async () => {
    const c = ctx({ status: 200, body: {} });
    const bad = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } }, c.context);
    expect(bad?.error?.code).toBe(-32602);
    const method = await rpc({ jsonrpc: '2.0', id: 9, method: 'does/not/exist' }, c.context);
    expect(method?.error?.code).toBe(-32601);
  });

  it('notifications get no response', async () => {
    const c = ctx({ status: 200, body: {} });
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, c.context)).toBeNull();
    expect(await handleRpc({ jsonrpc: '2.0', method: 'unknown/notification' }, c.context)).toBeNull();
  });

  it('an upstream 5xx becomes an isError result carrying the status', async () => {
    const c = ctx({ status: 502, body: { error: { code: 'capture_failed' } } });
    const res = await rpc(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'webcap_og', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    expect(res?.result.isError).toBe(true);
    expect(res?.result.content[0].text).toContain('502');
  });

  it('credit mode bills the operator key: paid path rewritten to the credits rail with a Bearer header', async () => {
    const c = ctx({ status: 200, body: { results: [], creditsCharged: 1, balance: 41 } }, false, 'wc_test_key');
    const res = await rpc(
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'webcap_extract', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    expect(c.calls[0]?.method).toBe('POST');
    expect(c.calls[0]?.path).toBe('/v1/extract');
    expect(c.calls[0]?.headers).toEqual({ authorization: 'Bearer wc_test_key' });
    expect(res?.result.content[0].text).toContain('creditsCharged');
    expect(res?.result.isError).toBeUndefined();
  });

  it('credit mode leaves free tools untouched (no auth header)', async () => {
    const c = ctx({ status: 200, body: { title: 'Example Domain' } }, false, 'wc_test_key');
    await rpc(
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'webcap_preview', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    expect(c.calls[0]?.path).toBe('/v1/extract/preview?url=https%3A%2F%2Fexample.com');
    expect(c.calls[0]?.headers).toEqual({});
  });

  it('credit mode 402 guides to the invoice top-up, not to EIP-3009 signing', async () => {
    const c = ctx(
      { status: 402, body: { error: { code: 'insufficient_credits', detail: { invoiceId: '7', requiredUsdc: 0.01 } } } },
      false,
      'wc_test_key',
    );
    const res = await rpc(
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'webcap_capture', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    const text = res?.result.content[0].text as string;
    expect(c.calls[0]?.path).toBe('/v1/capture');
    expect(text).toContain('POST /v1/invoice');
    expect(text).not.toContain('EIP-3009');
    expect(res?.result.isError).toBeUndefined();
  });

  it('a configured wallet wins over the credit key (x402 path, no Bearer header)', async () => {
    const c = ctx({ status: 200, body: { artifact: {} } }, true, 'wc_test_key');
    await rpc(
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'webcap_capture', arguments: { url: 'https://example.com' } } },
      c.context,
    );
    expect(c.calls[0]?.path).toBe('/v1/x402/capture');
    expect(c.calls[0]?.headers).toEqual({});
  });
});

// mcpmetrics.io scores this exact tool list for how easily an LLM picks the
// right tool. These pin the fixes for its first audit: unambiguous names,
// url/urls exclusivity, declared defaults and local signature errors.
describe('MCP tool readability', () => {
  it('names the catalog unambiguously and no longer ships the revenue funnel', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('webcap_service_catalog');
    expect(names).not.toContain('webcap_service');
    // Operator telemetry, not an agent tool: removed rather than renamed.
    expect(names).not.toContain('webcap_agent_funnel');
    expect(names).not.toContain('webcap_revenue_funnel');
  });

  it('declares url|urls as alternatives on webcap_extract', () => {
    const tool = TOOLS.find((t) => t.name === 'webcap_extract');
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.oneOf).toEqual([{ required: ['url'] }, { required: ['urls'] }]);
  });

  it('rejects an extract call with neither target, and one with both, without a round trip', async () => {
    const neither = ctx({ status: 200, body: {} });
    const a = await rpc(
      { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'webcap_extract', arguments: {} } },
      neither.context,
    );
    expect(a?.result.isError).toBe(true);
    expect(a?.result.content[0].text).toContain('webcap_extract');
    expect(neither.calls.length).toBe(0);

    const both = ctx({ status: 200, body: {} });
    const b = await rpc(
      {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: { name: 'webcap_extract', arguments: { url: 'https://example.com/', urls: ['https://example.com/a'] } },
      },
      both.context,
    );
    expect(b?.result.isError).toBe(true);
    expect(b?.result.content[0].text).toContain('not both');
    expect(both.calls.length).toBe(0);
  });

  it('forwards a single url or a batch unchanged', async () => {
    const single = ctx({ status: 200, body: {} });
    await rpc(
      { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'webcap_extract', arguments: { url: 'https://example.com/' } } },
      single.context,
    );
    expect(single.calls[0]?.body).toEqual({ url: 'https://example.com/' });

    const batch = ctx({ status: 200, body: {} });
    await rpc(
      {
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/call',
        params: { name: 'webcap_extract', arguments: { urls: ['https://a.example/', 'https://b.example/'] } },
      },
      batch.context,
    );
    expect(batch.calls[0]?.body).toEqual({ urls: ['https://a.example/', 'https://b.example/'] });
  });

  it('declares and enforces the maxUrls bounds on webcap_map_lite', async () => {
    const props = TOOLS.find((t) => t.name === 'webcap_map_lite')?.inputSchema.properties as Record<
      string,
      { default?: number; minimum?: number; maximum?: number }
    >;
    expect(props.maxUrls).toMatchObject({ minimum: 1, maximum: 50, default: 20 });

    const ok = ctx({ status: 200, body: {} });
    await rpc(
      { jsonrpc: '2.0', id: 107, method: 'tools/call', params: { name: 'webcap_map_lite', arguments: { url: 'https://example.com/', maxUrls: 5 } } },
      ok.context,
    );
    expect(ok.calls[0]?.body).toEqual({ url: 'https://example.com/', maxUrls: 5 });

    const bad = ctx({ status: 200, body: {} });
    const res = await rpc(
      { jsonrpc: '2.0', id: 108, method: 'tools/call', params: { name: 'webcap_map_lite', arguments: { url: 'https://example.com/', maxUrls: 500 } } },
      bad.context,
    );
    expect(res?.result.isError).toBe(true);
    expect(res?.result.content[0].text).toContain('between 1 and 50');
    expect(bad.calls.length).toBe(0);
  });

  it('omits an absent maxUrls so the service default applies', async () => {
    const c = ctx({ status: 200, body: {} });
    await rpc(
      { jsonrpc: '2.0', id: 109, method: 'tools/call', params: { name: 'webcap_map_lite', arguments: { url: 'https://example.com/' } } },
      c.context,
    );
    expect(c.calls[0]?.body).toEqual({ url: 'https://example.com/' });
  });

  it('rejects a url that is not absolute http(s) instead of spending a round trip', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc(
      { jsonrpc: '2.0', id: 110, method: 'tools/call', params: { name: 'webcap_preview', arguments: { url: 'example.com' } } },
      c.context,
    );
    expect(res?.result.isError).toBe(true);
    expect(res?.result.content[0].text).toContain('absolute http(s) URL');
    expect(c.calls.length).toBe(0);
  });
});

// The deployment was labelled "Legacy ⚠" for only speaking the initialize
// handshake. It is dual-era now: server/discover + per-request `_meta` for
// 2026-07-28 clients, initialize for everything older.
describe('MCP protocol eras', () => {
  const modernMeta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };

  it('implements the mandatory server/discover with the supported versions', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc({ jsonrpc: '2.0', id: 200, method: 'server/discover', params: {} }, c.context);
    const r = res?.result as {
      resultType?: string;
      supportedVersions?: string[];
      capabilities?: unknown;
      _meta?: Record<string, unknown>;
    };
    expect(r.resultType).toBe('complete');
    expect(r.supportedVersions).toContain('2026-07-28');
    expect(r.supportedVersions).toContain('2024-11-05');
    expect(r.capabilities).toEqual({ tools: {} });
    expect(r._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'webcap' });
  });

  it('tags a modern tools/list result with resultType and server identity, and leaves legacy alone', async () => {
    const modern = ctx({ status: 200, body: {} });
    const m = await rpc({ jsonrpc: '2.0', id: 201, method: 'tools/list', params: modernMeta }, modern.context);
    expect(m?.result.resultType).toBe('complete');
    expect(m?.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'webcap' });
    expect(Array.isArray(m?.result.tools)).toBe(true);

    const legacy = ctx({ status: 200, body: {} });
    const l = await rpc({ jsonrpc: '2.0', id: 202, method: 'tools/list' }, legacy.context);
    expect(l?.result.resultType).toBeUndefined();
    expect(l?.result._meta).toBeUndefined();
  });

  it('refuses an unknown revision with -32022 and the versions it does speak', async () => {
    const c = ctx({ status: 200, body: {} });
    const res = await rpc(
      { jsonrpc: '2.0', id: 203, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
      c.context,
    );
    expect(res?.error?.code).toBe(-32022);
    expect((res?.error as { data?: { supported?: string[] } }).data?.supported).toContain('2026-07-28');
  });

  it('accepts the revision from the HTTP header when _meta omits it', () => {
    const declared = declareProtocolVersion({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, '2026-07-28') as {
      params: { _meta: Record<string, string> };
    };
    expect(declared.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
  });
});

// The surface is 9 tools, down from 18: capabilities that differ only by a mode
// are one tool now, and operator/support rails left the surface entirely. These
// pin every merged route, so condensing can never silently drop a capability.
describe('condensed tool surface', () => {
  const call = (name: string, args: Record<string, unknown>, id = 300) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('exposes exactly eight tools, with the retired trial rail gone', () => {
    expect(TOOLS).toHaveLength(8);
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'webcap_analyze',
      'webcap_audit',
      'webcap_capture',
      'webcap_extract',
      'webcap_map_lite',
      'webcap_og',
      'webcap_preview',
      'webcap_service_catalog',
    ]);
    // Free access is the rolling per-IP allowance, not a tool: nothing on the
    // surface asks a caller for a wallet signature any more.
    expect(TOOLS.some((t) => t.name.includes('trial'))).toBe(false);
    expect(JSON.stringify(TOOLS.map((t) => t.inputSchema))).not.toContain('signature');
    expect(JSON.stringify(TOOLS.map((t) => t.inputSchema))).not.toContain('payer');
  });

  it('routes image/PDF formats to capture and video formats to video', async () => {
    const image = ctx({ status: 200, body: {} });
    await rpc(call('webcap_capture', { url: 'https://example.com/', format: 'pdf' }), image.context);
    expect(image.calls[0]?.path).toBe('/v1/x402/capture');
    expect(image.calls[0]?.body).toEqual({ url: 'https://example.com/', format: 'pdf' });

    const video = ctx({ status: 200, body: {} });
    await rpc(call('webcap_capture', { url: 'https://example.com/', format: 'webm', durationMs: 8000 }), video.context);
    expect(video.calls[0]?.path).toBe('/v1/x402/video');
    expect(video.calls[0]?.body).toEqual({ url: 'https://example.com/', format: 'webm', durationMs: 8000 });
  });

  it('rejects format-specific options on the wrong format', async () => {
    const a = ctx({ status: 200, body: {} });
    const r1 = await rpc(call('webcap_capture', { url: 'https://example.com/', format: 'mp4', fullPage: true }), a.context);
    expect(r1?.result.isError).toBe(true);
    expect(r1?.result.content[0].text).toContain('"fullPage" applies to png/jpeg/pdf only');

    const b = ctx({ status: 200, body: {} });
    const r2 = await rpc(call('webcap_capture', { url: 'https://example.com/', format: 'png', durationMs: 8000 }), b.context);
    expect(r2?.result.isError).toBe(true);
    expect(r2?.result.content[0].text).toContain('"durationMs" applies to mp4/webm only');
  });

  it('routes the catalog to the service descriptor', async () => {
    const c = ctx({ status: 200, body: {} });
    await rpc(call('webcap_service_catalog', {}), c.context);
    expect(c.calls[0]?.path).toBe('/v1/x402/service');
  });

  it('routes preview to the free preview endpoint, with no thumbnail mode', async () => {
    const c = ctx({ status: 200, body: {} });
    await rpc(call('webcap_preview', { url: 'https://example.com/' }), c.context);
    expect(c.calls[0]?.path).toBe('/v1/extract/preview?url=https%3A%2F%2Fexample.com%2F');
  });
});
