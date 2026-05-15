// SPDX-License-Identifier: AGPL-3.0-or-later
// Health monitor — laptop-friendly memory ceiling + vec0 chunk-corruption probe.
//
// RSS watch ports the relevant slice of mimir_daemon.py's sleep cycle.
// The vec0 probe covers a failure mode we hit on the main arch in 2026-04:
// a corrupt `topic_segment_embeddings_vector_chunks00.4` BLOB silently broke
// 9 days of segmenter writes — every INSERT failed with "Error opening vector
// blob" and rolled back the whole segment txn. OSS is structurally safer
// (per-row try/catch + retry queue in conversation-store), but if the chunk
// goes bad on `node_embeddings`/`diary_vec`/`message_embeddings`, embeddings
// stop landing and recall degrades. This probe reads the max-rowid BLOB on
// each known vec0 table once per cycle: an unreachable BLOB surfaces the
// "Error opening vector blob" string that operators can act on.
//
// OSS runs on consumer hardware where Electron + node + Mímir + LLM client
// can easily push past 1.5 GB combined. RSS check fires every 5 minutes and:
//   - logs a warning at >1.5 GB (operator visibility, not auto-action)
//   - calls `global.gc()` if available (only when --expose-gc is passed)
//
// We deliberately do NOT crash, restart, or aggressively prune on threshold
// breach. The daemon is a long-running service; opaque kills are worse than
// a degraded session that the user can observe and restart.
//
// Kill-switch: MIMIR_HEALTH_MONITOR=0. Defaults ON, fires every 300s (5min).

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync } from 'fs';
import { getDb } from './db.js';

const KILL = String(process.env.MIMIR_HEALTH_MONITOR || '').trim() === '0';
const INTERVAL_MS = parseInt(process.env.MIMIR_HEALTH_MONITOR_INTERVAL_MS || '300000', 10);
const RSS_WARN_BYTES = parseInt(process.env.MIMIR_RSS_WARN_BYTES || String(1.5 * 1024 * 1024 * 1024), 10);

let _intervalHandle = null;
let _lastRunTs = 0;
let _lastRssBytes = 0;
let _lastWarnTs = 0;
let _lastError = null;
let _convDbPath = null;
let _convDbHandle = null;
let _lastVec0Probe = null;
let _lastVec0WarnTs = 0;

export function configureHealthMonitor({ convDbPath } = {}) {
  if (convDbPath) _convDbPath = convDbPath;
}

function _getConvDb() {
  if (!_convDbPath || !existsSync(_convDbPath)) return null;
  if (_convDbHandle) {
    try { _convDbHandle.prepare('SELECT 1').get(); return _convDbHandle; }
    catch { try { _convDbHandle.close(); } catch {} _convDbHandle = null; }
  }
  try {
    _convDbHandle = new Database(_convDbPath, { readonly: true, fileMustExist: true });
    try { sqliteVec.load(_convDbHandle); } catch {}
    return _convDbHandle;
  } catch { return null; }
}

