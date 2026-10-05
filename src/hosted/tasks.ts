import { chromium as playwright, type Browser, type BrowserContext } from 'playwright';
import chromium from '@sparticuz/chromium';
import { randomUUID } from 'node:crypto';
import { classifyPage, makeBaseline, type MissingBaseline } from '../classifier.js';
import { blockUnreadResources, networkFailure, renderPage } from '../scanner.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { fetchSearchApiPage } from '../discovery/searchapi.js';
import { fetchSerperPage } from '../discovery/serper.js';
import { googleQueries } from '../discovery/google-results.js';
import { harvestHours } from '../hours/harvest.js';
import { extractPageHours, chooseWebsiteHours } from '../hours/website.js';
import { auditSiteHours } from '../hours/audit.js';
import { placeLookup } from '../hours/places.js';
import { discoverSitemaps } from '../discovery/sitemap.js';
import { discoverBacklinks } from '../discovery/backlinks.js';
import { RobotsCache } from '../robots.js';
import { isSameSite, normalizeUrl, siteKey } from '../urls.js';
import { ProfileBrowser, mergeWebsitePages } from '../profile/website.js';
import { buildProfileReport, durableReport, readGoogleSide, serviceDestinations, type AuditOptions, type GoogleSide } from '../profile/audit.js';
import { readMapsServiceLinks } from '../profile/maps-panel.js';
import type { LinkCheck, ProfileTarget, ServiceLink, WebsiteSnapshot } from '../profile/model.js';
import { publicUrl, publicAddress as resolvePublic, startPublicProxy } from './network.js';
import type { Candidate, HoursComparisonRecord, ScanResult } from '../types.js';

/**
 * Netlify ends a synchronous function at 60 s. Every step plans to finish inside this budget,
 * returning whatever it completed and naming what it skipped, so a slow restaurant website costs
 * a second call instead of a failed audit.
 */
const BUDGET_MS = 48_000;
/** Pages read at once inside one call; one Chromium on a 1 GB function handles three comfortably. */
const PAGE_PARALLEL = 3;
/** The most items one call accepts, so a request can never ask for more than its budget allows. */
const MAX_BATCH = { check: 8, hours: 6, profile: 4, links: 4 } as const;
/** A long-lived Chromium slowly gains memory; a fresh one is launched after this many steps. */
const RECYCLE_AFTER = 60;

/** A request the worker refuses outright: retrying it can never succeed. */
export class HostedInputError extends Error {}

type Env = (key: string) => string | undefined;
interface Clock { remaining(): number }
const startClock = (): Clock => { const end = Date.now() + BUDGET_MS; return { remaining: () => end - Date.now() }; };

