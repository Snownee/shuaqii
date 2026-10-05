#!/usr/bin/env bash
# Creates a launchable shortcut for OpenCode + shuaqii on macOS and Linux.
# Run by the installer (see INSTALL.txt); safe to run again to refresh it.
# The Windows twin is install/make-shortcut.ps1.
set -eu

# Where the installer put the repo (must match INSTALL.txt / open-shuaqii.sh).
DEST="${SHUAQII_DEST:-$HOME/.local/share/shuaqii}"
LAUNCHER="$DEST/open-shuaqii.sh"
NAME="shuaqii (OpenCode)"

if [ ! -f "$LAUNCHER" ]; then
  echo "open-shuaqii.sh not found at $LAUNCHER; is the install complete?" >&2
  exit 1
fi
chmod +x "$LAUNCHER"

case "$(uname -s)" in
  Darwin)
    # A ~/Desktop double-clickable .command that runs the launcher.
    LINK="$HOME/Desktop/$NAME.command"
    {
      printf '#!/usr/bin/env bash\n'
      printf 'exec %q\n' "$LAUNCHER"
    } > "$LINK"
    chmod +x "$LINK"
    echo "Created $LINK"
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
Terminal=true
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
