import type { DayIndex, OpenInterval } from '../types.js';
import { DAY_NAMES, dayIndexFromToken, expandDayRange, intervalFromDayTimes, makeWeeklyHours, parseClockTime } from './schedule.js';
import type { HoursCandidate, SiteIdentity } from './model.js';

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;

const BUSINESS_TYPES = new Set([
  'restaurant', 'foodestablishment', 'localbusiness', 'cafeorcoffeeshop', 'coffeeshop', 'barorpub',
  'bakery', 'fastfoodrestaurant', 'icecreamshop', 'winery', 'brewery', 'distillery', 'nightclub',
  'organization', 'place', 'store', 'hotel', 'lodgingbusiness', 'foodservice',
]);

/**
 * Google's structured-data guidance, which restaurant sites follow in practice:
 * both `opens` and `closes` at 00:00 means closed all day, while 00:00-23:59
 * means open around the clock.
 */
const CLOSED_ALL_DAY = '00:00';

export function parseJsonLdHours(scripts: readonly string[]): HoursCandidate[] {
  const candidates: HoursCandidate[] = [];
  for (const node of businessNodes(scripts)) {
    const intervals: OpenInterval[] = [];
    const stated = new Set<DayIndex>();
    const raw: string[] = [];

    for (const spec of asArray(node['openingHoursSpecification'])) {
      applySpecification(spec, intervals, stated, raw);
    }
    for (const value of asArray(node['openingHours'])) {
      if (typeof value !== 'string') continue;
      const parsed = parseOpeningHoursString(value);
      if (!parsed) continue;
      raw.push(value);
      intervals.push(...parsed.intervals);
      for (const day of parsed.days) stated.add(day);
    }

    if (!stated.size) continue;
    candidates.push({ weekly: makeWeeklyHours(intervals, stated), method: 'jsonld', confidence: 'high', raw });
  }
  return candidates;
}

export function parseJsonLdIdentity(scripts: readonly string[]): SiteIdentity | null {
  for (const node of businessNodes(scripts)) {
    const name = text(node['name']) ?? text(node['legalName']);
    if (!name) continue;
    return { name, address: formatAddress(node['address']), telephone: text(node['telephone']) };
  }
  return null;
}

/**
 * The schema.org shorthand grammar: a day specification followed by one or more
 * time ranges, e.g. `Mo-Fr 11:00-22:00` or `Mo-We,Fr 11:00-14:00,17:00-22:00`.
 * Sites routinely pack a whole week into one value (`Mo-Sa 11:00-23:00 Su 12:00-22:00`,
 * or groups separated by `;`), so every group is read; one unreadable group rejects the
 * value rather than publishing a partial week as if it were complete.
 */
export function parseOpeningHoursString(value: string): { intervals: OpenInterval[]; days: DayIndex[] } | null {
  const intervals: OpenInterval[] = [];
  const days = new Set<DayIndex>();
  let groups = 0;
  for (const chunk of value.split(/[;\n]+/)) {
    if (!chunk.trim()) continue;
    const pattern = /([A-Za-z][A-Za-z,\-\s.]*?)\s*(?::\s*)?\s((?:\d[\d:,\s-]*?\d)|closed|off)(?=\s*,?\s*[A-Za-z]|\s*$)/gi;
    let consumed = 0;
    for (let match = pattern.exec(chunk); match; match = pattern.exec(chunk)) {
      if (chunk.slice(consumed, match.index).replace(/[\s,]/g, '')) return null;
      consumed = match.index + match[0].length;
      const group = parseGroup(match[1]!, match[2]!);
      if (!group) return null;
      groups += 1;
      intervals.push(...group.intervals);
      for (const day of group.days) days.add(day);
    }
    if (chunk.slice(consumed).replace(/[\s,]/g, '')) return null;
  }
  if (!groups || !days.size) return null;
  return { intervals, days: [...days] };
}

