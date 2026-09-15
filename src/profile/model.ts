import type { WeeklyHours, RedirectHop } from '../types.js';

export const SERVICES = ['menu', 'reservations', 'ordering'] as const;
export type Service = typeof SERVICES[number] | 'website';
export type ProfileMode = 'public' | 'managed' | 'imported';
export type Source = 'website' | 'places' | 'gbp_managed' | 'gbp_google_updated' | 'imported';
export type Availability = 'present' | 'not_found' | 'unsupported' | 'unavailable' | 'partial';
export type Verdict = 'match' | 'equivalent' | 'mismatch' | 'missing_website' | 'missing_google' | 'missing_both' | 'source_conflict' | 'unverifiable';
export interface ProfileTarget { url: string; name?: string; address?: string; placeId?: string; gbpLocation?: string }
export interface Fact<T = unknown> {
  field: string; value: T; raw: string; source: Source; url: string;
  locator: string; observedAt: string; confidence: 'high' | 'medium' | 'low';
}
export interface ServiceLink { service: Service; url: string; label: string; source: Source; provider?: string; preferred?: boolean; editable?: boolean }
export interface ProfileSnapshot {
  source: Source; facts: Fact[]; links: ServiceLink[];
  coverage: Record<string, { state: Availability; reason: string }>;
  placeId?: string; resourceName?: string; warnings: string[];
}
export interface WebsiteSnapshot extends ProfileSnapshot {
  source: 'website'; pages: string[]; finalUrl: string;
}
export type LinkHealth = 'functional' | 'hard_404' | 'gone_410' | 'soft_404_suspected' | 'wrong_destination' | 'wrong_location' | 'server_error' | 'blocked' | 'timeout' | 'network_error' | 'temporarily_unavailable' | 'unverified';
export interface LinkCheck extends ServiceLink {
  finalUrl: string; httpStatus: number | null; redirectChain: RedirectHop[];
  health: LinkHealth; serviceReady: boolean | null; correctBranch: boolean | null;
  transactionTested: false; reason: string; checkedAt: string;
}
export interface ProfileCheck {
  field: string; verdict: Verdict; exactMatch: boolean | null; semanticMatch: boolean | null;
  website: string[]; google: string[]; evidence: Fact[];
  severity: 'info' | 'warning' | 'error'; reason: string; recommendation: string;
}
export interface ProfileReport {
  schemaVersion: '1.0'; auditId: string; targetKey: string; target: ProfileTarget;
  mode: ProfileMode; startedAt: string; completedAt: string;
  status: 'completed' | 'completed_partial' | 'cancelled';
  identity: { status: 'verified' | 'ambiguous' | 'unmatched' | 'unverified'; placeId: string | null; reason: string };
  checks: ProfileCheck[]; links: LinkCheck[];
  sources: ProfileSnapshot[]; pages: string[];
  summary: { total: number; conclusive: number; matches: number; equivalent: number; mismatches: number; missing: number; unknown: number; brokenLinks: number; outcome: 'pass' | 'issues' | 'incomplete' };
  warnings: string[]; retention: 'durable' | 'session_only' | 'redacted';
  rules: { version: '1.0'; hoursToleranceMinutes: number; country: string };
}
export interface ImportedProfile {
  url: string; observedAt: string; name?: string; address?: string; phone?: string; website?: string;
  placeId?: string; timezone?: string; weekly?: WeeklyHours;
  exceptions?: Record<string, Array<{ start: number; end: number }>>;
  services?: Partial<Record<Service, string[]>>;
}
export const CORE_FIELDS = ['name', 'phone', 'website', 'hours', 'special_hours', ...SERVICES.map(s => `services.${s}`)];
export function emptySnapshot(source: Source, reason = 'Not observed'): ProfileSnapshot {
  return { source, facts: [], links: [], warnings: [], coverage: Object.fromEntries(CORE_FIELDS.map(field => [field, { state: 'unavailable' as const, reason }])) };
}
export function fact(snapshot: ProfileSnapshot, field: string, value: unknown, url: string, locator: string, raw = typeof value === 'string' ? value : JSON.stringify(value), confidence: Fact['confidence'] = 'high'): void {
  if (value == null || value === '') return;
  // The same restaurant name, telephone and schedule are republished on every page of a site.
  // Recording each repetition once keeps a genuine disagreement between pages visible while
  // keeping the comparison table from listing one identical value once per crawled page.
  const serialized = JSON.stringify(value);
  if (snapshot.facts.some(existing => existing.field === field && JSON.stringify(existing.value) === serialized)) {
    snapshot.coverage[field] = { state: 'present', reason: `Observed in ${locator}` };
    return;
  }
  snapshot.facts.push({ field, value, raw, source: snapshot.source, url, locator, observedAt: new Date().toISOString(), confidence });
  snapshot.coverage[field] = { state: 'present', reason: `Observed in ${locator}` };
}
export function first<T>(snapshot: ProfileSnapshot, field: string): T | undefined {
  return snapshot.facts.find(f => f.field === field)?.value as T | undefined;
}

/** Imports describe operator-supplied observations; they never masquerade as live API reads. */
export function validateImports(input: unknown): ImportedProfile[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('Profile evidence must be an array with at most 10000 restaurant records');
  for (const row of input) {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string' || typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt))) throw new Error('Each profile observation requires url and a valid observedAt timestamp');
    validateHttpUrl(row.url);
    for (const key of ['name', 'address', 'phone', 'website', 'placeId', 'timezone']) if (row[key] !== undefined && (typeof row[key] !== 'string' || row[key].length > 2000)) throw new Error(`Invalid profile ${key}`);
    if (row.website) validateHttpUrl(row.website);
    if (row.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: row.timezone }); } catch { throw new Error('Invalid profile timezone'); } }
    if (row.weekly !== undefined) {
      const w = row.weekly;
      if (!w || !Array.isArray(w.statedDays) || w.statedDays.some((d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6) || typeof w.open24x7 !== 'boolean') throw new Error('Invalid weekly schedule');
      validateIntervals(w.intervals, 10080, 20160);
    }
    if (row.exceptions !== undefined) {
      if (!row.exceptions || typeof row.exceptions !== 'object' || Array.isArray(row.exceptions) || Object.keys(row.exceptions).length > 366) throw new Error('Invalid date exceptions');
      for (const [date, intervals] of Object.entries(row.exceptions)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Invalid exception date');
        validateIntervals(intervals, 1440, 2880);
      }
    }
    if (row.services !== undefined) {
      if (!row.services || typeof row.services !== 'object' || Array.isArray(row.services)) throw new Error('Invalid services');
      for (const [service, links] of Object.entries(row.services)) {
        if (!(SERVICES as readonly string[]).includes(service) || !Array.isArray(links) || links.length > 100) throw new Error('Invalid service links');
        links.forEach(validateHttpUrl);
      }
    }
  }
  return input as ImportedProfile[];
}
function validateIntervals(value: unknown, maxStart: number, maxEnd: number): void {
  if (!Array.isArray(value) || value.length > 100 || value.some(i => !i || !Number.isInteger(i.start) || !Number.isInteger(i.end) || i.start < 0 || i.start >= maxStart || i.end <= i.start || i.end > maxEnd)) throw new Error('Invalid schedule intervals');
}
export function validateHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8000) throw new Error('Invalid profile URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Profile URLs must use HTTP(S) without embedded credentials');
  return url.href;
}
