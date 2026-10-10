"""Command line: ``garmin login | sync | dashboard | logout``."""

from __future__ import annotations

import argparse
import logging
import sys
import webbrowser
import zipfile
from contextlib import closing
from datetime import date
from xml.etree import ElementTree

from . import apple, auth, config, db, export, hrcheck, processing, sync, weather


def _day(text: str) -> date:
    """A date typed as YYYY-MM-DD, with a plain message when it isn't one."""
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"'{text}' isn't a date; write it as YYYY-MM-DD, e.g. 2026-01-31")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="garmin", description="Pull your Garmin Connect activities into a local database."
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="show detailed logging")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="log in to Garmin Connect and remember the login")
    sub.add_parser("logout", help="forget the saved password and tokens")

    p_sync = sub.add_parser("sync", help="pull new activities into the local database")
    p_sync.add_argument("--since", type=_day, help="re-sync from this date (YYYY-MM-DD)")
    p_sync.add_argument("--no-fit", action="store_true", help="skip downloading .fit files (summaries only)")
    p_sync.add_argument("--no-export", action="store_true", help="don't update the phone app's data file")

    p_export = sub.add_parser("export", help="write the data file for the phone app (iCloud Drive by default)")
    p_export.add_argument("--to", help="folder to write to (default: iCloud Drive/Garmin Dashboard)")

    p_phone = sub.add_parser("phone-updates", help="automatic updates for the phone app (encrypted, via GitHub)")
    p_phone.add_argument("action", choices=["on", "off", "status", "now"], nargs="?", default="status",
                         help="on: set up; off: stop and forget the token; now: upload right away")

    sub.add_parser("analyze", help="re-run the analysis on every downloaded activity")
    p_hrc = sub.add_parser("hr-check", help="your running heart rate year by year, to spot sensor trouble")
    p_hrc.add_argument("--km", action="store_true", help="paces per km (default: per mile)")
    p_apple = sub.add_parser("import-apple", help="import your Apple Watch workouts from an Apple Health export")
    p_apple.add_argument("path", help="export.zip from the Health app (or the unzipped folder)")
    p_apple.add_argument("--before", type=_day,
                         help="only workouts before this date (YYYY-MM-DD); default: your first Garmin activity")
    p_weather = sub.add_parser("weather", help="look up the weather for workouts that don't have it yet")
    p_weather.add_argument("--redo", action="store_true", help="look up every workout again")
    sub.add_parser("set-api-key", help="save an Anthropic API key for 'Ask Claude' reviews (macOS Keychain)")
    sub.add_parser("remove-api-key", help="forget the saved Anthropic API key")

    p_set = sub.add_parser("settings", help="show or change heart-rate settings used for zones and load")
    p_set.add_argument("--max-hr", type=float, help="your max heart rate (0 = use Garmin's / estimate)")
    p_set.add_argument("--resting-hr", type=float, help="your resting heart rate (0 = use Garmin's / default)")
    p_set.add_argument("--lthr", type=float, help="lactate-threshold heart rate (0 = use Garmin's)")

    p_dash = sub.add_parser("dashboard", help="open the dashboard in your browser")
    p_dash.add_argument("--port", type=int, default=8765)
    p_dash.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    p_dash.add_argument("--stop", action="store_true", help="stop a dashboard running in the background")

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
    elif args.command == "hr-check":
        with closing(db.connect(config.db_path())) as conn:
            hrcheck.print_report(conn, "km" if args.km else "mi")
    elif args.command == "import-apple":
        with closing(db.connect(config.db_path())) as conn:
            print("Reading your Apple Health export (a big one takes a minute or two)…")
            try:
                r = apple.import_export(conn, args.path, before=args.before.isoformat() if args.before else None)
            except zipfile.BadZipFile:
                raise SystemExit("That file isn't a zip, or it's damaged. Export it again from the Health app "
                                 "(your picture → Export All Health Data) and use the export.zip it makes.")
            except ElementTree.ParseError as err:
                raise SystemExit(f"The export.xml inside is cut short or damaged ({err}). Export it again from "
                                 "the Health app; if it was unzipped, use the original export.zip instead.")
            except FileNotFoundError:
                raise SystemExit(f"There's no file at {args.path}. Check the name; Finder can drag the file into "
                                 "Terminal to type its full path for you.")
            except (ValueError, OSError) as err:
                raise SystemExit(f"Couldn't read the export: {err}")
            print(f"Imported {r['imported']} workouts"
                  + (f" ({r['with_route']} with a GPS map" + (f", {r['no_route']} outdoors without one" if r["no_route"] else "") + ")"
                     if r["with_route"] or r["no_route"] else "")
                  + (f"; skipped {r['skipped']} already in the dashboard" if r["skipped"] else "")
                  + (f"; {r['duplicates']} recorded twice (by two apps), kept once" if r["duplicates"] else "")
                  + (f"; {r['vo2max']} VO2 max readings" if r["vo2max"] else "") + ".")
            if r["no_route"]:
                why = {"none": "the export has no route for them", "missing": "their route file isn't in the zip",
                       "times": "their route's times don't match the workout", "unreadable": "their route file couldn't be read"}
                for k, n in r["why_no_route"].items():
                    print(f"  {n} without a map because {why.get(k, k)}")
                days = r["no_route_days"]
                print("  For example: " + "; ".join(days[:8]) + (f" (and {len(days) - 8} more)" if len(days) > 8 else ""))
            print("Analyzing…")
            processing.refresh(conn)
            weather.update_quietly(conn)
            export.write_quietly(conn)
            print("Done. They're in the dashboard alongside your Garmin runs.")
    elif args.command == "weather":
        with closing(db.connect(config.db_path())) as conn:
            print("Looking up the weather (the first time covers your whole history; usually under a minute)…")
            r = weather.update(conn, redo=args.redo)
            print(f"Weather added for {r['weather']} workouts"
                  + (f"; {r['indoor']} indoor" if r["indoor"] else "")
                  + (f"; {r['no_gps']} without GPS" if r["no_gps"] else "")
                  + (f"; {r['missing']} not available yet" if r["missing"] else "") + ".")
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
    elif args.command == "phone-updates":
        import requests

        from . import publish
        try:
            phone_updates(args.action)
        except publish.GitHubError as err:
            raise SystemExit(str(err))
        except requests.RequestException as err:
            raise SystemExit(f"Couldn't reach GitHub: {err}")
    elif args.command == "dashboard":
        dashboard(args.port, browser=not args.no_browser, stop=args.stop)


