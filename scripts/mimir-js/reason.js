// SPDX-License-Identifier: AGPL-3.0-or-later
// BFS-style reasoning paths over the active edge graph.
// Mirrors mimir_daemon.py /reason/paths, /reason/abduction, /reason/deduction.
// Engine reads compiled_text + unique_paths + compiled_paragraphs + anchors[].

import { getDb } from './db.js';
import { embed, toBlob } from './embed.js';

// Edge types we expand through, with directional preference. Negative-influence
// edges (contradicts/inhibits) get expanded for analogy/abduction but skipped
// for deduction.
const FORWARD_EDGES = new Set([
  'supports', 'causes', 'causal', 'extends', 'enables', 'triggers',
  'depends_on', 'contains', 'builds_on', 'synthesizes',
  'parallels', 'inspires', 'exemplifies', 'complements',
  'associative', 'temporal', 'contextualizes', 'hierarchical',
  'relates_to', 'collision', 'coactivation',
]);
const NEGATIVE_EDGES = new Set(['contradicts', 'challenges', 'contrasts', 'contrastive']);

function _anchorIdsFromQuery(query, k = 3) {
  const db = getDb();
  // Try vec0 KNN first (real semantic anchor); fall back to text LIKE
  return embed([query]).then(([qv]) => {
    try {
      const rows = db.prepare(`
        SELECT n.id, n.l0, distance
          FROM node_embeddings
          JOIN node_rowids r ON r.rowid = node_embeddings.rowid
          JOIN nodes n ON n.id = r.node_id
         WHERE node_embeddings.embedding MATCH ?
           AND k = ?
           AND n.state='active' AND n.superseded_at IS NULL
         ORDER BY distance ASC
      `).all(toBlob(qv), k);
      return rows;
    } catch {
      const stripped = query.slice(0, 40).replace(/[%_\\]/g, '').trim();
      const like = `%${stripped}%`;
      let rows = stripped.length === 0 ? [] : db.prepare(`
        SELECT id, l0, 0 AS distance FROM nodes
         WHERE state='active' AND superseded_at IS NULL
           AND (l0 LIKE ? OR l1 LIKE ?)
         ORDER BY accessed_at DESC LIMIT ?
      `).all(like, like, k);
      // Last-resort: most-recently-touched active nodes so reasoning still
      // has a starting point during cold-start (vec0 not loaded yet).
      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT id, l0, 0 AS distance FROM nodes
           WHERE state='active' AND superseded_at IS NULL
           ORDER BY accessed_at DESC LIMIT ?
        `).all(k);
      }
      return rows;
    }
  });
}

// Build adjacency once per call (small enough at OSS scale).
function _adjacency(maxNodes = 4000) {
  const db = getDb();
  const edges = db.prepare(`
    SELECT source, target, edge_type, COALESCE(strength, 0.5) AS strength
      FROM edges
     WHERE state='active'
       AND COALESCE(strength, 0.5) > 0.05
  `).all();
  const fwd = new Map();      // src -> [{target, edge_type, strength}, ...]
  for (const e of edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    fwd.get(e.source).push({ target: e.target, edge_type: e.edge_type, strength: e.strength });
    // Also add reverse for undirected expansion (BFS treats edges symmetric)
    if (!fwd.has(e.target)) fwd.set(e.target, []);
    fwd.get(e.target).push({ target: e.source, edge_type: e.edge_type, strength: e.strength });
  }
  return fwd;
}

function _nodeLabels(nodeIds) {
  if (nodeIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, l0 FROM nodes WHERE id IN (${placeholders})`).all(...nodeIds);
  return new Map(rows.map(r => [r.id, r.l0 || r.id]));
}

// Multi-source BFS, returns top `maxPaths` paths by score.
// A "path" is [node1] -e1-> [node2] -e2-> [node3] ...
//
// Each frontier item carries its own `visited` Set so that two anchors
// (multi-source abduction/analogy) can independently traverse the same
// node without one anchor's BFS shadowing another's alternative paths.
function _bfs(adj, startIds, { maxHops = 5, maxPaths = 3, edgeFilter = FORWARD_EDGES } = {}) {
  // Frontier item: { path: [{nodeId, edgeIn?}], score, visited: Set<nodeId> }
  let frontier = startIds.map(id => ({
    path: [{ nodeId: id, edgeIn: null }],
    score: 0,
    visited: new Set([id]),
  }));
  const completed = [];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next = [];
    for (const item of frontier) {
      const tip = item.path[item.path.length - 1].nodeId;
      const neigh = adj.get(tip) || [];
      let expanded = 0;
      for (const e of neigh) {
        if (item.visited.has(e.target)) continue;             // no cycles within this path
        if (!edgeFilter.has(e.edge_type)) continue;
        const newVisited = new Set(item.visited);
        newVisited.add(e.target);
        const newPath = [...item.path, { nodeId: e.target, edgeIn: e.edge_type, strength: e.strength }];
        const newScore = item.score + e.strength - 0.1;       // depth penalty
        next.push({ path: newPath, score: newScore, visited: newVisited });
        expanded += 1;
        if (expanded >= 4) break;                             // cap fanout per node
      }
      if (item.path.length >= 2) completed.push(item);        // also keep partial
    }
    // Trim frontier to top 16 by score to bound work
    next.sort((a, b) => b.score - a.score);
    frontier = next.slice(0, 16);
  }
  // Add final frontier paths
  for (const item of frontier) if (item.path.length >= 2) completed.push(item);
  completed.sort((a, b) => b.score - a.score);
  return completed.slice(0, maxPaths);
}

function _renderPath(path, labels) {
  const parts = [];
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const label = labels.get(seg.nodeId) || seg.nodeId;
    if (i > 0) parts.push(`—${seg.edgeIn}→`);
    parts.push(label);
  }
  return parts.join(' ');
}

