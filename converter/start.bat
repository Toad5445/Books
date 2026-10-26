@echo off
cd /d "%~dp0"
title Books converter
if not exist .venv\Scripts\python.exe (
  echo  Run setup.bat first.
  pause
  exit /b 1
)
echo  Checking for updates...
.venv\Scripts\python.exe update.py
.venv\Scripts\python.exe server.py
pause
