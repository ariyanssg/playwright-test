import { chromium as playwright } from 'playwright';
import chromium from '@sparticuz/chromium';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPage, makeBaseline } from '../classifier.js';
import { blockUnreadResources, renderPage } from '../scanner.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { fetchSearchApiPage } from '../discovery/searchapi.js';
import { fetchSerperPage } from '../discovery/serper.js';
import { googleQueries } from '../discovery/google-results.js';
import { harvestHours } from '../hours/harvest.js';
import { extractPageHours, chooseWebsiteHours } from '../hours/website.js';
import { auditSiteHours } from '../hours/audit.js';
import { searchPlaces, fetchPlaceDetails } from '../hours/places.js';
import { publicUrl, publicAddress, startPublicProxy } from './network.js';
import type { Candidate, ScanResult } from '../types.js';

type Env = (key: string) => string | undefined;
export async function hostedTask(body: any, env: Env) {
  if (body.action === 'providers') return { hosted: true, serper: Boolean(env('SERPER_API_KEY')), searchApi: Boolean(env('SERPER_API_KEY') || env('SEARCHAPI_API_KEY')), googleBrowser: false, googleDefaultProvider: env('SERPER_API_KEY') ? 'serper' : 'searchapi', googleMaps: Boolean(env('GOOGLE_MAPS_API_KEY')), dataForSeo: false };
  if (body.action === 'google') {
    const site = publicUrl(body.site); await publicAddress(site.hostname);
    const queries = googleQueries(site.origin);
    if (!queries.includes(body.query)) throw new Error('Choose a supported site discovery query.');
    if (!Number.isInteger(body.page) || body.page < 1 || body.page > 100) throw new Error('Invalid search page.');
    if (!/^[a-z]{2}$/.test(body.country) || !/^[a-z-]{2,12}$/i.test(body.language)) throw new Error('Invalid search market.');
    const request = { query: body.query, page: body.page, country: body.country, language: body.language, signal: AbortSignal.timeout(45_000) };
    // Serper is the cheaper API; SearchApi remains the fallback for existing deployments.
    if (env('SERPER_API_KEY')) return { ...await fetchSerperPage(request, env('SERPER_API_KEY')), provider: 'serper' };
    return { ...await fetchSearchApiPage(request, env('SEARCHAPI_API_KEY')), provider: 'searchapi' };
  }
  if (body.action === 'hours-compare') {
    publicUrl(body.site);
    return auditSiteHours({ site: body.site, siteKey: new URL(body.site).hostname.replace(/^www\./, ''), pages: [], hints: body.hints || {}, toleranceMinutes: Math.min(120, Math.max(0, Number(body.toleranceMinutes) || 0)), requireVerifiedPlace: Boolean(body.requireVerifiedPlace) }, { inspect: async () => chooseWebsiteHours(body.pages || [], body.pageErrors || []) }, { search: (q) => searchPlaces(q, env('GOOGLE_MAPS_API_KEY')), details: (id) => fetchPlaceDetails(id, env('GOOGLE_MAPS_API_KEY')) });
  }
  if (!['check', 'hours-page'].includes(body.action)) throw new Error('Unknown hosted action.');
  const url = publicUrl(body.url); await publicAddress(url.hostname);
  const proxy = await startPublicProxy();
  const profile = await mkdtemp(join(tmpdir(), 'signal404-page-'));
  chromium.setGraphicsMode = false;
  const context = await playwright.launchPersistentContext(profile, {
    headless: true, userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block', acceptDownloads: true,
    ...(process.platform === 'linux' ? { executablePath: await chromium.executablePath(), args: [...chromium.args.filter((arg) => !arg.startsWith('--disk-cache-size=')), '--disk-cache-size=1048576'] } : {}),
    downloadsPath: join(profile, 'downloads'), proxy: { server: proxy.server, bypass: '<-loopback>' },
  }).catch(async (error) => { await proxy.close(); await rm(profile, { recursive: true, force: true }); throw error; });
  try {
    // Hours extraction reads innerText and needs styles; a 404 check does not.
    if (body.action === 'hours-page') await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
    else await blockUnreadResources(context);
    const page = await context.newPage();
    if (body.action === 'hours-page') {
      const harvested = await harvestHours(page, url.href, 12_000);
      return { extraction: harvested.error ? null : extractPageHours(harvested, url.href, Number(body.score) || 1), error: harvested.error };
    }
    const rendered = await renderPage(page, url.href, 12_000);
    if (/ERR_INSUFFICIENT_RESOURCES|Target page, context or browser has been closed/i.test(rendered.error || '')) throw new Error('The hosted browser could not finish this check. Progress is saved; resume to retry this URL.');
    // One baseline is stored in the browser and reused across URL checks.
    let baseline = body.baseline ? { ...body.baseline, tokens: new Set<string>(body.baseline.tokens || []) } : null;
    if (!body.baselineChecked && rendered.status && rendered.status >= 200 && rendered.status < 300 && /html/i.test(rendered.contentType || '')) {
      const missing = await context.newPage();
      try { baseline = makeBaseline(await renderPage(missing, `${url.origin}/seo404-auditor-missing-${randomUUID()}`, 8_000)); } finally { await missing.close(); }
    }
    const decision = classifyPage(rendered, baseline);
    const candidate: Candidate = { inputUrl: url.href, normalizedUrl: url.href, site: url.origin, sources: [] };
    const result: ScanResult = { ...candidate, httpStatus: rendered.status, finalUrl: rendered.finalUrl, redirectChain: rendered.redirects, classification: decision.classification, confidence: decision.confidence, reasons: decision.reasons, robotsAllowed: null, title: rendered.title, h1: rendered.h1, canonical: rendered.canonical, contentType: rendered.contentType, responseMs: rendered.responseMs, checkedAt: new Date().toISOString(), error: rendered.error ?? null };
    return { result, baseline: baseline ? { ...baseline, tokens: [...baseline.tokens] } : null, baselineChecked: body.baselineChecked || Boolean(rendered.status && /html/i.test(rendered.contentType || '')) };
  } finally { await context.close().catch(() => {}); await proxy.close(); await rm(profile, { recursive: true, force: true }); }
}
