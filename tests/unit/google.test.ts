import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { google, type Auth } from 'googleapis';
import { GoogleSearchConsole, type GoogleProperty } from '../../src/google.js';

class TestSearchConsole extends GoogleSearchConsole {
  constructor(private readonly properties: GoogleProperty[]) { super('/tmp/unused-google-token.json'); }
  override async listProperties(_auth?: Auth.OAuth2Client): Promise<GoogleProperty[]> { return this.properties; }
}

test('Search Console property matching prefers exact domain properties and longest URL prefixes', async () => {
  const domain = new TestSearchConsole([
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  ]);
  assert.equal(await domain.matchProperty('https://www.example.com/menu'), 'sc-domain:example.com');

  const prefix = new TestSearchConsole([
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/restaurant/', permissionLevel: 'siteOwner' },
  ]);
  assert.equal(await prefix.matchProperty('https://www.example.com/restaurant/menu'), 'https://www.example.com/restaurant/');
  assert.equal(await prefix.matchProperty('https://other.example.net/'), null);
});

test('OAuth authorization URL uses readonly Search Console scope without exposing the client secret', () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'super-secret-value';
  try {
    const service = new GoogleSearchConsole('/tmp/unused-google-token.json');
    const url = service.authUrl('http://127.0.0.1:4174/oauth2/callback');
    assert.match(url, /webmasters\.readonly/);
    assert.match(url, /access_type=offline/);
    assert.doesNotMatch(url, /super-secret-value/);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test('OAuth state is single-use and token status rejects corrupt credential files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-google-state-'));
  const tokenPath = join(directory, 'google-token.json');
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  try {
    const service = new GoogleSearchConsole(tokenPath);
    const auth = service.beginAuth('http://127.0.0.1:4174/oauth2/callback');
    assert.match(auth.url, new RegExp(encodeURIComponent(auth.state)));
    assert.equal(service.consumeAuthState(auth.state), true);
    assert.equal(service.consumeAuthState(auth.state), false);

    await writeFile(tokenPath, '{not valid JSON', { mode: 0o600 });
    assert.equal(await service.authenticated(), false);
    await writeFile(tokenPath, '{}', { mode: 0o600 });
    assert.equal(await service.authenticated(), false);
    await writeFile(tokenPath, JSON.stringify({ refresh_token: 'refresh-value' }), { mode: 0o600 });
    assert.equal(await service.authenticated(), true);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test('token refresh preserves the refresh token and enforces owner-only file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-google-token-'));
  const tokenPath = join(directory, 'nested', 'google-token.json');
  process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
  try {
    const service = new GoogleSearchConsole(tokenPath);
    const saveTokens = service as unknown as { mergeAndSaveTokens(tokens: Auth.Credentials): Promise<void> };
    await saveTokens.mergeAndSaveTokens({ refresh_token: 'keep-me', access_token: 'old-token' });
    await saveTokens.mergeAndSaveTokens({ access_token: 'new-token' });
    const client = await service.client();
    assert.equal(client.credentials.refresh_token, 'keep-me');
    assert.equal(client.credentials.access_token, 'new-token');
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

test('Search Console discovery paginates page evidence, filters other sites, and includes submitted sitemaps', async () => {
  const calls: number[] = [];
  const firstPage = Array.from({ length: 5_000 }, (_, index) => ({
    keys: [index === 4_999 ? 'https://outside.example/ignored' : `https://www.example.com/page-${index}`],
    clicks: index,
    impressions: index + 1,
    position: 2.5,
  }));
  const originalWebmasters = google.webmasters;
  (google as unknown as { webmasters: typeof google.webmasters }).webmasters = (() => ({
    searchanalytics: { query: async ({ requestBody }: { requestBody: { startRow: number } }) => {
      calls.push(requestBody.startRow);
      return { data: { rows: requestBody.startRow === 0 ? firstPage : [{ keys: ['https://www.example.com/final-page'], clicks: 4, impressions: 8, position: 3 }] } };
    } },
    sitemaps: { list: async () => ({ data: { sitemap: [{ path: 'https://www.example.com/sitemap.xml' }, {}] } }) },
  })) as typeof google.webmasters;
  class MockDiscoveryConsole extends TestSearchConsole {
    override async client(): Promise<Auth.OAuth2Client> { return {} as Auth.OAuth2Client; }
  }
  try {
    const service = new MockDiscoveryConsole([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]);
    const result = await service.discover('https://www.example.com/', 90);
    assert.deepEqual(calls, [0, 5_000]);
    assert.equal(result.property, 'sc-domain:example.com');
    assert.equal(result.urls.length, 5_000);
    assert.ok(result.urls.every((entry) => entry.url.startsWith('https://www.example.com/')));
    assert.deepEqual(result.sitemapUrls, ['https://www.example.com/sitemap.xml']);
    assert.equal(result.urls.at(-1)?.evidence.source, 'gsc');
  } finally {
    (google as unknown as { webmasters: typeof google.webmasters }).webmasters = originalWebmasters;
  }
});

test('Search Console surfaces quota failures and maps URL Inspection evidence', async () => {
  const originalWebmasters = google.webmasters;
  const originalSearchConsole = google.searchconsole;
  class MockApiConsole extends TestSearchConsole {
    override async client(): Promise<Auth.OAuth2Client> { return {} as Auth.OAuth2Client; }
  }
  try {
    (google as unknown as { webmasters: typeof google.webmasters }).webmasters = (() => ({
      searchanalytics: { query: async () => { throw new Error('quota exceeded'); } },
      sitemaps: { list: async () => ({ data: {} }) },
    })) as typeof google.webmasters;
    const service = new MockApiConsole([{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]);
    await assert.rejects(() => service.discover('https://example.com', 90), /quota exceeded/);

    (google as unknown as { searchconsole: typeof google.searchconsole }).searchconsole = (() => ({
      urlInspection: { index: { inspect: async () => ({ data: { inspectionResult: { indexStatusResult: {
        verdict: 'PASS', coverageState: 'Submitted and indexed', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED',
        pageFetchState: 'SUCCESSFUL', googleCanonical: 'https://example.com/menu', userCanonical: 'https://example.com/menu',
        lastCrawlTime: '2026-08-20T10:00:00Z', referringUrls: ['https://example.com/'],
      } } } }) } },
    })) as typeof google.searchconsole;
    const inspected = await service.inspect('https://example.com/menu#section');
    assert.equal(inspected.property, 'sc-domain:example.com');
    assert.equal(inspected.verdict, 'PASS');
    assert.equal(inspected.coverageState, 'Submitted and indexed');
    assert.deepEqual(inspected.referringUrls, ['https://example.com/']);
  } finally {
    (google as unknown as { webmasters: typeof google.webmasters }).webmasters = originalWebmasters;
    (google as unknown as { searchconsole: typeof google.searchconsole }).searchconsole = originalSearchConsole;
  }
});
