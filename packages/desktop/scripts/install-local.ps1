# Installs the setup exe this checkout just built over the Helm on this machine.
#
# Why this is a script and not a line in a skill: the installed Helm is usually
# hosting the Claude Code session that asked for the reinstall, and the NSIS
# installer cannot replace a running app - so the sequence has to run from a
# process that survives Helm closing. Start it detached:
#
#   Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass',
#     '-File', 'packages\desktop\scripts\install-local.ps1' -WindowStyle Hidden
#
# What it does, in order, and writes to the log as it goes:
#   1. waits GraceSeconds so the sentence announcing this can land, then asks
#      Helm to close (WM_CLOSE, so before-quit runs and the store is released),
#      force-killing only if it has not gone after ForceAfterSeconds;
#   2. runs `Helm-<version>-setup.exe /S` - one-click, per-user, no elevation;
#   3. checks that resources\app.asar in the install directory is newer than the
#      installer, which is the only proof an install happened (`/S` exits 0 on
#      a refused install too);
#   4. starts the installed Helm again.
#
# It deliberately does not remove %APPDATA%\Helm - see electron-builder.yml,
# deleteAppDataOnUninstall - and does not touch anything but the install
# directory the installer owns.
param(
  [int]$GraceSeconds = 30,
  [int]$ForceAfterSeconds = 30,
  [string]$Log = (Join-Path $env:TEMP 'helm-install-local.log'),
  # Set by the relaunch below. Without it this process is a child of the
  # terminal that typed `pnpm install:local` - and when that terminal is a Helm
  # tab, closing Helm would kill the installer halfway through step 1.
  [switch]$Detached
)

if (-not $Detached) {
  $self = $MyInvocation.MyCommand.Path
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self,
    '-Detached', '-GraceSeconds', $GraceSeconds, '-ForceAfterSeconds', $ForceAfterSeconds, '-Log', $Log
  )
  Write-Host "install-local: running detached. Helm closes in $GraceSeconds s and comes back installed."
  Write-Host "install-local: log at $Log"
  exit 0
}

$ErrorActionPreference = 'Continue'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$desktop = Join-Path $repo 'packages\desktop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Helm'
$installedExe = Join-Path $installDir 'Helm.exe'
$asar = Join-Path $installDir 'resources\app.asar'

function Say($msg) { "$(Get-Date -Format 'HH:mm:ss')  $msg" | Tee-Object -FilePath $Log -Append | Out-Null }
"" | Out-File $Log
Say "install-local: repo $repo"

$version = (Get-Content (Join-Path $desktop 'package.json') | ConvertFrom-Json).version
$setup = Join-Path $desktop "dist-app\Helm-$version-setup.exe"
if (-not (Test-Path $setup)) { Say "FAIL  no installer at $setup - run pnpm dist:win first"; exit 2 }
Say "installer  : $setup ($([math]::Round((Get-Item $setup).Length/1MB)) MB, built $((Get-Item $setup).LastWriteTime))"
if (Test-Path $asar) { Say "installed  : app.asar from $((Get-Item $asar).LastWriteTime)" } else { Say "installed  : nothing at $installDir" }

# Only processes running out of the install directory - a pnpm dev or a
# portable Helm elsewhere on the machine is not the one being replaced.
function InstalledProcs {
  @(Get-CimInstance Win32_Process -Filter "Name = 'Helm.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir, 'OrdinalIgnoreCase') })
}

$running = InstalledProcs
if ($running.Count -gt 0) {
  Say "Helm is running ($($running.Count) process(es)); closing it in $GraceSeconds s. This ends the sessions it hosts."
  Start-Sleep -Seconds $GraceSeconds
  # WM_CLOSE to the main window: Electron's close handler and before-quit run,
  # sessions are ended and the database is released the ordinary way.
  foreach ($p in (Get-Process Helm -ErrorAction SilentlyContinue)) { try { $null = $p.CloseMainWindow() } catch {} }
  $deadline = (Get-Date).AddSeconds($ForceAfterSeconds)
  while ((InstalledProcs).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if ((InstalledProcs).Count -gt 0) {
    Say "still running after $ForceAfterSeconds s; force-stopping"
    InstalledProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
  Say "Helm closed"
}

$before = if (Test-Path $asar) { (Get-Item $asar).LastWriteTime } else { [datetime]::MinValue }
Say "running installer silently..."
$proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
Say "installer exited $($proc.ExitCode)"

if (-not (Test-Path $asar)) { Say "FAIL  no app.asar in $installDir after install"; exit 3 }
$after = (Get-Item $asar).LastWriteTime
if ($after -le $before) {
  Say "FAIL  app.asar unchanged ($after) - the installer exited without replacing the app. Is Helm still running? Did the EDR block the unsigned exe?"
  exit 4
}
Say "installed  : app.asar now $after"

Say "starting $installedExe"
Start-Process -FilePath $installedExe -WorkingDirectory $installDir | Out-Null
Say "done"
exit 0
