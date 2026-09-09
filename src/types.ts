export const DISCOVERY_SOURCES = ['import', 'sitemap', 'crawl', 'google', 'searchapi', 'google_browser', 'gsc', 'backlinks'] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const CLASSIFICATIONS = [
  'hard_404',
  'gone_410',
  'soft_404_suspected',
  'redirected',
  'ok',
  'server_error',
  'blocked',
  'timeout',
  'network_error',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export type ScanStatus =
  | 'queued'
  | 'discovering'
  | 'waiting_for_google'
  | 'scanning'
  | 'comparing_hours'
  | 'comparing_profile'
  | 'reporting'
  | 'completed'
  | 'completed_partial'
  | 'cancelled'
  | 'failed';

export interface DiscoveryEvidence {
  source: DiscoverySource;
  discoveredFrom?: string;
  query?: string;
  title?: string;
  snippet?: string;
  position?: number;
  impressions?: number;
  clicks?: number;
  averagePosition?: number;
  property?: string;
  provider?: string;
  resultPage?: number;
  searchUrl?: string;
  country?: string;
  language?: string;
  observedAt?: string;
  resultKind?: 'organic' | 'sitelink';
  backlinkSourceUrl?: string;
  backlinkSourceDomain?: string;
  anchor?: string | null;
  dofollow?: boolean;
  restaurantName?: string;
  restaurantAddress?: string;
  placeId?: string;
}

export interface BacklinkRecord {
  site: string;
  targetUrl: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceTitle: string | null;
  sourceHttpStatus: number | null;
  targetProviderStatus: number | null;
  anchor: string | null;
  dofollow: boolean | null;
  linkType: string | null;
  isNew: boolean;
  isLost: boolean;
  isBrokenByProvider: boolean | null;
  rank: number | null;
  domainRank: number | null;
  spamScore: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  linksCount: number;
  provider: 'dataforseo';
}

export interface Candidate {
  inputUrl: string;
  normalizedUrl: string;
  site: string;
  sources: DiscoveryEvidence[];
}

export interface RedirectHop {
  url: string;
  status: number | null;
  location?: string;
}

export interface GoogleIndexEvidence {
  property: string;
  verdict?: string | null;
  coverageState?: string | null;
  indexingState?: string | null;
  robotsTxtState?: string | null;
  pageFetchState?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
  lastCrawlTime?: string | null;
  referringUrls?: string[];
}

export interface ScanResult {
  inputUrl: string;
  normalizedUrl: string;
  site: string;
  sources: DiscoveryEvidence[];
  httpStatus: number | null;
  finalUrl: string;
  redirectChain: RedirectHop[];
  classification: Classification;
  confidence: number;
  reasons: string[];
  robotsAllowed: boolean | null;
  title: string;
  h1: string;
  canonical: string | null;
  contentType: string | null;
  responseMs: number;
  checkedAt: string;
  error: string | null;
  gsc?: GoogleIndexEvidence;
}

export interface ScanOptions {
  sites: string[];
  urls: string[];
  inputFiles: string[];
  discovery: DiscoverySource[];
  googleProvider: 'auto' | 'searchapi' | 'browser';
  googleCountry: string;
  googleLanguage: string;
  googleMaxPages: number;
  outputDir?: string;
  concurrency: number;
  perHostConcurrency: number;
  hostDelayMs: number;
  crawlLimit: number;
  timeoutMs: number;
  inspectGoogle: boolean;
  gscDays: number;
  backlinkLimit: number;
  failOn: 'hard' | 'soft' | 'none';
  checkHours: boolean;
  hoursToleranceMinutes: number;
  hoursPageLimit: number;
  hoursRequireVerifiedPlace: boolean;
  checkProfile: boolean;
  profileMode: import('./profile/model.js').ProfileMode;
  profilePageLimit: number;
  profileHoursTolerance: number;
  profileTargets: import('./profile/model.js').ProfileTarget[];
  profileEvidence: import('./profile/model.js').ImportedProfile[];
}

export interface StoredScan {
  id: string;
  status: ScanStatus;
  options: ScanOptions;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  total: number;
  processed: number;
  findings: number;
  error: string | null;
  outputDir: string;
  cancelRequested: boolean;
  warnings: string[];
}

export interface CandidateRecord extends Candidate {
  status: 'pending' | 'running' | 'complete';
  result: ScanResult | null;
}

export interface ScanSummary {
  scan: StoredScan;
  counts: Record<Classification, number>;
  sourceCounts: Partial<Record<DiscoverySource, number>>;
  backlinkCount: number;
  hoursCounts: Partial<Record<HoursComparisonStatus, number>>;
  artifacts: string[];
  googleDiscovery: GoogleDiscoveryState[];
  profiles?: import('./profile/model.js').ProfileReport[];
}

export interface GoogleQueryState {
  query: string;
  nextPage: number;
  nextUrl?: string;
  fingerprints: string[];
  done: boolean;
}

export interface GoogleDiscoveryState {
  site: string;
  provider: 'searchapi' | 'browser';
  providersUsed?: Array<'searchapi' | 'browser'>;
  country: string;
  language: string;
  pagesFetched: number;
  queries: GoogleQueryState[];
  status: 'running' | 'waiting' | 'exhausted' | 'limited' | 'failed' | 'cancelled';
  error?: string;
  updatedAt: string;
}

export interface ScanProgressEvent {
  scanId: string;
  status: ScanStatus;
  total: number;
  processed: number;
  findings: number;
  backlinkCount: number;
  hoursChecked: number;
  hoursMismatches: number;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Opening-hours comparison
 * ------------------------------------------------------------------ */

export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A half-open [start, end) span in minutes from Sunday 00:00 **local wall clock
 * at the restaurant**. `end` may exceed a week boundary, which means the span
 * wraps past Saturday midnight into Sunday.
 */
export interface OpenInterval {
  start: number;
  end: number;
}

export interface WeeklyHours {
  /** Sorted, merged, non-overlapping. */
  intervals: OpenInterval[];
  /** Days the source made an explicit statement about, including "Closed". */
  statedDays: DayIndex[];
  open24x7: boolean;
}

export const HOURS_METHODS = ['jsonld', 'microdata', 'text', 'none'] as const;
export type HoursMethod = (typeof HOURS_METHODS)[number];

export const HOURS_DAY_VERDICTS = [
  'match',
  'both_closed',
  'minor_difference',
  'mismatch',
  'closed_on_google',
  'closed_on_website',
  'missing_website',
  'missing_google',
  'unknown',
] as const;
export type DayVerdict = (typeof HOURS_DAY_VERDICTS)[number];

export const HOURS_COMPARISON_STATUSES = [
  'aligned',
  'minor_differences',
  'mismatch',
  'partial',
  'no_website_hours',
  'no_google_hours',
  'business_closed',
  'unmatched',
  'not_checked',
] as const;
export type HoursComparisonStatus = (typeof HOURS_COMPARISON_STATUSES)[number];

export const PLACE_MATCH_CONFIDENCES = ['verified', 'place_id_supplied', 'unverified', 'ambiguous', 'none'] as const;
export type PlaceMatchConfidence = (typeof PLACE_MATCH_CONFIDENCES)[number];

export interface PlacePoint {
  day: number;
  hour: number;
  minute: number;
}

export interface PlacePeriod {
  open: PlacePoint;
  close?: PlacePoint;
}

export interface PlaceOpeningHours {
  periods: PlacePeriod[];
  weekdayDescriptions: string[];
}

export interface PlaceMatch {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  websiteUri: string | null;
  utcOffsetMinutes: number | null;
  businessStatus: string | null;
  regularOpeningHours: PlaceOpeningHours | null;
}

export interface HoursDayDiff {
  day: DayIndex;
  verdict: DayVerdict;
  googleText: string;
  websiteText: string;
  deltaMinutes: number | null;
  notes: string[];
}

export interface HoursComparisonRecord {
  site: string;
  siteKey: string;
  status: HoursComparisonStatus;
  matchConfidence: PlaceMatchConfidence;
  placeId: string | null;
  placeName: string | null;
  placeAddress: string | null;
  placeWebsite: string | null;
  businessStatus: string | null;
  utcOffsetMinutes: number | null;
  websiteMethod: HoursMethod;
  websiteHoursUrl: string | null;
  pagesInspected: number;
  days: HoursDayDiff[];
  maxDeltaMinutes: number | null;
  notes: string[];
  checkedAt: string;
}
