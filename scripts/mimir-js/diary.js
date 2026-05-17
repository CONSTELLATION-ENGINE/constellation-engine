// SPDX-License-Identifier: AGPL-3.0-or-later
// mimir-js diary: flat append-only log of autonomy/reflection activity.
// Mirrors the Python `mimir_diary.py` schema so a future Python ↔ JS handoff
// can read either side. Storage lives in constellation.db alongside nodes.
//
// Shape:
//   diary_entries — one row per recorded act (raw text + metadata)
//   diary_vec     — vec0 virtual table keyed by rowid for KNN match
//   diary_meta    — schema/version + locked embed_dim
//
// Kill-switch: MIMIR_DIARY=0 disables append/knn (recent still works for
// observability). Default ON.

import { getDb } from './db.js';
import { EMBED_DIM } from './embed.js';

const SCHEMA_VERSION = '1';
const KILL = String(process.env.MIMIR_DIARY || '').trim() === '0';

// Observation panel auto-prune: rotate fire/skip rows past 24h so the dashboard
// stays focused on "what just happened". Reflections (kind='reflection') and
// other narrative entries are NOT in this list — they live by the 90d default.
export const OBSERVATION_KINDS = [
  'fire_v3',
  'skip_fuse',
  'skip_rejected',
  'picker_invalid',
  'secondary_concerns',
];

let _initialized = false;
let _vecAvailable = null; // null=unknown, true=ok, false=ext missing

function _initSchema() {
  if (_initialized) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS diary_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS diary_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      text       TEXT NOT NULL,
      source     TEXT,
      session_id TEXT,
      owner_id   TEXT NOT NULL DEFAULT 'self',
      meta       TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_diary_ts    ON diary_entries(ts);
    CREATE INDEX IF NOT EXISTS ix_diary_kind  ON diary_entries(kind);
    CREATE INDEX IF NOT EXISTS ix_diary_owner ON diary_entries(owner_id);

    CREATE TABLE IF NOT EXISTS library_read_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      owner_id    TEXT NOT NULL,
      path        TEXT NOT NULL,
      mode        TEXT NOT NULL,
      origin      TEXT NOT NULL,
      diary_id    INTEGER,
      meta        TEXT,
      page_count  INTEGER,
      digest      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_library_read_log_path_ts  ON library_read_log(path, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_library_read_log_owner_ts ON library_read_log(owner_id, ts DESC);
  `);

  try {
    const cols = new Set(
      db.prepare('PRAGMA table_info(library_read_log)').all().map(r => r.name)
    );
    if (!cols.has('page_count')) {
      db.exec('ALTER TABLE library_read_log ADD COLUMN page_count INTEGER');
    }
    if (!cols.has('digest')) {
      db.exec('ALTER TABLE library_read_log ADD COLUMN digest TEXT');
    }
  } catch (e) {
    console.warn('[mimir-js diary] library_read_log column add skipped:', e.message);
  }

  // Mímir v4 Phase 0: nodes.fire_count is bumped from /session_end after the
  // picker's candidate_id is back-filled. The earlier insert-time trigger
  // bumped meta.top_node (SA-argmax), which defeated Cold/Novel pools'
  // anti-hyperfixation by always counting the most-active node. Drop any
  // legacy trigger from prior installs so it never fires again.
  try {
    db.exec('DROP TRIGGER IF EXISTS bump_fire_count_on_diary');
  } catch (e) {
    console.warn('[mimir-js diary] legacy fire_count trigger drop skipped:', e.message);
  }

  // version + dim lock (mirrors engine_meta tier-lock pattern)
  const existing = new Map(
    db.prepare('SELECT key, value FROM diary_meta').all().map(r => [r.key, r.value])
  );
  if (!existing.has('schema_version')) {
    db.prepare('INSERT INTO diary_meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  }
  if (!existing.has('embed_dim')) {
    db.prepare('INSERT INTO diary_meta(key, value) VALUES (?, ?)').run('embed_dim', String(EMBED_DIM));
  } else {
    const locked = parseInt(existing.get('embed_dim'), 10);
    if (locked !== EMBED_DIM) {
      throw new Error(`mimir-js diary embed_dim mismatch: file locked at ${locked}, encoder is ${EMBED_DIM}`);
    }
  }

  // Probe vec0 once. If sqlite-vec isn't loadable, KNN routes degrade to recent().
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS diary_vec USING vec0(embedding float[${EMBED_DIM}])`);
    _vecAvailable = true;
  } catch (e) {
    _vecAvailable = false;
    console.warn('[mimir-js diary] vec0 unavailable — KNN will fall back to time scan:', e.message);
  }

  _initialized = true;
}

