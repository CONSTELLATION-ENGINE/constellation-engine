#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Re-embed all stored vectors when switching model tiers.
#
# Usage: scripts/reembed.sh --to=<strong|tiny> [--dry-run]
#
# Refuses to run while Mímir is alive on port 18810. Always stops here with a
# backup of the DB before touching anything; if anything fails the original
# DB is untouched.

set -euo pipefail

ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ENGINE_ROOT"

TO_TIER=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --to=*) TO_TIER="${arg#--to=}" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$TO_TIER" ]; then
  echo "Usage: scripts/reembed.sh --to=<strong|tiny> [--dry-run]" >&2
  exit 2
fi

if ! echo "strong tiny" | grep -qw "$TO_TIER"; then
  echo "❌ Unknown target tier: $TO_TIER (expected: strong | tiny)" >&2
  exit 2
fi

# Safety: refuse while Mímir is alive — we need exclusive DB access.
if lsof -ti :18810 > /dev/null 2>&1; then
  echo "❌ Mímir is running on port 18810. Stop the engine first (Ctrl+C start.sh)." >&2
  exit 1
fi

DB="$ENGINE_ROOT/constellation.db"
if [ ! -f "$DB" ]; then
  echo "❌ DB not found: $DB" >&2
  exit 1
fi

echo "🔍 Target tier: $TO_TIER"
if [ "$DRY_RUN" = 1 ]; then
  echo "🧪 Dry-run — will report what would change but not touch the DB."
fi

# Activate venv if present.
if [ -f "$ENGINE_ROOT/venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ENGINE_ROOT/venv/bin/activate"
fi

# Backup before any write.
if [ "$DRY_RUN" = 0 ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP="$DB.pre-reembed-$TO_TIER.$TS"
  cp "$DB" "$BACKUP"
  echo "💾 Backup: $BACKUP"
fi

export ENGINE_MODEL_TIER="$TO_TIER"

python3 - <<'PY'
import os, sys, sqlite3, time
sys.path.insert(0, 'scripts/mimir')
from model_tier import TIERS, ensure_engine_meta, clear_engine_meta

TO = os.environ['ENGINE_MODEL_TIER']
DRY = os.environ.get('REEMBED_DRY_RUN') == '1'
DB = 'constellation.db'

target = TIERS[TO]
print(f'[reembed] target: {target.name} ({target.embedder_name}, dim={target.embed_dim})')

con = sqlite3.connect(DB)
cur = con.execute("SELECT key, value FROM engine_meta WHERE key IN ('embedder_name','embed_dim')")
existing = dict(cur.fetchall())
con.close()
print(f'[reembed] stored : embedder={existing.get("embedder_name")} dim={existing.get("embed_dim")}')

if existing.get('embedder_name') == target.embedder_name and existing.get('embed_dim') == str(target.embed_dim):
    print('[reembed] already on target tier — nothing to do')
    sys.exit(0)

# Count what we need to re-encode.
con = sqlite3.connect(DB)
n_nodes = con.execute("SELECT COUNT(*) FROM nodes WHERE state='active'").fetchone()[0]
has_vec = False
try:
    con.execute('SELECT 1 FROM node_embeddings LIMIT 1')
    has_vec = True
except sqlite3.OperationalError:
    pass
con.close()
print(f'[reembed] {n_nodes} active nodes, vec0 table present={has_vec}')

if DRY:
    print('[reembed] dry-run — skipping encode')
    sys.exit(0)

# Load the target encoder, drop the old vec0 table, re-encode every active node.
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
from sentence_transformers import SentenceTransformer
enc = SentenceTransformer(target.embedder_name, device=target.embedder_device)
print('[reembed] encoder loaded')

con = sqlite3.connect(DB)
try:
    con.enable_load_extension(True)
    try:
        con.load_extension('sqlite_vec')
    except sqlite3.OperationalError:
        import sqlite_vec  # type: ignore
        sqlite_vec.load(con)
    con.enable_load_extension(False)
except Exception as e:
    print(f'[reembed] sqlite-vec load failed: {e}', file=sys.stderr)
    sys.exit(1)

con.execute('DROP TABLE IF EXISTS node_embeddings')
con.execute(f'CREATE VIRTUAL TABLE node_embeddings USING vec0(id integer primary key, embedding float[{target.embed_dim}])')
print('[reembed] dropped + recreated node_embeddings')

rows = con.execute("SELECT rowid, COALESCE(l0,'') || ' ' || COALESCE(l1,'') FROM nodes WHERE state='active'").fetchall()
BATCH = 64
t0 = time.time()
for i in range(0, len(rows), BATCH):
    chunk = rows[i:i+BATCH]
    texts = [r[1] for r in chunk]
    embs = enc.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    for (rid, _), vec in zip(chunk, embs):
        con.execute('INSERT INTO node_embeddings(id, embedding) VALUES(?, ?)', (rid, vec.tobytes()))
    if (i // BATCH) % 8 == 0:
        print(f'[reembed] {min(i+BATCH, len(rows))}/{len(rows)} nodes ({time.time()-t0:.1f}s)')
con.commit()
con.close()
print(f'[reembed] done in {time.time()-t0:.1f}s')

clear_engine_meta(DB)
ensure_engine_meta(DB, target)
print(f'[reembed] engine_meta relocked to {target.name}')
PY

if [ "$DRY_RUN" = 0 ]; then
  echo "✅ Reembed complete. Restart start.sh to pick up the new tier."
fi
