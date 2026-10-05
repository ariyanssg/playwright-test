import { $, $$, escapeHtml as e, statusLabel, targetLabel } from './ui.js';
const views = { overview: 'Overview', 'new-audit': 'New audit', 'audit-workspace': 'Audit', 'run-history': 'Audits', connections: 'Connections' };
export function initRouter(onNavigate, listAudits = () => []) {
  const sidebar = $('#sidebar');
  const mobile = matchMedia('(max-width: 760px)');
  let open = false;
  function setMenu(value, restore = false) {
    open = value;
    sidebar.classList.toggle('open', value);
    sidebar.inert = mobile.matches && !value;
    $('#sidebar-backdrop').classList.toggle('hidden', !value);
    $('#menu-toggle').setAttribute('aria-expanded', String(value));
    $('#menu-toggle').setAttribute('aria-label', value ? 'Close navigation' : 'Open navigation');
    document.body.classList.toggle('menu-open', value);
    $('.page-shell').inert = value;
    if (value) $('.sidebar-nav a').focus();
    else if (restore) $('#menu-toggle').focus();
  }
  $('#menu-toggle').addEventListener('click', () => setMenu(!open));
  $('#sidebar-backdrop').addEventListener('click', () => setMenu(false, true));
  document.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') { setMenu(false, true); return; }
    if (event.key === 'Tab') {
      const links = $$('a[href], button, [tabindex="0"]', sidebar);
      const first = links[0], last = links.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  mobile.addEventListener('change', () => setMenu(false));
  function render(focus) {
    const [requested, query = ''] = location.hash.slice(1).split('?');
    if (requested === 'main-content') { $('#main-content').focus(); return; }
    const view = views[requested] ? requested : 'overview';
    if ($('#evidence-dialog').open) $('#evidence-dialog').close();
    setMenu(false);
    $$('.workspace-view').forEach((section) => section.classList.toggle('hidden', section.id !== view));
    $$('[data-view-link]').forEach((link) => {
      const selected = link.dataset.viewLink === view;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    current.view = view;
    paintLocation();
    if (focus) { ($$(`#${view} h1`).find((heading) => heading.offsetParent) ?? $(`#${view} h1`)).focus({ preventScroll: true }); window.scrollTo(0, 0); }
    const params = new URLSearchParams(query);
    onNavigate(view, params.get('run'), params);
  }
  // The open audit is named in the breadcrumb, the sidebar and the tab title, so it is always
  // clear which audit the page shows and one click gets back to it from anywhere.
  const current = { view: 'overview', id: null, label: '' };
  function paintLocation() {
    const onAudit = current.view === 'audit-workspace';
    const name = onAudit && current.label ? current.label : views[current.view];
    $('#current-view-name').textContent = name;
    $('#crumb-parent').classList.toggle('hidden', !onAudit);
    $('#crumb-parent-slash').classList.toggle('hidden', !onAudit);
    document.title = `${name} · Signal404`;
    const link = $('#nav-current');
    link.href = current.id ? `#audit-workspace?run=${encodeURIComponent(current.id)}` : '#audit-workspace';
    link.classList.toggle('empty', !current.id);
    $('#nav-current-name').textContent = current.label || 'None open';
  }
  window.addEventListener('hashchange', () => render(true));
  initCommandPalette();
  render(false);
  function initCommandPalette() {
    const dialog = $('#command-palette');
    const input = $('#command-input');
    const list = $('#command-list');
    if (!dialog || !input || !list || dialog.dataset.ready) return;
    dialog.dataset.ready = 'true';
    const pages = [
      { title: 'New audit: broken pages', hint: 'Find 404 and soft-404 pages', run() { location.hash = '#new-audit?task=pages'; } },
      { title: 'New audit: business profile', hint: 'Compare the website with Google', run() { location.hash = '#new-audit?task=profile'; } },
      { title: 'New audit: opening hours', hint: 'Compare hours with Google', run() { location.hash = '#new-audit?task=hours'; } },
      { title: 'Open audit', hint: 'The audit you opened last', run() { location.hash = current.id ? `#audit-workspace?run=${encodeURIComponent(current.id)}` : '#audit-workspace'; } },
      { title: 'All audits', hint: 'Every saved audit', run() { location.hash = '#run-history'; } },
      { title: 'Connections', hint: 'Data sources and keys', run() { location.hash = '#connections'; } },
      { title: 'Overview', hint: 'Latest audits', run() { location.hash = '#overview'; } },
    ];
    // Recent audits are jump targets too: the palette is the fastest way back to a report.
    const commands = () => [...pages, ...listAudits().slice(0, 30).map((scan) => ({ title: targetLabel(scan), hint: `${statusLabel(scan.status)} · ${scan.findings} broken · ${scan.id}`, run() { location.hash = `#audit-workspace?run=${encodeURIComponent(scan.id)}`; } }))];
    let selected = 0;
    let items = pages;
    const paint = () => {
      list.innerHTML = items.map((item, index) => `<li><button type="button" role="option" data-i="${index}" aria-selected="${index === selected}"><span><b>${e(item.title)}</b><small>${e(item.hint)}</small></span><span class="command-kbd">${index === selected ? 'Enter ↵' : ''}</span></button></li>`).join('') || '<li class="command-empty">No matching pages or audits.</li>';
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    const filterItems = () => {
      const q = input.value.trim().toLowerCase();
      const all = commands();
      items = !q ? all.slice(0, 12) : all.filter((item) => `${item.title} ${item.hint}`.toLowerCase().includes(q)).slice(0, 30);
      selected = 0; paint();
    };
    const open = () => { input.value = ''; filterItems(); if (!dialog.open) dialog.showModal(); input.focus(); };
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (dialog.open) dialog.close(); else open(); }
    });
    if (/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)) $('#command-key').textContent = '⌘K';
    const searchBtn = $('#global-search');
    if (searchBtn) searchBtn.addEventListener('click', open);
    input.addEventListener('input', filterItems);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); selected = Math.min(items.length - 1, selected + 1); paint(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); selected = Math.max(0, selected - 1); paint(); }
      else if (event.key === 'Enter') { event.preventDefault(); const item = items[selected]; dialog.close(); item?.run(); }
    });
    list.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-i]');
      if (!button) return;
      const item = items[Number(button.dataset.i)]; dialog.close(); item?.run();
    });
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    paint();
  }
  return {
    go(view, run) { const hash = `#${view}${run ? `?run=${encodeURIComponent(run)}` : ''}`; if (location.hash === hash) render(true); else location.hash = hash; },
    /** Names the open audit everywhere the page refers to it. */
    setCurrent(id, label) { current.id = id; current.label = label || ''; paintLocation(); },
  };
}
