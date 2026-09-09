import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DISCOVERY_SOURCES, type ScanOptions } from './types.js';
import { validateHttpUrl, validateImports } from './profile/model.js';

export const APP_NAME = 'seo404-auditor';

export function appConfigDir(): string {
  if (process.env.SEO404_CONFIG_DIR) return resolve(process.env.SEO404_CONFIG_DIR);
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, APP_NAME);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME);
  return join(homedir(), '.config', APP_NAME);
}

export function appDataDir(): string {
  if (process.env.SEO404_DATA_DIR) return resolve(process.env.SEO404_DATA_DIR);
  return join(appConfigDir(), 'data');
}

export function defaultOutputDir(): string {
  return resolve(process.cwd(), 'output', 'runs');
}

export function defaultScanOptions(): ScanOptions {
  return {
    sites: [],
    urls: [],
    inputFiles: [],
    discovery: ['google'],
    googleProvider: 'auto',
    googleCountry: 'gb',
    googleLanguage: 'en',
    googleMaxPages: 50,
    concurrency: 5,
    perHostConcurrency: 2,
    hostDelayMs: 300,
    crawlLimit: 10_000,
    timeoutMs: 30_000,
    inspectGoogle: false,
    gscDays: 90,
    backlinkLimit: 100_000,
    failOn: 'hard',
    checkHours: false,
    hoursToleranceMinutes: 15,
    hoursPageLimit: 5,
    hoursRequireVerifiedPlace: false,
    checkProfile: false,
    profileMode: 'public',
    profilePageLimit: 20,
    profileHoursTolerance: 0,
    profileTargets: [],
    profileEvidence: [],
  };
}

export function mergeScanOptions(input: Partial<ScanOptions>): ScanOptions {
  const merged = { ...defaultScanOptions(), ...input };
  merged.sites = input.sites ?? [];
  merged.urls = input.urls ?? [];
  merged.inputFiles = input.inputFiles ?? [];
  merged.discovery = input.discovery ?? (merged.checkProfile ? ['import'] : merged.sites.length ? ['google'] : ['import']);
  if (!Array.isArray(merged.discovery) || !merged.discovery.length || merged.discovery.some((source) => !DISCOVERY_SOURCES.includes(source))) {
    throw new Error('Choose valid discovery sources');
  }
  merged.discovery = [...new Set(merged.discovery)];
  if ((merged.urls.length || merged.inputFiles.length) && !merged.discovery.includes('import')) merged.discovery.unshift('import');
  if (!['auto', 'searchapi', 'browser'].includes(merged.googleProvider)) throw new Error('Google provider must be auto, searchapi, or browser');
  merged.googleCountry = String(merged.googleCountry).toLowerCase();
  merged.googleLanguage = String(merged.googleLanguage).toLowerCase();
  if (!/^[a-z]{2}$/.test(merged.googleCountry)) throw new Error('Google country must be a two-letter country code');
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(merged.googleLanguage)) throw new Error('Google language must be a language code such as en');
  merged.googleMaxPages = positiveInteger(merged.googleMaxPages, 'Google page budget');
  merged.concurrency = positiveInteger(merged.concurrency, 'concurrency');
  merged.perHostConcurrency = positiveInteger(merged.perHostConcurrency, 'per-host concurrency');
  merged.hostDelayMs = nonNegativeInteger(merged.hostDelayMs, 'host delay');
  merged.crawlLimit = positiveInteger(merged.crawlLimit, 'crawl limit');
  merged.timeoutMs = positiveInteger(merged.timeoutMs, 'timeout');
  merged.gscDays = positiveInteger(merged.gscDays, 'GSC days');
  merged.backlinkLimit = positiveInteger(merged.backlinkLimit, 'backlink limit');
  merged.hoursToleranceMinutes = nonNegativeInteger(merged.hoursToleranceMinutes, 'hours tolerance');
  merged.hoursPageLimit = positiveInteger(merged.hoursPageLimit, 'hours page limit');
  if (typeof merged.checkProfile !== 'boolean') throw new Error('checkProfile must be a boolean');
  if (!['public', 'managed', 'imported'].includes(merged.profileMode)) throw new Error('Profile mode must be public, managed, or imported');
  merged.profilePageLimit = positiveInteger(merged.profilePageLimit, 'profile page limit');
  merged.profileHoursTolerance = nonNegativeInteger(merged.profileHoursTolerance, 'profile hours tolerance');
  merged.profileEvidence = validateImports(merged.profileEvidence);
  if (!Array.isArray(merged.profileTargets)) throw new Error('profileTargets must be an array');
  for (const target of merged.profileTargets) {
    if (!target || typeof target !== 'object') throw new Error('Invalid profile target');
    validateHttpUrl(target.url);
    for (const key of ['name', 'address', 'placeId', 'gbpLocation'] as const) if (target[key] !== undefined && (typeof target[key] !== 'string' || target[key]!.length > 2000)) throw new Error(`Invalid target ${key}`);
    if (target.gbpLocation && !/^locations\/[A-Za-z0-9_-]+$/.test(target.gbpLocation)) throw new Error('GBP location must be locations/{id}');
  }
  if (merged.checkProfile && merged.profileMode === 'imported' && !merged.profileEvidence.length) throw new Error('Imported profile mode requires profileEvidence');
  return merged;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
