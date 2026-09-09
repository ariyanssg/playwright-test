import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { DayIndex, WeeklyHours } from '../types.js';

export function phone(value: string, country = 'GB'): string | null {
  try {
    const parsed = parsePhoneNumberFromString(value.replace(/^tel:/i, '').replace(/;ext=/i, ' ext. '), { defaultCountry: country.toUpperCase() as CountryCode, extract: false });
    return parsed?.isValid() ? `${parsed.number}${parsed.ext ? `;ext=${parsed.ext}` : ''}` : null;
  } catch { return null; }
}
export function textKey(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function addressMatch(left: string, right: string): boolean {
  const a = textKey(left), b = textKey(right);
  // Require street/postcode detail and token boundaries; 1 High St is not 11 High St.
  return /\d/.test(a) && /\d/.test(b) && a.length > 8 && b.length > 8 && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));
}
export function urlKey(value: string): string | null {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function sameHost(a: string, b: string): boolean {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; }
}
/** Per-calendar-day coverage, including carry-in from an overnight interval. */
export function dayIntervals(hours: WeeklyHours, day: DayIndex): Array<{ start: number; end: number }> | null {
  if (hours.open24x7) return [{ start: 0, end: 1440 }];
  if (!hours.statedDays.includes(day)) return null;
  const base = day * 1440;
  return hours.intervals.flatMap(i => [-10080, 0, 10080].flatMap(shift => {
    const start = Math.max(base, i.start + shift), end = Math.min(base + 1440, i.end + shift);
    return start < end ? [{ start: start - base, end: end - base }] : [];
  })).sort((a, b) => a.start - b.start).reduce<Array<{start:number;end:number}>>((out, i) => {
    const last = out.at(-1); if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else out.push({...i}); return out;
  }, []);
}
export function formatIntervals(value: Array<{start:number;end:number}> | null): string {
  if (value === null) return 'Unknown';
  const time = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return value.length ? value.map(i => `${time(i.start)}–${time(i.end)}`).join(', ') : 'Closed';
}
