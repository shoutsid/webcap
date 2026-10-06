import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { USDC_SCALE, watchTopUpPriceUsdcUnits } from '../../src/config.js';
import { closeApiFixture, makeApiFixture } from './fixture.js';

interface OpenapiOperationView {
  readonly responses: Record<string, unknown>;
  readonly security?: readonly unknown[];
  readonly summary?: string;
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly required?: boolean;
  }[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content: Record<string, { readonly schema: unknown }>;
  };
  readonly 'x-payment-info'?: {
    readonly price: { readonly mode: string; readonly currency: string; readonly amount?: string; readonly min?: string; readonly max?: string };
    readonly protocols: Array<{ readonly x402?: Record<string, unknown>; readonly mpp?: Record<string, unknown> }>;
  };
}

interface OpenapiDocView {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly 'x-guidance'?: string;
    readonly contact?: { readonly email: string };
  };
  readonly servers: Array<{ url: string }>;
  readonly paths: Record<string, Record<string, OpenapiOperationView | undefined>>;
  readonly components: { readonly securitySchemes: Record<string, unknown> };
}

interface ChallengeSchemaView {
  readonly properties: {
    readonly resource: { properties: { url: { example: unknown } } };
    readonly accepts: { items: { properties: { amount: { example: unknown } } } };
  };
}

interface X402ChallengeDoc {
  readonly description: string;
  readonly headers?: Record<string, unknown>;
  readonly content?: Record<string, { schema: unknown }>;
}

/**
 * The method+path pairs registered on the app router, derived from Fastify's
 * radix-tree printRoutes output (no public route-list API exists). Tree lines
 * are 4-char indent units followed by a connector; route lines end with a
 * "(METHOD, METHOD)" suffix, internal nodes do not. Path labels split
 * mid-word in the radix tree, so the path is the concatenation of the labels
 * along the branch.
 */
function registeredRoutes(app: FastifyInstance): ReadonlyArray<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const labels: string[] = [];
  for (const line of app.printRoutes().split('\n')) {
    let i = 0;
    while (line.startsWith('│   ', i) || line.startsWith('    ', i)) {
      i += 4;
    }
    const connector = line.slice(i, i + 4);
    if (connector !== '├── ' && connector !== '└── ') continue;
    const rest = line.slice(i + 4);
    const depth = i / 4;
    const match = /^(.*) \(([A-Z]+(?:, [A-Z]+)*)\)$/.exec(rest);
    if (match === null) {
      labels[depth] = rest;
      continue;
    }
    const label = match[1];
    const methods = match[2];
    if (label === undefined || methods === undefined) continue;
    labels[depth] = label;
    const path = labels.slice(0, depth + 1).join('');
    for (const method of methods.split(', ')) {
      routes.push({ method, path });
    }
  }
  return routes;
}

/** Fastify ":param" segments -> OpenAPI "{param}" path template. */
function toOpenApiPath(path: string): string {
  return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, (segment) => `{${segment.slice(1)}}`);
}

function getDoc(app: FastifyInstance) {
  return app.inject({ method: 'GET', url: '/openapi.json' });
}

