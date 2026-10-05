import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { isPublicAddress, publicAddress, publicUrl } from '../../src/hosted/network.js';

async function fixture(worker: (body: any) => any) {
  const directory = await mkdtemp(join(tmpdir(), 'signal404-hosted-'));
  await cp('src/public', directory, { recursive: true });
  // Retries keep their production shape, only shorter, so failure paths stay fast to test.
  await writeFile(join(directory, 'runtime.js'), 'window.SIGNAL404_HOSTED = true; window.SIGNAL404_RETRY_DELAYS = [20, 20];');
  await build({ entryPoints: ['src/hosted/client.js'], outfile: join(directory, 'modules/hosted.js'), bundle: true, format: 'esm', platform: 'browser', external: ['./hosted-exports.js'] });
  await build({ entryPoints: ['src/hosted/exports.js'], outfile: join(directory, 'modules/hosted-exports.js'), bundle: true, format: 'esm', platform: 'browser' });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/worker') {
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        const value = body.action === 'providers' ? { searchApi: true, googleMaps: false, googleBrowser: false } : await batched(worker, body);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)); return;
      }
      const path = request.url === '/' ? 'index.html' : request.url!.slice(1);
      const content = await readFile(join(directory, path));
      response.writeHead(200, { 'content-type': extname(path) === '.js' ? 'application/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html' }).end(content);
    } catch (error) { response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listener');
  const browser = await chromium.launch();
  return { directory, browser, url: `http://127.0.0.1:${address.port}`, close: async () => { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
/**
 * The worker takes batches (several pages per call); fixtures describe one page at a time. A
 * page whose fixture throws is reported as skipped, as the real worker does when a page cannot be
 * finished within its time budget.
 */
async function batched(worker: (body: any) => any, body: any) {
  if (body.action === 'check') {
    const results = [], skipped = [];
    for (const url of body.urls) { try { results.push({ url, result: (await worker({ ...body, url })).result }); } catch (error: any) { if (error.transport) throw error; skipped.push(url); } }
    return { results, skipped, baselines: {} };
  }
  if (body.action === 'hours-pages') {
    const pages = [], errors = [];
    for (const item of body.items) { const page = await worker({ action: 'hours-page', url: item.url, score: item.score }); if (page.extraction) pages.push(page.extraction); else errors.push(`${item.url}: ${page.error}`); }
    return { pages, errors, skipped: [] };
  }
  if (body.action === 'profile-pages') return { pages: await Promise.all(body.items.map((item: any) => worker({ action: 'profile-page', target: body.target, url: item.url, depth: item.depth, landing: body.landing }))) };
  if (body.action === 'profile-links') return { checks: await Promise.all(body.links.map((link: any) => worker({ action: 'profile-link', target: body.target, link, website: body.website }))) };
  return worker(body);
}
function check(url: string) {
  return { result: { inputUrl: url, normalizedUrl: url, site: new URL(url).origin, sources: [], httpStatus: 200, finalUrl: url, redirectChain: [{ url, status: 200 }], classification: url.includes('404') ? 'soft_404_suspected' : 'ok', confidence: 0.99, reasons: ['Fixture evidence'], robotsAllowed: null, title: 'Restaurant', h1: '', canonical: null, contentType: 'text/html', responseMs: 50, checkedAt: new Date().toISOString(), error: null }, baseline: null, baselineChecked: true };
}
async function api(page: Page, path: string, options: any = {}) { return page.evaluate(async ({ path, options }) => { const module = await import('/modules/api.js'); return module.request(path, options); }, { path, options }); }
async function waitForStatus(page: Page, id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const summary = await api(page, `/api/scans/${id}`);
    if (summary.scan.status === status) return summary;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Audit did not reach ${status}`);
}

test('hosted Google audits save browser checkpoints, merge evidence, export locally, and isolate user storage', async () => {
  const calls: any[] = [];
  const env = await fixture((body) => { calls.push(body); return body.action === 'google' ? { results: [{ url: 'https://restaurant.example/404', title: '404', snippet: 'Not found', kind: 'organic', position: 1 }, { url: 'https://restaurant.example/menu.pdf', kind: 'sitelink' }, { url: 'https://outside.example/not-ours', kind: 'organic' }], hasNext: body.query === 'site:restaurant.example' && body.page === 1, searchUrl: 'https://www.google.com/search?q=fixture' } : check(body.url); });
  try {
    const context = await env.browser.newContext(), page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${env.url}/#new-audit`); await page.locator('#sites').fill('https://restaurant.example/'); await page.locator('#start-button').click();
    await page.locator('#run-status').filter({ hasText: 'Completed' }).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('#metric-total').innerText(), '2'); assert.equal(await page.locator('#metric-findings').innerText(), '1');
    assert.equal(await page.locator('#results-body tr').count(), 2);
    assert.equal(calls.filter((c) => c.action === 'google').length, 6); assert.equal(calls.filter((c) => c.action === 'check').length, 2);
    const download = async (name: string) => { const pending = page.waitForEvent('download'); await page.locator(`#downloads a[href$="/${name}"]`).click(); const d = await pending; return (await d.path())!; };
    const json = JSON.parse(await readFile(await download('run.json'), 'utf8'));
    assert.equal(json.candidates[0].sources.length, 6); assert(json.candidates.every((c: any) => c.sources.every((s: any) => s.source === 'searchapi')));
    const csv = parse(await readFile(await download('all-urls.csv'), 'utf8'), { columns: true }); assert.equal(csv.length, 2);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(await download('report.xlsx'));
    assert.equal(workbook.getWorksheet('All URLs')!.rowCount, 3); assert.equal(workbook.getWorksheet('Google Evidence')!.rowCount, 13);
    assert.deepEqual(JSON.parse(csv[0]['Discovery Evidence']), json.candidates[0].sources);
    await page.reload(); await page.locator('#metric-total').filter({ hasText: '2' }).waitFor(); assert.equal(calls.filter((c) => c.action === 'check').length, 2);
    const another = await env.browser.newContext(), otherPage = await another.newPage(); await otherPage.goto(env.url);
    assert.equal((await api(otherPage, '/api/scans')).scans.length, 0); assert.deepEqual(errors, []);
  } finally { await env.close(); }
});

