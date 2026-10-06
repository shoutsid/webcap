/**
 * The x402 402-challenge builders for webcap's paid routes: the bazaar
 * discovery-extension specs (input schemas + output examples, pinned to the
 * POST verb by withRoutedMethod) and buildUnpaidBody, the static mirror of
 * the PAYMENT-REQUIRED header that every 402 response body carries. Split out
 * of x402.ts as a pure move (no behavior change); x402.ts re-exports
 * everything it used to.
 */
import {
  declareDiscoveryExtension,
  type BodyDiscoveryExtension,
  type DiscoveryExtension,
} from '@x402/extensions/bazaar';
import type { BodyMethods } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { PACKS, WATCH_TOPUP_RUNS, watchTopUpPriceUsdcUnits, type WebcapConfig } from '../../config.js';
import { MAX_EXTRACT_BATCH } from '../extract-parse.js';

const X402_VERSION = 2;
export const X402_CAPTURE_DESCRIPTION = 'Capture a URL as PNG/JPEG/PDF + free OG metadata';
export const X402_EXTRACT_DESCRIPTION = 'Capture a URL and return its structured content (title, headings, text, links, images) as JSON';
export const X402_TOPUP_DESCRIPTION =
  'Top up a webcap watch with a 100-run pack, priced at the watch mode unit price x 100 (capture or extract)';
export const X402_AUDIT_DESCRIPTION = 'Audit a URL for SEO basics + link/OG health in one call';
export const X402_MAP_LITE_DESCRIPTION = 'Map a site to its URL list via sitemap/robots plus a 1-hop same-host crawl in one call';
export const X402_VIDEO_DESCRIPTION = 'Scroll-capture a URL as a WebM/VP8 video in one call';
export const X402_ANALYZE_DESCRIPTION = 'AI-powered visual analysis of a page screenshot (classification, accessibility, entities, sentiment, layout)';
export const X402_MIME_TYPE = 'application/json';

export const BAZAAR_SERVICE_NAME = 'Webcap';
export const BAZAAR_TAGS = ['screenshot', 'web-capture', 'pdf', 'markdown', 'text-extraction'];
const BAZAAR_HTTP_METHOD = 'POST';
// Placeholder payer for the output examples (never a real merchant address);
// also imported by the OpenAPI catalog so every doc example uses one literal.
export const BAZAAR_EXAMPLE_PAYER = '0x000000000000000000000000000000000000dEaD';

/** Shared capture-option properties for the capture + extract input schemas (mirrors parseOptions in ../capture-parse.ts). */
const CAPTURE_OPTIONS_PROPERTIES: Record<string, unknown> = {
  timeoutMs: { type: 'integer', description: 'Page load timeout in milliseconds' },
  fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
  viewport: {
    type: 'object',
    description: 'Capture viewport in CSS pixels (clamped to 320-3840 wide, 320-2160 tall)',
    properties: {
      width: { type: 'integer', description: 'Viewport width in CSS pixels' },
      height: { type: 'integer', description: 'Viewport height in CSS pixels' },
    },
  },
  deviceScaleFactor: { type: 'number', description: 'Device pixel ratio (clamped to at most 3)' },
  isMobile: { type: 'boolean', description: 'Render with a mobile viewport' },
  userAgent: { type: 'string', description: 'Custom user agent string' },
  proxy: { type: 'string', description: 'Proxy: "auto", "stealth", or an http(s) proxy URL string' },
  waitFor: {
    type: 'object',
    description: 'Wait for a selector before capture (timeoutMs capped at 10000)',
    properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds (capped at 10000)' },
    },
  },
  maxContentWords: {
    type: 'integer',
    description:
      'Word budget for the extracted main content (paragraphs + markdown). Lets an agent size a page to its context window; content is cut at a block boundary and content.truncated reports it',
  },
  actions: {
    type: 'array',
    description: 'Post-load actions: click/type/wait objects (1 to 5)',
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['click', 'type', 'wait'], description: 'Action kind' },
        selector: { type: 'string', description: 'CSS selector (click/type)' },
        text: { type: 'string', description: 'Text to type (type only)' },
        timeoutMs: { type: 'integer', description: 'Wait duration in milliseconds (wait only, capped at 10000)' },
      },
    },
    minItems: 1,
    maxItems: 5,
  },
};

/** Bazaar input schema for POST /v1/x402/capture — mirrors url + parseFormat/parseOptions. */
const CAPTURE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The page to capture' },
    format: { type: 'string', enum: ['png', 'jpeg', 'pdf'], description: 'Screenshot format (default png)' },
    options: {
      type: 'object',
      description: 'Capture options',
      properties: CAPTURE_OPTIONS_PROPERTIES,
      additionalProperties: false,
    },
  },
  required: ['url'],
};

const CAPTURE_OUTPUT_EXAMPLE: Record<string, unknown> = {
  artifact: {
    format: 'png',
    bytes: 2048,
    data: 'aGVsbG8gd29ybGQ=',
    url: 'https://example.com/v1/artifacts/00000000-0000-4000-8000-000000000000',
  },
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 1_000 },
};

