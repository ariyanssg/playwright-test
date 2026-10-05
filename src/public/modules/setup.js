import { request, createScan } from './api.js';
import { $, $$, lines, number, notify } from './ui.js';
const HOSTED = Boolean(globalThis.SIGNAL404_HOSTED);
const presets = HOSTED ? { google: ['google'], all: ['import', 'sitemap', 'crawl', 'google', 'backlinks'], local: ['import', 'sitemap', 'crawl'], import: ['import'] } : { google: ['google'], all: ['import', 'sitemap', 'crawl', 'google', 'gsc', 'backlinks'], local: ['import', 'sitemap', 'crawl'], import: ['import'] };
const PRESET_LABEL = { google: 'Google results', all: 'Every source', local: 'The website', import: 'Your list' };
const SOURCE_LABEL = { import: 'your list', sitemap: 'sitemaps', crawl: 'a crawl', google: 'Google', gsc: 'Search Console', backlinks: 'backlinks' };
/** Where credentials live: a hosted operator edits Netlify's settings, a local one edits .env. */
const KEY_HOME = HOSTED ? 'the Netlify environment variables' : 'your .env file and restart the dashboard';
// Each profile source is served by a different Google product, so each has its own
// prerequisite. Saying which one is missing is the difference between a blank comparison
// table and a fix the operator can actually carry out.
const profileSources = {
  public: {
    note: 'Reads the public Google Maps listing: name, address, phone, website, weekly hours and the booking, menu and order buttons.',
    ready: (providers) => providers?.serper || providers?.googleMaps,
    readyTitle: (providers) => providers?.serper ? 'Google Maps listing via Serper' : 'Google Places key detected',
    readyBody: (providers) => providers?.serper ? `About 3 Serper credits per restaurant${providers?.googleMaps ? ', with Google Places as the fallback' : ''}.` : 'Each restaurant costs one Places lookup, billed by Google. Add SERPER_API_KEY for a much cheaper source.',
    blockedTitle: 'No Google listing source set up',
    blockedBody: `Add SERPER_API_KEY (cheapest) or GOOGLE_MAPS_API_KEY (Places API New) to ${KEY_HOME}.`,
  },
  managed: {
    note: 'Reads the Business Profile you administer, including menu, reservation and ordering links that the public listing does not always show.',
    ready: (providers) => providers?.gbpAuthenticated,
    readyTitle: 'Business Profile connected',
    readyBody: 'Load your locations below and choose the restaurant to compare.',
    blockedTitle: (providers) => providers?.gbpConfigured ? 'Business Profile is not connected yet' : 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing',
    blockedBody: (providers) => providers?.gbpConfigured ? 'Choose Connect Business Profile below and authorize the Google account that manages this restaurant.' : 'Add both values to your .env file, restart the dashboard, then connect the Google account that manages this restaurant.',
  },
  imported: {
    note: 'Compares against profile details you paste in. Nothing is read from Google, so results are saved in full rather than expiring with the session.',
    ready: () => true,
    readyTitle: 'No Google connection needed',
    readyBody: 'Paste one JSON record per restaurant below.',
  },
};

