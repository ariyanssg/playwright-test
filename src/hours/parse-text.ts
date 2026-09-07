import type { DayIndex, OpenInterval } from '../types.js';
import { DAY_MINUTES, dayIndexFromToken, expandDayRange, fullDayInterval, intervalFromDayTimes, makeWeeklyHours } from './schedule.js';
import type { HoursCandidate } from './model.js';

const ALL_DAYS: DayIndex[] = [0, 1, 2, 3, 4, 5, 6];

const DAY_WORD = '(?:sundays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?'
  + '|sun\\.?|mon\\.?|tues?\\.?|weds?\\.?|thurs?\\.?|thu\\.?|fri\\.?|sat\\.?|su|mo|tu|we|th|fr|sa)';
const GROUP_WORD = '(?:daily|every ?day|weekdays?|weekends?|all week)';
const DAY_SEPARATOR = '(?:\\s*[-–—,&\\/]\\s*|\\s+(?:through|thru|to|and)\\s+)';
const DAY_SPEC = `(?:${GROUP_WORD}|${DAY_WORD}(?:${DAY_SEPARATOR}${DAY_WORD})*)`;
const DAY_LINE = new RegExp(`^\\s*(${DAY_SPEC})\\b\\s*(?:[:.–—-]|\\bis\\b|\\bare\\b)?\\s*(.*)$`, 'i');
const SPEC_SCANNER = /\b(through|thru|to)\b|([-–—])|([a-z]{2,10}\.?)/gi;

const CLOCK = '\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?|noon|midnight';
const RANGE = new RegExp(`(${CLOCK})\\s*(?:[-–—]|to|until|till|thru|through)\\s*(${CLOCK})`, 'gi');

const PHONE = /\(\d{3}\)\s*\d{3}|\d{3}[-.–]\d{3}[-.–]\d{4}/;
const PRICE = /[$£€]\s*\d/;
const CLOSED = /\bclosed\b/i;
const ALWAYS_OPEN = /\bopen\s*24\s*h(?:ou)?rs?\b|\b24\s*\/\s*7\b|\b24\s*hours\s*a\s*day\b/i;
const MAX_RANGES_PER_LINE = 3;

/**
 * Best-effort reading of human-written hours. Deliberately conservative: a line
 * that cannot be read confidently produces nothing rather than a guess, and a
 * day is only marked as stated when the text actually says something about it.
 */
export function parseTextHours(blocks: readonly string[]): HoursCandidate | null {
  const intervals: OpenInterval[] = [];
  const stated = new Set<DayIndex>();
  const raw: string[] = [];

  for (const block of blocks) {
    let pendingDays: DayIndex[] | null = null;
    for (const line of splitLines(block)) {
      if (PHONE.test(line) || PRICE.test(line)) {
        pendingDays = null;
        continue;
      }
      const match = DAY_LINE.exec(line);
      let days: DayIndex[] | null = null;
      let rest = line;
      if (match?.[1]) {
        days = parseDaySpec(match[1]);
        rest = (match[2] ?? '').trim();
        // A line that is only a day heading applies to the line that follows it.
        if (days && !rest) {
          pendingDays = days;
          continue;
        }
      }
      if (!days) {
        if (!pendingDays) continue;
        days = pendingDays;
      }
      pendingDays = null;
      if (!days.length) continue;

      if (ALWAYS_OPEN.test(rest)) {
        raw.push(line);
        for (const day of days) {
          stated.add(day);
          intervals.push(fullDayInterval(day));
        }
        continue;
      }
      if (CLOSED.test(rest)) {
        raw.push(line);
        for (const day of days) stated.add(day);
        continue;
      }
      const ranges = extractRanges(rest);
      if (!ranges?.length) continue;
      raw.push(line);
      for (const day of days) {
        stated.add(day);
        for (const [open, close] of ranges) intervals.push(intervalFromDayTimes(day, open, close));
      }
    }
  }

  if (!stated.size) return null;
  return { weekly: makeWeeklyHours(intervals, stated), method: 'text', confidence: 'low', raw };
}

