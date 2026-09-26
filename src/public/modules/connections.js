import { request } from './api.js';
import { $, escapeHtml as e, icon, notify } from './ui.js';
export async function loadConnections(applyProviderStatus) {
  const [googleResult, providerResult, redirectResult] = await Promise.allSettled([request('/api/auth/google/status'), request('/api/providers/status'), globalThis.SIGNAL404_HOSTED ? Promise.reject(new Error('hosted')) : request('/api/auth/google/redirect-uri')]);
  if (redirectResult.status === 'fulfilled') {
    $('#redirect-uri').hidden = false;
    $('#redirect-uri-value').textContent = redirectResult.value.redirectUri;
    $('#redirect-origin').textContent = redirectResult.value.origin;
  }
  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;
  const providers = providerResult.status === 'fulfilled' ? providerResult.value : null;
  const definitions = [
    { name: 'Website discovery', description: 'Imports, sitemaps, and rendered links for website audits.', symbol: 'globe', available: true, badge: 'Built in', note: 'Available through Website only or All sources' },
    { name: 'Google search results', description: 'Organic result URLs from Serper, SearchApi, or a free local Google browser.', symbol: 'search', available: providers?.googleBrowser || providers?.serper || providers?.searchApi, source: 'google', badge: providers?.serper ? 'Serper ready' : providers?.searchApi ? 'SearchApi ready' : 'Browser ready', note: providers?.serper ? 'Auto uses Serper (about $0.30–$1 per 1,000 pages)' : providers?.searchApi ? 'Auto uses SearchApi. Set SERPER_API_KEY for a cheaper API' : 'Free local browser. Set SERPER_API_KEY for an API without CAPTCHAs' },
    { name: 'Google Search Console', description: 'Add page, sitemap and indexed-version evidence from your verified properties.', symbol: 'console', available: google?.authenticated, source: 'gsc', connect: google?.configured && !google.authenticated, note: 'Connect your Google account after adding credentials' },
    { name: 'DataForSEO backlinks', description: 'Discover linked pages and retain the evidence from referring websites.', symbol: 'link', available: providers?.dataForSeo, source: 'backlinks', note: 'Optional · requests are billed by the provider' },
    { name: 'Google Places', description: 'Compare opening hours and the public business listing against the restaurant’s own website.', symbol: 'clock', available: providers?.googleMaps, badge: providers?.googleMaps ? 'Key detected' : 'Key required', note: providers?.googleMaps ? 'GOOGLE_MAPS_API_KEY detected · requests are billed by Google' : 'Set GOOGLE_MAPS_API_KEY · this is an API key, not GOOGLE_CLIENT_ID/SECRET', check: providers?.googleMaps },
    { name: 'Google Business Profile', description: 'Cross-check the profile you manage, including menu, reservation and ordering links.', symbol: 'store', available: providers?.gbpAuthenticated, connectGbp: providers?.gbpConfigured && !providers.gbpAuthenticated, note: providers?.gbpConfigured ? 'Credentials found · connect the Google account that manages the restaurant' : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then connect' },
  ];
  if (globalThis.SIGNAL404_HOSTED) {
    const builtIn = definitions[0]; builtIn.description = 'Imports, sitemaps and a rendered site crawl, run online.'; builtIn.note = 'Online crawl cap: 500 pages per site · files and history stay in this browser';
    const places = definitions.find((item) => item.check); if (places) places.check = false;
    definitions[1].badge = providers?.searchApi ? 'API ready' : providers ? 'Key required' : 'Unavailable';
    // Search Console and the managed Business Profile need a Google sign-in stored on a server.
    for (let index = definitions.length - 1; index >= 0; index--) if (definitions[index].source === 'gsc' || definitions[index].connectGbp !== undefined) definitions.splice(index, 1);
    const backlinks = definitions.find((item) => item.source === 'backlinks');
    if (backlinks) backlinks.note = providers?.dataForSeo ? 'Online cap: 2,000 rows per site · billed by the provider' : 'Add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to the Netlify environment';
  }
  $('#provider-cards').innerHTML = definitions.map((provider) => `<article class="surface provider-card"><div class="provider-top"><span class="provider-icon">${icon(provider.symbol)}</span><span class="provider-status ${provider.available ? 'connected' : ''}">${provider.badge || (provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : provider.connect ? 'Ready to connect' : 'Not connected')}</span></div><h2>${provider.name}</h2><p>${provider.description}</p><div class="provider-footer">${provider.connect ? '<a class="button primary compact" href="/api/auth/google/start">Connect Google</a>' : provider.connectGbp ? '<a class="button primary compact" href="/api/auth/gbp/start">Connect Business Profile</a>' : `<small>${provider.note}</small>`}${provider.check ? '<button type="button" class="button secondary compact" data-check-places>Test key</button>' : ''}</div><p class="provider-result" data-provider-result hidden></p></article>`).join('');
  for (const provider of definitions.filter((provider) => provider.source && !(globalThis.SIGNAL404_HOSTED && provider.source === 'gsc'))) {
    const tag = $(`input[value="${provider.source}"]`).closest('.source-card').querySelector('.source-tag');
    tag.textContent = provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : 'Optional';
    tag.classList.toggle('optional', !provider.available);
  }
  $('#google-status').innerHTML = `<span class="connection-light ${google?.authenticated ? '' : 'muted'}"></span><span><b>Search Console</b><small>${google?.authenticated ? 'Connected' : google ? 'Not connected · optional' : 'Status unavailable'}</small></span>${icon('arrow')}`;
  const hoursSource = providers?.serper || providers?.googleMaps;
  $('#check-hours').disabled = !hoursSource;
  $('#google-provider-note').textContent = providers?.serper ? `Auto will use Serper (one credit per results page)${providers?.searchApi ? ', then SearchApi,' : ''} with a visible browser fallback if it fails.` : providers?.searchApi ? 'Auto will use SearchApi (provider credits), with a visible browser fallback if it fails. Serper is a cheaper API: set SERPER_API_KEY.' : 'Auto will open a local Google browser. No API key is needed. Resolve any Google prompt there, then choose Continue in the audit.';
  // Optional chaining: a page cached from an older release may not have every provider option.
  const option = (value) => $(`#google-provider option[value="${value}"]`);
  if (option('serper')) option('serper').disabled = !providers?.serper && !globalThis.SIGNAL404_HOSTED;
  if (option('searchapi')) option('searchapi').disabled = !providers?.searchApi && !globalThis.SIGNAL404_HOSTED;
  if (globalThis.SIGNAL404_HOSTED) $('#google-provider-note').textContent = providers?.searchApi ? `Hosted Google discovery uses ${providers?.serper ? 'Serper' : 'SearchApi'}. Search credits and Netlify usage limits apply; keep the tab open to continue scanning.` : 'Add SERPER_API_KEY (cheapest) or SEARCHAPI_API_KEY to the Netlify environment to enable Google discovery. Exact URL imports do not need a search key.';
  if (!hoursSource) $('#check-hours').checked = false;
  $('#check-hours-note').textContent = providers?.serper ? 'Google Maps hours via Serper · about 3 credits per restaurant' : providers?.googleMaps ? 'Google Places is connected · billed per request' : 'Set SERPER_API_KEY or GOOGLE_MAPS_API_KEY to enable';
  $('#inspect-google').disabled = !google?.authenticated;
  if (!google?.authenticated) $('#inspect-google').checked = false;
  $('#inspect-google').closest('label').querySelector('small').textContent = google?.authenticated ? 'Uses URL Inspection quota only after live verification' : 'Connect Search Console to enable URL Inspection';
  applyProviderStatus?.(providers);
  if (!google || !providers) {
    const failure = [googleResult, providerResult].find((result) => result.status === 'rejected');
    throw new Error(`Some connection statuses could not be loaded. ${failure?.reason?.message || 'Try again to refresh them.'}`);
  }
}

/** The Places key is the single most common reason a profile audit returns nothing, and only
 *  a live call can tell a present key from an accepted one. */
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-check-places]');
  if (!button) return;
  const result = button.closest('article').querySelector('[data-provider-result]');
  const original = button.textContent;
  button.disabled = true; button.textContent = 'Testing…';
  try {
    const response = await request('/api/providers/places/check', { method: 'POST' });
    result.hidden = false;
    result.textContent = response.message;
    result.classList.toggle('ok', response.ok);
    result.classList.toggle('bad', !response.ok);
  } catch (error) {
    result.hidden = false; result.textContent = error.message; result.classList.add('bad');
  } finally { button.disabled = false; button.textContent = original; }
});

document.addEventListener('click', async (event) => {
  if (!event.target.closest('#copy-redirect-uri')) return;
  try { await navigator.clipboard.writeText($('#redirect-uri-value').textContent); notify('Redirect URI copied.'); }
  catch { notify('Copy failed. Select the address and copy it manually.', true); }
});

// After Google sends the browser back, say what happened and open Connections.
const connected = new URLSearchParams(location.search);
if (connected.has('gbp') || connected.has('google')) {
  queueMicrotask(() => notify(connected.has('gbp') ? 'Business Profile connected. Load your locations in a new audit.' : 'Search Console connected.'));
  history.replaceState(null, '', `${location.pathname}${location.hash || '#connections'}`);
}
