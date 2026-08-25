param(
  [switch]$PurgeData
)

$ErrorActionPreference = "Stop"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
Remove-ItemProperty -Path $runKey -Name "Vesper" -ErrorAction SilentlyContinue

$root = Join-Path $env:LOCALAPPDATA "Vesper"
$launcher = Join-Path $root "bin\vesper-host.cmd"
if (Test-Path $launcher) {
  Remove-Item $launcher -Force
}

if ($PurgeData -and (Test-Path $root)) {
  Remove-Item $root -Recurse -Force
  Write-Host "Removed $root"
} else {
  Write-Host "Startup entry removed. Data kept at $root. Pass -PurgeData to delete it."
}
