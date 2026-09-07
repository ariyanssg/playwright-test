import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS, { type Cell, type Row, type Worksheet } from 'exceljs';
import { CLASSIFICATIONS, type BacklinkRecord, type CandidateRecord, type Classification, type DayVerdict, type HoursComparisonRecord, type ScanResult, type StoredScan } from './types.js';
import { DAY_INDEXES, DAY_NAMES } from './hours/schedule.js';
import type { ScanDatabase } from './database.js';
import { isActionable } from './database.js';

const COLORS = {
  navy: 'FF12233F',
  blue: 'FF2563EB',
  paleBlue: 'FFEFF6FF',
  white: 'FFFFFFFF',
  slate: 'FF475569',
  line: 'FFD9E2EC',
  red: 'FFB42318',
  paleRed: 'FFFEE4E2',
  amber: 'FFB54708',
  paleAmber: 'FFFFF4CC',
  green: 'FF067647',
  paleGreen: 'FFDCFCE7',
  gray: 'FFF1F5F9',
};

interface ReportRow {
  url: string;
  inputUrl: string;
  site: string;
  classification: Classification;
  httpStatus: number | null;
  finalUrl: string;
  redirects: number;
  confidence: number;
  reasons: string;
  robotsAllowed: boolean | null;
  title: string;
  canonical: string;
  responseMs: number;
  checkedAt: Date;
  sources: string;
  sourceEvidence: string;
  gscVerdict: string;
  gscCoverage: string;
  error: string;
}

interface BacklinkReportRow {
  targetUrl: string;
  liveClassification: string;
  liveHttpStatus: number | null;
  sourceUrl: string;
  sourceDomain: string;
  sourceTitle: string;
  anchor: string;
  dofollow: boolean | null;
  providerState: string;
  providerBroken: boolean | null;
  providerTargetHttp: number | null;
  sourceHttpStatus: number | null;
  rank: number | null;
  domainRank: number | null;
  spamScore: number | null;
  linkType: string;
  firstSeen: Date | string;
  lastSeen: Date | string;
  linksCount: number;
}

export async function writeReports(db: ScanDatabase, scanId: string, scanOverride?: StoredScan): Promise<string[]> {
  const scan = scanOverride ?? db.getScan(scanId);
  if (!scan) throw new Error(`Unknown scan: ${scanId}`);
  await mkdir(scan.outputDir, { recursive: true });
  const candidates = db.listCandidates(scanId);
  const backlinks = db.listBacklinks(scanId);
  const results = candidates.flatMap((candidate) => candidate.result ? [candidate.result] : []);
  const reportRows = results.map(toReportRow);
  const allCsvPath = join(scan.outputDir, 'all-urls.csv');
  const findingsCsvPath = join(scan.outputDir, 'findings.csv');
  const backlinksCsvPath = join(scan.outputDir, 'backlinks.csv');
  const jsonPath = join(scan.outputDir, 'run.json');
  const xlsxPath = join(scan.outputDir, 'report.xlsx');
  const hours = scan.options.checkHours ? db.listHours(scanId) : [];
  const artifacts = [xlsxPath, findingsCsvPath, allCsvPath, backlinksCsvPath, jsonPath];

  await writeFile(allCsvPath, toCsv(reportRows), 'utf8');
  await writeFile(findingsCsvPath, toCsv(reportRows.filter((row) => isActionable(row.classification))), 'utf8');
  await writeFile(backlinksCsvPath, toBacklinksCsv(backlinks, candidates), 'utf8');
  // Only written when the stage ran, so an ordinary scan produces no empty artifact.
  if (scan.options.checkHours) {
    const hoursCsvPath = join(scan.outputDir, 'hours.csv');
    await writeFile(hoursCsvPath, toHoursCsv(hours), 'utf8');
    artifacts.push(hoursCsvPath);
  }
  await writeFile(jsonPath, `${JSON.stringify({
    scan,
    counts: db.classificationCounts(scanId),
    candidates: candidates.map(jsonCandidate),
    backlinks,
    hours,
    coverage: {
      googleSiteOperator: 'Diagnostic and not exhaustive',
      googleDiscovery: db.googleDiscovery(scanId),
      searchApi: db.googleDiscovery(scanId).some((state) => state.providersUsed?.includes('searchapi')) || candidates.some((item) => item.sources.some((source) => source.source === 'searchapi')) ? 'Paginated Google organic results; see per-site coverage' : 'No successful SearchApi pages recorded',
      searchConsole: scan.options.discovery.includes('gsc') ? `${scan.options.gscDays}-day Search Analytics window; not an index inventory` : 'Not used',
      backlinks: scan.options.discovery.includes('backlinks')
        ? `DataForSEO backlink index, capped at ${(scan.options.backlinkLimit ?? 100_000).toLocaleString()} rows per site; not the entire web`
        : 'Not used',
      hours: scan.options.checkHours
        ? `Google Places regular weekly hours compared against website hours with a ${scan.options.hoursToleranceMinutes}-minute tolerance; holiday and special hours are not compared`
        : 'Not used',
    },
  }, null, 2)}\n`, 'utf8');
  await writeWorkbook(xlsxPath, db, scanId, candidates, backlinks, hours, scan);
  return artifacts;
}

