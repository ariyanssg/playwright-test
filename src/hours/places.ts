import { setTimeout as delay } from 'node:timers/promises';
import type { PlaceMatch, PlaceOpeningHours, PlacePeriod, PlacePoint } from '../types.js';

const DEFAULT_ENDPOINT = 'https://places.googleapis.com/v1';
const TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_000;

const PLACE_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'websiteUri',
  'regularOpeningHours',
  'utcOffsetMinutes',
  'businessStatus',
] as const;

export const PLACES_COVERAGE_NOTE =
  'Google hours come from the Places API regular weekly schedule; holiday and special hours are not compared.';

export async function searchPlaces(textQuery: string, apiKey = process.env.GOOGLE_MAPS_API_KEY): Promise<PlaceMatch[]> {
  const payload = await request(`${endpoint()}/places:searchText`, {
    method: 'POST',
    body: JSON.stringify({ textQuery, maxResultCount: 5, languageCode: 'en' }),
  }, apiKey, PLACE_FIELDS.map((field) => `places.${field}`).join(','));
  const places = (payload as { places?: unknown[] }).places ?? [];
  return places.flatMap((place) => {
    const match = toPlaceMatch(place);
    return match ? [match] : [];
  });
}

export async function fetchPlaceDetails(placeId: string, apiKey = process.env.GOOGLE_MAPS_API_KEY): Promise<PlaceMatch | null> {
  const payload = await request(`${endpoint()}/places/${encodeURIComponent(placeId)}`, { method: 'GET' }, apiKey, PLACE_FIELDS.join(','));
  return toPlaceMatch(payload);
}

function endpoint(): string {
  return (process.env.GOOGLE_PLACES_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/**
 * The API key travels in a header rather than the query string so it cannot leak
 * through an error message that echoes the request URL.
 */
async function request(url: string, init: RequestInit, apiKey: string | undefined, fieldMask: string): Promise<unknown> {
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is required for opening-hours comparison');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        'x-goog-fieldmask': fieldMask,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    // Only quota exhaustion is worth retrying; retrying a rejected field mask burns quota for nothing.
    if (response.status === 429 && attempt === 0) {
      await delay(RETRY_DELAY_MS);
      continue;
    }
    const message = (payload as { error?: { message?: string } }).error?.message;
    throw new Error(message || `Places request failed with HTTP ${response.status}`);
  }
  throw new Error('Places request failed after a rate-limit retry');
}

function toPlaceMatch(value: unknown): PlaceMatch | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const placeId = typeof raw['id'] === 'string' ? raw['id'] : null;
  if (!placeId) return null;
  return {
    placeId,
    displayName: localizedText(raw['displayName']),
    formattedAddress: typeof raw['formattedAddress'] === 'string' ? raw['formattedAddress'] : '',
    websiteUri: typeof raw['websiteUri'] === 'string' ? raw['websiteUri'] : null,
    utcOffsetMinutes: typeof raw['utcOffsetMinutes'] === 'number' ? raw['utcOffsetMinutes'] : null,
    businessStatus: typeof raw['businessStatus'] === 'string' ? raw['businessStatus'] : null,
    regularOpeningHours: toOpeningHours(raw['regularOpeningHours']),
  };
}

function toOpeningHours(value: unknown): PlaceOpeningHours | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const periods = Array.isArray(raw['periods'])
    ? raw['periods'].flatMap((period) => {
      const parsed = toPeriod(period);
      return parsed ? [parsed] : [];
    })
    : [];
  const weekdayDescriptions = Array.isArray(raw['weekdayDescriptions'])
    ? raw['weekdayDescriptions'].filter((item): item is string => typeof item === 'string')
    : [];
  if (!periods.length && !weekdayDescriptions.length) return null;
  return { periods, weekdayDescriptions };
}

function toPeriod(value: unknown): PlacePeriod | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const open = toPoint(raw['open']);
  if (!open) return null;
  const close = toPoint(raw['close']);
  return close ? { open, close } : { open };
}

function toPoint(value: unknown): PlacePoint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const day = raw['day'];
  if (typeof day !== 'number') return null;
  return {
    day,
    hour: typeof raw['hour'] === 'number' ? raw['hour'] : 0,
    minute: typeof raw['minute'] === 'number' ? raw['minute'] : 0,
  };
}

function localizedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const text = (value as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}