test('a page that keeps failing leaves a partial audit, and resume finishes it without duplicate workers', async () => {
  const counts = new Map<string, number>(); let fail = true;
  const env = await fixture(async (body) => {
    counts.set(body.url, (counts.get(body.url) || 0) + 1);
    if (body.url.endsWith('/b') && fail) throw new Error('Provider temporarily unavailable');
    await new Promise((resolve) => setTimeout(resolve, 50)); return check(body.url);
  });
  try {
    const context = await env.browser.newContext(), page = await context.newPage(); await page.goto(env.url);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/a', 'https://restaurant.example/b'], discovery: ['import'] }) });
    // One unreachable page no longer fails the audit: the rest is reported and the gap is named.
    const failed = await waitForStatus(page, scan.id, 'completed_partial');
    assert.equal(failed.scan.processed, 1, JSON.stringify(failed.scan));
    assert.ok(failed.scan.warnings.some((warning: string) => /1 page could not be checked online.*Resume/.test(warning)), JSON.stringify(failed.scan.warnings));
    await page.reload(); fail = false;
    const other = await context.newPage(); await other.goto(env.url);
    await Promise.all([api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }), api(other, `/api/scans/${scan.id}/resume`, { method: 'POST' })]);
    await waitForStatus(page, scan.id, 'completed');
    assert.equal(counts.get('https://restaurant.example/a'), 1); assert.ok(counts.get('https://restaurant.example/b')! >= 2);
  } finally { await env.close(); }
});

test('busy and restarted workers are retried with backoff before a step counts as failed', async () => {
  let attempts = 0;
  // A transport-level failure is the whole call answering 503, like a busy or restarting worker.
  const env = await fixture(async (body) => { if (++attempts < 3) throw Object.assign(new Error('Rate limited'), { transport: true }); return check(body.url); });
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/a'], discovery: ['import'] }) });
    const done = await waitForStatus(page, scan.id, 'completed');
    assert.equal(done.scan.processed, 1);
  } finally { await env.close(); }
});

test('hosted network guard rejects private, mapped, link-local and reserved targets', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.2', '172.16.0.1', '192.168.1.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1', '224.0.0.1', '0.0.0.0', 'fc00::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => publicUrl('file:///etc/passwd')); assert.throws(() => publicUrl('http://example.com:22/'));
  await assert.rejects(publicAddress('127.0.0.1'), /Private/);
});

