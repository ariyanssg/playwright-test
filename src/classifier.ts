import type { Classification } from './types.js';

export interface PageSignals {
  status: number | null;
  title: string;
  h1: string;
  mainText: string;
  redirectCount: number;
  requestedUrl?: string;
  /** Where the browser ended up, including client-side (script or meta refresh) redirects. */
  finalUrl?: string;
  error?: string | null;
  timedOut?: boolean;
}

export interface MissingBaseline {
  status: number | null;
  title: string;
  h1: string;
  mainText: string;
  tokens: Set<string>;
  looksMissing: boolean;
}

export interface ClassificationDecision {
  classification: Classification;
  confidence: number;
  reasons: string[];
}

/**
 * Phrases that only appear on missing-page templates. A bare "404" or "gone" is deliberately
 * absent: restaurants are named "404 Kitchen" and "Gone Fishing", and a brand name in every
 * title would otherwise turn a whole site into suspected soft 404s.
 */
const ERROR_PHRASE = new RegExp([
  String.raw`\b(?:page|file|url|content|document|article|item|product|post|menu)s?\s+(?:was\s+|could\s+not\s+be\s+|can(?:no|')t\s+be\s+)?not\s+found\b`,
  String.raw`\b404\s*(?:[-–—:|]\s*)?(?:error|not\s+found|page)\b`,
  String.raw`\berror\s*(?:[-–—:|]\s*)?404\b`,
  String.raw`\b410\s*(?:[-–—:|]\s*)?gone\b`,
  String.raw`^\s*not\s+found\b`,
  String.raw`\bpage\s+(?:does\s*n[o']t|doesn['’]t|no\s+longer)\s+exists?\b`,
  String.raw`\b(?:this|that|the)\s+page\s+(?:is\s+)?(?:no\s+longer\s+available|unavailable|(?:has\s+been\s+)?(?:removed|deleted))\b`,
  String.raw`\b(?:we\s+)?(?:can(?:no|['’])t|could\s*n[o']t|couldn['’]t|could\s+not)\s+(?:seem\s+to\s+)?find\s+(?:the|that|this|what)\s+(?:page|you)`,
  String.raw`\bnothing\s+(?:was\s+)?found\s+(?:here|at\s+this\s+location)\b`,
  String.raw`\bcontent\s+(?:is\s+)?unavailable\b`,
  String.raw`\b(?:you\s+seem\s+(?:a\s+(?:little|bit)\s+)?lost|you['’]re\s+lost|looks\s+like\s+you['’]re\s+lost)\b`,
].join('|'), 'i');

/** A title segment that is nothing but an error code ("404", "Error 404", "404 | Site"). */
const BARE_CODE_SEGMENT = /^(?:error\s*)?(?:404|410)(?:\s*error)?$/i;

/** Paths that legitimately resolve to the homepage. */
const HOME_ALIAS = /^\/(?:index\.(?:html?|php|aspx?|jsp)|default\.aspx?|home(?:page)?|welcome|[a-z]{2}(?:[-_][a-z]{2})?)\/?$/i;

/** The minimum shingle count a template comparison needs to mean anything. */
const MIN_TEMPLATE_SHINGLES = 3;

export function hasMissingSignal(text: string): boolean {
  if (!text) return false;
  if (ERROR_PHRASE.test(text)) return true;
  return text.split(/\s[|–—•·:]\s|\s-\s/).some((segment) => BARE_CODE_SEGMENT.test(segment.trim()) || ERROR_PHRASE.test(segment));
}

