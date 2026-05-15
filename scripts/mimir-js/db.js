// SPDX-License-Identifier: AGPL-3.0-or-later
// constellation.db handle for mimir-js. Opened read-write so future v1.1
// writers (pulse_hint_log, episodic_ingest) can land without re-plumbing.
// Loads sqlite-vec extension so vec0 KNN works on node_embeddings.
//
// Lazy-open: on a fresh OSS install Mímir spawns BEFORE the engine creates
// constellation.db. boot() records the path but won't open until the file
// exists; getDb() retries on every call so endpoints come online the moment
// the engine finishes its first migration.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve } from 'path';
import { existsSync } from 'fs';

let _db = null;
let _dbPath = null;
let _pendingPath = null;

function _tryOpen(p) {
  if (!existsSync(p)) return null;
  const db = new Database(p, { readonly: false, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  // Stability sync from main repo (2026-05-05): raise WAL autocheckpoint
  // 1000 → 10000 pages so writers don't trigger checkpoints inline. Cheaper
  // for a JS port too — the engine is the heavy reader on this DB.
  db.pragma('wal_autocheckpoint = 10000');
  try { sqliteVec.load(db); }
  catch (e) { console.warn('[mimir-js] sqlite-vec load failed:', e.message); }
  return db;
}

export function openDb(dbPath) {
  if (_db) return _db;
  const p = resolve(dbPath);
  _pendingPath = p;
  const db = _tryOpen(p);
  if (!db) {
    // Engine hasn't created the file yet — getDb() will keep retrying.
    return null;
  }
  _db = db;
  _dbPath = p;
  console.log(`[mimir-js] db opened: ${p}`);
  return _db;
}

export function getDb() {
  if (_db) return _db;
  if (_pendingPath) {
    const db = _tryOpen(_pendingPath);
    if (db) {
      _db = db;
      _dbPath = _pendingPath;
      console.log(`[mimir-js] db opened (lazy): ${_dbPath}`);
      return _db;
    }
  }
  throw new Error('db not opened yet — engine has not created constellation.db');
}

export function getDbPath() { return _dbPath; }

export function closeDb() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
}

// Return single counter value or fallback.
export function tableCount(table) {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE state='active'`).get();
    return row?.c ?? 0;
  } catch {
    try {
      const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      return row?.c ?? 0;
    } catch { return 0; }
  }
}

// Read a value from engine_meta or return null.
export function getMeta(key) {
  try {
    const row = getDb().prepare(`SELECT value FROM engine_meta WHERE key = ?`).get(key);
    return row?.value ?? null;
  } catch { return null; }
}
