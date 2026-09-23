import { request } from './api.js';
import { $, escapeHtml as e, number, targetLabel, relativeDate, statusLabel, isRunning, icon, throttle, setHtml } from './ui.js';

const RECENT = 6;

export function createWorkspace(onSelect) {
  let scans = [], requestVersion = 0, loaded = false;
  const status = (scan) => `<span class="history-status ${e(scan.status)}">${e(statusLabel(scan.status))}</span>`;
  const ticketNo = (id) => `#${String(id).split('-').pop().slice(0, 6).toUpperCase()}`;

  function renderHistory() {
    const query = $('#history-search').value.trim().toLowerCase();
    const filter = $('#history-filter').value;
    const filtered = scans.filter((scan) => `${targetLabel(scan)} ${scan.id} ${scan.options.sites.join(' ')} ${scan.options.urls.join(' ')}`.toLowerCase().includes(query) && (filter === 'all' || (filter === 'active' ? isRunning(scan.status) : scan.status === filter)));
    $('#history-count').textContent = `${number(filtered.length)} of ${number(scans.length)} audits`;
    setHtml($('#run-list'), filtered.map((scan) => {
      const share = scan.total ? Math.min(100, Math.round(scan.processed / scan.total * 100)) : 0;
      return `<button type="button" class="run-item" data-scan-id="${e(scan.id)}" aria-label="Open audit ${e(scan.id)}"><span class="history-site"><span class="site-icon">${icon('globe')}</span><span><strong>${e(targetLabel(scan))}</strong><small>${e(scan.id)}</small></span></span>${status(scan)}<span class="history-progress"><span>${number(scan.processed)} <small>/ ${number(scan.total)}</small></span><span class="bar" aria-hidden="true"><i data-share="${share}"></i></span></span><span class="finding-count ${scan.findings ? 'has-findings' : ''}">${number(scan.findings)}<small class="mobile-only">&nbsp;broken</small></span><time datetime="${e(scan.createdAt)}" title="${e(new Date(scan.createdAt).toLocaleString())}">${relativeDate(scan.createdAt)}</time>${icon('arrow')}</button>`;
    }).join('') || `<div class="history-empty">${scans.length ? '<b>No matching audits</b><p>Try another website, audit ID or status.</p>' : '<b>No audits yet</b><p>Your first audit will be listed here, with its reports.</p><a class="button primary compact" href="#new-audit">Start an audit</a>'}</div>`);
    // Inline style attributes are blocked by the page's CSP, so bar widths are set through CSSOM.
    for (const bar of document.querySelectorAll('#run-list .bar i[data-share]')) bar.style.width = `${bar.dataset.share}%`;
  }

  function renderTickets() {
    const recent = scans.slice(0, RECENT);
    setHtml($('#recent-list'), recent.map((scan) => `<button type="button" class="ticket recent-item" data-scan-id="${e(scan.id)}" aria-label="Open audit of ${e(targetLabel(scan))}, ${e(statusLabel(scan.status))}">
      <span class="ticket-top"><span>${e(ticketNo(scan.id))}</span><time datetime="${e(scan.createdAt)}">${relativeDate(scan.createdAt)}</time></span>
      <b class="ticket-site">${e(targetLabel(scan).replace(/^www\./, '')).replace(/\./g, '.<wbr>')}</b>
      ${status(scan)}
      <span class="ticket-lines"><span><span>Checked</span><b>${number(scan.processed)} / ${number(scan.total)}</b></span><span class="${scan.findings ? 'broken' : ''}"><span>Broken</span><b>${number(scan.findings)}</b></span></span>
      <span class="ticket-open">Open audit ${icon('arrow')}</span>
    </button>`).join('') || `<div class="ticket ticket-empty"><b>No audits on the rail yet</b><p>Start an audit and it will hang here while it runs, with its broken-page count once it finishes.</p><a class="button primary compact" href="#new-audit">Start an audit</a></div>`);
  }

  function renderCounts() {
    $('#overview-audits').textContent = number(scans.length);
    $('#overview-checked').textContent = number(scans.reduce((sum, scan) => sum + scan.processed, 0));
    $('#overview-findings').textContent = number(scans.reduce((sum, scan) => sum + scan.findings, 0));
    $('#overview-active').textContent = number(scans.filter((scan) => isRunning(scan.status)).length);
    $('#nav-run-count').textContent = number(scans.length);
  }

  function render() {
    renderCounts(); renderTickets(); renderHistory();
    // Tickets "print" onto the rail once; later refreshes must not replay it on every update.
    requestAnimationFrame(() => $('#recent-list').classList.add('settled'));
  }
  // Live progress arrives per checked URL; the lists repaint a few times a second at most.
  const scheduleRender = throttle(render, 500);

  for (const id of ['run-list', 'recent-list']) $(`#${id}`).addEventListener('click', (event) => { const row = event.target.closest('[data-scan-id]'); if (row) onSelect(row.dataset.scanId); });
  $('#history-search').addEventListener('input', renderHistory);
  $('#history-filter').addEventListener('change', renderHistory);
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return {
    async load() {
      const version = ++requestVersion;
      const data = await request('/api/scans');
      if (version !== requestVersion) return;
      scans = data.scans; loaded = true; render();
    },
    latest: () => scans[0]?.id,
    scans: () => scans,
    loaded: () => loaded,
    update(progress) {
      const scan = scans.find((item) => item.id === progress.scanId);
      if (!scan) return;
      for (const key of ['status', 'total', 'processed', 'findings']) if (progress[key] !== undefined) scan[key] = progress[key];
      scheduleRender();
    },
    hasActive: () => scans.some((scan) => isRunning(scan.status)),
  };
}