test('hosted cancellation saves the in-flight batch and resumes pending URLs', async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const counts = new Map<string, number>();
  const env = await fixture(async (body) => { counts.set(body.url, (counts.get(body.url) || 0) + 1); if (body.url.endsWith('/b')) await held; return check(body.url); });
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    // Eight pages make two batches (six, then two); one call at a time, so the second is still pending.
    const urls = 'abcdefgh'.split('').map((letter) => `https://restaurant.example/${letter}`);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls, discovery: ['import'], concurrency: 1 }) });
    for (let i = 0; i < 100 && !counts.has('https://restaurant.example/b'); i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(counts.get('https://restaurant.example/b'), 1);
    await api(page, `/api/scans/${scan.id}/cancel`, { method: 'POST' }); release();
    const cancelled = await waitForStatus(page, scan.id, 'cancelled'); assert.equal(cancelled.scan.processed, 6);
    await page.reload(); await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' });
    const done = await waitForStatus(page, scan.id, 'completed'); assert.equal(done.scan.processed, 8);
    assert.deepEqual([...counts.values()], [1, 1, 1, 1, 1, 1, 1, 1]);
  } finally { release(); await env.close(); }
});

test('hosted imports have no row cap, preserve XLSX identity hints, and reject invalid inputs before creating an audit', async () => {
  const env = await fixture((body) => check(body.url));
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    const workbook = new ExcelJS.Workbook();
    for (const name of ['One', 'Two']) { const sheet = workbook.addWorksheet(name); sheet.addRow(['URL', 'Name', 'place_id']); for (let i = 0; i < 260; i++) sheet.addRow([`https://restaurant.example/${name}/${i}`, '=Guest formula', `place-${i}`]); }
    const bytes = [...new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer)];
    const imported = await page.evaluate(async (bytes) => { const m = await import('/modules/hosted-exports.js'); return m.readUpload(new Blob([new Uint8Array(bytes)]), 'list.xlsx'); }, bytes);
    assert.equal(imported.length, 520); assert.equal(imported[0].name, '=Guest formula'); assert.equal(imported[0].placeId, 'place-0');
    await assert.rejects(api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['file:///etc/passwd'], discovery: ['import'] }) }));
    assert.equal((await api(page, '/api/scans')).scans.length, 0);
  } finally { await env.close(); }
});

test('closing an active browser session preserves committed checks and offers resume', async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const counts = new Map<string, number>();
  const env = await fixture(async (body) => { counts.set(body.url, (counts.get(body.url) || 0) + 1); if (body.url.endsWith('/b') && counts.get(body.url) === 1) await held; return check(body.url); });
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    // Two websites are two batches, so one can finish while the other is still in flight.
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://one.example/a', 'https://two.example/b'], discovery: ['import'] }) });
    for (let i = 0; i < 100 && (!counts.has('https://two.example/b') || !counts.has('https://one.example/a')); i++) await new Promise((r) => setTimeout(r, 30));
    await new Promise((r) => setTimeout(r, 200));
    await page.reload(); const paused = await waitForStatus(page, scan.id, 'cancelled'); assert.equal(paused.scan.processed, 1);
    release(); await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }); await waitForStatus(page, scan.id, 'completed');
    assert.equal(counts.get('https://one.example/a'), 1); assert.equal(counts.get('https://two.example/b'), 2);
  } finally { release(); await env.close(); }
});

test('hosted hours retry keeps website extraction and successful URL checks', async () => {
  const calls: string[] = []; let failed = true;
  const env = await fixture((body) => {
    calls.push(body.action);
    if (body.action === 'check') return check(body.url);
    if (body.action === 'hours-page') return { extraction: { url: body.url, title: 'Restaurant', identity: { name: 'Restaurant' } }, error: null };
    if (failed) throw new Error('Places access blocked');
    return { site: body.site, status: 'match', matchConfidence: 'verified', placeName: 'Restaurant', days: [], notes: [] };
  });
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/'], discovery: ['import'], checkHours: true }) });
    // The listing failure is this restaurant's result ("not checked"), not a failed audit.
    const partial = await waitForStatus(page, scan.id, 'completed_partial'); failed = false;
    assert.equal(partial.hoursCounts.not_checked, 1);
    assert.match(partial.hours[0].notes[0], /Places access blocked.*Resume/);
    await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }); const done = await waitForStatus(page, scan.id, 'completed');
    assert.equal(done.hoursCounts.match, 1);
    // The homepage's links are read once to find an hours page, since nothing else was discovered.
    assert.deepEqual(calls.filter((call) => !['hours-compare', 'crawl-page'].includes(call)), ['check', 'hours-page'], 'website pages are read once and kept');
    assert.ok(calls.filter((call) => call === 'hours-compare').length >= 2);
  } finally { await env.close(); }
});

