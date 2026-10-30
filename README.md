# garmin.connector

Pulls your Garmin Connect workouts onto your Mac, down to the second-by-second
heart rate, pace, cadence and elevation, and analyzes them in a browser dashboard
built for running.

**Workout tags:** every run is tagged by what it actually was, using heart rate relative to
your threshold (the COROS approach) plus the watch's workout laps and pace surges: Recovery,
Easy, Easy + strides, Long, Progression, Tempo, Threshold, Threshold intervals, VO2 max
intervals, Speed session, Fartlek, Race. Each tag comes with the reason. Effort decides,
not structure: surges that never lift heart rate out of the easy zone (run/walk, relaxed
pickups) are an easy run. Runs with more than 15% walking are left out of effective VO2max,
aerobic efficiency and HR drift, since walk breaks would read as lost fitness; after a break,
the coach eases off mileage warnings while you rebuild.

**Coach notes:** feedback on each workout and on your training overall (easy days drifting
too hard, HR drift, rep pacing, efficiency vs. your usual, 80/20 balance, mileage jumps,
ramp rate, new bests, interval reps against the pace they're meant for, heat and air quality,
and how you're building back after a break of 3+ weeks), worked out
on your Mac.

The dashboard has three tabs: **Progress**, **Activities** and **Map**
(in a narrow window they move to the bottom of the screen).

**Progress** (the home page): your running at a glance, then how you're trending (a 3M / 6M /
1Y / 2Y / 5Y / All switch sets the range for the charts)
- **Sync trouble:** if the last sync failed (say, Garmin's login expired), a banner at the top
  says what went wrong, what to do, and when the last good sync was
- **Progress status:** one word: *Improving*, *Edging up*, *Holding
  steady*, *Slipping* or *Rebuilding* (after a break). It weighs four signals over fixed windows,
  whatever range the charts show: VO2max shape over 4 weeks, heart rate at your usual pace and
  easy-run efficiency (the last 4 weeks against the 8 before), and training load against 4 weeks
  ago; hot or humid runs are left out, so summer doesn't read as slipping. Next to it, the one
  step that would help most, from *Where to improve*
- This week / month / year (each opens its runs), your cross-training this week (strength,
  rides, hikes and the rest) and **active calories** today with your 7-day daily average
- **Latest run:** distance, time, pace, heart rate, load and effective VO2max, its route, and
  its top coach note
- **Coach notes** on your recent training: the three that matter most, with the rest a tap away
- **Running fitness**, the way [RUNALYZE](https://runalyze.com) does it:
  - **VO2max shape:** an effective VO2max from every run's pace and heart rate (Daniels &
    Gilbert), averaged over 30 days and weighted by duration. Races marked in Garmin
    calibrate it. It's charted next to your watch's VO2 max.
  - **Marathon shape:** whether your training has the endurance long races need. Weekly
    distance over 6 months counts two thirds, long runs over 13 km in the last 10 weeks one
    third, against targets that grow with your VO2max.
- **Base, fatigue & form** in plain language: *base* is your training load built up over about
  6 weeks (what other apps call "fitness"; your actual running fitness is VO2max shape), plus
  **monotony** and **training strain** (Foster) for the last 7 days, what resting would do, and
  your base now vs. earlier. A fold-out shows **where your load comes from**: each kind of run
  (easy, long, tempo…) and each kind of cross-training as a share of all your load in the range
- Weekly distance, easy vs. hard running, **aerobic efficiency** (distance per heartbeat on
  easy runs) and **long runs** (your longest each week against the long-run threshold and your
  marathon target), and **cross-training**: hours of strength, cycling, hiking & walking and
  everything else each week, and **active calories**: what your workouts burned beyond resting,
  as a daily average, split into running and cross-training. Each chart leads with its headline number, and a click on a week opens its
  runs. Cross-training, active calories, heart rate at a fixed pace and running form sit
  folded under **More charts**.
- **Heart rate at a fixed pace:** your heart rate while running steadily at one pace (adjusted
  for hills), run by run with a 30-day average. The same pace at a lower heart rate is the
  plainest sign of getting fitter. Hot or humid runs show as orange triangles and are left out of the
  30-day average (on the efficiency chart too), so a summer heatwave doesn't read as lost fitness. Pick the pace from the card (it starts at the pace you run
  most); only steady stretches count, from five minutes in and two minutes after any change of
  pace, and run/walk runs and runs where the heart rate locked onto your cadence are left out
