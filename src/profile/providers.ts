import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appConfigDir } from '../config.js';
import { GoogleSearchConsole } from '../google.js';
import { DAY_INDEXES, dayIndexFromToken, makeWeeklyHours, weeklyHoursFromPlaceHours } from '../hours/schedule.js';
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
    const response = await client.request<Json>({ url, method: 'GET', timeout: 30000 });
    return response.data;
  }
  async locations(): Promise<Array<{ name: string; title: string; address: string }>> {
    const rows = await paginate(`${INFO}/accounts/-/locations?readMask=name,title,storefrontAddress&pageSize=100`, 'locations', url => this.read(url));
    return rows.map(row => ({ name: row.name, title: row.title || '', address: address(row.storefrontAddress) }));
  }
}

export async function requestJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Json> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (response.ok) {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider response');
      return value as Json;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retry = response.headers.get('retry-after');
      const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 1000 * 2 ** attempt;
      if (retryMs > 30000) throw new Error(`Provider HTTP ${response.status}; retry later`);
      await delay(Math.max(500, retryMs || 1000), undefined, { signal }); continue;
    }
    throw new Error(`Provider HTTP ${response.status}`);
  }
  throw new Error('Provider retries exhausted');
}

export async function publicProfiles(query: string, placeId?: string, signal?: AbortSignal, read?: ApiRead): Promise<ProfileSnapshot[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key && !read) throw new Error('Connect Google Places using GOOGLE_MAPS_API_KEY');
  const call = read ?? ((url, init) => requestJson(url, init, signal));
  const headers = { 'X-Goog-Api-Key': key || '', 'X-Goog-FieldMask': placeId ? PLACE_FIELDS : PLACE_FIELDS.split(',').map(f => `places.${f}`).join(','), 'content-type': 'application/json' };
  const data = await call(placeId ? `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}` : 'https://places.googleapis.com/v1/places:searchText', placeId ? { headers } : { method: 'POST', headers, body: JSON.stringify({ textQuery: query, languageCode: 'en', pageSize: 5 }) });
  return (placeId ? [data] : Array.isArray(data.places) ? data.places : []).map(fromPlace);
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
