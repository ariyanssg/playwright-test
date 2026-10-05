import { EventEmitter } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { appDataDir, defaultOutputDir, mergeScanOptions } from './config.js';
import { ScanDatabase } from './database.js';
import { discoverCrawl } from './discovery/crawl.js';
import { discoverBacklinks } from './discovery/backlinks.js';
import { discoverGoogle, defaultGoogleProviders, type GoogleProviders } from './discovery/google-search.js';
import { discoverSitemaps, type DiscoveredUrl } from './discovery/sitemap.js';
import { GoogleSearchConsole } from './google.js';
import { importRowsFromFile, type ImportedRow } from './imports.js';
import { auditSiteHours } from './hours/audit.js';
import { HoursInspector } from './hours/inspector.js';
import type { PlaceHints } from './hours/match.js';
import { placeLookup } from './hours/places.js';
import { selectHoursPages } from './hours/pages.js';
import { holdBrowser } from './browser.js';
import { RobotsCache } from './robots.js';
import { BrowserScanner } from './scanner.js';
import type { Candidate, CandidateRecord, DiscoveryEvidence, ScanOptions, ScanProgressEvent, ScanSummary, StoredScan } from './types.js';
import { normalizeUrl, siteKey, siteOrigin, tryNormalizeUrl } from './urls.js';
import { writeReports } from './reports.js';
import { auditProfile, targetKey, type AuditDependencies } from './profile/audit.js';
import { BusinessProfileConnection } from './profile/providers.js';
import type { ProfileReport, ProfileTarget } from './profile/model.js';

/** Restaurants whose profile audits may run at once; each launches its own guarded browser. */
const PROFILE_PARALLEL_TARGETS = 2;

export class ScanService {
  readonly db: ScanDatabase;
  readonly google: GoogleSearchConsole;
  readonly gbp = new BusinessProfileConnection();
  private readonly liveProfiles = new Map<string, { expires: number; reports: Map<string, ProfileReport> }>();
  private readonly profileExpiry = setInterval(() => {
    for (const [key, entry] of this.liveProfiles) if (entry.expires <= Date.now()) this.liveProfiles.delete(key);
  }, 60000).unref();
  readonly robots = new RobotsCache();
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, Promise<StoredScan>>();
  private readonly discoveryControllers = new Map<string, AbortController>();
  private readonly googleWaiters = new Map<string, () => void>();

  constructor(databasePath = join(appDataDir(), 'seo404.sqlite'), private readonly googleProviders: GoogleProviders = defaultGoogleProviders, private readonly profileDependencies: AuditDependencies = {}) {
    this.db = new ScanDatabase(databasePath);
    this.google = new GoogleSearchConsole();
  }

  createScan(input: Partial<ScanOptions>): StoredScan {
    const options = mergeScanOptions(input);
    if (!options.sites.length && !options.urls.length && !options.inputFiles.length && !options.profileTargets.length) {
      throw new Error('Provide at least one --site, URL, or input file');
    }
    const id = makeScanId();
    const outputDir = join(resolve(options.outputDir ?? defaultOutputDir()), id);
    return this.db.createScan(id, options, outputDir);
  }

  start(scanId: string): Promise<StoredScan> {
    const running = this.active.get(scanId);
    if (running) return running;
    const promise = this.run(scanId).finally(() => this.active.delete(scanId));
    this.active.set(scanId, promise);
    return promise;
  }

  async resume(scanId: string): Promise<StoredScan> {
    const scan = this.db.getScan(scanId);
    if (!scan) throw new Error(`Unknown scan: ${scanId}`);
    if (scan.status === 'completed' && !scan.options.checkProfile) return scan;
    const running = this.active.get(scanId);
    if (running) {
      // A live run waiting on Google just needs its Continue signal.
      if (!scan.cancelRequested && !['completed', 'completed_partial', 'cancelled', 'failed'].includes(scan.status)) {
        this.googleWaiters.get(scanId)?.();
        return running;
      }
      // A run that has already recorded its final status may still be closing its browser.
      // Returning it here used to swallow a Resume pressed right after Cancel.
      await running.catch(() => undefined);
      if (this.active.has(scanId)) return this.active.get(scanId)!;
    }
    this.db.resetForResume(scanId);
    return this.start(scanId);
  }

