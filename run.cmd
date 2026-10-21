@echo off
rem QUTC Launcher development launcher.
rem Electron runtime is copied to LocalAppData first, because running an
rem executable directly inside the restricted workspace can crash Chromium.
setlocal
set "ELECTRON_RUN_AS_NODE="
set "RUNTIME=%LOCALAPPDATA%\QUTC-Launcher\runtime"

if not exist "%~dp0vendor\electron\electron.exe" (
  echo Preparing Electron runtime...
  node "%~dp0scripts\setup.js" --runtime-only
  if errorlevel 1 (
    echo Setup failed. Install Node.js 18+ and run: node scripts\setup.js
    pause
    exit /b 1
  )
)

if not exist "%RUNTIME%\electron.exe" goto copy_runtime
fc /b "%~dp0vendor\electron\version" "%RUNTIME%\version" >nul 2>nul
if errorlevel 1 goto copy_runtime
goto launch

:copy_runtime
echo Preparing QUTC runtime, please wait...
if exist "%RUNTIME%" rmdir /s /q "%RUNTIME%"
xcopy "%~dp0vendor\electron" "%RUNTIME%" /E /I /Y >nul
if not exist "%RUNTIME%\electron.exe" (
  echo Failed to prepare runtime. Check disk space or permissions.
  pause
  exit /b 1
)

:launch
start "" "%RUNTIME%\electron.exe" "%~dp0."
