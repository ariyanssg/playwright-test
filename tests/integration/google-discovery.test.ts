import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import { mergeScanOptions } from '../../src/config.js';
import { GoogleChallengeError, googleSearchUrl, type GooglePage, type GoogleSearchRequest } from '../../src/discovery/google-results.js';
import type { GoogleProviders } from '../../src/discovery/google-search.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

function response(request: GoogleSearchRequest, urls: string[], hasNext = false): GooglePage {
  return { results: urls.map((url, index) => ({ url, title: 'Search title', snippet: 'Search snippet', position: index + 1, kind: 'organic' })), hasNext, searchUrl: googleSearchUrl(request) };
}
function providers(fetch: (request: GoogleSearchRequest) => Promise<GooglePage>): GoogleProviders {
  return { searchapi: fetch, browser: () => ({ fetchPage: fetch, close: async () => {} }) };
}
async function setup(fetch: (request: GoogleSearchRequest, origin: string) => Promise<GooglePage>) {
  const site = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'signal404-google-'));
  const service = new ScanService(join(directory, 'scan.sqlite'), providers((request) => fetch(request, site.origin)));
  const options = { sites: [site.origin], googleProvider: 'browser' as const, outputDir: join(directory, 'runs'), hostDelayMs: 0, timeoutMs: 4000 };
  return { site, directory, service, options, close: async () => { service.close(); await site.close(); } };
}

