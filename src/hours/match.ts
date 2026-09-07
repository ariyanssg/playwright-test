import type { PlaceMatch, PlaceMatchConfidence } from '../types.js';
import { siteKey } from '../urls.js';
import { fetchPlaceDetails, searchPlaces } from './places.js';
import type { SiteIdentity } from './model.js';

/** Below this token-set overlap an unverified name match is not worth reporting. */
export const NAME_SIMILARITY_FLOOR = 0.6;

export interface PlaceHints {
  name?: string;
  address?: string;
  placeId?: string;
}

export interface PlaceResolution {
  place: PlaceMatch | null;
  confidence: PlaceMatchConfidence;
  notes: string[];
  /** Whether a billable Text Search was issued. */
  searched: boolean;
}

export interface PlaceLookup {
  search: (textQuery: string) => Promise<PlaceMatch[]>;
  details: (placeId: string) => Promise<PlaceMatch | null>;
}

const defaultLookup: PlaceLookup = {
  search: (textQuery) => searchPlaces(textQuery),
  details: (placeId) => fetchPlaceDetails(placeId),
};

/**
 * Resolves a site to a single Google listing. An operator-supplied place id wins
 * outright; otherwise the site's own identity drives a Text Search whose result
 * must point back at the same host to count as verified.
 */
export async function resolvePlace(
  site: string,
  hints: PlaceHints,
  identity: SiteIdentity | null,
  lookup: PlaceLookup = defaultLookup,
): Promise<PlaceResolution> {
  const notes: string[] = [];

  if (hints.placeId) {
    const place = await lookup.details(hints.placeId);
    if (place) return { place, confidence: 'place_id_supplied', notes, searched: false };
    notes.push(`The supplied place id ${hints.placeId} returned no listing; falling back to search`);
  }

  const name = firstText(hints.name, identity?.name);
  const address = firstText(hints.address, identity?.address);
  if (!name) {
    notes.push('No restaurant name could be read from the site or the input file, so no Google listing was searched for');
    return { place: null, confidence: 'none', notes, searched: false };
  }

  let places = await lookup.search(buildQuery(name, address));
  if (!places.length && address) places = await lookup.search(name);
  if (!places.length) {
    notes.push(`Google returned no listing for "${name}"`);
    return { place: null, confidence: 'none', notes, searched: true };
  }

  const verified = verifyPlaces(site, places);
  if (verified.length === 1) return { place: verified[0]!, confidence: 'verified', notes, searched: true };
  if (verified.length > 1) {
    notes.push(`${verified.length} Google listings point at this domain, which usually means multiple locations; supply a place_id column to pick one`);
    return { place: null, confidence: 'ambiguous', notes, searched: true };
  }

  const top = places[0]!;
  const similarity = nameSimilarity(top.displayName, name);
  if (similarity < NAME_SIMILARITY_FLOOR) {
    notes.push(`The closest Google listing ("${top.displayName}") does not resemble "${name}" closely enough to compare`);
    return { place: null, confidence: 'none', notes, searched: true };
  }
  notes.push(`Matched "${top.displayName}" by name only - its Google listing does not link back to this domain, so treat the comparison as unconfirmed`);
  return { place: top, confidence: 'unverified', notes, searched: true };
}

export function buildQuery(name: string, address?: string | null): string {
  return [name, address].filter(Boolean).join(', ');
}

/** A listing counts as verified when its own website points back at the same host. */
export function verifyPlaces(site: string, places: readonly PlaceMatch[]): PlaceMatch[] {
  let host: string;
  try {
    host = siteKey(site);
  } catch {
    return [];
  }
  return places.filter((place) => {
    if (!place.websiteUri) return false;
    try {
      return siteKey(place.websiteUri) === host;
    } catch {
      return false;
    }
  });
}

export function nameSimilarity(left: string, right: string): number {
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      // Apostrophes are dropped rather than split on, so "Luigi's" and "Luigis" agree.
      .replace(/['\u2019\u02bc]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function firstText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
