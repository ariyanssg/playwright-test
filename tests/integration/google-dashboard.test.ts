import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import { GoogleChallengeError, googleSearchUrl } from '../../src/discovery/google-results.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('Google dashboard defaults, browser prompt Continue, coverage, and evidence work on desktop and mobile', async () => {
  const site = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'signal404-google-ui-'));
  let challenge = true;
  const service = new ScanService(join(directory, 'scan.sqlite'), {
    searchapi: async () => { throw new Error('API must not run'); },
    browser: () => ({
      fetchPage: async (request) => {
        if (request.query.endsWith(' 404') && challenge) throw new GoogleChallengeError('Resolve the Google prompt, then Continue.');
        return { results: request.query.includes(' ') ? [] : [{ url: `${site.origin}/error-template`, title: 'Restaurant 404 Error Page', snippet: '404 Not Found', kind: 'organic', position: 1 }], hasNext: false, searchUrl: googleSearchUrl(request) };
      },
      close: async () => {},
    }),
  });
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch({ headless: true });
  let scanId: string | undefined;
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${dashboard.url}/#new-audit`);
    await page.locator('#google-provider').selectOption('browser');
    assert.deepEqual(await page.locator('[name="discovery"]:checked').evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value)), ['google']);
    assert.equal(await page.locator('#google-country').inputValue(), 'gb');
    assert.equal(await page.locator('#google-max-pages').inputValue(), '50');
    await page.locator('#sites').fill(site.origin);
    await page.locator('#start-button').click();
    await page.locator('#run-status').filter({ hasText: 'Waiting for Google' }).waitFor();
    scanId = service.listScans()[0]!.id;
    assert.equal(service.getScan(scanId)!.total, 1);
    await page.locator('#resume-run').filter({ hasText: 'Continue' }).waitFor();
    challenge = false;
    await page.locator('#resume-run').click();
    await page.locator('#run-status').filter({ hasText: 'Completed' }).waitFor({ timeout: 20_000 });
    await page.locator('#results-body button[data-evidence]').waitFor();
    assert.equal(await page.locator('#metric-total').innerText(), '1');
    assert.equal(await page.locator('#metric-findings').innerText(), '1');
    assert.match(await page.locator('#google-coverage').innerText(), /5 search pages/);
    await page.locator('[data-evidence="0"]').click();
    assert.match(await page.locator('#evidence-content').innerText(), /Google · browser/);
    assert.match(await page.locator('#evidence-content').innerText(), /404 Not Found/);
    assert.equal(await page.locator('#evidence-content a[href*="google.com/search"]').count(), 1);
    await page.locator('#close-evidence').click();
    const screenshots = resolve('output/playwright');
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, 'google-audit-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(screenshots, 'google-audit-mobile.png'), fullPage: true });
    await page.goto(`${dashboard.url}/#new-audit`);
    await page.locator('#google-settings:not(.hidden)').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(screenshots, 'google-setup-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    if (scanId && service.getScan(scanId)?.status === 'waiting_for_google') { service.cancel(scanId); await service.start(scanId); }
    await browser.close(); await dashboard.close(); service.close(); await site.close();
  }
});
