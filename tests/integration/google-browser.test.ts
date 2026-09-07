import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { GoogleBrowser, readGoogleResults } from '../../src/discovery/google-browser.js';
import { directGoogleDestination, GoogleChallengeError } from '../../src/discovery/google-results.js';

const request = { query: 'site:example.com 404', page: 1, country: 'gb', language: 'en' };

test('Google browser reads organic cards and sitelinks, resolves opaque links, and preserves the first website URL', async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  let websiteRequests = 0;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/goto') {
      return route.fulfill({ status: 302, headers: { location: 'https://www.example.com/old-menu?version=2#top' } });
    }
    if (url.hostname.endsWith('example.com')) { websiteRequests++; return route.fulfill({ status: 302, headers: { location: 'https://www.example.com/new-menu' } }); }
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <a href="https://www.example.com/outside">Navigation</a>
      <div id="search">
        <div id="tads"><div class="g"><a href="https://www.example.com/ad"><h3>Ad</h3></a></div></div>
        <div class="g"><a href="/goto?url=opaque"><h3>Old menu</h3></a><div class="VwiC3b">The old menu result.</div>
          <a href="https://www.example.com/menu.pdf">PDF menu</a>
          <a href="/search?q=other">Search tools</a>
          <a href="javascript:alert(1)">Unsafe</a>
        </div>
        <div class="g"><a href="/url?q=https%3A%2F%2Fexample.com%2Fmissing%3Fx%3D1"><h3>Missing page</h3></a></div>
        <div id="rhs"><div class="g"><a href="https://www.example.com/knowledge"><h3>Knowledge panel</h3></a></div></div>
        <a id="pnnext" href="/search?q=site%3Aexample.com%20404&start=10">Next</a>
      </div></body></html>` });
  });
  const browser = new GoogleBrowser({ delayMs: 0, createContext: async () => context });
  try {
    const page = await browser.fetchPage(request);
    assert.deepEqual(page.results.map((result) => result.url), [
      'https://www.example.com/old-menu?version=2', 'https://www.example.com/menu.pdf', 'https://example.com/missing?x=1',
    ]);
    assert.equal(page.results[1]!.kind, 'sitelink');
    assert.equal(page.results[0]!.snippet, 'The old menu result.');
    assert.equal(page.warnings!.length, 0);
    assert.equal(websiteRequests, 0, 'Discovery records the first destination without following website redirects');
    assert.equal(page.hasNext, true);
    assert.equal(new URL(page.nextUrl!).searchParams.get('gl'), 'gb');
  } finally { await browser.close(); await chromiumBrowser.close(); }
});

test('Google browser detects a challenge, continues in the same tab, and recognizes explicit empty searches', async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  let challenged = true, loads = 0;
  await context.route('**/*', async (route) => {
    loads++;
    await route.fulfill({ contentType: 'text/html', body: challenged
      ? '<form id="captcha-form">Our systems have detected unusual traffic</form>'
      : '<div id="search">Your search did not match any documents.</div>' });
  });
  const browser = new GoogleBrowser({ delayMs: 0, createContext: async () => context });
  try {
    await assert.rejects(browser.fetchPage(request), GoogleChallengeError);
    challenged = false;
    await context.pages()[0]!.reload(); // emulate the user completing Google's prompt
    const before = loads;
    const page = await browser.fetchPage(request);
    assert.equal(loads, before, 'Continue must inspect the resolved tab instead of replacing it');
    assert.equal(page.results.length, 0);
    assert.equal(page.hasNext, false);
  } finally { await browser.close(); await chromiumBrowser.close(); }
});

test('Unknown markup is a failure rather than a successful empty Google search', async () => {
  const chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext();
  await context.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="search">Something changed</div>' }));
  const browser = new GoogleBrowser({ delayMs: 0, createContext: async () => context });
  try { await assert.rejects(browser.fetchPage(request), /could not be recognized/); }
  finally { await browser.close(); await chromiumBrowser.close(); }
});

test('Browser result parsing does not claim arbitrary website anchors or Google links as results', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent('<main><a href="https://example.com/guess">A website link</a></main>');
    assert.equal((await readGoogleResults(page)).links.length, 0);
    assert.equal(directGoogleDestination('/search?q=example'), null);
    assert.equal(directGoogleDestination('/goto?url=opaque'), null);
    assert.equal(directGoogleDestination('javascript:alert(1)'), null);
    assert.equal(directGoogleDestination('/url?q=https%3A%2F%2Fexample.com%2Fmenu%3Fx%3D2%23top'), 'https://example.com/menu?x=2');
  } finally { await browser.close(); }
});
