// SPDX-License-Identifier: AGPL-3.0-or-later
// Dream revival: idle-period reactivation of high-salience memory nodes.
// Picks N nodes weighted by (arousal x weight x recency-score) and injects a
// small SA pulse for each. Optionally logs the revival batch as a diary entry
// so the next reflection cycle can consume it.
//
// Kill-switch: MIMIR_DREAM=0 disables the loop and inject calls.
// Defaults to ON, fires every DREAM_INTERVAL_MS (default 12 min).

import { getDb } from './db.js';
import * as sa from './sa.js';
import { appendDiary } from './diary.js';

const KILL = String(process.env.MIMIR_DREAM || '').trim() === '0';
const REVIVAL_COUNT      = 4;
const DREAM_INTERVAL_MS  = parseInt(process.env.MIMIR_DREAM_INTERVAL_MS || '720000', 10); // 12 min
const IDLE_THRESHOLD_MS  = parseInt(process.env.MIMIR_DREAM_IDLE_MS    || '600000', 10); // 10 min idle
const SA_PULSE_STRENGTH  = 0.20;

let _lastRunTs   = 0;
let _lastTouchTs = Date.now();
let _intervalHandle = null;

export function noteUserActivity() {
  _lastTouchTs = Date.now();
}

function _pickRevivalNodes(limit) {
  const db = getDb();
  // Salience proxy: arousal * weight, biased by recent access. Excludes diary
  // (already a derivative) and identity (already permanent in the pool).
  const rows = db.prepare(`
    SELECT id, l0, l1, node_type, weight, arousal, accessed_at
      FROM nodes
     WHERE state = 'active' AND superseded_at IS NULL
       AND node_type NOT IN ('diary', 'identity', 'milestone')
       AND COALESCE(weight, 0.5) >= 0.3
     ORDER BY (COALESCE(arousal, 1.0) * COALESCE(weight, 0.5)
               + (CAST(strftime('%s','now') AS INTEGER) - COALESCE(accessed_at, 0)) * -1e-7) DESC
     LIMIT ?
  `).all(Math.max(1, Math.min(20, limit | 0)));
  return rows;
}

export function runDreamCycle({ count = REVIVAL_COUNT, log = true } = {}) {
  if (KILL) return { ok: false, killed: true, revived: [] };
  let nodes = [];
  try { nodes = _pickRevivalNodes(count); }
  catch (e) { return { ok: false, error: e.message, revived: [] }; }
  if (nodes.length === 0) return { ok: true, revived: [], note: 'no candidates' };

  const revived = [];
  for (const n of nodes) {
    try {
      const ok = sa.inject(n.id, SA_PULSE_STRENGTH, null);
      revived.push({ node_id: n.id, l0: n.l0 || '', injected: !!ok });
    } catch {
      revived.push({ node_id: n.id, l0: n.l0 || '', injected: false });
    }
  }
  _lastRunTs = Date.now();

  if (log) {
    try {
      appendDiary({
        kind: 'dream_revival',
        text: `Revived ${revived.length} nodes during idle: ` +
              revived.map(r => r.l0.slice(0, 40)).join(' | '),
        source: 'mimir-js/dream',
        meta: { count: revived.length, ids: revived.map(r => r.node_id) },
      });
    } catch {}
  }

  return { ok: true, revived, when: new Date(_lastRunTs).toISOString() };
}

export function startDreamLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    const idle = Date.now() - _lastTouchTs;
    if (idle < IDLE_THRESHOLD_MS) return;
    if (Date.now() - _lastRunTs < DREAM_INTERVAL_MS) return;
    try { runDreamCycle({}); }
    catch (e) { console.warn('[mimir-js dream] cycle failed:', e.message); }
  }, DREAM_INTERVAL_MS).unref();
  return true;
}

export function stopDreamLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function dreamStatus() {
  return {
    enabled: !KILL,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    last_user_touch: new Date(_lastTouchTs).toISOString(),
    interval_ms: DREAM_INTERVAL_MS,
    idle_threshold_ms: IDLE_THRESHOLD_MS,
  };
}
