import { EventEmitter } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { appDataDir, defaultOutputDir, mergeScanOptions } from './config.js';
import { ScanDatabase, isActionable } from './database.js';
import { discoverCrawl } from './discovery/crawl.js';
import { discoverBacklinks } from './discovery/backlinks.js';
import { discoverSearchApi } from './discovery/searchapi.js';
import { discoverSitemaps, type DiscoveredUrl } from './discovery/sitemap.js';
import { GoogleSearchConsole } from './google.js';
import { importUrlsFromFile } from './imports.js';
import { RobotsCache } from './robots.js';
import { BrowserScanner } from './scanner.js';
import type { Candidate, CandidateRecord, DiscoveryEvidence, ScanOptions, ScanProgressEvent, ScanSummary, StoredScan } from './types.js';
import { normalizeUrl, siteKey, siteOrigin, tryNormalizeUrl, uniqueUrls } from './urls.js';
import { writeReports } from './reports.js';

export class ScanService {
  readonly db: ScanDatabase;
  readonly google: GoogleSearchConsole;
  readonly robots = new RobotsCache();
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, Promise<StoredScan>>();

  constructor(databasePath = join(appDataDir(), 'seo404.sqlite')) {
    this.db = new ScanDatabase(databasePath);
    this.google = new GoogleSearchConsole();
  }

