import assert from 'node:assert/strict';
import test from 'node:test';
import { nameSimilarity, resolvePlace } from '../../src/hours/match.js';
import { parseJsonLdHours, parseSchemaTime } from '../../src/hours/parse-jsonld.js';
import { parseTextHours } from '../../src/hours/parse-text.js';
import { chooseWebsiteHours, extractPageHours } from '../../src/hours/website.js';
import { addressMatch } from '../../src/profile/normalize.js';
import { compareProfiles, resolveIdentity } from '../../src/profile/audit.js';
import { emptySnapshot, fact } from '../../src/profile/model.js';
import { intervalsForDay } from '../../src/hours/schedule.js';
import type { PlaceMatch } from '../../src/types.js';
import type { HoursHarvest } from '../../src/hours/harvest.js';

const place = (overrides: Partial<PlaceMatch>): PlaceMatch => ({ placeId: 'p1', displayName: 'Dishoom', formattedAddress: '', websiteUri: null, utcOffsetMinutes: null, businessStatus: 'OPERATIONAL', regularOpeningHours: null, ...overrides });
const lookup = (answers: Record<string, PlaceMatch[]>) => {
  const queries: string[] = [];
  return { queries, search: async (query: string) => { queries.push(query); return answers[query] ?? answers['*'] ?? []; }, details: async () => null };
};
const harvest = (overrides: Partial<HoursHarvest>): HoursHarvest => ({ url: 'https://spicegarden.example/', finalUrl: 'https://spicegarden.example/', status: 200, title: '', jsonLd: [], microdata: { openingHours: [], specs: [] }, textBlocks: [], bodyText: '', error: null, ...overrides });

test('a branch name containing the brand matches it, but generic words alone never do', () => {
  assert.ok(nameSimilarity('Dishoom Covent Garden', 'Dishoom') >= 0.6);
  assert.ok(nameSimilarity('Spice Garden - Indian Restaurant', 'Spice Garden') >= 0.6);
  assert.ok(nameSimilarity('Kitchen', 'Dishoom Kitchen') < 0.6, 'a generic word is not a distinctive name');
  assert.ok(nameSimilarity('Dishoom', 'Hawksmoor') < 0.6);
});

test('unit numbers and number ranges still match the building; a different building does not', () => {
  assert.equal(addressMatch('Unit 3, 45 Market St, AB1 2CD', '45 Market Street, Townsville AB1 2CD, UK'), true);
  assert.equal(addressMatch('12-14 High St, London SE1 2AB', '14 High Street, London SE1 2AB'), true);
  assert.equal(addressMatch('1 High St, London SE1 2AB', '11 High Street, London SE1 2AB'), false);
  assert.equal(addressMatch('45 Market St, AB1 2CD', '45 Market St, AB9 9ZZ'), false);
});

test('a multi-location brand is resolved to the branch at the supplied address', async () => {
  const branches = [place({ placeId: 'soho', formattedAddress: '22 Kingly St, London W1B 5QP', websiteUri: 'https://www.dishoom.example/soho' }), place({ placeId: 'kx', formattedAddress: '5 Stable St, London N1C 4AB', websiteUri: 'https://www.dishoom.example/kings-cross' })];
  const resolved = await resolvePlace('https://www.dishoom.example/', { name: 'Dishoom', address: '5 Stable Street, N1C 4AB' }, null, lookup({ '*': branches }));
  assert.equal(resolved.confidence, 'verified');
  assert.equal(resolved.place?.placeId, 'kx');
});

test('when the name search finds nothing linked to the site, the domain search can still verify it', async () => {
  const sites = lookup({ 'Curry House': [place({ displayName: 'Curry House Takeaway', websiteUri: 'https://facebook.com/curryhouse' })], 'curryhouse.example': [place({ placeId: 'own', displayName: 'Curry House', websiteUri: 'https://curryhouse.example/' })] });
  const resolved = await resolvePlace('https://curryhouse.example/', { name: 'Curry House' }, null, sites);
  assert.equal(resolved.confidence, 'verified');
  assert.equal(resolved.place?.placeId, 'own');
  assert.deepEqual(sites.queries, ['Curry House', 'curryhouse.example']);
});

