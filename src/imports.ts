import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { extractUrlLikeValues, tryNormalizeUrl, uniqueUrls } from './urls.js';

const URL_HEADERS = new Set(['url', 'urls', 'website', 'domain', 'site', 'page', 'link']);

export async function importUrlsFromFile(filePath: string): Promise<string[]> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.xlsx' || extension === '.xlsm') return importXlsx(filePath);
  const text = await readFile(filePath, 'utf8');
  if (extension === '.csv') return importCsv(text);
  if (extension === '.txt' || !extension) return extractUrlLikeValues(text);
  throw new Error(`Unsupported input file: ${extension || '(no extension)'}`);
}

function importCsv(text: string): string[] {
  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true }) as unknown[][];
  if (!rows.length) return [];
  const headers = (rows[0] ?? []).map((value) => String(value).trim().toLowerCase());
  const urlIndexes = headers
    .map((header, index) => (URL_HEADERS.has(header) ? index : -1))
    .filter((index) => index >= 0);
  const values: string[] = [];
  const start = urlIndexes.length ? 1 : 0;
  for (const row of rows.slice(start)) {
    const cells = urlIndexes.length ? urlIndexes.map((index) => row[index]) : row;
    for (const cell of cells) {
      const normalized = tryNormalizeUrl(String(cell ?? ''));
      if (normalized) values.push(normalized);
    }
  }
  return uniqueUrls(values);
}

async function importXlsx(filePath: string): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const values: string[] = [];
  workbook.eachSheet((worksheet) => {
    const headerIndexes = new Set<number>();
    const firstRow = worksheet.getRow(1);
    firstRow.eachCell((cell, column) => {
      if (URL_HEADERS.has(cell.text.trim().toLowerCase())) headerIndexes.add(column);
    });
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1 && headerIndexes.size) return;
      row.eachCell((cell, column) => {
        if (headerIndexes.size && !headerIndexes.has(column)) return;
        const hyperlink = typeof cell.value === 'object' && cell.value && 'hyperlink' in cell.value
          ? String(cell.value.hyperlink)
          : null;
        const normalized = tryNormalizeUrl(hyperlink ?? cell.text);
        if (normalized) values.push(normalized);
      });
    });
  });
  return uniqueUrls(values);
}
