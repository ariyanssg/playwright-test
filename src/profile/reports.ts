import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type ExcelJS from 'exceljs';
import type { ProfileReport } from './model.js';

const safe = (value: unknown): string => String(value ?? '').replace(/^[\s]*([=+@-])/, "'$1");
const html = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const csv = (rows: unknown[][]) => '\uFEFF' + rows.map(row => row.map(v => `"${safe(v).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
const headers = ['Website', 'Requirement', 'Website value', 'Google value', 'Verdict', 'Exact match', 'Operational equivalence', 'Severity', 'Reason', 'Recommendation', 'Evidence'];
function rows(reports: ProfileReport[]): unknown[][] { return reports.flatMap(r => r.checks.map(c => [r.target.url, c.field, c.website.join('\n'), c.google.join('\n'), c.verdict, c.exactMatch ?? 'Unknown', c.semanticMatch ?? 'Unknown', c.severity, c.reason, c.recommendation, c.evidence.map(e => `${e.source} | ${e.url} | ${e.locator} | ${e.observedAt} | ${e.raw}`).join('\n')])); }
export async function writeProfileReports(output: string, reports: ProfileReport[]): Promise<string[]> {
  const artifacts = ['profile-audit.json', 'profile-fields.csv', 'profile-hours.csv', 'profile-links.csv', 'profile-report.html'];
  const all = rows(reports);
  await writeFile(join(output, artifacts[0]!), JSON.stringify({ schemaVersion: '1.0', reports }, null, 2) + '\n');
  await writeFile(join(output, artifacts[1]!), csv([headers, ...all]));
  await writeFile(join(output, artifacts[2]!), csv([headers, ...all.filter(row => /^(hours\.|special_hours)/.test(String(row[1])))]));
  await writeFile(join(output, artifacts[3]!), csv([['Website', 'Service', 'Source', 'URL', 'Final URL', 'HTTP', 'Health', 'Branch verified', 'Service ready', 'Reason', 'Checked at'], ...reports.flatMap(r => r.links.map(l => [r.target.url, l.service, l.source, l.url, l.finalUrl, l.httpStatus, l.health, l.correctBranch, l.serviceReady, l.reason, l.checkedAt]))]));
  await writeFile(join(output, artifacts[4]!), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Restaurant profile audit</title><style>body{font:15px system-ui;margin:32px;color:#18252e}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #cbd5dd;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#edf2f5}.scroll{overflow:auto}td{min-width:120px}h1{font-size:26px}small{color:#52616b}</style><h1>Website and Google Business Profile audit</h1><p>Published consistency and service readiness. Transactions were not submitted; real-world business facts require owner verification.</p>${reports.map(r => `<h2>${html(r.target.name || r.target.url)}</h2><p>${html(r.summary.outcome)} · ${r.summary.matches} matches · ${r.summary.mismatches} mismatches · ${r.summary.missing} missing · ${r.summary.unknown} unresolved. Branch: ${html(r.identity.status)}.</p><p>${r.warnings.map(html).join('<br>')}</p><small>Checked ${html(r.completedAt)} · Source mode ${html(r.mode)} · Retention ${html(r.retention)}</small><div class="scroll"><table><thead><tr>${headers.slice(1).map(h => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows([r]).map(row => `<tr>${row.slice(1).map(v => `<td>${html(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><h3>Acquisition coverage</h3><ul>${r.sources.flatMap(s => Object.entries(s.coverage).map(([field, c]) => `<li>${html(s.source)} / ${html(field)}: ${html(c.state)} — ${html(c.reason)}</li>`)).join('')}</ul>`).join('')}</html>`);
  return artifacts.map(file => join(output, file));
}
export function addProfileSheets(workbook: ExcelJS.Workbook, reports: ProfileReport[]): void {
  const summary = workbook.addWorksheet('Profile Summary');
  summary.addRow(['Website', 'Branch', 'Outcome', 'Matches', 'Equivalent', 'Mismatches', 'Missing', 'Unresolved', 'Retention', 'Warnings']);
  for (const r of reports) summary.addRow([r.target.url, r.identity.status, r.summary.outcome, r.summary.matches, r.summary.equivalent, r.summary.mismatches, r.summary.missing, r.summary.unknown, r.retention, r.warnings.join('\n')].map(safe));
  const all = rows(reports);
  for (const [name, selected] of [['Field Comparisons', all.filter(r => !/hours/.test(String(r[1])))], ['Weekly Hours', all.filter(r => /^hours\./.test(String(r[1])))], ['Special Hours', all.filter(r => /^special_hours/.test(String(r[1])))] ] as const) {
    const sheet = workbook.addWorksheet(name); sheet.addRow(headers); for (const row of selected) sheet.addRow(row.map(safe));
  }
  const links = workbook.addWorksheet('Service Links');
  links.addRow(['Website', 'Service', 'Source', 'URL', 'Final URL', 'HTTP', 'Health', 'Reason', 'Provider', 'Preferred']);
  for (const r of reports) for (const l of r.links) links.addRow([r.target.url, l.service, l.source, l.url, l.finalUrl, l.httpStatus, l.health, l.reason, l.provider, l.preferred].map(safe));
  const coverage = workbook.addWorksheet('Profile Coverage'); coverage.addRow(['Website', 'Source', 'Field', 'Coverage', 'Reason']);
  for (const r of reports) for (const s of r.sources) for (const [field, c] of Object.entries(s.coverage)) coverage.addRow([r.target.url, s.source, field, c.state, c.reason].map(safe));
  for (const sheet of [summary, links, coverage, ...['Field Comparisons', 'Weekly Hours', 'Special Hours'].map(n => workbook.getWorksheet(n)!)]) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
    sheet.columns.forEach((column, i) => column.width = i === 0 ? 38 : 26);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF194B5E' } };
    sheet.eachRow(row => row.alignment = { vertical: 'top', wrapText: true });
  }
}
