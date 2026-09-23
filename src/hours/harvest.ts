import { errors, type Page } from 'playwright';
import type { MicrodataHours } from './model.js';

export interface HoursHarvest {
  url: string;
  finalUrl: string;
  status: number | null;
  title: string;
  /** Raw `application/ld+json` payloads; parsing happens in Node. */
  jsonLd: string[];
  microdata: MicrodataHours;
  /** Innermost page fragments that mention a day of the week. */
  textBlocks: string[];
  bodyText: string;
  error: string | null;
}

const MAX_JSON_LD_SCRIPTS = 64;
const MAX_JSON_LD_BYTES = 200_000;
const MAX_TEXT_BLOCKS = 40;
const MAX_BLOCK_CHARS = 400;
const MAX_BODY_CHARS = 20_000;

const BLOCK_SELECTOR = '[class*="hour" i], [id*="hour" i], [class*="open" i], [id*="open" i], dl, table, footer, address, li, p, time';

/**
 * Loads a page and pulls out the raw material for hours extraction. The browser
 * side only selects and caps strings - every interpretation happens in the pure
 * parsers so it can be tested without Playwright.
 *
 * The evaluated function deliberately declares no named inner functions: the
 * dev-time TypeScript loader rewrites those into `__name(...)` calls that do not
 * exist in the page, which would make every extraction silently return nothing.
 */
export async function harvestHours(page: Page, url: string, timeoutMs: number): Promise<HoursHarvest> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Structured hours or a rendered "Mon … 11am" line means the page is ready now. Otherwise
    // wait only while the page is still changing, instead of a fixed pause on every page.
    await page.waitForFunction(({ stableMs }) => {
      if (document.querySelector('[itemprop="openingHours"], [itemtype$="OpeningHoursSpecification"]')) return true;
      if (Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((node) => /openingHours/i.test(node.textContent || ''))) return true;
      const text = document.body?.innerText || '';
      if (/\b(?:mon|tue|wed|thu|fri|sat|sun|daily)[a-z]*\.?\b[^\n]{0,40}\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m|p\.m)?\s*[-–—]/i.test(text)) return true;
      const holder = window as unknown as { __seo404Harvest?: { length: number; since: number } };
      const now = performance.now();
      if (!holder.__seo404Harvest || holder.__seo404Harvest.length !== text.length) {
        holder.__seo404Harvest = { length: text.length, since: now };
        return false;
      }
      return document.readyState === 'complete' && now - holder.__seo404Harvest.since >= stableMs;
    }, { stableMs: 400 }, { timeout: Math.min(1_500, Math.max(250, Math.floor(timeoutMs / 4))), polling: 100 }).catch(() => undefined);
    let evaluateError: string | null = null;
    const content = await page.evaluate(({ selector, maxScripts, maxJsonBytes, maxBlocks, maxBlockChars, maxBodyChars }) => {
      const jsonLd: string[] = [];
      let budget = maxJsonBytes;
      for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, maxScripts)) {
        const text = node.textContent || '';
        if (!text.trim() || text.length > budget) continue;
        budget -= text.length;
        jsonLd.push(text);
      }

      const openingHours = Array.from(document.querySelectorAll('[itemprop="openingHours"]'))
        .slice(0, maxBlocks)
        .map((node) => (node.getAttribute('content') || node.getAttribute('datetime') || node.textContent || '').trim())
        .filter(Boolean);

      const specs = Array.from(document.querySelectorAll('[itemtype$="OpeningHoursSpecification"]'))
        .slice(0, maxBlocks)
        .map((scope) => ({
          days: Array.from(scope.querySelectorAll('[itemprop="dayOfWeek"]'))
            .map((node) => (node.getAttribute('content') || node.getAttribute('datetime') || node.textContent || '').trim())
            .filter(Boolean),
          opens: (Array.from(scope.querySelectorAll('[itemprop="opens"]'))
            .map((node) => (node.getAttribute('content') || node.getAttribute('datetime') || node.textContent || '').trim())
            .filter(Boolean))[0] || '',
          closes: (Array.from(scope.querySelectorAll('[itemprop="closes"]'))
            .map((node) => (node.getAttribute('content') || node.getAttribute('datetime') || node.textContent || '').trim())
            .filter(Boolean))[0] || '',
        }))
        .filter((spec) => spec.days.length);

      const dayHint = /\b(?:mon|tue|wed|thu|fri|sat|sun|daily|every ?day)/i;
      const matched = Array.from(document.querySelectorAll(selector)).filter((element) => {
        const text = (element instanceof HTMLElement ? element.innerText : element.textContent) || '';
        return text.trim().length > 0 && text.length < maxBlockChars && dayHint.test(text);
      });
      // Prefer the innermost match so one footer does not swallow every line inside it.
      const textBlocks = matched
        .filter((element) => !matched.some((other) => other !== element && element.contains(other)))
        .slice(0, maxBlocks)
        .map((element) => (element instanceof HTMLElement ? element.innerText : element.textContent) || '');

      const main = document.querySelector('main, [role="main"], article') ?? document.body;
      const body = main ? ((main instanceof HTMLElement ? main.innerText : main.textContent) || '') : '';
      return { title: document.title || '', jsonLd, microdata: { openingHours, specs }, textBlocks, bodyText: body.slice(0, maxBodyChars) };
    }, {
      selector: BLOCK_SELECTOR,
      maxScripts: MAX_JSON_LD_SCRIPTS,
      maxJsonBytes: MAX_JSON_LD_BYTES,
      maxBlocks: MAX_TEXT_BLOCKS,
      maxBlockChars: MAX_BLOCK_CHARS,
      maxBodyChars: MAX_BODY_CHARS,
    }).catch((error: unknown) => {
      // Never fail silently here: an empty harvest looks identical to a site with no hours.
      evaluateError = error instanceof Error ? error.message : String(error);
      return emptyContent();
    });

    return {
      url,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      error: evaluateError,
      ...content,
      textBlocks: content.textBlocks.map(normalizeText),
      bodyText: normalizeText(content.bodyText),
    };
  } catch (error) {
    const timedOut = error instanceof errors.TimeoutError;
    return {
      url,
      finalUrl: url,
      status: null,
      error: timedOut ? `Timed out loading ${url}` : error instanceof Error ? error.message : String(error),
      ...emptyContent(),
    };
  }
}

/** Collapses runs of spaces and blank lines while keeping the line breaks hours rely on. */
function normalizeText(value: string): string {
  return value.replace(/[^\S\n]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

function emptyContent(): { title: string; jsonLd: string[]; microdata: MicrodataHours; textBlocks: string[]; bodyText: string } {
  return { title: '', jsonLd: [], microdata: { openingHours: [], specs: [] }, textBlocks: [], bodyText: '' };
}