test('schema times written with a zone, seconds, a dot or am/pm are read; unreadable ones leave the day unknown', () => {
  assert.equal(parseSchemaTime('17:00:00+01:00'), 1020);
  assert.equal(parseSchemaTime('17:00Z'), 1020);
  assert.equal(parseSchemaTime('5:00 PM'), 1020);
  assert.equal(parseSchemaTime('5pm'), 1020);
  assert.equal(parseSchemaTime('12am'), 0);
  assert.equal(parseSchemaTime('17.30'), 1050);
  const [candidate] = parseJsonLdHours([JSON.stringify({ '@type': 'Restaurant', openingHoursSpecification: [{ dayOfWeek: 'Monday', opens: '5:00 PM', closes: '11:00 PM' }, { dayOfWeek: 'Tuesday', opens: 'see website', closes: 'late' }] })]);
  assert.deepEqual(candidate!.weekly.statedDays, [1], 'Tuesday is unknown, never "closed"');
  // Intervals are minutes from the start of the week (Sunday 00:00).
  assert.deepEqual(intervalsForDay(candidate!.weekly, 1), [{ start: 1440 + 1020, end: 1440 + 1380 }]);
});

test('hours introduced by "Open" or packed into one line are read per day group', () => {
  const lead = parseTextHours(['Open Mon-Sat 5-11pm']);
  assert.deepEqual(lead?.weekly.statedDays, [1, 2, 3, 4, 5, 6]);
  const packed = parseTextHours(['Mon-Fri 12-10pm Sat-Sun 11am-11pm']);
  assert.deepEqual(intervalsForDay(packed!.weekly, 1), [{ start: 1440 + 720, end: 1440 + 1320 }]);
  assert.deepEqual(intervalsForDay(packed!.weekly, 6), [{ start: 6 * 1440 + 660, end: 6 * 1440 + 1380 }]);
});

test('a page title slogan is not taken for the name when a segment matches the domain', () => {
  const page = extractPageHours(harvest({ title: 'Best Indian Restaurant in Soho | Spice Garden' }), 'https://spicegarden.example/', 1);
  assert.equal(page.identity?.name, 'Spice Garden');
  const structured = extractPageHours(harvest({ url: 'https://spicegarden.example/contact', jsonLd: [JSON.stringify({ '@type': 'Restaurant', name: 'Spice Garden Soho' })] }), 'https://spicegarden.example/contact', 1);
  assert.equal(chooseWebsiteHours([page, structured]).identity?.name, 'Spice Garden Soho', 'structured data on a later page beats a title');
});

test('without an address, a listing that links to the site and carries its name is verified', () => {
  const site = emptySnapshot('website'); fact(site, 'name', 'Dishoom', 'https://dishoom.example/', 'fixture');
  const listing = emptySnapshot('places'); fact(listing, 'name', 'Dishoom Covent Garden', 'x', 'fixture'); fact(listing, 'website', 'https://www.dishoom.example/covent-garden', 'x', 'fixture');
  assert.equal(resolveIdentity({ url: 'https://dishoom.example/' }, site, [listing], 'GB').identity.status, 'verified');
  // Two branches that both qualify stay ambiguous rather than guessed.
  assert.equal(resolveIdentity({ url: 'https://dishoom.example/' }, site, [listing, structuredClone(listing)], 'GB').identity.status, 'ambiguous');
});

test('a listing name that adds the branch or cuisine is equivalent, not a mismatch', () => {
  const site = emptySnapshot('website'); fact(site, 'name', 'Spice Garden', 'https://spicegarden.example/', 'fixture');
  const listing = emptySnapshot('places'); fact(listing, 'name', 'Spice Garden - Indian Restaurant', 'x', 'fixture');
  const name = compareProfiles(site, listing, true, 'GB', 0, []).find((check) => check.field === 'name');
  assert.equal(name?.verdict, 'equivalent');
});