function parseGroup(dayPart: string, timePart: string): { intervals: OpenInterval[]; days: DayIndex[] } | null {
  const days: DayIndex[] = [];
  for (const piece of dayPart.split(',')) {
    const bounds = piece.split('-').map((item) => item.trim()).filter(Boolean);
    if (bounds.length === 1) {
      const day = dayIndexFromToken(bounds[0]!);
      if (day === null) return null;
      days.push(day);
    } else if (bounds.length === 2) {
      const from = dayIndexFromToken(bounds[0]!);
      const to = dayIndexFromToken(bounds[1]!);
      if (from === null || to === null) return null;
      days.push(...expandDayRange(from, to));
    } else if (bounds.length) {
      return null;
    }
  }
  if (!days.length) return null;

  const intervals: OpenInterval[] = [];
  if (/^(?:closed|off)$/i.test(timePart.trim())) return { intervals, days: [...new Set(days)] };
  for (const range of timePart.split(',')) {
    const parts = range.split('-').map((item) => item.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    const opens = parseClockTime(parts[0]!);
    const closes = parseClockTime(parts[1]!);
    if (opens === null || closes === null) return null;
    if (parts[0] === CLOSED_ALL_DAY && parts[1] === CLOSED_ALL_DAY) continue;
    for (const day of days) intervals.push(intervalFromDayTimes(day, opens, closes));
  }
  return { intervals, days: [...new Set(days)] };
}

function applySpecification(spec: unknown, intervals: OpenInterval[], stated: Set<DayIndex>, raw: string[]): void {
  if (!spec || typeof spec !== 'object') return;
  const node = spec as Record<string, unknown>;
  // Dated overrides are holiday or seasonal hours, which are out of scope.
  if (node['validFrom'] || node['validThrough']) return;

  const days: DayIndex[] = [];
  for (const token of asArray(node['dayOfWeek'])) {
    if (typeof token !== 'string') continue;
    const day = dayIndexFromToken(token);
    if (day !== null) days.push(day);
  }
  if (!days.length) return;

  const opensText = text(node['opens']);
  const closesText = text(node['closes']);
  raw.push(`${days.map((day) => DAY_NAMES[day]).join('/')} ${opensText ?? '?'}-${closesText ?? '?'}`);
  for (const day of days) stated.add(day);

  if (!opensText || !closesText) return;
  if (opensText.startsWith(CLOSED_ALL_DAY) && closesText.startsWith(CLOSED_ALL_DAY)) return;
  const opens = parseClockTime(opensText);
  const closes = parseClockTime(closesText);
  if (opens === null || closes === null) return;
  for (const day of days) intervals.push(intervalFromDayTimes(day, opens, closes));
}

function businessNodes(scripts: readonly string[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonNoise(script));
    } catch {
      continue;
    }
    for (const node of collectNodes(parsed)) {
      if (isBusinessNode(node)) nodes.push(node);
    }
  }
  return nodes;
}

function collectNodes(root: unknown): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || output.length >= MAX_NODES) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    output.push(value as Record<string, unknown>);
    for (const child of Object.values(value as Record<string, unknown>)) walk(child, depth + 1);
  };
  walk(root, 0);
  return output;
}

function isBusinessNode(node: Record<string, unknown>): boolean {
  if ('openingHoursSpecification' in node || 'openingHours' in node) return true;
  return asArray(node['@type']).some((value) => typeof value === 'string' && BUSINESS_TYPES.has(value.toLowerCase()));
}

function formatAddress(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const node = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
  if (!node) return null;
  const parts = ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry']
    .map((key) => text(node[key]))
    .filter((item): item is string => Boolean(item));
  return parts.length ? parts.join(', ') : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (value && typeof value === 'object') return text((value as Record<string, unknown>)['name']);
  return null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Some CMSs wrap the payload in CDATA or an HTML comment. */
export function stripJsonNoise(script: string): string {
  return script
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*(?:\/\/)?\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*(?:\/\/)?\s*$/, '')
    .trim();
}
