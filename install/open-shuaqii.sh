#!/usr/bin/env bash
# Launcher for macOS and Linux. The Windows twins are open-shuaqii.cmd (visible)
# and open-shuaqii.vbs (hidden). Starts OpenCode with a debug port and injects
# the mods. Only the user runs this, never the installer, so the restart below is
# a deliberate, informed action.
#
# Works both from a terminal (interactive prompt) and with no terminal (a GUI
# dialog when one is available). All output is appended to a log file.
set -u

DEST="${SHUAQII_DEST:-$HOME/.local/share/shuaqii}"
APP="$DEST/shuaqii.py"
LOG="${SHUAQII_LOG:-$DEST/shuaqii.log}"

gui_dialog() {
  # $1 = error|question, $2 = text. Returns 0 for yes/ok. No-op without a GUI tool.
  local kind="$1" text="$2"
  if command -v zenity >/dev/null 2>&1; then
    [ "$kind" = question ] && zenity --question --title="shuaqii" --text="$text"
    [ "$kind" = error ] && zenity --error --title="shuaqii" --text="$text"
  elif command -v kdialog >/dev/null 2>&1; then
    [ "$kind" = question ] && kdialog --yesno "$text" --title shuaqii
    [ "$kind" = error ] && kdialog --error "$text" --title shuaqii
  elif [ "$kind" = error ]; then
    command -v osascript >/dev/null 2>&1 && \
      osascript -e "display dialog \"$text\" with icon caution with title \"shuaqii\""
  fi
}

if [ ! -f "$APP" ]; then
  msg="shuaqii not found at $DEST
Re-run the installer: see INSTALL.txt in the repository."
  echo "$msg" >&2
  gui_dialog error "$msg"
  exit 1
fi

# Prefer python3; fall back to python.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  msg="Python 3 not found on PATH."
  echo "$msg" >&2
  gui_dialog error "$msg"
  exit 1
fi

running() {
  pgrep -f "[Oo]pen[Cc]ode" >/dev/null 2>&1
}

mode="--launch"
if running; then
  text="OpenCode is currently running.

shuaqii needs to restart it so it can attach. Unsaved state may be lost.

Restart OpenCode now?"
  if [ -t 0 ]; then
    echo "OpenCode is currently running without a debug port."
    echo "shuaqii needs to restart it so it can attach."
    echo "Unsaved state may be lost."
    printf 'Restart OpenCode now? [y/N] '
    read -r answer
    case "$answer" in [Yy]*) ;; *) exit 0 ;; esac
  elif gui_dialog question "$text"; then
    :
  else
    echo "[launcher] $(date) OpenCode is running and no confirmation was given; not restarting." >> "$LOG"
    exit 0
  fi
  mode="--launch --restart"
fi

echo "[launcher] $(date) $mode" >> "$LOG"
"$PY" "$APP" $mode >> "$LOG" 2>&1

echo
echo "shuaqii has stopped."
# Keep a double-clicked terminal window open so the output is visible; not when
# launched headless.
if [ -t 0 ]; then
  printf 'Press Enter to close... '
  read -r _ || true
fi
