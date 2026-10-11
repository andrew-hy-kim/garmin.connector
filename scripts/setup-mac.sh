#!/bin/bash
# One-step setup for macOS. Run it in Terminal with:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/andrew-hy-kim/garmin.connector/claude/affectionate-bohr-2g8s7y/scripts/setup-mac.sh)"
#
# It downloads (or updates) the app into ~/garmin.connector, installs a private copy
# of Python with uv (no admin password needed, and the Python that comes with macOS
# is left alone), installs the app, then logs you in, syncs, imports your Apple Watch
# history if there's a Health export (export.zip) in Downloads, makes the Garmin Dashboard
# app (Applications, plus a Desktop shortcut) and opens the dashboard. Safe to run again:
# it updates the app, skips the login if you're already logged in and skips an Apple export
# it has already imported, so it doubles as the update command.
set -euo pipefail

REPO_URL="https://github.com/andrew-hy-kim/garmin.connector.git"
BRANCH="claude/affectionate-bohr-2g8s7y"
APP_DIR="${GARMIN_CONNECTOR_DIR:-$HOME/garmin.connector}"
BIN_DIR="$HOME/.local/bin"

step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }

step "Getting the app"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

step "Installing uv (Python installer)"
export PATH="$BIN_DIR:$PATH"
if command -v uv >/dev/null 2>&1; then
  echo "uv already installed."
else
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN_DIR" sh
fi

step "Installing Python 3.13 and the app"
# a dashboard left running in the background would keep showing the old version
if [[ -x .venv/bin/garmin ]]; then .venv/bin/garmin dashboard --stop >/dev/null 2>&1 || true; fi
rm -rf .venv
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e .

# Make `garmin` (and the longer `garmin-connector`) work from any new Terminal window.
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/.venv/bin/garmin" "$BIN_DIR/garmin"
ln -sf "$APP_DIR/.venv/bin/garmin-connector" "$BIN_DIR/garmin-connector"
if ! grep -qs '.local/bin' "$HOME/.zshrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
fi

if [[ -f "${GARMIN_CONNECTOR_HOME:-$HOME/.garmin-connector}/account.json" ]]; then
  echo "Already logged in to Garmin Connect."
else
  step "Logging in to Garmin Connect"
  echo "Type your Garmin email and password. The password stays hidden while you type."
  garmin login < /dev/tty
fi

step "Syncing your workouts (first time: about a second per workout)"
garmin sync

# Apple Watch history: the newest Health export in Downloads (export.zip, or "export 2.zip" when
# there are several), imported once. It's imported again only when a newer export turns up, so
# running this script again to update the app doesn't redo it.
DATA_DIR="${GARMIN_CONNECTOR_HOME:-$HOME/.garmin-connector}"
APPLE_STAMP="$DATA_DIR/apple-import.done"
newest=""
for f in "$HOME"/Downloads/export*.zip; do
  [[ -f "$f" ]] || continue
  if [[ -z "$newest" || "$f" -nt "$newest" ]]; then newest="$f"; fi
done
if [[ -n "$newest" ]]; then
  if [[ "$(uname)" == Darwin ]]; then size_time=$(stat -f '%z %m' "$newest"); else size_time=$(stat -c '%s %Y' "$newest"); fi
  stamp="$newest $size_time"
  if [[ "$(cat "$APPLE_STAMP" 2>/dev/null)" == "$stamp" ]]; then
    echo "Apple Health export already imported ($(basename "$newest"))."
  else
    step "Importing your Apple Watch history from $(basename "$newest")"
    if garmin import-apple "$newest"; then
      mkdir -p "$DATA_DIR" && echo "$stamp" > "$APPLE_STAMP"
    else
      echo "The Apple import didn't work (details above). Everything else is set up; to try again:"
      echo "  garmin import-apple \"$newest\""
    fi
  fi
fi

step "Making the Garmin Dashboard app"
bash "$APP_DIR/scripts/make-mac-app.sh"

step "Opening the dashboard"
open "$HOME/Applications/Garmin Dashboard.app"
echo "Done. From now on, click Garmin Dashboard on your Desktop (or in Applications, or the Dock)."
echo "It keeps running in the background until you restart; 'garmin dashboard --stop' stops it."
