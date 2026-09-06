import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPage, makeBaseline } from '../../src/classifier.js';
import { isSameSite, normalizeUrl, tryNormalizeUrl, uniqueUrls } from '../../src/urls.js';

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
