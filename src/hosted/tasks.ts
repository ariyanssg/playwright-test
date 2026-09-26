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
import { searchPlaces, fetchPlaceDetails, searchSerperPlaces } from '../hours/places.js';
import { discoverSitemaps } from '../discovery/sitemap.js';
import { discoverBacklinks } from '../discovery/backlinks.js';
import { RobotsCache } from '../robots.js';
import { isSameSite, normalizeUrl } from '../urls.js';
import { ProfileBrowser, mergeWebsitePages } from '../profile/website.js';
import { buildProfileReport, durableReport, readGoogleSide, serviceDestinations, type AuditOptions, type GoogleSide } from '../profile/audit.js';
import { readMapsServiceLinks } from '../profile/maps-panel.js';
import type { BrowserContext } from 'playwright';
import type { ProfileTarget, ServiceLink, WebsiteSnapshot } from '../profile/model.js';
import { publicUrl, publicAddress, startPublicProxy } from './network.js';
import type { Candidate, ScanResult } from '../types.js';

type Env = (key: string) => string | undefined;
export async function hostedTask(body: any, env: Env) {
  // Provider modules read their keys from process.env; Netlify exposes them through `env`.
  for (const key of ['SERPER_API_KEY', 'SEARCHAPI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']) { const value = env(key); if (value && !process.env[key]) process.env[key] = value; }
  if (body.action === 'providers') return { hosted: true, serper: Boolean(env('SERPER_API_KEY')), searchApi: Boolean(env('SERPER_API_KEY') || env('SEARCHAPI_API_KEY')), googleBrowser: false, googleDefaultProvider: env('SERPER_API_KEY') ? 'serper' : 'searchapi', googleMaps: Boolean(env('GOOGLE_MAPS_API_KEY')), dataForSeo: Boolean(env('DATAFORSEO_LOGIN') && env('DATAFORSEO_PASSWORD')), profileAudit: Boolean(env('SERPER_API_KEY') || env('GOOGLE_MAPS_API_KEY')), gbpConfigured: false, gbpAuthenticated: false };
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
    return auditSiteHours({ site: body.site, siteKey: new URL(body.site).hostname.replace(/^www\./, ''), pages: [], hints: body.hints || {}, toleranceMinutes: Math.min(120, Math.max(0, Number(body.toleranceMinutes) || 0)), requireVerifiedPlace: Boolean(body.requireVerifiedPlace) }, { inspect: async () => chooseWebsiteHours(body.pages || [], body.pageErrors || []) }, {
      // Same order as the desktop edition: Google Maps data via Serper, then the Places API.
      search: async (q) => env('SERPER_API_KEY') ? searchSerperPlaces(q, env('SERPER_API_KEY')).catch((error) => { if (!env('GOOGLE_MAPS_API_KEY')) throw error; return searchPlaces(q, env('GOOGLE_MAPS_API_KEY')); }) : searchPlaces(q, env('GOOGLE_MAPS_API_KEY')),
      details: (id) => env('GOOGLE_MAPS_API_KEY') && !id.startsWith('cid:') ? fetchPlaceDetails(id, env('GOOGLE_MAPS_API_KEY')) : Promise.resolve(null),
    });
  }
  if (body.action === 'sitemap') {
    const site = publicUrl(normalizeUrl(body.site)); await publicAddress(site.hostname);
    // Only same-site sitemap files are followed (enforced by discoverSitemaps), on a host that
    // was just validated as public; the file budget keeps one call inside the function limit.
    const found = await discoverSitemaps(site.origin, new RobotsCache(), [], 25);
    return { urls: found.urls.slice(0, 20_000), warnings: found.warnings };
  }
  if (body.action === 'backlinks') {
    const site = publicUrl(normalizeUrl(body.site));
    const found = await discoverBacklinks(site.origin, Math.min(2_000, Math.max(1, Number(body.limit) || 1_000)), env('DATAFORSEO_LOGIN'), env('DATAFORSEO_PASSWORD'));
    return { backlinks: found.backlinks, candidates: found.candidates, coverageNote: found.coverageNote, costUsd: found.costUsd };
  }
  if (body.action === 'profile-google') {
    const target = profileTarget(body.target);
    const options = profileOptions(body);
    // The browser read each page separately; rebuild the website exactly as the desktop crawl does.
    const website = mergeWebsitePages(target, Array.isArray(body.pages) ? body.pages : [], Array.isArray(body.warnings) ? body.warnings.map(String) : [], Boolean(body.incomplete));
    // Google Search's business panel needs a visible browser and a person for CAPTCHAs, so the
    // hosted edition reads the listing and its Maps buttons only.
    const side = await readGoogleSide(target, website, { ...options, searchPanel: false }, {
      mapsPanel: (placeId, country, timeoutMs) => withHostedContext(true, (context) => readMapsServiceLinks(placeId, country, timeoutMs, async () => context)),
    });
    return { website, side, destinations: serviceDestinations(website, side) };
  }
  if (body.action === 'profile-report') {
    const target = profileTarget(body.target);
    const report = buildProfileReport(String(body.auditId), target, profileOptions(body), String(body.startedAt), body.website as WebsiteSnapshot, body.side as GoogleSide, body.links || []);
    // The live report is shown for this session; only the redacted copy is kept in browser storage.
    return { report, durable: durableReport(report) };
  }
  if (body.action === 'profile-page' || body.action === 'profile-link') {
    const target = profileTarget(body.target);
    return withHostedContext(false, async (context) => {
      const browser = new ProfileBrowser({ pageLimit: 1, timeoutMs: 18_000, hostDelayMs: 0, openContext: async () => context });
      if (body.action === 'profile-page') {
        const url = publicUrl(String(body.url)); await publicAddress(url.hostname);
        try { return await browser.inspectPage(target, url.href, Number(body.depth) || 0, body.landing ? String(body.landing) : undefined); }
        catch (error) { return { url: url.href, error: error instanceof Error ? error.message : String(error) }; }
      }
      const link = body.link as ServiceLink;
      publicUrl(link.url);
      return browser.check(link, target, body.website as WebsiteSnapshot);
    });
  }
  if (body.action === 'crawl-page') {
    const site = publicUrl(normalizeUrl(body.site)), url = publicUrl(String(body.url));
    if (!isSameSite(url.href, site.href)) throw new Error('Crawl pages must belong to the audited website.');
    await publicAddress(url.hostname);
    const robots = await new RobotsCache().get(url.href);
    if (!robots.isAllowed(url.href)) return { links: [], blocked: true };
    return withHostedContext(true, async (context) => {
      const page = await context.newPage();
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => undefined);
      const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((node) => (node as HTMLAnchorElement).href));
      const links = [...new Set(hrefs.flatMap((href) => { try { const next = normalizeUrl(href); return isSameSite(next, site.href) && !/\.(?:jpe?g|png|gif|webp|svg|css|js|zip|mp4)(?:$|\?)/i.test(next) ? [next] : []; } catch { return []; } }))];
      return { links: links.filter((link) => robots.isAllowed(link)).slice(0, 2_000), blocked: false };
    });
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

