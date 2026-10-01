#!/bin/bash
# Schedule `garmin-connector sync` to run every day on this Mac using launchd.
#
#   ./scripts/install-daily-sync.sh          # sync daily at 9:00 PM
#   ./scripts/install-daily-sync.sh 6 30     # sync daily at 6:30 AM
#   ./scripts/install-daily-sync.sh --remove # stop the daily sync
#
# If the Mac is asleep at that time, macOS runs the sync when it wakes up.
# Logs go to ~/.garmin-connector/sync.log
set -euo pipefail

LABEL="com.garmin-connector.sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Daily sync removed."
  exit 0
fi

HOUR="${1:-21}"
MINUTE="${2:-0}"
BIN="$(command -v garmin-connector || true)"
if [[ -z "$BIN" ]]; then
  echo "Can't find garmin-connector. Activate the virtualenv you installed it into first." >&2
  exit 1
fi
LOG_DIR="${GARMIN_CONNECTOR_HOME:-$HOME/.garmin-connector}"
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>sync</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/sync.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf "Daily sync scheduled for %02d:%02d. Logs: %s/sync.log\n" "$HOUR" "$MINUTE" "$LOG_DIR"
