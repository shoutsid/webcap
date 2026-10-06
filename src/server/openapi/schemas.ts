/**
 * The per-route schema components of the OpenAPI catalog: request bodies and
 * response shapes for capture, extract, watches, and the watch top-up. Split
 * out of openapi.ts as a pure move (no behavior change).
 */
import { CAPTURE_COST_CREDITS, PRODUCT_CREDIT_COST, WATCH_TOPUP_RUNS } from '../../config.js';
import { BAZAAR_EXAMPLE_PAYER } from '../x402.js';
import { MAX_EXTRACT_BATCH } from '../extract-parse.js';
import type { Json } from './types.js';

const artifactSchema: Json = {
  type: 'object',
  properties: {
    format: { type: 'string', enum: ['png', 'jpeg', 'pdf'] },
    bytes: { type: 'integer', example: 204_800 },
    data: { type: 'string', description: 'Base64-encoded image bytes' },
    url: { type: 'string', example: '{publicBaseUrl}/v1/artifacts/{id}', description: 'Canonical public artifact URL' },
  },
};

const captureResponse = (priceUsdcUnits: number): Json => ({
  type: 'object',
  properties: {
    artifact: artifactSchema,
    payment: {
      type: 'object',
      properties: {
        payer: { type: 'string', example: BAZAAR_EXAMPLE_PAYER },
        creditsUsed: { type: 'integer', description: 'Credits charged (credits rail and async jobs; omitted on x402-settled calls)' },
        costUsdcUnits: { type: 'integer', description: 'Amortized compute cost in atomic 6-decimal USDC units' },
        priceUsdcUnits: { type: 'integer', example: priceUsdcUnits },
      },
    },
  },
});

/** The credit-based POST /v1/capture 200 (same artifact, credit accounting instead of payment). */
const captureCreditResponse: Json = {
  type: 'object',
  properties: {
    artifact: artifactSchema,
    creditsCharged: { type: 'integer', example: CAPTURE_COST_CREDITS },
    balance: { type: 'integer', description: 'Credits remaining after the charge' },
  },
};

function propsOf(schema: Json): Record<string, Json> {
  if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
    const props = (schema as { readonly [key: string]: Json }).properties;
    if (typeof props === 'object' && props !== null && !Array.isArray(props)) {
      return { ...(props as Record<string, Json>) };
    }
  }
  return {};
}

/**
 * A credits-rail 200 derived from the x402 response: the same result keys,
 * credit accounting instead of the payment envelope. Deriving (not copying)
 * keeps the two rails' documented shapes from drifting apart.
 */
function creditOf(response: Json, keep: readonly string[]): Json {
  const props = propsOf(response);
  const kept: Record<string, Json> = {};
  for (const key of keep) {
    const value = props[key];
    if (value !== undefined) kept[key] = value;
  }
  return {
    type: 'object',
    properties: {
      ...kept,
      creditsCharged: { type: 'integer', example: PRODUCT_CREDIT_COST },
      balance: { type: 'integer', description: 'Credits remaining after the charge' },
    },
  };
}



