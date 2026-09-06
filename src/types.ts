export const DISCOVERY_SOURCES = ['import', 'sitemap', 'crawl', 'searchapi', 'gsc', 'backlinks'] as const;
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
  | 'scanning'
  | 'reporting'
  | 'completed'
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
  backlinkSourceUrl?: string;
  backlinkSourceDomain?: string;
  anchor?: string | null;
  dofollow?: boolean;
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
  artifacts: string[];
}

export interface ScanProgressEvent {
  scanId: string;
  status: ScanStatus;
  total: number;
  processed: number;
  findings: number;
  backlinkCount: number;
  message: string;
}
