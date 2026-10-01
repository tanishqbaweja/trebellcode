@echo off
cd /d "%~dp0"
title Trebell Benchmark Watchdog
node scripts\terminal-bench-watchdog.mjs --watch
echo.
echo Watchdog exited. Press any key to close.
pause >nul
