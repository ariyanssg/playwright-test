import { createHash } from 'node:crypto';
import { DAY_INDEXES, DAY_NAMES } from '../hours/schedule.js';
import type { OpenInterval, WeeklyHours } from '../types.js';
import { addressMatch, dayIntervals, formatIntervals, phone, sameHost, textKey, urlKey } from './normalize.js';
import { CORE_FIELDS, emptySnapshot, first, SERVICES, type ImportedProfile, type ProfileCheck, type ProfileMode, type ProfileReport, type ProfileSnapshot, type ProfileTarget, type WebsiteSnapshot, type Fact, type LinkCheck } from './model.js';
import { BusinessProfileConnection, fromImported, managedProfiles, publicProfiles, serperMapsProfiles, type ApiRead } from './providers.js';
import { ProfileBrowser } from './website.js';
import { readMapsServiceLinks, searchPanelLinks } from './maps-panel.js';
import { GoogleBrowser } from '../discovery/google-browser.js';
import { GoogleChallengeError } from '../discovery/google-results.js';

const LINK_CHECK_PARALLEL = 4;

export interface AuditOptions { mode: ProfileMode; pageLimit: number; timeoutMs: number; hostDelayMs: number; country: string; tolerance: number; signal?: AbortSignal; waitForGoogle?: (message: string) => Promise<void> }
export interface AuditDependencies { browser?: Pick<ProfileBrowser, 'crawl' | 'check' | 'close'>; mapsPanel?: typeof readMapsServiceLinks; searchPanel?: (query: string, signal?: AbortSignal) => Promise<Array<{ attr: string; label: string; href: string }>>; publicRead?: ApiRead; managedRead?: ApiRead; imported?: ImportedProfile[]; gbp?: BusinessProfileConnection }
export function targetKey(target: ProfileTarget): string { return createHash('sha256').update(JSON.stringify([target.url, target.placeId || '', target.gbpLocation || '', target.address || ''])).digest('hex').slice(0, 24); }