function profileTarget(value: any): ProfileTarget {
  if (!value || typeof value.url !== 'string') throw new Error('A restaurant website is required.');
  const url = publicUrl(normalizeUrl(value.url)).href;
  const text = (item: unknown) => typeof item === 'string' && item.trim() ? item.trim().slice(0, 500) : undefined;
  return { url, name: text(value.name), address: text(value.address), placeId: text(value.placeId) };
}

function profileOptions(body: any): AuditOptions {
  return { mode: 'public', pageLimit: 1, timeoutMs: 15_000, hostDelayMs: 0, country: /^[a-z]{2}$/i.test(body.country || '') ? String(body.country).toUpperCase() : 'GB', tolerance: Math.min(120, Math.max(0, Number(body.tolerance) || 0)) };
}

/**
 * One bundled Chromium per worker call, with every request (subresources and redirects too)
 * forced through the public-network proxy. `media` blocks images/fonts for pages we only read.
 */
async function withHostedContext<T>(lean: boolean, work: (context: BrowserContext) => Promise<T>): Promise<T> {
  const proxy = await startPublicProxy();
  const profile = await mkdtemp(join(tmpdir(), 'signal404-page-'));
  chromium.setGraphicsMode = false;
  const context = await playwright.launchPersistentContext(profile, {
    headless: true, userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block', acceptDownloads: false, locale: 'en-GB', viewport: { width: 1280, height: 900 },
    ...(process.platform === 'linux' ? { executablePath: await chromium.executablePath(), args: [...chromium.args.filter((arg) => !arg.startsWith('--disk-cache-size=')), '--disk-cache-size=1048576'] } : {}),
    proxy: { server: proxy.server, bypass: '<-loopback>' },
  }).catch(async (error) => { await proxy.close(); await rm(profile, { recursive: true, force: true }); throw error; });
  try {
    if (lean) await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
    return await work(context);
  } finally { await context.close().catch(() => {}); await proxy.close(); await rm(profile, { recursive: true, force: true }); }
}
