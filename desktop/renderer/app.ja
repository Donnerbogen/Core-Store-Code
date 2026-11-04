const state = {
  programs: [],
  currentPage: 'home',
  storeUpdate: null,
  busy: false
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  $('#toastRegion').appendChild(item);
  setTimeout(() => item.remove(), 4300);
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('busy', value);
  $$('button').forEach(button => {
    if (button.dataset.keepEnabled !== 'true') button.disabled = value;
  });
}

function showPage(page) {
  state.currentPage = page;
  $$('.page').forEach(section => section.classList.toggle('active', section.id === `page-${page}`));
  $$('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  const names = { home: 'Übersicht', store: 'Store', installed: 'Installiert', settings: 'Einstellungen' };
  $('#breadcrumbCurrent').textContent = names[page] || 'Übersicht';
  if (page === 'installed') renderInstalled();
  if (page === 'store') renderStore();
}

function categoryOf(program) {
  return String(program.category || 'Sonstiges');
}

function programCard(program) {
  const stateInfo = program.state || { installed: false, updateAvailable: false };
  const installed = Boolean(stateInfo.installed);
  const updateAvailable = Boolean(stateInfo.updateAvailable);
  const name = escapeHtml(program.name || program.id);
  const description = escapeHtml(program.short_description || program.description || 'Keine Beschreibung vorhanden.');
  const category = escapeHtml(categoryOf(program));
  const version = escapeHtml(program.version || '1.0.0');
  const author = escapeHtml(program.author || 'Unbekannt');
  const icon = escapeHtml((program.name || program.id || 'C').trim().charAt(0).toUpperCase());

  let buttons = '';
  if (!installed) {
    buttons = `<button class="primary-button install-button" data-action="install" data-id="${escapeHtml(program.id)}">INSTALLIEREN</button>`;
  } else {
    buttons = `<button class="primary-button install-button" data-action="start" data-id="${escapeHtml(program.id)}">STARTEN</button>`;
    if (updateAvailable) {
      buttons += `<button class="primary-button update-button" data-action="update" data-id="${escapeHtml(program.id)}">UPDATE</button>`;
    }
    buttons += `<button class="danger-button" data-action="uninstall" data-id="${escapeHtml(program.id)}">DEINSTALLIEREN</button>`;
  }

  const status = !installed
    ? '<span class="status-tag">NICHT INSTALLIERT</span>'
    : updateAvailable
      ? '<span class="status-tag update">UPDATE VERFÜGBAR</span>'
      : '<span class="status-tag installed">INSTALLIERT</span>';

  return `<article class="program-card">
    <div class="card-top"><div class="program-icon">${icon}</div><span class="category-tag">${category}</span></div>
    <h3>${name}</h3><p>${description}</p>
    <div class="card-meta"><span>VERSION ${version}</span><span>VON ${author}</span></div>
    <div class="card-meta">${status}<span>${installed ? `LOKAL ${escapeHtml(stateInfo.localVersion || '—')}` : 'CORE CATALOG'}</span></div>
    <div class="card-actions">${buttons}</div>
  </article>`;
}

function renderGrid(element, programs, emptyText) {
  if (!programs.length) {
    element.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
    return;
  }
  element.innerHTML = programs.map(programCard).join('');
}

function renderHome() {
  const installed = state.programs.filter(program => program.state?.installed);
  const updates = installed.filter(program => program.state?.updateAvailable);
  $('#statInstalled').textContent = String(installed.length);
  $('#statAvailable').textContent = String(state.programs.length);
  $('#statUpdates').textContent = String(updates.length);
  const featured = state.programs.filter(program => program.featured).slice(0, 3);
  renderGrid($('#featuredGrid'), featured, 'Noch keine empfohlenen Programme vorhanden.');
}

function renderStore() {
  const query = ($('#searchInput')?.value || '').trim().toLowerCase();
  const category = $('#categoryFilter')?.value || 'all';
  const filtered = state.programs.filter(program => {
    const searchable = `${program.name || ''} ${program.short_description || ''} ${program.description || ''} ${program.author || ''}`.toLowerCase();
    return searchable.includes(query) && (category === 'all' || categoryOf(program) === category);
  });
  $('#resultCount').textContent = `${filtered.length} Programme`;
  renderGrid($('#programGrid'), filtered, 'Keine passenden Programme gefunden.');
}

function renderInstalled() {
  const query = ($('#installedSearch')?.value || '').trim().toLowerCase();
  const installed = state.programs.filter(program => program.state?.installed && `${program.name || ''} ${program.short_description || ''}`.toLowerCase().includes(query));
  renderGrid($('#installedGrid'), installed, 'Auf diesem Gerät sind noch keine Programme installiert.');
}

function updateCategories() {
  const select = $('#categoryFilter');
  const current = select.value || 'all';
  const categories = [...new Set(state.programs.map(categoryOf))].sort((a, b) => a.localeCompare(b, 'de'));
  select.innerHTML = '<option value="all">Alle Kategorien</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  if (categories.includes(current)) select.value = current;
}

async function refreshPrograms() {
  setBusy(true);
  $('#connectionText').textContent = 'Verbindung wird geprüft';
  try {
    state.programs = await window.coreStore.getPrograms();
    updateCategories();
    renderHome();
    renderStore();
    renderInstalled();
    $('#connectionText').textContent = 'Render-API verbunden';
    $('#apiStatus').textContent = 'Verbunden – Programmliste erfolgreich geladen.';
    $('#apiAddress').textContent = 'Render-API erreichbar';
  } catch (error) {
    $('#connectionText').textContent = 'Keine Verbindung';
    $('#apiStatus').textContent = error.message;
    $('#apiAddress').textContent = 'Render-API nicht erreichbar';
    $('#featuredGrid').innerHTML = '<div class="empty-state">Verbindung zum Core-Store-Server fehlgeschlagen.</div>';
    $('#programGrid').innerHTML = '<div class="empty-state">Verbindung zum Core-Store-Server fehlgeschlagen.</div>';
    $('#installedGrid').innerHTML = '<div class="empty-state">Installierte Programme konnten nicht geladen werden.</div>';
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshStoreVersion() {
  try {
    state.storeUpdate = await window.coreStore.checkStoreUpdate();
    $('#storeUpdateButton').hidden = !state.storeUpdate.available;
    if (state.storeUpdate.available) {
      $('#apiStatus').textContent = `Core-Store-Update ${state.storeUpdate.remoteVersion} verfügbar.`;
    }
  } catch (error) {
    state.storeUpdate = null;
  }
}

function askConfirmation(title, message) {
  return new Promise(resolve => {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = message;
    $('#confirmBackdrop').classList.remove('hidden');
    const close = result => {
      $('#confirmBackdrop').classList.add('hidden');
      $('#confirmAccept').removeEventListener('click', accept);
      $('#confirmCancel').removeEventListener('click', cancel);
      resolve(result);
    };
    const accept = () => close(true);
    const cancel = () => close(false);
    $('#confirmAccept').addEventListener('click', accept);
    $('#confirmCancel').addEventListener('click', cancel);
  });
}

async function handleProgramAction(action, id) {
  const program = state.programs.find(item => item.id === id);
  if (!program) return;
  const name = program.name || id;
  try {
    if (action === 'uninstall') {
      const accepted = await askConfirmation('Programm deinstallieren?', `${name} wird von diesem Gerät entfernt. Gespeicherte Programmdaten können dabei gelöscht werden.`);
      if (!accepted) return;
    }
    setBusy(true);
    if (action === 'install') {
      toast(`${name} wird installiert ...`);
      await window.coreStore.installProgram(id);
      toast(`${name} wurde installiert.`);
    } else if (action === 'start') {
      await window.coreStore.startProgram(id);
      toast(`${name} wurde gestartet.`);
    } else if (action === 'update') {
      toast(`${name} wird aktualisiert ...`);
      await window.coreStore.updateProgram(id);
      toast(`${name} wurde aktualisiert.`);
    } else if (action === 'uninstall') {
      await window.coreStore.uninstallProgram(id);
      toast(`${name} wurde deinstalliert.`);
    }
    state.programs = await window.coreStore.getPrograms();
    updateCategories();
    renderHome();
    renderStore();
    renderInstalled();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function applyStoreUpdate() {
  try {
    const info = await window.coreStore.checkStoreUpdate();
    if (!info.available) {
      toast('Der Core Store ist bereits aktuell.');
      return;
    }
    const accepted = await askConfirmation('Core Store aktualisieren?', `Version ${info.remoteVersion} wird heruntergeladen. Der Store wird anschließend neu gestartet.`);
    if (!accepted) return;
    setBusy(true);
    await window.coreStore.applyStoreUpdate();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function bindEvents() {
  $$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)));
  $$('[data-goto]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.goto)));
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (button) handleProgramAction(button.dataset.action, button.dataset.id);
  });
  $('#searchInput').addEventListener('input', renderStore);
  $('#categoryFilter').addEventListener('change', renderStore);
  $('#installedSearch').addEventListener('input', renderInstalled);
  $('#refreshButton').addEventListener('click', refreshPrograms);
  $('#storeUpdateButton').addEventListener('click', applyStoreUpdate);
  $('#storeRefresh').addEventListener('click', refreshPrograms);
  $('#installedRefresh').addEventListener('click', refreshPrograms);
  $('#retryConnection').addEventListener('click', refreshPrograms);
  $('#openDataFolder').addEventListener('click', () => window.coreStore.openDataFolder());
  $('#checkStoreUpdate').addEventListener('click', async () => {
    await refreshStoreVersion();
    if (state.storeUpdate?.available) {
      toast(`Core-Store-Update ${state.storeUpdate.remoteVersion} verfügbar.`);
      await applyStoreUpdate();
    } else {
      toast('Der Core Store ist auf dem neuesten Stand.');
    }
  });
}

async function init() {
  bindEvents();
  const info = await window.coreStore.getInfo();
  $('#sidebarVersion').textContent = `v${info.version}`;
  $('#settingsVersion').textContent = info.version;
  await refreshPrograms();
  await refreshStoreVersion();
}

window.addEventListener('DOMContentLoaded', init);
