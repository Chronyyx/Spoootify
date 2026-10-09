@echo off
setlocal
title Spoootify - uninstall
set "HERE=%~dp0"
rem leave the folder so it can be deleted
cd /d "%TEMP%"

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)
if defined NODE goto havenode
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto havenode
echo Node.js not found - can't run the uninstaller.
pause
exit /b 1

:havenode
"%NODE%" "%HERE%tools\setup.mjs" uninstall
pause
exit /b 0
