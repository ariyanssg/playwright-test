import { $, $$ } from './ui.js';
const views = { overview: 'Overview', 'new-audit': 'New audit', 'audit-workspace': 'Findings', 'run-history': 'Audit history', connections: 'Connections' };
export function initRouter(onNavigate) {
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
    $('#current-view-name').textContent = views[view];
    document.title = `${views[view]} · Signal404`;
    if (focus) { $(`#${view} h1`).focus({ preventScroll: true }); window.scrollTo(0, 0); }
    onNavigate(view, new URLSearchParams(query).get('run'));
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
    const commands = [
      { title: 'New audit', hint: 'Set targets and launch', run() { location.hash = '#new-audit'; } },
      { title: 'Open findings', hint: 'Latest audit results', run() { location.hash = '#audit-workspace'; } },
      { title: 'Audit history', hint: 'Reopen any report', run() { location.hash = '#run-history'; } },
      { title: 'Connections', hint: 'Data sources', run() { location.hash = '#connections'; } },
      { title: 'Back to overview', hint: 'Workspace at a glance', run() { location.hash = '#overview'; } },
    ];
    let selected = 0;
    let items = commands;
    const paint = () => {
      list.innerHTML = items.map((item, index) => `<li><button role="option" data-i="${index}" aria-selected="${index === selected}"><span><b>${item.title}</b><small>${item.hint}</small></span><span class="command-kbd">${index === selected ? 'Enter' : `#${index + 1}`}</span></button></li>`).join('') || '<li><p class="muted" style="padding:12px">No matching actions.</p></li>';
    };
    const open = () => { items = commands; selected = 0; input.value = ''; paint(); if (!dialog.open) dialog.showModal(); input.focus(); };
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (dialog.open) dialog.close(); else open(); }
    });
    const searchBtn = $('#global-search');
    if (searchBtn) searchBtn.addEventListener('click', open);
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      items = !q ? commands : commands.filter((item) => `${item.title} ${item.hint}`.toLowerCase().includes(q));
      selected = 0; paint();
    });
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
    paint();
  }
  return { go(view, run) { const hash = `#${view}${run ? `?run=${encodeURIComponent(run)}` : ''}`; if (location.hash === hash) render(true); else location.hash = hash; } };
}
