import { chromium, type BrowserContext } from 'playwright';
import type { DiscoveredUrl } from './sitemap.js';
import type { RobotsCache } from '../robots.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { isSameSite, normalizeUrl, tryNormalizeUrl } from '../urls.js';

export interface CrawlDiscoveryResult {
  urls: DiscoveredUrl[];
  visitedPages: number;
  warnings: string[];
}

export async function discoverCrawl(
  site: string,
  robots: RobotsCache,
  limit: number,
  timeoutMs: number,
  shouldCancel: () => boolean = () => false,
): Promise<CrawlDiscoveryResult> {
  const start = normalizeUrl(site);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block' });
  await blockHeavyResources(context);
  const page = await context.newPage();
  const queue = [start];
  const enqueued = new Set(queue);
  const visited = new Set<string>();
  const found = new Map<string, DiscoveredUrl>();
  const warnings: string[] = [];
  let limitReached = false;
  try {
    while (queue.length && visited.size < limit && !shouldCancel()) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      const rules = await robots.get(url);
      if (!rules.isAllowed(url)) continue;
      visited.add(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForTimeout(Math.min(500, Math.max(200, Math.floor(timeoutMs / 4))));
        const links = await page.locator('a[href]').evaluateAll((anchors) =>
          anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
        );
        for (const rawLink of links) {
          const link = tryNormalizeUrl(rawLink);
          if (!link || !isSameSite(link, start)) continue;
          const parsed = new URL(link);
          if (!['http:', 'https:'].includes(parsed.protocol)) continue;
          found.set(link, { url: link, evidence: { source: 'crawl', discoveredFrom: url } });
          if (!enqueued.has(link)) {
            if (enqueued.size < limit) {
              enqueued.add(link);
              queue.push(link);
            } else {
              limitReached = true;
            }
          }
        }
      } catch (error) {
        warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  if (queue.length || limitReached) warnings.push(`Crawl stopped at the configured ${limit.toLocaleString()} page limit`);
  return { urls: [...found.values()], visitedPages: visited.size, warnings };
}

async function blockHeavyResources(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') await route.abort();
    else await route.continue();
  });
}
