import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { chromium, errors, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { classifyPage, makeBaseline, type MissingBaseline, type PageSignals } from './classifier.js';
import type { ScanDatabase } from './database.js';
import { isActionable } from './database.js';
import type { CandidateRecord, RedirectHop, ScanProgressEvent, ScanResult } from './types.js';
import type { RobotsCache } from './robots.js';
import { AUDITOR_USER_AGENT } from './robots.js';

interface RenderedPage extends PageSignals {
  requestedUrl: string;
  finalUrl: string;
  redirects: RedirectHop[];
  canonical: string | null;
  contentType: string | null;
  responseMs: number;
  retryAfterMs: number;
}

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
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent: AUDITOR_USER_AGENT,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
    });
    await this.context.route('**/*', async (route) => {
      const resource = route.request().resourceType();
      if (resource === 'image' || resource === 'media' || resource === 'font') await route.abort();
      else await route.continue();
    });

    let nextIndex = 0;
    const workerCount = Math.min(this.options.concurrency, candidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
      const page = await this.context!.newPage();
      try {
        for (;;) {
          if (this.db.getScan(scanId)?.cancelRequested) return;
          const candidate = candidates[nextIndex++];
          if (!candidate) return;
          this.db.markCandidateRunning(scanId, candidate.normalizedUrl);
          const result = await this.scanCandidate(page, candidate);
          this.db.saveResult(scanId, result);
          const scan = this.db.getScan(scanId)!;
          this.progress({
            scanId,
            status: 'scanning',
            total: scan.total,
            processed: scan.processed,
            findings: scan.findings,
            backlinkCount: this.db.backlinkCount(scanId),
            hoursChecked: this.db.hoursCount(scanId),
            hoursMismatches: this.db.hoursMismatchCount(scanId),
            message: `${result.classification}: ${result.normalizedUrl}`,
          });
        }
      } finally {
        await page.close();
      }
    });

    try {
      await Promise.all(workers);
    } finally {
      await this.context.close();
      await this.browser.close();
      this.context = null;
      this.browser = null;
    }
  }

  private async scanCandidate(page: Page, candidate: CandidateRecord): Promise<ScanResult> {
    const host = new URL(candidate.normalizedUrl).host;
    let rendered: RenderedPage | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      rendered = await this.limiter.run(host, () => renderPage(page, candidate.normalizedUrl, this.options.timeoutMs));
      if (!shouldRetry(rendered) || attempt === 1) break;
      await delay(Math.max(500, rendered.retryAfterMs || 1_000 * (attempt + 1)));
    }
    rendered ??= networkFailure(candidate.normalizedUrl, 'Unknown navigation failure');
    const robots = await this.robots.get(candidate.normalizedUrl);
    const baseline = rendered.status && rendered.status >= 200 && rendered.status < 300
      ? await this.getBaseline(new URL(candidate.normalizedUrl).origin)
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

async function renderPage(page: Page, url: string, timeoutMs: number): Promise<RenderedPage> {
  const started = performance.now();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(Math.min(750, Math.max(250, Math.floor(timeoutMs / 4))));
    const responseMs = Math.round(performance.now() - started);
    if (!response) return networkFailure(url, 'Navigation returned no main-document response', responseMs);
    const content = await page.evaluate(() => {
      const main = document.querySelector('main, [role="main"], article') ?? document.body;
      return {
        title: document.title || '',
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        mainText: (main?.textContent || '').replace(/\s+/g, ' ').trim(),
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href || null,
      };
    }).catch(() => ({ title: '', h1: '', mainText: '', canonical: null }));
    const headers = response.headers();
    return {
      requestedUrl: url,
      status: response.status(),
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
    const timedOut = error instanceof errors.TimeoutError || /timeout/i.test(error instanceof Error ? error.message : String(error));
    return {
      ...networkFailure(url, error instanceof Error ? error.message : String(error), responseMs),
      timedOut,
    };
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

function networkFailure(url: string, error: string, responseMs = 0): RenderedPage {
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

  constructor(limit: number, private readonly delayMs: number) {
    this.semaphore = new Semaphore(limit);
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
    let gate = this.gates.get(host);
    if (!gate) {
      gate = new HostGate(this.perHost, this.delayMs);
      this.gates.set(host, gate);
    }
    return gate.run(operation);
  }
}

export function meetsFailureThreshold(result: ScanResult, threshold: 'hard' | 'soft' | 'none'): boolean {
  if (threshold === 'none') return false;
  if (threshold === 'soft') return isActionable(result.classification);
  return result.classification === 'hard_404' || result.classification === 'gone_410';
}
