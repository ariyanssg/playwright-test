import { request, createScan } from './api.js';
import { $, $$, lines, number, notify } from './ui.js';
const presets = globalThis.SIGNAL404_HOSTED ? { google: ['google'], all: ['import', 'google'], local: ['import'], import: ['import'] } : { google: ['google'], all: ['import', 'sitemap', 'crawl', 'google', 'gsc', 'backlinks'], local: ['import', 'sitemap', 'crawl'], import: ['import'] };
export function initSetup(onCreated) {
  const form = $('#scan-form'), fileInput = $('#files'), button = $('#start-button');
  if (globalThis.SIGNAL404_HOSTED) {
    $$('[name="discovery"]').filter((input) => !['google', 'import'].includes(input.value)).forEach((input) => { input.checked = false; input.disabled = true; input.closest('.source-card').classList.add('hidden'); });
    $('[data-preset="local"]').classList.add('hidden');
    $('#google-provider').value = 'searchapi'; $('#google-provider option[value="browser"]').disabled = true;
    $('#google-max-pages').max = '100';
    for (const id of ['concurrency', 'per-host', 'host-delay', 'crawl-limit', 'timeout', 'gsc-days', 'backlink-limit']) {
      const input = $(`#${id}`); if (!input) continue; input.closest('label').classList.add('hidden');
      if (id === 'concurrency' || id === 'per-host') input.defaultValue = input.value = '1';
    }
  }
  if (globalThis.SIGNAL404_HOSTED) $('#profile-setup').classList.add('hidden');
  const profileMode = () => {
    $('#profile-options').classList.toggle('hidden', !$('#check-profile').checked);
    $('#profile-managed').classList.toggle('hidden', $('#profile-mode').value !== 'managed');
    $('#profile-imported').classList.toggle('hidden', $('#profile-mode').value !== 'imported');
  };
  $('#check-profile').addEventListener('change', () => {
    if ($('#check-profile').checked) $$('[name="discovery"]').forEach(input => input.checked = input.value === 'import');
    profileMode(); update();
  });
  $('#profile-mode').addEventListener('change', profileMode);
  $('#profile-load-locations').addEventListener('click', async () => {
    const button = $('#profile-load-locations'); button.disabled = true;
    try {
      const { locations } = await request('/api/gbp/locations');
      $('#profile-location').replaceChildren(new Option('Select a managed location', ''), ...locations.map(l => new Option(`${l.title} — ${l.address}`, l.name)));
      if (!locations.length) notify('No accessible locations were returned.', true);
    } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
  });
  let submitting = false;
  function update() {
    const sites = lines($('#sites').value).length, urls = lines($('#urls').value).length, files = [...fileInput.files];
    const selected = $$('[name="discovery"]:checked').map((input) => input.value);
    $('#site-count').textContent = `${number(sites)} ${sites === 1 ? 'site' : 'sites'}`;
    $('#url-count').textContent = `${number(urls)} ${urls === 1 ? 'URL' : 'URLs'}`;
    $('#file-summary').textContent = files.length ? files.map((file) => file.name).join(', ') : 'No files selected';
    $('#clear-files').classList.toggle('hidden', !files.length);
    $('#brief-targets').textContent = [sites && `${number(sites)} ${sites === 1 ? 'site' : 'sites'}`, urls && `${number(urls)} URLs`, files.length && `${files.length} files`].filter(Boolean).join(' · ') || 'No targets yet';
    const googleOnly = selected.length === 1 && selected[0] === 'google';
    $('#brief-sources').textContent = googleOnly ? 'Google results only' : `${selected.length} ${selected.length === 1 ? 'source' : 'sources'}`;
    $('#google-settings').classList.toggle('hidden', !selected.includes('google'));
    $$('#google-settings input, #google-settings select').forEach((input) => { input.disabled = !selected.includes('google'); });
    $('#google-scope-note').textContent = googleOnly ? 'Only URLs observed in Google results will enter this audit. Website roots are search targets.' : 'Custom audit: Google results are combined with your other selected sources, each labeled separately.';
    $('#launch-detail').textContent = sites + urls + files.length ? `${number(sites + urls + files.length)} inputs · ${selected.length} sources selected` : 'Add a website, exact URL, or file to begin';
    $('.ready-chip').innerHTML = sites + urls + files.length ? '<span></span>Targets ready' : '<span></span>Set up your audit';
    $$('.preset-bar button').forEach((element) => element.setAttribute('aria-pressed', String(presets[element.dataset.preset].join() === selected.join())));
    const cap = new Intl.NumberFormat(undefined, { notation: 'compact' }).format(Number($('#crawl-limit').value));
    $('#settings-summary').textContent = `${$('#concurrency').value} workers · ${selected.includes('google') ? `${$('#google-max-pages').value} Google pages` : `${cap} crawl cap`}`;
  }
  form.addEventListener('input', update);
  fileInput.addEventListener('change', update);
  $('#clear-files').addEventListener('click', () => { fileInput.value = ''; update(); fileInput.focus(); });
  $('#reset-form').addEventListener('click', () => {
    if (submitting) return;
    form.reset();
    $('#form-error').textContent = '';
    if ($('#check-hours').disabled) $('#check-hours').checked = false;
    profileMode(); update(); notify('Audit setup reset'); $('#sites').focus();
  });
  $$('.preset-bar button').forEach((element) => element.addEventListener('click', () => {
    $$('[name="discovery"]').forEach((input) => { input.checked = presets[element.dataset.preset].includes(input.value); }); update();
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
  // Reveal an invalid advanced setting before the browser focuses its input.
  form.addEventListener('invalid', (event) => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const sites = lines($('#sites').value), urls = lines($('#urls').value), files = [...fileInput.files];
    const error = $('#form-error'); error.textContent = '';
    if (!sites.length && !urls.length && !files.length) {
      error.textContent = 'Add at least one restaurant website, exact URL, or URL file to begin.'; notify(error.textContent, true); $('#sites').focus(); return;
    }
    let discovery = $$('[name="discovery"]:checked').map((input) => input.value);
    // Exact-only inputs retain their original uncapped workflow. A mixed audit is
    // explicitly labeled as including imports, never as Google-only evidence.
    if (!sites.length && (urls.length || files.length) && discovery.join() === 'google') discovery = ['import'];
    else if ((urls.length || files.length) && !discovery.includes('import')) discovery = ['import', ...discovery];
    $$('[name="discovery"]').forEach((input) => { input.checked = discovery.includes(input.value); });
    update();
    if (!discovery.length) { error.textContent = 'Choose at least one discovery source.'; notify(error.textContent, true); $('[name="discovery"]').focus(); return; }
    if (files.some((file) => !/\.(txt|csv|xlsx|xlsm)$/i.test(file.name))) { error.textContent = 'Choose TXT, CSV, XLSX, or XLSM files.'; return; }
    const numericFields = { concurrency: 'concurrency', perHostConcurrency: 'per-host', hostDelayMs: 'host-delay', crawlLimit: 'crawl-limit', timeoutMs: 'timeout', gscDays: 'gsc-days', backlinkLimit: 'backlink-limit', hoursToleranceMinutes: 'hours-tolerance', hoursPageLimit: 'hours-pages' };
    const payload = { sites, urls, discovery, inputFiles: [], googleProvider: $('#google-provider').value, googleCountry: $('#google-country').value, googleLanguage: $('#google-language').value, googleMaxPages: Number($('#google-max-pages').value), inspectGoogle: $('#inspect-google').checked, checkHours: $('#check-hours').checked, hoursRequireVerifiedPlace: false, failOn: 'hard' };
    for (const [key, id] of Object.entries(numericFields)) payload[key] = Number($(`#${id}`).value);
    if ($('#check-profile').checked && !globalThis.SIGNAL404_HOSTED) {
      payload.checkProfile = true;
      payload.profileMode = $('#profile-mode').value;
      payload.profilePageLimit = Number($('#profile-pages').value);
      payload.profileHoursTolerance = Number($('#profile-tolerance').value);
      const name = $('#profile-name').value.trim(), address = $('#profile-address').value.trim(), placeId = $('#profile-place-id').value.trim(), gbpLocation = $('#profile-location').value;
      if (name || address || placeId || gbpLocation) {
        if (sites.length + urls.length !== 1 || files.length) { error.textContent = 'Identity hints require one restaurant URL. Use CSV identity columns for multiple branches.'; return; }
        payload.profileTargets = [{ url: [...sites, ...urls][0], name: name || undefined, address: address || undefined, placeId: placeId || undefined, gbpLocation: gbpLocation || undefined }];
      }
      if (payload.profileMode === 'managed' && !gbpLocation) { error.textContent = 'Load and select a connected restaurant location.'; return; }
      if (payload.profileMode === 'imported') {
        try { payload.profileEvidence = JSON.parse($('#profile-evidence').value); } catch { error.textContent = 'Profile evidence must be a valid JSON array.'; return; }
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
      error.textContent = failure.message; notify(failure.message, true);
    } finally {
      submitting = false; disabled.forEach((control) => { control.disabled = false; });
      $('#reset-form').disabled = false; button.innerHTML = original; button.removeAttribute('aria-busy');
    }
    // A refresh failure after creation must never invite a duplicate submission.
    if (created) { notify('Audit started. We’ll keep your progress saved.'); onCreated(created.id); }
  });
  update();
}
