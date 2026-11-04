const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const APP_VERSION = require('./package.json').version;
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : __dirname;
const SETTINGS_PATH = path.join(APP_ROOT, 'settings.json');
const DATA_ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Core Network');
const PROGRAMS_ROOT = path.join(DATA_ROOT, 'Programs');
const STORE_ROOT = path.join(DATA_ROOT, '_store');
const INSTALLED_PATH = path.join(STORE_ROOT, 'installed.json');
const REQUEST_TIMEOUT = 120000;

let mainWindow;
let apiUrl = '';

function ensureDirectories() {
  fs.mkdirSync(PROGRAMS_ROOT, { recursive: true });
  fs.mkdirSync(STORE_ROOT, { recursive: true });
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
  fs.renameSync(temporary, INSTALLED_PATH);
}

function validateId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('Ungültige Programm-ID.');
  }
  return value;
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

function getProgramState(program, installed) {
  const id = validateId(program.id);
  const target = path.join(PROGRAMS_ROOT, id);
  const exists = fs.existsSync(target) && fs.statSync(target).isDirectory();
  const record = installed[id] || {};
  const localVersion = record.version || '0.0.0';
  const remoteVersion = String(program.version || '0.0.0');
  const installedFlag = exists;
  return {
    installed: installedFlag,
    localVersion,
    remoteVersion,
    updateAvailable: installedFlag && compareVersions(remoteVersion, localVersion) > 0
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
      throw new Error(`${relative} wurde mit Fehlercode ${result.status} beendet.${details ? `\n${details}` : ''}`);
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

  const temp = fs.mkdtempSync(path.join(DATA_ROOT, 'core-install-'));
  const stage = path.join(temp, 'program');
  const archive = path.join(temp, 'program.zip');
  const target = path.join(PROGRAMS_ROOT, validateId(programId));
  try {
    await downloadProgramArchive(programId, archive);
    extractZipSafely(archive, stage);
    runProgramFile(program, stage, 'installation');
    fs.mkdirSync(PROGRAMS_ROOT, { recursive: true });
    fs.renameSync(stage, target);
    const installed = readInstalled();
    installed[programId] = {
      name: program.name || programId,
      version: program.version || '0.0.0',
      folder: target,
      installed: true
    };
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
  runProgramFile(program, path.join(PROGRAMS_ROOT, validateId(programId)), 'start');
  return { success: true };
}

async function updateProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
  if (!program.state.updateAvailable) throw new Error('Es ist kein Update verfügbar.');

  const temp = fs.mkdtempSync(path.join(DATA_ROOT, 'core-update-'));
  const stage = path.join(temp, 'program');
  const archive = path.join(temp, 'program.zip');
  const target = path.join(PROGRAMS_ROOT, validateId(programId));
  const backup = path.join(temp, 'backup');
  try {
    await downloadProgramArchive(programId, archive);
    extractZipSafely(archive, stage);
    preserveUserData(program, target, stage);
    runProgramFile(program, stage, 'update');
    fs.renameSync(target, backup);
    try {
      fs.renameSync(stage, target);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    const installed = readInstalled();
    installed[programId] = {
      name: program.name || programId,
      version: program.version || '0.0.0',
      folder: target,
      installed: true
    };
    writeInstalled(installed);
    return { success: true, programs: await getPrograms() };
  } finally {
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function uninstallProgram(programId) {
  const programs = await getPrograms();
  const program = programs.find(item => item.id === programId);
  if (!program) throw new Error('Programm wurde nicht gefunden.');
  if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
  const target = path.join(PROGRAMS_ROOT, validateId(programId));
  runProgramFile(program, target, 'uninstallation');
  fs.rmSync(target, { recursive: true, force: true });
  const installed = readInstalled();
  delete installed[programId];
  writeInstalled(installed);
  return { success: true, programs: await getPrograms() };
}

async function getStoreUpdateInfo() {
  const data = await apiJson('/api/store/version');
  if (!data.enabled) return { available: false, disabled: true, currentVersion: APP_VERSION };
  return {
    available: compareVersions(String(data.version || '0.0.0'), APP_VERSION) > 0,
    currentVersion: APP_VERSION,
    remoteVersion: data.version,
    releaseNotes: Array.isArray(data.release_notes) ? data.release_notes : []
  };
}

async function startStoreUpdate() {
  const info = await getStoreUpdateInfo();
  if (!info.available) throw new Error('Es ist kein Core-Store-Update verfügbar.');
  if (!app.isPackaged) throw new Error('Core-Store-Updates funktionieren nur in der installierten Programmversion.');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-store-self-update-'));
  const zipPath = path.join(temp, 'core-store-update.zip');
  await downloadToFile('/api/store/download', zipPath);

  const scriptPath = path.join(temp, 'apply-update.ps1');
  const appRoot = APP_ROOT;
  const executable = process.execPath;
  const pid = process.pid;
  const psScript = String.raw`
param([string]$ZipPath, [string]$AppRoot, [int]$WaitPid, [string]$ExePath, [string]$TempRoot)
$ErrorActionPreference = 'Stop'
while (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
$Extract = Join-Path $TempRoot 'extracted'
New-Item -ItemType Directory -Path $Extract -Force | Out-Null
Expand-Archive -LiteralPath $ZipPath -DestinationPath $Extract -Force
if (-not (Test-Path (Join-Path $Extract 'main.js')) -or -not (Test-Path (Join-Path $Extract 'package.json'))) { throw 'Das Update-Archiv ist unvollständig.' }
Get-ChildItem -LiteralPath $Extract -Force | ForEach-Object {
  $Destination = Join-Path $AppRoot $_.Name
  if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
}
Start-Process -FilePath $ExePath
Start-Sleep -Seconds 3
Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
`;
  fs.writeFileSync(scriptPath, psScript, 'utf8');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    zipPath, appRoot, String(pid), executable, temp
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  app.quit();
  return { success: true };
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
  mainWindow.loadFile(path.join(APP_ROOT, 'renderer', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('app:get-info', () => ({ version: APP_VERSION }));
  ipcMain.handle('store:get-programs', () => getPrograms());
  ipcMain.handle('store:install', (_event, id) => installProgram(id));
  ipcMain.handle('store:start', (_event, id) => startProgram(id));
  ipcMain.handle('store:update-program', (_event, id) => updateProgram(id));
  ipcMain.handle('store:uninstall', (_event, id) => uninstallProgram(id));
  ipcMain.handle('store:check-update', () => getStoreUpdateInfo());
  ipcMain.handle('store:apply-update', () => startStoreUpdate());
  ipcMain.handle('app:open-data-folder', () => shell.openPath(DATA_ROOT));
  ipcMain.handle('app:open-program-folder', (_event, id) => shell.openPath(path.join(PROGRAMS_ROOT, validateId(id))));
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
