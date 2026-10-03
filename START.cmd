@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
    echo Installation failed. Read the error above and artifacts\setup.log.
    pause
    exit /b 1
)
echo Done. Open VS Code to activate the repair.
pause
