import type { DayIndex, OpenInterval, PlaceOpeningHours, WeeklyHours } from '../types.js';

export const DAY_MINUTES = 1_440;
export const WEEK_MINUTES = 10_080;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const DAY_INDEXES: readonly DayIndex[] = [0, 1, 2, 3, 4, 5, 6];

/** schema.org authors write 23:59 when they mean midnight; treating it literally drifts every day by a minute. */
const MIDNIGHT_IDIOM = 1_439;

const DAY_TOKENS = new Map<string, DayIndex>([
  ['sunday', 0], ['sun', 0], ['su', 0],
  ['monday', 1], ['mon', 1], ['mo', 1],
  ['tuesday', 2], ['tues', 2], ['tue', 2], ['tu', 2],
  ['wednesday', 3], ['weds', 3], ['wed', 3], ['we', 3],
  ['thursday', 4], ['thurs', 4], ['thur', 4], ['thu', 4], ['th', 4],
  ['friday', 5], ['fri', 5], ['fr', 5],
  ['saturday', 6], ['sat', 6], ['sa', 6],
]);

export function emptyWeeklyHours(): WeeklyHours {
  return { intervals: [], statedDays: [], open24x7: false };
}

export function isDayIndex(value: number): value is DayIndex {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}

/**
 * Resolves a day token to an index. Handles `https://schema.org/Monday`,
 * `schema:Monday`, `Monday`, `Mondays`, `Mon.`, and `Mo`. Bare `S` and `T` are
 * rejected as genuinely ambiguous rather than guessed at.
 */
export function dayIndexFromToken(raw: string): DayIndex | null {
  let token = String(raw ?? '').trim().toLowerCase();
  if (!token) return null;
  const separator = Math.max(token.lastIndexOf('/'), token.lastIndexOf(':'), token.lastIndexOf('#'));
  if (separator >= 0) token = token.slice(separator + 1);
  token = token.replace(/[.\s]+$/g, '').replace(/s$/, '');
  return DAY_TOKENS.get(token) ?? null;
}

/** Inclusive day range that may wrap the week (`Fr-Mo` is Friday through Monday). */
export function expandDayRange(from: DayIndex, to: DayIndex): DayIndex[] {
  const days: DayIndex[] = [];
  const span = (to - from + 7) % 7;
  for (let offset = 0; offset <= span; offset += 1) days.push(((from + offset) % 7) as DayIndex);
  return days;
}

/** Parses `HH:MM` or `HH:MM:SS` into minutes past midnight. Seconds are discarded. */
export function parseClockTime(raw: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw ?? '').trim());
  if (!match?.[1] || !match[2]) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 24 || minute > 59) return null;
  const total = hour * 60 + minute;
  return total > DAY_MINUTES ? null : total;
}

/**
 * Builds a week-absolute interval from a day and two clock times. A close at or
 * before the open wraps into the following day, so `Fri 17:00-02:00` and
 * `{open: Fri 17:00, close: Sat 02:00}` produce the identical value. Equal open
 * and close means a full 24 hours.
 */
export function intervalFromDayTimes(day: DayIndex, openMinutes: number, closeMinutes: number): OpenInterval {
  const start = day * DAY_MINUTES + openMinutes;
  const close = closeMinutes === MIDNIGHT_IDIOM ? DAY_MINUTES : closeMinutes;
  const duration = close > openMinutes ? close - openMinutes : close + DAY_MINUTES - openMinutes;
  return { start, end: start + duration };
}

export function fullDayInterval(day: DayIndex): OpenInterval {
  const start = day * DAY_MINUTES;
  return { start, end: start + DAY_MINUTES };
}

/**
 * Normalizes arbitrary intervals onto the circular 10,080-minute week: wrap,
 * linearize, sort, merge, and rejoin across the Sunday boundary. Touching
 * intervals merge, which is what makes midnight-split authoring (`Fri 17:00-24:00`
 * plus `Sat 00:00-02:00`) converge with a single `Fri 17:00 -> Sat 02:00` period.
 */
