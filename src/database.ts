import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CLASSIFICATIONS, HOURS_COMPARISON_STATUSES, type BacklinkRecord, type Candidate, type CandidateRecord, type Classification, type HoursComparisonRecord, type HoursComparisonStatus, type PlaceMatchConfidence, type ScanOptions, type ScanResult, type StoredScan } from './types.js';

interface ScanRow {
  id: string;
  status: StoredScan['status'];
  options_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  total: number;
  processed: number;
  findings: number;
  error: string | null;
  output_dir: string;
  cancel_requested: number;
  warnings_json: string;
}

interface CandidateRow {
  input_url: string;
  normalized_url: string;
  site: string;
  sources_json: string;
  status: CandidateRecord['status'];
  result_json: string | null;
}

interface BacklinkRow {
  site: string;
  target_url: string;
  source_url: string;
  source_domain: string;
  source_title: string | null;
  source_http_status: number | null;
  target_provider_status: number | null;
  anchor: string | null;
  dofollow: number | null;
  link_type: string | null;
  is_new: number;
  is_lost: number;
  is_broken_provider: number | null;
  rank: number | null;
  domain_rank: number | null;
  spam_score: number | null;
  first_seen: string | null;
  last_seen: string | null;
  links_count: number;
  provider: 'dataforseo';
}

interface HoursRow {
  site: string;
  site_key: string;
  status: HoursComparisonStatus;
  match_confidence: PlaceMatchConfidence;
  place_id: string | null;
  result_json: string;
  checked_at: string;
}

