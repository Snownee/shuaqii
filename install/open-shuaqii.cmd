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

rem Also tee output to a log file, so a hidden launch and a visible one leave
rem the same record.
echo [launcher] %DATE% %TIME% >> "%LOG%"

rem Decide how to reach OpenCode: if the debug port is already open, just attach
rem (--live); otherwise it is either not running (--launch) or running without a
rem port, which needs a restart the user must agree to.
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1', 9222); exit 0 } catch { exit 1 }"
if %ERRORLEVEL%==0 (
  python "%APP%" --live
) else (
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
)

echo.
echo shuaqii has stopped. The injected mods end when this window closes.
pause
endlocal