export function canonicalizeIntervals(raw: readonly OpenInterval[]): { intervals: OpenInterval[]; open24x7: boolean } {
  const linear: OpenInterval[] = [];
  for (const item of raw) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) continue;
    const duration = Math.round(item.end) - Math.round(item.start);
    if (duration <= 0) continue;
    if (duration >= WEEK_MINUTES) return fullWeek();
    const start = (((Math.round(item.start) % WEEK_MINUTES) + WEEK_MINUTES) % WEEK_MINUTES);
    const end = start + duration;
    if (end > WEEK_MINUTES) {
      linear.push({ start, end: WEEK_MINUTES });
      linear.push({ start: 0, end: end - WEEK_MINUTES });
    } else {
      linear.push({ start, end });
    }
  }
  if (!linear.length) return { intervals: [], open24x7: false };

  linear.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: OpenInterval[] = [];
  for (const item of linear) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else merged.push({ ...item });
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  if (merged.length > 1 && first && last && first.start === 0 && last.end === WEEK_MINUTES) {
    merged.pop();
    merged.shift();
    merged.push({ start: last.start, end: first.end + WEEK_MINUTES });
    merged.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  const covered = merged.reduce((sum, item) => sum + (item.end - item.start), 0);
  if (covered >= WEEK_MINUTES) return fullWeek();
  return { intervals: merged, open24x7: false };
}

export function makeWeeklyHours(raw: readonly OpenInterval[], statedDays: Iterable<DayIndex>): WeeklyHours {
  const { intervals, open24x7 } = canonicalizeIntervals(raw);
  const stated = [...new Set(statedDays)].sort((left, right) => left - right);
  return { intervals, statedDays: stated, open24x7 };
}

/** The day an interval belongs to, so a Friday 17:00 -> Saturday 02:00 span stays Friday's. */
export function anchorDay(interval: OpenInterval): DayIndex {
  return (Math.floor(interval.start / DAY_MINUTES) % 7) as DayIndex;
}

export function intervalsForDay(hours: WeeklyHours, day: DayIndex): OpenInterval[] {
  if (hours.open24x7) return [fullDayInterval(day)];
  return hours.intervals.filter((interval) => anchorDay(interval) === day);
}

export function statesDay(hours: WeeklyHours, day: DayIndex): boolean {
  return hours.open24x7 || hours.statedDays.includes(day);
}

export function formatClock(minutes: number): string {
  const withinDay = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const hour24 = Math.floor(withinDay / 60);
  const minute = withinDay % 60;
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** Human-readable rendering of one interval, e.g. `5:00 PM - 2:00 AM (+1)`. */
export function formatInterval(interval: OpenInterval, day: DayIndex): string {
  if (interval.end - interval.start >= DAY_MINUTES) return 'Open 24 hours';
  const relativeEnd = interval.end - day * DAY_MINUTES;
  const suffix = relativeEnd >= DAY_MINUTES ? ' (+1)' : '';
  return `${formatClock(interval.start)} - ${formatClock(interval.end)}${suffix}`;
}

/** Human-readable rendering of one day. Empty when the source never mentioned it. */
export function formatDayIntervals(hours: WeeklyHours, day: DayIndex): string {
  if (!statesDay(hours, day)) return '';
  if (hours.open24x7) return 'Open 24 hours';
  const intervals = intervalsForDay(hours, day);
  if (!intervals.length) return 'Closed';
  return intervals.map((interval) => formatInterval(interval, day)).join(', ');
}

/**
 * Converts a Places `regularOpeningHours` payload into the canonical model.
 * `weekdayDescriptions` is only read to learn which days Google made a statement
 * about (including "Closed") - the periods are the authoritative data.
 */
export function weeklyHoursFromPlaceHours(hours: PlaceOpeningHours | null | undefined): WeeklyHours {
  const periods = hours?.periods ?? [];
  const descriptions = hours?.weekdayDescriptions ?? [];
  if (!periods.length && !descriptions.length) return emptyWeeklyHours();

  const first = periods[0];
  if (periods.length === 1 && first && !first.close
    && first.open?.day === 0 && first.open.hour === 0 && first.open.minute === 0) {
    return { intervals: [{ start: 0, end: WEEK_MINUTES }], statedDays: [...DAY_INDEXES], open24x7: true };
  }

  const intervals: OpenInterval[] = [];
  const stated = new Set<DayIndex>();
  for (const period of periods) {
    const open = period?.open;
    if (!open || !isDayIndex(open.day)) continue;
    stated.add(open.day);
    const start = open.day * DAY_MINUTES + open.hour * 60 + open.minute;
    const close = period.close;
    if (!close || !isDayIndex(close.day)) {
      intervals.push(fullDayInterval(open.day));
      continue;
    }
    let end = close.day * DAY_MINUTES + close.hour * 60 + close.minute;
    if (end <= start) end += WEEK_MINUTES;
    intervals.push({ start, end });
  }

  for (const description of descriptions) {
    const day = dayIndexFromToken(String(description).split(/[:\u2013\u2014-]/)[0] ?? '');
    if (day !== null) stated.add(day);
  }

  return makeWeeklyHours(intervals, stated);
}

function fullWeek(): { intervals: OpenInterval[]; open24x7: boolean } {
  return { intervals: [{ start: 0, end: WEEK_MINUTES }], open24x7: true };
}
