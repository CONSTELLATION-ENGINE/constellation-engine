// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Autonomy v4 — multi-source candidate pool builders.
//
// Plan: engine-output/architecture-research/2026-05-06-mimir-autonomy-v4-multipool-planning.md
// V5a perturbation layer (2026-05-08) wraps this substrate without renaming
// the v4 module/identifier surface — buildHotPool now applies a fire_count
// re-rank penalty (Phase 3) before truncation; the rest of the substrate is
// reused unchanged. v4 is the cross-arch contract name; "v5" lives in
// per-mechanism env knobs (MIMIR_V5_HOT_FIRE_PENALTY etc).
//
// Each pool returns a small ranked list of node candidates the picker LLM
// chooses from. v3 fed the picker a single SA-argmax top_node; v4 feeds the
// union of four pool tops, restoring the LLM-as-valve principle by giving the
// LLM a real menu (Hot / Cold / Bridge / Novel) instead of a pre-narrowed pick.
//
// Substrate this module relies on:
//   - sa.js              activation / activation_slow per-node from Multi-SA tick
//   - zones.js           Leiden communities (in-memory) — zone_id is also persisted
//                        on nodes.zone_id by zones.js after each refresh (Phase 0)
//   - nodes.fire_count   bumped by the diary trigger on fire_v3 inserts (Phase 0)
//   - engine_meta.autonomy_seeds JSON blob with `tags` array from setup wizard
//
// Each function is read-only and idempotent. They never write to nodes/diary.

import { getDb, getMeta } from './db.js';
import * as sa from './sa.js';
import * as zones from './zones.js';

const DEFAULT_K = 4;

// Bridge pool: keep "moderate activation" — not fully cold, not already-hot.
// Calibration is empirical (MD §8.5) — these are v4.0 starting values.
const BRIDGE_ACT_LO = 0.10;
const BRIDGE_ACT_HI = 0.50;

// Novel pool decay window: 7 days matches the action_distribution panel's 7d
// horizon — keeps the "anti-hyperfixation" signal visible against the same
// observability window the dashboard already shows.
const NOVEL_RECENCY_DAYS = 7.0;

// ─── helpers ─────────────────────────────────────────────────────────────

// V5b Phase 11.2 — owner / persona scoping helpers.
//
// OSS v1 is single-user by default (`owner_id` resolves to STAR_MAP_OWNER_ID_DEFAULT
// 'self' on engine.cjs). Pool callers may pass an explicit `ownerId` to opt
// into multi-user safety once a host wraps Mímir-JS for multi-tenant use.
// `null` / undefined → no clause (legacy single-user behavior preserved).
//
// `_personaSqlClause` matches the main-arch contract (engine.cjs:322):
//   strict     — persona_id = ? OR persona_id IS NULL  (NULL rows are shared
//                substrate; intentionally leak across all personas)
//   exclusive  — persona_id = ?  (per-persona partition; no NULL leakage)
// Returns `{ where, binds }`; callers concatenate `where` after their existing
// WHERE clauses (it always begins with `' AND '` when non-empty).
function _ownerSqlClause(ownerId, alias = null) {
  if (ownerId == null) return { where: '', binds: [] };
  const col = alias ? `${alias}.owner_id` : 'owner_id';
  return { where: ` AND ${col} = ?`, binds: [String(ownerId)] };
}

function _personaSqlClause(personaId, mode = 'strict', alias = null) {
  if (personaId == null) return { where: '', binds: [] };
  const col = alias ? `${alias}.persona_id` : 'persona_id';
  if (mode === 'exclusive') {
    return { where: ` AND ${col} = ?`, binds: [String(personaId)] };
  }
  // strict (default)
  return { where: ` AND (${col} = ? OR ${col} IS NULL)`, binds: [String(personaId)] };
}

function _parseJsonArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Pull the user's stated interest tags from the wizard's autonomy_seeds blob.
// Returns lowercase token array; empty when the user skipped the quiz or the
// blob hasn't been written yet. Cold pool tolerates [] by dropping the FTS
// filter (graceful degradation per MD §3.2).
function _readInterestTags() {
  const raw = getMeta('autonomy_seeds');
  if (!raw) return [];
  let blob;
  try { blob = JSON.parse(raw); } catch { return []; }
  const tags = Array.isArray(blob?.tags) ? blob.tags : [];
  return tags.map(t => String(t || '').toLowerCase().trim()).filter(Boolean);
}

