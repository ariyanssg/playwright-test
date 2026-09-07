import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonLdHours, parseJsonLdIdentity, parseOpeningHoursString } from '../../src/hours/parse-jsonld.js';
import { parseMicrodataHours } from '../../src/hours/parse-microdata.js';
import { parseTextHours } from '../../src/hours/parse-text.js';
import { formatDayIntervals, intervalFromDayTimes, intervalsForDay } from '../../src/hours/schedule.js';
import type { DayIndex } from '../../src/types.js';

const script = (value: unknown): string => JSON.stringify(value);

test('openingHoursSpecification accepts URL arrays, bare strings, and abbreviations', () => {
  const [candidate] = parseJsonLdHours([script({
    '@type': 'Restaurant',
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['https://schema.org/Monday', 'https://schema.org/Tuesday'], opens: '11:00', closes: '22:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Wednesday', opens: '11:00:00', closes: '22:00:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Th', 'Fr'], opens: '11:00', closes: '23:00' },
    ],
  })]);
  assert.ok(candidate);
  assert.equal(candidate.confidence, 'high');
  assert.deepEqual(candidate.weekly.statedDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(intervalsForDay(candidate.weekly, 3), [intervalFromDayTimes(3, 660, 1_320)]);
  assert.deepEqual(intervalsForDay(candidate.weekly, 5), [intervalFromDayTimes(5, 660, 1_380)]);
});

test('a Monday-to-Friday specification does not claim the weekend is closed', () => {
  const [candidate] = parseJsonLdHours([script({
    '@type': 'Restaurant',
    openingHours: 'Mo-Fr 11:00-22:00',
  })]);
  assert.deepEqual(candidate?.weekly.statedDays, [1, 2, 3, 4, 5]);
  assert.equal(formatDayIntervals(candidate!.weekly, 6), '');
});

