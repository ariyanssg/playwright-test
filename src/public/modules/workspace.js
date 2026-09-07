import { request } from './api.js';
import { $, escapeHtml as e, number, targetLabel, relativeDate, statusLabel, isRunning, icon } from './ui.js';
export function createWorkspace(onSelect) {
  let scans = [], requestVersion = 0;
  const status = (scan) => `<span class="history-status ${e(scan.status)}">${e(statusLabel(scan.status))}</span>`;
  function renderHistory() {
    const query = $('#history-search').value.trim().toLowerCase();
    const filter = $('#history-filter').value;
    const filtered = scans.filter((scan) => `${targetLabel(scan)} ${scan.id} ${scan.options.sites.join(' ')} ${scan.options.urls.join(' ')}`.toLowerCase().includes(query) && (filter === 'all' || (filter === 'active' ? isRunning(scan.status) : scan.status === filter)));
    $('#history-count').textContent = `${number(filtered.length)} of ${number(scans.length)} audits`;
    $('#run-list').innerHTML = filtered.map((scan) => `<button class="run-item" data-scan-id="${e(scan.id)}" aria-label="Open audit ${e(scan.id)}"><span class="history-site"><span class="site-icon">${icon('globe')}</span><span><strong>${e(targetLabel(scan))}</strong><small>${e(scan.id)}</small></span></span>${status(scan)}<span class="history-progress"><b>${number(scan.processed)} <small>/ ${number(scan.total)}</small></b><progress max="${Math.max(1, scan.total)}" value="${scan.processed}" aria-label="Pages checked"></progress></span><span class="finding-count ${scan.findings ? 'has-findings' : ''}">${number(scan.findings)}<small class="mobile-only"> findings</small></span><time datetime="${e(scan.createdAt)}" title="${e(new Date(scan.createdAt).toLocaleString())}">${relativeDate(scan.createdAt)}</time>${icon('arrow')}</button>`).join('') || `<div class="history-empty">${scans.length ? '<b>No matching audits</b><p>Try another website, audit ID, or status.</p>' : '<b>Your audit history starts here.</b><p>Create your first audit to build a clearer picture of your websites.</p><a class="text-link" href="#new-audit">Create an audit →</a>'}</div>`;
  }
  function render() {
    $('#overview-audits').textContent = number(scans.length);
    $('#overview-checked').textContent = number(scans.reduce((sum, scan) => sum + scan.processed, 0));
    $('#overview-findings').textContent = number(scans.reduce((sum, scan) => sum + scan.findings, 0));
    $('#overview-active').textContent = number(scans.filter((scan) => isRunning(scan.status)).length);
    $('#nav-run-count').textContent = number(scans.length);
    $('#recent-list').innerHTML = scans.slice(0, 4).map((scan) => `<button class="recent-item" data-scan-id="${e(scan.id)}"><span class="site-icon">${icon('globe')}</span><span class="recent-copy"><b>${e(targetLabel(scan))}</b><small>${number(scan.processed)} pages checked <span>·</span> ${number(scan.findings)} findings</small></span><span class="recent-meta">${status(scan)}<small>${relativeDate(scan.createdAt)}</small></span>${icon('arrow')}</button>`).join('') || '<div class="history-empty"><span class="empty-mini">↗</span><b>Good things start with a first look.</b><p>Your latest audits will appear here.</p><a class="text-link" href="#new-audit">Create your first audit →</a></div>';
    renderHistory();
  }
  for (const id of ['run-list', 'recent-list']) $(`#${id}`).addEventListener('click', (event) => { const row = event.target.closest('[data-scan-id]'); if (row) onSelect(row.dataset.scanId); });
  $('#history-search').addEventListener('input', renderHistory);
  $('#history-filter').addEventListener('change', renderHistory);
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return {
    async load() {
      const version = ++requestVersion;
      const data = await request('/api/scans');
      if (version !== requestVersion) return;
      scans = data.scans; render();
    },
    latest: () => scans[0]?.id,
    update(progress) { const scan = scans.find((scan) => scan.id === progress.scanId); if (scan) { Object.assign(scan, progress); render(); } },
    hasActive: () => scans.some((scan) => isRunning(scan.status)),
  };
}
