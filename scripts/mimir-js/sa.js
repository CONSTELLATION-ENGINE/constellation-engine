// SPDX-License-Identifier: AGPL-3.0-or-later
// Multi-SA: 3-channel spreading activation over the active star map.
// Mirrors the Python daemon's _multi_sa_tick (mimir_daemon.py:4658+).
//
// Channels: knowledge / language / scaffold. Each owns a filtered subset of
// the edge graph (by edge type). One tick:
//
//   A_ch(t+1) = D · A_ch(t) + α · W_ch · A_ch(t) + I_ch(t)
//
// Three ping-pong rounds of (diffuse → cross-channel inhibit) then fuse.
// Slow EMA + baseline EMA persist across calls so `delta = A_fast − baseline`
// surfaces real surprise (the Python POOL_W_FAST·delta term).
//
// Graph state rebuilt every REBUILD_MS (5min). Pool calls step() before
// reading per-node state, so activation is fresh by the time scoring runs.

import { getDb } from './db.js';

const SA_NAMES = ['knowledge', 'language', 'scaffold'];

// Edge type → channel index. System types (collision/coactivation/relates_to)
// broadcast to all channels. Negative-influence types (contradicts/inhibits)
// excluded entirely (they're handled by IR pass, not diffusion).
const EDGE_CHANNEL = {
  // knowledge
  supports: 0, causes: 0, causal: 0, extends: 0, synthesizes: 0,
  challenges: 0, contextualizes: 0, contrasts: 0, contrastive: 0, hierarchical: 0,
  // language
  inspires: 1, parallels: 1, exemplifies: 1, complements: 1,
  associative: 1, temporal: 1,
  // scaffold
  enables: 2, triggers: 2, depends_on: 2, contains: 2, supersedes: 2, builds_on: 2,
};
// Edge types that broadcast to all channels (system / topology):
const EDGE_BROADCAST = new Set(['collision', 'coactivation', 'relates_to']);
// Edge types skipped entirely:
const EDGE_SKIP = new Set(['contradicts', 'inhibits']);

// Node type → seed channel (where this node "lives" for input seeding).
const NODE_TYPE_CHANNEL = {
  theory: 0, observation: 0, decision: 0, milestone: 0, exploration: 0,
  'language-template': 1, 'conversation-insight': 1, diary: 1,
  'language-art': 1, 'social-rule': 1,
  action: 2, engineering: 2, principle: 2, anchor: 2,
  'theory-of-change': 2, lesson: 2,
};

const DIFFUSION_ALPHA = 0.05;     // Python: DIFFUSION_ALPHA
const DECAY = 0.94;               // Python: DECAY_STANDARD
const PINGPONG_BETA = 0.40;       // Python: PINGPONG_BETA
const PINGPONG_ROUNDS = 3;        // Python: PINGPONG_ROUNDS
const ACTIVATION_CAP = 1.0;
const SLOW_EMA_KEEP = 0.85;       // smoother slow channel
const BASELINE_EMA_KEEP = 0.98;   // Python: POOL_BASELINE_EMA_KEEP

const FUSE_WEIGHTS = [0.50, 0.25, 0.25];   // K dominant, L+S balanced

const REBUILD_MS = 5 * 60 * 1000;
const MAX_NODES = 5000;           // cap so big graphs don't OOM the worker

let _state = null;
let _alphaScale = 1.0;            // turn_signal alpha modulator, ∈[0.5, 2.0]
let _lastLoggedShape = null;      // {N, edgeCount} of last printed rebuild

export function setAlphaScale(v) {
  if (Number.isFinite(v) && v >= 0.3 && v <= 3.0) _alphaScale = v;
}