- **Running form:** cadence, stride length, ground contact time and vertical ratio on easy runs
  (whichever your watch records), each run plus a 30-day average, so you see your form change
  over months
- **Where to improve:** your last three months area by area (consistency, endurance, easy vs.
  hard, workouts, aerobic efficiency), each marked *work on*, *fine* or *strength*,
  with what to work on first and a concrete next step using your own paces and distances
- **Statistics** by year, month or week: runs, distance, time, pace, heart rate, climb, longest
  run and VO2max. Click a row to list its runs. Above it, a year-to-date chart of this year's
  distance against last year and your best year: ahead or behind by this date, and what
  you're on pace for.
- **Race predictor** at the record distances (400 m to marathon), from VO2max shape, with
  Garmin's prediction (saved at each sync) and the change over three months. Long races that
  your endurance doesn't support yet show two times: what you'd run today, and what your speed
  supports once weekly distance and long runs catch up. Click a row for your fastest recent
  stretch at that distance.
- **Personal records** from the fastest stretch of any outdoor run (all-time and within the
  range) and milestones (longest run, biggest week and month)
- **Training paces** (easy, marathon, threshold, interval, repetition) from your VO2max shape,
  folded away under one summary line; marathon pace is your potential, with today's marathon
  pace noted when endurance holds it back
- Heart-rate settings (folded away, with a summary line), max, resting and threshold HR and **zones pulled from your Garmin account**
  on every sync, so zones match your watch. You can override any value, and anything Garmin
  doesn't have is estimated from your data.

**Activities**
- **Consistency calendar:** every run of the past year as a dot, colored by workout type and
  sized by distance, with your runs per week and your streak of weeks with 3+ runs
