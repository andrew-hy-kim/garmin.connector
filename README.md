# garmin.connector

Pulls your Garmin Connect workouts onto your Mac, down to the second-by-second
heart rate, pace, cadence and elevation, and analyzes them in a browser dashboard
built for running.

**Overview page**
- **Training load:** fitness (6-week load), fatigue (7-day load) and form, from
  heart-rate-based load (TRIMP) across every activity
- Weekly distance, VO2 max trend, and **aerobic efficiency** (distance per heartbeat on
  easy runs), which shows whether your aerobic base is improving
- **Personal records** at 400 m, 1 km, mile, 5K, 10K, half and marathon, taken from the fastest
  stretch of any outdoor run
- Heart-rate settings (max, resting, threshold). Blanks are estimated from your data.

**Workout page** (click any activity)
- HR, pace + grade-adjusted pace, cadence and elevation on one synced timeline (by time or
  distance), with HR zone bands and interval reps shaded
- **Drag across any stretch** (or click a lap, split or best effort) for its pace, GAP,
  HR, cadence and elevation
- Time in HR zones, route map colored by zone, laps with a work-rep summary for interval
  sessions, mile/km splits with GAP, best efforts within the run
- **HR drift** (aerobic decoupling) on steady runs over 40 minutes

**Wrist vs. arm band:** each workout records whether an external HR sensor was connected.
Wrist HR is cleaned of one-second spikes and dropouts, and runs where the wrist sensor
locked onto your cadence are flagged and left out of max-HR and efficiency estimates.

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
garmin-connector sync      # first run downloads your whole history; allow ~1 s per workout
garmin-connector dashboard # opens http://127.0.0.1:8765
```

Your password goes in the macOS Keychain and Garmin's login tokens in
`~/.garmin-connector/tokens`, so later syncs don't ask again.

## Everyday use

| Command | What it does |
| --- | --- |
| `garmin-connector sync` | Pull new activities since the last sync |
| `garmin-connector sync --since 2026-01-01` | Re-pull everything from a date |
| `garmin-connector sync --no-fit` | Summaries only; skip downloading workout files |
| `garmin-connector dashboard` | Open the dashboard (it also has a **Sync now** button) |
| `garmin-connector settings --max-hr 192 --lthr 172` | Set heart-rate values (0 = go back to estimating) |
| `garmin-connector analyze` | Re-run the analysis on every downloaded workout |
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

- `garmin.db`: SQLite database. `activities` (summaries plus Garmin's full JSON), `streams`
  (second-by-second data, compressed), `laps`, `activity_metrics`, `vo2max`, `settings`
- `fit/`: the original `.fit` file for every workout, so nothing is lost even if Garmin
  changes something
- `tokens/`: login tokens (private to your user account)

Your data is only sent to Garmin, to fetch it. The one exception is the route map, which
loads map tiles from OpenStreetMap, so OpenStreetMap sees roughly which area you ran in
(not your data). The dashboard only listens on `127.0.0.1`, so it's reachable only from your Mac.

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests use a fake Garmin client and synthetic `.fit` files (written with `fit-tool`),
and never touch a real account.

Chart.js 4.4.1 (MIT) and Leaflet 1.9.4 (BSD-2) are bundled in `src/garmin_connector/static/`,
so everything except the map tiles works offline.
