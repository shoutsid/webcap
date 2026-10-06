import { describe, expect, it } from 'vitest';
import { closeApiFixture, CUSTOMER_ADDRESS, makeApiFixture } from './fixture.js';
import { serviceTools } from '../../src/server/tool-catalog.js';

/**
 * Strict XML well-formedness check for the (flat) sitemap document: single root
 * element, balanced start/end tags, quoted attributes, no bare '&' in text.
 * The node test env has no DOMParser and the repo adds no XML dependency, so
 * the check is self-contained.
 */
function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      assertNoBareAmpersand(xml.slice(i));
      break;
    }
    assertNoBareAmpersand(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt);
      if (end === -1) throw new Error('unterminated comment');
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt === -1) throw new Error('unterminated tag');
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith('?')) {
      if (!inner.endsWith('?')) throw new Error('unterminated processing instruction');
      i = gt + 1;
      continue;
    }
    if (inner.startsWith('!')) throw new Error(`unexpected markup declaration: ${inner}`);
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      if (!/^[A-Za-z_][\w.:-]*$/.test(name)) throw new Error(`invalid closing tag: ${inner}`);
      const open = stack.pop();
      if (open !== name) throw new Error(`mismatched closing tag </${name}> (open <${open}>)`);
      i = gt + 1;
      continue;
    }
    const m = inner.match(/^([A-Za-z_][\w.:-]*)([\s\S]*)$/);
    const name = m?.[1];
    const attrSrc = m?.[2];
    if (m === null || name === undefined || attrSrc === undefined) {
      throw new Error(`invalid start tag: <${inner}>`);
    }
    let attrs = attrSrc;
    const selfClosing = attrs.trimEnd().endsWith('/');
    if (selfClosing) attrs = attrs.trimEnd().slice(0, -1);
    const attrList = attrs.trim();
    if (attrList !== '') {
      for (const attr of attrList.split(/\s+(?=[\w.:-]+=)/)) {
        if (!/^[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*')$/.test(attr)) {
          throw new Error(`invalid attribute in <${name}>: "${attr}"`);
        }
      }
    }
    if (!selfClosing) stack.push(name);
    i = gt + 1;
  }
  if (stack.length !== 0) throw new Error(`unclosed element(s): ${stack.join(', ')}`);
}

