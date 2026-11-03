@echo off
title Core Store

cd /d "%~dp0"

echo ==========================================
echo              CORE STORE
echo ==========================================
echo.

where py >nul 2>nul

if errorlevel 1 (
    echo Python wurde nicht gefunden.
    echo Bitte installiere Python 3.
    pause
    exit /b 1
)

echo Pruefe Abhaengigkeiten...

py -3 -m pip install -r requirements.txt

if errorlevel 1 (
    echo.
    echo Installation der Abhaengigkeiten fehlgeschlagen.
    pause
    exit /b 1
)

echo.
echo Starte Core Store...

py -3 main.py

if errorlevel 1 (
    echo.
    echo Core Store wurde mit einem Fehler beendet.
    pause
)
