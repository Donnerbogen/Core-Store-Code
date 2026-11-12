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
// Sämtliche CORE-Network-Daten liegen unter genau einem gemeinsamen Hauptordner.
const CORE_ROOT = path.join(APPDATA_ROOT, 'Core Network');
const DATA_ROOT = CORE_ROOT; // Kompatibilitätsname für vorhandene Update-/Backup-Funktionen.
const STORE_ROOT = path.join(CORE_ROOT, 'Core Store');
const INSTALLER_ROOT = path.join(STORE_ROOT, 'Installer');
const PROGRAMS_ROOT = CORE_ROOT;
const BACKUP_ROOT = path.join(CORE_ROOT, 'Backups');
const TEMP_ROOT = path.join(CORE_ROOT, 'Temp');
const LOG_ROOT = path.join(STORE_ROOT, 'Logs');
const LOG_PATH = path.join(LOG_ROOT, 'core-store.log');
const SETTINGS_PATH = path.join(STORE_ROOT, 'settings.json');
const INSTALLED_PATH = path.join(STORE_ROOT, 'installed.json');
const UPDATE_FAILURE_PATH = path.join(STORE_ROOT, 'update-failure.json');
const UPDATE_STATUS_PATH = path.join(STORE_ROOT, 'update-status.json');
const SUPPORT_CACHE_PATH = path.join(STORE_ROOT, 'support-url.json');
const REQUEST_TIMEOUT = 120000;
const MAX_ZIP_ENTRIES = 10000;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const activeOperations = new Set();
let installedManifestQueue = Promise.resolve();