export function isVecAvailable() {
  if (!_initialized) try { _initSchema(); } catch { return false; }
  return _vecAvailable === true;
}

export function appendDiary({
  kind,
  text,
  source = '',
  sessionId = '',
  ownerId = 'self',
  meta = null,
  embedding = null,
  ts = null,
} = {}) {
  if (KILL) return null;
  if (!kind || !text) throw new Error('diary append requires kind and text');
  _initSchema();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const tsVal = Number.isFinite(ts) ? Math.floor(ts) : now;
  const metaJson = meta ? JSON.stringify(meta) : null;

  const txn = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO diary_entries (ts, kind, text, source, session_id, owner_id, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tsVal, String(kind), String(text), source || null, sessionId || null, ownerId, metaJson, now);
    const rowId = info.lastInsertRowid;
    if (embedding && _vecAvailable) {
      const arr = Array.from(embedding);
      if (arr.length !== EMBED_DIM) {
        throw new Error(`diary embedding dim ${arr.length} != locked ${EMBED_DIM}`);
      }
      db.prepare('INSERT INTO diary_vec(rowid, embedding) VALUES (?, ?)')
        .run(rowId, JSON.stringify(arr));
    }
    return Number(rowId);
  });
  return txn();
}

// In-place merge of meta[key]=value on a single diary entry. Used by the
// L1 back-fill path: fire_v3 rows are written BEFORE the picker LLM
// responds, so chosen_action is unknown at write time. The /session_end
// handler patches it in once last_response is parsed, so distribution
// queries can GROUP BY chosen_action without joining sessions back.
// Returns true iff a row was updated.
export function updateDiaryMeta(rowId, key, value) {
  if (KILL) return false;
  if (!Number.isInteger(rowId) || !key) return false;
  _initSchema();
  const db = getDb();
  let v = value;
  if (v && typeof v === 'object') v = JSON.stringify(v);
  const info = db.prepare(
    "UPDATE diary_entries " +
    "SET meta = json_set(COALESCE(meta, '{}'), ?, ?) " +
    "WHERE id = ?"
  ).run(`$.${key}`, v, rowId);
  return info.changes > 0;
}

// Same as updateDiaryMeta, but only writes when meta[key] IS NULL.
// Used by Hybrid A+C (2026-05-11): chosen_action / chosen_action_source /
// candidate_id are stamped at fire-time when the forced tool_choice picker
// resolves. The legacy /session_end back-fill still runs but must NOT
// clobber the fire-time stamp. Returns true iff a row was actually patched.
export function updateDiaryMetaIfNull(rowId, key, value) {
  if (KILL) return false;
  if (!Number.isInteger(rowId) || !key) return false;
  _initSchema();
  const db = getDb();
  let v = value;
  if (v && typeof v === 'object') v = JSON.stringify(v);
  const info = db.prepare(
    "UPDATE diary_entries " +
    "SET meta = json_set(COALESCE(meta, '{}'), ?, ?) " +
    "WHERE id = ? AND json_extract(COALESCE(meta, '{}'), ?) IS NULL"
  ).run(`$.${key}`, v, rowId, `$.${key}`);
  return info.changes > 0;
}

// Look up the most recent fire_v3 row for a given session_id. Used by
// the /session_end back-fill path.
export function getFireDiaryIdBySession(sessionId, maxAgeHours = 6) {
  if (!sessionId) return null;
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeHours * 3600);
  const row = db.prepare(
    "SELECT id FROM diary_entries " +
    "WHERE session_id = ? AND kind = 'fire_v3' AND ts >= ? " +
    "ORDER BY ts DESC LIMIT 1"
  ).get(sessionId, cutoff);
  return row ? Number(row.id) : null;
}

