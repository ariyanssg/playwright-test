import { $, escapeHtml as e, safeUrl, setHtml } from './ui.js';

const VERDICT = { match: 'Match', equivalent: 'Equivalent', mismatch: 'Mismatch', source_conflict: 'Conflict', missing_website: 'Missing on website', missing_google: 'Missing on Google', missing_both: 'Missing on both', unverifiable: 'Unresolved' };
const OUTCOME = { pass: 'Consistent', issues: 'Needs fixes', incomplete: 'Incomplete' };
const IDENTITY = { verified: 'Branch verified', ambiguous: 'Several matches', unmatched: 'No listing', unverified: 'Branch not verified' };
const MODE = { public: 'Google Maps listing', managed: 'Business Profile you manage', imported: 'Profile details you supplied' };
const RETENTION = { durable: 'Saved in full', session_only: 'Google values kept for this session only', redacted: 'Google values removed from the saved copy' };
const SOURCE = { website: 'Website', places: 'Google Maps', gbp_managed: 'Business Profile', gbp_google_updated: 'Google-suggested edits', imported: 'Supplied details' };
const SERVICE = { website: 'Website', menu: 'Menu', reservations: 'Reservations', ordering: 'Ordering' };
const HEALTH = { functional: 'Working', hard_404: 'Hard 404', gone_410: 'Gone 410', soft_404_suspected: 'Soft 404 suspected', wrong_destination: 'Wrong destination', wrong_location: 'Wrong branch', server_error: 'Server error', blocked: 'Blocked', timeout: 'Timed out', network_error: 'Network error', temporarily_unavailable: 'Temporarily unavailable', unverified: 'Needs a manual check' };
const STATE = { present: 'Found', not_found: 'Not found', unsupported: 'Not offered', unavailable: 'Unavailable', partial: 'Partly read' };
const FIELD = { name: 'Restaurant name', phone: 'Phone', website: 'Website', address: 'Address', hours: 'Opening hours', special_hours: 'Special hours', business_status: 'Business status', timezone: 'Time zone', attributions: 'Attributions', 'services.menu': 'Menu link', 'services.reservations': 'Reservation link', 'services.ordering': 'Ordering link' };

