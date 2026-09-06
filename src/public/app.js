const state = {
  activeId: null,
  eventSource: null,
  lastMessage: '',
  results: [],
  resultTotal: 0,
  refreshTimer: null,
  toastTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

document.addEventListener('DOMContentLoaded', async () => {
  $('#scan-form').addEventListener('submit', startScan);
  $('#refresh-runs').addEventListener('click', async () => {
    spinRefreshButton();
    await Promise.all([loadRuns(), refreshActive()]);
    showToast('Audit data refreshed');
  });
  $('#cancel-run').addEventListener('click', () => mutateActive('cancel'));
  $('#resume-run').addEventListener('click', () => mutateActive('resume'));
  $('#classification-filter').addEventListener('change', loadResults);
  $('#result-search').addEventListener('input', renderResultRows);
  $('#sites').addEventListener('input', updateTargetSummary);
  $('#urls').addEventListener('input', updateTargetSummary);
  $('#files').addEventListener('change', updateTargetSummary);
  for (const input of $$('.settings-grid input')) input.addEventListener('input', updateSettingsSummary);
  for (const input of $$('[name="discovery"]')) input.addEventListener('change', updateTargetSummary);
  setupFileDrop();
  setupSectionNavigation();
  updateTargetSummary();
  updateSettingsSummary();
  await Promise.all([loadGoogleStatus(), loadProviderStatus(), loadRuns()]);
});

async function startScan(event) {
  event.preventDefault();
  const error = $('#form-error');
  const button = $('#start-button');
  const originalButton = button.innerHTML;
  error.textContent = '';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = '<span>Preparing audit…</span><span class="button-spinner" aria-hidden="true"></span>';
  try {
    const sites = lines($('#sites').value);
    const urls = lines($('#urls').value);
    const files = [...$('#files').files];
    if (!sites.length && !urls.length && !files.length) {
      throw new Error('Add at least one restaurant website, exact URL, or URL file to begin.');
    }

    const inputFiles = [];
    for (const [index, file] of files.entries()) {
      button.querySelector('span').textContent = `Uploading ${index + 1} of ${files.length}…`;
      const response = await fetch(`/api/uploads?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const uploaded = await response.json();
      if (!response.ok) throw new Error(uploaded.error || `Could not upload ${file.name}`);
      inputFiles.push(uploaded.path);
    }

    button.querySelector('span').textContent = 'Launching Chromium…';
    const payload = {
      sites,
      urls,
      inputFiles,
      discovery: $$('[name="discovery"]:checked').map((input) => input.value),
      concurrency: numberValue('#concurrency'),
      perHostConcurrency: numberValue('#per-host'),
      hostDelayMs: numberValue('#host-delay'),
      crawlLimit: numberValue('#crawl-limit'),
      timeoutMs: numberValue('#timeout'),
      inspectGoogle: $('#inspect-google').checked,
      gscDays: numberValue('#gsc-days'),
      backlinkLimit: numberValue('#backlink-limit'),
      failOn: 'hard',
    };
    const response = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const scan = await response.json();
    if (!response.ok) throw new Error(scan.error || 'Could not start scan');
    showToast(`Audit ${shortId(scan.id)} started`);
    await loadRuns();
    await selectRun(scan.id);
    $('#audit-workspace').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  } catch (failure) {
    error.textContent = failure.message || String(failure);
    showToast(error.textContent, true);
    error.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = originalButton;
  }
}

async function loadGoogleStatus() {
  const target = $('#google-status');
  const gscTag = document.querySelector('input[name="discovery"][value="gsc"]')?.closest('.source-card')?.querySelector('.source-tag');
  const setGscTag = (label, available) => {
    if (!gscTag) return;
    gscTag.textContent = label;
    gscTag.classList.toggle('optional', !available);
  };
  try {
    const status = await api('/api/auth/google/status');
    if (status.authenticated) {
      target.dataset.state = 'connected';
      target.innerHTML = connectionMarkup('Search Console', 'Connected to verified properties', false);
      setGscTag('Connected', true);
    } else if (status.configured) {
      target.dataset.state = 'configured';
      target.innerHTML = connectionMarkup('Search Console', 'Connect Google account', true);
      setGscTag('Available', true);
      target.addEventListener('click', () => { window.location.href = '/api/auth/google/start'; });
      target.setAttribute('role', 'link');
      target.tabIndex = 0;
      target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') window.location.href = '/api/auth/google/start';
      });
    } else {
      target.dataset.state = 'optional';
      target.title = 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect';
      target.innerHTML = connectionMarkup('Search Console', 'Optional · credentials not set', false);
      setGscTag('Optional', false);
    }
  } catch {
    target.dataset.state = 'optional';
    target.innerHTML = connectionMarkup('Search Console', 'Connection unavailable', false);
    setGscTag('Unavailable', false);
  }
}

async function loadProviderStatus() {
  try {
    const status = await api('/api/providers/status');
    setSourceTag('searchapi', status.searchApi ? 'Ready' : 'Credentials', status.searchApi);
    setSourceTag('backlinks', status.dataForSeo ? 'Ready' : 'Credentials', status.dataForSeo);
  } catch {
    setSourceTag('searchapi', 'Unavailable', false);
    setSourceTag('backlinks', 'Unavailable', false);
  }
}

function setSourceTag(source, label, available) {
  const tag = document.querySelector(`input[name="discovery"][value="${source}"]`)?.closest('.source-card')?.querySelector('.source-tag');
  if (!tag) return;
  tag.textContent = label;
  tag.classList.toggle('optional', !available);
}

function connectionMarkup(title, subtitle, actionable) {
  return `<span class="connection-light" aria-hidden="true"></span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(subtitle)}</small></span>${actionable ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 12 3 3 7-7"/></svg>'}`;
}

async function loadRuns() {
  const { scans } = await api('/api/scans');
  const list = $('#run-list');
  list.innerHTML = scans.map((scan) => {
    const percentage = scan.total ? Math.round(scan.processed / scan.total * 100) : (scan.status === 'completed' ? 100 : 0);
    return `<button class="run-item ${scan.id === state.activeId ? 'active' : ''}" data-scan-id="${escapeHtml(scan.id)}" aria-label="Open audit ${escapeHtml(scan.id)}">
      <strong>${escapeHtml(scan.id)}</strong><span class="history-status ${escapeHtml(scan.status)}">${escapeHtml(statusLabel(scan.status))}</span>
      <span class="history-meta"><b>${number(scan.processed)}/${number(scan.total)}</b><small>checked · ${number(scan.findings)} findings</small></span><small>${relativeDate(scan.createdAt)}</small>
      <span class="sr-only">${percentage}% complete</span>
    </button>`;
  }).join('') || '<div class="history-empty">No audits yet. Your completed and resumable runs will appear here.</div>';
  list.querySelectorAll('[data-scan-id]').forEach((button) => button.addEventListener('click', () => selectRun(button.dataset.scanId)));
  if (!state.activeId && scans[0]) await selectRun(scans[0].id);
}

async function selectRun(scanId) {
  state.activeId = scanId;
  state.lastMessage = '';
  clearActiveConnection();
  $('#empty-state').classList.add('hidden');
  $('#run-view').classList.remove('hidden');
  await Promise.all([refreshActive(), loadResults()]);
  connectToRun(scanId);
  $$('.run-item').forEach((item) => item.classList.toggle('active', item.dataset.scanId === scanId));
}

function connectToRun(scanId) {
  state.eventSource = new EventSource(`/api/scans/${encodeURIComponent(scanId)}/events`);
  state.eventSource.onmessage = async (event) => {
    const progress = JSON.parse(event.data);
    state.lastMessage = progress.message;
    renderProgress(progress);
    if (['completed', 'cancelled', 'failed'].includes(progress.status)) {
      clearActiveConnection();
      await Promise.all([refreshActive(), loadResults(), loadRuns()]);
      showToast(progress.status === 'completed' ? 'Audit complete — reports are ready' : `Audit ${progress.status}` , progress.status === 'failed');
    }
  };
  state.eventSource.onerror = () => {
    if (!state.refreshTimer) state.refreshTimer = setInterval(() => void refreshActive(), 4_000);
  };
}

function clearActiveConnection() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

async function refreshActive() {
  if (!state.activeId) return;
  const summary = await api(`/api/scans/${encodeURIComponent(state.activeId)}`);
  const scan = summary.scan;
  renderProgress({ ...scan, scanId: scan.id, backlinkCount: summary.backlinkCount, message: state.lastMessage || (scan.error ? `Failed: ${scan.error}` : progressCopy(scan.status)) });
  const running = ['queued', 'discovering', 'scanning', 'reporting'].includes(scan.status);
  $('#cancel-run').classList.toggle('hidden', !running);
  $('#resume-run').classList.toggle('hidden', !['cancelled', 'failed'].includes(scan.status));

  const artifactOrder = ['report.xlsx', 'findings.csv', 'all-urls.csv', 'backlinks.csv', 'run.json'];
  const artifacts = [...summary.artifacts].sort((left, right) => artifactOrder.indexOf(left) - artifactOrder.indexOf(right));
  $('#downloads').innerHTML = artifacts.map((file) => {
    const primary = file === 'report.xlsx' ? ' primary-download' : '';
    return `<a class="${primary}" href="/api/scans/${encodeURIComponent(scan.id)}/artifacts/${encodeURIComponent(file)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 19h14"/></svg>Download ${escapeHtml(file)}</a>`;
  }).join('');
  $('#report-center').classList.toggle('report-ready', artifacts.length > 0);
  const reportSubtitle = $('#report-center small');
  reportSubtitle.textContent = artifacts.length ? `${artifacts.length} export formats · generated locally` : 'Reports appear here when the run completes.';
}

function renderProgress(progress) {
  $('#run-id').textContent = progress.scanId || state.activeId;
  const pill = $('#run-status');
  pill.textContent = statusLabel(progress.status);
  pill.className = `status-pill ${progress.status}`;
  $('#metric-total').textContent = number(progress.total);
  $('#metric-processed').textContent = number(progress.processed);
  $('#metric-findings').textContent = number(progress.findings);
  $('#metric-backlinks').textContent = number(progress.backlinkCount);
  $('#progress-message').textContent = readableProgressMessage(progress.message || progress.status);
  const percentage = progress.total ? Math.min(100, Math.round(progress.processed / progress.total * 100)) : (progress.status === 'completed' ? 100 : 0);
  $('#progress-percent').textContent = `${percentage}%`;
  $('#progress-orb').style.setProperty('--progress', `${percentage * 3.6}deg`);
  $('#progress-orb').setAttribute('aria-label', `Audit ${percentage}% complete`);
  $('#checked-caption').textContent = progress.total ? `${percentage}% of discovered URLs` : 'Waiting to verify';
  updateStages(progress.status);
}

function updateStages(status) {
  const order = ['discovering', 'scanning', 'reporting'];
  const terminal = ['completed', 'cancelled', 'failed'].includes(status);
  const currentIndex = terminal ? (status === 'completed' ? 3 : order.indexOf('scanning')) : order.indexOf(status);
  for (const element of $$('.stage-track [data-stage]')) {
    const index = order.indexOf(element.dataset.stage);
    element.classList.toggle('complete', currentIndex > index || status === 'completed');
    element.classList.toggle('current', currentIndex === index && !terminal);
  }
}

async function loadResults() {
  if (!state.activeId) return;
  const classification = $('#classification-filter').value;
  const data = await api(`/api/scans/${encodeURIComponent(state.activeId)}/results?classification=${encodeURIComponent(classification)}&limit=500`);
  state.results = data.items;
  state.resultTotal = data.total;
  renderResultRows();
}

function renderResultRows() {
  const query = $('#result-search').value.trim().toLowerCase();
  const items = state.results.filter((candidate) => {
    if (!query) return true;
    const result = candidate.result;
    return [result.normalizedUrl, result.finalUrl, result.title, result.classification, ...result.reasons]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
  $('#result-count').textContent = state.resultTotal > items.length && !query ? `${items.length}/${state.resultTotal}` : number(items.length);
  $('#results-body').innerHTML = items.map((candidate) => resultRow(candidate)).join('') || '<tr><td class="empty-table" colspan="5">No checked URLs match this view yet.</td></tr>';
  for (const bar of $$('.confidence-bar > span')) bar.style.width = `${Number(bar.dataset.value || 0)}%`;
}

function resultRow(candidate) {
  const result = candidate.result;
  const sources = [...new Set(candidate.sources.map((source) => source.source))];
  const reason = result.reasons[0] || result.title || 'No additional evidence';
  const confidence = Math.round(Number(result.confidence || 0) * 100);
  return `<tr>
    <td class="url-cell"><a href="${escapeAttribute(result.finalUrl || result.normalizedUrl)}" target="_blank" rel="noreferrer" title="${escapeAttribute(result.normalizedUrl)}">${escapeHtml(result.normalizedUrl)}</a><small>${escapeHtml(reason)} · ${number(result.responseMs)} ms</small></td>
    <td><span class="classification ${escapeHtml(result.classification)}"><span class="sr-only">${escapeHtml(result.classification)} </span>${escapeHtml(classificationLabel(result.classification))}</span></td>
    <td><span class="http-code">${result.httpStatus ?? '—'}</span></td>
    <td class="confidence-cell"><span class="confidence-value"><span class="confidence-bar"><span data-value="${confidence}"></span></span>${confidence}%</span></td>
    <td><span class="source-pills">${sources.map((source) => `<span>${escapeHtml(sourceLabel(source))}</span>`).join('')}</span></td>
  </tr>`;
}

async function mutateActive(action) {
  if (!state.activeId) return;
  try {
    await api(`/api/scans/${encodeURIComponent(state.activeId)}/${action}`, { method: 'POST' });
    showToast(action === 'resume' ? 'Audit resumed' : 'Cancellation requested');
    if (action === 'resume') await selectRun(state.activeId);
    else await refreshActive();
  } catch (error) {
    showToast(error.message || String(error), true);
  }
}

function updateTargetSummary() {
  const siteCount = lines($('#sites').value).length;
  const urlCount = lines($('#urls').value).length;
  const files = [...$('#files').files];
  $('#site-count').textContent = `${siteCount} ${siteCount === 1 ? 'site' : 'sites'}`;
  $('#url-count').textContent = `${urlCount} ${urlCount === 1 ? 'URL' : 'URLs'}`;
  $('#file-summary').textContent = files.length ? files.map((file) => file.name).join(', ') : 'No files selected';
  const sourceCount = $$('[name="discovery"]:checked').length;
  const totalInputs = siteCount + urlCount + files.length;
  $('#launch-detail').textContent = totalInputs
    ? `${number(totalInputs)} input${totalInputs === 1 ? '' : 's'} · ${sourceCount} discovery source${sourceCount === 1 ? '' : 's'} selected`
    : 'Add a website, exact URL, or file to begin';
  $('.ready-chip').innerHTML = totalInputs ? '<span></span> Targets ready' : '<span></span> Ready';
}

function updateSettingsSummary() {
  const cap = numberValue('#crawl-limit');
  $('#settings-summary').textContent = `${numberValue('#concurrency')} workers · ${compactNumber(cap)} crawl cap`;
}

function setupFileDrop() {
  const drop = $('.file-drop');
  for (const eventName of ['dragenter', 'dragover']) {
    drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.add('dragging'); });
  }
  for (const eventName of ['dragleave', 'drop']) {
    drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove('dragging'); });
  }
  drop.addEventListener('drop', (event) => {
    const supported = [...event.dataTransfer.files].filter((file) => /\.(txt|csv|xlsx|xlsm)$/i.test(file.name));
    if (!supported.length) return showToast('Drop a TXT, CSV, XLSX, or XLSM file', true);
    const transfer = new DataTransfer();
    for (const file of supported) transfer.items.add(file);
    $('#files').files = transfer.files;
    updateTargetSummary();
  });
}

function setupSectionNavigation() {
  const links = $$('.sidebar-nav a');
  const sections = links.map((link) => document.querySelector(link.getAttribute('href'))).filter(Boolean);
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
    if (!visible) return;
    links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`));
  }, { rootMargin: '-20% 0px -60% 0px', threshold: [0, .25, .6] });
  sections.forEach((section) => observer.observe(section));
}

function spinRefreshButton() {
  const button = $('#refresh-runs');
  button.classList.remove('spinning');
  requestAnimationFrame(() => button.classList.add('spinning'));
  setTimeout(() => button.classList.remove('spinning'), 500);
}

function showToast(message, isError = false) {
  const toast = $('#toast');
  $('#toast-message').textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3_800);
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function progressCopy(status) {
  return ({ queued: 'Queued and waiting for a worker', discovering: 'Collecting and deduplicating candidate URLs', scanning: 'Rendering pages and evaluating live outcomes', reporting: 'Building audit exports', completed: 'Audit complete', cancelled: 'Audit cancelled; partial reports are available', failed: 'Audit failed' })[status] || status;
}

function readableProgressMessage(message) {
  const match = String(message).match(/^([a-z_]+):\s(.+)$/i);
  return match ? `${classificationLabel(match[1])} · ${match[2]}` : String(message);
}

function statusLabel(status) { return ({ queued: 'Queued', discovering: 'Discovering', scanning: 'Verifying', reporting: 'Reporting', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' })[status] || status; }
function classificationLabel(value) { return ({ hard_404: 'Hard 404', gone_410: 'Gone 410', soft_404_suspected: 'Soft 404 suspected', redirected: 'Redirected', ok: 'Healthy', server_error: 'Server error', blocked: 'Blocked', timeout: 'Timed out', network_error: 'Network error' })[value] || value.replaceAll('_', ' '); }
function sourceLabel(value) { return ({ import: 'Import', sitemap: 'Sitemap', crawl: 'Crawl', searchapi: 'Google', gsc: 'GSC', backlinks: 'Backlink' })[value] || value; }
function lines(value) { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function numberValue(selector) { return Number($(selector).value); }
function number(value) { return Number(value || 0).toLocaleString(); }
function compactNumber(value) { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0); }
function shortId(value) { return String(value).split('-').slice(-1)[0]; }
function relativeDate(value) {
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
