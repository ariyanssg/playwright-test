import { chromium, type Browser, type BrowserContext } from 'playwright';
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

  constructor(private readonly options: HoursInspectorOptions) {
    this.limiter = new HostLimiter(options.perHostConcurrency, options.hostDelayMs);
  }

  async open(): Promise<void> {
    if (this.context) return;
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
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }
}
