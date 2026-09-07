import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuery, nameSimilarity, resolvePlace, verifyPlaces } from '../../src/hours/match.js';
import type { PlaceMatch } from '../../src/types.js';

function place(overrides: Partial<PlaceMatch> = {}): PlaceMatch {
  return {
    placeId: 'places/one',
    displayName: 'Blue Fin Sushi',
    formattedAddress: '12 Ocean Ave, San Francisco, CA',
    websiteUri: 'https://www.bluefin.example/',
    utcOffsetMinutes: -480,
    businessStatus: 'OPERATIONAL',
    regularOpeningHours: null,
    ...overrides,
  };
}

function lookup(places: PlaceMatch[], details: PlaceMatch | null = null) {
  const queries: string[] = [];
  const detailIds: string[] = [];
  return {
    queries,
    detailIds,
    search: async (query: string) => {
      queries.push(query);
      return places;
    },
    details: async (id: string) => {
      detailIds.push(id);
      return details;
    },
  };
}

test('a listing whose website matches the host is verified across www', () => {
  assert.equal(verifyPlaces('https://bluefin.example', [place()]).length, 1);
  assert.equal(verifyPlaces('https://www.bluefin.example', [place()]).length, 1);
  assert.equal(verifyPlaces('https://bluefin.example', [place({ websiteUri: 'https://elsewhere.example' })]).length, 0);
  assert.equal(verifyPlaces('https://bluefin.example', [place({ websiteUri: null })]).length, 0);
  assert.equal(verifyPlaces('https://bluefin.example', [place({ websiteUri: 'not a url' })]).length, 0);
});

test('a supplied place id skips the billable search', async () => {
  const api = lookup([], place());
  const result = await resolvePlace('https://bluefin.example', { placeId: 'places/xyz' }, null, api);
  assert.equal(result.confidence, 'place_id_supplied');
  assert.equal(result.searched, false);
  assert.deepEqual(api.detailIds, ['places/xyz']);
  assert.deepEqual(api.queries, []);
});

test('site identity drives the search query', async () => {
  const api = lookup([place()]);
  const result = await resolvePlace('https://bluefin.example', {}, { name: 'Blue Fin Sushi', address: '12 Ocean Ave', telephone: null }, api);
  assert.equal(result.confidence, 'verified');
  assert.deepEqual(api.queries, ['Blue Fin Sushi, 12 Ocean Ave']);
  assert.equal(buildQuery('Blue Fin Sushi'), 'Blue Fin Sushi');
});

test('several listings pointing at one domain are ambiguous, not guessed at', async () => {
  const api = lookup([place(), place({ placeId: 'places/two', formattedAddress: '90 Market St' })]);
  const result = await resolvePlace('https://bluefin.example', { name: 'Blue Fin Sushi' }, null, api);
  assert.equal(result.confidence, 'ambiguous');
  assert.equal(result.place, null);
  assert.match(result.notes.join(' '), /place_id/);
});

test('a close name with no linking website is unverified but still compared', async () => {
  const api = lookup([place({ websiteUri: null, displayName: 'Blue Fin Sushi Bar' })]);
  const result = await resolvePlace('https://bluefin.example', { name: 'Blue Fin Sushi' }, null, api);
  assert.equal(result.confidence, 'unverified');
  assert.equal(result.place?.displayName, 'Blue Fin Sushi Bar');
  assert.match(result.notes.join(' '), /unconfirmed/);
});

test('a distant name is rejected outright', async () => {
  const api = lookup([place({ websiteUri: null, displayName: 'Taco Palace' })]);
  const result = await resolvePlace('https://bluefin.example', { name: 'Blue Fin Sushi' }, null, api);
  assert.equal(result.confidence, 'none');
  assert.equal(result.place, null);
});

test('with no name at all nothing is searched', async () => {
  const api = lookup([place()]);
  const result = await resolvePlace('https://bluefin.example', {}, null, api);
  assert.equal(result.confidence, 'none');
  assert.equal(result.searched, false);
  assert.deepEqual(api.queries, []);
});

test('an empty result retries without the address', async () => {
  const queries: string[] = [];
  const api = {
    search: async (query: string) => {
      queries.push(query);
      return queries.length === 1 ? [] : [place()];
    },
    details: async () => null,
  };
  const result = await resolvePlace('https://bluefin.example', { name: 'Blue Fin Sushi', address: '12 Ocean Ave' }, null, api);
  assert.deepEqual(queries, ['Blue Fin Sushi, 12 Ocean Ave', 'Blue Fin Sushi']);
  assert.equal(result.confidence, 'verified');
});

test('name similarity scoring', () => {
  assert.ok(nameSimilarity('Blue Fin Sushi', 'Blue Fin Sushi Bar') >= 0.6);
  assert.ok(nameSimilarity("Luigi's Trattoria", 'Luigis Trattoria') >= 0.6);
  assert.ok(nameSimilarity('Blue Fin Sushi', 'Taco Palace') < 0.6);
  assert.equal(nameSimilarity('', 'Blue Fin'), 0);
});