- **Activity list** grouped by week, with search (names or workout types; press `/`),
  workout-type and date filters, sortable columns (including each run's effective VO2max),
  each run's temperature and sky, and paging

**Map**: a **heatmap** of everywhere you've run
- The more often you've run a street, the brighter it glows. Tap anywhere to list the runs
  that went through it. **Routes** shows each run as its own line, colored by workout type.
- Filter by date (all time, last 12 months / 90 / 30 days, this or last year), activity type,
  workout type and distance
- **Where you run:** your most-run places, with runs, distance and your last visit. Select one
  to zoom there. The map opens on the place you run most.

**Workout page** (click any activity)
- **Weather** during the run, from [Open-Meteo](https://open-meteo.com): temperature and
  feels-like, dew point and humidity, wind, rain or snow, and air quality (US AQI), with what
  it cost you: heat and humidity together give an expected slowdown at the same effort
  ("Warm and humid: about 3% slower"). Coach notes connect it to your numbers (heart-rate
  drift on a hot day, a hard run in poor air).
- **Your recent sessions of the same kind** (intervals, tempo, threshold, long runs…): for interval
  sessions the reps (6 × 3:00), rep pace and rep heart rate; for steady ones distance, pace and
  heart rate, with how this session compares with your previous three
- **Same route:** your other runs along the same line, start to finish, with time, pace, heart
  rate and efficiency, how this one ranks against runs of the same kind, and your route record
- Training load and Garmin's training effect (with what it means: maintaining, improving…),
  HR drift, efficiency, effective VO2max and your heart rate at the pace picked on Progress
  against your runs the month before; under **More from your watch**, active calories (with the total including resting), power,
  best pace, stride length, ground contact, vertical oscillation and ratio, and
  sweat loss, whichever your watch records
- HR, pace + grade-adjusted pace, cadence and elevation on one synced timeline (by time or
  distance), with HR zone bands and interval reps shaded
- **Drag across any stretch** (or click a lap, split or best effort) for its pace, GAP,
  HR, cadence and elevation, compared with the run as a whole
- Time in HR zones and **time in pace zones** (easy to repetition, from your training paces, on
  grade-adjusted pace), a full-width route map colored by zone, laps with a work-rep summary for interval
  sessions, mile/km splits with GAP, best efforts within the run; laps and splits show a speed
  bar colored by heart-rate zone
- **Older / Newer** buttons (or the ← → keys) to page through your runs
- Steady runs compare themselves with your last run of the same kind ("8 s/mi faster at
  2 bpm lower heart rate"); intervals are listed as reps and recoveries; the fastest split
  is marked
- **HR drift** (aerobic decoupling) on steady runs over 40 minutes

**Active calories:** Garmin's calorie count for a workout includes what you'd have burned
sitting still; the dashboard takes that resting share off, so you see what the workout itself
burned (Apple Watch workouts record it that way already). These are your watch's estimates:
fair for runs (heart rate plus pace), rougher for strength, indoor cycling and the like, where
heart rate alone tends to overstate them. Good for trends, not to the calorie.

**Wrist vs. arm band:** each workout records whether an external HR sensor was connected.
Wrist HR is cleaned of one-second spikes and dropouts, and runs where the wrist sensor
locked onto your cadence are flagged and left out of max-HR and efficiency estimates.

> Uses the unofficial [`garminconnect`](https://github.com/cyberjunky/python-garminconnect)
> library, which logs in the same way the Garmin Connect website does. Garmin doesn't
> officially support it, so if Garmin changes their login it may need a library update
> (`pip install -U garminconnect`).

## Setup (once)

**Easiest:** paste this into Terminal. It installs everything (including its own Python,
no admin password needed), logs you in, runs the first sync, adds a **Garmin Dashboard**
app (in Applications, with a shortcut on your Desktop) and opens the dashboard:

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

garmin login     # asks for your Garmin email + password
garmin sync      # first run downloads your whole history; allow ~1 s per workout
garmin dashboard # opens http://127.0.0.1:8765
```

Your password goes in the macOS Keychain and Garmin's login tokens in
`~/.garmin-connector/tokens`, so later syncs don't ask again.

## Everyday use

Click **Garmin Dashboard** on your Desktop, in Applications, or in the Dock (drag it there
to keep it). It starts the dashboard in the background, if it isn't running yet, and opens
it in your browser. It then keeps running quietly until you restart; `garmin dashboard
--stop` stops it. If the app ever goes missing, `bash ~/garmin.connector/scripts/make-mac-app.sh`
makes it again.

Everything else is a command in Terminal. The command is `garmin`; the original, longer
`garmin-connector` still works the same.

| Command | What it does |
| --- | --- |
| `garmin sync` | Pull new activities since the last sync |
| `garmin sync --since 2026-01-01` | Re-pull everything from a date |
| `garmin sync --no-fit` | Summaries only; skip downloading workout files |
| `garmin dashboard` | Open the dashboard (it also has a **Sync now** button); same as clicking the app |
| `garmin dashboard --stop` | Stop a dashboard running in the background |
| `garmin settings` | Show heart-rate settings and where each came from (Garmin, you, estimated) |
| `garmin settings --max-hr 192` | Override a Garmin value (0 = go back to Garmin's) |
| `garmin analyze` | Re-run the analysis on every downloaded workout |
| `garmin backup` | Copy your database to `~/.garmin-connector/backups` now (syncs already do it once a week) |
| `garmin weather` | Look up the weather for workouts that don't have it yet (also happens at every sync; the first time it fills in your whole history) |
| `garmin weather --redo` | Look up every workout's weather again |
| `garmin import-apple export.zip` | Add your Apple Watch workouts from before your Garmin (see below) |
| `garmin hr-check` | Your running heart rate year by year: heart rate at one fixed pace, highest heart rate, and signs of a misreading wrist sensor (`--km` for km paces) |
| `garmin logout` | Forget the saved password and tokens |

Add `--help` to any command (`garmin sync --help`) to see all of its options.

### Apple Watch history (optional)

Ran with an Apple Watch before your Garmin? Bring those workouts in once:

1. On your iPhone: **Health** app → your picture (top right) → **Export All Health Data**.
   It takes a few minutes; AirDrop or save the `export.zip` it makes to your Mac.
2. On the Mac: run the setup line (see [Setup](#setup-once)). It finds the newest
   `export.zip` in Downloads and imports it. The app remembers what it imported, so running
   the setup line again skips it; it reads the file again only for a newer export, or once
   after an update that improves how exports are read. Or import it yourself:
   `garmin import-apple ~/Downloads/export.zip` (add `--if-needed` to skip it when it's
   already in). Once imported, the workouts live in the dashboard, so you can delete the zip.

Runs, rides, walks and hikes from before your first Garmin activity come in with their GPS
route, heart rate, cadence and power, and are analysed like any other workout: zones,
load, efficiency, records, the map, weather. Apple's VO2 max (Cardio Fitness) readings from
then fill in the VO2 max chart. Anything that overlaps an activity already in the dashboard
is skipped, so nothing shows up twice; so is a run two apps recorded at once (say the
Workout app on the watch and a running app on the phone), keeping the better-recorded copy.
Running it again just updates them. To pick the cut-off yourself: `--before 2023-06-01`.
Workouts from the watch are marked "Apple Watch" in the activity list (which can show just
one watch) and on their page, and count on the map with the place you usually ran. Runs
without GPS get the weather where your other runs that month started, but no best efforts
or records: their distance comes from the step counter, too rough to time a fast mile. The
import lists any outdoor runs that came without a GPS route, and why.

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
  (second-by-second data, compressed), `laps`, `activity_metrics`, `vo2max`, `weather`, `settings`.
  While the dashboard or a sync has it open, recent changes sit beside it in `garmin.db-wal`;
  to copy it by hand, copy the whole folder, or run `garmin dashboard --stop` first and copy `garmin.db`
- `backups/`: copies of `garmin.db`, one per day at most, the last 4 kept. A sync makes one
  when the newest is a week old, and `garmin analyze`, `garmin weather --redo` and
  `garmin import-apple` make one before they rewrite anything. To restore, stop the
  dashboard and copy one back over `garmin.db`. The `.fit` files aren't copied: Garmin keeps
  the originals, and a sync downloads any that go missing
- `fit/`: the original `.fit` file for every workout, so nothing is lost even if Garmin
  changes something
- `tokens/`: login tokens (private to your user account)

Your data is only sent to Garmin, to fetch it, with two exceptions: the route map loads
map tiles from OpenStreetMap, so OpenStreetMap sees roughly which area you ran in; the
weather lookup sends Open-Meteo each workout's start point rounded to about a kilometre and
its date (no account, nothing else about you or the run). The dashboard only listens on `127.0.0.1`, so it's reachable only from your Mac, and it
refuses requests that other websites open in your browser could send it (changing settings,
starting a sync, or reading your runs through another web address).

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests use a fake Garmin client and synthetic `.fit` files (written with `fit-tool`),
and never touch a real account.

The pages' code is split by part: Progress and Activities share `overview.js` (state and
helpers), then `today.js`, `charts.js`, `table.js` and `progress.js`, with `start.js` loaded last
to run the page; the workout page is `activity.js` plus `activity-panels.js`, `activity-tables.js`,
`activity-map.js`, `activity-compare.js` and `activity-start.js`. A new file goes in the page's
script tags, before the `start` file.

Chart.js 4.4.1 (MIT) and Leaflet 1.9.4 (BSD-2) are bundled in `src/garmin_connector/static/`,
so everything except the map tiles works offline.
