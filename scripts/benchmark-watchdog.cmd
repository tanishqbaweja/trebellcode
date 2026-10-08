@echo off
setlocal
cd /d "%~dp0.."
title Trebell Benchmark Watchdog
set "TREBELL_WATCHDOG_INTERVAL_MS=5000"
set "TARGET="
rem The active run is written to an ignored pointer file when a benchmark is launched; without it, follow the latest run.
if exist ".harbor-validation\watchdog-target.txt" set /p TARGET=<".harbor-validation\watchdog-target.txt"
echo Starting payload-free benchmark monitor...
echo.
if defined TARGET (
  echo Watching %TARGET%
  echo.
  node scripts\terminal-bench-watchdog.mjs --watch --pair=%TARGET%
) else (
  node scripts\terminal-bench-watchdog.mjs --watch
)
echo.
echo Watchdog exited. Press any key to close.
pause >nul
endlocal
