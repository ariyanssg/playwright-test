import type { DiscoveredUrl } from './sitemap.js';
import { isSameSite, normalizeUrl, siteKey, tryNormalizeUrl } from '../urls.js';

interface OrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
}

interface SearchApiResponse {
  organic_results?: OrganicResult[];
  error?: string;
}

export interface SearchApiDiscoveryResult {
  urls: DiscoveredUrl[];
  query: string;
  coverageNote: string;
}

export async function discoverSearchApi(site: string, apiKey = process.env.SEARCHAPI_API_KEY): Promise<SearchApiDiscoveryResult> {
  if (!apiKey) throw new Error('SEARCHAPI_API_KEY is required for SearchApi discovery');
  const normalizedSite = normalizeUrl(site);
  const query = `site:${siteKey(normalizedSite)}`;
  const endpoint = new URL(process.env.SEARCHAPI_ENDPOINT || 'https://www.searchapi.io/api/v1/search');
  endpoint.searchParams.set('engine', 'google');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('num', '100');
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json() as SearchApiResponse;
  if (!response.ok) throw new Error(payload.error || `SearchApi request failed with HTTP ${response.status}`);

  const urls = new Map<string, DiscoveredUrl>();
  for (const item of payload.organic_results ?? []) {
    const url = tryNormalizeUrl(item.link ?? '');
    if (!url || !isSameSite(url, normalizedSite)) continue;
    urls.set(url, {
      url,
      evidence: {
        source: 'searchapi',
        query,
        position: item.position,
        title: item.title,
        snippet: item.snippet,
      },
    });
  }
  return {
    urls: [...urls.values()],
    query,
    coverageNote: 'SearchApi site: discovery is capped at the first 100 Google results and is not a complete index inventory.',
  };
}
