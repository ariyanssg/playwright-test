import { normalizeUrl } from '../urls.ts';
import { linkCandidates, selectHoursPages } from '../hours/pages.ts';
const ACTIVE = ['queued', 'discovering', 'scanning', 'comparing_hours', 'comparing_profile', 'reporting'];
/** Sources that run online. Search Console needs a stored OAuth token, so it stays desktop-only. */
const HOSTED_SOURCES = ['import', 'google', 'serper', 'searchapi', 'sitemap', 'crawl', 'backlinks'];
const GOOGLE_SOURCES = ['google', 'serper', 'searchapi'];
/** Live profile reports hold Google values; they live for this page session only, as on desktop. */
const liveProfiles = new Map();
const SERVICE_PATH = /contact|hours|menu|reserv|book|order/i;
const CLASSIFICATIONS = ['hard_404', 'gone_410', 'soft_404_suspected', 'redirected', 'ok', 'server_error', 'blocked', 'timeout', 'network_error'];
/** Worst first, as on desktop: a reader opens the results to see what is broken. */
const SEVERITY = ['hard_404', 'gone_410', 'soft_404_suspected', 'server_error', 'timeout', 'network_error', 'blocked', 'redirected', 'ok'];
const actionable = (value) => ['hard_404', 'gone_410', 'soft_404_suspected'].includes(value);
const now = () => new Date().toISOString();
const locks = new Set();
const transientErrors = new Map();
/** URLs per worker call. The worker reads three at a time, so six is about two page loads deep. */
const CHECK_BATCH = 6;
const LINK_BATCH = 4;
/** A page the worker had no time for is offered again this many times before it waits for Resume. */
const MAX_SKIPS = 2;
const dbPromise = new Promise((resolve, reject) => {
  const open = indexedDB.open('signal404-audits', 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore('scans', { keyPath: 'id' });
    db.createObjectStore('uploads', { keyPath: 'id' });
    const urls = db.createObjectStore('urls', { keyPath: ['scanId', 'normalizedUrl'] });
    urls.createIndex('scanId', 'scanId');
  };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(new Error('Browser storage is unavailable. Allow site storage to save audits.'));
});
const result = (request) => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
async function transaction(stores, mode, work) {
  const db = await dbPromise, tx = db.transaction(stores, mode);
  const finished = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(new Error('Could not save audit progress. Browser storage may be full. Export existing audits and free space before continuing.')); });
  try { const value = await work(tx); await finished; return value; } catch (error) { try { tx.abort(); } catch {} await finished.catch(() => {}); throw error; }
}
const get = (store, key) => transaction([store], 'readonly', (tx) => result(tx.objectStore(store).get(key)));
const put = (store, value) => transaction([store], 'readwrite', (tx) => result(tx.objectStore(store).put(value)));
const scans = () => transaction(['scans'], 'readonly', (tx) => result(tx.objectStore('scans').getAll()));
const updateScan = (id, patch) => transaction(['scans'], 'readwrite', async (tx) => { const store = tx.objectStore('scans'), scan = await result(store.get(id)); if (!scan) throw new Error('Audit not found'); Object.assign(scan, patch); store.put(scan); return scan; });
export const candidates = (id) => transaction(['urls'], 'readonly', (tx) => result(tx.objectStore('urls').index('scanId').getAll(id)));
const normalize = normalizeUrl;
const host = (value) => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
const queryList = (site) => { const q = `site:${host(site)}`; return [q, `${q} 404`, `${q} "not found"`, `${q} "page does not exist"`, `${q} intitle:error`]; };
const cleanScan = ({ googleDiscovery, baselines, hours, hoursWork, profiles, profileWork, backlinks, work, ...scan }) => transientErrors.has(scan.id) ? { ...scan, status: 'failed', error: transientErrors.get(scan.id) } : scan;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- Worker transport ---------- */

/** Calls in flight across every audit in this tab; the worker's rate limit is per visitor. */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting = [];
const acquire = () => inFlight < MAX_IN_FLIGHT ? (inFlight++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve));
const release = () => { const next = waiting.shift(); if (next) next(); else inFlight--; };
/** Backoff between attempts; tests shorten it through `SIGNAL404_RETRY_DELAYS`. */
const retryDelays = () => globalThis.SIGNAL404_RETRY_DELAYS || [1_500, 4_000, 10_000];

