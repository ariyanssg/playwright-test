import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { ScanService } from '../../src/service.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('scans fixture pages, classifies outcomes, and writes reconciled reports', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-scan-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  try {
    const paths = [
      '/', '/ok', '/hard', '/gone', '/soft', '/js-soft', '/catch-all-missing', '/private', '/redirect',
      '/redirect-chain-a', '/loop-a', '/incidental', '/blocked', '/server-error', '/retry-429', '/retry-500',
    ];
    const scan = service.createScan({
      urls: paths.map((path) => `${fixture.origin}${path}`),
      discovery: ['import'],
      outputDir: join(directory, 'runs'),
      concurrency: 3,
      perHostConcurrency: 2,
      hostDelayMs: 0,
      timeoutMs: 4_000,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.processed, paths.length);

    const results = service.results(scan.id, 0, 100).items.map((candidate) => candidate.result!);
    const byPath = new Map(results.map((result) => [new URL(result.normalizedUrl).pathname, result]));
    assert.equal(byPath.get('/ok')?.classification, 'ok');
    assert.equal(byPath.get('/hard')?.classification, 'hard_404');
    assert.equal(byPath.get('/gone')?.classification, 'gone_410');
    assert.equal(byPath.get('/soft')?.classification, 'soft_404_suspected');
    assert.equal(byPath.get('/js-soft')?.classification, 'soft_404_suspected');
    assert.equal(byPath.get('/catch-all-missing')?.classification, 'soft_404_suspected');
    assert.equal(byPath.get('/private')?.classification, 'soft_404_suspected');
    assert.equal(byPath.get('/private')?.robotsAllowed, false);
    assert.equal(byPath.get('/')?.classification, 'ok', 'The real homepage must not match its own catch-all baseline');
    assert.equal(byPath.get('/redirect')?.classification, 'redirected');
    assert.equal(byPath.get('/redirect')?.redirectChain.length, 2);
    assert.equal(byPath.get('/redirect-chain-a')?.classification, 'redirected');
    assert.equal(byPath.get('/redirect-chain-a')?.redirectChain.length, 3);
    assert.deepEqual(byPath.get('/redirect-chain-a')?.redirectChain.map((hop) => hop.status), [301, 302, 200]);
    assert.equal(byPath.get('/loop-a')?.classification, 'network_error');
    assert.equal(byPath.get('/incidental')?.classification, 'ok');
    assert.equal(byPath.get('/blocked')?.classification, 'blocked');
    assert.equal(byPath.get('/server-error')?.classification, 'server_error');
    assert.equal(byPath.get('/retry-429')?.classification, 'ok');
    assert.equal(byPath.get('/retry-500')?.classification, 'ok');
    assert.equal(fixture.requestCount('/retry-429'), 2);
    assert.equal(fixture.requestCount('/retry-500'), 2);

    for (const file of ['report.xlsx', 'findings.csv', 'all-urls.csv', 'backlinks.csv', 'run.json']) {
      assert.ok((await stat(join(completed.outputDir, file))).size > 0, `${file} should be populated`);
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(completed.outputDir, 'report.xlsx'));
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Summary', 'Broken & Soft 404', 'All URLs', 'Backlinks', 'Sources & Run Info']);
    assert.equal(workbook.getWorksheet('All URLs')?.rowCount, paths.length + 1);
    assert.equal(workbook.getWorksheet('Broken & Soft 404')?.rowCount, 7);
    assert.equal(workbook.getWorksheet('Backlinks')?.rowCount, 1);
    assert.match(String(workbook.getWorksheet('Summary')?.getCell('B9').formula), /COUNTIF/);
    assert.ok(workbook.getWorksheet('All URLs')?.getCell('A2').hyperlink);

    const allCsv = await readFile(join(completed.outputDir, 'all-urls.csv'), 'utf8');
    const findingsCsv = await readFile(join(completed.outputDir, 'findings.csv'), 'utf8');
    const backlinksCsv = await readFile(join(completed.outputDir, 'backlinks.csv'), 'utf8');
    assert.equal(parse(allCsv).length, paths.length + 1);
    assert.equal(parse(findingsCsv).length, 7);
    assert.equal(parse(backlinksCsv).length, 1);
    const run = JSON.parse(await readFile(join(completed.outputDir, 'run.json'), 'utf8'));
    assert.equal(run.scan.processed, paths.length);
    assert.equal(run.counts.hard_404, 1);
    assert.equal(run.counts.soft_404_suspected, 4);
  } finally {
    service.close();
    await fixture.close();
  }
});

