// SPDX-License-Identifier: AGPL-3.0-or-later
// Hebb writeback — BCM non-monotonic plasticity for edge strength.
// Mirrors mimir_daemon.py:hebb_writeback (~L6959-7087).
//
//   ai > 0.5 && aj > 0.5  → +0.02 LTP
//   0.2 < ai,aj ≤ 0.5     → −0.01 LTD (legacy; replaced by V5a P6 below)
//   either ≤ 0.2          → no change
//
// V5a Phase 6 (default-ON via MIMIR_V5_EDGE_DECAY): the LTD branch is replaced
// by a single-pass multiplicative decay on outgoing edges of every active
// (fired) node — `strength = max(0.05, strength * factor)`. Tunable via
// MIMIR_V5_EDGE_DECAY_FACTOR (default 0.99, clamped to 0.95-0.999). Decays
// run BEFORE the per-pair LTP fetch so LTP cleanly stacks on top of the
// decayed baseline. Coexists cleanly with edge-decay.js: both refresh
// accessed_at, so no edge gets double-decayed in the same hour.
//
// Activation source: sa.js A_fast (post-fuse). Caps to top 30 most-active
// nodes to bound the O(n²) pair scan. Batches edge UPDATEs in chunks of 20
// with 100ms yields between batches so /signal etc. can grab the lock —
// the same write-storm relief the Python daemon needs at scale.
//
// Kill-switch: MIMIR_HEBB=0. Defaults ON, fires every 180s.

import { getDb } from './db.js';
import * as sa from './sa.js';

const KILL = String(process.env.MIMIR_HEBB || '').trim() === '0';
const HEBB_INTERVAL_MS = parseInt(process.env.MIMIR_HEBB_INTERVAL_MS || '180000', 10);
const MIN_COACT = 0.2;
const MAX_ACTIVE = 30;
const CHUNK = 20;
const YIELD_MS = 100;
const LTP_DELTA = 0.02;
const LTD_DELTA = -0.01;
const STRENGTH_FLOOR = 0.05;
const STRENGTH_CAP = 1.0;