describe('GET /openapi.json (machine-readable catalog)', () => {
  it('returns the OpenAPI 3.1 document with the paid x402 paths and their 402 semantics', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'])).toContain('application/json');
      const doc = res.json() as OpenapiDocView;
      expect(doc.openapi.startsWith('3.1')).toBe(true);
      expect(doc.info.title).toBe('webcap');
      // Directory auditors (x402gle audition) reject any non-public server URL
      // in the declaration — the catalog must list exactly the public origin.
      const serverUrls = doc.servers.map((s) => s.url);
      expect(serverUrls).toEqual([fx.config.publicBaseUrl]);

      const capture = doc.paths['/v1/x402/capture']?.post;
      const extract = doc.paths['/v1/x402/extract']?.post;
      expect(capture).toBeDefined();
      expect(extract).toBeDefined();
      // 200 success + documented 402 x402 payment-required + 400 bad input
      expect(capture?.responses['200']).toBeDefined();
      expect(extract?.responses['200']).toBeDefined();
      expect(capture?.responses['402']).toBeDefined();
      expect(extract?.responses['402']).toBeDefined();
      expect(capture?.responses['400']).toBeDefined();
      expect(extract?.responses['400']).toBeDefined();
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('covers the free, artifact, discovery and landing paths', async () => {
    const fx = makeApiFixture();
    try {
      const res = await fx.app.inject({ method: 'GET', url: '/openapi.json' });
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/extract/preview']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/v1/artifacts/{id}']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/v1/artifacts/{id}']?.get?.responses['404']).toBeDefined();
      expect(doc.paths['/v1/artifacts/{id}/page']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/v1/artifacts/{id}/page']?.get?.responses['404']).toBeDefined();
      expect(doc.paths['/']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/icon.png']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/openapi.json']?.get?.responses['200']).toBeDefined();
      expect(doc.paths['/v1/x402/service']?.get?.responses['200']).toBeDefined();
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('serves a parseable OpenAPI 3.1 document: absolute paths, known methods, a success response per operation', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      expect(res.statusCode).toBe(200);
      const doc: unknown = JSON.parse(res.payload);
      expect(typeof doc).toBe('object');
      expect(doc).not.toBeNull();
      const view = doc as OpenapiDocView;
      expect(view.openapi.startsWith('3.1')).toBe(true);
      const paths = Object.keys(view.paths);
      expect(paths.length).toBeGreaterThan(0);
      // POST / is the lost-agent handler: it only ever answers 405
      // (method_not_allowed + catalog pointers), so a 2xx is not documented
      // for it by design — the 405 itself is pinned below instead.
      const never2xx = new Set(['POST /']);
      for (const path of paths) {
        expect(path.startsWith('/'), `${path} must be an absolute path template`).toBe(true);
        for (const [method, op] of Object.entries(view.paths[path] ?? {})) {
          expect(['get', 'put', 'post', 'delete', 'options', 'head', 'patch'].includes(method), `${path} has unknown method ${method}`).toBe(true);
          const key = `${method.toUpperCase()} ${path}`;
          if (never2xx.has(key)) {
            expect(Object.keys(op?.responses ?? {}), `${key} must document its 405`).toContain('405');
            continue;
          }
          const success = Object.keys(op?.responses ?? {}).some((status) => status.startsWith('2'));
          expect(success, `${method.toUpperCase()} ${path} must document a 2xx success response`).toBe(true);
        }
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the GET form of every paid route, with the same payment terms', async () => {
    // Every paid path is served for GET as well as POST (the challenge is
    // advertised per method, and a client retries the method it was given), so
    // the catalog must describe both — with one price, not two.
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const paidPaths = [
        '/v1/x402/capture',
        '/v1/x402/extract',
        '/v1/x402/audit',
        '/v1/x402/map-lite',
        '/v1/x402/video',
        '/v1/x402/analyze',
        '/v1/x402/analyze/batch',
        '/v1/x402/watches/topup',
      ] as const;
      for (const path of paidPaths) {
        const methods = doc.paths[path];
        const post = methods?.['post'];
        const get = methods?.['get'];
        expect(post?.['x-payment-info'], `${path} must stay priced`).toBeDefined();
        expect(get, `${path} must document its GET form`).toBeDefined();
        expect(get?.['x-payment-info'], `${path} GET must carry the same price info`).toEqual(post?.['x-payment-info']);
        expect(get?.responses['402'], `${path} GET must document the 402 challenge`).toBeDefined();
        expect(get?.summary).toContain('GET form');
        expect(get?.requestBody, `${path} GET must not declare a request body`).toBeUndefined();
        expect(get?.parameters?.length ?? 0, `${path} GET must list the query parameters`).toBeGreaterThan(0);
        expect(get?.parameters?.every((p) => p.in === 'query'), `${path} GET parameters must be query params`).toBe(true);
      }
      // The async submit is the one paid path that is POST-only: its GET is the
      // free per-job poll at /v1/capture/jobs/{id}, so no GET form is offered.
      expect(doc.paths['/v1/capture/jobs']?.['get'], 'POST /v1/capture/jobs must stay POST-only').toBeUndefined();
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents every route registered on the app router', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const registered = registeredRoutes(fx.app);
      expect(registered.length).toBeGreaterThanOrEqual(20);
      const missing = registered.flatMap(({ method, path }) => {
        // Fastify serves HEAD for every GET route; the catalog documents GET.
        // OpenAPI method keys are lowercase; printRoutes prints uppercase.
        const methodKey = method === 'HEAD' ? 'get' : method.toLowerCase();
        const op = doc.paths[toOpenApiPath(path)]?.[methodKey];
        return op === undefined ? [`${method} ${path}`] : [];
      });
      expect(missing).toEqual([]);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('declares a 402 challenge carrying the config price and resource on every x402 paid route', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const cases: Array<[string, number]> = [
        ['/v1/x402/capture', fx.config.x402PriceUsdcUnits],
        ['/v1/x402/extract', fx.config.x402ExtractPriceUsdcUnits],
        // the top-up challenge is priced per watch mode; the static (no ?watchId=)
        // price is the capture-mode pack price
        ['/v1/x402/watches/topup', watchTopUpPriceUsdcUnits('capture', fx.config)],
      ];
      for (const [path, priceUsdcUnits] of cases) {
        const challenge = (doc.paths[path]?.post?.responses['402'] ?? undefined) as X402ChallengeDoc | undefined;
        expect(challenge, `POST ${path} must document a 402 response`).toBeDefined();
        expect(
          challenge?.headers?.['PAYMENT-REQUIRED'],
          `POST ${path} 402 must document the base64 PAYMENT-REQUIRED header`,
        ).toBeDefined();
        const schema = (challenge?.content?.['application/json']?.schema ?? undefined) as ChallengeSchemaView | undefined;
        expect(schema, `POST ${path} 402 must document the challenge JSON body schema`).toBeDefined();
        expect(schema?.properties.accepts.items.properties.amount.example, `POST ${path} 402 amount example`).toBe(
          String(priceUsdcUnits),
        );
        expect(schema?.properties.resource.properties.url.example, `POST ${path} 402 resource url example`).toBe(
          `${fx.config.publicBaseUrl}${path}`,
        );
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the capture viewport/mobile options in the requestBody schema', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const schema = (doc.paths['/v1/x402/capture']?.post?.requestBody?.content?.['application/json']?.schema ?? {}) as {
        readonly properties?: {
          readonly options?: { readonly properties?: Record<string, unknown> };
        };
      };
      const options = schema.properties?.options?.properties ?? {};
      for (const key of ['timeoutMs', 'fullPage', 'viewport', 'deviceScaleFactor', 'isMobile', 'userAgent']) {
        expect(options, `POST /v1/x402/capture options must document ${key}`).toHaveProperty(key);
      }
      expect(options['viewport']).toMatchObject({ type: 'object' });
      expect(options['deviceScaleFactor']).toMatchObject({ type: 'number' });
      expect(options['isMobile']).toMatchObject({ type: 'boolean' });
      expect(options['userAgent']).toMatchObject({ type: 'string' });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents input validation as 422 unprocessable (error envelope) on the x402 capture/extract routes', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      for (const path of ['/v1/x402/capture', '/v1/x402/extract']) {
        const validation = (doc.paths[path]?.post?.responses['422'] ?? undefined) as X402ChallengeDoc | undefined;
        expect(validation, `POST ${path} must document 422 for invalid input (not 400-only)`).toBeDefined();
        expect(String(validation?.description ?? '')).toMatch(/unprocessable/);
        expect(validation?.content?.['application/json']?.schema).toEqual({ $ref: '#/components/schemas/Error' });
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents 502 upstream capture failures where they can occur and 429 on the rate-limited preview', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const captureFailureRoutes: Array<[string, string]> = [
        ['post', '/v1/x402/capture'],
        ['post', '/v1/x402/extract'],
        ['get', '/v1/extract/preview'],
        ['get', '/v1/og'],
      ];
      for (const [method, path] of captureFailureRoutes) {
        const failure = doc.paths[path]?.[method]?.responses['502'] as { description?: string } | undefined;
        expect(failure, `${method.toUpperCase()} ${path} must document 502`).toBeDefined();
        expect(String(failure?.description ?? '')).toMatch(/capture_failed|extract_failed/);
      }
      expect(doc.paths['/v1/extract/preview']?.get?.responses['429'], 'GET /v1/extract/preview must document 429').toBeDefined();
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the enriched twitter/article fields on GET /v1/og', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const schema = (
        doc.paths['/v1/og']?.get?.responses['200'] as {
          readonly content?: Record<string, { readonly schema?: { readonly properties?: Record<string, unknown> } }>;
        }
      )?.content?.['application/json']?.schema?.properties;
      for (const field of [
        'twitterCard',
        'twitterSite',
        'twitterCreator',
        'twitterTitle',
        'twitterDescription',
        'twitterImage',
        'articlePublishedTime',
        'articleAuthor',
        'articleSection',
        'articleTags',
      ]) {
        expect(schema, `GET /v1/og 200 schema must document ${field}`).toHaveProperty(field);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('run #2 headliner surface (spend caps, typed extract, jobs, signed artifacts)', () => {
  it('documents 429 spend_cap_exceeded exactly where the handlers enforce it', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      // Enforced: x402 capture (per-payer), credits capture (per-account), jobs submit (both rails).
      const enforced: Array<[string, string]> = [
        ['post', '/v1/x402/capture'],
        ['post', '/v1/capture'],
        ['post', '/v1/capture/jobs'],
      ];
      for (const [method, path] of enforced) {
        const limited = doc.paths[path]?.[method]?.responses['429'] as { description?: string } | undefined;
        expect(limited, `${method.toUpperCase()} ${path} must document 429`).toBeDefined();
        expect(String(limited?.description ?? '')).toMatch(/spend_cap_exceeded/);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the 402 reason detail (top-up invoice) on the credits-rail submits', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      for (const path of ['/v1/capture', '/v1/capture/jobs']) {
        const required = doc.paths[path]?.post?.responses['402'] as { description?: string } | undefined;
        expect(required, `POST ${path} must document 402`).toBeDefined();
        expect(String(required?.description ?? '')).toMatch(/insufficient_credits/);
        expect(String(required?.description ?? '')).toMatch(/invoiceId/);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the deterministic object-schema path (spans + 422 detail shape) on the extract body', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const schema = (doc.paths['/v1/x402/extract']?.post?.requestBody?.content?.['application/json']?.schema ?? {}) as {
        readonly properties?: {
          readonly schema?: { readonly type?: string; readonly description?: string };
          readonly spans?: { readonly type?: string };
        };
      };
      // Optional-only: the stringly schema field stays a string (schema-driven
      // callers synthesize valid bodies), with the object path described.
      expect(schema.properties?.schema?.type).toBe('string');
      expect(schema.properties?.schema?.description ?? '').toMatch(/deterministic/);
      expect(schema.properties?.spans?.type).toBe('array');
      const validation = doc.paths['/v1/x402/extract']?.post?.responses['422'] as { description?: string } | undefined;
      expect(String(validation?.description ?? '')).toMatch(/unsupported keyword/);
      expect(String(validation?.description ?? '')).toMatch(/dnsRebindingCaveat/);
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents the signed-artifact 403/410 on the artifact route and the jobs receipt fields', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/artifacts/{id}']?.get?.responses['403'], 'GET /v1/artifacts/{id} must document 403').toBeDefined();
      expect(doc.paths['/v1/artifacts/{id}']?.get?.responses['410'], 'GET /v1/artifacts/{id} must document 410').toBeDefined();
      const poll = (
        doc.paths['/v1/capture/jobs/{id}']?.get?.responses['200'] as {
          readonly content?: Record<string, { readonly schema?: { readonly properties?: Record<string, unknown> } }>;
        }
      )?.content?.['application/json']?.schema?.properties;
      expect(poll, 'GET /v1/capture/jobs/{id} 200 must carry the payment receipt').toHaveProperty('payment');
      const submit = (doc.paths['/v1/capture/jobs']?.post?.requestBody?.content?.['application/json']?.schema ?? {}) as {
        readonly properties?: Record<string, unknown>;
      };
      expect(submit.properties, 'POST /v1/capture/jobs must document the optional webhookUrl').toHaveProperty('webhookUrl');
    } finally {
      await closeApiFixture(fx);
    }
  });
});

describe('mppscan/x402gle discovery metadata', () => {
  // The free/public ops: genuinely open (no payment, no auth) -> security: [].
  const FREE_OPS: ReadonlyArray<readonly [method: string, path: string]> = [
    ['post', '/v1/watches'],
    ['get', '/v1/watches/{id}'],
    ['delete', '/v1/watches/{id}'],
    ['get', '/v1/extract/preview'],
    ['get', '/v1/artifacts/{id}'],
    ['get', '/v1/artifacts/{id}/page'],
    ['get', '/'],
    ['post', '/'],
    ['get', '/icon.png'],
    ['get', '/openapi.json'],
    ['get', '/v1/x402/service'],
    ['get', '/v1/health'],
    ['get', '/v1/status'],
    ['get', '/robots.txt'],
    ['get', '/sitemap.xml'],
    ['get', '/.well-known/x402'],
    ['get', '/.well-known/agent-card.json'],
    ['get', '/.well-known/agents.json'],
    ['get', '/.well-known/openai-tools.json'],
    ['get', '/.well-known/mcp-tools.json'],
    ['get', '/llms.txt'],
    ['get', '/skill.md'],
    ['get', '/AGENT.md'],
    ['post', '/v1/register'],
    ['get', '/v1/og'],
    // The remote MCP transport: public like every other free op, and it holds
    // no wallet — a paid tool call returns the challenge for the caller to pay.
    ['post', '/mcp'],
    // The MCP server descriptor a registry crawler reads instead of guessing.
    ['get', '/.well-known/mcp.json'],
    // Feedback: the machine POST + the human page, both free and security: [].
    ['post', '/v1/feedback'],
    ['get', '/feedback'],
  ];

  // The paid x402 ops: no security requirement — the auth mode is the
  // per-call settlement, declared as x-payment-info.
  const PAID_X402_OPS: ReadonlyArray<readonly [method: string, path: string]> = [
    ['post', '/v1/x402/capture'],
    ['post', '/v1/x402/extract'],
    ['post', '/v1/x402/watches/topup'],
  ];

  // The API-key ops: every one authenticates a `Bearer <key>` header.
  const BEARER_OPS: ReadonlyArray<readonly [method: string, path: string]> = [
    ['post', '/v1/invoice'],
    ['post', '/v1/capture'],
    ['post', '/v1/extract'],
    ['post', '/v1/audit'],
    ['post', '/v1/map-lite'],
    ['post', '/v1/video'],
    ['post', '/v1/analyze'],
    ['post', '/v1/analyze/batch'],
    ['post', '/v1/watches/{id}/topup'],
    ['get', '/v1/ledger'],
    ['get', '/v1/account'],
    ['get', '/v1/admin/hits/summary'],
    ['get', '/v1/admin/analytics'],
    ['get', '/v1/admin/waitlist'],
    ['post', '/v1/webhooks'],
    ['get', '/v1/webhooks'],
    ['delete', '/v1/webhooks/{id}'],
  ];

  it('documents x-payment-info on POST /v1/x402/capture with the fixed config price', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/x402/capture']?.post?.['x-payment-info']).toEqual({
        price: { mode: 'fixed', currency: 'USD', amount: (fx.config.x402PriceUsdcUnits / USDC_SCALE).toFixed(6) },
        protocols: [{ x402: {} }, { mpp: { method: 'evm' } }],
      });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents x-payment-info on POST /v1/x402/extract with the fixed extract price', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/x402/extract']?.post?.['x-payment-info']).toEqual({
        price: { mode: 'fixed', currency: 'USD', amount: (fx.config.x402ExtractPriceUsdcUnits / USDC_SCALE).toFixed(6) },
        protocols: [{ x402: {} }, { mpp: { method: 'evm' } }],
      });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents x-payment-info on POST /v1/capture/jobs (the async submit is a paid route)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/capture/jobs']?.post?.['x-payment-info']).toEqual({
        price: { mode: 'fixed', currency: 'USD', amount: (fx.config.x402PriceUsdcUnits / USDC_SCALE).toFixed(6) },
        protocols: [{ x402: {} }, { mpp: { method: 'evm' } }],
      });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents x-payment-info on POST /v1/x402/watches/topup with the dynamic min/max pack prices', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.paths['/v1/x402/watches/topup']?.post?.['x-payment-info']).toEqual({
        price: {
          mode: 'dynamic',
          currency: 'USD',
          min: (watchTopUpPriceUsdcUnits('capture', fx.config) / USDC_SCALE).toFixed(6),
          max: (watchTopUpPriceUsdcUnits('extract', fx.config) / USDC_SCALE).toFixed(6),
        },
        protocols: [{ x402: {} }, { mpp: { method: 'evm' } }],
      });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents info["x-guidance"] with the config-derived prices and the x402 payment flow', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const guidance = doc.info['x-guidance'];
      expect(typeof guidance).toBe('string');
      expect((guidance ?? '').length > 0).toBe(true);
      // Same trimmed-decimal format as the usd() helper in src/server/openapi.ts:
      // (units / USDC_SCALE).toString() — 1000 -> '0.001', 10000 -> '0.01'.
      expect(guidance).toContain('capture');
      expect(guidance).toContain('extract');
      expect(guidance).toContain((fx.config.x402PriceUsdcUnits / USDC_SCALE).toString());
      expect(guidance).toContain((fx.config.x402ExtractPriceUsdcUnits / USDC_SCALE).toString());
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents info["x-guidance"] with the video + map-lite prices (all five paid routes)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const guidance = doc.info['x-guidance'] ?? '';
      expect(guidance).toContain('/v1/x402/video');
      expect(guidance).toContain((fx.config.x402VideoPriceUsdcUnits / USDC_SCALE).toString());
      expect(guidance).toContain('/v1/x402/map-lite');
      expect(guidance).toContain((fx.config.x402AuditPriceUsdcUnits / USDC_SCALE).toString());
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('omits info.contact entirely when no contact email is configured', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.info).not.toHaveProperty('contact');
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('documents info.contact.email when a contact email is configured', async () => {
    const fx = makeApiFixture({ contactEmail: 'ops@webcap.dev' });
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(doc.info.contact).toEqual({ email: 'ops@webcap.dev' });
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('declares security: [] on every free/public op (the explicit list)', async () => {
    const fx = makeApiFixture();
    try {
      expect(FREE_OPS.length).toBe(29);
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      for (const [method, path] of FREE_OPS) {
        expect(doc.paths[path]?.[method]?.security, `${method.toUpperCase()} ${path} must declare security: []`).toEqual([]);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('references the declared apiKey scheme on every API-key op', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      expect(Object.keys(doc.components.securitySchemes)).toContain('apiKey');
      for (const [method, path] of BEARER_OPS) {
        const op = doc.paths[path]?.[method];
        expect(op, `${method.toUpperCase()} ${path} must be documented`).toBeDefined();
        expect(op?.security, `${method.toUpperCase()} ${path} must require the apiKey scheme`).toEqual([{ apiKey: [] }]);
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  it('leaves the paid x402 ops on x-payment-info (settlement is the auth mode, not a key)', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      for (const [method, path] of PAID_X402_OPS) {
        const op = doc.paths[path]?.[method];
        expect(op, `${method.toUpperCase()} ${path} must be documented`).toBeDefined();
        expect(op?.['x-payment-info'], `${method.toUpperCase()} ${path} must carry x-payment-info`).toBeDefined();
        expect(Object.keys(op ?? {}), `${method.toUpperCase()} ${path} must not declare security`).not.toContain('security');
      }
    } finally {
      await closeApiFixture(fx);
    }
  });

  // The rule mppscan enforces when it registers an origin: an operation with no
  // declared auth mode is skipped as "unprotected" — 10 of our routes were, and
  // they silently did not exist in the listing. Either declare a scheme, carry
  // x-payment-info, or say `security: []` (explicitly public).
  it('declares an auth mode on every documented operation (scheme, x-payment-info, or explicit [] )', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const undeclared: string[] = [];
      const schemes = new Set(Object.keys(doc.components.securitySchemes));
      const referenced = new Set<string>();
      let operations = 0;
      for (const [path, methods] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          if (op === undefined) continue;
          operations += 1;
          const security = op.security;
          for (const requirement of security ?? []) {
            for (const name of Object.keys(requirement as Record<string, unknown>)) referenced.add(name);
          }
          if (security === undefined && op['x-payment-info'] === undefined) undeclared.push(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(operations).toBeGreaterThan(0);
      expect(undeclared, 'these operations declare no auth mode and will be skipped by directory auditors').toEqual([]);
      expect([...referenced].filter((name) => !schemes.has(name))).toEqual([]);
    } finally {
      await closeApiFixture(fx);
    }
  });

  // Schema-driven auditors (x402gle's verifier) synthesize the paid request
  // body from the requestBody schema: an unambiguous url|urls target and a
  // clearly stringly schema field are what keep the synthesized body valid
  // at runtime (the live audition otherwise 422s before settling).
  it('documents the extract body with a oneOf url|urls target so synthesized requests carry a valid URL', async () => {
    const fx = makeApiFixture();
    try {
      const res = await getDoc(fx.app);
      const doc = res.json() as OpenapiDocView;
      const schema = (doc.paths['/v1/x402/extract']?.post?.requestBody?.content?.['application/json']?.schema ?? {}) as {
        readonly oneOf?: Array<{ readonly required?: string[] }>;
        readonly properties?: {
          readonly url?: { readonly format?: string; readonly example?: string };
          readonly schema?: { readonly type?: string; readonly description?: string };
        };
      };
      const oneOf = schema.oneOf ?? [];
      const requiredSets = oneOf.map((variant) => [...(variant.required ?? [])].sort());
      expect(requiredSets).toContainEqual(['url']);
      expect(requiredSets).toContainEqual(['urls']);
      expect(schema.properties?.url?.format).toBe('uri');
      expect(schema.properties?.url?.example).toMatch(/^https:\/\//);
      expect(schema.properties?.schema?.type).toBe('string');
      expect(schema.properties?.schema?.description ?? '').toMatch(/not a JSON object/i);
    } finally {
      await closeApiFixture(fx);
    }
  });
});