export async function auditProfile(auditId: string, target: ProfileTarget, options: AuditOptions, pages: string[] = [], deps: AuditDependencies = {}): Promise<ProfileReport> {
  const startedAt = new Date().toISOString();
  const browser = deps.browser ?? new ProfileBrowser({ ...options });
  let website: WebsiteSnapshot = { ...emptySnapshot('website'), source: 'website', finalUrl: target.url, pages: [] };
  let candidates: ProfileSnapshot[] = [], extras: ProfileSnapshot[] = [];
  const warnings: string[] = [];
  let acquisitionError = '';
  let links: LinkCheck[] = [];
  try {
    website = await browser.crawl(target, pages);
    if (!options.signal?.aborted) {
      try {
        if (options.mode === 'imported') {
          const matching = (deps.imported || []).filter(row => row.url === target.url || (sameHost(row.url, target.url) && (target.placeId ? row.placeId === target.placeId : true)));
          candidates = matching.map(fromImported);
          if (!matching.length) warnings.push('No supplied profile evidence matches this target');
        } else if (options.mode === 'managed') {
          if (!target.gbpLocation) throw new Error('Select a GBP location or supply profileTargets with a gbpLocation for each restaurant');
          const snapshots = await managedProfiles(target.gbpLocation, deps.managedRead ?? (url => (deps.gbp ?? new BusinessProfileConnection()).read(url)));
          candidates = snapshots.slice(0, 1); extras = snapshots.slice(1);
        } else {
          const query = [target.name || first<string>(website, 'name'), target.address || first<string>(website, 'address')].filter(Boolean).join(', ');
          if (!target.placeId && !query) throw new Error('Restaurant identity could not be extracted; provide a name/address or Place ID');
          candidates = await publicListing(query, target.placeId, options, deps, warnings);
        }
      } catch (error) { acquisitionError = error instanceof Error ? error.message : 'Google acquisition failed'; warnings.push(`${LISTING_UNAVAILABLE}${acquisitionError}`); }
    }
    const resolution = resolveIdentity(target, website, candidates, options.country);
    // Say why there is nothing to compare, not merely that nothing was acquired.
    if (!candidates.length && acquisitionError) resolution.identity = { status: 'unmatched', placeId: null, reason: `Google listing could not be read: ${acquisitionError}` };
    const google = resolution.snapshot ?? emptySnapshot(options.mode === 'public' ? 'places' : options.mode === 'managed' ? 'gbp_managed' : 'imported', 'No verified Google branch; comparisons unavailable');
    const verified = resolution.identity.status === 'verified';
    // Menu, booking and ordering links are published on the Maps listing and in Google Search's
    // business panel, and neither API returns them. Maps is read silently first; the Search panel
    // (which needs a real, visible browser) only fills in what Maps did not show.
    const live = options.mode === 'public' && !deps.publicRead;
    const panel = deps.mapsPanel ?? (live ? readMapsServiceLinks : undefined);
    if (verified && google.placeId && !options.signal?.aborted && (panel || deps.searchPanel || live)) {
      let mapsRead = false, searchRead = false;
      if (panel) {
        try {
          const found = await panel(google.placeId, options.country, options.timeoutMs);
          addLinks(google, found.links);
          mapsRead = true;
        } catch (error) { warnings.push(`Google Maps listing buttons could not be read (${error instanceof Error ? error.message : String(error)})`); }
      }
      const gaps = SERVICES.filter(service => !google.links.some(l => l.service === service));
      if (gaps.length && (deps.searchPanel || live)) {
        const query = [first<string>(google, 'name'), first<string>(google, 'address')].filter(Boolean).join(' ');
        const searchBrowser = deps.searchPanel ? null : new GoogleBrowser();
        const read = deps.searchPanel ?? ((q: string, signal?: AbortSignal) => searchBrowser!.localPanel(q, signal));
        try {
          for (let attempt = 0; attempt < 3 && !options.signal?.aborted; attempt++) {
            try { addLinks(google, searchPanelLinks(await read(query, options.signal))); searchRead = true; break; }
            catch (error) {
              if (!(error instanceof GoogleChallengeError) || !options.waitForGoogle) throw error;
              await options.waitForGoogle(error.message);
            }
          }
        } catch (error) {
          warnings.push(`Google Search business panel could not be read (${error instanceof Error ? error.message : String(error)}); ${gaps.join(', ')} links on Google stay unresolved`);
        } finally { await searchBrowser?.close().catch(() => undefined); }
      }
      for (const service of SERVICES) {
        const count = google.links.filter(l => l.service === service).length;
        // Maps can omit a link that Google Search still shows (a menu link, typically), so absence
        // is only claimed once the Search business panel itself has been read.
        google.coverage[`services.${service}`] = count ? { state: 'present', reason: `${count} link(s) on Google` }
          : searchRead ? { state: 'not_found', reason: `Not shown on ${mapsRead ? 'the Google Maps listing or ' : ''}the Google Search business panel` }
          : { state: 'partial', reason: mapsRead ? 'Not shown on the Google Maps listing, and Google Search’s business panel could not be checked' : 'Google’s listing buttons could not be read' };
      }
    }
    const websiteDestinations = [website, ...(verified ? [google] : [])].flatMap(s => {
      const url = first<string>(s, 'website'); return url ? [{ service: 'website' as const, url, source: s.source, label: 'Official website' }] : [];
    });
    // Service destinations are mostly on different hosts (booking and ordering platforms), so
    // they are checked a few at a time; results keep their original order.
    const destinations = [...websiteDestinations, ...website.links, ...(verified ? google.links : [])];
    const checked: Array<LinkCheck | undefined> = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(LINK_CHECK_PARALLEL, destinations.length) }, async () => {
      for (let index = next++; index < destinations.length; index = next++) {
        if (options.signal?.aborted) return;
        checked[index] = await browser.check(destinations[index]!, target, website);
      }
    }));
    links = checked.filter((item): item is LinkCheck => item !== undefined);
    const checks = compareProfiles(website, google, verified, options.country, options.tolerance, links);
    if (verified) for (const extra of extras) for (const field of ['name', 'phone', 'website', 'hours']) {
      const a = first(google, field), b = first(extra, field);
      if (a !== undefined && b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) checks.push({ field: `google_updates.${field}`, verdict: 'source_conflict', exactMatch: false, semanticMatch: null, website: [], google: [JSON.stringify(a), JSON.stringify(b)], evidence: [...google.facts, ...extra.facts].filter(f => f.field === field), severity: 'warning', reason: 'Managed and Google-updated values differ', recommendation: 'Review the managed and Google-updated profile values before changing either source.' });
    }
    const report: ProfileReport = {
      schemaVersion: '1.0', auditId, targetKey: targetKey(target), target, mode: options.mode, startedAt, completedAt: new Date().toISOString(),
      status: options.signal?.aborted ? 'cancelled' : 'completed', identity: resolution.identity, checks, links,
      sources: [website, google, ...extras], pages: website.pages, summary: summarize(checks, links, verified),
      warnings: [...warnings, ...website.warnings, ...google.warnings, ...extras.flatMap(s => s.warnings)],
      retention: options.mode === 'imported' ? 'durable' : 'session_only', rules: { version: '1.0', hoursToleranceMinutes: options.tolerance, country: options.country },
    };
    if (report.status !== 'cancelled' && (report.summary.unknown > 0 || !verified || website.warnings.length)) report.status = 'completed_partial';
    if (report.retention === 'session_only') report.warnings.push('Google values and comparisons are shown live only and are not saved (Google’s terms). They stay on screen for an hour or until the dashboard restarts; Refresh profile audit fetches them again.');
    return report;
  } finally { await browser.close(); }
}