export function classifyPage(page: PageSignals, baseline?: MissingBaseline | null): ClassificationDecision {
  const reasons: string[] = [];
  if (page.timedOut) return { classification: 'timeout', confidence: 1, reasons: ['Navigation timed out'] };
  if (page.status === null) return { classification: 'network_error', confidence: 1, reasons: [page.error || 'No HTTP response'] };
  if (page.status === 404) return { classification: 'hard_404', confidence: 1, reasons: ['Final HTTP status is 404'] };
  if (page.status === 410) return { classification: 'gone_410', confidence: 1, reasons: ['Final HTTP status is 410'] };
  if ([401, 403, 407, 429, 451].includes(page.status)) {
    return { classification: 'blocked', confidence: 1, reasons: [`Final HTTP status is ${page.status}`] };
  }
  if (page.status >= 500) return { classification: 'server_error', confidence: 1, reasons: [`Final HTTP status is ${page.status}`] };

  if (page.status >= 200 && page.status < 300) {
    let score = 0;
    if (hasMissingSignal(page.title)) {
      score += 0.55;
      reasons.push('Page title contains a missing-page signal');
    }
    if (hasMissingSignal(page.h1)) {
      score += 0.55;
      reasons.push('Primary heading contains a missing-page signal');
    }
    if (ERROR_PHRASE.test(page.mainText.slice(0, 2_500))) {
      score += 0.3;
      reasons.push('Rendered main content contains a missing-page signal');
    }

    const clientRedirect = Boolean(page.finalUrl && page.requestedUrl && stripHash(page.finalUrl) !== stripHash(page.requestedUrl));
    const redirected = page.redirectCount > 0 || clientRedirect;
    if (redirected && redirectsToHomepage(page.requestedUrl, page.finalUrl)) {
      score += 0.65;
      reasons.push('A deep URL redirects to the homepage, which search engines treat as a soft 404');
    }

    const nonRoot = isNonRootPage(page.requestedUrl);
    // An empty or near-empty page is not evidence of anything: two empty sets are "identical"
    // to Jaccard, which used to flag every slow client-rendered page as a missing template.
    const pageTokens = tokenize(page.mainText);
    const comparable = baseline && baseline.tokens.size >= MIN_TEMPLATE_SHINGLES && pageTokens.size >= MIN_TEMPLATE_SHINGLES;
    if (comparable && baseline.looksMissing) {
      const similarity = jaccard(pageTokens, baseline.tokens);
      if (similarity >= 0.9) {
        score += 0.65;
        reasons.push(`Rendered content matches the site's missing-page template (${Math.round(similarity * 100)}%)`);
      } else if (similarity >= 0.75) {
        score += 0.45;
        reasons.push(`Rendered content resembles the site's missing-page template (${Math.round(similarity * 100)}%)`);
      }
    } else if (comparable && nonRoot && baseline.status && baseline.status >= 200 && baseline.status < 300) {
      const similarity = jaccard(pageTokens, baseline.tokens);
      if (similarity >= 0.95) {
        score += 0.65;
        reasons.push(`Rendered content matches the site's synthetic missing-path baseline (${Math.round(similarity * 100)}%)`);
      }
    }

    if (score >= 0.65) {
      return { classification: 'soft_404_suspected', confidence: Math.min(0.99, round(score)), reasons };
    }
    if (redirected) {
      return { classification: 'redirected', confidence: 1, reasons: [clientRedirect && !page.redirectCount ? 'Page script or meta refresh redirects to a successful page' : 'URL redirects to a successful page'] };
    }
    return { classification: 'ok', confidence: 1, reasons: ['Successful rendered page'] };
  }

  if (page.status >= 300 && page.status < 400) {
    return { classification: 'redirected', confidence: 0.8, reasons: ['Redirect response did not resolve to a final page'] };
  }
  return { classification: 'network_error', confidence: 0.7, reasons: [`Unexpected HTTP status ${page.status}`] };
}

function isNonRootPage(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).pathname !== '/';
  } catch {
    return false;
  }
}

/** True when a meaningful, non-home path on a site ends up on that same site's root. */
function redirectsToHomepage(requested: string | undefined, final: string | undefined): boolean {
  if (!requested || !final) return false;
  try {
    const from = new URL(requested);
    const to = new URL(final);
    if (to.pathname !== '/' || from.pathname === '/' || HOME_ALIAS.test(from.pathname)) return false;
    return from.hostname.replace(/^www\./, '') === to.hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

/** Canonical form for "did the browser move?" — fragments and a trailing slash are not moves. */
function stripHash(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return value.replace(/#.*$/, '').replace(/\/$/, '');
  }
}

export function makeBaseline(signals: PageSignals): MissingBaseline {
  const combined = `${signals.title} ${signals.h1} ${signals.mainText.slice(0, 2_500)}`;
  return {
    status: signals.status,
    title: signals.title,
    h1: signals.h1,
    mainText: signals.mainText,
    tokens: tokenize(signals.mainText),
    looksMissing: signals.status === 404 || signals.status === 410 || hasMissingSignal(signals.title) || hasMissingSignal(signals.h1) || ERROR_PHRASE.test(combined),
  };
}

export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const shingles = new Set<string>();
  for (let index = 0; index < words.length - 2; index += 1) {
    shingles.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return shingles;
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of small) if (large.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