const extractResponse = (priceUsdcUnits: number): Json => ({
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'error'] },
          data: {
            type: 'object',
            description: 'Present when status=ok; the structured content (plus optional model-extracted "extracted")',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              headings: { type: 'array', items: { type: 'object', properties: { level: { type: 'integer' }, text: { type: 'string' } } } },
              paragraphs: { type: 'array', items: { type: 'string' } },
              links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, text: { type: 'string' } } } },
              images: { type: 'array', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } },
              wordCount: { type: 'integer', description: 'Words on the whole page, chrome included (the human count)' },
              markdown: { type: 'string' },
              content: {
                type: 'object',
                description:
                  'Provenance of the main content that paragraphs/markdown actually contain: which container was chosen, how many words it holds after chrome removal, and whether a maxContentWords budget cut it short',
                properties: {
                  source: { type: 'string', example: 'article', description: 'Selector the content came from; "body" = whole-page fallback' },
                  words: { type: 'integer' },
                  truncated: { type: 'boolean' },
                },
              },
              extracted: { type: 'object', description: 'Model-extracted JSON when a schema was supplied' },
              classification: {
                type: 'object',
                description: 'Deterministic page classification (rule-based, no model): category + confidence + tags',
                properties: {
                  category: { type: 'string', description: 'Page category (article, product, documentation, landing-page, forum, social-media, e-commerce, news, blog, wiki, dashboard, form, other)' },
                  confidence: { type: 'number', description: '0.4 (no signal) to 0.8 (og:type match)' },
                  tags: { type: 'array', items: { type: 'string' } },
                  mode: { type: 'string', example: 'deterministic' },
                },
              },
            },
          },
          error: { type: 'string', description: 'Present when status=error' },
        },
      },
    },
    payment: {
      type: 'object',
      properties: {
        payer: { type: 'string', example: BAZAAR_EXAMPLE_PAYER },
        creditsUsed: { type: 'integer', description: 'Credits charged (credits rail and async jobs; omitted on x402-settled calls)' },
        costUsdcUnits: { type: 'integer', description: 'Amortized compute cost in atomic 6-decimal USDC units' },
        priceUsdcUnits: { type: 'integer', example: priceUsdcUnits },
      },
    },
  },
});

/** Shared capture-option properties for the capture + extract request bodies (mirrors parseOptions). */
const captureOptionsProperties = {
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
  locale: { type: 'string', description: 'BCP-47 locale tag for the browser context (drives Accept-Language + navigator.language)' },
  timezoneId: { type: 'string', description: 'IANA timezone id for the browser context (422 on unknown zones)' },
  stealth: { type: 'boolean', description: 'Hardened anti-bot context: realistic UA/viewport defaults + webdriver mask (same as proxy "stealth", without routing traffic through a proxy)' },
  auth: {
    type: 'object',
    description:
      'Logged-in session for the capture: allowlisted extra headers (authorization, x-api-key only) plus up to 10 cookies, applied to the browser context. ' +
      'Rejections are 422 with static messages (secret values never appear in errors or logs).',
    properties: {
      headers: { type: 'object', description: 'Extra request headers (authorization and x-api-key only)', additionalProperties: { type: 'string' } },
      cookies: {
        type: 'array',
        description: 'Session cookies (at most 10)',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Cookie name' },
            value: { type: 'string', description: 'Cookie value' },
            domain: { type: 'string', description: 'Cookie domain (optional — defaults to the captured URL)' },
          },
        },
      },
    },
  },
  proxy: { type: 'string', description: 'Proxy: "auto", "stealth", or an http(s) proxy URL string' },
  maxContentWords: {
    type: 'integer',
    description:
      'Word budget for the extracted main content (paragraphs + markdown), clamped to ' +
      '25..100000. Lets an agent size a page to its context window; content is cut at a block ' +
      'boundary and content.truncated reports it.',
  },
  waitFor: {
    type: 'object',
    description: 'Wait for a selector before capture (timeoutMs capped at 10000)',
    properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeoutMs: { type: 'integer', description: 'Wait timeout in milliseconds (capped at 10000)' },
    },
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

const captureRequestBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', description: 'The page to capture', example: 'https://example.com/' },
    format: { type: 'string', enum: ['png', 'jpeg', 'pdf'], description: 'Screenshot format (default png)' },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: captureOptionsProperties,
    },
  },
};

