import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('dashboard starts a scan, shows findings, and exposes downloads', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-dashboard-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'dashboard.sqlite'));
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const screenshotDirectory = resolve(process.cwd(), 'output', 'playwright');
    await mkdir(screenshotDirectory, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${dashboard.url}/#new-audit`);
    await page.screenshot({ path: join(screenshotDirectory, 'dashboard-empty.png'), fullPage: true });
    assert.equal(await page.locator('input[name="discovery"][value="google"]').isChecked(), true);
    assert.equal(await page.locator('input[name="discovery"][value="backlinks"]').isChecked(), false);
    await page.locator('#start-button').click();
    await page.locator('#form-error').filter({ hasText: 'Add at least one' }).waitFor();

    const inputFile = join(directory, 'dashboard-input.txt');
    await writeFile(inputFile, `${fixture.origin}/ok\n`);
    await page.locator('#sites').fill(fixture.origin);
    await page.locator('#urls').fill(`${fixture.origin}/hard`);
    await page.locator('#files').setInputFiles(inputFile);
    await page.locator('[data-preset="import"]').click();
    await page.locator('input[name="discovery"][value="sitemap"]').uncheck();
    await page.locator('input[name="discovery"][value="crawl"]').uncheck();
    await page.locator('#start-button').click();
    await page.locator('#run-status').filter({ hasText: 'completed' }).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#metric-total').innerText(), '3');
    await page.locator('#result-search').fill('/hard');
    await page.waitForFunction(() => document.querySelectorAll('#results-body tr').length === 1);
    assert.match(await page.locator('#results-body').innerText(), /\/hard/);
    await page.locator('#result-search').fill('');
    await page.locator('#classification-filter').selectOption('hard_404');
    await page.waitForFunction(() => document.querySelectorAll('#results-body tr').length === 1);
    assert.match(await page.locator('#results-body').innerText(), /hard_404/);
    assert.equal(await page.locator('#metric-findings').innerText(), '1');
    assert.equal(await page.locator('#metric-backlinks').innerText(), '0');
    await page.locator('a', { hasText: 'Download report.xlsx' }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('a', { hasText: 'Download report.xlsx' }).click(),
    ]);
    assert.equal(download.suggestedFilename(), 'report.xlsx');
    assert.ok(await download.path());
    await page.screenshot({ path: join(screenshotDirectory, 'dashboard.png'), fullPage: true });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${dashboard.url}/#audit-workspace`);
    await mobile.locator('#run-view:not(.hidden)').waitFor();
    await mobile.waitForFunction(() => document.querySelectorAll('#results-body tr').length === 3);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    assert.equal(await mobile.locator('#results-body tr').count(), 3);
    await mobile.screenshot({ path: join(screenshotDirectory, 'dashboard-mobile.png'), fullPage: true });
    await mobile.close();
  } finally {
    await browser.close();
    await dashboard.close();
    service.close();
    await fixture.close();
    delete process.env.SEO404_DATA_DIR;
  }
});

test('dashboard cancels a running audit, exposes a partial report, and resumes without losing completed work', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-dashboard-resume-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'dashboard.sqlite'));
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${dashboard.url}/#new-audit`);
    await page.locator('#urls').fill(Array.from({ length: 4 }, (_, index) => `${fixture.origin}/slow?dashboard=${index}`).join('\n'));
    await page.locator('[data-preset="import"]').click();
    await page.locator('input[name="discovery"][value="sitemap"]').uncheck();
    await page.locator('input[name="discovery"][value="crawl"]').uncheck();
    await page.locator('.advanced-section summary').click();
    await page.locator('#concurrency').fill('1');
    await page.locator('#per-host').fill('1');
    await page.locator('#start-button').click();
    await page.waitForFunction(() => Number(document.querySelector('#metric-processed')?.textContent || 0) >= 1, null, { timeout: 30_000 });
    await page.locator('#cancel-run').click();
    await page.locator('#run-status').filter({ hasText: 'cancelled' }).waitFor({ timeout: 30_000 });
    const partialProcessed = Number(await page.locator('#metric-processed').innerText());
    assert.ok(partialProcessed >= 1 && partialProcessed < 4);
    await page.locator('a', { hasText: 'Download report.xlsx' }).waitFor();
    const screenshotDirectory = resolve(process.cwd(), 'output', 'playwright');
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, 'dashboard-cancelled.png'), fullPage: true });

    await page.locator('#resume-run').click();
    await page.locator('#run-status').filter({ hasText: 'completed' }).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#metric-processed').innerText(), '4');
    assert.equal(await page.locator('#metric-total').innerText(), '4');
  } finally {
    await browser.close();
    await dashboard.close();
    service.close();
    await fixture.close();
    delete process.env.SEO404_DATA_DIR;
  }
});

test('dashboard does not carry cleared exact URLs into a later site-only audit', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-dashboard-clean-form-'));
  process.env.SEO404_DATA_DIR = directory;
  const service = new ScanService(join(directory, 'dashboard.sqlite'));
  const dashboard = await startDashboard(service, 0);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${dashboard.url}/#new-audit`);
    await page.locator('[data-preset="import"]').click();
    await page.locator('input[name="discovery"][value="sitemap"]').uncheck();
    await page.locator('input[name="discovery"][value="crawl"]').uncheck();
    await page.locator('#urls').fill(`${fixture.origin}/ok\n${fixture.origin}/hard`);
    await page.locator('#start-button').click();
    await page.locator('#run-status').filter({ hasText: 'completed' }).waitFor({ timeout: 30_000 });
    const firstRunId = await page.locator('#run-id').innerText();

    await page.locator('[data-view-link="new-audit"]').click();
    await page.locator('#urls').fill('');
    await page.locator('#sites').fill(fixture.origin);
    assert.equal(await page.locator('#urls').inputValue(), '');
    await page.locator('#start-button').click();
    await page.waitForFunction((previous) => document.querySelector('#run-id')?.textContent !== previous, firstRunId);
    await page.locator('#run-status').filter({ hasText: 'completed' }).waitFor({ timeout: 30_000 });
    const latest = service.listScans()[0];
    assert.deepEqual(latest?.options.urls, []);
    assert.deepEqual(latest?.options.sites, [fixture.origin]);
    assert.equal(latest?.total, 1);
  } finally {
    await browser.close();
    await dashboard.close();
    service.close();
    await fixture.close();
    delete process.env.SEO404_DATA_DIR;
  }
});
