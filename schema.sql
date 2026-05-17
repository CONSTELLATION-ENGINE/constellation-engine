-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Constellation Engine Schema (OSS bootstrap)
-- 星图引擎数据库 — 拓扑记忆网络
--
-- This is the OSS-specific schema. It bakes in all columns/triggers that
-- main acquires only via the historical migration chain (phase1a bi-temporal,
-- B6 owner_id, edge evolution fine_*, event_at, subkind). Fresh OSS installs
-- skip the migration chain entirely — engine.cjs:316 applies this directly.
--
-- vec0 / fts5 virtual tables are still created at runtime by engine.cjs
-- (sqlite-vec extension must be loaded first), so they are NOT defined here.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── nodes: every memory is a node ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,          -- M-YYYYMMDDNN format
  state         TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','dormant','archived')),
  created_at    TEXT NOT NULL,             -- ISO 8601 wall-clock write time
  accessed_at   TEXT NOT NULL,             -- last render/touch time

  -- Three-layer content
  l0            TEXT NOT NULL,             -- pointer (~20 tokens)
  l1            TEXT NOT NULL,             -- summary (~80 tokens)
  l2            TEXT NOT NULL,             -- full (~300 tokens)

  -- Metadata
  tags          TEXT,                      -- JSON array, e.g. ["kc","monetary"]
  tone          TEXT,                      -- analytical | narrative | emotional | ...
  valence       REAL DEFAULT 0,            -- -1.0 to 1.0
  arousal       REAL DEFAULT 0.5,          -- 0 to 1.0
  weight        REAL DEFAULT 1.0,          -- current network weight
  conn_count    INTEGER DEFAULT 0,
  access_count  INTEGER DEFAULT 1,
  source        TEXT,                      -- diary | knowledge | insight | inbox

  -- Supersedence (FUSE / SUPERSEDE / TIMELINE_MERGE outcomes)
  superseded_at TEXT,
  superseded_by TEXT,

  -- Taxonomy
  node_type     TEXT DEFAULT 'knowledge',
  subkind       TEXT,

  -- Bi-temporal / lifecycle (phase1a + later)
  updated_at    TEXT,
  deprecated_at TEXT,

  -- Multi-owner scoping (B6, 2026-04-21). 'self' for solo OSS install.
  owner_id      TEXT,

  -- Event time = the source-time the content describes (e.g. yesterday's diary).
  -- Distinct from created_at (write-time). NULL = unspecified.
  event_at      TEXT DEFAULT NULL,

  -- Memory Migration Importer (2026-04-29). Stamped by migrate_memory.py;
  -- NULL = organic node. Used by SA pool soft-suppression and rollback.
  imported_batch_id TEXT DEFAULT NULL
);

-- ─── edges: connections between memories ────────────────────────────────
CREATE TABLE IF NOT EXISTS edges (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source                TEXT NOT NULL,
  target                TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  strength              REAL DEFAULT 0.5,
  state                 TEXT NOT NULL DEFAULT 'active',
  created_at            TEXT NOT NULL,
  accessed_at           TEXT,

  classification_source TEXT,
  confidence            REAL DEFAULT 0.5,
  owner_id              TEXT,

  -- Edge Evolution v1 (2026-04-26) — additive richness layer.
  -- edge_type stays 5-coarse (Multi-SA channel routing depends on it);
  -- fine_type / fine_confidence / fine_source are NEVER read by SA routing.
  fine_type             TEXT DEFAULT NULL,
  fine_confidence       REAL DEFAULT NULL,
  fine_source           TEXT DEFAULT NULL,

  -- Bi-temporal columns (phase1a). valid_to IS NULL = currently valid.
  -- engine.cjs _bitemporalSqlClause filters reads by this.
  valid_from            INTEGER DEFAULT (CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)),
  valid_to              INTEGER,
  superseded_by         INTEGER
);

-- vec0 rowid mapping
CREATE TABLE IF NOT EXISTS node_rowids (
  rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id)
);