/** Bazaar input schema for POST /v1/x402/extract — mirrors parseExtractUrls/parseExtractSchema/parseOptions. */
const EXTRACT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'A single page to extract' },
    urls: {
      type: 'array',
      description: 'Batch of pages for one payment (at most 50)',
      items: { type: 'string' },
      maxItems: MAX_EXTRACT_BATCH,
    },
    schema: { type: 'string', description: 'Optional natural-language description of the JSON to extract via a model' },
    options: {
      type: 'object',
      description: 'Capture options forwarded to the capture pipeline (proxy/waitFor/actions/viewport)',
      properties: CAPTURE_OPTIONS_PROPERTIES,
      additionalProperties: false,
    },
  },
};

const EXTRACT_OUTPUT_EXAMPLE: Record<string, unknown> = {
  results: [
    {
      url: 'https://example.com',
      status: 'ok',
      data: {
        title: 'Example Domain',
        description: 'For use in examples.',
        headings: [{ level: 1, text: 'Example Domain' }],
        paragraphs: ['This domain is for use in illustrative examples.'],
        links: [{ href: 'https://www.iana.org/domains/example', text: 'More information...' }],
        images: [],
        wordCount: 9,
        markdown: '# Example Domain\n\nThis domain is for use in illustrative examples.',
      },
    },
  ],
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 10_000 },
};

/** declareDiscoveryExtension wraps the extension under its key; unwrap + narrow it. */
function bazaarFromDeclared(declared: Record<string, DiscoveryExtension>): BodyDiscoveryExtension {
  const bazaar = declared['bazaar'];
  if (bazaar === undefined) throw new Error('declareDiscoveryExtension did not return a bazaar extension');
  return bazaar as BodyDiscoveryExtension;
}

// The declaration omits info.input.method (the library types it as absent at
// declaration time); withRoutedMethod pins it for the POST route so the static
// 402 body and the middleware-enriched header both carry it.
export function buildCaptureBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com', format: 'png' },
        inputSchema: CAPTURE_INPUT_SCHEMA,
        output: { example: CAPTURE_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

export function buildExtractBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com' },
        inputSchema: EXTRACT_INPUT_SCHEMA,
        output: { example: EXTRACT_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

/** Bazaar input schema for POST /v1/x402/audit — mirrors the audit handler (url only). */
export const AUDIT_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The page to audit' },
  },
  required: ['url'],
};

export const AUDIT_OUTPUT_EXAMPLE: Record<string, unknown> = {
  audit: {
    url: 'https://example.com',
    seo: { title: { present: true, length: 13, ok: true } },
    og: { present: { title: true } },
    links: { total: 1 },
  },
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 2000 },
};

export function buildAuditBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com' },
        inputSchema: AUDIT_INPUT_SCHEMA,
        output: { example: AUDIT_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

/** Bazaar input schema for POST /v1/x402/map-lite — mirrors parseMapLiteRequest (url + maxUrls, default 20, cap 50). */
export const MAP_LITE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The seed page to map' },
    maxUrls: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
      description: 'Maximum URLs to return (default 20, at most 50)',
    },
  },
  required: ['url'],
};

export const MAP_LITE_OUTPUT_EXAMPLE: Record<string, unknown> = {
  urls: ['https://example.com/', 'https://example.com/about'],
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 2000 },
};

export function buildMapLiteBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com' },
        inputSchema: MAP_LITE_INPUT_SCHEMA,
        output: { example: MAP_LITE_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

/** Bazaar input schema for POST /v1/x402/video — mirrors parseVideoRequest (url + format/durationMs/scrollSpeed/scrollEasing + viewport). */
export const VIDEO_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The page to scroll-capture' },
    format: {
      type: 'string',
      enum: ['mp4', 'webm'],
      description: 'Accepted for compatibility; recordings are always WebM/VP8 (mp4 is a legacy alias, default webm)',
    },
    durationMs: { type: 'integer', description: 'Recording duration in milliseconds (default 5000, at most 30000)' },
    scrollSpeed: { type: 'integer', description: 'Pixels scrolled per choreography step (default 800, at most 5000)' },
    scrollEasing: { type: 'string', enum: ['linear', 'ease-in-out'], description: 'Scroll easing (default linear)' },
    options: {
      type: 'object',
      description: 'Capture options (viewport forwarded to the recording context)',
      properties: {
        viewport: {
          type: 'object',
          description: 'Recording viewport in CSS pixels (clamped to 320-3840 wide, 320-2160 tall)',
          properties: {
            width: { type: 'integer', description: 'Viewport width in CSS pixels' },
            height: { type: 'integer', description: 'Viewport height in CSS pixels' },
          },
        },
      },
      additionalProperties: false,
    },
  },
  required: ['url'],
};

export const VIDEO_OUTPUT_EXAMPLE: Record<string, unknown> = {
  artifact: { mime: 'video/webm', bytes: 1_048_576, data: 'aGVsbG8gd29ybGQ=' },
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 5000 },
};

