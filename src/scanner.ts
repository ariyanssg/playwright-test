import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { errors, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { acquireBrowser, releaseBrowser } from './browser.js';
import { classifyPage, makeBaseline, type MissingBaseline, type PageSignals } from './classifier.js';
import type { ScanDatabase } from './database.js';
import { isActionable } from './database.js';
import type { CandidateRecord, RedirectHop, ScanProgressEvent, ScanResult } from './types.js';
import type { RobotsCache } from './robots.js';
import { AUDITOR_USER_AGENT } from './robots.js';

/**
 * Resource types that never change a missing-page verdict. Styles are included because every
 * signal the classifier reads comes from `textContent`, which ignores CSS.
 */
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet', 'texttrack', 'manifest', 'eventsource', 'websocket']);
/** Trackers, ad exchanges and chat widgets: pure latency on a page we only read text from. */
const BLOCKED_HOSTS = /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|googleadservices\.com|adservice\.google\.com|doubleclick\.net|googlesyndication\.com|facebook\.net|connect\.facebook\.com|hotjar\.com|clarity\.ms|segment\.(?:io|com)|mixpanel\.com|intercom\.io|fullstory\.com|newrelic\.com|nr-data\.net|criteo\.com|taboola\.com|outbrain\.com|bat\.bing\.com|analytics\.tiktok\.com|ct\.pinterest\.com|snap\.licdn\.com|px\.ads\.linkedin\.com|mc\.yandex\.ru|scorecardresearch\.com|quantserve\.com|tawk\.to|zopim\.com|livechatinc\.com|crisp\.chat)$/i;

/** Applies the shared blocking policy to a context so page loads carry only what we read. */
export async function blockUnreadResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    if (BLOCKED_RESOURCES.has(request.resourceType())) return route.abort();
    let host = '';
    try {
      host = new URL(request.url()).hostname;
    } catch {
      return route.continue();
    }
    return BLOCKED_HOSTS.test(host) ? route.abort() : route.continue();
  });
}

interface RenderedPage extends PageSignals {
  requestedUrl: string;
  finalUrl: string;
  redirects: RedirectHop[];
  canonical: string | null;
  contentType: string | null;
  responseMs: number;
  retryAfterMs: number;
}

const PROGRESS_REFRESH_MS = 400;

export interface ScannerOptions {
  concurrency: number;
  perHostConcurrency: number;
  hostDelayMs: number;
  timeoutMs: number;
}

