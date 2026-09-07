import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { ScanDatabase } from '../../src/database.js';
import { importRowsFromFile, importUrlsFromFile } from '../../src/imports.js';
import { defaultScanOptions } from '../../src/config.js';

test('a restaurant site scan defaults to Google search discovery', () => {
  const options = defaultScanOptions();
  assert.deepEqual(options.discovery, ['google']);
  assert.equal(options.googleCountry, 'gb');
  assert.equal(options.googleLanguage, 'en');
  assert.equal(options.googleMaxPages, 50);
  assert.equal(options.backlinkLimit, 100_000);
});

test('imports URL columns from TXT, CSV, and XLSX', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-imports-'));
  const txt = join(directory, 'urls.txt');
  const csv = join(directory, 'urls.csv');
  const xlsx = join(directory, 'urls.xlsx');
  await writeFile(txt, '# list\nexample.com/a\nhttps://example.com/b#fragment\n');
  await writeFile(csv, 'name,url\nMenu,https://example.com/menu\nOld,example.com/old\n');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('URLs');
  sheet.addRow(['URL', 'Note']);
  sheet.addRow(['https://example.com/from-xlsx', 'valid']);
  await workbook.xlsx.writeFile(xlsx);

  assert.deepEqual(await importUrlsFromFile(txt), ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(await importUrlsFromFile(csv), ['https://example.com/menu', 'https://example.com/old']);
  assert.deepEqual(await importUrlsFromFile(xlsx), ['https://example.com/from-xlsx']);
});

test('optional name, address, and place id columns become place hints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hints-'));
  const csv = join(directory, 'restaurants.csv');
  const xlsx = join(directory, 'restaurants.xlsx');
  const bare = join(directory, 'bare.csv');
  await writeFile(csv, [
    'Restaurant Name,Website,Full Address,Place ID',
    'Blue Fin Sushi,https://bluefin.example,"12 Ocean Ave, San Francisco",places/blue-fin',
    'Taco Palace,tacopalace.example,,',
  ].join('\n'));
  await writeFile(bare, 'https://example.com/a\nhttps://example.com/b\n');

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Restaurants');
  sheet.addRow(['URL', 'Business', 'Address']);
  sheet.addRow(['https://bluefin.example', 'Blue Fin Sushi', '12 Ocean Ave']);
  await workbook.xlsx.writeFile(xlsx);

  assert.deepEqual(await importRowsFromFile(csv), [
    { url: 'https://bluefin.example/', name: 'Blue Fin Sushi', address: '12 Ocean Ave, San Francisco', placeId: 'places/blue-fin' },
    { url: 'https://tacopalace.example/', name: 'Taco Palace' },
  ]);
  assert.deepEqual(await importRowsFromFile(xlsx), [
    { url: 'https://bluefin.example/', name: 'Blue Fin Sushi', address: '12 Ocean Ave' },
  ]);
  // Without a recognizable URL header the file stays a bare list of URLs.
  assert.deepEqual(await importRowsFromFile(bare), [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);
  assert.deepEqual(await importUrlsFromFile(csv), ['https://bluefin.example/', 'https://tacopalace.example/']);
});

test('hours comparisons are stored per site and survive a resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-db-'));
  const db = new ScanDatabase(join(directory, 'scan.sqlite'));
  try {
    db.createScan('scan-hours', defaultScanOptions(), join(directory, 'output'));
    const record = {
      site: 'https://bluefin.example', siteKey: 'bluefin.example', status: 'mismatch' as const,
      matchConfidence: 'verified' as const, placeId: 'places/blue-fin', placeName: 'Blue Fin Sushi',
      placeAddress: '12 Ocean Ave', placeWebsite: 'https://bluefin.example', businessStatus: 'OPERATIONAL',
      utcOffsetMinutes: -480, websiteMethod: 'jsonld' as const, websiteHoursUrl: 'https://bluefin.example/hours',
      pagesInspected: 4, days: [], maxDeltaMinutes: 45, notes: [], checkedAt: new Date().toISOString(),
    };
    db.upsertHours('scan-hours', record);
    db.upsertHours('scan-hours', { ...record, status: 'aligned', maxDeltaMinutes: 0 });
    assert.equal(db.hoursCount('scan-hours'), 1, 'one row per site, replaced rather than duplicated');
    assert.equal(db.listHours('scan-hours')[0]?.status, 'aligned');
    assert.equal(db.hoursMismatchCount('scan-hours'), 0);
    assert.deepEqual(db.hoursStatusCounts('scan-hours'), { aligned: 1 });
    assert.equal(db.hasHours('scan-hours', 'bluefin.example'), true);
    assert.equal(db.hasHours('scan-hours', 'other.example'), false);

    db.resetForResume('scan-hours');
    assert.equal(db.hoursCount('scan-hours'), 1, 'a resume must not discard paid-for lookups');
  } finally {
    db.close();
  }
});

test('SQLite persistence deduplicates candidates while retaining discovery evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-db-'));
  const db = new ScanDatabase(join(directory, 'scan.sqlite'));
  try {
    const options = defaultScanOptions();
    db.createScan('scan-1', options, join(directory, 'output'));
    db.addCandidate('scan-1', {
      inputUrl: 'https://example.com/old', normalizedUrl: 'https://example.com/old', site: 'https://example.com',
      sources: [{ source: 'import' }],
    });
    db.addCandidate('scan-1', {
      inputUrl: 'https://example.com/old', normalizedUrl: 'https://example.com/old', site: 'https://example.com',
      sources: [{ source: 'sitemap', discoveredFrom: 'https://example.com/sitemap.xml' }],
    });
    const candidates = db.listCandidates('scan-1');
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.sources.map((source) => source.source).sort(), ['import', 'sitemap']);
    assert.equal(db.getScan('scan-1')?.total, 1);
    const backlink = {
      site: 'https://example.com/', targetUrl: 'https://example.com/old', sourceUrl: 'https://directory.example/listing',
      sourceDomain: 'directory.example', sourceTitle: 'Listing', sourceHttpStatus: 200, targetProviderStatus: 404,
      anchor: 'Old menu', dofollow: true, linkType: 'anchor', isNew: false, isLost: false,
      isBrokenByProvider: true, rank: 50, domainRank: 60, spamScore: 1,
      firstSeen: '2025-01-01 00:00:00 +00:00', lastSeen: '2026-08-25 00:00:00 +00:00',
      linksCount: 1, provider: 'dataforseo' as const,
    };
    db.addBacklink('scan-1', backlink);
    db.addBacklink('scan-1', backlink);
    assert.equal(db.backlinkCount('scan-1'), 1);
    assert.deepEqual(db.listBacklinks('scan-1')[0], backlink);
  } finally {
    db.close();
  }
});

test('imports a large URL list without an artificial row limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-large-import-'));
  const txt = join(directory, 'large-urls.txt');
  const rows = Array.from({ length: 10_000 }, (_, index) => `https://example.com/menu/${index}`);
  await writeFile(txt, `${rows.join('\n')}\n`);
  const imported = await importUrlsFromFile(txt);
  assert.equal(imported.length, 10_000);
  assert.equal(imported[0], 'https://example.com/menu/0');
  assert.equal(imported.at(-1), 'https://example.com/menu/9999');
});
