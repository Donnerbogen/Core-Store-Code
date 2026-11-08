const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const APP_VERSION = require('./package.json').version;
const APP_ROOT = app.getAppPath();
const LOCAL_ROOT = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_ROOT = path.join(LOCAL_ROOT, 'Core Network');
const STORE_ROOT = path.join(DATA_ROOT, 'Core Store');
const INSTALLER_ROOT = path.join(STORE_ROOT, 'Installer');
// Programme liegen direkt unter %LOCALAPPDATA%\\Core Network\\<Programmname>.
const PROGRAMS_ROOT = DATA_ROOT;
const SETTINGS_PATH = path.join(STORE_ROOT, 'settings.json');
const INSTALLED_PATH = path.join(STORE_ROOT, 'installed.json');
const UPDATE_FAILURE_PATH = path.join(STORE_ROOT, 'update-failure.json');
const SUPPORT_CACHE_PATH = path.join(STORE_ROOT, 'support-url.json');
const BACKUP_ROOT = path.join(LOCAL_ROOT, 'Core Network Backup');
const REQUEST_TIMEOUT = 120000;

let mainWindow;
let apiUrl = '';

function ensureDirectories() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(STORE_ROOT, { recursive: true });
  fs.mkdirSync(INSTALLER_ROOT, { recursive: true });
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });

  // Einstellungen beim ersten Start aus der mitgelieferten Datei übernehmen.
  if (!fs.existsSync(SETTINGS_PATH)) {
    const packagedSettings = path.join(APP_ROOT, 'settings.json');
    if (fs.existsSync(packagedSettings)) {
      fs.copyFileSync(packagedSettings, SETTINGS_PATH);
    }
  }

  // Vorhandene Installationsverwaltung aus der alten Version migrieren.
  const oldInstalledPath = path.join(DATA_ROOT, '_store', 'installed.json');
  if (!fs.existsSync(INSTALLED_PATH) && fs.existsSync(oldInstalledPath)) {
    fs.copyFileSync(oldInstalledPath, INSTALLED_PATH);
  }
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    throw new Error(`settings.json fehlt: ${SETTINGS_PATH}`);
  }
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  const url = String(settings.api_url || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Ungültige API-Adresse in settings.json.');
  return url;
}