// oneOf (not top-level required): the runtime accepts either `url` or `urls`;
// a schema-driven caller that sees both optional may synthesize a body with
// neither, which 422s at runtime. The x402gle live audition hit exactly that.
const extractRequestBody = {
  type: 'object',
  oneOf: [{ required: ['url'] }, { required: ['urls'] }],
  properties: {
    url: { type: 'string', format: 'uri', description: 'A single absolute http(s) page to extract', example: 'https://example.com/' },
    urls: {
      type: 'array',
      description: 'Batch of absolute http(s) pages for one payment (at most 50)',
      items: { type: 'string', format: 'uri' },
      maxItems: MAX_EXTRACT_BATCH,
    },
    schema: { type: 'string', description: 'Optional plain natural-language string describing the JSON to extract via a model (a string, not a JSON object). A JSON object schema instead takes the deterministic path: zero model calls, the response data gains an "extracted" projection of the page structure, and failures 422 with detail string[] ($-rooted schema errors, "span not grounded" grounding errors, or "unsupported schema keyword" for oneOf/anyOf/allOf/$ref/format)' },
    spans: {
      type: 'array',
      description: 'Optional grounding spans for the deterministic object-schema path: each {field, quote, page} must be a verbatim substring of the cited markdown page, else 422 (omitted or [] skips grounding)',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Extracted field the quote grounds' },
          quote: { type: 'string', description: 'Verbatim substring of the cited page markdown' },
          page: { type: 'integer', description: 'Zero-based index into the batch markdown pages' },
        },
      },
    },
    options: {
      type: 'object',
      additionalProperties: false,
      description: 'Capture options forwarded to the capture pipeline (proxy/waitFor/actions/viewport)',
      properties: captureOptionsProperties,
    },
  },
};

const auditRequestBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', example: 'https://example.com/' },
  },
};

const mapLiteRequestBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', description: 'The seed page to map', example: 'https://example.com/' },
    maxUrls: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 20,
      description: 'Maximum URLs to return (default 20, at most 50)',
    },
  },
};

const mapLiteResponse = (priceUsdcUnits: number): Json => ({
  type: 'object',
  properties: {
    urls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Same-host URLs discovered via sitemap/robots plus a 1-hop crawl (empty when none found)',
    },
    payment: {
      type: 'object',
      properties: {
        payer: { type: 'string', example: BAZAAR_EXAMPLE_PAYER },
        creditsUsed: { type: 'integer', description: 'Credits charged (credits rail and async jobs; omitted on x402-settled calls)' },
        costUsdcUnits: { type: 'integer', description: 'Amortized compute cost in atomic 6-decimal USDC units' },
        priceUsdcUnits: { type: 'integer', example: priceUsdcUnits },
      },
    },
  },
});

const videoRequestBody = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri', description: 'The page to scroll-capture', example: 'https://example.com/' },
    format: {
      type: 'string',
      enum: ['mp4', 'webm'],
      description:
        'Accepted for compatibility; recordings are always WebM/VP8 (mp4 is a legacy alias, default webm). The response artifact.mime always reports video/webm.',
    },
    durationMs: { type: 'integer', description: 'Recording duration in milliseconds (default 5000, at most 30000)' },
    scrollSpeed: { type: 'integer', description: 'Pixels scrolled per choreography step (default 800, at most 5000)' },
    scrollEasing: { type: 'string', enum: ['linear', 'ease-in-out'], description: 'Scroll easing (default linear)' },
    options: {
      type: 'object',
      additionalProperties: false,
      description: 'Capture options forwarded to the recording context (viewport, session auth, stealth, locale)',
      properties: {
        viewport: {
          type: 'object',
          description: 'Recording viewport in CSS pixels (clamped to 320-3840 wide, 320-2160 tall)',
          properties: {
            width: { type: 'integer', description: 'Viewport width in CSS pixels' },
            height: { type: 'integer', description: 'Viewport height in CSS pixels' },
          },
        },
        stealth: { type: 'boolean', description: 'Hardened anti-bot recording context (realistic UA/viewport defaults + webdriver mask)' },
        auth: {
          type: 'object',
          description: 'Logged-in session for the recording: allowlisted extra headers (authorization, x-api-key only) plus up to 10 cookies. 422 with static messages on misuse.',
          properties: {
            headers: { type: 'object', description: 'Extra request headers (authorization and x-api-key only)', additionalProperties: { type: 'string' } },
            cookies: {
              type: 'array',
              description: 'Session cookies (at most 10; domain optional — defaults to the recorded URL)',
              maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Cookie name' },
                  value: { type: 'string', description: 'Cookie value' },
                  domain: { type: 'string', description: 'Cookie domain (optional)' },
                },
              },
            },
          },
        },
        locale: { type: 'string', description: 'BCP-47 locale tag for the recording context (drives Accept-Language)' },
        timezoneId: { type: 'string', description: 'IANA timezone id for the recording context' },
      },
    },
  },
};