async function writeWorkbook(filePath: string, db: ScanDatabase, scanId: string, candidates: CandidateRecord[], backlinks: BacklinkRecord[], hours: HoursComparisonRecord[], scan: StoredScan): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Restaurant SEO 404 Auditor';
  workbook.created = new Date(scan.createdAt);
  workbook.modified = new Date();
  workbook.subject = 'Hard and suspected soft 404 audit';
  workbook.description = 'Generated by the local Playwright SEO 404 Auditor.';

  const allResults = candidates.flatMap((candidate) => candidate.result ? [candidate.result] : []);
  const findings = allResults.filter((result) => isActionable(result.classification));
  const summary = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  const broken = workbook.addWorksheet('Broken & Soft 404', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  const all = workbook.addWorksheet('All URLs', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  const backlinkSheet = workbook.addWorksheet('Backlinks', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  const hoursSheet = scan.options.checkHours
    ? workbook.addWorksheet('Hours Comparison', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }] })
    : null;
  const sources = workbook.addWorksheet('Sources & Run Info', { views: [{ showGridLines: false }] });

  buildSummary(summary, db, scanId, allResults.length, findings.length, backlinks.length, hours, scan);
  buildResultSheet(broken, findings);
  buildResultSheet(all, allResults);
  buildBacklinksSheet(backlinkSheet, backlinks, candidates);
  if (hoursSheet) buildHoursSheet(hoursSheet, hours);
  buildSourcesSheet(sources, candidates, scan);
  const googleStates = db.googleDiscovery(scanId);
  if (googleStates.length) {
    const coverage = workbook.addWorksheet('Google Coverage', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
    coverage.columns = [
      { header: 'Website', key: 'site', width: 40 }, { header: 'Provider', key: 'provider', width: 16 },
      { header: 'Market', key: 'market', width: 14 }, { header: 'Coverage', key: 'status', width: 18 },
      { header: 'Search pages fetched', key: 'pages', width: 24 }, { header: 'Query', key: 'query', width: 65 },
      { header: 'Query exhausted', key: 'done', width: 20 }, { header: 'Next result page', key: 'nextPage', width: 20 },
      { header: 'Last updated', key: 'updatedAt', width: 26 }, { header: 'Issue', key: 'error', width: 65 },
    ];
    for (const state of googleStates) for (const query of state.queries) coverage.addRow({
      site: safeText(state.site), provider: state.providersUsed?.join(', ') || state.provider, market: `${state.country}/${state.language}`, status: state.status,
      pages: state.pagesFetched, query: safeText(query.query), done: query.done ? 'Yes' : 'No', nextPage: query.nextPage,
      updatedAt: state.updatedAt, error: safeText(state.error ?? ''),
    });
    styleHeader(coverage.getRow(1));
    coverage.getColumn('error').alignment = { wrapText: true, vertical: 'top' };
    coverage.addRow({ site: 'Coverage is observed Google results, not a complete index inventory.' });
  }
  await workbook.xlsx.writeFile(filePath);
}

