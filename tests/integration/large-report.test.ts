import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { ScanDatabase } from '../../src/database.js';
import { defaultScanOptions } from '../../src/config.js';
import { writeReports } from '../../src/reports.js';
import type { ScanResult } from '../../src/types.js';

test('large reports reconcile SQLite, XLSX, CSV, and JSON rows while neutralizing spreadsheet formulas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'seo404-large-report-'));
  const outputDir = join(directory, 'output');
  const db = new ScanDatabase(join(directory, 'scan.sqlite'));
  const rowCount = 2_000;
  try {
    db.createScan('large-scan', { ...defaultScanOptions(), discovery: ['import'] }, outputDir);
    for (let index = 0; index < rowCount; index += 1) {
      const normalizedUrl = `https://example.com/page-${index}`;
      db.addCandidate('large-scan', {
        inputUrl: normalizedUrl,
        normalizedUrl,
        site: 'https://example.com',
        sources: [{ source: 'import' }],
      });
      const hard = index % 10 === 0;
      const result: ScanResult = {
        inputUrl: normalizedUrl,
        normalizedUrl,
        site: 'https://example.com',
        sources: [{ source: 'import' }],
        httpStatus: hard ? 404 : 200,
        finalUrl: normalizedUrl,
        redirectChain: [{ url: normalizedUrl, status: hard ? 404 : 200 }],
        classification: hard ? 'hard_404' : 'ok',
        confidence: 1,
        reasons: [index === 0 ? '=WEBSERVICE("https://attacker.invalid")' : hard ? 'Final HTTP status is 404' : 'Successful rendered page'],
        robotsAllowed: true,
        title: index === 0 ? '=HYPERLINK("https://attacker.invalid")' : `Page ${index}`,
        h1: `Page ${index}`,
        canonical: normalizedUrl,
        contentType: 'text/html; charset=utf-8',
        responseMs: index,
        checkedAt: new Date(2026, 0, 1, 0, 0, index % 60).toISOString(),
        error: null,
      };
      db.saveResult('large-scan', result);
    }
    db.updateScan('large-scan', { status: 'completed', completedAt: new Date().toISOString() });
    await writeReports(db, 'large-scan');

    for (const file of ['report.xlsx', 'findings.csv', 'all-urls.csv', 'backlinks.csv', 'run.json']) {
      assert.ok((await stat(join(outputDir, file))).size > 0);
    }
    const allRows = parse(await readFile(join(outputDir, 'all-urls.csv'), 'utf8')) as string[][];
    const findingRows = parse(await readFile(join(outputDir, 'findings.csv'), 'utf8')) as string[][];
    assert.equal(allRows.length, rowCount + 1);
    assert.equal(findingRows.length, rowCount / 10 + 1);
    assert.match(allRows[1]?.[8] ?? '', /^'/);
    assert.match(allRows[1]?.[10] ?? '', /^'/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(outputDir, 'report.xlsx'));
    assert.equal(workbook.getWorksheet('All URLs')?.rowCount, rowCount + 1);
    assert.equal(workbook.getWorksheet('Broken & Soft 404')?.rowCount, rowCount / 10 + 1);
    assert.equal(workbook.getWorksheet('Backlinks')?.rowCount, 1);
    assert.match(String(workbook.getWorksheet('All URLs')?.getCell('I2').value), /^'/);
    assert.match(String(workbook.getWorksheet('All URLs')?.getCell('K2').value), /^'/);

    const run = JSON.parse(await readFile(join(outputDir, 'run.json'), 'utf8')) as { scan: { processed: number }; counts: { hard_404: number } };
    assert.equal(run.scan.processed, rowCount);
    assert.equal(run.counts.hard_404, rowCount / 10);
  } finally {
    db.close();
  }
});
