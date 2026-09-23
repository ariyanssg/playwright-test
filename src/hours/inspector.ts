import { type Browser, type BrowserContext, type Page } from 'playwright';
import { acquireBrowser, releaseBrowser } from '../browser.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { HostLimiter } from '../scanner.js';
import { harvestHours } from './harvest.js';
import { chooseWebsiteHours, extractPageHours, type PageExtraction, type WebsiteHoursExtraction } from './website.js';

/** Pages of one site read at once; the per-host limiter still paces them. */
const MAX_PARALLEL_PAGES = 3;

export interface HoursInspectorOptions {
  perHostConcurrency: number;
  hostDelayMs: number;
  timeoutMs: number;
}

/**
 * Loads a handful of pages per site and extracts their published hours, reusing
 * the scanner's per-host pacing so an hours pass is no less polite than a scan.
 */
export class HoursInspector {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly limiter: HostLimiter;
  private opening: Promise<void> | null = null;

  constructor(private readonly options: HoursInspectorOptions) {
    this.limiter = new HostLimiter(options.perHostConcurrency, options.hostDelayMs);
  }

  /** Idempotent under concurrent callers: several sites may start inspecting at once. */
  async open(): Promise<void> {
    this.opening ??= (async () => {
      const browser = await acquireBrowser();
      const context = await browser.newContext({
        userAgent: AUDITOR_USER_AGENT,
        serviceWorkers: 'block',
        ignoreHTTPSErrors: false,
      });
      // Hours are read from innerText, so styles must load; only unread media is dropped.
      await context.route('**/*', (route) => {
        const resource = route.request().resourceType();
        return ['image', 'media', 'font'].includes(resource) ? route.abort() : route.continue();
      });
      this.browser = browser;
      this.context = context;
    })();
    await this.opening;
  }

  /**
   * Reads the highest-ranked page first. When it already carries a complete, structured week
   * (the common case: a JSON-LD homepage), no lower-ranked page could outrank it in
   * `chooseWebsiteHours`, so the rest are skipped. Otherwise the remaining pages load in
   * parallel, still paced by the per-host limiter.
   */
  async inspect(urls: readonly string[]): Promise<WebsiteHoursExtraction> {
    await this.open();
    const extractions: Array<PageExtraction | null> = urls.map(() => null);
    const failures: Array<string | null> = urls.map(() => null);
    const read = async (page: Page, index: number): Promise<void> => {
      const url = urls[index]!;
      const harvest = await this.limiter.run(new URL(url).host, () => harvestHours(page, url, this.options.timeoutMs));
      if (harvest.error) failures[index] = `${url}: ${harvest.error}`;
      else extractions[index] = extractPageHours(harvest, url, urls.length - index);
    };

    const first = await this.context!.newPage();
    try {
      if (urls.length) await read(first, 0);
      const lead = extractions[0];
      const settled = lead?.identity && lead.candidate?.confidence === 'high' && lead.candidate.weekly.statedDays.length === 7;
      if (!settled && urls.length > 1) {
        let next = 1;
        const workers = Math.max(1, Math.min(this.options.perHostConcurrency, MAX_PARALLEL_PAGES, urls.length - 1));
        await Promise.all(Array.from({ length: workers }, async (_, worker) => {
          const page = worker === 0 ? first : await this.context!.newPage();
          try {
            for (let index = next++; index < urls.length; index = next++) await read(page, index);
          } finally {
            if (page !== first) await page.close();
          }
        }));
      }
    } finally {
      await first.close();
    }
    return chooseWebsiteHours(
      extractions.filter((item): item is PageExtraction => item !== null),
      failures.filter((item): item is string => item !== null),
    );
  }

  async close(): Promise<void> {
    if (!this.opening) return;
    await this.opening.catch(() => undefined);
    this.opening = null;
    const started = Boolean(this.browser);
    await this.context?.close();
    this.context = null;
    this.browser = null;
    if (started) await releaseBrowser();
  }
}
