import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appConfigDir } from '../config.js';
import { GoogleSearchConsole } from '../google.js';
import { DAY_INDEXES, dayIndexFromToken, makeWeeklyHours, weeklyHoursFromPlaceHours } from '../hours/schedule.js';
import { parseTextHours } from '../hours/parse-text.js';
import type { DayIndex, OpenInterval, PlaceOpeningHours } from '../types.js';
import { emptySnapshot, fact, SERVICES, type ImportedProfile, type ProfileSnapshot, type Service } from './model.js';

type Json = Record<string, any>;
export type ApiRead = (url: string, init?: RequestInit) => Promise<Json>;
const INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const ACTIONS = 'https://mybusinessplaceactions.googleapis.com/v1';
const PLACE_FIELDS = 'id,displayName,formattedAddress,websiteUri,internationalPhoneNumber,nationalPhoneNumber,regularOpeningHours,currentOpeningHours,businessStatus,googleMapsUri,timeZone,attributions';
const LOCATION_FIELDS = 'name,title,phoneNumbers,websiteUri,storefrontAddress,regularHours,specialHours,moreHours,openInfo,metadata,categories';

export class BusinessProfileConnection extends GoogleSearchConsole {
  constructor() { super(join(appConfigDir(), 'gbp-token.json'), ['https://www.googleapis.com/auth/business.manage'], 'Google Business Profile'); }
  async read(url: string): Promise<Json> {
    const parsed = new URL(url);
    if (!['mybusinessbusinessinformation.googleapis.com', 'mybusinessplaceactions.googleapis.com'].includes(parsed.hostname)) throw new Error('Invalid GBP API host');
    const client = await this.client();
    try {
      const response = await client.request<Json>({ url, method: 'GET', timeout: 30000 });
      return response.data;
    } catch (error) {
      throw gbpFailure(error);
    }
  }
  async locations(): Promise<Array<{ name: string; title: string; address: string }>> {
    const rows = await paginate(`${INFO}/accounts/-/locations?readMask=name,title,storefrontAddress&pageSize=100`, 'locations', url => this.read(url));
    return rows.map(row => ({ name: row.name, title: row.title || '', address: address(row.storefrontAddress) }));
  }
}

/**
 * Business Profile APIs are gated: a new Cloud project has a quota of 0 requests per minute
 * until Google approves its access application, so every call fails with 429 even after a
 * successful sign-in. Google's message never says that, so the fix is named here.
 */
export function gbpFailure(error: unknown): Error {
  const status = (error as { response?: { status?: number } })?.response?.status ?? (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return new Error(`Google Business Profile API refused the request (${message}). New Google Cloud projects start with a quota of 0 requests per minute: submit the Business Profile API access request at https://developers.google.com/my-business/content/prereqs and wait for approval, or use "Public Google Places listing" or "Profile details you supply" meanwhile.`);
  }
  if (status === 403 && /has not been used|disabled|SERVICE_DISABLED/i.test(message)) {
    return new Error(`${message} Enable "My Business Account Management API" and "My Business Business Information API" for this Google Cloud project.`);
  }
  return error instanceof Error ? error : new Error(message);
}

/**
 * A rejected Google key is the most common reason a profile audit produces nothing, and the
 * HTTP status alone never says which of the many causes applied. Google puts the actionable
 * sentence in the response body, so failures carry it through instead of discarding it.
 */
export async function providerFailure(response: Response, body: string): Promise<Error> {
  let detail = '';
  let reason = '';
  try {
    const parsed = JSON.parse(body);
    detail = typeof parsed?.error?.message === 'string' ? parsed.error.message : '';
    reason = parsed?.error?.details?.find((item: Json) => typeof item?.reason === 'string')?.reason || parsed?.error?.status || '';
  } catch {
    detail = body.trim().slice(0, 300);
  }
  const advice = PROVIDER_ADVICE[reason] || (response.status === 403 && !detail ? PROVIDER_ADVICE.PERMISSION_DENIED : '');
  return new Error([`Google API HTTP ${response.status}`, detail && `: ${detail}`, reason && ` (${reason})`, advice && ` ${advice}`].filter(Boolean).join(''));
}

