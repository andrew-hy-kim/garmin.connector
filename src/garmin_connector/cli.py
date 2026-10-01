"""Command line: ``garmin-connector login | sync | dashboard | logout``."""

from __future__ import annotations

import argparse
import logging
import webbrowser
from contextlib import closing
from datetime import date

from . import auth, config, db, sync


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="garmin-connector", description="Pull your Garmin Connect activities into a local database."
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="show detailed logging")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="log in to Garmin Connect and remember the login")
    sub.add_parser("logout", help="forget the saved password and tokens")

    p_sync = sub.add_parser("sync", help="pull new activities into the local database")
    p_sync.add_argument("--since", type=date.fromisoformat, help="re-sync from this date (YYYY-MM-DD)")
    p_sync.add_argument("--fit", action="store_true", help="also download the original .fit files")

    p_dash = sub.add_parser("dashboard", help="open the dashboard in your browser")
    p_dash.add_argument("--port", type=int, default=8765)
    p_dash.add_argument("--no-browser", action="store_true", help="don't open a browser tab")

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if args.command == "login":
        auth.login_interactive()
        print(f"Logged in. Data will be stored in {config.home_dir()}")
    elif args.command == "logout":
        auth.logout()
        print("Saved password and tokens removed.")
    elif args.command == "sync":
        with closing(db.connect(config.db_path())) as conn:
            result = sync.sync(auth.get_client(), conn, since=args.since, download_fit=args.fit)
        print(
            f"Synced {result['activities']} activities, {result['vo2max_readings']} VO2 max readings"
            + (f", {result['fit_files']} FIT files" if args.fit else "")
            + "."
        )
    elif args.command == "dashboard":
        from .web import create_app

        url = f"http://127.0.0.1:{args.port}"
        if not args.no_browser:
            webbrowser.open(url)
        print(f"Dashboard running at {url} (Ctrl+C to stop)")
        # Bound to 127.0.0.1 so it's only reachable from this Mac.
        create_app().run(host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
