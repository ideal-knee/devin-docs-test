#!/usr/bin/env python3
"""
Export macOS Reminders through EventKit and write the Base64 YAML payload to GitHub.

GitHub target:
  ideal-knee/reminder-data, branch main, file reminders.yaml

Selection:
  - Every uncompleted reminder that has a due date (no cutoff).
  - Every completed reminder that BOTH has a due date AND was completed in the
    last 90 days.

Requirements (Python 3.9):
  python3 -m venv .venv
  .venv/bin/pip install -r reminders/requirements.txt

Usage:
  .venv/bin/python reminders/export_reminders_to_github.py --token-keychain reminders-export

Keychain setup:
  security add-generic-password -s reminders-export -a github-token -w YOUR_WRITE_TOKEN

Useful options:
  .venv/bin/python reminders/export_reminders_to_github.py --no-completed
  .venv/bin/python reminders/export_reminders_to_github.py --dry-run --write-yaml reminders.yaml
  .venv/bin/python reminders/export_reminders_to_github.py --repo YOUR_OWNER/YOUR_REPO --path reminders.yaml --branch main

Token permissions:
  - Fine-grained token: Contents = Read and write for the target repository.
  - Classic token: repo scope for a private repository, or public_repo for a public repository.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import yaml
except ImportError as exc:
    raise SystemExit(
        "PyYAML is not installed for this Python. Install it with:\n"
        "  .venv/bin/pip install pyyaml\n"
        f"Import error: {exc}"
    )

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
DEFAULT_PATH = "reminders.yaml"
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

    output.sort(
        key=lambda reminder: (
            reminder["list"],
            reminder["due"],
            reminder["title"],
            reminder["created"],
            reminder["completed_at"],
        )
    )

    log(f"Finished: scanned {len(reminders)} reminders; exported {len(output)}.")
    return {
        "version": 2,
        "source": "eventkit",
        "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "reminders": output,
    }


def github_request(
    method: str,
    url: str,
    token: str,
    body: dict | None = None,
    ok_statuses: tuple[int, ...] = (200, 201),
) -> tuple[int, dict | None]:
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
        if exc.code not in ok_statuses:
            error_body = exc.read().decode("utf-8", errors="replace")
            fail(f"GitHub API returned HTTP {exc.code}: {error_body}")
        try:
            error_body = exc.read().decode("utf-8", errors="replace")
            return exc.code, json.loads(error_body) if error_body else None
        except Exception:
            return exc.code, None
    except urllib.error.URLError as exc:
        fail(f"Could not reach GitHub API: {exc.reason}")


def canonical_reminders_bytes(payload: dict) -> bytes:
    """Stable comparison representation that ignores generated_at."""
    return json.dumps(
        payload["reminders"],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def decode_github_file_content(existing: dict) -> bytes:
    """Decode the Base64 content returned by GitHub's Contents API."""
    content = existing.get("content")
    encoding = existing.get("encoding")

    if not content or encoding != "base64":
        fail("GitHub did not return Base64 content for the existing reminders file.")

    try:
        return base64.b64decode(content)
    except Exception as exc:
        fail(f"Could not decode existing GitHub file content: {exc}")


def existing_reminders_digest(existing_file_bytes: bytes) -> str:
    """Return a stable digest of the existing reminders array."""
    try:
        existing_payload = yaml.safe_load(existing_file_bytes.decode("utf-8"))
        return hashlib.sha256(
            canonical_reminders_bytes(existing_payload)
        ).hexdigest()
    except Exception as exc:
        fail(f"Existing GitHub file is not valid reminders YAML: {exc}")


