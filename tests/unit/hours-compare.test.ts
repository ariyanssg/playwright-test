import assert from 'node:assert/strict';
import test from 'node:test';
import { compareWeeklyHours } from '../../src/hours/compare.js';
import { intervalFromDayTimes, makeWeeklyHours, weeklyHoursFromPlaceHours } from '../../src/hours/schedule.js';
import { parseJsonLdHours } from '../../src/hours/parse-jsonld.js';
import { parseTextHours } from '../../src/hours/parse-text.js';
import type { DayIndex, WeeklyHours } from '../../src/types.js';

const ALL_DAYS: DayIndex[] = [0, 1, 2, 3, 4, 5, 6];

function weekly(open: number, close: number, days: DayIndex[] = ALL_DAYS): WeeklyHours {
  return makeWeeklyHours(days.map((day) => intervalFromDayTimes(day, open, close)), days);
}

test('identical schedules are aligned', () => {
  const result = compareWeeklyHours(weekly(660, 1_320), weekly(660, 1_320), 15);
  assert.equal(result.status, 'aligned');
  assert.equal(result.maxDeltaMinutes, 0);
  assert.ok(result.days.every((day) => day.verdict === 'match'));
});

test('a 15-minute drift is minor at the default tolerance and a mismatch below it', () => {
  const google = weekly(660, 1_320);
  const website = weekly(645, 1_320);
  assert.equal(compareWeeklyHours(google, website, 15).status, 'minor_differences');
  assert.equal(compareWeeklyHours(google, website, 15).maxDeltaMinutes, 15);
  assert.equal(compareWeeklyHours(google, website, 10).status, 'mismatch');
  assert.equal(compareWeeklyHours(google, website, 0).status, 'mismatch');
});

test('tolerance applies to each boundary independently', () => {
  const google = weekly(660, 1_320, [1]);
  assert.equal(compareWeeklyHours(google, weekly(645, 1_335, [1]), 15).status, 'minor_differences');
  assert.equal(compareWeeklyHours(google, weekly(644, 1_320, [1]), 15).status, 'mismatch');
});

test('a day open on Google but closed on the website is a mismatch', () => {
  const google = weekly(660, 1_320, [1]);
  const website = makeWeeklyHours([], [1]);
  const result = compareWeeklyHours(google, website, 15);
  assert.equal(result.days[1]?.verdict, 'closed_on_website');
  assert.equal(result.days[1]?.websiteText, 'Closed');
  assert.equal(result.status, 'mismatch');
});

test('a website that only states weekdays is partial, never wrongly closed', () => {
  const result = compareWeeklyHours(weekly(660, 1_320), weekly(660, 1_320, [1, 2, 3, 4, 5]), 15);
  assert.equal(result.status, 'partial');
  assert.equal(result.days[0]?.verdict, 'missing_website');
  assert.equal(result.days[6]?.verdict, 'missing_website');
  assert.equal(result.days[6]?.websiteText, '—');
  assert.equal(result.days[3]?.verdict, 'match');
});

test('an extra website interval is a mismatch while the other interval still pairs', () => {
  const google = makeWeeklyHours([intervalFromDayTimes(2, 1_020, 1_320)], [2]);
  const website = makeWeeklyHours([intervalFromDayTimes(2, 690, 840), intervalFromDayTimes(2, 1_020, 1_320)], [2]);
  const result = compareWeeklyHours(google, website, 15);
  assert.equal(result.days[2]?.verdict, 'mismatch');
  assert.equal(result.days[2]?.deltaMinutes, 0);
  assert.match(result.days[2]?.notes[0] ?? '', /website lists 11:30 AM - 2:00 PM/i);
});

test('days neither side states are unknown and excluded from the rollup', () => {
  const result = compareWeeklyHours(weekly(660, 1_320, [1]), weekly(660, 1_320, [1]), 15);
  assert.equal(result.days[4]?.verdict, 'unknown');
  assert.equal(result.days[4]?.googleText, '—');
  assert.equal(result.status, 'aligned');
});

test('a 24/7 Google listing against posted hours mismatches every day', () => {
  const google = weeklyHoursFromPlaceHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }], weekdayDescriptions: [] });
  const result = compareWeeklyHours(google, weekly(660, 1_320), 15);
  assert.equal(result.status, 'mismatch');
  assert.equal(result.days.filter((day) => day.verdict === 'mismatch').length, 7);
});

test('the worked example lands on minor differences', () => {
  const google = weeklyHoursFromPlaceHours({
    periods: [
      { open: { day: 5, hour: 17, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } },
      { open: { day: 6, hour: 11, minute: 30 }, close: { day: 6, hour: 14, minute: 0 } },
      { open: { day: 6, hour: 17, minute: 0 }, close: { day: 0, hour: 1, minute: 0 } },
    ],
    weekdayDescriptions: ['Monday: Closed', 'Friday: 5:00 – 2:00 AM', 'Saturday: 11:30 AM – 2:00 PM'],
  });
  const [jsonLd] = parseJsonLdHours([JSON.stringify({
    '@type': 'Restaurant',
    openingHoursSpecification: [
      { dayOfWeek: ['https://schema.org/Friday'], opens: '17:00', closes: '02:00' },
      { dayOfWeek: 'Saturday', opens: '11:30', closes: '14:15' },
      { dayOfWeek: 'Saturday', opens: '17:00', closes: '01:00' },
    ],
  })]);
  const closedMonday = parseTextHours(['Monday: Closed']);
  const website = makeWeeklyHours(jsonLd!.weekly.intervals, [...jsonLd!.weekly.statedDays, ...closedMonday!.weekly.statedDays]);

  assert.deepEqual(google.intervals, [
    { start: 8_220, end: 8_760 },
    { start: 9_330, end: 9_480 },
    { start: 9_660, end: 10_140 },
  ]);

  const result = compareWeeklyHours(google, website, 15);
  assert.equal(result.days[1]?.verdict, 'both_closed');
  assert.equal(result.days[5]?.verdict, 'match');
  assert.equal(result.days[6]?.verdict, 'minor_difference');
  assert.equal(result.days[0]?.verdict, 'unknown');
  assert.equal(result.maxDeltaMinutes, 15);
  assert.equal(result.status, 'minor_differences');
});
