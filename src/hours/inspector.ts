import { type Browser, type BrowserContext } from 'playwright';
import { acquireBrowser, releaseBrowser } from '../browser.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { HostLimiter } from '../scanner.js';
import { harvestHours } from './harvest.js';
import { chooseWebsiteHours, extractPageHours, type PageExtraction, type WebsiteHoursExtraction } from './website.js';

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

  async inspect(urls: readonly string[]): Promise<WebsiteHoursExtraction> {
    await this.open();
    const page = await this.context!.newPage();
    const extractions: PageExtraction[] = [];
    const pageErrors: string[] = [];
    try {
      for (const [index, url] of urls.entries()) {
        const host = new URL(url).host;
        const harvest = await this.limiter.run(host, () => harvestHours(page, url, this.options.timeoutMs));
        if (harvest.error) {
          pageErrors.push(`${url}: ${harvest.error}`);
          continue;
        }
        extractions.push(extractPageHours(harvest, url, urls.length - index));
      }
    } finally {
      await page.close();
    }
    return chooseWebsiteHours(extractions, pageErrors);
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