// Probe one vec0 table by reading the BLOB at MAX(idCol). If the latest chunk
// is unreadable, sqlite-vec raises "Could not fetch vector data for <id>,
// opening blob failed" (read-side) or "Error opening vector blob at
// <chunks_path>" (write-side; same string main arch's daemon spammed for
// 9 days). vec0 doesn't expose the bare `rowid` column for ORDER BY/WHERE;
// tables created with `id INTEGER PRIMARY KEY` use `id`, and tables created
// without a PK column accept `rowid` only on INSERT — for those we read via
// the internal `topic_segment_embeddings_rowids` shadow table or skip. Empty
// tables are reported `empty: true` (nothing to probe yet on fresh install).
function _probeVec0Table(db, table, idCol = 'id') {
  try {
    if (!_tableExists(db, table)) {
      return { ok: true, empty: true, schema_missing: true };
    }
    const top = db.prepare(`SELECT ${idCol} AS r FROM ${table} ORDER BY ${idCol} DESC LIMIT 1`).get();
    if (!top || top.r == null) return { ok: true, empty: true };
    db.prepare(`SELECT embedding FROM ${table} WHERE ${idCol} = ?`).get(top.r);
    return { ok: true, max_id: Number(top.r) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Check whether a table exists in sqlite_master. Used to short-circuit probes
// on fresh installs where diary_vec / its shadow rowids table haven't been
// created yet — without this, the probe returns ok:false and triggers the
// "vec0 corruption suspected" warning every 5 minutes on first boot.
function _tableExists(db, table) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
    return !!row;
  } catch { return false; }
}

// diary_vec is `vec0(embedding float[N])` — no explicit PK column. Probe via
// the shadow rowids table maintained by sqlite-vec, then read the BLOB by
// rowid (the one column shape that DOES work on PK-less vec0 tables).
function _probeVec0RowidOnly(db, table) {
  try {
    if (!_tableExists(db, table) || !_tableExists(db, `${table}_rowids`)) {
      return { ok: true, empty: true, schema_missing: true };
    }
    const top = db.prepare(`SELECT MAX(rowid) AS r FROM ${table}_rowids`).get();
    if (!top || top.r == null) return { ok: true, empty: true };
    db.prepare(`SELECT embedding FROM ${table} WHERE rowid = ?`).get(top.r);
    return { ok: true, max_id: Number(top.r) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function runVec0Probe() {
  const result = { ts: Date.now(), tables: {} };
  // constellation.db side: node_embeddings (PK 'id') + diary_vec (rowid-only)
  try {
    const db = getDb();
    if (db) {
      result.tables.node_embeddings = _probeVec0Table(db, 'node_embeddings', 'id');
      result.tables.diary_vec = _probeVec0RowidOnly(db, 'diary_vec');
    }
  } catch (e) { result.const_db_error = e.message; }
  // conversations.db side: message_embeddings (PK 'id')
  const conv = _getConvDb();
  if (conv) result.tables.message_embeddings = _probeVec0Table(conv, 'message_embeddings', 'id');

  const broken = Object.entries(result.tables).filter(([, v]) => !v.ok);
  if (broken.length && Date.now() - _lastVec0WarnTs > INTERVAL_MS) {
    for (const [tbl, info] of broken) {
      console.error(`[mimir-js health] vec0 corruption suspected on ${tbl}: ${info.error}`);
    }
    _lastVec0WarnTs = Date.now();
  }
  _lastVec0Probe = result;
  return result;
}

export function runHealthCheck() {
  if (KILL) return { ok: false, killed: true };
  try {
    const mem = process.memoryUsage();
    _lastRssBytes = mem.rss;
    _lastRunTs = Date.now();
    _lastError = null;
    if (mem.rss > RSS_WARN_BYTES) {
      // Throttle warnings to once per interval to avoid log spam.
      if (Date.now() - _lastWarnTs > INTERVAL_MS) {
        const mb = (mem.rss / 1024 / 1024).toFixed(0);
        console.warn(`[mimir-js health] rss=${mb}MB exceeds threshold (${(RSS_WARN_BYTES / 1024 / 1024).toFixed(0)}MB)`);
        _lastWarnTs = Date.now();
      }
      if (typeof global.gc === 'function') {
        try { global.gc(); } catch {}
      }
    }
    let vec0 = null;
    try { vec0 = runVec0Probe(); } catch (e) { vec0 = { ok: false, error: e.message }; }
    return { ok: true, rss: mem.rss, heapUsed: mem.heapUsed, warned: mem.rss > RSS_WARN_BYTES, vec0 };
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message };
  }
}

export function startHealthMonitor() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    try { runHealthCheck(); }
    catch (e) {
      _lastError = e.message;
      console.warn('[mimir-js health] loop error:', e.message);
    }
  }, INTERVAL_MS);
  _intervalHandle.unref?.();
  return true;
}

export function stopHealthMonitor() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
  if (_convDbHandle) { try { _convDbHandle.close(); } catch {} _convDbHandle = null; }
}

export function healthStatus() {
  return {
    enabled: !KILL,
    interval_ms: INTERVAL_MS,
    rss_warn_bytes: RSS_WARN_BYTES,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    last_rss_bytes: _lastRssBytes,
    last_error: _lastError,
    vec0_probe: _lastVec0Probe,
  };
}
