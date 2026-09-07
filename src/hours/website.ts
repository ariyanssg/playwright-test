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
    identity: parseJsonLdIdentity(harvest.jsonLd) ?? identityFromTitle(harvest.title),
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
    identity: pages.find((page) => page.identity)?.identity ?? null,
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

/** Last resort when a site publishes no structured identity at all. */
function identityFromTitle(title: string): SiteIdentity | null {
  const name = title
    .split(/[|–—]|(?: - )/)
    .map((part) => part.trim())
    .find((part) => part.length > 2 && !/^(?:home|official site|welcome|restaurant website)$/i.test(part));
  return name ? { name, address: null, telephone: null } : null;
}