  createScan(input: Partial<ScanOptions>): StoredScan {
    const options = mergeScanOptions(input);
    if (!options.sites.length && !options.urls.length && !options.inputFiles.length) {
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
    if (scan.status === 'completed') return scan;
    this.db.resetForResume(scanId);
    return this.start(scanId);
  }

  cancel(scanId: string): void {
    if (!this.db.getScan(scanId)) throw new Error(`Unknown scan: ${scanId}`);
    this.db.requestCancel(scanId);
    this.emit(scanId, 'Cancellation requested');
  }

  getScan(scanId: string): StoredScan | null {
    return this.db.getScan(scanId);
  }

  listScans(): StoredScan[] {
    return this.db.listScans();
  }

  results(scanId: string, offset = 0, limit = 200, classification?: string): { total: number; items: CandidateRecord[] } {
    if (!this.db.getScan(scanId)) throw new Error(`Unknown scan: ${scanId}`);
    const completed = this.db.listCandidates(scanId)
      .filter((candidate) => candidate.result && (!classification || classification === 'all' || candidate.result.classification === classification));
    return { total: completed.length, items: completed.slice(offset, offset + limit) };
  }

  close(): void {
    this.db.close();
  }

  async summary(scanId: string): Promise<ScanSummary> {
    const scan = this.db.getScan(scanId);
    if (!scan) throw new Error(`Unknown scan: ${scanId}`);
    const sourceCounts: ScanSummary['sourceCounts'] = {};
    for (const candidate of this.db.listCandidates(scanId)) {
      for (const source of new Set(candidate.sources.map((value) => value.source))) {
        sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
      }
    }
    let artifacts: string[] = [];
    try {
      artifacts = await readdir(scan.outputDir);
    } catch {
      // Reports do not exist yet.
    }
    return { scan, counts: this.db.classificationCounts(scanId), sourceCounts, backlinkCount: this.db.backlinkCount(scanId), artifacts };
  }

  onProgress(scanId: string, listener: (event: ScanProgressEvent) => void): () => void {
    const name = `scan:${scanId}`;
    this.events.on(name, listener);
    return () => this.events.off(name, listener);
  }

  private async run(scanId: string): Promise<StoredScan> {
    const initial = this.db.getScan(scanId);
    if (!initial) throw new Error(`Unknown scan: ${scanId}`);
    try {
      this.db.updateScan(scanId, { status: 'discovering', startedAt: initial.startedAt ?? new Date().toISOString(), error: null });
      this.emit(scanId, 'Collecting candidate URLs');
      await this.discover(scanId, initial.options);

      if (!this.db.getScan(scanId)?.cancelRequested) {
        this.db.updateScan(scanId, { status: 'scanning' });
        this.emit(scanId, 'Checking live pages with Chromium');
        const scanner = new BrowserScanner(this.db, this.robots, initial.options, (event) => this.events.emit(`scan:${scanId}`, event));
        await scanner.scan(scanId, this.db.listCandidates(scanId, 'pending'));
      }

      if (!this.db.getScan(scanId)?.cancelRequested && initial.options.inspectGoogle) {
        await this.inspectFindings(scanId);
      }

      this.db.updateScan(scanId, { status: 'reporting' });
      this.emit(scanId, 'Writing XLSX, CSV, and JSON reports');
      await mkdir(initial.outputDir, { recursive: true });
      const cancelled = Boolean(this.db.getScan(scanId)?.cancelRequested);
      const finalState: StoredScan = {
        ...this.db.getScan(scanId)!,
        status: cancelled ? 'cancelled' : 'completed',
        completedAt: new Date().toISOString(),
      };
      await writeReports(this.db, scanId, finalState);
      this.db.updateScan(scanId, { status: finalState.status, completedAt: finalState.completedAt });
      this.emit(scanId, cancelled ? 'Cancelled; partial reports are ready' : 'Scan completed');
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
    }
    return this.db.getScan(scanId)!;
  }

  private async discover(scanId: string, options: ScanOptions): Promise<void> {
    const imported: string[] = [...options.urls];
    for (const filePath of options.inputFiles) {
      try {
        imported.push(...await importUrlsFromFile(resolve(filePath)));
      } catch (error) {
        this.db.appendWarning(scanId, `${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const url of uniqueUrls(imported)) this.add(scanId, url, { source: 'import' });
    for (const rawSite of options.sites) {
      const site = normalizeUrl(rawSite);
      this.add(scanId, site, { source: 'import' });
    }

    const siteMap = new Map<string, string>();
    for (const value of [...options.sites, ...imported]) {
      const normalized = tryNormalizeUrl(value);
      if (normalized && !siteMap.has(siteKey(normalized))) siteMap.set(siteKey(normalized), siteOrigin(normalized));
    }

    for (const site of siteMap.values()) {
      if (this.db.getScan(scanId)?.cancelRequested) return;
      let gscSitemaps: string[] = [];
      if (options.discovery.includes('gsc')) {
        try {
          const result = await this.google.discover(site, options.gscDays);
          for (const item of result.urls) this.addDiscovered(scanId, item);
          gscSitemaps = result.sitemapUrls;
        } catch (error) {
          this.warnAdapter(scanId, 'gsc', site, error);
        }
      }
      if (options.discovery.includes('sitemap')) {
        try {
          const result = await discoverSitemaps(site, this.robots, gscSitemaps);
          for (const item of result.urls) this.addDiscovered(scanId, item);
          for (const warning of result.warnings) this.db.appendWarning(scanId, `sitemap ${warning}`);
        } catch (error) {
          this.warnAdapter(scanId, 'sitemap', site, error);
        }
      }
      if (options.discovery.includes('searchapi')) {
        try {
          const result = await discoverSearchApi(site);
          for (const item of result.urls) this.addDiscovered(scanId, item);
          this.db.appendWarning(scanId, result.coverageNote);
        } catch (error) {
          this.warnAdapter(scanId, 'searchapi', site, error);
        }
      }
      if (options.discovery.includes('backlinks')) {
        try {
          this.emit(scanId, `Collecting backlink targets for ${siteKey(site)}`);
          const result = await discoverBacklinks(site, options.backlinkLimit ?? 100_000);
          for (const backlink of result.backlinks) this.db.addBacklink(scanId, backlink);
          for (const item of result.candidates) this.add(scanId, item.url, item.evidence);
          this.db.appendWarning(scanId, `${result.coverageNote} Provider cost: $${result.costUsd.toFixed(5)}.`);
        } catch (error) {
          this.warnAdapter(scanId, 'backlinks', site, error);
        }
      }
      if (options.discovery.includes('crawl')) {
        try {
          const result = await discoverCrawl(site, this.robots, options.crawlLimit, options.timeoutMs, () => Boolean(this.db.getScan(scanId)?.cancelRequested));
          for (const item of result.urls) this.addDiscovered(scanId, item);
          for (const warning of result.warnings) this.db.appendWarning(scanId, `crawl ${warning}`);
        } catch (error) {
          this.warnAdapter(scanId, 'crawl', site, error);
        }
      }
      this.emit(scanId, `Discovered ${this.db.getScan(scanId)?.total ?? 0} unique URLs`);
    }
  }

  private async inspectFindings(scanId: string): Promise<void> {
    const candidates = this.db.listCandidates(scanId).filter((candidate) => candidate.result && isActionable(candidate.result.classification));
    for (const candidate of candidates) {
      if (this.db.getScan(scanId)?.cancelRequested) return;
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
    const scan = this.db.getScan(scanId);
    if (!scan) return;
    this.events.emit(`scan:${scanId}`, {
      scanId,
      status: scan.status,
      total: scan.total,
      processed: scan.processed,
      findings: scan.findings,
      backlinkCount: this.db.backlinkCount(scanId),
      message,
    } satisfies ScanProgressEvent);
  }
}

function makeScanId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
