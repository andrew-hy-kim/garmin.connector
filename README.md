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
the coach eases off workout suggestions and mileage warnings while you rebuild.

**Your next workouts:** at the top of the coach notes, your next 3, 5 or 7 sessions, each with
a date, length, how to run it, HR/pace target and why it was picked. They're built from your last 8 weeks:
the days you usually run, your usual long-run day and lengths, and the hard sessions you do
(on your usual days, rotated and gently progressed), with hard days 48 hours apart, never the
day before the long run, and none while you're overreaching or early in a comeback.

**Coach notes:** feedback on each workout and on your training overall (easy days drifting
too hard, HR drift, rep pacing, efficiency vs. your usual, 80/20 balance, mileage jumps,
ramp rate, new bests, interval reps against the pace they're meant for, heat and air quality,
and how you're building back after a break of 3+ weeks), worked out
on your Mac. Optionally, **Ask Claude** for a written
coach's review (see below).

The dashboard has four tabs: **Today**, **Progress**, **Activities** and **Map**
(the same tabs sit at the bottom of the screen on a phone).

**Today**: how you're doing and what to do now
- **Readiness:** fresh / balanced / building / tired from your form, with base and fatigue,
  how many easy days until you're fresh, and the most training load you can do today and stay
  balanced, next to today's suggested session (or the next one). It's all
  worked out from your workouts, so it doesn't need the watch worn day and night.
- **Latest run:** distance, time, pace, heart rate, load and effective VO2max, its route, and
  its coach notes
- This week / month / year (each opens its runs), coach notes with the workouts after today's
  and your biggest opportunity to improve, and your recent activities

**Progress**: how you're trending (a 3M / 6M / 1Y / 2Y / 5Y / All switch sets the range)
- **Progress status:** one word, like Readiness on Today: *Improving*, *Edging up*, *Holding
  steady*, *Slipping* or *Rebuilding* (after a break). It weighs four signals over fixed windows,
  whatever range the charts show: VO2max shape over 4 weeks, heart rate at your usual pace and
  easy-run efficiency (the last 4 weeks against the 8 before), and training load against 4 weeks
  ago; hot or humid runs are left out, so summer doesn't read as slipping. Next to it, the one
  step that would help most, from *Where to improve*
- **Running fitness**, the way [RUNALYZE](https://runalyze.com) does it:
  - **VO2max shape:** an effective VO2max from every run's pace and heart rate (Daniels &
    Gilbert), averaged over 30 days and weighted by duration. Races marked in Garmin
    calibrate it. It's charted next to your watch's VO2 max.
  - **Marathon shape:** whether your training has the endurance long races need. Weekly
    distance over 6 months counts two thirds, long runs over 13 km in the last 10 weeks one
    third, against targets that grow with your VO2max.
- **Where to improve:** your last three months area by area (consistency, endurance, easy vs.
  hard, workouts, aerobic efficiency), each marked *work on*, *fine* or *strength*,
  with what to work on first and a concrete next step using your own paces and distances
- **Base, fatigue & form** in plain language: *base* is your training load built up over about
  6 weeks (what other apps call "fitness"; your actual running fitness is VO2max shape), plus
  **monotony** and **training strain** (Foster) for the last 7 days, what resting would do, and
  your base now vs. earlier
- **Race predictor** at the record distances (400 m to marathon), from VO2max shape, with
  Garmin's prediction (saved at each sync) and the change over three months. Long races that
  your endurance doesn't support yet show two times: what you'd run today, and what your speed
  supports once weekly distance and long runs catch up. Click a row for your fastest recent
  stretch at that distance.
- **Training paces** (easy, marathon, threshold, interval, repetition) from your VO2max shape,
  folded away under one summary line; marathon pace is your potential, with today's marathon
  pace noted when endurance holds it back
- Weekly distance, easy vs. hard running, **aerobic efficiency** (distance per heartbeat on
  easy runs) and **long runs** (your longest each week against the long-run threshold and your
  marathon target). Each chart leads with its headline number, and a click on a week opens its
  runs.
- **Heart rate at a fixed pace:** your heart rate while running steadily at one pace (adjusted
  for hills), run by run with a 30-day average. The same pace at a lower heart rate is the
  plainest sign of getting fitter. Hot or humid runs show as orange triangles and are left out of the
  30-day average (on the efficiency chart too), so a summer heatwave doesn't read as lost fitness. Pick the pace from the card (it starts at the pace you run
  most); only steady stretches count, from five minutes in and two minutes after any change of
  pace, and run/walk runs and runs where the heart rate locked onto your cadence are left out
