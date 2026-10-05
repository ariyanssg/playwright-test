import { renderProfiles, profileIssues } from './profile.js';
import { renderHours, needsAttention } from './hours.js';
import { request, scanPath } from './api.js';
import { $, $$, escapeHtml as e, number, targetLabel, statusLabel, classificationLabel, sourceLabel, isRunning, isFinding, icon, safeUrl, notify, showError, debounce, frameThrottle, setHtml } from './ui.js';

const HOSTED = Boolean(globalThis.SIGNAL404_HOSTED);
const pageSize = 25;
const progressCopy = (status) => ({ queued: 'Waiting for the audit engine…', discovering: 'Collecting pages from the selected sources.', waiting_for_google: 'Resolve the CAPTCHA or consent prompt in the Google browser, then choose Continue. Progress is saved.', scanning: 'Checking pages in a real browser.', comparing_profile: 'Comparing the restaurant’s details, hours and links with Google.', comparing_hours: 'Comparing website and Google opening hours.', reporting: 'Writing your reports.', completed: 'Finished. Results and reports are ready below.', completed_partial: 'Finished, but some parts could not be completed. The Notes tab says what is missing; Resume retries it.', cancelled: 'Cancelled. Finished work is saved; resume whenever you’re ready.', failed: 'This audit stopped with an error. The Notes tab has the reason; fix it, then resume.' })[status] || status;
const COVERAGE_STATE = { exhausted: 'All results read', limited: 'Page budget reached', failed: 'Incomplete', waiting: 'Waiting for you', running: 'Searching', cancelled: 'Cancelled' };
const FILTER_ORDER = ['hard_404', 'gone_410', 'soft_404_suspected', 'server_error', 'timeout', 'network_error', 'blocked', 'redirected', 'ok'];
/** Reports by what they hold, in the order a reader reaches for them. */
const FILES = [
  ['report.xlsx', 'Excel report'], ['findings.csv', 'Broken pages'], ['all-urls.csv', 'All checked pages'], ['hours.csv', 'Opening hours'],
  ['profile-report.html', 'Profile report'], ['profile-fields.csv', 'Profile details'], ['profile-hours.csv', 'Profile hours'], ['profile-links.csv', 'Profile links'],
  ['profile-audit.json', 'Profile data'], ['backlinks.csv', 'Backlinks'], ['run.json', 'Full audit data'],
];
const TABS = ['pages', 'profile', 'hours', 'notes'];

/** Which checks an audit ran. Profile and hours audits only check the restaurants' own homepages. */
export function auditChecks(options) {
  const comparing = options.checkProfile || options.checkHours;
  return { pages: !comparing || options.discovery.some((source) => source !== 'import') || options.urls.length > 0 || options.inputFiles.length > 0, profile: Boolean(options.checkProfile), hours: Boolean(options.checkHours) };
}
const noteTone = (note) => /fail|could not|error|refused|rejected|unavailable|incomplete|not checked/i.test(note) ? 'error' : /cost|coverage|cap|budget/i.test(note) ? 'info' : 'warn';

