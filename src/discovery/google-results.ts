import { tryNormalizeUrl, siteKey } from '../urls.js';

export interface GoogleSearchRequest {
  query: string;
  page: number;
  country: string;
  language: string;
  nextUrl?: string;
  signal?: AbortSignal;
}

export interface GoogleResult {
  url: string;
  title?: string;
  snippet?: string;
  position?: number;
  kind: 'organic' | 'sitelink';
}

export interface GooglePage {
  results: GoogleResult[];
  hasNext: boolean;
  nextUrl?: string;
  searchUrl: string;
  warnings?: string[];
}

export class GoogleChallengeError extends Error {}

export function googleQueries(site: string): string[] {
  const base = `site:${siteKey(site)}`;
  return [base, `${base} 404`, `${base} "not found"`, `${base} "page does not exist"`, `${base} intitle:error`];
}

export function googleSearchUrl(request: GoogleSearchRequest): string {
  const url = new URL('https://www.google.com/search');
  url.search = new URLSearchParams({ q: request.query, gl: request.country, hl: request.language, pws: '0', start: String((request.page - 1) * 10) }).toString();
  return url.href;
}

export function isGoogleHost(hostname: string): boolean {
  return /(^|\.)google\.(com|co\.uk)$/.test(hostname);
}

/** Never reconstruct a destination from Google's truncated displayed breadcrumb. */
export function directGoogleDestination(value: string, base = 'https://www.google.com'): string | null {
  let url: URL;
  try { url = new URL(value, base); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (!isGoogleHost(url.hostname)) return tryNormalizeUrl(url.href);
  if (!['/url', '/goto'].includes(url.pathname)) return null;
  const target = url.searchParams.get('q') || url.searchParams.get('url');
  return target && /^https?:\/\//i.test(target) ? tryNormalizeUrl(target) : null;
}
