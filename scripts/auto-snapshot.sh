#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Auto-snapshot script - runs independently of engine HTTP server
# Creates SQLite backup snapshots every 15 minutes via crontab

SNAP_DIR="$HOME/constellation-engine/snapshots"
MAIN_DB="$HOME/constellation-engine/constellation.db"
CONV_DB="$HOME/constellation-engine/conversations.db"
MAX_SNAPSHOTS=10

# Generate timestamp
TS=$(date '+%Y-%m-%dT%H-%M-%S')

# Create snapshots using SQLite .backup API (safe for concurrent access)
sqlite3 "$MAIN_DB" ".backup '${SNAP_DIR}/main_${TS}.db'" 2>/dev/null
sqlite3 "$CONV_DB" ".backup '${SNAP_DIR}/conversations_${TS}.db'" 2>/dev/null

# Cleanup old snapshots (keep MAX_SNAPSHOTS most recent pairs)
cd "$SNAP_DIR"
ls -t main_*.db 2>/dev/null | tail -n +$((MAX_SNAPSHOTS + 1)) | while read f; do
  rm -f "$f"
  CONV_F=$(echo "$f" | sed 's/main_/conversations_/')
  rm -f "$CONV_F"
done

# Cleanup: enforce total .db file count limit (20 files max across all types)
TOTAL_DB=$(ls -1 *.db 2>/dev/null | wc -l)
if [ "$TOTAL_DB" -gt 20 ]; then
  ls -t *.db 2>/dev/null | tail -n +21 | while read f; do
    rm -f "$f"
  done
fi

# Cleanup: remove pre-phase milestone backups older than 30 days
find "$SNAP_DIR" -name "constellation-pre-*.db" -mtime +30 -delete 2>/dev/null

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Snapshot created: ${TS}"