let _intervalHandle = null;
let _lastRunTs = 0;
let _lastResult = null;
let _lastError = null;
// P38d: only log decay-only summaries when the decayed count changes.
// Resets to -1 on LTP-success path so a return to decay-only logs once.
let _lastDecayPrint = -1;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function runHebbWriteback() {
  if (KILL) return { ok: false, killed: true, updated: 0 };
  const s = sa.ensureState();
  if (!s) return { ok: true, updated: 0, note: 'sa state not ready' };

  const A = s.A_fast;
  const N = s.N;
  const active = [];
  for (let i = 0; i < N; i++) if (A[i] > MIN_COACT) active.push(i);
  if (active.length < 2) return { ok: true, updated: 0, note: 'fewer than 2 active nodes' };

  let activeIdx = active;
  if (active.length > MAX_ACTIVE) {
    activeIdx = active.slice().sort((a, b) => A[b] - A[a]).slice(0, MAX_ACTIVE);
  }

  // V5a Phase 6: env gates read once per writeback so flips take effect on
  // the next call without restart.
  const v5DecayEnabled = String(process.env.MIMIR_V5_EDGE_DECAY || '1').trim() !== '0';
  let v5DecayFactor = parseFloat(process.env.MIMIR_V5_EDGE_DECAY_FACTOR || '0.99');
  if (!Number.isFinite(v5DecayFactor)) v5DecayFactor = 0.99;
  v5DecayFactor = Math.max(0.95, Math.min(0.999, v5DecayFactor));

  const db = getDb();
  let decayed = 0;

  // V5a Phase 6: bulk multiplicative decay on outgoing edges of all fired
  // (active) nodes. Runs BEFORE the LTP fetch so per-pair +0.02 cleanly
  // stacks on top of the decayed baseline. REPLACES legacy per-pair −0.01
  // LTD (short-circuited via `continue` in the BCM loop below when enabled).
  // Floor 0.05 enforced in SQL; `strength > 0.05` excludes already-floored
  // edges so we don't silently bump legacy sub-floor strengths up to 0.05.
  if (v5DecayEnabled) {
    try {
      const firedNids = activeIdx.map((idx) => s.nodeRows[idx].id);
      const placeholders = firedNids.map(() => '?').join(',');
      const info = db.prepare(
        `UPDATE edges
            SET strength = MAX(0.05, strength * ?),
                accessed_at = datetime('now')
          WHERE state = 'active'
            AND strength > 0.05
            AND source IN (${placeholders})`
      ).run(v5DecayFactor, ...firedNids);
      decayed = info.changes || 0;
    } catch (e) {
      _lastError = e.message;
      console.warn('[mimir-js hebb] V5a P6 decay failed:', e.message);
    }
  }

  const pairDeltas = [];
  for (let i = 0; i < activeIdx.length; i++) {
    for (let j = i + 1; j < activeIdx.length; j++) {
      const ai = A[activeIdx[i]], aj = A[activeIdx[j]];
      let delta;
      if (ai > 0.5 && aj > 0.5) delta = LTP_DELTA;
      else if (ai > 0.2 && aj > 0.2) {
        if (v5DecayEnabled) continue;  // V5a Phase 6: LTD replaced by L2 bulk decay above
        delta = LTD_DELTA;
      }
      else continue;
      pairDeltas.push([s.nodeRows[activeIdx[i]].id, s.nodeRows[activeIdx[j]].id, delta]);
    }
  }
  if (!pairDeltas.length) {
    if (decayed > 0) {
      _lastRunTs = Date.now();
      _lastResult = { strengthened: 0, weakened: 0, updated: 0, decayed };
      if (decayed !== _lastDecayPrint) {
        console.log(`[mimir-js hebb] V5a P6 decay only — ${decayed} edges, no LTP pairs`);
        _lastDecayPrint = decayed;
      }
      return { ok: true, updated: 0, decayed };
    }
    return { ok: true, updated: 0, note: 'no co-active pairs' };
  }
  const allNids = new Set();
  for (const [a, b] of pairDeltas) { allNids.add(a); allNids.add(b); }
  const nidList = Array.from(allNids);
  const placeholders = nidList.map(() => '?').join(',');

  let rows;
  try {
    rows = db.prepare(
      `SELECT source, target, strength FROM edges
        WHERE state='active'
          AND source IN (${placeholders})
          AND target IN (${placeholders})`
    ).all(...nidList, ...nidList);
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message, updated: 0 };
  }

  const edgeStrengths = new Map();
  for (const r of rows) edgeStrengths.set(`${r.source}|${r.target}`, r.strength);

  const updates = [];
  let strengthened = 0, weakened = 0;
  for (const [a, b, delta] of pairDeltas) {
    const old = edgeStrengths.get(`${a}|${b}`) ?? edgeStrengths.get(`${b}|${a}`);
    if (old == null) continue;
    const next = Math.max(STRENGTH_FLOOR, Math.min(STRENGTH_CAP, old + delta));
    if (next === old) continue;
    updates.push([next, a, b, b, a]);
    if (delta > 0) strengthened++; else weakened++;
  }
  if (!updates.length) {
    if (decayed > 0) {
      _lastRunTs = Date.now();
      _lastResult = { strengthened: 0, weakened: 0, updated: 0, decayed };
      return { ok: true, updated: 0, decayed };
    }
    return { ok: true, updated: 0, note: 'no edge changes' };
  }

  const stmt = db.prepare(
    `UPDATE edges
        SET strength=?, accessed_at=datetime('now')
      WHERE (source=? AND target=?) OR (source=? AND target=?)`
  );

  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    try {
      const tx = db.transaction((batch) => {
        for (const r of batch) stmt.run(...r);
      });
      tx(slice);
    } catch (e) {
      _lastError = e.message;
      console.warn('[mimir-js hebb] batch update failed:', e.message);
      break;
    }
    if (i + CHUNK < updates.length) await _sleep(YIELD_MS);
  }

  _lastRunTs = Date.now();
  _lastError = null;
  _lastResult = { strengthened, weakened, updated: updates.length, decayed };
  if (strengthened || weakened || decayed) {
    console.log(`[mimir-js hebb] +${strengthened}/-${weakened} edges${decayed ? ` (V5a P6 decay=${decayed})` : ''}`);
    _lastDecayPrint = -1; // reset so next decay-only path logs at least once
  }
  return { ok: true, updated: updates.length, strengthened, weakened, decayed };
}

export function startHebbLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    runHebbWriteback().catch((e) => {
      _lastError = e.message;
      console.warn('[mimir-js hebb] loop error:', e.message);
    });
  }, HEBB_INTERVAL_MS);
  _intervalHandle.unref?.();
  return true;
}

export function stopHebbLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function hebbStatus() {
  return {
    enabled: !KILL,
    interval_ms: HEBB_INTERVAL_MS,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    last_result: _lastResult,
    last_error: _lastError,
  };
}