// Electron-eigene Nutzerdaten und Cache ebenfalls im CORE-Network-Hauptordner halten.
try {
  for (const directory of [STORE_ROOT, TEMP_ROOT, LOG_ROOT]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const electronPaths = [
    ['userData', path.join(STORE_ROOT, 'UserData')],
    ['sessionData', path.join(STORE_ROOT, 'SessionData')],
    ['cache', path.join(TEMP_ROOT, 'Cache')],
    ['temp', TEMP_ROOT],
    ['logs', LOG_ROOT],
    ['crashDumps', path.join(TEMP_ROOT, 'CrashDumps')]
  ];
  for (const [name, location] of electronPaths) {
    try { app.setPath(name, location); }
    catch (error) { console.warn(`Electron-Pfad '${name}' konnte nicht angepasst werden:`, error.message); }
  }
} catch (error) {
  console.warn('CORE-Network-Speicherpfade konnten vor dem Start nicht vollständig vorbereitet werden:', error.message);
}

function log(message, details = '') {
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 5 * 1024 * 1024) {
      const previousLog = `${LOG_PATH}.1`;
      fs.rmSync(previousLog, { force: true });
      fs.renameSync(LOG_PATH, previousLog);
    }
    const suffix = details ? ` | ${String(details.stack || details.message || details)}` : '';
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}${suffix}\n`, 'utf8');
  } catch (error) {
    console.error('Core-Store-Log konnte nicht geschrieben werden:', error);
  }
}

async function runExclusive(key, task) {
  if (activeOperations.has(key)) {
    throw new Error('Für dieses Programm läuft bereits ein Vorgang. Bitte warte, bis er abgeschlossen ist.');
  }
  activeOperations.add(key);
  try { return await task(); }
  finally { activeOperations.delete(key); }
}

function createTempDirectory(prefix) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEMP_ROOT, prefix));
}

function mutateInstalled(mutator) {
  const operation = installedManifestQueue.then(() => {
    const installed = readInstalled();
    const result = mutator(installed);
    writeInstalled(installed);
    return result;
  });
  installedManifestQueue = operation.catch(() => {});
  return operation;
}

let mainWindow;
let apiUrl = '';

function copyFileIfMissing(source, destination) {
  if (!fs.existsSync(destination) && fs.existsSync(source) && fs.statSync(source).isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function copyDirectoryMissing(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryMissing(from, to);
    else if (entry.isFile()) copyFileIfMissing(from, to);
  }
}

function ensureDirectories() {
  for (const directory of [CORE_ROOT, STORE_ROOT, INSTALLER_ROOT, BACKUP_ROOT, TEMP_ROOT, LOG_ROOT]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  // Verwaiste temporäre Vorgänge älter als 24 Stunden entfernen.
  for (const entry of fs.readdirSync(TEMP_ROOT, { withFileTypes: true })) {
    const candidate = path.join(TEMP_ROOT, entry.name);
    try {
      if (Date.now() - fs.statSync(candidate).mtimeMs > 24 * 60 * 60 * 1000) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch (error) { log(`Temporärer Ordner konnte nicht bereinigt werden: ${candidate}`, error); }
  }

  // Migration aus älteren Versionen: Store-Daten lagen unter LOCALAPPDATA.
  const legacyRoot = path.join(LOCAL_ROOT, 'Core Network');
  const legacyStore = path.join(legacyRoot, 'Core Store');
  for (const file of ['settings.json', 'installed.json', 'update-failure.json', 'support-url.json', 'update-status.json']) {
    copyFileIfMissing(path.join(legacyStore, file), path.join(STORE_ROOT, file));
  }
  copyDirectoryMissing(path.join(legacyStore, 'Installer'), INSTALLER_ROOT);
  const legacyBackupRoot = path.join(LOCAL_ROOT, 'Core Network Backup');
  if (fs.existsSync(legacyBackupRoot)) {
    copyDirectoryMissing(legacyBackupRoot, path.join(BACKUP_ROOT, 'Legacy'));
  }
  copyFileIfMissing(path.join(legacyRoot, '_store', 'installed.json'), INSTALLED_PATH);
  if (!fs.existsSync(INSTALLED_PATH)) {
    try {
      const recoverable = fs.readdirSync(STORE_ROOT)
        .filter(name => /^installed\.json\.\d+\.bak$/.test(name))
        .map(name => path.join(STORE_ROOT, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (recoverable.length) fs.copyFileSync(recoverable[0], INSTALLED_PATH);
    } catch (error) { log('Wiederherstellung von installed.json fehlgeschlagen', error); }
  }

  // Noch ältere Store-Versionen hatten Einstellungen direkt im alten Hauptordner.
  copyFileIfMissing(path.join(legacyRoot, 'settings.json'), SETTINGS_PATH);

  if (!fs.existsSync(SETTINGS_PATH)) {
    const packagedSettings = path.join(APP_ROOT, 'settings.json');
    copyFileIfMissing(packagedSettings, SETTINGS_PATH);
  }

  // Alte Programminstallationen unter LOCALAPPDATA bleiben erhalten und werden
  // beim ersten Laden des jeweiligen Programms gezielt in den neuen Zielpfad verschoben.
  log(`Core Store initialisiert. Hauptordner: ${CORE_ROOT}`);
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
  if (!fs.existsSync(INSTALLED_PATH)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(INSTALLED_PATH, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('installed.json muss ein JSON-Objekt enthalten.');
    }
    return data;
  } catch (error) {
    log('installed.json ist beschädigt oder nicht lesbar', error);
    throw new Error(`Die Installationsübersicht ist beschädigt: ${error.message}. Datei: ${INSTALLED_PATH}`);
  }
}

function writeInstalled(data) {
  fs.mkdirSync(path.dirname(INSTALLED_PATH), { recursive: true });
  const temporary = `${INSTALLED_PATH}.${process.pid}.tmp`;
  const previous = `${INSTALLED_PATH}.${process.pid}.bak`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.rmSync(previous, { force: true });
    if (fs.existsSync(INSTALLED_PATH)) fs.renameSync(INSTALLED_PATH, previous);
    fs.renameSync(temporary, INSTALLED_PATH);
    fs.rmSync(previous, { force: true });
  } catch (error) {
    if (!fs.existsSync(INSTALLED_PATH) && fs.existsSync(previous)) {
      try { fs.renameSync(previous, INSTALLED_PATH); } catch {}
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
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

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name)) {
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

  if (parts.some(part =>
    !part || part === '.' || part === '..' ||
    /[<>:\"|?*\x00-\x1F]/.test(part) || /[. ]$/.test(part) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(part)
  )) {
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

function requestBuffer(url, timeout = REQUEST_TIMEOUT, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Zu viele HTTP-Weiterleitungen.'));
    let parsed;
    try { parsed = new URL(url); }
    catch { return reject(new Error('Ungültige Serveradresse.')); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error('Nicht unterstütztes Netzwerkprotokoll.'));
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, { headers: { 'User-Agent': 'Core-Store-Desktop' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed).toString();
        requestBuffer(nextUrl, timeout, redirectCount + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      let total = 0;
      const maxBytes = 200 * 1024 * 1024;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error('Serverantwort überschreitet das erlaubte Limit von 200 MB.'));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
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

  fs.mkdirSync(path.dirname(destination), {
    recursive: true
  });

  fs.writeFileSync(destination, buffer);
}

function extractZipSafely(zipPath, destination) {
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('Das ZIP-Archiv enthält keine Dateien.');
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Das ZIP-Archiv enthält zu viele Einträge (maximal ${MAX_ZIP_ENTRIES}).`);

  let totalBytes = 0;
  const seenPaths = new Set();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relative = safeRelative(entry.entryName);
    const collisionKey = relative.toLocaleLowerCase('en-US');
    if (seenPaths.has(collisionKey)) throw new Error(`Doppelter Dateipfad im ZIP-Archiv: ${relative}`);
    seenPaths.add(collisionKey);
    // Unix-Symlinks in Archiven werden nicht akzeptiert.
    const unixMode = (entry.header.attr >>> 16) & 0xF000;
    if (unixMode === 0xA000) throw new Error(`Symbolische Links sind im Programmpaket nicht erlaubt: ${relative}`);
    const data = entry.getData();
    totalBytes += data.length;
    if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error('Das entpackte Programmpaket überschreitet 512 MB.');
    const target = safeChild(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  if (totalBytes === 0) throw new Error('Das ZIP-Archiv enthält keine verwendbaren Dateien.');
  return { entries: entries.length, bytes: totalBytes };
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
  const legacyRoot = path.join(LOCAL_ROOT, 'Core Network');
  const legacyPaths = [
    // Früheres Layout: %LOCALAPPDATA%\Core Network\<Programmname>
    path.join(legacyRoot, safeFolderName(program.name, id)),
    // Noch älteres Layout: %LOCALAPPDATA%\Core Network\Programs\<ID>
    path.join(legacyRoot, 'Programs', id)
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
  const ids = new Set();
  const folders = new Set();
  for (const program of data.programs) {
    const id = validateId(program.id);
    if (ids.has(id)) throw new Error(`Doppelte Programm-ID in der Programmliste: ${id}`);
    ids.add(id);
    const folder = safeFolderName(program.name, id).toLocaleLowerCase('en-US');
    if (folder === 'core store' || folder === 'backups' || folder === 'temp') {
      throw new Error(`Der Programmname '${program.name}' ist für einen reservierten CORE-Network-Ordner nicht zulässig.`);
    }
    if (folders.has(folder)) throw new Error(`Mehrere Programme verwenden denselben Zielordner: ${program.name}`);
    folders.add(folder);
  }

  return data.programs.map(program => ({
    ...program,
    state: getProgramState(program, installed)
  }));
}

function buildProgramCommand(target) {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.bat' || ext === '.cmd') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `call \"${target}\"`] };
  }
  if (ext === '.py') return { command: 'py.exe', args: ['-3', target] };
  if (ext === '.ps1') return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', target] };
  if (ext === '.exe') return { command: target, args: [] };
  return null;
}

