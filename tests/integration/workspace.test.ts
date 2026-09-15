import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import type { ScanResult } from '../../src/types.js';

// Persisted fixture data exercises the same API/SQLite path as real scans, at a
// scale that exposed the old 500-row client-side search and 50-audit history caps.
test('workspace routes, full-inventory search, pagination, evidence, and responsive navigation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-workspace-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'workspace.sqlite'));
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch();
  try {
    const scan = service.createScan({ urls: ['https://restaurant.example/'], discovery: ['import'], outputDir: join(directory, 'reports') });
    for (let index = 0; index < 511; index++) {
      const url = `https://restaurant.example/menu/${String(index).padStart(4, '0')}`;
      const candidate = { inputUrl: url, normalizedUrl: url, site: 'https://restaurant.example', sources: [{ source: 'import' as const }] };
      service.db.addCandidate(scan.id, candidate);
      const result: ScanResult = { ...candidate, httpStatus: index === 510 ? 404 : 200, finalUrl: url, redirectChain: [], classification: index === 510 ? 'hard_404' : 'ok', confidence: 1, reasons: [index === 510 ? 'A missing seasonal menu' : 'Successful rendered page'], robotsAllowed: true, title: index === 510 ? '<img src=x onerror=alert(1)> seasonal menu' : `Menu ${index}`, h1: 'Menu', canonical: null, contentType: 'text/html', responseMs: 50, checkedAt: new Date().toISOString(), error: null };
      service.db.saveResult(scan.id, result);
    }
    service.db.updateScan(scan.id, { status: 'completed', completedAt: new Date().toISOString() });
    for (let index = 0; index < 51; index++) {
      const older = service.createScan({ sites: [`https://history-${index}.example/`], discovery: ['import'], outputDir: join(directory, 'reports') });
      service.db.updateScan(older.id, { status: index % 2 ? 'completed' : 'cancelled' });
    }
    assert.equal(service.listScans().length, 52);
    const base = `${dashboard.url}/api/scans/${scan.id}/results`;
    const searched = await fetch(`${base}?search=SEASONAL&limit=25`).then((r) => r.json()) as { total: number; items: Array<{ normalizedUrl: string }> };
    assert.equal(searched.total, 1);
    assert.match(searched.items[0]!.normalizedUrl, /0510$/);
    assert.equal((await fetch(`${base}?offset=NaN`)).status, 400);
    assert.equal((await fetch(`${base}?limit=1.5`)).status, 400);
    assert.equal((await fetch(`${dashboard.url}/modules/api.js`)).status, 200);
    assert.equal((await fetch(`${dashboard.url}/modules/missing.js`)).status, 404);
    assert.equal((await fetch(`${dashboard.url}/modules/..%2F..%2Fconfig.ts`)).status, 404);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(dashboard.url);
    await page.waitForFunction(() => document.querySelector('#overview-audits')?.textContent === '52');
    assert.equal(await page.locator('.workspace-view:not(.hidden)').count(), 1);
    await page.locator('[data-view-link="new-audit"]').click();
    await page.locator('#sites').fill('https://example.com');
    await page.locator('[data-preset="local"]').click();
    assert.equal(await page.locator('[name="discovery"]:checked').count(), 3);
    assert.match(await page.locator('#brief-targets').innerText(), /1 site/);
    const file = join(directory, 'urls.txt'); await writeFile(file, 'https://example.com/menu');
    await page.locator('#files').setInputFiles(file);
    await page.locator('#clear-files').click();
    assert.equal(await page.locator('#files').evaluate((input: HTMLInputElement) => input.files?.length), 0);
    await page.locator('#reset-form').click();
    assert.equal(await page.locator('#sites').inputValue(), '');
    assert.equal(await page.locator('[name="discovery"]:checked').count(), 1);
    assert.equal(await page.locator('[name="discovery"][value="google"]').isChecked(), true);
    await page.goBack();
    await page.locator('#overview:not(.hidden)').waitFor();
    await page.goto(`${dashboard.url}/#audit-workspace?run=${encodeURIComponent(scan.id)}`);
    await page.locator('#result-count').filter({ hasText: '511' }).waitFor();
    assert.equal(await page.locator('#results-body tr').count(), 25);
    await page.locator('#next-page').click();
    await page.locator('#page-number').filter({ hasText: 'Page 2 of 21' }).waitFor();
    assert.match(await page.locator('#results-body tr').first().innerText(), /0025/);
    await page.locator('#result-search').fill('seasonal');
    await page.locator('#result-count').filter({ hasText: /^1$/ }).waitFor();
    assert.match(await page.locator('#results-body').innerText(), /0510/);
    assert.equal(await page.locator('#next-page').isDisabled(), true);
    await page.locator('[data-evidence]').click();
    await page.locator('#evidence-dialog[open]').waitFor();
    assert.match(await page.locator('#evidence-content').innerText(), /<img src=x onerror=alert\(1\)>/);
    assert.equal(await page.locator('#evidence-content img').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#evidence-dialog').isVisible(), false);
    assert.equal(await page.locator('[data-evidence]').evaluate((button) => button === document.activeElement), true);
    await page.locator('[data-evidence]').click();
    await page.evaluate(() => { location.hash = 'run-history'; });
    await page.locator('#run-history:not(.hidden)').waitFor();
    assert.equal(await page.locator('#evidence-dialog').isVisible(), false);
    await page.evaluate((id) => { location.hash = `audit-workspace?run=${id}`; }, scan.id);
    await page.locator('#audit-workspace:not(.hidden)').waitFor();
    await page.locator('#classification-filter').selectOption('ok');
    await page.locator('#results-body').filter({ hasText: 'No matching pages' }).waitFor();
    await page.locator('#result-search').fill('');
    await page.locator('#result-count').filter({ hasText: '510' }).waitFor();
    await page.locator('[data-view-link="run-history"]').click();
    await page.locator('#history-search').fill('history-50.example');
    assert.equal(await page.locator('#run-list .run-item').count(), 1);
    await page.locator('#history-filter').selectOption('completed');
    await page.locator('#run-list').filter({ hasText: 'No matching audits' }).waitFor();
    await page.locator('[data-view-link="connections"]').click();
    // Website discovery, Google search, Search Console, DataForSEO, Places, Business Profile.
    assert.equal(await page.locator('.provider-card').count(), 6);

    const screenshots = resolve('output/playwright'); await mkdir(screenshots, { recursive: true });
    for (const width of [1440, 1024, 820, 768, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const view of ['overview', 'new-audit', 'run-history', 'connections', `audit-workspace?run=${scan.id}`]) {
        await page.goto(`${dashboard.url}/#${view}`);
        await page.reload();
        await page.waitForFunction(() => document.querySelector('#overview-audits')?.textContent === '52');
        if (view.startsWith('audit-workspace')) await page.locator('#result-count').filter({ hasText: '511' }).waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        if (overflow) {
          console.log(await page.evaluate(() => ({inner: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth})));
          console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth && !el.closest('.table-wrap')).map((el) => ({ tag: el.tagName, class: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right }))));
          await page.screenshot({ path: join(screenshots, 'workspace-overflow.png'), fullPage: true });
        }
        assert.equal(overflow, false, `${view} overflows at ${width}px`);
        assert.equal(await page.locator('.workspace-view:not(.hidden)').count(), 1);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#menu-toggle').click();
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#menu-toggle').evaluate((button) => document.activeElement === button), true);
    await page.locator('#menu-toggle').click();
    await page.locator('[data-view-link="overview"]').click();
    await page.locator('#overview:not(.hidden)').waitFor();
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: join(screenshots, 'workspace-mobile-overview.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await dashboard.close(); service.close(); delete process.env.SEO404_DATA_DIR;
  }
});