export function buildVideoBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com' },
        inputSchema: VIDEO_INPUT_SCHEMA,
        output: { example: VIDEO_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

/** Bazaar input schema for POST /v1/x402/analyze — mirrors the analyze handler (url + task + optional context). */
export const ANALYZE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'The page to analyze' },
    task: {
      type: 'string',
      enum: ['classification', 'accessibility', 'layout', 'entities', 'sentiment'],
      description: 'Analysis task type',
    },
    context: { type: 'string', description: 'Optional focus context for the analysis' },
  },
  required: ['url', 'task'],
};

export const ANALYZE_OUTPUT_EXAMPLE: Record<string, unknown> = {
  task: 'classification',
  result: { category: 'landing-page', confidence: 0.9, tags: ['marketing'] },
  payment: { payer: BAZAAR_EXAMPLE_PAYER, priceUsdcUnits: 10_000 },
  latency_ms: 1200,
};

export function buildAnalyzeBazaarExtension(): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { url: 'https://example.com', task: 'classification' },
        inputSchema: ANALYZE_INPUT_SCHEMA,
        output: { example: ANALYZE_OUTPUT_EXAMPLE },
      }),
    ),
  );
}

/** Bazaar input schema for POST /v1/x402/watches/topup — mirrors the top-up handler. */
const TOPUP_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    watchId: { type: 'string', description: 'The watch to top up' },
    runs: { type: 'integer', enum: [WATCH_TOPUP_RUNS], description: 'Pack size in runs (always 100)' },
  },
  required: ['watchId', 'runs'],
};

/** The top-up 200 example, derived from config: starter-pack credit count + the capture-mode pack price. */
export function topUpOutputExample(config: WebcapConfig): Record<string, unknown> {
  return {
    watchId: '00000000-0000-4000-8000-000000000000',
    credits: PACKS.starter.credits,
    priceUsdcUnits: watchTopUpPriceUsdcUnits('capture', config),
  };
}

export function buildTopUpBazaarExtension(config: WebcapConfig): BodyDiscoveryExtension {
  return withRoutedMethod(
    bazaarFromDeclared(
      declareDiscoveryExtension({
        bodyType: 'json',
        input: { watchId: '00000000-0000-4000-8000-000000000000', runs: WATCH_TOPUP_RUNS },
        inputSchema: TOPUP_INPUT_SCHEMA,
        output: { example: topUpOutputExample(config) },
      }),
    ),
  );
}

/** The service metadata + bazaar extension a route advertises (mirrored into the 402 body). */
export interface UnpaidBazaarMetadata {
  readonly resourceUrl: string;
  readonly serviceName: string;
  readonly tags: readonly string[];
  readonly iconUrl: string;
  readonly bazaar: BodyDiscoveryExtension;
}

/**
 * Mirror of bazaarResourceServerExtension.enrichDeclaration: pins
 * info.input.method and narrows the schema method enum to the given verb
 * (default POST, the static route advertisement), so the 402 JSON body
 * equals the enriched PAYMENT-REQUIRED header challenge for that request.
 */
function withRoutedMethod(extension: BodyDiscoveryExtension, method: string = BAZAAR_HTTP_METHOD): BodyDiscoveryExtension {
  const inputSchema = extension.schema.properties.input;
  // The bazaar types these fields as BodyMethods (POST|PUT|PATCH), but its own
  // resource-server middleware writes the request's actual method at runtime
  // (GET included — these routes serve GET 402 challenges). Mirror that runtime
  // behavior; the value comes from the matched x402 route pattern, not user input.
  const routedMethod = method as BodyMethods;
  const required: ('type' | 'method' | 'bodyType' | 'body')[] = inputSchema.required.includes('method')
    ? inputSchema.required
    : [...inputSchema.required, 'method'];
  return {
    ...extension,
    info: { ...extension.info, input: { ...extension.info.input, method: routedMethod } },
    schema: {
      ...extension.schema,
      properties: {
        ...extension.schema.properties,
        input: {
          ...inputSchema,
          properties: { ...inputSchema.properties, method: { type: 'string', enum: [routedMethod] } },
          required,
        },
      },
    },
  };
}

/**
 * 402 body mirror of the PAYMENT-REQUIRED header (curl/agent-friendly).
 * `method` defaults to POST (the real payment verb); GET 402s on the same
 * routes pass 'GET' so the body matches the middleware-enriched header.
 */
export function buildUnpaidBody(
  requirement: PaymentRequirements,
  description: string,
  metadata: UnpaidBazaarMetadata,
  method: string = BAZAAR_HTTP_METHOD,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: 'Payment required',
    resource: {
      url: metadata.resourceUrl,
      description,
      mimeType: X402_MIME_TYPE,
      serviceName: metadata.serviceName,
      tags: [...metadata.tags],
      iconUrl: metadata.iconUrl,
    },
    accepts: [requirement],
    extensions: { bazaar: withRoutedMethod(metadata.bazaar, method) },
  };
}
