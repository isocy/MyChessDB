@echo off
REM Double-click this file to start My Chess DB with a visible console (shows logs/errors).
cd /d "%~dp0"
start "" ".venv\Scripts\python.exe" app.py
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765"
