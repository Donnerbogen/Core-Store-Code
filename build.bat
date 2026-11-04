@echo off
setlocal
 title CORE STORE - BUILD
cd /d "%~dp0desktop"

echo ==========================================
echo          CORE STORE - BUILD
 echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js wurde nicht gefunden.
    echo Installiere Node.js LTS ueber winget...
    where winget >nul 2>nul
    if errorlevel 1 (
        echo winget ist nicht verfuegbar. Bitte Node.js LTS von https://nodejs.org installieren.
        pause
        exit /b 1
    )
    winget install --id OpenJS.NodeJS.LTS --exact --scope user --accept-package-agreements --accept-source-agreements
    echo.
    echo Node.js wurde installiert. Bitte dieses Fenster schliessen,
    echo ein neues Terminal oeffnen und build.bat erneut ausfuehren.
    pause
    exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
    echo npm wurde nicht gefunden. Bitte Node.js LTS reparieren oder neu installieren.
    pause
    exit /b 1
)

echo [1/2] Installiere Build-Abhaengigkeiten...
npm install
if errorlevel 1 (
    echo npm install ist fehlgeschlagen.
    pause
    exit /b 1
)

echo.
echo [2/2] Erstelle Windows-Installer...
npm run dist
if errorlevel 1 (
    echo Der Build ist fehlgeschlagen.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo BUILD ERFOLGREICH
echo Datei: desktop\dist\Core-Store-Setup.exe
echo ==========================================
pause
