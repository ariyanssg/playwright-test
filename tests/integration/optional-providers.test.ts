import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { ScanService } from '../../src/service.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('optional discovery provider failures become visible warnings without failing the local scan', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-optional-providers-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previousKey = process.env.SEARCHAPI_API_KEY;
  const previousBacklinkLogin = process.env.DATAFORSEO_LOGIN;
  const previousBacklinkPassword = process.env.DATAFORSEO_PASSWORD;
  delete process.env.SEARCHAPI_API_KEY;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  service.google.discover = async () => { throw new Error('invalid Google credentials'); };
  try {
    const scan = service.createScan({
      sites: [fixture.origin],
      discovery: ['gsc', 'searchapi', 'backlinks'],
      outputDir: join(directory, 'runs'),
      concurrency: 1,
      perHostConcurrency: 1,
      hostDelayMs: 0,
      timeoutMs: 4_000,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed_partial');
    assert.equal(completed.processed, 1, 'The submitted site root remains usable without providers');
    assert.match(completed.warnings.join('\n'), /gsc .*invalid Google credentials/);
    assert.match(completed.warnings.join('\n'), /Google discovery incomplete .*SEARCHAPI_API_KEY is required/);
    assert.match(completed.warnings.join('\n'), /backlinks .*DATAFORSEO_LOGIN.*DATAFORSEO_PASSWORD/);
  } finally {
    if (previousKey) process.env.SEARCHAPI_API_KEY = previousKey;
    else delete process.env.SEARCHAPI_API_KEY;
    if (previousBacklinkLogin) process.env.DATAFORSEO_LOGIN = previousBacklinkLogin;
    else delete process.env.DATAFORSEO_LOGIN;
    if (previousBacklinkPassword) process.env.DATAFORSEO_PASSWORD = previousBacklinkPassword;
    else delete process.env.DATAFORSEO_PASSWORD;
    service.close();
    await fixture.close();
  }
});

test('backlink targets are persisted, live-verified, and reconciled across CSV, JSON, and XLSX reports', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-backlink-scan-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previous = {
    endpoint: process.env.DATAFORSEO_BACKLINKS_ENDPOINT,
    login: process.env.DATAFORSEO_LOGIN,
    password: process.env.DATAFORSEO_PASSWORD,
  };
  const provider = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('login:password').toString('base64')}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const task = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Array<{ backlinks_status_type: string }>)[0]!;
    assert.equal(task.backlinks_status_type, 'all');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status_code: 20000, status_message: 'Ok.', cost: 0.01,
      tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ total_count: 2, items_count: 2, items: [
        providerItem('https://directory.example/listing', `${fixture.origin}/hard`, '=BROKEN'),
        providerItem('https://social.example/post', `${fixture.origin}/ok`, 'Menu'),
      ], search_after_token: null }] }],
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Mock backlink provider did not bind');
  process.env.DATAFORSEO_BACKLINKS_ENDPOINT = `http://127.0.0.1:${address.port}/backlinks`;
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';
  try {
    const scan = service.createScan({
      sites: [fixture.origin],
      discovery: ['backlinks'],
      backlinkLimit: 100,
      outputDir: join(directory, 'runs'),
      concurrency: 2,
      perHostConcurrency: 2,
      hostDelayMs: 0,
      timeoutMs: 4_000,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.processed, 3, 'site root plus both unique backlink targets are verified');
    assert.equal(service.db.backlinkCount(scan.id), 2);
    const targets = service.results(scan.id, 0, 10).items.map((candidate) => candidate.result!);
    assert.equal(targets.find((result) => result.normalizedUrl.endsWith('/hard'))?.classification, 'hard_404');
    assert.equal(targets.find((result) => result.normalizedUrl.endsWith('/ok'))?.classification, 'ok');

    const backlinksCsv = parse(await readFile(join(completed.outputDir, 'backlinks.csv'), 'utf8')) as string[][];
    assert.equal(backlinksCsv.length, 3);
    assert.equal(backlinksCsv[1]?.[1], 'hard_404');
    assert.match(backlinksCsv[1]?.[6] ?? '', /^'/, 'formula-looking anchor text is neutralized');
    const run = JSON.parse(await readFile(join(completed.outputDir, 'run.json'), 'utf8')) as { backlinks: unknown[] };
    assert.equal(run.backlinks.length, 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(completed.outputDir, 'report.xlsx'));
    assert.equal(workbook.getWorksheet('Backlinks')?.rowCount, 3);
    assert.equal(workbook.getWorksheet('Backlinks')?.getCell('B2').value, 'hard_404');
    assert.ok(workbook.getWorksheet('Backlinks')?.getCell('D2').hyperlink);
  } finally {
    service.close();
    await fixture.close();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    restore('DATAFORSEO_BACKLINKS_ENDPOINT', previous.endpoint);
    restore('DATAFORSEO_LOGIN', previous.login);
    restore('DATAFORSEO_PASSWORD', previous.password);
  }
});

test('URL Inspection runs only for actionable findings and persists evidence separately from live status', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-inspection-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const inspected: string[] = [];
  service.google.inspect = async (url) => {
    inspected.push(url);
    return {
      property: 'sc-domain:example.com',
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      googleCanonical: url,
    };
  };
  try {
    const scan = service.createScan({
      urls: [`${fixture.origin}/ok`, `${fixture.origin}/hard`, `${fixture.origin}/soft`],
      discovery: ['import'],
      outputDir: join(directory, 'runs'),
      concurrency: 2,
      perHostConcurrency: 2,
      hostDelayMs: 0,
      timeoutMs: 4_000,
      inspectGoogle: true,
      failOn: 'none',
    });
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(inspected.map((url) => new URL(url).pathname).sort(), ['/hard', '/soft']);
    const results = service.results(scan.id, 0, 10).items.map((candidate) => candidate.result!);
    assert.equal(results.find((result) => result.normalizedUrl.endsWith('/ok'))?.gsc, undefined);
    assert.equal(results.find((result) => result.normalizedUrl.endsWith('/hard'))?.gsc?.verdict, 'PASS');
    assert.equal(results.find((result) => result.normalizedUrl.endsWith('/hard'))?.httpStatus, 404);
  } finally {
    service.close();
    await fixture.close();
  }
});

function providerItem(sourceUrl: string, targetUrl: string, anchor: string): Record<string, unknown> {
  return {
    domain_from: new URL(sourceUrl).hostname, url_from: sourceUrl, url_to: targetUrl,
    page_from_title: 'Restaurant listing', page_from_status_code: 200, url_to_status_code: 404,
    anchor, dofollow: true, item_type: 'anchor', is_new: false, is_lost: false, is_broken: true,
    rank: 50, domain_from_rank: 60, backlink_spam_score: 1,
    first_seen: '2025-01-01 00:00:00 +00:00', last_seen: '2026-08-25 00:00:00 +00:00', links_count: 1,
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
