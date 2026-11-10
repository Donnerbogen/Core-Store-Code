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
const APPDATA_ROOT = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_ROOT = path.join(LOCAL_ROOT, 'Core Network');
const STORE_ROOT = path.join(DATA_ROOT, 'Core Store');
const INSTALLER_ROOT = path.join(STORE_ROOT, 'Installer');
// Programme liegen getrennt von den Store-Einstellungen im Roaming-Profil.
const PROGRAMS_ROOT = path.join(APPDATA_ROOT, 'Core Network');
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
  fs.mkdirSync(PROGRAMS_ROOT, { recursive: true });
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });

  if (!fs.existsSync(SETTINGS_PATH)) {
    const packagedSettings = path.join(APP_ROOT, 'settings.json');
    if (fs.existsSync(packagedSettings)) {
      fs.copyFileSync(packagedSettings, SETTINGS_PATH);
    }
  }

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

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Ungültige API-Adresse in settings.json.');
  }

  return url;
}

function readInstalled() {
  try {
    const data = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));

    return data && typeof data === 'object' && !Array.isArray(data)
      ? data
      : {};
  } catch {
    return {};
  }
}

function writeInstalled(data) {
  const temporary = `${INSTALLED_PATH}.tmp`;

  fs.writeFileSync(
    temporary,
    JSON.stringify(data, null, 2),
    'utf8'
  );

  if (fs.existsSync(INSTALLED_PATH)) {
    fs.rmSync(INSTALLED_PATH, { force: true });
  }

  fs.renameSync(temporary, INSTALLED_PATH);
}

function validateId(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(value)
  ) {
    throw new Error('Ungültige Programm-ID.');
  }

  return value;
}

function safeFolderName(value, fallback) {
  let name = String(value || fallback || '').trim();

  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '');

  if (!name || name === '.' || name === '..') {
    name = String(fallback || 'Programm');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    name = `_${name}`;
  }

  if (
    name.toLowerCase() === 'core store' ||
    name.toLowerCase() === 'installer'
  ) {
    name = `${name} Programm`;
  }

  return name;
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value) {
    throw new Error('Ungültiger Dateipfad.');
  }

  const normalized = value.replace(/\\/g, '/');

  if (normalized.startsWith('/') || normalized.includes(':')) {
    throw new Error('Ungültiger Dateipfad.');
  }

  const parts = normalized.split('/');

  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Ungültiger Dateipfad.');
  }

  return parts.join('/');
}

function safeChild(root, relative) {
  const safe = safeRelative(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, ...safe.split('/'));

  if (
    target !== base &&
    !target.startsWith(base + path.sep)
  ) {
    throw new Error('Dateipfad liegt außerhalb des Zielordners.');
  }

  return target;
}

function programDirectory(program) {
  return path.join(
    PROGRAMS_ROOT,
    safeFolderName(program.name, program.id)
  );
}

function requestBuffer(url, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;

    const request = client.get(
      url,
      {
        headers: {
          'User-Agent': 'Core-Store-Desktop'
        }
      },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();

          requestBuffer(response.headers.location, timeout)
            .then(resolve, reject);

          return;
        }

        const chunks = [];

        response.on('data', chunk => chunks.push(chunk));

        response.on('end', () => {
          const body = Buffer.concat(chunks);

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            let message = body.toString('utf8');

            try {
              message = JSON.parse(message).error || message;
            } catch {}

            reject(
              new Error(
                `HTTP ${response.statusCode}: ${message.slice(0, 500)}`
              )
            );

            return;
          }

          resolve(body);
        });
      }
    );

    request.setTimeout(timeout, () => {
      request.destroy(
        new Error('Zeitüberschreitung bei der Serveranfrage.')
      );
    });

    request.on('error', reject);
  });
}

async function apiJson(endpoint) {
  const buffer = await requestBuffer(`${apiUrl}${endpoint}`);

  return JSON.parse(buffer.toString('utf8'));
}

