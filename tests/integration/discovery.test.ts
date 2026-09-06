import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { discoverCrawl } from '../../src/discovery/crawl.js';
import { discoverBacklinks } from '../../src/discovery/backlinks.js';
import { discoverSearchApi } from '../../src/discovery/searchapi.js';
import { discoverSitemaps } from '../../src/discovery/sitemap.js';
import { RobotsCache } from '../../src/robots.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('sitemap discovery reads robots, nested indexes, gzip, and same-site URLs', async () => {
  const fixture = await startFixtureSite();
  try {
    const result = await discoverSitemaps(fixture.origin, new RobotsCache(), [`${fixture.origin}/sitemap-index.xml`]);
    const paths = result.urls.map((item) => new URL(item.url).pathname).sort();
    assert.deepEqual(paths, ['/gone', '/hard', '/ok']);
    assert.ok(result.sitemapUrls.some((url) => url.endsWith('/nested.xml.gz')));
  } finally {
    await fixture.close();
  }
});

test('rendered crawl finds same-site links but does not visit robots-disallowed paths', async () => {
  const fixture = await startFixtureSite();
  try {
    const result = await discoverCrawl(fixture.origin, new RobotsCache(), 20, 4_000);
    const paths = new Set(result.urls.map((item) => new URL(item.url).pathname));
    assert.ok(paths.has('/ok'));
    assert.ok(paths.has('/hard'));
    assert.ok(paths.has('/private'), 'The link remains evidence even though it is not followed');
    assert.ok(result.visitedPages >= 4);
    assert.equal(fixture.requestCount('/private'), 0, 'robots-disallowed links are retained but never crawled');

    const capped = await discoverCrawl(fixture.origin, new RobotsCache(), 2, 4_000);
    assert.equal(capped.visitedPages, 2);
    assert.match(capped.warnings.join(' '), /configured 2 page limit/);
  } finally {
    await fixture.close();
  }
});

test('SearchApi adapter reports missing credentials and provider quota errors', async () => {
  const previousKey = process.env.SEARCHAPI_API_KEY;
  delete process.env.SEARCHAPI_API_KEY;
  await assert.rejects(() => discoverSearchApi('https://example.com'), /SEARCHAPI_API_KEY is required/);

  const server = createServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'monthly quota exceeded' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock SearchApi did not bind');
  process.env.SEARCHAPI_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
  try {
    await assert.rejects(() => discoverSearchApi('https://example.com', 'test-key'), /monthly quota exceeded/);
  } finally {
    if (previousKey) process.env.SEARCHAPI_API_KEY = previousKey;
    else delete process.env.SEARCHAPI_API_KEY;
    delete process.env.SEARCHAPI_ENDPOINT;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('SearchApi adapter preserves result evidence and filters external domains', async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    assert.equal(url.searchParams.get('q'), 'site:example.com');
    assert.equal(url.searchParams.get('num'), '100');
    assert.equal(url.searchParams.get('api_key'), null);
    assert.equal(request.headers.authorization, 'Bearer test-key');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ organic_results: [
      { position: 3, link: 'https://www.example.com/old-menu', title: 'Old menu', snippet: 'Cached listing' },
      { position: 4, link: 'https://external.example/not-ours', title: 'External' },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock SearchApi did not bind');
  process.env.SEARCHAPI_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
  try {
    const result = await discoverSearchApi('https://example.com', 'test-key');
    assert.equal(result.urls.length, 1);
    assert.equal(result.urls[0]?.evidence.position, 3);
    assert.equal(result.urls[0]?.evidence.query, 'site:example.com');
    assert.match(result.coverageNote, /100/);
  } finally {
    delete process.env.SEARCHAPI_ENDPOINT;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('DataForSEO backlink adapter paginates, preserves evidence, and filters target URLs to the restaurant site', async () => {
  const previous = {
    endpoint: process.env.DATAFORSEO_BACKLINKS_ENDPOINT,
    login: process.env.DATAFORSEO_LOGIN,
    password: process.env.DATAFORSEO_PASSWORD,
  };
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls += 1;
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('api-login:api-password').toString('base64')}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const task = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Array<Record<string, unknown>>)[0]!;
    assert.equal(task.target, 'example.com');
    assert.equal(task.mode, 'as_is');
    assert.equal(task.backlinks_status_type, 'all');
    assert.equal(task.limit, 3);
    if (calls === 1) assert.equal(task.search_after_token, undefined);
    else assert.equal(task.search_after_token, 'next-page');
    const items = calls === 1 ? [
      backlinkItem('https://blog.example.net/review', 'https://www.example.com/old-menu', 'Old menu'),
      backlinkItem('https://social.example.net/post', 'https://www.example.com/missing-offer', '=SUM(1,1)'),
      backlinkItem('https://external.example.net/post', 'https://unrelated.example/page', 'External'),
    ] : [
      { ...backlinkItem('https://directory.example.net/listing', 'https://example.com/contact', 'Contact'), is_lost: true },
    ];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status_code: 20000, status_message: 'Ok.', cost: 0.02,
      tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{
        total_count: 4, items_count: items.length, items,
        search_after_token: calls === 1 ? 'next-page' : null,
      }] }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock DataForSEO did not bind');
  process.env.DATAFORSEO_BACKLINKS_ENDPOINT = `http://127.0.0.1:${address.port}/backlinks`;
  process.env.DATAFORSEO_LOGIN = 'api-login';
  process.env.DATAFORSEO_PASSWORD = 'api-password';
  try {
    const result = await discoverBacklinks('https://www.example.com', 3);
    assert.equal(calls, 2);
    assert.equal(result.backlinks.length, 3);
    assert.equal(result.candidates.length, 3);
    assert.equal(result.totalAvailable, 4);
    assert.equal(result.truncated, true);
    assert.equal(result.costUsd, 0.04);
    assert.equal(result.backlinks.at(-1)?.isLost, true);
    assert.equal(result.candidates[0]?.evidence.source, 'backlinks');
    assert.match(result.coverageNote, /3 of 4/);
  } finally {
    restoreEnv('DATAFORSEO_BACKLINKS_ENDPOINT', previous.endpoint);
    restoreEnv('DATAFORSEO_LOGIN', previous.login);
    restoreEnv('DATAFORSEO_PASSWORD', previous.password);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('DataForSEO backlink adapter rejects missing credentials before making a request', async () => {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
  try {
    await assert.rejects(() => discoverBacklinks('https://example.com', 100), /DATAFORSEO_LOGIN.*DATAFORSEO_PASSWORD/);
  } finally {
    restoreEnv('DATAFORSEO_LOGIN', login);
    restoreEnv('DATAFORSEO_PASSWORD', password);
  }
});

function backlinkItem(sourceUrl: string, targetUrl: string, anchor: string): Record<string, unknown> {
  return {
    domain_from: new URL(sourceUrl).hostname,
    url_from: sourceUrl,
    url_to: targetUrl,
    page_from_title: 'Referring page',
    page_from_status_code: 200,
    url_to_status_code: 404,
    anchor,
    dofollow: true,
    item_type: 'anchor',
    is_new: false,
    is_lost: false,
    is_broken: true,
    rank: 42,
    domain_from_rank: 55,
    backlink_spam_score: 3,
    first_seen: '2025-01-01 00:00:00 +00:00',
    last_seen: '2026-08-25 00:00:00 +00:00',
    links_count: 1,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
