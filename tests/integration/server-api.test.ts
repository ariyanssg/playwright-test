import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('localhost API validates requests, secures responses, streams progress, filters results, and downloads artifacts', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-api-'));
  process.env.SEO404_DATA_DIR = directory;
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'api-test-secret';
  process.env.SEARCHAPI_API_KEY = 'search-key';
  process.env.DATAFORSEO_LOGIN = 'backlink-login';
  process.env.DATAFORSEO_PASSWORD = 'backlink-password';
  const service = new ScanService(join(directory, 'api.sqlite'));
  service.google.listProperties = async () => [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }];
  const dashboard = await startDashboard(service, 0);
  try {
    const health = await fetch(`${dashboard.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.match(health.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal((await health.json() as { ok: boolean }).ok, true);
    const providers = await fetch(`${dashboard.url}/api/providers/status`).then((response) => response.json()) as Record<string, unknown>;
    assert.deepEqual(providers, { searchApi: true, dataForSeo: true, googleMaps: false });
    assert.doesNotMatch(JSON.stringify(providers), /search-key|backlink-login|backlink-password/);

    const googleStatus = await fetch(`${dashboard.url}/api/auth/google/status`).then((response) => response.json()) as { configured: boolean; authenticated: boolean };
    assert.deepEqual(googleStatus, { configured: true, authenticated: false });
    const properties = await fetch(`${dashboard.url}/api/google/properties`).then((response) => response.json()) as { properties: Array<{ siteUrl: string }> };
    assert.equal(properties.properties[0]?.siteUrl, 'sc-domain:example.com');
    const authStart = await fetch(`${dashboard.url}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(authStart.status, 302);
    assert.match(authStart.headers.get('location') ?? '', /accounts\.google\.com/);
    assert.doesNotMatch(authStart.headers.get('location') ?? '', /api-test-secret/);
    const deniedCallback = await fetch(`${dashboard.url}/api/auth/google/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(deniedCallback.status, 400);

    const invalidJson = await fetch(`${dashboard.url}/api/scans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    assert.equal(invalidJson.status, 400);
    assert.match((await invalidJson.json() as { error: string }).error, /valid JSON/);

    const emptyScan = await fetch(`${dashboard.url}/api/scans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(emptyScan.status, 400);
    assert.match((await emptyScan.json() as { error: string }).error, /Provide at least one/);

    const badUpload = await fetch(`${dashboard.url}/api/uploads?filename=urls.exe`, { method: 'POST', body: 'https://example.com' });
    assert.equal(badUpload.status, 400);
    const upload = await fetch(`${dashboard.url}/api/uploads?filename=urls.txt`, { method: 'POST', body: `${fixture.origin}/ok\n` });
    assert.equal(upload.status, 201);
    const uploadPath = (await upload.json() as { path: string }).path;
    assert.equal((await stat(uploadPath)).mode & 0o777, 0o600);
    assert.equal((await fetch(`${dashboard.url}/api/scans/unknown-scan`)).status, 404);

    const create = await fetch(`${dashboard.url}/api/scans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls: [`${fixture.origin}/ok`, `${fixture.origin}/hard`], discovery: ['import'], outputDir: join(directory, 'runs'),
        concurrency: 2, perHostConcurrency: 2, hostDelayMs: 0, timeoutMs: 4_000, failOn: 'none',
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json() as { id: string };

    const events = await fetch(`${dashboard.url}/api/scans/${created.id}/events`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    const eventReader = events.body!.getReader();
    const firstEvent = await eventReader.read();
    assert.match(new TextDecoder().decode(firstEvent.value), /"message":"Connected"/);
    await eventReader.cancel();

    const completed = await waitForScan(dashboard.url, created.id, ['completed']);
    assert.equal(completed.scan.processed, 2);
    assert.equal(completed.counts.ok, 1);
    assert.equal(completed.counts.hard_404, 1);
    assert.equal(completed.sourceCounts.import, 2);
    assert.equal(completed.backlinkCount, 0);

    const filtered = await fetch(`${dashboard.url}/api/scans/${created.id}/results?classification=hard_404&limit=1`).then((response) => response.json()) as {
      total: number; items: Array<{ result: { classification: string; httpStatus: number } }>;
    };
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0]?.result.classification, 'hard_404');
    assert.equal(filtered.items[0]?.result.httpStatus, 404);

    const report = await fetch(`${dashboard.url}/api/scans/${created.id}/artifacts/report.xlsx`);
    assert.equal(report.status, 200);
    assert.match(report.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.match(report.headers.get('content-disposition') ?? '', /report\.xlsx/);
    assert.ok((await report.arrayBuffer()).byteLength > 1_000);
    assert.equal((await fetch(`${dashboard.url}/api/scans/${created.id}/artifacts/secrets.txt`)).status, 404);
  } finally {
    await dashboard.close();
    service.close();
    await fixture.close();
    delete process.env.SEO404_DATA_DIR;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.SEARCHAPI_API_KEY;
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
  }
});

test('localhost API cancels an active scan, writes partial artifacts, and resumes it to completion', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-api-resume-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'api.sqlite'));
  const dashboard = await startDashboard(service, 0);
  try {
    const create = await fetch(`${dashboard.url}/api/scans`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        urls: Array.from({ length: 4 }, (_, index) => `${fixture.origin}/slow?api=${index}`),
        discovery: ['import'], outputDir: join(directory, 'runs'), concurrency: 1, perHostConcurrency: 1,
        hostDelayMs: 0, timeoutMs: 3_000, failOn: 'none',
      }),
    });
    const created = await create.json() as { id: string };
    await waitUntil(dashboard.url, created.id, (summary) => summary.scan.processed >= 1);
    assert.equal((await fetch(`${dashboard.url}/api/scans/${created.id}/cancel`, { method: 'POST' })).status, 202);
    const cancelled = await waitForScan(dashboard.url, created.id, ['cancelled']);
    assert.ok(cancelled.scan.processed >= 1 && cancelled.scan.processed < 4);
    assert.ok(cancelled.artifacts.includes('report.xlsx'));

    assert.equal((await fetch(`${dashboard.url}/api/scans/${created.id}/resume`, { method: 'POST' })).status, 202);
    const completed = await waitForScan(dashboard.url, created.id, ['completed']);
    assert.equal(completed.scan.processed, 4);
    assert.equal(completed.counts.ok, 4);
  } finally {
    await dashboard.close();
    service.close();
    await fixture.close();
    delete process.env.SEO404_DATA_DIR;
  }
});

interface ApiSummary {
  scan: { status: string; processed: number };
  counts: Record<string, number>;
  sourceCounts: Record<string, number>;
  backlinkCount: number;
  artifacts: string[];
}

async function waitForScan(baseUrl: string, scanId: string, statuses: string[]): Promise<ApiSummary> {
  return waitUntil(baseUrl, scanId, (summary) => statuses.includes(summary.scan.status));
}

async function waitUntil(baseUrl: string, scanId: string, predicate: (summary: ApiSummary) => boolean): Promise<ApiSummary> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/scans/${scanId}`);
    const summary = await response.json() as ApiSummary;
    if (predicate(summary)) return summary;
    if (summary.scan.status === 'failed') throw new Error(`Scan ${scanId} failed`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for scan ${scanId}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