/** Google's own message names the problem; these name the fix, which the message never does. */
const PROVIDER_ADVICE: Record<string, string> = {
  API_KEY_IP_ADDRESS_BLOCKED: 'Edit this key in Google Cloud Console → APIs & Services → Credentials and either add this machine\'s IP to the allow list or remove the IP restriction.',
  API_KEY_HTTP_REFERRER_BLOCKED: 'This key is restricted to website referrers, which a server-side audit cannot send. Create a key with no referrer restriction, or restrict it by IP instead.',
  API_KEY_SERVICE_BLOCKED: 'Add "Places API (New)" to this key\'s API restrictions in Google Cloud Console.',
  API_KEY_INVALID: 'Check GOOGLE_MAPS_API_KEY for stray spaces or a truncated value, then restart the dashboard.',
  SERVICE_DISABLED: 'Enable "Places API (New)" for this project in Google Cloud Console.',
  BILLING_DISABLED: 'Enable billing on this Google Cloud project; Places API requests are billed per call.',
  RATE_LIMIT_EXCEEDED: 'The project quota is exhausted; raise the Places API quota or retry later.',
  PERMISSION_DENIED: 'Check that GOOGLE_MAPS_API_KEY is valid, that Places API (New) is enabled, and that no IP or referrer restriction blocks this machine.',
};

export async function requestJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Json> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (response.ok) {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
      return value as Json;
    }
    const body = await response.text().catch(() => '');
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retry = response.headers.get('retry-after');
      const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 1000 * 2 ** attempt;
      if (retryMs > 30000) throw await providerFailure(response, body);
      await delay(Math.max(500, retryMs || 1000), undefined, { signal }); continue;
    }
    throw await providerFailure(response, body);
  }
  throw new Error('Provider retries exhausted');
}

export async function publicProfiles(query: string, placeId?: string, signal?: AbortSignal, read?: ApiRead): Promise<ProfileSnapshot[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  // GOOGLE_CLIENT_ID/SECRET authorize Search Console and the managed Business Profile API.
  // Public Places is a separate, key-based product, so name it rather than implying OAuth.
  if (!key && !read) throw new Error('Public profile cross-matching needs GOOGLE_MAPS_API_KEY (Places API New). GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET only cover Search Console and the connected Business Profile mode.');
  const call = read ?? ((url, init) => requestJson(url, init, signal));
  const headers = { 'X-Goog-Api-Key': key || '', 'X-Goog-FieldMask': placeId ? PLACE_FIELDS : PLACE_FIELDS.split(',').map(f => `places.${f}`).join(','), 'content-type': 'application/json' };
  const data = await call(placeId ? `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}` : 'https://places.googleapis.com/v1/places:searchText', placeId ? { headers } : { method: 'POST', headers, body: JSON.stringify({ textQuery: query, languageCode: 'en', pageSize: 5 }) });
  return (placeId ? [data] : Array.isArray(data.places) ? data.places : []).map(fromPlace);
}

/**
 * The public Google Maps listing read through Serper's Maps endpoint: the same panel customers
 * see (name, address, phone, website, weekly hours, booking links, place id) for 3 Serper
 * credits, against a Places API call that bills in the Enterprise tier once hours are requested.
 * It also works where a Places key is missing or restricted.
 */
export async function serperMapsProfiles(query: string, country: string, placeId?: string, signal?: AbortSignal, apiKey = process.env.SERPER_API_KEY): Promise<ProfileSnapshot[]> {
  if (!apiKey) throw new Error('SERPER_API_KEY is not set');
  const response = await fetch(process.env.SERPER_MAPS_ENDPOINT || 'https://google.serper.dev/maps', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ q: query, gl: country.toLowerCase(), hl: 'en' }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  });
  let data: Json;
  try { data = await response.json() as Json; } catch { throw new Error(`Serper Maps returned an invalid response (HTTP ${response.status})`); }
  if (!response.ok || (data.message && !data.places)) throw new Error(`Serper Maps request failed: ${String(data.message || `HTTP ${response.status}`).replaceAll(apiKey, '[redacted]')}`);
  const places: Json[] = Array.isArray(data.places) ? data.places : [];
  // A supplied Place ID pins the branch; otherwise every candidate goes to address verification.
  const pinned = placeId ? places.filter(place => place.placeId === placeId) : [];
  return (pinned.length ? pinned : places.slice(0, 5)).map(fromSerperPlace);
}

