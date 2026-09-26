import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { appDataDir } from '../config.js';
import { directGoogleDestination, GoogleChallengeError, googleSearchUrl, isGoogleHost, type GooglePage, type GoogleResult, type GoogleSearchRequest } from './google-results.js';

// Chromium profiles cannot be shared by simultaneously running browser instances.
let browserQueue: Promise<void> = Promise.resolve();

export class GoogleBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private release?: () => void;
  private lastRequest = 0;
  private interruptedUrl?: string;

  constructor(private readonly options: { profileDir?: string; headless?: boolean; delayMs?: number; createContext?: () => Promise<BrowserContext> } = {}) {}

  async fetchPage(request: GoogleSearchRequest): Promise<GooglePage> {
    await this.open(request.signal);
    request.signal?.throwIfAborted();
    const abort = () => { void this.context?.close().catch(() => undefined); };
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      await delay(Math.max(0, (this.options.delayMs ?? 1500) - (Date.now() - this.lastRequest)), undefined, { signal: request.signal });
      const desired = request.nextUrl || googleSearchUrl(request);
      if (this.interruptedUrl !== desired || !this.page || this.page.isClosed()) {
        this.page = this.page && !this.page.isClosed() ? this.page : await this.context!.newPage();
        await this.page.goto(desired, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      this.lastRequest = Date.now();
      await this.page!.waitForFunction(() => document.querySelector('#search, #rso, #captcha-form, iframe[src*="recaptcha"]') || /unusual traffic|before you continue|did not match any documents|no results found/i.test(document.body?.innerText ?? ''), undefined, { timeout: 8000 }).catch(() => undefined);
      const parsed = await readGoogleResults(this.page!);
      if (parsed.challenge) {
        this.interruptedUrl = desired;
        await this.page!.bringToFront();
        throw new GoogleChallengeError('Google needs your attention. Resolve the CAPTCHA or consent prompt in the Google browser, then choose Continue.');
      }
      const current = new URL(this.page!.url());
      if (!isGoogleHost(current.hostname) || current.pathname !== '/search' || current.searchParams.get('q') !== request.query) {
        this.interruptedUrl = undefined;
        throw new Error('The Google browser left the requested search. Resume to reopen that search.');
      }
      this.interruptedUrl = undefined;
      if (!parsed.links.length && !parsed.empty) throw new Error('Google page could not be recognized as results or an explicit empty search');
      const results: GoogleResult[] = [];
      const warnings: string[] = [];
      for (const item of parsed.links) {
        request.signal?.throwIfAborted();
        try {
          const url = directGoogleDestination(item.href, this.page!.url()) || await this.resolveLink(item.href, request.signal);
          if (url) results.push({ url, title: item.title, snippet: item.snippet, kind: item.kind, position: item.position });
          else warnings.push(`Could not resolve Google result: ${item.title}`);
        } catch {
          request.signal?.throwIfAborted();
          warnings.push(`Could not resolve Google result: ${item.title}`);
        }
      }
      let nextUrl: string | undefined;
      if (parsed.next) {
        const next = new URL(parsed.next, this.page!.url());
        if (isGoogleHost(next.hostname) && next.pathname === '/search' && next.searchParams.get('q') === request.query) {
          next.searchParams.set('gl', request.country);
          next.searchParams.set('hl', request.language);
          next.searchParams.set('pws', '0');
          nextUrl = next.href;
        }
      }
      return { results, hasNext: Boolean(nextUrl), nextUrl, searchUrl: googleSearchUrl(request), warnings };
    } finally { request.signal?.removeEventListener('abort', abort); }
  }

  /**
   * Reads the local business panel beside a Google Search result: its menu, order and
   * reservation rows (`data-attrid="kc:/local:…"`). Google only renders that panel for a real
   * browser session, which is why this uses the persistent, visible profile. A CAPTCHA or
   * consent screen raises GoogleChallengeError so the audit can wait for the person.
   */
  async localPanel(query: string, signal?: AbortSignal): Promise<Array<{ attr: string; label: string; href: string }>> {
    await this.open(signal);
    signal?.throwIfAborted();
    await delay(Math.max(0, (this.options.delayMs ?? 1500) - (Date.now() - this.lastRequest)), undefined, { signal });
    const page = this.page && !this.page.isClosed() ? this.page : (this.page = await this.context!.newPage());
    const url = new URL('https://www.google.com/search');
    url.search = new URLSearchParams({ q: query, hl: 'en' }).toString();
    // After a CAPTCHA the person may already have landed on the results; do not reload them.
    if (!(new URL(page.url()).pathname === '/search' && new URL(page.url()).searchParams.get('q') === query)) {
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    this.lastRequest = Date.now();
    await page.waitForFunction(() => document.querySelector('[data-attrid^="kc:/local:"], #rso, #captcha-form, iframe[src*="recaptcha"]') || /unusual traffic|before you continue/i.test(document.body?.innerText ?? ''), undefined, { timeout: 10_000 }).catch(() => undefined);
    const blocked = /\/sorry\/|consent\.google\./.test(page.url()) || await page.locator('#captcha-form, iframe[src*="recaptcha"]').count() > 0
      || /unusual traffic|before you continue/i.test(await page.evaluate(() => document.body?.innerText.slice(0, 2000) ?? ''));
    if (blocked) {
      await page.bringToFront();
      throw new GoogleChallengeError('Google needs your attention to read the business panel. Resolve the CAPTCHA or consent prompt in the Google browser, then choose Continue.');
    }
    // Panel rows render a moment after the results.
    await page.locator('[data-attrid^="kc:/local:"]').first().waitFor({ timeout: 5_000 }).catch(() => undefined);
    return page.evaluate(() => Array.from(document.querySelectorAll('[data-attrid^="kc:/local:"]'))
      .flatMap((row) => Array.from(row.querySelectorAll('a[href]'))
        .map((link) => ({ attr: row.getAttribute('data-attrid') || '', label: (link.textContent || '').replace(/\s+/g, ' ').trim(), href: (link as HTMLAnchorElement).href }))));
  }

  private async open(signal?: AbortSignal): Promise<void> {
    if (this.context) return;
    const previous = browserQueue;
    let release!: () => void;
    browserQueue = new Promise<void>((resolve) => { release = resolve; });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('Google browser request cancelled'));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        void previous.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
      });
      signal?.throwIfAborted();
      this.release = release;
      this.context = this.options.createContext ? await this.options.createContext() : await chromium.launchPersistentContext(this.options.profileDir ?? join(appDataDir(), 'google-browser'), {
        headless: this.options.headless ?? false, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block',
      });
      this.page = this.context.pages()[0] ?? await this.context.newPage();
    } catch (error) {
      void previous.then(release);
      this.release = undefined;
      throw error;
    }
  }

  private async resolveLink(href: string, signal?: AbortSignal): Promise<string | null> {
    const wrapper = new URL(href, this.page!.url());
    if (!isGoogleHost(wrapper.hostname) || !['/url', '/goto'].includes(wrapper.pathname)) return null;
    const resolver = await this.context!.newPage();
    let destination: string | null = null;
    try {
      // Request events include redirect hops that Playwright route handlers skip.
      resolver.on('request', (request) => {
        if (destination || !request.isNavigationRequest() || request.frame() !== resolver.mainFrame()) return;
        const target = new URL(request.url());
        if (!isGoogleHost(target.hostname)) {
          destination = directGoogleDestination(target.href);
          if (destination) void resolver.close().catch(() => undefined);
        }
      });
      await resolver.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === resolver.mainFrame()) {
          const target = new URL(request.url());
          if (!isGoogleHost(target.hostname)) {
            // Capture the first website URL, before any redirects on that site.
            destination = directGoogleDestination(target.href);
            await route.abort();
            return;
          }
        }
        await route.fallback();
      });
      await resolver.goto(wrapper.href, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
      signal?.throwIfAborted();
      if (!destination && !resolver.isClosed()) {
        const links = await resolver.locator('a[href^="http"]').evaluateAll((nodes) => nodes.map((a) => (a as HTMLAnchorElement).href));
        destination = links.map((url) => directGoogleDestination(url)).find(Boolean) ?? null;
      }
      return destination;
    } finally { await resolver.close().catch(() => undefined); }
  }

  async close(): Promise<void> {
    try { await this.context?.close(); }
    finally { this.context = undefined; this.page = undefined; this.release?.(); this.release = undefined; }
  }
}

