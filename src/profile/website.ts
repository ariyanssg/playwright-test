import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import robotsParser from 'robots-parser';
import { startPublicProxy } from '../hosted/network.js';
import { AUDITOR_USER_AGENT } from '../robots.js';
import { harvestHours, type HoursHarvest } from '../hours/harvest.js';
import { parseJsonLdHours } from '../hours/parse-jsonld.js';
import { parseMicrodataHours } from '../hours/parse-microdata.js';
import { parseTextHours } from '../hours/parse-text.js';
import { parseClockTime } from '../hours/schedule.js';
import { emptySnapshot, fact, first, SERVICES, validateHttpUrl, type ProfileTarget, type WebsiteSnapshot, type ServiceLink, type LinkCheck, type Service } from './model.js';
import { addressMatch, sameHost, textKey, phone } from './normalize.js';

export const servicePattern: Record<Service, RegExp> = {
  website: /website/i,
  menu: /\b(?:menus?|food menu|a la carte|dishes)\b/i,
  reservations: /\b(?:reservations?|reserve|book(?:ing)?(?: a)? table|table booking|book now)\b/i,
  ordering: /\b(?:order(?:ing)?(?: online| now)?|takeaway|takeout|delivery|click.{0,5}collect)\b/i,
};
export interface PageContent { title: string; body: string; names: string[]; addresses: string[]; phones: Array<{raw:string;value:string}>; links: Array<{url:string;label:string}>; headings: string[]; forms: string[]; frames: Array<{url:string;title:string}> }
/** Service and contact pages of one site read at once after the landing page. */
const CRAWL_PARALLEL_PAGES = 3;

/**
 * Waits while a page is still changing, up to `capMs`, instead of a fixed pause: booking and
 * ordering widgets often render late, but a server-rendered page is ready immediately. The
 * callback is inline with no named functions (see hours/harvest.ts on the `__name` trap).
 */
async function settle(page: Page, capMs: number): Promise<void> {
  await page.waitForFunction(({ stableMs }) => {
    const text = document.body?.innerText || '';
    const holder = window as unknown as { __seo404Link?: { length: number; since: number } };
    const now = performance.now();
    if (!holder.__seo404Link || holder.__seo404Link.length !== text.length) {
      holder.__seo404Link = { length: text.length, since: now };
      return false;
    }
    return document.readyState === 'complete' && text.length > 0 && now - holder.__seo404Link.since >= stableMs;
  }, { stableMs: 400 }, { timeout: Math.max(250, capMs), polling: 100 }).catch(() => undefined);
}

export interface WebsiteOptions { pageLimit: number; timeoutMs: number; hostDelayMs: number; signal?: AbortSignal }