function fieldLabel(field) {
  if (FIELD[field]) return FIELD[field];
  let match = /^hours\.(\w+)$/.exec(field);
  if (match) return match[1];
  match = /^special_hours\.(.+)$/.exec(field);
  if (match) return new Date(`${match[1]}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  match = /^(services\.\w+|website)\.health$/.exec(field);
  if (match) return `${fieldLabel(match[1])} works`;
  match = /^google_updates\.(\w+)$/.exec(field);
  if (match) return `${fieldLabel(match[1])} (suggested edit)`;
  return field.replace(/[._]/g, ' ');
}
function group(field) {
  if (/^google_updates\./.test(field)) return 'Google-suggested edits';
  if (/\.health$/.test(field)) return 'Do the links work?';
  if (/^hours\./.test(field)) return 'Opening hours';
  if (/^special_hours/.test(field)) return 'Holiday and special hours';
  if (/^services\./.test(field)) return 'Menu, booking and ordering links';
  return 'Identity';
}
const healthTone = (health) => health === 'functional' ? 'functional' : ['hard_404', 'gone_410', 'soft_404_suspected', 'wrong_destination', 'wrong_location', 'server_error'].includes(health) ? 'bad' : 'unsure';
const value = (values, label) => {
  const text = values.filter(Boolean).join('\n');
  return `<td class="value${text ? '' : ' none'}" data-label="${e(label)}">${e(text || 'Not observed')}</td>`;
};

const GROUP_ORDER = ['Identity', 'Opening hours', 'Holiday and special hours', 'Menu, booking and ordering links', 'Do the links work?', 'Google-suggested edits'];

function checksTable(checks) {
  let current = '';
  // Group rows so each heading appears once; the sort is stable, so order within a group holds.
  const sorted = [...checks].sort((left, right) => GROUP_ORDER.indexOf(group(left.field)) - GROUP_ORDER.indexOf(group(right.field)));
  const rows = sorted.map((check) => {
    const heading = group(check.field);
    const divider = heading !== current ? `<tr class="profile-group-row"><td colspan="5">${e(heading)}</td></tr>` : '';
    current = heading;
    const evidence = check.evidence.length ? `<details><summary>Source evidence (${check.evidence.length})</summary>${check.evidence.map((fact) => `<p><b>${e(SOURCE[fact.source] || fact.source)} · ${e(fact.locator)}</b><br>${e(fact.url)}<br>${e(fact.observedAt)}<br>${e(fact.raw)}</p>`).join('')}</details>` : '';
    return `${divider}<tr data-verdict="${e(check.verdict)}"><td>${e(fieldLabel(check.field))}</td>${value(check.website, 'Website')}${value(check.google, 'Google')}<td><span class="verdict ${e(check.verdict)}">${e(VERDICT[check.verdict] || check.verdict)}</span></td><td><p class="reason">${e(check.reason)}</p>${check.verdict === 'match' ? '' : `<p class="recommendation">${e(check.recommendation)}</p>`}${evidence}</td></tr>`;
  }).join('');
  return `<div class="profile-table"><table><thead><tr><th scope="col">Detail</th><th scope="col">Website says</th><th scope="col">Google says</th><th scope="col">Result</th><th scope="col">Why, and what to do</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function card(report) {
  const s = report.summary;
  const attributions = report.sources.filter((source) => source.source === 'places').flatMap((source) => source.facts.filter((fact) => fact.field === 'attributions').flatMap((fact) => Array.isArray(fact.value) ? fact.value : []));
  const coverage = report.sources.flatMap((source) => Object.entries(source.coverage).map(([field, entry]) => `<li><span>${e(SOURCE[source.source] || source.source)} · ${e(fieldLabel(field))}</span><span class="state ${e(entry.state)}">${e(STATE[entry.state] || entry.state)}</span><p>${e(entry.reason)}</p></li>`));
  const links = report.links.map((link) => `<li><span class="service">${e(SERVICE[link.service] || link.service)}</span><span><a href="${e(safeUrl(link.url))}" target="_blank" rel="noreferrer">${e(link.url)}</a></span><p><span class="link-health ${healthTone(link.health)}">${e(HEALTH[link.health] || link.health)}<span class="sr-only"> (${e(link.health)})</span></span> · ${e(SOURCE[link.source] || link.source)} · HTTP ${link.httpStatus ?? 'unknown'}${link.finalUrl && link.finalUrl !== link.url ? ` · ends at ${e(link.finalUrl)}` : ''}<br>${e(link.reason)}</p></li>`).join('');
  return `<article class="profile-card">
    <header class="profile-head">
      <div><h3>${e(report.target.name || report.sources.find((source) => source.source === 'website')?.facts.find((item) => item.field === 'name')?.value || hostname(report.target.url))}</h3><p>${e(MODE[report.mode] || report.mode)} · checked ${e(new Date(report.completedAt).toLocaleString())} · ${e(RETENTION[report.retention] || report.retention)}</p></div>
      <span class="status-pill profile-outcome ${e(s.outcome)}">${e(OUTCOME[s.outcome] || s.outcome)}</span>
    </header>
    <dl class="profile-tally">
      <div class="good"><dt>Match</dt><dd>${s.matches}</dd></div>
      <div><dt>Equivalent</dt><dd>${s.equivalent}</dd></div>
      <div class="${s.mismatches ? 'bad' : ''}"><dt>Mismatch</dt><dd>${s.mismatches}</dd></div>
      <div class="${s.missing ? 'warn' : ''}"><dt>Missing</dt><dd>${s.missing}</dd></div>
      <div><dt>Unresolved</dt><dd>${s.unknown}</dd></div>
      <div class="${s.brokenLinks ? 'bad' : ''}"><dt>Broken links</dt><dd>${s.brokenLinks}</dd></div>
    </dl>
    <div class="profile-identity"><span class="identity-state ${e(report.identity.status)}">${e(IDENTITY[report.identity.status] || report.identity.status)}</span><p>${e(report.identity.reason)}</p></div>
    ${checksTable(report.checks)}
    ${attributions.length ? `<p class="attribution">Google data: ${attributions.map((item) => `<a href="${e(safeUrl(item.providerUri))}" target="_blank" rel="noreferrer">${e(item.provider)}</a>`).join(', ')}</p>` : ''}
    <div class="profile-sections">
      <details><summary>Service link checks (${report.links.length})<svg aria-hidden="true"><use href="#i-chevron"/></svg></summary><div>${links ? `<ul class="link-list">${links}</ul>` : '<p class="muted">No service links were found to check.</p>'}</div></details>
      <details ${report.warnings.length && s.outcome === 'incomplete' ? 'open' : ''}><summary>Coverage and audit notes (${report.warnings.length + coverage.length})<svg aria-hidden="true"><use href="#i-chevron"/></svg></summary><div>${report.warnings.length ? `<ul class="warning-list">${report.warnings.map((warning) => `<li>${e(warning)}</li>`).join('')}</ul>` : ''}<ul class="coverage-list">${coverage.join('')}</ul></div></details>
    </div>
  </article>`;
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Restaurants whose comparison found something to fix or could not finish. */
export const profileIssues = (reports) => (reports || []).filter((report) => report.summary.outcome !== 'pass').length;

export function renderProfiles(reports, enabled, running = false) {
  const root = $('#profile-results'); if (!root) return;
  root.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  // Preserve which sections the reader has opened across live refreshes.
  const open = [...root.querySelectorAll('details')].map((details) => details.open);
  const problemsOnly = root.querySelector('#profile-problems')?.checked ?? false;
  // Restaurants with something to fix come first.
  const rank = { issues: 0, incomplete: 1, pass: 2 };
  const sorted = [...(reports || [])].sort((a, b) => (rank[a.summary.outcome] ?? 1) - (rank[b.summary.outcome] ?? 1));
  const toolbar = `<div class="profile-toolbar"><h2>Website vs. Google profile <span class="count-chip">${sorted.length}</span></h2><label><input type="checkbox" id="profile-problems" ${problemsOnly ? 'checked' : ''}>Show only items to fix</label></div>`;
  const changed = setHtml(root, `${toolbar}${sorted.length ? sorted.map(card).join('') : `<div class="empty-panel"><b>${running ? 'The business profile is compared after the pages are checked' : 'No business profile was compared'}</b>${running ? 'Each restaurant appears here as soon as its profile has been compared.' : 'Resume the audit, or check the notes for the reason.'}</div>`}`);
  root.classList.toggle('problems-only', problemsOnly);
  if (changed && open.length) root.querySelectorAll('details').forEach((details, index) => { if (index < open.length) details.open = open[index]; });
}

document.addEventListener('change', (event) => {
  if (event.target.id === 'profile-problems') $('#profile-results').classList.toggle('problems-only', event.target.checked);
});
