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
  await writeFile(join(directory, 'runtime.js'), 'window.SIGNAL404_HOSTED = true;');
  await build({ entryPoints: ['src/hosted/client.js'], outfile: join(directory, 'modules/hosted.js'), bundle: true, format: 'esm', platform: 'browser', external: ['./hosted-exports.js'] });
  await build({ entryPoints: ['src/hosted/exports.js'], outfile: join(directory, 'modules/hosted-exports.js'), bundle: true, format: 'esm', platform: 'browser' });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/worker') {
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        const value = body.action === 'providers' ? { searchApi: true, googleMaps: false, googleBrowser: false } : await worker(body);
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

test('hosted retry preserves completed checks and concurrent tabs cannot start duplicate workers', async () => {
  const counts = new Map<string, number>(); let fail = true;
  const env = await fixture(async (body) => {
    counts.set(body.url, (counts.get(body.url) || 0) + 1);
    if (body.url.endsWith('/b') && fail) throw new Error('Provider temporarily unavailable');
    await new Promise((resolve) => setTimeout(resolve, 50)); return check(body.url);
  });
  try {
    const context = await env.browser.newContext(), page = await context.newPage(); await page.goto(env.url);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/a', 'https://restaurant.example/b'], discovery: ['import'] }) });
    await waitForStatus(page, scan.id, 'failed');
    const failed = await api(page, `/api/scans/${scan.id}`);
    assert.equal(failed.scan.processed, 1, JSON.stringify(failed.scan));
    await page.reload(); fail = false;
    const other = await context.newPage(); await other.goto(env.url);
    await Promise.all([api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }), api(other, `/api/scans/${scan.id}/resume`, { method: 'POST' })]);
    await waitForStatus(page, scan.id, 'completed');
    assert.equal(counts.get('https://restaurant.example/a'), 1); assert.equal(counts.get('https://restaurant.example/b'), 2);
  } finally { await env.close(); }
});

test('hosted network guard rejects private, mapped, link-local and reserved targets', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.2', '172.16.0.1', '192.168.1.2', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1', '224.0.0.1', '0.0.0.0', 'fc00::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.throws(() => publicUrl('file:///etc/passwd')); assert.throws(() => publicUrl('http://example.com:22/'));
  await assert.rejects(publicAddress('127.0.0.1'), /Private/);
});

test('hosted cancellation saves the in-flight result and resumes pending URLs', async () => {
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const counts = new Map<string, number>();
  const env = await fixture(async (body) => { counts.set(body.url, (counts.get(body.url) || 0) + 1); if (body.url.endsWith('/b')) await held; return check(body.url); });
  try {
    const page = await env.browser.newPage(); await page.goto(env.url);
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/a', 'https://restaurant.example/b', 'https://restaurant.example/c'], discovery: ['import'] }) });
    for (let i = 0; i < 100 && !counts.has('https://restaurant.example/b'); i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(counts.get('https://restaurant.example/b'), 1);
    await api(page, `/api/scans/${scan.id}/cancel`, { method: 'POST' }); release();
    const cancelled = await waitForStatus(page, scan.id, 'cancelled'); assert.equal(cancelled.scan.processed, 2);
    await page.reload(); await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' });
    const done = await waitForStatus(page, scan.id, 'completed'); assert.equal(done.scan.processed, 3);
    assert.deepEqual([...counts.values()], [1, 1, 1]);
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
    const scan = await api(page, '/api/scans', { method: 'POST', body: JSON.stringify({ urls: ['https://restaurant.example/a', 'https://restaurant.example/b'], discovery: ['import'] }) });
    for (let i = 0; i < 100 && !counts.has('https://restaurant.example/b'); i++) await new Promise((r) => setTimeout(r, 30));
    await page.reload(); const paused = await waitForStatus(page, scan.id, 'cancelled'); assert.equal(paused.scan.processed, 1);
    release(); await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }); await waitForStatus(page, scan.id, 'completed');
    assert.equal(counts.get('https://restaurant.example/a'), 1); assert.equal(counts.get('https://restaurant.example/b'), 2);
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
    await waitForStatus(page, scan.id, 'failed'); failed = false;
    await api(page, `/api/scans/${scan.id}/resume`, { method: 'POST' }); const done = await waitForStatus(page, scan.id, 'completed');
    assert.equal(done.hoursCounts.match, 1); assert.deepEqual(calls, ['check', 'hours-page', 'hours-compare', 'hours-compare']);
  } finally { await env.close(); }
});
