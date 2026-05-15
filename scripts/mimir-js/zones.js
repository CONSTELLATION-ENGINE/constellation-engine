// SPDX-License-Identifier: AGPL-3.0-or-later
// Leiden community detection over the active star map. Mirrors the Python
// daemon's _detect_zones (mimir_daemon.py:2547+): builds an undirected graph
// from positive-weight edges and runs Leiden modularity optimization.
//
// Refreshed lazily — on first call, then every ZONE_REFRESH_MS afterwards.
// Engine and pool.js call getZoneOf(nodeId) which is O(1).

import { leiden, Graph } from '@graphty/algorithms';
import { getDb } from './db.js';

const ZONE_REFRESH_MS = 60 * 60 * 1000;     // 1 hour, like Python ZONE_REFRESH_S=3600
const ZONE_RETRY_MS = 10 * 60 * 1000;       // after a failed run, retry sooner
const ZONE_TIMEOUT_MS = 30 * 1000;          // bail if Leiden hangs (large graphs)

let _zoneOf = new Map();      // node_id -> zone_id
let _bridgeOf = new Map();    // node_id -> cross-zone edge ratio (0..1)
let _communities = [];        // zone_id -> [node_ids]
let _lastRefresh = 0;
let _refreshing = false;

function _nowMs() { return Date.now(); }

// Build edge list once; @graphty/algorithms wants {nodes, edges} adjacency.
function _buildGraph() {
  const db = getDb();
  const edges = db.prepare(`
    SELECT source AS s, target AS t, COALESCE(strength, 0.5) AS w, edge_type AS et
      FROM edges
     WHERE state = 'active'
       AND COALESCE(strength, 0.5) > 0.05
  `).all();

  const nodeSet = new Set();
  const adjList = [];
  for (const e of edges) {
    if (!e.s || !e.t || e.s === e.t) continue;
    // contradicts/inhibits are negative-influence edges in SA; for clustering
    // we only want positive structure (Python behavior at line 2562).
    if (e.et === 'contradicts' || e.et === 'inhibits') continue;
    nodeSet.add(e.s);
    nodeSet.add(e.t);
    adjList.push({ source: e.s, target: e.t, weight: e.w });
  }
  const nodes = [...nodeSet].map(id => ({ id }));
  return { nodes, edges: adjList };
}