function _seedRecency(node, nowMs) {
  let aMs = 0;
  const v = node.accessed_at;
  if (v != null) {
    if (typeof v === 'number') aMs = v < 1e12 ? v * 1000 : v;
    else { const p = Date.parse(v); aMs = Number.isFinite(p) ? p : 0; }
  }
  const ageH = aMs > 0 ? (nowMs - aMs) / 3600000 : 9999;
  const recency = Math.exp(-ageH / 168);                      // 1-week half-life-ish
  const freq = Math.min(1, Math.log10(1 + (node.access_count || 1)) / 2);
  // Total stays well under decay headroom (1−0.94=0.06) so steady-state
  // activation tracks structural relevance, not seed-driven saturation.
  return 0.020 * recency + 0.010 * freq;
}

function _buildState() {
  const db = getDb();
  const nodeRows = db.prepare(`
    SELECT id, node_type, weight, accessed_at, access_count, l2
      FROM nodes
     WHERE state='active' AND superseded_at IS NULL
     ORDER BY accessed_at DESC
     LIMIT ?
  `).all(MAX_NODES);
  const N = nodeRows.length;
  if (N === 0) return null;

  const idx = new Map();
  for (let i = 0; i < N; i++) idx.set(nodeRows[i].id, i);

  // r14 zombie-edge defense: filter at the SQL layer too (both endpoints must
  // be in the live node set). The downstream idx.get() guard below catches
  // anything that slips through, but doing it here keeps the read cheap on
  // large graphs with orphan edges accumulated from older builds.
  const edgeRows = db.prepare(`
    SELECT e.source AS s, e.target AS t, COALESCE(e.strength, 0.5) AS w, e.edge_type AS et
      FROM edges e
     WHERE e.state='active'
       AND COALESCE(e.strength, 0.5) > 0.05
       AND EXISTS (SELECT 1 FROM nodes ns WHERE ns.id = e.source AND ns.state = 'active' AND ns.superseded_at IS NULL)
       AND EXISTS (SELECT 1 FROM nodes nt WHERE nt.id = e.target AND nt.state = 'active' AND nt.superseded_at IS NULL)
  `).all();

  // Per-channel adjacency lists (will convert to CSR for fast matvec).
  const adj = [[], [], []];
  for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) adj[c].push([]);

  // Count edges that actually survive into the SA graph — separates "what's in
  // the DB" from "what drives activation" so observation panels can flag drift.
  let liveEdgeCount = 0;
  for (const e of edgeRows) {
    if (!e.s || !e.t || e.s === e.t) continue;
    if (EDGE_SKIP.has(e.et)) continue;
    const i = idx.get(e.s), j = idx.get(e.t);
    if (i == null || j == null) continue;
    let chans;
    if (EDGE_BROADCAST.has(e.et) || e.et == null) chans = [0, 1, 2];
    else if (EDGE_CHANNEL[e.et] != null) chans = [EDGE_CHANNEL[e.et]];
    else continue;                                            // unknown type
    liveEdgeCount++;
    for (const c of chans) {
      adj[c][i].push([j, e.w]);
      adj[c][j].push([i, e.w]);                               // undirected
    }
  }

  // CSR per channel
  const csrPerCh = [];
  for (let c = 0; c < 3; c++) {
    let nnz = 0;
    for (let i = 0; i < N; i++) nnz += adj[c][i].length;
    const rowPtr = new Int32Array(N + 1);
    const colInd = new Int32Array(nnz);
    const vals = new Float32Array(nnz);
    let k = 0;
    for (let i = 0; i < N; i++) {
      rowPtr[i] = k;
      for (const [j, w] of adj[c][i]) { colInd[k] = j; vals[k] = w; k++; }
    }
    rowPtr[N] = k;
    csrPerCh.push({ rowPtr, colInd, vals, N, nnz });
  }

  return {
    nodeRows, idx, csrPerCh, N,
    A_fast: new Float32Array(N),
    A_slow: new Float32Array(N),
    baseline: new Float32Array(N),
    A_ch: [new Float32Array(N), new Float32Array(N), new Float32Array(N)],
    massCache: new Float32Array(N),
    lastBuilt: Date.now(),
    lastTick: 0,
    edgeCount: liveEdgeCount,
    edgeCountRaw: edgeRows.length,
  };
}