-- Migration ledger. Numbered migrations skip themselves if already applied;
-- oss-bootstrap.sql pre-stamps the migration ids this schema covers.
CREATE TABLE IF NOT EXISTS migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- engine_meta: small key/value config (e.g. embedding model lock).
CREATE TABLE IF NOT EXISTS engine_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Indices ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_nodes_state          ON nodes(state);
CREATE INDEX IF NOT EXISTS idx_nodes_weight         ON nodes(weight);
CREATE INDEX IF NOT EXISTS idx_nodes_source         ON nodes(source);
CREATE INDEX IF NOT EXISTS idx_nodes_state_source   ON nodes(state, source);
CREATE INDEX IF NOT EXISTS idx_nodes_superseded     ON nodes(superseded_at);
CREATE INDEX IF NOT EXISTS idx_nodes_owner_state    ON nodes(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_nodes_type_subkind   ON nodes(node_type, subkind);
CREATE INDEX IF NOT EXISTS idx_nodes_event_at       ON nodes(event_at) WHERE event_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_imported_batch  ON nodes(imported_batch_id) WHERE imported_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_edges_source         ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target         ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_type           ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target_state   ON edges(target, state);
CREATE INDEX IF NOT EXISTS idx_edges_state_accessed ON edges(state, accessed_at);
CREATE INDEX IF NOT EXISTS idx_edges_owner_state    ON edges(owner_id, state);
CREATE INDEX IF NOT EXISTS idx_edges_fine_type      ON edges(fine_type) WHERE fine_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_valid_to       ON edges(valid_to);
CREATE INDEX IF NOT EXISTS idx_edges_state_valid    ON edges(state, valid_to);

-- ─── Triggers ───────────────────────────────────────────────────────────

-- Tags must always be a valid JSON array.
CREATE TRIGGER IF NOT EXISTS validate_tags_insert BEFORE INSERT ON nodes
BEGIN
  SELECT RAISE(ABORT, 'Invalid tags: must be a JSON array, e.g. ["tag1","tag2"]')
  WHERE NEW.tags IS NOT NULL
    AND NEW.tags <> ''
    AND (json_valid(NEW.tags) = 0 OR json_type(NEW.tags) <> 'array');
END;

CREATE TRIGGER IF NOT EXISTS validate_tags_update BEFORE UPDATE OF tags ON nodes
BEGIN
  SELECT RAISE(ABORT, 'Invalid tags: must be a JSON array, e.g. ["tag1","tag2"]')
  WHERE NEW.tags IS NOT NULL
    AND NEW.tags <> ''
    AND (json_valid(NEW.tags) = 0 OR json_type(NEW.tags) <> 'array');
END;

-- owner_id required on every nodes/edges write (B6 hardening).
CREATE TRIGGER IF NOT EXISTS nodes_owner_required_insert
BEFORE INSERT ON nodes
WHEN NEW.owner_id IS NULL OR NEW.owner_id = ''
BEGIN
  SELECT RAISE(ABORT, 'nodes.owner_id required (set OWNER_USER_ID env or pass explicitly)');
END;

CREATE TRIGGER IF NOT EXISTS nodes_owner_required_update
BEFORE UPDATE OF owner_id ON nodes
WHEN NEW.owner_id IS NULL OR NEW.owner_id = ''
BEGIN
  SELECT RAISE(ABORT, 'nodes.owner_id cannot be NULL or empty (UPDATE blocked)');
END;

CREATE TRIGGER IF NOT EXISTS edges_owner_required_insert
BEFORE INSERT ON edges
WHEN NEW.owner_id IS NULL OR NEW.owner_id = ''
BEGIN
  SELECT RAISE(ABORT, 'edges.owner_id required (auto-resolve from source node)');
END;

CREATE TRIGGER IF NOT EXISTS edges_owner_required_update
BEFORE UPDATE OF owner_id ON edges
WHEN NEW.owner_id IS NULL OR NEW.owner_id = ''
BEGIN
  SELECT RAISE(ABORT, 'edges.owner_id cannot be NULL or empty (UPDATE blocked)');
END;

-- NOTE: nodes_fts (fts5) and node_embeddings (vec0) virtual tables are
-- created at runtime by engine.cjs after sqlite-vec extension load.