async function downloadToFile(endpoint, destination) {
  const buffer = await requestBuffer(`${apiUrl}${endpoint}`);

  fs.mkdirSync(path.dirname(destination), {
    recursive: true
  });

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

    fs.mkdirSync(path.dirname(target), {
      recursive: true
    });

    fs.writeFileSync(target, entry.getData());
  }
}

function parseVersion(version) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version)
  ) {
    return [0, 0, 0];
  }

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
  const legacyPaths = [
    // Früheres Layout: %LOCALAPPDATA%\Core Network\<Programmname>
    path.join(DATA_ROOT, safeFolderName(program.name, id)),
    // Noch älteres Layout: %LOCALAPPDATA%\Core Network\Programs\<ID>
    path.join(DATA_ROOT, 'Programs', id)
  ];

  if (!fs.existsSync(target)) {
    const legacyPath = legacyPaths.find(candidate =>
      path.resolve(candidate) !== path.resolve(target) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isDirectory()
    );

    if (legacyPath) {
      moveDirectory(legacyPath, target);
    }
  }

  return target;
}

function getProgramState(program, installed) {
  const id = validateId(program.id);
  const target = migrateLegacyProgramFolder(program);

  const exists =
    fs.existsSync(target) &&
    fs.statSync(target).isDirectory();

  const record = installed[id] || {};
  // Ein Ordner allein bedeutet nicht, dass die Installation erfolgreich war.
  // Erst ein erfolgreicher Installationslauf schreibt einen Eintrag in installed.json.
  const isInstalled = exists && Boolean(record.installed);

  const localVersion = record.version || '0.0.0';
  const remoteVersion = String(program.version || '0.0.0');

  return {
    installed: isInstalled,
    localVersion,
    remoteVersion,
    updateAvailable:
      isInstalled &&
      compareVersions(remoteVersion, localVersion) > 0
  };
}

async function getPrograms() {
  const data = await apiJson('/api/programs');

  if (!Array.isArray(data.programs)) {
    throw new Error(
      'Der Server hat keine gültige Programmliste geliefert.'
    );
  }

  const installed = readInstalled();

  return data.programs.map(program => ({
    ...program,
    state: getProgramState(program, installed)
  }));
}

function runProgramFile(program, programDir, action) {
  const relative = program.files && program.files[action];
  const execution = program.execution || {};

  if (!relative || execution[action] === false) {
    return { skipped: true };
  }

  const target = safeChild(programDir, relative);

  if (!fs.existsSync(target)) {
    throw new Error(
      `Datei für Aktion '${action}' fehlt: ${relative}`
    );
  }

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
    args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      target
    ];
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

  const wait =
    action === 'start'
      ? false
      : execution[waitKeys[action] || ''] !== false;

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
      const details = (
        result.stderr ||
        result.stdout ||
        ''
      ).trim();

      throw new Error(
        `${relative} wurde mit Fehlercode ${result.status}.` +
        `${details ? `\n${details}` : ''}`
      );
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

    fs.rmSync(newPath, {
      recursive: true,
      force: true
    });

    fs.mkdirSync(path.dirname(newPath), {
      recursive: true
    });

    fs.cpSync(oldPath, newPath, {
      recursive: true,
      force: true
    });
  }
}

async function downloadProgramArchive(programId, archivePath) {
  await downloadToFile(
    `/api/programs/${encodeURIComponent(validateId(programId))}/download`,
    archivePath
  );
}

// ============================================================
// SICHERES KOPIEREN UND VERSCHIEBEN
// ============================================================

