#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// mimir-js: in-process JS replacement for the Python Mímir daemon.
// OSS v1 — ships with real BGE-M3 embed/rerank (via @xenova/transformers ONNX)
// and sqlite-backed reads. Spreading-activation pool is simplified vs the
// 30-layer Python Multi-SA; full parity arrives in v1.1.
//
// Boot:
//   node scripts/mimir-js/index.js
// Env:
//   MIMIR_PORT      default 18810
//   MIMIR_HOST      default 127.0.0.1
//   CONSTELLATION_DB  path to constellation.db (default: ../../constellation.db)

import { createServer } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { openDb, getDb, closeDb } from './db.js';
import { embed, EMBED_DIM, toBlob, loadEmbedder, isReady as embedReady } from './embed.js';
import { rerank } from './rerank.js';
import { getPool, getStatus } from './pool.js';
import * as sa from './sa.js';
import { reasonPaths, reasonAbduction, reasonDeduction, reasonAnalogy } from './reason.js';
import { compile, compileSkeleton } from './compile.js';
import {
  appendDiary, recentDiary, knnDiary, pruneDiary,
  updateDiaryMeta, updateDiaryMetaIfNull, getFireDiaryIdBySession,
  pruneObservation, actionDistribution,
  buildReflectionContext, isVecAvailable as diaryVecReady,
  logLibraryRead, updateLibraryReadDigest,
} from './diary.js';
import { reconsolidateBatch, reconsolidationStatus } from './reconsolidate.js';
import { runDreamCycle, startDreamLoop, stopDreamLoop, noteUserActivity, dreamStatus } from './dream.js';
import { evolveEdges, startEvolutionLoop, stopEvolutionLoop, evolutionStatus } from './edge-evolution.js';
import { segmentRecent, startSegmenterLoop, stopSegmenterLoop, segmenterStatus } from './segment.js';
import { llmRerank } from './llm-retriever.js';
import { startWatchdog, stopWatchdog, noteHeartbeat, watchdogStatus } from './watchdog.js';
import { startHeartbeat, stopHeartbeat, heartbeatStatus } from './heartbeat.js';
import { liveStatus } from './live-push.js';
import { startHebbLoop, stopHebbLoop, runHebbWriteback, hebbStatus, setNoveltyGateEnabled } from './hebb.js';
import { startRuminationLoop, stopRuminationLoop, runRumination, ruminationStatus, noteExternalSignal as noteRumSignal, setRuminationEnabled } from './rumination.js';
import { startEdgeDecayLoop, stopEdgeDecayLoop, runEdgeDecay, edgeDecayStatus } from './edge-decay.js';
import { startWalCheckpointLoop, stopWalCheckpointLoop, runWalCheckpoint, walCheckpointStatus } from './wal-checkpoint.js';
import { startHealthMonitor, stopHealthMonitor, runHealthCheck, healthStatus, configureHealthMonitor } from './health-monitor.js';
import {
  startAutonomyLoop, stopAutonomyLoop, autonomyStatus,
  getAutonomyState, applyConfigPatch,
  loadAutonomyConfig, saveAutonomyConfig,
} from './autonomy.js';
const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_PORT = parseInt(process.env.MIMIR_PORT || '18810', 10);
const PORT_RANGE = parseInt(process.env.MIMIR_PORT_RANGE || '10', 10);
const HOST = process.env.MIMIR_HOST || '127.0.0.1';
const DB_PATH = process.env.CONSTELLATION_DB
  || resolve(__dirname, '..', '..', 'constellation.db');
// Install-id is the cross-process handshake token. Launcher generates a UUID
// per install and propagates via env to both mimir and engine; engine refuses
// to talk to a /status reporting a different id (foreign daemon defense).
const INSTALL_ID = process.env.INSTALL_ID || randomUUID();
// Path to advertise the resolved port back to the launcher / engine. Defaults
// to <db-parent>/.mimir-runtime.json so dev runs without an explicit env var
// still drop the file next to constellation.db.
const RUNTIME_FILE = process.env.MIMIR_RUNTIME_FILE
  || resolve(dirname(DB_PATH), '.mimir-runtime.json');

const BOOT_TS = Date.now();
let RESOLVED_PORT = null;  // filled in once server.listen succeeds
let _observationPruneTimer = null;

// ─── tiny router ─────────────────────────────────────────────────────────
const routes = new Map();
function route(method, path, handler) { routes.set(`${method} ${path}`, handler); }

function send(res, status, body, contentType = 'application/json') {
  const payload = contentType === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > maxBytes) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (n === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

function ok(extra = {}) { return { ok: true, ...extra }; }

// Extract the first balanced top-level JSON object from a string. Tracks
// brace nesting and skips over string literals so nested `{...}` inside
// `payload` doesn't terminate the match prematurely. Returns
// { obj, endIdx } where endIdx is the index just after the closing brace
// (so callers can resume scanning from there). Returns null on no candidate.
function _splitFirstJsonObj(s) {
  if (!s || typeof s !== 'string') return null;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return { obj: JSON.parse(s.slice(start, i + 1)), endIdx: i + 1 }; }
        catch { return { obj: null, endIdx: i + 1 }; }
      }
    }
  }
  return null;
}

// Legacy single-object extractor — kept for any callers expecting the older
// "first balanced dict" semantics. New picker back-fill uses
// _extractPickerActionJson which walks past unrelated dicts.
function _extractFirstJsonObj(s) {
  const r = _splitFirstJsonObj(s);
  return r ? r.obj : null;
}

// Walk all balanced top-level JSON dicts in `text` and return the picker
// envelope. Balanced-tier pickers sometimes emit unrelated JSON blobs (DEBRIEF
// metadata, TASK_TOUCH receipts) that pre-empt the picker envelope under the
// first-balanced-dict rule. Prefer dicts with BOTH action AND candidate_id
// (canonical picker contract); fall back to action-only if no full envelope
// is found. Returns null if no dict carries even an action field.
// Why: picker-LLM contract violations were leaving fire_count writeback dead
// because the first-action-bearing blob was often a DEBRIEF without
// candidate_id, masking the real envelope downstream.
function _extractPickerActionJson(text) {
  if (!text || typeof text !== 'string') return null;
  let cursor = 0;
  let guard = 0;
  let bestPartial = null;
  while (cursor < text.length && guard < 20) {
    guard++;
    const r = _splitFirstJsonObj(text.slice(cursor));
    if (!r) break;
    const obj = r.obj;
    if (obj && typeof obj === 'object'
        && typeof obj.action === 'string' && obj.action.trim()) {
      if (typeof obj.candidate_id === 'string' && obj.candidate_id.trim()) {
        return obj;
      }
      if (!bestPartial) bestPartial = obj;
    }
    if (r.endIdx <= 0) break;
    cursor += r.endIdx;
  }
  return bestPartial;
}

// Best-effort fallback when the picker LLM skipped its JSON envelope. Maps
// the dedup'd tool list captured by agent-runtime to a v3/v4 action label so
// the K-panel distribution query has something to GROUP BY besides NULL.
// Returns null when the signal is too weak (no tools, or tools we don't
// trust to imply intent) — caller leaves chosen_action NULL in that case.
// Mirrors mimir_daemon.py _infer_action_from_tools — keep the maps in sync.
function _inferActionFromTools(toolsUsed) {
  if (!toolsUsed || !Array.isArray(toolsUsed)) return null;
  const names = [];
  for (const t of toolsUsed) {
    if (typeof t === 'string' && t) names.push(t);
    else if (t && typeof t === 'object') {
      const n = t.name || t.tool;
      if (typeof n === 'string' && n) names.push(n);
    }
  }
  if (!names.length) return null;
  const bare = new Set(names.map(n => n.includes('__') ? n.split('__').pop() : n));
  if (bare.has('constellation_remember')) return 'reflection';
  if (bare.has('constellation_dive')) return 'curation';
  for (const n of [
    'constellation_query', 'constellation_search_dive',
    'library_fetch', 'web_fetch', 'WebFetch', 'WebSearch',
  ]) {
    if (bare.has(n)) return 'fetch';
  }
  for (const n of bare) {
    if (n.startsWith('telegram') || n.startsWith('browser_') || n.startsWith('desktop_')) {
      return 'outreach.dm';
    }
  }
  return null;
}

