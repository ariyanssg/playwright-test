import ExcelJS from 'exceljs/dist/exceljs.min.js';
export function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(value); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted field.');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
export async function readUpload(file, name) {
  let matrix;
  if (/\.xlsx$|\.xlsm$/i.test(name)) {
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await file.arrayBuffer());
    const imported = [];
    for (const sheet of workbook.worksheets) {
      const rows = []; sheet.eachRow((row) => rows.push(row.values.slice(1).map((cell) => typeof cell === 'object' && cell ? cell.text || cell.hyperlink || cell.result || '' : cell ?? '')));
      imported.push(...rowsToImports(rows));
    }
    return imported;
  } else if (/\.csv$/i.test(name)) matrix = parseCsv(await file.text());
  else return (await file.text()).split(/\r?\n/).map((url) => ({ url: url.trim() })).filter((r) => r.url);
  return rowsToImports(matrix);
}
function rowsToImports(matrix) {
  const headers = (matrix[0] || []).map((h) => String(h).replace(/^\uFEFF/, '').trim().toLowerCase());
  const column = (...names) => headers.findIndex((h) => names.includes(h));
  const urlColumn = column('url', 'urls', 'website', 'domain', 'site', 'page', 'link');
  const nameColumn = column('name', 'restaurant', 'restaurant name', 'business', 'business name', 'title');
  const addressColumn = column('address', 'street address', 'location', 'formatted address');
  const placeColumn = column('place_id', 'placeid', 'place id', 'google place id');
  return matrix.slice(urlColumn >= 0 ? 1 : 0).flatMap((row) => {
    const url = String(row[urlColumn >= 0 ? urlColumn : 0] || '').trim(); if (!url) return [];
    return [{ url, name: row[nameColumn] || undefined, address: row[addressColumn] || undefined, placeId: row[placeColumn] || undefined }];
  });
}
const columns = ['URL', 'Input URL', 'Site', 'Classification', 'HTTP Status', 'Final URL', 'Confidence', 'Reasons', 'Title', 'Checked At', 'Discovery Evidence', 'Error'];
const toRow = (c) => [c.normalizedUrl, c.inputUrl, c.site, c.result.classification, c.result.httpStatus, c.result.finalUrl, c.result.confidence, c.result.reasons.join('; '), c.result.title, c.result.checkedAt, JSON.stringify(c.sources), c.result.error || ''];
const safe = (value) => typeof value === 'string' && /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value ?? '';
const csv = (rows) => rows.map((row) => row.map((value) => `"${String(safe(value)).replaceAll('"', '""')}"`).join(',')).join('\r\n');
export async function exportFile(scan, candidates, name) {
  const completed = candidates.filter((c) => c.result), findings = completed.filter((c) => ['hard_404', 'gone_410', 'soft_404_suspected'].includes(c.result.classification));
  const hours = [['Site', 'Status', 'Google place', 'Match confidence', 'Website hours URL', 'Daily comparison', 'Notes'], ...scan.hours.map((h) => [h.site, h.status, h.placeName, h.matchConfidence, h.websiteHoursUrl, JSON.stringify(h.days), h.notes.join('; ')])];
  let blob;
  if (name === 'run.json') blob = new Blob([JSON.stringify({ scan, candidates, hours: scan.hours, coverage: { googleDiscovery: scan.googleDiscovery, storage: 'This browser only', googleSiteOperator: 'Observed results, not a complete index inventory' } }, null, 2)], { type: 'application/json' });
  else if (name === 'report.xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = (name, rows) => { const ws = workbook.addWorksheet(name); for (const row of rows) ws.addRow(row.map(safe)); ws.views = [{ state: 'frozen', ySplit: 1 }]; ws.getRow(1).font = { bold: true }; ws.columns.forEach((col) => { col.width = 28; }); return ws; };
    sheet('Summary', [['Audit', scan.id], ['Status', scan.status], ['URLs', scan.total], ['Checked', scan.processed], ['Findings', scan.findings], ['Storage', 'Browser IndexedDB'], ['Coverage', 'Google observations are not a complete index inventory']]);
    sheet('All URLs', [columns, ...completed.map(toRow)]); sheet('Broken & Soft 404', [columns, ...findings.map(toRow)]);
    sheet('Google Evidence', [['URL', 'Provider', 'Query', 'Page', 'Position', 'Title', 'Snippet', 'Search URL', 'Country', 'Language', 'Observed at', 'Kind'], ...candidates.flatMap((c) => c.sources.filter((s) => s.source === 'searchapi').map((s) => [c.normalizedUrl, s.provider, s.query, s.resultPage, s.position, s.title, s.snippet, s.searchUrl, s.country, s.language, s.observedAt, s.resultKind]))]);
    sheet('Google Coverage', [['Site', 'Pages fetched', 'Outcome', 'Query', 'Next page', 'Exhausted', 'Error'], ...scan.googleDiscovery.flatMap((s) => s.queries.map((q) => [s.site, s.pagesFetched, s.status, q.query, q.nextPage, q.done, s.error || '']))]);
    if (scan.options.checkHours) sheet('Hours', hours);
    blob = new Blob([await workbook.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  } else blob = new Blob([csv(name === 'hours.csv' ? hours : [columns, ...(name === 'findings.csv' ? findings : completed).map(toRow)])], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
