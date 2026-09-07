import type { DayIndex, DayVerdict, HoursComparisonStatus, HoursDayDiff, OpenInterval, WeeklyHours } from '../types.js';
import { DAY_INDEXES, DAY_NAMES, formatDayIntervals, formatInterval, intervalsForDay, statesDay } from './schedule.js';

export interface WeeklyComparison {
  status: HoursComparisonStatus;
  days: HoursDayDiff[];
  maxDeltaMinutes: number | null;
}

const UNSTATED = '—';

/**
 * Diffs two weekly schedules that are already in the same frame.
 *
 * Both sides are local wall-clock times at the restaurant - Places reports the
 * place's own clock, and schema.org `opens`/`closes` are equally local - so no
 * timezone conversion happens here, and none should: running either side through
 * the auditor's system timezone would shift the comparison by that offset.
 */
export function compareWeeklyHours(google: WeeklyHours, website: WeeklyHours, toleranceMinutes: number): WeeklyComparison {
  const tolerance = Math.max(0, Math.round(toleranceMinutes));
  const days = DAY_INDEXES.map((day) => compareDay(day, google, website, tolerance));
  const deltas = days.map((day) => day.deltaMinutes).filter((value): value is number => value !== null);
  return {
    status: rollup(days),
    days,
    maxDeltaMinutes: deltas.length ? Math.max(...deltas) : null,
  };
}

function compareDay(day: DayIndex, google: WeeklyHours, website: WeeklyHours, tolerance: number): HoursDayDiff {
  const googleStated = statesDay(google, day);
  const websiteStated = statesDay(website, day);
  const base: Omit<HoursDayDiff, 'verdict' | 'deltaMinutes' | 'notes'> = {
    day,
    googleText: googleStated ? formatDayIntervals(google, day) : UNSTATED,
    websiteText: websiteStated ? formatDayIntervals(website, day) : UNSTATED,
  };

  if (!googleStated && !websiteStated) return { ...base, verdict: 'unknown', deltaMinutes: null, notes: [] };
  if (!websiteStated) {
    return { ...base, verdict: 'missing_website', deltaMinutes: null, notes: [`The website does not state ${DAY_NAMES[day]} hours`] };
  }
  if (!googleStated) {
    return { ...base, verdict: 'missing_google', deltaMinutes: null, notes: [`Google does not list ${DAY_NAMES[day]} hours`] };
  }

  const googleIntervals = intervalsForDay(google, day);
  const websiteIntervals = intervalsForDay(website, day);
  if (!googleIntervals.length && !websiteIntervals.length) {
    return { ...base, verdict: 'both_closed', deltaMinutes: 0, notes: [] };
  }
  if (!websiteIntervals.length) {
    return { ...base, verdict: 'closed_on_website', deltaMinutes: null, notes: ['Google shows the restaurant open; the website says closed'] };
  }
  if (!googleIntervals.length) {
    return { ...base, verdict: 'closed_on_google', deltaMinutes: null, notes: ['The website shows the restaurant open; Google says closed'] };
  }

  const paired = pairIntervals(googleIntervals, websiteIntervals, tolerance);
  const notes: string[] = [];
  for (const interval of paired.extraGoogle) {
    notes.push(`Google lists ${formatInterval(interval, day)} with no matching interval on the website`);
  }
  for (const interval of paired.extraWebsite) {
    notes.push(`The website lists ${formatInterval(interval, day)} with no matching interval on Google`);
  }

  const verdict: DayVerdict = notes.length ? 'mismatch' : paired.maxDelta === 0 ? 'match' : 'minor_difference';
  return { ...base, verdict, deltaMinutes: paired.matched ? paired.maxDelta : null, notes };
}

/**
 * Greedy pairing: an interval matches when BOTH boundaries are within tolerance.
 * Tolerance is per boundary and independent, so a 15-minute drift on each end is
 * still a 15-minute publishing error rather than a 30-minute one.
 */
function pairIntervals(google: readonly OpenInterval[], website: readonly OpenInterval[], tolerance: number): {
  maxDelta: number;
  matched: number;
  extraGoogle: OpenInterval[];
  extraWebsite: OpenInterval[];
} {
  const consumed = website.map(() => false);
  const extraGoogle: OpenInterval[] = [];
  let maxDelta = 0;
  let matched = 0;

  for (const left of google) {
    let index = -1;
    for (let cursor = 0; cursor < website.length; cursor += 1) {
      if (consumed[cursor]) continue;
      const right = website[cursor];
      if (!right) continue;
      if (Math.abs(right.start - left.start) <= tolerance && Math.abs(right.end - left.end) <= tolerance) {
        index = cursor;
        break;
      }
    }
    if (index < 0) {
      extraGoogle.push(left);
      continue;
    }
    const right = website[index]!;
    consumed[index] = true;
    matched += 1;
    maxDelta = Math.max(maxDelta, Math.abs(right.start - left.start), Math.abs(right.end - left.end));
  }

  return {
    maxDelta,
    matched,
    extraGoogle,
    extraWebsite: website.filter((_, index) => !consumed[index]),
  };
}

function rollup(days: readonly HoursDayDiff[]): HoursComparisonStatus {
  const verdicts = new Set(days.map((day) => day.verdict));
  if (verdicts.has('mismatch') || verdicts.has('closed_on_google') || verdicts.has('closed_on_website')) return 'mismatch';
  if (verdicts.has('minor_difference')) return 'minor_differences';
  if (verdicts.has('missing_website') || verdicts.has('missing_google')) return 'partial';
  if (verdicts.has('match') || verdicts.has('both_closed')) return 'aligned';
  return 'not_checked';
}
