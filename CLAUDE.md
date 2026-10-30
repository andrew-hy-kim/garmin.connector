# garmin.connector

Pulls my Garmin Connect workouts onto my Mac (second-by-second HR, pace, cadence, elevation) into a local SQLite database and shows them in a running-focused dashboard. README.md describes every feature in detail; read it before larger changes.

## Stack
- Python package (`pyproject.toml`), source in `src/garmin_connector/`, tests in `tests/`.
- Garmin login via the unofficial `garminconnect` library (it can break when Garmin changes their login; fix is usually `pip install -U garminconnect`).
- Dashboard: Flask app (`web.py`) serving the pages in `src/garmin_connector/static/` at http://127.0.0.1:8765. Chart.js and Leaflet are bundled.
- My data lives outside the repo in `~/.garmin-connector/` (garmin.db, fit/, tokens/, sync.log).

## Branch
- Work on `claude/affectionate-bohr-2g8s7y`. It is the main branch for this project: the setup script and updates point at it.

## Commands
- Activate the environment first: `source .venv/bin/activate`
- Install / dev install: `pip install -e ".[dev]"`
- Tests: `pytest` (uses a fake Garmin client and synthetic .fit files; never touches the real account)
- Run the dashboard: `garmin dashboard` (stop with `garmin dashboard --stop`)
- Everyday CLI: `garmin sync`, `garmin analyze`, `garmin settings`, `garmin --help`

## Secrets and data
- Never commit `*.db`, `garmin_tokens.json`, or anything from `~/.garmin-connector/` (already in `.gitignore`).
- Password is in the macOS Keychain; never print, log or paste credentials or tokens.
- Ask before running a real `garmin sync`, `garmin analyze`, `garmin weather --redo` or anything that rewrites my database. Back up `~/.garmin-connector/` before risky data changes.

## How I want you to work
- I'm not a full-time developer. Explain changes in plain language and keep diffs small.
- Run `pytest` after code changes.
- After dashboard changes, start the dashboard and check the page in the browser.
- Keep README.md in sync when features or commands change (same plain, friendly style).
- Commit with clear messages after each working change. Ask before pushing.

## Ideas / backlog
<!-- Add features you want here so every session can see them -->
- 
