import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { ScanService } from '../../src/service.js';
import type { HoursComparisonRecord, ScanOptions } from '../../src/types.js';
import { startFixtureSite, type FixtureSite } from '../helpers/fixture-site.js';

interface PlacesMock {
  origin: string;
  requests: Array<{ path: string; apiKey: string | undefined; fieldMask: string | undefined; body: string }>;
  displayName: { text: string };
  formattedAddress: string;
  websiteUri: string | null;
  businessStatus: string;
  openMondayOnGoogle: boolean;
  close(): Promise<void>;
}

function period(day: number, hour: number, minute: number, closeDay: number, closeHour: number, closeMinute: number) {
  return { open: { day, hour, minute }, close: { day: closeDay, hour: closeHour, minute: closeMinute } };
}

/**
 * Mirrors the fixture site's published hours except for a deliberate 45-minute
 * drift on the Saturday lunch close, plus an optional Monday on which Google
 * shows the restaurant open while the site says closed.
 */
async function startPlacesMock(): Promise<PlacesMock> {
  const requests: PlacesMock['requests'] = [];
  const state = {
    displayName: { text: 'Blue Fin Sushi' },
    formattedAddress: '12 Ocean Ave, San Francisco, CA 94110',
    websiteUri: null as string | null,
    businessStatus: 'OPERATIONAL',
    openMondayOnGoogle: true,
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        apiKey: request.headers['x-goog-api-key'] as string | undefined,
        fieldMask: request.headers['x-goog-fieldmask'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const periods = [
        ...(state.openMondayOnGoogle ? [period(1, 11, 0, 1, 22, 0)] : []),
        period(2, 11, 0, 2, 22, 0),
        period(3, 11, 0, 3, 22, 0),
        period(4, 11, 0, 4, 22, 0),
        period(5, 17, 0, 6, 2, 0),
        period(6, 11, 30, 6, 14, 45),
        period(6, 17, 0, 0, 1, 0),
      ];
      const place = {
        id: 'places/blue-fin',
        displayName: state.displayName,
        formattedAddress: state.formattedAddress,
        websiteUri: state.websiteUri,
        utcOffsetMinutes: -480,
        businessStatus: state.businessStatus,
        regularOpeningHours: {
          periods,
          weekdayDescriptions: [
            'Sunday: Closed',
            state.openMondayOnGoogle ? 'Monday: 11:00 AM – 10:00 PM' : 'Monday: Closed',
            'Tuesday: 11:00 AM – 10:00 PM',
            'Wednesday: 11:00 AM – 10:00 PM',
            'Thursday: 11:00 AM – 10:00 PM',
            'Friday: 5:00 – 2:00 AM',
            'Saturday: 11:30 AM – 2:45 PM, 5:00 – 1:00 AM',
          ],
        },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify((request.url ?? '').includes(':searchText') ? { places: [place] } : place));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Places mock did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get displayName() { return state.displayName; },
    set displayName(value) { state.displayName = value; },
    get websiteUri() { return state.websiteUri; },
    set websiteUri(value) { state.websiteUri = value; },
    get formattedAddress() { return state.formattedAddress; },
    set formattedAddress(value) { state.formattedAddress = value; },
    get businessStatus() { return state.businessStatus; },
    set businessStatus(value) { state.businessStatus = value; },
    get openMondayOnGoogle() { return state.openMondayOnGoogle; },
    set openMondayOnGoogle(value) { state.openMondayOnGoogle = value; },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function scanOptions(fixture: FixtureSite, directory: string, overrides: Partial<ScanOptions> = {}): Partial<ScanOptions> {
  return {
    urls: ['/', '/hours', '/contact', '/visit', '/blog/post-1'].map((path) => `${fixture.origin}${path}`),
    discovery: ['import'],
    outputDir: join(directory, 'runs'),
    concurrency: 2,
    perHostConcurrency: 2,
    hostDelayMs: 0,
    timeoutMs: 8_000,
    failOn: 'none',
    checkHours: true,
    ...overrides,
  };
}


// Hours tests drive mock Places endpoints; a Serper key exported in the shell must not route
// them to the real Serper API (the hours lookup prefers Serper when a key is present).
delete process.env.SERPER_API_KEY;

test('a missing Places key degrades to a warning without failing the scan', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-nokey-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previousKey = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  try {
    const scan = service.createScan(scanOptions(fixture, directory));
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');
    assert.match(completed.warnings.join('\n'), /hours comparison: set SERPER_API_KEY \(cheapest\) or GOOGLE_MAPS_API_KEY/);
    assert.equal(service.db.hoursCount(scan.id), 0);
    // The 404 audit is unaffected by the hours stage failing.
    assert.equal(completed.processed, 5);
    assert.equal(service.results(scan.id, 0, 10).items.find((item) => item.normalizedUrl.endsWith('/hours'))?.result?.classification, 'ok');
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previousKey);
    service.close();
    await fixture.close();
  }
});

test('a verified listing is compared per day and written to every artifact', async () => {
  const fixture = await startFixtureSite();
  const places = await startPlacesMock();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-match-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previous = { key: process.env.GOOGLE_MAPS_API_KEY, endpoint: process.env.GOOGLE_PLACES_ENDPOINT };
  process.env.GOOGLE_MAPS_API_KEY = 'places-test-key';
  process.env.GOOGLE_PLACES_ENDPOINT = places.origin;
  places.websiteUri = fixture.origin;
  try {
    const scan = service.createScan(scanOptions(fixture, directory));
    const completed = await service.start(scan.id);
    assert.equal(completed.status, 'completed');

    const search = places.requests.find((item) => item.path.includes(':searchText'));
    assert.ok(search, 'a Text Search was issued');
    assert.equal(search.apiKey, 'places-test-key');
    assert.match(search.fieldMask ?? '', /places\.regularOpeningHours/);
    assert.match(search.body, /Blue Fin Sushi/);

    const [record] = service.db.listHours(scan.id) as HoursComparisonRecord[];
    assert.ok(record);
    assert.equal(record.matchConfidence, 'verified');
    assert.equal(record.status, 'mismatch');
    assert.equal(record.websiteMethod, 'jsonld');
    assert.match(record.websiteHoursUrl ?? '', /\/hours$/);
    assert.equal(record.utcOffsetMinutes, -480);
    assert.equal(record.days[0]?.verdict, 'both_closed');
    assert.equal(record.days[1]?.verdict, 'closed_on_website');
    assert.equal(record.days[3]?.verdict, 'match');
    assert.equal(record.days[5]?.verdict, 'match', 'the Friday close after midnight matches');
    assert.equal(record.days[5]?.googleText, '5:00 PM - 2:00 AM (+1)');
    assert.equal(record.days[6]?.verdict, 'mismatch', 'the 45-minute Saturday drift exceeds the tolerance');

    const hoursCsv = parse(await readFile(join(completed.outputDir, 'hours.csv'), 'utf8')) as string[][];
    assert.equal(hoursCsv.length, 8, 'a header plus one row per day');
    assert.equal(hoursCsv[7]?.[1], 'Saturday');
    assert.equal(hoursCsv[7]?.[4], 'mismatch');

    const run = JSON.parse(await readFile(join(completed.outputDir, 'run.json'), 'utf8')) as { hours: HoursComparisonRecord[]; coverage: Record<string, string> };
    assert.equal(run.hours[0]?.days[6]?.verdict, 'mismatch');
    assert.match(run.coverage.hours ?? '', /15-minute tolerance/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(completed.outputDir, 'report.xlsx'));
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name),
      ['Summary', 'Broken & Soft 404', 'All URLs', 'Backlinks', 'Hours Comparison', 'Sources & Run Info']);
    const sheet = workbook.getWorksheet('Hours Comparison');
    assert.equal(sheet?.rowCount, 2);
    assert.ok(sheet?.getCell('A2').hyperlink, 'the site cell links out');
    assert.equal(sheet?.getCell('G2').value, 'mismatch');
    assert.equal(workbook.getWorksheet('Summary')?.getCell('G3').value, 'Hours mismatches');
    assert.equal(workbook.getWorksheet('Summary')?.getCell('G4').value, 1);
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previous.key);
    restore('GOOGLE_PLACES_ENDPOINT', previous.endpoint);
    service.close();
    await fixture.close();
    await places.close();
  }
});

