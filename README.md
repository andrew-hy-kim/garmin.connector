# garmin.connector

Pulls your Garmin Connect activities onto your Mac, keeps them in a local SQLite
database, and shows them in a dashboard in your browser.

> Uses the unofficial [`garminconnect`](https://github.com/cyberjunky/python-garminconnect)
> library, which logs in the same way the Garmin Connect website does. Garmin doesn't
> officially support it, so if Garmin changes their login it may need a library update
> (`pip install -U garminconnect`).

## Setup (once)

Needs Python 3.10+ (`brew install python` if you don't have it).

```bash
git clone https://github.com/andrew-hy-kim/garmin.connector.git
cd garmin.connector
python3 -m venv .venv
source .venv/bin/activate
pip install -e .

garmin-connector login     # asks for your Garmin email + password
garmin-connector sync      # first run pulls your whole history; can take a few minutes
garmin-connector dashboard # opens http://127.0.0.1:8765
```

Your password goes in the macOS Keychain and Garmin's login tokens in
`~/.garmin-connector/tokens`, so later syncs don't ask again.

## Everyday use

| Command | What it does |
| --- | --- |
| `garmin-connector sync` | Pull new activities since the last sync |
| `garmin-connector sync --since 2026-01-01` | Re-pull everything from a date |
| `garmin-connector sync --fit` | Also download the original `.fit` file for each activity |
| `garmin-connector dashboard` | Open the dashboard (it also has a **Sync now** button) |
| `garmin-connector logout` | Forget the saved password and tokens |

### Sync automatically every day

```bash
./scripts/install-daily-sync.sh          # every day at 9 PM
./scripts/install-daily-sync.sh 6 30     # or pick a time (6:30 AM)
./scripts/install-daily-sync.sh --remove # turn it off
```

This uses `launchd`, the Mac's built-in scheduler. If the Mac is asleep at that time,
the sync runs when it wakes. Logs: `~/.garmin-connector/sync.log`.

## Where your data lives

Everything is in `~/.garmin-connector/` (set `GARMIN_CONNECTOR_HOME` to move it):

- `garmin.db`: SQLite database (`activities`, `vo2max` tables). Each activity also keeps
  Garmin's full JSON in `raw_json`.
- `fit/`: original `.fit` files, if you sync with `--fit`
- `tokens/`: login tokens (private to your user account)

Nothing is sent anywhere except to Garmin to fetch your data, and the dashboard only
listens on `127.0.0.1`, so it's reachable only from your Mac.

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests use a fake Garmin client and never touch a real account.

Chart.js 4.4.1 (MIT) is bundled in `src/garmin_connector/static/` so the dashboard works offline.