// FTS5 reserves a small set of punctuation; quote each tag and column-filter
// each term independently, then OR-join. `tags:"x" OR "y"` would only column-
// scope the first term; correct form is `tags:"x" OR tags:"y"`.
function _ftsTagQuery(tags) {
  if (!tags.length) return null;
  const cleaned = tags
    .map(t => t.replace(/[^a-z0-9_-]/gi, ' ').trim())
    .filter(Boolean);
  if (!cleaned.length) return null;
  return cleaned.map(t => `tags:"${t}"`).join(' OR ');
}

function _ageDays(accessedAtIso) {
  if (!accessedAtIso) return null;
  const t = Date.parse(accessedAtIso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000.0;
}

// Per-node degree count, computed once and reused by Cold + Bridge pools.
// O(E) but only fires when at least one of those pools is requested.
// V5b Phase 11.2 — cache key includes ownerId so multi-user hosts don't share
// degree maps across tenants.
const _degreeCacheByOwner = new Map();
const DEGREE_CACHE_MS = 60_000;
function _degreeMap(ownerId = null) {
  const now = Date.now();
  const cacheKey = ownerId == null ? '__null__' : String(ownerId);
  const entry = _degreeCacheByOwner.get(cacheKey);
  if (entry && now - entry.cachedAt < DEGREE_CACHE_MS) return entry.map;
  const db = getDb();
  const owner = _ownerSqlClause(ownerId, null);
  const rows = db.prepare(`
    SELECT node_id, COUNT(*) AS degree FROM (
      SELECT source AS node_id FROM edges WHERE state='active'${owner.where}
      UNION ALL
      SELECT target AS node_id FROM edges WHERE state='active'${owner.where}
    ) GROUP BY node_id
  `).all(...owner.binds, ...owner.binds);
  const m = new Map();
  for (const r of rows) m.set(r.node_id, Number(r.degree) || 0);
  _degreeCacheByOwner.set(cacheKey, { map: m, cachedAt: now });
  return m;
}

function _shape(row, pool, extras = {}) {
  return {
    id: row.id,
    l0: row.l0 || '',
    pool,
    fire_count: Number(row.fire_count || 0),
    age_days: _ageDays(row.accessed_at),
    zone_id: row.zone_id == null ? null : Number(row.zone_id),
    edge_density: Number(extras.edge_density || row.degree || 0),
    activation: Number.isFinite(extras.activation) ? extras.activation : null,
  };
}

// ─── Hot pool ────────────────────────────────────────────────────────────
// Top-K by current SA activation. Mirrors v3's argmax pick but returns a
// list, not a singleton. No DB-side ranking — sa.js owns the activation
// vector; we look up node rows by id afterwards.
//
// V5a Phase 3 — fire_count penalty re-rank (default-ON; floor at fire_count
// > 3 so cold-start is untouched). Penalty: score = a / (1 + max(0, fc-3)/10).
// Kill-switch: MIMIR_V5_HOT_FIRE_PENALTY=0 reverts to pure activation order.
// Pulls more than K so the penalty re-rank has room before truncation.
export function buildHotPool({ K = DEFAULT_K, ownerId = null, personaId = null } = {}) {
  const saState = sa.ensureState();
  if (!saState || !saState.idx) return [];

  const acts = [];
  for (const [nid, idx] of saState.idx) {
    const a = saState.A_fast[idx];
    if (!Number.isFinite(a) || a <= 0) continue;
    acts.push([nid, a]);
  }
  if (acts.length === 0) return [];
  acts.sort((x, y) => y[1] - x[1]);
  const overFetch = Math.max(K * 4, K);
  const topPairs = acts.slice(0, overFetch);
  const topIds = topPairs.map(p => p[0]);
  if (topIds.length === 0) return [];

  const db = getDb();
  const placeholders = topIds.map(() => '?').join(',');
  const owner = _ownerSqlClause(ownerId, null);
  const persona = _personaSqlClause(personaId, 'strict', null);
  const rows = db.prepare(`
    SELECT id, l0, accessed_at, zone_id,
           COALESCE(fire_count, 0) AS fire_count
      FROM nodes
     WHERE state='active' AND superseded_at IS NULL
       AND id IN (${placeholders})${owner.where}${persona.where}
  `).all(...topIds, ...owner.binds, ...persona.binds);

  const byId = new Map(rows.map(r => [r.id, r]));
  const actMap = new Map(topPairs);

  let orderedIds = topIds;
  const firePenaltyOn = String(process.env.MIMIR_V5_HOT_FIRE_PENALTY || '1').trim() !== '0';
  if (firePenaltyOn) {
    const score = (nid) => {
      const a = actMap.get(nid) || 0;
      const r = byId.get(nid);
      if (!r) return a;
      const fc = Number(r.fire_count || 0);
      return a / (1.0 + Math.max(0, fc - 3) / 10.0);
    };
    orderedIds = topIds.slice().sort((a, b) => score(b) - score(a));
  }

  const out = [];
  for (const nid of orderedIds) {
    const r = byId.get(nid);
    if (!r) continue;
    out.push(_shape(r, 'hot', { activation: actMap.get(nid) }));
    if (out.length >= K) break;
  }
  return out;
}

// ─── Cold pool ───────────────────────────────────────────────────────────
// Interest-domain ∩ low fire_count ∩ sparse edges. Surfaces gaps inside the
// user's stated interests. Falls back to "low fire_count + sparse edges"
// without the FTS subquery when autonomy_seeds.tags is empty.
export function buildColdPool({
  K = DEFAULT_K,
  fireThreshold = 2,
  degreeThreshold = 5,
  ownerId = null,
  personaId = null,
} = {}) {
  // Env knobs override defaults so cold-pool tuning doesn't need a code change.
  // Defaults assume sparse user graphs (avg_degree ~5–15); on a denser
  // ecosystem you'd raise AUTONOMY_COLD_DEGREE_THRESHOLD to keep the cold pool
  // meaningfully under-connected. The LIMIT_FACTOR widening + ASC degree
  // ranking below works the same regardless of threshold, so 0% yield is
  // already prevented by the fallback fill.
  //   AUTONOMY_COLD_FIRE_THRESHOLD   (default 2)
  //   AUTONOMY_COLD_DEGREE_THRESHOLD (default 5) — soft cap, see below
  const _fEnv = Number(process.env.AUTONOMY_COLD_FIRE_THRESHOLD);
  if (Number.isFinite(_fEnv) && _fEnv >= 0) fireThreshold = Math.floor(_fEnv);
  const _dEnv = Number(process.env.AUTONOMY_COLD_DEGREE_THRESHOLD);
  if (Number.isFinite(_dEnv) && _dEnv >= 0) degreeThreshold = Math.floor(_dEnv);

  const db = getDb();
  const tags = _readInterestTags();
  const ftsQuery = _ftsTagQuery(tags);
  const degMap = _degreeMap(ownerId);
  const ownerN = _ownerSqlClause(ownerId, 'n');
  const personaN = _personaSqlClause(personaId, 'strict', 'n');
  const ownerBare = _ownerSqlClause(ownerId, null);
  const personaBare = _personaSqlClause(personaId, 'strict', null);

  // Wide pre-fetch window so the JS-side degree ranking has range. On dense
  // graphs (avg_degree >> degreeThreshold) a small window can return zero
  // sparse-degree candidates after filtering; widening + ranking fixes that.
  const LIMIT_FACTOR = 40;
  const sqlLimit = Math.max(K * LIMIT_FACTOR, 40);

  let rows;
  try {
    if (ftsQuery) {
      // FTS5 subquery — nodes_fts indexes (node_id, l2, tags). MATCH against
      // the tags column directly via the FTS column-filter syntax.
      rows = db.prepare(`
        SELECT n.id, n.l0, n.accessed_at, n.zone_id,
               COALESCE(n.fire_count, 0) AS fire_count
          FROM nodes n
         WHERE n.state='active' AND n.superseded_at IS NULL
           AND n.id IN (
             SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH ?
           )
           AND COALESCE(n.fire_count, 0) <= ?${ownerN.where}${personaN.where}
         ORDER BY n.fire_count ASC, n.accessed_at ASC
         LIMIT ?
      `).all(ftsQuery, fireThreshold, ...ownerN.binds, ...personaN.binds, sqlLimit);
    } else {
      rows = db.prepare(`
        SELECT id, l0, accessed_at, zone_id,
               COALESCE(fire_count, 0) AS fire_count
          FROM nodes
         WHERE state='active' AND superseded_at IS NULL
           AND COALESCE(fire_count, 0) <= ?${ownerBare.where}${personaBare.where}
         ORDER BY fire_count ASC, accessed_at ASC
         LIMIT ?
      `).all(fireThreshold, ...ownerBare.binds, ...personaBare.binds, sqlLimit);
    }
  } catch (e) {
    console.warn('[autonomy-pools cold] query failed:', e.message);
    return [];
  }

  if (!rows || rows.length === 0) return [];

  // Rank by ascending degree (true 'cold' = under-connected). degreeThreshold
  // is a soft cap — preferred for exclusion in pass 1, but if fewer than K
  // pass we fall through to pass 2 and fill from the lowest-degree remaining
  // so cold pool actually yields K when the substrate has any under-fired
  // nodes (avoids 0% yield on dense graphs).
  const scored = rows.map(r => ({ deg: degMap.get(r.id) || 0, r }));
  scored.sort((a, b) => {
    if (a.deg !== b.deg) return a.deg - b.deg;
    const af = Number(a.r.fire_count || 0), bf = Number(b.r.fire_count || 0);
    if (af !== bf) return af - bf;
    return String(a.r.accessed_at || '').localeCompare(String(b.r.accessed_at || ''));
  });

  const out = [];
  const seen = new Set();
  for (const { deg, r } of scored) {
    if (deg > degreeThreshold) continue;
    out.push(_shape(r, 'cold', { edge_density: deg }));
    seen.add(r.id);
    if (out.length >= K) break;
  }
  if (out.length < K) {
    for (const { deg, r } of scored) {
      if (seen.has(r.id)) continue;
      out.push(_shape(r, 'cold', { edge_density: deg }));
      seen.add(r.id);
      if (out.length >= K) break;
    }
  }
  return out;
}

// ─── Bridge pool ─────────────────────────────────────────────────────────
// Nodes whose neighbors span ≥2 zones, with moderate (not extreme) activation.
// Reads zone_id directly from nodes (persisted by zones.js Leiden writeback).
export function buildBridgePool({
  K = DEFAULT_K,
  actLo = BRIDGE_ACT_LO,
  actHi = BRIDGE_ACT_HI,
  multiZoneMin = 2,
  ownerId = null,
  personaId = null,
} = {}) {
  const db = getDb();
  const saState = sa.ensureState();
  if (!saState || !saState.idx) return [];

  const ownerN = _ownerSqlClause(ownerId, 'n');
  const personaN = _personaSqlClause(personaId, 'strict', 'n');

  let rows;
  try {
    rows = db.prepare(`
      SELECT n.id, n.l0, n.accessed_at, n.zone_id,
             COALESCE(n.fire_count, 0) AS fire_count,
             (SELECT COUNT(DISTINCT n2.zone_id)
                FROM edges e
                JOIN nodes n2 ON (n2.id = e.target AND e.source = n.id)
                              OR (n2.id = e.source AND e.target = n.id)
               WHERE e.state='active'
                 AND n2.zone_id IS NOT NULL
                 AND n2.zone_id != n.zone_id) AS neighbor_zones
        FROM nodes n
       WHERE n.state='active' AND n.superseded_at IS NULL
         AND n.zone_id IS NOT NULL${ownerN.where}${personaN.where}
       ORDER BY neighbor_zones DESC
       LIMIT ?
    `).all(...ownerN.binds, ...personaN.binds, K * 8);
  } catch (e) {
    console.warn('[autonomy-pools bridge] query failed:', e.message);
    return [];
  }

  // Filter by SA activation in [actLo, actHi] — rejects fully-cold and
  // already-hot nodes so the bridge pool genuinely surfaces "warming" links.
  const out = [];
  for (const r of rows) {
    if ((r.neighbor_zones || 0) < multiZoneMin) continue;
    const idx = saState.idx.get(r.id);
    if (idx == null) continue;
    const act = saState.A_fast[idx];
    if (!Number.isFinite(act) || act < actLo || act > actHi) continue;
    out.push(_shape(r, 'bridge', { activation: act, edge_density: r.neighbor_zones }));
    if (out.length >= K) break;
  }
  return out;
}

// ─── Novel pool ──────────────────────────────────────────────────────────
// Anti-hyperfixation primary defense: fire_count × recency, ascending. Even
// if hot/cold/bridge converge on one cluster, novel guarantees diversity.
//
// Recency weight uses julianday(accessed_at) which is ISO-8601 friendly. The
// fire_count term is +1-shifted so a never-fired node still scores >0 (it
// gets `1 × recency_weight`, ranking purely by how stale it is).
export function buildNovelPool({
  K = DEFAULT_K,
  recencyDays = NOVEL_RECENCY_DAYS,
  ownerId = null,
  personaId = null,
} = {}) {
  const db = getDb();
  const owner = _ownerSqlClause(ownerId, null);
  const persona = _personaSqlClause(personaId, 'strict', null);
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, l0, accessed_at, zone_id,
             COALESCE(fire_count, 0) AS fire_count,
             EXP(-(CAST(julianday('now') - julianday(accessed_at) AS FLOAT) / ?)) AS recency
        FROM nodes
       WHERE state='active' AND superseded_at IS NULL
         AND accessed_at IS NOT NULL${owner.where}${persona.where}
       ORDER BY (COALESCE(fire_count, 0) + 1) * recency ASC
       LIMIT ?
    `).all(recencyDays, ...owner.binds, ...persona.binds, K);
  } catch (e) {
    console.warn('[autonomy-pools novel] query failed:', e.message);
    return [];
  }
  return rows.map(r => _shape(r, 'novel'));
}

// ─── Combined builder ────────────────────────────────────────────────────
// Build all four pools per the supplied weights (= per-pool candidate counts,
// per MD §8.2 decision (i): slider value is literal count). Dedup by id with
// "first pool wins" — pool order chosen so the highest-priority signal labels
// the candidate (hot > cold > bridge > novel; matches MD §8.6 (a)).
export function buildAllPools({
  weights = { hot: 4, cold: 4, bridge: 4, novel: 4 },
  ownerId = null,
  personaId = null,
} = {}) {
  const w = {
    hot: Math.max(0, Math.floor(weights.hot ?? 0)),
    cold: Math.max(0, Math.floor(weights.cold ?? 0)),
    bridge: Math.max(0, Math.floor(weights.bridge ?? 0)),
    novel: Math.max(0, Math.floor(weights.novel ?? 0)),
  };

  const hot = w.hot ? buildHotPool({ K: w.hot, ownerId, personaId }) : [];
  const cold = w.cold ? buildColdPool({ K: w.cold, ownerId, personaId }) : [];
  const bridge = w.bridge ? buildBridgePool({ K: w.bridge, ownerId, personaId }) : [];
  const novel = w.novel ? buildNovelPool({ K: w.novel, ownerId, personaId }) : [];

  const seen = new Set();
  const merged = [];
  for (const list of [hot, cold, bridge, novel]) {
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
  }
  return {
    candidates: merged,
    by_pool: { hot: hot.length, cold: cold.length, bridge: bridge.length, novel: novel.length },
    weights: w,
  };
}

// ─── Phase 2: multi-gate cold-start state machine ─────────────────────────
//
// Per Plan §4.2, the v4 autonomy phase is determined by FOUR gates evaluated
// against substrate that the engine already exposes. All four must be true to
// stay in `cold-start`. Any one false transitions to `warm-up`. After all
// four are false plus a 7d-elapsed and fire_history > 100 sanity floor, we
// graduate to `steady`.
//
// The 4th gate (imported_node_ratio) breaks the migration-user deadlock: a
// user importing 4000 nodes from main arch instantly clears `< 0.5` and
// enters warm-up, even though their fresh-engine relationship hasn't built
// turns or fires yet.
//
// This is INDEPENDENT from engine.cjs `_coldStartGateState()` which routes
// the OSS bootstrap dispatcher (different concern: question-prompt seeding
// vs. pool weight selection). We do not collapse them — both run in parallel.

const COLD_START_GATES = {
  user_turn_count: 50,
  fire_history: 30,
  days_since_first_run: 7,
  imported_node_ratio: 0.5,
};

const STEADY_THRESHOLD_FIRES = 100;
const STEADY_MIN_DAYS = 7;

const PRESET_WEIGHTS = {
  'cold-start': { hot: 4, cold: 6, bridge: 1, novel: 3 },
  'warm-up':    { hot: 3, cold: 3, bridge: 2, novel: 2 },
  'steady':     { hot: 5, cold: 2, bridge: 2, novel: 1 },
};

export function getPresetWeights(phase) {
  return { ...(PRESET_WEIGHTS[phase] || PRESET_WEIGHTS['warm-up']) };
}

// Read the four gate inputs in one place — no side effects, all best-effort.
// Missing tables (e.g. no diary_entries yet) treat the count as 0, which
// keeps that gate "true" (still cold). This matches the spirit of the gate:
// absence of data = absence of warmth.
export function readGateInputs({ ownerId = null } = {}) {
  const db = getDb();
  const owner = _ownerSqlClause(ownerId, null);

  let userTurnCount = 0;
  try {
    // topic_segments lives in conversations.db (different file). The current
    // OSS plumbing reads it from the same handle only when conversations.db
    // is ATTACH'd. Owner filter is best-effort; absent owner_id column → skip.
    const r = db.prepare(`
      SELECT COALESCE(SUM(msg_count), 0) AS n FROM topic_segments WHERE 1=1${owner.where}
    `).get(...owner.binds);
    userTurnCount = Number(r?.n || 0);
  } catch {
    try {
      const r = db.prepare("SELECT COALESCE(SUM(msg_count), 0) AS n FROM topic_segments").get();
      userTurnCount = Number(r?.n || 0);
    } catch { /* topic_segments not seeded yet → 0 */ }
  }

  let fireHistory = 0;
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS n FROM diary_entries WHERE kind = 'fire_v3'${owner.where}
    `).get(...owner.binds);
    fireHistory = Number(r?.n || 0);
  } catch {
    try {
      const r = db.prepare("SELECT COUNT(*) AS n FROM diary_entries WHERE kind = 'fire_v3'").get();
      fireHistory = Number(r?.n || 0);
    } catch { /* diary not initialized → 0 */ }
  }

  let daysSinceFirstRun = 0;
  try {
    const raw = getMeta('first_run_at');
    if (raw) {
      const ms = parseInt(raw, 10);
      if (Number.isFinite(ms) && ms > 0) {
        daysSinceFirstRun = (Date.now() - ms) / 86400000.0;
      }
    }
  } catch {}

  let importedNodeRatio = 0;
  try {
    const r = db.prepare(`
      SELECT CAST(SUM(CASE WHEN imported_batch_id IS NOT NULL THEN 1 ELSE 0 END) AS FLOAT)
             / NULLIF(COUNT(*), 0) AS r
        FROM nodes WHERE state = 'active'${owner.where}
    `).get(...owner.binds);
    importedNodeRatio = Number(r?.r || 0);
  } catch {}

  return { userTurnCount, fireHistory, daysSinceFirstRun, importedNodeRatio };
}

