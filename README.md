# Core Store – Electron Edition

## Aufbau

- `backend/`: bestehendes Flask-Backend. Bleibt auf Render.
- `desktop/`: Electron-Anwendung mit HTML, CSS und JavaScript.
- `Core-Store-Installer.bat`: lädt den Setup-Installer aus dem neuesten GitHub Release herunter.
- `build.bat`: baut lokal den Windows-Setup-Installer.

## Render

Das bestehende Render-Web-Service bleibt unverändert:

- Build: `pip install -r backend/requirements.txt`
- Start: `gunicorn backend.app:app`
- `GITHUB_TOKEN`: Fine-grained Token mit read-only Contents-Zugriff auf die private Daten-Repository
- `FILES_REPO`: `OWNER/PRIVATE-DATA-REPOSITORY`
- `GITHUB_BRANCH`: `main`
- `CONFIG_PATH`: `config/programs.json`

Der Token wird niemals in die Electron-App oder in das öffentliche Repository kopiert.

## Windows-App bauen und veröffentlichen

Ein GitHub-Workflow unter `.github/workflows/build-release.yml` baut den Windows-Installer automatisch, sobald du ein GitHub Release veröffentlichst. Er hängt die Datei `Core-Store-Setup.exe` an das Release an. Warte nach dem Veröffentlichen, bis der Workflow erfolgreich beendet wurde.

Alternativ kannst du lokal `build.bat` ausführen. Dafür wird Node.js LTS benötigt; der Build erzeugt `desktop/dist/Core-Store-Setup.exe`. Lade diese Datei als Release-Asset mit exakt diesem Namen hoch.

Endbenutzer brauchen nur `Core-Store-Installer.bat`, geben den Link zur öffentlichen Haupt-Repository ein und erhalten den Installer aus dem neuesten GitHub Release. Endbenutzer benötigen weder Node.js noch Python.

## Private Daten-Repository

Behalte `config/programs.json`, `config/store.json` und `programs/` bei.

Ersetze den Inhalt des bisherigen Ordners `core-store/` durch die Dateien aus `desktop/`:

```text
core-store/
├── package.json
├── main.js
├── preload.js
├── settings.json
└── renderer/
    ├── index.html
    ├── style.css
    └── app.js
```

Der Backend-Endpunkt `/api/store/download` erstellt daraus das Update-ZIP. `config/store.json` muss dieselbe Version enthalten wie `core-store/package.json`.

## Programmaktionen

Das bisherige Manifestformat bleibt erhalten:

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

Die lokale Programmliste bleibt unter `%LOCALAPPDATA%\Core Network\_store\installed.json`, die Programme unter `%LOCALAPPDATA%\Core Network\Programs`.

## Hinweise

- Die öffentliche API gibt Programmpakete an alle Benutzer aus. Der private GitHub-Token bleibt auf Render.
- Programme können ausführbare Dateien und Installationsskripte enthalten. Nur vertrauenswürdige Pakete veröffentlichen.
- Vor einem öffentlichen Produktivbetrieb sind Signaturprüfung der ZIP-Dateien und API-Rate-Limits empfehlenswert.