function moveDirectory(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Quellordner fehlt: ${sourcePath}`);
  }

  if (fs.existsSync(destinationPath)) {
    throw new Error(`Zielordner existiert bereits: ${destinationPath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), {
    recursive: true
  });

  try {
    fs.renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') {
      throw error;
    }
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
      throw new Error(
        'Dateikopie unvollständig: Anzahl der Dateien stimmt nicht überein.'
      );
    }

    for (let i = 0; i < sourceFiles.length; i++) {
      if (
        sourceFiles[i].relative !== copiedFiles[i].relative ||
        sourceFiles[i].size !== copiedFiles[i].size
      ) {
        throw new Error(
          `Dateikopie unvollständig: ${sourceFiles[i].relative}`
        );
      }
    }

    fs.renameSync(copyTemp, destinationPath);

    fs.rmSync(sourcePath, {
      recursive: true,
      force: true
    });
  } catch (error) {
    fs.rmSync(copyTemp, {
      recursive: true,
      force: true
    });

    throw error;
  }
}

function collectFileManifest(root) {
  const result = [];

  function walk(current, relativeBase) {
    for (const entry of fs.readdirSync(current, {
      withFileTypes: true
    })) {
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
        throw new Error(
          `Nicht unterstützter Dateityp beim Kopieren: ${relative}`
        );
      }
    }
  }

  walk(root, '');

  result.sort((a, b) =>
    a.relative.localeCompare(b.relative)
  );

  return result;
}

// ============================================================
// INSTALLATION
// ============================================================

async function installProgram(programId) {
  const programs = await getPrograms();

  const program = programs.find(item => item.id === programId);

  if (!program) {
    throw new Error('Programm wurde nicht gefunden.');
  }

  if (program.state.installed) {
    throw new Error('Programm ist bereits installiert.');
  }

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'core-install-')
  );

  const archive = path.join(temp, 'program.zip');
  const target = programDirectory(program);

  try {
    // Nur das ZIP wird temporär gespeichert. Die Programmdaten selbst
    // werden direkt in den endgültigen APPDATA-Zielordner entpackt.
    await downloadProgramArchive(programId, archive);

    fs.mkdirSync(target, { recursive: true });
    extractZipSafely(archive, target);

    // Das Installationsskript läuft erst nach dem Entpacken und direkt
    // aus dem endgültigen Programmordner.
    runProgramFile(program, target, 'installation');

    const installed = readInstalled();

    installed[programId] = {
      name: program.name || programId,
      version: program.version || '0.0.0',
      folder: target,
      installed: true
    };

    writeInstalled(installed);

    return {
      success: true,
      programs: await getPrograms()
    };
  } catch (error) {
    // Den entpackten Ordner absichtlich behalten. So bleiben Dateien
    // für Diagnose und einen erneuten Installationsversuch verfügbar.
    throw new Error(
      `${error.message}\n\nProgrammdateien liegen unter: ${target}`
    );
  } finally {
    fs.rmSync(temp, {
      recursive: true,
      force: true
    });
  }
}

async function startProgram(programId) {
  const programs = await getPrograms();

  const program = programs.find(item => item.id === programId);

  if (!program) {
    throw new Error('Programm wurde nicht gefunden.');
  }

  if (!program.state.installed) {
    throw new Error('Programm ist nicht installiert.');
  }

  runProgramFile(
    program,
    programDirectory(program),
    'start'
  );

  return { success: true };
}

// ============================================================
// UPDATE
// ============================================================

async function updateProgram(programId) {
  const programs = await getPrograms();

  const program = programs.find(item => item.id === programId);

  if (!program) {
    throw new Error('Programm wurde nicht gefunden.');
  }

  if (!program.state.installed) {
    throw new Error('Programm ist nicht installiert.');
  }

  if (!program.state.updateAvailable) {
    throw new Error('Es ist kein Update verfügbar.');
  }

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'core-program-update-')
  );

  const archive = path.join(temp, 'program.zip');
  const backup = path.join(temp, 'backup');
  const target = programDirectory(program);
  let backupCreated = false;
  let updateCommitted = false;

  try {
    await downloadProgramArchive(programId, archive);

    // Vor dem Austausch wird die bisherige Installation gesichert.
    moveDirectory(target, backup);
    backupCreated = true;

    try {
      fs.mkdirSync(target, { recursive: true });
      extractZipSafely(archive, target);
      preserveUserData(program, backup, target);

      // Auch das Update-Skript läuft im endgültigen APPDATA-Ordner.
      runProgramFile(program, target, 'update');

      const installed = readInstalled();
      installed[programId] = {
        name: program.name || programId,
        version: program.version || '0.0.0',
        folder: target,
        installed: true
      };
      writeInstalled(installed);

      updateCommitted = true;
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      if (backupCreated && fs.existsSync(backup)) {
        moveDirectory(backup, target);
        backupCreated = false;
      }
      throw error;
    }

    if (updateCommitted && fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true, force: true });
      backupCreated = false;
    }

    return {
      success: true,
      programs: await getPrograms()
    };
  } finally {
    if (
      backupCreated &&
      fs.existsSync(backup) &&
      !fs.existsSync(target)
    ) {
      moveDirectory(backup, target);
    }

    fs.rmSync(temp, {
      recursive: true,
      force: true
    });
  }
}

