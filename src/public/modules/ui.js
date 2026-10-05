export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const number = (value) => Number(value || 0).toLocaleString();
export const lines = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
export const isRunning = (status) => ['queued', 'discovering', 'waiting_for_google', 'scanning', 'comparing_hours', 'comparing_profile', 'reporting'].includes(status);
export const statusLabel = (status) => ({ queued: 'Queued', discovering: 'Discovering', waiting_for_google: 'Waiting for Google', scanning: 'Verifying', comparing_profile: 'Comparing profile', comparing_hours: 'Comparing hours', reporting: 'Reporting', completed: 'Completed', completed_partial: 'Partial coverage', cancelled: 'Cancelled', failed: 'Failed' })[status] || status;
export const classificationLabel = (value) => ({ hard_404: 'Hard 404', gone_410: 'Gone 410', soft_404_suspected: 'Soft 404 suspected', redirected: 'Redirected', ok: 'Healthy', server_error: 'Server error', blocked: 'Blocked', timeout: 'Timed out', network_error: 'Network error' })[value] || value;
export const sourceLabel = (value) => ({ import: 'Import', sitemap: 'Sitemap', crawl: 'Crawl', google: 'Google', serper: 'Google · Serper', searchapi: 'Google · SearchApi', google_browser: 'Google · browser', gsc: 'Search Console', backlinks: 'Backlink' })[value] || value;
export const isFinding = (classification) => ['hard_404', 'gone_410', 'soft_404_suspected'].includes(classification);
export function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; }
}
export function targetLabel(scan) {
  const targets = [...scan.options.sites, ...scan.options.urls];
  if (!targets.length) return 'Imported URL audit';
  try {
    const hosts = [...new Set(targets.map((url) => new URL(url).host))];
    return hosts[0] + (hosts.length > 1 ? ` +${hosts.length - 1}` : '');
  } catch { return targets[0]; }
}
export function relativeDate(value) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const sprite = { arrow: 'arrow', play: 'play', refresh: 'refresh', globe: 'globe', download: 'download', check: 'check', search: 'search', clock: 'clock', link: 'link', file: 'file', store: 'store', alert: 'alert', console: 'console', stop: 'stop', chevron: 'chevron', plug: 'plug', note: 'note' };
/** Icons come from the inline sprite in index.html, so each use is one tiny element. */
export const icon = (name) => sprite[name] ? `<svg aria-hidden="true"><use href="#i-${sprite[name]}"/></svg>` : '';
let toastTimer;
export function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast .toast-icon').innerHTML = icon(error ? 'alert' : 'check');
  $('#toast').classList.add('visible');
  $('#toast').inert = false;
  toastTimer = setTimeout(dismissToast, error ? 8000 : 4500);
}
export function dismissToast() { $('#toast').classList.remove('visible'); $('#toast').inert = true; }
export function showError(error) {
  $('#app-error-message').textContent = error.message || String(error);
  $('#app-error').classList.remove('hidden');
}
export function debounce(fn, delay = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
/**
 * Coalesces bursts of calls into one per animation frame. Live audits stream a progress event
 * per checked URL; painting each one separately made the whole workspace stutter.
 */
export function frameThrottle(fn) {
  let frame = 0, latest;
  const run = () => { frame = 0; fn(...latest); };
  return (...args) => {
    latest = args;
    if (frame) return;
    frame = document.hidden ? setTimeout(run, 250) : requestAnimationFrame(run);
  };
}
/** Runs at most once per `ms`, always finishing with the latest arguments. */
export function throttle(fn, ms) {
  let timer = 0, last = 0, latest;
  const run = () => { timer = 0; last = performance.now(); fn(...latest); };
  return (...args) => {
    latest = args;
    if (timer) return;
    timer = setTimeout(run, Math.max(0, last + ms - performance.now()));
  };
}
/** Replaces markup only when it changed, so polling never resets hover, focus or selection. */
export function setHtml(element, html) {
  if (element.__html === html) return false;
  element.__html = html;
  element.innerHTML = html;
  return true;
}