function readInstalled() {
  try {
    const data = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeInstalled(data) {
  const temporary = `${INSTALLED_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  if (fs.existsSync(INSTALLED_PATH)) fs.rmSync(INSTALLED_PATH, { force: true });
  fs.renameSync(temporary, INSTALLED_PATH);
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('Ungültige Programm-ID.');
  }
  return value;
}

function safeFolderName(value, fallback) {
  let name = String(value || fallback || '').trim();
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = String(fallback || 'Programm');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = `_${name}`;
  if (name.toLowerCase() === 'core store' || name.toLowerCase() === 'installer') name = `${name} Programm`;
  return name;
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value) throw new Error('Ungültiger Dateipfad.');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.includes(':')) throw new Error('Ungültiger Dateipfad.');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Ungültiger Dateipfad.');
  return parts.join('/');
}

function safeChild(root, relative) {
  const safe = safeRelative(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, ...safe.split('/'));
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Dateipfad liegt außerhalb des Zielordners.');
  return target;
}

function programDirectory(program) {
  return path.join(PROGRAMS_ROOT, safeFolderName(program.name, program.id));
}

function requestBuffer(url, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'Core-Store-Desktop' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestBuffer(response.headers.location, timeout).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let message = body.toString('utf8');
          try { message = JSON.parse(message).error || message; } catch {}
          reject(new Error(`HTTP ${response.statusCode}: ${message.slice(0, 500)}`));
          return;
        }
        resolve(body);
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Zeitüberschreitung bei der Serveranfrage.')));
    request.on('error', reject);
  });
}

async function apiJson(endpoint) {
  const buffer = await requestBuffer(`${apiUrl}${endpoint}`);
  return JSON.parse(buffer.toString('utf8'));
}

async function downloadToFile(endpoint, destination) {
  const buffer = await requestBuffer(`${apiUrl}${endpoint}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
}

function extractZipSafely(zipPath, destination) {
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const relative = safeRelative(entry.entryName);
    const target = safeChild(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}


// Verschiebt einen Ordner sicher. Wenn TEMP und LOCALAPPDATA auf
// unterschiedlichen Laufwerken liegen (Windows: EXDEV), wird geprüft kopiert.
function moveDirectory(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Quellordner fehlt: ${sourcePath}`);
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(`Zielordner existiert bereits: ${destinationPath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    fs.renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }

  const copyTemp = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.copy-${process.pid}-${Date.now()}`
  );

  try {
    fs.cpSync(sourcePath, copyTemp, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true
    });

    const sourceFiles = collectFileManifest(sourcePath);
    const copiedFiles = collectFileManifest(copyTemp);

    if (sourceFiles.length !== copiedFiles.length) {
      throw new Error('Dateikopie unvollständig: Anzahl der Dateien stimmt nicht überein.');
    }

    for (let i = 0; i < sourceFiles.length; i++) {
      if (
        sourceFiles[i].relative !== copiedFiles[i].relative ||
        sourceFiles[i].size !== copiedFiles[i].size
      ) {
        throw new Error(`Dateikopie unvollständig: ${sourceFiles[i].relative}`);
      }
    }

    fs.renameSync(copyTemp, destinationPath);
    fs.rmSync(sourcePath, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(copyTemp, { recursive: true, force: true });
    throw error;
  }
}

function collectFileManifest(root) {
  const result = [];

  function walk(current, relativeBase) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = relativeBase
        ? `${relativeBase}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        result.push({
          relative,
          size: fs.statSync(absolute).size
        });
      } else {
        throw new Error(`Nicht unterstützter Dateityp beim Kopieren: ${relative}`);
      }
    }
  }

  walk(root, '');
  result.sort((a, b) => a.relative.localeCompare(b.relative));
  return result;
}

function parseVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return [0, 0, 0];
  return version.split('.').map(Number);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function migrateLegacyProgramFolder(program) {
  const id = validateId(program.id);
  const target = programDirectory(program);
  const oldPath = path.join(DATA_ROOT, 'Programs', id);
  if (!fs.existsSync(target) && fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, target);
  }
  return target;
}

function getProgramState(program, installed) {
  const id = validateId(program.id);
  const target = migrateLegacyProgramFolder(program);
  const exists = fs.existsSync(target) && fs.statSync(target).isDirectory();
  const record = installed[id] || {};
  const localVersion = record.version || '0.0.0';
  const remoteVersion = String(program.version || '0.0.0');
  return {
    installed: exists,
    localVersion,
    remoteVersion,
    updateAvailable: exists && compareVersions(remoteVersion, localVersion) > 0
  };
}

async function getPrograms() {
  const data = await apiJson('/api/programs');
  if (!Array.isArray(data.programs)) throw new Error('Der Server hat keine gültige Programmliste geliefert.');
  const installed = readInstalled();
  return data.programs.map(program => ({
    ...program,
    state: getProgramState(program, installed)
  }));
}