function buildSummary(sheet: Worksheet, db: ScanDatabase, scanId: string, checked: number, findings: number, backlinks: number, hours: HoursComparisonRecord[], scan: StoredScan): void {
  sheet.mergeCells('A1:G1');
  const title = sheet.getCell('A1');
  title.value = 'Restaurant SEO 404 Audit';
  title.font = { name: 'Arial', size: 20, bold: true, color: { argb: COLORS.white } };
  title.fill = solid(COLORS.navy);
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 34;

  const meta: Array<[string, string | Date]> = [
    ['Scan ID', scan.id],
    ['Status', scan.status],
    ['Started', scan.startedAt ? new Date(scan.startedAt) : new Date(scan.createdAt)],
    ['Completed', scan.completedAt ? new Date(scan.completedAt) : 'Report generated before completion'],
  ];
  meta.forEach(([label, value], index) => {
    const row = sheet.getRow(index + 3);
    row.getCell(1).value = label;
    row.getCell(2).value = value;
    row.getCell(1).font = { bold: true, color: { argb: COLORS.slate } };
    if (value instanceof Date) row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm:ss';
  });

  const hoursMismatches = hours.filter((record) => record.status === 'mismatch').length;
  const kpis: Array<[string, number, string]> = [
    ['Unique URLs', scan.total, COLORS.blue],
    ['Checked', checked, COLORS.green],
    ['Actionable findings', findings, findings ? COLORS.red : COLORS.green],
    ['Backlinks', backlinks, COLORS.blue],
    ['Hours mismatches', hoursMismatches, hoursMismatches ? COLORS.red : COLORS.green],
  ];
  kpis.forEach(([label, value, color], index) => {
    const column = 3 + index;
    const labelCell = sheet.getCell(3, column);
    const valueCell = sheet.getCell(4, column);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: COLORS.slate } };
    valueCell.value = value;
    valueCell.numFmt = '#,##0';
    valueCell.font = { size: 18, bold: true, color: { argb: color } };
    valueCell.fill = solid(COLORS.gray);
    valueCell.alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getColumn(column).width = 20;
  });
  sheet.getRow(4).height = 32;

  sheet.getCell('A8').value = 'Classification';
  sheet.getCell('B8').value = 'Count';
  styleHeader(sheet.getRow(8));
  const counts = db.classificationCounts(scanId);
  CLASSIFICATIONS.forEach((classification, index) => {
    const rowNumber = index + 9;
    sheet.getCell(rowNumber, 1).value = classification;
    sheet.getCell(rowNumber, 2).value = {
      formula: `COUNTIF('All URLs'!D:D,A${rowNumber})`,
      result: counts[classification],
    };
    sheet.getCell(rowNumber, 2).numFmt = '#,##0';
    styleClassification(sheet.getCell(rowNumber, 1), classification);
  });

  sheet.getCell('D8').value = 'Coverage and interpretation';
  sheet.mergeCells('D8:F8');
  styleHeader(sheet.getRow(8), 4, 6);
  const notes = [
    'Hard 404 and 410 results are definitive HTTP responses.',
    'Soft 404 results are confidence-scored suspicions based on rendered content and the site missing-page baseline.',
    'Google site: and Search Console sources are useful coverage signals, not complete index inventories.',
    'Backlinks are the records exposed by the configured provider index, not a guaranteed inventory of the entire web.',
    scan.options.checkHours
      ? `Hours comparison covers the regular weekly schedule with a ${scan.options.hoursToleranceMinutes}-minute tolerance; holiday and special hours are out of scope. A mismatch means the two published sources disagree, not that the website is necessarily wrong.`
      : 'Opening hours were not compared in this run.',
    scan.cancelRequested ? 'This is a partial report from a cancelled scan.' : 'The report includes every candidate completed when it was generated.',
  ];
  notes.forEach((note, index) => {
    const cell = sheet.getCell(9 + index, 4);
    sheet.mergeCells(9 + index, 4, 9 + index, 6);
    cell.value = `• ${note}`;
    cell.alignment = { wrapText: true, vertical: 'top' };
  });
  sheet.getColumn(1).width = 20;
  sheet.getColumn(2).width = 34;
  sheet.getColumn(3).width = 20;
  sheet.getColumn(4).width = 25;
  sheet.getColumn(5).width = 25;
  sheet.getColumn(6).width = 25;
  sheet.getColumn(7).width = 20;
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 };
}

