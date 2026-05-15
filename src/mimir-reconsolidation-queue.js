// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Reconsolidation Queue — Wave 3 Phase 8 (v2 plan §4.4 corrected).
//
// When a self_act node is written, schedule async refresh of the L1 summary
// of its top-3 cosine neighbors (A-MEM neighbor reconsolidation). Default
// ON — kill switch via env MIMIR_RECONSOLIDATION=0. When OFF, enqueue() is a
// cheap no-op so callers don't need to env-check at the call site.
//
// Why a separate module: Curation extension only does edge-strengthen, not
// summary refresh (v3.1 §4.4 correction). This is the actual hook for
// "neighbor summaries reconsolidate after self_act writes".
//
// Strategy:
//   - In-memory queue with bounded size (drop oldest on overflow).
//   - Periodic drain (default 5 min). Each drain processes RECONSOLIDATION_BATCH
//     items, fetches top-K neighbors via vec0, marks any with stale L1
//     (older than RECONSOLIDATION_STALE_HOURS) for refresh.
//   - Refresh itself is delegated to a callback (refreshFn), so the LLM call
//     lives in the action-worker, not here. This module is pure scheduling.

// Default ON: drains every 5min, refreshes stale L1 of self_act neighbors via
// vec0 KNN. Pure scheduling — refresh callback owns the LLM call. Set
// MIMIR_RECONSOLIDATION=0 to disable.
const ENABLED = (process.env.MIMIR_RECONSOLIDATION ?? '1') !== '0'
              && (process.env.MIMIR_RECONSOLIDATION ?? '1') !== 'false';
const QUEUE_MAX            = 500;
const DRAIN_INTERVAL_MS    = 5 * 60_000;
const TOP_K_NEIGHBORS      = 3;
const STALE_HOURS          = 24;
const KNN_FETCH_LIMIT      = 25; // vec0 over-fetch then post-filter
const BATCH_SIZE           = 5;  // self_act sources processed per drain

export class MimirReconsolidationQueue {
  #engine;
  #refreshFn;
  #queue = [];
  #timer = null;
  #running = false;

  constructor({ engine, refreshFn = null } = {}) {
    if (!engine || !engine.db) throw new Error('MimirReconsolidationQueue: engine.db required');
    this.#engine = engine;
    this.#refreshFn = (typeof refreshFn === 'function') ? refreshFn : null;
  }

  // Cheap no-op when disabled — call from any self_act write site.
  enqueue(nodeId, ownerId = 'self') {
    if (!ENABLED) return;
    if (!nodeId || typeof nodeId !== 'string') return;
    if (this.#queue.length >= QUEUE_MAX) {
      this.#queue.shift(); // drop oldest
    }
    this.#queue.push({ nodeId, ownerId, ts: Date.now() });
  }

  start() {
    if (!ENABLED) return false;
    if (this.#timer) return true;
    this.#timer = setInterval(() => this.#drain().catch(() => {}), DRAIN_INTERVAL_MS);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
    return true;
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  size() { return this.#queue.length; }
  isEnabled() { return ENABLED; }

  async #drain() {
    if (this.#running) return;
    if (this.#queue.length === 0) return;
    this.#running = true;
    try {
      const batch = this.#queue.splice(0, BATCH_SIZE);
      for (const item of batch) {
        const stale = this.#findStaleNeighbors(item.nodeId, item.ownerId);
        for (const n of stale) {
          if (this.#refreshFn) {
            try {
              await this.#refreshFn({
                neighborId: n.id,
                sourceId:   item.nodeId,
                cosSim:     n.cosSim,
                ageHours:   n.ageHours,
              });
            } catch (e) {
              console.warn(`[Reconsolidation] refreshFn failed for ${n.id}: ${e.message}`);
            }
          } else {
            // No refresh callback wired — log only (observation mode).
            console.log(`[Reconsolidation] stale neighbor ${n.id} of ${item.nodeId} (cos=${n.cosSim?.toFixed(3)}, age=${n.ageHours}h)`);
          }
        }
      }
    } finally {
      this.#running = false;
    }
  }

  // Returns up to TOP_K_NEIGHBORS stale neighbor objects: { id, cosSim, ageHours }.
  #findStaleNeighbors(nodeId, ownerId) {
    try {
      // Lookup the source node's embedding rowid → blob.
      const rowidRow = this.#engine.db.prepare(
        'SELECT rowid FROM node_rowids WHERE node_id = ?'
      ).get(nodeId);
      if (!rowidRow) return [];
      const embRow = this.#engine.db.prepare(
        'SELECT embedding FROM node_embeddings WHERE id = ?'
      ).get(rowidRow.rowid);
      if (!embRow?.embedding) return [];

      // vec0 KNN — literal LIMIT (vec0 quirk; matches engine.cjs:962/2130 pattern).
      const vecRows = this.#engine.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ${KNN_FETCH_LIMIT}`
      ).all(embRow.embedding);
      if (vecRows.length === 0) return [];

      const rowidList = vecRows.map(r => r.id);
      const ph = rowidList.map(() => '?').join(',');
      const mapRows = this.#engine.db.prepare(
        `SELECT rowid, node_id FROM node_rowids WHERE rowid IN (${ph})`
      ).all(...rowidList);
      const rowidToNodeId = new Map(mapRows.map(m => [m.rowid, m.node_id]));

      // Filter: skip self, skip non-active, skip identity/permanent-slot, only owner_id match.
      const candidateIds = [];
      for (const v of vecRows) {
        const nid = rowidToNodeId.get(v.id);
        if (!nid || nid === nodeId) continue;
        candidateIds.push({ id: nid, distance: v.distance });
      }
      if (candidateIds.length === 0) return [];

      const phIds = candidateIds.map(() => '?').join(',');
      const safeOwner = String(ownerId || 'self').replace(/[^a-zA-Z0-9_:.-]/g, '');
      const nodeRows = this.#engine.db.prepare(
        `SELECT id, l1, node_type, accessed_at, updated_at, created_at, tags
         FROM nodes
         WHERE id IN (${phIds})
           AND state = 'active'
           AND (owner_id = '${safeOwner}' OR owner_id IS NULL)
           AND node_type NOT IN ('identity', 'milestone')`
      ).all(...candidateIds.map(c => c.id));
      const nodeById = new Map(nodeRows.map(r => [r.id, r]));

      const now = Date.now();
      const staleCutoffMs = now - STALE_HOURS * 3600_000;
      const out = [];
      for (const c of candidateIds) {
        const n = nodeById.get(c.id);
        if (!n) continue;
        // Skip permanent-slot tagged nodes (cheap CSV scan)
        const tagsCsv = String(n.tags || '');
        if (tagsCsv.includes('permanent-slot') || tagsCsv.includes('principle')) continue;
        const tsMs = Date.parse(n.updated_at || n.accessed_at || n.created_at) || now;
        if (tsMs > staleCutoffMs) continue; // fresh — skip
        const cosSim = 1 - (c.distance * c.distance) / 2;
        const ageHours = Number(((now - tsMs) / 3600_000).toFixed(1));
        out.push({ id: n.id, cosSim, ageHours });
        if (out.length >= TOP_K_NEIGHBORS) break;
      }
      return out;
    } catch (e) {
      console.warn(`[Reconsolidation] findStaleNeighbors error for ${nodeId}: ${e.message}`);
      return [];
    }
  }
}
