import type { Classification } from './types.js';

export interface PageSignals {
  status: number | null;
  title: string;
  h1: string;
  mainText: string;
  redirectCount: number;
  requestedUrl?: string;
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

const STRONG_ERROR = /\b(404|410|page not found|not found|page doesn['’]?t exist|page does not exist|nothing here|content (?:is )?unavailable|gone)\b/i;

export function classifyPage(page: PageSignals, baseline?: MissingBaseline | null): ClassificationDecision {
  const reasons: string[] = [];
  if (page.timedOut) return { classification: 'timeout', confidence: 1, reasons: ['Navigation timed out'] };
  if (page.status === null) return { classification: 'network_error', confidence: 1, reasons: [page.error || 'No HTTP response'] };
  if (page.status === 404) return { classification: 'hard_404', confidence: 1, reasons: ['Final HTTP status is 404'] };
  if (page.status === 410) return { classification: 'gone_410', confidence: 1, reasons: ['Final HTTP status is 410'] };
  if ([401, 403, 429].includes(page.status)) {
    return { classification: 'blocked', confidence: 1, reasons: [`Final HTTP status is ${page.status}`] };
  }
  if (page.status >= 500) return { classification: 'server_error', confidence: 1, reasons: [`Final HTTP status is ${page.status}`] };

  if (page.status >= 200 && page.status < 300) {
    let score = 0;
    if (STRONG_ERROR.test(page.title)) {
      score += 0.55;
      reasons.push('Page title contains a missing-page signal');
    }
    if (STRONG_ERROR.test(page.h1)) {
      score += 0.55;
      reasons.push('Primary heading contains a missing-page signal');
    }
    const mainPrefix = page.mainText.slice(0, 2_500);
    if (STRONG_ERROR.test(mainPrefix)) {
      score += 0.3;
      reasons.push('Rendered main content contains a missing-page signal');
    }

    if (baseline?.looksMissing) {
      const similarity = jaccard(tokenize(page.mainText), baseline.tokens);
      if (similarity >= 0.9) {
        score += 0.65;
        reasons.push(`Rendered content matches the site's missing-page template (${Math.round(similarity * 100)}%)`);
      } else if (similarity >= 0.75) {
        score += 0.45;
        reasons.push(`Rendered content resembles the site's missing-page template (${Math.round(similarity * 100)}%)`);
      }
    } else if (isNonRootPage(page.requestedUrl) && baseline && baseline.status && baseline.status >= 200 && baseline.status < 300 && baseline.tokens.size >= 3) {
      const similarity = jaccard(tokenize(page.mainText), baseline.tokens);
      if (similarity >= 0.95) {
        score += 0.65;
        reasons.push(`Rendered content matches the site's synthetic missing-path baseline (${Math.round(similarity * 100)}%)`);
      }
    }

    if (score >= 0.65) {
      return { classification: 'soft_404_suspected', confidence: Math.min(0.99, round(score)), reasons };
    }
    if (page.redirectCount > 0) return { classification: 'redirected', confidence: 1, reasons: ['URL redirects to a successful page'] };
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

export function makeBaseline(signals: PageSignals): MissingBaseline {
  const combined = `${signals.title} ${signals.h1} ${signals.mainText.slice(0, 2_500)}`;
  return {
    status: signals.status,
    title: signals.title,
    h1: signals.h1,
    mainText: signals.mainText,
    tokens: tokenize(signals.mainText),
    looksMissing: signals.status === 404 || signals.status === 410 || STRONG_ERROR.test(combined),
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
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
