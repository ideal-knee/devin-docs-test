#!/bin/bash
set -e
cd /Users/dkee/Development/ideal-knee/devin-docs-test
exec .venv/bin/python reminders/export_reminders_to_github.py --token-keychain reminders-export
