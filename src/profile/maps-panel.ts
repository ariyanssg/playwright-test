import type { BrowserContext, Page } from 'playwright';
import { acquireBrowser, releaseBrowser } from '../browser.js';
import type { Service, ServiceLink } from './model.js';

export interface MapsPanelLinks {
  links: ServiceLink[];
  /** Which service buttons the panel was confirmed to show or not show. */
  observed: Record<'menu' | 'reservations' | 'ordering', boolean>;
}

/**
 * Reads the Menu, Reserve and "Place an order" actions from a listing's public Google Maps page.
 *
 * Neither the Places API nor Serper's Maps data carries these links, yet they are exactly what a
 * customer clicks. The order action has no URL of its own: it opens a chooser listing the
 * restaurant's own ordering page and delivery platforms, so it is opened and read. Evaluated
 * callbacks are inline with no named inner functions (see hours/harvest.ts on `__name`).
 */
export async function readMapsServiceLinks(placeId: string, country: string, timeoutMs = 20_000, openContext?: () => Promise<BrowserContext>): Promise<MapsPanelLinks> {
  // The hosted edition supplies its own bundled, network-guarded Chromium; locally the shared one is used.
  const shared = openContext ? null : await acquireBrowser();
  const context = openContext ? await openContext() : await shared!.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 } });
  // The panel's links live in the DOM; images, fonts and video only slow the page down.
  await context.route('**/*', (route) => ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
  const page = await context.newPage();
  try {
    const base = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}&hl=en`;
    // Google hides "Place an order" on some listings when a market (`gl`) is forced, so the
    // unforced listing is read first; the market view is only tried when it showed neither
    // a menu nor an order button, and anything it adds is merged in.
    const result = await readPanel(page, base, timeoutMs);
    if (!result.observed.menu && !result.observed.ordering) {
      const market = await readPanel(page, `${base}&gl=${encodeURIComponent(country.toLowerCase())}`, timeoutMs).catch(() => null);
      if (market) {
        for (const link of market.links) if (!result.links.some((item) => item.service === link.service && item.url === link.url)) result.links.push(link);
        for (const key of ['menu', 'reservations', 'ordering'] as const) result.observed[key] ||= market.observed[key];
      }
    }
    return result;
  } finally {
    await context.close().catch(() => undefined);
    if (shared) await releaseBrowser();
  }
}

async function readPanel(page: Page, url: string, timeoutMs: number): Promise<MapsPanelLinks> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await declineConsent(page, timeoutMs);
  if (/\/sorry\//.test(page.url())) throw new Error('Google asked for a CAPTCHA before showing the Maps listing');
  // The action row renders after the title; the website item is present on nearly every listing.
  await page.locator('[data-item-id="authority"], [data-item-id^="action:"], [data-item-id="menu"]').first().waitFor({ timeout: timeoutMs });
  // Action buttons arrive one by one ("Place an order" after "Reserve"); read once the set of
  // panel items has stopped changing, so a listing without an order button costs ~1.5 s, not 8.
  await page.waitForFunction(({ quietMs }) => {
    const signature = Array.from(document.querySelectorAll('[data-item-id]')).map((node) => node.getAttribute('data-item-id')).join('|');
    const holder = window as unknown as { __seo404Panel?: { signature: string; since: number } };
    const now = performance.now();
    if (!holder.__seo404Panel || holder.__seo404Panel.signature !== signature) {
      holder.__seo404Panel = { signature, since: now };
      return false;
    }
    return now - holder.__seo404Panel.since >= quietMs;
  }, { quietMs: 1_500 }, { timeout: 8_000, polling: 250 }).catch(() => undefined);

  const links: ServiceLink[] = [];
  const add = (service: Service, href: string | null, label: string) => {
    const cleaned = cleanLink(href);
    // Google's own pages (the Maps UI, help) are never a restaurant's service destination.
    if (cleaned && /(^|\.)google\.[a-z.]+$/.test(new URL(cleaned).hostname)) return;
    if (cleaned && !links.some((link) => link.service === service && link.url === cleaned)) links.push({ service, url: cleaned, label, source: 'places' });
  };
  const direct = await page.evaluate(() => Array.from(document.querySelectorAll('a[data-item-id], a[aria-label]'))
    .map((node) => ({ id: node.getAttribute('data-item-id') || '', label: node.getAttribute('aria-label') || node.textContent?.trim() || '', href: (node as HTMLAnchorElement).href || '' })));
  let menu = false, reservations = false;
  for (const item of direct) {
    if (item.id === 'menu' || /^menu\b/i.test(item.label)) { menu = true; add('menu', item.href, 'Google Maps menu link'); }
    if (item.id === 'action:1' || /reserv|book a table|open reservation link/i.test(item.label)) { reservations = true; add('reservations', item.href, 'Google Maps reservation link'); }
  }

  // "Place an order" (action:4) is either a direct link or a button that opens a chooser.
  let ordering = false;
  const order = page.locator('[data-item-id="action:4"]').first();
  if (await order.count()) {
    ordering = true;
    const href = await order.getAttribute('href');
    if (href) add('ordering', href, 'Google Maps order link');
    else {
      const before = new Set(await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((node) => (node as HTMLAnchorElement).href)));
      await order.click({ timeout: 5_000 });
      await page.waitForTimeout(2_000);
      const chooser = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
        .map((node) => ({ href: (node as HTMLAnchorElement).href, label: (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim() })));
      for (const item of chooser) {
        if (before.has(item.href) || /support\.google\.com|google\.[a-z.]+\/(?:maps|search|intl)/i.test(item.href)) continue;
        add('ordering', item.href, `Google Maps "Place an order": ${item.label || new URL(item.href).hostname}`);
      }
    }
  }
  return { links, observed: { menu, reservations, ordering } };
}

/** Google's cookie screen blocks the listing; the privacy-preserving choice is to reject. */
async function declineConsent(page: Page, timeoutMs: number): Promise<void> {
  if (!/consent\.google\./.test(page.url())) return;
  const reject = page.getByRole('button', { name: /reject all/i }).first();
  if (!await reject.count()) throw new Error('Google showed a cookie consent screen that could not be declined automatically');
  await reject.click({ timeout: 5_000 });
  await page.waitForURL(/google\.[a-z.]+\/maps/, { timeout: timeoutMs });
}

/** Unwraps Google redirects and drops tracking parameters so links compare by destination. */
export function cleanLink(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname === '/url') {
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    if (!target) return null;
    try { url = new URL(target); } catch { return null; }
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^rwg_token$|^gclid$|^fbclid$/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

/** Rows of Google Search's local panel that name a service, keyed by their `data-attrid`. */
const PANEL_ROWS: Array<[RegExp, Service, string]> = [
  [/^kc:\/local:menu\b/, 'menu', 'Google Search panel "Menu"'],
  [/^kc:\/local:(?:order_food|order)\b/, 'ordering', 'Google Search panel "Order"'],
  [/^kc:\/local:(?:table_reservations|reservations|appointments)\b/, 'reservations', 'Google Search panel "Reservations"'],
];

/** Turns raw Search-panel anchors into service links (Google's own help and search URLs dropped). */
export function searchPanelLinks(rows: ReadonlyArray<{ attr: string; label: string; href: string }>): ServiceLink[] {
  const links: ServiceLink[] = [];
  for (const row of rows) {
    const rule = PANEL_ROWS.find(([pattern]) => pattern.test(row.attr));
    const url = rule ? cleanLink(row.href) : null;
    if (!rule || !url || /(^|\.)google\.[a-z.]+$/.test(new URL(url).hostname)) continue;
    if (!links.some((link) => link.service === rule[1] && link.url === url)) links.push({ service: rule[1], url, label: `${rule[2]}: ${row.label || new URL(url).hostname}`, source: 'places' });
  }
  return links;
}
