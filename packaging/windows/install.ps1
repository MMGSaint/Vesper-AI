param(
  [switch]$RegisterStartup
)

$ErrorActionPreference = "Stop"
$root = Join-Path $env:LOCALAPPDATA "Vesper"
$dirs = @("config", "data", "logs", "models", "bin")
foreach ($name in $dirs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $root $name) | Out-Null
}

# Must match paths.ts `configFile()`. A mismatch here means the runtime silently
# ignores everything the installer wrote.
$configPath = Join-Path $root "config\vesper.json"
if (-not (Test-Path $configPath)) {
  @'
{
  "identity": { "name": "Vesper", "userName": "User" },
  "hardware": { "mode": "auto" },
  "optimizer": { "mode": "mock" },
  "voice": { "enabled": false },
  "windows": { "enableTray": true, "startOnLogin": false }
}
'@ | Set-Content -Path $configPath -Encoding UTF8
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $repo "src\vesper\host\main.ts"))) {
  $repo = (Get-Location).Path
}

$launcher = Join-Path $root "bin\vesper-host.cmd"
@"
@echo off
set VESPER_ENV=production
cd /d "$repo"
node --experimental-strip-types src\vesper\host\main.ts %*
"@ | Set-Content -Path $launcher -Encoding ASCII

if ($RegisterStartup) {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  New-ItemProperty -Path $runKey -Name "Vesper" -Value "`"$launcher`"" -PropertyType String -Force | Out-Null
}

Write-Host "Vesper installed to $root"
Write-Host "Launcher: $launcher"
if ($RegisterStartup) {
  Write-Host "Start on login: registered (HKCU Run)."
} else {
  Write-Host "Start on login: not registered. Re-run with -RegisterStartup to enable."
}
Write-Host "First launch will probe local backends. No optimizer action is taken automatically."