function runProgramFile(program, programDir, action) {
  const relative = program.files && program.files[action];
  const execution = program.execution || {};
  if (!relative || execution[action] === false) return { skipped: true };

  const target = safeChild(programDir, relative);
  if (!fs.existsSync(target)) throw new Error(`Datei für Aktion '${action}' fehlt: ${relative}`);

  const ext = path.extname(target).toLowerCase();
  let command;
  let args;
  if (ext === '.bat' || ext === '.cmd') {
    command = process.env.ComSpec || 'cmd.exe';
    // /c erhält den vollständigen Pfad als ein Argument; keine doppelt verschachtelten Quotes.
    args = ['/d', '/s', '/c', `"${target}"`];
  } else if (ext === '.py') {
    command = 'py';
    args = ['-3', target];
  } else if (ext === '.ps1') {
    command = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target];
  } else if (ext === '.exe') {
    command = target;
    args = [];
  } else {
    shell.openPath(target);
    return { opened: true };
  }

  const waitKeys = {
    installation: 'wait_for_installation',
    update: 'wait_for_update',
    uninstallation: 'wait_for_uninstallation'
  };
  const wait = action === 'start' ? false : execution[waitKeys[action] || ''] !== false;
  const showConsole = execution.show_console !== false;

  if (wait) {
    const result = spawnSync(command, args, {
      cwd: programDir,
      encoding: 'utf8',
      windowsHide: !showConsole,
      timeout: 30 * 60 * 1000
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout || '').trim();
      throw new Error(`${relative} wurde mit Fehlercode ${result.status}.${details ? `\n${details}` : ''}`);
    }
    return { completed: true };
  }

  const child = spawn(command, args, {
    cwd: programDir,
    detached: true,
    stdio: showConsole ? 'inherit' : 'ignore',
    windowsHide: !showConsole
  });
  child.unref();
  return { started: true };
}

function preserveUserData(program, oldDir, newDir) {
  for (const relativeRaw of (program.update_preserve || [])) {
    const relative = safeRelative(relativeRaw);
    const oldPath = safeChild(oldDir, relative);
    const newPath = safeChild(newDir, relative);
    if (!fs.existsSync(oldPath)) continue;
    fs.rmSync(newPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.cpSync(oldPath, newPath, { recursive: true, force: true });
  }
}

async function downloadProgramArchive(programId, archivePath) {
  await downloadToFile(`/api/programs/${encodeURIComponent(validateId(programId))}/download`, archivePath);
}

async function installProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (program.state.installed) throw new Error('Programm ist bereits installiert.');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-install-'));
  const stage = path.join(temp, 'program');
  const archive = path.join(temp, 'program.zip');
  const target = programDirectory(program);
  try {
    await downloadProgramArchive(programId, archive);
    extractZipSafely(archive, stage);
    runProgramFile(program, stage, 'installation');
    if (fs.existsSync(target)) throw new Error(`Der Zielordner existiert bereits: ${target}`);
    moveDirectory(stage, target);
    const installed = readInstalled();
    installed[programId] = { name: program.name || programId, version: program.version || '0.0.0', folder: target, installed: true };
    writeInstalled(installed);
    return { success: true, programs: await getPrograms() };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function startProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
  runProgramFile(program, programDirectory(program), 'start');
  return { success: true };
}

async function updateProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
  if (!program.state.updateAvailable) throw new Error('Es ist kein Update verfügbar.');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-program-update-'));
  const stage = path.join(temp, 'program');
  const archive = path.join(temp, 'program.zip');
  const target = programDirectory(program);
  const backup = path.join(temp, 'backup');
  try {
    await downloadProgramArchive(programId, archive);
    extractZipSafely(archive, stage);
    preserveUserData(program, target, stage);
    runProgramFile(program, stage, 'update');
    moveDirectory(target, backup);
    try {
      moveDirectory(stage, target);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target)) moveDirectory(backup, target);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    const installed = readInstalled();
    installed[programId] = { name: program.name || programId, version: program.version || '0.0.0', folder: target, installed: true };
    writeInstalled(installed);
    return { success: true, programs: await getPrograms() };
  } finally {
    if (fs.existsSync(backup) && !fs.existsSync(target)) moveDirectory(backup, target);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function uninstallProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
  const target = programDirectory(program);
  runProgramFile(program, target, 'uninstallation');
  fs.rmSync(target, { recursive: true, force: true });
  const installed = readInstalled();
  delete installed[programId];
  writeInstalled(installed);
  return { success: true, programs: await getPrograms() };
}

function isValidWebUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function getStoreUpdateInfo() {
  const data = await apiJson('/api/store/version');
  if (!data.enabled) return { available: false, disabled: true, currentVersion: APP_VERSION, supportUrl: isValidWebUrl(data.support_url) ? data.support_url : getCachedSupportUrl() };
  const supportUrl = isValidWebUrl(data.support_url) ? data.support_url : '';
  if (supportUrl) {
    fs.mkdirSync(STORE_ROOT, { recursive: true });
    fs.writeFileSync(SUPPORT_CACHE_PATH, JSON.stringify({ supportUrl, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  }
  return {
    available: compareVersions(String(data.version || '0.0.0'), APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    remoteVersion: data.version,
    releaseNotes: Array.isArray(data.release_notes) ? data.release_notes : [],
    supportUrl: supportUrl || getCachedSupportUrl()
  };
}

function createFullBackup() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_ROOT, `Core-Store-Backup-${stamp}.zip`);
  const zip = new AdmZip();
  const installRoot = path.dirname(process.execPath);

  if (fs.existsSync(DATA_ROOT)) zip.addLocalFolder(DATA_ROOT, 'Core Network');
  if (fs.existsSync(installRoot)) zip.addLocalFolder(installRoot, 'Core Store Installation');
  zip.addFile('Backup-Information.json', Buffer.from(JSON.stringify({
    createdAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    dataRoot: DATA_ROOT,
    appRoot: APP_ROOT,
    installRoot,
    backupDirectory: BACKUP_ROOT,
    includes: ['Core Network', 'Core Store Installation']
  }, null, 2), 'utf8'));
  zip.writeZip(backupPath);

  const stat = fs.statSync(backupPath);
  if (!stat.size) throw new Error('Das Backup wurde erstellt, ist aber leer. Das Update wurde abgebrochen.');
  return backupPath;
}

function validateStoreUpdateArchive(zipPath) {
  const zip = new AdmZip(zipPath);
  const names = zip.getEntries().filter(entry => !entry.isDirectory).map(entry => safeRelative(entry.entryName));
  if (!names.includes('main.js') || !names.includes('package.json')) {
    throw new Error('Das Update-Archiv ist unvollständig (main.js oder package.json fehlt).');
  }
  return true;
}

const UPDATE_ERROR_CODES = {
  UPDATE_INFO_FAILED: 'CSU-001',
  DOWNLOAD_FAILED: 'CSU-002',
  BACKUP_FAILED: 'CSU-003',
  ARCHIVE_INVALID: 'CSU-004',
  HELPER_START_FAILED: 'CSU-005',
  EXTRACT_FAILED: 'CSU-006',
  APPLY_FAILED: 'CSU-007',
  RESTART_FAILED: 'CSU-008',
  RESTORE_FAILED: 'CSU-009',
  TEMP_DIR_FAILED: 'CSU-010',
  UNKNOWN: 'CSU-999'
};

function writeUpdateFailure({ code, error, backupPath = '', supportUrl = '', failedVersion = '', restored = false, restoreError = '', restoreStatus = 'not-needed', phase = '' }) {
  fs.mkdirSync(path.dirname(UPDATE_FAILURE_PATH), { recursive: true });
  const payload = {
    failed: true,
    errorCode: code || UPDATE_ERROR_CODES.UNKNOWN,
    error: String(error || 'Unbekannter Fehler'),
    phase,
    restored: Boolean(restored),
    restoreStatus,
    restoreError: String(restoreError || ''),
    backupPath,
    supportUrl: isValidWebUrl(supportUrl) ? supportUrl : '',
    failedVersion,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(UPDATE_FAILURE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function readUpdateFailure() {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATE_FAILURE_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return data && data.failed ? data : null;
  } catch {
    return null;
  }
}

function acknowledgeUpdateFailure() {
  const failure = readUpdateFailure();
  if (fs.existsSync(UPDATE_FAILURE_PATH)) fs.rmSync(UPDATE_FAILURE_PATH, { force: true });
  return {
    success: true,
    restored: Boolean(failure && failure.restored),
    restoreStatus: failure?.restoreStatus || (failure?.restored ? 'restored' : 'not-needed'),
    backupPath: failure?.backupPath || '',
    errorCode: failure?.errorCode || UPDATE_ERROR_CODES.UNKNOWN
  };
}

function getCachedSupportUrl() {
  try {
    const cached = JSON.parse(fs.readFileSync(SUPPORT_CACHE_PATH, 'utf8'));
    return isValidWebUrl(cached.supportUrl) ? cached.supportUrl : '';
  } catch {
    return '';
  }
}

async function openSupportWebsite() {
  const failure = readUpdateFailure();
  const url = isValidWebUrl(failure?.supportUrl) ? failure.supportUrl : getCachedSupportUrl();
  if (!isValidWebUrl(url)) throw new Error('Es wurde keine gültige Support-Webseite in der Render-Konfiguration hinterlegt. Bitte trage support_url in config/store.json ein und starte Core Store erneut.');
  await shell.openExternal(url);
  return { success: true };
}

async function checkStoreUpdateForAction() {
  try {
    return await getStoreUpdateInfo();
  } catch (error) {
    writeUpdateFailure({
      code: UPDATE_ERROR_CODES.UPDATE_INFO_FAILED,
      error: error.message,
      supportUrl: getCachedSupportUrl(),
      phase: 'update-info'
    });
    throw new Error(`[${UPDATE_ERROR_CODES.UPDATE_INFO_FAILED}] Update-Informationen konnten nicht geladen werden: ${error.message}`);
  }
}

async function startStoreUpdate() {
  let info;
  try {
    info = await getStoreUpdateInfo();
  } catch (error) {
    writeUpdateFailure({
      code: UPDATE_ERROR_CODES.UPDATE_INFO_FAILED,
      error: error.message,
      supportUrl: getCachedSupportUrl(),
      phase: 'update-info'
    });
    throw new Error(`[${UPDATE_ERROR_CODES.UPDATE_INFO_FAILED}] Update-Informationen konnten nicht geladen werden: ${error.message}`);
  }

  if (!info.available) throw new Error('Es ist kein Core-Store-Update verfügbar.');
  if (!app.isPackaged) throw new Error('Core-Store-Updates funktionieren nur in der installierten Programmversion.');

  let temp;
  try {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-store-self-update-'));
  } catch (error) {
    writeUpdateFailure({ code: UPDATE_ERROR_CODES.TEMP_DIR_FAILED, error: error.message, supportUrl: info.supportUrl, failedVersion: info.remoteVersion, phase: 'temp-directory' });
    throw new Error(`[${UPDATE_ERROR_CODES.TEMP_DIR_FAILED}] Temporärer Update-Arbeitsordner konnte nicht erstellt werden: ${error.message}`);
  }
  const zipPath = path.join(temp, 'core-store-update.zip');
  let backupPath = '';
  let phase = 'download';
  try {
    try {
      await downloadToFile('/api/store/download', zipPath);
    } catch (error) {
      writeUpdateFailure({ code: UPDATE_ERROR_CODES.DOWNLOAD_FAILED, error: error.message, unchanged: true, supportUrl: info.supportUrl, failedVersion: info.remoteVersion, phase });
      throw new Error(`[${UPDATE_ERROR_CODES.DOWNLOAD_FAILED}] Update-Paket konnte nicht heruntergeladen werden: ${error.message}`);
    }

    phase = 'archive-validation';
    try {
      validateStoreUpdateArchive(zipPath);
    } catch (error) {
      writeUpdateFailure({ code: UPDATE_ERROR_CODES.ARCHIVE_INVALID, error: error.message, unchanged: true, supportUrl: info.supportUrl, failedVersion: info.remoteVersion, phase });
      throw new Error(`[${UPDATE_ERROR_CODES.ARCHIVE_INVALID}] Update-Paket ist ungültig: ${error.message}`);
    }

    phase = 'backup';
    try {
      // Vollständige Sicherung: gesamter lokaler Core-Network-Ordner plus App-Dateien.
      // Das ZIP liegt außerhalb von DATA_ROOT, damit es nicht sich selbst enthält.
      backupPath = createFullBackup();
    } catch (error) {
      writeUpdateFailure({ code: UPDATE_ERROR_CODES.BACKUP_FAILED, error: error.message, unchanged: true, supportUrl: info.supportUrl, failedVersion: info.remoteVersion, phase });
      throw new Error(`[${UPDATE_ERROR_CODES.BACKUP_FAILED}] Backup konnte nicht erstellt werden: ${error.message}`);
    }

    if (fs.existsSync(UPDATE_FAILURE_PATH)) fs.rmSync(UPDATE_FAILURE_PATH, { force: true });

    const scriptPath = path.join(temp, 'apply-update.ps1');
    const appRoot = APP_ROOT;
    const executable = process.execPath;
    const installRoot = path.dirname(executable);
    const pid = process.pid;
    const statusPath = UPDATE_FAILURE_PATH;
    const psScript = String.raw`
param(
  [string]$ZipPath,
  [string]$AppRoot,
  [int]$WaitPid,
  [string]$ExePath,
  [string]$TempRoot,
  [string]$BackupZip,
  [string]$DataRoot,
  [string]$InstallRoot,
  [string]$StatusPath,
  [string]$SupportUrl,
  [string]$NewVersion
)
$ErrorActionPreference = 'Stop'
$Phase = 'wait'
while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }
$Extract = Join-Path $TempRoot 'update-files'
$Rollback = Join-Path $TempRoot 'rollback-files'
try {
  $Phase = 'extract'
  New-Item -ItemType Directory -Path $Extract -Force | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Extract -Force
  if (-not (Test-Path (Join-Path $Extract 'main.js')) -or -not (Test-Path (Join-Path $Extract 'package.json'))) {
    throw 'Das Update-Archiv enthält nicht die erforderlichen Dateien main.js und package.json.'
  }

  $Phase = 'apply'
  Get-ChildItem -LiteralPath $Extract -Force | ForEach-Object {
    $Destination = Join-Path $AppRoot $_.Name
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }

  $Phase = 'restart'
  $StartedProcess = Start-Process -FilePath $ExePath -PassThru -ErrorAction Stop
  Start-Sleep -Seconds 3
  $StartedProcess.Refresh()
  if ($StartedProcess.HasExited) { throw 'Core Store wurde gestartet, hat sich aber unmittelbar wieder beendet.' }
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}
catch {
  $UpdateError = $_.Exception.Message
  $ErrorCode = switch ($Phase) {
    'extract' { 'CSU-006' }
    'apply' { 'CSU-007' }
    'restart' { 'CSU-008' }
    default { 'CSU-999' }
  }
  $Restored = $false
  $RestoreError = ''
  try {
    $Phase = 'restore'
    New-Item -ItemType Directory -Path $Rollback -Force | Out-Null
    Expand-Archive -LiteralPath $BackupZip -DestinationPath $Rollback -Force
    $NetworkBackup = Join-Path $Rollback 'Core Network'
    $InstallBackup = Join-Path $Rollback 'Core Store Installation'

    if (Test-Path -LiteralPath $NetworkBackup) {
      $DataParent = Split-Path -Parent $DataRoot
      if (Test-Path -LiteralPath $DataRoot) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
      New-Item -ItemType Directory -Path $DataParent -Force | Out-Null
      Copy-Item -LiteralPath $NetworkBackup -Destination $DataParent -Recurse -Force
    }
    if (Test-Path -LiteralPath $InstallBackup) {
      if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
      New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
      Get-ChildItem -LiteralPath $InstallBackup -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallRoot $_.Name) -Recurse -Force
      }
    }
    $Restored = $true
  }
  catch {
    $RestoreError = $_.Exception.Message
    $ErrorCode = 'CSU-009'
  }

  $StatusDirectory = Split-Path -Parent $StatusPath
  New-Item -ItemType Directory -Path $StatusDirectory -Force | Out-Null
  $Status = @{
    failed = $true
    errorCode = $ErrorCode
    failedPhase = $Phase
    restored = $Restored
    restoreStatus = $(if ($Restored) { 'restored' } else { 'failed' })
    error = $UpdateError
    restoreError = $RestoreError
    backupPath = $BackupZip
    supportUrl = $SupportUrl
    failedVersion = $NewVersion
    createdAt = (Get-Date).ToString('o')
  }
  $Status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatusPath -Encoding UTF8

  # Eigenständiges Fenster: funktioniert auch nach Rollback auf eine ältere App-Version.
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $Form = New-Object System.Windows.Forms.Form
    $Form.Text = 'Core Store - Update fehlgeschlagen'
    $Form.StartPosition = 'CenterScreen'
    $Form.Size = New-Object System.Drawing.Size(570, 285)
    $Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $Form.MaximizeBox = $false
    $Form.MinimizeBox = $false
    $Form.TopMost = $true

    $Title = New-Object System.Windows.Forms.Label
    $Title.Text = 'Das Core-Store-Update konnte nicht abgeschlossen werden.'
    $Title.Location = New-Object System.Drawing.Point(22, 18)
    $Title.Size = New-Object System.Drawing.Size(520, 35)
    $Title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $Form.Controls.Add($Title)

    $Message = New-Object System.Windows.Forms.Label
    if ($Restored) {
      $Message.Text = "Fehlercode: $ErrorCode" + [Environment]::NewLine + "Bitte melde dich über die Core-Network-Webseite. Die ursprünglichen Dateien wurden automatisch aus dem Backup wiederhergestellt." + [Environment]::NewLine + [Environment]::NewLine + "Fehler: $UpdateError"
    } else {
      $Message.Text = "Fehlercode: $ErrorCode" + [Environment]::NewLine + "Das Update ist fehlgeschlagen und die automatische Wiederherstellung war nicht erfolgreich. Bitte melde dich über die Core-Network-Webseite." + [Environment]::NewLine + [Environment]::NewLine + "Update-Fehler: $UpdateError" + [Environment]::NewLine + "Wiederherstellungsfehler: $RestoreError"
    }
    $Message.Location = New-Object System.Drawing.Point(22, 62)
    $Message.Size = New-Object System.Drawing.Size(520, 125)
    $Message.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $Form.Controls.Add($Message)

    $WebsiteButton = New-Object System.Windows.Forms.Button
    $WebsiteButton.Text = 'Webseite öffnen'
    $WebsiteButton.Location = New-Object System.Drawing.Point(260, 205)
    $WebsiteButton.Size = New-Object System.Drawing.Size(135, 32)
    $WebsiteButton.Add_Click({
      if ($SupportUrl -match '^https?://') { Start-Process -FilePath $SupportUrl }
      else { [System.Windows.Forms.MessageBox]::Show('Auf Render wurde keine gültige SUPPORT_URL hinterlegt.', 'Core Store', 'OK', 'Warning') | Out-Null }
    })
    $Form.Controls.Add($WebsiteButton)

    $FinishButton = New-Object System.Windows.Forms.Button
    $FinishButton.Text = 'Abschließen'
    $FinishButton.Location = New-Object System.Drawing.Point(405, 205)
    $FinishButton.Size = New-Object System.Drawing.Size(120, 32)
    $FinishButton.Add_Click({
      if ($Restored) {
        [System.Windows.Forms.MessageBox]::Show('Die ursprünglichen Dateien wurden aus dem Backup wiederhergestellt.', 'Core Store - Wiederherstellung', 'OK', 'Information') | Out-Null
      } else {
        [System.Windows.Forms.MessageBox]::Show('Die ursprünglichen Dateien konnten nicht vollständig wiederhergestellt werden. Bitte öffne die Support-Webseite.', 'Core Store - Wiederherstellung', 'OK', 'Warning') | Out-Null
      }
      $Form.Close()
    })
    $Form.Controls.Add($FinishButton)
    [void]$Form.ShowDialog()
  }
  catch {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show("Fehlercode: $ErrorCode" + [Environment]::NewLine + "Das Update ist fehlgeschlagen. $UpdateError" + [Environment]::NewLine + "Backup: $BackupZip", 'Core Store - Update fehlgeschlagen') | Out-Null
    } catch { }
  }

  Remove-Item -LiteralPath $StatusPath -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $ExePath -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
`;
    fs.writeFileSync(scriptPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(psScript, 'utf8')]));

    phase = 'helper-start';
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
        zipPath, appRoot, String(pid), executable, temp, backupPath, DATA_ROOT,
        path.dirname(executable), statusPath, info.supportUrl || '', info.remoteVersion || ''
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', reject);
    });
    app.quit();
    return { success: true, backupPath };
  } catch (error) {
    if (!readUpdateFailure()) {
      const code = phase === 'helper-start' ? UPDATE_ERROR_CODES.HELPER_START_FAILED : UPDATE_ERROR_CODES.UNKNOWN;
      writeUpdateFailure({ code, error: error.message, backupPath, supportUrl: info.supportUrl, failedVersion: info.remoteVersion, unchanged: phase === 'helper-start', phase });
    }
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#070d18',
    title: 'Core Store',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('Core Store preload konnte nicht geladen werden:', preloadPath, error);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Core Store Oberfläche konnte nicht geladen werden:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html')).catch(error => {
    console.error('Fehler beim Laden der Core-Store-Oberfläche:', error);
    dialog.showErrorBox('Core Store', `Die Oberfläche konnte nicht geladen werden.\n\n${error.message}`);
  });
}