const videoResponse = (priceUsdcUnits: number): Json => ({
  type: 'object',
  properties: {
    artifact: {
      type: 'object',
      properties: {
        mime: { type: 'string', enum: ['video/webm'], description: 'Recordings are WebM/VP8 (Chromium screencast); no MP4 is produced' },
        bytes: { type: 'integer', example: 1_048_576 },
        data: { type: 'string', description: 'Base64-encoded video bytes' },
      },
    },
    payment: {
      type: 'object',
      properties: {
        payer: { type: 'string', example: BAZAAR_EXAMPLE_PAYER },
        creditsUsed: { type: 'integer', description: 'Credits charged (credits rail and async jobs; omitted on x402-settled calls)' },
        costUsdcUnits: { type: 'integer', description: 'Amortized compute cost in atomic 6-decimal USDC units' },
        priceUsdcUnits: { type: 'integer', example: priceUsdcUnits },
      },
    },
  },
});

const auditResponse = (priceUsdcUnits: number): Json => ({
  type: 'object',
  properties: {
    audit: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        seo: {
          type: 'object',
          properties: {
            title: {
              type: 'object',
              properties: {
                present: { type: 'boolean' },
                length: { type: 'integer' },
                ok: { type: 'boolean' },
              },
            },
            description: {
              type: 'object',
              properties: {
                present: { type: 'boolean' },
                length: { type: 'integer' },
                ok: { type: 'boolean' },
              },
            },
            h1Count: { type: 'integer' },
            h1Ok: { type: 'boolean' },
            canonical: {
              type: 'object',
              properties: {
                present: { type: 'boolean' },
                value: { type: 'string' },
              },
            },
            robotsMeta: {
              type: 'object',
              properties: {
                present: { type: 'boolean' },
                value: { type: 'string' },
              },
            },
          },
        },
        og: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            image: { type: 'string' },
            twitterCard: { type: 'string' },
            twitterSite: { type: 'string' },
            twitterCreator: { type: 'string' },
            twitterTitle: { type: 'string' },
            twitterDescription: { type: 'string' },
            twitterImage: { type: 'string' },
            articlePublishedTime: { type: 'string' },
            articleAuthor: { type: 'string' },
            articleSection: { type: 'string' },
            articleTags: { type: 'array', items: { type: 'string' } },
            present: {
              type: 'object',
              properties: {
                title: { type: 'boolean' },
                description: { type: 'boolean' },
                image: { type: 'boolean' },
                twitterCard: { type: 'boolean' },
                twitterSite: { type: 'boolean' },
                twitterCreator: { type: 'boolean' },
                twitterTitle: { type: 'boolean' },
                twitterDescription: { type: 'boolean' },
                twitterImage: { type: 'boolean' },
                articlePublishedTime: { type: 'boolean' },
                articleAuthor: { type: 'boolean' },
                articleSection: { type: 'boolean' },
                articleTags: { type: 'boolean' },
              },
            },
          },
        },
        links: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            internal: { type: 'integer' },
            external: { type: 'integer' },
            emptyText: { type: 'integer' },
            duplicates: { type: 'integer' },
            sample: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, text: { type: 'string' } } } },
          },
        },
      },
    },
    payment: {
      type: 'object',
      properties: {
        payer: { type: 'string', example: BAZAAR_EXAMPLE_PAYER },
        creditsUsed: { type: 'integer', description: 'Credits charged (credits rail and async jobs; omitted on x402-settled calls)' },
        costUsdcUnits: { type: 'integer', description: 'Amortized compute cost in atomic 6-decimal USDC units' },
        priceUsdcUnits: { type: 'integer', example: priceUsdcUnits },
      },
    },
  },
});

