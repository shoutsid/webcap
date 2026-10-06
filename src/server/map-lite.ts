import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.js';
import type { WebcapConfig } from '../config.js';
import { HttpError, unprocessable } from '../util/errors.js';
import { validateCaptureUrl } from '../util/url.js';
import { isRecord, validatedUrl } from './capture-parse.js';
import { x402Payer } from './x402.js';
import { registerPaidRoute } from './query-body.js';

export const MAP_LITE_DEFAULT_MAX_URLS = 20;
export const MAP_LITE_MAX_URLS = 50;
const MAP_LITE_MAX_SITEMAP_FETCHES = 3;
const MAP_LITE_MAX_INDEX_CHILD_FETCHES = 3;
const MAP_LITE_FETCH_TIMEOUT_MS = 8_000;
const MAP_LITE_TOTAL_TIMEOUT_MS = 20_000;

export interface MapLiteRequest {
  readonly url: string;
  readonly maxUrls: number;
}

export function parseMapLiteRequest(body: unknown, allowHosts: readonly string[] | undefined): MapLiteRequest {
  if (!isRecord(body)) throw unprocessable('body must be an object');
  const rawUrl = body['url'];
  if (typeof rawUrl !== 'string') throw unprocessable('url is required');
  const url = validatedUrl(rawUrl, allowHosts);
  const rawMax = body['maxUrls'];
  if (rawMax === undefined) return { url, maxUrls: MAP_LITE_DEFAULT_MAX_URLS };
  if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > MAP_LITE_MAX_URLS) {
    throw unprocessable(`maxUrls must be an integer between 1 and ${MAP_LITE_MAX_URLS}`);
  }
  return { url, maxUrls: rawMax };
}

const LOC_PATTERN = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;

export function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  LOC_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOC_PATTERN.exec(xml)) !== null) {
    const loc = (match[1] ?? '').trim();
    if (loc !== '') locs.push(loc);
  }
  return locs;
}

export function extractRobotsSitemapUrls(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const line of robotsTxt.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const m = /^sitemap\s*:\s*(\S+)\s*$/i.exec(trimmed);
    if (m?.[1] !== undefined) urls.push(m[1]);
  }
  return urls;
}

const HREF_PATTERN = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function extractSameHostLinks(html: string, baseUrl: string): string[] {
  let seed: URL;
  try {
    seed = new URL(baseUrl);
  } catch {
    return [];
  }
  const seedHost = seed.hostname.toLowerCase();
  const links: string[] = [];
  const seen = new Set<string>();
  HREF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HREF_PATTERN.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let resolved: URL;
    try {
      resolved = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    if (resolved.hostname.toLowerCase() !== seedHost) continue;
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

export function filterMapLiteCandidates(
  candidates: readonly string[],
  seedUrl: string,
  maxUrls: number,
  allowHosts: readonly string[] | undefined,
): string[] {
  let seedHost: string;
  try {
    seedHost = new URL(seedUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (urls.length >= maxUrls) break;
    let normalized: string;
    try {
      normalized = validateCaptureUrl(candidate, { allowHosts });
    } catch {
      continue;
    }
    let host: string;
    try {
      host = new URL(normalized).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host !== seedHost) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

export interface MapLiteDiscovery {
  readonly urls: string[];
  readonly fetchCount: number;
}

async function fetchText(url: string, signal: AbortSignal, counter: { count: number }): Promise<string | undefined> {
  counter.count += 1;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(MAP_LITE_FETCH_TIMEOUT_MS)]) });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

export async function discoverMapLiteUrls(
  seedUrl: string,
  maxUrls: number,
  allowHosts: readonly string[] | undefined,
): Promise<MapLiteDiscovery> {
  const origin = new URL(seedUrl).origin;
  const counter = { count: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAP_LITE_TOTAL_TIMEOUT_MS);
  try {
    const robots = await fetchText(`${origin}/robots.txt`, controller.signal, counter);
    let sitemapUrls = robots === undefined ? [] : extractRobotsSitemapUrls(robots);
    if (sitemapUrls.length === 0) sitemapUrls = [`${origin}/sitemap.xml`];
    const locs: string[] = [];
    for (const sitemapUrl of sitemapUrls.slice(0, MAP_LITE_MAX_SITEMAP_FETCHES)) {
      const xml = await fetchText(sitemapUrl, controller.signal, counter);
      if (xml === undefined) continue;
      if (xml.includes('<sitemapindex')) {
        const children = extractSitemapLocs(xml).slice(0, MAP_LITE_MAX_INDEX_CHILD_FETCHES);
        for (const child of children) {
          const childXml = await fetchText(child, controller.signal, counter);
          if (childXml !== undefined) locs.push(...extractSitemapLocs(childXml));
          if (locs.length >= maxUrls) break;
        }
      } else {
        locs.push(...extractSitemapLocs(xml));
      }
      if (locs.length >= maxUrls) break;
    }
    if (locs.length === 0) {
      let page: string | undefined;
      try {
        counter.count += 1;
        const res = await fetch(seedUrl, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MAP_LITE_FETCH_TIMEOUT_MS)]),
        });
        if (res.ok) page = await res.text();
      } catch {
        page = undefined;
      }
      if (page === undefined) throw new HttpError(502, 'map_failed', 'map-lite discovery failed for the URL');
      return { urls: filterMapLiteCandidates(extractSameHostLinks(page, seedUrl), seedUrl, maxUrls, allowHosts), fetchCount: counter.count };
    }
    return { urls: filterMapLiteCandidates(locs, seedUrl, maxUrls, allowHosts), fetchCount: counter.count };
  } finally {
    clearTimeout(timer);
  }
}

export interface MapLiteRouteDeps {
  readonly db: Db;
  readonly config: WebcapConfig;
  readonly captureAllowHosts?: readonly string[];
}

export function registerMapLiteRoute(app: FastifyInstance, deps: MapLiteRouteDeps): void {
  const { config } = deps;
  const allowHosts = deps.captureAllowHosts;
  registerPaidRoute(app, '/v1/x402/map-lite', async (req) => {
    if (config.x402Network === undefined) {
      throw new HttpError(503, 'x402_disabled', 'x402 payment requires WEBCAP_CHAIN=base-sepolia or base');
    }
    const { url, maxUrls } = parseMapLiteRequest(req.body, allowHosts);
    const discovery = await discoverMapLiteUrls(url, maxUrls, allowHosts);
    const payer = x402Payer(req) ?? 'unknown';
    (req as unknown as { _pendingRevenue?: { endpoint: string; payer: string; revenueUsdcUnits: number; costUsdcUnits: number } })._pendingRevenue = {
      endpoint: 'map-lite',
      payer,
      revenueUsdcUnits: config.x402AuditPriceUsdcUnits,
      costUsdcUnits: config.computeCostUsdcUnitsPerRequest * discovery.fetchCount,
    };
    return {
      urls: discovery.urls,
      payment: {
        payer,
        priceUsdcUnits: config.x402AuditPriceUsdcUnits,
        costUsdcUnits: config.computeCostUsdcUnitsPerRequest * discovery.fetchCount,
      },
    };
  });
}
