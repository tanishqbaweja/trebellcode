@echo off
setlocal
cd /d "%~dp0"
rem Opens the watchdog in its own window; it follows the active run recorded in .harbor-validation.
start "Trebell Benchmark Watchdog" /D "%~dp0" cmd /c "scripts\benchmark-watchdog.cmd"
endlocal
