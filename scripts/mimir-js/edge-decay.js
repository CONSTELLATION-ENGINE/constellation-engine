// SPDX-License-Identifier: AGPL-3.0-or-later
// Edge decay maintenance — "use it or lose it" for edge strength.
// Mirrors mimir_daemon.py:edge_decay_maintenance (~L7567-7660).
//
// Two passes per call:
//   1. Decay: edges last accessed >24h ago get strength *= 0.998 (floored 0.05)
//   2. Dormancy: edges with strength < 0.05 transition state='active' → 'dormant'
//
// Hebb writeback refreshes accessed_at on co-active pairs, so frequently fired
// edges escape decay automatically. The MAX_PER_CALL cap prevents a backlog
// from monopolizing the worker thread; leftover work resumes next interval.
//
// Kill-switch: MIMIR_EDGE_DECAY=0. Defaults ON, fires every 3600s (1h).

import { getDb } from './db.js';

const KILL = String(process.env.MIMIR_EDGE_DECAY || '').trim() === '0';
const INTERVAL_MS = parseInt(process.env.MIMIR_EDGE_DECAY_INTERVAL_MS || '3600000', 10);

const DECAY_RATE = 0.998;
const MIN_STRENGTH = 0.05;
const MAX_PER_CALL = 5000;
const DECAY_BATCH = 500;
const DORMANT_BATCH = 200;
const YIELD_MS = 20;

let _intervalHandle = null;
let _lastRunTs = 0;
let _lastResult = null;
let _lastError = null;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function runEdgeDecay() {
  if (KILL) return { ok: false, killed: true };
  const db = getDb();

  let decayed = 0;
  let dormant = 0;

  const decayStmt = db.prepare(`
    UPDATE edges SET strength = MAX(?, strength * ?)
     WHERE id IN (
       SELECT id FROM edges
        WHERE state = 'active'
          AND COALESCE(accessed_at, created_at) < datetime('now', '-24 hours')
          AND strength > ?
        LIMIT ?
     )
  `);
  try {
    while (decayed < MAX_PER_CALL) {
      const info = decayStmt.run(MIN_STRENGTH, DECAY_RATE, MIN_STRENGTH * DECAY_RATE, DECAY_BATCH);
      const n = info.changes || 0;
      if (n === 0) break;
      decayed += n;
      if (n < DECAY_BATCH) break;
      await _sleep(YIELD_MS);
    }
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message, decayed, dormant };
  }

  const dormantStmt = db.prepare(`
    UPDATE edges SET state = 'dormant'
     WHERE id IN (
       SELECT id FROM edges
        WHERE state = 'active' AND strength < ?
        LIMIT ?
     )
  `);
  try {
    while (dormant < MAX_PER_CALL) {
      const info = dormantStmt.run(MIN_STRENGTH, DORMANT_BATCH);
      const n = info.changes || 0;
      if (n === 0) break;
      dormant += n;
      if (n < DORMANT_BATCH) break;
      await _sleep(YIELD_MS);
    }
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message, decayed, dormant };
  }

  _lastRunTs = Date.now();
  _lastError = null;
  _lastResult = { decayed, dormant };
  if (decayed || dormant) {
    console.log(`[mimir-js edge-decay] attenuated=${decayed} dormant=${dormant}`);
  }
  return { ok: true, decayed, dormant };
}

export function startEdgeDecayLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    runEdgeDecay().catch((e) => {
      _lastError = e.message;
      console.warn('[mimir-js edge-decay] loop error:', e.message);
    });
  }, INTERVAL_MS);
  _intervalHandle.unref?.();
  return true;
}

export function stopEdgeDecayLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function edgeDecayStatus() {
  return {
    enabled: !KILL,
    interval_ms: INTERVAL_MS,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    last_result: _lastResult,
    last_error: _lastError,
  };
}
