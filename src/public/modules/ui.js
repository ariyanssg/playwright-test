export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const number = (value) => Number(value || 0).toLocaleString();
export const lines = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
export const isRunning = (status) => ['queued', 'discovering', 'waiting_for_google', 'scanning', 'comparing_hours', 'comparing_profile', 'reporting'].includes(status);
export const statusLabel = (status) => ({ queued: 'Queued', discovering: 'Discovering', waiting_for_google: 'Waiting for Google', scanning: 'Verifying', comparing_profile: 'Comparing profile', comparing_hours: 'Comparing hours', reporting: 'Reporting', completed: 'Completed', completed_partial: 'Partial coverage', cancelled: 'Cancelled', failed: 'Failed' })[status] || status;
export const classificationLabel = (value) => ({ hard_404: 'Hard 404', gone_410: 'Gone 410', soft_404_suspected: 'Soft 404 suspected', redirected: 'Redirected', ok: 'Healthy', server_error: 'Server error', blocked: 'Blocked', timeout: 'Timed out', network_error: 'Network error' })[value] || value;
export const sourceLabel = (value) => ({ import: 'Import', sitemap: 'Sitemap', crawl: 'Crawl', google: 'Google', searchapi: 'Google · API', google_browser: 'Google · browser', gsc: 'Search Console', backlinks: 'Backlink' })[value] || value;
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
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${({ arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', play: '<path d="M8 5v14l11-7Z"/>', refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/>', download: '<path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14"/>', check: '<path d="m5 12 4 4L19 6"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', link: '<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>', file: '<path d="M5 3h10l4 4v14H5V3Zm10 0v5h4M8 13h8M8 17h5"/>' })[name] || ''}</svg>`;
let toastTimer;
export function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast-message').textContent = message;
  $('#toast').classList.toggle('error', error);
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
