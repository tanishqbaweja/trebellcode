@echo off
setlocal
cd /d "%~dp0.."
title Trebell Benchmark Watchdog
set "TREBELL_WATCHDOG_INTERVAL_MS=5000"
set "TARGET="
set "WATCH_ROOT=%CD%"
rem Benchmark launches write ignored pointers: the active run ID and, for runs started from a clean benchmark
rem worktree, that checkout's path. Without them, follow the latest run in this checkout.
if exist ".harbor-validation\watchdog-target.txt" set /p TARGET=<".harbor-validation\watchdog-target.txt"
if exist ".harbor-validation\watchdog-root.txt" set /p WATCH_ROOT=<".harbor-validation\watchdog-root.txt"
echo Starting payload-free benchmark monitor...
echo.
if defined TARGET (
  echo Watching %TARGET%
  echo Checkout: %WATCH_ROOT%
  echo.
  node "%WATCH_ROOT%\scripts\terminal-bench-watchdog.mjs" --watch --pair=%TARGET%
) else (
  node "%WATCH_ROOT%\scripts\terminal-bench-watchdog.mjs" --watch
)
echo.
echo Watchdog exited. Press any key to close.
pause >nul
endlocal
