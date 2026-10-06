param(
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$portableRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $portableRoot "data"

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    throw "node.exe was not found on PATH. Install Node.js 20.11+ or pass -NodePath."
  }
  $NodePath = $node.Source
}

$entryPoint = Join-Path $portableRoot "src\vesper\host\main.ts"
if (-not (Test-Path $entryPoint)) {
  throw "Vesper source entrypoint was not found: $entryPoint"
}

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null

# Portable mode is deliberately FOREIGN. It disables host-machine control and
# persistence at the actual tool chokepoint and runtime lifecycle, not just here.
$env:VESPER_ENV = "production"
$env:VESPER_PORTABLE = "1"
$env:VESPER_DATA_DIR = $dataRoot

Write-Host "Vesper portable mode"
Write-Host "  Root:          $portableRoot"
Write-Host "  Data:          $dataRoot"
Write-Host "  Host posture:  foreign"
Write-Host "  Startup:       disabled"
Write-Host "  Companion IPC: disabled"
Write-Host "  Host controls: refused"
Write-Host ""

& $NodePath --experimental-strip-types $entryPoint @args
exit $LASTEXITCODE