  cancel(scanId: string): void {
    if (!this.db.getScan(scanId)) throw new Error(`Unknown scan: ${scanId}`);
    this.db.requestCancel(scanId);
    this.discoveryControllers.get(scanId)?.abort();
    this.googleWaiters.get(scanId)?.();
    this.emit(scanId, 'Cancellation requested');
  }

  getScan(scanId: string): StoredScan | null {
    return this.db.getScan(scanId);
  }

  listScans(): StoredScan[] {
    return this.db.listScans();
  }

  results(scanId: string, offset = 0, limit = 200, classification?: string, search = ''): { total: number; items: CandidateRecord[] } {
    if (!this.db.getScan(scanId)) throw new Error(`Unknown scan: ${scanId}`);
    return this.db.queryResults(scanId, offset, limit, classification, search);
  }

  close(): void {
    clearInterval(this.profileExpiry);
    this.liveProfiles.clear();
    this.db.close();
  }

  profiles(scanId: string): ProfileReport[] {
    for (const [key, entry] of this.liveProfiles) if (entry.expires <= Date.now()) this.liveProfiles.delete(key);
    const stored = this.db.listProfiles(scanId), live = this.liveProfiles.get(scanId)?.reports;
    const merged = new Map(stored.map(report => [report.targetKey, report]));
    for (const [key, report] of live || []) merged.set(key, report);
    return [...merged.values()];
  }

  async summary(scanId: string): Promise<ScanSummary> {
    const scan = this.db.getScan(scanId);
    if (!scan) throw new Error(`Unknown scan: ${scanId}`);
    const sourceCounts: ScanSummary['sourceCounts'] = this.db.sourceCounts(scanId);
    let artifacts: string[] = [];
    try {
      artifacts = await readdir(scan.outputDir);
    } catch {
      // Reports do not exist yet.
    }
    return {
      scan,
      counts: this.db.classificationCounts(scanId),
      sourceCounts,
      backlinkCount: this.db.backlinkCount(scanId),
      hoursCounts: this.db.hoursStatusCounts(scanId),
      artifacts,
      googleDiscovery: this.db.googleDiscovery(scanId),
      profiles: this.profiles(scanId),
    };
  }

  onProgress(scanId: string, listener: (event: ScanProgressEvent) => void): () => void {
    const name = `scan:${scanId}`;
    this.events.on(name, listener);
    return () => this.events.off(name, listener);
  }

