import type { HoursMethod, WeeklyHours } from '../types.js';
import type { HoursHarvest } from './harvest.js';
import { CONFIDENCE_RANK, type HoursCandidate, type HoursConfidence, type SiteIdentity } from './model.js';
import { parseJsonLdHours, parseJsonLdIdentity } from './parse-jsonld.js';
import { parseMicrodataHours } from './parse-microdata.js';
import { parseTextHours } from './parse-text.js';

export interface PageExtraction {
  url: string;
  score: number;
  candidate: HoursCandidate | null;
  alternateMethods: HoursMethod[];
  identity: SiteIdentity | null;
  title: string;
}

export interface WebsiteHoursExtraction {
  weekly: WeeklyHours | null;
  method: HoursMethod;
  confidence: HoursConfidence | null;
  sourceUrl: string | null;
  raw: string[];
  alternateMethods: HoursMethod[];
  identity: SiteIdentity | null;
  pagesInspected: number;
  pagesWithHours: number;
  /** Pages that could not be read at all, surfaced so a silent failure stays visible. */
  pageErrors: string[];
}

/**
 * Reads one page. The highest-confidence layer that produced anything wins
 * outright - unioning a partial JSON-LD specification with text guesses would
 * fabricate intervals that appear in neither source.
 */
export function extractPageHours(harvest: HoursHarvest, url: string, score: number): PageExtraction {
  const jsonLd = bestOf(parseJsonLdHours(harvest.jsonLd));
  const microdata = parseMicrodataHours(harvest.microdata);
  const blocks = harvest.textBlocks.length ? harvest.textBlocks : harvest.bodyText ? [harvest.bodyText] : [];
  const text = parseTextHours(blocks);

  const found = [jsonLd, microdata, text].filter((item): item is HoursCandidate => item !== null);
  const candidate = found.reduce<HoursCandidate | null>((best, item) => (
    !best || CONFIDENCE_RANK[item.confidence] > CONFIDENCE_RANK[best.confidence] ? item : best
  ), null);

  return {
    url,
    score,
    candidate,
    alternateMethods: found.filter((item) => item !== candidate).map((item) => item.method),
    identity: structuredIdentity(harvest.jsonLd) ?? identityFromTitle(harvest.title, url),
    title: harvest.title,
  };
}

/**
 * Picks one page's hours for the whole site. Results are never unioned across
 * pages: different pages routinely describe different locations.
 */
export function chooseWebsiteHours(pages: readonly PageExtraction[], pageErrors: readonly string[] = []): WebsiteHoursExtraction {
  const withHours = pages.filter((page) => page.candidate);
  const best = withHours.reduce<PageExtraction | null>((winner, page) => {
    if (!winner) return page;
    const left = CONFIDENCE_RANK[page.candidate!.confidence];
    const right = CONFIDENCE_RANK[winner.candidate!.confidence];
    if (left !== right) return left > right ? page : winner;
    // A page covering the whole week beats a higher-ranked page with a partial one:
    // a homepage often lists weekday hours while /hours carries the authoritative set.
    const stated = page.candidate!.weekly.statedDays.length;
    const winnerStated = winner.candidate!.weekly.statedDays.length;
    if (stated !== winnerStated) return stated > winnerStated ? page : winner;
    return page.score > winner.score ? page : winner;
  }, null);

  return {
    weekly: best?.candidate?.weekly ?? null,
    method: best?.candidate?.method ?? 'none',
    confidence: best?.candidate?.confidence ?? null,
    sourceUrl: best?.url ?? null,
    raw: best?.candidate?.raw ?? [],
    alternateMethods: best?.alternateMethods ?? [],
    // Structured data on any page beats a name guessed from the first page's title.
    identity: pages.find((page) => page.identity && page.identity.source !== 'title')?.identity ?? pages.find((page) => page.identity)?.identity ?? null,
    pagesInspected: pages.length,
    pagesWithHours: withHours.length,
    pageErrors: [...pageErrors],
  };
}

function bestOf(candidates: readonly HoursCandidate[]): HoursCandidate | null {
  return candidates.reduce<HoursCandidate | null>((best, item) => (
    !best || item.weekly.statedDays.length > best.weekly.statedDays.length ? item : best
  ), null);
}

function structuredIdentity(scripts: readonly string[]): SiteIdentity | null {
  const identity = parseJsonLdIdentity(scripts);
  return identity ? { ...identity, source: 'structured' } : null;
}

const GENERIC_TITLE = /^(?:home(?:\s*page)?|official site|welcome|restaurant website|menu|contact(?: us)?|about(?: us)?)$/i;

/**
 * Last resort when a site publishes no structured identity at all. Titles mix the brand with a
 * slogan ("Best Indian in Soho | Spice Garden"), so the segment that resembles the site's own
 * domain is the name; without one, the first segment that is not a generic page word is used.
 */
function identityFromTitle(title: string, url: string): SiteIdentity | null {
  const parts = title.split(/[|–—·:]|(?: - )/).map((part) => part.trim()).filter((part) => part.length > 2 && !GENERIC_TITLE.test(part));
  let label = '';
  try { label = new URL(url).hostname.replace(/^www\./, '').split('.')[0]!.replace(/[^a-z0-9]/gi, '').toLowerCase(); } catch { /* No host to compare with. */ }
  const compact = (part: string) => part.toLowerCase().replace(/[^a-z0-9]/g, '');
  const byDomain = label.length > 2 ? parts.find((part) => { const key = compact(part); return key.length > 2 && (label.includes(key) || key.includes(label)); }) : undefined;
  const name = byDomain ?? parts[0];
  return name ? { name, address: null, telephone: null, source: 'title' } : null;
}
