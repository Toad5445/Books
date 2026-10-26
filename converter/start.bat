@echo off
cd /d "%~dp0"
title Books converter
if not exist .venv\Scripts\python.exe (
  echo  Run setup.bat first.
  pause
  exit /b 1
)
.venv\Scripts\python.exe server.py
pause
