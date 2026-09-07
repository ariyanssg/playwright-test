import { request } from './api.js';
import { $, escapeHtml as e, icon } from './ui.js';
export async function loadConnections() {
  const [googleResult, providerResult] = await Promise.allSettled([request('/api/auth/google/status'), request('/api/providers/status')]);
  const google = googleResult.status === 'fulfilled' ? googleResult.value : null;
  const providers = providerResult.status === 'fulfilled' ? providerResult.value : null;
  const definitions = [
    { name: 'Website discovery', description: 'Imports, sitemaps, and rendered links for website audits.', symbol: 'globe', available: true, badge: 'Built in', note: 'Available through Website only or All sources' },
    { name: 'Google search results', description: 'Actual organic result URLs from SearchApi or a local Google browser.', symbol: 'search', available: providers?.googleBrowser || providers?.searchApi, source: 'google', badge: providers?.searchApi ? 'API ready' : 'Browser ready', note: 'Five queries · configurable page budget · UK English by default' },
    { name: 'Google Search Console', description: 'Add page, sitemap, and indexed-version evidence from verified properties.', symbol: 'file', available: google?.authenticated, source: 'gsc', connect: google?.configured && !google.authenticated, note: 'Connect your Google account after adding credentials' },
    { name: 'DataForSEO backlinks', description: 'Discover linked pages and retain the evidence from referring websites.', symbol: 'link', available: providers?.dataForSeo, source: 'backlinks', note: 'Optional · requests are billed by the provider' },
    { name: 'Google opening hours', description: 'Compare the hours on a restaurant’s website with its Google listing.', symbol: 'clock', available: providers?.googleMaps, note: 'Optional · Google Places requests are billed' },
  ];
  $('#provider-cards').innerHTML = definitions.map((provider) => `<article class="surface provider-card"><div class="provider-top"><span class="provider-icon">${icon(provider.symbol)}</span><span class="provider-status ${provider.available ? 'connected' : ''}">${provider.badge || (provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : provider.connect ? 'Ready to connect' : 'Not connected')}</span></div><h2>${provider.name}</h2><p>${provider.description}</p><div class="provider-footer">${provider.connect ? '<a class="primary compact" href="/api/auth/google/start">Connect Google →</a>' : `<small>${provider.note}</small>`}</div></article>`).join('');
  for (const provider of definitions.filter((provider) => provider.source)) {
    const tag = $(`input[value="${provider.source}"]`).closest('.source-card').querySelector('.source-tag');
    tag.textContent = provider.available ? 'Connected' : provider.available == null ? 'Unavailable' : 'Optional';
    tag.classList.toggle('optional', !provider.available);
  }
  $('#google-status').innerHTML = `<span class="connection-light ${google?.authenticated ? '' : 'muted'}"></span><span><b>Search Console</b><small>${google?.authenticated ? 'Connected' : google ? 'Optional connection' : 'Status unavailable'}</small></span><a href="#connections" aria-label="View connections">${icon('arrow')}</a>`;
  $('#check-hours').disabled = !providers?.googleMaps;
  $('#google-provider-note').textContent = providers?.searchApi ? 'Auto will use SearchApi (provider credits), with a visible browser fallback if it fails.' : 'Auto will open a local Google browser. No API key is needed. Resolve any Google prompt there, then choose Continue in the audit.';
  if (!providers?.googleMaps) $('#check-hours').checked = false;
  $('#check-hours-note').textContent = providers?.googleMaps ? 'Google Places is connected · billed per request' : 'Connect Google Places to enable · billed per request';
  $('#inspect-google').disabled = !google?.authenticated;
  if (!google?.authenticated) $('#inspect-google').checked = false;
  $('#inspect-google').closest('label').querySelector('small').textContent = google?.authenticated ? 'Uses URL Inspection quota only after live verification' : 'Connect Search Console to enable URL Inspection';
  if (!google || !providers) throw new Error('Some connection statuses could not be loaded. Try again to refresh them.');
}