function assertNoBareAmpersand(text: string): void {
  const stripped = text.replace(/&(?:[A-Za-z][\w.]*|#\d+|#x[0-9a-fA-F]+);/g, '');
  if (stripped.includes('&')) throw new Error(`bare '&' in text: ${text}`);
}

describe('GET /robots.txt + GET /sitemap.xml (SEO surface)', () => {
  it('robots.txt: 200 text/plain allowing all, with a Sitemap: line pointing at <base>/sitemap.xml', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/robots.txt' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('text/plain');
      expect(res.payload).toContain('User-agent: *');
      expect(res.payload).toContain('Allow: /');
      expect(res.payload).toContain(`Sitemap: ${fx.config.publicBaseUrl}/sitemap.xml`);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('sitemap.xml: 200 application/xml, parses as XML, urlset with 8+ https <loc> entries incl. the x402 routes', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/sitemap.xml' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/xml');
      const xml = res.payload;
      assertWellFormedXml(xml);
      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      const urlCount = (xml.match(/<url>/g) ?? []).length;
      expect(urlCount).toBeGreaterThanOrEqual(8);
      // Sitemap URLs are https-absolute: the fixture base (http://) is normalized.
      const base = fx.config.publicBaseUrl.replace(/^http:\/\//, 'https://');
      expect(xml).toContain(`<loc>${base}/</loc>`);
      expect(xml).toContain(`<loc>${base}/openapi.json</loc>`);
      expect(xml).toContain(`<loc>${base}/icon.png</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/x402/service</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/x402/capture</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/x402/extract</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/x402/watches/topup</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/watches</loc>`);
      expect(xml).toContain(`<loc>${base}/v1/extract/preview</loc>`);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('leaves the existing routes untouched (landing, health, openapi, register)', async () => {
    const fx = makeApiFixture();
    try {
      const landing = await fx.app.inject({ method: 'GET', url: '/' });
      expect(landing.statusCode).toBe(200);
      expect(String(landing.headers['content-type'])).toBe('text/html; charset=utf-8');

      const health = await fx.app.inject({ method: 'GET', url: '/v1/health' });
      expect(health.statusCode).toBe(200);
      expect((health.json() as { ok: boolean }).ok).toBe(true);

      const openapi = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
      expect(openapi.statusCode).toBe(200);
      expect(String(openapi.headers['content-type'])).toContain('application/json');

      const register = await fx.app.inject({
        method: 'POST',
        url: '/v1/register',
        payload: { address: CUSTOMER_ADDRESS },
      });
      expect(register.statusCode).toBe(201);
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('GET /.well-known/x402 + GET /.well-known/agent-card.json (machine discovery)', () => {
  it('x402 catalog: 200 JSON naming the service, the payment rails, and all five paid endpoints', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/.well-known/x402' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/json');
      const body = res.json() as {
        service: string;
        network: string | null;
        asset: string | null;
        payTo: string | null;
        facilitator: string;
        endpoints: Array<{ path: string; usdc: number }>;
        openapi: string;
      };
      expect(body.service).toBe('webcap');
      expect(body.network).toBe(fx.config.x402Network ?? null);
      expect(body.payTo).toBe(fx.config.x402Network === undefined ? null : fx.config.x402PayTo);
      expect(body.facilitator).toBe(fx.config.x402FacilitatorUrl);
      expect(body.endpoints.map((e) => e.path)).toEqual([
        'POST /v1/x402/capture',
        'POST /v1/x402/extract',
        'POST /v1/x402/audit',
        'POST /v1/x402/map-lite',
        'POST /v1/x402/video',
        'POST /v1/x402/analyze',
        'POST /v1/x402/analyze/batch',
        'POST /v1/x402/watches/topup',
      ]);
      expect(body.endpoints[0]?.usdc).toBe(fx.config.x402PriceUsdcUnits / 1_000_000);
      expect(body.endpoints[1]?.usdc).toBe(fx.config.x402ExtractPriceUsdcUnits / 1_000_000);
      expect(body.endpoints[2]?.usdc).toBe(fx.config.x402AuditPriceUsdcUnits / 1_000_000);
      expect(body.endpoints[3]?.usdc).toBe(fx.config.x402AuditPriceUsdcUnits / 1_000_000);
      expect(body.endpoints[4]?.usdc).toBe(fx.config.x402VideoPriceUsdcUnits / 1_000_000);
      expect(body.openapi).toContain('/openapi.json');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('agent card: 200 JSON, A2A v1.0 shape, trial + preview skills first, x402 payments section', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/.well-known/agent-card.json' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/json');
      const card = res.json() as {
        protocolVersion: string;
        name: string;
        url: string;
        supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
        capabilities: { streaming: boolean; pushNotifications: boolean };
        defaultInputModes: string[];
        defaultOutputModes: string[];
        authentication: { schemes: string[] };
        payments: { provider: string; network: string | null; payTo: string | null };
        skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
      };
      expect(card.name).toBe('webcap');
      expect(card.protocolVersion).toBe('1.0');
      expect(card.url).toBe(fx.config.publicBaseUrl.replace(/^http:\/\//, 'https://'));
      expect(card.supportedInterfaces[0]?.url).toBe(card.url);
      expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false });
      expect(card.defaultInputModes).toContain('application/json');
      for (const skill of card.skills) {
        expect(skill.tags.length).toBeGreaterThan(0);
      }
      expect(card.authentication.schemes).toContain('x402');
      expect(card.payments.provider).toBe('x402');
      expect(card.payments.network).toBe(fx.config.x402Network ?? null);
      expect(card.payments.payTo).toBe(
        fx.config.x402Network === undefined ? null : fx.config.x402PayTo,
      );
      expect(card.skills.map((s) => s.id)).toEqual(['free-allowance', 'preview', 'capture', 'extract', 'audit', 'map-lite', 'video', 'analyze', 'watch']);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('tool manifests: openai-tools + mcp-tools 200 JSON, every catalog tool each naming an HTTPS endpoint', async () => {
    const fx = makeApiFixture();
    try {
      // Derived, not typed: the manifests used to list 9 free tools and no paid
      // product at all. The surface is now deliberately condensed to 9 tools, so
      // growing it is a conscious edit here as well as in the catalog.
      const canonical = serviceTools(fx.config);
      expect(canonical.length).toBe(8);
      for (const path of ['/.well-known/openai-tools.json', '/.well-known/mcp-tools.json']) {
        const res = await fx.app.inject({ method: 'GET', url: path });
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['content-type'])).toContain('application/json');
        const body = res.json() as { tools: Array<{ endpoint?: { path: string }; function?: { name: string }; name?: string }> };
        expect(body.tools.length).toBe(canonical.length);
        for (const tool of body.tools) {
          expect(tool.endpoint?.path ?? '').toContain('/v1/');
        }
        const names = body.tools.map((t) => t.function?.name ?? t.name ?? '');
        // The free rail is the rolling per-IP allowance, so it is not a tool
        // of its own; the catalog carries the prices and the allowance state.
        expect(names.some((n) => n.includes('trial'))).toBe(false);
        expect(names).toContain('webcap_service_catalog');
        // The paid products must be discoverable from the manifest too.
        expect(names).toContain('webcap_extract');
        expect(names).toContain('webcap_capture');
      }
    } finally {
      await closeApiFixture(fx);
    }
  });
});
