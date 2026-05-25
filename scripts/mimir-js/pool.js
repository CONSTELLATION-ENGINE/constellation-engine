// SPDX-License-Identifier: AGPL-3.0-or-later
// Attention pool — Python parity (mimir_daemon.py:2769+).
//
//   raw_score = POOL_W_FAST · delta + POOL_W_SLOW · A_slow
//             + POOL_W_MASS · mass + POOL_W_BRIDGE · bridge
//             + query_cosine_bonus
//
// Then per-type multiplier, superseded penalty, noise penalty, imported
// soft-suppression. Activation comes from sa.js Multi-SA tick; zones +
// bridge ratio from zones.js Leiden.
//
// /pool flow: step() ticks Multi-SA once → score every active node → split
// into dyn / perm and sort. Engine reads activations as-is.

import { getDb, getMeta } from './db.js';
import * as sa from './sa.js';
import * as zones from './zones.js';
import { hebbStatus } from './hebb.js';
import { ruminationStatus } from './rumination.js';

const DEFAULT_POOL_SIZE = 60;
const DEFAULT_LLM_INJECT_LIMIT = 65;

// Python POOL_W_* constants (mimir_daemon.py:312-315)
const POOL_W_FAST   = 0.80;
const POOL_W_SLOW   = 0.10;
const POOL_W_MASS   = 0.05;
const POOL_W_BRIDGE = 0.05;
const POOL_NOISE_PENALTY = 0.15;
const IMPORT_SUPPRESS_MULTIPLIER = 0.40;
const IMPORT_SUPPRESS_PROMOTE_THRESHOLD = 5;
const POOL_COSINE_BONUS_ALPHA = 0.30;
const POOL_COSINE_BONUS_GATE = 0.40;
const QUERY_SIM_TTL_MS = 5 * 60 * 1000;

// Per-type multiplier (Python POOL_TYPE_MULTIPLIER, mimir_daemon.py:382).
// Lower = pool prefers; higher = pool boosts. Defaults to 1.0 for unknown.
const TYPE_MULTIPLIER = {
  decision: 1.20, milestone: 1.20, principle: 1.15, anchor: 1.15,
  theory: 1.10, lesson: 1.10, observation: 1.05,
  action: 1.00, engineering: 1.00, exploration: 1.00,
  diary: 0.95, 'conversation-insight': 0.95,
  'language-template': 0.90, 'language-art': 0.90, 'social-rule': 0.90,
  // noise-ish:
  draft: 0.50, fragment: 0.50, scratch: 0.40,
};

const NOISE_TYPES = new Set(['draft', 'fragment', 'scratch']);

let _tick = 0;
let _lastQuerySims = null;
let _lastQuerySimsAt = 0;

export function recordQuerySimilarities(rows = []) {
  const sims = new Map();
  for (const row of rows) {
    const id = row.node_id || row.id;
    if (!id) continue;
    const dist = Number(row.distance);
    if (!Number.isFinite(dist)) continue;
    const cosine = Math.max(-1, Math.min(1, 1 - (dist * dist) / 2));
    sims.set(id, cosine);
  }
  _lastQuerySims = sims;
  _lastQuerySimsAt = Date.now();
}

function getQueryCosineBonus(nodeId) {
  if (!_lastQuerySims || (Date.now() - _lastQuerySimsAt) > QUERY_SIM_TTL_MS) return 0;
  const cosine = _lastQuerySims.get(nodeId);
  if (!Number.isFinite(cosine)) return 0;
  return POOL_COSINE_BONUS_ALPHA * Math.max(0, cosine - POOL_COSINE_BONUS_GATE);
}

// Bumped by the heartbeat loop so the dashboard's tick counter advances at
// heartbeat cadence (5s) instead of only when /pool is polled (30s). Without
// this, activations evolve in the background but the UI looks frozen because
// the visible counter only ticks once per pool poll.
export function advanceTick() {
  _tick += 1;
  return _tick;
}

function parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function parsePermanentSlots() {
  const raw = getMeta('permanent_slots');
  return parseJsonArray(raw);
}