// ============================================================
// DEINSTALLATION
// ============================================================

async function uninstallProgram(programId) {
  const programs = await getPrograms();

  const program = programs.find(item => item.id === programId);

  if (!program) {
    throw new Error('Programm wurde nicht gefunden.');
  }

  if (!program.state.installed) {
    throw new Error('Programm ist nicht installiert.');
  }

  const target = programDirectory(program);

  runProgramFile(
    program,
    target,
    'uninstallation'
  );

  fs.rmSync(target, {
    recursive: true,
    force: true
  });

  const installed = readInstalled();

  delete installed[programId];

  writeInstalled(installed);

  return {
    success: true,
    programs: await getPrograms()
  };
}

// ============================================================
// STORE-UPDATE
// ============================================================

function isValidWebUrl(value) {
  try {
    const parsed = new URL(String(value || ''));

    return (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:'
    );
  } catch {
    return false;
  }
}

function getCachedSupportUrl() {
  try {
    const data = JSON.parse(
      fs.readFileSync(SUPPORT_CACHE_PATH, 'utf8')
    );

    return isValidWebUrl(data.supportUrl)
      ? data.supportUrl
      : '';
  } catch {
    return '';
  }
}

async function getStoreUpdateInfo() {
  const data = await apiJson('/api/store/version');

  if (!data.enabled) {
    return {
      available: false,
      disabled: true,
      currentVersion: APP_VERSION,
      supportUrl: isValidWebUrl(data.support_url)
        ? data.support_url
        : getCachedSupportUrl()
    };
  }

  const supportUrl = isValidWebUrl(data.support_url)
    ? data.support_url
    : '';

  if (supportUrl) {
    fs.mkdirSync(STORE_ROOT, {
      recursive: true
    });

    fs.writeFileSync(
      SUPPORT_CACHE_PATH,
      JSON.stringify({
        supportUrl,
        savedAt: new Date().toISOString()
      }, null, 2),
      'utf8'
    );
  }

  return {
    available:
      compareVersions(
        String(data.version || '0.0.0'),
        APP_VERSION
      ) > 0,

    currentVersion: APP_VERSION,
    remoteVersion: data.version,

    releaseNotes: Array.isArray(data.release_notes)
      ? data.release_notes
      : [],

    supportUrl: supportUrl || getCachedSupportUrl()
  };
}

// ============================================================
// NEU: VERSION DIREKT AUS store.json ANZEIGEN
// ============================================================

async function getConfiguredStoreVersion() {
  try {
    const data = await apiJson('/api/store/version');

    const configuredVersion = String(
      data.version || ''
    ).trim();

    if (/^\d+\.\d+\.\d+$/.test(configuredVersion)) {
      return configuredVersion;
    }

    console.warn(
      'Ungültige Store-Version aus config/store.json erhalten.'
    );
  } catch (error) {
    console.warn(
      'Store-Version konnte nicht von der API geladen werden:',
      error.message
    );
  }

  return APP_VERSION;
}

// ============================================================
// BACKUP
// ============================================================

