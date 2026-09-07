import type { DayIndex, OpenInterval } from '../types.js';
import { dayIndexFromToken, intervalFromDayTimes, makeWeeklyHours, parseClockTime } from './schedule.js';
import { parseOpeningHoursString } from './parse-jsonld.js';
import type { HoursCandidate, MicrodataHours } from './model.js';

const CLOSED_ALL_DAY = '00:00';

/**
 * Microdata carries no day context on a bare `opens`/`closes` pair, so only
 * `openingHours` shorthand values and complete `OpeningHoursSpecification`
 * itemscopes are usable. Anything ambiguous is dropped rather than guessed at.
 */
export function parseMicrodataHours(microdata: MicrodataHours): HoursCandidate | null {
  const intervals: OpenInterval[] = [];
  const stated = new Set<DayIndex>();
  const raw: string[] = [];

  for (const value of microdata.openingHours) {
    const parsed = parseOpeningHoursString(value);
    if (!parsed) continue;
    raw.push(value);
    intervals.push(...parsed.intervals);
    for (const day of parsed.days) stated.add(day);
  }

  for (const spec of microdata.specs) {
    const days = spec.days.map(dayIndexFromToken).filter((day): day is DayIndex => day !== null);
    if (!days.length) continue;
    raw.push(`${spec.days.join('/')} ${spec.opens || '?'}-${spec.closes || '?'}`);
    for (const day of days) stated.add(day);
    if (!spec.opens || !spec.closes) continue;
    if (spec.opens.startsWith(CLOSED_ALL_DAY) && spec.closes.startsWith(CLOSED_ALL_DAY)) continue;
    const opens = parseClockTime(spec.opens);
    const closes = parseClockTime(spec.closes);
    if (opens === null || closes === null) continue;
    for (const day of days) intervals.push(intervalFromDayTimes(day, opens, closes));
  }

  if (!stated.size) return null;
  return { weekly: makeWeeklyHours(intervals, stated), method: 'microdata', confidence: 'medium', raw };
}