// Mass = log10(L2 length + 1) / 4, capped 1.0. Long content carries weight.
function computeMass(node) {
  const len = (node.l2 || node.l1 || node.l0 || '').length;
  return Math.min(1, Math.log10(1 + len) / 4);
}

function isImportedUnpromoted(node) {
  if (node.source !== 'library' && node.node_type !== 'library' && !node.imported_batch_id) return false;
  return (node.access_count || 0) < IMPORT_SUPPRESS_PROMOTE_THRESHOLD;
}

export function getPool({ size = DEFAULT_POOL_SIZE } = {}) {
  _tick += 1;
  let db;
  try { db = getDb(); }
  catch { return _emptyPool(); }

  // 1. Tick Multi-SA so activation/delta is fresh.
  const saState = sa.step();

  // 2. Lazily refresh Leiden zones (1h cadence; cached map otherwise).
  zones.ensureZones().catch(() => {});  // fire-and-forget

  const perms = new Set(parsePermanentSlots());

  // Pull a wider candidate set than `size` so scoring picks the truly hot ones.
  const fetchLimit = Math.max(size * 4, 240);
  // Exclude resolver canary heartbeats — they're infra noise, not user data,
  // and otherwise dominate fresh-install pool snapshots / sidebar lists.
  // Mirrors the /api/graph filter (dashboard.js:3142). Surface them only via
  // the explicit Settings → Advanced → Show infrastructure nodes toggle.
  const rows = db.prepare(`
    SELECT id, l0, l1, l2, tags, tone, valence, arousal, weight, access_count,
           accessed_at, source, node_type, subkind, superseded_at,
           imported_batch_id
      FROM nodes
     WHERE state = 'active'
       AND superseded_at IS NULL
       AND source != 'autonomous:resolver-canary'
     ORDER BY accessed_at DESC
     LIMIT ?
  `).all(fetchLimit);

  const dynNodes = [];
  const permNodes = [];

  for (const r of rows) {
    const saNode = saState ? sa.getNodeState(r.id) : null;
    // Fall back to a tiny synthetic activation if SA isn't ready yet — keeps
    // first-few-seconds /pool calls non-empty. Engine treats delta>0.001 as
    // "in pool" (POOL_DYNAMIC_DELTA_THRESHOLD).
    const activation       = saNode?.activation       ?? 0.0;
    const activation_slow  = saNode?.activation_slow  ?? 0.0;
    const baseline         = saNode?.baseline         ?? 0.0;
    const delta            = saNode?.delta            ?? 0.005;
    const sa_channel       = saNode?.sa_channel       ?? 'mixed';

    const mass = computeMass(r);
    const bridge = zones.getBridgeOf(r.id);
    const zone = zones.getZoneOf(r.id);

    // Python pool scoring formula (additive 4-term, then multipliers)
    let score = POOL_W_FAST * delta
              + POOL_W_SLOW * activation_slow
              + POOL_W_MASS * mass
              + POOL_W_BRIDGE * bridge;

    // Type multiplier
    score *= (TYPE_MULTIPLIER[r.node_type] ?? 1.0);

    // Noise category penalty (drafts/fragments/scratch)
    if (NOISE_TYPES.has(r.node_type)) score *= POOL_NOISE_PENALTY;

    // Imported soft-suppression
    if (isImportedUnpromoted(r)) score *= IMPORT_SUPPRESS_MULTIPLIER;

    const query_cosine_bonus = perms.has(r.id) ? 0 : getQueryCosineBonus(r.id);
    score += query_cosine_bonus;
    const score_raw = score;

    const node = {
      id: r.id,
      l0: r.l0, l1: r.l1, l2: r.l2,
      tags: parseJsonArray(r.tags),
      tone: r.tone, valence: r.valence, arousal: r.arousal,
      weight: r.weight, access_count: r.access_count,
      source: r.source, node_type: r.node_type, subkind: r.subkind,
      score, score_raw,
      activation, activation_slow,
      baseline, delta,
      mass, bridge, zone, sa_channel,
      query_cosine_bonus,
      permanent: perms.has(r.id),
    };
    if (node.permanent) permNodes.push(node);
    else dynNodes.push(node);
  }

  // Sort dyn by score desc, take top `size - perm_count`
  dynNodes.sort((a, b) => b.score - a.score);
  const dynRoom = Math.max(0, size - permNodes.length);
  const dynKept = dynNodes.slice(0, dynRoom);

  // Daemon contract: dynamics-first, permanents-last (engine re-orders).
  const nodes = [...dynKept, ...permNodes];

  const maxes = sa.getChannelMaxes();
  const energy = Math.max(maxes.K_max, maxes.L_max, maxes.S_max);

  return {
    ok: true,
    tick: _tick,
    nodes,
    energy,
    K_max: maxes.K_max,
    L_max: maxes.L_max,
    S_max: maxes.S_max,
    llm_inject_limit: DEFAULT_LLM_INJECT_LIMIT,
    perm_count: permNodes.length,
    dyn_count: dynKept.length,
    query_bonus_active: !!(_lastQuerySims && (Date.now() - _lastQuerySimsAt) <= QUERY_SIM_TTL_MS),
  };
}