function createFullBackup() {
  fs.mkdirSync(BACKUP_ROOT, {
    recursive: true
  });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-');

  const backupPath = path.join(
    BACKUP_ROOT,
    `Core-Store-Backup-${stamp}.zip`
  );

  const zip = new AdmZip();
  const installRoot = path.dirname(process.execPath);

  if (fs.existsSync(DATA_ROOT)) {
    zip.addLocalFolder(DATA_ROOT, 'Core Network');
  }

  if (fs.existsSync(installRoot)) {
    zip.addLocalFolder(
      installRoot,
      'Core Store Installation'
    );
  }

  zip.addFile(
    'Backup-Information.json',
    Buffer.from(
      JSON.stringify({
        createdAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        dataRoot: DATA_ROOT,
        appRoot: APP_ROOT
      }, null, 2)
    )
  );

  zip.writeZip(backupPath);

  return backupPath;
}

// ============================================================
// UPDATE-FEHLER
// ============================================================

const UPDATE_ERROR_CODES = {
  DOWNLOAD_FAILED: 'CSU-001',
  INVALID_ARCHIVE: 'CSU-002',
  BACKUP_FAILED: 'CSU-003',
  UPDATE_FAILED: 'CSU-004',
  RESTORE_FAILED: 'CSU-005',
  HELPER_START_FAILED: 'CSU-006',
  UNKNOWN: 'CSU-999'
};

