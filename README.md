# garmin.connector

Pulls your Garmin Connect workouts onto your Mac, down to the second-by-second
heart rate, pace, cadence and elevation, and analyzes them in a browser dashboard
built for running.

**Workout tags:** every run is tagged by what it actually was, using heart rate relative to
your threshold (the COROS approach) plus the watch's workout laps and pace surges: Recovery,
Easy, Easy + strides, Long, Progression, Tempo, Threshold, Threshold intervals, VO2 max
intervals, Speed session, Fartlek, Race. Each tag comes with the reason.

**Coach notes:** feedback on each workout and on your training overall (easy days drifting
too hard, HR drift, rep pacing, efficiency vs. your usual, 80/20 balance, mileage jumps,
ramp rate, new bests, and how you're building back after a break of 3+ weeks), worked out
on your Mac. Optionally, **Ask Claude** for a written
coach's review (see below).

**Training plan:** pick a goal (build aerobic base, improve VO2 max, raise threshold, return
from a break, or maintain), how many weeks, runs per week and your long-run day. The plan is
built from your recent running time, run frequency, fitness and form, any comeback from a
break, your threshold HR and recent best efforts: mostly easy running, volume growing gradually,
a lighter week every fourth week, progressing workouts with HR and pace targets, and no hard
sessions until you've been consistent for about four weeks after a break. Each week shows
planned vs. done, the overview shows this week's plan, and you can **Ask Claude** to review it.

**Overview page** (a 3M / 6M / 1Y / 2Y / 5Y / All switch sets the time range for every chart)
- **Fitness, fatigue & form** explained in plain language: what the numbers mean, your
  current form state (fresh / maintaining / productive / overreaching), and what resting
  would do, plus your fitness now vs. 3 months, 1, 2, 3 and 5 years ago and your peak
- **Easy vs. hard running:** minutes by intensity per week (or per month on long ranges)
- Weekly distance, VO2 max trend, and **aerobic efficiency** (distance per heartbeat on
  easy runs), which shows whether your aerobic base is improving
- **Personal records** at 400 m, 1 km, mile, 5K, 10K, half and marathon, taken from the fastest
  stretch of any outdoor run, all-time and within the selected range
- **Activity list** with search, workout-type and date filters, sortable columns and paging
- Heart-rate settings (max, resting, threshold) and **zones pulled from your Garmin account**
  on every sync, so zones match your watch. You can override any value, and anything Garmin
  doesn't have is estimated from your data.

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

**Easiest:** paste this into Terminal. It installs everything (including its own Python,
no admin password needed), logs you in, runs the first sync and opens the dashboard:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/andrew-hy-kim/garmin.connector/claude/affectionate-bohr-2g8s7y/scripts/setup-mac.sh)"
```

**Or by hand:**

Needs **Python 3.10 or newer**. The `python3` that comes with macOS is 3.9, which is too
old, so install a current one first, either `brew install python@3.12` (Homebrew) or the
installer from [python.org](https://www.python.org/downloads/). Then open a new Terminal window.

```bash
git clone https://github.com/andrew-hy-kim/garmin.connector.git
cd garmin.connector
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
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
| `garmin-connector settings` | Show heart-rate settings and where each came from (Garmin, you, estimated) |
| `garmin-connector settings --max-hr 192` | Override a Garmin value (0 = go back to Garmin's) |
| `garmin-connector analyze` | Re-run the analysis on every downloaded workout |
| `garmin-connector logout` | Forget the saved password and tokens |

### Ask Claude (optional)

The coach notes work without this. For a written coach's review of a workout or of your
recent training, add an [Anthropic API key](https://console.anthropic.com/) once:

```bash
garmin-connector set-api-key     # stored in your macOS Keychain
```

Then click **Ask Claude** in the dashboard. Only then is a summary of your training sent to
Anthropic: workout tags, distances, paces, heart rate, load and the coach notes. No GPS
data is sent. Each review costs a few cents and is saved, so reopening it is free.
`garmin-connector remove-api-key` turns it off.

### Updating

Rerun the setup line. It updates the app, skips the login if you're logged in, syncs, and
opens the dashboard.

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

Your data is only sent to Garmin, to fetch it, with two exceptions: the route map loads
map tiles from OpenStreetMap, so OpenStreetMap sees roughly which area you ran in, and if
you set up **Ask Claude**, a training summary goes to Anthropic each time you click it. The dashboard only listens on `127.0.0.1`, so it's reachable only from your Mac.

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests use a fake Garmin client and synthetic `.fit` files (written with `fit-tool`),
and never touch a real account.

Chart.js 4.4.1 (MIT) and Leaflet 1.9.4 (BSD-2) are bundled in `src/garmin_connector/static/`,
so everything except the map tiles works offline.