def update_github_file(
    repo: str,
    path: str,
    branch: str,
    token: str,
    encoded_payload: str,
    payload: dict,
) -> bool:
    escaped_path = "/".join(
        urllib.parse.quote(piece, safe="")
        for piece in path.split("/")
    )
    endpoint = f"{GITHUB_API}/repos/{repo}/contents/{escaped_path}"
    get_url = endpoint + "?ref=" + urllib.parse.quote(branch, safe="")

    log(f"Getting current GitHub file: {repo}/{path} on {branch}…")
    status, existing = github_request("GET", get_url, token, ok_statuses=(200, 404))

    local_digest = hashlib.sha256(
        canonical_reminders_bytes(payload)
    ).hexdigest()

    if status == 404:
        update_body = {
            "message": (
                f"Create reminders export "
                f"({len(payload['reminders'])} reminders)"
            ),
            "content": encoded_payload,
            "branch": branch,
        }
        log(f"Creating GitHub file: {repo}/{path} on {branch}…")
        status, response = github_request("PUT", endpoint, token, update_body)
        if status not in (200, 201):
            fail(f"Unexpected GitHub create result: HTTP {status}")
        commit_sha = ((response or {}).get("commit") or {}).get(
            "sha", "unknown"
        )
        log(f"GitHub create succeeded. Commit: {commit_sha}")
        return True

    if status != 200 or not existing or "sha" not in existing:
        fail(
            "GitHub did not return a SHA for the existing file; "
            "refusing to overwrite without it."
        )

    remote_file_bytes = decode_github_file_content(existing)
    remote_digest = existing_reminders_digest(remote_file_bytes)

    if local_digest == remote_digest:
        log(
            "No reminder changes detected; GitHub was not updated. "
            f"Content digest: {local_digest}"
        )
        return False

    update_body = {
        "message": (
            f"Update reminders export "
            f"({len(payload['reminders'])} reminders)"
        ),
        "content": encoded_payload,
        "sha": existing["sha"],
        "branch": branch,
    }

    log(
        "Reminder changes detected; updating GitHub file: "
        f"{repo}/{path} on {branch}…"
    )
    status, response = github_request("PUT", endpoint, token, update_body)

    if status not in (200, 201):
        fail(f"Unexpected GitHub update result: HTTP {status}")

    commit_sha = ((response or {}).get("commit") or {}).get(
        "sha", "unknown"
    )
    log(f"GitHub update succeeded. Commit: {commit_sha}")
    return True


def get_keychain_token(service: str) -> str:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except Exception as exc:
        fail(f"Could not read token from Keychain service {service!r}: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Export Reminders via EventKit and update a GitHub file.")
    parser.add_argument("--repo", default=os.getenv("GITHUB_REPO", DEFAULT_REPO), help="owner/repository")
    parser.add_argument("--path", default=os.getenv("GITHUB_PATH", DEFAULT_PATH), help="repository file path")
    parser.add_argument("--branch", default=os.getenv("GITHUB_BRANCH", DEFAULT_BRANCH), help="branch name")
    parser.add_argument("--token-env", default="GITHUB_TOKEN", help="environment variable containing the GitHub token")
    parser.add_argument("--token-keychain", help="Keychain service name containing the GitHub token")
    parser.add_argument("--no-completed", action="store_true", help="exclude completed reminders")
    parser.add_argument("--dry-run", action="store_true", help="export only; do not call GitHub")
    parser.add_argument("--write-yaml", metavar="FILE", help="also write unencoded YAML to FILE")
    args = parser.parse_args()

    payload = export_reminders(include_completed=not args.no_completed)
    yaml_bytes = yaml.safe_dump(
        payload,
        default_flow_style=False,
        sort_keys=False,
        allow_unicode=True,
        width=4096,
    ).encode("utf-8")
    encoded_payload = base64.b64encode(yaml_bytes).decode("ascii")

    if args.write_yaml:
        Path(args.write_yaml).write_bytes(yaml_bytes + b"\n")
        log(f"Wrote readable YAML to {args.write_yaml}.")

    if args.dry_run:
        log("Dry run: GitHub was not changed.")
        print(encoded_payload)
        return 0

    if args.token_keychain:
        token = get_keychain_token(args.token_keychain)
    else:
        token = os.getenv(args.token_env)
    if not token:
        fail(
            "Provide a GitHub token with --token-keychain SERVICE, "
            f"or set {args.token_env}, e.g. export {args.token_env}='github_pat_…'"
        )

    update_github_file(args.repo, args.path, args.branch, token, encoded_payload, payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