// ─── /status, /state ─────────────────────────────────────────────────────
route('GET', '/status', async (req, res) => {
  const s = getStatus();
  s.uptime_ms = Date.now() - BOOT_TS;
  s.embedder_ready = embedReady();
  s.embedder_model = 'Xenova/bge-m3';
  s.embedder_dim = EMBED_DIM;
  s.install_id = INSTALL_ID;
  s.port = RESOLVED_PORT;
  send(res, 200, s);
});

route('GET', '/state', async (req, res) => {
  const s = getStatus();
  s.uptime_ms = Date.now() - BOOT_TS;
  s.install_id = INSTALL_ID;
  s.port = RESOLVED_PORT;
  send(res, 200, s);
});

route('POST', '/state', async (req, res) => {
  // Engine occasionally POSTs to /state for filtered views — return same shape.
  const s = getStatus();
  send(res, 200, s);
});

// ─── /pool ───────────────────────────────────────────────────────────────
route('GET', '/pool', async (req, res) => {
  try { send(res, 200, getPool()); }
  catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('POST', '/pool', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    send(res, 200, getPool({ size: parseInt(body?.size, 10) || undefined }));
  }
  catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ─── /embed ──────────────────────────────────────────────────────────────
route('POST', '/embed', async (req, res) => {
  try {
    const body = await readJson(req);
    const texts = Array.isArray(body.texts) ? body.texts
                : (typeof body.text === 'string' ? [body.text] : []);
    if (texts.length === 0) return send(res, 400, { ok: false, error: 'texts required' });
    const embeddings = await embed(texts);
    send(res, 200, { ok: true, model: 'Xenova/bge-m3', dim: EMBED_DIM, embeddings });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /rerank ─────────────────────────────────────────────────────────────
// Two modes:
//   1) Pool-mode (agent-runtime): { node_ids, query_text, keep_count,
//        bridge_ids?, bridge_bonus? } → cosine vs node_embeddings vec0,
//        returns { ok, kept:[{id,cosine,score,bridge}], dropped:[...], query_dim }
//   2) Doc-mode (tools / smoke):    { query, documents } → cross-encoder rerank,
//        returns { ok, ranked:[{index,score}] }
route('POST', '/rerank', async (req, res) => {
  try {
    const body = await readJson(req);
    const nodeIds = Array.isArray(body.node_ids) ? body.node_ids : null;

    if (nodeIds) {
      const queryText = (body.query_text || body.query || '').toString().trim();
      const keepCount = Math.max(0, parseInt(body.keep_count, 10) || 0);
      const bridgeIds = new Set(Array.isArray(body.bridge_ids) ? body.bridge_ids : []);
      const bridgeBonus = Number.isFinite(body.bridge_bonus) ? body.bridge_bonus : 0.1;

      if (nodeIds.length === 0) {
        return send(res, 200, { ok: true, kept: [], dropped: [], query_dim: EMBED_DIM });
      }
      if (!queryText) {
        return send(res, 400, { ok: false, error: 'query_text required' });
      }

      let qv;
      try { [qv] = await embed([queryText]); }
      catch (e) { return send(res, 503, { ok: false, error: `embeddings not ready: ${e.message}` }); }

      const db = getDb();
      // Bulk-fetch embeddings for the requested node_ids in one query.
      const placeholders = nodeIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT r.node_id AS id, ne.embedding
          FROM node_embeddings ne
          JOIN node_rowids r ON r.rowid = ne.rowid
         WHERE r.node_id IN (${placeholders})
      `).all(...nodeIds);
      const vecById = new Map();
      for (const row of rows) {
        try {
          const buf = row.embedding;
          const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
          vecById.set(row.id, f);
        } catch {}
      }

      const scored = [];
      for (const nid of nodeIds) {
        const v = vecById.get(nid);
        const isBridge = bridgeIds.has(nid);
        if (!v) {
          scored.push({ id: nid, cosine: 0, score: 0, bridge: isBridge });
          continue;
        }
        let dot = 0;
        for (let i = 0; i < v.length && i < qv.length; i++) dot += qv[i] * v[i];
        const cos = dot;
        const bonus = isBridge ? bridgeBonus : 0;
        scored.push({
          id: nid,
          cosine: Math.round(cos * 1e4) / 1e4,
          score: Math.round((cos + bonus) * 1e4) / 1e4,
          bridge: isBridge,
        });
      }
      scored.sort((a, b) => b.score - a.score);
      const k = Math.max(0, Math.min(keepCount, scored.length));
      return send(res, 200, {
        ok: true,
        kept: scored.slice(0, k),
        dropped: scored.slice(k),
        query_dim: EMBED_DIM,
      });
    }

    const query = body.query || body.q || '';
    const docs = Array.isArray(body.documents) ? body.documents
              : Array.isArray(body.docs) ? body.docs
              : [];
    const ranked = await rerank(query, docs.map(d => typeof d === 'string' ? d : (d.text || d.content || '')));
    send(res, 200, { ok: true, ranked });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /episodic_query: vec0 KNN over node_embeddings ──────────────────────
route('POST', '/episodic_query', async (req, res) => {
  try {
    const body = await readJson(req);
    const query = body.query || body.q || '';
    const limit = Math.min(50, Math.max(1, parseInt(body.limit || 10, 10)));
    if (!query) return send(res, 400, { ok: false, error: 'query required' });
    let db;
    try { db = getDb(); }
    catch {
      return send(res, 200, { ok: true, results: [], segments: [], pool_size: 0, episodic_context: null, cross_activated: false });
    }
    const [qv] = await embed([query]);
    let rows = [];
    try {
      // node_embeddings is a vec0 virtual table created at engine boot. Some installs
      // expose it as `node_embeddings`; if absent, fall back to text scan.
      rows = db.prepare(`
        SELECT n.id AS node_id, n.l0, n.l1, n.l2, n.source, n.node_type,
               distance
          FROM node_embeddings
          JOIN node_rowids r ON r.rowid = node_embeddings.rowid
          JOIN nodes n ON n.id = r.node_id
         WHERE node_embeddings.embedding MATCH ?
           AND k = ?
           AND n.state='active' AND n.superseded_at IS NULL
         ORDER BY distance ASC
      `).all(toBlob(qv), limit);
    } catch (e) {
      // Vec table missing — fall back to recent + text-LIKE filter
      const stripped = query.slice(0, 40).replace(/[%_\\]/g, '').trim();
      const like = `%${stripped}%`;
      rows = stripped.length === 0 ? [] : db.prepare(`
        SELECT id AS node_id, l0, l1, l2, source, node_type, 0 AS distance
          FROM nodes
         WHERE state='active' AND superseded_at IS NULL
           AND (l0 LIKE ? OR l1 LIKE ? OR l2 LIKE ?)
         ORDER BY accessed_at DESC LIMIT ?
      `).all(like, like, like, limit);
    }
    // Engine reads episodicRes.{episodic_context, segments, pool_size,
    // cross_activated}. v1: surface the KNN hits as one segment per node so
    // the engine has something to render. v1.1 will cluster into topic
    // segments like the Python daemon's TopicGraph builder.
    const segments = rows.map((r, i) => ({
      segment_id: `seg-${i}`,
      node_ids: [r.node_id],
      summary: r.l1 || r.l0 || '',
      excerpt: r.l2 || r.l1 || r.l0 || '',
      rerank_score: Math.max(0, 1 - (r.distance ?? 0)),
      score: Math.max(0, 1 - (r.distance ?? 0)),
      messages: [],
    }));
    const episodic_context = segments.length === 0
      ? null
      : segments.slice(0, 5).map(s => `- ${s.summary}`).join('\n');
    send(res, 200, {
      ok: true,
      results: rows,                     // back-compat
      segments,
      pool_size: segments.length,
      episodic_context,
      cross_activated: false,
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /retrieve_conversations: text + vector search over conversations ────
route('POST', '/retrieve_conversations', async (req, res) => {
  try {
    const body = await readJson(req);
    const query = body.query || '';
    const limit = Math.min(20, Math.max(1, parseInt(body.limit || 5, 10)));
    if (!query) return send(res, 200, { ok: true, results: [] });

    // Conversations live in conversations.db. Try opening if present.
    const convPath = resolve(dirname(DB_PATH), 'conversations.db');
    if (!existsSync(convPath)) return send(res, 200, { ok: true, results: [] });
    let conv;
    try {
      const Database = (await import('better-sqlite3')).default;
      conv = new Database(convPath, { readonly: true });
    } catch { return send(res, 200, { ok: true, results: [] }); }

    let rows = [];
    try {
      // FTS5 if available — bm25 score normalized to ~0..1 range.
      rows = conv.prepare(`
        SELECT m.id, m.role, m.content, m.timestamp, m.session_id,
               -bm25(messages_fts) AS raw_score
          FROM messages_fts f
          JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ?
         ORDER BY raw_score DESC LIMIT ?
      `).all(query.slice(0, 200), limit);
      // Normalize: BM25 typically -10..0 (more negative = better); flip to 0..1.
      for (const r of rows) {
        r.score = Math.min(1, Math.max(0, (r.raw_score || 0) / 10));
        delete r.raw_score;
      }
    } catch {
      try {
        const stripped = query.slice(0, 40).replace(/[%_\\]/g, '').trim();
        const like = `%${stripped}%`;
        rows = stripped.length === 0 ? [] : conv.prepare(`
          SELECT id, role, content, timestamp, session_id
            FROM messages
           WHERE content LIKE ?
           ORDER BY timestamp DESC LIMIT ?
        `).all(like, limit);
        // LIKE matches are exact-substring — score 0.6 (above the engine's 0.3 gate).
        for (const r of rows) r.score = 0.6;
      } catch {}
    }
    try { conv.close(); } catch {}
    send(res, 200, { ok: true, results: rows });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /digest: recent session digests (engine consumes sessions[]) ────────
// Engine reads: digestRes.count, digestRes.sessions[].{session_id, type,
// summary, last_response, updated_at, checkpoints_count}.
// OSS first-run: empty sessions table → empty digest. That's fine.
route('GET', '/digest', async (req, res) => {
  try {
    const url = parseUrl(req.url, true);
    const limit = Math.min(50, Math.max(1, parseInt(url.query.limit || 10, 10)));
    let sessions = [];
    try {
      const rows = getDb().prepare(`
        SELECT id AS session_id, summary, last_active_at, message_count
          FROM sessions
         WHERE is_temp = 0 OR is_temp IS NULL
         ORDER BY last_active_at DESC LIMIT ?
      `).all(limit);
      sessions = rows.map(r => ({
        session_id: r.session_id,
        type: 'regular',
        summary: r.summary || '',
        last_response: '',
        updated_at: r.last_active_at,
        checkpoints_count: r.message_count || 0,
      }));
    } catch { sessions = []; }
    send(res, 200, {
      ok: true,
      count: sessions.length,
      since: Date.now() / 1000 - 86400,
      sessions,
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary_search ───────────────────────────────────────────────────────
// Honors the diary_search tool contract: mode='knn'|'recent', k, max_age_hours,
// kinds[]. Returns { ok, hits:[{ts, kind, distance?, text, source?, meta?}] }.
// knn → embed query then KNN diary_vec; recent → time-window scan with kinds.
route('POST', '/diary_search', async (req, res) => {
  try {
    const body = await readJson(req);
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const k = Math.max(1, Math.min(50, parseInt(body.k || body.limit || 5, 10)));
    const maxAgeHours = Number.isFinite(body.max_age_hours) ? body.max_age_hours : 168;
    const kinds = Array.isArray(body.kinds) && body.kinds.length ? body.kinds : null;
    const mode = body.mode === 'recent' || (body.mode == null && !query) ? 'recent' : 'knn';
    const ownerId = body.owner_id || body.ownerId || 'self';

    let rows = [];
    if (mode === 'knn' && query) {
      try {
        const [qv] = await embed([query]);
        rows = knnDiary(qv, { k, maxAgeHours, ownerId, kinds });
      } catch {
        rows = recentDiary({ hours: maxAgeHours, kinds, ownerId, limit: k });
      }
    } else {
      rows = recentDiary({ hours: maxAgeHours, kinds, ownerId, limit: k });
    }
    const hits = (rows || []).map(r => {
      let metaObj = null;
      try { metaObj = r.meta ? JSON.parse(r.meta) : null; } catch {}
      return { ...r, meta: metaObj };
    });
    send(res, 200, { ok: true, hits });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary/append ───────────────────────────────────────────────────────
// Engine cron / autonomy loop calls this to record a reflection or activity
// row. Returns null id if MIMIR_DIARY=0 kill-switch is set.
route('POST', '/diary/append', async (req, res) => {
  try {
    const body = await readJson(req);
    const id = appendDiary({
      kind: body.kind,
      text: body.text,
      source: body.source || '',
      sessionId: body.session_id || body.sessionId || '',
      ownerId: body.owner_id || body.ownerId || 'self',
      meta: body.meta || null,
      embedding: Array.isArray(body.embedding) ? body.embedding : null,
      ts: Number.isFinite(body.ts) ? body.ts : null,
    });
    send(res, 200, { ok: true, id, killed: id === null });
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  }
});

// ─── /diary/recent ───────────────────────────────────────────────────────
route('POST', '/diary/recent', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const rows = recentDiary({
      hours: Number.isFinite(body.hours) ? body.hours : 24,
      kinds: Array.isArray(body.kinds) ? body.kinds : null,
      ownerId: body.owner_id || body.ownerId || 'self',
      limit: parseInt(body.limit, 10) || 50,
    });
    send(res, 200, { ok: true, results: rows });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary_recent — GET wrapper for dashboard observation panel ─────────
// Mirrors Python daemon's GET /diary_recent so the dashboard proxy
// (`/api/mimir/diary_recent?hours=24&limit=100&kinds=fire_v3,...`) lands
// here directly. Returns shape `{ ok, hits: [...] }` matching Python.
route('GET', '/diary_recent', async (req, res) => {
  try {
    const url = parseUrl(req.url, true);
    const q = url.query || {};
    const hours = parseFloat(q.hours);
    const limit = parseInt(q.limit, 10);
    const kindsRaw = typeof q.kinds === 'string' ? q.kinds : '';
    const kinds = kindsRaw
      ? kindsRaw.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const rows = recentDiary({
      hours: Number.isFinite(hours) ? hours : 24,
      kinds: kinds && kinds.length ? kinds : null,
      ownerId: 'self',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
    });
    // Hits include parsed meta so the UI can show JSON details inline.
    const hits = rows.map(r => {
      let metaObj = null;
      try { metaObj = r.meta ? JSON.parse(r.meta) : null; } catch {}
      return { ...r, meta: metaObj };
    });
    send(res, 200, { ok: true, hits });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary_action_distribution — fire vs skip per action over a window ──
// Pass ?by_pool=1 to also break down each action by which v4 pool the
// chosen candidate came from (hot|cold|bridge|novel|unknown). v3 fires have
// no pool field and roll up to `unknown` in the by_pool buckets.
route('GET', '/diary_action_distribution', async (req, res) => {
  try {
    const url = parseUrl(req.url, true);
    const hours = parseFloat(url.query?.hours);
    const byPool = String(url.query?.by_pool || '').trim() === '1';
    send(res, 200, actionDistribution(Number.isFinite(hours) ? hours : 24, { byPool }));
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /picker_contract_health — Hybrid A+C observation panel ──────────────
// 2026-05-11. Returns chosen_action_source breakdown
// (tool_call | llm_json | tools_inferred | null) over a recent window so the
// dashboard can show whether forced tool_choice is actually firing vs falling
// through to legacy envelope / inference / NULL. Mirrors Python daemon's
// /picker_contract_health route (mimir_daemon.py).
route('GET', '/picker_contract_health', async (req, res) => {
  try {
    const url = parseUrl(req.url, true);
    let hours = parseFloat(url.query?.hours);
    if (!Number.isFinite(hours)) hours = 24;
    hours = Math.max(0.5, Math.min(168.0, hours));
    const cutoffTs = Math.floor(Date.now() / 1000 - hours * 3600);
    const db = getDb();
    const rows = db.prepare(
      "SELECT json_extract(meta, '$.chosen_action_source') AS src, COUNT(*) AS n " +
      "  FROM diary_entries " +
      " WHERE kind = 'fire_v3' AND ts >= ? " +
      " GROUP BY src"
    ).all(cutoffTs);
    const cidRow = db.prepare(
      "SELECT " +
      "  SUM(CASE WHEN json_extract(meta, '$.candidate_id') IS NOT NULL THEN 1 ELSE 0 END) AS present, " +
      "  COUNT(*) AS total " +
      "  FROM diary_entries " +
      " WHERE kind = 'fire_v3' AND ts >= ?"
    ).get(cutoffTs);
    const bySource = { tool_call: 0, llm_json: 0, tools_inferred: 0, null: 0 };
    let total = 0;
    for (const { src, n } of rows) {
      const nn = Number(n) || 0;
      total += nn;
      const key = (src && Object.prototype.hasOwnProperty.call(bySource, src)) ? src : 'null';
      bySource[key] += nn;
    }
    const forced = bySource.tool_call;
    const legacy = bySource.llm_json + bySource.tools_inferred;
    const nullN = bySource.null;
    const cidPresent = Number(cidRow?.present) || 0;
    const cidTotal = Number(cidRow?.total) || 0;
    send(res, 200, {
      ok: true,
      hours,
      total,
      by_source: bySource,
      forced_tool_rate: total > 0 ? forced / total : 0,
      legacy_fallback_rate: total > 0 ? legacy / total : 0,
      contract_violation_rate: total > 0 ? nullN / total : 0,
      candidate_id_present_rate: cidTotal > 0 ? cidPresent / cidTotal : 0,
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary/knn — KNN over diary_vec; falls back to recent if vec0 absent ─
route('POST', '/diary/knn', async (req, res) => {
  try {
    const body = await readJson(req);
    if (!body.query && !Array.isArray(body.embedding)) {
      return send(res, 400, { ok: false, error: 'query or embedding required' });
    }
    let qv = body.embedding;
    if (!qv) {
      const [v] = await embed([String(body.query)]);
      qv = v;
    }
    const rows = knnDiary(qv, {
      k: parseInt(body.k || body.limit, 10) || 5,
      maxAgeHours: Number.isFinite(body.max_age_hours) ? body.max_age_hours : 168,
      ownerId: body.owner_id || body.ownerId || 'self',
      kinds: Array.isArray(body.kinds) && body.kinds.length ? body.kinds : null,
    });
    send(res, 200, { ok: true, results: rows, vec_available: diaryVecReady() });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary/reflect — assemble context for daily reflection ──────────────
// Engine cron picks this up, runs consolidation-tier LLM, posts result back
// to /diary/append. Mimir-js owns storage; engine owns LLM.
route('POST', '/diary/reflect', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const ctx = buildReflectionContext({
      hoursBack: Number.isFinite(body.hours_back) ? body.hours_back : 24,
      ownerId: body.owner_id || body.ownerId || 'self',
    });
    send(res, 200, ctx);
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /diary/prune — drop entries older than max_age_days ─────────────────
route('POST', '/diary/prune', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const removed = pruneDiary(parseInt(body.max_age_days, 10) || 90);
    send(res, 200, { ok: true, removed });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /library_fetch — read a file from <repo-root>/library/ ──────────────
// Body: { path, max_bytes?, mode?, origin? }
//   path:      relative under library/, no '..' or leading '/'
//   max_bytes: soft cap on returned text bytes (default 100000)
// Returns: { ok, path, kind, bytes, text, truncated, log_id }
//   kind = 'pdf' | 'text'. PDFs auto-extracted via `pdftotext -layout`.
// Path is canonicalized + scoped under <repo-root>/library/. Allowed text
// extensions: .txt .md .markdown .json. Other types rejected.
route('POST', '/library_fetch', async (req, res) => {
  try {
    const body = await readJson(req);
    const relPath = (typeof body.path === 'string' ? body.path : '').trim();
    if (!relPath) return send(res, 400, { ok: false, error: 'path required' });
    if (relPath.startsWith('/') || relPath.split('/').includes('..')) {
      return send(res, 400, { ok: false, error: 'path must be relative under library/' });
    }
    const maxBytes = Math.max(1, Math.min(5_000_000, parseInt(body.max_bytes, 10) || 100_000));

    const repoRoot = dirname(dirname(__dirname));
    let libraryRoot;
    try {
      libraryRoot = realpathSync(join(repoRoot, 'library'));
    } catch {
      return send(res, 404, { ok: false, error: 'library/ not found in repo root' });
    }
    let target;
    try {
      target = realpathSync(join(libraryRoot, relPath));
    } catch {
      return send(res, 404, { ok: false, error: 'file not found' });
    }
    if (!(target === libraryRoot || target.startsWith(libraryRoot + '/') || target.startsWith(libraryRoot + '\\'))) {
      return send(res, 400, { ok: false, error: 'path escapes library_root' });
    }
    let st;
    try { st = statSync(target); } catch { return send(res, 404, { ok: false, error: 'file not found' }); }
    if (!st.isFile()) return send(res, 404, { ok: false, error: 'not a regular file' });

    const lower = target.toLowerCase();
    let head;
    try {
      const fd = readFileSync(target);
      head = fd.subarray(0, 8);
    } catch (e) {
      return send(res, 500, { ok: false, error: `read failed: ${e.message}` });
    }
    const isPdf = head.slice(0, 5).toString('latin1') === '%PDF-' || lower.endsWith('.pdf');

    let text;
    let kind;
    if (isPdf) {
      const proc = spawnSync('pdftotext', ['-layout', target, '-'], {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 60_000,
      });
      if (proc.error && proc.error.code === 'ENOENT') {
        return send(res, 400, { ok: false, error: 'pdftotext binary not installed' });
      }
      if (proc.status !== 0) {
        const stderr = (proc.stderr || '').toString().slice(0, 200);
        return send(res, 400, { ok: false, error: `pdftotext failed: ${stderr}` });
      }
      text = proc.stdout || '';
      kind = 'pdf';
    } else {
      const allowed = ['.txt', '.md', '.markdown', '.json'];
      if (!allowed.some(ext => lower.endsWith(ext))) {
        return send(res, 400, { ok: false, error: 'unsupported file type (allowed: pdf, txt, md, json)' });
      }
      try {
        text = readFileSync(target, 'utf8');
      } catch (e) {
        return send(res, 500, { ok: false, error: `read failed: ${e.message}` });
      }
      kind = 'text';
    }

    let truncated = false;
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      let cut = maxBytes;
      while (cut > 0) {
        try {
          const slice = Buffer.from(text, 'utf8').subarray(0, cut).toString('utf8');
          text = slice;
          break;
        } catch { cut -= 1; }
      }
      truncated = true;
    }

    const relOut = target.slice(libraryRoot.length + 1) || target;
    const bytes = Buffer.byteLength(text, 'utf8');

    let pageCount = null;
    if (kind === 'pdf') {
      try {
        const info = spawnSync('pdfinfo', [target], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        if (info.status === 0 && info.stdout) {
          const m = info.stdout.match(/^Pages:\s+(\d+)/m);
          if (m) pageCount = parseInt(m[1], 10);
        }
      } catch {}
    }

    let logId = null;
    try {
      const origin = (typeof body.origin === 'string' && body.origin.trim())
        ? body.origin.trim() : 'library_fetch';
      logId = logLibraryRead({
        path: relOut,
        mode: 'actions',
        origin,
        meta: { kind, truncated, bytes },
        pageCount,
      });
    } catch (e) {
      console.warn('[mimir-js] library_read_log write failed:', e.message);
    }

    send(res, 200, {
      ok: true,
      path: relOut,
      kind,
      bytes,
      truncated,
      text,
      log_id: logId,
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ─── /compile, /compile_skeleton: narrative IR from pool + edges ─────────
route('POST', '/compile', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    send(res, 200, compile({ query: body.query || '' }));
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('POST', '/compile_skeleton', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    send(res, 200, compileSkeleton({ max_sentences: parseInt(body.max_sentences, 10) || 6 }));
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ─── /reason/* — BFS over typed edges ────────────────────────────────────
route('POST', '/reason/paths', async (req, res) => {
  try {
    const body = await readJson(req);
    const out = await reasonPaths({
      message: body.message || body.query || '',
      max_hops: parseInt(body.max_hops, 10) || 5,
      max_paths: parseInt(body.max_paths, 10) || 3,
    });
    send(res, 200, out);
  } catch (e) { send(res, 200, { ok: false, error: e.message, paths: [] }); }
});
route('POST', '/reason/analogy', async (req, res) => {
  try {
    const body = await readJson(req);
    send(res, 200, await reasonAnalogy({ node_a: body.node_a, node_b: body.node_b }));
  } catch (e) { send(res, 200, { ok: false, error: e.message }); }
});
route('POST', '/reason/abduction', async (req, res) => {
  try {
    const body = await readJson(req);
    send(res, 200, await reasonAbduction({ conclusion_id: body.conclusion_id }));
  } catch (e) { send(res, 200, { ok: false, error: e.message, explanations: [] }); }
});
route('POST', '/reason/deduction', async (req, res) => {
  try {
    const body = await readJson(req);
    send(res, 200, await reasonDeduction({ premises: body.premises || [] }));
  } catch (e) { send(res, 200, { ok: false, error: e.message, paths: [] }); }
});

// ─── /segments_by_anchors — pool-anchored topic segment lookup ───────────
// Resolve each pool node's event_at/created_at, then query topic_segments
// (UNIX-second `created_at`) with a ±window_minutes union per anchor.
// Used by agent-runtime Layer 3.7 to inject the original conversation that
// produced the activated concepts back into the LLM prompt.
route('POST', '/segments_by_anchors', async (req, res) => {
  try {
    const body = await readJson(req);
    const nodeIds = Array.isArray(body.node_ids) ? body.node_ids.slice(0, 20)
                  : Array.isArray(body.anchors) ? body.anchors.slice(0, 20) : [];
    const windowMinutes = Math.max(5, Math.min(120, parseInt(body.window_minutes, 10) || 30));
    const limit = Math.max(1, Math.min(30, parseInt(body.limit, 10) || 8));
    if (nodeIds.length === 0) {
      return send(res, 200, { ok: true, segments: [], anchors: 0 });
    }

    let db;
    try { db = getDb(); } catch { return send(res, 200, { ok: true, segments: [], anchors: 0 }); }

    // Resolve each node's anchor time. Schema stores ISO TEXT for nodes;
    // topic_segments uses UNIX seconds. Convert anchors → seconds for the
    // overlap query.
    const placeholders = nodeIds.map(() => '?').join(',');
    let nodeRows = [];
    try {
      nodeRows = db.prepare(`
        SELECT id, COALESCE(event_at, created_at) AS ts
          FROM nodes
         WHERE id IN (${placeholders})
      `).all(...nodeIds);
    } catch (e) { return send(res, 200, { ok: true, segments: [], anchors: 0, error: e.message }); }

    const anchors = [];
    for (const r of nodeRows) {
      if (!r.ts) continue;
      const ms = Date.parse(r.ts);
      if (!Number.isFinite(ms)) continue;
      anchors.push({ id: r.id, sec: Math.floor(ms / 1000) });
    }
    if (anchors.length === 0) {
      return send(res, 200, { ok: true, segments: [], anchors: 0 });
    }

    // Build OR clauses per anchor; small K keeps it cheap.
    const wins = [];
    const params = [];
    for (const a of anchors) {
      wins.push('(created_at BETWEEN ? AND ?)');
      params.push(a.sec - windowMinutes * 60, a.sec + windowMinutes * 60);
    }
    let segRows = [];
    try {
      segRows = db.prepare(`
        SELECT id, created_at, message_ids, session_ids, summary, kind, msg_count
          FROM topic_segments
         WHERE ${wins.join(' OR ')}
         ORDER BY created_at DESC LIMIT 100
      `).all(...params);
    } catch {
      // Table may not exist yet — segmenter creates lazily.
      return send(res, 200, { ok: true, segments: [], anchors: anchors.length });
    }

    // Score by proximity to nearest anchor (1/(1+gap_min)).
    const scored = [];
    const seen = new Set();
    for (const s of segRows) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      let minGap = Infinity;
      for (const a of anchors) {
        const g = Math.abs(s.created_at - a.sec);
        if (g < minGap) minGap = g;
      }
      const proximity = 1.0 / (1.0 + minGap / 60.0);
      let messageIds = []; try { messageIds = JSON.parse(s.message_ids || '[]'); } catch {}
      let sessionIds = []; try { sessionIds = JSON.parse(s.session_ids || '[]'); } catch {}
      scored.push({
        id: s.id,
        message_ids: messageIds,
        session_ids: sessionIds,
        summary: s.summary || '',
        kind: s.kind || 'topic',
        msg_count: s.msg_count || 0,
        created_at: s.created_at,
        proximity: Math.round(proximity * 1e4) / 1e4,
        gap_s: Math.floor(minGap),
      });
    }
    scored.sort((a, b) => b.proximity - a.proximity);
    send(res, 200, {
      ok: true,
      segments: scored.slice(0, limit),
      anchors: anchors.length,
      window_minutes: windowMinutes,
    });
  } catch (e) {
    send(res, 200, { ok: false, error: e.message, segments: [] });
  }
});

// ─── /signal — pulse touch ingestion (Ratatoskr): inject SA energy + log ─
// pulse_hint_log doesn't exist in the OSS schema (Ratatoskr is removed).
// We probe once, then skip. Caching prevents prepare-throw spam under load.
let _pulseLogAvailable = null;     // null = unknown, false = absent, true = present
route('POST', '/signal', async (req, res) => {
  try {
    const body = await readJson(req);
    const kind = body.kind || 'unknown';
    const targetId = body.target_id || body.target;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    let injected = false;
    const injectedIds = [];
    if (targetId) {
      injected = sa.inject(targetId, 0.30, null);
      if (injected) injectedIds.push(targetId);
    } else if (text) {
      // Text path: embed → vec0 KNN → inject top-k node ids. Lets graph_lookup
      // and other "by query" callers actually re-focus the SA pool.
      try {
        const [qv] = await embed([text]);
        const k = Math.min(20, Math.max(1, parseInt(body.k, 10) || 8));
        const seedStrength = Number.isFinite(body.strength) ? body.strength : 0.30;
        const db = getDb();
        let rows = [];
        try {
          rows = db.prepare(`
            SELECT r.node_id AS node_id, distance
              FROM node_embeddings
              JOIN node_rowids r ON r.rowid = node_embeddings.rowid
              JOIN nodes n ON n.id = r.node_id
             WHERE node_embeddings.embedding MATCH ?
               AND k = ?
               AND n.state='active' AND n.superseded_at IS NULL
             ORDER BY distance ASC
          `).all(toBlob(qv), k);
        } catch {
          // vec0 missing — degrade silently
          rows = [];
        }
        for (const r of rows) {
          if (sa.inject(r.node_id, seedStrength, null)) {
            injected = true;
            injectedIds.push(r.node_id);
          }
        }
      } catch (e) {
        // Embed failure — silent degrade so /signal stays best-effort
      }
    }
    if (_pulseLogAvailable !== false) {
      try {
        const db = getDb();
        db.prepare(`
          INSERT INTO pulse_hint_log (received_at, kind, source_hint, target_kind, target_id, payload)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(Date.now(), kind, body.source || null, body.target_kind || null, targetId || null, JSON.stringify(body));
        _pulseLogAvailable = true;
      } catch { _pulseLogAvailable = false; }
    }
    // Record A_fast snapshot so predictive priming can learn signal→next-state
    // transitions. Cheap O(N) snapshot; bounded by SIGNAL_HISTORY_SIZE=20.
    if (injected) {
      try { sa.recordSignal(); } catch {}
      try { noteRumSignal(); } catch {}
    }
    send(res, 200, ok({ kind, accepted: injected, target_id: targetId || null, injected_ids: injectedIds }));
  } catch { send(res, 200, ok()); }
});

// ─── /turn_signal — pre-LLM nudge; arousal alpha modulates SA seed ───────
route('POST', '/turn_signal', async (req, res) => {
  let alpha = 1.0;
  try {
    const body = await readJson(req);
    const a = parseFloat(body.alpha);
    if (Number.isFinite(a) && a >= 0.5 && a <= 2.0) { alpha = a; sa.setAlphaScale(a); }
  } catch {}
  send(res, 200, ok({ alpha }));
});

// ─── /episodic_ingest — per-turn signal that a conversation msg landed ──
// Engine src/main.js calls this every turn. mimir-js segmenter polls
// conversations.db on its own 10-min cadence, so we don't need to consume
// the payload — we just record the activity to keep the watchdog/idle
// timer honest, and (cheap) update the SA pool seed for the speaker_id
// node if one was provided in the body. Heavy lifting (clustering) stays
// inside segment.js's periodic loop to avoid per-turn embed cost.
let _ingestCount = 0;
route('POST', '/episodic_ingest', async (req, res) => {
  try {
    const body = await readJson(req);
    _ingestCount += 1;
    if (body && body.speaker_node_id) {
      try { sa.inject(body.speaker_node_id, 0.10, null); } catch {}
    }
    send(res, 200, ok({ ingested: true, count: _ingestCount }));
  } catch (e) {
    send(res, 200, ok({ ingested: false, error: e.message }));
  }
});

// ─── /session_end — turn boundary; finalize topic segment for that session ─
// Cron / telegram / dashboard each call this when a turn closes. The
// segmenter normally runs on a 10-min loop; on session_end we trigger an
// out-of-band run so the segments table reflects the just-finished session
// before the next turn starts.
let _lastSessionEndMs = 0;
const SESSION_END_DEBOUNCE_MS = 30 * 1000;
route('POST', '/session_end', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    // ── L1 back-fill: chosen_action onto fire_v3 row (parity with Python) ──
    // The picker LLM emits a leading JSON object ({"action": "...", ...})
    // before any tool calls. fire_v3 was written at picker-fire time before
    // the LLM responded, so chosen_action is unknown then. Patch it in here
    // so distribution queries (L2 hint + dashboard) can GROUP BY chosen_action.
    //
    // Source priority: first_response (round-1 text, where the envelope lives)
    // → last_response (final summary, fallback for legacy callers).
    try {
      const sid = String(body.session_id || '').trim();
      const firstResp = String(body.first_response || '');
      const lastResp = String(body.last_response || '');
      const toolsUsed = Array.isArray(body.tools_used) ? body.tools_used : [];
      if (sid.startsWith('curiosity-') && (firstResp || lastResp || toolsUsed.length)) {
        // Walk past DEBRIEF/TASK_TOUCH JSON blobs to find the picker envelope
        // (first dict with non-empty `action`). Fall back to tool-call
        // inference when the LLM skipped the envelope entirely.
        let pickerObj = _extractPickerActionJson(firstResp)
          || _extractPickerActionJson(lastResp);
        let chosenActionSource = pickerObj ? 'llm_json' : null;
        if (!pickerObj) {
          const inferred = _inferActionFromTools(toolsUsed);
          if (inferred) {
            pickerObj = { action: inferred };
            chosenActionSource = 'tools_inferred';
          }
        }
        const action = pickerObj && typeof pickerObj.action === 'string'
          ? pickerObj.action.trim().slice(0, 32) : null;
        const candidateId = pickerObj && typeof pickerObj.candidate_id === 'string'
          ? pickerObj.candidate_id.trim().slice(0, 128) : null;
        // Always tag fire_v3 entries with picker contract compliance so the
        // dashboard can compute candidate_id violation rate (drives whether
        // V5a Phase 3 hot-fc-penalty has signal to work with).
        // Hybrid A+C (2026-05-11): use *_if_null so we don't overwrite the
        // fire-time stamp set by the forced tool_choice picker. Only stamp
        // if the LLM's late envelope/inference adds *new* info we didn't
        // already have at fire time.
        const fireId = getFireDiaryIdBySession(sid);
        if (fireId && candidateId) {
          try { updateDiaryMetaIfNull(fireId, 'candidate_id_present', 1); }
          catch { /* best-effort telemetry */ }
        }
        if ((action || candidateId) && fireId) {
          // Hybrid A+C (2026-05-11): use *_if_null so the legacy back-fill
          // doesn't clobber a fire-time stamp set by the forced tool_choice
          // picker. fire_count bump + pool resolution still run unconditionally
          // (one fire = one bump regardless of who stamped chosen_action).
          if (action) updateDiaryMetaIfNull(fireId, 'chosen_action', action);
          if (chosenActionSource) {
            try { updateDiaryMetaIfNull(fireId, 'chosen_action_source', chosenActionSource); }
            catch { /* best-effort audit tag */ }
          }
          if (candidateId) {
            updateDiaryMetaIfNull(fireId, 'candidate_id', candidateId);
            // Bump fire_count on the picker's actual choice (not SA-argmax).
            // Guarded by table_info because migration 0002 may not have run.
            // r12 Gap 4: fail-loud on failure. Silent fire_count loss breaks
            // the V5a hot-pool penalty and lets the picker re-pick the same
            // node (component of the "55-day silence" repeat pattern).
            // better-sqlite3 handles SQLITE_BUSY via busy_timeout PRAGMA;
            // synchronous retry would block the event loop, so we trust the
            // PRAGMA and just surface the failure if it still throws.
            try {
              const db = getDb();
              const hasFireCount = db.prepare(
                "SELECT 1 AS ok FROM pragma_table_info('nodes') WHERE name = 'fire_count'"
              ).get();
              if (hasFireCount) {
                db.prepare(
                  'UPDATE nodes SET fire_count = COALESCE(fire_count, 0) + 1 WHERE id = ?'
                ).run(candidateId);
              }
            } catch (e) {
              if (process.env.MIMIR_OUTREACH_FIRECOUNT_FAILLOUD !== '0') {
                console.error(`[mimir-js] fire_count bump failed (cand=${candidateId}): ${e.message}`);
              } else {
                console.warn('[mimir-js] fire_count bump failed:', e.message);
              }
            }
            // Resolve which pool the chosen candidate came from by reading
            // back the candidate_pools map the v4 picker stashed at fire time.
            try {
              const db = getDb();
              const row = db.prepare(
                "SELECT json_extract(meta, '$.candidate_pools') AS cp FROM diary_entries WHERE id = ?"
              ).get(fireId);
              if (row && row.cp) {
                const cp = JSON.parse(row.cp);
                const pool = cp && cp[candidateId];
                if (pool && typeof pool === 'string') {
                  // Hybrid A+C: don't overwrite fire-time pool stamp.
                  updateDiaryMetaIfNull(fireId, 'pool', pool.slice(0, 16));
                }
              }
            } catch { /* best-effort */ }
          }
        }
      }
    } catch (e) {
      console.warn('[mimir-js] session_end chosen_action back-fill failed:', e.message);
    }
    const now = Date.now();
    // Debounce: rapid session_end calls (multi-source: cron + telegram +
    // dashboard) don't all need to trigger embedding work.
    if (now - _lastSessionEndMs >= SESSION_END_DEBOUNCE_MS) {
      _lastSessionEndMs = now;
      const convPath = resolve(dirname(DB_PATH), 'conversations.db');
      // Fire-and-forget; segmenter handles missing-conv-db gracefully.
      segmentRecent({ convDbPath: convPath, hours: 6, limit: 200, persist: true })
        .catch(e => console.warn('[mimir-js] session_end segment refresh failed:', e.message));
    }
    send(res, 200, ok({ debounced: now - _lastSessionEndMs < SESSION_END_DEBOUNCE_MS }));
  } catch (e) {
    send(res, 200, ok({ error: e.message }));
  }
});

// ─── /outreach_response_seen — ack ───────────────────────────────────────
route('POST', '/outreach_response_seen', async (req, res) => {
  try { await readJson(req); } catch {}
  send(res, 200, ok());
});

// ─── /activations, /inject — observability stubs ─────────────────────────
route('GET', '/activations', async (req, res) => send(res, 200, { ok: true, activations: [] }));
route('POST', '/inject', async (req, res) => {
  try { await readJson(req); } catch {}
  send(res, 200, ok());
});

// ─── /config — autonomy settings (writable, mirrors Python /config) ─────
// Reads/writes go through autonomy.js. Autonomy is default-OFF; user opts
// in via dashboard or /mimir Telegram command. Writes are not persisted
// across restart (parity with Python rule that LLM-call autonomy must be
// re-enabled explicitly each boot).
route('GET', '/config', async (req, res) => {
  send(res, 200, {
    ok: true,
    ...getAutonomyState(),
    autonomy: getAutonomyState(),
    rumination_enabled: ruminationStatus().enabled,
    novelty_gate_enabled: hebbStatus().novelty_gate_enabled,
    reverse_propagation_enabled: sa.isReversePropEnabled(),
    priming_enabled: sa.isPrimingEnabled(),
  });
});
route('POST', '/config', async (req, res) => {
  try {
    const body = await readJson(req);
    // Mímir internal-mechanism toggles. Default-ON kill-switch convention —
    // these aren't autonomy actions so they live outside autonomy.js. Flips
    // take effect on the next tick; not persisted across restart (env var
    // MIMIR_<NAME>=0 is the durable off-switch).
    const extraChanged = [];
    if ('rumination_enabled' in body) {
      setRuminationEnabled(Boolean(body.rumination_enabled));
      extraChanged.push(`rumination_enabled=${Boolean(body.rumination_enabled)}`);
    }
    if ('novelty_gate_enabled' in body) {
      setNoveltyGateEnabled(Boolean(body.novelty_gate_enabled));
      extraChanged.push(`novelty_gate_enabled=${Boolean(body.novelty_gate_enabled)}`);
    }
    if ('reverse_propagation_enabled' in body) {
      sa.setReversePropEnabled(Boolean(body.reverse_propagation_enabled));
      extraChanged.push(`reverse_propagation_enabled=${Boolean(body.reverse_propagation_enabled)}`);
    }
    if ('priming_enabled' in body) {
      sa.setPrimingEnabled(Boolean(body.priming_enabled));
      extraChanged.push(`priming_enabled=${Boolean(body.priming_enabled)}`);
    }
    const out = applyConfigPatch(body);
    if (!out.ok) return send(res, 400, out);
    // Persist after every successful patch so a crash recovers the user's
    // opt-in state. clean_shutdown defaults to false here — only the
    // graceful shutdown handler writes the sentinel.
    try { saveAutonomyConfig(); } catch {}
    const changed = [...(out.changed || []), ...extraChanged];
    send(res, 200, {
      ok: true,
      changed,
      ...getAutonomyState(),
      rumination_enabled: ruminationStatus().enabled,
      novelty_gate_enabled: hebbStatus().novelty_gate_enabled,
      reverse_propagation_enabled: sa.isReversePropEnabled(),
      priming_enabled: sa.isPrimingEnabled(),
    });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ─── /autonomy/status — observability for dashboard /mimir tab ──────────
route('GET', '/autonomy/status', async (req, res) => {
  send(res, 200, { ok: true, ...autonomyStatus(), state: getAutonomyState() });
});

// ─── /gaps — knowledge-gap detection stub (proxied by dashboard) ────────
// Python's detect_knowledge_gaps walks the active subgraph for components
// with low edge density. mimir-js v1 returns an empty list (UI-safe shape);
// the Leiden/zone path already surfaces the same information via /pool's
// bridge column, so deferring full detection to v1.1 doesn't lose signal.
route('GET', '/gaps', async (req, res) => {
  send(res, 200, { ok: true, n_gaps: 0, gaps: [] });
});

// ─── /reconsolidate — similarity-driven sweep over recent nodes ──────────
route('POST', '/reconsolidate', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const out = await reconsolidateBatch({
      limit: parseInt(body.limit, 10) || 50,
      hoursBack: Number.isFinite(body.hours_back) ? body.hours_back : 24,
      dryRun: !!body.dry_run,
    });
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/reconsolidate/status', async (req, res) => {
  send(res, 200, { ok: true, ...reconsolidationStatus() });
});

// ─── /dream — idle-period revival ────────────────────────────────────────
route('POST', '/dream/run', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const out = runDreamCycle({
      count: parseInt(body.count, 10) || undefined,
      log: body.log !== false,
    });
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/dream/status', async (req, res) => {
  send(res, 200, { ok: true, ...dreamStatus() });
});

// ─── /evolve_edges — relates_to → typed promotion ────────────────────────
route('POST', '/evolve_edges', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const out = evolveEdges({
      limit: parseInt(body.limit, 10) || 50,
      dryRun: !!body.dry_run,
    });
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/evolve_edges/status', async (req, res) => {
  send(res, 200, { ok: true, ...evolutionStatus() });
});

// ─── /hebb — BCM plasticity edge updates ─────────────────────────────────
route('POST', '/hebb/run', async (req, res) => {
  try {
    const out = await runHebbWriteback();
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('POST', '/rumination/run', async (req, res) => {
  try {
    const out = runRumination();
    send(res, 200, { ok: true, ...out });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/rumination/status', async (req, res) => {
  send(res, 200, { ok: true, ...ruminationStatus() });
});

route('GET', '/hebb/status', async (req, res) => {
  send(res, 200, { ok: true, ...hebbStatus() });
});

// ─── /edge_decay — strength attenuation + dormancy sweep ─────────────────
route('POST', '/edge_decay/run', async (req, res) => {
  try {
    const out = await runEdgeDecay();
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/edge_decay/status', async (req, res) => {
  send(res, 200, { ok: true, ...edgeDecayStatus() });
});

// ─── /segments_recent — agglomerative topic clustering ───────────────────
route('POST', '/segments_recent', async (req, res) => {
  try {
    const body = await readJson(req).catch(() => ({}));
    const convPath = body.conv_db_path
      || resolve(dirname(DB_PATH), 'conversations.db');
    const out = await segmentRecent({
      convDbPath: convPath,
      hours: Number.isFinite(body.hours) ? body.hours : 6,
      limit: parseInt(body.limit, 10) || 200,
      persist: body.persist !== false,
    });
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/segments_recent/status', async (req, res) => {
  send(res, 200, { ok: true, ...segmenterStatus() });
});

// ─── /llm_rerank — fast-tier model precision rerank ──────────────────────
route('POST', '/llm_rerank', async (req, res) => {
  try {
    const body = await readJson(req);
    const out = await llmRerank({
      query: body.query || '',
      candidates: Array.isArray(body.candidates) ? body.candidates : [],
      topK: parseInt(body.top_k || body.topK, 10) || 15,
    });
    send(res, 200, out);
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ─── /watchdog/status — heartbeat freshness ──────────────────────────────
route('GET', '/watchdog/status', async (req, res) => {
  send(res, 200, { ok: true, ...watchdogStatus(), heartbeat: heartbeatStatus(), live: liveStatus() });
});

// ─── /wal_checkpoint — bounded WAL maintenance ───────────────────────────
route('POST', '/wal_checkpoint/run', async (req, res) => {
  try { send(res, 200, runWalCheckpoint()); }
  catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/wal_checkpoint/status', async (req, res) => {
  send(res, 200, { ok: true, ...walCheckpointStatus() });
});

// ─── /health — RSS visibility for the operator ───────────────────────────
route('POST', '/health/run', async (req, res) => {
  try { send(res, 200, runHealthCheck()); }
  catch (e) { send(res, 500, { ok: false, error: e.message }); }
});
route('GET', '/health/status', async (req, res) => {
  send(res, 200, { ok: true, ...healthStatus() });
});

// ─── V5b Phase 11.4 — /personas + /critic + /review_queue ────────────────
// Persona registration is read-only in OSS v1 (3 seeded by engine.cjs:_init).
// Critic mode comes from MIMIR_V5_CRITIC_MODE env (full|rule-only|disabled);
// OSS default is `disabled` per Plan §10 §10 — post/reply locked until user
// opts in. Review queue is a count-only badge for v1; full approve/reject
// flow is Phase 12 work.
route('GET', '/personas', async (req, res) => {
  try {
    const db = getDb();
    const ownerId = String(req.url.includes('owner_id=')
      ? new URL(req.url, 'http://x').searchParams.get('owner_id') || 'self'
      : 'self');
    const personas = db.prepare(`
      SELECT id, display_name, active, created_at,
             (voice_exemplars IS NOT NULL) AS has_exemplars
      FROM personas
      WHERE owner_id = ?
      ORDER BY id
    `).all(ownerId);
    const caps = db.prepare(`
      SELECT persona_id, platform, action, daily_cap,
             COALESCE(direct_send_enabled, 0) AS direct_send_enabled
      FROM persona_caps
      WHERE owner_id = ?
    `).all(ownerId);
    send(res, 200, { ok: true, owner_id: ownerId, personas, caps });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// POST /personas/direct-send — r20 Option B: direct_send is permanently ON
// in OSS. The route is kept for backward compatibility but ignores `enabled`
// from the body and always forces the column to 1. The Critic gate still
// runs; only the human review-queue step was removed.
route('POST', '/personas/direct-send', async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { return send(res, 400, { ok: false, error: 'invalid json' }); }
    const personaId = String(parsed.persona_id || '').trim();
    if (!personaId) return send(res, 400, { ok: false, error: 'persona_id required' });
    const ownerId = String(parsed.owner_id || 'self');
    const platform = parsed.platform != null ? String(parsed.platform) : null;
    const action = parsed.action != null ? String(parsed.action) : null;
    const db = getDb();
    let updated;
    if (platform != null && action != null) {
      updated = db.prepare(`
        UPDATE persona_caps SET direct_send_enabled = 1
        WHERE owner_id = ? AND persona_id = ? AND platform = ? AND action = ?
      `).run(ownerId, personaId, platform, action);
    } else {
      updated = db.prepare(`
        UPDATE persona_caps SET direct_send_enabled = 1
        WHERE owner_id = ? AND persona_id = ?
      `).run(ownerId, personaId);
    }
    send(res, 200, { ok: true, persona_id: personaId, enabled: true, rows_updated: updated.changes, note: 'direct_send is permanently ON in OSS' });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

route('GET', '/critic/status', async (req, res) => {
  try {
    const rawMode  = String(process.env.MIMIR_V5_CRITIC_MODE || 'disabled').toLowerCase();
    const mode     = ['full', 'rule-only', 'disabled'].includes(rawMode) ? rawMode : 'disabled';
    const killRaw  = process.env.MIMIR_V5_CRITIC ?? '1';
    const killOff  = killRaw === '0' || killRaw === 'false';
    const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.MIMIR_V5_CRITIC_API_KEY);
    const tier      = String(process.env.MIMIR_V5_CRITIC_TIER || 'haiku').toLowerCase();
    send(res, 200, {
      ok: true,
      mode,
      kill_switch_engaged: killOff,
      has_api_key: hasApiKey,
      tier,
      post_reply_locked: mode === 'disabled' || killOff,
    });
  } catch (e) { send(res, 500, { ok: false, error: e.message }); }
});

// ─── default 404 ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS for dashboard panels that probe Mímir directly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const { pathname } = parseUrl(req.url || '/');
  const key = `${req.method} ${pathname}`;
  let handler = routes.get(key);

  if (!handler) return send(res, 404, { ok: false, error: `no route for ${key}` });
  noteHeartbeat();
  noteUserActivity();
  try {
    await handler(req, res);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
  }
});

// Try to bind on BASE_PORT; on EADDRINUSE step up through PORT_RANGE-1
// alternates. A foreign daemon on 18810 (e.g. dev mimir running in WSL while
// user installs the OSS build on the same host) must not crash mimir-js;
// instead we land on 18811/12/... and advertise the resolved port via
// runtime.json so the engine connects to the right child.
function listenWithFallback(server, basePort, host, range) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = basePort + attempt;
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && attempt < range - 1) {
          console.warn(`[mimir-js] port ${port} in use — trying ${port + 1}`);
          attempt += 1;
          setImmediate(tryListen);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryListen();
  });
}

function writeRuntimeFile(port) {
  const payload = {
    port,
    install_id: INSTALL_ID,
    pid: process.pid,
    boot_ts: BOOT_TS,
    host: HOST,
  };
  try {
    mkdirSync(dirname(RUNTIME_FILE), { recursive: true });
    writeFileSync(RUNTIME_FILE, JSON.stringify(payload, null, 2));
    console.log(`[mimir-js] runtime advertised at ${RUNTIME_FILE}`);
  } catch (e) {
    console.warn(`[mimir-js] runtime advertise failed: ${e.message}`);
  }
}

// ─── boot ────────────────────────────────────────────────────────────────
async function boot() {
  console.log(`[mimir-js] starting — db=${DB_PATH}`);
  // Always call openDb so the path is recorded as pending. On a fresh OSS
  // install Mímir spawns BEFORE the engine creates constellation.db; the
  // lazy retry inside getDb() picks it up the moment the file exists.
  openDb(DB_PATH);
  if (!existsSync(DB_PATH)) {
    console.warn(`[mimir-js] db not found yet — will lazy-open when engine creates it`);
  }

  try {
    RESOLVED_PORT = await listenWithFallback(server, BASE_PORT, HOST, PORT_RANGE);
  } catch (e) {
    console.error(`[mimir-js] failed to bind ${HOST}:${BASE_PORT}-${BASE_PORT + PORT_RANGE - 1}: ${e.message}`);
    process.exit(1);
  }
  console.log(`[mimir-js] listening on http://${HOST}:${RESOLVED_PORT}`);
  console.log(`[mimir-js] PID=${process.pid} install_id=${INSTALL_ID} backend=mimir-js v0.1.0`);
  writeRuntimeFile(RESOLVED_PORT);

  // Warm the embedder in the background — first /embed call triggers cold load
  // (~30s). Pre-warming overlaps with engine boot.
  loadEmbedder()
    .then(() => console.log('[mimir-js] embedder ready (BGE-M3, 1024d)'))
    .catch(err => console.warn('[mimir-js] embedder warm-up failed:', err.message));

  // Background loops — all default-on, kill-switch via env (MIMIR_<NAME>=0).
  if (startWatchdog({ onStall: ({ idleMs, strikes }) =>
       console.error(`[mimir-js] wedged: ${strikes} strikes, idle ${idleMs}ms`) })) {
    console.log('[mimir-js] watchdog armed');
  }
  if (startHeartbeat()) console.log('[mimir-js] heartbeat armed (5s cadence — drives SA + keeps watchdog fresh)');
  if (startDreamLoop()) console.log('[mimir-js] dream loop armed');
  if (startEvolutionLoop()) console.log('[mimir-js] edge-evolution loop armed');
  if (startHebbLoop()) console.log('[mimir-js] hebb writeback armed (180s cadence — BCM plasticity)');
  if (startRuminationLoop()) console.log('[mimir-js] rumination armed (120s cadence — DMN re-activates recent zones when idle)');
  if (startEdgeDecayLoop()) console.log('[mimir-js] edge-decay armed (1h cadence — use it or lose it)');
  if (startWalCheckpointLoop()) console.log('[mimir-js] wal-checkpoint armed (10min cadence — keeps WAL bounded)');
  const convPath = resolve(dirname(DB_PATH), 'conversations.db');
  configureHealthMonitor({ convDbPath: convPath });
  if (startHealthMonitor()) console.log('[mimir-js] health monitor armed (5min cadence — RSS ceiling 1.5GB + vec0 chunk probe)');
  if (startSegmenterLoop({ convDbPath: convPath })) console.log('[mimir-js] segmenter loop armed');
  // Restore persisted autonomy state BEFORE arming the loop so a crash
  // recovers the user's prior opt-in. loadAutonomyConfig handles the
  // clean_shutdown sentinel + crash-loop guard.
  try { loadAutonomyConfig(); } catch (e) { console.warn('[mimir-js] loadAutonomyConfig failed:', e.message); }
  if (startAutonomyLoop()) console.log('[mimir-js] autonomy v3 loop armed (default-OFF; opt-in via /config)');

  // Observation auto-prune: drop diary fire/skip rows past 24h every hour
  // so the dashboard observation panel stays focused on "what just happened"
  // and the table doesn't grow unbounded. Reflections + library_read_log
  // narrative rows are NOT touched (they live by /diary/prune at 90d).
  _observationPruneTimer = setInterval(() => {
    try {
      const removed = pruneObservation(24);
      if (removed > 0) console.log(`[mimir-js] observation prune: removed ${removed} rows >24h`);
    } catch (e) {
      console.warn('[mimir-js] observation prune failed:', e.message);
    }
  }, 60 * 60 * 1000).unref();
  console.log('[mimir-js] observation prune armed (hourly, 24h window)');
}

function shutdown(sig) {
  console.log(`[mimir-js] ${sig} — shutting down`);
  // Write clean_shutdown sentinel BEFORE tearing down so the next boot's
  // loadAutonomyConfig() sees it. Without this, every graceful exit would
  // look like a crash and silently re-arm autonomy.
  try { saveAutonomyConfig({ cleanShutdown: true }); } catch {}
  try { stopWatchdog(); } catch {}
  try { stopHeartbeat(); } catch {}
  try { stopDreamLoop(); } catch {}
  try { stopEvolutionLoop(); } catch {}
  try { stopHebbLoop(); } catch {}
  try { stopEdgeDecayLoop(); } catch {}
  try { stopWalCheckpointLoop(); } catch {}
  try { stopHealthMonitor(); } catch {}
  try { stopSegmenterLoop(); } catch {}
  try { stopAutonomyLoop(); } catch {}
  try { if (_observationPruneTimer) clearInterval(_observationPruneTimer); } catch {}
  try { server.close(); } catch {}
  try { closeDb(); } catch {}
  // Remove runtime advertise file so a stale port/install_id can't be picked
  // up by a launcher that happens to start before the next mimir comes up.
  try { unlinkSync(RUNTIME_FILE); } catch {}
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => console.error('[mimir-js] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[mimir-js] unhandled:', e));

boot().catch(e => {
  console.error('[mimir-js] boot failed:', e);
  process.exit(1);
});
