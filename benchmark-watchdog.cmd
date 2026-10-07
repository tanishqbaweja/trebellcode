@echo off
setlocal
cd /d "%~dp0"
set "TREBELL_WATCHDOG_INTERVAL_MS=5000"
start "Trebell Benchmark Watchdog" /D "%~dp0" cmd /k "node scripts\terminal-bench-watchdog.mjs --watch"
endlocal
