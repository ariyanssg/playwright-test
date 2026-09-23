import { directGoogleDestination, googleSearchUrl, type GooglePage, type GoogleResult, type GoogleSearchRequest } from './google-results.js';

interface SerperOrganic {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
  sitelinks?: Array<{ title?: string; link?: string }>;
}

interface SerperResponse {
  organic?: SerperOrganic[];
  message?: string;
  error?: string;
  statusCode?: number;
}

/**
 * Serper.dev: one credit per 10-result Google page, at roughly $0.30-$1.00 per 1,000 pages
 * against SearchApi's $1.00-$4.00. Its `page` parameter maps one-to-one onto the paginated
 * checkpoint model the Google coordinator already uses, so resume works unchanged.
 */
export async function fetchSerperPage(request: GoogleSearchRequest, apiKey = process.env.SERPER_API_KEY): Promise<GooglePage> {
  if (!apiKey) throw new Error('SERPER_API_KEY is required for Serper discovery');
  const endpoint = process.env.SERPER_ENDPOINT || 'https://google.serper.dev/search';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ q: request.query, gl: request.country, hl: request.language, page: request.page, num: 10 }),
    signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  let payload: SerperResponse;
  try { payload = await response.json() as SerperResponse; }
  catch { throw new Error(`Serper returned an invalid response (HTTP ${response.status})`); }
  if (!response.ok || payload.error || (payload.message && !payload.organic)) {
    const reason = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`Serper request failed: ${reason.replaceAll(apiKey, '[redacted]')}${response.status === 403 || /credit|balance|quota/i.test(reason) ? ' (check the API key and remaining credits at serper.dev)' : ''}`);
  }
  // Serper omits `organic` entirely when Google has nothing more for the query.
  const organic = payload.organic ?? [];
  if (!Array.isArray(organic)) throw new Error('Serper response did not contain recognizable organic results');
  const results: GoogleResult[] = [];
  const warnings: string[] = [];
  for (const item of organic) {
    const url = directGoogleDestination(item.link ?? '');
    if (!url) { warnings.push('Serper returned an organic result without a usable destination URL'); continue; }
    results.push({ url, title: item.title, snippet: item.snippet, position: item.position, kind: 'organic' });
    for (const link of item.sitelinks ?? []) {
      const target = directGoogleDestination(link.link ?? '');
      if (target) results.push({ url: target, title: link.title, position: item.position, kind: 'sitelink' });
    }
  }
  return {
    results,
    // Serper reports no pagination cursor. Any organic result means another page may exist;
    // the coordinator's repeat-fingerprint check stops a query that starts looping.
    hasNext: organic.length > 0,
    searchUrl: googleSearchUrl(request),
    warnings,
  };
}