function writeUpdateFailure(data) {
  fs.mkdirSync(STORE_ROOT, {
    recursive: true
  });

  fs.writeFileSync(
    UPDATE_FAILURE_PATH,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

function readUpdateFailure() {
  try {
    return JSON.parse(
      fs.readFileSync(UPDATE_FAILURE_PATH, 'utf8')
    );
  } catch {
    return null;
  }
}

function acknowledgeUpdateFailure() {
  const failure = readUpdateFailure();

  if (!failure) {
    return {
      success: true,
      restored: false
    };
  }

  fs.rmSync(UPDATE_FAILURE_PATH, {
    force: true
  });

  return {
    success: true,
    restored: Boolean(failure.restored),
    restoreStatus: failure.restoreStatus,
    errorCode: failure.errorCode
  };
}

function getCachedSupportUrlSafe() {
  return getCachedSupportUrl();
}

// ============================================================
// STORE UPDATE STARTEN
// ============================================================

async function startStoreUpdate() {
  const info = await getStoreUpdateInfo();

  if (!info.available) {
    throw new Error('Es ist kein Core-Store-Update verfügbar.');
  }

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'core-store-update-')
  );

  const zipPath = path.join(temp, 'update.zip');
  const backupPath = createFullBackup();

  try {
    await downloadToFile(
      '/api/store/download',
      zipPath
    );

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    if (!entries.length) {
      throw new Error('Das Update-Archiv ist leer.');
    }

    const statusPath = path.join(
      STORE_ROOT,
      'update-status.json'
    );

    const executable = process.execPath;
    const pid = process.pid;
    const appRoot = APP_ROOT;

    const scriptPath = path.join(
      temp,
      'apply-update.ps1'
    );

    const psScript = `
param(
  [string]$ZipPath,
  [string]$AppRoot,
  [int]$ProcessId,
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
$Phase = 'prepare'
$Restored = $false
$RestoreError = ''
$UpdateError = ''
$ErrorCode = 'CSU-999'

try {
  $Phase = 'wait-for-app'

  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Start-Sleep -Milliseconds 500
  }

  $Phase = 'extract'

  $ExtractPath = Join-Path $TempRoot 'extracted'
  New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null

  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractPath -Force

  $Phase = 'validate'

  $Items = Get-ChildItem -LiteralPath $ExtractPath -Force

  if (-not $Items) {
    throw 'Das Update enthält keine Dateien.'
  }

  $Phase = 'copy'

  foreach ($Item in $Items) {
    $Destination = Join-Path $AppRoot $Item.Name

    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }

    Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Recurse -Force
  }

  $Phase = 'verify'

  foreach ($Item in $Items) {
    $Destination = Join-Path $AppRoot $Item.Name

    if (-not (Test-Path -LiteralPath $Destination)) {
      throw "Datei fehlt nach dem Kopieren: $($Item.Name)"
    }
  }

  $Phase = 'complete'

  $Status = @{
    success = $true
    version = $NewVersion
    createdAt = (Get-Date).ToString('o')
  }

  $Status | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StatusPath -Encoding UTF8

  Start-Process -FilePath $ExePath
  Start-Sleep -Seconds 2

  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}
catch {
  $UpdateError = $_.Exception.Message

  if ($Phase -eq 'extract') {
    $ErrorCode = 'CSU-002'
  }
  elseif ($Phase -eq 'copy' -or $Phase -eq 'verify') {
    $ErrorCode = 'CSU-004'
  }

  $Phase = 'restore'

  try {
    if (-not (Test-Path -LiteralPath $BackupZip)) {
      throw 'Backup-Datei fehlt.'
    }

    $RestoreTemp = Join-Path $TempRoot 'restore'
    New-Item -ItemType Directory -Path $RestoreTemp -Force | Out-Null

    Expand-Archive -LiteralPath $BackupZip -DestinationPath $RestoreTemp -Force

    $DataBackup = Join-Path $RestoreTemp 'Core Network'
    $InstallBackup = Join-Path $RestoreTemp 'Core Store Installation'

    if (Test-Path -LiteralPath $DataBackup) {
      Get-ChildItem -LiteralPath $DataBackup -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $DataRoot -Recurse -Force
      }
    }

    if (Test-Path -LiteralPath $InstallBackup) {
      Get-ChildItem -LiteralPath $InstallBackup -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
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
      if ($SupportUrl -match '^https?://') {
        Start-Process -FilePath $SupportUrl
      }
      else {
        [System.Windows.Forms.MessageBox]::Show(
          'Auf Render wurde keine gültige SUPPORT_URL hinterlegt.',
          'Core Store',
          'OK',
          'Warning'
        ) | Out-Null
      }
    })

    $Form.Controls.Add($WebsiteButton)

    $FinishButton = New-Object System.Windows.Forms.Button
    $FinishButton.Text = 'Abschließen'
    $FinishButton.Location = New-Object System.Drawing.Point(405, 205)
    $FinishButton.Size = New-Object System.Drawing.Size(120, 32)

    $FinishButton.Add_Click({
      if ($Restored) {
        [System.Windows.Forms.MessageBox]::Show(
          'Die ursprünglichen Dateien wurden aus dem Backup wiederhergestellt.',
          'Core Store - Wiederherstellung',
          'OK',
          'Information'
        ) | Out-Null
      }
      else {
        [System.Windows.Forms.MessageBox]::Show(
          'Die ursprünglichen Dateien konnten nicht vollständig wiederhergestellt werden. Bitte öffne die Support-Webseite.',
          'Core Store - Wiederherstellung',
          'OK',
          'Warning'
        ) | Out-Null
      }

      $Form.Close()
    })

    $Form.Controls.Add($FinishButton)

    [void]$Form.ShowDialog()
  }
  catch {
    try {
      Add-Type -AssemblyName System.Windows.Forms

      [System.Windows.Forms.MessageBox]::Show(
        "Fehlercode: $ErrorCode" + [Environment]::NewLine + "Das Update ist fehlgeschlagen. $UpdateError" + [Environment]::NewLine + "Backup: $BackupZip",
        'Core Store - Update fehlgeschlagen'
      ) | Out-Null
    } catch { }
  }

  Remove-Item -LiteralPath $StatusPath -Force -ErrorAction SilentlyContinue

  Start-Process -FilePath $ExePath -ErrorAction SilentlyContinue

  Start-Sleep -Seconds 2

  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue

  exit 1
}
`;

    fs.writeFileSync(
      scriptPath,
      Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(psScript, 'utf8')
      ])
    );

    await new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          zipPath,
          appRoot,
          String(pid),
          executable,
          temp,
          backupPath,
          DATA_ROOT,
          path.dirname(executable),
          statusPath,
          info.supportUrl || '',
          info.remoteVersion || ''
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        }
      );

      child.once('spawn', () => {
        child.unref();
        resolve();
      });

      child.once('error', reject);
    });

    app.quit();

    return {
      success: true,
      backupPath
    };
  } catch (error) {
    if (!readUpdateFailure()) {
      writeUpdateFailure({
        code: UPDATE_ERROR_CODES.UNKNOWN,
        error: error.message,
        backupPath,
        supportUrl: info.supportUrl,
        failedVersion: info.remoteVersion,
        unchanged: true
      });
    }

    fs.rmSync(temp, {
      recursive: true,
      force: true
    });

    throw error;
  }
}

