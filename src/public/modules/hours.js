import { $, escapeHtml as e, safeUrl, setHtml } from './ui.js';

export const HOURS_STATUS = { aligned: 'Hours match', minor_differences: 'Minor differences', mismatch: 'Hours differ', partial: 'Partly compared', no_website_hours: 'No hours on website', no_google_hours: 'No hours on Google', business_closed: 'Closed on Google', unmatched: 'Listing not found', not_checked: 'Not checked' };
/** What each outcome asks of the reader, shown under the restaurant's name. */
const HOURS_ADVICE = {
  aligned: 'Google shows the same weekly hours as the website.',
  minor_differences: 'Small differences within the tolerance you set. Worth tidying, not urgent.',
  mismatch: 'Customers see different hours on Google and on the website. Decide which is right and update the other.',
  partial: 'Only some days could be compared; the rest are missing on one side.',
  no_website_hours: 'No opening hours could be read from the website, so nothing was compared.',
  no_google_hours: 'The Google listing publishes no regular hours. Add them in Google Business Profile.',
  business_closed: 'Google marks this restaurant as closed. Check the listing if it is still trading.',
  unmatched: 'No Google listing could be confirmed as this restaurant. Add its street address or Place ID and run the audit again.',
  not_checked: 'This restaurant could not be checked this time. Resume the audit to try again.',
};
const DAY = { match: 'Same', both_closed: 'Both closed', minor_difference: 'Minor', mismatch: 'Differs', closed_on_google: 'Closed on Google', closed_on_website: 'Closed on website', missing_website: 'Not on website', missing_google: 'Not on Google', unknown: 'Unknown' };
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MATCH = { verified: 'Listing verified', place_id_supplied: 'Place ID supplied', unverified: 'Matched by name only', ambiguous: 'Several listings matched', none: 'No listing' };
/** Restaurants that need attention come first. */
const ORDER = ['mismatch', 'not_checked', 'unmatched', 'no_google_hours', 'no_website_hours', 'business_closed', 'partial', 'minor_differences', 'aligned'];
export const needsAttention = (record) => ['mismatch', 'not_checked', 'unmatched', 'no_google_hours', 'business_closed'].includes(record.status);

function host(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }

function card(record) {
  // Monday first, as menus and listings print the week.
  const days = [...record.days].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7));
  const rows = days.map((day) => `<tr class="${['mismatch', 'closed_on_google', 'closed_on_website'].includes(day.verdict) ? 'differs' : day.verdict === 'minor_difference' ? 'minor' : ''}"><td>${DAY_NAME[day.day]}</td><td data-label="Website">${e(day.websiteText || '—')}</td><td data-label="Google">${e(day.googleText || '—')}</td><td><span class="day-verdict ${e(day.verdict)}">${e(DAY[day.verdict] || day.verdict)}</span>${day.notes?.length ? `<small class="muted"> ${e(day.notes.join(' '))}</small>` : ''}</td></tr>`).join('');
  const listing = record.placeName ? `${e(record.placeName)}${record.placeAddress ? ` · ${e(record.placeAddress)}` : ''}` : 'No Google listing';
  return `<article class="hours-card">
    <header class="hours-head">
      <div><h3>${e(host(record.site))}</h3><p>${e(HOURS_ADVICE[record.status] || '')}</p></div>
      <span class="hours-status ${e(record.status)}">${e(HOURS_STATUS[record.status] || record.status)}</span>
    </header>
    <div class="hours-meta">
      <span><b>Google:</b> ${listing}</span>
      <span><b>Match:</b> ${e(MATCH[record.matchConfidence] || record.matchConfidence)}</span>
      ${record.websiteHoursUrl ? `<span><b>Website hours from:</b> <a href="${e(safeUrl(record.websiteHoursUrl))}" target="_blank" rel="noreferrer">${e(new URL(record.websiteHoursUrl).pathname || '/')}</a></span>` : `<span><b>Pages read:</b> ${record.pagesInspected}</span>`}
    </div>
    ${rows ? `<div class="profile-table hours-days"><table><thead><tr><th scope="col">Day</th><th scope="col">Website</th><th scope="col">Google</th><th scope="col">Result</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    ${record.notes.length ? `<ul class="hours-notes">${record.notes.map((note) => `<li>${e(note)}</li>`).join('')}</ul>` : ''}
  </article>`;
}

export function renderHours(records, enabled, running) {
  const root = $('#hours-results');
  if (!enabled) return setHtml(root, '');
  const sorted = [...(records || [])].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.site.localeCompare(b.site));
  setHtml(root, sorted.length ? sorted.map(card).join('') : `<div class="empty-panel"><b>${running ? 'Opening hours are compared after the pages are checked' : 'No opening hours were compared'}</b>${running ? 'Each restaurant appears here as soon as its hours have been read.' : 'Resume the audit, or check the notes for the reason.'}</div>`);
}
