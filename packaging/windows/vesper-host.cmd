@echo off
set VESPER_ENV=production
node --experimental-strip-types "%~dp0..\..\src\vesper\host\main.ts" %*
