# Hidden launcher: starts OpenCode through shuaqii with no console window.
# The desktop shortcut runs this with `powershell -WindowStyle Hidden`, so the
# only UI is a dialog when a restart is needed. Windows-only; the visible-
# terminal twin is open-shuaqii.cmd. Output goes to %LOCALAPPDATA%\shuaqii\shuaqii.log.
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'shuaqii'
$app  = Join-Path $dest 'shuaqii.py'
$log  = Join-Path $dest 'shuaqii.log'

function Show-Message([string]$text, [string]$title, [string]$button) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $icon = if ($button -eq 'YesNo') {
    [System.Windows.Forms.MessageBoxIcon]::Question
  } else {
    [System.Windows.Forms.MessageBoxIcon]::Error
  }
  $buttons = if ($button -eq 'YesNo') {
    [System.Windows.Forms.MessageBoxButtons]::YesNo
  } else {
    [System.Windows.Forms.MessageBoxButtons]::OK
  }
  return [System.Windows.Forms.MessageBox]::Show($text, $title, $buttons, $icon)
}

if (-not (Test-Path -LiteralPath $app)) {
  [void](Show-Message "shuaqii not found at $dest.`nRe-run the installer: see INSTALL.txt in the repository." 'shuaqii' 'OK')
  exit 1
}

# Prefer pythonw.exe (no console); fall back to python.exe.
$pythonPath = $null
foreach ($name in 'pythonw.exe', 'python.exe') {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  if ($found) { $pythonPath = $found.Source; break }
}
if (-not $pythonPath) {
  [void](Show-Message 'Python 3 not found on PATH.' 'shuaqii' 'OK')
  exit 1
}

# If OpenCode is already running it must be restarted so the debug port can bind.
$appArgs = @($app, '--launch')
$running = @(Get-Process -Name 'OpenCode' -ErrorAction SilentlyContinue).Count -gt 0
if ($running) {
  $answer = Show-Message ("OpenCode is currently running.`n`n" +
    "shuaqii needs to restart it so it can attach.`n" +
    "Unsaved state may be lost.`n`n" +
    "Restart OpenCode now?") 'shuaqii' 'YesNo'
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
  $appArgs += '--restart'
}

# Run detached with stdout+stderr appended to the log file. Redirecting through
# cmd gives us the append ('' 2>&1') that Start-Process alone cannot, and pythonw
# + a hidden window means no console flashes.
$logLine = "[launcher] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($appArgs -join ' ')"
Add-Content -LiteralPath $log -Value $logLine

$quoted = ($appArgs | ForEach-Object { '"' + ($_ -replace '"', '""') + '"' }) -join ' '
$cmdLine = '"{0}" {1} >> "{2}" 2>&1' -f $pythonPath, $quoted, $log
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -WorkingDirectory $dest -WindowStyle Hidden
