CORE NETWORK – EINHEITLICHER SPEICHERORT

Alle Core-Network-Dateien werden unter folgendem Verzeichnis abgelegt:

%APPDATA%\Core Network

Ordner:
- Core Store\       Core-Store-Anwendung und Einstellungen
- <Programmname>\   Installierte Programme
- Backups\          Sicherungen vor Updates
- Temp\             Temporäre Downloads und Update-Dateien

Die Desktop-Anwendung wird durch den NSIS-Installer in
%APPDATA%\Core Network\Core Store installiert.

Bestehende Einstellungen und Installationsstatus aus dem früheren
%LOCALAPPDATA%\Core Network\Core Store werden beim ersten Start kopiert.
Ältere Programmordner direkt unter %LOCALAPPDATA%\Core Network werden
bei der Programmerkennung in den neuen Hauptordner verschoben.

Hinweis:
Das Erstellen der Installer-Datei muss über den vorhandenen GitHub-Actions-
Workflow erfolgen. Ein echter Windows-Installationstest ist separat nötig.