/** Parse only organic result cards; never harvest every anchor on a SERP. */
export async function readGoogleResults(page: Page) {
  return page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const challenge = /\/sorry\b/.test(location.pathname) || location.hostname === 'consent.google.com' || Boolean(document.querySelector('#captcha-form, iframe[src*="recaptcha"]')) || /our systems have detected unusual traffic|before you continue to Google/i.test(text);
    const root = document.querySelector('#search, #rso') ?? document.querySelector('main, [role="main"]');
    const links: Array<{ href: string; title: string; snippet: string; position: number; kind: 'organic' | 'sitelink' }> = [];
    let position = 0;
    const used = new Set<string>();
    for (const heading of Array.from(root?.querySelectorAll('h3') ?? [])) {
      const anchor = heading.closest<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.closest('#tads, #bottomads, #rhs, [data-text-ad], [data-pla], [aria-label="Ads"], [aria-label="Sponsored"]')) continue;
      const card = anchor.closest('.MjjYud, .g, .tF2Cxc') ?? anchor.parentElement?.parentElement;
      if (!card || /^(Sponsored|Sponsored result)\b/i.test(card.textContent?.trim() ?? '') || used.has(anchor.href)) continue;
      used.add(anchor.href);
      position += 1;
      const snippet = (card.querySelector('.VwiC3b, [data-sncf], .IsZvec')?.textContent ?? '').trim();
      links.push({ href: anchor.href, title: heading.textContent?.trim() ?? '', snippet, position, kind: 'organic' });
      for (const child of Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
        const label = child.textContent?.trim() ?? '';
        if (!label || used.has(child.href) || child.querySelector('h3, img') || child.closest('button, [role="button"]')) continue;
        const target = new URL(child.href, location.href);
        const google = /(^|\.)google\.(com|co\.uk)$/.test(target.hostname);
        if (!['http:', 'https:'].includes(target.protocol) || (google && !['/url', '/goto'].includes(target.pathname))) continue;
        used.add(child.href);
        links.push({ href: child.href, title: label, snippet: '', position, kind: 'sitelink' });
      }
    }
    const next = document.querySelector<HTMLAnchorElement>('a#pnnext, a[aria-label="Next page"], a[aria-label="Next"]')?.href;
    return { links, next, challenge, empty: /did not match any documents|no results found|there are no results for/i.test(text) };
  });
}