test('workspace recovers from a failed load and ignores a stale audit response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-workspace-recovery-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'workspace.sqlite'));
  const first = service.createScan({ sites: ['https://first.example'], discovery: ['import'] });
  const second = service.createScan({ sites: ['https://second.example'], discovery: ['import'] });
  service.db.updateScan(first.id, { status: 'completed' });
  service.db.updateScan(second.id, { status: 'completed' });
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/api/scans', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Engine unavailable for test"}' }));
    await page.goto(dashboard.url);
    await page.locator('#app-error').filter({ hasText: 'Engine unavailable for test' }).waitFor();
    await page.unroute('**/api/scans');
    await page.locator('#retry-load').click();
    await page.locator('#overview-audits').filter({ hasText: '2' }).waitFor();
    assert.equal(await page.locator('#app-error').isVisible(), false);
    let release: (() => void) | undefined;
    const delay = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/scans/${first.id}`, async (route) => { const response = await route.fetch(); await delay; await route.fulfill({ response }); });
    await page.goto(`${dashboard.url}/#audit-workspace?run=${first.id}`);
    await page.locator('#run-target').filter({ hasText: 'Loading audit' }).waitFor();
    await page.evaluate((id) => { location.hash = `audit-workspace?run=${id}`; }, second.id);
    await page.locator('#run-target').filter({ hasText: 'second.example' }).waitFor();
    release!();
    // Wait for the deliberately delayed HTTP response, then let its microtasks render.
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.locator('#run-target').innerText(), 'second.example');
    assert.equal(await page.locator('#run-id').innerText(), second.id);
  } finally {
    await browser.close(); await dashboard.close(); service.close(); delete process.env.SEO404_DATA_DIR;
  }
});
