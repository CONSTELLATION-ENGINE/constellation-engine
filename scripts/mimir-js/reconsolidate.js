// SPDX-License-Identifier: AGPL-3.0-or-later
// Reconsolidation sweep: when new knowledge enters, find semantically similar
// nodes and classify each as PROTECTED / UPDATED / SUPERSEDED / CONSISTENT.
// Identity / principle / milestone / diary nodes are immutable firewalls.
//
// v1 minimal port: similarity-driven classification only (no LLM call).
// Engine cron / writer pass invokes this after creating a node so the topology
// stays coherent.
//
// Kill-switch: MIMIR_RECONSOLIDATE=0 disables the sweep.

import { getDb } from './db.js';
import { embed, EMBED_DIM, toBlob } from './embed.js';

const KILL = String(process.env.MIMIR_RECONSOLIDATE || '').trim() === '0';

const SIMILARITY_THRESHOLD = 0.55;
const SUPERSEDE_THRESHOLD  = 0.85;
const KNN_LIMIT            = 30;

const IMMUTABLE_TYPES = new Set([
  'identity', 'principle', 'milestone', 'diary',
  'relationship', 'experiment',
]);

function _isImmutable(nodeType, tags) {
  if (IMMUTABLE_TYPES.has(String(nodeType || '').toLowerCase())) return true;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const lt = String(t || '').toLowerCase();
      if (lt === 'immutable' || lt === 'load-bearing' || lt === 'pinned') return true;
    }
  }
  return false;
}

function _parseTags(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// L2 distance to cosine similarity for normalized vectors:
// L2^2 = 2 - 2*cos(theta) -> cos(theta) = 1 - L2^2/2
function _distanceToCosine(d) {
  const x = 1 - (d * d) / 2;
  return Math.max(-1, Math.min(1, x));
}

export async function reconsolidate({
  newText,
  newNodeId = null,
  similarityThreshold = SIMILARITY_THRESHOLD,
  dryRun = false,
} = {}) {
  if (KILL) return { ok: false, killed: true, swept: 0 };
  if (!newText || typeof newText !== 'string') {
    throw new Error('reconsolidate requires newText');
  }
  const db = getDb();
  const [qv] = await embed([newText.slice(0, 4000)]);

  let candidates = [];
  try {
    const rows = db.prepare(`
      SELECT n.id AS node_id, n.l0, n.l1, n.l2, n.node_type, n.tags, n.weight,
             distance
        FROM node_embeddings
        JOIN node_rowids r ON r.rowid = node_embeddings.rowid
        JOIN nodes n ON n.id = r.node_id
       WHERE node_embeddings.embedding MATCH ?
         AND k = ?
         AND n.state = 'active' AND n.superseded_at IS NULL
       ORDER BY distance ASC
    `).all(toBlob(qv), KNN_LIMIT);
    for (const r of rows) {
      if (newNodeId && r.node_id === newNodeId) continue;
      const sim = _distanceToCosine(r.distance);
      if (sim < similarityThreshold) continue;
      candidates.push({ ...r, similarity: sim });
    }
  } catch (e) {
    return {
      ok: false,
      error: `vec0 unavailable: ${e.message}`,
      swept: 0, candidates_found: 0,
    };
  }

  if (candidates.length === 0) {
    return { ok: true, swept: 0, candidates_found: 0,
      protected: [], updated: [], superseded: [], consistent: [] };
  }

  const result = { protected: [], updated: [], superseded: [], consistent: [] };
  const now = Math.floor(Date.now() / 1000);

  const txn = db.transaction(() => {
    for (const c of candidates) {
      const tags = _parseTags(c.tags);
      const immutable = _isImmutable(c.node_type, tags);
      const sim = c.similarity;

      if (immutable) {
        result.protected.push({ node_id: c.node_id, similarity: sim });
        continue;
      }
      if (sim >= SUPERSEDE_THRESHOLD) {
        // Near-duplicate: mark superseded by new node when newNodeId provided.
        if (!dryRun && newNodeId) {
          try {
            db.prepare(`
              UPDATE nodes
                 SET superseded_at = ?, superseded_by = ?
               WHERE id = ?
            `).run(now, newNodeId, c.node_id);
          } catch {}
        }
        result.superseded.push({ node_id: c.node_id, similarity: sim });
        continue;
      }
      if (sim >= 0.65) {
        // Update note: append a short reconsolidation marker to L2 so future
        // reads see the reinforcement signal.
        if (!dryRun) {
          try {
            const note = `[reconsolidated ${new Date(now * 1000).toISOString().slice(0,10)}]`;
            db.prepare(`
              UPDATE nodes
                 SET l2 = COALESCE(l2, '') || ?, accessed_at = ?
               WHERE id = ? AND (l2 IS NULL OR INSTR(COALESCE(l2,''), ?) = 0)
            `).run('\n' + note, now, c.node_id, note);
          } catch {}
        }
        result.updated.push({ node_id: c.node_id, similarity: sim });
        continue;
      }
      result.consistent.push({ node_id: c.node_id, similarity: sim });
    }
  });

  try { txn(); } catch (e) { return { ok: false, error: e.message }; }

  return {
    ok: true,
    swept: candidates.length,
    candidates_found: candidates.length,
    ...result,
    dry_run: dryRun,
  };
}

let _lastBatchTs = 0;
let _lastBatchSummary = null;

// Batch sweep: walk recent nodes and call reconsolidate(newText) for each, so
// engine cron can run "sweep last 24h" without naming each node.
export async function reconsolidateBatch({
  limit = 50,
  hoursBack = 24,
  dryRun = false,
} = {}) {
  if (KILL) return { ok: false, killed: true, swept: 0 };
  let rows = [];
  try {
    const cutoff = Math.floor(Date.now() / 1000) - hoursBack * 3600;
    rows = getDb().prepare(`
      SELECT id, l0, l1, l2, node_type
        FROM nodes
       WHERE state = 'active' AND superseded_at IS NULL
         AND COALESCE(created_at, 0) >= ?
       ORDER BY created_at DESC LIMIT ?
    `).all(cutoff, Math.max(1, Math.min(500, limit | 0)));
  } catch (e) {
    return { ok: false, error: e.message, swept: 0 };
  }
  if (rows.length === 0) {
    _lastBatchTs = Date.now();
    _lastBatchSummary = { protected: 0, updated: 0, superseded: 0, consistent: 0, candidates: 0 };
    return { ok: true, scanned: 0, ..._lastBatchSummary };
  }
  const totals = { protected: 0, updated: 0, superseded: 0, consistent: 0, candidates: 0 };
  for (const r of rows) {
    const text = [r.l0, r.l1, r.l2].filter(Boolean).join(' | ').slice(0, 4000);
    if (!text) continue;
    try {
      const out = await reconsolidate({ newText: text, newNodeId: r.id, dryRun });
      if (out && out.ok) {
        totals.protected   += out.protected?.length   || 0;
        totals.updated     += out.updated?.length     || 0;
        totals.superseded  += out.superseded?.length  || 0;
        totals.consistent  += out.consistent?.length  || 0;
        totals.candidates  += out.candidates_found    || 0;
      }
    } catch { /* per-node failure shouldn't kill the sweep */ }
  }
  _lastBatchTs = Date.now();
  _lastBatchSummary = { ...totals };
  return { ok: true, scanned: rows.length, ...totals, dry_run: dryRun };
}

export function reconsolidationStatus() {
  return {
    enabled: !KILL,
    last_run: _lastBatchTs ? new Date(_lastBatchTs).toISOString() : null,
    last_summary: _lastBatchSummary,
  };
}