export function recentDiary({
  hours = 24,
  kinds = null,
  ownerId = 'self',
  limit = 50,
} = {}) {
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(hours * 3600);
  const params = [cutoff, ownerId];
  let sql = `SELECT id, ts, kind, text, source, session_id, meta
               FROM diary_entries
              WHERE ts >= ? AND owner_id = ?`;
  if (Array.isArray(kinds) && kinds.length) {
    sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(Math.max(1, Math.min(500, limit | 0)));
  return db.prepare(sql).all(...params);
}

export function knnDiary(embedding, {
  k = 5,
  maxAgeHours = 168,
  ownerId = 'self',
  kinds = null,
} = {}) {
  _initSchema();
  if (!_vecAvailable) {
    return recentDiary({ hours: maxAgeHours, ownerId, limit: k, kinds });
  }
  const arr = Array.from(embedding || []);
  if (arr.length !== EMBED_DIM) {
    throw new Error(`diary knn dim ${arr.length} != locked ${EMBED_DIM}`);
  }
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeHours * 3600);
  let sql = `SELECT e.id, e.ts, e.kind, e.text, e.source, e.session_id, e.meta, v.distance
               FROM diary_vec v
               JOIN diary_entries e ON e.id = v.rowid
              WHERE v.embedding MATCH ? AND k = ?
                AND e.ts >= ? AND e.owner_id = ?`;
  const params = [JSON.stringify(arr), Math.max(1, Math.min(50, k | 0)), cutoff, ownerId];
  if (Array.isArray(kinds) && kinds.length) {
    sql += ` AND e.kind IN (${kinds.map(() => '?').join(',')})`;
    params.push(...kinds);
  }
  sql += ' ORDER BY v.distance';
  return getDb().prepare(sql).all(...params);
}

export function pruneObservation(maxAgeHours = 24) {
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeHours * 3600);
  const placeholders = OBSERVATION_KINDS.map(() => '?').join(',');
  const txn = db.transaction(() => {
    if (_vecAvailable) {
      db.prepare(`DELETE FROM diary_vec
                   WHERE rowid IN (SELECT id FROM diary_entries
                                    WHERE ts < ? AND kind IN (${placeholders}))`)
        .run(cutoff, ...OBSERVATION_KINDS);
    }
    return db.prepare(
      `DELETE FROM diary_entries WHERE ts < ? AND kind IN (${placeholders})`
    ).run(cutoff, ...OBSERVATION_KINDS).changes;
  });
  return txn();
}

export function actionDistribution(maxAgeHours = 24, { byPool = false } = {}) {
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeHours * 3600);
  // Source: fire_v3 entries with chosen_action back-filled by /session_end.
  // chosen_action is the picker's actual choice (incl. reflection/curation/
  // tension which don't write rate-limited rows elsewhere). v4 picker fires
  // also stash a `pool` (hot|cold|bridge|novel) — surface it when requested.
  const sql = byPool
    ? "SELECT json_extract(meta, '$.chosen_action') AS act, " +
      "       json_extract(meta, '$.pool')          AS pool, " +
      "       COUNT(*) AS n " +
      "  FROM diary_entries " +
      " WHERE kind = 'fire_v3' AND ts >= ? " +
      " GROUP BY act, pool"
    : "SELECT json_extract(meta, '$.chosen_action') AS act, COUNT(*) AS n " +
      "  FROM diary_entries " +
      " WHERE kind = 'fire_v3' AND ts >= ? " +
      " GROUP BY act";
  const rows = db.prepare(sql).all(cutoff);
  const CANONICAL = [
    'reflection', 'curation', 'tension', 'profile',
    'fetch', 'library_fetch', 'outreach', 'skip',
  ];
  const POOLS = ['hot', 'cold', 'bridge', 'novel'];
  const by = {};
  for (const a of CANONICAL) {
    by[a] = byPool
      ? { fire: 0, by_pool: { hot: 0, cold: 0, bridge: 0, novel: 0, unknown: 0 } }
      : { fire: 0 };
  }
  by.unknown = byPool
    ? { fire: 0, by_pool: { hot: 0, cold: 0, bridge: 0, novel: 0, unknown: 0 } }
    : { fire: 0 };
  const byPoolTotals = byPool ? { hot: 0, cold: 0, bridge: 0, novel: 0, unknown: 0 } : null;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    const key = (r.act && by[r.act]) ? r.act : 'unknown';
    by[key].fire += n;
    if (byPool) {
      const poolKey = (r.pool && POOLS.includes(r.pool)) ? r.pool : 'unknown';
      by[key].by_pool[poolKey] += n;
      byPoolTotals[poolKey] += n;
    }
  }
  const out = { ok: true, hours: maxAgeHours, total, by_action: by };
  if (byPool) out.by_pool = byPoolTotals;
  return out;
}

