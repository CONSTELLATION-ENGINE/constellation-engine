#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ─── Constellation Engine DB Rollback CLI ─────────────────────────────────
# Usage:
#   ./scripts/rollback.sh list          — show available snapshots
#   ./scripts/rollback.sh latest        — restore most recent snapshot
#   ./scripts/rollback.sh <snapshot-id> — restore specific snapshot
#   ./scripts/rollback.sh snap [reason] — create a manual snapshot
#
# Works even when the Node engine is down.
# ──────────────────────────────────────────────────────────────────────────

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAP_DIR="$ROOT/snapshots"
MANIFEST="$SNAP_DIR/manifest.json"
MAIN_DB="$ROOT/constellation.db"
CONV_DB="$ROOT/conversations.db"

if [ ! -d "$SNAP_DIR" ]; then
  echo "❌ No snapshots directory found at $SNAP_DIR"
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "❌ No manifest.json found at $MANIFEST"
  exit 1
fi

CMD="${1:-help}"

case "$CMD" in
  list)
    echo "📸 Available DB snapshots:"
    echo ""
    # Parse manifest.json with basic tools (python3 for JSON)
    python3 -c "
import json, sys
with open('$MANIFEST') as f:
    m = json.load(f)
snaps = m.get('snapshots', [])
if not snaps:
    print('  (none)')
    sys.exit(0)
for i, s in enumerate(reversed(snaps[-20:])):
    files = ', '.join(s.get('files', {}).keys())
    print(f\"  {i+1}. {s['id']}  |  {s.get('sizeMB', '?')}MB  |  {s.get('reason', '')}  |  [{files}]\")
"
    ;;

  snap)
    REASON="${2:-manual-cli}"
    TS="$(date -u +%Y-%m-%dT%H-%M-%S)"
    ID="$TS"

    echo "📸 Creating snapshot $ID (reason: $REASON)..."

    # Checkpoint WAL files first
    sqlite3 "$MAIN_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true
    sqlite3 "$CONV_DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || true

    MAIN_FILE="main_${ID}.db"
    CONV_FILE="conversations_${ID}.db"

    cp "$MAIN_DB" "$SNAP_DIR/$MAIN_FILE"
    MAIN_SIZE=$(stat -c%s "$SNAP_DIR/$MAIN_FILE" 2>/dev/null || stat -f%z "$SNAP_DIR/$MAIN_FILE")

    TOTAL_SIZE=$MAIN_SIZE
    if [ -f "$CONV_DB" ]; then
      cp "$CONV_DB" "$SNAP_DIR/$CONV_FILE"
      CONV_SIZE=$(stat -c%s "$SNAP_DIR/$CONV_FILE" 2>/dev/null || stat -f%z "$SNAP_DIR/$CONV_FILE")
      TOTAL_SIZE=$((TOTAL_SIZE + CONV_SIZE))
    fi

    SIZE_MB=$(echo "scale=1; $TOTAL_SIZE / 1048576" | bc)

    # Append to manifest
    python3 -c "
import json
with open('$MANIFEST') as f:
    m = json.load(f)
entry = {
    'id': '$ID',
    'ts': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'reason': '$REASON',
    'files': {'main': '$MAIN_FILE', 'conversations': '$CONV_FILE'},
    'sizeMB': $SIZE_MB
}
m['snapshots'].append(entry)
# Keep last 20
m['snapshots'] = m['snapshots'][-20:]
with open('$MANIFEST', 'w') as f:
    json.dump(m, f, indent=2)
"
    echo "✅ Snapshot created: $ID (${SIZE_MB}MB)"
    ;;

  latest)
    # Get latest snapshot ID
    LATEST_ID=$(python3 -c "
import json
with open('$MANIFEST') as f:
    m = json.load(f)
snaps = m.get('snapshots', [])
if snaps:
    print(snaps[-1]['id'])
else:
    print('')
")
    if [ -z "$LATEST_ID" ]; then
      echo "❌ No snapshots available"
      exit 1
    fi
    echo "🔄 Restoring latest snapshot: $LATEST_ID"
    exec "$0" "$LATEST_ID"
    ;;

  help|--help|-h)
    echo "Usage: $0 {list|latest|snap [reason]|<snapshot-id>}"
    echo ""
    echo "  list              Show available snapshots"
    echo "  latest            Restore the most recent snapshot"
    echo "  snap [reason]     Create a manual snapshot"
    echo "  <snapshot-id>     Restore a specific snapshot"
    ;;

  *)
    # Treat as snapshot ID to restore
    TARGET_ID="$CMD"

    # Verify snapshot exists
    SNAP_INFO=$(python3 -c "
import json, sys
with open('$MANIFEST') as f:
    m = json.load(f)
for s in m.get('snapshots', []):
    if s['id'] == '$TARGET_ID':
        for key, fname in s.get('files', {}).items():
            print(f'{key}={fname}')
        sys.exit(0)
print('NOT_FOUND')
")

    if [ "$SNAP_INFO" = "NOT_FOUND" ]; then
      echo "❌ Snapshot not found: $TARGET_ID"
      echo "   Run '$0 list' to see available snapshots."
      exit 1
    fi

    # Safety: create a snapshot of current state first
    echo "📸 Creating safety snapshot of current state..."
    "$0" snap "pre-restore:$TARGET_ID"

    echo ""
    echo "⏳ Restoring snapshot $TARGET_ID..."

    # Parse files from snapshot info
    while IFS='=' read -r KEY FNAME; do
      SRC="$SNAP_DIR/$FNAME"
      case "$KEY" in
        main)         DEST="$MAIN_DB" ;;
        conversations) DEST="$CONV_DB" ;;
        *) echo "  ⚠ Unknown DB key: $KEY — skipping"; continue ;;
      esac

      if [ ! -f "$SRC" ]; then
        echo "  ⚠ Snapshot file missing: $SRC — skipping"
        continue
      fi

      # Remove WAL/SHM
      rm -f "${DEST}-wal" "${DEST}-shm"
      cp "$SRC" "$DEST"
      echo "  ✅ Restored $KEY from $FNAME"
    done <<< "$SNAP_INFO"

    echo ""
    echo "✅ Rollback complete! Restart the engine to apply: ./start.sh"
    ;;
esac
