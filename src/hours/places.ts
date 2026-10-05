import { setTimeout as delay } from 'node:timers/promises';
import type { PlaceMatch, PlaceOpeningHours, PlacePeriod, PlacePoint } from '../types.js';
import type { PlaceLookup } from './match.js';
import { parseTextHours } from './parse-text.js';
import { DAY_NAMES, WEEK_MINUTES as WEEK } from './schedule.js';

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

export async function searchPlaces(textQuery: string, apiKey = process.env.GOOGLE_MAPS_API_KEY, signal?: AbortSignal): Promise<PlaceMatch[]> {
  const payload = await request(`${endpoint()}/places:searchText`, {
    method: 'POST',
    body: JSON.stringify({ textQuery, maxResultCount: 5, languageCode: 'en' }),
  }, apiKey, PLACE_FIELDS.map((field) => `places.${field}`).join(','), signal);
  const places = (payload as { places?: unknown[] }).places ?? [];
  return places.flatMap((place) => {
    const match = toPlaceMatch(place);
    return match ? [match] : [];
  });
}

export async function fetchPlaceDetails(placeId: string, apiKey = process.env.GOOGLE_MAPS_API_KEY, signal?: AbortSignal): Promise<PlaceMatch | null> {
  const payload = await request(`${endpoint()}/places/${encodeURIComponent(placeId)}`, { method: 'GET' }, apiKey, PLACE_FIELDS.join(','), signal);
  return toPlaceMatch(payload);
}

function endpoint(): string {
  return (process.env.GOOGLE_PLACES_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}

/**
 * The API key travels in a header rather than the query string so it cannot leak
 * through an error message that echoes the request URL.
 */
async function request(url: string, init: RequestInit, apiKey: string | undefined, fieldMask: string, signal?: AbortSignal): Promise<unknown> {
  if (!apiKey) throw new Error('GOOGLE_MAPS_API_KEY is required for opening-hours comparison');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        'x-goog-fieldmask': fieldMask,
      },
      signal: withTimeout(signal),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    // Only quota exhaustion is worth retrying; retrying a rejected field mask burns quota for nothing.
    if (response.status === 429 && attempt === 0) {
      await delay(RETRY_DELAY_MS, undefined, { signal });
      continue;
    }
    const message = (payload as { error?: { message?: string } }).error?.message;
    throw new Error(message || `Places request failed with HTTP ${response.status}`);
  }
  throw new Error('Places request failed after a rate-limit retry');
}

/** The caller's deadline (the hosted worker has one) still never waits longer than the default. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
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

/**
 * The same Google Maps listing read through Serper's Maps endpoint (3 credits, no Google Cloud
 * key). Its hours arrive as display text ("6–10:30 PM"), so they are parsed with the website
 * text reader and re-expressed as Places periods: the comparator never sees the difference.
 */
export async function searchSerperPlaces(textQuery: string, apiKey = process.env.SERPER_API_KEY, signal?: AbortSignal, country?: string): Promise<PlaceMatch[]> {
  if (!apiKey) throw new Error('SERPER_API_KEY is not set');
  const response = await fetch(process.env.SERPER_MAPS_ENDPOINT || 'https://google.serper.dev/maps', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    // Without a market, Serper searches from its default region and a bare restaurant name
    // can resolve to a namesake abroad.
    body: JSON.stringify({ q: textQuery, hl: 'en', ...(country && /^[a-z]{2}$/i.test(country) ? { gl: country.toLowerCase() } : {}) }),
    signal: withTimeout(signal),
  });
  let payload: { places?: Array<Record<string, unknown>>; message?: string };
  try { payload = await response.json() as typeof payload; } catch { throw new Error(`Serper Maps returned an invalid response (HTTP ${response.status})`); }
  if (!response.ok || (payload.message && !payload.places)) throw new Error(`Serper Maps request failed: ${String(payload.message || `HTTP ${response.status}`).replaceAll(apiKey, '[redacted]')}`);
  return (payload.places ?? []).slice(0, 5).flatMap((place) => {
    const placeId = typeof place.placeId === 'string' ? place.placeId : typeof place.cid === 'string' ? `cid:${place.cid}` : null;
    if (!placeId || typeof place.title !== 'string') return [];
    return [{
      placeId,
      displayName: place.title,
      formattedAddress: typeof place.address === 'string' ? place.address : '',
      websiteUri: typeof place.website === 'string' ? place.website : null,
      utcOffsetMinutes: null,
      businessStatus: null,
      regularOpeningHours: serperOpeningHours(place.openingHours),
    }];
  });
}

export function serperOpeningHours(value: unknown): PlaceOpeningHours | null {
  if (!value || typeof value !== 'object') return null;
  const descriptions = Object.entries(value as Record<string, unknown>).map(([day, text]) => `${day}: ${String(text).replace(/[  ]/g, ' ')}`);
  const parsed = parseTextHours([descriptions.join('\n')]);
  if (!parsed) return { periods: [], weekdayDescriptions: [] };
  const point = (minute: number): PlacePoint => {
    const inWeek = ((minute % WEEK) + WEEK) % WEEK;
    return { day: Math.floor(inWeek / 1440) as PlacePoint['day'], hour: Math.floor((inWeek % 1440) / 60), minute: inWeek % 60 };
  };
  const periods: PlacePeriod[] = parsed.weekly.open24x7
    ? [{ open: { day: 0, hour: 0, minute: 0 } }]
    : parsed.weekly.intervals.map((interval) => ({ open: point(interval.start), close: point(interval.end) }));
  // Only days the listing actually shows count as stated, so a missing day is never "closed".
  const stated = new Set(parsed.weekly.statedDays.map((day) => DAY_NAMES[day]));
  return { periods, weekdayDescriptions: descriptions.filter((line) => stated.has(line.split(':')[0] as typeof DAY_NAMES[number])) };
}

/**
 * The listing lookup both editions use: Google Maps data via Serper first (cheapest, and
 * unaffected by Cloud key restrictions), then the Places API. A Serper failure or an empty Serper
 * result falls through to Places when a key exists, and is reported through `onFallback`.
 */
export function placeLookup(keys: { serper?: string; maps?: string }, options: { signal?: AbortSignal; country?: string; onFallback?: (message: string) => void } = {}): PlaceLookup {
  return {
    search: async (query) => {
      if (keys.serper) {
        try {
          const found = await searchSerperPlaces(query, keys.serper, options.signal, options.country);
          if (found.length || !keys.maps) return found;
        } catch (error) {
          if (!keys.maps) throw error;
          options.onFallback?.(`Serper Maps unavailable (${error instanceof Error ? error.message : String(error)}); used Google Places instead`);
        }
      }
      return searchPlaces(query, keys.maps, options.signal);
    },
    // Serper's `cid:` identifiers are not Place IDs, and details need a Places key.
    details: (placeId) => keys.maps && !placeId.startsWith('cid:') ? fetchPlaceDetails(placeId, keys.maps, options.signal) : Promise.resolve(null),
  };
}