export function fromSerperPlace(data: Json): ProfileSnapshot {
  const out = emptySnapshot('places', 'The Google Maps listing does not show this field; public absence is not established');
  out.placeId = typeof data.placeId === 'string' ? data.placeId : undefined;
  const url = out.placeId ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(out.placeId)}` : `https://www.google.com/maps?cid=${encodeURIComponent(String(data.cid ?? ''))}`;
  const locator = (field: string) => `Google Maps listing via Serper (${field})`;
  for (const [field, value] of Object.entries({ name: data.title, address: data.address, phone: data.phoneNumber, website: data.website })) fact(out, field, value, url, locator(field));
  const opening = data.openingHours && typeof data.openingHours === 'object' ? data.openingHours as Record<string, string> : null;
  if (opening) {
    // "6–10:30 PM" style text goes through the same reader as website text, so both sides
    // land in the identical week model before they are compared.
    const lines = Object.entries(opening).map(([day, text]) => `${day}: ${String(text).replace(/[\u202f\u00a0]/g, ' ')}`);
    const parsed = parseTextHours([lines.join('\n')]);
    if (parsed) fact(out, 'hours', parsed.weekly, url, locator('openingHours'), lines.join('; '));
    else out.warnings.push(`Google Maps opening hours could not be read: ${lines.join('; ')}`);
  }
  const booking = Array.isArray(data.bookingLinks) ? data.bookingLinks.filter((link: unknown): link is string => typeof link === 'string' && /^https?:/.test(link)) : [];
  for (const link of booking) out.links.push({ service: 'reservations', url: link, label: 'Google Maps booking link', source: 'places' });
  out.coverage['services.reservations'] = booking.length ? { state: 'present', reason: 'Booking link shown on the Google Maps listing' } : { state: 'unsupported', reason: 'No booking link shown on the listing; absence is not established' };
  for (const service of ['menu', 'ordering'] as const) out.coverage[`services.${service}`] = { state: 'unsupported', reason: 'The Google Maps listing data does not include this service URL' };
  return out;
}

/**
 * Verifies GOOGLE_MAPS_API_KEY against the live Places API on request. The `places.id` field
 * mask keeps this on the ID-only Text Search tier so checking a key is not a priced lookup.
 */
