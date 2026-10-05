@echo off
setlocal
set "DEST=%LOCALAPPDATA%\shuaqii"
set "APP=%DEST%\shuaqii.py"
set "LOG=%DEST%\shuaqii.log"

if not exist "%APP%" (
  echo shuaqii not found at "%DEST%".
  echo Re-run the installer: see INSTALL.txt in the repository.
  pause
  exit /b 1
)

rem Also tee output to a log file, so a hidden launch (open-shuaqii.vbs) and a
rem visible one leave the same record.
echo [launcher] %DATE% %TIME% >> "%LOG%"

rem If OpenCode is already running without a debug port, the injector cannot
rem attach to it (single-instance lock). Offer to restart it, which is why this
rem launcher exists: only the user, double-clicking here, agrees to that.
tasklist /FI "IMAGENAME eq OpenCode.exe" 2>nul | find /I "OpenCode.exe" >nul
if %ERRORLEVEL%==0 (
  echo OpenCode is currently running without a debug port.
  echo shuaqii needs to restart it so it can attach.
  echo Unsaved state may be lost.
  choice /C YN /M "Restart OpenCode now"
  if errorlevel 2 exit /b 0
  python "%APP%" --launch --restart
) else (
  python "%APP%" --launch
)

echo.
echo shuaqii has stopped. The injected mods end when this window closes.
pause
endlocal