const watchCreateBody = {  type: 'object',
  required: ['url', 'every', 'mode'],
  properties: {
    url: { type: 'string', description: 'The https URL to watch', example: 'https://example.com/' },
    every: { type: 'string', enum: ['15m', '1h', '6h', '24h'], description: 'Run interval' },
    mode: { type: 'string', enum: ['capture', 'extract'], description: 'Re-run the capture (screenshot) or the extract (structured content) pipeline' },
    schema: { type: 'string', description: 'Optional natural-language extraction schema (extract mode)' },
    webhook: { type: 'string', description: 'Optional https URL that receives a change alert when a run detects a change' },
  },
};

const watchRunView = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    status: { type: 'string', enum: ['ok', 'error', 'no-credit'] },
    changed: { type: 'boolean' },
    artifactUrl: { type: 'string', description: 'Present for ok capture runs' },
    extract: { type: 'object', description: 'Present for ok extract runs; the extract JSON of that run' },
    diffSummary: { type: 'string', description: 'Present when changed; compact list of changed paths (capture: "artifact")' },
    webhook: { type: 'string', description: 'Present when a change alert fired; delivery outcome (e.g. "ok: HTTP 200")' },
    error: { type: 'string', description: 'Present when status=error' },
    createdAt: { type: 'string' },
  },
};

const watchStateResponse = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    every: { type: 'string' },
    mode: { type: 'string' },
    schema: { type: 'string', description: 'Present when set' },
    webhook: { type: 'string', description: 'Present when set' },
    credits: { type: 'integer', description: 'Pre-paid runs remaining (each run consumes 1)' },
    paused: { type: 'boolean', description: 'True when the watch ran out of credits and waits for a top-up' },
    nextRunAt: { type: ['string', 'null'] },
    lastRunAt: { type: ['string', 'null'] },
    runs: { type: 'array', description: 'The last ~10 runs, newest first', items: watchRunView },
  },
};

const watchTopUpBody = {
  type: 'object',
  required: ['watchId', 'runs'],
  properties: {
    watchId: { type: 'string', description: 'The watch to top up' },
    runs: { type: 'integer', enum: [WATCH_TOPUP_RUNS], description: `Pack size in runs (always ${WATCH_TOPUP_RUNS})` },
  },
};

const watchTopUpResponse = {
  type: 'object',
  properties: {
    watchId: { type: 'string' },
    credits: { type: 'integer', description: 'The watch credit balance after the top-up' },
    priceUsdcUnits: {
      type: 'integer',
      description: `The pack price paid: the watch mode unit price × ${WATCH_TOPUP_RUNS}`,
    },
  },
};

const extractCreditResponse = creditOf(extractResponse(0), ['results']);
const auditCreditResponse = creditOf(auditResponse(0), ['audit']);
const mapLiteCreditResponse = creditOf(mapLiteResponse(0), ['urls']);
const videoCreditResponse = creditOf(videoResponse(0), ['artifact']);

export {
  auditCreditResponse,
  auditRequestBody,
  auditResponse,
  captureCreditResponse,
  captureRequestBody,
  captureResponse,
  extractCreditResponse,
  extractRequestBody,
  extractResponse,
  mapLiteCreditResponse,
  mapLiteRequestBody,
  mapLiteResponse,
  videoCreditResponse,
  videoRequestBody,
  videoResponse,
  watchCreateBody,
  watchStateResponse,
  watchTopUpBody,
  watchTopUpResponse,
};