async function _runLeiden() {
  if (_refreshing) return;
  _refreshing = true;
  try {
    const graph = _buildGraph();
    if (graph.nodes.length < 4) {
      _zoneOf = new Map();
      _bridgeOf = new Map();
      _communities = [];
      _lastRefresh = _nowMs();
      return;
    }

    // Build a real Graph object (undirected). The lib's leiden() consumes
    // this directly — no adapter needed.
    const G = new Graph({ directed: false });
    for (const n of graph.nodes) G.addNode(n.id);
    // Coalesce duplicate edges (each undirected edge added once).
    const seen = new Set();
    for (const e of graph.edges) {
      const a = e.source < e.target ? e.source : e.target;
      const b = e.source < e.target ? e.target : e.source;
      const k = `${a}\u0000${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      G.addEdge(e.source, e.target, e.weight);
    }

    let result;
    const started = _nowMs();
    try {
      result = await Promise.race([
        Promise.resolve(leiden(G, { resolution: 1.0, randomSeed: 42 })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('leiden timeout')), ZONE_TIMEOUT_MS)),
      ]);
    } catch (e) {
      console.warn(`[mimir-js zones] leiden failed (${e.message}) — fallback to flat zone 0, will retry sooner`);
      _zoneOf = new Map();
      _bridgeOf = new Map();
      for (const n of graph.nodes) { _zoneOf.set(n.id, 0); _bridgeOf.set(n.id, 0); }
      _communities = [graph.nodes.map(n => n.id)];
      // Set _lastRefresh into the past so retry fires after ZONE_RETRY_MS
      // (10min) instead of 1h, so a transient failure doesn't trap us.
      _lastRefresh = _nowMs() - (ZONE_REFRESH_MS - ZONE_RETRY_MS);
      return;
    }

    // result is { communities: Map<nodeId, communityId> } per @graphty docs
    const newZoneOf = new Map();
    const newComms = new Map();
    let zoneIdx = 0;
    const remap = new Map();
    const communityMap = result.communities || result;
    if (communityMap instanceof Map) {
      for (const [nodeId, cid] of communityMap) {
        if (!remap.has(cid)) {
          remap.set(cid, zoneIdx);
          newComms.set(zoneIdx, []);
          zoneIdx += 1;
        }
        const z = remap.get(cid);
        newZoneOf.set(nodeId, z);
        newComms.get(z).push(nodeId);
      }
    } else if (Array.isArray(result)) {
      // fallback shape: [{nodes: [...], id: x}, ...]
      for (const c of result) {
        const z = zoneIdx++;
        newComms.set(z, c.nodes || []);
        for (const n of (c.nodes || [])) newZoneOf.set(n, z);
      }
    }

    _zoneOf = newZoneOf;
    _communities = [...newComms.values()];

    // Mímir v4 Phase 0: persist zone_id back to nodes so cold/bridge/novel
    // pool queries can filter on the column directly instead of round-tripping
    // through getZoneOf(). Clear-then-set inside one transaction so isolates
    // (nodes not in any active edge this round) end up with zone_id = NULL.
    // Pre-v4 schema (no nodes.zone_id column) is tolerated silently.
    try {
      const db2 = getDb();
      const persist = db2.transaction((entries) => {
        db2.prepare("UPDATE nodes SET zone_id = NULL WHERE zone_id IS NOT NULL").run();
        const upd = db2.prepare("UPDATE nodes SET zone_id = ? WHERE id = ?");
        for (const [id, z] of entries) upd.run(z, id);
      });
      persist(newZoneOf);
    } catch (e) {
      console.warn('[mimir-js zones] zone_id writeback skipped:', e.message);
    }

    // Bridge ratio: per-node fraction of edges that cross zone boundaries.
    // Used by pool scoring (POOL_W_BRIDGE · bridge boosts cross-cluster nodes).
    const bridgeOf = new Map();
    const adjLocal = new Map();
    for (const n of graph.nodes) adjLocal.set(n.id, []);
    for (const e of graph.edges) {
      adjLocal.get(e.source).push(e.target);
      adjLocal.get(e.target).push(e.source);
    }
    for (const [id, neigh] of adjLocal) {
      if (!neigh.length) { bridgeOf.set(id, 0); continue; }
      const z = newZoneOf.get(id);
      let cross = 0;
      for (const nb of neigh) if (newZoneOf.get(nb) !== z) cross += 1;
      bridgeOf.set(id, cross / neigh.length);
    }
    _bridgeOf = bridgeOf;

    _lastRefresh = _nowMs();
    const elapsed = _nowMs() - started;
    console.log(`[mimir-js zones] leiden done in ${elapsed}ms — ${graph.nodes.length} nodes, ${zoneIdx} zones`);
  } finally {
    _refreshing = false;
  }
}

// Public API ────────────────────────────────────────────────────────────────

// Returns immediately with cached zone_id; triggers async refresh if stale.
export function getZoneOf(nodeId) {
  const now = _nowMs();
  if (now - _lastRefresh > ZONE_REFRESH_MS && !_refreshing) {
    _runLeiden().catch(e => console.warn('[mimir-js zones] refresh err:', e.message));
  }
  return _zoneOf.get(nodeId) ?? 0;
}

export function getBridgeOf(nodeId) { return _bridgeOf.get(nodeId) ?? 0; }

export function getCommunities() { return _communities; }

export async function ensureZones() {
  if (_lastRefresh === 0) await _runLeiden();
}

export function zoneStats() {
  return {
    zone_count: _communities.length,
    node_count: _zoneOf.size,
    last_refresh_ms: _lastRefresh,
    age_ms: _lastRefresh ? _nowMs() - _lastRefresh : null,
  };
}