function _csrMatvec(csr, x, out, alpha) {
  const { rowPtr, colInd, vals, N } = csr;
  for (let i = 0; i < N; i++) {
    let s = 0;
    const e = rowPtr[i + 1];
    for (let k = rowPtr[i]; k < e; k++) s += vals[k] * x[colInd[k]];
    out[i] = alpha * s;
  }
}

function _seedInput(state, nowMs) {
  const N = state.N;
  const I = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  // Cap per-tick seed so alpha=2.0 + warm node can't overshoot the
  // 1−DECAY headroom (0.06) and pin steady-state activation at the cap.
  const SEED_HEADROOM = 0.030;
  for (let i = 0; i < N; i++) {
    const n = state.nodeRows[i];
    const seed = _seedRecency(n, nowMs);
    if (seed < 0.0005) continue;
    let scaled = seed * _alphaScale;
    if (scaled > SEED_HEADROOM) scaled = SEED_HEADROOM;
    const ch = NODE_TYPE_CHANNEL[n.node_type || ''];
    if (ch != null) I[ch][i] = scaled;
    else { I[0][i] = scaled * 0.4; I[1][i] = scaled * 0.3; I[2][i] = scaled * 0.3; }
  }
  return I;
}

function _tickOnce(state, I) {
  const N = state.N;
  // Decay + add input
  for (let c = 0; c < 3; c++) {
    const A = state.A_ch[c];
    const Ic = I[c];
    for (let i = 0; i < N; i++) A[i] = A[i] * DECAY + Ic[i];
  }

  const scratch = new Float32Array(N);
  for (let r = 0; r < PINGPONG_ROUNDS; r++) {
    // Diffusion per channel
    for (let c = 0; c < 3; c++) {
      _csrMatvec(state.csrPerCh[c], state.A_ch[c], scratch, DIFFUSION_ALPHA);
      const A = state.A_ch[c];
      for (let i = 0; i < N; i++) {
        let v = A[i] + scratch[i];
        if (v > ACTIVATION_CAP) v = ACTIVATION_CAP;
        else if (v < 0) v = 0;
        A[i] = v;
      }
    }
    // Cross-channel inhibition: each node's non-dominant channels suppressed
    const A0 = state.A_ch[0], A1 = state.A_ch[1], A2 = state.A_ch[2];
    const k = 1.0 - PINGPONG_BETA;
    for (let i = 0; i < N; i++) {
      const v0 = A0[i], v1 = A1[i], v2 = A2[i];
      const m = v0 >= v1 ? (v0 >= v2 ? 0 : 2) : (v1 >= v2 ? 1 : 2);
      if (m !== 0) A0[i] = v0 * k;
      if (m !== 1) A1[i] = v1 * k;
      if (m !== 2) A2[i] = v2 * k;
    }
  }

  // Fuse + slow/baseline EMAs
  const A_fast = state.A_fast, A_slow = state.A_slow, baseline = state.baseline;
  const A0 = state.A_ch[0], A1 = state.A_ch[1], A2 = state.A_ch[2];
  for (let i = 0; i < N; i++) {
    const fused = FUSE_WEIGHTS[0] * A0[i] + FUSE_WEIGHTS[1] * A1[i] + FUSE_WEIGHTS[2] * A2[i];
    A_fast[i] = fused;
    A_slow[i] = SLOW_EMA_KEEP * A_slow[i] + (1 - SLOW_EMA_KEEP) * fused;
    baseline[i] = BASELINE_EMA_KEEP * baseline[i] + (1 - BASELINE_EMA_KEEP) * fused;
  }
  state.lastTick = Date.now();
}

// Public API ────────────────────────────────────────────────────────────────