export async function hostedTask(body: any, env: Env) {
  // Provider modules read their keys from process.env; Netlify exposes them through `env`.
  for (const key of ['SERPER_API_KEY', 'SEARCHAPI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD']) { const value = env(key); if (value && !process.env[key]) process.env[key] = value; }
  const clock = startClock();
  if (body?.action === 'providers') return { hosted: true, serper: Boolean(env('SERPER_API_KEY')), searchApi: Boolean(env('SERPER_API_KEY') || env('SEARCHAPI_API_KEY')), googleBrowser: false, googleDefaultProvider: env('SERPER_API_KEY') ? 'serper' : 'searchapi', googleMaps: Boolean(env('GOOGLE_MAPS_API_KEY')), dataForSeo: Boolean(env('DATAFORSEO_LOGIN') && env('DATAFORSEO_PASSWORD')), profileAudit: Boolean(env('SERPER_API_KEY') || env('GOOGLE_MAPS_API_KEY')), gbpConfigured: false, gbpAuthenticated: false };
  if (body?.action === 'google') {
    const site = input(() => publicUrl(body.site)); await publicAddress(site.hostname);
    const queries = googleQueries(site.origin);
    if (!queries.includes(body.query)) throw new HostedInputError('Choose a supported site discovery query.');
    if (!Number.isInteger(body.page) || body.page < 1 || body.page > 100) throw new HostedInputError('Invalid search page.');
    if (!/^[a-z]{2}$/.test(body.country) || !/^[a-z-]{2,12}$/i.test(body.language)) throw new HostedInputError('Invalid search market.');
    const request = { query: body.query, page: body.page, country: body.country, language: body.language, signal: AbortSignal.timeout(clock.remaining()) };
    // Serper is the cheaper API; SearchApi remains the fallback for existing deployments.
    if (env('SERPER_API_KEY')) return { ...await fetchSerperPage(request, env('SERPER_API_KEY')), provider: 'serper' };
    return { ...await fetchSearchApiPage(request, env('SEARCHAPI_API_KEY')), provider: 'searchapi' };
  }
  if (body?.action === 'check') return checkPages(body, clock);
  if (body?.action === 'hours-pages') return hoursPages(body, clock);
  if (body?.action === 'hours-compare') return hoursCompare(body, env, clock);
  if (body?.action === 'sitemap') {
    const site = input(() => publicUrl(normalizeUrl(body.site))); await publicAddress(site.hostname);
    // Only same-site sitemap files are followed (enforced by discoverSitemaps), on a host that
    // was just validated as public; the file budget keeps one call inside the function limit.
    const found = await within(clock.remaining() - 2_000, discoverSitemaps(site.origin, new RobotsCache(), [], 25), 'Reading the sitemaps took longer than one online step allows');
    return { urls: found.urls.slice(0, 20_000), warnings: found.warnings };
  }
  if (body?.action === 'backlinks') {
    const site = input(() => publicUrl(normalizeUrl(body.site)));
    const found = await discoverBacklinks(site.origin, Math.min(2_000, Math.max(1, Number(body.limit) || 1_000)), env('DATAFORSEO_LOGIN'), env('DATAFORSEO_PASSWORD'));
    return { backlinks: found.backlinks, candidates: found.candidates, coverageNote: found.coverageNote, costUsd: found.costUsd };
  }
  if (body?.action === 'crawl-page') return crawlPage(body, clock);
  if (body?.action === 'profile-pages') return profilePages(body, clock);
  if (body?.action === 'profile-google') {
    const target = profileTarget(body.target);
    const options = { ...profileOptions(body), signal: AbortSignal.timeout(Math.max(5_000, clock.remaining() - 20_000)) };
    // The browser read each page separately; rebuild the website exactly as the desktop crawl does.
    const website = mergeWebsitePages(target, Array.isArray(body.pages) ? body.pages : [], Array.isArray(body.warnings) ? body.warnings.map(String) : [], Boolean(body.incomplete));
    // Google Search's business panel needs a visible browser and a person for CAPTCHAs, so the
    // hosted edition reads the listing and its Maps buttons only. The Maps read gets whatever
    // time is left; running out only costs those buttons, which the report then marks unread.
    const side = await readGoogleSide(target, website, { ...options, searchPanel: false }, {
      mapsPanel: (placeId, country) => withContext('plain', (context) => within(clock.remaining() - 2_000, readMapsServiceLinks(placeId, country, 10_000, async () => context), 'ran out of time online')),
    });
    return { website, side, destinations: serviceDestinations(website, side) };
  }
  if (body?.action === 'profile-links') return profileLinks(body, clock);
  if (body?.action === 'profile-report') {
    const target = profileTarget(body.target);
    const report = buildProfileReport(String(body.auditId), target, profileOptions(body), String(body.startedAt), body.website as WebsiteSnapshot, body.side as GoogleSide, body.links || []);
    // The live report is shown for this session; only the redacted copy is kept in browser storage.
    return { report, durable: durableReport(report) };
  }
  throw new HostedInputError('Unknown hosted action.');
}

/** URL checks, a few at a time in one context; whatever does not fit the budget is handed back. */
async function checkPages(body: any, clock: Clock) {
  const urls = list<string>(body.urls, MAX_BATCH.check).map(String);
  const baselines: Record<string, { baseline: SerializedBaseline | null; baselineChecked: boolean }> = body.baselines && typeof body.baselines === 'object' ? body.baselines : {};
  const results: Array<{ url: string; result: ScanResult }> = [], skipped: string[] = [];
  await withContext('check', async (context) => {
    // One synthetic missing page per origin, shared by every URL of that origin in this batch.
    const pendingBaselines = new Map<string, Promise<void>>();
    await pool(urls, PAGE_PARALLEL, async (raw) => {
      if (clock.remaining() < 16_000) { skipped.push(raw); return; }
      let url: URL;
      try { url = input(() => publicUrl(raw)); await publicAddress(url.hostname); }
      catch (error) { results.push({ url: raw, result: scanResult(raw, networkFailure(raw, message(error)), null) }); return; }
      const page = await context.newPage();
      try {
        const rendered = await within(clock.remaining() - 3_000, renderPage(page, url.href, Math.min(12_000, clock.remaining() - 6_000)), '').catch(() => null);
        // A browser that ran out of room is this worker's problem, not the page's: check it again.
        if (!rendered || /ERR_INSUFFICIENT_RESOURCES|Target page, context or browser has been closed/i.test(rendered.error || '')) { skipped.push(raw); return; }
        const origin = url.origin;
        if (!baselines[origin]?.baselineChecked && rendered.status && rendered.status >= 200 && rendered.status < 300 && /html/i.test(rendered.contentType || '')) {
          let job = pendingBaselines.get(origin);
          if (!job) {
            job = (async () => {
              const missing = await context.newPage();
              try { baselines[origin] = { baseline: serializeBaseline(makeBaseline(await renderPage(missing, `${origin}/seo404-auditor-missing-${randomUUID()}`, Math.max(2_000, Math.min(8_000, clock.remaining() - 4_000))))), baselineChecked: true }; }
              finally { await missing.close().catch(() => undefined); }
            })().catch(() => undefined);
            pendingBaselines.set(origin, job);
          }
          await job;
        }
        results.push({ url: raw, result: scanResult(raw, rendered, deserializeBaseline(baselines[origin]?.baseline)) });
      } finally { await page.close().catch(() => undefined); }
    });
  });
  return { results, skipped, baselines };
}

