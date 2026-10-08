---
title: Exporting Reminders from an iPhone
layout: default
---

# Exporting Reminders from an iPhone

The macOS exporter (`reminders/export_reminders_to_github.py`) cannot run on iOS: it
needs CPython with PyObjC/EventKit, the `security` Keychain CLI, and a checkout on
disk. `reminders/export_reminders_to_github.js` is the same logic rewritten for
[Scriptable](https://scriptable.app), which exposes the iOS Reminders and Keychain
APIs to JavaScript.

Both exporters write the same file — `ideal-knee/reminder-data`, `reminders.yaml` on
`main` — with the same selection rules (open reminders with a due date, plus
reminders completed in the last 90 days that had one) and the same YAML formatting,
so either can update the mirror without churning the file.

## Setup

1. Install Scriptable from the App Store.
2. Copy `reminders/export_reminders_to_github.js` into the Scriptable folder (Files
   app → iCloud Drive → Scriptable), or paste it into a new script.
3. Run it once from inside Scriptable. It asks for Reminders access, then for a
   GitHub token with `Contents: Read and write` on `ideal-knee/reminder-data`, which
   it stores in the iOS keychain under `reminders-export`.
4. To run it unattended: Shortcuts → Automation → Time of Day → Run Script →
   pick the script, and turn off "Ask Before Running".

## Differences from the macOS exporter

- No 5-minute loop. iOS runs time-based automations on its own schedule; hourly is
  a realistic floor, and runs can be deferred while the phone is under load.
- iOS limits reminder fetches to a four-year window, so very old completed
  reminders are invisible to it. The 90-day completion cutoff makes that moot.
- The no-op check compares the rendered YAML instead of a SHA-256 digest of the
  reminder array, because Scriptable has no YAML parser or hashing API. The effect
  is the same: a run that changes nothing does not commit.

## Testing the YAML formatting

`reminders/yaml_compat_test.js` renders a payload of awkward titles with the
Scriptable emitter and compares it against `yaml.safe_dump` from the Python
exporter, then checks the selection rules:

```
node reminders/yaml_compat_test.js
```
