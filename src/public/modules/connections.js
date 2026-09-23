import { request } from './api.js';
import { $, escapeHtml as e, icon } from './ui.js';
export async function loadConnections(applyProviderStatus) {
  const [googleResult, providerResult] = await Promise.allSettled([request('/api/auth/google/status'), request('/api/providers/status')]);
  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;
  const providers = providerResult.status === 'fulfilled' ? providerResult.value : null;
  const definitions = [
    { name: 'Website discovery', description: 'Imports, sitemaps, and rendered links for website audits.', symbol: 'globe', available: true, badge: 'Built in', note: 'Available through Website only or All sources' },
    { name: 'Google search results', description: 'Actual organic result URLs from SearchApi or a local Google browser.', symbol: 'search', available: providers?.googleBrowser || providers?.searchApi, source: 'google', badge: providers?.searchApi ? 'API ready' : 'Browser ready', note: 'Five queries · configurable page budget · UK English by default' },
    { name: 'Google Search Console', description: 'Add page, sitemap and indexed-version evidence from your verified properties.', symbol: 'console', available: google?.authenticated, source: 'gsc', connect: google?.configured && !google.authenticated, note: 'Connect your Google account after adding credentials' },
    { name: 'DataForSEO backlinks', description: 'Discover linked pages and retain the evidence from referring websites.', symbol: 'link', available: providers?.dataForSeo, source: 'backlinks', note: 'Optional · requests are billed by the provider' },
    { name: 'Google Places', description: 'Compare opening hours and the public business listing against the restaurant’s own website.', symbol: 'clock', available: providers?.googleMaps, badge: providers?.googleMaps ? 'Key detected' : 'Key required', note: providers?.googleMaps ? 'GOOGLE_MAPS_API_KEY detected · requests are billed by Google' : 'Set GOOGLE_MAPS_API_KEY · this is an API key, not GOOGLE_CLIENT_ID/SECRET', check: providers?.googleMaps },
    { name: 'Google Business Profile', description: 'Cross-check the profile you manage, including menu, reservation and ordering links.', symbol: 'store', available: providers?.gbpAuthenticated, connectGbp: providers?.gbpConfigured && !providers.gbpAuthenticated, note: providers?.gbpConfigured ? 'Credentials found · connect the Google account that manages the restaurant' : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then connect' },
  ];
  if (globalThis.SIGNAL404_HOSTED) {
    const builtIn = definitions[0]; builtIn.name = 'Exact URL imports'; builtIn.description = 'Upload TXT, CSV or XLSX lists and verify each URL.'; builtIn.note = 'Files and audit history stay in this browser';
    definitions[1].badge = providers?.searchApi ? 'API ready' : providers ? 'Key required' : 'Unavailable';
    for (let index = definitions.length - 1; index >= 0; index--) if (['gsc', 'backlinks'].includes(definitions[index].source)) definitions.splice(index, 1);
  }
  $('#provider-cards').innerHTML = definitions.map((provider) => `<article class="surface provider-card"><div class="provider-top"><span class="provider-icon">${icon(provider.symbol)}</span><span class="provider-status ${provider.available ? 'connected' : ''}">${provider.badge || (provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : provider.connect ? 'Ready to connect' : 'Not connected')}</span></div><h2>${provider.name}</h2><p>${provider.description}</p><div class="provider-footer">${provider.connect ? '<a class="button primary compact" href="/api/auth/google/start">Connect Google</a>' : provider.connectGbp ? '<a class="button primary compact" href="/api/auth/gbp/start">Connect Business Profile</a>' : `<small>${provider.note}</small>`}${provider.check ? '<button type="button" class="button secondary compact" data-check-places>Test key</button>' : ''}</div><p class="provider-result" data-provider-result hidden></p></article>`).join('');
  for (const provider of definitions.filter((provider) => provider.source)) {
    const tag = $(`input[value="${provider.source}"]`).closest('.source-card').querySelector('.source-tag');
    tag.textContent = provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : 'Optional';
    tag.classList.toggle('optional', !provider.available);
  }
  $('#google-status').innerHTML = `<span class="connection-light ${google?.authenticated ? '' : 'muted'}"></span><span><b>Search Console</b><small>${google?.authenticated ? 'Connected' : google ? 'Not connected · optional' : 'Status unavailable'}</small></span>${icon('arrow')}`;
  $('#check-hours').disabled = !providers?.googleMaps;
  $('#google-provider-note').textContent = providers?.searchApi ? 'Auto will use SearchApi (provider credits), with a visible browser fallback if it fails.' : 'Auto will open a local Google browser. No API key is needed. Resolve any Google prompt there, then choose Continue in the audit.';
  if (globalThis.SIGNAL404_HOSTED) $('#google-provider-note').textContent = providers?.searchApi ? 'Hosted Google discovery uses SearchApi. Search credits and Netlify usage limits apply; keep the tab open to continue scanning.' : 'Add SEARCHAPI_API_KEY to the Netlify environment to enable Google discovery. Exact URL imports do not need a search key.';
  if (!providers?.googleMaps) $('#check-hours').checked = false;
  $('#check-hours-note').textContent = providers?.googleMaps ? 'Google Places is connected · billed per request' : 'Connect Google Places to enable · billed per request';
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