/** The pages that may publish a restaurant's opening hours, read in parallel. */
async function hoursPages(body: any, clock: Clock) {
  const items = list<{ url: string; score?: number }>(body.items, MAX_BATCH.hours);
  const pages: unknown[] = [], errors: string[] = [], skipped: string[] = [];
  await withContext('lean', (context) => pool(items, PAGE_PARALLEL, async (item) => {
    const raw = String(item?.url);
    if (clock.remaining() < 14_000) { skipped.push(raw); return; }
    let url: URL;
    try { url = input(() => publicUrl(raw)); await publicAddress(url.hostname); } catch (error) { errors.push(`${raw}: ${message(error)}`); return; }
    const page = await context.newPage();
    try {
      const harvested = await within(clock.remaining() - 3_000, harvestHours(page, url.href, Math.min(12_000, clock.remaining() - 6_000)), '').catch(() => null);
      if (!harvested) { skipped.push(raw); return; }
      // An error page cannot publish the restaurant's hours; saying so beats "no hours found".
      if (harvested.error) errors.push(`${raw}: ${harvested.error}`);
      else if (harvested.status && harvested.status >= 400) errors.push(`${raw}: HTTP ${harvested.status}`);
      else pages.push(extractPageHours(harvested, url.href, Number(item.score) || 1));
    } finally { await page.close().catch(() => undefined); }
  }));
  return { pages, errors, skipped };
}

/**
 * Compares a site's hours with its Google listing. A provider failure is this restaurant's result
 * ("not checked", with the reason), never an error that stops the other restaurants.
 */
async function hoursCompare(body: any, env: Env, clock: Clock): Promise<HoursComparisonRecord> {
  const site = input(() => publicUrl(normalizeUrl(body.site))).href;
  const key = siteKey(site);
  const signal = AbortSignal.timeout(Math.max(5_000, clock.remaining() - 2_000));
  const lookup = placeLookup({ serper: env('SERPER_API_KEY'), maps: env('GOOGLE_MAPS_API_KEY') }, { signal, country: /^[a-z]{2}$/i.test(body.country || '') ? body.country : undefined });
  try {
    const record = await auditSiteHours({ site, siteKey: key, pages: [], hints: body.hints || {}, toleranceMinutes: Math.min(120, Math.max(0, Number(body.toleranceMinutes) || 0)), requireVerifiedPlace: Boolean(body.requireVerifiedPlace) },
      { inspect: async () => chooseWebsiteHours(Array.isArray(body.pages) ? body.pages : [], Array.isArray(body.pageErrors) ? body.pageErrors.map(String) : []) }, lookup);
    return record;
  } catch (error) {
    const extraction = chooseWebsiteHours(Array.isArray(body.pages) ? body.pages : [], []);
    return { site, siteKey: key, status: 'not_checked', matchConfidence: 'none', placeId: null, placeName: null, placeAddress: null, placeWebsite: null, businessStatus: null, utcOffsetMinutes: null, websiteMethod: extraction.method, websiteHoursUrl: extraction.sourceUrl, pagesInspected: extraction.pagesInspected, days: [], maxDeltaMinutes: null, notes: [`The Google listing could not be read: ${message(error)}`], checkedAt: new Date().toISOString() };
  }
}

