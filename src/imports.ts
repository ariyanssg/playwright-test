import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { extractUrlLikeValues, tryNormalizeUrl, uniqueUrls } from './urls.js';

const URL_HEADERS = new Set(['url', 'urls', 'website', 'domain', 'site', 'page', 'link']);
const NAME_HEADERS = new Set(['name', 'restaurant', 'restaurant name', 'business', 'business name', 'title']);
const ADDRESS_HEADERS = new Set(['address', 'street address', 'location', 'full address', 'formatted address']);
const PLACE_ID_HEADERS = new Set(['place_id', 'placeid', 'place id', 'google place id']);

export interface ImportedRow {
  url: string;
  /** Optional identity hints used to resolve the site's Google listing. */
  name?: string;
  address?: string;
  placeId?: string;
}

interface HintColumns {
  url: number[];
  name: number[];
  address: number[];
  placeId: number[];
}

export async function importRowsFromFile(filePath: string): Promise<ImportedRow[]> {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.xlsx' || extension === '.xlsm') return importXlsx(filePath);
  const text = await readFile(filePath, 'utf8');
  if (extension === '.csv') return importCsv(text);
  if (extension === '.txt' || !extension) return extractUrlLikeValues(text).map((url) => ({ url }));
  throw new Error(`Unsupported input file: ${extension || '(no extension)'}`);
}

export async function importUrlsFromFile(filePath: string): Promise<string[]> {
  const rows = await importRowsFromFile(filePath);
  return uniqueUrls(rows.map((row) => row.url));
}

function importCsv(text: string): ImportedRow[] {
  const rows = parse(text, { relax_column_count: true, skip_empty_lines: true }) as unknown[][];
  if (!rows.length) return [];
  const headers = (rows[0] ?? []).map((value) => String(value).trim().toLowerCase());
  const columns = mapColumns(headers.map((header, index) => ({ header, index })));

  // Without a recognizable header row the file is treated as bare URLs, exactly as before.
  if (!columns.url.length) {
    return dedupe(rows.flatMap((row) => row.map((cell) => ({ url: String(cell ?? '') }))));
  }

  return dedupe(rows.slice(1).flatMap((row) => {
    const hints = {
      name: cellText(row, columns.name),
      address: cellText(row, columns.address),
      placeId: cellText(row, columns.placeId),
    };
    return columns.url.map((index) => ({ url: String(row[index] ?? ''), ...hints }));
  }));
}

async function importXlsx(filePath: string): Promise<ImportedRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const collected: ImportedRow[] = [];
  workbook.eachSheet((worksheet) => {
    const columns = mapColumns([]);
    worksheet.getRow(1).eachCell((cell, column) => {
      assignColumn(columns, cell.text.trim().toLowerCase(), column);
    });

    worksheet.eachRow((row, rowNumber) => {
      if (!columns.url.length) {
        row.eachCell((cell) => collected.push({ url: cellValue(cell) }));
        return;
      }
      if (rowNumber === 1) return;
      const hints = {
        name: rowText(row, columns.name),
        address: rowText(row, columns.address),
        placeId: rowText(row, columns.placeId),
      };
      for (const column of columns.url) collected.push({ url: cellValue(row.getCell(column)), ...hints });
    });
  });
  return dedupe(collected);
}

function mapColumns(headers: Array<{ header: string; index: number }>): HintColumns {
  const columns: HintColumns = { url: [], name: [], address: [], placeId: [] };
  for (const { header, index } of headers) assignColumn(columns, header, index);
  return columns;
}

function assignColumn(columns: HintColumns, header: string, index: number): void {
  if (URL_HEADERS.has(header)) columns.url.push(index);
  else if (NAME_HEADERS.has(header)) columns.name.push(index);
  else if (ADDRESS_HEADERS.has(header)) columns.address.push(index);
  else if (PLACE_ID_HEADERS.has(header)) columns.placeId.push(index);
}

function cellText(row: unknown[], indexes: number[]): string | undefined {
  for (const index of indexes) {
    const value = String(row[index] ?? '').trim();
    if (value) return value;
  }
  return undefined;
}

function rowText(row: ExcelJS.Row, columns: number[]): string | undefined {
  for (const column of columns) {
    const value = row.getCell(column).text.trim();
    if (value) return value;
  }
  return undefined;
}

function cellValue(cell: ExcelJS.Cell): string {
  const hyperlink = typeof cell.value === 'object' && cell.value && 'hyperlink' in cell.value
    ? String(cell.value.hyperlink)
    : null;
  return hyperlink ?? cell.text;
}

/** Normalizes, drops non-URLs, and keeps the first hint seen for each URL. */
function dedupe(rows: readonly ImportedRow[]): ImportedRow[] {
  const merged = new Map<string, ImportedRow>();
  for (const row of rows) {
    const url = tryNormalizeUrl(row.url);
    if (!url) continue;
    const target = merged.get(url) ?? { url };
    // Hint keys are only ever added when present, so a plain URL list stays a plain URL list.
    for (const key of ['name', 'address', 'placeId'] as const) {
      const value = row[key]?.trim();
      if (value && !target[key]) target[key] = value;
    }
    merged.set(url, target);
  }
  return [...merged.values()];
}
