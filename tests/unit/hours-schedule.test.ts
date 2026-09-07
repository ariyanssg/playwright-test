import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAY_MINUTES,
  WEEK_MINUTES,
  anchorDay,
  canonicalizeIntervals,
  dayIndexFromToken,
  expandDayRange,
  formatDayIntervals,
  intervalFromDayTimes,
  intervalsForDay,
  makeWeeklyHours,
  parseClockTime,
  weeklyHoursFromPlaceHours,
} from '../../src/hours/schedule.js';

test('Google periods and website strings converge on the same past-midnight interval', () => {
  const google = weeklyHoursFromPlaceHours({
    periods: [{ open: { day: 5, hour: 17, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }],
    weekdayDescriptions: [],
  });
  const website = makeWeeklyHours([intervalFromDayTimes(5, 17 * 60, 2 * 60)], [5]);
  assert.deepEqual(website.intervals, google.intervals);
  assert.deepEqual(google.intervals, [{ start: 8_220, end: 8_760 }]);
  assert.equal(anchorDay({ start: 8_220, end: 8_760 }), 5);
});

test('midnight-split authoring merges into a single interval', () => {
  const split = makeWeeklyHours([
    intervalFromDayTimes(5, 17 * 60, 24 * 60),
    intervalFromDayTimes(6, 0, 2 * 60),
  ], [5, 6]);
  assert.deepEqual(split.intervals, [{ start: 8_220, end: 8_760 }]);
});

test('a Saturday span into Sunday stays anchored to Saturday', () => {
  const hours = makeWeeklyHours([intervalFromDayTimes(6, 22 * 60, 2 * 60)], [6]);
  assert.deepEqual(hours.intervals, [{ start: 9_960, end: 10_200 }]);
  assert.equal(anchorDay(hours.intervals[0]!), 6);
  assert.deepEqual(intervalsForDay(hours, 0), []);
});

test('overlapping and touching intervals merge', () => {
  assert.deepEqual(canonicalizeIntervals([{ start: 660, end: 900 }, { start: 720, end: 840 }]).intervals,
    [{ start: 660, end: 900 }]);
  assert.deepEqual(canonicalizeIntervals([{ start: 660, end: 840 }, { start: 840, end: 1_320 }]).intervals,
    [{ start: 660, end: 1_320 }]);
});

test('unsorted input is sorted and zero-length intervals are dropped', () => {
  const result = canonicalizeIntervals([{ start: 900, end: 1_000 }, { start: 100, end: 100 }, { start: 200, end: 300 }]);
  assert.deepEqual(result.intervals, [{ start: 200, end: 300 }, { start: 900, end: 1_000 }]);
});

test('an open period with no close is 24/7', () => {
  const hours = weeklyHoursFromPlaceHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }], weekdayDescriptions: [] });
  assert.equal(hours.open24x7, true);
  assert.deepEqual(hours.intervals, [{ start: 0, end: WEEK_MINUTES }]);
  assert.deepEqual(hours.statedDays, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(intervalsForDay(hours, 3), [{ start: 3 * DAY_MINUTES, end: 4 * DAY_MINUTES }]);
});

test('weekday descriptions mark closed days as stated', () => {
  const hours = weeklyHoursFromPlaceHours({
    periods: [{ open: { day: 2, hour: 11, minute: 0 }, close: { day: 2, hour: 22, minute: 0 } }],
    weekdayDescriptions: ['Monday: Closed', 'Tuesday: 11:00 AM – 10:00 PM'],
  });
  assert.deepEqual(hours.statedDays, [1, 2]);
  assert.equal(formatDayIntervals(hours, 1), 'Closed');
  assert.equal(formatDayIntervals(hours, 0), '');
});

test('23:59 is treated as midnight and equal open/close is a full day', () => {
  assert.deepEqual(intervalFromDayTimes(1, 0, 1_439), { start: 1_440, end: 2_880 });
  assert.deepEqual(intervalFromDayTimes(2, 660, 660), { start: 3_540, end: 4_980 });
});

test('a full week of coverage collapses to open24x7', () => {
  const hours = makeWeeklyHours([{ start: 0, end: WEEK_MINUTES }], [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(hours.open24x7, true);
});

test('clock and day token parsing', () => {
  assert.equal(parseClockTime('17:00'), 1_020);
  assert.equal(parseClockTime('11:00:00'), 660);
  assert.equal(parseClockTime('24:00'), 1_440);
  assert.equal(parseClockTime('25:00'), null);
  assert.equal(parseClockTime('bogus'), null);
  assert.equal(dayIndexFromToken('https://schema.org/Monday'), 1);
  assert.equal(dayIndexFromToken('schema:Saturday'), 6);
  assert.equal(dayIndexFromToken('Weds'), 3);
  assert.equal(dayIndexFromToken('Thurs.'), 4);
  assert.equal(dayIndexFromToken('Mondays'), 1);
  assert.equal(dayIndexFromToken('S'), null);
  assert.equal(dayIndexFromToken('T'), null);
  assert.deepEqual(expandDayRange(5, 1), [5, 6, 0, 1]);
  assert.deepEqual(expandDayRange(1, 5), [1, 2, 3, 4, 5]);
});

test('day rendering marks a next-day close', () => {
  const hours = makeWeeklyHours([intervalFromDayTimes(5, 17 * 60, 2 * 60)], [5]);
  assert.equal(formatDayIntervals(hours, 5), '5:00 PM - 2:00 AM (+1)');
});