async function crawlPage(body: any, clock: Clock) {
  const site = input(() => publicUrl(normalizeUrl(body.site))), url = input(() => publicUrl(String(body.url)));
  if (!isSameSite(url.href, site.href)) throw new HostedInputError('Crawl pages must belong to the audited website.');
  await publicAddress(url.hostname);
  const robots = await new RobotsCache().get(url.href);
  if (!robots.isAllowed(url.href)) return { links: [], blocked: true };
  return withContext('lean', async (context) => {
    const page = await context.newPage();
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: Math.min(12_000, clock.remaining() - 8_000) });
    await page.waitForLoadState('load', { timeout: 4_000 }).catch(() => undefined);
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((node) => (node as HTMLAnchorElement).href));
    const links = [...new Set(hrefs.flatMap((href) => { try { const next = normalizeUrl(href); return isSameSite(next, site.href) && !/\.(?:jpe?g|png|gif|webp|svg|css|js|zip|mp4)(?:$|\?)/i.test(next) ? [next] : []; } catch { return []; } }))];
    return { links: links.filter((link) => robots.isAllowed(link)).slice(0, 2_000), blocked: false };
  });
}

/** Website pages for the profile comparison. A page that ran out of time comes back as `retry`. */
async function profilePages(body: any, clock: Clock) {
  const target = profileTarget(body.target);
  const items = list<{ url: string; depth?: number }>(body.items, MAX_BATCH.profile);
  const landing = body.landing ? String(body.landing) : undefined;
  return withContext('plain', async (context) => {
    const browser = new ProfileBrowser({ pageLimit: 1, timeoutMs: 12_000, hostDelayMs: 0, openContext: async () => context });
    const pages = await pool(items, PAGE_PARALLEL, async (item) => {
      const raw = String(item?.url);
      if (clock.remaining() < 16_000) return { url: raw, retry: true };
      try {
        const url = input(() => publicUrl(raw)); await publicAddress(url.hostname);
        const page = await within(clock.remaining() - 3_000, browser.inspectPage(target, url.href, Number(item.depth) || 0, landing), '').catch((error) => error instanceof DeadlineError ? null : Promise.reject(error));
        return page ?? { url: raw, retry: true };
      } catch (error) { return { url: raw, error: message(error) }; }
    });
    return { pages };
  });
}

/** Service destinations (menu, booking, ordering, website), checked a few at a time. */
async function profileLinks(body: any, clock: Clock) {
  const target = profileTarget(body.target);
  const links = list<ServiceLink>(body.links, MAX_BATCH.links);
  return withContext('plain', async (context) => {
    const browser = new ProfileBrowser({ pageLimit: 1, timeoutMs: 12_000, hostDelayMs: 0, openContext: async () => context });
    const checks = await pool(links, PAGE_PARALLEL, async (link): Promise<LinkCheck | { retry: true }> => {
      if (clock.remaining() < 18_000) return { retry: true };
      try { publicUrl(link.url); }
      catch (error) { return { ...link, finalUrl: link.url, httpStatus: null, redirectChain: [], health: 'blocked', serviceReady: null, correctBranch: null, transactionTested: false, reason: `Not checked online: ${message(error)}`, checkedAt: new Date().toISOString() }; }
      return await within(clock.remaining() - 3_000, browser.check(link, target, body.website as WebsiteSnapshot), '').catch(() => ({ retry: true as const }));
    });
    return { checks };
  });
}

function profileTarget(value: any): ProfileTarget {
  if (!value || typeof value.url !== 'string') throw new HostedInputError('A restaurant website is required.');
  const url = input(() => publicUrl(normalizeUrl(value.url))).href;
  const text = (item: unknown) => typeof item === 'string' && item.trim() ? item.trim().slice(0, 500) : undefined;
  return { url, name: text(value.name), address: text(value.address), placeId: text(value.placeId) };
}

function profileOptions(body: any): AuditOptions {
  return { mode: 'public', pageLimit: 1, timeoutMs: 12_000, hostDelayMs: 0, country: /^[a-z]{2}$/i.test(body.country || '') ? String(body.country).toUpperCase() : 'GB', tolerance: Math.min(120, Math.max(0, Number(body.tolerance) || 0)) };
}

/* ---------- Results ---------- */

type SerializedBaseline = Omit<MissingBaseline, 'tokens'> & { tokens: string[] };
const serializeBaseline = (baseline: MissingBaseline): SerializedBaseline => ({ ...baseline, tokens: [...baseline.tokens] });
const deserializeBaseline = (baseline: SerializedBaseline | null | undefined): MissingBaseline | null => baseline ? { ...baseline, tokens: new Set(baseline.tokens || []) } : null;

