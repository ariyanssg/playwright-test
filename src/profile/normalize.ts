import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { DayIndex, WeeklyHours } from '../types.js';

export function phone(value: string, country = 'GB'): string | null {
  try {
    const parsed = parsePhoneNumberFromString(value.replace(/^tel:/i, '').replace(/;ext=/i, ' ext. '), { defaultCountry: country.toUpperCase() as CountryCode, extract: false });
    return parsed?.isValid() ? `${parsed.number}${parsed.ext ? `;ext=${parsed.ext}` : ''}` : null;
  } catch { return null; }
}
export function textKey(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

/** Written forms that differ only by abbreviation describe the same street. */
const STREET_WORDS: Record<string, string> = {
  st: 'street', str: 'street', rd: 'road', ave: 'avenue', av: 'avenue', dr: 'drive', drv: 'drive',
  ln: 'lane', blvd: 'boulevard', bvd: 'boulevard', pl: 'place', sq: 'square', ct: 'court',
  cres: 'crescent', cr: 'crescent', gdns: 'gardens', gdn: 'garden', pde: 'parade', ter: 'terrace',
  hwy: 'highway', pkwy: 'parkway', rte: 'route', bldg: 'building', fl: 'floor', flr: 'floor',
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
};
/** Country and nation names that Google appends and a website almost never prints. */
const ADDRESS_FILLER = new Set(['uk', 'gb', 'usa', 'us', 'united', 'kingdom', 'states', 'england', 'scotland', 'wales', 'ireland', 'northern', 'britain', 'great']);
const POSTCODE = /\b(?:[a-z]{1,2}\d[a-z\d]?\s*\d[a-z]{2}|\d{5}(?:\s*\d{4})?)\b/;

interface AddressParts { numbers: string[]; postcode: string | null; words: string[] }
function addressParts(value: string): AddressParts | null {
  const key = textKey(value);
  if (!key) return null;
  const postcode = key.match(POSTCODE)?.[0]?.replace(/\s+/g, '') ?? null;
  const rest = postcode ? key.replace(POSTCODE, ' ') : key;
  const tokens = rest.split(/\s+/).filter(Boolean);
  // Every bare number: the building, a unit or floor, or both ends of a range ("12-14").
  const numbers = tokens.filter(token => /^\d+[a-z]?$/.test(token));
  const words = tokens
    .filter(token => !/^\d+[a-z]?$/.test(token))
    .map(token => STREET_WORDS[token] ?? token)
    .filter(token => !ADDRESS_FILLER.has(token));
  return { numbers, postcode, words };
}

/**
 * Google's formattedAddress inserts the town and country a website omits ("100 High St, SE1 2AB"
 * against "100 High St, Norwood, London SE1 2AB, UK"), so the two are compared by word rather
 * than as one contiguous string. A differing postcode decides against a match outright, and so do
 * building numbers that share nothing: 1 High St stays distinct from 11 High St, while
 * "Unit 3, 45 Market St" and "12-14 High St" still match "45 Market St" and "14 High St".
 */
export function addressMatch(left: string, right: string): boolean {
  const a = addressParts(left), b = addressParts(right);
  if (!a || !b) return false;
  if (a.postcode && b.postcode && a.postcode !== b.postcode) return false;
  if (a.numbers.length && b.numbers.length && !a.numbers.some(number => b.numbers.includes(number))) return false;
  const smaller = a.words.length <= b.words.length ? a : b, larger = smaller === a ? b : a;
  const shared = smaller.words.filter(word => larger.words.includes(word));
  // The shorter address must be fully accounted for, or share enough of the street to be the same one.
  const consistent = (smaller.words.length > 0 && shared.length === smaller.words.length) || shared.length >= 2;
  if (a.postcode && b.postcode) return consistent;
  if (a.numbers.length && b.numbers.length) return consistent;
  return false;
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
