@echo off
title Core Network Store
color 0B

cd /d "%~dp0"

echo ==========================================
echo        CORE NETWORK STORE
echo ==========================================
echo.

where py >nul 2>&1

if errorlevel 1 (
    echo Python wurde nicht gefunden.
    echo Bitte Python installieren.
    pause
    exit /b 1
)

py -3 --version

if errorlevel 1 (
    echo Python konnte nicht gestartet werden.
    pause
    exit /b 1
)

py -3 -m pip install -r requirements.txt

if errorlevel 1 (
    echo Abhaengigkeiten konnten nicht installiert werden.
    pause
    exit /b 1
)

py -3 main.py

if errorlevel 1 (
    echo.
    echo Core Store konnte nicht gestartet werden.
    pause
)