test('Google-only discovery paginates breadth first, excludes crawl/root URLs, verifies soft404/PDF, and reconciles reports', async () => {
  const calls: GoogleSearchRequest[] = [];
  const env = await setup(async (request, origin) => {
    calls.push(request);
    if (request.query.endsWith(' 404')) return response(request, [`${origin}/error-template`]);
    if (request.query.includes('"not found"')) return response(request, [`${origin}/error-template`]);
    if (request.query.includes(' ')) return response(request, []);
    if (request.page === 1) return response(request, [`${origin}/ok`, `${origin}/menu.pdf`, `${origin}/download-redirect`, 'https://external.example/ignore'], true);
    if (request.page === 2) return response(request, [`${origin}/hard?google=page2#fragment`], true);
    return response(request, [`${origin}/hard?google=page2#fragment`], true); // repeated page stops
  });
  try {
    const scan = env.service.createScan(env.options);
    assert.deepEqual(scan.options.discovery, ['google']);
    const done = await env.service.start(scan.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.total, 5);
    assert.equal(done.findings, 2);
    assert.deepEqual(calls.slice(0, 5).map((call) => call.page), [1, 1, 1, 1, 1]);
    assert.equal(calls.length, 7);
    const rows = env.service.results(scan.id, 0, 100).items;
    assert.ok(rows.every((row) => row.sources.every((source) => source.source === 'google_browser')));
    assert.ok(rows.every((row) => row.normalizedUrl !== `${env.site.origin}/`));
    assert.equal(env.site.requestCount('/sitemap.xml'), 0);
    assert.equal(env.site.requestCount('/private'), 0);
    const error = rows.find((row) => row.normalizedUrl.endsWith('/error-template'))!;
    assert.equal(error.result!.httpStatus, 200);
    assert.equal(error.result!.classification, 'soft_404_suspected');
    assert.equal(error.sources.length, 2);
    assert.equal(error.sources[0]!.country, 'gb');
    assert.equal(error.sources[0]!.language, 'en');
    assert.ok(error.sources[0]!.observedAt);
    assert.match(error.sources[0]!.searchUrl!, /google.com\/search/);
    const pdf = rows.find((row) => row.normalizedUrl.endsWith('/menu.pdf'))!;
    assert.equal(pdf.result!.classification, 'ok');
    assert.equal(pdf.result!.httpStatus, 200);
    const redirected = rows.find((row) => row.normalizedUrl.endsWith('/download-redirect'))!;
    assert.equal(redirected.result!.classification, 'redirected');
    assert.deepEqual(redirected.result!.redirectChain.map((hop) => hop.status), [302, 200]);
    const summary = await env.service.summary(scan.id);
    assert.equal(summary.googleDiscovery[0]!.status, 'exhausted');
    assert.equal(summary.sourceCounts.google_browser, 5);
    const json = JSON.parse(await readFile(join(done.outputDir, 'run.json'), 'utf8'));
    assert.equal(json.candidates.length, 5);
    assert.equal(json.coverage.googleDiscovery[0].pagesFetched, 7);
    const csv = parse(await readFile(join(done.outputDir, 'all-urls.csv'), 'utf8'), { columns: true });
    assert.equal(csv.length, 5);
    const findings = parse(await readFile(join(done.outputDir, 'findings.csv'), 'utf8'), { columns: true });
    assert.equal(findings.length, 2);
    assert.match(JSON.stringify(findings), /resultPage/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(join(done.outputDir, 'report.xlsx'));
    assert.equal(book.getWorksheet('All URLs')!.rowCount, 6);
    assert.ok(book.getWorksheet('Google Coverage'));
    assert.match(JSON.stringify(book.getWorksheet('All URLs')!.getSheetValues()), /google_browser/);
    for (const csvRow of csv) {
      let evidence: string | undefined;
      book.getWorksheet('All URLs')!.eachRow((row) => {
        if (row.getCell(1).text === csvRow.URL) evidence = row.getCell(18).text;
      });
      assert.deepEqual(JSON.parse(evidence!), JSON.parse(csvRow['Discovery Evidence']));
    }
  } finally { await env.close(); }
});

test('Google failure and page budget cannot yield a clean completed scan; explicit empty results are recorded', async () => {
  const failed = await setup(async () => { throw new Error('provider unavailable'); });
  try {
    const scan = failed.service.createScan(failed.options);
    const done = await failed.service.start(scan.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.total, 0);
    assert.match(done.error!, /no URLs were verified/);
  } finally { await failed.close(); }
  const limited = await setup(async (request, origin) => response(request, [`${origin}/ok`], true));
  try {
    const scan = limited.service.createScan({ ...limited.options, googleMaxPages: 1 });
    const done = await limited.service.start(scan.id);
    assert.equal(done.status, 'completed_partial');
    assert.equal(done.total, 1);
    assert.equal(limited.service.db.googleDiscovery(scan.id)[0]!.status, 'limited');
  } finally { await limited.close(); }
  const empty = await setup(async (request) => response(request, []));
  try {
    const scan = empty.service.createScan(empty.options);
    const done = await empty.service.start(scan.id);
    assert.equal(done.total, 0);
    assert.equal(done.status, 'completed');
    assert.equal(empty.service.db.googleDiscovery(scan.id)[0]!.pagesFetched, 5);
  } finally { await empty.close(); }
});

test('Auto falls back visibly, while explicit SearchApi never starts a browser', async () => {
  const key = process.env.SEARCHAPI_API_KEY;
  process.env.SEARCHAPI_API_KEY = 'configured-for-test';
  let browserCalls = 0;
  const env = await setup(async (request) => { browserCalls++; return response(request, []); });
  // Inject independent adapters to exercise the real provider selection logic.
  const directory = await mkdtemp(join(tmpdir(), 'signal404-fallback-'));
  const service = new ScanService(join(directory, 'scan.sqlite'), {
    searchapi: async () => { throw new Error('quota exhausted'); },
    browser: () => ({ fetchPage: async (r) => { browserCalls++; return response(r, []); }, close: async () => {} }),
  });
  try {
    const auto = service.createScan({ ...env.options, googleProvider: 'auto' });
    assert.equal((await service.start(auto.id)).status, 'completed');
    assert.equal(browserCalls, 5);
    assert.match(service.getScan(auto.id)!.warnings.join(), /continuing with the local Google browser/);
    const explicit = service.createScan({ ...env.options, googleProvider: 'searchapi' });
    assert.equal((await service.start(explicit.id)).status, 'failed');
    assert.equal(browserCalls, 5);
  } finally {
    if (key === undefined) delete process.env.SEARCHAPI_API_KEY; else process.env.SEARCHAPI_API_KEY = key;
    service.close(); await env.close();
  }
});

test('Auto prefers Serper, records it as evidence, and falls back to SearchApi before the browser', async () => {
  const saved = { serper: process.env.SERPER_API_KEY, searchapi: process.env.SEARCHAPI_API_KEY };
  process.env.SERPER_API_KEY = 'serper-for-test';
  process.env.SEARCHAPI_API_KEY = 'searchapi-for-test';
  const env = await setup(async (request) => response(request, []));
  const calls = { serper: 0, searchapi: 0, browser: 0 };
  let serperFails = false;
  const directory = await mkdtemp(join(tmpdir(), 'signal404-serper-'));
  const service = new ScanService(join(directory, 'scan.sqlite'), {
    serper: async (request) => { calls.serper++; if (serperFails) throw new Error('Not enough credits'); return response(request, request.query.includes(' ') ? [] : [`${env.site.origin}/ok`]); },
    searchapi: async (request) => { calls.searchapi++; return response(request, []); },
    browser: () => ({ fetchPage: async (request) => { calls.browser++; return response(request, []); }, close: async () => {} }),
  });
  try {
    const cheap = service.createScan({ ...env.options, googleProvider: 'auto' });
    assert.equal((await service.start(cheap.id)).status, 'completed');
    assert.deepEqual(calls, { serper: 5, searchapi: 0, browser: 0 });
    const [row] = service.results(cheap.id, 0, 10).items;
    assert.equal(row?.sources[0]?.source, 'serper');
    assert.deepEqual(service.db.googleDiscovery(cheap.id)[0]?.providersUsed, ['serper']);

    serperFails = true;
    const fallback = service.createScan({ ...env.options, googleProvider: 'auto' });
    assert.equal((await service.start(fallback.id)).status, 'completed');
    assert.equal(calls.searchapi, 5);
    assert.equal(calls.browser, 0);
    assert.match(service.getScan(fallback.id)!.warnings.join(), /Serper unavailable \(Not enough credits\); continuing with SearchApi/);
  } finally {
    for (const [name, value] of [['SERPER_API_KEY', saved.serper], ['SEARCHAPI_API_KEY', saved.searchapi]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    service.close(); await env.close();
  }
});

test('CAPTCHA Continue and Cancel preserve checkpoints; restart resumes without replaying completed queries', async () => {
  const requests: string[] = [];
  let challenge = true;
  const env = await setup(async (request, origin) => {
    requests.push(`${request.query}:${request.page}`);
    if (request.query.endsWith(' 404') && challenge) throw new GoogleChallengeError('Resolve test Google prompt');
    return response(request, request.query.includes(' ') ? [] : [`${origin}/hard`]);
  });
  const dashboard = await startDashboard(env.service, 0);
  try {
    const scan = env.service.createScan(env.options);
    let paused!: () => void;
    const waiting = new Promise<void>((resolve) => { paused = resolve; });
    env.service.onProgress(scan.id, (event) => { if (event.status === 'waiting_for_google') paused(); });
    const running = env.service.start(scan.id);
    await waiting;
    assert.equal(env.service.db.googleDiscovery(scan.id)[0]!.pagesFetched, 1);
    assert.equal(env.service.db.listCandidates(scan.id).length, 1);
    challenge = false;
    const continued = await fetch(`${dashboard.url}/api/scans/${scan.id}/resume`, { method: 'POST' });
    assert.equal(continued.status, 202);
    const done = await running;
    assert.equal(done.status, 'completed');
    assert.equal(requests.filter((r) => r.endsWith('127.0.0.1:1')).length, 1);

    challenge = true;
    const second = env.service.createScan(env.options);
    const stopped = new Promise<void>((resolve) => env.service.onProgress(second.id, (e) => { if (e.status === 'waiting_for_google') resolve(); }));
    const active = env.service.start(second.id);
    await stopped;
    env.service.cancel(second.id);
    assert.equal((await active).status, 'cancelled');
    const completedQueries = requests.filter((r) => r.endsWith('127.0.0.1:1')).length;
    challenge = false;
    // A second service emulates a process restart using the same SQLite state.
    const restored = new ScanService(join(env.directory, 'scan.sqlite'), providers(async (request) => {
      requests.push(`${request.query}:${request.page}`);
      return response(request, []);
    }));
    try {
      const resumed = await restored.resume(second.id);
      assert.equal(resumed.status, 'completed');
      assert.equal(resumed.total, 1);
      assert.equal(requests.filter((r) => r.endsWith('127.0.0.1:1')).length, completedQueries);
    } finally { restored.close(); }
  } finally { await dashboard.close(); await env.close(); }
});

test('Google settings validate while exact imports and explicit legacy sources keep their scope', () => {
  assert.deepEqual(mergeScanOptions({ urls: ['https://example.com/a'] }).discovery, ['import']);
  assert.deepEqual(mergeScanOptions({ sites: ['https://example.com'], discovery: ['sitemap'] }).discovery, ['sitemap']);
  assert.throws(() => mergeScanOptions({ googleCountry: 'bad' }), /country/);
  assert.throws(() => mergeScanOptions({ googleMaxPages: 0 }), /Google result pages per site/);
  assert.throws(() => mergeScanOptions({ googleProvider: 'unknown' as never }), /provider/);
});

test('Retry after partial provider failure keeps completed URL checks and adds new evidence', async () => {
  let failing = true;
  const env = await setup(async (request, origin) => {
    if (!request.query.includes(' ')) return response(request, [`${origin}/ok`]);
    if (request.query.endsWith(' 404')) {
      if (failing) throw new Error('temporary Google failure');
      return response(request, [`${origin}/ok`, `${origin}/hard`]);
    }
    return response(request, []);
  });
  try {
    const scan = env.service.createScan(env.options);
    assert.equal((await env.service.start(scan.id)).status, 'completed_partial');
    const checked = env.site.requestCount('/ok');
    failing = false;
    assert.equal((await env.service.resume(scan.id)).status, 'completed');
    assert.equal(env.site.requestCount('/ok'), checked);
    const rows = env.service.results(scan.id).items;
    assert.equal(rows.length, 2);
    const ok = rows.find((row) => row.normalizedUrl.endsWith('/ok'))!;
    assert.equal(ok.sources.length, 2);
    assert.deepEqual(ok.result!.sources, ok.sources, 'Previously checked results receive newly discovered evidence in exports too');
  } finally { await env.close(); }
});