function scanResult(url: string, rendered: ReturnType<typeof networkFailure>, baseline: MissingBaseline | null): ScanResult {
  const decision = classifyPage(rendered, baseline);
  const candidate: Candidate = { inputUrl: url, normalizedUrl: url, site: safeOrigin(url), sources: [] };
  return { ...candidate, httpStatus: rendered.status, finalUrl: rendered.finalUrl, redirectChain: rendered.redirects, classification: decision.classification, confidence: decision.confidence, reasons: decision.reasons, robotsAllowed: null, title: rendered.title, h1: rendered.h1, canonical: rendered.canonical, contentType: rendered.contentType, responseMs: rendered.responseMs, checkedAt: new Date().toISOString(), error: rendered.error ?? null };
}

/* ---------- Warm Chromium ---------- */

interface Warm { browser: Browser; proxy: Awaited<ReturnType<typeof startPublicProxy>>; open: number; uses: number }
let warm: Promise<Warm> | null = null;

/**
 * One bundled Chromium per function instance, kept between calls. Launching it is most of a cold
 * call's cost, and Netlify reuses a warm instance for the next request. Every request (subresources
 * and redirects too) still goes through the public-network proxy set at launch.
 */
async function launch(): Promise<Warm> {
  const proxy = await startPublicProxy();
  chromium.setGraphicsMode = false;
  try {
    const browser = await playwright.launch({
      headless: true, proxy: { server: proxy.server, bypass: '<-loopback>' },
      ...(process.platform === 'linux' ? { executablePath: await chromium.executablePath(), args: [...chromium.args.filter((arg) => !arg.startsWith('--disk-cache-size=')), '--disk-cache-size=1048576'] } : {}),
    });
    return { browser, proxy, open: 0, uses: 0 };
  } catch (error) { await proxy.close(); throw error; }
}

async function retire(instance: Warm): Promise<void> {
  await instance.browser.close().catch(() => undefined);
  await instance.proxy.close().catch(() => undefined);
}

/**
 * `check` blocks everything the 404 classifier never reads; `lean` keeps styles (hours extraction
 * reads innerText, which depends on them); `plain` leaves blocking to the caller.
 */
async function withContext<T>(kind: 'check' | 'lean' | 'plain', work: (context: BrowserContext) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = warm ??= launch().catch((error) => { warm = null; throw error; });
    const instance = await current;
    if (!instance.browser.isConnected()) { if (warm === current) warm = null; void retire(instance); continue; }
    let context: BrowserContext;
    try {
      context = await instance.browser.newContext({ userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block', acceptDownloads: kind === 'check', locale: 'en-GB', viewport: { width: 1280, height: 900 } });
    } catch (error) {
      if (instance.browser.isConnected()) throw error;
      if (warm === current) warm = null; void retire(instance); continue;
    }
    instance.open++; instance.uses++;
    // Retire after enough steps: the next call launches fresh, this one closes once idle.
    if (instance.uses >= RECYCLE_AFTER && warm === current) warm = null;
    try {
      if (kind === 'check') await blockUnreadResources(context);
      else if (kind === 'lean') await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
      return await work(context);
    } finally {
      await context.close().catch(() => undefined);
      instance.open--;
      if (warm !== current && !instance.open) await retire(instance);
    }
  }
  throw new Error('The online browser could not start. It is retried automatically.');
}

/* ---------- Helpers ---------- */

class DeadlineError extends Error {}

/** Settles with `work`, or rejects once `ms` has passed (the caller's context close then stops the work). */
async function within<T>(ms: number, work: Promise<T>, reason: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineError(reason || 'Ran out of time')), Math.max(0, ms)); })]);
  } finally { clearTimeout(timer); work.catch(() => undefined); }
}

/** Runs `work` over `items` with at most `width` at once, keeping results in input order. */
async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) out[index] = await work(items[index]!);
  }));
  return out;
}

function list<T>(value: unknown, max: number): T[] {
  if (!Array.isArray(value) || !value.length) throw new HostedInputError('Send at least one item.');
  if (value.length > max) throw new HostedInputError(`Send at most ${max} items per step.`);
  return value as T[];
}

/** Turns a validation failure into a refusal the browser will not retry. */
function input<T>(read: () => T): T {
  try { return read(); } catch (error) { throw new HostedInputError(message(error)); }
}

/** A private or reserved address is a refusal; a DNS hiccup is worth another try. */
async function publicAddress(host: string): Promise<string> {
  try { return await resolvePublic(host); }
  catch (error) { throw /Private, local, or reserved/.test(message(error)) ? new HostedInputError(message(error)) : error; }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeOrigin(url: string): string { try { return new URL(url).origin; } catch { return url; } }
