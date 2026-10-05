# Creates a desktop shortcut that launches OpenCode Desktop through shuaqii.
# Run by the installer (see INSTALL.txt); safe to run again to refresh it.
$ErrorActionPreference = 'Stop'

# The launcher sits next to this script, so resolve it from here rather than
# assuming the repo root. The install root is the repo directory, two levels up
# (install/make-shortcut.ps1 -> repo).
#
# Target the hidden launcher: run hidden PowerShell, which shows a dialog if a
# restart is needed and starts OpenCode with no console window.
# open-shuaqii.cmd is the visible-terminal alternative.
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$launch  = Join-Path $here 'open-shuaqii.ps1'
$dest    = Split-Path -Parent $here

if (-not (Test-Path -LiteralPath $launch)) {
  throw "open-shuaqii.ps1 not found next to this script; is the install complete?"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'shuaqii (OpenCode).lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
# Hidden PowerShell: no console window; the script shows a dialog when needed.
$sc.TargetPath       = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$sc.Arguments        = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launch`""
$sc.WorkingDirectory = $dest
$sc.Description      = 'Launch OpenCode Desktop with shuaqii mods injected'

# Prefer the OpenCode icon; fall back silently if it is not at the usual path.
$iconExe = Join-Path $env:LOCALAPPDATA 'Programs\@opencode-aidesktop\OpenCode.exe'
if (Test-Path -LiteralPath $iconExe) {
  $sc.IconLocation = "$iconExe,0"
}

$sc.Save()

Write-Host "Shortcut created: $lnkPath"