function buildBacklinksSheet(sheet: Worksheet, backlinks: BacklinkRecord[], candidates: CandidateRecord[]): void {
  sheet.columns = [
    { header: 'Target URL', key: 'targetUrl', width: 48 },
    { header: 'Live classification', key: 'liveClassification', width: 22 },
    { header: 'Live HTTP', key: 'liveHttpStatus', width: 11 },
    { header: 'Referring URL', key: 'sourceUrl', width: 52 },
    { header: 'Referring domain', key: 'sourceDomain', width: 28 },
    { header: 'Referring title', key: 'sourceTitle', width: 34 },
    { header: 'Anchor', key: 'anchor', width: 30 },
    { header: 'Dofollow', key: 'dofollow', width: 12 },
    { header: 'Provider state', key: 'providerState', width: 15 },
    { header: 'Provider broken', key: 'providerBroken', width: 15 },
    { header: 'Provider target HTTP', key: 'providerTargetHttp', width: 20 },
    { header: 'Referrer HTTP', key: 'sourceHttpStatus', width: 14 },
    { header: 'Link rank', key: 'rank', width: 12 },
    { header: 'Domain rank', key: 'domainRank', width: 14 },
    { header: 'Spam score', key: 'spamScore', width: 13 },
    { header: 'Link type', key: 'linkType', width: 14 },
    { header: 'First seen', key: 'firstSeen', width: 21 },
    { header: 'Last seen', key: 'lastSeen', width: 21 },
    { header: 'Links on page', key: 'linksCount', width: 15 },
  ];
  styleHeader(sheet.getRow(1));
  const results = new Map(candidates.flatMap((candidate) => candidate.result ? [[candidate.normalizedUrl, candidate.result] as const] : []));
  for (const backlink of backlinks) {
    const live = results.get(backlink.targetUrl);
    const row = sheet.addRow(toBacklinkReportRow(backlink, live));
    setHyperlink(row.getCell('targetUrl'), backlink.targetUrl);
    setHyperlink(row.getCell('sourceUrl'), backlink.sourceUrl);
    if (live) styleClassification(row.getCell('liveClassification'), live.classification);
    for (const key of ['liveHttpStatus', 'providerTargetHttp', 'sourceHttpStatus', 'rank', 'domainRank', 'spamScore', 'linksCount']) {
      row.getCell(key).numFmt = '#,##0';
    }
    for (const key of ['firstSeen', 'lastSeen']) {
      if (row.getCell(key).value instanceof Date) row.getCell(key).numFmt = 'yyyy-mm-dd hh:mm:ss';
    }
    for (const key of ['sourceTitle', 'anchor']) row.getCell(key).alignment = { vertical: 'top', wrapText: true };
    row.alignment = { vertical: 'top' };
  }
  const lastRow = Math.max(1, sheet.rowCount);
  sheet.autoFilter = { from: 'A1', to: `S${lastRow}` };
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
}

function buildResultSheet(sheet: Worksheet, results: ScanResult[]): void {
  sheet.columns = [
    { header: 'URL', key: 'url', width: 48 },
    { header: 'Site', key: 'site', width: 28 },
    { header: 'Source(s)', key: 'sources', width: 18 },
    { header: 'Classification', key: 'classification', width: 24 },
    { header: 'HTTP', key: 'httpStatus', width: 10 },
    { header: 'Final URL', key: 'finalUrl', width: 48 },
    { header: 'Redirects', key: 'redirects', width: 11 },
    { header: 'Confidence', key: 'confidence', width: 13 },
    { header: 'Reasons', key: 'reasons', width: 52 },
    { header: 'Robots allowed', key: 'robotsAllowed', width: 15 },
    { header: 'Title', key: 'title', width: 32 },
    { header: 'Canonical', key: 'canonical', width: 45 },
    { header: 'Response ms', key: 'responseMs', width: 14 },
    { header: 'Checked at', key: 'checkedAt', width: 21 },
    { header: 'GSC verdict', key: 'gscVerdict', width: 18 },
    { header: 'GSC coverage', key: 'gscCoverage', width: 28 },
    { header: 'Error', key: 'error', width: 42 },
    { header: 'Discovery Evidence', key: 'sourceEvidence', width: 70 },
  ];
  styleHeader(sheet.getRow(1));
  for (const result of results) {
    const row = sheet.addRow(toReportRow(result));
    setHyperlink(row.getCell('url'), result.normalizedUrl);
    if (result.finalUrl) setHyperlink(row.getCell('finalUrl'), result.finalUrl);
    if (result.canonical) setHyperlink(row.getCell('canonical'), result.canonical);
    row.getCell('checkedAt').numFmt = 'yyyy-mm-dd hh:mm:ss';
    row.getCell('confidence').numFmt = '0%';
    row.getCell('httpStatus').numFmt = '0';
    row.getCell('redirects').numFmt = '0';
    row.getCell('responseMs').numFmt = '#,##0';
    styleClassification(row.getCell('classification'), result.classification);
    row.alignment = { vertical: 'top' };
    for (const key of ['reasons', 'title', 'error', 'sourceEvidence']) row.getCell(key).alignment = { vertical: 'top', wrapText: true };
  }
  const lastRow = Math.max(1, sheet.rowCount);
  sheet.autoFilter = { from: 'A1', to: `R${lastRow}` };
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
}