- **Running form:** cadence, stride length, ground contact time and vertical ratio on easy runs
  (whichever your watch records), each run plus a 30-day average, so you see your form change
  over months
- **Statistics** by year, month or week: runs, distance, time, pace, heart rate, climb, longest
  run and VO2max. Click a row to list its runs. Above it, a year-to-date chart of this year's
  distance against last year and your best year: ahead or behind by this date, and what
  you're on pace for.
- **Personal records** from the fastest stretch of any outdoor run (all-time and within the
  range) and milestones (longest run, biggest week and month)
- **Shoes:** distance on each pair from your gear in Garmin Connect, against its limit (or
  500 miles), with how much you've run in it this month. A coach note warns when a pair you're
  still using passes 85%. Each workout shows the shoes it was run in.
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
  drift on a hot day, a hard run in poor air), and Claude reviews get it too
- **Your recent sessions of the same kind** (intervals, tempo, threshold, long runs…): for interval
  sessions the reps (6 × 3:00), rep pace and rep heart rate; for steady ones distance, pace and
  heart rate, with how this session compares with your previous three
- **Same route:** your other runs along the same line, start to finish, with time, pace, heart
  rate and efficiency, how this one ranks against runs of the same kind, and your route record
- Training load and Garmin's training effect (with what it means: maintaining, improving…),
  HR drift, efficiency, effective VO2max and your heart rate at the pace picked on Progress
  against your runs the month before; under **More from your watch**, calories, power,
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

**Wrist vs. arm band:** each workout records whether an external HR sensor was connected.
Wrist HR is cleaned of one-second spikes and dropouts, and runs where the wrist sensor
locked onto your cadence are flagged and left out of max-HR and efficiency estimates.

