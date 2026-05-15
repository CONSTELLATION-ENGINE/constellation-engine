#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Log rotation for Constellation Engine
# Keeps last 7 days of logs, archives older ones, deletes archives older than 30 days
# Run daily via crontab (e.g. at 04:00)

LOG_DIR="$HOME/constellation-engine/logs"
ARCHIVE_DIR="$LOG_DIR/archive"
MAX_LOG_SIZE_MB=50    # rotate individual files larger than this
KEEP_DAYS=7           # keep recent logs
DELETE_DAYS=30        # delete archived logs older than this

mkdir -p "$ARCHIVE_DIR"

DATE=$(date +%Y-%m-%d)

# Rotate large log files
for f in "$LOG_DIR"/*.log "$LOG_DIR"/*.jsonl; do
    [ -f "$f" ] || continue
    SIZE_MB=$(du -m "$f" 2>/dev/null | cut -f1)
    if [ "$SIZE_MB" -ge "$MAX_LOG_SIZE_MB" ]; then
        BASENAME=$(basename "$f")
        mv "$f" "$ARCHIVE_DIR/${BASENAME%.${BASENAME##*.}}-${DATE}.${BASENAME##*.}"
        touch "$f"
        echo "[rotate-logs] Rotated $BASENAME ($SIZE_MB MB)"
    fi
done

# Archive logs older than KEEP_DAYS
find "$LOG_DIR" -maxdepth 1 -name "*.log" -mtime +$KEEP_DAYS -exec mv {} "$ARCHIVE_DIR/" \;
find "$LOG_DIR" -maxdepth 1 -name "*.jsonl" -mtime +$KEEP_DAYS -exec mv {} "$ARCHIVE_DIR/" \;

# Sweep numeric-suffix orphans (e.g. mimir.jsonl.1, engine.log.2) — these are
# leftovers from in-process rotation (RotatingFileHandler / external rotators)
# that don't match the *.log / *.jsonl globs above. Treat them as already-rotated.
find "$LOG_DIR" -maxdepth 1 -type f \( -regex '.*\.\(log\|jsonl\)\.[0-9]+$' \) -mtime +$KEEP_DAYS -exec mv {} "$ARCHIVE_DIR/" \;

# Delete archived logs older than DELETE_DAYS
find "$ARCHIVE_DIR" -type f -mtime +$DELETE_DAYS -delete 2>/dev/null

# Clean up empty archive dir
rmdir "$ARCHIVE_DIR" 2>/dev/null

# ─── Compiler-training data ────────────────────────────────────────────
# Per-turn IR compiler training entries (src/agent-runtime.js writes one file
# per UTC day to data/compiler-training/training-YYYY-MM-DD.jsonl). Outright
# delete files older than TRAINING_KEEP_DAYS — anything older has already been
# distilled or is no longer useful for the active compiler.
TRAINING_DIR="$HOME/constellation-engine/data/compiler-training"
TRAINING_KEEP_DAYS=60
if [ -d "$TRAINING_DIR" ]; then
    find "$TRAINING_DIR" -maxdepth 1 -type f -name "training-*.jsonl" -mtime +$TRAINING_KEEP_DAYS -delete 2>/dev/null
fi

echo "[rotate-logs] Done at $(date)"
