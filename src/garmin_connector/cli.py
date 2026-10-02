"""Command line: ``garmin-connector login | sync | dashboard | logout``."""

from __future__ import annotations

import argparse
import logging
import webbrowser
from contextlib import closing
from datetime import date

from . import auth, config, db, export, processing, sync


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
    p_sync.add_argument("--no-fit", action="store_true", help="skip downloading .fit files (summaries only)")
    p_sync.add_argument("--no-export", action="store_true", help="don't update the phone app's data file")

    p_export = sub.add_parser("export", help="write the data file for the phone app (iCloud Drive by default)")
    p_export.add_argument("--to", help="folder to write to (default: iCloud Drive/Garmin Dashboard)")

    sub.add_parser("analyze", help="re-run the analysis on every downloaded activity")
    sub.add_parser("set-api-key", help="save an Anthropic API key for 'Ask Claude' reviews (macOS Keychain)")
    sub.add_parser("remove-api-key", help="forget the saved Anthropic API key")

    p_set = sub.add_parser("settings", help="show or change heart-rate settings used for zones and load")
    p_set.add_argument("--max-hr", type=float, help="your max heart rate (0 = use Garmin's / estimate)")
    p_set.add_argument("--resting-hr", type=float, help="your resting heart rate (0 = use Garmin's / default)")
    p_set.add_argument("--lthr", type=float, help="lactate-threshold heart rate (0 = use Garmin's)")

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
            result = sync.sync(auth.get_client(), conn, since=args.since, download_fit=not args.no_fit)
            print(
                f"Synced {result['activities']} activities, {result['vo2max_readings']} VO2 max readings, "
                f"{result['fit_files']} new .fit files; analyzed {result['analyzed']} activities."
            )
            if not args.no_export:
                path = export.write_quietly(conn)
                if path:
                    print(f"Phone app data updated: {path}")
    elif args.command == "export":
        with closing(db.connect(config.db_path())) as conn:
            path = export.write(conn, args.to)
        print(f"Wrote {path} ({path.stat().st_size / 1e6:.1f} MB). Import it in the phone app.")
    elif args.command == "analyze":
        with closing(db.connect(config.db_path())) as conn:
            sync.import_missing_streams(conn)
            print(f"Analyzed {processing.refresh(conn, force=True)} activities.")
            export.write_quietly(conn)
    elif args.command == "set-api-key":
        import getpass

        from . import ai

        key = getpass.getpass("Anthropic API key (input hidden): ").strip()
        if not key:
            raise SystemExit("No key entered.")
        ai.set_api_key(key)
        print("Saved to your macOS Keychain. 'Ask Claude' is now available in the dashboard.")
    elif args.command == "remove-api-key":
        from . import ai

        ai.remove_api_key()
        print("Anthropic API key removed.")
    elif args.command == "settings":
        with closing(db.connect(config.db_path())) as conn:
            changes = {"max_hr": args.max_hr, "resting_hr": args.resting_hr, "lthr": args.lthr}
            for key, value in changes.items():
                if value is not None:
                    db.set_setting(conn, key, value or None)
            if any(v is not None for v in changes.values()):
                processing.refresh(conn)
            current = processing.effective_settings(conn)
            if any(v is not None for v in changes.values()):
                export.write_quietly(conn)
        for key, label in (("max_hr", "Max HR"), ("resting_hr", "Resting HR"), ("lthr", "Threshold HR")):
            value = current[key]
            source = current["sources"][key]
            note = {"you": " (set by you)", "garmin": " (from Garmin)", "estimated": " (estimated)",
                    "default": " (default)"}.get(source, "")
            print(f"{label}: {round(value) if value else 'not set'}{note}")
        if current["zone_floors"]:
            print("Zones: from Garmin, lower bounds " + ", ".join(str(f) for f in current["zone_floors"]))
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
