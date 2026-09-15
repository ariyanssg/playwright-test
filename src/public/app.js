import { $, notify, dismissToast, showError } from './modules/ui.js';
import { initRouter } from './modules/router.js';
import { createWorkspace } from './modules/workspace.js';
import { initSetup } from './modules/setup.js';
import { createAudit } from './modules/audit.js';
import { loadConnections } from './modules/connections.js';

if (globalThis.SIGNAL404_HOSTED) document.addEventListener('click', async (event) => {
  const link = event.target.closest('a[href*="/artifacts/"]');
  const match = link?.getAttribute('href')?.match(/^\/api\/scans\/([^/]+)\/artifacts\/([^/]+)$/);
  if (!match) return;
  event.preventDefault();
  try { const { download } = await import('./modules/hosted.js'); await download(match[1], match[2]); } catch (error) { showError(error); }
});

// The composition root owns feature coordination; each feature owns its own state.
let router;
const workspace = createWorkspace((id) => router.go('audit-workspace', id));
const audit = createAudit(workspace.update, () => { void workspace.load().catch(showError); });
const initialRuns = workspace.load().catch(showError);
const applyProviderStatus = initSetup((id) => { router.go('audit-workspace', id); void workspace.load().catch(showError); });
router = initRouter(async (view, id) => {
  if (view === 'audit-workspace') {
    await initialRuns;
    // Ignore a route that was superseded while the initial request was pending.
    if (!location.hash.startsWith('#audit-workspace')) return;
    await audit.select(id || audit.id() || workspace.latest());
  }
});
void loadConnections(applyProviderStatus).catch(showError);
$('#dismiss-toast').addEventListener('click', dismissToast);
dismissToast();
async function reload(button, connections = false) {
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  $('#app-error').classList.add('hidden');
  try {
    await Promise.all([workspace.load(), audit.reload(), ...(connections ? [loadConnections(applyProviderStatus)] : [])]);
    if (location.hash.startsWith('#audit-workspace') && !audit.id()) await audit.select(workspace.latest());
    notify('Workspace is up to date');
  } catch (error) { showError(error); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}
$('#refresh-runs').addEventListener('click', (event) => void reload(event.currentTarget));
$('#retry-load').addEventListener('click', (event) => void reload(event.currentTarget, true));
let refreshing = false;
const timer = setInterval(async () => {
  if (document.hidden || refreshing || !workspace.hasActive()) return;
  refreshing = true;
  try { await workspace.load(); } catch (error) { showError(error); } finally { refreshing = false; }
}, 10000);
window.addEventListener('pagehide', () => clearInterval(timer));