export class BrowserScanner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly baselineCache = new Map<string, Promise<MissingBaseline | null>>();
  private readonly limiter: HostLimiter;
  private counts: NonNullable<ReturnType<ScanDatabase['progressCounts']>> | null = null;
  private countsReadAt = 0;

  constructor(
    private readonly db: ScanDatabase,
    private readonly robots: RobotsCache,
    private readonly options: ScannerOptions,
    private readonly progress: (event: ScanProgressEvent) => void,
  ) {
    this.limiter = new HostLimiter(options.perHostConcurrency, options.hostDelayMs);
  }

  async scan(scanId: string, candidates: CandidateRecord[]): Promise<void> {
    if (!candidates.length) return;
    this.browser = await acquireBrowser();
    this.context = await this.browser.newContext({
      userAgent: AUDITOR_USER_AGENT,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
    });
    await blockUnreadResources(this.context);

    // Interleave hosts so the global workers are not all parked behind one host's limiter while
    // every other site in the audit sits idle.
    const queue = interleaveByHost(candidates);
    let nextIndex = 0;
    const workerCount = Math.min(this.options.concurrency, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      const page = await this.context!.newPage();
      try {
        for (;;) {
          if (this.db.isCancelled(scanId)) return;
          const candidate = queue[nextIndex++];
          if (!candidate) return;
          this.db.markCandidateRunning(scanId, candidate.normalizedUrl);
          const result = await this.scanCandidate(page, candidate);
          this.db.saveResult(scanId, result);
          this.report(scanId, result);
        }
      } finally {
        await page.close();
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      await this.context.close();
      this.context = null;
      this.browser = null;
      await releaseBrowser();
    }
  }

  /**
   * Emits progress for every URL but re-reads the counters at most once per tick: the counter
   * query is synchronous, so polling it per URL stole time from the browser workers.
   */
  private report(scanId: string, result: ScanResult): void {
    const now = Date.now();
    if (!this.counts || now - this.countsReadAt >= PROGRESS_REFRESH_MS) {
      this.counts = this.db.progressCounts(scanId);
      this.countsReadAt = now;
    } else {
      this.counts.processed += 1;
      if (isActionable(result.classification)) this.counts.findings += 1;
    }
    if (!this.counts) return;
    this.progress({
      scanId,
      ...this.counts,
      status: 'scanning',
      message: `${result.classification}: ${result.normalizedUrl}`,
    });
  }

  private async scanCandidate(page: Page, candidate: CandidateRecord): Promise<ScanResult> {
    const url = new URL(candidate.normalizedUrl);
    const host = url.host;
    // Read robots first (it is cached per origin) so a declared crawl-delay paces this request
    // rather than the one after it.
    const robots = await this.robots.get(candidate.normalizedUrl);
    this.limiter.slowHost(host, robots.crawlDelayMs);
    let rendered: RenderedPage | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      rendered = await this.limiter.run(host, () => renderPage(page, candidate.normalizedUrl, this.options.timeoutMs));
      if (!shouldRetry(rendered) || attempt === 1) break;
      await delay(Math.max(500, rendered.retryAfterMs || 1_000 * (attempt + 1)));
    }
    rendered ??= networkFailure(candidate.normalizedUrl, 'Unknown navigation failure');
    const baseline = rendered.status && rendered.status >= 200 && rendered.status < 300 && /html/i.test(rendered.contentType ?? '')
      ? await this.getBaseline(url.origin)
      : null;
    const decision = classifyPage(rendered, baseline);
    return {
      inputUrl: candidate.inputUrl,
      normalizedUrl: candidate.normalizedUrl,
      site: candidate.site,
      sources: candidate.sources,
      httpStatus: rendered.status,
      finalUrl: rendered.finalUrl,
      redirectChain: rendered.redirects,
      classification: decision.classification,
      confidence: decision.confidence,
      reasons: decision.reasons,
      robotsAllowed: robots.isAllowed(candidate.normalizedUrl),
      title: rendered.title,
      h1: rendered.h1,
      canonical: rendered.canonical,
      contentType: rendered.contentType,
      responseMs: rendered.responseMs,
      checkedAt: new Date().toISOString(),
      error: rendered.error ?? null,
    };
  }

  private getBaseline(origin: string): Promise<MissingBaseline | null> {
    let pending = this.baselineCache.get(origin);
    if (!pending) {
      pending = (async () => {
        if (!this.context) return null;
        const page = await this.context.newPage();
        try {
          const url = `${origin}/seo404-auditor-missing-${randomUUID()}`;
          const rendered = await this.limiter.run(new URL(origin).host, () => renderPage(page, url, this.options.timeoutMs));
          return makeBaseline(rendered);
        } catch {
          return null;
        } finally {
          await page.close();
        }
      })();
      this.baselineCache.set(origin, pending);
    }
    return pending;
  }
}

/** Text long enough that a settle wait is unlikely to change the verdict. */
const SETTLED_TEXT_CHARS = 400;
/**
 * Upper bound on waiting for a client-rendered page to produce its copy. Restaurant sites built
 * on ordering platforms routinely set their title and menu 3-4 s after DOMContentLoaded; reading
 * them at 2 s saw only the shared loading shell, which then "matched" the missing-page baseline
 * and flagged every page as a soft 404. Server-rendered pages still return immediately.
 */
const MAX_SETTLE_MS = 6_000;
/** A short page whose text has not moved for this long is treated as finished. */
const STABLE_TEXT_MS = 450;
/** Phrases worth reading immediately: the verdict is already on the page. */
const SETTLE_EARLY_EXIT = String.raw`not\s+found|404|410|does\s*n[o']t\s+exist|no\s+longer\s+(?:exists|available)|you\s+seem\s+lost`;