function addLinks(snapshot: ProfileSnapshot, links: ProfileSnapshot['links']): void {
  for (const link of links) if (!snapshot.links.some(l => l.service === link.service && l.url === link.url)) snapshot.links.push(link);
}

/** Prefix that marks a failure to read Google, which saved reports keep (it holds no Google data). */
export const LISTING_UNAVAILABLE = 'Google listing unavailable: ';

/**
 * Reads the public listing from the cheapest source that works: Serper's Google Maps data when
 * SERPER_API_KEY is set, then the Places API. A source that fails is noted, never silent.
 */
async function publicListing(query: string, placeId: string | undefined, options: AuditOptions, deps: AuditDependencies, warnings: string[]): Promise<ProfileSnapshot[]> {
  const failures: string[] = [];
  const serper = !deps.publicRead && process.env.SERPER_API_KEY && query;
  const places = Boolean(deps.publicRead || process.env.GOOGLE_MAPS_API_KEY);
  if (!serper && !places) throw new Error('Reading the public Google listing needs SERPER_API_KEY (cheapest) or GOOGLE_MAPS_API_KEY (Places API New) in .env.');
  if (serper) {
    try {
      const found = await serperMapsProfiles(query, options.country, placeId, options.signal);
      if (found.length) return found;
      failures.push(`Google Maps (via Serper) found no listing for "${query}"`);
    } catch (error) { failures.push(`Google Maps via Serper: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (places) {
    try {
      const found = await publicProfiles(query, placeId, options.signal, deps.publicRead);
      for (const failure of failures) warnings.push(`${failure}; used Google Places instead`);
      return found;
    } catch (error) { failures.push(`Google Places: ${error instanceof Error ? error.message : String(error)}`); }
  }
  throw new Error(failures.join(' · '));
}

export function resolveIdentity(target: ProfileTarget, website: ProfileSnapshot, candidates: ProfileSnapshot[], country: string): { identity: ProfileReport['identity']; snapshot?: ProfileSnapshot } {
  // A site may print its address in a footer and again, differently punctuated, on a contact
  // page. Any published address is valid branch evidence, so all of them are candidates.
  const expectedAddresses = (target.address ? [target.address] : website.facts.filter(f => f.field === 'address').map(f => String(f.value))).filter(Boolean);
  const expectedPhones = website.facts.filter(f => f.field === 'phone').map(f => phone(String(f.value), country)).filter(Boolean);
  const scored = candidates.map(snapshot => {
    const actualAddress = first<string>(snapshot, 'address') || '';
    const addressMatches = expectedAddresses.some(expected => addressMatch(expected, actualAddress));
    const phoneMatches = expectedPhones.includes(phone(first<string>(snapshot, 'phone') || '', country));
    const hostMatches = sameHost(first<string>(snapshot, 'website') || '', target.url);
    // A branch address is independent evidence even when name, telephone or GBP URL is wrong.
    const addressConflict = Boolean(expectedAddresses.length && actualAddress && /\d/.test(actualAddress) && expectedAddresses.some(expected => /\d/.test(expected)) && !addressMatches);
    const score = addressMatches ? 3 : !addressConflict && phoneMatches && hostMatches ? 2 : 0;
    return { snapshot, score };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return { identity: { status: 'unmatched', placeId: null, reason: 'No profile acquired' } };
  if (!best.score) return { identity: { status: 'unverified', placeId: best.snapshot.placeId || null, reason: 'A supplied ID/name/domain alone cannot verify a restaurant branch; add its street address and postcode.' } };
  if (scored[1]?.score === best.score) return { identity: { status: 'ambiguous', placeId: null, reason: 'Multiple profiles match this branch; supply a specific Place ID or GBP location.' } };
  return { snapshot: best.snapshot, identity: { status: 'verified', placeId: best.snapshot.placeId || null, reason: best.score === 3 ? 'Matched branch street address/postcode independently of name and website URL' : 'Matched telephone and website host' } };
}

function baseCheck(field: string, website: ProfileSnapshot, google: ProfileSnapshot): ProfileCheck {
  const wf = website.facts.filter(f => f.field === field), gf = google.facts.filter(f => f.field === field);
  return { field, verdict: 'unverifiable', exactMatch: null, semanticMatch: null, website: wf.map(f => f.raw), google: gf.map(f => f.raw), evidence: [...wf, ...gf], severity: 'warning', reason: '', recommendation: 'Review the source evidence and publish the approved restaurant information consistently.' };
}
function missing(check: ProfileCheck, website: ProfileSnapshot, google: ProfileSnapshot, verified: boolean, field = check.field): ProfileCheck | null {
  const w = website.coverage[field], g = google.coverage[field];
  if (!verified || !g || ['unavailable', 'partial', 'unsupported'].includes(g.state) || !w || ['unavailable', 'partial', 'unsupported'].includes(w.state)) return { ...check, reason: !verified ? 'Google branch is not verified' : [w?.reason, g?.reason].filter(Boolean).join('; ') };
  if (w.state === 'not_found' || g.state === 'not_found') return { ...check, verdict: w.state === 'not_found' && g.state === 'not_found' ? 'missing_both' : w.state === 'not_found' ? 'missing_website' : 'missing_google', severity: 'error', reason: `Absent within observed scope: ${w.reason}; ${g.reason}` };
  return null;
}
function finish(check: ProfileCheck, exact: boolean, semantic: boolean): ProfileCheck {
  return { ...check, verdict: exact ? 'match' : semantic ? 'equivalent' : 'mismatch', exactMatch: exact, semanticMatch: semantic, severity: exact ? 'info' : semantic ? 'warning' : 'error', reason: exact ? 'Published values match exactly' : semantic ? 'Different published formatting; equivalent normalized value or verified destination' : 'Published values disagree', recommendation: exact ? 'No change needed for this check.' : check.recommendation };
}
export function compareProfiles(website: ProfileSnapshot, google: ProfileSnapshot, verified: boolean, country: string, tolerance: number, links: LinkCheck[]): ProfileCheck[] {
  const checks: ProfileCheck[] = [];
  for (const field of ['name', 'phone', 'website']) {
    const check = baseCheck(field, website, google), absent = missing(check, website, google, verified);
    if (absent) { checks.push(absent); continue; }
    const wf = website.facts.filter(f => f.field === field), gf = google.facts.filter(f => f.field === field);
    const key = (f: Fact) => field === 'phone' ? phone(String(f.value), country) : field === 'website' ? urlKey(String(f.value)) : textKey(String(f.value));
    const keys = [...new Set(wf.map(key).filter(Boolean))];
    // Restaurants routinely list a second line (takeaway, bookings). When Google shows one of
    // the website's numbers, that is agreement, not a conflict between the site's own values.
    const googleKey = gf[0] ? key(gf[0]) : null;
    const agreeing = field === 'phone' && googleKey ? wf.find(f => key(f) === googleKey) : undefined;
    if (keys.length > 1 && field !== 'website' && !agreeing) { checks.push({ ...check, verdict: 'source_conflict', reason: 'Website publishes multiple different values; no source was silently selected', severity: 'error' }); continue; }
    const websiteFact = agreeing ?? wf[0];
    if (!websiteFact || !gf[0]) { checks.push({ ...check, reason: 'Field could not be parsed' }); continue; }
    const w = String(websiteFact.value).trim(), g = String(gf[0].value).trim();
    const final = (url: string) => links.find(l => l.url === url && l.health === 'functional')?.finalUrl;
    const semantic = field === 'website' ? Boolean(urlKey(w) === urlKey(g) || (final(w) && final(w) === final(g))) : Boolean(key(websiteFact) && key(websiteFact) === key(gf[0]));
    const result = finish(check, w === g, semantic);
    if (field === 'name' && websiteFact.confidence === 'low') { result.verdict = 'unverifiable'; result.reason = 'Restaurant name inferred from page title; visible branding needs verification'; }
    checks.push(result);
  }
  const wh = first<WeeklyHours>(website, 'hours'), gh = first<WeeklyHours>(google, 'hours');
  for (const day of DAY_INDEXES) {
    const check = { ...baseCheck('hours', website, google), field: `hours.${DAY_NAMES[day]}` };
    const absent = missing(check, website, google, verified, 'hours');
    if (absent) { checks.push(absent); continue; }
    const w = wh ? dayIntervals(wh, day) : null, g = gh ? dayIntervals(gh, day) : null;
    check.website = [formatIntervals(w)]; check.google = [formatIntervals(g)];
    const alternatives = website.facts.filter(f => f.field === 'hours').map(f => dayIntervals(f.value as WeeklyHours, day)).filter(v => v !== null);
    if (new Set(alternatives.map(v => JSON.stringify(v))).size > 1) { checks.push({ ...check, verdict: 'source_conflict', reason: 'Website hours disagree between pages or extraction layers', severity: 'error' }); continue; }
    if (w === null || g === null) { checks.push({ ...check, verdict: w === null && g === null ? 'unverifiable' : w === null ? 'missing_website' : 'unverifiable', reason: 'Unknown day; an omitted day is never treated as closed' }); continue; }
    const result = finish(check, JSON.stringify(w) === JSON.stringify(g), JSON.stringify(w) === JSON.stringify(g));
    if (!result.exactMatch && w.length === g.length && w.every((i, index) => Math.abs(i.start - g[index]!.start) <= tolerance && Math.abs(i.end - g[index]!.end) <= tolerance)) { result.severity = 'warning'; result.reason += `; within configured ${tolerance}-minute severity tolerance (still not exact)`; }
    checks.push(result);
  }
  const ws = first<Record<string, OpenInterval[]>>(website, 'special_hours') || {}, gs = first<Record<string, OpenInterval[]>>(google, 'special_hours') || {};
  const dates = [...new Set([...Object.keys(ws), ...Object.keys(gs)])].sort();
  if (!dates.length) checks.push({ ...baseCheck('special_hours', website, google), reason: 'No comparable dated exceptions observed; holiday correctness is unverified' });
  for (const date of dates) {
    const check = { ...baseCheck('special_hours', website, google), field: `special_hours.${date}`, website: [formatIntervals(ws[date] || null)], google: [formatIntervals(gs[date] || null)] };
    const timezone = first<string>(google, 'timezone') || first<string>(website, 'timezone');
    if (!verified || !timezone || !ws[date] || !gs[date]) { checks.push({ ...check, reason: 'Date exception or location timezone unavailable on one source' }); continue; }
    checks.push(finish(check, JSON.stringify(ws[date]) === JSON.stringify(gs[date]), JSON.stringify(ws[date]) === JSON.stringify(gs[date])));
  }
  for (const service of SERVICES) {
    const field = `services.${service}`, w = website.links.filter(l => l.service === service), g = google.links.filter(l => l.service === service);
    const check = { ...baseCheck(field, website, google), website: w.map(l => l.url), google: g.map(l => l.url) };
    const absent = missing(check, website, google, verified);
    const noun = service === 'menu' ? 'menu' : service === 'reservations' ? 'booking' : 'online ordering';
    if (absent?.verdict === 'missing_google') absent.recommendation = `The website has a ${noun} link but the Google listing shows none. Add it in Google Business Profile (Edit profile → ${service === 'menu' ? 'Menu link' : service === 'reservations' ? 'Bookings' : 'Order ahead'}) so customers can use it from Google.`;
    else if (absent?.verdict === 'missing_website') absent.recommendation = `Google shows a ${noun} link that the website does not. Link to it from the website too, or remove it from the listing if it is out of date.`;
    if (absent) checks.push(absent);
    else {
      const exact = g.some(gl => w.some(wl => wl.url === gl.url));
      const equivalent = g.some(gl => w.some(wl => {
        const a = links.find(l => l.url === gl.url && l.service === service), b = links.find(l => l.url === wl.url && l.service === service);
        return a?.health === 'functional' && b?.health === 'functional' && (a.finalUrl === b.finalUrl || (a.correctBranch && b.correctBranch));
      }));
      checks.push(finish(check, exact, exact || equivalent));
    }
    for (const link of links.filter(l => l.service === service)) checks.push({ field: `${field}.health`, verdict: link.health === 'functional' ? 'match' : ['blocked', 'timeout', 'network_error', 'unverified', 'temporarily_unavailable'].includes(link.health) ? 'unverifiable' : 'mismatch', exactMatch: null, semanticMatch: null, website: link.source === 'website' ? [link.url] : [], google: link.source !== 'website' ? [link.url] : [], evidence: [], severity: link.health === 'functional' ? 'info' : 'warning', reason: link.reason, recommendation: link.health === 'functional' ? 'No change needed; transaction completion was not tested.' : 'Inspect this service destination and restore the correct restaurant interface.' });
  }
  for (const link of links.filter(l => l.service === 'website')) checks.push({ field: 'website.health', verdict: link.health === 'functional' ? 'match' : ['blocked', 'timeout', 'network_error', 'unverified'].includes(link.health) ? 'unverifiable' : 'mismatch', exactMatch: null, semanticMatch: null, website: link.source === 'website' ? [link.url] : [], google: link.source !== 'website' ? [link.url] : [], evidence: [], severity: link.health === 'functional' ? 'info' : 'warning', reason: link.reason, recommendation: link.health === 'functional' ? 'No change needed.' : 'Restore the official restaurant website destination.' });
  const closed = first<string>(google, 'business_status');
  if (closed && /CLOSED/.test(closed)) checks.push({ ...baseCheck('business_status', website, google), verdict: 'source_conflict', severity: 'error', reason: `Google reports ${closed}; verify whether the restaurant is trading` });
  return checks;
}

export function summarize(checks: ProfileCheck[], links: LinkCheck[], verified: boolean): ProfileReport['summary'] {
  const count = (v: string) => checks.filter(c => c.verdict === v).length;
  const unknown = count('unverifiable'), missing = checks.filter(c => c.verdict.startsWith('missing_')).length;
  const mismatches = count('mismatch') + count('source_conflict');
  return { total: checks.length, conclusive: checks.length - unknown, matches: count('match'), equivalent: count('equivalent'), mismatches, missing, unknown, brokenLinks: links.filter(l => ['hard_404', 'gone_410', 'soft_404_suspected', 'wrong_destination', 'wrong_location', 'server_error'].includes(l.health)).length, outcome: !verified ? 'incomplete' : mismatches || missing ? 'issues' : unknown ? 'incomplete' : count('equivalent') ? 'issues' : 'pass' };
}

/** Google API content and derived results are deliberately excluded from durable artifacts. */
export function durableReport(report: ProfileReport): ProfileReport {
  if (report.retention === 'durable' || report.retention === 'redacted') return structuredClone(report);
  const copy = structuredClone(report);
  copy.sources = copy.sources.filter(s => s.source === 'website');
  copy.links = copy.links.filter(l => l.source === 'website');
  copy.checks = copy.checks.filter(c => !c.field.startsWith('google_updates.')).map(c => ({ ...c, google: [], evidence: c.evidence.filter(f => f.source === 'website'), verdict: 'unverifiable', exactMatch: null, semanticMatch: null, reason: 'Google-derived comparison omitted from stored report; refresh the live audit', recommendation: 'Resume this audit to reacquire Google observations.' }));
  // A failure to read Google holds no Google content, so it stays: otherwise a saved report shows
  // every row "unresolved" with no hint that, say, the API key was rejected.
  const failed = report.identity.status === 'unmatched' && report.identity.reason.startsWith('Google listing could not be read');
  copy.identity = failed ? { ...report.identity } : { status: 'unverified', placeId: report.identity.placeId, reason: 'Google values are not saved. Use Refresh profile audit to fetch them again.' };
  copy.summary = summarize(copy.checks, copy.links, false); copy.status = 'completed_partial'; copy.retention = 'redacted';
  copy.warnings = [
    ...report.warnings.filter(w => w.startsWith(LISTING_UNAVAILABLE)),
    'Google values and comparisons are shown live only and are not saved (Google’s terms). They stay on screen for an hour or until the dashboard restarts; Refresh profile audit fetches them again.',
    ...copy.sources.flatMap(s => s.warnings),
  ];
  return copy;
}
