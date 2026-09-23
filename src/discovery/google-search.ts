import { createHash } from 'node:crypto';
import type { ScanDatabase } from '../database.js';
import type { Candidate, GoogleDiscoveryState, GoogleProviderName, ScanOptions } from '../types.js';
import { isSameSite, siteOrigin, tryNormalizeUrl } from '../urls.js';
import { GoogleBrowser } from './google-browser.js';
import { GoogleChallengeError, googleQueries, type GooglePage, type GoogleSearchRequest } from './google-results.js';
import { fetchSearchApiPage } from './searchapi.js';
import { fetchSerperPage } from './serper.js';

export interface GoogleBrowserProvider {
  fetchPage(request: GoogleSearchRequest): Promise<GooglePage>;
  close(): Promise<void>;
}
export interface GoogleProviders {
  serper?: (request: GoogleSearchRequest) => Promise<GooglePage>;
  searchapi: (request: GoogleSearchRequest) => Promise<GooglePage>;
  browser: () => GoogleBrowserProvider;
}
export const defaultGoogleProviders: GoogleProviders = {
  serper: fetchSerperPage,
  searchapi: fetchSearchApiPage,
  browser: () => new GoogleBrowser(),
};

const PROVIDER_LABEL: Record<GoogleProviderName, string> = { serper: 'Serper', searchapi: 'SearchApi', browser: 'browser' };

/** Auto picks the cheapest configured API, and the free local browser when no key is set. */
export function autoProvider(): GoogleProviderName {
  return process.env.SERPER_API_KEY ? 'serper' : process.env.SEARCHAPI_API_KEY ? 'searchapi' : 'browser';
}

export async function discoverGoogle(site: string, options: ScanOptions, context: {
  db: ScanDatabase;
  scanId: string;
  signal: AbortSignal;
  progress(message: string): void;
  warn(message: string): void;
  waitForUser(message: string): Promise<void>;
}, providers = defaultGoogleProviders): Promise<GoogleDiscoveryState> {
  const explicit = options.discovery.includes('google') ? options.googleProvider
    : options.discovery.includes('serper') ? 'serper' : options.discovery.includes('searchapi') ? 'searchapi' : 'browser';
  const state: GoogleDiscoveryState = context.db.googleDiscovery(context.scanId).find((value) => value.site === site) ?? {
    site, provider: explicit === 'auto' ? autoProvider() : explicit,
    country: options.googleCountry, language: options.googleLanguage, pagesFetched: 0,
    queries: googleQueries(site).map((query) => ({ query, nextPage: 1, fingerprints: [], done: false })),
    status: 'running', updatedAt: new Date().toISOString(),
  };
  const save = (candidates: Candidate[] = []) => {
    state.updatedAt = new Date().toISOString();
    context.db.saveGooglePage(context.scanId, state, candidates);
  };
  const cancelled = () => context.signal.aborted || Boolean(context.db.getScan(context.scanId)?.cancelRequested);
  if (state.status === 'exhausted' || state.status === 'limited') return state;
  let browser: GoogleBrowserProvider | undefined;
  state.status = 'running';
  state.error = undefined;
  save();
  try {
    while (!cancelled() && state.pagesFetched < options.googleMaxPages) {
      // Breadth first: error-focused queries cannot be starved by a large site: result set.
      const query = state.queries.filter((item) => !item.done).sort((a, b) => a.nextPage - b.nextPage)[0];
      if (!query) break;
      const request: GoogleSearchRequest = {
        query: query.query, page: query.nextPage, country: state.country, language: state.language,
        nextUrl: state.provider === 'browser' ? query.nextUrl : undefined, signal: context.signal,
      };
      context.progress(`Google ${PROVIDER_LABEL[state.provider]}: ${query.query} · page ${query.nextPage} · ${state.pagesFetched}/${options.googleMaxPages} pages fetched`);
      let page: GooglePage;
      try {
        page = state.provider === 'serper' ? await (providers.serper ?? fetchSerperPage)(request)
          : state.provider === 'searchapi' ? await providers.searchapi(request)
          : await (browser ??= providers.browser()).fetchPage(request);
      } catch (error) {
        if (cancelled()) return state;
        if (error instanceof GoogleChallengeError) {
          state.status = 'waiting';
          state.error = error.message;
          save();
          await context.waitForUser(error.message);
          if (cancelled()) return state;
          state.status = 'running';
          state.error = undefined;
          save();
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (state.provider !== 'browser' && explicit === 'auto') {
          // Cheapest working option next: Serper, then SearchApi when it has a key, then the browser.
          const next: GoogleProviderName = state.provider === 'serper' && process.env.SEARCHAPI_API_KEY ? 'searchapi' : 'browser';
          context.warn(`${PROVIDER_LABEL[state.provider]} unavailable (${message}); continuing with ${next === 'browser' ? 'the local Google browser' : PROVIDER_LABEL[next]}.`);
          state.provider = next;
          // Provider-specific pagination links must not leak across providers.
          for (const item of state.queries) item.nextUrl = undefined;
          save();
          continue;
        }
        state.status = 'failed';
        state.error = message;
        save();
        context.warn(`Google discovery incomplete for ${site}: ${message}`);
        return state;
      }
      const observedAt = new Date().toISOString();
      state.providersUsed = [...new Set([...(state.providersUsed ?? []), state.provider])];
      const candidates: Candidate[] = page.results.flatMap((result) => {
        const normalizedUrl = tryNormalizeUrl(result.url);
        if (!normalizedUrl || !isSameSite(normalizedUrl, site)) return [];
        return [{ inputUrl: normalizedUrl, normalizedUrl, site: siteOrigin(normalizedUrl), sources: [{
          source: state.provider === 'browser' ? 'google_browser' as const : state.provider,
          provider: state.provider, query: query.query, resultPage: query.nextPage, searchUrl: page.searchUrl,
          country: state.country, language: state.language, observedAt, resultKind: result.kind,
          title: result.title, snippet: result.snippet, position: result.position,
        }] }];
      });
      state.pagesFetched += 1;
      if (page.warnings?.length) {
        // Keep successful destinations, but do not mark an incompletely parsed page done.
        state.status = 'failed';
        state.error = page.warnings.join('; ');
        save(candidates);
        context.warn(`Google discovery incomplete for ${site}: ${state.error}`);
        return state;
      }
      const fingerprint = createHash('sha256').update([...new Set(page.results.map((item) => item.url))].sort().join('\n')).digest('hex');
      const repeated = query.fingerprints.includes(fingerprint);
      query.fingerprints.push(fingerprint);
      query.done = !page.results.length || !page.hasNext || repeated;
      query.nextPage += 1;
      query.nextUrl = page.nextUrl;
      save(candidates);
    }
    if (cancelled()) return state;
    state.status = state.queries.every((query) => query.done) ? 'exhausted' : 'limited';
    if (state.status === 'limited') context.warn(`Google discovery for ${site} reached its ${options.googleMaxPages}-page budget. Coverage is partial.`);
    save();
    return state;
  } finally { await browser?.close().catch(() => undefined); }
}