// innerText, not textContent: textContent includes inline <script> source, so a page whose
// content had not rendered yet still looked "full" and identical to every other page's shell.
const readSignals = () => {
  const main = (document.querySelector('main, [role="main"], article') ?? document.body) as HTMLElement | null;
  return {
    title: document.title || '',
    h1: document.querySelector('h1')?.textContent?.trim() || '',
    mainText: (main?.innerText ?? main?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || null,
  };
};

const emptySignals = { title: '', h1: '', mainText: '', canonical: null as string | null };

export async function renderPage(page: Page, url: string, timeoutMs: number): Promise<RenderedPage> {
  const started = performance.now();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const responseMs = Math.round(performance.now() - started);
    if (!response) return networkFailure(url, 'Navigation returned no main-document response', responseMs);
    let content = await page.evaluate(readSignals).catch(() => emptySignals);
    // The settle wait only exists for client-rendered pages. A non-2xx status is already
    // decided by the classifier, and a page that arrived with its copy has nothing to wait for.
    const status = response.status();
    if (status >= 200 && status < 300) {
      // Wait until the document has finished loading (images, fonts and styles are blocked, so a
      // server-rendered page gets there almost at once) and its text has stopped changing.
      // Length alone is not a signal: a client-rendered site's navigation and footer are
      // already several hundred characters before the page's own content arrives.
      // The callback is inline and declares no named functions (see harvest.ts on `__name`).
      await page.waitForFunction(({ min, stableMs, early }) => {
        const root = (document.querySelector('main, [role="main"], article') ?? document.body) as HTMLElement | null;
        const text = (root?.innerText ?? root?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const probe = `${document.title} ${document.querySelector('h1')?.textContent || ''} ${text.slice(0, 800)}`;
        if (new RegExp(early, 'i').test(probe)) return true;
        if (document.readyState === 'complete' && text.length >= min && document.title) {
          const loaded = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.loadEventEnd ?? 0;
          // Give scripts that render on "load" one short beat to do so.
          if (loaded && performance.now() - loaded >= 150) return true;
        }
        const holder = window as unknown as { __seo404Settle?: { length: number; since: number } };
        const now = performance.now();
        if (!holder.__seo404Settle || holder.__seo404Settle.length !== text.length) {
          holder.__seo404Settle = { length: text.length, since: now };
          return false;
        }
        // An empty <title> almost always means the app has not rendered yet, so it must hold
        // still much longer before its text is trusted.
        return document.readyState === 'complete' && !/loading|please wait/i.test(probe) && now - holder.__seo404Settle.since >= (document.title ? stableMs : stableMs * 4);
      }, { min: SETTLED_TEXT_CHARS, stableMs: STABLE_TEXT_MS, early: SETTLE_EARLY_EXIT }, { timeout: Math.min(MAX_SETTLE_MS, Math.max(250, Math.floor(timeoutMs / 3))), polling: 100 }).catch(() => undefined);
      content = await page.evaluate(readSignals).catch(() => content);
    }
    const headers = response.headers();
    return {
      requestedUrl: url,
      status,
      title: content.title,
      h1: content.h1,
      mainText: content.mainText,
      finalUrl: page.url(),
      redirects: await redirectChain(response),
      redirectCount: await redirectCount(response.request()),
      canonical: content.canonical,
      contentType: headers['content-type'] ?? null,
      responseMs,
      retryAfterMs: parseRetryAfter(headers['retry-after']),
      error: null,
      timedOut: false,
    };
  } catch (error) {
    const responseMs = Math.round(performance.now() - started);
    if (error instanceof Error && /download is starting/i.test(error.message)) {
      return renderDownload(page, url, timeoutMs, started);
    }
    const timedOut = error instanceof errors.TimeoutError || /timeout/i.test(error instanceof Error ? error.message : String(error));
    return {
      ...networkFailure(url, error instanceof Error ? error.message : String(error), responseMs),
      timedOut,
    };
  }
}

async function renderDownload(page: Page, url: string, timeoutMs: number, started: number): Promise<RenderedPage> {
  const redirects: RedirectHop[] = [];
  let current = url;
  try {
    for (let count = 0; count <= 10; count += 1) {
      const response = await page.context().request.get(current, { timeout: timeoutMs, maxRedirects: 0 });
      const status = response.status();
      const headers = response.headers();
      redirects.push({ url: current, status, location: headers.location });
      await response.dispose();
      if (status >= 300 && status < 400 && headers.location) {
        current = new URL(headers.location, current).href;
        continue;
      }
      return {
        requestedUrl: url, finalUrl: current, status, redirects, redirectCount: redirects.length - 1,
        title: '', h1: '', mainText: '', canonical: null, contentType: headers['content-type'] ?? null,
        responseMs: Math.round(performance.now() - started), retryAfterMs: parseRetryAfter(headers['retry-after']),
        error: null, timedOut: false,
      };
    }
    return networkFailure(url, 'Too many download redirects');
  } catch (error) {
    return networkFailure(url, error instanceof Error ? error.message : String(error), Math.round(performance.now() - started));
  }
}

async function redirectChain(response: Response): Promise<RedirectHop[]> {
  const requests: Request[] = [];
  let current: Request | null = response.request();
  while (current) {
    requests.unshift(current);
    current = current.redirectedFrom();
  }
  const output: RedirectHop[] = [];
  for (const request of requests) {
    const hopResponse = await request.response();
    const headers = hopResponse?.headers() ?? {};
    output.push({ url: request.url(), status: hopResponse?.status() ?? null, location: headers.location });
  }
  return output;
}

async function redirectCount(request: Request): Promise<number> {
  let count = 0;
  let current = request.redirectedFrom();
  while (current) {
    count += 1;
    current = current.redirectedFrom();
  }
  return count;
}

export function networkFailure(url: string, error: string, responseMs = 0): RenderedPage {
  return {
    requestedUrl: url,
    status: null,
    title: '',
    h1: '',
    mainText: '',
    finalUrl: url,
    redirects: [],
    redirectCount: 0,
    canonical: null,
    contentType: null,
    responseMs,
    retryAfterMs: 0,
    error,
    timedOut: /timeout/i.test(error),
  };
}

function shouldRetry(page: RenderedPage): boolean {
  return page.status === null || page.status === 429 || (page.status !== null && page.status >= 500);
}

function parseRetryAfter(value: string | undefined): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 0;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.queue.shift()?.();
    };
  }
}

