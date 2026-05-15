// SPDX-License-Identifier: AGPL-3.0-or-later
// Topic segmenter: turn a recent-message stream into clustered topic
// segments. v1 uses BGE-M3 embeddings + simple agglomerative clustering with
// a fixed cosine threshold — no Python deps, no scikit-learn.
//
// Engine cron / dashboard hits /retrieve_segments to render the topic graph;
// this module owns the in-memory clustering and periodic refresh of the
// `topic_segments` cache table.
//
// Kill-switch: MIMIR_SEGMENTER=0 disables clustering (returns empty).

import { getDb } from './db.js';
import { embed } from './embed.js';

const KILL = String(process.env.MIMIR_SEGMENTER || '').trim() === '0';
const COSINE_MERGE = 0.62;
const MIN_SEG_SIZE = 4;
const MAX_SEG_SIZE = 60;
const REFRESH_INTERVAL_MS = parseInt(process.env.MIMIR_SEGMENTER_INTERVAL_MS || '600000', 10);

let _lastRunTs = 0;
let _intervalHandle = null;

function _cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function _ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_segments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  INTEGER NOT NULL,
      message_ids TEXT NOT NULL,
      session_ids TEXT,
      summary     TEXT,
      kind        TEXT DEFAULT 'topic',
      msg_count   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ix_topic_segments_created ON topic_segments(created_at);
  `);
  // V5b Phase 7 (2026-05-08): persona_id substrate column. NULL = shared.
  try { db.exec("ALTER TABLE topic_segments ADD COLUMN persona_id TEXT"); } catch { /* idempotent */ }
}

function _fetchRecentMessages(convDbPath, hours = 6, limit = 200) {
  try {
    const Database = require('better-sqlite3');
    const conv = new Database(convDbPath, { readonly: true });
    const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
    const rows = conv.prepare(`
      SELECT id, role, content, timestamp, session_id
        FROM messages
       WHERE timestamp >= ? AND content IS NOT NULL AND LENGTH(content) > 20
       ORDER BY timestamp DESC LIMIT ?
    `).all(cutoff, limit);
    conv.close();
    return rows.reverse();
  } catch { return []; }
}

export async function segmentRecent({
  convDbPath = null,
  hours = 6,
  limit = 200,
  persist = true,
} = {}) {
  if (KILL) return { ok: false, killed: true, segments: [] };
  if (!convDbPath) {
    return { ok: false, error: 'convDbPath required', segments: [] };
  }
  const msgs = _fetchRecentMessages(convDbPath, hours, limit);
  if (msgs.length < MIN_SEG_SIZE) return { ok: true, segments: [], note: 'too few messages' };

  const texts = msgs.map(m => String(m.content || '').slice(0, 1000));
  const vecs = await embed(texts);

  // Online agglomeration: merge each msg into the rolling current cluster if
  // cosine to centroid >= threshold; otherwise finalize current and start a
  // new one. Simple, deterministic, no scikit needed.
  const segments = [];
  let cur = null;
  for (let i = 0; i < msgs.length; i++) {
    const v = vecs[i];
    if (!cur) {
      cur = { msgs: [msgs[i]], centroid: Float32Array.from(v) };
      continue;
    }
    const sim = _cosine(cur.centroid, v);
    if (sim >= COSINE_MERGE && cur.msgs.length < MAX_SEG_SIZE) {
      const k = cur.msgs.length;
      for (let j = 0; j < cur.centroid.length; j++) {
        cur.centroid[j] = (cur.centroid[j] * k + v[j]) / (k + 1);
      }
      cur.msgs.push(msgs[i]);
    } else {
      if (cur.msgs.length >= MIN_SEG_SIZE) segments.push(cur);
      cur = { msgs: [msgs[i]], centroid: Float32Array.from(v) };
    }
  }
  if (cur && cur.msgs.length >= MIN_SEG_SIZE) segments.push(cur);

  const out = segments.map((s, idx) => ({
    segment_id: `seg-${Date.now()}-${idx}`,
    message_ids: s.msgs.map(m => m.id),
    session_ids: [...new Set(s.msgs.map(m => m.session_id).filter(Boolean))],
    msg_count: s.msgs.length,
    excerpt: s.msgs[0].content.slice(0, 240),
    summary: s.msgs[0].content.slice(0, 80) + (s.msgs[0].content.length > 80 ? '…' : ''),
  }));

  if (persist) {
    try {
      const db = getDb();
      _ensureSchema(db);
      const now = Math.floor(Date.now() / 1000);
      const ins = db.prepare(`
        INSERT INTO topic_segments (created_at, message_ids, session_ids, summary, kind, msg_count)
        VALUES (?, ?, ?, ?, 'topic', ?)
      `);
      const txn = db.transaction(() => {
        for (const s of out) {
          ins.run(now,
            JSON.stringify(s.message_ids),
            JSON.stringify(s.session_ids),
            s.summary, s.msg_count);
        }
      });
      txn();
    } catch (e) {
      // Persistence is best-effort; segments still returned to caller.
      console.warn('[mimir-js segmenter] persist failed:', e.message);
    }
  }

  _lastRunTs = Date.now();
  return { ok: true, segments: out, total: out.length };
}

export function startSegmenterLoop({ convDbPath } = {}) {
  if (KILL || _intervalHandle || !convDbPath) return false;
  _intervalHandle = setInterval(() => {
    if (Date.now() - _lastRunTs < REFRESH_INTERVAL_MS) return;
    segmentRecent({ convDbPath, persist: true })
      .catch(e => console.warn('[mimir-js segmenter] tick failed:', e.message));
  }, REFRESH_INTERVAL_MS).unref();
  return true;
}

export function stopSegmenterLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function segmenterStatus() {
  return {
    enabled: !KILL,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    interval_ms: REFRESH_INTERVAL_MS,
  };
}
