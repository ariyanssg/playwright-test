import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GoogleDiscoveryState } from './types.js';
import type { ProfileReport } from './profile/model.js';
import { durableReport } from './profile/audit.js';
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

/** Classifications that count as findings; kept as SQL text so counting never leaves SQLite. */
const ACTIONABLE_SQL = "('hard_404', 'gone_410', 'soft_404_suspected')";
const MAX_WARNINGS = 500;
/** Triage order for the dashboard: definitive breaks, then suspicions, then failures to check. */
const SEVERITY_ORDER_SQL = `CASE json_extract(result_json, '$.classification')
  WHEN 'hard_404' THEN 0 WHEN 'gone_410' THEN 1 WHEN 'soft_404_suspected' THEN 2 WHEN 'server_error' THEN 3
  WHEN 'timeout' THEN 4 WHEN 'network_error' THEN 5 WHEN 'blocked' THEN 6 WHEN 'redirected' THEN 7 ELSE 8 END`;

export class ScanDatabase {
  readonly db: DatabaseSync;
  /** Compiling a statement costs more than running it on the scanner's hot path. */
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private transactionDepth = 0;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // NORMAL is durable under WAL for everything but a host crash, and removes an fsync per write.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY;');
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
      CREATE INDEX IF NOT EXISTS candidates_classification_idx
        ON candidates(scan_id, json_extract(result_json, '$.classification'));
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
      CREATE TABLE IF NOT EXISTS google_discovery (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        site TEXT NOT NULL,
        state_json TEXT NOT NULL,
        PRIMARY KEY (scan_id, site)
      );
      CREATE TABLE IF NOT EXISTS restaurant_profiles (
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        target_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (scan_id, target_key)
      );
    `);
  }

  /**
   * Appends a de-duplicated warning without reading or rewriting the whole list in JS: a
   * crawl can raise one warning per failed page, which used to be quadratic.
   */
  appendWarning(id: string, warning: string): void {
    const appended = this.stmt(`UPDATE scans SET warnings_json = json_insert(warnings_json, '$[#]', ?)
      WHERE id = ?
        AND json_array_length(warnings_json) < ${MAX_WARNINGS}
        AND NOT EXISTS (SELECT 1 FROM json_each(warnings_json) WHERE value = ?)`).run(warning, id, warning);
    if (appended.changes) return;
    this.stmt(`UPDATE scans SET warnings_json = json_insert(warnings_json, '$[#]', ?)
      WHERE id = ? AND json_array_length(warnings_json) = ${MAX_WARNINGS}`)
      .run(`Further warnings were suppressed after the first ${MAX_WARNINGS}.`, id);
  }

  upsertProfile(scanId: string, report: ProfileReport): void {
    this.stmt('INSERT OR REPLACE INTO restaurant_profiles(scan_id, target_key, result_json) VALUES (?, ?, ?)').run(scanId, report.targetKey, JSON.stringify(durableReport(report)));
  }

  listProfiles(scanId: string): ProfileReport[] {
    return (this.stmt('SELECT result_json FROM restaurant_profiles WHERE scan_id = ? ORDER BY target_key').all(scanId) as Array<{result_json:string}>).map(row => JSON.parse(row.result_json) as ProfileReport);
  }

  createScan(id: string, options: ScanOptions, outputDir: string): StoredScan {
    const now = new Date().toISOString();
    this.stmt(`INSERT INTO scans
      (id, status, options_json, created_at, output_dir)
      VALUES (?, 'queued', ?, ?, ?)`)
      .run(id, JSON.stringify(options), now, outputDir);
    return this.getScan(id)!;
  }

  getScan(id: string): StoredScan | null {
    const row = this.stmt('SELECT * FROM scans WHERE id = ?').get(id) as unknown as ScanRow | undefined;
    return row ? mapScan(row) : null;
  }

  listScans(limit = -1): StoredScan[] {
    const rows = this.stmt('SELECT * FROM scans ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as ScanRow[];
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
    this.stmt(`UPDATE scans SET ${columns.join(', ')} WHERE id = ?`).run(...params, id);
  }

  addCandidate(scanId: string, candidate: Candidate): void {
    const sources = JSON.stringify(candidate.sources);
    const inserted = this.stmt(`INSERT OR IGNORE INTO candidates
      (scan_id, input_url, normalized_url, site, sources_json) VALUES (?, ?, ?, ?, ?)`)
      .run(scanId, candidate.inputUrl, candidate.normalizedUrl, candidate.site, sources);
    // Counting rows on every insert made discovery quadratic; the total moves by one instead.
    if (inserted.changes) {
      this.stmt('UPDATE scans SET total = total + 1 WHERE id = ?').run(scanId);
      return;
    }
    const existing = this.stmt('SELECT sources_json FROM candidates WHERE scan_id = ? AND normalized_url = ?')
      .get(scanId, candidate.normalizedUrl) as { sources_json: string } | undefined;
    if (!existing) return;
    const merged = JSON.stringify(mergeSources(JSON.parse(existing.sources_json), candidate.sources));
    // Repeat sightings from the same source are the common case and need no write at all.
    if (merged === existing.sources_json) return;
    this.stmt('UPDATE candidates SET sources_json = ? WHERE scan_id = ? AND normalized_url = ?')
      .run(merged, scanId, candidate.normalizedUrl);
    this.stmt("UPDATE candidates SET result_json = json_set(result_json, '$.sources', json(?)) WHERE scan_id = ? AND normalized_url = ? AND result_json IS NOT NULL")
      .run(merged, scanId, candidate.normalizedUrl);
  }

  /** Adds many candidates under one transaction, which is one disk flush instead of thousands. */
  addCandidates(scanId: string, candidates: readonly Candidate[]): void {
    if (!candidates.length) return;
    this.transaction(() => {
      for (const candidate of candidates) this.addCandidate(scanId, candidate);
    });
  }

  /** Runs `work` in a transaction, joining an outer one rather than nesting a second BEGIN. */
  transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  listCandidates(scanId: string, status?: CandidateRecord['status']): CandidateRecord[] {
    const rows = (status
      ? this.stmt('SELECT * FROM candidates WHERE scan_id = ? AND status = ? ORDER BY normalized_url').all(scanId, status)
      : this.stmt('SELECT * FROM candidates WHERE scan_id = ? ORDER BY normalized_url').all(scanId)) as unknown as CandidateRow[];
    return rows.map(mapCandidate);
  }

  googleDiscovery(scanId: string): GoogleDiscoveryState[] {
    return (this.stmt('SELECT state_json FROM google_discovery WHERE scan_id = ? ORDER BY site').all(scanId) as Array<{ state_json: string }>)
      .map((row) => JSON.parse(row.state_json) as GoogleDiscoveryState);
  }

  saveGooglePage(scanId: string, state: GoogleDiscoveryState, candidates: Candidate[] = []): void {
    // A crash cannot advance a search cursor without retaining the URLs it found.
    this.transaction(() => {
      for (const candidate of candidates) this.addCandidate(scanId, candidate);
      this.stmt('INSERT INTO google_discovery (scan_id, site, state_json) VALUES (?, ?, ?) ON CONFLICT(scan_id, site) DO UPDATE SET state_json = excluded.state_json')
        .run(scanId, state.site, JSON.stringify(state));
    });
  }

  /** Filter before pagination; materialize only the visible evidence records. */
  queryResults(scanId: string, offset: number, limit: number, classification?: string, search = ''): { total: number; items: CandidateRecord[] } {
    const clauses = ['scan_id = ?', 'result_json IS NOT NULL'];
    const params: Array<string | number> = [scanId];
    if (classification && classification !== 'all') {
      clauses.push("json_extract(result_json, '$.classification') = ?");
      params.push(classification);
    }
    if (search.trim()) {
      clauses.push("(instr(lower(normalized_url), ?) > 0 OR instr(lower(json_extract(result_json, '$.title')), ?) > 0 OR instr(lower(json_extract(result_json, '$.reasons')), ?) > 0)");
      const term = search.trim().toLowerCase();
      params.push(term, term, term);
    }
    const where = clauses.join(' AND ');
    const count = this.stmt(`SELECT COUNT(*) AS total FROM candidates WHERE ${where}`).get(...params) as { total: number };
    // Worst first: whoever opens an audit is looking for what is broken, not for page 1 of "OK".
    const rows = this.stmt(`SELECT * FROM candidates WHERE ${where} ORDER BY ${SEVERITY_ORDER_SQL}, normalized_url LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as CandidateRow[];
    return { total: count.total, items: rows.map(mapCandidate) };
  }

  addBacklink(scanId: string, backlink: BacklinkRecord): void {
    this.stmt(`INSERT OR IGNORE INTO backlinks (
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
    const rows = this.stmt(
      'SELECT * FROM backlinks WHERE scan_id = ? ORDER BY target_url, source_url, anchor_key',
    ).all(scanId) as unknown as BacklinkRow[];
    return rows.map(mapBacklink);
  }

  backlinkCount(scanId: string): number {
    const row = this.stmt('SELECT COUNT(*) AS count FROM backlinks WHERE scan_id = ?').get(scanId) as { count: number };
    return row.count;
  }

  upsertHours(scanId: string, record: HoursComparisonRecord): void {
    this.stmt(`INSERT OR REPLACE INTO restaurant_hours (
      scan_id, site_key, site, status, match_confidence, place_id, result_json, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      scanId, record.siteKey, record.site, record.status, record.matchConfidence,
      record.placeId, JSON.stringify(record), record.checkedAt,
    );
  }

  listHours(scanId: string): HoursComparisonRecord[] {
    const rows = this.stmt('SELECT * FROM restaurant_hours WHERE scan_id = ? ORDER BY site_key')
      .all(scanId) as unknown as HoursRow[];
    return rows.map((row) => JSON.parse(row.result_json) as HoursComparisonRecord);
  }

  hasHours(scanId: string, key: string): boolean {
    const row = this.stmt('SELECT 1 AS present FROM restaurant_hours WHERE scan_id = ? AND site_key = ?')
      .get(scanId, key) as { present: number } | undefined;
    return Boolean(row);
  }

  hoursCount(scanId: string): number {
    const row = this.stmt('SELECT COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ?').get(scanId) as { count: number };
    return row.count;
  }

  hoursMismatchCount(scanId: string): number {
    const row = this.stmt("SELECT COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ? AND status = 'mismatch'")
      .get(scanId) as { count: number };
    return row.count;
  }

  hoursStatusCounts(scanId: string): Partial<Record<HoursComparisonStatus, number>> {
    const counts: Partial<Record<HoursComparisonStatus, number>> = {};
    const rows = this.stmt('SELECT status, COUNT(*) AS count FROM restaurant_hours WHERE scan_id = ? GROUP BY status')
      .all(scanId) as unknown as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if (HOURS_COMPARISON_STATUSES.includes(row.status as HoursComparisonStatus)) {
        counts[row.status as HoursComparisonStatus] = row.count;
      }
    }
    return counts;
  }

  markCandidateRunning(scanId: string, url: string): void {
    this.stmt("UPDATE candidates SET status = 'running' WHERE scan_id = ? AND normalized_url = ?").run(scanId, url);
  }

  /**
   * Stores one verdict and moves the scan counters by the delta it caused. Recounting the whole
   * table per URL made a scan quadratic, and node:sqlite is synchronous, so that time stalled
   * every browser worker as well.
   */
  saveResult(scanId: string, result: ScanResult): void {
    const previous = this.stmt(`SELECT status, json_extract(result_json, '$.classification') AS classification
      FROM candidates WHERE scan_id = ? AND normalized_url = ?`)
      .get(scanId, result.normalizedUrl) as { status: CandidateRecord['status']; classification: Classification | null } | undefined;
    if (!previous) return;
    this.stmt("UPDATE candidates SET status = 'complete', result_json = ? WHERE scan_id = ? AND normalized_url = ?")
      .run(JSON.stringify(result), scanId, result.normalizedUrl);
    const processed = previous.status === 'complete' ? 0 : 1;
    const wasActionable = previous.classification ? isActionable(previous.classification) : false;
    const findings = Number(isActionable(result.classification)) - Number(wasActionable);
    if (processed || findings) {
      this.stmt('UPDATE scans SET processed = processed + ?, findings = findings + ? WHERE id = ?')
        .run(processed, findings, scanId);
    }
  }

  updateResult(scanId: string, result: ScanResult): void {
    this.stmt('UPDATE candidates SET result_json = ? WHERE scan_id = ? AND normalized_url = ?')
      .run(JSON.stringify(result), scanId, result.normalizedUrl);
  }

  requestCancel(scanId: string): void {
    this.updateScan(scanId, { cancelRequested: true });
  }

  resetForResume(scanId: string): void {
    // restaurant_hours rows are deliberately kept: a resume must never re-bill the Places API.
    this.stmt("UPDATE candidates SET status = 'pending' WHERE scan_id = ? AND status = 'running'").run(scanId);
    this.updateScan(scanId, { status: 'queued', cancelRequested: false, error: null, completedAt: null });
    this.reconcileCounts(scanId);
  }

  classificationCounts(scanId: string): Record<Classification, number> {
    const counts = Object.fromEntries(CLASSIFICATIONS.map((value) => [value, 0])) as Record<Classification, number>;
    const rows = this.stmt(`SELECT json_extract(result_json, '$.classification') AS classification, COUNT(*) AS count
      FROM candidates WHERE scan_id = ? AND result_json IS NOT NULL GROUP BY classification`)
      .all(scanId) as unknown as Array<{ classification: Classification | null; count: number }>;
    for (const row of rows) {
      if (row.classification && row.classification in counts) counts[row.classification] = row.count;
    }
    return counts;
  }

  /** Per-source candidate counts, aggregated in SQLite instead of parsing every stored result. */
  sourceCounts(scanId: string): Record<string, number> {
    const rows = this.stmt(`SELECT json_extract(source.value, '$.source') AS source, COUNT(DISTINCT candidates.normalized_url) AS count
      FROM candidates, json_each(candidates.sources_json) AS source
      WHERE candidates.scan_id = ? GROUP BY source`)
      .all(scanId) as unknown as Array<{ source: string | null; count: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) if (row.source) counts[row.source] = row.count;
    return counts;
  }

  /** Candidates whose verdict is worth acting on, filtered in SQL rather than in memory. */
  listActionableCandidates(scanId: string): CandidateRecord[] {
    const rows = this.stmt(`SELECT * FROM candidates
      WHERE scan_id = ? AND json_extract(result_json, '$.classification') IN ${ACTIONABLE_SQL}
      ORDER BY normalized_url`).all(scanId) as unknown as CandidateRow[];
    return rows.map(mapCandidate);
  }

  listCandidateUrls(scanId: string): string[] {
    return (this.stmt('SELECT normalized_url FROM candidates WHERE scan_id = ? ORDER BY normalized_url')
      .all(scanId) as unknown as Array<{ normalized_url: string }>).map((row) => row.normalized_url);
  }

  /** Cheap cancellation check for scan loops; avoids re-parsing the options blob per URL. */
  isCancelled(scanId: string): boolean {
    const row = this.stmt('SELECT cancel_requested FROM scans WHERE id = ?').get(scanId) as { cancel_requested: number } | undefined;
    return Boolean(row?.cancel_requested);
  }

  /** Every counter a progress event needs, in one statement instead of five queries. */
  progressCounts(scanId: string): { status: StoredScan['status']; total: number; processed: number; findings: number; backlinkCount: number; hoursChecked: number; hoursMismatches: number } | null {
    const row = this.stmt(`SELECT status, total, processed, findings,
        (SELECT COUNT(*) FROM backlinks WHERE scan_id = scans.id) AS backlinks,
        (SELECT COUNT(*) FROM restaurant_hours WHERE scan_id = scans.id) AS hours,
        (SELECT COUNT(*) FROM restaurant_hours WHERE scan_id = scans.id AND status = 'mismatch') AS mismatches
      FROM scans WHERE id = ?`).get(scanId) as unknown as
      { status: StoredScan['status']; total: number; processed: number; findings: number; backlinks: number; hours: number; mismatches: number } | undefined;
    if (!row) return null;
    return {
      status: row.status,
      total: row.total,
      processed: row.processed,
      findings: row.findings,
      backlinkCount: row.backlinks,
      hoursChecked: row.hours,
      hoursMismatches: row.mismatches,
    };
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  /** Authoritative recount, used where the incremental counters could have drifted. */
  reconcileCounts(scanId: string): void {
    const row = this.stmt(`SELECT COUNT(*) AS total,
        COALESCE(SUM(status = 'complete'), 0) AS processed,
        COALESCE(SUM(json_extract(result_json, '$.classification') IN ${ACTIONABLE_SQL}), 0) AS findings
      FROM candidates WHERE scan_id = ?`).get(scanId) as unknown as { total: number; processed: number; findings: number };
    this.updateScan(scanId, { total: row.total, processed: row.processed, findings: row.findings });
  }

  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
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
