import { directGoogleDestination, googleSearchUrl, type GooglePage, type GoogleResult, type GoogleSearchRequest } from './google-results.js';

interface OrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  sitelinks?: { inline?: OrganicResult[]; expanded?: OrganicResult[] };
}

interface SearchApiResponse {
  search_metadata?: { status?: string };
  organic_results?: OrganicResult[];
  error?: string;
  pagination?: { next?: string; next_page?: string };
  search_information?: { total_results?: number; organic_results_state?: string };
}

export async function fetchSearchApiPage(request: GoogleSearchRequest, apiKey = process.env.SEARCHAPI_API_KEY): Promise<GooglePage> {
  if (!apiKey) throw new Error('SEARCHAPI_API_KEY is required for SearchApi discovery');
  const endpoint = new URL(process.env.SEARCHAPI_ENDPOINT || 'https://www.searchapi.io/api/v1/search');
  for (const [key, value] of Object.entries({ engine: 'google', q: request.query, page: String(request.page), gl: request.country, hl: request.language, device: 'desktop' })) {
    endpoint.searchParams.set(key, value);
  }
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  let payload: SearchApiResponse;
  try { payload = await response.json() as SearchApiResponse; }
  catch { throw new Error(`SearchApi returned an invalid response (HTTP ${response.status})`); }
  // SearchApi reports exhausted Google pages as HTTP 200 / Success with this
  // exact message in `error`. Other provider errors must remain failures.
  const exhausted = response.ok && payload.search_metadata?.status === 'Success'
    && payload.error === "Google didn't return any results.";
  if (!response.ok || (payload.error && !exhausted)) throw new Error(payload.error?.replaceAll(apiKey, '[redacted]') || `SearchApi request failed with HTTP ${response.status}`);
  const empty = exhausted || payload.search_information?.total_results === 0 || /fully empty/i.test(payload.search_information?.organic_results_state ?? '');
  if (!Array.isArray(payload.organic_results) && !empty) throw new Error('SearchApi response did not contain recognizable organic results');
  const results: GoogleResult[] = [];
  const warnings: string[] = [];
  const add = (item: OrganicResult, kind: GoogleResult['kind'], position?: number) => {
    const url = directGoogleDestination(item.link ?? '');
    if (!url) { warnings.push('SearchApi returned an organic result without a usable destination URL'); return; }
    results.push({ url, title: item.title, snippet: item.snippet, position: item.position ?? position, kind });
  };
  for (const item of payload.organic_results ?? []) {
    add(item, 'organic');
    for (const link of [...(item.sitelinks?.inline ?? []), ...(item.sitelinks?.expanded ?? [])]) add(link, 'sitelink', item.position);
  }
  const organicCount = payload.organic_results?.length ?? 0;
  return {
    results,
    // Some responses omit pagination. A full organic page warrants another request.
    hasNext: organicCount > 0 && (Boolean(payload.pagination?.next || payload.pagination?.next_page) || (!payload.pagination && organicCount >= 10)),
    searchUrl: googleSearchUrl(request), warnings,
  };
}