test('an unverified listing is flagged everywhere and skipped in strict mode', async () => {
  const fixture = await startFixtureSite();
  const places = await startPlacesMock();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-unverified-'));
  const previous = { key: process.env.GOOGLE_MAPS_API_KEY, endpoint: process.env.GOOGLE_PLACES_ENDPOINT };
  process.env.GOOGLE_MAPS_API_KEY = 'places-test-key';
  process.env.GOOGLE_PLACES_ENDPOINT = places.origin;
  places.websiteUri = 'https://someone-else.example';
  // Same name at another address: matched by name only. (At the restaurant's own street address
  // the listing would count as verified even with a wrong website link.)
  places.formattedAddress = '98 Harbor Rd, Oakland, CA 94607';

  const lenient = new ScanService(join(directory, 'lenient.sqlite'));
  try {
    const scan = lenient.createScan(scanOptions(fixture, directory));
    const completed = await lenient.start(scan.id);
    const [record] = lenient.db.listHours(scan.id);
    assert.equal(record?.matchConfidence, 'unverified');
    assert.notEqual(record?.status, 'unmatched', 'an unverified listing is still compared');
    assert.match(completed.warnings.join('\n'), /unverified Google listing/);

    const hoursCsv = parse(await readFile(join(completed.outputDir, 'hours.csv'), 'utf8')) as string[][];
    assert.equal(hoursCsv[1]?.[7], 'unverified');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(completed.outputDir, 'report.xlsx'));
    assert.equal(workbook.getWorksheet('Hours Comparison')?.getCell('E2').value, 'unverified');
  } finally {
    lenient.close();
  }

  const strict = new ScanService(join(directory, 'strict.sqlite'));
  try {
    const scan = strict.createScan(scanOptions(fixture, directory, { hoursRequireVerifiedPlace: true }));
    await strict.start(scan.id);
    const [record] = strict.db.listHours(scan.id);
    assert.equal(record?.status, 'unmatched');
    assert.deepEqual(record?.days, []);
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previous.key);
    restore('GOOGLE_PLACES_ENDPOINT', previous.endpoint);
    strict.close();
    await fixture.close();
    await places.close();
  }
});

