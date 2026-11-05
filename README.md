# Core Store – Electron Edition

## Aufbau

- `backend/`: Flask-Backend auf Render.
- `desktop/`: Electron-Anwendung mit HTML, CSS und JavaScript.
- `Core-Store-Installer.bat`: lädt den Setup-Installer aus dem neuesten GitHub Release.
- `build.bat`: baut lokal den Windows-Setup-Installer.

## Render-Konfiguration

Das bestehende Render-Web-Service verwendet:

- Build: `pip install -r backend/requirements.txt`
- Start: `gunicorn backend.app:app`
- `GITHUB_TOKEN`: Fine-grained Token mit read-only Contents-Zugriff auf die private Daten-Repository
- `FILES_REPO`: `OWNER/PRIVATE-DATA-REPOSITORY`
- `GITHUB_BRANCH`: `main`
- `CONFIG_PATH`: `config/programs.json`
- `SUPPORT_URL`: vollständige öffentliche URL deiner Support-Webseite, z. B. `https://deine-domain.example` (durch deine echte Webseite ersetzen)

`SUPPORT_URL` wird vom Endpunkt `/api/store/version` an den Desktop-Client ausgegeben. Die URL wird nur zum Öffnen der Support-Webseite verwendet. Der GitHub-Token wird niemals an die Electron-App oder das öffentliche Repository ausgegeben. Wenn `SUPPORT_URL` leer ist, kann alternativ `support_url` in `config/store.json` gesetzt werden.

## Lokale Speicherorte

Die lokale Datenstruktur lautet:

```text
%LOCALAPPDATA%\Core Network\
├── Core Store\
│   ├── settings.json
│   ├── installed.json
│   └── Installer\
├── Nexus Agent\
└── Nexus Server\

%LOCALAPPDATA%\Core Network Backup\
└── Core-Store-Backup-<Zeitstempel>.zip
```

Der Core Store legt seine lokalen Einstellungen und Installationsverwaltung in `Core Network\Core Store` ab. Jedes Programm liegt direkt unter `Core Network\<Programmname>`. Alte Programme aus `Core Network\Programs\<programm-id>` werden beim Laden der Programmliste in den neuen Programmordner verschoben. Die alte Installationsverwaltung unter `Core Network\_store\installed.json` wird übernommen.

## Core-Store-Updates und Backup

Vor jedem Core-Store-Selbstupdate wird eine ZIP-Sicherung angelegt. Sie enthält den gesamten lokalen Ordner `Core Network` sowie den vollständigen Electron-Installationsordner (einschließlich der Programmdateien). Das Backup wird unter `%LOCALAPPDATA%\Core Network Backup` gespeichert und nicht automatisch gelöscht.

Der Update-Helfer wartet, bis die Anwendung geschlossen ist, prüft das Update-Archiv und wendet es an. Schlägt das Update beim Entpacken, Ersetzen oder Neustarten fehl, versucht der Helfer automatisch, die ursprünglichen Dateien aus dem Backup wiederherzustellen. Danach erscheint ein eigenständiges Windows-Fehlerfenster mit **Webseite öffnen** und **Abschließen**. **Webseite öffnen** öffnet die auf Render konfigurierte `SUPPORT_URL`. **Abschließen** zeigt eine zweite Meldung, die bestätigt, ob die ursprünglichen Dateien aus dem Backup wiederhergestellt wurden. Dieses Fehlerfenster funktioniert auch dann, wenn das Rollback eine ältere Core-Store-Version zurückspielt.

Fehler, die bereits beim Abrufen, Prüfen oder Sichern des Update-Pakets auftreten, werden in der laufenden Core-Store-Oberfläche angezeigt. In diesem Fall wurden noch keine vorhandenen Programmdateien ersetzt.

Das Backup wird vor dem Update erstellt. Wenn das Backup nicht angelegt oder das Update-ZIP nicht geprüft werden kann, wird das Update abgebrochen und die laufende Anwendung bleibt geöffnet.

## Windows-App bauen und veröffentlichen

Der Workflow unter `.github/workflows/build-release.yml` baut den Windows-Installer automatisch, sobald du ein GitHub Release veröffentlichst. Er hängt `Core-Store-Setup.exe` an das Release an. Warte nach dem Veröffentlichen, bis der Workflow erfolgreich beendet wurde.

Alternativ kannst du lokal `build.bat` ausführen. Dafür wird Node.js LTS benötigt; der Build erzeugt `desktop/dist/Core-Store-Setup.exe`. Endbenutzer benötigen weder Node.js noch Python.

## Private Daten-Repository

Behalte `config/programs.json`, `config/store.json` und `programs/` bei. Der Inhalt von `core-store/` wird als Update-ZIP durch `/api/store/download` ausgeliefert. `config/store.json` muss dieselbe Version enthalten wie `core-store/package.json`.

## Programmaktionen

Das Programmmanifest verwendet weiterhin:

- `files.installation`
- `files.start`
- `files.update`
- `files.uninstallation`
- `execution.*`
- `update_preserve`

UI-Regeln:

- Nicht installiert: nur **Installieren**.
- Installiert, kein Update: **Starten** und **Deinstallieren**.
- Installiert, Update verfügbar: **Starten**, **Update** und **Deinstallieren**.

## Sicherheitshinweise

- Die öffentliche API gibt Programmpakete an alle Benutzer aus. Der private GitHub-Token bleibt auf Render.
- Programme können ausführbare Dateien und Installationsskripte enthalten. Nur vertrauenswürdige Pakete veröffentlichen.
- Vor einem öffentlichen Produktivbetrieb sind Signaturprüfung der ZIP-Dateien und API-Rate-Limits empfehlenswert.


## Core-Store-Update 1.2.0 – Backup und Fehlercodes

Vor dem Austausch der Core-Store-Dateien erstellt die Desktop-App eine ZIP-Sicherung unter `%LOCALAPPDATA%\Core Network Backup`. Das Archiv enthält den lokalen Ordner `Core Network` sowie den vollständigen Electron-Installationsordner. Die Sicherung wird nicht automatisch gelöscht.

Bei einem Updatefehler speichert die App einen Fehlercode (`CSU-001` bis `CSU-009`, `CSU-999`) und zeigt die Meldung nach dem Neustart an. Die Schaltfläche **Webseite öffnen** verwendet `support_url` aus `config/store.json` (oder die Render-Umgebungsvariable `SUPPORT_URL`). **Abschließen** zeigt den tatsächlichen Wiederherstellungsstatus an. Die Fehlercode-Erklärungen liegen in `desktop/renderer/update-error-codes.html`.

Für die private Daten-Repository muss `config/store.json` mindestens diese Felder enthalten:

```json
{
  "enabled": true,
  "version": "1.2.0",
  "folder": "core-store",
  "support_url": "https://DEINE-SUPPORT-WEBSITE.example"
}
```

Der Ordner `core-store/` im privaten Repository muss die Update-Dateien enthalten (`main.js`, `preload.js`, `package.json`, `settings.json` und den Ordner `renderer/`). Die Versionsnummer in `config/store.json` muss höher als die installierte App-Version sein, damit das Update angeboten wird.
