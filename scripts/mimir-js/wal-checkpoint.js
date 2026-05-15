// SPDX-License-Identifier: AGPL-3.0-or-later
// WAL checkpoint loop — periodic explicit PRAGMA wal_checkpoint(PASSIVE).
// Mirrors the periodic checkpoint cadence of mimir_daemon.py.
//
// db.js sets wal_autocheckpoint=10000 pages so writes don't trigger inline
// checkpoints, which is great for write throughput but lets the WAL grow
// without bound when the engine is the dominant reader (OSS case). On long
// idle sessions the WAL can balloon to hundreds of MB before SQLite gets
// around to truncating it. A 10-min explicit PASSIVE checkpoint keeps the
// WAL bounded without blocking writers — PASSIVE skips frames behind active
// readers, then truncates whatever it could flush.
//
// Kill-switch: MIMIR_WAL_CHECKPOINT=0. Defaults ON, fires every 600s (10min).

import { getDb } from './db.js';

const KILL = String(process.env.MIMIR_WAL_CHECKPOINT || '').trim() === '0';
const INTERVAL_MS = parseInt(process.env.MIMIR_WAL_CHECKPOINT_INTERVAL_MS || '600000', 10);

let _intervalHandle = null;
let _lastRunTs = 0;
let _lastResult = null;
let _lastError = null;

export function runWalCheckpoint() {
  if (KILL) return { ok: false, killed: true };
  try {
    const db = getDb();
    // PRAGMA wal_checkpoint returns { busy, log, checkpointed }.
    // busy=1 means a writer/reader held the lock for some frames; that's fine
    // under PASSIVE — leftover frames will be picked up next pass.
    const row = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    _lastRunTs = Date.now();
    _lastError = null;
    _lastResult = row || null;
    return { ok: true, ...row };
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message };
  }
}

export function startWalCheckpointLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    try { runWalCheckpoint(); }
    catch (e) {
      _lastError = e.message;
      console.warn('[mimir-js wal-checkpoint] loop error:', e.message);
    }
  }, INTERVAL_MS);
  _intervalHandle.unref?.();
  return true;
}

export function stopWalCheckpointLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function walCheckpointStatus() {
  return {
    enabled: !KILL,
    interval_ms: INTERVAL_MS,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    last_result: _lastResult,
    last_error: _lastError,
  };
}
