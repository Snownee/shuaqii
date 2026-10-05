#!/usr/bin/env bash
# Creates a launchable shortcut for OpenCode + shuaqii on macOS and Linux.
# Run by the installer (see INSTALL.txt); safe to run again to refresh it.
# The Windows twin is install/make-shortcut.ps1.
set -eu

# The launcher sits next to this script, so resolve it from here rather than
# assuming the repo root.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER="$HERE/open-shuaqii.sh"
NAME="shuaqii (OpenCode)"

if [ ! -f "$LAUNCHER" ]; then
  echo "open-shuaqii.sh not found next to this script; is the install complete?" >&2
  exit 1
fi
chmod +x "$LAUNCHER"

case "$(uname -s)" in
  Darwin)
    # A double-clickable .app with no Terminal window. osacompile builds it from
    # an AppleScript that prompts natively, then runs the launcher detached,
    # appending to the log file. Falls back to a .command if osacompile is absent.
    APP_BUNDLE="$HOME/Desktop/$NAME.app"
    LOG="${SHUAQII_LOG:-$HOME/.local/share/shuaqii/shuaqii.log}"
    if command -v osacompile >/dev/null 2>&1; then
      SCRIPT="$(mktemp /tmp/shuaqii-XXXXXX.applescript)"
      cat > "$SCRIPT" <<OSA
set launcher to "$LAUNCHER"
set logPath to "$LOG"
set running to (do shell script "pgrep -f '[Oo]pen[Cc]ode' >/dev/null 2>&1 && echo yes || echo no")
set mode to "--launch"
if running is "yes" then
  display dialog "OpenCode is currently running.

shuaqii needs to restart it so it can attach. Unsaved state may be lost.

Restart OpenCode now?" buttons {"Cancel", "Restart"} default button "Restart" with icon caution with title "shuaqii"
  if button returned of result is not "Restart" then return
  set mode to "--launch --restart"
end if
do shell script "nohup " & quoted form of launcher & " " & mode & " >> " & quoted form of logPath & " 2>&1 &"
OSA
      rm -rf "$APP_BUNDLE"
      osacompile -o "$APP_BUNDLE" "$SCRIPT"
      rm -f "$SCRIPT"
      echo "Created $APP_BUNDLE"
    else
      LINK="$HOME/Desktop/$NAME.command"
      { printf '#!/usr/bin/env bash\n'; printf 'exec %q\n' "$LAUNCHER"; } > "$LINK"
      chmod +x "$LINK"
      echo "Created $LINK (osacompile not found; this one opens Terminal)"
    fi
    ;;
  Linux)
    DESKTOP_DIR="$HOME/.local/share/applications"
    mkdir -p "$DESKTOP_DIR"
    ENTRY="$DESKTOP_DIR/shuaqii-opencode.desktop"
    cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Comment=Launch OpenCode Desktop with shuaqii mods injected
Exec=$LAUNCHER
Terminal=false
Categories=Development;
EOF
    chmod +x "$ENTRY"
    echo "Created $ENTRY"
    # Also drop a copy on the Desktop when a Desktop folder exists.
    if [ -d "$HOME/Desktop" ]; then
      cp "$ENTRY" "$HOME/Desktop/shuaqii-opencode.desktop"
      chmod +x "$HOME/Desktop/shuaqii-opencode.desktop"
      echo "Created $HOME/Desktop/shuaqii-opencode.desktop"
    fi
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
