import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPage, makeBaseline } from '../../src/classifier.js';
import { isSameSite, normalizeUrl, tryNormalizeUrl, uniqueUrls } from '../../src/urls.js';
import { interleaveByHost } from '../../src/scanner.js';

test('normalizes domains without destroying indexed path/query details', () => {
  assert.equal(normalizeUrl('site:WWW.Example.com/menu?ref=social#offer'), 'https://www.example.com/menu?ref=social');
  assert.equal(normalizeUrl('[menu](http://Example.com:80/Food)'), 'http://example.com/Food');
  assert.equal(tryNormalizeUrl('mailto:test@example.com'), null);
  assert.deepEqual(uniqueUrls(['example.com', 'https://example.com/', 'https://example.com/#top']), ['https://example.com/']);
  assert.equal(isSameSite('https://www.example.com/a', 'http://example.com/b'), true);
  assert.equal(isSameSite('https://example.com', 'https://example.net'), false);
});

test('classifies definitive HTTP outcomes', () => {
  const base = { title: '', h1: '', mainText: '', redirectCount: 0 };
  assert.equal(classifyPage({ ...base, status: 404 }).classification, 'hard_404');
  assert.equal(classifyPage({ ...base, status: 410 }).classification, 'gone_410');
  assert.equal(classifyPage({ ...base, status: 503 }).classification, 'server_error');
  assert.equal(classifyPage({ ...base, status: 403 }).classification, 'blocked');
  assert.equal(classifyPage({ ...base, status: null, timedOut: true }).classification, 'timeout');
});

test('soft 404 scoring requires strong rendered evidence', () => {
  const baseline = makeBaseline({ status: 404, title: 'Page not found', h1: '404', mainText: 'Sorry, this page does not exist. Return to restaurant home.', redirectCount: 0 });
  const soft = classifyPage({ status: 200, title: 'Page not found', h1: 'Page not found', mainText: 'Sorry, this page does not exist. Return to restaurant home.', redirectCount: 0 }, baseline);
  assert.equal(soft.classification, 'soft_404_suspected');
  assert.ok(soft.confidence >= 0.9);

  const incidental = classifyPage({ status: 200, title: 'Our story', h1: 'Our story', mainText: 'We have not found a better supplier, and dinner is served daily.', redirectCount: 0 }, baseline);
  assert.equal(incidental.classification, 'ok');
});

test('detects a catch-all 200 page by similarity to a synthetic missing-path baseline without flagging the homepage', () => {
  const homeText = 'Welcome Menu Old menu Old event Private reservations contact restaurant';
  const baseline = makeBaseline({ status: 200, title: 'Restaurant home', h1: 'Welcome', mainText: homeText, redirectCount: 0 });
  const missing = classifyPage({
    status: 200,
    title: 'Restaurant home',
    h1: 'Welcome',
    mainText: homeText,
    redirectCount: 0,
    requestedUrl: 'https://example.com/does-not-exist',
  }, baseline);
  assert.equal(missing.classification, 'soft_404_suspected');
  assert.match(missing.reasons.join(' '), /synthetic missing-path baseline/);

  const homepage = classifyPage({
    status: 200,
    title: 'Restaurant home',
    h1: 'Welcome',
    mainText: homeText,
    redirectCount: 0,
    requestedUrl: 'https://example.com/',
  }, baseline);
  assert.equal(homepage.classification, 'ok');
});

test('successful redirects are reported without being called broken', () => {
  const decision = classifyPage({ status: 200, title: 'Menu', h1: 'Menu', mainText: 'Full dinner menu', redirectCount: 1 });
  assert.equal(decision.classification, 'redirected');
});

test('a brand name containing 404 or "gone" is not a missing-page signal', () => {
  const page = (title: string) => classifyPage({ status: 200, title, h1: title, mainText: 'Dinner service, cocktails and a seasonal menu every night.', redirectCount: 0 });
  assert.equal(page('404 Kitchen | Nashville').classification, 'ok');
  assert.equal(page('Gone Fishing Seafood Bar').classification, 'ok');
  assert.equal(page('Error 404 - Gone Fishing').classification, 'soft_404_suspected');
  assert.equal(page('Menu | Not Found').classification, 'soft_404_suspected');
});

test('an empty client-rendered page is not "identical" to an empty missing-page template', () => {
  const emptyTemplate = makeBaseline({ status: 404, title: '', h1: '', mainText: '', redirectCount: 0 });
  const decision = classifyPage({ status: 200, title: 'Menu', h1: '', mainText: '', redirectCount: 0, requestedUrl: 'https://example.com/menu' }, emptyTemplate);
  assert.equal(decision.classification, 'ok');
});

test('a deep URL that redirects to the homepage is a suspected soft 404, a home alias is not', () => {
  const home = { status: 200, title: 'Home', h1: 'Welcome', mainText: 'Welcome to the restaurant', redirectCount: 1 };
  const deep = classifyPage({ ...home, requestedUrl: 'https://example.com/old-menu', finalUrl: 'https://www.example.com/' });
  assert.equal(deep.classification, 'soft_404_suspected');
  assert.match(deep.reasons.join(' '), /redirects to the homepage/);
  assert.equal(classifyPage({ ...home, requestedUrl: 'https://example.com/index.html', finalUrl: 'https://example.com/' }).classification, 'redirected');
});

test('a script or meta-refresh redirect is reported as a redirect', () => {
  const decision = classifyPage({ status: 200, title: 'Menu', h1: 'Menu', mainText: 'Full dinner menu', redirectCount: 0, requestedUrl: 'https://example.com/menu-2019', finalUrl: 'https://example.com/menu' });
  assert.equal(decision.classification, 'redirected');
  assert.match(decision.reasons[0]!, /script or meta refresh/);
});

test('hosts are interleaved so one site cannot monopolize the workers', () => {
  const urls = ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://b.com/1', 'https://c.com/1'].map((normalizedUrl) => ({ normalizedUrl }));
  assert.deepEqual(interleaveByHost(urls).map((item) => item.normalizedUrl), ['https://a.com/1', 'https://b.com/1', 'https://c.com/1', 'https://a.com/2', 'https://a.com/3']);
});