export function createAudit(onProgress, onFinished, onSelected) {
  const state = { id: null, generation: 0, summaryVersion: 0, summary: null, items: [], total: 0, page: 0, source: null, poll: null, resultsTimer: null, resultsController: null, resultsError: null, mutating: false, tab: null, tabChosen: false, evidence: -1 };
  function stop() {
    state.source?.close(); state.source = null;
    clearInterval(state.poll); state.poll = null;
    clearTimeout(state.resultsTimer); state.resultsTimer = null;
  }
  function connection(label, live = false) {
    const element = $('#run-connection');
    setHtml(element, `<span></span>${e(label)}`);
    element.classList.toggle('live', live);
  }
  function renderProgress(progress) {
    const pill = $('#run-status');
    pill.textContent = statusLabel(progress.status);
    pill.className = `status-pill ${progress.status}`;
    $('#metric-total').textContent = number(progress.total);
    $('#metric-processed').textContent = number(progress.processed);
    $('#metric-findings').textContent = number(progress.findings);
    $('#metric-findings').closest('.metric-card').classList.toggle('has-value', progress.findings > 0);
    $('#metric-backlinks').textContent = number(progress.backlinkCount);
    const running = isRunning(progress.status);
    $('#progress-message').textContent = progress.message && progress.message !== 'Connected' ? progress.message.replace(/^([a-z_0-9]+):\s*/, (_, label) => `${classificationLabel(label)} · `) : progressCopy(progress.status);
    const done = ['completed', 'completed_partial'].includes(progress.status);
    const percent = progress.total ? Math.min(100, Math.round(progress.processed / progress.total * 100)) : done ? 100 : 0;
    const bar = $('#progress-orb');
    $('#progress-percent').textContent = `${percent}%`;
    bar.style.setProperty('--pct', `${percent}%`);
    bar.setAttribute('aria-valuenow', String(percent));
    bar.classList.toggle('active', running);
    bar.classList.toggle('done', progress.status === 'completed');
    bar.classList.toggle('attention', ['completed_partial', 'cancelled', 'failed', 'waiting_for_google'].includes(progress.status));
    $('#checked-caption').textContent = progress.total ? `${percent}% of pages found` : 'Waiting to check';
    $('#cancel-run').classList.toggle('hidden', !running);
    const checks = state.summary ? auditChecks(state.summary.scan.options) : { profile: false };
    // Online, Resume retries exactly what a partial audit is missing; desktop retries discovery.
    const retryPartial = progress.status === 'completed_partial' && (HOSTED || state.summary?.googleDiscovery?.some((item) => item.status === 'failed'));
    const refreshProfile = checks.profile && !running && !retryPartial && !['cancelled', 'failed', 'waiting_for_google'].includes(progress.status);
    $('#resume-run').classList.toggle('hidden', !['cancelled', 'failed', 'waiting_for_google'].includes(progress.status) && !retryPartial && !refreshProfile);
    const resumeLabel = progress.status === 'waiting_for_google' ? 'Continue' : retryPartial ? 'Retry what’s missing' : refreshProfile ? 'Refresh profile audit' : 'Resume audit';
    const resumeButton = $('#resume-run');
    const resumeGlyph = progress.status === 'waiting_for_google' ? 'play' : refreshProfile || retryPartial ? 'refresh' : 'arrow';
    if (resumeButton.dataset.label !== resumeLabel && !state.mutating) {
      resumeButton.dataset.label = resumeLabel;
      resumeButton.innerHTML = `${icon(resumeGlyph)}<span>${resumeLabel}</span>`;
    }
    const stages = [...(checks.pages !== false ? ['discovering', 'scanning'] : ['scanning']), ...(checks.hours ? ['comparing_hours'] : []), ...(checks.profile ? ['comparing_profile'] : []), 'reporting'];
    // Google can pause discovery or the profile comparison; stay on whichever stage was running.
    if (stages.includes(progress.status)) state.stage = progress.status;
    // A page opened mid-pause has no history: once every page is checked, it is the profile step.
    const pausedAt = state.stage || (progress.total && progress.processed >= progress.total && checks.profile ? 'comparing_profile' : 'discovering');
    const current = done ? stages.length : stages.indexOf(progress.status === 'waiting_for_google' ? pausedAt : progress.status === 'discovering' && !stages.includes('discovering') ? 'scanning' : progress.status);
    $$('.stage-track [data-stage]').forEach((element) => {
      const index = stages.indexOf(element.dataset.stage);
      element.classList.toggle('skipped', index === -1);
      element.classList.toggle('complete', index >= 0 && current > index);
      element.classList.toggle('current', index >= 0 && current === index && !['cancelled', 'failed'].includes(progress.status));
      if (index === current) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current');
    });
    if (!running) connection(HOSTED ? 'Saved in this browser' : 'Saved on this computer');
    onProgress(progress);
  }
  // SSE delivers one event per checked URL; the header repaints once per frame at most.
  const paintProgress = frameThrottle(renderProgress);

  function renderCoverage(scan, google) {
    const box = $('#google-coverage');
    box.classList.toggle('hidden', !google.length);
    if (!google.length) return setHtml(box, '');
    const rows = google.map((item) => {
      const providers = (item.providersUsed?.length ? item.providersUsed : [item.provider]).map((provider) => ({ browser: 'Local browser', serper: 'Serper', searchapi: 'SearchApi' })[provider] || provider).join(' + ');
      return `<div class="coverage-row"><strong>${e(item.site)}</strong><span class="coverage-state ${e(item.status)}">${e(COVERAGE_STATE[item.status] || item.status)}</span><span class="coverage-meta">${e(providers)} · ${e(item.country.toUpperCase())}/${e(item.language)} · ${number(item.pagesFetched)} search pages · ${number(item.queries.filter((q) => q.done).length)}/${item.queries.length} queries finished</span>${item.error ? `<span class="coverage-error">${e(item.error)}</span>` : ''}</div>`;
    }).join('');
    setHtml(box, `<b>Google search coverage</b><div class="coverage-rows">${rows}</div><small>${scan.total === 0 && !isRunning(scan.status) ? 'No pages were checked, so this is not a clean-site verdict. ' : ''}Only pages actually seen in Google results count as Google evidence, and search results are never a complete index.${google.some((item) => item.status === 'limited') ? ' Start a new audit with a larger page budget for more coverage.' : ''}</small>`);
  }

  function renderFilterChips(counts) {
    const select = $('#classification-filter');
    const present = FILTER_ORDER.filter((key) => counts?.[key]);
    const total = present.reduce((sum, key) => sum + counts[key], 0);
    const broken = present.filter(isFinding).reduce((sum, key) => sum + counts[key], 0);
    const chips = present.length > 1 ? [`<button type="button" data-filter="all" aria-pressed="${select.value === 'all'}">All <b>${number(total)}</b></button>`, ...(broken && broken < total ? [`<button type="button" data-filter="problems" class="alert" aria-pressed="${select.value === 'problems'}">Broken only <b>${number(broken)}</b></button>`] : []), ...present.map((key) => `<button type="button" data-filter="${key}" class="${isFinding(key) ? 'alert' : ''}" aria-pressed="${select.value === key}">${e(classificationLabel(key))} <b>${number(counts[key])}</b></button>`)] : [];
    setHtml($('#filter-chips'), chips.join(''));
  }

  function renderNotes(scan) {
    const warnings = [...new Set([...(scan.error ? [scan.error] : []), ...scan.warnings])];
    $('#run-warnings').classList.toggle('hidden', !warnings.length);
    $('#notes-empty').classList.toggle('hidden', warnings.length > 0);
    // Errors first: they are what stops a result from being complete.
    const sorted = [...warnings].sort((a, b) => ['error', 'warn', 'info'].indexOf(noteTone(a)) - ['error', 'warn', 'info'].indexOf(noteTone(b)));
    setHtml($('#run-warnings'), warnings.length ? `<h3>${icon('alert')}${warnings.length} ${warnings.length === 1 ? 'note' : 'notes'} about coverage and providers</h3><ul>${sorted.map((warning) => `<li class="${noteTone(warning)}">${e(warning)}</li>`).join('')}</ul>` : '');
    return { total: warnings.length, errors: warnings.filter((warning) => noteTone(warning) === 'error').length };
  }

  function renderDownloads(scan, artifacts) {
    const files = FILES.filter(([file]) => artifacts.includes(file));
    setHtml($('#downloads'), files.map(([file, label]) => `<a class="${file === 'report.xlsx' ? 'primary-download' : ''}" href="${scanPath(scan.id)}/artifacts/${file}" download title="${e(file)}">${icon('download')}<span class="file-label"><span class="sr-only">Download ${e(file)} · </span>${e(label)}</span><span class="file-name" aria-hidden="true">${e(file)}</span></a>`).join(''));
    $('#report-center').classList.toggle('report-ready', files.length > 0);
    $('#report-center small').textContent = files.length ? `${files.length} files · ${scan.status === 'completed' ? 'complete audit' : 'partial results'}` : isRunning(scan.status) ? 'Reports appear here when the audit finishes.' : 'No reports were written for this audit.';
  }

  /** One tab per check the audit ran, each with a count of what needs attention. */
  function renderTabs(summary, notes) {
    const scan = summary.scan, checks = auditChecks(scan.options);
    const broken = FILTER_ORDER.filter(isFinding).reduce((sum, key) => sum + (summary.counts?.[key] || 0), 0);
    const hoursIssues = (summary.hours || []).filter(needsAttention).length;
    const profileCount = profileIssues(summary.profiles);
    const visible = { pages: checks.pages, profile: checks.profile, hours: checks.hours, notes: true };
    const counts = { pages: [broken, 'alert'], profile: [profileCount, 'alert'], hours: [hoursIssues, 'alert'], notes: [notes.total, notes.errors ? 'alert' : 'warn'] };
    for (const tab of TABS) {
      $(`#tab-${tab}`).classList.toggle('hidden', !visible[tab]);
      const badge = $(`#tab-count-${tab}`), [count, tone] = counts[tab];
      badge.textContent = count ? number(count) : '';
      badge.className = `tab-count ${count ? tone : ''}`;
    }
    // Only checks this audit ran have metrics; a zero for a check that never ran reads as a pass.
    $('.metric-findings').classList.toggle('hidden', !checks.pages);
    $('.metric-backlinks').classList.toggle('hidden', !scan.options.discovery.includes('backlinks'));
    $('.metric-hours').classList.toggle('hidden', !checks.hours);
    $('.metric-profile').classList.toggle('hidden', !checks.profile);
    $('#metric-hours').textContent = number(hoursIssues);
    $('.metric-hours').classList.toggle('has-value', hoursIssues > 0);
    $('#hours-caption').textContent = (summary.hours || []).length ? `of ${number(summary.hours.length)} restaurants` : 'Google and website disagree';
    $('#metric-profile').textContent = number(profileCount);
    $('.metric-profile').classList.toggle('has-value', profileCount > 0);
    $('#run-checks').textContent = [checks.pages && 'Broken pages', checks.profile && 'Business profile', checks.hours && 'Opening hours'].filter(Boolean).join(' · ');
    // Open on the first check with something to fix, then leave the choice to the reader.
    if (!state.tabChosen || !visible[state.tab]) {
      const issues = { pages: broken, profile: profileCount, hours: hoursIssues };
      const order = TABS.filter((tab) => tab !== 'notes' && visible[tab]);
      selectTab(order.find((tab) => issues[tab]) || (checks.pages ? 'pages' : order[0]) || 'notes', false);
    }
  }

  function selectTab(tab, chosen = true, focus = false) {
    state.tab = tab; if (chosen) state.tabChosen = true;
    for (const name of TABS) {
      const selected = name === tab, button = $(`#tab-${name}`);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`#panel-${name}`).hidden = !selected;
    }
    if (focus) $(`#tab-${tab}`).focus();
  }

  function renderSummary(summary) {
    const scan = summary.scan, checks = auditChecks(scan.options), running = isRunning(scan.status);
    renderProfiles(summary.profiles || [], checks.profile, running);
    renderHours(summary.hours || [], checks.hours, running);
    renderCoverage(scan, summary.googleDiscovery || []);
    renderFilterChips(summary.counts);
    // Break long hostnames at dots rather than mid-word.
    const label = targetLabel(scan);
    $('#run-target').innerHTML = e(label).replace(/\./g, '.<wbr>');
    $('#run-id').textContent = scan.id;
    onSelected(scan.id, label);
    renderProgress({ ...scan, scanId: scan.id, backlinkCount: summary.backlinkCount, message: scan.error || (running && scan.message) || progressCopy(scan.status) });
    renderTabs(summary, renderNotes(scan));
    renderDownloads(scan, summary.artifacts);
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

  function row(candidate, index) {
    const result = candidate.result, confidence = Math.round(result.confidence * 100);
    const sources = [...new Set(candidate.sources.map((source) => source.source))];
    const tone = ['hard_404', 'gone_410'].includes(result.classification) ? 'row-alert' : result.classification === 'soft_404_suspected' ? 'row-warn' : '';
    return `<tr class="${tone}"><td class="url-cell"><a href="${e(safeUrl(result.normalizedUrl))}" target="_blank" rel="noreferrer" title="${e(result.normalizedUrl)}">${e(result.normalizedUrl)}</a><small>${e(result.reasons[0] || result.error || result.title || 'No additional evidence')}</small></td><td><span class="classification ${e(result.classification)}"><span class="sr-only">${e(result.classification)} </span>${e(classificationLabel(result.classification))}</span></td><td><span class="sr-only">HTTP </span><span class="http-code">${result.httpStatus ?? '—'}</span></td><td><span class="confidence-value"><span class="confidence-bar" aria-hidden="true"><i data-confidence="${confidence}"></i></span>${confidence}%</span></td><td><span class="source-pills">${sources.map((source) => `<span>${e(sourceLabel(source))}</span>`).join('')}</span></td><td><button type="button" class="detail-button" data-evidence="${index}" aria-label="View evidence for ${e(result.normalizedUrl)}">Details ${icon('arrow')}</button></td></tr>`;
  }
  function renderRows() {
    const filtered = $('#result-search').value || $('#classification-filter').value !== 'all';
    const body = $('#results-body');
    const changed = setHtml(body, state.items.map(row).join('') || `<tr class="table-empty"><td colspan="6"><b>${filtered ? 'No matching pages' : isRunning(state.summary?.scan.status) ? 'Checking pages…' : 'No checked pages yet'}</b><p>${filtered ? 'Try a different search or outcome filter.' : 'Results appear here as each page is checked.'}</p></td></tr>`);
    // Inline style attributes are blocked by the page's CSP, so bar widths are set through CSSOM.
    if (changed) for (const bar of body.querySelectorAll('[data-confidence]')) bar.style.width = `${bar.dataset.confidence}%`;
    $('#result-count').textContent = number(state.total);
    $('#page-summary').textContent = state.total ? `${number(state.page * pageSize + 1)}–${number(state.page * pageSize + state.items.length)} of ${number(state.total)} checked pages` : '0 checked pages';
    $('#page-number').textContent = `Page ${state.page + 1} of ${Math.max(1, Math.ceil(state.total / pageSize))}`;
    $('#previous-page').disabled = !state.page;
    $('#next-page').disabled = (state.page + 1) * pageSize >= state.total;
    $$('#filter-chips [data-filter]').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.filter === $('#classification-filter').value)));
  }
  function renderSkeleton() {
    setHtml($('#results-body'), Array.from({ length: 6 }, () => '<tr class="skeleton-row" aria-hidden="true"><td><span></span></td><td><span></span></td><td><span></span></td><td><span></span></td><td><span></span></td><td><span></span></td></tr>').join(''));
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
        state.items = [];
        setHtml($('#results-body'), '<tr class="table-empty"><td colspan="6"><b>Results could not be loaded</b><p>Use the refresh button next to the audit name to try again.</p></td></tr>');
        $('#page-summary').textContent = 'Results unavailable'; showError(error);
      }
    } finally { if (state.resultsController === controller) $('.findings-section').removeAttribute('aria-busy'); }
  }
  async function finish(status, generation) {
    stop();
    await Promise.all([refresh(), loadResults()]);
    if (state.generation !== generation) return;
    notify(status === 'completed' ? 'Audit complete. Reports are ready.' : status === 'completed_partial' ? 'Audit finished with gaps. The Notes tab says what is missing.' : `Audit ${statusLabel(status).toLowerCase()}. Progress is saved.`, ['failed', 'completed_partial'].includes(status));
    onFinished();
  }
  function connect() {
    if (!state.summary || !isRunning(state.summary.scan.status)) return;
    const generation = state.generation;
    // Online there is no event stream: the page polls, and says so instead of claiming "live".
    const source = HOSTED ? { close() {} } : new EventSource(`${scanPath(state.id)}/events`); state.source = source;
    if (HOSTED) connection('Updating every few seconds', true);
    source.onopen = () => { if (state.generation === generation) connection('Live updates', true); };
    source.onmessage = (event) => {
      if (state.generation !== generation) return;
      let progress;
      try { progress = JSON.parse(event.data); } catch { return; }
      state.summaryVersion++;
      // Every event goes through the same frame queue, so a late paint can never overwrite the
      // final status with an earlier "Checking" one.
      paintProgress(progress);
      if (!isRunning(progress.status)) { void finish(progress.status, generation).catch(showError); return; }
      if (!state.resultsTimer) state.resultsTimer = setTimeout(() => { state.resultsTimer = null; void loadResults(); }, 1200);
    };
    source.onerror = () => { if (state.generation === generation) connection('Reconnecting…'); };
    // Polling also catches a missed completion event and reports written after cancellation.
    let pending = false, failures = 0;
    state.poll = setInterval(async () => {
      if (pending || generation !== state.generation || document.hidden) return;
      pending = true;
      try {
        const summary = await refresh();
        failures = 0;
        if (summary && !isRunning(summary.scan.status)) await finish(summary.scan.status, generation);
        else await loadResults();
      } catch (error) {
        connection('Connection lost · retrying');
        // A single missed poll is noise; three in a row is worth telling the reader about.
        if (++failures === 3) showError(new Error(`Lost contact with the audit (${error.message}). It keeps retrying; finished work is saved.`));
      }
      finally { pending = false; }
    }, HOSTED ? 3000 : 5000);
  }
  async function select(id) {
    if (!id) return;
    if (state.id === id && state.summary) return;
    stop(); state.resultsController?.abort();
    const generation = ++state.generation;
    state.id = id; state.summary = null; state.stage = null; state.page = 0; state.items = []; state.total = 0; state.tabChosen = false;
    $('#result-search').value = ''; $('#classification-filter').value = 'all';
    $('#empty-state').classList.add('hidden'); $('#run-view').classList.remove('hidden');
    $('#run-view').setAttribute('aria-busy', 'true');
    $('#run-view').classList.add('is-loading');
    $('#run-target').textContent = 'Loading audit…'; $('#run-id').textContent = id;
    $('#run-warnings').classList.add('hidden'); setHtml($('#downloads'), '');
    $('#google-coverage').classList.add('hidden');
    $('#profile-results').classList.add('hidden');
    setHtml($('#filter-chips'), '');
    $('#cancel-run').classList.add('hidden'); $('#resume-run').classList.add('hidden');
    renderSkeleton();
    try { await Promise.all([refresh(), loadResults()]); if (generation === state.generation) connect(); }
    catch (error) { if (generation === state.generation) { $('#run-view').classList.add('hidden'); $('#empty-state').classList.remove('hidden'); showError(error); } }
    finally { if (generation === state.generation) { $('#run-view').removeAttribute('aria-busy'); $('#run-view').classList.remove('is-loading'); } }
  }
  async function mutate(action) {
    if (!state.id || state.mutating) return;
    const id = state.id, generation = state.generation;
    state.mutating = true;
    const button = $(`#${action}-run`), original = button.innerHTML;
    button.disabled = true; button.innerHTML = `<span class="button-spinner" aria-hidden="true"></span><span>${action === 'cancel' ? 'Cancelling…' : 'Resuming…'}</span>`;
    try {
      await request(`${scanPath(id)}/${action}`, { method: 'POST' });
      if (generation !== state.generation) return;
      notify(action === 'cancel' ? 'Cancelling. Finished work is kept.' : 'Audit resumed from saved progress.');
      state.mutating = false; button.disabled = false; button.innerHTML = original;
      await refresh();
      if (action === 'resume') { stop(); connect(); }
    } catch (error) { notify(error.message, true); }
    finally { if (state.mutating) { button.disabled = false; button.innerHTML = original; } state.mutating = false; }
  }

  function evidence(index) {
    const candidate = state.items[index]; if (!candidate) return;
    state.evidence = index;
    const r = candidate.result;
    const item = (label, value) => `<div><dt>${e(label)}</dt><dd>${e(value ?? 'Not available')}</dd></div>`;
    const link = (label, url) => !url ? item(label, null) : `<div><dt>${e(label)}</dt><dd><a href="${e(safeUrl(url))}" target="_blank" rel="noreferrer">${e(url)} ↗</a></dd></div>`;
    const sourceFields = (source) => Object.entries(source).filter(([key, value]) => key !== 'source' && value !== undefined && value !== null && value !== '');
    const guidance = r.classification === 'soft_404_suspected' ? '<p>A soft 404 is a suspicion, not a certainty. Check the page before redirecting or removing it.</p>'
      : ['hard_404', 'gone_410'].includes(r.classification) ? '<p>Redirect this URL to the closest live page, or leave it missing if the content is gone for good.</p>'
      : ['timeout', 'network_error', 'blocked', 'server_error'].includes(r.classification) ? '<p>The page could not be read, so it is not counted as broken. Open it yourself to check.</p>' : '';
    $('#evidence-content').innerHTML = `<div><span class="classification ${e(r.classification)}">${e(classificationLabel(r.classification))}</span> <span id="evidence-position">${number(state.page * pageSize + index + 1)} of ${number(state.total)}</span></div>
      <p class="evidence-url">${e(r.normalizedUrl)}</p>
      <div class="evidence-callout"><b>Why this verdict</b><ul>${r.reasons.map((reason) => `<li>${e(reason)}</li>`).join('') || '<li>No additional signals recorded.</li>'}</ul>${guidance}</div>
      <dl class="evidence-facts">${item('HTTP status', r.httpStatus)}${item('Confidence', `${Math.round(r.confidence * 100)}%`)}${item('Page title', r.title || null)}${item('Main heading', r.h1 || null)}${link('Final URL', r.finalUrl)}${link('Canonical', r.canonical)}${item('Response time', `${number(r.responseMs)} ms`)}${item('Checked', new Date(r.checkedAt).toLocaleString())}${item('Robots crawling', r.robotsAllowed === null ? 'Unknown' : r.robotsAllowed ? 'Allowed' : 'Disallowed')}${r.error ? item('Error', r.error) : ''}</dl>
      <h3>Redirect chain</h3>${r.redirectChain.length ? `<ol class="evidence-chain">${r.redirectChain.map((hop) => `<li><span class="http-code">${hop.status ?? '—'}</span><span>${e(hop.url)}${hop.location ? ` → ${e(hop.location)}` : ''}</span></li>`).join('')}</ol>` : '<p class="muted">No redirects recorded.</p>'}
      <h3>Where this page was found</h3>${candidate.sources.map((source) => { const fields = sourceFields(source); return `<div class="evidence-source"><b>${e(sourceLabel(source.source))}</b>${fields.length ? `<dl>${fields.map(([key, value]) => key === 'searchUrl' ? link('Google search', value) : item(key.replace(/([A-Z])/g, ' $1').toLowerCase(), value)).join('')}</dl>` : '<p class="muted">Supplied directly to this audit.</p>'}</div>`; }).join('')}
      ${r.gsc ? `<h3>Google’s indexed version</h3><dl class="evidence-facts">${Object.entries(r.gsc).map(([key, value]) => item(key.replace(/([A-Z])/g, ' $1').toLowerCase(), Array.isArray(value) ? value.join(', ') : value)).join('')}</dl>` : ''}`;
    $('#previous-evidence').disabled = index <= 0;
    $('#next-evidence').disabled = index >= state.items.length - 1;
    if (!$('#evidence-dialog').open) $('#evidence-dialog').showModal();
    $('#evidence-dialog').scrollTop = 0;
  }
  $('#results-body').addEventListener('click', (event) => { const button = event.target.closest('[data-evidence]'); if (button) evidence(Number(button.dataset.evidence)); });
  $('#close-evidence').addEventListener('click', () => $('#evidence-dialog').close());
  $('#previous-evidence').addEventListener('click', () => evidence(state.evidence - 1));
  $('#next-evidence').addEventListener('click', () => evidence(state.evidence + 1));
  $('#evidence-dialog').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' && state.evidence > 0) evidence(state.evidence - 1);
    if (event.key === 'ArrowRight' && state.evidence < state.items.length - 1) evidence(state.evidence + 1);
  });
  // Closing the sheet returns focus to the row it was opened from, even after browsing to another.
  $('#evidence-dialog').addEventListener('close', () => $(`[data-evidence="${state.evidence}"]`)?.focus());
  $('#evidence-dialog').addEventListener('click', (event) => { if (event.target === $('#evidence-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  const filter = () => { state.page = 0; void loadResults(); };
  $('#classification-filter').addEventListener('change', filter);
  $('#filter-chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]'); if (!chip) return;
    const select = $('#classification-filter');
    select.value = chip.dataset.filter === select.value ? 'all' : chip.dataset.filter;
    filter();
  });
  $('#result-search').addEventListener('input', debounce(filter));
  $('#previous-page').addEventListener('click', () => { if (state.page > 0) { state.page--; void loadResults(); $('.findings-section').scrollIntoView({ block: 'nearest' }); } });
  $('#next-page').addEventListener('click', () => { if ((state.page + 1) * pageSize < state.total) { state.page++; void loadResults(); $('.findings-section').scrollIntoView({ block: 'nearest' }); } });
  $('#cancel-run').addEventListener('click', () => void mutate('cancel'));
  $('#resume-run').addEventListener('click', () => void mutate('resume'));
  $('#result-tabs').addEventListener('click', (event) => { const tab = event.target.closest('[data-tab]'); if (tab) selectTab(tab.dataset.tab); });
  $('#result-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const visible = TABS.filter((tab) => !$(`#tab-${tab}`).classList.contains('hidden'));
    const index = visible.indexOf(state.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visible.length) % visible.length;
    event.preventDefault(); selectTab(visible[next], true, true);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.poll && state.id) void refresh().catch(() => undefined); });
  window.addEventListener('pagehide', () => { stop(); state.resultsController?.abort(); });
  return { select, async reload() { if (state.id && !state.summary) return select(state.id); await Promise.all([refresh(), loadResults()]); if (state.resultsError) throw state.resultsError; }, id: () => state.id };
}
