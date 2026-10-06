/**
 * The three tool catalogs must agree.
 *
 * Before this test they did not. `/.well-known/openai-tools.json` and
 * `/.well-known/mcp-tools.json` listed 9 tools, every one free, and not a
 * single paid product; the MCP server's table listed 11 tools, including all 6
 * paid products and no trial at all. Their intersection was two tools
 * (`webcap_preview`, `webcap_og`).
 *
 * That is rule 2's failure mode with a price tag: an agent wiring webcap from a
 * manifest learned that we sell nothing, and an MCP host never learned that the
 * free trial rail exists. Crawlers do read these files: BrickBlueBot
 * (agentic-web registry) fetches our discovery paths on a schedule, and
 * `/.well-known/mcp.json` is what it asks for.
 *
 * The catalog in src/server/tool-catalog.ts is now the single source of truth.
 * This test fails the moment a surface drifts from it again.
 */
import { describe, expect, it } from 'vitest';
import { makeApiFixture, closeApiFixture, type ApiFixture } from '../api/fixture.js';
import { serviceTools, catalogToolNames } from '../../src/server/tool-catalog.js';
import { TOOLS } from '../../src/mcp/server.js';
import { USDC_SCALE } from '../../src/config.js';

interface ManifestTool {
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly endpoint?: { method?: string; path?: string };
  readonly function?: { name?: string; description?: string; parameters?: unknown };
}

interface Manifest {
  readonly tools?: readonly ManifestTool[];
  readonly server?: { version?: string };
  readonly mcp?: { url?: string; method?: string };
}

async function manifest(fx: ApiFixture, path: string): Promise<Manifest> {
  const res = await fx.app.inject({ method: 'GET', url: path });
  expect(res.statusCode, `${path} must be served`).toBe(200);
  return res.json() as Manifest;
}

/** Same fields regardless of which of the two manifest shapes we are reading. */
function namesAndDescriptions(m: Manifest): Array<{ name: string; description: string }> {
  return (m.tools ?? []).map((t) => ({
    name: t.function?.name ?? t.name ?? '',
    description: t.function?.description ?? t.description ?? '',
  }));
}

