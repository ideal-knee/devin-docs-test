#!/usr/bin/env python3
"""
Export macOS Reminders through EventKit and write the Base64 payload to GitHub.

GitHub target (matching the original Shortcut):
  ideal-knee/reminder-data, branch main, file reminders.json

Selection:
  - Every uncompleted reminder that has a due date (no cutoff).
  - Every completed reminder that BOTH has a due date AND was completed in the
    last 90 days.

Requirements (Python 3.9):
  pip install "pyobjc-core==11.1" "pyobjc-framework-Cocoa==11.1" "pyobjc-framework-EventKit==11.1"

Usage:
  export GITHUB_TOKEN='github_pat_...'
  python export_reminders_to_github.py

Useful options:
  python export_reminders_to_github.py --no-completed
  python export_reminders_to_github.py --dry-run --write-json reminders.json
  python export_reminders_to_github.py --repo YOUR_OWNER/YOUR_REPO --path reminders.json --branch main

Token permissions:
  - Fine-grained token: Contents = Read and write for the target repository.
  - Classic token: repo scope for a private repository, or public_repo for a public repository.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import EventKit
except ImportError as exc:
    raise SystemExit(
        "EventKit is not installed for this Python. With Python 3.9, install:\n"
        'pip install "pyobjc-core==11.1" "pyobjc-framework-Cocoa==11.1" '
        '"pyobjc-framework-EventKit==11.1"\n'
        f"Import error: {exc}"
    )

DEFAULT_REPO = "ideal-knee/reminder-data"
DEFAULT_PATH = "reminders.json"
DEFAULT_BRANCH = "main"
COMPLETED_CUTOFF_DAYS = 90
PROGRESS_EVERY = 100
GITHUB_API = "https://api.github.com"


def log(message: str) -> None:
    print(f"[reminders-export] {message}", file=sys.stderr, flush=True)


def fail(message: str) -> None:
    print(f"[reminders-export] ERROR: {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def iso8601(nsdate) -> str:
    if nsdate is None:
        return ""
    seconds = float(nsdate.timeIntervalSince1970())
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def request_reminders_access(store) -> None:
    done = threading.Event()
    result: dict[str, object] = {"granted": False, "error": None}

    def completion(granted, error):
        result["granted"] = bool(granted)
        result["error"] = error
        done.set()

    store.requestFullAccessToRemindersWithCompletion_(completion)
    if not done.wait(60):
        fail("Timed out waiting for macOS Reminders permission.")
    if not result["granted"]:
        fail(f"Reminders permission was not granted: {result['error']}")


def fetch_reminders(store, calendars):
    predicate = store.predicateForRemindersInCalendars_(calendars)
    done = threading.Event()
    result: dict[str, object] = {"reminders": None}

    def completion(reminders):
        result["reminders"] = reminders
        done.set()

    store.fetchRemindersMatchingPredicate_completion_(predicate, completion)
    if not done.wait(300):
        fail("EventKit did not return reminders within five minutes.")
    return list(result["reminders"] or [])


def export_reminders(include_completed: bool) -> dict:
    now = datetime.now(timezone.utc)
    completion_cutoff = now - timedelta(days=COMPLETED_CUTOFF_DAYS)

    log("Requesting Reminders access through EventKit…")
    store = EventKit.EKEventStore.alloc().init()
    request_reminders_access(store)

    calendars = list(store.calendarsForEntityType_(EventKit.EKEntityTypeReminder) or [])
    log(f"Found {len(calendars)} reminder lists.")
    log("Fetching reminders through EventKit…")
    reminders = fetch_reminders(store, calendars)
    log(f"Fetched {len(reminders)} reminders. Filtering and serializing…")

    output = []
    for index, reminder in enumerate(reminders, start=1):
        completed = bool(reminder.isCompleted())
        due_components = reminder.dueDateComponents()
        due_date = due_components.date() if due_components is not None else None
        completed_date = reminder.completionDate()

        include_open_with_due = not completed and due_date is not None
        include_recently_completed_with_due = False
        if include_completed and completed and due_date is not None and completed_date is not None:
            completed_at = datetime.fromtimestamp(
                float(completed_date.timeIntervalSince1970()), tz=timezone.utc
            )
            include_recently_completed_with_due = completed_at > completion_cutoff

        if include_open_with_due or include_recently_completed_with_due:
            calendar = reminder.calendar()
            output.append(
                {
                    "title": str(reminder.title() or ""),
                    "list": str(calendar.title() if calendar is not None else ""),
                    "notes": str(reminder.notes() or ""),
                    "created": iso8601(reminder.creationDate()),
                    "due": iso8601(due_date),
                    "completed_at": iso8601(completed_date),
                    "priority": int(reminder.priority()),
                    "flagged": False,
                    "completed": completed,
                }
            )

        if index % PROGRESS_EVERY == 0:
            log(f"Scanned {index}/{len(reminders)}; selected {len(output)}.")

    log(f"Finished: scanned {len(reminders)} reminders; exported {len(output)}.")
    return {
        "version": 2,
        "source": "eventkit",
        "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "reminders": output,
    }


def github_request(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "reminders-eventkit-export",
    }
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response_body = response.read()
            return response.status, json.loads(response_body.decode("utf-8")) if response_body else None
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        fail(f"GitHub API returned HTTP {exc.code}: {error_body}")
    except urllib.error.URLError as exc:
        fail(f"Could not reach GitHub API: {exc.reason}")


def update_github_file(repo: str, path: str, branch: str, token: str, encoded_payload: str, reminder_count: int) -> None:
    escaped_path = "/".join(urllib.parse.quote(piece, safe="") for piece in path.split("/"))
    endpoint = f"{GITHUB_API}/repos/{repo}/contents/{escaped_path}"
    get_url = endpoint + "?ref=" + urllib.parse.quote(branch, safe="")

    log(f"Getting current GitHub file SHA: {repo}/{path} on {branch}…")
    status, existing = github_request("GET", get_url, token)
    if status != 200 or not existing or "sha" not in existing:
        fail("GitHub did not return a SHA for the existing file; refusing to overwrite without it.")

    update_body = {
        "message": f"Update reminders export ({reminder_count} reminders)",
        "content": encoded_payload,
        "sha": existing["sha"],
        "branch": branch,
    }
    log(f"Updating GitHub file: {repo}/{path} on {branch}…")
    status, response = github_request("PUT", endpoint, token, update_body)
    if status not in (200, 201):
        fail(f"Unexpected GitHub update result: HTTP {status}")

    commit_sha = ((response or {}).get("commit") or {}).get("sha", "unknown")
    log(f"GitHub update succeeded. Commit: {commit_sha}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Reminders via EventKit and update a GitHub file.")
    parser.add_argument("--repo", default=os.getenv("GITHUB_REPO", DEFAULT_REPO), help="owner/repository")
    parser.add_argument("--path", default=os.getenv("GITHUB_PATH", DEFAULT_PATH), help="repository file path")
    parser.add_argument("--branch", default=os.getenv("GITHUB_BRANCH", DEFAULT_BRANCH), help="branch name")
    parser.add_argument("--token-env", default="GITHUB_TOKEN", help="environment variable containing the GitHub token")
    parser.add_argument("--no-completed", action="store_true", help="exclude completed reminders")
    parser.add_argument("--dry-run", action="store_true", help="export only; do not call GitHub")
    parser.add_argument("--write-json", metavar="FILE", help="also write unencoded JSON to FILE")
    args = parser.parse_args()

    payload = export_reminders(include_completed=not args.no_completed)
    json_bytes = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded_payload = base64.b64encode(json_bytes).decode("ascii")

    if args.write_json:
        Path(args.write_json).write_bytes(json_bytes + b"\n")
        log(f"Wrote readable JSON to {args.write_json}.")

    if args.dry_run:
        log("Dry run: GitHub was not changed.")
        print(encoded_payload)
        return 0

    token = os.getenv(args.token_env)
    if not token:
        fail(f"Set {args.token_env} before running, e.g. export {args.token_env}='github_pat_…'")

    update_github_file(args.repo, args.path, args.branch, token, encoded_payload, len(payload["reminders"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
