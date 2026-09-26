import { normalizeUrl } from '../urls.ts';
const ACTIVE = ['queued', 'discovering', 'scanning', 'comparing_hours', 'comparing_profile', 'reporting'];
/** Sources that run online. Search Console needs a stored OAuth token, so it stays desktop-only. */
const HOSTED_SOURCES = ['import', 'google', 'serper', 'searchapi', 'sitemap', 'crawl', 'backlinks'];
const GOOGLE_SOURCES = ['google', 'serper', 'searchapi'];
/** Live profile reports hold Google values; they live for this page session only, as on desktop. */
const liveProfiles = new Map();
const SERVICE_PATH = /contact|hours|menu|reserv|book|order/i;
const CLASSIFICATIONS = ['hard_404', 'gone_410', 'soft_404_suspected', 'redirected', 'ok', 'server_error', 'blocked', 'timeout', 'network_error'];
const actionable = (value) => ['hard_404', 'gone_410', 'soft_404_suspected'].includes(value);
const now = () => new Date().toISOString();
const locks = new Set();
const transientErrors = new Map();
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
async function remote(payload) {
  const response = await fetch('/api/worker', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(58_000) });
  const body = await response.json().catch(() => ({ error: `Hosted worker unavailable (HTTP ${response.status}). Retry to resume saved work.` }));
  if (!response.ok) throw new Error(body.error || `Hosted worker failed (HTTP ${response.status})`);
  return body;
}
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
async function run(scanId) {
  if (locks.has(scanId)) return;
  locks.add(scanId);
  try {
    await navigator.locks.request(`signal404-${scanId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const scan = await get('scans', scanId);
      try {
        scan.startedAt ||= now(); scan.error = null; scan.completedAt = null;
        await discoverWebsite(scan);
        if (await checkCancelled(scan)) throw new CancelledRun();
        for (const state of scan.googleDiscovery) {
          if (state.status === 'exhausted' || state.status === 'limited') continue;
          scan.status = 'discovering'; state.status = 'running'; state.error = undefined; await persist(scan);
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
            await persist(scan, additions);
            if (state.status === 'failed') break;
          }
          if (await checkCancelled(scan)) break;
          if (state.status !== 'failed') { state.status = state.queries.every((q) => q.done) ? 'exhausted' : 'limited'; if (state.status === 'limited') scan.warnings.push(`Google reached its ${scan.options.googleMaxPages}-page budget for ${state.site}. Coverage is partial.`); }
          state.updatedAt = now(); await persist(scan);
        }
        scan.status = 'scanning'; await persist(scan);
        // Several pages are checked at once (each is its own worker call); counters live on the one
        // in-memory scan object, so the parallel workers never race each other's totals.
        const pending = (await candidates(scan.id)).filter((candidate) => !candidate.result);
        let nextCandidate = 0;
        await Promise.all(Array.from({ length: Math.max(1, Math.min(parallelism(scan), pending.length)) }, async () => {
          for (let candidate = pending[nextCandidate++]; candidate; candidate = pending[nextCandidate++]) {
            if (await checkCancelled(scan)) return;
            const origin = new URL(candidate.normalizedUrl).origin;
            const checked = await remote({ action: 'check', url: candidate.normalizedUrl, ...scan.baselines[origin] });
            if (!scan.baselines[origin]?.baselineChecked) scan.baselines[origin] = { baseline: checked.baseline, baselineChecked: checked.baselineChecked };
            candidate.result = { ...checked.result, inputUrl: candidate.inputUrl, sources: candidate.sources }; candidate.status = 'complete';
            scan.processed++; if (actionable(candidate.result.classification)) scan.findings++;
            await transaction(['scans', 'urls'], 'readwrite', async (tx) => { const latest = await result(tx.objectStore('scans').get(scan.id)); if (latest?.cancelRequested) scan.cancelRequested = true; tx.objectStore('urls').put(candidate); tx.objectStore('scans').put(scan); });
          }
        }));
        if (scan.options.checkHours && !await checkCancelled(scan)) {
          scan.status = 'comparing_hours'; await persist(scan);
          const all = await candidates(scan.id);
          for (const site of scan.options.sites.length ? scan.options.sites : [...new Set(all.map((c) => c.site))]) {
            if (await checkCancelled(scan)) break;
            if (scan.hours.some((h) => host(h.site) === host(site))) continue;
            const work = scan.hoursWork[site] ||= { pages: [], pageErrors: [], completed: [] };
            const urls = [...new Set([site, ...all.filter((c) => host(c.site) === host(site) && /hour|contact|about|visit/i.test(c.normalizedUrl)).map((c) => c.normalizedUrl)])].slice(0, scan.options.hoursPageLimit || 5);
            for (const [index, url] of urls.entries()) {
              if (work.completed.includes(url)) continue;
              if (await checkCancelled(scan)) break;
              const page = await remote({ action: 'hours-page', url, score: urls.length - index });
              if (page.extraction) work.pages.push(page.extraction); else work.pageErrors.push(`${url}: ${page.error}`);
              work.completed.push(url); await persist(scan);
            }
            if (await checkCancelled(scan)) break;
            const source = all.find((c) => host(c.site) === host(site))?.sources.find((s) => s.restaurantName || s.placeId) || {};
            const record = await remote({ action: 'hours-compare', site, pages: work.pages, pageErrors: work.pageErrors, hints: { name: source.restaurantName, address: source.restaurantAddress, placeId: source.placeId }, toleranceMinutes: scan.options.hoursToleranceMinutes || 15, requireVerifiedPlace: scan.options.hoursRequireVerifiedPlace });
            scan.hours.push(record); await persist(scan);
          }
        }
        if (scan.options.checkProfile && !await checkCancelled(scan)) await compareProfiles(scan);
        const incomplete = scan.googleDiscovery.some((s) => s.status !== 'exhausted') || [...liveReports(scan)].some((report) => report.status !== 'completed');
        scan.status = await checkCancelled(scan) ? 'cancelled' : incomplete ? (scan.total || scan.options.checkProfile ? 'completed_partial' : 'failed') : 'completed';
        if (scan.status === 'failed') scan.error = 'Google discovery failed. Resolve the provider issue and resume; no clean-site verdict is available.';
        scan.completedAt = now(); await persist(scan);
      } catch (error) {
        if (error instanceof CancelledRun) { scan.status = 'cancelled'; scan.completedAt = now(); await persist(scan).catch(() => {}); return; }
        scan.status = 'failed'; scan.error = error.message; scan.completedAt = now(); try { await persist(scan); } catch (storageError) { transientErrors.set(scan.id, storageError.message); } }
    });
  } finally { locks.delete(scanId); }
}

const ready = (async () => {
  if (!navigator.locks) throw new Error('This browser does not support safe audit locking. Use a current browser to run hosted audits.');
  for (const scan of await scans()) {
    if (ACTIVE.includes(scan.status)) await navigator.locks.request(`signal404-${scan.id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const current = await get('scans', scan.id); if (!ACTIVE.includes(current.status)) return;
      current.status = 'cancelled'; current.cancelRequested = false; current.error = null;
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
    opts.profileMode = 'public';
    if (opts.googleProvider === 'browser' || opts.inspectGoogle) throw new Error('Local Google browser and Search Console inspection are available in the desktop version. Choose an API provider for hosted discovery.');
    if (!Number.isInteger(opts.googleMaxPages) || opts.googleMaxPages < 1 || opts.googleMaxPages > 100) throw new Error('Use a Google page budget between 1 and 100 online.');
    opts.sites = [...new Set(opts.sites.map((s) => new URL(normalize(s)).origin))]; opts.urls = opts.urls.map(normalize);
    const scan = { id, options: opts, status: 'queued', createdAt: now(), startedAt: null, completedAt: null, total: 0, processed: 0, findings: 0, error: null, cancelRequested: false, warnings: [], outputDir: 'Browser storage', baselines: {}, hours: [], hoursWork: {}, profiles: [], profileWork: {}, backlinks: [], work: { sitemap: {}, backlinks: {}, crawl: {} }, googleDiscovery: opts.discovery.some((s) => GOOGLE_SOURCES.includes(s)) ? opts.sites.map((site) => ({ site, provider: 'searchapi', country: opts.googleCountry, language: opts.googleLanguage, pagesFetched: 0, status: 'running', updatedAt: now(), queries: queryList(site).map((query) => ({ query, nextPage: 1, done: false, fingerprints: [] })) })) : [] };
    const imported = opts.urls.map((url) => ({ url })); for (const file of opts.inputFiles) { const upload = await get('uploads', file); if (!upload) throw new Error('The selected import is no longer available. Choose the file again.'); imported.push(...upload.rows); }
    const rows = imported.map((row) => { const normalizedUrl = normalize(row.url); return { inputUrl: row.url, normalizedUrl, site: new URL(normalizedUrl).origin, sources: [{ source: 'import', restaurantName: row.name, restaurantAddress: row.address, placeId: row.placeId }] }; });
    if (!rows.length && !opts.sites.length) throw new Error('Add a website or at least one exact URL.');
    if (!rows.length && !scan.googleDiscovery.length && !opts.discovery.some((s) => ['sitemap', 'crawl', 'backlinks'].includes(s)) && !opts.checkProfile) throw new Error('Add exact URLs for an import audit, or choose a discovery source for website targets.');
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
      const refresh = latest.options.checkProfile && ['completed', 'completed_partial'].includes(latest.status) ? { profileWork: {} } : {};
      await updateScan(id, { cancelRequested: false, status: 'queued', error: null, ...refresh }); transientErrors.delete(id); void run(id);
    });
    return { ok: true };
  }
  const all = await candidates(id);
  if (action === 'profiles') return { schemaVersion: '1.0', reports: [...liveReports(scan)] };
  if (action === 'results') {
    const search = (url.searchParams.get('search') || '').toLowerCase(), classification = url.searchParams.get('classification');
    const rows = all.filter((r) => r.result && (!classification || classification === 'all' || r.result.classification === classification) && (!search || JSON.stringify(r).toLowerCase().includes(search))).sort((a, b) => a.normalizedUrl.localeCompare(b.normalizedUrl));
    const offset = Number(url.searchParams.get('offset')) || 0, limit = Number(url.searchParams.get('limit')) || 25;
    return { total: rows.length, items: rows.slice(offset, offset + limit) };
  }
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, all.filter((r) => r.result?.classification === c).length]));
  const sourceCounts = {}; for (const row of all) for (const source of new Set(row.sources.map((s) => s.source))) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  const hoursCounts = {}; for (const row of scan.hours) hoursCounts[row.status] = (hoursCounts[row.status] || 0) + 1;
  return { scan: cleanScan(scan), counts, sourceCounts, hoursCounts, googleDiscovery: scan.googleDiscovery, backlinkCount: scan.backlinks?.length || 0, profiles: [...liveReports(scan)], artifacts: !ACTIVE.includes(scan.status) ? ['report.xlsx', 'all-urls.csv', 'findings.csv', 'run.json', ...(scan.options.checkHours ? ['hours.csv'] : []), ...(scan.backlinks?.length ? ['backlinks.csv'] : []), ...(scan.profiles?.length ? ['profile-audit.json'] : [])] : [] };
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
      try { const found = await remote({ action: 'sitemap', site }); await addSources(scan, found.urls); scan.warnings.push(...found.warnings.map((w) => `sitemap ${w}`)); }
      catch (error) { scan.warnings.push(`sitemap ${site}: ${error.message}`); }
      scan.work.sitemap[site] = true; await persist(scan);
    }
    if (await checkCancelled(scan)) return;
    if (sources.includes('backlinks') && !scan.work.backlinks[site]) {
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
          if (!url) { if (!active) return; await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
          if (work.seen.includes(url)) continue;
          work.seen.push(url); active++;
          try {
            const page = await remote({ action: 'crawl-page', site, url });
            const fresh = page.links.filter((link) => !work.seen.includes(link) && !work.queue.includes(link));
            work.queue.push(...fresh);
            await addSources(scan, [url, ...fresh].map((link) => ({ url: link, evidence: { source: 'crawl', discoveredFrom: url } })));
          } catch (error) { if (++work.failures <= 20) scan.warnings.push(`crawl ${url}: ${error.message}`); }
          finally { active--; await persist(scan); }
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

/**
 * The desktop profile audit, one short worker step at a time: website pages, then the Google side
 * (listing plus Maps buttons, merged and resolved server-side), then each link, then the report.
 */
async function compareProfiles(scan) {
  scan.profileWork ||= {}; scan.profiles ||= [];
  scan.status = 'comparing_profile'; await persist(scan);
  const discovered = (await candidates(scan.id)).map((candidate) => candidate.normalizedUrl);
  for (const target of await profileTargets(scan)) {
    if (await checkCancelled(scan)) return;
    const work = scan.profileWork[target.url] ||= { startedAt: now(), queue: [{ url: target.url, depth: 0 }, ...discovered.filter((url) => host(url) === host(target.url) && SERVICE_PATH.test(url)).map((url) => ({ url, depth: 1 }))], seen: [], pages: [], warnings: [], incomplete: false, links: [] };
    if (work.done) continue;
    while (work.queue.length && work.seen.length < scan.options.profilePageLimit) {
      if (await checkCancelled(scan)) return;
      const item = work.queue.shift(), key = item.url.replace(/#.*$/, '');
      if (work.seen.includes(key)) continue;
      work.seen.push(key);
      const page = await remote({ action: 'profile-page', target, url: item.url, depth: item.depth, landing: work.pages[0]?.finalUrl });
      if (page.error) { work.incomplete = true; work.warnings.push(`Could not inspect ${item.url}: ${page.error}`); }
      else { work.pages.push({ url: page.url, finalUrl: page.finalUrl, snapshot: page.snapshot }); work.queue.push(...page.next.filter((next) => !work.seen.includes(next.url.replace(/#.*$/, '')))); }
      await persist(scan);
    }
    if (work.queue.some((item) => !work.seen.includes(item.url.replace(/#.*$/, '')))) { work.incomplete = true; if (!work.warnings.includes('Website discovery page budget reached')) work.warnings.push('Website discovery page budget reached'); }
    if (!work.side) {
      const google = await remote({ action: 'profile-google', target, pages: work.pages, warnings: work.warnings, incomplete: work.incomplete, country: scan.options.googleCountry, tolerance: scan.options.profileHoursTolerance });
      Object.assign(work, { website: google.website, side: google.side, destinations: google.destinations }); await persist(scan);
    }
    // Link checks only need the identity facts, not every fact on the website.
    const slim = { ...work.website, pages: [], links: [], facts: work.website.facts.filter((item) => ['name', 'address', 'phone'].includes(item.field)) };
    let nextLink = 0;
    await Promise.all(Array.from({ length: Math.min(parallelism(scan), work.destinations.length) }, async () => {
      for (let index = nextLink++; index < work.destinations.length; index = nextLink++) {
        if (work.links[index] || await checkCancelled(scan)) continue;
        work.links[index] = await remote({ action: 'profile-link', target, link: work.destinations[index], website: slim });
        await persist(scan);
      }
    }));
    if (await checkCancelled(scan)) return;
    const { report, durable } = await remote({ action: 'profile-report', auditId: scan.id, target, startedAt: work.startedAt, website: work.website, side: work.side, links: work.links.filter(Boolean), country: scan.options.googleCountry, tolerance: scan.options.profileHoursTolerance });
    liveProfiles.set(`${scan.id}|${report.targetKey}`, report);
    scan.profiles = [...(scan.profiles || []).filter((item) => item.targetKey !== durable.targetKey), durable];
    // Google values stay in memory only; the saved work keeps nothing but the completion mark.
    scan.profileWork[target.url] = { done: true };
    await persist(scan);
  }
}

export async function download(scanId, name) {
  const scan = await get('scans', scanId), rows = await candidates(scanId);
  const { exportFile } = await import('./hosted-exports.js');
  await exportFile(scan, rows, name);
}