test('hosted audits run sitemaps, a rendered crawl and the business profile comparison step by step', async () => {
  const root = 'https://restaurant.example/';
  const actions: string[] = [];
  const snapshot = (url: string) => ({ source: 'website', facts: [{ field: 'name', value: 'Tandoori House', raw: 'Tandoori House', source: 'website', url, locator: 'test', observedAt: '2026-09-26T10:00:00Z', confidence: 'high' }], links: [], coverage: {}, warnings: [], pages: [url], finalUrl: root });
  const report = (retention: string) => ({ schemaVersion: '1.0', auditId: 'x', targetKey: 'target-1', target: { url: root }, mode: 'public', startedAt: '2026-09-26T10:00:00Z', completedAt: '2026-09-26T10:01:00Z', status: 'completed', identity: { status: 'verified', placeId: 'place-1', reason: 'Matched branch street address' }, checks: [{ field: 'services.menu', verdict: 'match', exactMatch: true, semanticMatch: true, website: [`${root}menu`], google: [`${root}menu`], evidence: [], severity: 'info', reason: 'Published values match exactly', recommendation: '' }], links: [], sources: [], pages: [root], summary: { total: 1, conclusive: 1, matches: 1, equivalent: 0, mismatches: 0, missing: 0, unknown: 0, brokenLinks: 0, outcome: 'pass' }, warnings: [], retention, rules: { version: '1.0', hoursToleranceMinutes: 0, country: 'GB' } });
  const env = await fixture((body) => {
    actions.push(body.action);
    if (body.action === 'sitemap') return { urls: [{ url: `${root}menu`, evidence: { source: 'sitemap', discoveredFrom: `${root}sitemap.xml` } }], warnings: [] };
    if (body.action === 'crawl-page') return { links: body.url === root ? [`${root}menu`, `${root}contact`] : [], blocked: false };
    if (body.action === 'check') return check(body.url);
    if (body.action === 'profile-page') return { url: body.url, finalUrl: body.url, snapshot: snapshot(body.url), next: body.depth === 0 ? [{ url: `${root}contact`, depth: 1 }] : [] };
    if (body.action === 'profile-google') {
      assert.ok(body.pages.length >= 2, 'every website page reaches the Google step');
      return { website: snapshot(root), side: { google: { source: 'places', facts: [], links: [], coverage: {}, warnings: [] }, extras: [], identity: { status: 'verified', placeId: 'place-1', reason: 'Matched' }, verified: true, warnings: [] }, destinations: [{ service: 'menu', url: `${root}menu`, label: 'Menu', source: 'website' }] };
    }
    if (body.action === 'profile-link') return { ...body.link, finalUrl: body.link.url, httpStatus: 200, redirectChain: [], health: 'functional', serviceReady: true, correctBranch: true, transactionTested: false, reason: 'ok', checkedAt: '2026-09-26T10:00:00Z' };
    if (body.action === 'profile-report') return { report: report('session_only'), durable: report('redacted') };
    throw new Error(`unexpected ${body.action}`);
  });
  try {
    const page = await env.browser.newPage(); await page.goto(`${env.url}/#new-audit`);
    // Online, Search Console is shown but labelled; the profile comparison is available.
    await page.locator('#profile-card:not(.hidden)').waitFor();
    assert.match(await page.locator('[name="discovery"][value="gsc"]').locator('xpath=..').innerText(), /Desktop only/i);
    assert.equal(await page.locator('[name="discovery"][value="gsc"]').isDisabled(), true);
    assert.equal(await page.locator('[name="discovery"][value="crawl"]').isVisible() || await page.locator('[name="discovery"][value="crawl"]').locator('xpath=..').isVisible(), true);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ sites: [root], discovery: ['import', 'sitemap', 'crawl'], checkProfile: true, profileMode: 'public' }) });
    const done = await waitForStatus(page, scan.id, 'completed');
    for (const action of ['sitemap', 'crawl-page', 'check', 'profile-page', 'profile-google', 'profile-link', 'profile-report']) assert.ok(actions.includes(action), `${action} step ran`);
    assert.ok(actions.indexOf('profile-google') > actions.lastIndexOf('profile-page'), 'Google is read after every website page');
    assert.equal(done.scan.total, 3, 'root, sitemap and crawl URLs are de-duplicated');
    assert.equal(done.profiles[0].retention, 'session_only');
    // A new page session only has the redacted copy, exactly like a desktop restart.
    await page.reload();
    const later = await api(page, `/api/scans/${scan.id}`);
    assert.equal(later.profiles[0].retention, 'redacted');
    assert.ok(later.artifacts.includes('profile-audit.json'));
  } finally { await env.close(); }
});