function registerIpc() {
  ipcMain.handle('app:get-info', () => ({ version: APP_VERSION }));
  ipcMain.handle('store:get-programs', () => getPrograms());
  ipcMain.handle('store:install', (_event, id) => installProgram(id));
  ipcMain.handle('store:start', (_event, id) => startProgram(id));
  ipcMain.handle('store:update-program', (_event, id) => updateProgram(id));
  ipcMain.handle('store:uninstall', (_event, id) => uninstallProgram(id));
  ipcMain.handle('store:check-update', () => getStoreUpdateInfo());
  ipcMain.handle('store:check-update-for-action', () => checkStoreUpdateForAction());
  ipcMain.handle('store:apply-update', () => startStoreUpdate());
  ipcMain.handle('store:get-update-failure', () => readUpdateFailure());
  ipcMain.handle('store:acknowledge-update-failure', () => acknowledgeUpdateFailure());
  ipcMain.handle('store:open-support-website', () => openSupportWebsite());
  ipcMain.handle('app:open-data-folder', () => shell.openPath(DATA_ROOT));
  ipcMain.handle('app:open-program-folder', async (_event, id) => {
    const programs = await getPrograms();
    const program = programs.find(item => item.id === validateId(id));
    if (!program) throw new Error('Programm wurde nicht gefunden.');
    return shell.openPath(programDirectory(program));
  });
}

app.whenReady().then(() => {
  try {
    ensureDirectories();
    apiUrl = loadSettings();
    registerIpc();
    createWindow();
  } catch (error) {
    dialog.showErrorBox('Core Store konnte nicht gestartet werden', error.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