export class ScanDatabase {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        findings INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        output_dir TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS candidates (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        input_url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        site TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_json TEXT,
        PRIMARY KEY (scan_id, normalized_url)
      );
      CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates(scan_id, status);
      CREATE TABLE IF NOT EXISTS backlinks (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        site TEXT NOT NULL,
        target_url TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_domain TEXT NOT NULL,
        source_title TEXT,
        source_http_status INTEGER,
        target_provider_status INTEGER,
        anchor TEXT,
        anchor_key TEXT NOT NULL,
        dofollow INTEGER,
        link_type TEXT,
        is_new INTEGER NOT NULL DEFAULT 0,
        is_lost INTEGER NOT NULL DEFAULT 0,
        is_broken_provider INTEGER,
        rank REAL,
        domain_rank REAL,
        spam_score REAL,
        first_seen TEXT,
        last_seen TEXT,
        links_count INTEGER NOT NULL DEFAULT 1,
        provider TEXT NOT NULL,
        PRIMARY KEY (scan_id, target_url, source_url, anchor_key)
      );
      CREATE INDEX IF NOT EXISTS backlinks_target_idx ON backlinks(scan_id, target_url);
      CREATE TABLE IF NOT EXISTS restaurant_hours (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        site_key TEXT NOT NULL,
        site TEXT NOT NULL,
        status TEXT NOT NULL,
        match_confidence TEXT NOT NULL,
        place_id TEXT,
        result_json TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY (scan_id, site_key)
      );
      CREATE INDEX IF NOT EXISTS restaurant_hours_status_idx ON restaurant_hours(scan_id, status);
    `);
  }

  appendWarning(id: string, warning: string): void {
    const scan = this.getScan(id);
    if (!scan || scan.warnings.includes(warning)) return;
    this.db.prepare('UPDATE scans SET warnings_json = ? WHERE id = ?')
      .run(JSON.stringify([...scan.warnings, warning]), id);
  }

  createScan(id: string, options: ScanOptions, outputDir: string): StoredScan {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO scans
      (id, status, options_json, created_at, output_dir)
      VALUES (?, 'queued', ?, ?, ?)`)
      .run(id, JSON.stringify(options), now, outputDir);
    return this.getScan(id)!;
  }

  getScan(id: string): StoredScan | null {
    const row = this.db.prepare('SELECT * FROM scans WHERE id = ?').get(id) as unknown as ScanRow | undefined;
    return row ? mapScan(row) : null;
  }

  listScans(limit = 50): StoredScan[] {
    const rows = this.db.prepare('SELECT * FROM scans ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ScanRow[];
    return rows.map(mapScan);
  }

  updateScan(id: string, values: Partial<Pick<StoredScan, 'status' | 'startedAt' | 'completedAt' | 'error' | 'total' | 'processed' | 'findings' | 'cancelRequested'>>): void {
    const columns: string[] = [];
    const params: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      status: 'status', startedAt: 'started_at', completedAt: 'completed_at', error: 'error',
      total: 'total', processed: 'processed', findings: 'findings', cancelRequested: 'cancel_requested',
    };
    for (const [key, value] of Object.entries(values)) {
      columns.push(`${mapping[key]} = ?`);
      params.push(typeof value === 'boolean' ? Number(value) : (value as string | number | null));
    }
    if (!columns.length) return;
    this.db.prepare(`UPDATE scans SET ${columns.join(', ')} WHERE id = ?`).run(...params, id);
  }

  addCandidate(scanId: string, candidate: Candidate): void {
    const existing = this.db.prepare(
      'SELECT sources_json, input_url FROM candidates WHERE scan_id = ? AND normalized_url = ?',
    ).get(scanId, candidate.normalizedUrl) as { sources_json: string; input_url: string } | undefined;
    if (existing) {
      const sources = mergeSources(JSON.parse(existing.sources_json), candidate.sources);
      this.db.prepare('UPDATE candidates SET sources_json = ? WHERE scan_id = ? AND normalized_url = ?')
        .run(JSON.stringify(sources), scanId, candidate.normalizedUrl);
    } else {
      this.db.prepare(`INSERT INTO candidates
        (scan_id, input_url, normalized_url, site, sources_json) VALUES (?, ?, ?, ?, ?)`)
        .run(scanId, candidate.inputUrl, candidate.normalizedUrl, candidate.site, JSON.stringify(candidate.sources));
    }
    const total = this.db.prepare('SELECT COUNT(*) AS count FROM candidates WHERE scan_id = ?').get(scanId) as { count: number };
    this.updateScan(scanId, { total: total.count });
  }

  listCandidates(scanId: string, status?: CandidateRecord['status']): CandidateRecord[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM candidates WHERE scan_id = ? AND status = ? ORDER BY normalized_url').all(scanId, status)
      : this.db.prepare('SELECT * FROM candidates WHERE scan_id = ? ORDER BY normalized_url').all(scanId)) as unknown as CandidateRow[];
    return rows.map(mapCandidate);
  }

  addBacklink(scanId: string, backlink: BacklinkRecord): void {
    this.db.prepare(`INSERT OR IGNORE INTO backlinks (
      scan_id, site, target_url, source_url, source_domain, source_title, source_http_status,
      target_provider_status, anchor, anchor_key, dofollow, link_type, is_new, is_lost,
      is_broken_provider, rank, domain_rank, spam_score, first_seen, last_seen, links_count, provider
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      scanId, backlink.site, backlink.targetUrl, backlink.sourceUrl, backlink.sourceDomain,
      backlink.sourceTitle, backlink.sourceHttpStatus, backlink.targetProviderStatus, backlink.anchor,
      backlink.anchor ?? '', nullableBoolean(backlink.dofollow), backlink.linkType, Number(backlink.isNew),
      Number(backlink.isLost), nullableBoolean(backlink.isBrokenByProvider), backlink.rank,
      backlink.domainRank, backlink.spamScore, backlink.firstSeen, backlink.lastSeen,
      backlink.linksCount, backlink.provider,
    );
  }

  listBacklinks(scanId: string): BacklinkRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM backlinks WHERE scan_id = ? ORDER BY target_url, source_url, anchor_key',
    ).all(scanId) as unknown as BacklinkRow[];
    return rows.map(mapBacklink);
  }

  backlinkCount(scanId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM backlinks WHERE scan_id = ?').get(scanId) as { count: number };
    return row.count;
  }

  upsertHours(scanId: string, record: HoursComparisonRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO restaurant_hours (
      scan_id, site_key, site, status, match_confidence, place_id, result_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      scanId, record.siteKey, record.site, record.status, record.matchConfidence,
      record.placeId, JSON.stringify(record), record.checkedAt,
    );
  }

  listHours(scanId: string): HoursComparisonRecord[] {
    const rows = this.db.prepare('SELECT * FROM restaurant_hours WHERE scan_id = ? ORDER BY site_key')
      .all(scanId) as unknown as HoursRow[];
    return rows.map((row) => JSON.parse(row.result_json) as HoursComparisonRecord);
  }

  hasHours(scanId: string, key: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM restaurant_hours WHERE scan_id = ? AND site_key = ?')
      .get(scanId, key) as { present: number } | undefined;
    return Boolean(row);
  }

  hoursCount(scanId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ?').get(scanId) as { count: number };
    return row.count;
  }

  hoursMismatchCount(scanId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ? AND status = 'mismatch'")
      .get(scanId) as { count: number };
    return row.count;
  }

  hoursStatusCounts(scanId: string): Partial<Record<HoursComparisonStatus, number>> {
    const counts: Partial<Record<HoursComparisonStatus, number>> = {};
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ? GROUP BY status')
      .all(scanId) as unknown as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if (HOURS_COMPARISON_STATUSES.includes(row.status as HoursComparisonStatus)) {
        counts[row.status as HoursComparisonStatus] = row.count;
      }
    }
    return counts;
  }

  markCandidateRunning(scanId: string, url: string): void {
    this.db.prepare("UPDATE candidates SET status = 'running' WHERE scan_id = ? AND normalized_url = ?").run(scanId, url);
  }

  saveResult(scanId: string, result: ScanResult): void {
    this.db.prepare("UPDATE candidates SET status = 'complete', result_json = ? WHERE scan_id = ? AND normalized_url = ?")
      .run(JSON.stringify(result), scanId, result.normalizedUrl);
    this.reconcileCounts(scanId);
  }

  updateResult(scanId: string, result: ScanResult): void {
    this.db.prepare('UPDATE candidates SET result_json = ? WHERE scan_id = ? AND normalized_url = ?')
      .run(JSON.stringify(result), scanId, result.normalizedUrl);
  }

  requestCancel(scanId: string): void {
    this.updateScan(scanId, { cancelRequested: true });
  }

  resetForResume(scanId: string): void {
    // restaurant_hours rows are deliberately kept: a resume must never re-bill the Places API.
    this.db.prepare("UPDATE candidates SET status = 'pending' WHERE scan_id = ? AND status = 'running'").run(scanId);
    this.updateScan(scanId, { status: 'queued', cancelRequested: false, error: null, completedAt: null });
    this.reconcileCounts(scanId);
  }

  classificationCounts(scanId: string): Record<Classification, number> {
    const counts = Object.fromEntries(CLASSIFICATIONS.map((value) => [value, 0])) as Record<Classification, number>;
    for (const candidate of this.listCandidates(scanId)) {
      if (candidate.result) counts[candidate.result.classification] += 1;
    }
    return counts;
  }

  close(): void {
    this.db.close();
  }

  private reconcileCounts(scanId: string): void {
    const candidates = this.listCandidates(scanId);
    const processed = candidates.filter((candidate) => candidate.status === 'complete').length;
    const findings = candidates.filter((candidate) => candidate.result && isActionable(candidate.result.classification)).length;
    this.updateScan(scanId, { total: candidates.length, processed, findings });
  }
}

function mapScan(row: ScanRow): StoredScan {
  return {
    id: row.id,
    status: row.status,
    options: JSON.parse(row.options_json) as ScanOptions,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    total: row.total,
    processed: row.processed,
    findings: row.findings,
    error: row.error,
    outputDir: row.output_dir,
    cancelRequested: Boolean(row.cancel_requested),
    warnings: JSON.parse(row.warnings_json || '[]'),
  };
}

function mapCandidate(row: CandidateRow): CandidateRecord {
  return {
    inputUrl: row.input_url,
    normalizedUrl: row.normalized_url,
    site: row.site,
    sources: JSON.parse(row.sources_json),
    status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

function mapBacklink(row: BacklinkRow): BacklinkRecord {
  return {
    site: row.site,
    targetUrl: row.target_url,
    sourceUrl: row.source_url,
    sourceDomain: row.source_domain,
    sourceTitle: row.source_title,
    sourceHttpStatus: row.source_http_status,
    targetProviderStatus: row.target_provider_status,
    anchor: row.anchor,
    dofollow: row.dofollow === null ? null : Boolean(row.dofollow),
    linkType: row.link_type,
    isNew: Boolean(row.is_new),
    isLost: Boolean(row.is_lost),
    isBrokenByProvider: row.is_broken_provider === null ? null : Boolean(row.is_broken_provider),
    rank: row.rank,
    domainRank: row.domain_rank,
    spamScore: row.spam_score,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    linksCount: row.links_count,
    provider: row.provider,
  };
}

function nullableBoolean(value: boolean | null): number | null {
  return value === null ? null : Number(value);
}

function mergeSources(left: Candidate['sources'], right: Candidate['sources']): Candidate['sources'] {
  const merged = new Map<string, Candidate['sources'][number]>();
  for (const source of [...left, ...right]) merged.set(JSON.stringify(source), source);
  return [...merged.values()];
}

export function isActionable(classification: Classification): boolean {
  return classification === 'hard_404' || classification === 'gone_410' || classification === 'soft_404_suspected';
}
