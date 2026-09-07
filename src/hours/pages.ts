import type { CandidateRecord } from '../types.js';
import { siteKey, tryNormalizeUrl } from '../urls.js';

interface ScoreRule {
  pattern: RegExp;
  score: number;
}

const PATH_RULES: ScoreRule[] = [
  { pattern: /^\/(?:hours|opening-hours|opening-times|our-hours|hours-and-location|hours-location)(?:\/|$)/, score: 90 },
  { pattern: /^\/(?:contact|contact-us|contactus)(?:\/|$)/, score: 80 },
  { pattern: /^\/(?:locations?|visit|visit-us|find-us|directions)(?:\/|$)/, score: 70 },
  { pattern: /^\/(?:about|about-us|info|information)(?:\/|$)/, score: 60 },
];

const SEGMENT_HINT = /(?:hour|open)/;
const EXCLUDED_PATH = /^\/(?:blog|news|press|tag|tags|category|categories|feed|wp-|author|events?\/)/;
const EXCLUDED_EXTENSION = /\.(?:pdf|jpe?g|png|gif|webp|svg|xml|json|css|js|zip|mp4)$/;
const EVIDENCE_HINT = /hours|contact|visit|location/i;
const EVIDENCE_BONUS = 15;
const ROOT_SCORE = 100;

/**
 * Ranks pages already discovered for this site by how likely they are to publish
 * opening hours. Pure, and reads only what the database already holds, so it
 * costs no extra discovery.
 */
export function selectHoursPages(site: string, candidates: readonly CandidateRecord[], limit: number): string[] {
  const host = siteKey(site);
  const root = new URL('/', site).href;
  const scored = new Map<string, number>([[root, ROOT_SCORE]]);

  for (const candidate of candidates) {
    const url = tryNormalizeUrl(candidate.normalizedUrl);
    if (!url) continue;
    try {
      if (siteKey(url) !== host) continue;
    } catch {
      continue;
    }
    // A page already known to be missing or broken cannot publish hours.
    const classification = candidate.result?.classification;
    if (classification && classification !== 'ok' && classification !== 'redirected') continue;

    const score = scorePath(new URL(url).pathname, candidate);
    if (score === null) continue;
    scored.set(url, Math.max(scored.get(url) ?? 0, score));
  }

  return [...scored.entries()]
    .sort(([leftUrl, leftScore], [rightUrl, rightScore]) => rightScore - leftScore || leftUrl.length - rightUrl.length || leftUrl.localeCompare(rightUrl))
    .slice(0, Math.max(1, limit))
    .map(([url]) => url);
}

function scorePath(rawPath: string, candidate: CandidateRecord): number | null {
  const path = rawPath.replace(/\/+$/, '').toLowerCase() || '/';
  if (path === '/') return ROOT_SCORE;
  if (EXCLUDED_PATH.test(path) || EXCLUDED_EXTENSION.test(path)) return null;

  let score = 0;
  for (const rule of PATH_RULES) {
    if (rule.pattern.test(`${path}/`)) {
      score = rule.score;
      break;
    }
  }
  if (!score && path.split('/').some((segment) => SEGMENT_HINT.test(segment))) score = 50;
  if (!score) return null;

  const evidence = candidate.sources.some((source) => EVIDENCE_HINT.test(`${source.title ?? ''} ${source.anchor ?? ''}`));
  return evidence ? score + EVIDENCE_BONUS : score;
}