// ============================================================
// FENSTER
// ============================================================

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

  mainWindow.webContents.on(
    'preload-error',
    (_event, preloadPath, error) => {
      console.error(
        'Core Store preload konnte nicht geladen werden:',
        preloadPath,
        error
      );
    }
  );

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        'Core Store Oberfläche konnte nicht geladen werden:',
        errorCode,
        errorDescription,
        validatedURL
      );
    }
  );

  mainWindow.loadFile(
    path.join(APP_ROOT, 'renderer', 'index.html')
  ).catch(error => {
    console.error(
      'Fehler beim Laden der Core-Store-Oberfläche:',
      error
    );

    dialog.showErrorBox(
      'Core Store',
      `Die Oberfläche konnte nicht geladen werden.\n\n${error.message}`
    );
  });
}

// ============================================================
// IPC
// ============================================================

function registerIpc() {
  ipcMain.handle(
    'app:get-info',
    async () => ({
      version: await getConfiguredStoreVersion(),
      packageVersion: APP_VERSION
    })
  );

  ipcMain.handle('store:check-maintenance', async () => {
    const data = await apiJson('/api/store/status');
    return {
      maintenance: Boolean(data.maintenance),
      title: String(data.title || 'Core Store wird aktualisiert'),
      message: String(data.message || 'Der Core Store wird gerade aktualisiert. Bitte versuche es später erneut.'),
      showRetry: data.show_retry !== false
    };
  });

  ipcMain.handle('store:get-programs', () => getPrograms());

  ipcMain.handle('store:install', (_event, id) =>
    installProgram(id)
  );

  ipcMain.handle('store:start', (_event, id) =>
    startProgram(id)
  );

  ipcMain.handle('store:update-program', (_event, id) =>
    updateProgram(id)
  );

  ipcMain.handle('store:uninstall', (_event, id) =>
    uninstallProgram(id)
  );

  ipcMain.handle('store:check-update', () =>
    getStoreUpdateInfo()
  );

  ipcMain.handle('store:check-update-for-action', () =>
    checkStoreUpdateForAction()
  );

  ipcMain.handle('store:apply-update', () =>
    startStoreUpdate()
  );

  ipcMain.handle('store:get-update-failure', () =>
    readUpdateFailure()
  );

  ipcMain.handle('store:acknowledge-update-failure', () =>
    acknowledgeUpdateFailure()
  );

  ipcMain.handle('store:open-support-website', () =>
    openSupportWebsite()
  );

  ipcMain.handle('app:open-data-folder', () =>
    shell.openPath(DATA_ROOT)
  );

  ipcMain.handle(
    'app:open-program-folder',
    async (_event, id) => {
      const programs = await getPrograms();

      const program = programs.find(
        item => item.id === validateId(id)
      );

      if (!program) {
        throw new Error('Programm wurde nicht gefunden.');
      }

      return shell.openPath(programDirectory(program));
    }
  );
}

// ============================================================
// START
// ============================================================

app.whenReady().then(() => {
  try {
    ensureDirectories();

    apiUrl = loadSettings();

    registerIpc();

    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      'Core Store konnte nicht gestartet werden',
      error.message
    );

    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