class RemoteError extends Error {
  constructor(message, retryable, retryAfterMs = 0) { super(message); this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}
function describeFailure(status, body) {
  if (body?.error) return body.error;
  if (status === 429) return 'The online worker is busy (rate limit reached)';
  if (status === 502 || status === 504) return `The online worker timed out or restarted (HTTP ${status})`;
  return `The online worker is unavailable (HTTP ${status})`;
}
/**
 * One worker step. Busy, timed-out and restarted workers are retried with backoff; a refused
 * request (HTTP 400) is not, because sending it again cannot change the answer.
 */
async function remote(payload) {
  for (let attempt = 0; ; attempt++) {
    let failure;
    await acquire();
    try {
      const response = await fetch('/api/worker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(59_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body) return body;
      const retryAfter = Number(response.headers.get('retry-after')) * 1000 || 0;
      failure = new RemoteError(describeFailure(response.status, body), body?.retryable ?? (response.status === 429 || response.status >= 500), retryAfter);
    } catch (error) {
      failure = new RemoteError(error?.name === 'TimeoutError' ? 'An online step took longer than a minute' : 'The connection to the online worker dropped', true);
    } finally { release(); }
    const delays = retryDelays();
    if (!failure.retryable || attempt >= delays.length) throw failure;
    await sleep(Math.max(failure.retryAfterMs, delays[attempt]) * (0.8 + Math.random() * 0.4));
  }
}

/* ---------- Storage ---------- */

async function persist(scan, additions = []) {
  await transaction(['scans', 'urls'], 'readwrite', async (tx) => {
    const store = tx.objectStore('urls');
    const latest = await result(tx.objectStore('scans').get(scan.id));
    if (latest?.cancelRequested) scan.cancelRequested = true;
    for (const addition of additions) {
      const key = [scan.id, addition.normalizedUrl], old = await result(store.get(key));
      const row = old || { ...addition, scanId: scan.id, status: 'pending', result: null, sources: [] };
      for (const source of addition.sources) if (!row.sources.some((s) => JSON.stringify(s) === JSON.stringify(source))) row.sources.push(source);
      if (row.result) row.result.sources = row.sources;
      if (!old) scan.total++;
      store.put(row);
    }
    tx.objectStore('scans').put(scan);
  });
}
async function checkCancelled(scan) { const current = await get('scans', scan.id); scan.cancelRequested = Boolean(current?.cancelRequested); return scan.cancelRequested; }
/** Plain-language progress for the dashboard; saved with the audit so a reopened tab shows it too. */
const say = (scan, message) => { scan.message = message; };

/* ---------- The audit ---------- */

async function run(scanId) {
  if (locks.has(scanId)) return;
  locks.add(scanId);
  try {
    await navigator.locks.request(`signal404-${scanId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const scan = await get('scans', scanId);
      // What this run could not finish; each gap makes the result partial instead of failing it.
      const gaps = { pages: 0, pageError: '', hours: 0, profiles: 0 };
      try {
        scan.startedAt ||= now(); scan.error = null; scan.completedAt = null;
        await discoverWebsite(scan);
        if (await checkCancelled(scan)) throw new CancelledRun();
        await discoverGoogle(scan);
        if (await checkCancelled(scan)) throw new CancelledRun();
        await checkAll(scan, gaps);
        if (scan.options.checkHours && !await checkCancelled(scan)) await compareHours(scan, gaps);
        if (scan.options.checkProfile && !await checkCancelled(scan)) await compareProfiles(scan, gaps);
        if (gaps.pages) scan.warnings.push(`${gaps.pages} ${gaps.pages === 1 ? 'page' : 'pages'} could not be checked online${gaps.pageError ? ` (${gaps.pageError})` : ''}. Resume the audit to retry ${gaps.pages === 1 ? 'it' : 'them'}.`);
        const incomplete = gaps.pages || gaps.hours || gaps.profiles || scan.googleDiscovery.some((s) => s.status !== 'exhausted') || [...liveReports(scan)].some((report) => report.status !== 'completed');
        scan.status = await checkCancelled(scan) ? 'cancelled' : incomplete ? (scan.total || scan.options.checkProfile || scan.options.checkHours ? 'completed_partial' : 'failed') : 'completed';
        if (scan.status === 'failed') scan.error = 'Google discovery failed. Resolve the provider issue and resume; no clean-site verdict is available.';
        say(scan, null); scan.completedAt = now(); await persist(scan);
      } catch (error) {
        if (error instanceof CancelledRun) { scan.status = 'cancelled'; say(scan, null); scan.completedAt = now(); await persist(scan).catch(() => {}); return; }
        scan.status = 'failed'; scan.error = error.message; say(scan, null); scan.completedAt = now(); try { await persist(scan); } catch (storageError) { transientErrors.set(scan.id, storageError.message); } }
    });
  } finally { locks.delete(scanId); }
}

async function discoverGoogle(scan) {
  for (const state of scan.googleDiscovery) {
    if (state.status === 'exhausted' || state.status === 'limited') continue;
    scan.status = 'discovering'; state.status = 'running'; state.error = undefined;
    say(scan, `Reading Google results for ${host(state.site)}`); await persist(scan);
    while (state.pagesFetched < scan.options.googleMaxPages && !await checkCancelled(scan)) {
      const query = state.queries.filter((q) => !q.done).sort((a, b) => a.nextPage - b.nextPage)[0];
      if (!query) break;
      let page;
      try { page = await remote({ action: 'google', site: state.site, query: query.query, page: query.nextPage, country: state.country, language: state.language }); }
      catch (error) { state.status = 'failed'; state.error = error.message; scan.warnings.push(`Google discovery incomplete: ${error.message}`); await persist(scan); break; }
      const observedAt = now();
      const additions = page.results.flatMap((item) => {
        let url; try { url = normalize(item.url); if (host(url) !== host(state.site)) return []; } catch { return []; }
        return [{ inputUrl: url, normalizedUrl: url, site: new URL(url).origin, sources: [{ source: page.provider || 'searchapi', provider: page.provider || 'searchapi', query: query.query, resultPage: query.nextPage, position: item.position, title: item.title, snippet: item.snippet, resultKind: item.kind, searchUrl: page.searchUrl, country: state.country, language: state.language, observedAt }] }];
      });
      const fingerprint = [...new Set(page.results.map((r) => r.url))].sort().join('\n');
      query.done = !page.hasNext || !page.results.length || query.fingerprints.includes(fingerprint);
      if (page.warnings?.length) { state.status = 'failed'; state.error = page.warnings.join('; '); scan.warnings.push(state.error); }
      else { query.fingerprints.push(fingerprint); query.nextPage++; }
      state.pagesFetched++; state.updatedAt = now(); state.providersUsed = [...new Set([...(state.providersUsed || []), page.provider || 'searchapi'])];
      say(scan, `Reading Google results for ${host(state.site)} · ${state.pagesFetched} pages read`);
      await persist(scan, additions);
      if (state.status === 'failed') break;
    }
    if (await checkCancelled(scan)) return;
    if (state.status !== 'failed') { state.status = state.queries.every((q) => q.done) ? 'exhausted' : 'limited'; if (state.status === 'limited') scan.warnings.push(`Google reached its ${scan.options.googleMaxPages}-page budget for ${state.site}. Coverage is partial.`); }
    state.updatedAt = now(); await persist(scan);
  }
}

/**
 * Verifies every pending URL, a batch per worker call, grouped by website so each batch shares
 * one missing-page baseline. A batch that fails after retries leaves its pages pending: the audit
 * finishes as partial and Resume picks them up, instead of the whole audit failing.
 */
async function checkAll(scan, gaps) {
  const pending = (await candidates(scan.id)).filter((candidate) => !candidate.result);
  if (!pending.length) return;
  scan.status = 'scanning'; say(scan, `Checking ${pending.length} ${pending.length === 1 ? 'page' : 'pages'}`); await persist(scan);
  const byOrigin = new Map();
  for (const candidate of pending) { const origin = new URL(candidate.normalizedUrl).origin; byOrigin.set(origin, [...(byOrigin.get(origin) || []), candidate]); }
  const batches = [...byOrigin.values()].flatMap((rows) => Array.from({ length: Math.ceil(rows.length / CHECK_BATCH) }, (_, index) => rows.slice(index * CHECK_BATCH, (index + 1) * CHECK_BATCH)));
  const skips = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallelism(scan), batches.length)) }, async () => {
    // The cursor only advances onto a real batch, so a batch requeued after another worker
    // finished is still picked up by whoever is left.
    while (next < batches.length) {
      const batch = batches[next++];
      if (await checkCancelled(scan)) return;
      const origins = [...new Set(batch.map((candidate) => new URL(candidate.normalizedUrl).origin))];
      let reply;
      try { reply = await remote({ action: 'check', urls: batch.map((candidate) => candidate.normalizedUrl), baselines: Object.fromEntries(origins.flatMap((origin) => scan.baselines[origin] ? [[origin, scan.baselines[origin]]] : [])) }); }
      catch (error) { gaps.pages += batch.length; gaps.pageError = error.message; continue; }
      for (const [origin, state] of Object.entries(reply.baselines || {})) if (state?.baselineChecked && !scan.baselines[origin]?.baselineChecked) scan.baselines[origin] = state;
      const done = [];
      for (const { url, result: checked } of reply.results || []) {
        const candidate = batch.find((item) => item.normalizedUrl === url); if (!candidate || candidate.result) continue;
        candidate.result = { ...checked, inputUrl: candidate.inputUrl, sources: candidate.sources }; candidate.status = 'complete';
        scan.processed++; if (actionable(candidate.result.classification)) scan.findings++;
        done.push(candidate);
      }
      // Pages the worker had no time for go to the back of the queue, a limited number of times.
      const retry = batch.filter((candidate) => (reply.skipped || []).includes(candidate.normalizedUrl));
      for (const candidate of retry) skips.set(candidate.normalizedUrl, (skips.get(candidate.normalizedUrl) || 0) + 1);
      const again = retry.filter((candidate) => skips.get(candidate.normalizedUrl) <= MAX_SKIPS);
      if (again.length) batches.push(again);
      gaps.pages += retry.length - again.length;
      if (retry.length > again.length) gaps.pageError ||= 'the pages took too long to load';
      say(scan, `Checking pages · ${scan.processed.toLocaleString()} of ${scan.total.toLocaleString()} done`);
      await transaction(['scans', 'urls'], 'readwrite', async (tx) => { const latest = await result(tx.objectStore('scans').get(scan.id)); if (latest?.cancelRequested) scan.cancelRequested = true; for (const candidate of done) tx.objectStore('urls').put(candidate); tx.objectStore('scans').put(scan); });
    }
  }));
}

/** Restaurant identity hints: branch details typed in the form, then every imported row of the site. */
function placeHints(all, site, targets = []) {
  const hints = {};
  for (const target of targets) {
    try { if (host(target.url) !== host(site)) continue; } catch { continue; }
    hints.name ||= target.name; hints.address ||= target.address; hints.placeId ||= target.placeId;
  }
  for (const candidate of all) {
    if (host(candidate.site) !== host(site)) continue;
    for (const source of candidate.sources) {
      hints.name ||= source.restaurantName; hints.address ||= source.restaurantAddress; hints.placeId ||= source.placeId;
    }
  }
  return hints;
}

const notChecked = (site, reason) => ({ site, siteKey: host(site), status: 'not_checked', matchConfidence: 'none', placeId: null, placeName: null, placeAddress: null, placeWebsite: null, businessStatus: null, utcOffsetMinutes: null, websiteMethod: 'none', websiteHoursUrl: null, pagesInspected: 0, days: [], maxDeltaMinutes: null, notes: [reason], checkedAt: now() });

/** Website hours against the Google listing, one restaurant at a time; a failure is that restaurant's result. */
async function compareHours(scan, gaps) {
  scan.status = 'comparing_hours'; await persist(scan);
  const all = await candidates(scan.id);
  const sites = scan.options.sites.length ? scan.options.sites : [...new Set(all.map((c) => c.site))];
  for (const [index, site] of sites.entries()) {
    if (await checkCancelled(scan)) return;
    // A restaurant that could not be checked last time is tried again on Resume.
    if (scan.hours.some((h) => host(h.site) === host(site) && h.status !== 'not_checked')) continue;
    say(scan, `Reading opening hours · ${host(site)} (${index + 1} of ${sites.length})`); await persist(scan);
    const work = scan.hoursWork[site] ||= { pages: [], pageErrors: [], completed: [] };
    let record;
    try {
      const limit = scan.options.hoursPageLimit || 5;
      let ranked = selectHoursPages(site, all, limit);
      // Nothing discovered beyond the homepage (an hours-only audit): rank the homepage's links.
      if (ranked.length < 2 && limit > 1 && !work.completed.length) {
        const home = await remote({ action: 'crawl-page', site, url: normalize(site) }).catch(() => ({ links: [] }));
        ranked = selectHoursPages(site, [...all, ...linkCandidates(site, home.links || [])], limit);
      }
      let items = ranked.filter((url) => !work.completed.includes(url)).map((url, rank, list) => ({ url, score: list.length - rank }));
      for (let round = 0; items.length && round <= MAX_SKIPS; round++) {
        const reply = await remote({ action: 'hours-pages', items });
        work.pages.push(...reply.pages); work.pageErrors.push(...reply.errors);
        work.completed.push(...items.map((item) => item.url).filter((url) => !reply.skipped.includes(url)));
        items = items.filter((item) => reply.skipped.includes(item.url));
        await persist(scan);
      }
      for (const item of items) work.pageErrors.push(`${item.url}: the page took too long to load online`);
      record = await remote({ action: 'hours-compare', site, pages: work.pages, pageErrors: work.pageErrors, hints: placeHints(all, site, scan.options.profileTargets), toleranceMinutes: scan.options.hoursToleranceMinutes || 15, requireVerifiedPlace: scan.options.hoursRequireVerifiedPlace, country: scan.options.googleCountry });
    } catch (error) { record = notChecked(site, `Not checked: ${error.message}. Resume the audit to retry.`); }
    if (record.status === 'not_checked') gaps.hours++;
    scan.hours = [...scan.hours.filter((h) => host(h.site) !== host(site)), record];
    await persist(scan);
  }
}

class CancelledRun extends Error {}
const parallelism = (scan) => Math.min(4, Math.max(1, Number(scan.options.concurrency) || 3));
const addSources = async (scan, found) => {
  const additions = found.flatMap(({ url, evidence }) => { try { const normalizedUrl = normalize(url); return [{ inputUrl: url, normalizedUrl, site: new URL(normalizedUrl).origin, sources: [evidence] }]; } catch { return []; } });
  for (let offset = 0; offset < additions.length; offset += 500) await persist(scan, additions.slice(offset, offset + 500));
};

/** Sitemaps, backlinks and a rendered crawl, each resumable per site. */
async function discoverWebsite(scan) {
  const sources = scan.options.discovery;
  if (!sources.some((s) => ['sitemap', 'crawl', 'backlinks'].includes(s))) return;
  scan.work ||= { sitemap: {}, backlinks: {}, crawl: {} };
  scan.status = 'discovering'; await persist(scan);
  for (const site of scan.options.sites) {
    if (sources.includes('sitemap') && !scan.work.sitemap[site]) {
      say(scan, `Reading the sitemap of ${host(site)}`); await persist(scan);
      try { const found = await remote({ action: 'sitemap', site }); await addSources(scan, found.urls); scan.warnings.push(...found.warnings.map((w) => `sitemap ${w}`)); }
      catch (error) { scan.warnings.push(`sitemap ${site}: ${error.message}`); }
      scan.work.sitemap[site] = true; await persist(scan);
    }
    if (await checkCancelled(scan)) return;
    if (sources.includes('backlinks') && !scan.work.backlinks[site]) {
      say(scan, `Collecting backlinks for ${host(site)}`); await persist(scan);
      try {
        const found = await remote({ action: 'backlinks', site, limit: scan.options.backlinkLimit });
        scan.backlinks = [...(scan.backlinks || []), ...found.backlinks]; await addSources(scan, found.candidates);
        scan.warnings.push(`${found.coverageNote} Provider cost: $${Number(found.costUsd || 0).toFixed(5)}.`);
      } catch (error) { scan.warnings.push(`backlinks ${site}: ${error.message}`); }
      scan.work.backlinks[site] = true; await persist(scan);
    }
    if (await checkCancelled(scan)) return;
    if (sources.includes('crawl')) {
      const work = scan.work.crawl[site] ||= { queue: [normalize(site)], seen: [], failures: 0 };
      let active = 0;
      // A small pool of page renders; the queue and the seen list are saved after every page.
      await Promise.all(Array.from({ length: parallelism(scan) }, async () => {
        for (;;) {
          if (await checkCancelled(scan) || work.seen.length >= scan.options.crawlLimit) return;
          const url = work.queue.shift();
          if (!url) { if (!active) return; await sleep(200); continue; }
          if (work.seen.includes(url)) continue;
          work.seen.push(url); active++;
          try {
            const page = await remote({ action: 'crawl-page', site, url });
            const fresh = page.links.filter((link) => !work.seen.includes(link) && !work.queue.includes(link));
            work.queue.push(...fresh);
            await addSources(scan, [url, ...fresh].map((link) => ({ url: link, evidence: { source: 'crawl', discoveredFrom: url } })));
          } catch (error) { if (++work.failures <= 20) scan.warnings.push(`crawl ${url}: ${error.message}`); }
          finally { active--; say(scan, `Crawling ${host(site)} · ${work.seen.length} pages read`); await persist(scan); }
        }
      }));
      if (work.queue.some((url) => !work.seen.includes(url))) scan.warnings.push(`crawl ${site}: stopped at the online cap of ${scan.options.crawlLimit} pages. Raise it (up to 500) or use the desktop version for larger sites.`);
    }
  }
}

function liveReports(scan) {
  return (scan.profiles || []).map((stored) => liveProfiles.get(`${scan.id}|${stored.targetKey}`) || stored);
}

/** Restaurants to compare: identity hints first, then every website and exact URL, once each. */
async function profileTargets(scan) {
  const targets = [...(scan.options.profileTargets || [])];
  for (const url of [...scan.options.sites, ...scan.options.urls]) targets.push({ url });
  for (const file of scan.options.inputFiles) { const upload = await get('uploads', file); for (const row of upload?.rows || []) targets.push({ url: row.url, name: row.name, address: row.address, placeId: row.placeId }); }
  const unique = new Map();
  for (const target of targets) { let url; try { url = normalize(target.url); } catch { continue; } unique.set(url, { ...unique.get(url), ...Object.fromEntries(Object.entries(target).filter(([, v]) => v)), url }); }
  return [...unique.values()];
}

const timedOutLink = (link) => ({ ...link, finalUrl: link.url, httpStatus: null, redirectChain: [], health: 'timeout', serviceReady: null, correctBranch: null, transactionTested: false, reason: 'The destination took too long to load online. Open it yourself, or resume the audit to try again.', checkedAt: now() });

/**
 * The desktop profile audit, a few short worker steps at a time: website pages, then the Google
 * side (listing plus Maps buttons, merged and resolved server-side), then the links, then the
 * report. A restaurant that fails is noted and skipped; the others still complete.
 */
async function compareProfiles(scan, gaps) {
  scan.profileWork ||= {}; scan.profiles ||= [];
  scan.status = 'comparing_profile'; await persist(scan);
  const discovered = (await candidates(scan.id)).map((candidate) => candidate.normalizedUrl);
  const targets = await profileTargets(scan);
  for (const [position, target] of targets.entries()) {
    if (await checkCancelled(scan)) return;
    let work = scan.profileWork[target.url];
    // Google values are never stored, so a finished restaurant whose live report is gone (the tab
    // was reloaded) is compared again rather than left showing the redacted copy.
    if (work?.done && (!work.targetKey || liveProfiles.has(`${scan.id}|${work.targetKey}`))) continue;
    if (!work || work.done) work = scan.profileWork[target.url] = { startedAt: now(), queue: [{ url: target.url, depth: 0 }, ...discovered.filter((url) => host(url) === host(target.url) && SERVICE_PATH.test(url)).map((url) => ({ url, depth: 1 }))], seen: [], retries: {}, pages: [], warnings: [], incomplete: false, links: [] };
    work.retries ||= {};
    const label = `${host(target.url)} (${position + 1} of ${targets.length})`;
    try {
      while (work.queue.length && work.seen.length < scan.options.profilePageLimit) {
        if (await checkCancelled(scan)) return;
        // The landing page goes alone: it fixes the host every later link is filtered against.
        const items = [];
        while (work.queue.length && items.length < (work.pages.length ? 3 : 1) && work.seen.length + items.length < scan.options.profilePageLimit) {
          const item = work.queue.shift(), key = item.url.replace(/#.*$/, '');
          if (!work.seen.includes(key) && !items.some((other) => other.url.replace(/#.*$/, '') === key)) items.push(item);
        }
        if (!items.length) continue;
        say(scan, `Reading the website of ${label}`); await persist(scan);
        let reply;
        try { reply = await remote({ action: 'profile-pages', target, items, landing: work.pages[0]?.finalUrl }); }
        catch (error) { reply = { pages: items.map((item) => ({ url: item.url, error: error.message })) }; }
        for (const [index, page] of reply.pages.entries()) {
          const item = items[index], key = item.url.replace(/#.*$/, '');
          if (page.retry && (work.retries[key] = (work.retries[key] || 0) + 1) <= MAX_SKIPS) { work.queue.unshift(item); continue; }
          // Only a page that was actually answered counts as seen; a failure is recorded as such.
          work.seen.push(key);
          if (page.retry || page.error) { work.incomplete = true; work.warnings.push(`Could not inspect ${item.url}: ${page.error || 'the page took too long to load online'}`); }
          else { work.pages.push({ url: page.url, finalUrl: page.finalUrl, snapshot: page.snapshot }); work.queue.push(...page.next.filter((next) => !work.seen.includes(next.url.replace(/#.*$/, '')))); }
        }
        await persist(scan);
      }
      if (work.queue.some((item) => !work.seen.includes(item.url.replace(/#.*$/, '')))) { work.incomplete = true; if (!work.warnings.includes('Website discovery page budget reached')) work.warnings.push('Website discovery page budget reached'); }
      if (!work.side) {
        say(scan, `Reading the Google listing of ${label}`); await persist(scan);
        const google = await remote({ action: 'profile-google', target, pages: work.pages, warnings: work.warnings, incomplete: work.incomplete, country: scan.options.googleCountry, tolerance: scan.options.profileHoursTolerance });
        Object.assign(work, { website: google.website, side: google.side, destinations: google.destinations }); await persist(scan);
      }
      // Link checks only need the identity facts, not every fact on the website.
      const slim = { ...work.website, pages: [], links: [], facts: work.website.facts.filter((item) => ['name', 'address', 'phone'].includes(item.field)) };
      for (let round = 0; round <= MAX_SKIPS; round++) {
        const open = work.destinations.map((link, index) => ({ link, index })).filter(({ index }) => !work.links[index]);
        if (!open.length) break;
        say(scan, `Checking menu, booking and ordering links of ${label}`); await persist(scan);
        const batches = Array.from({ length: Math.ceil(open.length / LINK_BATCH) }, (_, index) => open.slice(index * LINK_BATCH, (index + 1) * LINK_BATCH));
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(parallelism(scan), batches.length) }, async () => {
          for (let batch = batches[next++]; batch; batch = batches[next++]) {
            if (await checkCancelled(scan)) return;
            const reply = await remote({ action: 'profile-links', target, links: batch.map(({ link }) => link), website: slim });
            reply.checks.forEach((check, index) => { if (!check.retry) work.links[batch[index].index] = check; });
            await persist(scan);
          }
        }));
        if (await checkCancelled(scan)) return;
      }
      work.destinations.forEach((link, index) => { work.links[index] ||= timedOutLink(link); });
      say(scan, `Writing the profile report of ${label}`);
      const { report, durable } = await remote({ action: 'profile-report', auditId: scan.id, target, startedAt: work.startedAt, website: work.website, side: work.side, links: work.links.filter(Boolean), country: scan.options.googleCountry, tolerance: scan.options.profileHoursTolerance });
      liveProfiles.set(`${scan.id}|${report.targetKey}`, report);
      scan.profiles = [...(scan.profiles || []).filter((item) => item.targetKey !== durable.targetKey), durable];
      // Google values stay in memory only; the saved work keeps nothing but the completion mark.
      scan.profileWork[target.url] = { done: true, targetKey: report.targetKey };
    } catch (error) {
      gaps.profiles++;
      scan.warnings.push(`Business profile for ${host(target.url)} is incomplete: ${error.message}. Its progress is saved; resume the audit to continue it.`);
    }
    await persist(scan);
  }
}

const ready = (async () => {
  if (!navigator.locks) throw new Error('This browser does not support safe audit locking. Use a current browser to run hosted audits.');
  for (const scan of await scans()) {
    if (ACTIVE.includes(scan.status)) await navigator.locks.request(`signal404-${scan.id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const current = await get('scans', scan.id); if (!ACTIVE.includes(current.status)) return;
      current.status = 'cancelled'; current.cancelRequested = false; current.error = null; current.message = null;
      current.warnings.push('The previous browser session ended. Resume to continue from saved progress.'); await put('scans', current);
    });
  }
})();

export async function hostedRequest(path, options = {}) {
  await ready;
  const url = new URL(path, location.origin);
  if (url.pathname === '/api/providers/status') return remote({ action: 'providers' });
  if (url.pathname === '/api/auth/google/status') return { configured: false, authenticated: false };
  if (url.pathname === '/api/uploads') {
    const { readUpload } = await import('./hosted-exports.js');
    const rows = await readUpload(options.body, url.searchParams.get('filename'));
    const id = crypto.randomUUID(); await put('uploads', { id, rows }); return { path: id };
  }
  if (url.pathname === '/api/scans' && options.method !== 'POST') return { scans: (await scans()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(cleanScan) };
  if (url.pathname === '/api/scans') {
    const supplied = JSON.parse(options.body), id = crypto.randomUUID();
    if (supplied.checkProfile && supplied.profileMode && supplied.profileMode !== 'public') throw new Error('Online, the profile comparison reads the public Google listing. "Business Profile you manage" and "Profile details you supply" need the desktop version.');
    const opts = { sites: [], urls: [], inputFiles: [], discovery: ['google'], googleProvider: 'searchapi', googleCountry: 'gb', googleLanguage: 'en', googleMaxPages: 50, hoursPageLimit: 5, profileTargets: [], ...supplied };
    if (opts.discovery.some((s) => !HOSTED_SOURCES.includes(s))) throw new Error('Search Console discovery needs the desktop version, which can store your Google sign-in. Every other source runs online.');
    // Each page is its own serverless call, so online limits are tighter than on desktop.
    opts.concurrency = Math.min(4, Math.max(1, Number(opts.concurrency) || 3));
    opts.crawlLimit = Math.min(500, Math.max(1, Number(opts.crawlLimit) || 200));
    opts.backlinkLimit = Math.min(2_000, Math.max(1, Number(opts.backlinkLimit) || 1_000));
    opts.profilePageLimit = Math.min(12, Math.max(1, Number(opts.profilePageLimit) || 8));
    // One worker step reads at most six hours pages.
    opts.hoursPageLimit = Math.min(6, Math.max(1, Number(opts.hoursPageLimit) || 5));
    opts.profileMode = 'public';
    if (opts.googleProvider === 'browser' || opts.inspectGoogle) throw new Error('Local Google browser and Search Console inspection are available in the desktop version. Choose an API provider for hosted discovery.');
    if (!Number.isInteger(opts.googleMaxPages) || opts.googleMaxPages < 1 || opts.googleMaxPages > 100) throw new Error('Use a Google page budget between 1 and 100 online.');
    opts.sites = [...new Set(opts.sites.map((s) => new URL(normalize(s)).origin))]; opts.urls = opts.urls.map(normalize);
    const scan = { id, options: opts, status: 'queued', message: null, createdAt: now(), startedAt: null, completedAt: null, total: 0, processed: 0, findings: 0, error: null, cancelRequested: false, warnings: [], outputDir: 'Browser storage', baselines: {}, hours: [], hoursWork: {}, profiles: [], profileWork: {}, backlinks: [], work: { sitemap: {}, backlinks: {}, crawl: {} }, googleDiscovery: opts.discovery.some((s) => GOOGLE_SOURCES.includes(s)) ? opts.sites.map((site) => ({ site, provider: 'searchapi', country: opts.googleCountry, language: opts.googleLanguage, pagesFetched: 0, status: 'running', updatedAt: now(), queries: queryList(site).map((query) => ({ query, nextPage: 1, done: false, fingerprints: [] })) })) : [] };
    const imported = opts.urls.map((url) => ({ url })); for (const file of opts.inputFiles) { const upload = await get('uploads', file); if (!upload) throw new Error('The selected import is no longer available. Choose the file again.'); imported.push(...upload.rows); }
    const rows = imported.map((row) => { const normalizedUrl = normalize(row.url); return { inputUrl: row.url, normalizedUrl, site: new URL(normalizedUrl).origin, sources: [{ source: 'import', restaurantName: row.name, restaurantAddress: row.address, placeId: row.placeId }] }; });
    if (!rows.length && !opts.sites.length) throw new Error('Add a website or at least one exact URL.');
    const comparing = opts.checkProfile || opts.checkHours;
    if (!rows.length && !scan.googleDiscovery.length && !opts.discovery.some((s) => ['sitemap', 'crawl', 'backlinks'].includes(s)) && !comparing) throw new Error('Add exact URLs for an import audit, or choose a discovery source for website targets.');
    // Website targets are pages too, unless the audit is Google-only (as on desktop).
    if (!opts.discovery.every((s) => GOOGLE_SOURCES.includes(s))) for (const site of opts.sites) if (!rows.some((row) => row.normalizedUrl === normalize(site))) rows.push({ inputUrl: site, normalizedUrl: normalize(site), site, sources: [{ source: 'import' }] });
    await persist(scan);
    for (let offset = 0; offset < rows.length; offset += 500) await persist(scan, rows.slice(offset, offset + 500));
    void navigator.storage?.persist?.().catch(() => {});
    void run(id); return cleanScan(scan);
  }
  const match = url.pathname.match(/^\/api\/scans\/([^/]+)(?:\/(.*))?$/);
  if (!match) throw new Error('This feature is unavailable in the hosted version.');
  const [, id, action] = match, scan = await get('scans', id);
  if (!scan) throw new Error('This audit is not stored in this browser.');
  if (action === 'cancel') { await updateScan(id, { cancelRequested: true }); return { ok: true }; }
  if (action === 'resume') {
    await navigator.locks.request(`signal404-command-${id}`, async () => {
      const state = await navigator.locks.query();
      if ([...state.held, ...state.pending].some((lock) => lock.name === `signal404-${id}`)) return;
      const latest = await get('scans', id);
      if (latest.status === 'completed' && !latest.options.checkProfile) return;
      // Google values are never stored, so a finished profile comparison is refreshed from scratch.
      // Only a fully completed audit is refreshed from scratch; a partial one keeps the saved
      // progress of restaurants that failed, and compareProfiles re-reads finished ones whose
      // live Google values are gone.
      const refresh = latest.options.checkProfile && latest.status === 'completed' ? { profileWork: {} } : {};
      await updateScan(id, { cancelRequested: false, status: 'queued', error: null, ...refresh }); transientErrors.delete(id); void run(id);
    });
    return { ok: true };
  }
  const all = await candidates(id);
  if (action === 'profiles') return { schemaVersion: '1.0', reports: [...liveReports(scan)] };
  if (action === 'results') {
    const search = (url.searchParams.get('search') || '').toLowerCase(), classification = url.searchParams.get('classification');
    const matches = (r) => !search || [r.normalizedUrl, r.result.title, r.result.h1, ...r.result.reasons].some((text) => String(text || '').toLowerCase().includes(search));
    const rank = (r) => SEVERITY.indexOf(r.result.classification);
    const rows = all.filter((r) => r.result && (!classification || classification === 'all' || (classification === 'problems' ? actionable(r.result.classification) : r.result.classification === classification)) && matches(r)).sort((a, b) => rank(a) - rank(b) || a.normalizedUrl.localeCompare(b.normalizedUrl));
    const offset = Number(url.searchParams.get('offset')) || 0, limit = Number(url.searchParams.get('limit')) || 25;
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, all.filter((r) => r.result?.classification === c).length]));
  const sourceCounts = {}; for (const row of all) for (const source of new Set(row.sources.map((s) => s.source))) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  const hoursCounts = {}; for (const row of scan.hours) hoursCounts[row.status] = (hoursCounts[row.status] || 0) + 1;
  return { scan: cleanScan(scan), counts, sourceCounts, hoursCounts, hours: scan.hours, googleDiscovery: scan.googleDiscovery, backlinkCount: scan.backlinks?.length || 0, profiles: [...liveReports(scan)], artifacts: !ACTIVE.includes(scan.status) ? ['report.xlsx', 'all-urls.csv', 'findings.csv', 'run.json', ...(scan.options.checkHours ? ['hours.csv'] : []), ...(scan.backlinks?.length ? ['backlinks.csv'] : []), ...(scan.profiles?.length ? ['profile-audit.json'] : [])] : [] };
}

export async function download(scanId, name) {
  const scan = await get('scans', scanId), rows = await candidates(scanId);
  const { exportFile } = await import('./hosted-exports.js');
  await exportFile(scan, rows, name);
}