> Uses the unofficial [`garminconnect`](https://github.com/cyberjunky/python-garminconnect)
> library, which logs in the same way the Garmin Connect website does. Garmin doesn't
> officially support it, so if Garmin changes their login it may need a library update
> (`pip install -U garminconnect`).

**On your iPhone:** a home-screen version of the dashboard that works offline. Your Mac
writes one data file to iCloud Drive after every sync; the phone app imports it and keeps
it on the phone. See [On your iPhone](#on-your-iphone).

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
| `garmin export` | Write the phone app's data file now (also happens after every sync) |
| `garmin weather` | Look up the weather for workouts that don't have it yet (also happens at every sync; the first time it fills in your whole history) |
| `garmin weather --redo` | Look up every workout's weather again |
| `garmin import-apple export.zip` | Add your Apple Watch workouts from before your Garmin (see below) |
| `garmin hr-check` | Your running heart rate year by year: heart rate at one fixed pace, highest heart rate, and signs of a misreading wrist sensor (`--km` for km paces) |
| `garmin logout` | Forget the saved password and tokens |

### Apple Watch history (optional)

Ran with an Apple Watch before your Garmin? Bring those workouts in once:

1. On your iPhone: **Health** app → your picture (top right) → **Export All Health Data**.
   It takes a few minutes; AirDrop or save the `export.zip` it makes to your Mac.
2. On the Mac: `garmin import-apple ~/Downloads/export.zip`

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

### Ask Claude (optional)

The coach notes work without this. For a written coach's review of a workout or of your
recent training, add an [Anthropic API key](https://console.anthropic.com/) once:

```bash
garmin set-api-key     # stored in your macOS Keychain
```

Then click **Ask Claude** in the dashboard. Only then is a summary of your training sent to
Anthropic: workout tags, distances, paces, heart rate, load and the coach notes. No GPS
data is sent. Each review costs a few cents and is saved, so reopening it is free.
`garmin remove-api-key` turns it off.

### Updating

Rerun the setup line. It updates the app, skips the login if you're logged in, syncs, and
opens the dashboard.

## On your iPhone

The phone app is the same dashboard (overview, workouts, suggested workouts, coach notes and
saved Claude reviews) as a home-screen app. It's **view-only**: syncing, changing settings
and asking Claude happen on the Mac. It works offline; only the route map's
background needs a connection.

**How it works:** after every sync (including the daily automatic one), your Mac writes
`garmin-dashboard.data` to **iCloud Drive → Garmin Dashboard**. The phone app imports that
file and stores it on the phone. The app's code is served by GitHub Pages. Your data only
goes there if you turn on automatic updates (below), and then only encrypted.

### One-time setup

1. **Turn on GitHub Pages** for this repository: on GitHub, open the repo → **Settings** →
   **Pages** → under *Build and deployment*, Source: **Deploy from a branch**, Branch:
   **claude/affectionate-bohr-2g8s7y**, folder: **/docs** → **Save**. After a minute the app
   is at **https://andrew-hy-kim.github.io/garmin.connector/**
2. **On your Mac**, make sure iCloud Drive is on (System Settings → your name → iCloud →
   iCloud Drive), update the app by rerunning the setup line, and let it sync. It prints
   `Phone app data updated: …/Garmin Dashboard/garmin-dashboard.data`.
3. **On your iPhone**, open the link above in **Safari**, tap **Share** → **Add to Home
   Screen** → **Add**.
4. Open **Running** from your home screen (not from Safari: the home-screen app keeps its
   own copy of the data), tap **Import data**, then **Browse** → **iCloud Drive** →
   **Garmin Dashboard** → **garmin-dashboard.data**. The first import takes a few seconds.

### Everyday

After your Mac syncs, tap **Update** at the top of the phone app and pick the same file
again. The bar shows how old the data on the phone is. Or let it update by itself:

### Automatic updates

```bash
garmin phone-updates on
```

It walks you through two things: a GitHub token that can change only this repository
(Contents: read and write), and a passphrase you pick. From then on, after every sync your
Mac encrypts the phone app's data with that passphrase (AES-256) and uploads it to the
`phone-data` branch of this repository, replacing the previous copy. On the phone, tap
**Auto-update** at the top (or, on a new phone, it's offered right away) and enter the
passphrase once. Each time you open the app it checks for new data and loads it.

- The repository is public, so the encrypted file is too: the passphrase is what keeps it
  private. Use a few unrelated words. The token and passphrase stay in your Mac's Keychain;
  the phone keeps only the key derived from the passphrase.
- Change the passphrase by running `phone-updates on` again; the phone asks for the new one.
- `garmin phone-updates status` shows whether it's on; `… now` uploads right
  away; `… off` stops it and removes the token and passphrase (delete the `phone-data`
  branch on GitHub to remove the uploaded file too).
- Combined with the daily sync below, the phone stays current without touching the Mac.

- No iCloud Drive? Run `garmin export --to ~/Desktop` and AirDrop the file to
  your phone (save it to Files), then import it.
- Needs iOS 16.4 or later.
- Removing the app from your home screen deletes its copy of the data; just import again.

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
  to back up, copy the whole folder, or run `garmin dashboard --stop` first and copy `garmin.db`
- `fit/`: the original `.fit` file for every workout, so nothing is lost even if Garmin
  changes something
- `tokens/`: login tokens (private to your user account)
- The phone app's copy: `iCloud Drive/Garmin Dashboard/garmin-dashboard.data` (summaries,
  analysis and 5-second workout data, about 10–15 MB for several years of running)

Your data is only sent to Garmin, to fetch it, with four exceptions: the route map loads
map tiles from OpenStreetMap, so OpenStreetMap sees roughly which area you ran in; the
weather lookup sends Open-Meteo each workout's start point rounded to about a kilometre and
its date (no account, nothing else about you or the run); if you
set up **Ask Claude**, a training summary goes to Anthropic each time you click it; and the
phone app's data file is stored in your own iCloud Drive. The dashboard only listens on `127.0.0.1`, so it's reachable only from your Mac, and it
refuses requests that other websites open in your browser could send it (changing settings,
starting a sync or a Claude review, or reading your runs through another web address).

## Development

```bash
pip install -e ".[dev]"
pytest
```

Tests use a fake Garmin client and synthetic `.fit` files (written with `fit-tool`),
and never touch a real account.

The phone app in `docs/` is built from `src/garmin_connector/static/`. After changing the
pages, rebuild it (a test checks that `docs/` is up to date):

```bash
python -m garmin_connector.phone_build docs
```

Chart.js 4.4.1 (MIT) and Leaflet 1.9.4 (BSD-2) are bundled in `src/garmin_connector/static/`,
so everything except the map tiles works offline.
