import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ScanOptions } from './types.js';

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
    discovery: ['import', 'sitemap', 'crawl', 'searchapi', 'gsc', 'backlinks'],
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
  };
}

export function mergeScanOptions(input: Partial<ScanOptions>): ScanOptions {
  const merged = { ...defaultScanOptions(), ...input };
  merged.sites = input.sites ?? [];
  merged.urls = input.urls ?? [];
  merged.inputFiles = input.inputFiles ?? [];
  merged.discovery = input.discovery ?? defaultScanOptions().discovery;
  merged.concurrency = positiveInteger(merged.concurrency, 'concurrency');
  merged.perHostConcurrency = positiveInteger(merged.perHostConcurrency, 'per-host concurrency');
  merged.hostDelayMs = nonNegativeInteger(merged.hostDelayMs, 'host delay');
  merged.crawlLimit = positiveInteger(merged.crawlLimit, 'crawl limit');
  merged.timeoutMs = positiveInteger(merged.timeoutMs, 'timeout');
  merged.gscDays = positiveInteger(merged.gscDays, 'GSC days');
  merged.backlinkLimit = positiveInteger(merged.backlinkLimit, 'backlink limit');
  merged.hoursToleranceMinutes = nonNegativeInteger(merged.hoursToleranceMinutes, 'hours tolerance');
  merged.hoursPageLimit = positiveInteger(merged.hoursPageLimit, 'hours page limit');
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
