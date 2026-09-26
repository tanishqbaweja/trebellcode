@echo off
setlocal
cd /d "%~dp0"
if /I "%~1"=="publish" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-windows-release.ps1" -Publish
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-windows-release.ps1"
)
if errorlevel 1 (
  echo.
  echo Trebell Code release build failed.
  exit /b %errorlevel%
)
echo.
echo Done.