export function initSetup(onCreated) {
  const form = $('#scan-form'), fileInput = $('#files'), button = $('#start-button');
  const task = { pages: $('#check-pages'), profile: $('#check-profile'), hours: $('#check-hours') };
  let providerStatus = null;
  if (HOSTED) {
    // Online, everything runs except what needs a stored Google sign-in or a visible browser.
    // Those stay on screen, labelled, rather than silently disappearing.
    const gsc = $('[name="discovery"][value="gsc"]');
    gsc.checked = false; gsc.disabled = true;
    gsc.closest('.source-card').classList.add('desktop-only');
    $('.source-tag', gsc.closest('.source-card')).textContent = 'Desktop only';
    $('#google-provider option[value="browser"]').disabled = true;
    $('#google-provider option[value="browser"]').textContent = 'Local browser (desktop only)';
    $('#google-max-pages').max = '100';
    // Each step is its own serverless call, so the online limits are tighter.
    const limits = { concurrency: [3, 4, 'Online: up to 4'], 'crawl-limit': [200, 500, 'Online: up to 500 pages'], 'backlink-limit': [1000, 2000, 'Online: up to 2,000'], 'profile-pages': [8, 12, 'Online: up to 12 per restaurant'] };
    for (const [id, [value, max, note]] of Object.entries(limits)) {
      const input = $(`#${id}`); input.defaultValue = input.value = String(value); input.max = String(max);
      $('small', input.closest('label')).textContent = note;
    }
    for (const id of ['per-host', 'host-delay', 'timeout', 'gsc-days']) $(`#${id}`).closest('label').classList.add('hidden');
    $('#group-inspect').classList.add('hidden');
    for (const mode of ['managed', 'imported']) { const option = $(`#profile-mode option[value="${mode}"]`); option.disabled = true; option.textContent += ' (desktop only)'; }
    $('#profile-test-key').classList.add('hidden');
    $('#brief-note').textContent = 'Keep this tab open while the audit runs. Cancel any time; resuming never re-checks finished pages.';
  }
  const text = (value) => typeof value === 'function' ? value(providerStatus) : value;
  const selected = () => $$('[name="discovery"]:checked').map((input) => input.value);

  function profileMode() {
    const mode = $('#profile-mode').value, source = profileSources[mode] || profileSources.public;
    $('#profile-managed').classList.toggle('hidden', mode !== 'managed');
    $('#profile-imported').classList.toggle('hidden', mode !== 'imported');
    $('#profile-source-note').textContent = source.note;
    // Status is unknown until the provider request lands; claiming either state early would
    // send the operator to fix something that is not actually broken.
    const ready = providerStatus === null ? null : Boolean(source.ready(providerStatus));
    const requirement = $('#profile-requirement');
    requirement.classList.toggle('ready', ready === true);
    requirement.classList.toggle('blocked', ready === false);
    $('#profile-requirement-title').textContent = ready === null ? 'Checking connection…' : ready ? text(source.readyTitle) : text(source.blockedTitle);
    $('#profile-requirement-body').textContent = ready === null ? '' : ready ? text(source.readyBody) : text(source.blockedBody);
    $('#profile-test-key').classList.toggle('hidden', HOSTED || mode !== 'public' || !providerStatus?.googleMaps);
    $('#profile-task-note').textContent = ready === false && mode === 'public' ? 'Needs a Google listing source; see below' : '';
  }

  /** Shows only what the chosen checks need, and keeps the ticket in step with the form. */
  function update() {
    const sites = lines($('#sites').value).length, urls = lines($('#urls').value).length, files = [...fileInput.files];
    const sources = selected();
    // The business profile already compares opening hours, day by day.
    const profile = task.profile.checked;
    task.hours.disabled = profile || task.hours.dataset.unavailable === 'true';
    if (profile) task.hours.checked = false;
    $('#check-hours-note').textContent = profile ? 'Included in the business profile' : task.hours.dataset.note || '';
    const pages = task.pages.checked, hours = task.hours.checked;
    $('#sources-section').classList.toggle('hidden', !pages);
    $('#urls-group').classList.toggle('hidden', !pages && !urls);
    $('#profile-section').classList.toggle('hidden', !profile);
    $('#identity-block').classList.toggle('hidden', !profile && !hours);
    $('#brief-sources-row').classList.toggle('hidden', !pages);

    $('#site-count').textContent = `${number(sites)} ${sites === 1 ? 'site' : 'sites'}`;
    $('#url-count').textContent = `${number(urls)} ${urls === 1 ? 'URL' : 'URLs'}`;
    $('#file-summary').textContent = files.length ? files.map((file) => file.name).join(', ') : 'No files selected';
    $('#clear-files').classList.toggle('hidden', !files.length);
    $('#brief-targets').textContent = [sites && `${number(sites)} ${sites === 1 ? 'site' : 'sites'}`, urls && `${number(urls)} ${urls === 1 ? 'page' : 'pages'}`, files.length && `${files.length} ${files.length === 1 ? 'file' : 'files'}`].filter(Boolean).join(' · ') || 'None yet';
    const checks = [pages && 'Broken pages', profile && 'Business profile', hours && 'Opening hours'].filter(Boolean);
    $('#brief-checks').textContent = checks.join(' · ') || 'None chosen';
    const preset = Object.entries(presets).find(([, list]) => list.join() === sources.join())?.[0];
    $('#brief-sources').textContent = preset ? PRESET_LABEL[preset] : sources.map((source) => SOURCE_LABEL[source]).join(', ') || 'None chosen';
    $$('.preset-bar button').forEach((element) => element.setAttribute('aria-pressed', String(element.dataset.preset === preset)));

    $('#google-settings').classList.toggle('hidden', !sources.includes('google'));
    $$('#google-settings input, #google-settings select').forEach((input) => { input.disabled = !sources.includes('google'); });
    $('#google-scope-note').textContent = sources.join() === 'google' ? 'Only pages seen in Google results enter this audit. Websites are used as search targets.' : 'Google results are combined with your other sources, and each page records where it was found.';

    const targets = sites + urls + files.length;
    const homepageOnly = pages && sites && sources.length && sources.every((source) => source === 'import');
    $('#launch-detail').textContent = !checks.length ? 'Choose at least one check above'
      : !targets ? 'Add a website, a page or a file to begin'
      : homepageOnly ? 'Only the website addresses themselves will be checked. Add Google results, sitemaps or a crawl to find broken pages.'
      : `${checks.join(', ')} for ${$('#brief-targets').textContent}`;
    $('#launch-detail').classList.toggle('launch-warning', Boolean(homepageOnly));
    const ready = Boolean(targets && checks.length);
    $('.ready-chip').innerHTML = ready ? '<span></span>Ready to start' : `<span></span>${checks.length ? 'Add a restaurant' : 'Choose a check'}`;
    $('.ready-chip').classList.toggle('ready', ready);
    $('#identity-summary').textContent = $('#profile-address').value.trim()
      ? 'Google’s listing is matched against this address before any value is compared.'
      : 'The address picks the right branch when a brand has several on Google. For several restaurants, import a CSV with url, name, address and place_id columns instead.';

    // A setting for a source or check this audit is not running is noise; only the ones that
    // will affect this run stay on screen.
    for (const label of $$('.settings-grid [data-needs-source]')) label.classList.toggle('hidden', !pages || !sources.includes(label.dataset.needsSource));
    for (const label of $$('.settings-grid [data-needs-toggle]')) label.classList.toggle('hidden', !$(`#${label.dataset.needsToggle}`).checked);
    for (const group of $$('.settings-group')) {
      if (group.dataset.needsSourceGroup) { group.classList.toggle('hidden', HOSTED || !pages || !sources.includes(group.dataset.needsSourceGroup)); continue; }
      const labels = $$('.settings-grid > label', group);
      group.classList.toggle('hidden', labels.length > 0 && labels.every((label) => label.classList.contains('hidden')));
    }
    const cap = new Intl.NumberFormat(undefined, { notation: 'compact' }).format(Number($('#crawl-limit').value));
    $('#settings-summary').textContent = [`${$('#concurrency').value} at once`, pages && sources.includes('google') && `${$('#google-max-pages').value} Google pages`, pages && sources.includes('crawl') && `crawl up to ${cap}`].filter(Boolean).join(' · ');
  }

  /** Opens the form on one check, e.g. from the overview's "Check opening hours". */
  function chooseTask(name) {
    if (!task[name]) return;
    for (const [key, input] of Object.entries(task)) input.checked = key === name;
    if (name === 'hours' && task.hours.dataset.unavailable === 'true') { task.profile.checked = true; notify('Opening hours need a Google listing source; the business profile check is selected instead.', true); }
    profileMode(); update();
  }

  for (const input of Object.values(task)) input.addEventListener('change', () => { profileMode(); update(); clearError(); });
  $('#profile-mode').addEventListener('change', () => { profileMode(); update(); });
  $('#profile-test-key').addEventListener('click', async () => {
    const test = $('#profile-test-key'), original = test.textContent;
    test.disabled = true; test.textContent = 'Testing…';
    try {
      const result = await request('/api/providers/places/check', { method: 'POST' });
      const requirement = $('#profile-requirement');
      requirement.classList.toggle('ready', result.ok);
      requirement.classList.toggle('blocked', !result.ok);
      $('#profile-requirement-title').textContent = result.ok ? 'Google Places key works' : 'Google rejected this key';
      $('#profile-requirement-body').textContent = result.message;
      notify(result.ok ? 'Google Places key works.' : 'Google rejected this key. See the details in the form.', !result.ok);
    } catch (error) { notify(error.message, true); }
    finally { test.disabled = false; test.textContent = original; }
  });
  $('#reset-advanced').addEventListener('click', () => {
    for (const input of $$('.advanced-section input, #google-settings input, #google-settings select')) {
      if (input.type === 'checkbox') input.checked = input.disabled ? false : input.defaultChecked;
      else if (input.tagName === 'SELECT') input.selectedIndex = Math.max(0, [...input.options].findIndex((option) => option.defaultSelected));
      else input.value = input.defaultValue;
    }
    update(); notify('Settings restored to their defaults.');
  });
  $('#profile-load-locations').addEventListener('click', async () => {
    const load = $('#profile-load-locations'); load.disabled = true;
    try {
      const { locations } = await request('/api/gbp/locations');
      $('#profile-location').replaceChildren(new Option('Select a managed location', ''), ...locations.map(l => new Option(`${l.title} — ${l.address}`, l.name)));
      if (!locations.length) notify('No accessible locations were returned.', true);
    } catch (error) { notify(error.message, true); } finally { load.disabled = false; }
  });

  let submitting = false;
  const errorBox = $('#form-error');
  function clearError() { errorBox.textContent = ''; $$('.invalid', form).forEach((field) => field.classList.remove('invalid')); }
  /** Errors appear beside the Start button, and the field at fault is outlined and focused. */
  function fail(message, field) {
    errorBox.textContent = message;
    if (field) { field.classList.add('invalid'); field.scrollIntoView({ block: 'center', behavior: 'smooth' }); field.focus({ preventScroll: true }); }
    else errorBox.scrollIntoView({ block: 'nearest' });
  }
  form.addEventListener('input', (event) => { update(); if (event.target.classList?.contains('invalid')) clearError(); });
  fileInput.addEventListener('change', () => { update(); clearError(); });
  $('#clear-files').addEventListener('click', () => { fileInput.value = ''; update(); fileInput.focus(); });
  $('#reset-form').addEventListener('click', () => {
    if (submitting) return;
    form.reset(); clearError();
    if (task.hours.dataset.unavailable === 'true') task.hours.checked = false;
    profileMode(); update(); notify('The form is back to its defaults'); $('#sites').focus();
    $('.advanced-section details').open = false;
  });
  $$('.preset-bar button').forEach((element) => element.addEventListener('click', () => {
    $$('[name="discovery"]').forEach((input) => { input.checked = !input.disabled && presets[element.dataset.preset].includes(input.value); }); update();
  }));
  const drop = $('.file-drop');
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); if (!submitting) drop.classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop', (event) => {
    if (submitting) return;
    const files = [...event.dataTransfer.files];
    if (!files.length || files.some((file) => !/\.(txt|csv|xlsx|xlsm)$/i.test(file.name))) return notify('Choose TXT, CSV, XLSX, or XLSM files.', true);
    const transfer = new DataTransfer(); files.forEach((file) => transfer.items.add(file)); fileInput.files = transfer.files; update();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    clearError();
    const sites = lines($('#sites').value), urls = lines($('#urls').value), files = [...fileInput.files];
    const pages = task.pages.checked, profile = task.profile.checked, hours = task.hours.checked;
    if (!pages && !profile && !hours) return fail('Choose at least one check: broken pages, business profile or opening hours.', task.pages);
    if (!sites.length && !urls.length && !files.length) return fail('Add at least one restaurant website, page or file to begin.', $('#sites'));
    if (files.some((file) => !/\.(txt|csv|xlsx|xlsm)$/i.test(file.name))) return fail('Choose TXT, CSV, XLSX or XLSM files.', fileInput);
    // Profile and hours checks need only the restaurants themselves; page discovery runs only
    // when broken pages were asked for.
    let discovery = pages ? selected() : ['import'];
    // Exact-only inputs keep their uncapped workflow. A mixed audit is explicitly labeled as
    // including your list, never as Google-only evidence; the checkboxes show what will run.
    if (!sites.length && (urls.length || files.length) && discovery.join() === 'google') discovery = ['import'];
    else if ((urls.length || files.length) && !discovery.includes('import')) discovery = ['import', ...discovery];
    if (pages) { $$('[name="discovery"]').forEach((input) => { input.checked = discovery.includes(input.value); }); update(); }
    if (!discovery.length) return fail('Choose where to look for pages.', $('[name="discovery"]'));
    for (const input of $$('.advanced-section input[type=number], #google-settings input')) {
      if (!input.disabled && !input.closest('.hidden') && !input.checkValidity()) { $('.advanced-section details').open = true; return fail(`Check “${input.closest('label')?.querySelector('span')?.firstChild?.textContent?.trim() || 'this setting'}”: ${input.validationMessage}`, input); }
    }
    const numericFields = { concurrency: 'concurrency', perHostConcurrency: 'per-host', hostDelayMs: 'host-delay', crawlLimit: 'crawl-limit', timeoutMs: 'timeout', gscDays: 'gsc-days', backlinkLimit: 'backlink-limit', hoursToleranceMinutes: 'hours-tolerance', hoursPageLimit: 'hours-pages' };
    const payload = { sites, urls: pages ? urls : [], discovery, inputFiles: [], googleProvider: $('#google-provider').value, googleCountry: $('#google-country').value, googleLanguage: $('#google-language').value, googleMaxPages: Number($('#google-max-pages').value), inspectGoogle: pages && $('#inspect-google').checked, checkHours: hours, hoursRequireVerifiedPlace: false, failOn: 'hard' };
    for (const [key, id] of Object.entries(numericFields)) payload[key] = Number($(`#${id}`).value);
    if (profile || hours) {
      const name = $('#profile-name').value.trim(), address = $('#profile-address').value.trim(), placeId = $('#profile-place-id').value.trim(), gbpLocation = profile ? $('#profile-location').value : '';
      if (name || address || placeId || gbpLocation) {
        if (sites.length + payload.urls.length !== 1 || files.length) return fail('Branch details describe one restaurant. Add just one website, or import a CSV with url, name, address and place_id columns.', $('#profile-address'));
        payload.profileTargets = [{ url: [...sites, ...payload.urls][0], name: name || undefined, address: address || undefined, placeId: placeId || undefined, gbpLocation: gbpLocation || undefined }];
      }
    }
    if (profile) {
      payload.checkProfile = true;
      payload.profileMode = $('#profile-mode').value;
      payload.profilePageLimit = Number($('#profile-pages').value);
      payload.profileHoursTolerance = Number($('#profile-tolerance').value);
      if (payload.profileMode === 'managed' && !$('#profile-location').value) return fail('Load and select the restaurant location you manage.', $('#profile-location'));
      if (payload.profileMode === 'imported') {
        try { payload.profileEvidence = JSON.parse($('#profile-evidence').value); } catch { return fail('Profile details must be a valid JSON array.', $('#profile-evidence')); }
      }
    }
    submitting = true;
    const original = button.innerHTML;
    const disabled = $$('input, textarea, button, select', form).filter((control) => !control.disabled);
    disabled.forEach((control) => { control.disabled = true; });
    $('#reset-form').disabled = true;
    button.setAttribute('aria-busy', 'true');
    const setLabel = (label) => { button.innerHTML = `<span>${label}</span><span class="button-spinner" aria-hidden="true"></span>`; };
    let created;
    try {
      for (const [index, file] of files.entries()) {
        setLabel(`Uploading ${index + 1} of ${files.length}…`);
        const upload = await request(`/api/uploads?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
        payload.inputFiles.push(upload.path);
      }
      setLabel('Starting audit…'); created = await createScan(payload);
    } catch (failure) {
      fail(failure.message); notify(failure.message, true);
    } finally {
      submitting = false; disabled.forEach((control) => { control.disabled = false; });
      $('#reset-form').disabled = false; button.innerHTML = original; button.removeAttribute('aria-busy');
      update();
    }
    // A refresh failure after creation must never invite a duplicate submission.
    if (created) { notify('Audit started. Progress is saved as it goes.'); onCreated(created.id); }
  });
  profileMode(); update();
  return {
    applyProviderStatus(status) { providerStatus = status; profileMode(); update(); },
    chooseTask,
  };
}
