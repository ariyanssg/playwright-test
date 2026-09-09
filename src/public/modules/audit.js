import { renderProfiles } from './profile.js';
import { request, scanPath } from './api.js';
import { $, $$, escapeHtml as e, number, targetLabel, statusLabel, classificationLabel, sourceLabel, isRunning, icon, safeUrl, notify, showError, debounce } from './ui.js';
const pageSize = 25;
const progressCopy = (status) => ({ queued: 'Waiting for the audit engine…', discovering: 'Discovering pages and bringing the evidence together.', waiting_for_google: 'Resolve the CAPTCHA or consent prompt in the Google browser, then choose Continue. Your progress is saved.', scanning: 'Checking pages in a real browser.', comparing_profile: 'Comparing restaurant identity, hours and service links.', comparing_hours: 'Comparing website and Google opening hours.', reporting: 'Preparing your reports.', completed: 'Checks of the discovered URLs are complete. Your evidence and reports are ready.', completed_partial: 'Audit finished with incomplete source coverage. Review the report below.', cancelled: 'Audit cancelled. Checked pages are saved; resume whenever you’re ready.', failed: 'This audit needs attention. Review the details below or try resuming.' })[status] || status;
export function createAudit(onProgress, onFinished) {
  const state = { id: null, generation: 0, summaryVersion: 0, summary: null, items: [], total: 0, page: 0, source: null, poll: null, resultsTimer: null, resultsController: null, resultsError: null, mutating: false };
  function stop() {
    state.source?.close(); state.source = null;
    clearInterval(state.poll); state.poll = null;
    clearTimeout(state.resultsTimer); state.resultsTimer = null;
  }
  function connection(label, live = false) {
    $('#run-connection').innerHTML = `<span></span>${label}`;
    $('#run-connection').classList.toggle('live', live);
  }
  function renderProgress(progress) {
    $('#run-status').textContent = statusLabel(progress.status);
    $('#run-status').className = `status-pill ${progress.status}`;
    $('#metric-total').textContent = number(progress.total);
    $('#metric-processed').textContent = number(progress.processed);
    $('#metric-findings').textContent = number(progress.findings);
    $('#metric-backlinks').textContent = number(progress.backlinkCount);
    $('#metric-hours').textContent = number(progress.hoursMismatches);
    $('#progress-message').textContent = progress.message && progress.message !== 'Connected' ? progress.message.replace(/^([a-z_]+):/, (_, label) => `${classificationLabel(label)} ·`) : progressCopy(progress.status);
    const percent = progress.total ? Math.min(100, Math.round(progress.processed / progress.total * 100)) : progress.status === 'completed' ? 100 : 0;
    $('#progress-percent').textContent = `${percent}%`;
    $('#progress-orb').style.setProperty('--progress', `${percent * 3.6}deg`);
    $('#progress-orb').setAttribute('aria-label', `${percent}% of discovered URLs checked`);
    $('#checked-caption').textContent = progress.total ? `${percent}% of discovered URLs` : 'Waiting to verify';
    $('#cancel-run').classList.toggle('hidden', !isRunning(progress.status));
    const refreshProfile = state.summary?.scan.options.checkProfile && !isRunning(progress.status);
    const retryPartial = progress.status === 'completed_partial' && state.summary?.googleDiscovery?.some((item) => item.status === 'failed');
    $('#resume-run').classList.toggle('hidden', !['cancelled', 'failed', 'waiting_for_google'].includes(progress.status) && !retryPartial && !refreshProfile);
    const resumeLabel = progress.status === 'waiting_for_google' ? 'Continue' : refreshProfile ? 'Refresh profile audit' : retryPartial ? 'Retry discovery' : 'Resume audit';
    const resumeButton = $('#resume-run');
    const resumeGlyph = progress.status === 'waiting_for_google' ? 'play' : refreshProfile ? 'refresh' : 'arrow';
    if (resumeButton.dataset.label !== resumeLabel) {
      resumeButton.dataset.label = resumeLabel;
      resumeButton.innerHTML = `${icon(resumeGlyph)}<span>${resumeLabel}</span>`;
    }
    const stages = ['discovering', 'scanning', ...(state.summary?.scan.options.checkHours ? ['comparing_hours'] : []), ...(state.summary?.scan.options.checkProfile ? ['comparing_profile'] : []), 'reporting'];
    const current = ['completed', 'completed_partial'].includes(progress.status) ? stages.length : stages.indexOf(progress.status === 'waiting_for_google' ? 'discovering' : progress.status);
    $$('.stage-track [data-stage]').forEach((element) => {
      const index = stages.indexOf(element.dataset.stage);
      element.classList.toggle('skipped', index === -1);
      element.classList.toggle('complete', index >= 0 && current > index);
      element.classList.toggle('current', index >= 0 && current === index);
      if (element.dataset.stage === 'comparing_hours') $('small', element).textContent = index === -1 ? 'Not included' : 'Compare schedules';
    });
    if (!isRunning(progress.status)) connection('Saved locally');
    onProgress(progress);
  }
  function renderSummary(summary) {
    const scan = summary.scan;
    renderProfiles(summary.profiles || [], scan.options.checkProfile);
    const google = summary.googleDiscovery || [];
    $('#google-coverage').classList.toggle('hidden', !google.length);
    $('#google-coverage').innerHTML = google.length ? `<b>Google search coverage</b>${google.map((item) => `<p><strong>${e(item.site)}</strong> · ${e((item.providersUsed?.length ? item.providersUsed : [item.provider]).map((provider) => provider === 'browser' ? 'Local browser' : 'SearchApi').join(' + '))} · ${e(item.country.toUpperCase())} / ${e(item.language)}<br>${number(item.pagesFetched)} search pages · ${number(item.queries.filter((q) => q.done).length)}/${item.queries.length} queries exhausted · <strong>${e(({ exhausted: 'Available results exhausted', limited: 'Page budget reached — partial coverage', failed: 'Discovery incomplete', waiting: 'Waiting for you', running: 'Searching', cancelled: 'Cancelled — progress saved' })[item.status])}</strong>${item.error ? `<br>${e(item.error)}` : ''}</p>`).join('')}<small>${scan.total === 0 && !isRunning(scan.status) ? 'No URLs were verified. This is not a clean-site verdict. ' : ''}Only observed Google results count as Google evidence. Search results are not a complete index inventory.${google.some((item) => item.status === 'limited') ? ' Create a new audit with a larger page budget for more coverage.' : ''}</small>` : '';
    $('#run-target').textContent = targetLabel(scan);
    $('#run-id').textContent = scan.id;
    $('.metric-hours').classList.toggle('hidden', !scan.options.checkHours);
    renderProgress({ ...scan, scanId: scan.id, backlinkCount: summary.backlinkCount, hoursMismatches: summary.hoursCounts?.mismatch || 0, message: scan.error || progressCopy(scan.status) });
    const warnings = [...new Set([...(scan.error ? [scan.error] : []), ...scan.warnings])];
    $('#run-warnings').classList.toggle('hidden', !warnings.length);
    $('#run-warnings').innerHTML = warnings.length ? `<details ${['failed', 'completed_partial'].includes(scan.status) ? 'open' : ''}><summary>${warnings.length} ${warnings.length === 1 ? 'audit note' : 'audit notes'} <span>Review coverage and provider availability</span></summary><ul>${warnings.map((warning) => `<li>${e(warning)}</li>`).join('')}</ul></details>` : '';
    const order = ['report.xlsx', 'findings.csv', 'all-urls.csv', 'backlinks.csv', 'hours.csv', 'profile-report.html', 'profile-fields.csv', 'profile-hours.csv', 'profile-links.csv', 'profile-audit.json', 'run.json'];
    const files = order.filter((file) => summary.artifacts.includes(file));
    $('#downloads').innerHTML = files.map((file) => `<a class="${file === 'report.xlsx' ? 'primary-download' : ''}" href="${scanPath(scan.id)}/artifacts/${file}">${icon('download')}<span><span class="sr-only">Download </span>${e(file)}</span></a>`).join('');
    $('#report-center').classList.toggle('report-ready', files.length > 0);
    $('#report-center small').textContent = files.length ? `${files.length} files ready · ${scan.status === 'completed' ? 'complete audit' : 'partial results'}` : 'Your downloads appear here when reporting finishes.';
  }
  async function refresh() {
    const id = state.id, generation = state.generation;
    const version = ++state.summaryVersion;
    if (!id) return;
    const summary = await request(scanPath(id));
    if (generation !== state.generation || version !== state.summaryVersion) return;
    state.summary = summary; renderSummary(summary);
    return summary;
  }
  function renderRows() {
    $('#results-body').innerHTML = state.items.map((candidate, index) => {
      const result = candidate.result, confidence = Math.round(result.confidence * 100);
      const sources = [...new Set(candidate.sources.map((source) => source.source))];
      return `<tr><td class="url-cell"><a href="${e(safeUrl(result.normalizedUrl))}" target="_blank" rel="noreferrer" title="${e(result.normalizedUrl)}">${e(result.normalizedUrl)}</a><small>${e(result.reasons[0] || result.title || 'No additional evidence')}</small></td><td><span class="classification ${e(result.classification)}"><span class="sr-only">${e(result.classification)} </span>${e(classificationLabel(result.classification))}</span></td><td><span class="sr-only">HTTP </span><span class="http-code">${result.httpStatus ?? '—'}</span></td><td><span class="confidence-value"><meter min="0" max="100" value="${confidence}" aria-label="Classification confidence"></meter>${confidence}%</span></td><td><span class="source-pills">${sources.map((source) => `<span>${e(sourceLabel(source))}</span>`).join('')}</span></td><td><button class="detail-button" data-evidence="${index}" aria-label="View evidence for ${e(result.normalizedUrl)}">Details ${icon('arrow')}</button></td></tr>`;
    }).join('') || `<tr class="table-empty"><td colspan="6"><b>${$('#result-search').value || $('#classification-filter').value !== 'all' ? 'No matching pages' : 'No checked pages yet'}</b><p>${$('#result-search').value || $('#classification-filter').value !== 'all' ? 'Try a different search or outcome filter.' : 'Results will appear as the audit progresses.'}</p></td></tr>`;
    $('#result-count').textContent = number(state.total);
    $('#page-summary').textContent = state.total ? `${number(state.page * pageSize + 1)}–${number(state.page * pageSize + state.items.length)} of ${number(state.total)} checked URLs` : '0 checked URLs';
    $('#page-number').textContent = `Page ${state.page + 1} of ${Math.max(1, Math.ceil(state.total / pageSize))}`;
    $('#previous-page').disabled = !state.page;
    $('#next-page').disabled = (state.page + 1) * pageSize >= state.total;
  }
  async function loadResults() {
    if (!state.id) return;
    state.resultsController?.abort();
    const controller = new AbortController(); state.resultsController = controller;
    const generation = state.generation;
    state.resultsError = null;
    const query = new URLSearchParams({ offset: String(state.page * pageSize), limit: String(pageSize), classification: $('#classification-filter').value, search: $('#result-search').value.trim() });
    $('.findings-section').setAttribute('aria-busy', 'true');
    $('#previous-page').disabled = true; $('#next-page').disabled = true;
    try {
      const data = await request(`${scanPath(state.id)}/results?${query}`, { signal: controller.signal });
      if (generation !== state.generation || controller.signal.aborted) return;
      state.items = data.items; state.total = data.total;
      if (state.page > 0 && state.page * pageSize >= state.total) { state.page = 0; return loadResults(); }
      renderRows();
    } catch (error) {
      if (error.name !== 'AbortError') {
        state.resultsError = error;
        state.items = []; $('#results-body').innerHTML = '<tr class="table-empty"><td colspan="6">Results could not be loaded. Use Refresh to try again.</td></tr>';
        $('#page-summary').textContent = 'Results unavailable'; showError(error);
      }
    } finally { if (state.resultsController === controller) $('.findings-section').removeAttribute('aria-busy'); }
  }
  async function finish(status, generation) {
    stop();
    await Promise.all([refresh(), loadResults()]);
    if (state.generation !== generation) return;
    notify(status === 'completed' ? 'Audit complete. Your reports are ready.' : `Audit: ${statusLabel(status)}. Your progress is saved.`, status === 'failed');
    onFinished();
  }
  function connect() {
    if (!state.summary || !isRunning(state.summary.scan.status)) return;
    const generation = state.generation;
    const source = globalThis.SIGNAL404_HOSTED ? { close() {} } : new EventSource(`${scanPath(state.id)}/events`); state.source = source;
    source.onopen = () => { if (state.generation === generation) connection('Live updates', true); };
    source.onmessage = (event) => {
      if (state.generation !== generation) return;
      let progress;
      try { progress = JSON.parse(event.data); } catch { return; }
      state.summaryVersion++;
      renderProgress(progress);
      if (!isRunning(progress.status)) { void finish(progress.status, generation).catch(showError); return; }
      if (!state.resultsTimer) state.resultsTimer = setTimeout(() => { state.resultsTimer = null; void loadResults(); }, 1200);
    };
    source.onerror = () => { if (state.generation === generation) connection('Reconnecting · checking progress'); };
    // Polling also detects missed completion events and artifacts created after cancellation.
    let pending = false;
    state.poll = setInterval(async () => {
      if (pending || generation !== state.generation) return;
      pending = true;
      try {
        const summary = await refresh();
        if (summary && !isRunning(summary.scan.status)) await finish(summary.scan.status, generation);
        else await loadResults();
      } catch (error) { connection('Engine unreachable · retrying'); }
      finally { pending = false; }
    }, 5000);
  }
  async function select(id) {
    if (!id) return;
    if (state.id === id && state.summary) return;
    stop(); state.resultsController?.abort();
    const generation = ++state.generation;
    state.id = id; state.summary = null; state.page = 0; state.items = []; state.total = 0;
    $('#result-search').value = ''; $('#classification-filter').value = 'all';
    $('#empty-state').classList.add('hidden'); $('#run-view').classList.remove('hidden');
    $('#run-view').setAttribute('aria-busy', 'true');
    $('#run-view').classList.add('is-loading');
    $('#run-target').textContent = 'Loading audit…'; $('#run-id').textContent = id;
    $('#run-warnings').classList.add('hidden'); $('#downloads').innerHTML = '';
    $('#google-coverage').classList.add('hidden');
    $('#profile-results').classList.add('hidden');
    $('#cancel-run').classList.add('hidden'); $('#resume-run').classList.add('hidden');
    renderRows();
    try { await Promise.all([refresh(), loadResults()]); if (generation === state.generation) connect(); }
    catch (error) { if (generation === state.generation) { $('#run-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden'); showError(error); } }
    finally { if (generation === state.generation) { $('#run-view').removeAttribute('aria-busy'); $('#run-view').classList.remove('is-loading'); } }
  }
  async function mutate(action) {
    if (!state.id || state.mutating) return;
    const id = state.id, generation = state.generation;
    state.mutating = true;
    const button = $(`#${action}-run`), original = button.innerHTML;
    button.disabled = true; button.textContent = action === 'cancel' ? 'Cancelling…' : 'Resuming…';
    try {
      await request(`${scanPath(id)}/${action}`, { method: 'POST' });
      if (generation !== state.generation) return;
      notify(action === 'cancel' ? 'Cancellation requested. Checked pages will be saved.' : 'Audit resumed. Continuing from saved progress.');
      await refresh();
      if (action === 'resume') { stop(); connect(); }
    } catch (error) { notify(error.message, true); }
    finally { state.mutating = false; button.disabled = false; button.innerHTML = original; }
  }
  function evidence(index) {
    const candidate = state.items[index]; if (!candidate) return;
    const r = candidate.result;
    const item = (label, value) => `<div><dt>${label}</dt><dd>${e(value ?? 'Not available')}</dd></div>`;
    const link = (label, url) => !url ? item(label, null) : `<div><dt>${label}</dt><dd><a href="${e(safeUrl(url))}" target="_blank" rel="noreferrer">${e(url || 'Not available')} ↗</a></dd></div>`;
    $('#evidence-content').innerHTML = `<span class="classification ${e(r.classification)}">${e(classificationLabel(r.classification))}</span><p class="evidence-url">${e(r.normalizedUrl)}</p><div class="evidence-callout"><b>Why this classification?</b><ul>${r.reasons.map((reason) => `<li>${e(reason)}</li>`).join('') || '<li>No additional signals recorded.</li>'}</ul>${r.classification === 'soft_404_suspected' ? '<p>A soft 404 is a suspected error page. Review the evidence before making changes.</p>' : ''}</div><dl class="evidence-facts">${item('HTTP status', r.httpStatus)}${item('Classification confidence', `${Math.round(r.confidence * 100)}%`)}${item('Page title', r.title)}${item('Main heading', r.h1)}${link('Final URL', r.finalUrl)}${link('Canonical', r.canonical)}${item('Response time', `${number(r.responseMs)} ms`)}${item('Checked', new Date(r.checkedAt).toLocaleString())}${item('Robots crawling', r.robotsAllowed === null ? 'Unknown' : r.robotsAllowed ? 'Allowed' : 'Disallowed')}${r.error ? item('Error', r.error) : ''}</dl><h3>Redirect chain</h3>${r.redirectChain.length ? `<ol class="evidence-chain">${r.redirectChain.map((hop) => `<li><span class="http-code">${hop.status ?? '—'}</span> ${e(hop.url)}${hop.location ? ` → ${e(hop.location)}` : ''}</li>`).join('')}</ol>` : '<p class="muted">No redirects recorded.</p>'}<h3>Discovery evidence</h3>${candidate.sources.map((source) => `<div class="evidence-source"><b>${e(sourceLabel(source.source))}</b><dl>${Object.entries(source).filter(([key]) => key !== 'source').map(([key, value]) => key === 'searchUrl' ? link('Google search', value) : item(key.replace(/([A-Z])/g, ' $1'), value)).join('') || '<p>Supplied directly to this audit.</p>'}</dl></div>`).join('')}${r.gsc ? `<h3>Google indexed-version evidence</h3><dl class="evidence-facts">${Object.entries(r.gsc).map(([key, value]) => item(key.replace(/([A-Z])/g, ' $1'), Array.isArray(value) ? value.join(', ') : value)).join('')}</dl>` : ''}`;
    $('#evidence-dialog').showModal();
  }
  $('#results-body').addEventListener('click', (event) => { const button = event.target.closest('[data-evidence]'); if (button) evidence(Number(button.dataset.evidence)); });
  $('#close-evidence').addEventListener('click', () => $('#evidence-dialog').close());
  $('#evidence-dialog').addEventListener('click', (event) => { if (event.target === $('#evidence-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  const filter = () => { state.page = 0; void loadResults(); };
  $('#classification-filter').addEventListener('change', filter);
  $('#result-search').addEventListener('input', debounce(filter));
  $('#previous-page').addEventListener('click', () => { if (state.page > 0) { state.page--; void loadResults(); } });
  $('#next-page').addEventListener('click', () => { if ((state.page + 1) * pageSize < state.total) { state.page++; void loadResults(); } });
  $('#cancel-run').addEventListener('click', () => void mutate('cancel'));
  $('#resume-run').addEventListener('click', () => void mutate('resume'));
  window.addEventListener('pagehide', () => { stop(); state.resultsController?.abort(); });
  return { select, async reload() { if (state.id && !state.summary) return select(state.id); await Promise.all([refresh(), loadResults()]); if (state.resultsError) throw state.resultsError; }, id: () => state.id };
}
