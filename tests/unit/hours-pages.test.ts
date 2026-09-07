import assert from 'node:assert/strict';
import test from 'node:test';
import { selectHoursPages } from '../../src/hours/pages.js';
import type { CandidateRecord, Classification, DiscoveryEvidence } from '../../src/types.js';

const SITE = 'https://bluefin.example';

function candidate(path: string, classification?: Classification, sources: DiscoveryEvidence[] = [{ source: 'import' }]): CandidateRecord {
  const url = new URL(path, SITE).href;
  return {
    inputUrl: url,
    normalizedUrl: url,
    site: SITE,
    sources,
    status: classification ? 'complete' : 'pending',
    result: classification
      ? {
        inputUrl: url, normalizedUrl: url, site: SITE, sources, httpStatus: 200, finalUrl: url,
        redirectChain: [], classification, confidence: 1, reasons: [], robotsAllowed: true,
        title: '', h1: '', canonical: null, contentType: 'text/html', responseMs: 1,
        checkedAt: new Date().toISOString(), error: null,
      }
      : null,
  };
}

const paths = (urls: string[]): string[] => urls.map((url) => new URL(url).pathname);

test('likely hours pages are ranked ahead of everything else', () => {
  const selected = selectHoursPages(SITE, [
    candidate('/about', 'ok'),
    candidate('/visit', 'ok'),
    candidate('/contact', 'ok'),
    candidate('/hours', 'ok'),
    candidate('/menu', 'ok'),
  ], 5);
  assert.deepEqual(paths(selected), ['/', '/hours', '/contact', '/visit', '/about']);
});

test('the site root is always inspected even when it was never discovered', () => {
  assert.deepEqual(paths(selectHoursPages(SITE, [], 5)), ['/']);
});

test('blogs, assets, and broken pages are never inspected', () => {
  const selected = selectHoursPages(SITE, [
    candidate('/blog/opening-hours-explained', 'ok'),
    candidate('/hours.pdf', 'ok'),
    candidate('/hours', 'hard_404'),
    candidate('/contact', 'soft_404_suspected'),
    candidate('/visit', 'redirected'),
  ], 5);
  assert.deepEqual(paths(selected), ['/', '/visit']);
});

test('a path segment mentioning hours is a weaker but valid signal', () => {
  const selected = selectHoursPages(SITE, [candidate('/info/store-hours', 'ok'), candidate('/menu', 'ok')], 5);
  assert.deepEqual(paths(selected), ['/', '/info/store-hours']);
});

test('anchor and title evidence promotes a page above its path score', () => {
  // /about scores 60 and /visit 70, so only the evidence bonus can reorder them.
  assert.deepEqual(paths(selectHoursPages(SITE, [
    candidate('/visit', 'ok'),
    candidate('/about', 'ok'),
  ], 5)), ['/', '/visit', '/about']);
  assert.deepEqual(paths(selectHoursPages(SITE, [
    candidate('/visit', 'ok'),
    candidate('/about', 'ok', [{ source: 'crawl', anchor: 'Our opening hours' }]),
  ], 5)), ['/', '/about', '/visit']);
  assert.deepEqual(paths(selectHoursPages(SITE, [
    candidate('/visit', 'ok'),
    candidate('/about', 'ok', [{ source: 'crawl', title: 'Hours and location' }]),
  ], 2)), ['/', '/about'], 'the bonus wins when only two slots exist');
});

test('the page limit is honoured and other sites are ignored', () => {
  const selected = selectHoursPages(SITE, [
    candidate('/hours', 'ok'),
    candidate('/contact', 'ok'),
    { ...candidate('/hours', 'ok'), normalizedUrl: 'https://other.example/hours', site: 'https://other.example' },
  ], 2);
  assert.deepEqual(paths(selected), ['/', '/hours']);
});