describe('every tool surface describes the same service', () => {
  it('exposes the same tool names on the manifests and on the MCP server', async () => {
    const fx = makeApiFixture();
    try {
      const canonical = [...catalogToolNames(fx.config)].sort();
      expect(canonical.length).toBeGreaterThan(0);

      const openai = await manifest(fx, '/.well-known/openai-tools.json');
      const mcp = await manifest(fx, '/.well-known/mcp-tools.json');
      expect(namesAndDescriptions(openai).map((t) => t.name).sort()).toEqual(canonical);
      expect(namesAndDescriptions(mcp).map((t) => t.name).sort()).toEqual(canonical);
      // The transport's own tools/list is the fourth surface; a host that
      // connects over MCP must see exactly what the manifests promised.
      expect([...TOOLS.map((t) => t.name)].sort()).toEqual(canonical);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('lists every paid product on every surface, not just free tools', async () => {
    // The specific regression: manifests used to advertise zero paid products.
    // Five products now (video folded into webcap_capture), not six tools.
    const fx = makeApiFixture();
    try {
      const paid = serviceTools(fx.config).filter((t) => !t.free).map((t) => t.name);
      expect(paid.length).toBe(5);
      for (const path of ['/.well-known/openai-tools.json', '/.well-known/mcp-tools.json']) {
        const names = namesAndDescriptions(await manifest(fx, path)).map((t) => t.name);
        for (const name of paid) {
          expect(names, `${path} must advertise the paid product ${name}`).toContain(name);
        }
      }
      expect(TOOLS.filter((t) => !t.free).map((t) => t.name).sort()).toEqual([...paid].sort());
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('has retired the wallet-signed trial rail from every surface', async () => {
    // Free access is the rolling per-IP allowance now (src/db/allowance.ts),
    // which is not a tool: an agent calls the real product. Nothing on any
    // surface may still promise a trial or ask for a wallet signature.
    const fx = makeApiFixture();
    try {
      const names = serviceTools(fx.config).map((t) => t.name);
      expect(names.some((n) => n.includes('trial'))).toBe(false);
      for (const path of ['/.well-known/openai-tools.json', '/.well-known/mcp-tools.json']) {
        const body = await manifest(fx, path);
        const advertised = namesAndDescriptions(body).map((t) => t.name);
        expect(advertised.some((n) => n.includes('trial')), `${path} still advertises a trial`).toBe(false);
        expect(JSON.stringify(body)).not.toContain('personal_sign');
      }
      expect(TOOLS.some((t) => t.name.includes('trial')), 'the MCP server still exposes a trial tool').toBe(false);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('states the configured price in every paid tool description', async () => {
    // A description that omits the price is how a manifest quietly stops
    // matching the 402 challenge. Prices are config-derived, never typed.
    const fx = makeApiFixture();
    try {
      const priceOf = new Map(serviceTools(fx.config).filter((t) => !t.free).map((t) => [t.name, `$${t.priceUsdcUnits! / USDC_SCALE}`]));
      for (const path of ['/.well-known/openai-tools.json', '/.well-known/mcp-tools.json']) {
        for (const tool of namesAndDescriptions(await manifest(fx, path))) {
          const price = priceOf.get(tool.name);
          if (price === undefined) continue;
          expect(tool.description, `${path} ${tool.name} must state its price (${price})`).toContain(price);
        }
      }
      for (const tool of TOOLS.filter((t) => !t.free)) {
        expect(tool.description, `MCP ${tool.name} must state its price`).toMatch(/PAID \(\$/);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('reports one version across the service, the manifests and the agent card', async () => {
    // The card and the mcp-tools manifest used to say 1.1.0 while /v1/status and
    // MCP initialize said 0.1.0: three surfaces, two answers.
    const fx = makeApiFixture();
    try {
      const status = (await fx.app.inject({ method: 'GET', url: '/v1/status' })).json() as { version?: string };
      const card = (await fx.app.inject({ method: 'GET', url: '/.well-known/agent-card.json' })).json() as { version?: string };
      const mcp = await manifest(fx, '/.well-known/mcp-tools.json');
      const init = await fx.app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      });
      const initVersion = ((init.json() as { result?: { serverInfo?: { version?: string } } }).result?.serverInfo?.version) ?? '';
      expect(status.version).toBeTruthy();
      expect(card.version).toBe(status.version);
      expect(mcp.server?.version).toBe(status.version);
      expect(initVersion).toBe(status.version);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('exposes the same parameter shape on the MCP server as in the catalog', async () => {
    // The audit's loudest complaint was parameter inconsistency (`url` vs
    // `urls`, an undeclared default). Matching names are not enough: this pins
    // the property set, the required list and any oneOf alternatives per tool.
    const fx = makeApiFixture();
    try {
      const catalog = new Map(serviceTools(fx.config).map((t) => [t.name, t]));
      for (const tool of TOOLS) {
        const entry = catalog.get(tool.name);
        expect(entry, `catalog is missing ${tool.name}`).toBeDefined();
        const mcp = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[]; oneOf?: unknown };
        const cat = entry?.inputSchema as { properties?: Record<string, unknown>; required?: string[]; oneOf?: unknown };
        expect(Object.keys(mcp.properties ?? {}).sort(), `${tool.name} parameters`).toEqual(
          Object.keys(cat.properties ?? {}).sort(),
        );
        expect([...(mcp.required ?? [])].sort(), `${tool.name} required`).toEqual([...(cat.required ?? [])].sort());
        expect(mcp.oneOf, `${tool.name} url|urls alternatives`).toEqual(cat.oneOf);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });
});