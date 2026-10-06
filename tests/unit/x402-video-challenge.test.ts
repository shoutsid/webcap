import { describe, expect, it } from 'vitest';
import type { BodyDiscoveryExtension } from '@x402/extensions/bazaar';
import type { RouteConfig } from '@x402/core/server';
import type { WebcapConfig } from '../../src/config.js';
import { openapiDocument } from '../../src/server/openapi.js';
import { buildUnpaidBody, buildX402Requirement, buildX402Routes } from '../../src/server/x402.js';
import * as challenges from '../../src/server/x402/challenges.js';

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT_ADDRESS = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';

const X402_VIDEO_PATTERN = 'POST /v1/x402/video';
const X402_VIDEO_PATH = '/v1/x402/video';

/** x402-enabled config literal (pattern of tests/unit/x402-bazaar.test.ts, base-sepolia network). */
function makeConfig(): WebcapConfig {
  return {
    chain: {
      name: 'base-sepolia',
      rpcUrl: 'https://sepolia.base.org',
      chainId: 84532,
      usdcContract: SEPOLIA_USDC,
      explorer: 'https://sepolia.basescan.org',
    },
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    usdcAddress: SEPOLIA_USDC,
    merchantAddress: MERCHANT_ADDRESS,
    port: 0,
    pollIntervalMs: 5_000,
    merchantPrivateKey: '',
    dbPath: 'data/webcap.db',
    x402Network: 'eip155:84532',
    x402Asset: SEPOLIA_USDC,
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
}

// Namespace access (not static imports): the video challenge surface lands
// with GREEN, so RED must fail at runtime while tsc stays clean.
const videoChallenges = challenges as unknown as Record<string, unknown>;

function videoInputSchema(): Record<string, unknown> {
  const schema = videoChallenges['VIDEO_INPUT_SCHEMA'];
  expect(schema, 'VIDEO_INPUT_SCHEMA must be exported from x402/challenges.ts').toBeDefined();
  return schema as Record<string, unknown>;
}

function videoOutputExample(): Record<string, unknown> {
  const example = videoChallenges['VIDEO_OUTPUT_EXAMPLE'];
  expect(example, 'VIDEO_OUTPUT_EXAMPLE must be exported from x402/challenges.ts').toBeDefined();
  return example as Record<string, unknown>;
}

function buildVideoBazaarExtension(): BodyDiscoveryExtension {
  const build = videoChallenges['buildVideoBazaarExtension'];
  expect(build, 'buildVideoBazaarExtension must be exported from x402/challenges.ts').toBeDefined();
  return (build as () => BodyDiscoveryExtension)();
}

function bazaarOf(route: { readonly extensions?: Record<string, unknown> }): BodyDiscoveryExtension {
  const ext = route.extensions?.['bazaar'];
  expect(ext).toBeDefined();
  return ext as BodyDiscoveryExtension;
}

describe('x402 video challenge identity (challenge == config == OpenAPI == bazaar example)', () => {
  const config = makeConfig();

  it('exposes POST /v1/x402/video via x402RouteConfig with the config video price (5000)', () => {
    const routes = buildX402Routes(config) as Record<string, RouteConfig>;
    const route = routes[X402_VIDEO_PATTERN];
    expect(route, `${X402_VIDEO_PATTERN} must be registered`).toBeDefined();
    expect(route?.resource).toBe(`${config.publicBaseUrl}${X402_VIDEO_PATH}`);
    expect(route?.serviceName).toBe('Webcap');
    const price = (route?.accepts as unknown as { price: { amount: string } }).price;
    expect(price.amount).toBe(String(config.x402VideoPriceUsdcUnits));
    expect(price.amount).toBe('5000');
  });

  it('mirrors the GET discovery pattern onto the same route config', () => {
    const routes = buildX402Routes(config) as Record<string, RouteConfig>;
    const post = routes[X402_VIDEO_PATTERN];
    expect(post, `${X402_VIDEO_PATTERN} must be registered`).toBeDefined();
    expect(routes[`GET ${X402_VIDEO_PATH}`]).toBe(post);
  });

  it('VIDEO_INPUT_SCHEMA mirrors parseVideoRequest (required url, mp4|webm format, scroll opts)', () => {
    const schema = videoInputSchema();
    expect(schema['type']).toBe('object');
    expect(schema['required']).toEqual(expect.arrayContaining(['url']));
    const props = schema['properties'] as Record<string, unknown>;
    expect(props['url']).toMatchObject({ type: 'string' });
    expect(props['format']).toMatchObject({ type: 'string', enum: ['mp4', 'webm'] });
    for (const key of ['durationMs', 'scrollSpeed', 'scrollEasing']) {
      expect(props, `VIDEO_INPUT_SCHEMA must describe scroll opt ${key}`).toHaveProperty(key);
    }
    expect(props['scrollEasing']).toMatchObject({ type: 'string', enum: ['linear', 'ease-in-out'] });
  });

  it('VIDEO_OUTPUT_EXAMPLE prices the video at 5000 atomic units and reports video/webm', () => {
    const example = videoOutputExample();
    const payment = example['payment'] as Record<string, unknown>;
    expect(payment['priceUsdcUnits']).toBe(5_000);
    expect(payment['priceUsdcUnits']).toBe(config.x402VideoPriceUsdcUnits);
    expect(example['artifact']).toMatchObject({ mime: 'video/webm' });
  });

  it('buildVideoBazaarExtension advertises the schema + the 5000-unit output example over POST json', () => {
    const bazaar = buildVideoBazaarExtension();
    expect(bazaar.info.input.type).toBe('http');
    expect(bazaar.info.input.method).toBe('POST');
    expect(bazaar.info.input.bodyType).toBe('json');
    expect(bazaar.info.output?.example).toEqual(videoOutputExample());
    const body = bazaar.schema.properties.input.properties.body;
    expect(body['type']).toBe('object');
    expect(body['required']).toEqual(expect.arrayContaining(['url']));
  });

  it('the registered route carries the bazaar extension (service metadata + 5000-unit example)', () => {
    const routes = buildX402Routes(config) as Record<string, RouteConfig>;
    const bazaar = bazaarOf(routes[X402_VIDEO_PATTERN] ?? {});
    expect(bazaar.info.input.method).toBe('POST');
    expect(bazaar.info.output?.example).toEqual(videoOutputExample());
  });

  it('buildUnpaidBody at the config video price challenges 5000 units on the video resource', () => {
    const routes = buildX402Routes(config) as Record<string, RouteConfig>;
    const route = routes[X402_VIDEO_PATTERN];
    expect(route).toBeDefined();
    const body = buildUnpaidBody(
      buildX402Requirement(config, config.x402VideoPriceUsdcUnits),
      'video',
      {
        resourceUrl: route?.resource ?? '',
        serviceName: route?.serviceName ?? '',
        tags: route?.tags ?? [],
        iconUrl: route?.iconUrl ?? '',
        bazaar: bazaarOf(route ?? {}),
      },
    );
    expect(body.accepts[0]?.amount).toBe('5000');
    expect(body.resource.url).toBe(`${config.publicBaseUrl}${X402_VIDEO_PATH}`);
  });

  it('the OpenAPI catalog documents POST /v1/x402/video at 0.005000 USDC with both protocols', async () => {
    const doc = await openapiDocument(config);
    const paths = doc.paths as unknown as Record<string, Record<string, Record<string, unknown> | undefined>>;
    const op = paths[X402_VIDEO_PATH]?.['post'];
    expect(op, 'POST /v1/x402/video must be documented in the OpenAPI catalog').toBeDefined();
    expect(op?.['x-payment-info']).toEqual({
      price: { mode: 'fixed', currency: 'USD', amount: '0.005000' },
      protocols: [{ x402: {} }, { mpp: { method: 'evm' } }],
    });
    const responses = op?.['responses'] as Record<string, Record<string, unknown>>;
    const schema = (
      responses['402'] as { content: { 'application/json': { schema: { properties: { accepts: { items: { properties: { amount: { example: unknown } } } } } } } } }
    ).content['application/json'].schema;
    expect(schema.properties.accepts.items.properties.amount.example).toBe('5000');
  });
});