export function ensureState() {
  if (!_state || Date.now() - _state.lastBuilt > REBUILD_MS) {
    try {
      const fresh = _buildState();
      if (!fresh) return _state;     // DB empty — keep prior state if any
      // Carry forward A_slow/baseline for nodes that survived rebuild
      if (_state) {
        for (let i = 0; i < fresh.N; i++) {
          const id = fresh.nodeRows[i].id;
          const old = _state.idx.get(id);
          if (old != null) {
            fresh.A_slow[i] = _state.A_slow[old];
            fresh.baseline[i] = _state.baseline[old];
            fresh.A_ch[0][i] = _state.A_ch[0][old];
            fresh.A_ch[1][i] = _state.A_ch[1][old];
            fresh.A_ch[2][i] = _state.A_ch[2][old];
          }
        }
      }
      _state = fresh;
      // Only log when graph shape changes meaningfully — avoids 5-min heartbeat
      // noise when N/edgeCount are stable. MIMIR_VERBOSE=1 forces every rebuild.
      const verbose = process.env.MIMIR_VERBOSE === '1';
      const prev = _lastLoggedShape;
      const shapeChanged = !prev || prev.N !== fresh.N || prev.edgeCount !== fresh.edgeCount;
      if (verbose || shapeChanged) {
        console.log(`[mimir-js sa] graph rebuilt — ${fresh.N} nodes, ${fresh.edgeCount} edges`);
        _lastLoggedShape = { N: fresh.N, edgeCount: fresh.edgeCount };
      }
    } catch (e) {
      console.warn('[mimir-js sa] buildState failed:', e.message);
      return _state;
    }
  }
  return _state;
}

export function step() {
  const s = ensureState();
  if (!s) return null;
  const I = _seedInput(s, Date.now());
  _tickOnce(s, I);
  return s;
}

// Outside callers (e.g., /signal handler) inject targeted energy.
// Channel: 0=K, 1=L, 2=S, null=split across all three.
export function inject(nodeId, energy = 0.5, channel = null) {
  const s = ensureState();
  if (!s) return false;
  const i = s.idx.get(nodeId);
  if (i == null) return false;
  const clamp = (c) => { if (s.A_ch[c][i] > ACTIVATION_CAP) s.A_ch[c][i] = ACTIVATION_CAP; };
  if (channel != null && channel >= 0 && channel < 3) {
    s.A_ch[channel][i] += energy; clamp(channel);
  } else {
    s.A_ch[0][i] += energy / 3; clamp(0);
    s.A_ch[1][i] += energy / 3; clamp(1);
    s.A_ch[2][i] += energy / 3; clamp(2);
  }
  return true;
}

// Per-node read for pool scoring. Returns {activation, activation_slow,
// baseline, delta, sa_channel}. delta is the Python POOL_W_FAST term.
export function getNodeState(nodeId) {
  const s = _state;
  if (!s) return null;
  const i = s.idx.get(nodeId);
  if (i == null) return null;
  const v0 = s.A_ch[0][i], v1 = s.A_ch[1][i], v2 = s.A_ch[2][i];
  let ch = 'mixed', maxV = 0;
  if (v0 > maxV) { maxV = v0; ch = 'knowledge'; }
  if (v1 > maxV) { maxV = v1; ch = 'language'; }
  if (v2 > maxV) { maxV = v2; ch = 'scaffold'; }
  if (maxV < 0.001) ch = 'mixed';
  const a = s.A_fast[i];
  const slow = s.A_slow[i];
  const base = s.baseline[i];
  return {
    activation: a,
    activation_slow: slow,
    baseline: base,
    delta: Math.max(0, a - base),
    sa_channel: ch,
  };
}

export function getChannelMaxes() {
  const s = _state;
  if (!s) return { K_max: 0, L_max: 0, S_max: 0 };
  let K = 0, L = 0, S = 0;
  const N = s.N;
  const A0 = s.A_ch[0], A1 = s.A_ch[1], A2 = s.A_ch[2];
  for (let i = 0; i < N; i++) {
    if (A0[i] > K) K = A0[i];
    if (A1[i] > L) L = A1[i];
    if (A2[i] > S) S = A2[i];
  }
  return { K_max: K, L_max: L, S_max: S };
}

export function saStats() {
  const s = _state;
  if (!s) return { ready: false };
  return {
    ready: true,
    node_count: s.N,
    edge_count: s.edgeCount,
    last_built_ms: s.lastBuilt,
    last_tick_ms: s.lastTick,
  };
}
