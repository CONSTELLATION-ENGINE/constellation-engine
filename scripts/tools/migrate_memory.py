#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Memory Migration Importer — Phase 1 scaffold.

OSS user migrate existing AI-agent memory (.md / .txt) into a fresh
constellation.db. Phase 1 = scaffolding (precheck, secrets sweep, dry-run,
batch stamping, collision validation, ordered-cascade rollback). Phases
2-10 layer in path heuristics, frontmatter parsing, BGE-M3 embeddings,
vec0 KNN edges, LLM polish, SA pool soft-suppression per planning MD v2.

Source: engine-output/architecture-research/
        2026-04-29-memory-migration-importer-planning-v2.md
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

# Phase 3 — heavy deps, lazy-imported in helpers.
# `sentence_transformers` + `sqlite_vec` are only needed for --execute.
# Dry-run / --rollback-batch skip both, so the tool stays usable on
# minimal Python installs until the user actually imports.


# ── Constants ──────────────────────────────────────────────────────

# Planning §6 — collision against active engine identity.
ENGINE_IDENTITY_ANCHORS = [
    'soul-core', 'grand-synthesis', 'lineage',
    'milestone-eternal-core-memory',
]

# Planning §7 — Tier-1 OSS prerequisite.
SECRETS_PATTERNS = [
    re.compile(r'sk-[A-Za-z0-9]{20,}'),
    re.compile(r'ghp_[A-Za-z0-9]{36}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'-----BEGIN (?:RSA|OPENSSH|DSA|EC) PRIVATE KEY-----'),
    re.compile(r'xox[baprs]-[A-Za-z0-9-]+'),
    re.compile(r'AIza[0-9A-Za-z\-_]{35}'),
]

# Planning §10 caps + Q5 lock.
DEFAULT_MAX_FILES = 2000
DEFAULT_MAX_FILE_SIZE_MB = 2
DEFAULT_MAX_BATCH_SIZE_MB = 50
# G-F: cap on stored L2 to prevent 2MB-file → 2MB-row bloat. BGE-M3 only
# embeds first ~8k tokens anyway, so storing more is dead weight.
DEFAULT_MAX_L2_CHARS = 8000

# Phase 3 — must match engine.cjs constants exactly. Drift here = silent
# divergence between imported and natively-written nodes.
EMBED_MODEL_NAME = 'BAAI/bge-m3'
EMBED_DIM = 1024  # engine.cjs:320 EMBED_DIM
KNN_LIMIT = 11  # engine.cjs:1491 (top-10 + self)
EDGE_COSINE_FLOOR = 0.40  # engine.cjs:1504
HUB_DEGREE_THRESHOLD = 20  # engine.cjs:1508
HUB_BOOST = 1.2
TOP_K_EDGES = 5  # engine.cjs:1516
EDGE_REVERSE_FACTOR = 0.8  # engine.cjs:1536
EDGE_STRENGTH_MIN = 0.3
EDGE_STRENGTH_MAX = 0.7
EDGE_STRENGTH_COEFF = 0.7  # cosSim * 0.7

# Planning §4 skip rules — whole-segment match (G-E fix). Phase 2 may add
# --include-all to opt out.
SKIP_NAME_TOKENS = ('INBOX', 'QUEUE', '.PROCESSED', '.TMP')


# ── Schema migration (Phase 0, kept idempotent) ───────────────────

def ensure_schema(conn: sqlite3.Connection) -> bool:
    """Idempotent: add `imported_batch_id`, `event_at`, `subkind` if missing.

    Engine.cjs adds these at boot; this lets the migrator run on a fresh OSS
    DB *before* the engine has ever booted (e.g. wizard-driven first import).
    Returns True if any migration was applied.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(nodes)").fetchall()}
    applied = False
    if 'imported_batch_id' not in cols:
        conn.execute("ALTER TABLE nodes ADD COLUMN imported_batch_id TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_nodes_imported_batch "
            "ON nodes(imported_batch_id) WHERE imported_batch_id IS NOT NULL"
        )
        applied = True
    if 'event_at' not in cols:
        conn.execute("ALTER TABLE nodes ADD COLUMN event_at TEXT DEFAULT NULL")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_nodes_event_at "
            "ON nodes(event_at) WHERE event_at IS NOT NULL"
        )
        applied = True
    if 'subkind' not in cols:
        conn.execute("ALTER TABLE nodes ADD COLUMN subkind TEXT")
        applied = True
    if applied:
        conn.commit()
    return applied


# ── Precheck helpers ──────────────────────────────────────────────

def is_binary(path: Path, sniff_bytes: int = 8192) -> bool:
    """Cheap binary sniff: NUL byte presence in first 8KB."""
    try:
        with open(path, 'rb') as f:
            return b'\x00' in f.read(sniff_bytes)
    except OSError:
        return True


def scan_secrets(text: str) -> list:
    """Return list of pattern strings that fired. Empty = clean."""
    return [pat.pattern for pat in SECRETS_PATTERNS if pat.search(text)]


def fingerprint(text: str) -> str:
    """SHA-256 of normalized text → first 16 hex (planning §3.8 + Q8 lock).

    Phase 2 wires this for re-import detection alongside `--force`.
    """
    return hashlib.sha256(text.strip().lower().encode('utf-8')).hexdigest()[:16]


def slugify(name: str) -> str:
    """Filename → safe id slug (lowercase, dashes, alnum only)."""
    s = re.sub(r'[^a-zA-Z0-9]+', '-', name).strip('-').lower()
    return s or 'untitled'


# ── Phase 3 — embeddings + vec0 KNN auto-edges ────────────────────

def load_embedder():
    """Lazy-load BGE-M3 once. Returns (model, err_str). On failure, model
    is None and err_str describes why so the caller can abort --execute
    cleanly. Dry-run never calls this.

    G-1: BGE-M3 first-run download is ~2.3GB and otherwise silent. We
    print a one-line stderr notice before the load so user don't
    misread the pause as a hang.
    """
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:
        return None, (
            f"sentence_transformers missing: {e}. "
            f"Install with: pip install sentence-transformers"
        )
    print(
        f"Loading {EMBED_MODEL_NAME} (~2.3GB on first run, cached after)...",
        file=sys.stderr,
    )
    try:
        model = SentenceTransformer(EMBED_MODEL_NAME)
    except Exception as e:
        return None, (
            f"BGE-M3 load failed: {e}. "
            f"First-run download requires internet; retry once cached."
        )
    return model, None


def embed_text(model, text: str):
    """Encode `text` → normalized float32 bytes (vec0-compatible).

    Returns None for empty/whitespace text (B-6 fix). Caller must skip
    both the vec0 INSERT and the KNN MATCH for None — storing zero
    vectors poisons the index (every future KNN wastes a slot returning
    zero-vector neighbors at max distance).
    """
    import numpy as np
    if not text or not text.strip():
        return None
    emb = model.encode(text, normalize_embeddings=True)
    return emb.astype(np.float32).tobytes()


def embed_batch(model, texts):
    """Batched encode for the whole import (G-2). Returns list of
    bytes-or-None aligned with `texts`. Empty strings → None to
    preserve the B-6 zero-vector skip path.
    """
    import numpy as np
    nonempty_idx = [i for i, t in enumerate(texts) if t and t.strip()]
    if not nonempty_idx:
        return [None] * len(texts)
    nonempty_texts = [texts[i] for i in nonempty_idx]
    embs = model.encode(
        nonempty_texts,
        normalize_embeddings=True,
        batch_size=32,
        show_progress_bar=len(nonempty_texts) >= 16,
    )
    out = [None] * len(texts)
    for j, i in enumerate(nonempty_idx):
        out[i] = embs[j].astype(np.float32).tobytes()
    return out


def _try_load_vec0(conn: sqlite3.Connection):
    """Load sqlite-vec extension on `conn`. Returns (ok, err_str).

    Idempotent: re-loading on a connection that already has it raises
    OperationalError, which we treat as success.
    """
    try:
        import sqlite_vec
    except ImportError as e:
        return False, f"sqlite_vec missing: {e}. Install: pip install sqlite-vec"
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True, None
    except sqlite3.OperationalError as e:
        # Already loaded on this connection in many SQLite builds → benign.
        if 'already' in str(e).lower():
            return True, None
        return False, str(e)
    except Exception as e:
        return False, str(e)


def auto_edges_for_batch(conn: sqlite3.Connection, inserted_envs,
                         embeddings_by_id: dict) -> dict:
    """Mirror engine.cjs:_suggestEdges for each newly inserted node.

    KNN via vec0 → cosine floor 0.40 → hub-bias 1.2× when target
    conn_count>20 → top-5 → bidirectional INSERT OR IGNORE with reverse
    strength × 0.8 → recompute conn_count via subquery (matches engine
    N2 fix; safe under concurrent writes since we're in a per-call txn).

    Skip nodes whose embedding is None (e.g. silently empty body) so we
    don't pollute the graph with zero-vector neighbors.
    """
    stats = {'edges_inserted': 0, 'nodes_with_edges': 0, 'no_match': 0}
    # Edge dedup: schema has no UNIQUE(source,target,edge_type), so
    # `INSERT OR IGNORE` won't catch within-batch duplicates. When A and
    # B are both new, A's KNN emits A→B and B→A; B's KNN re-emits the
    # same pair → conn_count gets inflated 2-4×. Track pairs in-memory.
    # B-1: only commit pairs into seen_pairs after the txn for that node
    # COMMITs, so a rolled-back iteration doesn't permanently mask the
    # pairs from a future legitimate retry.
    seen_pairs: set = set()
    warn_count = 0
    WARN_CAP = 10

    def warn(msg: str) -> None:
        nonlocal warn_count
        warn_count += 1
        if warn_count <= WARN_CAP:
            print(msg, file=sys.stderr)
        elif warn_count == WARN_CAP + 1:
            print(f"  WARN: further auto-edge warnings suppressed "
                  f"(cap={WARN_CAP})", file=sys.stderr)
    sel_neighbors = (
        "SELECT id, distance FROM node_embeddings "
        "WHERE embedding MATCH ? ORDER BY distance LIMIT ?"
    )
    sel_node_for_rowid = (
        "SELECT node_id FROM node_rowids WHERE rowid = ?"
    )
    sel_conn_count = (
        "SELECT conn_count FROM nodes WHERE id=? AND state='active'"
    )
    ins_edge = (
        "INSERT OR IGNORE INTO edges "
        "(source, target, edge_type, strength, state, created_at, owner_id) "
        "VALUES (?, ?, 'associative', ?, 'active', datetime('now'), 'self')"
    )
    # B-5: bi-temporal clause parity with engine.cjs:1526 (`AND valid_to
    # IS NULL`). On fresh OSS DBs this is a no-op since no tombstones
    # exist yet, but stays correct after future tombstone migrations.
    # Owner-scoped to 'self' to keep import math consistent with OSS
    # single-tenant.
    upd_conn_count = (
        "UPDATE nodes SET conn_count = ("
        "  (SELECT COUNT(*) FROM edges WHERE source=? AND state='active' "
        "       AND valid_to IS NULL) + "
        "  (SELECT COUNT(*) FROM edges WHERE target=? AND state='active' "
        "       AND valid_to IS NULL)"
        "), accessed_at=datetime('now') WHERE id=?"
    )

    for env in inserted_envs:
        nid = env['id']
        emb_blob = embeddings_by_id.get(nid)
        if emb_blob is None:
            continue
        try:
            rows = conn.execute(sel_neighbors, (emb_blob, KNN_LIMIT)).fetchall()
        except sqlite3.Error as e:
            # B-4: broaden from OperationalError to sqlite3.Error so vec0
            # corruption / lock errors / DatabaseError don't escape the
            # loop and lose the entire post-WRITE pass.
            warn(f"  WARN: KNN failed for {nid}: {e}")
            continue

        scored = []
        for vec_id, dist in rows:
            mapping = conn.execute(sel_node_for_rowid, (vec_id,)).fetchone()
            if not mapping:
                continue
            target_id = mapping[0]
            if target_id == nid:
                continue
            cos_sim = 1 - (dist * dist) / 2.0
            if cos_sim < EDGE_COSINE_FLOOR:
                continue
            deg_row = conn.execute(sel_conn_count, (target_id,)).fetchone()
            if not deg_row:
                continue
            hub_boost = HUB_BOOST if (deg_row[0] or 0) > HUB_DEGREE_THRESHOLD else 1.0
            scored.append((target_id, cos_sim * hub_boost, cos_sim))

        # B-3: always bump self accessed_at + recompute conn_count, even
        # when no neighbors made it through the floor — engine.cjs:1541
        # does the same regardless of whether edges were created.
        try:
            conn.execute("BEGIN")
            conn.execute(upd_conn_count, (nid, nid, nid))
            conn.execute("COMMIT")
        except sqlite3.Error as e:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            warn(f"  WARN: self conn_count bump failed for {nid}: {e}")

        if not scored:
            stats['no_match'] += 1
            continue

        scored.sort(key=lambda r: r[1], reverse=True)
        top = scored[:TOP_K_EDGES]

        # B-1: pending_pairs only promotes into seen_pairs after COMMIT.
        pending_pairs: list = []
        try:
            conn.execute("BEGIN")
            created = 0
            touched_neighbors = []
            for target_id, _boosted, cos_sim in top:
                strength = min(EDGE_STRENGTH_MAX,
                               max(EDGE_STRENGTH_MIN, cos_sim * EDGE_STRENGTH_COEFF))
                fwd = (nid, target_id)
                rev = (target_id, nid)
                if fwd not in seen_pairs:
                    cur = conn.execute(ins_edge, (nid, target_id, strength))
                    created += cur.rowcount
                    pending_pairs.append(fwd)
                if rev not in seen_pairs:
                    cur = conn.execute(ins_edge, (target_id, nid,
                                                  strength * EDGE_REVERSE_FACTOR))
                    created += cur.rowcount
                    pending_pairs.append(rev)
                touched_neighbors.append(target_id)
            # Recompute conn_count for each neighbor (subquery, not
            # increment) — safe even if INSERT OR IGNORE skipped a dupe.
            for tgt in touched_neighbors:
                conn.execute(upd_conn_count, (tgt, tgt, tgt))
            # Re-bump self after edge inserts so its conn_count reflects
            # the new edges (the earlier bump captured pre-edge state).
            conn.execute(upd_conn_count, (nid, nid, nid))
            conn.execute("COMMIT")
            seen_pairs.update(pending_pairs)  # B-1: promote post-COMMIT
            stats['edges_inserted'] += created
            if created > 0:
                stats['nodes_with_edges'] += 1
        except Exception as e:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.OperationalError:
                pass
            warn(f"  WARN: auto-edge txn failed for {nid}: {e}")

    return stats


def proposed_id(path: Path, root: Path) -> str:
    """Phase 1: id from relative path. Phase 2 refines via frontmatter override."""
    rel = path.relative_to(root).with_suffix('')
    parts = [slugify(p) for p in rel.parts if p]
    return ('-'.join(parts) or slugify(path.stem))[:128]


def should_skip(path: Path, root: Path) -> bool:
    """Hidden / queue / processed / tmp skips per planning §4 (G-E fix).

    Skips when the file *or any ancestor under root* is a dot-prefixed
    directory (.migrate-quarantine, .git) OR a whole-segment match against
    SKIP_NAME_TOKENS (case-insensitive). Whole-segment matching avoids
    false-positives on names like `quarterly-report.md`.
    """
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError:
        rel_parts = (path.name,)
    for part in rel_parts:
        if part.startswith('.'):
            return True
        # Strip extension before comparing (e.g. INBOX.md → INBOX).
        stem_upper = part.rsplit('.', 1)[0].upper()
        if stem_upper in SKIP_NAME_TOKENS:
            return True
    return False


def walk_input(input_dir: Path, max_file_bytes: int):
    """Yield (path, text, size, status). status ∈ ok|binary|oversize|skip|unreadable."""
    for path in sorted(input_dir.rglob('*')):
        if not path.is_file():
            continue
        if path.suffix.lower() not in ('.md', '.txt'):
            continue
        if should_skip(path, input_dir):
            yield path, None, 0, 'skip'
            continue
        try:
            size = path.stat().st_size
        except OSError:
            yield path, None, 0, 'unreadable'
            continue
        if size > max_file_bytes:
            yield path, None, size, 'oversize'
            continue
        if is_binary(path):
            yield path, None, size, 'binary'
            continue
        try:
            with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
                text = f.read()
        except OSError:
            yield path, None, size, 'unreadable'
            continue
        yield path, text, size, 'ok'


def quarantine_file(path: Path, input_dir: Path) -> Path:
    """Move secrets-hit file to <input>/.migrate-quarantine/<rel> (G-D fix).

    Uses shutil.move so cross-filesystem moves succeed.
    """
    qdir = input_dir / '.migrate-quarantine'
    qdir.mkdir(exist_ok=True)
    dest = qdir / path.relative_to(input_dir)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(dest))
    readme = qdir / 'README.md'
    if not readme.exists():
        readme.write_text(
            "# Quarantine\n\n"
            "Files matched secrets patterns and were withheld from import. "
            "Review and clean before retrying.\n",
            encoding='utf-8',
        )
    return dest


# ── Collision validation (G7) ─────────────────────────────────────

def staged_collision_validation(proposed, conn: sqlite3.Connection):
    """Planning §6 + B-A fix. Returns list of (collision_kind, id, source_file).

    Intra-batch dupes report BOTH the first-seen path and the duplicate path
    so the user can see which two files collide. Without this, the report
    only flagged file #2 with no companion.
    """
    collisions = []
    seen_in_batch: dict = {}
    for pid, src_file in proposed:
        if pid in ENGINE_IDENTITY_ANCHORS:
            collisions.append(('engine_anchor', pid, src_file))
        existing = conn.execute(
            "SELECT id FROM nodes WHERE id=? AND state='active'", (pid,)
        ).fetchone()
        if existing:
            collisions.append(('existing_node', pid, src_file))
        if pid in seen_in_batch:
            first = seen_in_batch[pid]
            collisions.append(('intra_batch_dupe_first', pid, first))
            collisions.append(('intra_batch_dupe_other', pid, src_file))
        else:
            seen_in_batch[pid] = src_file
    return collisions


# ── Rollback (B2 — explicit ordered cascade) ─────────────────────

def rollback_batch(conn: sqlite3.Connection, batch_id: str) -> dict:
    """Planning §3.5. FK-safe order: edges → embeddings → rowids → fts → nodes.

    Returns {step: rows_deleted_or_status}. Wraps virtual-table deletes in
    try/except since vec0 / fts5 modules may not be loaded in this connection.
    """
    counts = {}
    conn.execute("BEGIN")
    try:
        cur = conn.execute("""
            DELETE FROM edges
            WHERE source IN (SELECT id FROM nodes WHERE imported_batch_id=?)
               OR target IN (SELECT id FROM nodes WHERE imported_batch_id=?)
        """, (batch_id, batch_id))
        counts['edges'] = cur.rowcount

        try:
            cur = conn.execute("""
                DELETE FROM node_embeddings
                WHERE id IN (
                    SELECT rowid FROM node_rowids
                    WHERE node_id IN (
                        SELECT id FROM nodes WHERE imported_batch_id=?
                    )
                )
            """, (batch_id,))
            counts['node_embeddings'] = cur.rowcount
        except sqlite3.OperationalError as e:
            counts['node_embeddings'] = f'skipped (vec0 not loaded): {e}'

        cur = conn.execute("""
            DELETE FROM node_rowids
            WHERE node_id IN (SELECT id FROM nodes WHERE imported_batch_id=?)
        """, (batch_id,))
        counts['node_rowids'] = cur.rowcount

        # G-7: skip cleanly when nodes_fts table doesn't exist (cold DB
        # rollback before any engine boot). Avoids confusing "no such
        # table" warning that fires for the perfectly normal case.
        fts_exists = bool(conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='nodes_fts'"
        ).fetchone())
        if not fts_exists:
            counts['nodes_fts'] = 'absent'
        else:
            try:
                cur = conn.execute("""
                    DELETE FROM nodes_fts
                    WHERE node_id IN (SELECT id FROM nodes WHERE imported_batch_id=?)
                """, (batch_id,))
                counts['nodes_fts'] = cur.rowcount
            except sqlite3.OperationalError as e:
                counts['nodes_fts'] = f'skipped (fts5 not loaded): {e}'

        cur = conn.execute(
            "DELETE FROM nodes WHERE imported_batch_id=?", (batch_id,)
        )
        counts['nodes'] = cur.rowcount

        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return counts


# ── Node write (B1 — explicit owner_id='self') ────────────────────

def insert_node(conn: sqlite3.Connection, node: dict, batch_id: str,
                embedding: bytes | None = None) -> None:
    """Planning §3.3 step 7. Phase 2 adds subkind + event_at columns.

    Phase 3: when `embedding` is not None, also writes node_embeddings
    keyed by node_rowids.lastrowid. Caller is responsible for txn
    boundary; this function only emits SQL.
    """
    nid = node['id']
    tags = node.get('tags') or '[]'
    conn.execute("""
        INSERT INTO nodes (id, l0, l1, l2, tags, tone, source, node_type,
                           subkind, event_at,
                           state, weight, conn_count, accessed_at, created_at,
                           owner_id, imported_batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'active', 1.0, 0,
                datetime('now'), datetime('now'), 'self', ?)
    """, (
        nid,
        node['l0'], node['l1'], node['l2'], tags,
        node.get('tone', 'analytical'),
        node.get('source', 'imported'),
        node.get('node_type', 'knowledge'),
        node.get('subkind'),
        node.get('event_at'),
        batch_id,
    ))
    cur = conn.execute(
        "INSERT INTO node_rowids (node_id) VALUES (?)", (nid,)
    )
    rowid = cur.lastrowid
    if embedding is not None and rowid is not None:
        try:
            conn.execute(
                "INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)",
                (rowid, embedding),
            )
        except sqlite3.OperationalError as e:
            # vec0 not loaded — let txn continue; auto-edges will skip
            # this node since it has no neighbor index entry.
            print(f"  WARN: vec0 insert failed for {nid}: {e}", file=sys.stderr)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)",
            (nid, node['l2'], tags),
        )
    except sqlite3.OperationalError:
        # fts5 module may not be loaded in some inspection contexts; tolerate.
        pass


# ── Phase 2: frontmatter parser + path-heuristic kind routing ─────

# Strict prefix match: --- on its own line, body until next --- on its own line.
FRONTMATTER_RE = re.compile(r'\A---\s*\n(.*?)\n---\s*(?:\n|$)', re.DOTALL)
DATE_IN_PATH_RE = re.compile(r'(\d{4})-(\d{2})-(\d{2})')


def parse_frontmatter(text: str):
    """Zero-dep YAML subset parser.

    Returns (fm_dict, body_text) on success, (None, full_text) on no-FM
    block OR any parse error (G5: a malformed header must never poison the
    plain-text fallback). Supports: scalar `key: value`, single/double-quoted
    strings, single-line bracketed lists `[a, b, "c"]`. Comments + blank
    lines tolerated.
    """
    if not text:
        return None, text
    stripped = text.lstrip('\ufeff')  # BOM tolerant
    m = FRONTMATTER_RE.match(stripped)
    if not m:
        return None, text
    raw = m.group(1)
    body = stripped[m.end():]
    fm: dict = {}
    try:
        for line in raw.splitlines():
            s = line.rstrip()
            if not s.strip() or s.lstrip().startswith('#'):
                continue
            if ':' not in s:
                return None, text  # malformed → bail to plain-text mode
            key, _, value = s.partition(':')
            key = key.strip()
            value = value.strip()
            if not key:
                return None, text
            # G-2 fix: block scalars (`|` / `>`) are unsupported — bail loud.
            if value in ('|', '>'):
                return None, text
            # G-6 fix: unclosed bracketed list = silent data loss — bail.
            if value.startswith('[') and not value.endswith(']'):
                return None, text
            if value.startswith('[') and value.endswith(']'):
                items = []
                for it in value[1:-1].split(','):
                    it = it.strip()
                    if (it.startswith('"') and it.endswith('"')) or \
                       (it.startswith("'") and it.endswith("'")):
                        it = it[1:-1]
                    if it:
                        items.append(it)
                fm[key] = items
            else:
                if (value.startswith('"') and value.endswith('"')) or \
                   (value.startswith("'") and value.endswith("'")):
                    value = value[1:-1]
                fm[key] = value
        return fm, body
    except Exception:
        return None, text


def infer_kind_from_path(path: Path, root: Path):
    """Planning §4 path heuristic table → (node_type, subkind, kind_tags).

    Forward-slash + lowercase normalize for cross-platform zip dumps.
    Order matters: identity > milestone > principle > diary > relationship
    > reading-note > knowledge (default).
    """
    try:
        rel = path.relative_to(root)
    except ValueError:
        rel = path
    parts_lower = [p.lower() for p in rel.parts]
    name_upper = rel.stem.upper()

    has = lambda *needles: any(p in needles for p in parts_lower)

    if has('identity', 'soul-core', 'soul') or \
       name_upper.startswith(('SOUL', 'IDENTITY')):
        return ('identity', None, ['identity'])
    if has('milestones', 'milestone') or name_upper.startswith('MILESTONE'):
        return ('milestone', None, ['milestone'])
    if has('principles', 'principle') or name_upper.startswith('PRINCIPLE'):
        return ('principle', None, ['principle'])
    if has('diary', 'journal', 'journals'):
        return ('knowledge', 'diary', ['diary'])
    if has('relationships', 'relationship', 'people'):
        return ('knowledge', 'relationship', ['relationship'])
    if has('reading', 'notes', 'reading-notes'):
        return ('knowledge', 'reading-note', ['reading-note'])
    return ('knowledge', None, [])


def extract_event_at(path: Path, root: Path, fm: dict | None):
    """ISO 8601 string or None. Frontmatter `event_at`/`date` wins, then
    first `YYYY-MM-DD` in any path segment. Bare YYYY-MM-DD is expanded to
    midnight UTC so downstream `datetime()` SQL parsing works.
    """
    if fm:
        for key in ('event_at', 'date'):
            v = fm.get(key)
            if v:
                v = str(v).strip()
                if re.fullmatch(r'\d{4}-\d{2}-\d{2}', v):
                    return v + 'T00:00:00Z'
                # G-5 fix: only accept ISO 8601 prefixed full forms; bare
                # words like 'tomorrow' fall through to path-date or None.
                if re.match(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}', v):
                    return v
    try:
        rel = path.relative_to(root)
    except ValueError:
        rel = path
    for part in rel.parts:
        m = DATE_IN_PATH_RE.search(part)
        if m:
            return f'{m.group(1)}-{m.group(2)}-{m.group(3)}T00:00:00Z'
    return None


def build_envelope(path: Path, text: str, root: Path,
                   max_l2_chars: int = DEFAULT_MAX_L2_CHARS) -> dict:
    """Phase 2 envelope: frontmatter + path-heuristic kind routing + event_at
    + fingerprint tag. FM precedence over path heuristics; FM parse failure
    → plain-text fallback (G5).

    G-F: L2 truncated to max_l2_chars to bound DB row size.
    """
    fm, body_text = parse_frontmatter(text)

    # Path-heuristic defaults; FM may override below.
    node_type, subkind, kind_tags = infer_kind_from_path(path, root)
    if fm:
        if isinstance(fm.get('node_type'), str):
            node_type = fm['node_type']
        if isinstance(fm.get('subkind'), str):
            subkind = fm['subkind']

    pid = proposed_id(path, root)

    head_lines = [ln for ln in body_text.strip().splitlines() if ln.strip()]
    default_head = (head_lines[0] if head_lines else path.stem)[:120]
    body = body_text.strip()
    if len(body) > max_l2_chars:
        body = body[:max_l2_chars] + '\n\n[…truncated]'

    l0 = default_head
    l1 = default_head
    l2 = body
    if fm:
        if isinstance(fm.get('l0'), str):
            l0 = fm['l0'][:120]
        if isinstance(fm.get('l1'), str):
            l1 = fm['l1'][:400]
        if isinstance(fm.get('l2'), str):
            l2 = fm['l2'][:max_l2_chars]

    # Tags: kind tags + 'imported' + fingerprint + FM tags (dedupe, ordered).
    tag_set: list = []
    seen: set = set()
    def add(t):
        if isinstance(t, str) and t and t not in seen:
            seen.add(t)
            tag_set.append(t)
    for t in kind_tags:
        add(t)
    add('imported')
    # B-1 fix: hash body only — FM edits (tag/title) shouldn't break
    # re-import detection. Spec §3.8: fingerprint anchors content identity.
    add(f'fp:{fingerprint(body_text)}')
    if fm and isinstance(fm.get('tags'), list):
        for t in fm['tags']:
            add(t)

    tone = 'analytical'
    source = 'imported'
    if fm:
        if isinstance(fm.get('tone'), str):
            tone = fm['tone']
        if isinstance(fm.get('source'), str):
            source = fm['source']

    event_at = extract_event_at(path, root, fm)

    return {
        'id': pid,
        'l0': l0,
        'l1': l1,
        'l2': l2,
        'tags': json.dumps(tag_set),
        'tone': tone,
        'source': source,
        'node_type': node_type,
        'subkind': subkind,
        'event_at': event_at,
        '_path': path,
    }


# ── Reporting ─────────────────────────────────────────────────────

def write_report(report_dir: Path, batch_id: str, summary: dict,
                 collisions, quarantines, sample_nodes) -> Path:
    out = report_dir / f'migrate-{batch_id}'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'summary.json').write_text(
        json.dumps(summary, indent=2, default=str), encoding='utf-8'
    )
    (out / 'collisions.json').write_text(
        json.dumps(
            [{'kind': k, 'id': i, 'source': str(s)} for k, i, s in collisions],
            indent=2,
        ),
        encoding='utf-8',
    )
    (out / 'quarantine.json').write_text(
        json.dumps(
            [{'source': str(p), 'patterns': h} for p, h in quarantines],
            indent=2,
        ),
        encoding='utf-8',
    )
    samples_md = '\n\n'.join(
        f"### {n['id']}\n\n**l0:** {n['l0']}\n\n```\n{n['l2'][:400]}\n```"
        for n in sample_nodes[:20]
    ) or '_No samples (empty input or all skipped)._'
    (out / 'sample-nodes.md').write_text(samples_md, encoding='utf-8')
    return out


# ── CLI command handlers ──────────────────────────────────────────

def cmd_migrate(args: argparse.Namespace) -> int:
    # B-B: kill switch. Default ON (dry-run is harmless); only --execute
    # mutates DB, so gate the write phase via env to allow ops to disable
    # the tool without uninstalling.
    if args.execute and os.environ.get('MIGRATE_TOOL_ENABLED', '1') == '0':
        print("ERROR: MIGRATE_TOOL_ENABLED=0 — execute disabled by env",
              file=sys.stderr)
        return 6

    db_path = args.db
    input_dir = Path(args.input).expanduser().resolve()
    if not input_dir.is_dir():
        print(f"ERROR: --input is not a directory: {input_dir}", file=sys.stderr)
        return 2

    batch_id = args.batch_id or (
        'imp-' + datetime.datetime.now(datetime.timezone.utc)
                            .strftime('%Y%m%dT%H%M%SZ')
    )
    max_file_bytes = args.max_file_size * 1024 * 1024
    max_batch_bytes = DEFAULT_MAX_BATCH_SIZE_MB * 1024 * 1024
    report_dir = Path(args.report_dir).resolve()

    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        ensure_schema(conn)

        # G-A: cold OSS DBs may lack nodes_fts (engine.cjs creates it at
        # boot, not schema.sql). Detect early so imports don't silently
        # skip FTS indexing — without it, BM25 search misses imported nodes
        # until first engine boot rebuilds the index.
        fts_present = bool(conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='nodes_fts'"
        ).fetchone())
        if not fts_present:
            print(
                "WARN: nodes_fts not found — boot the engine once to "
                "create FTS5 index, OR imported nodes will be FTS-invisible "
                "until first engine boot.",
                file=sys.stderr,
            )

        # Phase 3 prereq probe: vec0 + node_embeddings. Cold OSS DB has
        # node_embeddings created by engine.cjs at boot — same FTS rule.
        # G-4: there is NO boot-time consolidation that re-suggests edges
        # for pre-existing nodes (engine `_suggestEdges` only fires inside
        # `_remember`). So if we import without vec0, those nodes will be
        # edge-orphans forever. Make the warning explicit.
        vec_present = bool(conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='node_embeddings'"
        ).fetchone())
        if not vec_present:
            print(
                "WARN: node_embeddings not found — engine has not booted "
                "yet on this DB. Recommend: boot engine once to create "
                "node_embeddings, then re-run --execute. Otherwise "
                "imported nodes will be permanent edge-orphans (no "
                "boot-time consolidation re-runs auto-edges).",
                file=sys.stderr,
            )

        # [1] PRECHECK + secrets sweep
        envelopes = []
        quarantined = []
        skipped = []
        bytes_total = 0

        for path, text, size, status in walk_input(input_dir, max_file_bytes):
            if status != 'ok':
                skipped.append((path, status))
                continue
            hits = scan_secrets(text)
            if hits:
                if args.secrets_policy == 'abort':
                    print(f"ABORT: secrets in {path}: {hits}", file=sys.stderr)
                    return 3
                if args.execute:
                    try:
                        quarantine_file(path, input_dir)
                    except OSError as e:
                        print(f"WARN: quarantine failed for {path}: {e}",
                              file=sys.stderr)
                quarantined.append((path, hits))
                continue
            if len(envelopes) >= args.max_files:
                skipped.append((path, 'cap_files'))
                continue
            if bytes_total + size > max_batch_bytes:
                skipped.append((path, 'cap_bytes'))
                continue
            envelopes.append(build_envelope(path, text, input_dir,
                                            args.max_l2_chars))
            bytes_total += size

        # [2] STAGED COLLISION VALIDATION (G7)
        proposed = [(e['id'], e['_path']) for e in envelopes]
        collisions = staged_collision_validation(proposed, conn)

        if collisions and args.collision_policy == 'abort':
            write_report(report_dir, batch_id,
                         {'aborted': 'collisions', 'count': len(collisions),
                          'batch_id': batch_id, 'mode': 'aborted'},
                         collisions, quarantined, [])
            print(f"ABORT: {len(collisions)} collision(s):", file=sys.stderr)
            for kind, pid, src in collisions[:10]:
                print(f"  [{kind}] {pid}  ←  {src}", file=sys.stderr)
            if len(collisions) > 10:
                print(f"  ... and {len(collisions) - 10} more", file=sys.stderr)
            print(f"see report: {report_dir / ('migrate-' + batch_id)}",
                  file=sys.stderr)
            return 4

        summary = {
            'batch_id': batch_id,
            'input': str(input_dir),
            'db': db_path,
            'planned_nodes': len(envelopes),
            'planned_bytes': bytes_total,
            'skipped_count': len(skipped),
            'skipped_sample': [(str(p), s) for p, s in skipped[:50]],
            'quarantined_count': len(quarantined),
            # G-C: distinguish planned (dry-run) from executed (file moved).
            'quarantined_status': 'executed' if args.execute else 'planned',
            'collisions_count': len(collisions),
            'fts_present': fts_present,
            'mode': 'execute' if args.execute else 'dry-run',
        }

        # [3] DRY-RUN PREVIEW
        if not args.execute:
            out = write_report(report_dir, batch_id, summary,
                               collisions, quarantined, envelopes)
            print(json.dumps(summary, indent=2, default=str))
            print(f"\nDRY-RUN: {len(envelopes)} nodes would be imported.")
            print(f"Pass --execute to commit (batch_id={batch_id}).")
            print(f"report: {out}")
            return 0

        # [3.5] Phase 3 prep — load BGE-M3 + vec0 before WRITE.
        # If either fails AND vec_present is True, abort the run — writing
        # nodes without embeddings into a vec-equipped DB silently breaks
        # KNN until the user manually re-embeds. If vec_present is False
        # (cold DB), continue without embeddings; engine.cjs will rebuild
        # at first boot via the existing reembed.sh path.
        embedder = None
        embedder_err = None
        vec_loaded = False
        if vec_present:
            embedder, embedder_err = load_embedder()
            if embedder is None:
                print(f"ABORT: BGE-M3 unavailable: {embedder_err}",
                      file=sys.stderr)
                return 7
            ok, vec_err = _try_load_vec0(conn)
            if not ok:
                print(f"ABORT: sqlite-vec extension load failed: {vec_err}",
                      file=sys.stderr)
                return 7
            vec_loaded = True

        # [3.6] G-2: pre-compute all embeddings in one batched call. Per-node
        # `model.encode()` would dispatch the model 2000× for a max-cap
        # batch; batched mode is ~10-30× faster on CPU and stays accurate.
        # Match engine.cjs:999 verbatim: `${l0} ${l1}` (single space).
        embeddings_by_id: dict = {}
        if embedder is not None and envelopes:
            texts = [f"{e['l0']} {e['l1']}" for e in envelopes]
            try:
                blobs = embed_batch(embedder, texts)
            except Exception as e:
                print(f"ABORT: batched embedding failed: {e}", file=sys.stderr)
                return 7
            for env, blob in zip(envelopes, blobs):
                if blob is not None:
                    embeddings_by_id[env['id']] = blob

        # [4] WRITE — per-node txn
        inserted_envs = []
        failed_ids = []
        conn.isolation_level = None  # autocommit; manage txn explicitly
        for env in envelopes:
            emb_blob = embeddings_by_id.get(env['id'])
            try:
                conn.execute("BEGIN")
                insert_node(conn, env, batch_id, embedding=emb_blob)
                conn.execute("COMMIT")
                inserted_envs.append(env)
            except Exception as e:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.OperationalError:
                    pass
                print(f"  FAILED {env['id']}: {e}", file=sys.stderr)
                failed_ids.append(env['id'])
                # B-6 reciprocal: if write rolled back, drop the
                # embedding from the lookup so auto-edges doesn't
                # KNN-match against a non-existent node id.
                embeddings_by_id.pop(env['id'], None)

        # [4.5] AUTO-EDGES — vec0 KNN per-inserted-node, post-WRITE so
        # intra-batch nodes can link to each other.
        edge_stats = {'edges_inserted': 0, 'nodes_with_edges': 0, 'no_match': 0}
        if vec_loaded and inserted_envs:
            edge_stats = auto_edges_for_batch(conn, inserted_envs,
                                              embeddings_by_id)

        inserted = len(inserted_envs)
        failed = len(failed_ids)
        summary['inserted'] = inserted
        summary['failed'] = failed
        summary['failed_ids'] = failed_ids[:50]
        summary['edges_inserted'] = edge_stats['edges_inserted']
        summary['nodes_with_edges'] = edge_stats['nodes_with_edges']
        summary['nodes_no_match'] = edge_stats['no_match']
        summary['vec_loaded'] = vec_loaded
        # B-C: sample report shows only successfully inserted envelopes.
        out = write_report(report_dir, batch_id, summary,
                           collisions, quarantined, inserted_envs)
        print(f"DONE: inserted={inserted} failed={failed} "
              f"edges={edge_stats['edges_inserted']} batch_id={batch_id}")
        print(f"report: {out}")
        if inserted:
            # Phase 5: imported nodes carry imported_batch_id; Mímir SA pool
            # applies 0.40× score multiplier until access_count ≥ 5.
            # Topology refresh runs every ~5 min — restart Mímir for
            # immediate effect, or wait one tick.
            print("note: imported nodes are soft-suppressed in Mímir SA "
                  "pool (×0.40) until accessed ≥4 times. Restart the "
                  "Mímir daemon for immediate topology refresh; "
                  "otherwise effect lands within ~5 min.")
        if failed:
            print(f"rollback: migrate_memory.py --db {db_path} "
                  f"--rollback-batch {batch_id}")
        return 0 if failed == 0 else 5
    finally:
        conn.close()


def cmd_list_batches(args: argparse.Namespace) -> int:
    """Phase 4 — show all imported batches with summary counts."""
    conn = sqlite3.connect(args.db, timeout=30)
    try:
        ensure_schema(conn)
        # Bi-temporal `valid_to` only exists on OSS schema.sql installs.
        # Live engine.cjs runtime ALTERs don't add it; degrade gracefully.
        cols = {r[1] for r in conn.execute("PRAGMA table_info(nodes)").fetchall()}
        bitemporal = "AND (valid_to IS NULL OR valid_to > strftime('%s','now')*1000)" \
            if 'valid_to' in cols else ''
        rows = conn.execute(
            "SELECT imported_batch_id, COUNT(*) AS n, "
            "MIN(created_at) AS first, MAX(created_at) AS last "
            "FROM nodes WHERE imported_batch_id IS NOT NULL "
            f"{bitemporal} "
            "GROUP BY imported_batch_id ORDER BY first DESC"
        ).fetchall()
        if not rows:
            print("No imported batches found.")
            return 0
        print(f"{'batch_id':<40} {'nodes':>6}  {'first':<24} {'last':<24}")
        print('-' * 100)
        def _fmt(v):
            if v is None or v == '':
                return '-'
            if isinstance(v, (int, float)):
                try:
                    return datetime.datetime.utcfromtimestamp(v/1000).isoformat()
                except Exception:
                    return str(v)
            s = str(v)
            return s[:24]
        for bid, n, first, last in rows:
            print(f"{bid:<40} {n:>6}  {_fmt(first):<24} {_fmt(last):<24}")
        return 0
    finally:
        conn.close()


def cmd_polish(args: argparse.Namespace) -> int:
    """Phase 4 — stub for Tier B LLM polish.

    Phase 6 (deferred) will implement the actual LLM call. CLI surface ships
    now so wizards / docs can reference the flag without breakage.
    """
    print("[polish] Tier B LLM polish is not yet implemented (Phase 6).")
    print(f"[polish] Target batch: {args.polish}")
    print("[polish] To enable, set MIGRATE_POLISH_LLM=anthropic|openai and rerun.")
    print("[polish] No changes written. Exit 0.")
    return 0


def cmd_rollback(args: argparse.Namespace) -> int:
    conn = sqlite3.connect(args.db, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        ensure_schema(conn)
        # Best-effort vec0 load so node_embeddings deletes succeed. The
        # rollback function already try/excepts vec0 absence, so failure
        # here is non-fatal.
        _try_load_vec0(conn)
        counts = rollback_batch(conn, args.rollback_batch)
    finally:
        conn.close()
    print(json.dumps(
        {'batch_id': args.rollback_batch, 'deleted': counts},
        indent=2, default=str,
    ))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db', required=True,
                   help='SQLite path (constellation.db)')
    p.add_argument('--input',
                   help='folder of .md/.txt to import')
    p.add_argument('--execute', action='store_true',
                   help='commit writes (omit for dry-run preview)')
    p.add_argument('--rollback-batch',
                   help='revert a previous import (ordered cascade)')
    p.add_argument('--list-batches', action='store_true',
                   help='show all imported batches with counts')
    p.add_argument('--polish',
                   help='Phase 6 stub — re-polish a batch via LLM '
                        '(advertises CLI; not yet wired)')
    p.add_argument('--batch-id',
                   help='auto-generated UTC timestamp if omitted')
    p.add_argument('--max-files', type=int, default=DEFAULT_MAX_FILES,
                   help=f'cap per batch (default {DEFAULT_MAX_FILES})')
    p.add_argument('--max-file-size', type=int,
                   default=DEFAULT_MAX_FILE_SIZE_MB,
                   help=f'per-file MB cap (default {DEFAULT_MAX_FILE_SIZE_MB})')
    p.add_argument('--max-l2-chars', type=int, default=DEFAULT_MAX_L2_CHARS,
                   help=f'truncate L2 to this length '
                        f'(default {DEFAULT_MAX_L2_CHARS})')
    # B-2: only `abort` is implemented today; `rename` was advertised in
    # planning §6 but never wired. Restricting choices to abort prevents
    # silent no-op behavior. Re-add `rename` once Phase 4+ implements id
    # remapping (and updates embeddings_by_id keying accordingly).
    p.add_argument('--collision-policy', choices=['abort'],
                   default='abort', help='Q3 lock: default abort')
    p.add_argument('--secrets-policy', choices=['quarantine', 'abort'],
                   default='quarantine')
    p.add_argument('--report-dir', default='reports',
                   help='where to write per-batch report folder')
    return p


def main() -> int:
    args = build_parser().parse_args()
    if args.list_batches:
        return cmd_list_batches(args)
    if args.polish:
        return cmd_polish(args)
    if args.rollback_batch:
        return cmd_rollback(args)
    if not args.input:
        print("ERROR: --input is required (or use --rollback-batch / "
              "--list-batches / --polish)", file=sys.stderr)
        return 2
    return cmd_migrate(args)


if __name__ == '__main__':
    sys.exit(main())
