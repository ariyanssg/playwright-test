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
  render(false);
  return { go(view, run) { const hash = `#${view}${run ? `?run=${encodeURIComponent(run)}` : ''}`; if (location.hash === hash) render(true); else location.hash = hash; } };
}
