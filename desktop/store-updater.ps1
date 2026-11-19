param(
 [string]$ZipPath,[string]$AppRoot,[int]$ProcessId,[string]$ExePath,
 [string]$TempRoot,[string]$BackupZip,[string]$DataRoot,[string]$StatusPath,
 [string]$FailurePath,[string]$SupportUrl,[string]$NewVersion
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text='Core Store - Update'
$form.Width=480;$form.Height=190;$form.StartPosition='CenterScreen';$form.TopMost=$true
$form.FormBorderStyle='FixedDialog';$form.MaximizeBox=$false;$form.MinimizeBox=$false
$label=New-Object System.Windows.Forms.Label;$label.Left=20;$label.Top=20;$label.Width=420;$label.Height=35;$label.Text='Update wird vorbereitet...';$form.Controls.Add($label)
$bar=New-Object System.Windows.Forms.ProgressBar;$bar.Left=20;$bar.Top=65;$bar.Width=420;$bar.Height=25;$bar.Minimum=0;$bar.Maximum=100;$form.Controls.Add($bar)
$percent=New-Object System.Windows.Forms.Label;$percent.Left=20;$percent.Top=100;$percent.Width=420;$percent.Height=25;$percent.Text='0 %';$form.Controls.Add($percent)
$form.Show();$form.Refresh()
function Set-Progress([int]$Value,[string]$Text){$bar.Value=[Math]::Max(0,[Math]::Min(100,$Value));$label.Text=$Text;$percent.Text="$Value %";$form.Refresh();[System.Windows.Forms.Application]::DoEvents()}
function Write-Json([string]$Path,$Data){$dir=Split-Path -Parent $Path;New-Item -ItemType Directory -Path $dir -Force|Out-Null;$tmp="$Path.tmp";$Data|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $tmp -Encoding UTF8;Move-Item $tmp $Path -Force}
$phase='wait-for-store';$backupCreated=$false
try {
 Set-Progress 5 'Warte, bis Core Store vollständig geschlossen ist...'
 $deadline=(Get-Date).AddSeconds(90)
 while(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue){if((Get-Date)-gt $deadline){throw 'Store-Prozess wurde nicht beendet.'};Start-Sleep -Milliseconds 300}
 $phase='backup';Set-Progress 15 'Backup wird erstellt...'
 New-Item -ItemType Directory -Path (Split-Path -Parent $BackupZip) -Force|Out-Null
 $backupTemp=Join-Path $TempRoot 'backup-source';New-Item -ItemType Directory -Path $backupTemp -Force|Out-Null
 $backupCore=Join-Path $backupTemp 'Core Network';New-Item -ItemType Directory -Path $backupCore -Force|Out-Null
 foreach($entry in Get-ChildItem -LiteralPath $DataRoot -Force){if($entry.Name -in @('Backups','Temp')){continue};Copy-Item -LiteralPath $entry.FullName -Destination $backupCore -Recurse -Force}
 Compress-Archive -Path (Join-Path $backupTemp '*') -DestinationPath $BackupZip -Force
 if(!(Test-Path $BackupZip) -or (Get-Item $BackupZip).Length -eq 0){throw 'Backup-ZIP konnte nicht erstellt werden.'};$backupCreated=$true
 $phase='extract';Set-Progress 35 'Updatepaket wird entpackt...'
 $extract=Join-Path $TempRoot 'extracted';New-Item -ItemType Directory -Path $extract -Force|Out-Null;Expand-Archive -LiteralPath $ZipPath -DestinationPath $extract -Force
 $items=@(Get-ChildItem $extract -Force);if(!$items.Count){throw 'Updatepaket ist leer.'}
 $phase='copy';Set-Progress 50 'Neue Store-Dateien werden installiert...'
 foreach($item in $items){$dest=Join-Path $AppRoot $item.Name;if($item.PSIsContainer){if(Test-Path $dest){Remove-Item $dest -Recurse -Force};Copy-Item $item.FullName $dest -Recurse -Force}else{if(Test-Path $dest -PathType Container){Remove-Item $dest -Recurse -Force};Copy-Item $item.FullName $dest -Force}}
 $phase='verify';Set-Progress 85 'Installation wird überprüft...'
 foreach($item in $items){if(!(Test-Path (Join-Path $AppRoot $item.Name))){throw "Datei fehlt nach Installation: $($item.Name)"}}
 Set-Progress 95 'Update erfolgreich. Store wird gestartet...'
 Write-Json $StatusPath @{success=$true;version=$NewVersion;completedAt=(Get-Date).ToString('o');backupPath=$BackupZip}
 if(Test-Path $FailurePath){Remove-Item $FailurePath -Force}
 Start-Process -FilePath $ExePath
 Set-Progress 100 'Fertig!'
 Start-Sleep -Seconds 1
 $form.Close();Remove-Item $TempRoot -Recurse -Force -ErrorAction SilentlyContinue;exit 0
} catch {
 $msg=$_.Exception.Message
 $code=if($phase -eq 'wait-for-store'){'CSU-006'}elseif($phase -eq 'backup' -or !$backupCreated){'CSU-003'}elseif($phase -eq 'extract'){'CSU-002'}else{'CSU-004'}
 $restored=$false;$restoreError=''
 if($backupCreated -and (Test-Path $BackupZip)){
  try{Set-Progress 90 'Fehler. Vorherige Version wird wiederhergestellt...';$rt=Join-Path $TempRoot 'restore';New-Item -ItemType Directory $rt -Force|Out-Null;Expand-Archive $BackupZip $rt -Force;$core=Join-Path $rt 'Core Network';foreach($bk in Get-ChildItem $core -Force){$dst=Join-Path $DataRoot $bk.Name;if(Test-Path $dst){Remove-Item $dst -Recurse -Force};Copy-Item $bk.FullName $DataRoot -Recurse -Force};$restored=$true}catch{$restoreError=$_.Exception.Message}
 }
 $failure=@{failed=$true;errorCode=$code;code=$code;failedPhase=$phase;restored=$restored;restoreStatus=if($restored){'restored'}else{'failed'};error=$msg;restoreError=$restoreError;backupPath=$BackupZip;supportUrl=$SupportUrl;failedVersion=$NewVersion;createdAt=(Get-Date).ToString('o');acknowledged=$false}
 try{Write-Json $FailurePath $failure;Write-Json $StatusPath $failure}catch{}
 [System.Windows.Forms.MessageBox]::Show("Fehlercode: $code`r`n$msg`r`nWiederherstellung: $restored`r`n$restoreError",'Core Store Update fehlgeschlagen','OK','Warning')|Out-Null
 Start-Process -FilePath $ExePath -ErrorAction SilentlyContinue
 $form.Close();exit 1
}