export function pruneDiary(maxAgeDays = 90) {
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(maxAgeDays * 86400);
  const txn = db.transaction(() => {
    if (_vecAvailable) {
      db.prepare(`DELETE FROM diary_vec
                   WHERE rowid IN (SELECT id FROM diary_entries WHERE ts < ?)`).run(cutoff);
    }
    return db.prepare('DELETE FROM diary_entries WHERE ts < ?').run(cutoff).changes;
  });
  return txn();
}

// Append one library_read_log event (one row per successful library_fetch fire).
// Caller writes only on confirmed read success — no upserts, no backfill.
// page_count/digest are L1 enhancements: page_count from pdfinfo at fire time;
// digest filled later via updateLibraryReadDigest().
export function logLibraryRead({
  path,
  mode,
  origin,
  diaryId = null,
  ownerId = 'self',
  meta = null,
  ts = null,
  pageCount = null,
  digest = null,
} = {}) {
  if (KILL) return null;
  if (!path || !mode || !origin) {
    throw new Error('log_library_read requires path, mode, origin');
  }
  _initSchema();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const tsVal = Number.isFinite(ts) ? Math.floor(ts) : now;
  const metaJson = meta ? JSON.stringify(meta) : null;
  const info = db.prepare(
    `INSERT INTO library_read_log
       (ts, owner_id, path, mode, origin, diary_id, meta, page_count, digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tsVal, ownerId, String(path), String(mode), String(origin),
    Number.isInteger(diaryId) ? diaryId : null,
    metaJson,
    Number.isFinite(pageCount) ? Math.floor(pageCount) : null,
    digest != null ? String(digest) : null,
  );
  return Number(info.lastInsertRowid);
}

// Backfill digest on an existing library_read_log row. Returns true on touch.
export function updateLibraryReadDigest(logId, digest) {
  if (KILL) return false;
  if (!Number.isInteger(logId) || logId <= 0) return false;
  _initSchema();
  const db = getDb();
  const info = db.prepare(
    'UPDATE library_read_log SET digest = ? WHERE id = ?'
  ).run(digest != null ? String(digest) : null, logId);
  return info.changes > 0;
}

// Reflection context: assemble recent activity for a daily-reflection prompt.
// Engine cron calls this, runs the LLM, then POSTs the reflection back via
// /diary/append. Mimir-js owns storage + assembly; engine owns the LLM call.
export function buildReflectionContext({
  hoursBack = 24,
  ownerId = 'self',
} = {}) {
  _initSchema();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(hoursBack * 3600);

  const recentNodes = (() => {
    try {
      return db.prepare(`
        SELECT id, l0, l1, node_type, source, accessed_at
          FROM nodes
         WHERE state='active' AND superseded_at IS NULL
           AND COALESCE(accessed_at, 0) >= ?
         ORDER BY accessed_at DESC LIMIT 25
      `).all(cutoff);
    } catch { return []; }
  })();

  const priorEntries = recentDiary({ hours: hoursBack, ownerId, limit: 25 });

  return {
    ok: true,
    hours: hoursBack,
    cutoff,
    recent_nodes: recentNodes,
    prior_entries: priorEntries,
    note: 'Engine cron should call its consolidation-tier LLM with this context, then POST the reflection text back to /diary/append.',
  };
}