/**
 * One row per restaurant, read across: an owner scans their own line. The long
 * per-day form lives in hours.csv, which pivots and filters far better.
 */
function buildHoursSheet(sheet: Worksheet, hours: HoursComparisonRecord[]): void {
  sheet.columns = [
    { header: 'Site', key: 'site', width: 34 },
    { header: 'Matched place', key: 'placeName', width: 30 },
    { header: 'Address', key: 'placeAddress', width: 38 },
    { header: 'Place ID', key: 'placeId', width: 26 },
    { header: 'Match confidence', key: 'matchConfidence', width: 18 },
    { header: 'Business status', key: 'businessStatus', width: 18 },
    { header: 'Status', key: 'status', width: 20 },
    ...DAY_INDEXES.flatMap((day) => [
      { header: `${DAY_NAMES[day]} Google`, key: `google${day}`, width: 22 },
      { header: `${DAY_NAMES[day]} website`, key: `website${day}`, width: 22 },
      { header: `${DAY_NAMES[day]} verdict`, key: `verdict${day}`, width: 18 },
    ]),
    { header: 'Max delta (min)', key: 'maxDeltaMinutes', width: 15 },
    { header: 'Website source', key: 'websiteMethod', width: 16 },
    { header: 'Hours page', key: 'websiteHoursUrl', width: 44 },
    { header: 'UTC offset (min)', key: 'utcOffsetMinutes', width: 16 },
    { header: 'Notes', key: 'notes', width: 70 },
  ];
  styleHeader(sheet.getRow(1));

  for (const record of hours) {
    const days = new Map(record.days.map((day) => [day.day, day] as const));
    const row = sheet.addRow({
      site: record.site,
      placeName: safeText(record.placeName ?? ''),
      placeAddress: safeText(record.placeAddress ?? ''),
      placeId: safeText(record.placeId ?? ''),
      matchConfidence: record.matchConfidence,
      businessStatus: safeText(record.businessStatus ?? ''),
      status: record.status,
      ...Object.fromEntries(DAY_INDEXES.flatMap((day) => {
        const diff = days.get(day);
        return [
          [`google${day}`, safeText(diff?.googleText ?? '')],
          [`website${day}`, safeText(diff?.websiteText ?? '')],
          [`verdict${day}`, diff?.verdict ?? ''],
        ];
      })),
      maxDeltaMinutes: record.maxDeltaMinutes,
      websiteMethod: record.websiteMethod,
      websiteHoursUrl: record.websiteHoursUrl ?? '',
      utcOffsetMinutes: record.utcOffsetMinutes,
      notes: safeText(record.notes.join(' · ')),
    });
    setHyperlink(row.getCell('site'), record.site);
    if (record.websiteHoursUrl) setHyperlink(row.getCell('websiteHoursUrl'), record.websiteHoursUrl);
    styleHoursStatus(row.getCell('status'), record.status);
    if (record.matchConfidence === 'unverified') {
      row.getCell('matchConfidence').font = { bold: true, color: { argb: COLORS.amber } };
      row.getCell('matchConfidence').fill = solid(COLORS.paleAmber);
    }
    for (const day of DAY_INDEXES) {
      const diff = days.get(day);
      if (diff) styleHoursVerdict(row.getCell(`verdict${day}`), diff.verdict);
    }
    row.getCell('maxDeltaMinutes').numFmt = '#,##0';
    row.getCell('utcOffsetMinutes').numFmt = '0';
    row.getCell('notes').alignment = { vertical: 'top', wrapText: true };
    row.alignment = { vertical: 'top' };
  }

  const lastRow = Math.max(1, sheet.rowCount);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: sheet.columnCount } };
  // 30 columns will not survive fitToWidth; let it print wide instead of unreadably small.
  sheet.pageSetup = { orientation: 'landscape', fitToPage: false, printTitlesRow: '1:1' };
}