function _emptyPool() {
  return {
    ok: true, tick: _tick, nodes: [], energy: 0,
    K_max: 0, L_max: 0, S_max: 0,
    llm_inject_limit: DEFAULT_LLM_INJECT_LIMIT,
    perm_count: 0, dyn_count: 0,
  };
}

export function getStatus() {
  let db;
  try { db = getDb(); }
  catch {
    return {
      ok: true, tick: _tick, tick_count: _tick,
      active_count: 0, active_nodes: 0,
      n_nodes: 0, n_zones: 0, n_attractors: 0, hopfield_energy: 0,
      top_activations: [], top_nodes: [],
      zones: [], top_zones: [],
      backend: 'mimir-js', version: '0.1.0', db_ready: false,
      rumination_enabled: (() => { try { return ruminationStatus().enabled; } catch { return null; } })(),
      novelty_gate_enabled: (() => { try { return hebbStatus().novelty_gate_enabled; } catch { return null; } })(),
    };
  }
  let activeCount = 0;
  try {
    activeCount = db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE state='active'`).get()?.c ?? 0;
  } catch {}

  // top_activations: pull from real Multi-SA state if available, else fall
  // back to recent-touch order so the dashboard isn't empty during cold boot.
  let topActivations = [];
  try {
    const rows = db.prepare(`
      SELECT id, l0 FROM nodes
       WHERE state='active' AND superseded_at IS NULL
         AND source != 'autonomous:resolver-canary'
       ORDER BY accessed_at DESC LIMIT 20
    `).all();
    topActivations = rows.map(r => {
      const s = sa.getNodeState(r.id);
      return {
        id: r.id,
        node_id: r.id,                  // back-compat: main.js reads either name
        l0: r.l0,
        activation: s?.activation ?? 0,
        sa_channel: s?.sa_channel ?? 'mixed',
        zone: zones.getZoneOf(r.id),
      };
    }).sort((a, b) => b.activation - a.activation);
  } catch {}

  const zonesArr = zones.getCommunities().map((nodeIds, i) => ({ id: i, zone: i, size: nodeIds.length }));

  return {
    ok: true,
    tick: _tick,
    tick_count: _tick,                  // Python contract alias (Telegram /status)
    active_count: activeCount,
    active_nodes: activeCount,          // Python contract alias (Telegram /status)
    n_nodes: activeCount,               // dashboard sidebar contract
    n_zones: zonesArr.length,           // dashboard sidebar contract
    n_attractors: 0,                    // not implemented in OSS — surface explicit zero
    hopfield_energy: 0,                 // not implemented in OSS — surface explicit zero
    top_activations: topActivations,
    top_nodes: topActivations,          // Python contract alias (/pool fallback)
    zones: zonesArr,
    top_zones: zonesArr,                // Python contract alias (/pool fallback)
    backend: 'mimir-js',
    version: '0.1.0',
    db_ready: true,
    sa: sa.saStats(),
    leiden: zones.zoneStats(),
    rumination_enabled: (() => { try { return ruminationStatus().enabled; } catch { return null; } })(),
    novelty_gate_enabled: (() => { try { return hebbStatus().novelty_gate_enabled; } catch { return null; } })(),
  };
}
