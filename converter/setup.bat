@echo off
setlocal
cd /d "%~dp0"
title Books converter setup

echo.
echo  === Books converter setup ===
echo  This installs everything the converter needs. It downloads about 3 GB
echo  and can take 10-20 minutes. You only need to do this once.
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo  Python was not found. Install Python 3.12 from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH" during install, then run this again.
  pause
  exit /b 1
)

py -3.12 -c "import sys" >nul 2>nul
if errorlevel 1 (
  echo  Python 3.12 is required ^(Kokoro does not support newer versions yet^).
  echo  Install Python 3.12 from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)

if not exist .venv (
  echo  Creating a private Python environment...
  py -3.12 -m venv .venv || goto :fail
)

set PY=.venv\Scripts\python.exe
%PY% -m pip install --upgrade pip || goto :fail

echo.
echo  Installing PyTorch with NVIDIA GPU support...
%PY% -m pip install torch==2.7.1 --index-url https://download.pytorch.org/whl/cu128 || goto :fail

echo.
echo  Installing Kokoro and the book readers...
%PY% -m pip install -r requirements.txt || goto :fail
%PY% -m spacy download en_core_web_sm || goto :fail

echo.
echo  Downloading the Kokoro voice model and checking your graphics card...
%PY% -c "import torch; print('  GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'not found - conversion will be slow')" || goto :fail
%PY% -c "from synth import Engine; e = Engine(); print('  Kokoro is ready on', e.device)" || goto :fail

echo.
echo  Creating a "Books Converter" shortcut on your desktop...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Books Converter.lnk'); $s.TargetPath='%~dp0start.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\imageres.dll,189'; $s.Save()"

echo.
echo  All done! Double-click "Books Converter" on your desktop to start.
pause
exit /b 0

:fail
echo.
echo  Setup failed. Scroll up to see the error, or copy it to Claude for help.
pause
exit /b 1
