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

# Decide how to reach OpenCode:
#   debug port already open  -> it is running (and likely injected): just attach
#   port closed + process up -> it is running without a port: offer a restart
#   no process               -> launch it fresh
$port = 9222
function Test-Port([string]$host_, [int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($host_, $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (Test-Port '127.0.0.1' $port) {
  $appArgs = @($app, '--live')
} else {
  $appArgs = @($app, '--launch')
  $running = @(Get-Process -Name 'OpenCode' -ErrorAction SilentlyContinue).Count -gt 0
  if ($running) {
    $answer = Show-Message ("OpenCode is currently running without a debug port.`n`n" +
      "shuaqii needs to restart it so it can attach.`n" +
      "Unsaved state may be lost.`n`n" +
      "Restart OpenCode now?") 'shuaqii' 'YesNo'
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
    $appArgs += '--restart'
  }
}

# Run detached with stdout+stderr appended to the log file. Start-Process cannot
# append both streams to one file, and handing a quoted command line to
# `cmd /c` via Start-Process mangles it, so write a small .cmd and launch that
# hidden. pythonw.exe + -WindowStyle Hidden means no console flashes.
$logLine = "[launcher] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $($appArgs -join ' ')"
Add-Content -LiteralPath $log -Value $logLine

$runner = Join-Path $dest 'run-latest.cmd'
$cmdLines = @(
  '@echo off',
  ('"{0}" {1} >> "{2}" 2>&1' -f $pythonPath, (($appArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '), $log)
)
Set-Content -LiteralPath $runner -Value $cmdLines -Encoding ASCII

Start-Process -FilePath $runner -WorkingDirectory $dest -WindowStyle Hidden