test('classifies slow navigation and TLS failures without aborting the run', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-network-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  try {
    const tlsUrl = fixture.origin.replace('http://', 'https://') + '/ok';
    const scan = service.createScan({
      urls: [`${fixture.origin}/slow`, tlsUrl],
      discovery: ['import'],
      outputDir: join(directory, 'runs'),
      concurrency: 2,
      perHostConcurrency: 2,
      hostDelayMs: 0,
      timeoutMs: 100,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    const results = service.results(scan.id, 0, 10).items.map((candidate) => candidate.result!);
    assert.equal(results.find((result) => result.normalizedUrl.endsWith('/slow'))?.classification, 'timeout');
    assert.equal(results.find((result) => result.normalizedUrl.startsWith('https://'))?.classification, 'network_error');
    assert.equal(fixture.requestCount('/slow'), 2, 'Transient navigation failures are retried once');
  } finally {
    service.close();
    await fixture.close();
  }
});

test('enforces per-host concurrency and delay while global workers remain parallel', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-host-limit-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  try {
    const scan = service.createScan({
      urls: Array.from({ length: 4 }, (_, index) => `${fixture.origin}/paced?case=${index}`),
      discovery: ['import'],
      outputDir: join(directory, 'runs'),
      concurrency: 4,
      perHostConcurrency: 2,
      hostDelayMs: 70,
      timeoutMs: 4_000,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.processed, 4);
    assert.ok(fixture.maxConcurrentPacedRequests() <= 2);
    const times = fixture.pacedRequestTimes();
    assert.equal(times.length, 4);
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index]! - times[index - 1]! >= 50, `Requests ${index} and ${index + 1} started too closely`);
    }
  } finally {
    service.close();
    await fixture.close();
  }
});

test('a client-rendered site is read after it renders, not while it is still a navigation shell', async () => {
  // Mirrors a real ordering-platform restaurant site: every URL first serves the same large
  // navigation/footer shell plus inline script source, and the page content arrives ~1 s later.
  const nav = Array.from({ length: 12 }, (_, index) => `<a href="/p${index}">Section ${index} of our restaurant</a>`).join(' ');
  const footer = '<footer>6 Langley Road, Abbots Langley. Open every day for dine-in, takeaway and delivery. Follow us on social media for offers and seasonal specials.</footer>';
  const inlineScript = `<script>/* ${'var config = { analytics: true, theme: "dark" }; '.repeat(20)} */</script>`;
  const real: Record<string, string> = { '/': 'Welcome to our tandoori kitchen, cooking since 1998.', '/menu': 'Papadam, chutneys, lamb biryani, chicken tikka masala and garlic naan.', '/awards': 'Regional chef of the year and a Good Food Award winner.' };
  // Identical HTML for every URL, as a client-side router serves it; content comes from an API.
  const late = `<script>fetch('/__content' + location.pathname).then((r) => r.json()).then((page) => { document.title = page.title; document.querySelector('#app').textContent = page.text; })</script>`;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path.startsWith('/__content')) {
      const route = path.slice('/__content'.length) || '/';
      const text = real[route] ?? '404 Looks like you are lost. The page you are looking for is not available!';
      setTimeout(() => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ title: 'Tandoori House', text })); }, 900);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title></title><nav>${nav}</nav>${inlineScript}<div id="app"></div>${footer}${late}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Late-render fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'seo404-late-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  try {
    const scan = service.createScan({
      urls: ['/menu', '/awards', '/christmas-menu-2019'].map((path) => origin + path), discovery: ['import'],
      outputDir: join(directory, 'runs'), hostDelayMs: 0, timeoutMs: 15_000, failOn: 'none',
    });
    await service.start(scan.id);
    const verdicts = Object.fromEntries(service.results(scan.id, 0, 10).items.map((item) => [new URL(item.normalizedUrl).pathname, item.result!.classification]));
    assert.deepEqual(verdicts, { '/menu': 'ok', '/awards': 'ok', '/christmas-menu-2019': 'soft_404_suspected' });
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