class HostGate {
  private readonly semaphore: Semaphore;
  private pace: Promise<void> = Promise.resolve();
  private lastStarted = 0;

  constructor(limit: number, private delayMs: number) {
    this.semaphore = new Semaphore(limit);
  }

  /** A host that asks for more room in robots.txt gets it; it can never ask for less. */
  slowTo(delayMs: number): void {
    if (delayMs > this.delayMs) this.delayMs = delayMs;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.semaphore.acquire();
    try {
      const turn = this.pace.then(async () => {
        const wait = Math.max(0, this.lastStarted + this.delayMs - Date.now());
        if (wait) await delay(wait);
        this.lastStarted = Date.now();
      });
      this.pace = turn.catch(() => undefined);
      await turn;
      return await operation();
    } finally {
      release();
    }
  }
}

export class HostLimiter {
  private readonly gates = new Map<string, HostGate>();

  constructor(private readonly perHost: number, private readonly delayMs: number) {}

  run<T>(host: string, operation: () => Promise<T>): Promise<T> {
    return this.gate(host).run(operation);
  }

  /** Widens the pacing for one host, used to honour a robots.txt crawl-delay. */
  slowHost(host: string, delayMs: number | null): void {
    if (delayMs) this.gate(host).slowTo(delayMs);
  }

  private gate(host: string): HostGate {
    let gate = this.gates.get(host);
    if (!gate) {
      gate = new HostGate(this.perHost, this.delayMs);
      this.gates.set(host, gate);
    }
    return gate;
  }
}

/**
 * Round-robins candidates across hosts while keeping each host's own order. Sorted input used
 * to hand every worker the same host at once, so per-host limits serialized a multi-site audit.
 */
export function interleaveByHost<T extends { normalizedUrl: string }>(candidates: readonly T[]): T[] {
  const buckets = new Map<string, T[]>();
  for (const candidate of candidates) {
    let host = '';
    try {
      host = new URL(candidate.normalizedUrl).host;
    } catch {
      // Unparseable URLs share one bucket and still get checked.
    }
    let bucket = buckets.get(host);
    if (!bucket) buckets.set(host, bucket = []);
    bucket.push(candidate);
  }
  if (buckets.size < 2) return [...candidates];
  const lists = [...buckets.values()];
  const output: T[] = [];
  for (let index = 0; output.length < candidates.length; index += 1) {
    for (const list of lists) if (index < list.length) output.push(list[index]!);
  }
  return output;
}

export function meetsFailureThreshold(result: ScanResult, threshold: 'hard' | 'soft' | 'none'): boolean {
  if (threshold === 'none') return false;
  if (threshold === 'soft') return isActionable(result.classification);
  return result.classification === 'hard_404' || result.classification === 'gone_410';
}