  private async run(scanId: string): Promise<StoredScan> {
    const initial = this.db.getScan(scanId);
    if (!initial) throw new Error(`Unknown scan: ${scanId}`);
    // Old scans keep their explicit source choices; only fill newly added options.
    initial.options = mergeScanOptions(initial.options);
    const controller = new AbortController();
    this.discoveryControllers.set(scanId, controller);
    // Discovery, scanning, and the hours pass share one Chromium instead of launching three.
    const releaseBrowser = holdBrowser();
    try {
      this.db.updateScan(scanId, { status: 'discovering', startedAt: initial.startedAt ?? new Date().toISOString(), error: null });
      this.emit(scanId, 'Collecting candidate URLs');
      await this.discover(scanId, initial.options);

      if (!this.db.isCancelled(scanId)) {
        this.db.updateScan(scanId, { status: 'scanning' });
        this.emit(scanId, 'Checking live pages with Chromium');
        const scanner = new BrowserScanner(this.db, this.robots, initial.options, (event) => this.events.emit(`scan:${scanId}`, event));
        await scanner.scan(scanId, this.db.listCandidates(scanId, 'pending'));
      }

      if (!this.db.isCancelled(scanId) && initial.options.checkHours) {
        this.db.updateScan(scanId, { status: 'comparing_hours' });
        this.emit(scanId, 'Comparing Google and website opening hours');
        await this.compareHours(scanId, initial.options);
      }

      if (initial.options.checkProfile) {
        this.db.updateScan(scanId, { status: 'comparing_profile' });
        this.emit(scanId, 'Cross-matching restaurant websites and Google Business Profiles');
        await this.compareProfiles(scanId, initial.options, controller.signal);
      }

      if (!this.db.isCancelled(scanId) && initial.options.inspectGoogle) {
        await this.inspectFindings(scanId);
      }

      this.db.updateScan(scanId, { status: 'reporting' });
      this.emit(scanId, 'Writing XLSX, CSV, and JSON reports');
      await mkdir(initial.outputDir, { recursive: true });
      const cancelled = this.db.isCancelled(scanId);
      const googleStates = this.db.googleDiscovery(scanId);
      if (cancelled) for (const state of googleStates) {
        if (state.status === 'waiting' || state.status === 'running') {
          state.status = 'cancelled';
          state.error = undefined;
          state.updatedAt = new Date().toISOString();
          this.db.saveGooglePage(scanId, state);
        }
      }
      const incomplete = googleStates.some((state) => state.status !== 'exhausted') || this.profiles(scanId).some(report => report.status !== 'completed');
      const failedDiscovery = googleStates.some((state) => state.status === 'failed');
      const noCandidates = this.db.getScan(scanId)!.total === 0;
      const status = cancelled ? 'cancelled' : failedDiscovery && noCandidates ? 'failed' : incomplete ? 'completed_partial' : 'completed';
      const finalState: StoredScan = {
        ...this.db.getScan(scanId)!,
        options: initial.options,
        status,
        error: status === 'failed' ? 'Google discovery failed; no URLs were verified. Resume after resolving the provider issue.' : null,
        completedAt: new Date().toISOString(),
      };
      await writeReports(this.db, scanId, finalState);
      this.db.updateScan(scanId, { status: finalState.status, completedAt: finalState.completedAt, error: finalState.error });
      this.emit(scanId, cancelled ? 'Cancelled; partial reports are ready' : status === 'failed' ? finalState.error! : incomplete ? 'Audit finished with incomplete source coverage. Review the report.' : noCandidates && !initial.options.checkProfile ? 'Google returned no matching URLs for the completed searches. This is not a clean-site verdict.' : 'Scan completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.appendWarning(scanId, message);
      const failedState: StoredScan = {
        ...this.db.getScan(scanId)!,
        status: 'failed',
        error: message,
        completedAt: new Date().toISOString(),
      };
      try {
        await mkdir(initial.outputDir, { recursive: true });
        await writeReports(this.db, scanId, failedState);
      } catch {
        // Retain the primary failure.
      }
      this.db.updateScan(scanId, { status: 'failed', error: message, completedAt: failedState.completedAt });
      this.emit(scanId, `Failed: ${message}`);
    } finally {
      this.discoveryControllers.delete(scanId);
      this.googleWaiters.delete(scanId);
    }
    // Read the final state before the browser shuts down: once the status says "completed",
    // callers may close the service, and a read after that await would hit a closed database.
    const final = this.db.getScan(scanId)!;
    await releaseBrowser();
    return final;
  }

  private async discover(scanId: string, options: ScanOptions): Promise<void> {
    const imported: ImportedRow[] = options.urls.map((url) => ({ url }));
    for (const filePath of options.inputFiles) {
      try {
        imported.push(...await importRowsFromFile(resolve(filePath)));
      } catch (error) {
        this.db.appendWarning(scanId, `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const seen = new Set<string>();
    const googleOnly = options.discovery.every((source) => ['google', 'serper', 'searchapi', 'google_browser'].includes(source));
    this.db.transaction(() => {
      for (const row of imported) {
        const normalized = tryNormalizeUrl(row.url);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        this.add(scanId, normalized, {
          source: 'import',
          restaurantName: row.name,
          restaurantAddress: row.address,
          placeId: row.placeId,
        });
      }
      for (const rawSite of googleOnly ? [] : options.sites) {
        const site = normalizeUrl(rawSite);
        this.add(scanId, site, { source: 'import' });
      }
    });

    const siteMap = new Map<string, string>();
    for (const value of [...options.sites, ...imported.map((row) => row.url)]) {
      const normalized = tryNormalizeUrl(value);
      if (normalized && !siteMap.has(siteKey(normalized))) siteMap.set(siteKey(normalized), siteOrigin(normalized));
    }

    for (const site of siteMap.values()) {
      if (this.db.isCancelled(scanId)) return;
      let gscSitemaps: string[] = [];
      if (options.discovery.includes('gsc')) {
        try {
          const result = await this.google.discover(site, options.gscDays);
          this.db.transaction(() => { for (const item of result.urls) this.addDiscovered(scanId, item); });
          gscSitemaps = result.sitemapUrls;
        } catch (error) {
          this.warnAdapter(scanId, 'gsc', site, error);
        }
      }
      if (options.discovery.includes('sitemap')) {
        try {
          const result = await discoverSitemaps(site, this.robots, gscSitemaps);
          this.db.transaction(() => { for (const item of result.urls) this.addDiscovered(scanId, item); });
          for (const warning of result.warnings) this.db.appendWarning(scanId, `sitemap ${warning}`);
        } catch (error) {
          this.warnAdapter(scanId, 'sitemap', site, error);
        }
      }
      if (options.discovery.some((source) => ['google', 'serper', 'searchapi', 'google_browser'].includes(source))) {
        await discoverGoogle(site, options, {
          db: this.db, scanId, signal: this.discoveryControllers.get(scanId)!.signal,
          progress: (message) => this.emit(scanId, message),
          warn: (message) => this.db.appendWarning(scanId, message),
          waitForUser: (message) => this.waitForGoogle(scanId, message),
        }, this.googleProviders);
      }
      if (options.discovery.includes('backlinks')) {
        try {
          this.emit(scanId, `Collecting backlink targets for ${siteKey(site)}`);
          const result = await discoverBacklinks(site, options.backlinkLimit ?? 100_000);
          this.db.transaction(() => {
            for (const backlink of result.backlinks) this.db.addBacklink(scanId, backlink);
            for (const item of result.candidates) this.add(scanId, item.url, item.evidence);
          });
          this.db.appendWarning(scanId, `${result.coverageNote} Provider cost: $${result.costUsd.toFixed(5)}.`);
        } catch (error) {
          this.warnAdapter(scanId, 'backlinks', site, error);
        }
      }
      if (options.discovery.includes('crawl')) {
        try {
          const result = await discoverCrawl(site, this.robots, {
            crawlLimit: options.crawlLimit,
            timeoutMs: options.timeoutMs,
            concurrency: options.concurrency,
            perHostConcurrency: options.perHostConcurrency,
            hostDelayMs: options.hostDelayMs,
          }, () => this.db.isCancelled(scanId));
          this.db.transaction(() => { for (const item of result.urls) this.addDiscovered(scanId, item); });
          for (const warning of result.warnings) this.db.appendWarning(scanId, `crawl ${warning}`);
        } catch (error) {
          this.warnAdapter(scanId, 'crawl', site, error);
        }
      }
      this.emit(scanId, `Discovered ${this.db.getScan(scanId)?.total ?? 0} unique URLs`);
    }
  }

  private async compareHours(scanId: string, options: ScanOptions): Promise<void> {
    const candidates = this.db.listCandidates(scanId);
    const sites = new Map<string, string>();
    for (const candidate of candidates) {
      try {
        const key = siteKey(candidate.site);
        if (!sites.has(key)) sites.set(key, siteOrigin(candidate.site));
      } catch {
        // A candidate whose site cannot be normalized has nothing to compare.
      }
    }
    if (!sites.size) return;
    // Fail fast rather than driving a browser over every site only to be rejected by Places.
    if (!process.env.GOOGLE_MAPS_API_KEY && !process.env.SERPER_API_KEY) {
      this.db.appendWarning(scanId, 'hours comparison: set SERPER_API_KEY (cheapest) or GOOGLE_MAPS_API_KEY to read Google opening hours');
      return;
    }

    const lookup = placeLookup({ serper: process.env.SERPER_API_KEY, maps: process.env.GOOGLE_MAPS_API_KEY }, {
      country: options.googleCountry,
      onFallback: (message) => this.db.appendWarning(scanId, `hours: ${message}`),
    });
    const inspector = new HoursInspector({
      perHostConcurrency: options.perHostConcurrency,
      hostDelayMs: options.hostDelayMs,
      timeoutMs: options.timeoutMs,
    });
    // Distinct sites are distinct hosts, so they can be audited together; per-host pacing
    // inside the inspector still governs how hard any one restaurant is hit.
    const pending = [...sites].filter(([key]) => !this.db.hasHours(scanId, key));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.db.isCancelled(scanId)) return;
        const entry = pending[next++];
        if (!entry) return;
        const [key, site] = entry;
        try {
          const record = await auditSiteHours({
            site,
            siteKey: key,
            pages: selectHoursPages(site, candidates, options.hoursPageLimit),
            hints: collectPlaceHints(candidates, key),
            toleranceMinutes: options.hoursToleranceMinutes,
            requireVerifiedPlace: options.hoursRequireVerifiedPlace,
          }, inspector, lookup);
          this.db.upsertHours(scanId, record);
          if (record.matchConfidence === 'unverified') {
            this.db.appendWarning(scanId, `hours ${key}: compared against an unverified Google listing`);
          }
          this.emit(scanId, `Hours ${key}: ${record.status}`);
        } catch (error) {
          this.warnAdapter(scanId, 'hours', site, error);
        }
      }
    };
    try {
      const workers = Math.max(1, Math.min(options.concurrency, pending.length));
      await Promise.all(Array.from({ length: workers }, worker));
    } finally {
      await inspector.close();
    }
  }

  private async compareProfiles(scanId: string, options: ScanOptions, signal: AbortSignal): Promise<void> {
    const raw: ProfileTarget[] = [...options.profileTargets];
    for (const url of [...options.sites, ...options.urls]) raw.push({ url });
    // Read original import rows; candidate URL deduplication must not collapse branches.
    for (const path of options.inputFiles) for (const row of await importRowsFromFile(resolve(path))) {
      raw.push({ url: row.url, name: row.name, address: row.address, placeId: row.placeId });
    }
    // Discovery accepts "www.example.com" without a scheme, so the profile step must too: the raw
    // text used to reach `new URL()` here and failed the whole audit with "Invalid URL".
    const targets: ProfileTarget[] = [];
    for (const target of raw) {
      const url = tryNormalizeUrl(target.url);
      if (!url) { this.db.appendWarning(scanId, `profile ${target.url}: not a website address, skipped`); continue; }
      const existing = targets.find(t => t.url === url);
      if (existing) { existing.name ??= target.name; existing.address ??= target.address; existing.placeId ??= target.placeId; existing.gbpLocation ??= target.gbpLocation; }
      else targets.push({ ...target, url });
    }
    const unique = new Map(targets.map(target => [targetKey(target), target]));
    const entry = { expires: Date.now() + 3600000, reports: new Map<string, ProfileReport>() };
    this.liveProfiles.set(scanId, entry);
    const candidates = this.db.listCandidateUrls(scanId);
    const stored = new Map(this.db.listProfiles(scanId).map(report => [report.targetKey, report]));
    const pending: Array<[string, ProfileTarget]> = [];
    for (const [key, target] of unique) {
      const old = stored.get(key);
      if (old?.retention === 'durable' && old.status === 'completed') entry.reports.set(key, old);
      else pending.push([key, target]);
    }
    // Each restaurant gets its own isolated browser, so a couple of branches can be audited at
    // once. An injected test browser is shared, and closing it mid-audit would break the other.
    const width = this.profileDependencies.browser ? 1 : Math.min(PROFILE_PARALLEL_TARGETS, pending.length);
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      for (let index = next++; index < pending.length; index = next++) {
        if (signal.aborted) return;
        const [key, target] = pending[index]!;
        // One restaurant's failure is recorded against that restaurant; it never fails the audit.
        let report: ProfileReport;
        try {
          report = await auditProfile(scanId, target, { mode: options.profileMode, pageLimit: options.profilePageLimit, timeoutMs: options.timeoutMs, hostDelayMs: options.hostDelayMs, country: options.googleCountry.toUpperCase(), tolerance: options.profileHoursTolerance, signal, waitForGoogle: (message) => this.waitForGoogle(scanId, message, 'comparing_profile') }, candidates, { gbp: this.gbp, imported: options.profileEvidence, ...this.profileDependencies });
        } catch (error) {
          this.warnAdapter(scanId, 'profile', target.url, error);
          continue;
        }
        entry.reports.set(key, report); entry.expires = Date.now() + 3600000;
        this.db.upsertProfile(scanId, report);
        this.emit(scanId, `Profile ${new URL(target.url).hostname}: ${report.summary.matches} matches, ${report.summary.mismatches} mismatches, ${report.summary.missing} missing, ${report.summary.unknown} unresolved`);
      }
    }));
  }

  private async waitForGoogle(scanId: string, message: string, resumeStatus: 'discovering' | 'comparing_profile' = 'discovering'): Promise<void> {
    await new Promise<void>((resolve) => {
      // Register before emitting; a fast Continue/Cancel cannot be lost.
      this.googleWaiters.set(scanId, resolve);
      this.db.updateScan(scanId, { status: 'waiting_for_google' });
      this.emit(scanId, message);
      if (this.db.isCancelled(scanId)) resolve();
    });
    this.googleWaiters.delete(scanId);
    if (!this.db.isCancelled(scanId)) this.db.updateScan(scanId, { status: resumeStatus });
  }

  private async inspectFindings(scanId: string): Promise<void> {
    const candidates = this.db.listActionableCandidates(scanId);
    for (const candidate of candidates) {
      if (this.db.isCancelled(scanId)) return;
      try {
        const result = candidate.result!;
        result.gsc = await this.google.inspect(result.normalizedUrl);
        this.db.updateResult(scanId, result);
      } catch (error) {
        this.db.appendWarning(scanId, `URL Inspection ${candidate.normalizedUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private add(scanId: string, value: string, evidence: DiscoveryEvidence): void {
    const normalizedUrl = normalizeUrl(value);
    const candidate: Candidate = {
      inputUrl: value,
      normalizedUrl,
      site: siteOrigin(normalizedUrl),
      sources: [evidence],
    };
    this.db.addCandidate(scanId, candidate);
  }

  private addDiscovered(scanId: string, item: DiscoveredUrl): void {
    this.add(scanId, item.url, item.evidence);
  }

  private warnAdapter(scanId: string, adapter: string, site: string, error: unknown): void {
    this.db.appendWarning(scanId, `${adapter} ${site}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private emit(scanId: string, message: string): void {
    const counts = this.db.progressCounts(scanId);
    if (!counts) return;
    this.events.emit(`scan:${scanId}`, { scanId, ...counts, message } satisfies ScanProgressEvent);
  }
}

/** Pulls operator-supplied place hints out of the discovery evidence for one site. */
function collectPlaceHints(candidates: readonly CandidateRecord[], key: string): PlaceHints {
  const hints: PlaceHints = {};
  for (const candidate of candidates) {
    let candidateKey: string;
    try {
      candidateKey = siteKey(candidate.site);
    } catch {
      continue;
    }
    if (candidateKey !== key) continue;
    for (const source of candidate.sources) {
      hints.name ??= source.restaurantName;
      hints.address ??= source.restaurantAddress;
      hints.placeId ??= source.placeId;
    }
  }
  return hints;
}

function makeScanId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
