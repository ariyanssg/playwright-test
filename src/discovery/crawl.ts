import { setTimeout as delay } from 'node:timers/promises';
import { type Page } from 'playwright';
import type { DiscoveredUrl } from './sitemap.js';
import type { RobotsCache } from '../robots.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { acquireBrowser, releaseBrowser } from '../browser.js';
import { blockUnreadResources, HostLimiter } from '../scanner.js';
import { isSameSite, normalizeUrl, tryNormalizeUrl } from '../urls.js';

export interface CrawlDiscoveryResult {
  urls: DiscoveredUrl[];
  visitedPages: number;
  warnings: string[];
}

export interface CrawlOptions {
  crawlLimit: number;
  timeoutMs: number;
  concurrency: number;
  perHostConcurrency: number;
  hostDelayMs: number;
}

/** One site fills the queue faster than any single page can drain it; cap the warning spam. */
const MAX_WARNINGS = 50;
const MAX_LINKS_PER_PAGE = 2_000;
const IDLE_POLL_MS = 20;

/**
 * Breadth-first crawl of one site. Pages are fetched by a pool of tabs rather than one at a
 * time; per-host pacing still runs through the scanner's limiter, so parallelism never makes
 * the crawl less polite than the configured host delay allows.
 */
export async function discoverCrawl(
  site: string,
  robots: RobotsCache,
  options: CrawlOptions,
  shouldCancel: () => boolean = () => false,
): Promise<CrawlDiscoveryResult> {
  const start = normalizeUrl(site);
  const limit = options.crawlLimit;
  const browser = await acquireBrowser();
  const context = await browser.newContext({ userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block' });
  await blockUnreadResources(context);
  const limiter = new HostLimiter(options.perHostConcurrency, options.hostDelayMs);

  const queue = [start];
  const enqueued = new Set(queue);
  const visited = new Set<string>();
  const found = new Map<string, DiscoveredUrl>();
  const warnings: string[] = [];
  let limitReached = false;
  let inFlight = 0;

  const record = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
  };

  const worker = async (): Promise<void> => {
    const page = await context.newPage();
    try {
      for (;;) {
        if (shouldCancel() || visited.size >= limit) return;
        const url = queue.shift();
        if (url === undefined) {
          // Another tab may still be about to enqueue links; only stop once nothing is in flight.
          if (!inFlight) return;
          await delay(IDLE_POLL_MS);
          continue;
        }
        if (visited.has(url)) continue;
        inFlight += 1;
        try {
          const rules = await robots.get(url);
          if (!rules.isAllowed(url)) continue;
          limiter.slowHost(new URL(url).host, rules.crawlDelayMs);
          // Re-check with no await before the add, so parallel tabs cannot overshoot the limit.
          if (visited.size >= limit) return;
          visited.add(url);
          const links = await limiter.run(new URL(url).host, () => readLinks(page, url, options.timeoutMs));
          for (const rawLink of links) {
            const link = tryNormalizeUrl(rawLink);
            if (!link || !isSameSite(link, start)) continue;
            const parsed = new URL(link);
            if (!['http:', 'https:'].includes(parsed.protocol)) continue;
            found.set(link, { url: link, evidence: { source: 'crawl', discoveredFrom: url } });
            if (enqueued.has(link)) continue;
            if (enqueued.size >= limit) {
              limitReached = true;
              continue;
            }
            enqueued.add(link);
            queue.push(link);
          }
        } catch (error) {
          record(`${url}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          inFlight -= 1;
        }
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  const workerCount = Math.max(1, Math.min(options.concurrency, options.perHostConcurrency, limit));
  try {
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    await context.close();
    await releaseBrowser();
  }
  if (queue.length || limitReached) warnings.push(`Crawl stopped at the configured ${limit.toLocaleString()} page limit`);
  return { urls: [...found.values()], visitedPages: visited.size, warnings };
}

/**
 * Reads a page's anchors. Server-rendered markup already carries them at DOMContentLoaded, so
 * the settle wait is only paid by pages that arrive without any links.
 */
async function readLinks(page: Page, url: string, timeoutMs: number): Promise<string[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  let links = await collect(page);
  if (!links.length) {
    await page.waitForTimeout(Math.min(500, Math.max(200, Math.floor(timeoutMs / 4))));
    links = await collect(page);
  }
  return links;
}

function collect(page: Page): Promise<string[]> {
  return page.evaluate((max) => Array.from(document.querySelectorAll('a[href]'))
    .slice(0, max)
    .map((anchor) => (anchor as HTMLAnchorElement).href), MAX_LINKS_PER_PAGE);
}