/** Test transport is constructor-only: API callers cannot turn off the public-network guard. */
export class ProfileBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private proxy?: Awaited<ReturnType<typeof startPublicProxy>>;
  private robots = new Map<string, { allowed: (url: string) => boolean; delay: number; sitemaps: string[] }>();
  private checked = new Map<string, Promise<LinkCheck>>();
  private lastStart = new Map<string, Promise<number>>();
  private abort?: () => void;
  constructor(private options: WebsiteOptions, private testAllowLocal = false) {}
  private initializing?: Promise<BrowserContext>;
  /** Idempotent under concurrent callers, which parallel page and link checks now are. */
  private init(): Promise<BrowserContext> {
    this.options.signal?.throwIfAborted();
    this.initializing ??= this.launch().catch(error => { this.initializing = undefined; throw error; });
    return this.initializing;
  }
  private async launch(): Promise<BrowserContext> {
    if (!this.testAllowLocal) this.proxy = await startPublicProxy();
    this.browser = await chromium.launch({ headless: true, proxy: this.proxy ? { server: this.proxy.server } : undefined, args: this.proxy ? ['--proxy-bypass-list=<-loopback>'] : [] });
    this.context = await this.browser.newContext({ userAgent: AUDITOR_USER_AGENT, serviceWorkers: 'block', acceptDownloads: false });
    await this.context.route('**/*', async route => {
      const r = route.request();
      let hops = 0; for (let prev = r.redirectedFrom(); prev; prev = prev.redirectedFrom()) hops++;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) || ['media', 'font'].includes(r.resourceType()) || hops > 10) await route.abort();
      else await route.continue();
    });
    this.abort = () => { void this.browser?.close().catch(() => {}); };
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    return this.context;
  }
  private async policy(url: string): Promise<{ allowed: (url: string) => boolean; delay: number; sitemaps: string[] }> {
    const origin = new URL(url).origin, cached = this.robots.get(origin); if (cached) return cached;
    const context = await this.init();
    const response = await context.request.get(`${origin}/robots.txt`, { timeout: this.options.timeoutMs, maxRedirects: 10 });
    let policy;
    if ([404, 410].includes(response.status())) policy = { allowed: () => true, delay: this.options.hostDelayMs, sitemaps: [] };
    else if (!response.ok()) policy = { allowed: () => false, delay: 0, sitemaps: [] };
    else {
      const parsed = (robotsParser as unknown as (url: string, content: string) => { isAllowed: (url: string, agent: string) => boolean | undefined; getCrawlDelay: (agent: string) => number | undefined; getSitemaps: () => string[] })(`${origin}/robots.txt`, (await response.text()).slice(0, 500000));
      policy = { allowed: (u: string) => parsed.isAllowed(u, AUDITOR_USER_AGENT) !== false, delay: Math.max(this.options.hostDelayMs, (parsed.getCrawlDelay(AUDITOR_USER_AGENT) || 0) * 1000), sitemaps: parsed.getSitemaps() };
    }
    await response.dispose(); this.robots.set(origin, policy); return policy;
  }
  private async page(url: string): Promise<Page> {
    validateHttpUrl(url); const context = await this.init();
    const policy = await this.policy(url);
    if (!policy.allowed(url)) throw new Error('Blocked by robots.txt or robots unavailable');
    const page = await context.newPage();
    await this.pace(new URL(url).host, Math.min(policy.delay, 30000)); return page;
  }
  /** Spaces page starts per host by the robots/host delay, without sleeping before every page. */
  private async pace(host: string, delay: number): Promise<void> {
    const previous = this.lastStart.get(host) ?? Promise.resolve(0);
    const turn = previous.then(async last => {
      const wait = Math.max(0, last + delay - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      return Date.now();
    });
    this.lastStart.set(host, turn);
    await turn;
  }
  async crawl(target: ProfileTarget, suppliedPages: string[] = []): Promise<WebsiteSnapshot> {
    const out: WebsiteSnapshot = { ...emptySnapshot('website'), source: 'website', pages: [], finalUrl: target.url };
    const queue = [{ url: target.url, depth: 0 }], seen = new Set<string>();
    let incomplete = false;
    // Candidate URLs are already discovered. Do not guess menu/booking endpoints.
    for (const url of suppliedPages.filter(u => sameHost(u, target.url) && /contact|hours|menu|reserv|book|order/i.test(u))) queue.push({ url, depth: 1 });
    try {
      const policy = await this.policy(target.url), context = await this.init();
      for (const sitemap of policy.sitemaps.slice(0, 3)) {
        if (!sameHost(sitemap, target.url)) continue;
        const response = await context.request.get(sitemap, { timeout: this.options.timeoutMs, maxRedirects: 10 });
        if (response.ok()) {
          const text = (await response.text()).slice(0, 1000000);
          for (const match of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
            const url = match[1]!.replace(/&amp;/g, '&');
            if (sameHost(url, target.url) && /contact|hours|menu|reserv|book|order/i.test(url) && !/\.xml(?:$|\?)/i.test(url)) queue.push({ url, depth: 1 });
          }
        } else incomplete = true;
        await response.dispose();
      }
    } catch { incomplete = true; out.warnings.push('Robots or sitemap discovery was unavailable'); }
    // Pages load a few at a time, but their evidence is applied in queue order, so which page's
    // value comes "first" never depends on network timing. The landing page runs alone because
    // it fixes the final host every later link is filtered against.
    while (queue.length && seen.size < this.options.pageLimit) {
      if (this.options.signal?.aborted) { incomplete = true; break; }
      const batch: Array<{ url: string; depth: number }> = [];
      const width = out.pages.length ? CRAWL_PARALLEL_PAGES : 1;
      while (queue.length && batch.length < width && seen.size < this.options.pageLimit) {
        const item = queue.shift()!;
        const key = item.url.replace(/#.*$/, ''); if (seen.has(key)) continue; seen.add(key);
        batch.push(item);
      }
      const loaded = await Promise.all(batch.map(async item => {
        let page: Page | undefined;
        try {
          page = await this.page(item.url);
          const harvest = await harvestHours(page, item.url, this.options.timeoutMs);
          if (harvest.error || !harvest.status || harvest.status >= 400) throw new Error(harvest.error || `HTTP ${harvest.status}`);
          const content = await readContent(page);
          if (!content.body.trim()) throw new Error('No rendered content');
          return { item, harvest, content, finalUrl: page.url() };
        } catch (error) { return { item, error: error instanceof Error ? error.message : 'page failure' }; }
        finally { await page?.close().catch(() => {}); }
      }));
      for (const result of loaded) {
        if ('error' in result) { incomplete = true; out.warnings.push(`Could not inspect ${result.item.url}: ${result.error}`); continue; }
        const { item, harvest, content } = result;
        if (out.pages.length === 0) { out.finalUrl = result.finalUrl; fact(out, 'website', result.finalUrl, item.url, 'resolved website landing page'); }
        out.pages.push(item.url);
        extract(out, harvest, content, target);
        for (const link of content.links) {
          if (!sameHost(link.url, out.finalUrl) || !/^https?:/.test(link.url) || /\.(?:pdf|jpg|png|zip)(?:$|[?#])/i.test(link.url)) continue;
          if (item.depth < 2 && /contact|about|hours|menu|reserv|book|order|location/i.test(`${link.label} ${link.url}`)) queue.push({ url: link.url, depth: item.depth + 1 });
        }
      }
    }
    if (queue.some(i => !seen.has(i.url.replace(/#.*$/, '')))) { incomplete = true; out.warnings.push('Website discovery page budget reached'); }
    out.links = out.links.filter((l, i, all) => all.findIndex(x => x.service === l.service && x.url === l.url) === i);
    for (const field of ['name', 'phone', 'website', 'hours', 'special_hours', ...SERVICES.map(s => `services.${s}`)]) {
      if (out.coverage[field]?.state === 'present') continue;
      out.coverage[field] = { state: incomplete ? 'partial' : 'not_found', reason: `${incomplete ? 'Incomplete discovery' : 'Not found'} across ${out.pages.length} rendered pages; scope: linked service/contact pages to depth 2` };
    }
    return out;
  }
  check(link: ServiceLink, target: ProfileTarget, website: WebsiteSnapshot): Promise<LinkCheck> {
    const key = `${link.service}|${link.url}`;
    let pending = this.checked.get(key);
    if (!pending) { pending = this.checkLink(link, target, website); this.checked.set(key, pending); }
    return pending.then(result => ({ ...result, ...link }));
  }
  private async checkLink(link: ServiceLink, target: ProfileTarget, website: WebsiteSnapshot): Promise<LinkCheck> {
    const result: LinkCheck = { ...link, finalUrl: link.url, httpStatus: null, redirectChain: [], health: 'unverified', serviceReady: null, correctBranch: null, transactionTested: false, reason: '', checkedAt: new Date().toISOString() };
    let page: Page | undefined;
    try {
      page = await this.page(link.url);
      // PDFs need document validation; Chromium may download instead of navigating.
      if (/\.pdf(?:$|[?#])/i.test(link.url) && link.service === 'menu') {
        const response = await this.context!.request.get(link.url, { timeout: this.options.timeoutMs, maxRedirects: 10 });
        result.httpStatus = response.status(); result.finalUrl = response.url();
        const size = Number(response.headers()['content-length'] || 0);
        if (size > 10_000_000) throw new Error('Menu document exceeds 10 MB');
        const body = await response.body();
        result.health = response.ok() && body.subarray(0, 5).toString() === '%PDF-' ? 'functional' : response.status() === 404 ? 'hard_404' : 'unverified';
        result.serviceReady = result.health === 'functional';
        result.correctBranch = sameHost(result.finalUrl, website.finalUrl) ? true : null;
        if (result.correctBranch === null && result.health === 'functional') result.health = 'unverified';
        result.reason = 'PDF signature checked; off-site document branch identity requires review';
        await response.dispose(); return result;
      }
      const response = await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
      await settle(page, Math.min(1_500, this.options.timeoutMs / 4));
      result.httpStatus = response?.status() ?? null; result.finalUrl = page.url();
      for (let req = response?.request() ?? null; req; req = req.redirectedFrom()) {
        const res = await req.response(); result.redirectChain.unshift({ url: req.url(), status: res?.status() ?? null, location: res?.headers()['location'] });
      }
      const content = await readContent(page);
      for (const frame of page.frames().slice(1, 6)) {
        try { content.body += '\n' + (await frame.locator('body').innerText({ timeout: 2000 })).slice(0, 10000); content.forms.push(...await frame.locator('input,select').evaluateAll(nodes => nodes.map(n => n.getAttribute('type') || n.getAttribute('name') || 'input'))); } catch { /* Embedded blocked UI remains unverified. */ }
      }
      const status = result.httpStatus;
      if (status === 404) result.health = 'hard_404';
      else if (status === 410) result.health = 'gone_410';
      else if ([401, 403, 429].includes(status || 0) || /verify you are human|captcha|access denied|checking your browser/i.test(content.body)) result.health = 'blocked';
      else if (status && status >= 500) result.health = 'server_error';
      else if (!status || status >= 400) result.health = 'unverified';
      else if (/page not found|page does not exist|domain (?:is )?for sale|404 not found/i.test(`${content.title} ${content.headings.join(' ')} ${content.body.slice(0, 500)}`)) result.health = 'soft_404_suspected';
      else {
        const expectedName = target.name || first<string>(website, 'name') || '';
        const expectedAddress = target.address || first<string>(website, 'address') || '';
        const bodyKey = textKey(content.body), nameKey = textKey(expectedName);
        result.correctBranch = sameHost(result.finalUrl, website.finalUrl) || Boolean(expectedAddress && bodyKey.includes(textKey(expectedAddress))) ? true : null;
        // A shared brand name alone cannot establish the branch on a third-party site.
        const expectedPhone = phone(first<string>(website, 'phone') || '');
        if (result.correctBranch !== true && nameKey && bodyKey.includes(nameKey) && expectedPhone && content.phones.some(p => phone(p.value) === expectedPhone)) result.correctBranch = true;
        if (expectedAddress && content.addresses.length && content.addresses.every(a => !addressMatch(a, expectedAddress))) result.correctBranch = false;
        if (content.names.length && nameKey && content.names.every(n => textKey(n) !== nameKey) && !bodyKey.includes(nameKey)) result.correctBranch = false;
        const scopedText = `${content.headings.join(' ')} ${content.body}`;
        const menuReady = /(?:£|€|\$)\s*\d|\b(?:starters|main courses|desserts|appetizers|biryani|curries)\b/i.test(content.body);
        const bookingReady = /date|time|guests|party|people|covers/i.test(content.forms.join(' ')) && /reserv|book|table/i.test(scopedText);
        const orderReady = /add to (?:basket|cart)|choose (?:delivery|collection)|start (?:your )?order|checkout|view basket/i.test(content.body);
        result.serviceReady = link.service === 'website' ? content.body.trim().length > 20 : link.service === 'menu' ? menuReady : link.service === 'reservations' ? bookingReady : orderReady;
        // A confirmed branch that served a real page is never a broken destination. When the
        // service interface cannot be recognized there, the page is unverified, not wrong:
        // calling a restaurant's own working menu page "wrong destination" is a false alarm.
        result.health = result.correctBranch === false ? 'wrong_location'
          : result.serviceReady && result.correctBranch === true ? 'functional'
          : /temporarily unavailable|not accepting (?:orders|reservations)/i.test(content.body) ? 'temporarily_unavailable'
          : result.correctBranch === true || content.frames.length ? 'unverified'
          : 'wrong_destination';
      }
      result.reason = result.health === 'functional' ? 'Correct restaurant and service interface observed; no transaction submitted'
        : result.health === 'unverified' && result.correctBranch === true ? `Reached the correct restaurant (HTTP ${status ?? 'unknown'}), but the ${link.service} interface could not be confirmed automatically. Open the page to check it yourself.`
        : `${result.health.replaceAll('_', ' ')}; HTTP ${status ?? 'unknown'}, service readiness ${result.serviceReady ?? 'unknown'}, branch ${result.correctBranch ?? 'unknown'}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.health = /timeout|timed out/i.test(message) ? 'timeout' : /blocked|robots/i.test(message) ? 'blocked' : 'network_error';
      result.reason = message.slice(0, 500);
    } finally { await page?.close().catch(() => {}); }
    return result;
  }
  async close(): Promise<void> {
    if (this.abort) this.options.signal?.removeEventListener('abort', this.abort);
    await this.browser?.close().catch(() => {}); await this.proxy?.close(); this.browser = undefined; this.context = undefined; this.initializing = undefined;
  }
}

async function readContent(page: Page): Promise<PageContent> {
  return page.evaluate(() => ({
    title: document.title,
    body: document.body?.innerText.slice(0, 60000) || '',
    names: Array.from(document.querySelectorAll('[itemprop="name"],meta[property="og:site_name"]')).slice(0, 10).map(n => n.getAttribute('content') || n.textContent?.trim() || '').filter(Boolean),
    addresses: Array.from(document.querySelectorAll('address,[itemprop="address"]')).slice(0, 10).map(n => (n as HTMLElement).innerText?.trim() || '').filter(Boolean),
    phones: Array.from(document.querySelectorAll('a[href^="tel:"]')).slice(0, 20).map(n => ({ raw: n.textContent?.trim() || '', value: (n.getAttribute('href') || '').slice(4) })),
    links: Array.from(document.querySelectorAll('a[href]')).slice(0, 1000).map(n => ({ url: (n as HTMLAnchorElement).href, label: `${n.textContent || ''} ${n.getAttribute('aria-label') || ''}`.trim().slice(0, 300) })),
    headings: Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]')).slice(0, 50).map(n => n.textContent?.trim() || ''),
    forms: Array.from(document.querySelectorAll('input,select,button')).slice(0, 100).map(n => `${n.getAttribute('name') || ''} ${n.getAttribute('type') || ''} ${n.getAttribute('aria-label') || ''} ${n.textContent?.slice(0, 100) || ''}`),
    frames: Array.from(document.querySelectorAll('iframe')).slice(0, 10).map(n => ({ url: n.src, title: n.title })),
  }));
}

export function extract(out: WebsiteSnapshot, harvest: HoursHarvest, content: PageContent, target: ProfileTarget): void {
  const url = harvest.finalUrl;
  const nodes: Record<string, any>[] = [];
  for (const script of harvest.jsonLd) {
    try {
      const queue = [JSON.parse(script)];
      for (let count = 0; queue.length && count < 2000; count++) {
        const value = queue.shift(); if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) { queue.push(...value); continue; }
        if (/restaurant|foodestablishment|localbusiness|cafeorcoffeeshop/i.test([value['@type']].flat().join(' '))) nodes.push(value);
        queue.push(...Object.values(value).filter(v => v && typeof v === 'object'));
      }
    } catch { out.warnings.push(`Invalid JSON-LD on ${url}`); }
  }
  const selected = nodes.filter(n => !target.name || !n.name || textKey(n.name) === textKey(target.name));
  for (const node of selected) {
    for (const [field, value] of Object.entries({ name: node.name, phone: node.telephone, website: node.url, address: typeof node.address === 'string' ? node.address : node.address ? [node.address.streetAddress, node.address.addressLocality, node.address.postalCode].filter(Boolean).join(', ') : null })) if (typeof value === 'string') fact(out, field, value, url, `JSON-LD ${field}`);
    for (const value of [node.hasMenu || node.menu].flat()) if (typeof value === 'string') { try { out.links.push({ service: 'menu', url: new URL(value, url).href, label: 'Structured menu', source: 'website' }); } catch {} }
    const exceptions: Record<string, Array<{start:number;end:number}>> = {};
    for (const spec of [node.specialOpeningHoursSpecification || []].flat()) {
      if (!spec?.validFrom || !/^\d{4}-\d{2}-\d{2}$/.test(spec.validFrom)) continue;
      const open = parseClockTime(spec.opens), close = parseClockTime(spec.closes);
      if (open === null || close === null) continue;
      const start = Date.parse(spec.validFrom), end = Date.parse(spec.validThrough || spec.validFrom);
      for (let date = start; date <= end && date - start < 366 * 86400000; date += 86400000) {
        const key = new Date(date).toISOString().slice(0, 10);
        exceptions[key] ??= [];
        if (open !== 0 || close !== 0) exceptions[key]!.push({ start: open, end: close <= open ? close + 1440 : close });
      }
    }
    if (Object.keys(exceptions).length) fact(out, 'special_hours', exceptions, url, 'JSON-LD specialOpeningHoursSpecification');
  }
  if (!selected.some(n => n.name)) for (const name of content.names.slice(0, 2)) fact(out, 'name', name, url, 'visible branding / og:site_name', name, 'medium');
  // A page heading is only identity evidence when it resembles the supplied restaurant name.
  if (!out.facts.some(f => f.field === 'name') && target.name && content.headings.some(h => textKey(h) === textKey(target.name!))) fact(out, 'name', content.headings.find(h => textKey(h) === textKey(target.name!))!, url, 'visible heading');
  for (const address of content.addresses) fact(out, 'address', address, url, 'address element', address, 'medium');
  for (const p of content.phones) fact(out, 'phone', phone(p.raw) ? p.raw : p.value, url, 'tel: anchor', p.raw || p.value, 'medium');
  const validNodes = selected.map(node => ({ ...node, openingHoursSpecification: [node.openingHoursSpecification || []].flat().filter(spec => {
    const valid = spec && parseClockTime(spec.opens) !== null && parseClockTime(spec.closes) !== null;
    if (!valid) out.warnings.push(`Invalid structured hours on ${url}; incomplete times are not treated as closed`);
    return valid;
  }) }));
  const validMicrodata = { ...harvest.microdata, specs: harvest.microdata.specs.filter(s => parseClockTime(s.opens) !== null && parseClockTime(s.closes) !== null) };
  // Within one page the most structured layer wins outright, as in the hours comparison: a
  // footer read as text next to exact JSON-LD is not a second opinion, and treating the two as
  // rival sources raised "website disagrees with itself" conflicts that were only parse noise.
  const structured = parseJsonLdHours(validNodes.map(n => JSON.stringify(n)));
  const microdata = structured.length ? null : parseMicrodataHours(validMicrodata);
  const text = structured.length || microdata ? null : parseTextHours(harvest.textBlocks.length ? harvest.textBlocks : [content.body]);
  const hours = structured.length ? structured : [microdata ?? text].filter(x => x !== null);
  for (const h of hours) fact(out, 'hours', h.weekly, url, h.method, h.raw.join('; '), h.confidence);
  for (const service of SERVICES) {
    const links = [...content.links, ...content.frames.map(f => ({ url: f.url, label: f.title }))].filter(l => servicePattern[service].test(`${l.label} ${new URL(l.url, url).pathname}`) && /^https?:/.test(l.url));
    out.links.push(...links.map(l => ({ service, url: l.url, label: l.label, source: 'website' as const })));
    if (!links.length && content.headings.some(h => servicePattern[service].test(h))) out.links.push({ service, url, label: `${service} section`, source: 'website' });
    if (out.links.some(l => l.service === service)) out.coverage[`services.${service}`] = { state: 'present', reason: 'Service link or visible section found' };
  }
}
