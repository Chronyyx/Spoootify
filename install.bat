@echo off
setlocal
title Spoootify - install
cd /d "%~dp0"

set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE set "NODE=%%i"
)
if defined NODE goto havenode
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto havenode

echo.
echo Spoootify needs Node.js (free, from nodejs.org).
where winget >nul 2>nul
if errorlevel 1 goto nonode
choice /C YN /M "Install Node.js LTS now"
if errorlevel 2 goto nonode
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE goto nonode

:havenode
"%NODE%" -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)"
if errorlevel 1 goto oldnode
"%NODE%" "%~dp0tools\setup.mjs" install
pause
exit /b 0

:oldnode
echo Node.js 18 or newer is required - update it from https://nodejs.org
pause
exit /b 1

:nonode
echo.
echo Install Node.js from https://nodejs.org and then run install.bat again.
pause
exit /b 1
