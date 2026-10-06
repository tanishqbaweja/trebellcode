@echo off
setlocal
cd /d "%~dp0"
start "Trebell Benchmark Health" /D "%~dp0" cmd /k "npm run bench:terminal:health"
endlocal
