@echo off
setlocal
set "VESPER_ENV=production"
set "VESPER_PORTABLE=1"
set "VESPER_DATA_DIR=%~dp0data"
where node >nul 2>&1
if errorlevel 1 (
  echo node.exe was not found on PATH. Install Node.js 20.11+ or use portable.ps1 -NodePath.
  exit /b 1
)
node --experimental-strip-types "%~dp0src\vesper\host\main.ts" %*
endlocal
