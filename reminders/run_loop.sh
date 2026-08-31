#!/bin/bash
cd /Users/dkee/Development/ideal-knee/devin-docs-test
while true; do
  .venv/bin/python reminders/export_reminders_to_github.py --token-keychain reminders-export >> reminders/export-reminders.log 2>&1
  sleep 300
done
