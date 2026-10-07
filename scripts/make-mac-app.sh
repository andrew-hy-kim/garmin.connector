#!/bin/bash
# Builds "Garmin Dashboard.app" in ~/Applications, with a shortcut on the Desktop.
# Clicking it starts the dashboard in the background (if it isn't running already) and
# opens it in your browser: no Terminal needed. The setup script runs this; to rebuild:
#
#   bash ~/garmin.connector/scripts/make-mac-app.sh
#
# The dashboard then keeps running quietly until you log out or restart (it's small);
# `garmin dashboard --stop` stops it.
set -euo pipefail

APP_DIR="${GARMIN_CONNECTOR_DIR:-$HOME/garmin.connector}"
DATA_DIR="${GARMIN_CONNECTOR_HOME:-$HOME/.garmin-connector}"
APP="$HOME/Applications/Garmin Dashboard.app"
PORT=8765

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/MacOS/garmin-dashboard" <<EOF
#!/bin/bash
# Start the dashboard if it isn't running, then open it.
URL="http://127.0.0.1:$PORT"
up() { /usr/bin/curl -s -o /dev/null --max-time 2 "\$URL/"; }
if ! up; then
  mkdir -p "$DATA_DIR"
  export GARMIN_CONNECTOR_HOME="$DATA_DIR"
  nohup "$APP_DIR/.venv/bin/garmin" dashboard --no-browser --port $PORT > "$DATA_DIR/dashboard.log" 2>&1 &
  for _ in \$(seq 1 60); do up && break; sleep 0.25; done
fi
if up; then
  /usr/bin/open "\$URL"
else
  /usr/bin/osascript -e 'display alert "The dashboard didn'"'"'t start" message "Details are in $DATA_DIR/dashboard.log. Running the setup line again in Terminal usually fixes it."'
fi
EOF
chmod +x "$APP/Contents/MacOS/garmin-dashboard"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Garmin Dashboard</string>
  <key>CFBundleDisplayName</key><string>Garmin Dashboard</string>
  <key>CFBundleIdentifier</key><string>local.garmin-connector.dashboard</string>
  <key>CFBundleExecutable</key><string>garmin-dashboard</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

# The dashboard's icon, in the sizes macOS wants (sips and iconutil come with macOS)
ICON_SRC="$APP_DIR/src/garmin_connector/static/phone/icon-512.png"
if [[ -f "$ICON_SRC" ]] && command -v iconutil >/dev/null 2>&1; then
  SET="$(mktemp -d)/icon.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256; do
    sips -z $s $s "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  cp "$ICON_SRC" "$SET/icon_512x512.png"
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/icon.icns" || true
fi
touch "$APP"  # so Finder picks up the new icon

# A shortcut on the Desktop (an ordinary link; delete it any time)
if [[ ! -e "$HOME/Desktop/Garmin Dashboard" ]]; then
  ln -s "$APP" "$HOME/Desktop/Garmin Dashboard" || true
fi
echo "Made $APP, with a shortcut on your Desktop. Drag it to the Dock to keep it there."