// Public ─────────────────────────────────────────────────────────────────────

export async function reasonPaths({ message = '', max_hops = 5, max_paths = 3 } = {}) {
  if (!message) {
    return {
      ok: false, error: 'empty message',
      compiled_text: '', paths: [], anchors: [],
      total_paths_found: 0, unique_paths: 0, compiled_paragraphs: 0,
    };
  }
  let anchors;
  try { anchors = await _anchorIdsFromQuery(message, 3); }
  catch (e) {
    return {
      ok: false, error: e.message,
      compiled_text: '', paths: [], anchors: [],
      total_paths_found: 0, unique_paths: 0, compiled_paragraphs: 0,
    };
  }
  if (anchors.length === 0) {
    return {
      ok: true, compiled_text: '', paths: [], anchors: [],
      total_paths_found: 0, unique_paths: 0, compiled_paragraphs: 0,
    };
  }

  const adj = _adjacency();
  const startIds = anchors.map(a => a.id);
  // Python clamps max_hops≤7, max_paths≤5 — mirror that here.
  const allFound = _bfs(adj, startIds, {
    maxHops: Math.min(7, max_hops),
    maxPaths: 20,
  });
  const uniquePaths = allFound.slice(0, Math.min(5, max_paths));

  // Collect labels for all nodes touched
  const allIds = new Set();
  for (const p of uniquePaths) for (const seg of p.path) allIds.add(seg.nodeId);
  for (const a of anchors) allIds.add(a.id);
  const labels = _nodeLabels([...allIds]);

  const renderedSegs = uniquePaths.map(p => _renderPath(p.path, labels));
  const compiled_text = renderedSegs.length
    ? `Reasoning paths:\n${renderedSegs.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
    : '';
  return {
    ok: true,
    compiled_text,
    paths: uniquePaths.map(p => ({
      nodes: p.path.map(s => s.nodeId),
      edge_types: p.path.slice(1).map(s => s.edgeIn),
      hops: Math.max(0, p.path.length - 1),
      score: Math.round(p.score * 1000) / 1000,
      strategy: 'bfs',
    })),
    anchors: anchors.slice(0, 5).map(a => ({ id: a.id, l0: a.l0 })),
    total_paths_found: allFound.length,
    unique_paths: uniquePaths.length,
    compiled_paragraphs: renderedSegs.length,
  };
}

export async function reasonAbduction({ conclusion_id }) {
  if (!conclusion_id) return { ok: false, explanations: [] };
  const adj = _adjacency();
  // Reverse-only BFS: find nodes that "support" or "cause" or "enable" the conclusion.
  // We just expand backward over FORWARD_EDGES (undirected adj already includes both).
  const paths = _bfs(adj, [conclusion_id], { maxHops: 4, maxPaths: 8 });
  const explanations = [];
  for (const p of paths) {
    const tip = p.path[p.path.length - 1];
    explanations.push({ node_id: tip.nodeId, score: p.score, depth: p.path.length - 1 });
  }
  return { ok: true, explanations };
}

export async function reasonDeduction({ premises = [] } = {}) {
  if (!Array.isArray(premises) || premises.length === 0) return { ok: false, paths: [], n_paths: 0 };
  const adj = _adjacency();
  const paths = _bfs(adj, premises, { maxHops: 4, maxPaths: 5 });
  const labels = _nodeLabels([...new Set(paths.flatMap(p => p.path.map(s => s.nodeId)))]);
  return {
    ok: true,
    paths: paths.map(p => ({
      path_labels: p.path.map(s => labels.get(s.nodeId) || s.nodeId),
      strength: p.score,
    })),
    n_paths: paths.length,
  };
}

export async function reasonAnalogy({ node_a, node_b }) {
  if (!node_a || !node_b) return { ok: false };
  const db = getDb();
  // Topological similarity = Jaccard of neighbor sets (cheap proxy).
  const ne = (id) => db.prepare(`
    SELECT target AS n FROM edges WHERE source=? AND state='active'
    UNION SELECT source AS n FROM edges WHERE target=? AND state='active'
  `).all(id, id).map(r => r.n);
  const A = new Set(ne(node_a));
  const B = new Set(ne(node_b));
  if (A.size === 0 && B.size === 0) return { ok: false };
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  const structural_similarity = union > 0 ? inter / union : 0;

  // Semantic similarity: cosine over BGE embeddings if both present
  let semantic_similarity = 0;
  try {
    const blob = (id) => db.prepare(`
      SELECT embedding FROM node_embeddings
       WHERE rowid = (SELECT rowid FROM node_rowids WHERE node_id=?)
    `).get(id)?.embedding;
    const a = blob(node_a), b = blob(node_b);
    if (a && b) {
      const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
      const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < fa.length; i++) { dot += fa[i] * fb[i]; na += fa[i]*fa[i]; nb += fb[i]*fb[i]; }
      semantic_similarity = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
    }
  } catch {}

  const combined_score = 0.5 * structural_similarity + 0.5 * semantic_similarity;
  return { ok: true, structural_similarity, semantic_similarity, combined_score, similarity: combined_score };
}
