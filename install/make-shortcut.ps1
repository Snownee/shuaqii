# Creates a desktop shortcut that launches OpenCode Desktop through shuaqii.
# Run by the installer (see INSTALL.txt); safe to run again to refresh it.
$ErrorActionPreference = 'Stop'

$dest = Join-Path $env:LOCALAPPDATA 'shuaqii'
$cmd  = Join-Path $dest 'open-shuaqii.cmd'

if (-not (Test-Path -LiteralPath $cmd)) {
  throw "open-shuaqii.cmd not found in $dest; is the install complete?"
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'shuaqii (OpenCode).lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnkPath)
$sc.TargetPath       = $cmd
$sc.WorkingDirectory = $dest
$sc.Description      = 'Launch OpenCode Desktop with shuaqii mods injected'

# Prefer the OpenCode icon; fall back silently if it is not at the usual path.
$iconExe = Join-Path $env:LOCALAPPDATA 'Programs\@opencode-aidesktop\OpenCode.exe'
if (Test-Path -LiteralPath $iconExe) {
  $sc.IconLocation = "$iconExe,0"
}

$sc.Save()

Write-Host "Shortcut created: $lnkPath"
