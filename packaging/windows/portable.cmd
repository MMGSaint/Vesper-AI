@echo off
setlocal
set "VESPER_ENV=production"
set "VESPER_PORTABLE=1"
set "VESPER_DATA_DIR=%~dp0data"
if "%NODE_PATH%"=="" set "NODE_PATH=node"
node --experimental-strip-types "%~dp0src\vesper\host\main.ts" %*
endlocal
