import { createHash } from 'node:crypto';
import { DAY_INDEXES, DAY_NAMES } from '../hours/schedule.js';
import type { OpenInterval, WeeklyHours } from '../types.js';
import { addressMatch, dayIntervals, formatIntervals, phone, sameHost, textKey, urlKey } from './normalize.js';
import { CORE_FIELDS, emptySnapshot, first, SERVICES, type ImportedProfile, type ProfileCheck, type ProfileMode, type ProfileReport, type ProfileSnapshot, type ProfileTarget, type WebsiteSnapshot, type Fact, type LinkCheck } from './model.js';
import { BusinessProfileConnection, fromImported, managedProfiles, publicProfiles, type ApiRead } from './providers.js';
import { ProfileBrowser } from './website.js';

export interface AuditOptions { mode: ProfileMode; pageLimit: number; timeoutMs: number; hostDelayMs: number; country: string; tolerance: number; signal?: AbortSignal }
export interface AuditDependencies { browser?: Pick<ProfileBrowser, 'crawl' | 'check' | 'close'>; publicRead?: ApiRead; managedRead?: ApiRead; imported?: ImportedProfile[]; gbp?: BusinessProfileConnection }
export function targetKey(target: ProfileTarget): string { return createHash('sha256').update(JSON.stringify([target.url, target.placeId || '', target.gbpLocation || '', target.address || ''])).digest('hex').slice(0, 24); }

export async function auditProfile(auditId: string, target: ProfileTarget, options: AuditOptions, pages: string[] = [], deps: AuditDependencies = {}): Promise<ProfileReport> {
  const startedAt = new Date().toISOString();
  const browser = deps.browser ?? new ProfileBrowser({ ...options });
  let website: WebsiteSnapshot = { ...emptySnapshot('website'), source: 'website', finalUrl: target.url, pages: [] };
  let candidates: ProfileSnapshot[] = [], extras: ProfileSnapshot[] = [];
  const warnings: string[] = [];
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
          candidates = await publicProfiles(query, target.placeId, options.signal, deps.publicRead);
        }
      } catch (error) { warnings.push(error instanceof Error ? error.message : 'Google acquisition failed'); }
    }
    const resolution = resolveIdentity(target, website, candidates, options.country);
    const google = resolution.snapshot ?? emptySnapshot(options.mode === 'public' ? 'places' : options.mode === 'managed' ? 'gbp_managed' : 'imported', 'No verified Google branch; comparisons unavailable');
    const verified = resolution.identity.status === 'verified';
    const websiteDestinations = [website, ...(verified ? [google] : [])].flatMap(s => {
      const url = first<string>(s, 'website'); return url ? [{ service: 'website' as const, url, source: s.source, label: 'Official website' }] : [];
    });
    for (const link of [...websiteDestinations, ...website.links, ...(verified ? google.links : [])]) {
      if (options.signal?.aborted) break;
      links.push(await browser.check(link, target, website));
    }
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
    if (report.retention === 'session_only') report.warnings.push('Google-derived values and comparisons are available in this live session only. Saved exports redact them; resume refreshes Google observations.');
    return report;
  } finally { await browser.close(); }
}

export function resolveIdentity(target: ProfileTarget, website: ProfileSnapshot, candidates: ProfileSnapshot[], country: string): { identity: ProfileReport['identity']; snapshot?: ProfileSnapshot } {
  const expectedAddress = target.address || first<string>(website, 'address') || '';
  const expectedPhone = phone(first<string>(website, 'phone') || '', country);
  const scored = candidates.map(snapshot => {
    const actualAddress = first<string>(snapshot, 'address') || '';
    const addressMatches = addressMatch(expectedAddress, actualAddress);
    const phoneMatches = Boolean(expectedPhone && expectedPhone === phone(first<string>(snapshot, 'phone') || '', country));
    const hostMatches = sameHost(first<string>(snapshot, 'website') || '', target.url);
    // A branch address is independent evidence even when name, telephone or GBP URL is wrong.
    const addressConflict = Boolean(expectedAddress && actualAddress && /\d/.test(expectedAddress) && /\d/.test(actualAddress) && !addressMatches);
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
    if (keys.length > 1 && field !== 'website') { checks.push({ ...check, verdict: 'source_conflict', reason: 'Website publishes multiple different values; no source was silently selected', severity: 'error' }); continue; }
    if (!wf[0] || !gf[0]) { checks.push({ ...check, reason: 'Field could not be parsed' }); continue; }
    const w = String(wf[0].value).trim(), g = String(gf[0].value).trim();
    const final = (url: string) => links.find(l => l.url === url && l.health === 'functional')?.finalUrl;
    const semantic = field === 'website' ? Boolean(urlKey(w) === urlKey(g) || (final(w) && final(w) === final(g))) : Boolean(key(wf[0]) && key(wf[0]) === key(gf[0]));
    const result = finish(check, w === g, semantic);
    if (field === 'name' && wf[0].confidence === 'low') { result.verdict = 'unverifiable'; result.reason = 'Restaurant name inferred from page title; visible branding needs verification'; }
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
  return { total: checks.length, conclusive: checks.length - unknown, matches: count('match'), equivalent: count('equivalent'), mismatches, missing, unknown, brokenLinks: links.filter(l => ['hard_404', 'gone_410', 'soft_404_suspected', 'wrong_destination', 'wrong_location', 'server_error'].includes(l.health)).length, outcome: !verified || unknown ? 'incomplete' : mismatches || missing || count('equivalent') ? 'issues' : 'pass' };
}

/** Google API content and derived results are deliberately excluded from durable artifacts. */
export function durableReport(report: ProfileReport): ProfileReport {
  if (report.retention === 'durable' || report.retention === 'redacted') return structuredClone(report);
  const copy = structuredClone(report);
  copy.sources = copy.sources.filter(s => s.source === 'website');
  copy.links = copy.links.filter(l => l.source === 'website');
  copy.checks = copy.checks.filter(c => !c.field.startsWith('google_updates.')).map(c => ({ ...c, google: [], evidence: c.evidence.filter(f => f.source === 'website'), verdict: 'unverifiable', exactMatch: null, semanticMatch: null, reason: 'Google-derived comparison omitted from stored report; refresh the live audit', recommendation: 'Resume this audit to reacquire Google observations.' }));
  copy.identity = { status: 'unverified', placeId: report.identity.placeId, reason: 'Identity evidence is session-only; refresh to verify' };
  copy.summary = summarize(copy.checks, copy.links, false); copy.status = 'completed_partial'; copy.retention = 'redacted';
  copy.warnings = ['Google API values and derived comparisons are omitted from durable artifacts. Live dashboard results expire after one hour or server restart.'];
  return copy;
}