function toHoursCsv(hours: HoursComparisonRecord[]): string {
  const headers = [
    'Site', 'Day', 'Google Hours', 'Website Hours', 'Verdict', 'Delta Minutes', 'Status',
    'Match Confidence', 'Matched Place', 'Place ID', 'Website Source', 'Hours Page', 'Notes',
  ];
  const values = hours.flatMap((record) => {
    if (!record.days.length) {
      return [[
        record.site, '', '', '', record.status, '', record.status, record.matchConfidence,
        record.placeName ?? '', record.placeId ?? '', record.websiteMethod, record.websiteHoursUrl ?? '',
        record.notes.join(' · '),
      ]];
    }
    return record.days.map((day) => [
      record.site, DAY_NAMES[day.day], day.googleText, day.websiteText, day.verdict,
      day.deltaMinutes, record.status, record.matchConfidence, record.placeName ?? '', record.placeId ?? '',
      record.websiteMethod, record.websiteHoursUrl ?? '', [...day.notes, ...record.notes].join(' · '),
    ]);
  });
  return `${[headers, ...values].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function buildSourcesSheet(sheet: Worksheet, candidates: CandidateRecord[], scan: StoredScan): void {
  sheet.mergeCells('A1:D1');
  sheet.getCell('A1').value = 'Discovery Sources & Run Information';
  sheet.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: COLORS.white } };
  sheet.getCell('A1').fill = solid(COLORS.navy);
  sheet.getRow(1).height = 32;
  const sourceCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const source of new Set(candidate.sources.map((item) => item.source))) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
  }
  sheet.addRow([]);
  sheet.addRow(['Source', 'Unique candidates', 'Enabled', 'Coverage note']);
  styleHeader(sheet.getRow(3));
  const coverage: Record<string, string> = {
    import: 'Every valid URL supplied by the user',
    sitemap: 'URLs exposed by accessible same-site sitemaps',
    crawl: `Rendered same-site crawl capped at ${scan.options.crawlLimit.toLocaleString()} URLs per site`,
    google: `Google organic results from API or browser; ${(scan.options.googleMaxPages ?? 50).toLocaleString()} search pages per site maximum`,
    searchapi: 'Google organic results via SearchApi; see Google Coverage for actual pagination and outcome',
    google_browser: 'Google organic results observed in the local browser; see Google Coverage',
    gsc: `${scan.options.gscDays}-day Search Analytics pages; not an index inventory`,
    backlinks: `DataForSEO backlink index capped at ${(scan.options.backlinkLimit ?? 100_000).toLocaleString()} rows per site; provider-billed and not the entire web`,
  };
  for (const source of ['import', 'sitemap', 'crawl', 'google', 'searchapi', 'google_browser', 'gsc', 'backlinks']) {
    sheet.addRow([source, sourceCounts.get(source) ?? 0, scan.options.discovery.includes(source as never) || sourceCounts.has(source) ? 'Yes' : 'No', coverage[source]]);
  }
  sheet.addRow([]);
  sheet.addRow(['Run warnings']);
  styleHeader(sheet.getRow(sheet.rowCount));
  if (!scan.warnings.length) sheet.addRow(['None']);
  else for (const warning of scan.warnings) sheet.addRow([safeText(warning)]);
  sheet.addRow([]);
  sheet.addRow(['Configuration', 'Value']);
  styleHeader(sheet.getRow(sheet.rowCount));
  const configRows: Array<[string, string | number | boolean]> = [
    ['Google provider', scan.options.googleProvider ?? 'searchapi'],
    ['Google country', scan.options.googleCountry ?? 'Not recorded'],
    ['Google language', scan.options.googleLanguage ?? 'Not recorded'],
    ['Google page budget / site', scan.options.googleMaxPages ?? 50],
    ['Hours comparison', scan.options.checkHours],
    ['Hours tolerance (min)', scan.options.hoursToleranceMinutes],
    ['Hours pages per site', scan.options.hoursPageLimit],
    ['Require verified place', scan.options.hoursRequireVerifiedPlace],
    ['Concurrency', scan.options.concurrency],
    ['Per-host concurrency', scan.options.perHostConcurrency],
    ['Host delay (ms)', scan.options.hostDelayMs],
    ['Navigation timeout (ms)', scan.options.timeoutMs],
    ['Google URL Inspection', scan.options.inspectGoogle],
    ['Backlink row cap / site', scan.options.backlinkLimit ?? 100_000],
    ['Failure threshold', scan.options.failOn],
  ];
  for (const row of configRows) sheet.addRow(row);
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 76;
  sheet.getColumn(4).alignment = { wrapText: true, vertical: 'top' };
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3' };
}

function toBacklinkReportRow(backlink: BacklinkRecord, live?: ScanResult): BacklinkReportRow {
  return {
    targetUrl: backlink.targetUrl,
    liveClassification: live?.classification ?? 'not_checked',
    liveHttpStatus: live?.httpStatus ?? null,
    sourceUrl: backlink.sourceUrl,
    sourceDomain: safeText(backlink.sourceDomain),
    sourceTitle: safeText(backlink.sourceTitle ?? ''),
    anchor: safeText(backlink.anchor ?? ''),
    dofollow: backlink.dofollow,
    providerState: backlink.isLost ? 'lost' : backlink.isNew ? 'new' : 'live',
    providerBroken: backlink.isBrokenByProvider,
    providerTargetHttp: backlink.targetProviderStatus,
    sourceHttpStatus: backlink.sourceHttpStatus,
    rank: backlink.rank,
    domainRank: backlink.domainRank,
    spamScore: backlink.spamScore,
    linkType: safeText(backlink.linkType ?? ''),
    firstSeen: providerDate(backlink.firstSeen),
    lastSeen: providerDate(backlink.lastSeen),
    linksCount: backlink.linksCount,
  };
}

function toReportRow(result: ScanResult): ReportRow {
  const sourceTypes = [...new Set(result.sources.map((source) => source.source))];
  return {
    url: result.normalizedUrl,
    inputUrl: result.inputUrl,
    site: result.site,
    sources: sourceTypes.join(', '),
    classification: result.classification,
    httpStatus: result.httpStatus,
    finalUrl: result.finalUrl,
    redirects: Math.max(0, result.redirectChain.length - 1),
    confidence: result.confidence,
    reasons: safeText(result.reasons.join('; ')),
    robotsAllowed: result.robotsAllowed,
    title: safeText(result.title),
    canonical: result.canonical ?? '',
    responseMs: result.responseMs,
    checkedAt: new Date(result.checkedAt),
    sourceEvidence: JSON.stringify(result.sources),
    gscVerdict: result.gsc?.verdict ?? '',
    gscCoverage: result.gsc?.coverageState ?? '',
    error: safeText(result.error ?? ''),
  };
}

function toCsv(rows: ReportRow[]): string {
  const headers = [
    'URL', 'Input URL', 'Site', 'Classification', 'HTTP Status', 'Final URL', 'Redirect Count', 'Confidence',
    'Reasons', 'Robots Allowed', 'Title', 'Canonical', 'Response ms', 'Checked At', 'Sources', 'Discovery Evidence',
    'GSC Verdict', 'GSC Coverage', 'Error',
  ];
  const values = rows.map((row) => [
    row.url, row.inputUrl, row.site, row.classification, row.httpStatus, row.finalUrl, row.redirects, row.confidence,
    row.reasons, row.robotsAllowed, row.title, row.canonical, row.responseMs, row.checkedAt.toISOString(), row.sources,
    row.sourceEvidence, row.gscVerdict, row.gscCoverage, row.error,
  ]);
  return `${[headers, ...values].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function toBacklinksCsv(backlinks: BacklinkRecord[], candidates: CandidateRecord[]): string {
  const results = new Map(candidates.flatMap((candidate) => candidate.result ? [[candidate.normalizedUrl, candidate.result] as const] : []));
  const headers = [
    'Target URL', 'Live Classification', 'Live HTTP', 'Referring URL', 'Referring Domain', 'Referring Title',
    'Anchor', 'Dofollow', 'Provider State', 'Provider Broken', 'Provider Target HTTP', 'Referrer HTTP',
    'Link Rank', 'Domain Rank', 'Spam Score', 'Link Type', 'First Seen', 'Last Seen', 'Links On Page',
  ];
  const values = backlinks.map((backlink) => {
    const row = toBacklinkReportRow(backlink, results.get(backlink.targetUrl));
    return [
      row.targetUrl, row.liveClassification, row.liveHttpStatus, row.sourceUrl, row.sourceDomain, row.sourceTitle,
      row.anchor, row.dofollow, row.providerState, row.providerBroken, row.providerTargetHttp, row.sourceHttpStatus,
      row.rank, row.domainRank, row.spamScore, row.linkType,
      row.firstSeen instanceof Date ? row.firstSeen.toISOString() : row.firstSeen,
      row.lastSeen instanceof Date ? row.lastSeen.toISOString() : row.lastSeen, row.linksCount,
    ];
  });
  return `${[headers, ...values].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function providerDate(value: string | null): Date | string {
  if (!value) return '';
  const parsed = new Date(value.replace(' ', 'T').replace(/ \+00:00$/, 'Z'));
  return Number.isNaN(parsed.getTime()) ? safeText(value) : parsed;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  text = safeText(text);
  return `"${text.replace(/"/g, '""')}"`;
}

