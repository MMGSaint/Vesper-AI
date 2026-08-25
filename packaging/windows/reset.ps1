param()

$ErrorActionPreference = "Stop"
$root = Join-Path $env:LOCALAPPDATA "Vesper"
$data = Join-Path $root "data"
$state = Join-Path $data "state.json"
$health = Join-Path $data "health.json"

if (Test-Path $state) {
  Copy-Item $state "$state.corrupt" -Force
  Remove-Item $state -Force
}

if (Test-Path $health) {
  Remove-Item $health -Force
}

$profile = Join-Path $data "state.json"
Write-Host "Vesper local state reset. First-boot will run again on next launch."
Write-Host "Memory file backup: $state.corrupt (if it existed)."
Write-Host "Mortis and the PC optimizer were not touched."
