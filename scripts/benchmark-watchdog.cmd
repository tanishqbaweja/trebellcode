@echo off
setlocal
cd /d "%~dp0.."
title Trebell Benchmark Watchdog
set "TREBELL_WATCHDOG_INTERVAL_MS=5000"
echo Starting payload-free benchmark monitor...
echo.
node scripts\terminal-bench-watchdog.mjs --watch
echo.
echo Watchdog exited. Press any key to close.
pause >nul
endlocal
