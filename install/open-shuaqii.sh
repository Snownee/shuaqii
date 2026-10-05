#!/usr/bin/env bash
# Launcher for macOS and Linux. The Windows twin is install/open-shuaqii.cmd.
# Double-clicked (macOS) or run from a terminal; it starts OpenCode with a debug
# port and injects the mods. Only the user runs this, never the installer, so
# the restart below is a deliberate, informed action.
set -u

DEST="${SHUAQII_DEST:-$HOME/.local/share/shuaqii}"
APP="$DEST/shuaqii.py"

if [ ! -f "$APP" ]; then
  echo "shuaqii not found at $DEST" >&2
  echo "Re-run the installer: see INSTALL.txt in the repository." >&2
  exit 1
fi

# Prefer python3; fall back to python.
PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "Python 3 not found on PATH." >&2
  exit 1
fi

running() {
  pgrep -f "[Oo]pen[Cc]ode" >/dev/null 2>&1
}

if running; then
  echo "OpenCode is currently running without a debug port."
  echo "shuaqii needs to restart it so it can attach."
  echo "Unsaved state may be lost."
  printf 'Restart OpenCode now? [y/N] '
  read -r answer
  case "$answer" in
    [Yy]*) "$PY" "$APP" --launch --restart ;;
    *) exit 0 ;;
  esac
else
  "$PY" "$APP" --launch
fi

echo
echo "shuaqii has stopped."
# Keep a double-clicked terminal window open so the output is visible.
if [ -t 0 ]; then
  printf 'Press Enter to close... '
  read -r _ || true
fi