function runProgramFile(program, programDir, action) {
  const relative = program.files && program.files[action];
  const execution = program.execution || {};
  if (!relative || execution[action] === false) return { skipped: true };

  const target = safeChild(programDir, relative);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Datei für Aktion '${action}' fehlt oder ist keine Datei: ${relative}`);
  }

  const launch = buildProgramCommand(target);
  if (!launch) {
    throw new Error(`Nicht unterstütztes Dateiformat für '${action}': ${path.extname(target) || '(keine Dateiendung)'}. Verwende .bat, .cmd, .exe, .py oder .ps1.`);
  }

  // Installations, Updates und Deinstallationen müssen vollständig beendet sein,
  // bevor der Store den jeweiligen Vorgang als erfolgreich markieren darf.
  const wait = action !== 'start';
  const showConsole = execution.show_console !== false;

  log(`Aktion '${action}' wird ausgeführt: ${relative}`, `Programm=${program.id}; cwd=${programDir}`);

  if (wait) {
    const result = spawnSync(launch.command, launch.args, {
      cwd: programDir,
      encoding: 'utf8',
      windowsHide: !showConsole,
      timeout: Number(execution.timeout_ms) > 0 ? Math.min(Number(execution.timeout_ms), 60 * 60 * 1000) : 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      windowsVerbatimArguments: process.platform === 'win32' && ['.bat', '.cmd'].includes(path.extname(target).toLowerCase())
    });
    if (result.error) throw new Error(`${relative}: ${result.error.message}`);
    if (result.signal) throw new Error(`${relative} wurde durch Signal ${result.signal} beendet.`);
    if (result.status !== 0) {
      const details = (result.stderr || result.stdout || '').trim();
      throw new Error(`${relative} wurde mit Fehlercode ${result.status === null ? 'unbekannt' : result.status} beendet.${details ? `\n${details}` : ''}`);
    }
    return { completed: true, exitCode: 0 };
  }

  return new Promise((resolve, reject) => {
    let spawned = false;
    let settled = false;
    let launchTimer = null;
    const child = spawn(launch.command, launch.args, {
      cwd: programDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: !showConsole,
      windowsVerbatimArguments: process.platform === 'win32' && ['.bat', '.cmd'].includes(path.extname(target).toLowerCase())
    });
    child.once('error', error => {
      log(`Startfehler bei '${relative}'`, error);
      if (!settled) {
        settled = true;
        if (launchTimer) clearTimeout(launchTimer);
        reject(new Error(`${relative} konnte nicht gestartet werden: ${error.message}`));
      }
    });
    child.once('spawn', () => {
      spawned = true;
      const pid = child.pid;
      child.unref();
      log(`Startprozess erzeugt: ${relative}`, `PID=${pid || 'unbekannt'}`);
      // Kurzes Beobachtungsfenster erkennt Startskripte, die sofort mit Fehlercode enden.
      launchTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ started: true, pid: pid || null, process: relative });
      }, 500);
    });
    child.once('exit', (code, signal) => {
      if (!spawned) return;
      log(`Startprozess beendet: ${relative}`, `Code=${code}; Signal=${signal}`);
      if (!settled && (code !== 0 || signal)) {
        settled = true;
        if (launchTimer) clearTimeout(launchTimer);
        reject(new Error(`${relative} wurde direkt nach dem Start mit Fehlercode ${code === null ? signal : code} beendet. Details stehen in ${LOG_PATH}.`));
      }
    });
  });
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
  return runExclusive(`program:${validateId(programId)}`, async () => {
    const programs = await getPrograms();
    const program = programs.find(item => item.id === programId);
    if (!program) throw new Error('Programm wurde nicht gefunden.');
    if (program.state.installed) throw new Error('Programm ist bereits installiert.');

    const temp = createTempDirectory('install-');
    const archive = path.join(temp, 'program.zip');
    const target = programDirectory(program);
    try {
      await downloadProgramArchive(programId, archive);
      if (fs.existsSync(target)) {
        const failedRoot = path.join(BACKUP_ROOT, 'Failed-Installations', safeFolderName(program.name, programId));
        fs.mkdirSync(failedRoot, { recursive: true });
        const failedPath = path.join(failedRoot, new Date().toISOString().replace(/[:.]/g, '-') );
        moveDirectory(target, failedPath);
      }
      fs.mkdirSync(target, { recursive: true });
      const extracted = extractZipSafely(archive, target);
      log(`Programmpaket entpackt: ${program.name}`, `${extracted.entries} Einträge; ${extracted.bytes} Bytes; ${target}`);

      const installResult = runProgramFile(program, target, 'installation');
      if (!installResult.completed && !installResult.skipped) {
        throw new Error('Das Installationsskript wurde nicht vollständig abgewartet. Setze execution.wait_for_installation auf true.');
      }

      await mutateInstalled(installed => {
        installed[programId] = { name: program.name || programId, version: program.version || '0.0.0', folder: target, installed: true, installedAt: new Date().toISOString() };
      });
      log(`Installation abgeschlossen: ${program.name}`);
      return { success: true };
    } catch (error) {
      log(`Installation fehlgeschlagen: ${program.name}`, error);
      throw new Error(`${error.message}\n\nProgrammdateien liegen unter: ${target}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

async function startProgram(programId) {
  return runExclusive(`program:${validateId(programId)}`, async () => {
    const programs = await getPrograms();
    const program = programs.find(item => item.id === programId);
    if (!program) throw new Error('Programm wurde nicht gefunden.');
    if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
    const result = await runProgramFile(program, programDirectory(program), 'start');
    if (result.skipped) throw new Error('Für dieses Programm ist keine Startdatei konfiguriert oder die Startfunktion wurde deaktiviert.');
    return { success: true, ...result };
  });
}

// ============================================================
// UPDATE
// ============================================================

async function updateProgram(programId) {
  return runExclusive(`program:${validateId(programId)}`, async () => {
    const programs = await getPrograms();
    const program = programs.find(item => item.id === programId);
    if (!program) throw new Error('Programm wurde nicht gefunden.');
    if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
    if (!program.state.updateAvailable) throw new Error('Es ist kein Update verfügbar.');

    const temp = createTempDirectory('program-update-');
    const archive = path.join(temp, 'program.zip');
    const target = programDirectory(program);
    const backupDir = path.join(BACKUP_ROOT, 'Program-Updates', safeFolderName(program.name, programId));
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${programId}-${Date.now()}-${program.state.localVersion}.bak`);
    let backupCreated = false;
    try {
      await downloadProgramArchive(programId, archive);
      moveDirectory(target, backup);
      backupCreated = true;
      fs.mkdirSync(target, { recursive: true });
      const extracted = extractZipSafely(archive, target);
      preserveUserData(program, backup, target);
      const updateResult = runProgramFile(program, target, 'update');
      if (!updateResult.completed && !updateResult.skipped) {
        throw new Error('Das Update-Skript wurde nicht vollständig abgewartet. Setze execution.wait_for_update auf true.');
      }
      await mutateInstalled(installed => {
        installed[programId] = { name: program.name || programId, version: program.version || '0.0.0', folder: target, installed: true, installedAt: installed[programId]?.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      });
      log(`Update abgeschlossen: ${program.name}`, `${extracted.entries} Einträge; ${extracted.bytes} Bytes; Backup=${backup}`);
      return { success: true, backupPath: backup };
    } catch (error) {
      log(`Update fehlgeschlagen: ${program.name}`, error);
      try {
        if (backupCreated) {
          fs.rmSync(target, { recursive: true, force: true });
          if (fs.existsSync(backup)) moveDirectory(backup, target);
        }
        await mutateInstalled(installed => {
          if (installed[programId]) {
            installed[programId].version = program.state.localVersion;
            installed[programId].installed = true;
          }
        });
      } catch (restoreError) {
        log(`Wiederherstellung fehlgeschlagen: ${program.name}`, restoreError);
        throw new Error(`${error.message}\nZusätzlich ist die Wiederherstellung fehlgeschlagen: ${restoreError.message}\nBackup: ${backup}`);
      }
      throw new Error(`${error.message}\nDie vorherige Version wurde wiederhergestellt. Backup: ${backup}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}

// ============================================================
// DEINSTALLATION
// ============================================================

async function uninstallProgram(programId) {
  return runExclusive(`program:${validateId(programId)}`, async () => {
    const programs = await getPrograms();
    const program = programs.find(item => item.id === programId);
    if (!program) throw new Error('Programm wurde nicht gefunden.');
    if (!program.state.installed) throw new Error('Programm ist nicht installiert.');
    const target = programDirectory(program);
    const uninstallResult = runProgramFile(program, target, 'uninstallation');
    if (!uninstallResult.completed && !uninstallResult.skipped) {
      throw new Error('Das Deinstallationsskript wurde nicht vollständig abgewartet. Setze execution.wait_for_uninstallation auf true.');
    }

    // Vor dem Entfernen wird eine Wiederherstellungskopie aufbewahrt.
    const backupDir = path.join(BACKUP_ROOT, 'Uninstalled-Programs');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${safeFolderName(program.name, programId)}-${Date.now()}`);
    moveDirectory(target, backup);
    try {
      await mutateInstalled(installed => { delete installed[programId]; });
    } catch (error) {
      if (!fs.existsSync(target) && fs.existsSync(backup)) moveDirectory(backup, target);
      throw error;
    }
    log(`Programm deinstalliert: ${program.name}`, `Sicherung=${backup}`);
    return { success: true, backupPath: backup };
  });
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

// Wird vom Update-Button über store:check-update-for-action aufgerufen.
// Die Aktionsprüfung verwendet dieselbe zuverlässige Versionsprüfung wie
// die allgemeine Store-Update-Anzeige, damit beide Anzeigen identisch bleiben.
async function checkStoreUpdateForAction() {
  try {
    return await getStoreUpdateInfo();
  } catch (error) {
    writeUpdateFailure({
      errorCode: UPDATE_ERROR_CODES.VERSION_CHECK_FAILED,
      code: UPDATE_ERROR_CODES.VERSION_CHECK_FAILED,
      failedPhase: 'check-version',
      restoreStatus: 'not-needed',
      restored: false,
      unchanged: true,
      error: error.message || String(error),
      supportUrl: getCachedSupportUrlSafe(),
      createdAt: new Date().toISOString(),
      acknowledged: false
    });
    throw error;
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
// BACKUP
// ============================================================

function createFullBackup() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_ROOT, `Core-Network-Backup-${stamp}.zip`);
  const zip = new AdmZip();

  // Alle Daten sichern, aber Backups/Temp auslassen, damit keine rekursiven
  // Backups und keine unvollständigen temporären Downloads in das Archiv geraten.
  for (const entry of fs.readdirSync(CORE_ROOT, { withFileTypes: true })) {
    if (entry.name === 'Backups' || entry.name === 'Temp') continue;
    const full = path.join(CORE_ROOT, entry.name);
    if (entry.isDirectory()) zip.addLocalFolder(full, `Core Network/${entry.name}`);
    else if (entry.isFile()) zip.addLocalFile(full, 'Core Network');
  }

  zip.addFile('Backup-Information.json', Buffer.from(JSON.stringify({
    createdAt: new Date().toISOString(), appVersion: APP_VERSION,
    coreRoot: CORE_ROOT, storeRoot: STORE_ROOT, appRoot: APP_ROOT
  }, null, 2)));
  zip.writeZip(backupPath);
  log('Vollständiges CORE-Network-Backup erstellt', backupPath);
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
  VERSION_CHECK_FAILED: 'CSU-007',
  UNKNOWN: 'CSU-999'
};

function writeJsonAtomically(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // Windows kann rename über eine bestehende Datei ablehnen.
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  }
}

function writeUpdateFailure(data) {
  const normalized = {
    ...data,
    errorCode: data.errorCode || data.code || UPDATE_ERROR_CODES.UNKNOWN,
    code: data.errorCode || data.code || UPDATE_ERROR_CODES.UNKNOWN,
    createdAt: data.createdAt || new Date().toISOString()
  };
  writeJsonAtomically(UPDATE_FAILURE_PATH, normalized);
  log(`Store-Update fehlgeschlagen (${normalized.errorCode})`, normalized.error || normalized.message || 'Keine Detailmeldung');
  return normalized;
}

function readUpdateFailure() {
  try {
    const raw = fs.readFileSync(UPDATE_FAILURE_PATH, 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // Rückwärtskompatibilität mit älteren Fehlerdateien.
    if (!data.errorCode && data.code) data.errorCode = data.code;
    return data;
  } catch {
    return null;
  }
}

function acknowledgeUpdateFailure() {
  const failure = readUpdateFailure();
  if (!failure) return { success: true, restored: false };

  // Fehlerdetails nicht löschen: Sie bleiben für Support und Diagnose erhalten.
  const acknowledged = {
    ...failure,
    acknowledged: true,
    acknowledgedAt: new Date().toISOString()
  };
  writeJsonAtomically(UPDATE_FAILURE_PATH, acknowledged);

  return {
    success: true,
    restored: Boolean(failure.restored),
    restoreStatus: failure.restoreStatus,
    errorCode: failure.errorCode || failure.code || UPDATE_ERROR_CODES.UNKNOWN
  };
}

function validateStoreUpdateArchive(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('Das Update-Archiv ist leer.');
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Das Update enthält mehr als ${MAX_ZIP_ENTRIES} Einträge.`);

  let totalBytes = 0;
  const seen = new Set();
  let fileCount = 0;
  for (const entry of entries) {
    const normalized = String(entry.entryName || '').replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized) continue;
    const relative = safeRelative(normalized);
    const key = relative.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`Doppelter Dateipfad im Update-Archiv: ${relative}`);
    seen.add(key);
    const unixMode = (entry.header.attr >>> 16) & 0xF000;
    if (unixMode === 0xA000) throw new Error(`Symbolische Links sind im Update nicht erlaubt: ${relative}`);
    if (entry.isDirectory) continue;
    fileCount += 1;
    const bytes = entry.getData().length;
    totalBytes += bytes;
    if (totalBytes > MAX_EXTRACTED_BYTES) throw new Error('Das Store-Update überschreitet 512 MB entpackte Daten.');
  }
  if (!fileCount) throw new Error('Das Update-Archiv enthält keine Dateien.');
  return { entries: entries.length, files: fileCount, bytes: totalBytes };
}

function getCachedSupportUrlSafe() {
  return getCachedSupportUrl();
}

// ============================================================
// STORE UPDATE STARTEN
// ============================================================

async function startStoreUpdate() {
  return runExclusive('core-store-update', async () => {
    let phase = 'check-version';
    let info = null;
    let temp = '';
    let backupPath = '';
    let helperStarted = false;

    try {
      info = await getStoreUpdateInfo();
      if (!info.available) throw new Error('Es ist kein Core-Store-Update verfügbar.');

      fs.mkdirSync(TEMP_ROOT, { recursive: true });
      temp = fs.mkdtempSync(path.join(TEMP_ROOT, 'core-store-update-'));
      const zipPath = path.join(temp, 'update.zip');
      const scriptPath = path.join(temp, 'apply-update.ps1');

      phase = 'backup';
      backupPath = createFullBackup();
      if (!backupPath || !fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
        throw new Error('Das vollständige Backup konnte nicht erstellt werden.');
      }

      phase = 'download';
      await downloadToFile('/api/store/download', zipPath);
      if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
        throw new Error('Der Update-Download ist leer.');
      }

      phase = 'validate-archive';
      const archiveInfo = validateStoreUpdateArchive(zipPath);
      log(`Store-Update-Archiv geprüft: ${archiveInfo.files} Dateien, ${archiveInfo.bytes} Bytes`);

      const executable = process.execPath;
      const pid = process.pid;
      const appRoot = APP_ROOT;
      const statusPath = UPDATE_STATUS_PATH;
      const failurePath = UPDATE_FAILURE_PATH;

      const psScript = String.raw`
param(
  [string]$ZipPath,
  [string]$AppRoot,
  [int]$ProcessId,
  [string]$ExePath,
  [string]$TempRoot,
  [string]$BackupZip,
  [string]$DataRoot,
  [string]$StatusPath,
  [string]$FailurePath,
  [string]$SupportUrl,
  [string]$NewVersion
)

$ErrorActionPreference = 'Stop'
$Phase = 'prepare'
$FailedPhase = ''
$Restored = $false
$RestoreError = ''
$UpdateError = ''
$ErrorCode = 'CSU-999'

function Write-JsonAtomic([string]$Path, $Value) {
  $Directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $Temporary = "$Path.$PID.tmp"
  $Json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($Temporary, $Json, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $Temporary -Destination $Path -Force
}

try {
  $Phase = 'wait-for-app'
  $WaitUntil = (Get-Date).AddSeconds(90)
  while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $WaitUntil) { throw 'Der Core Store wurde nicht rechtzeitig beendet.' }
    Start-Sleep -Milliseconds 400
  }

  $Phase = 'extract'
  $ExtractPath = Join-Path $TempRoot 'extracted'
  New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractPath -Force

  $Phase = 'validate'
  $Items = @(Get-ChildItem -LiteralPath $ExtractPath -Force)
  if ($Items.Count -eq 0) { throw 'Das Update enthält keine Dateien.' }

  $Phase = 'copy'
  New-Item -ItemType Directory -Path $AppRoot -Force | Out-Null

  # Aktualisiert nur die im Paket enthaltenen Anwendungsbereiche.
  # Nicht im ZIP enthaltene Laufzeitordner wie node_modules bleiben erhalten.
  function Sync-PackageDirectory([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $SourceItems = @(Get-ChildItem -LiteralPath $Source -Force)
    $SourceNames = @{}
    foreach ($SourceItem in $SourceItems) { $SourceNames[$SourceItem.Name.ToLowerInvariant()] = $true }

    foreach ($Existing in @(Get-ChildItem -LiteralPath $Destination -Force)) {
      if (-not $SourceNames.ContainsKey($Existing.Name.ToLowerInvariant())) {
        Remove-Item -LiteralPath $Existing.FullName -Recurse -Force
      }
    }

    foreach ($SourceItem in $SourceItems) {
      $Target = Join-Path $Destination $SourceItem.Name
      if ($SourceItem.PSIsContainer) {
        if ((Test-Path -LiteralPath $Target) -and -not (Test-Path -LiteralPath $Target -PathType Container)) {
          Remove-Item -LiteralPath $Target -Force
        }
        Sync-PackageDirectory -Source $SourceItem.FullName -Destination $Target
      } else {
        if (Test-Path -LiteralPath $Target -PathType Container) {
          Remove-Item -LiteralPath $Target -Recurse -Force
        }
        Copy-Item -LiteralPath $SourceItem.FullName -Destination $Target -Force
      }
    }
  }

  foreach ($Item in $Items) {
    $Destination = Join-Path $AppRoot $Item.Name
    if ($Item.PSIsContainer) {
      if ((Test-Path -LiteralPath $Destination) -and -not (Test-Path -LiteralPath $Destination -PathType Container)) {
        Remove-Item -LiteralPath $Destination -Force
      }
      Sync-PackageDirectory -Source $Item.FullName -Destination $Destination
    } else {
      if (Test-Path -LiteralPath $Destination -PathType Container) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
      }
      Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Force
    }
  }

  $Phase = 'verify'
  foreach ($Item in $Items) {
    $Destination = Join-Path $AppRoot $Item.Name
    if (-not (Test-Path -LiteralPath $Destination)) {
      throw "Datei oder Ordner fehlt nach dem Kopieren: $($Item.Name)"
    }
  }

  $Phase = 'complete'
  Write-JsonAtomic -Path $StatusPath -Value @{
    success = $true
    version = $NewVersion
    completedAt = (Get-Date).ToString('o')
    backupPath = $BackupZip
  }
  if (Test-Path -LiteralPath $FailurePath) { Remove-Item -LiteralPath $FailurePath -Force }

  Start-Process -FilePath $ExePath
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}
catch {
  $UpdateError = $_.Exception.Message
  $FailedPhase = $Phase
  switch ($FailedPhase) {
    'download' { $ErrorCode = 'CSU-001' }
    'extract' { $ErrorCode = 'CSU-002' }
    'validate' { $ErrorCode = 'CSU-002' }
    'complete' { $ErrorCode = 'CSU-006' }
    'backup' { $ErrorCode = 'CSU-003' }
    'copy' { $ErrorCode = 'CSU-004' }
    'verify' { $ErrorCode = 'CSU-004' }
    'wait-for-app' { $ErrorCode = 'CSU-006' }
    default { $ErrorCode = 'CSU-004' }
  }

  $Phase = 'restore'
  try {
    if (-not (Test-Path -LiteralPath $BackupZip)) { throw 'Die Backup-Datei fehlt.' }
    $RestoreTemp = Join-Path $TempRoot 'restore'
    New-Item -ItemType Directory -Path $RestoreTemp -Force | Out-Null
    Expand-Archive -LiteralPath $BackupZip -DestinationPath $RestoreTemp -Force
    $DataBackup = Join-Path $RestoreTemp 'Core Network'
    if (-not (Test-Path -LiteralPath $DataBackup)) { throw 'Der Backup-Ordner Core Network fehlt im Archiv.' }

    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    foreach ($BackupItem in @(Get-ChildItem -LiteralPath $DataBackup -Force)) {
      $Destination = Join-Path $DataRoot $BackupItem.Name
      if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
      }
      Copy-Item -LiteralPath $BackupItem.FullName -Destination $DataRoot -Recurse -Force
    }
    $Restored = $true
  }
  catch {
    $RestoreError = $_.Exception.Message
    $ErrorCode = 'CSU-005'
  }

  $Failure = @{
    failed = $true
    errorCode = $ErrorCode
    code = $ErrorCode
    failedPhase = $FailedPhase
    restorePhase = 'restore'
    restored = $Restored
    restoreStatus = $(if ($Restored) { 'restored' } else { 'failed' })
    error = $UpdateError
    restoreError = $RestoreError
    backupPath = $BackupZip
    supportUrl = $SupportUrl
    failedVersion = $NewVersion
    createdAt = (Get-Date).ToString('o')
    acknowledged = $false
  }

  try {
    Write-JsonAtomic -Path $FailurePath -Value $Failure
    Write-JsonAtomic -Path $StatusPath -Value $Failure
  }
  catch {
    $PersistError = $_.Exception.Message
    try {
      Add-Content -LiteralPath (Join-Path $env:TEMP 'core-store-update-emergency.log') -Value "$(Get-Date -Format o) | Fehler: $UpdateError | Fehlerstatus konnte nicht gespeichert werden: $PersistError"
    } catch { }
  }

  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      "Fehlercode: $ErrorCode" + [Environment]::NewLine + "Fehlerphase: $FailedPhase" + [Environment]::NewLine + "Update-Fehler: $UpdateError" + [Environment]::NewLine + "Wiederherstellung: $(if ($Restored) { 'erfolgreich' } else { $RestoreError })" + [Environment]::NewLine + [Environment]::NewLine + "Fehlerdetails wurden gespeichert unter:" + [Environment]::NewLine + $FailurePath,
      'Core Store - Update fehlgeschlagen', 'OK', 'Warning'
    ) | Out-Null
  } catch { }

  Start-Process -FilePath $ExePath -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
`;

      fs.writeFileSync(scriptPath, Buffer.concat([
        Buffer.from([0xEF, 0xBB, 0xBF]),
        Buffer.from(psScript, 'utf8')
      ]));

      phase = 'start-helper';
      await new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive',
          '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
          zipPath, appRoot, String(pid), executable, temp,
          backupPath, DATA_ROOT, statusPath, failurePath,
          info.supportUrl || '', info.remoteVersion || ''
        ], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          helperStarted = true;
          child.unref();
          resolve();
        });
        child.once('error', error => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });

      log(`Store-Update-Hilfsprogramm gestartet. Zielversion: ${info.remoteVersion || 'unbekannt'}`);
      app.quit();
      return { success: true, backupPath, version: info.remoteVersion };
    } catch (error) {
      const code = phase === 'check-version' ? UPDATE_ERROR_CODES.VERSION_CHECK_FAILED
        : phase === 'download' ? UPDATE_ERROR_CODES.DOWNLOAD_FAILED
          : phase === 'backup' ? UPDATE_ERROR_CODES.BACKUP_FAILED
          : phase === 'validate-archive' ? UPDATE_ERROR_CODES.INVALID_ARCHIVE
            : phase === 'start-helper' ? UPDATE_ERROR_CODES.HELPER_START_FAILED
              : UPDATE_ERROR_CODES.UNKNOWN;
      const failure = writeUpdateFailure({
        errorCode: code,
        code,
        failedPhase: phase,
        restoreStatus: 'not-needed',
        restored: false,
        error: error.message || String(error),
        backupPath,
        supportUrl: info?.supportUrl || getCachedSupportUrlSafe(),
        failedVersion: info?.remoteVersion || null,
        unchanged: !helperStarted,
        createdAt: new Date().toISOString(),
        acknowledged: false
      });
      try {
        writeJsonAtomically(UPDATE_STATUS_PATH, failure);
      } catch (statusError) {
        log('Update-Status konnte nicht gespeichert werden', statusError);
      }
      if (temp && !helperStarted) {
        fs.rmSync(temp, { recursive: true, force: true });
      }
      log(`Store-Update konnte nicht gestartet werden (${code})`, error);
      throw new Error(`${code}: ${error.message || String(error)}`);
    }
  });
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
      version: APP_VERSION,
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
    shell.openPath(CORE_ROOT)
  );

  ipcMain.handle('app:open-logs-folder', () =>
    shell.openPath(LOG_ROOT)
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

process.on('uncaughtException', error => log('Nicht abgefangener Hauptprozessfehler', error));
process.on('unhandledRejection', error => log('Nicht abgefangene Promise-Ablehnung', error));

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