// Compute the v4 phase from gate inputs. Pure function — no I/O, no logging;
// callers who want telemetry should record the transition themselves.
export function computePhase(inputs) {
  const g = COLD_START_GATES;
  const {
    userTurnCount = 0,
    fireHistory = 0,
    daysSinceFirstRun = 0,
    importedNodeRatio = 0,
  } = inputs || {};

  const gates = {
    user_turn_count: userTurnCount < g.user_turn_count,
    fire_history: fireHistory < g.fire_history,
    days_since_first_run: daysSinceFirstRun < g.days_since_first_run,
    imported_node_ratio: importedNodeRatio < g.imported_node_ratio,
  };
  const allCold = Object.values(gates).every(Boolean);
  const allWarm = Object.values(gates).every(v => !v);

  let phase;
  if (allCold) {
    phase = 'cold-start';
  } else if (allWarm && daysSinceFirstRun >= STEADY_MIN_DAYS && fireHistory >= STEADY_THRESHOLD_FIRES) {
    phase = 'steady';
  } else {
    phase = 'warm-up';
  }
  return { phase, gates, inputs: { userTurnCount, fireHistory, daysSinceFirstRun, importedNodeRatio } };
}

// Convenience: read gates + compute phase in one call.
export function getAutonomyPhase({ ownerId = null } = {}) {
  return computePhase(readGateInputs({ ownerId }));
}