test('a wider tolerance reclassifies the drift as a minor difference', async () => {
  const fixture = await startFixtureSite();
  const places = await startPlacesMock();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-tolerance-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previous = { key: process.env.GOOGLE_MAPS_API_KEY, endpoint: process.env.GOOGLE_PLACES_ENDPOINT };
  process.env.GOOGLE_MAPS_API_KEY = 'places-test-key';
  process.env.GOOGLE_PLACES_ENDPOINT = places.origin;
  places.websiteUri = fixture.origin;
  places.openMondayOnGoogle = false;
  try {
    const scan = service.createScan(scanOptions(fixture, directory, { hoursToleranceMinutes: 60 }));
    await service.start(scan.id);
    const [record] = service.db.listHours(scan.id);
    assert.equal(record?.days[6]?.verdict, 'minor_difference');
    assert.equal(record?.days[6]?.deltaMinutes, 45);
    assert.equal(record?.status, 'minor_differences');
    assert.equal(service.db.hoursMismatchCount(scan.id), 0);
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previous.key);
    restore('GOOGLE_PLACES_ENDPOINT', previous.endpoint);
    service.close();
    await fixture.close();
    await places.close();
  }
});

test('a resumed scan does not pay for the same Places lookup twice', async () => {
  const fixture = await startFixtureSite();
  const places = await startPlacesMock();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-resume-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previous = { key: process.env.GOOGLE_MAPS_API_KEY, endpoint: process.env.GOOGLE_PLACES_ENDPOINT };
  process.env.GOOGLE_MAPS_API_KEY = 'places-test-key';
  process.env.GOOGLE_PLACES_ENDPOINT = places.origin;
  places.websiteUri = fixture.origin;
  try {
    const scan = service.createScan(scanOptions(fixture, directory));
    await service.start(scan.id);
    const afterFirstRun = places.requests.length;
    assert.ok(afterFirstRun > 0);
    await service.resume(scan.id);
    assert.equal(places.requests.length, afterFirstRun, 'the cached hours row is reused');
    assert.equal(service.db.hoursCount(scan.id), 1);
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previous.key);
    restore('GOOGLE_PLACES_ENDPOINT', previous.endpoint);
    service.close();
    await fixture.close();
    await places.close();
  }
});

test('a formula-looking place name is neutralized in the exports', async () => {
  const fixture = await startFixtureSite();
  const places = await startPlacesMock();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-hours-injection-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  const previous = { key: process.env.GOOGLE_MAPS_API_KEY, endpoint: process.env.GOOGLE_PLACES_ENDPOINT };
  process.env.GOOGLE_MAPS_API_KEY = 'places-test-key';
  process.env.GOOGLE_PLACES_ENDPOINT = places.origin;
  places.websiteUri = fixture.origin;
  places.displayName = { text: '=cmd|calc' };
  try {
    const scan = service.createScan(scanOptions(fixture, directory));
    const completed = await service.start(scan.id);
    const hoursCsv = parse(await readFile(join(completed.outputDir, 'hours.csv'), 'utf8')) as string[][];
    assert.match(hoursCsv[1]?.[8] ?? '', /^'/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(completed.outputDir, 'report.xlsx'));
    assert.match(String(workbook.getWorksheet('Hours Comparison')?.getCell('B2').value), /^'/);
    assert.ok((await stat(join(completed.outputDir, 'hours.csv'))).size > 0);
  } finally {
    restore('GOOGLE_MAPS_API_KEY', previous.key);
    restore('GOOGLE_PLACES_ENDPOINT', previous.endpoint);
    service.close();
    await fixture.close();
    await places.close();
  }
});
