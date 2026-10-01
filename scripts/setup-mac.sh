#!/bin/bash
# One-step setup for macOS. Run it in Terminal with:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/andrew-hy-kim/garmin.connector/claude/affectionate-bohr-2g8s7y/scripts/setup-mac.sh)"
#
# It downloads (or updates) the app into ~/garmin.connector, installs a private copy
# of Python with uv (no admin password needed, and the Python that comes with macOS
# is left alone), installs the app, then logs you in, runs the first sync and opens
# the dashboard. Safe to run again: it updates the app and skips the login if
# you're already logged in, so it doubles as the update command.
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
rm -rf .venv
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python -e .

# Make `garmin-connector` work from any new Terminal window.
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/.venv/bin/garmin-connector" "$BIN_DIR/garmin-connector"
if ! grep -qs '.local/bin' "$HOME/.zshrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
fi

if [[ -f "${GARMIN_CONNECTOR_HOME:-$HOME/.garmin-connector}/account.json" ]]; then
  echo "Already logged in to Garmin Connect."
else
  step "Logging in to Garmin Connect"
  echo "Type your Garmin email and password. The password stays hidden while you type."
  garmin-connector login < /dev/tty
fi

step "Syncing your workouts (first time: about a second per workout)"
garmin-connector sync

step "Opening the dashboard"
echo "Leave this window open while you use the dashboard. Press Ctrl+C to stop it."
echo "Next time, just open Terminal and run:  garmin-connector dashboard"
garmin-connector dashboard