function safeText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function jsonCandidate(candidate: CandidateRecord): object {
  return { ...candidate, status: candidate.status };
}

function styleHeader(row: Row, start = 1, end = row.cellCount || 1): void {
  row.height = 25;
  for (let column = start; column <= end; column += 1) {
    const cell = row.getCell(column);
    cell.font = { name: 'Arial', bold: true, color: { argb: COLORS.white } };
    cell.fill = solid(COLORS.navy);
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.line } } };
  }
}

function styleClassification(cell: Cell, classification: Classification): void {
  const hard = classification === 'hard_404' || classification === 'gone_410';
  const soft = classification === 'soft_404_suspected';
  const good = classification === 'ok' || classification === 'redirected';
  cell.font = { bold: true, color: { argb: hard ? COLORS.red : soft ? COLORS.amber : good ? COLORS.green : COLORS.slate } };
  cell.fill = solid(hard ? COLORS.paleRed : soft ? COLORS.paleAmber : good ? COLORS.paleGreen : COLORS.gray);
}

function styleHoursStatus(cell: Cell, status: HoursComparisonRecord['status']): void {
  const bad = status === 'mismatch';
  const warn = status === 'minor_differences' || status === 'partial' || status === 'unmatched';
  const good = status === 'aligned';
  cell.font = { bold: true, color: { argb: bad ? COLORS.red : warn ? COLORS.amber : good ? COLORS.green : COLORS.slate } };
  cell.fill = solid(bad ? COLORS.paleRed : warn ? COLORS.paleAmber : good ? COLORS.paleGreen : COLORS.gray);
}

function styleHoursVerdict(cell: Cell, verdict: DayVerdict): void {
  const bad = verdict === 'mismatch' || verdict === 'closed_on_google' || verdict === 'closed_on_website';
  const warn = verdict === 'minor_difference' || verdict === 'missing_website' || verdict === 'missing_google';
  const good = verdict === 'match' || verdict === 'both_closed';
  cell.font = { bold: true, color: { argb: bad ? COLORS.red : warn ? COLORS.amber : good ? COLORS.green : COLORS.slate } };
  cell.fill = solid(bad ? COLORS.paleRed : warn ? COLORS.paleAmber : good ? COLORS.paleGreen : COLORS.gray);
}

function setHyperlink(cell: Cell, url: string): void {
  cell.value = { text: url, hyperlink: url, tooltip: 'Open URL' };
  cell.font = { color: { argb: COLORS.blue }, underline: true };
}

function solid(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}