test('nodes are found in @graph, top-level arrays, and nested properties', () => {
  const graph = parseJsonLdHours([script({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Restaurant', openingHours: 'Sa,Su 09:00-14:00' }] })]);
  assert.deepEqual(graph[0]?.weekly.statedDays, [0, 6]);

  const array = parseJsonLdHours([script([{ '@type': 'BreadcrumbList' }, { '@type': ['Restaurant', 'LocalBusiness'], openingHours: 'Mo 08:00-16:00' }])]);
  assert.deepEqual(array[0]?.weekly.statedDays, [1]);

  const nested = parseJsonLdHours([script({ '@type': 'Organization', department: { '@type': 'Restaurant', openingHours: 'Tu 10:00-20:00' } })]);
  assert.ok(nested.some((item) => item.weekly.statedDays.includes(2)));
});

test('a wrapping legacy day range expands across the week boundary', () => {
  const parsed = parseOpeningHoursString('Fr-Mo 17:00-23:00');
  assert.deepEqual(parsed?.days, [5, 6, 0, 1]);
});

test('legacy strings support day lists and multiple ranges', () => {
  const parsed = parseOpeningHoursString('Mo-We,Fr 11:00-14:00,17:00-22:00');
  assert.deepEqual(parsed?.days, [1, 2, 3, 5]);
  assert.equal(parsed?.intervals.length, 8);
});

test('opens and closes both at 00:00 means closed, not open all day', () => {
  const [candidate] = parseJsonLdHours([script({
    '@type': 'Restaurant',
    openingHoursSpecification: [
      { dayOfWeek: 'Sunday', opens: '00:00', closes: '00:00' },
      { dayOfWeek: 'Monday', opens: '00:00', closes: '23:59' },
    ],
  })]);
  assert.equal(formatDayIntervals(candidate!.weekly, 0), 'Closed');
  assert.equal(formatDayIntervals(candidate!.weekly, 1), 'Open 24 hours');
});

test('a malformed script does not discard the valid ones', () => {
  const candidates = parseJsonLdHours(['{ not json', script({ '@type': 'Restaurant', openingHours: 'Mo 09:00-17:00' })]);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.weekly.statedDays, [1]);
});

test('dated specifications are skipped as special hours', () => {
  const candidates = parseJsonLdHours([script({
    '@type': 'Restaurant',
    openingHoursSpecification: [{ dayOfWeek: 'Monday', opens: '11:00', closes: '22:00', validFrom: '2026-12-24', validThrough: '2026-12-26' }],
  })]);
  assert.equal(candidates.length, 0);
});

test('site identity is read from the same JSON-LD', () => {
  const identity = parseJsonLdIdentity([script({
    '@type': 'Restaurant',
    name: 'Blue Fin Sushi',
    telephone: '+1-415-555-0100',
    address: { '@type': 'PostalAddress', streetAddress: '12 Ocean Ave', addressLocality: 'San Francisco', addressRegion: 'CA', postalCode: '94110' },
  })]);
  assert.equal(identity?.name, 'Blue Fin Sushi');
  assert.equal(identity?.address, '12 Ocean Ave, San Francisco, CA, 94110');
  assert.equal(identity?.telephone, '+1-415-555-0100');
});

test('microdata reads shorthand values and complete specifications', () => {
  const candidate = parseMicrodataHours({
    openingHours: ['Mo-Th 11:00-22:00'],
    specs: [{ days: ['Friday'], opens: '17:00', closes: '23:00' }],
  });
  assert.equal(candidate?.confidence, 'medium');
  assert.deepEqual(candidate?.weekly.statedDays, [1, 2, 3, 4, 5]);
  assert.deepEqual(intervalsForDay(candidate!.weekly, 5), [intervalFromDayTimes(5, 1_020, 1_380)]);
});

test('microdata without any usable day context yields nothing', () => {
  assert.equal(parseMicrodataHours({ openingHours: ['not hours'], specs: [{ days: [], opens: '17:00', closes: '23:00' }] }), null);
});

const textDays = (blocks: string[], day: DayIndex): string => {
  const candidate = parseTextHours(blocks);
  assert.ok(candidate, 'expected text hours');
  return formatDayIntervals(candidate.weekly, day);
};

test('visible text handles day ranges, dashes, and meridiems', () => {
  assert.equal(textDays(['Mon – Fri 11am – 10pm'], 1), '11:00 AM - 10:00 PM');
  assert.equal(textDays(['Mon-Fri 11am-10pm'], 5), '11:00 AM - 10:00 PM');
  assert.equal(textDays(['Mon — Fri 11am — 10pm'], 3), '11:00 AM - 10:00 PM');
  assert.equal(textDays(['Sunday: Closed'], 0), 'Closed');
  assert.equal(textDays(['Daily 8am-8pm'], 6), '8:00 AM - 8:00 PM');
  assert.equal(textDays(['Weekends 9:00 AM - 2:00 PM'], 0), '9:00 AM - 2:00 PM');
});

test('a day heading on its own line applies to the times beneath it', () => {
  assert.equal(textDays(['Saturday\n11:00 AM – 9:30 PM'], 6), '11:00 AM - 9:30 PM');
});

test('noon, midnight, and around-the-clock phrasing', () => {
  assert.equal(textDays(['Tuesday: Noon – Midnight'], 2), '12:00 PM - 12:00 AM (+1)');
  assert.equal(textDays(['Wednesday: Open 24 hours'], 3), 'Open 24 hours');
});

test('a close after midnight wraps into the next day', () => {
  assert.equal(textDays(['Fri 5:00 PM – 2:00 AM'], 5), '5:00 PM - 2:00 AM (+1)');
});

test('split shifts produce two intervals', () => {
  assert.equal(textDays(['Tue 11:30 – 14:00, 17:00 – 22:00'], 2), '11:30 AM - 2:00 PM, 5:00 PM - 10:00 PM');
});

test('a missing opening meridiem is inferred from the closing one', () => {
  assert.equal(textDays(['Thursday 11 – 10pm'], 4), '11:00 AM - 10:00 PM');
});

test('phone numbers and prices are not read as hours', () => {
  assert.equal(parseTextHours(['Call us: (415) 555-1212']), null);
  assert.equal(parseTextHours(['Monday specials $12 - $18']), null);
  assert.equal(parseTextHours(['We serve seasonal fish every evening.']), null);
});

test('text results are always low confidence', () => {
  assert.equal(parseTextHours(['Mon-Fri 11:00-22:00'])?.confidence, 'low');
});
