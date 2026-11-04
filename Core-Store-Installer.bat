@echo off
setlocal
title Core Store Installer

echo ==========================================
echo          CORE STORE INSTALLER
echo ==========================================
echo.
echo Gib den Link zu deiner OEFFENTLICHEN GitHub-Haupt-Repository ein.
echo Beispiel: https://github.com/OWNER/Core-Store-Code
echo.
set /p CORE_REPO=GitHub-Link: 
if "%CORE_REPO%"=="" (
    echo Kein Repository-Link eingegeben.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$u=$env:CORE_REPO; $m=[regex]::Match($u,'^https?://(www\.)?github\.com/([^/]+)/([^/]+)'); if(-not $m.Success){throw 'Ungueltiger GitHub-Link.'}; $owner=$m.Groups[2].Value; $repo=$m.Groups[3].Value -replace '\.git$',''; $api='https://api.github.com/repos/'+$owner+'/'+$repo+'/releases/latest'; $r=Invoke-RestMethod -Uri $api -Headers @{'User-Agent'='Core-Store-Installer';'Accept'='application/vnd.github+json'}; $a=$r.assets | Where-Object {$_.name -eq 'Core-Store-Setup.exe'} | Select-Object -First 1; if(-not $a){throw 'Im neuesten Release fehlt Core-Store-Setup.exe. Erst GitHub-Release erstellen und Build abwarten.'}; $t=Join-Path $env:TEMP ('CoreStore-'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $t -Force | Out-Null; try {$f=Join-Path $t 'Core-Store-Setup.exe'; Write-Host ('Lade Version '+$r.tag_name+' herunter...'); Invoke-WebRequest -Uri $a.browser_download_url -OutFile $f -UseBasicParsing; if((Get-Item $f).Length -lt 1000000){throw 'Setup-Datei ist unvollstaendig.'}; $p=Start-Process -FilePath $f -Wait -PassThru; if($p.ExitCode -ne 0){throw ('Setup-Fehler: '+$p.ExitCode)}; Write-Host 'Core Store wurde installiert.' -ForegroundColor Green} finally {Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue}"

if errorlevel 1 (
    echo.
    echo Installation fehlgeschlagen.
    pause
    exit /b 1
)
exit /b 0