export async function checkPlacesKey(read?: ApiRead): Promise<{ ok: boolean; message: string }> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key && !read) return { ok: false, message: 'GOOGLE_MAPS_API_KEY is not set. Add it to your .env file and restart the dashboard.' };
  const call = read ?? ((url, init) => requestJson(url, init));
  try {
    await call('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'X-Goog-Api-Key': key || '', 'X-Goog-FieldMask': 'places.id', 'content-type': 'application/json' },
      body: JSON.stringify({ textQuery: 'restaurant', languageCode: 'en', pageSize: 1 }),
    });
    return { ok: true, message: 'Google Places accepted this key. Public profile cross-matching is ready.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function fromPlace(data: Json): ProfileSnapshot {
  const out = emptySnapshot('places', 'Places did not return this field; public absence is not established');
  out.placeId = typeof data.id === 'string' ? data.id : undefined;
  const url = data.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=restaurant&query_place_id=${encodeURIComponent(out.placeId || '')}`;
  for (const [field, value] of Object.entries({ name: data.displayName?.text, address: data.formattedAddress, phone: data.internationalPhoneNumber || data.nationalPhoneNumber, website: data.websiteUri, timezone: data.timeZone?.id, business_status: data.businessStatus, attributions: data.attributions })) fact(out, field, value, url, field);
  if (data.regularOpeningHours) fact(out, 'hours', weeklyHoursFromPlaceHours(data.regularOpeningHours as PlaceOpeningHours), url, 'regularOpeningHours');
  if (data.currentOpeningHours) {
    fact(out, 'current_hours', data.currentOpeningHours, url, 'currentOpeningHours');
    const dates = currentDates(data.currentOpeningHours);
    if (Object.keys(dates).length) fact(out, 'special_hours', dates, url, 'currentOpeningHours date periods (bounded window)');
  }
  for (const service of SERVICES) out.coverage[`services.${service}`] = { state: 'unsupported', reason: 'Places does not expose this service URL inventory' };
  return out;
}

export async function managedProfiles(location: string, read: ApiRead): Promise<ProfileSnapshot[]> {
  if (!/^locations\/[A-Za-z0-9_-]+$/.test(location)) throw new Error('GBP location must be locations/{id}');
  const base = `${INFO}/${location}`;
  const data = await read(`${base}?readMask=${LOCATION_FIELDS}`);
  const out = fromManaged(data, 'gbp_managed');
  const updates: ProfileSnapshot[] = [];
  try {
    const updated = await read(`${base}:getGoogleUpdated?readMask=${LOCATION_FIELDS}`);
    if (updated.location) updates.push(fromManaged(updated.location, 'gbp_google_updated'));
  } catch { out.warnings.push('Google-updated business information could not be read'); }
  try {
    const attributes = await read(`${base}/attributes`);
    const menu = (attributes.attributes || []).find((a: Json) => a.name === 'attributes/url_menu');
    const links = (menu?.uriValues || []).map((v: Json) => v.uri).filter((s: unknown) => typeof s === 'string');
    out.links.push(...links.map((url: string) => ({ service: 'menu' as const, url, label: 'Menu', source: out.source })));
    out.coverage['services.menu'] = { state: links.length ? 'present' : 'not_found', reason: 'Menu URL attribute in the managed profile; public panel visibility not established' };
  } catch { out.coverage['services.menu'] = { state: 'unavailable', reason: 'Menu attributes could not be read' }; }
  try {
    const actions = await paginate(`${ACTIONS}/${location}/placeActionLinks?pageSize=100`, 'placeActionLinks', read);
    for (const item of actions) {
      const service: Service | null = item.placeActionType === 'DINING_RESERVATION' ? 'reservations' : ['FOOD_ORDERING', 'FOOD_DELIVERY', 'FOOD_TAKEOUT'].includes(item.placeActionType) ? 'ordering' : null;
      if (service && typeof item.uri === 'string') out.links.push({ service, url: item.uri, label: item.placeActionType, source: out.source, provider: item.providerType, preferred: item.isPreferred, editable: item.isEditable });
    }
    for (const service of ['reservations', 'ordering'] as const) out.coverage[`services.${service}`] = { state: out.links.some(l => l.service === service) ? 'present' : 'not_found', reason: 'Managed action list exhausted; public panel visibility not established' };
  } catch { for (const service of ['reservations', 'ordering']) out.coverage[`services.${service}`] = { state: 'unavailable', reason: 'Action list incomplete or unavailable' }; }
  out.warnings.push('Configured GBP links do not prove customer-facing button visibility. Public Search/Maps display was not inspected.');
  return [out, ...updates];
}

function fromManaged(data: Json, source: 'gbp_managed' | 'gbp_google_updated'): ProfileSnapshot {
  const out = emptySnapshot(source, 'Managed profile field not set');
  out.resourceName = data.name; out.placeId = data.metadata?.placeId;
  for (const field of ['name', 'phone', 'website', 'hours', 'special_hours']) out.coverage[field] = { state: 'not_found', reason: 'Not set in this managed source' };
  for (const [field, value] of Object.entries({ name: data.title, phone: data.phoneNumbers?.primaryPhone, additional_phones: data.phoneNumbers?.additionalPhones, website: data.websiteUri, address: address(data.storefrontAddress), business_status: data.openInfo?.status })) fact(out, field, value, data.name || '', field);
  if (data.regularHours?.periods) {
    const intervals: OpenInterval[] = [];
    for (const p of data.regularHours.periods) {
      const d = dayIndexFromToken(p.openDay), c = dayIndexFromToken(p.closeDay);
      if (d === null || c === null || !p.openTime || !p.closeTime) continue;
      const start = d * 1440 + (p.openTime.hours || 0) * 60 + (p.openTime.minutes || 0);
      let end = c * 1440 + (p.closeTime.hours || 0) * 60 + (p.closeTime.minutes || 0);
      if (end <= start) end += 10080;
      intervals.push({ start, end });
    }
    fact(out, 'hours', makeWeeklyHours(intervals, DAY_INDEXES), data.name, 'regularHours');
  }
  const exceptions: Record<string, OpenInterval[]> = {};
  for (const p of data.specialHours?.specialHourPeriods || []) {
    const date = dateString(p.startDate); if (!date) continue;
    exceptions[date] ??= [];
    if (p.closed) continue;
    if (!p.openTime || !p.closeTime) { delete exceptions[date]; continue; }
    const start = (p.openTime.hours || 0) * 60 + (p.openTime.minutes || 0);
    const days = p.endDate ? Math.round((Date.parse(dateString(p.endDate)) - Date.parse(date)) / 86400000) : 0;
    let end = days * 1440 + (p.closeTime.hours || 0) * 60 + (p.closeTime.minutes || 0);
    if (end <= start) end += 1440;
    exceptions[date]!.push({ start, end });
  }
  if (Object.keys(exceptions).length) fact(out, 'special_hours', exceptions, data.name, 'specialHours');
  if (data.moreHours?.length) fact(out, 'service_hours', data.moreHours, data.name, 'moreHours (separate from general hours)');
  return out;
}

export async function paginate(url: string, field: string, read: ApiRead): Promise<Json[]> {
  const output: Json[] = [], seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await read(url);
    if (data[field] !== undefined && !Array.isArray(data[field])) throw new Error('Invalid provider list');
    output.push(...(data[field] || []));
    if (!data.nextPageToken) return output;
    if (typeof data.nextPageToken !== 'string' || seen.has(data.nextPageToken)) throw new Error('Provider pagination repeated');
    seen.add(data.nextPageToken); const next = new URL(url); next.searchParams.set('pageToken', data.nextPageToken); url = next.href;
  }
  throw new Error('Provider pagination budget reached');
}

export function fromImported(row: ImportedProfile): ProfileSnapshot {
  const out = emptySnapshot('imported', 'Field omitted from supplied evidence'); out.placeId = row.placeId;
  for (const field of ['name', 'address', 'phone', 'website', 'timezone'] as const) fact(out, field, row[field], row.url, `import.${field}`);
  if (row.weekly) fact(out, 'hours', row.weekly, row.url, 'import.weekly');
  if (row.exceptions) fact(out, 'special_hours', row.exceptions, row.url, 'import.exceptions');
  for (const service of SERVICES) if (row.services?.[service]) {
    out.links.push(...row.services[service]!.map(url => ({ service, url, label: service, source: out.source })));
    out.coverage[`services.${service}`] = { state: row.services[service]!.length ? 'present' : 'not_found', reason: 'Explicitly supplied observation; not a live Google read' };
  }
  out.facts.forEach(f => f.observedAt = row.observedAt);
  out.warnings.push(`Imported observation captured ${row.observedAt}; it may be stale.`);
  return out;
}

function address(a: Json | undefined): string { return a ? [...(a.addressLines || []), a.locality, a.administrativeArea, a.postalCode, a.regionCode].filter(Boolean).join(', ') : ''; }
function dateString(d: Json | undefined): string { return d?.year && d?.month && d?.day ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : ''; }
function currentDates(hours: Json): Record<string, OpenInterval[]> {
  const result: Record<string, OpenInterval[]> = {};
  for (const p of hours.periods || []) {
    const date = dateString(p.open?.date), endDate = dateString(p.close?.date);
    if (!date || !endDate || p.open?.truncated || p.close?.truncated) continue;
    const start = (p.open.hour || 0) * 60 + (p.open.minute || 0);
    const end = Math.round((Date.parse(endDate) - Date.parse(date)) / 86400000) * 1440 + (p.close.hour || 0) * 60 + (p.close.minute || 0);
    if (end > start) (result[date] ??= []).push({ start, end });
  }
  return result;
}