function splitLines(block: string): string[] {
  return block
    .split(/[\n\r•|;]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseDaySpec(spec: string): DayIndex[] | null {
  const lower = spec.toLowerCase();
  if (/\b(?:daily|every ?day|all week)\b/.test(lower)) return [...ALL_DAYS];
  if (/\bweekends?\b/.test(lower)) return [0, 6];
  if (/\bweekdays?\b/.test(lower)) return [1, 2, 3, 4, 5];

  const days = new Set<DayIndex>();
  let previous: DayIndex | null = null;
  let pendingRange = false;
  SPEC_SCANNER.lastIndex = 0;
  for (let match = SPEC_SCANNER.exec(lower); match; match = SPEC_SCANNER.exec(lower)) {
    if (match[1] || match[2]) {
      pendingRange = true;
      continue;
    }
    const day = dayIndexFromToken(match[3] ?? '');
    if (day === null) return null;
    if (pendingRange && previous !== null) for (const item of expandDayRange(previous, day)) days.add(item);
    else days.add(day);
    previous = day;
    pendingRange = false;
  }
  return days.size ? [...days] : null;
}

function extractRanges(text: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = [];
  RANGE.lastIndex = 0;
  for (let match = RANGE.exec(text); match; match = RANGE.exec(text)) {
    const resolved = resolveRange(match[1] ?? '', match[2] ?? '');
    if (!resolved) return null;
    ranges.push(resolved);
    if (ranges.length > MAX_RANGES_PER_LINE) return null;
  }
  return ranges;
}

interface LooseTime {
  hour: number;
  minute: number;
  meridiem: 'am' | 'pm' | null;
  keyword: 'noon' | 'midnight' | null;
}

function parseLoose(token: string): LooseTime | null {
  const value = token.trim().toLowerCase();
  if (value === 'noon') return { hour: 12, minute: 0, meridiem: 'pm', keyword: 'noon' };
  if (value === 'midnight') return { hour: 0, minute: 0, meridiem: 'am', keyword: 'midnight' };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(value);
  if (!match?.[1]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (minute > 59) return null;
  const meridiem = match[3] ? (match[3].startsWith('a') ? 'am' : 'pm') : null;
  if (meridiem && (hour < 1 || hour > 12)) return null;
  if (!meridiem && hour > 24) return null;
  return { hour, minute, meridiem, keyword: null };
}

function applyMeridiem(time: LooseTime, meridiem: 'am' | 'pm'): number {
  const base = time.hour % 12;
  return (meridiem === 'pm' ? base + 12 : base) * 60 + time.minute;
}

function resolveRange(startToken: string, endToken: string): [number, number] | null {
  const left = parseLoose(startToken);
  const right = parseLoose(endToken);
  if (!left || !right) return null;

  // "midnight" as a closing time is the end of the day, not the start of it.
  const endKeyword = right.keyword === 'midnight' ? DAY_MINUTES : null;

  if (left.meridiem && right.meridiem) {
    return [applyMeridiem(left, left.meridiem), endKeyword ?? applyMeridiem(right, right.meridiem)];
  }
  if (!left.meridiem && right.meridiem) {
    const end = endKeyword ?? applyMeridiem(right, right.meridiem);
    for (const meridiem of [right.meridiem, right.meridiem === 'pm' ? 'am' : 'pm'] as const) {
      const start = applyMeridiem(left, meridiem);
      if (start < end) return [start, end];
    }
    return null;
  }
  if (left.meridiem && !right.meridiem) {
    const start = applyMeridiem(left, left.meridiem);
    for (const meridiem of [left.meridiem, left.meridiem === 'am' ? 'pm' : 'am'] as const) {
      const end = applyMeridiem(right, meridiem);
      if (end > start) return [start, end];
    }
    // Nothing later the same day: read it as a close after midnight.
    return [start, applyMeridiem(right, 'am')];
  }
  if (left.hour > 24 || right.hour > 24) return null;
  return [left.hour * 60 + left.minute, endKeyword ?? right.hour * 60 + right.minute];
}
