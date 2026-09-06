import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import type { DiscoveryEvidence } from '../types.js';
import { isSameSite, normalizeUrl, siteOrigin, tryNormalizeUrl } from '../urls.js';
import type { RobotsCache } from '../robots.js';

export interface DiscoveredUrl {
  url: string;
  evidence: DiscoveryEvidence;
}

export interface SitemapDiscoveryResult {
  urls: DiscoveredUrl[];
  sitemapUrls: string[];
  warnings: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true });

export async function discoverSitemaps(
  site: string,
  robots: RobotsCache,
  extraSitemaps: string[] = [],
  maxSitemapFiles = 1_000,
): Promise<SitemapDiscoveryResult> {
  const root = normalizeUrl(site);
  const robotsInfo = await robots.get(root);
  const queue = [...robotsInfo.sitemaps, ...extraSitemaps, new URL('/sitemap.xml', siteOrigin(root)).href];
  const visited = new Set<string>();
  const found = new Map<string, DiscoveredUrl>();
  const warnings: string[] = [];

  while (queue.length && visited.size < maxSitemapFiles) {
    const rawSitemapUrl = queue.shift()!;
    const sitemapUrl = tryNormalizeUrl(rawSitemapUrl);
    if (!sitemapUrl || visited.has(sitemapUrl) || !isSameSite(sitemapUrl, root)) continue;
    visited.add(sitemapUrl);
    try {
      const response = await fetch(sitemapUrl, {
        headers: { accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        if (response.status !== 404) warnings.push(`${sitemapUrl}: HTTP ${response.status}`);
        continue;
      }
      let body = Buffer.from(await response.arrayBuffer());
      if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
      const document = parser.parse(body.toString('utf8')) as Record<string, unknown>;
      const childSitemaps = locations(document.sitemapindex, 'sitemap');
      if (childSitemaps.length) {
        for (const child of childSitemaps) queue.push(child);
        continue;
      }
      for (const pageUrl of locations(document.urlset, 'url')) {
        const normalized = tryNormalizeUrl(pageUrl);
        if (!normalized || !isSameSite(normalized, root)) continue;
        found.set(normalized, {
          url: normalized,
          evidence: { source: 'sitemap', discoveredFrom: sitemapUrl },
        });
      }
    } catch (error) {
      warnings.push(`${sitemapUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (queue.length) warnings.push(`Stopped after ${maxSitemapFiles} sitemap files`);
  return { urls: [...found.values()], sitemapUrls: [...visited], warnings };
}

function locations(container: unknown, key: string): string[] {
  if (!container || typeof container !== 'object') return [];
  const value = (container as Record<string, unknown>)[key];
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const output: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const loc = (entry as Record<string, unknown>).loc;
    if (typeof loc === 'string') output.push(loc);
    else if (loc && typeof loc === 'object' && '#text' in loc) output.push(String((loc as Record<string, unknown>)['#text']));
  }
  return output;
}
