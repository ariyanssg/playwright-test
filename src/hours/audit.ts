import type { HoursComparisonRecord, HoursComparisonStatus, PlaceMatch } from '../types.js';
import { compareWeeklyHours } from './compare.js';
import type { HoursInspector } from './inspector.js';
import { resolvePlace, type PlaceHints, type PlaceLookup } from './match.js';
import { weeklyHoursFromPlaceHours } from './schedule.js';

const CLOSED_STATUSES = new Set(['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']);

export interface HoursAuditInput {
  site: string;
  siteKey: string;
  pages: string[];
  hints: PlaceHints;
  toleranceMinutes: number;
  requireVerifiedPlace: boolean;
}

/**
 * Compares one restaurant's Google listing against its own website. Every
 * outcome is a recorded status rather than a thrown error, so one unreadable
 * site never stops the rest of the run.
 */
export async function auditSiteHours(
  input: HoursAuditInput,
  inspector: Pick<HoursInspector, 'inspect'>,
  lookup?: PlaceLookup,
): Promise<HoursComparisonRecord> {
  const extraction = await inspector.inspect(input.pages);
  const resolution = await resolvePlace(input.site, input.hints, extraction.identity, lookup);
  const notes = [...resolution.notes];

  let place = resolution.place;
  // Serper's Maps data sometimes omits a listing's hours; the Places API has them when a key exists.
  if (place && lookup && !place.regularOpeningHours?.periods.length) {
    const detailed = await lookup.details(place.placeId).catch(() => null);
    if (detailed?.regularOpeningHours?.periods.length) place = { ...place, regularOpeningHours: detailed.regularOpeningHours, businessStatus: place.businessStatus ?? detailed.businessStatus, utcOffsetMinutes: place.utcOffsetMinutes ?? detailed.utcOffsetMinutes };
  }
  const record = (status: HoursComparisonStatus, extra: Partial<HoursComparisonRecord> = {}): HoursComparisonRecord => ({
    site: input.site,
    siteKey: input.siteKey,
    status,
    matchConfidence: resolution.confidence,
    placeId: place?.placeId ?? null,
    placeName: place?.displayName ?? null,
    placeAddress: place?.formattedAddress ?? null,
    placeWebsite: place?.websiteUri ?? null,
    businessStatus: place?.businessStatus ?? null,
    utcOffsetMinutes: place?.utcOffsetMinutes ?? null,
    websiteMethod: extraction.method,
    websiteHoursUrl: extraction.sourceUrl,
    pagesInspected: extraction.pagesInspected,
    days: [],
    maxDeltaMinutes: null,
    notes,
    checkedAt: new Date().toISOString(),
    ...extra,
  });

  if (!place) return record('unmatched');
  if (input.requireVerifiedPlace && resolution.confidence === 'unverified') {
    notes.push('Skipped because --hours-require-verified-place is set and this listing could not be verified');
    return record('unmatched');
  }
  if (place.businessStatus && CLOSED_STATUSES.has(place.businessStatus)) {
    notes.push(`Google reports this business as ${place.businessStatus.toLowerCase().replace('_', ' ')}, so its hours are not compared`);
    return record('business_closed');
  }

  const google = weeklyHoursFromPlaceHours(place.regularOpeningHours);
  if (!google.statedDays.length) {
    notes.push('The Google listing publishes no regular opening hours');
    return record('no_google_hours');
  }
  if (!extraction.weekly?.statedDays.length) {
    notes.push(extraction.pagesInspected
      ? `No opening hours were found on ${extraction.pagesInspected} inspected page(s); they may be rendered by a third-party booking widget`
      : 'No pages could be loaded to read opening hours from');
    for (const failure of extraction.pageErrors) notes.push(`Could not read ${failure}`);
    return record('no_website_hours');
  }

  if (extraction.confidence === 'low') {
    notes.push('Website hours were read from visible text rather than structured data, so verify before acting');
  }
  if (extraction.alternateMethods.length) {
    notes.push(`Other sources on the page also published hours: ${extraction.alternateMethods.join(', ')}`);
  }

  const comparison = compareWeeklyHours(google, extraction.weekly, input.toleranceMinutes);
  return record(comparison.status, { days: comparison.days, maxDeltaMinutes: comparison.maxDeltaMinutes });
}

export function isHoursFinding(status: HoursComparisonStatus): boolean {
  return status === 'mismatch';
}

export function placeSummary(place: PlaceMatch | null): string {
  return place ? `${place.displayName} (${place.formattedAddress})` : 'no matched listing';
}