def _running(url: str) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(url + "/", timeout=2):
            return True
    except OSError:
        return False


def _is_dashboard(pid: int) -> bool:
    """Whether that process is a dashboard, not some later process that got the same ID."""
    import subprocess

    try:
        cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout
    except OSError:
        return False
    return "garmin" in cmd and "dashboard" in cmd


def dashboard(port: int, browser: bool = True, stop: bool = False) -> None:
    """Run the dashboard; or, if one is already running (say, started from the Garmin Dashboard
    app), just open it. Its process ID goes in dashboard.pid so `--stop` can find it."""
    import os
    import signal

    pid_file = config.home_dir() / "dashboard.pid"
    if stop:
        try:
            pid = int(pid_file.read_text())
        except (OSError, ValueError):
            pid = None
        if pid and _is_dashboard(pid):
            os.kill(pid, signal.SIGTERM)
            print("Dashboard stopped.")
        else:
            print("No dashboard is running in the background.")
        pid_file.unlink(missing_ok=True)
        return
    url = f"http://127.0.0.1:{port}"
    if _running(url):
        if browser:
            webbrowser.open(url)
        print(f"The dashboard is already running at {url}.")
        return
    from .web import create_app

    pid_file.write_text(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # so the cleanup below runs
    if browser:
        webbrowser.open(url)
    print(f"Dashboard running at {url} (Ctrl+C to stop)")
    try:
        # Bound to 127.0.0.1 so it's only reachable from this Mac.
        create_app().run(host="127.0.0.1", port=port)
    finally:
        pid_file.unlink(missing_ok=True)


def phone_updates(action: str) -> None:
    import getpass

    from . import publish

    with closing(db.connect(config.db_path())) as conn:
        cfg = publish.settings(conn)
        if action == "status":
            if cfg:
                print(f"Automatic phone updates are on: encrypted data goes to the '{publish.BRANCH}' branch of "
                      f"{cfg['repo']} after each sync.\nPhone app: {publish.phone_url(cfg['repo'])}")
            else:
                print("Automatic phone updates are off. Turn them on with: garmin phone-updates on")
        elif action == "off":
            publish.clear_settings(conn)
            print("Automatic phone updates are off; the token and passphrase were removed from your Keychain.\n"
                  "To also remove the uploaded (encrypted) data, delete the 'phone-data' branch on GitHub.")
        elif action == "now":
            if not cfg:
                raise SystemExit("Automatic phone updates aren't set up. Run: garmin phone-updates on")
            publish.publish(conn, export.write(conn), force=True)
            print("Uploaded. The phone app picks it up the next time you open it.")
        else:  # on
            print("The phone app runs on GitHub Pages, so your Mac uploads an encrypted copy of its data there\n"
                  "after each sync, and the app downloads it when you open it. Without your passphrase the\n"
                  "file is unreadable.\n")
            repo = publish.repo_from_git() or input("GitHub repository of the phone app (owner/name): ").strip()
            print(f"Repository: {repo}\n")
            print("1. Make a GitHub token that can change only this repository:\n"
                  "   https://github.com/settings/personal-access-tokens/new\n"
                  f"   Repository access: Only select repositories → {repo}\n"
                  "   Permissions → Repository permissions → Contents: Read and write\n"
                  "   Generate it and copy it.")
            token = getpass.getpass("   Paste the token (hidden): ").strip()
            publish.check_access(repo, token)
            print("\n2. Pick a passphrase. You'll type it once on your phone. Use a few unrelated words\n"
                  "   (at least 12 characters): the encrypted file is public, so the passphrase is what protects it.")
            while True:
                passphrase = getpass.getpass("   Passphrase (hidden): ")
                if len(passphrase) < 12:
                    print("   At least 12 characters, please.")
                elif getpass.getpass("   Again: ") != passphrase:
                    print("   Those didn't match.")
                else:
                    break
            publish.save_settings(conn, repo, token, passphrase)
            print("\nUploading your data…")
            publish.publish(conn, export.write(conn), force=True)
            print(f"Done. On your phone, open {publish.phone_url(repo)} and tap 'Turn on automatic updates',\n"
                  "then enter the passphrase. From then on it updates by itself after each sync.")


if __name__ == "__main__":
    main()
