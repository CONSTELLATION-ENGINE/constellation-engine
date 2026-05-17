// SPDX-License-Identifier: AGPL-3.0-or-later
// Rumination — default-mode-network analog. When the daemon goes idle, pick a
// recently-active Leiden zone, re-inject energy into its top weighted nodes.
// Mirrors mimir_daemon.py:ruminate (L5599-5687) + the idle-gated dispatch at
// L15411-15423 (rumination_interval_s=120, idle ticks >120).
//
// Selection (Python parity):
//   • Mean A_slow per zone → "what we were just thinking about"
//   • max_slow > 0.005 → slow-bias: 0.7 · slow_share + 0.3 · size_share
//   • else            → size-weighted random fallback
//   • Pick top 12 (rumination_n_nodes) by `weight · (1 + log(1 + access_count))`
//   • Inject `rumination_strength=0.35` per node, split across SA channels
//
// Cadence (Python parity): every 120s, only when idle for ≥120 ticks (≈60s
// of no /signal). The watchdog has its own keepalive — rumination is a pure
// cognitive afterglow, not a liveness mechanism.
//
// Kill-switch: MIMIR_RUMINATION=0. Defaults ON.

import { getDb } from './db.js';
import * as sa from './sa.js';
import { getCommunities } from './zones.js';

const KILL = String(process.env.MIMIR_RUMINATION || '').trim() === '0';
const INTERVAL_MS = parseInt(process.env.MIMIR_RUMINATION_INTERVAL_MS || '120000', 10);
const IDLE_MS = parseInt(process.env.MIMIR_RUMINATION_IDLE_MS || '60000', 10);
const N_NODES = 12;
const STRENGTH = 0.35;
const SLOW_WARM_THRESHOLD = 0.005;
const SLOW_WEIGHT = 0.7;
const SIZE_WEIGHT = 0.3;

let _enabled = String(process.env.MIMIR_RUMINATION || '1').trim() !== '0';
let _intervalHandle = null;
let _lastRunTs = 0;
let _lastActivated = 0;
let _lastSignalTs = Date.now();
let _runs = 0;
let _lastError = null;

export function setRuminationEnabled(v) { _enabled = !!v; }
export function isRuminationEnabled() { return _enabled; }

// Called from /signal handler so the rumination loop knows when the daemon is
// actually idle vs. just between heartbeats.
export function noteExternalSignal() { _lastSignalTs = Date.now(); }

function _pickZone(communities, A_slow, idxOf) {
  const Z = communities.length;
  if (!Z) return -1;
  const slowMeans = new Float64Array(Z);
  const sizes = new Int32Array(Z);
  let maxSlow = 0;
  for (let z = 0; z < Z; z++) {
    const members = communities[z];
    sizes[z] = members.length;
    if (!members.length) continue;
    let sum = 0, cnt = 0;
    for (const nid of members) {
      const i = idxOf.get(nid);
      if (i == null) continue;
      sum += A_slow[i];
      cnt++;
    }
    if (cnt) {
      slowMeans[z] = sum / cnt;
      if (slowMeans[z] > maxSlow) maxSlow = slowMeans[z];
    }
  }
  let totalSize = 0;
  for (let z = 0; z < Z; z++) totalSize += sizes[z];
  if (!totalSize) return -1;
  const probs = new Float64Array(Z);
  if (maxSlow > SLOW_WARM_THRESHOLD) {
    let slowTotal = 0;
    for (let z = 0; z < Z; z++) slowTotal += slowMeans[z];
    slowTotal += 1e-8;
    for (let z = 0; z < Z; z++) {
      probs[z] = SLOW_WEIGHT * (slowMeans[z] / slowTotal) + SIZE_WEIGHT * (sizes[z] / totalSize);
    }
  } else {
    for (let z = 0; z < Z; z++) probs[z] = sizes[z] / totalSize;
  }
  // Normalize then weighted sample
  let psum = 0;
  for (let z = 0; z < Z; z++) psum += probs[z];
  if (psum <= 0) return -1;
  let r = Math.random() * psum;
  for (let z = 0; z < Z; z++) {
    r -= probs[z];
    if (r <= 0) return z;
  }
  return Z - 1;
}

export function runRumination() {
  if (KILL || !_enabled) return { ok: false, skipped: 'disabled' };
  const s = sa.ensureState();
  if (!s) return { ok: false, skipped: 'sa not ready' };
  // Idle gate: only ruminate when no external /signal has landed recently.
  if (Date.now() - _lastSignalTs < IDLE_MS) return { ok: true, skipped: 'not idle' };

  const communities = getCommunities();
  if (!communities || !communities.length) return { ok: true, skipped: 'no zones' };

  const zoneIdx = _pickZone(communities, s.A_slow, s.idx);
  if (zoneIdx < 0) return { ok: true, skipped: 'no zone selected' };
  const zoneNodes = communities[zoneIdx];
  if (!zoneNodes.length) return { ok: true, skipped: 'empty zone' };

  // Top-N by weight · log(1+access_count). LIMIT 15 fetch, take min(N_NODES, len).
  let rows = [];
  try {
    const db = getDb();
    const placeholders = zoneNodes.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT id FROM nodes
       WHERE id IN (${placeholders})
         AND state='active'
       ORDER BY weight * (1 + LOG(1 + access_count)) DESC
       LIMIT 15
    `).all(...zoneNodes);
  } catch (e) {
    _lastError = e.message;
    return { ok: false, error: e.message };
  }

  const chosen = rows.slice(0, N_NODES).map((r) => r.id).filter((id) => s.idx.has(id));
  let activated = 0;
  for (const nid of chosen) {
    if (sa.inject(nid, STRENGTH, null)) activated++;
  }

  _lastRunTs = Date.now();
  _lastActivated = activated;
  _runs++;
  _lastError = null;
  if (activated) {
    console.log(`[mimir-js rumination] zone=${zoneIdx} re-activated ${activated} nodes`);
  }
  return { ok: true, activated, zone: zoneIdx };
}

export function startRuminationLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    try { runRumination(); } catch (e) { _lastError = e.message; }
  }, INTERVAL_MS);
  _intervalHandle.unref?.();
  return true;
}

export function stopRuminationLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function ruminationStatus() {
  return {
    enabled: !KILL && _enabled,
    kill_switch_off: KILL,
    interval_ms: INTERVAL_MS,
    idle_ms: IDLE_MS,
    runs: _runs,
    last_run_ms: _lastRunTs,
    last_activated: _lastActivated,
    last_error: _lastError,
  };
}
