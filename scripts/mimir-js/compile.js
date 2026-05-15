// SPDX-License-Identifier: AGPL-3.0-or-later
// Narrative IR compilation: render top pool nodes + their edges into a
// compact text skeleton. Mirrors mimir_daemon.py compile_from_pool +
// pool_skeleton_compiler.
//
// Engine reads:
//   /compile_skeleton → { ok, skeleton_text, edges_used, nodes_covered, method }
//   /compile          → { ok, compiled: { skeleton, claims[], tensions[],
//                                          narrative_ir{...}, edge_count,
//                                          role_distribution{} } }

import { getDb } from './db.js';
import { getPool } from './pool.js';

// Edge type → narrative role (mirrors Python role classification, lite).
const EDGE_ROLE = {
  // causal / structural
  causes: 'causal', causal: 'causal', enables: 'causal', triggers: 'causal',
  depends_on: 'dependency', contains: 'dependency', builds_on: 'dependency',
  // support / evidence
  supports: 'support', exemplifies: 'evidence', extends: 'support',
  contextualizes: 'context', synthesizes: 'support',
  // tension / contrast
  contradicts: 'contradiction', challenges: 'tension',
  contrasts: 'tension', contrastive: 'tension',
  // associative / lineage
  parallels: 'parallel', associative: 'parallel', inspires: 'parallel',
  complements: 'parallel', temporal: 'lineage', supersedes: 'lineage',
  hierarchical: 'lineage',
  relates_to: 'relate', collision: 'relate', coactivation: 'relate',
};

const ROLE_LABELS = {
  causal: 'Drivers',
  dependency: 'Dependencies',
  support: 'Supporting',
  evidence: 'Evidence',
  context: 'Context',
  contradiction: 'Contradictions',
  tension: 'Tensions',
  parallel: 'Parallels',
  lineage: 'Lineage',
  relate: 'Related',
};

function _topPoolNodes(maxNodes = 30) {
  const pool = getPool({ size: maxNodes });
  return pool.nodes || [];
}

function _edgesBetween(nodeIds) {
  if (nodeIds.length === 0) return [];
  const db = getDb();
  const placeholders = nodeIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT source, target, edge_type, COALESCE(strength, 0.5) AS strength
      FROM edges
     WHERE state='active'
       AND source IN (${placeholders})
       AND target IN (${placeholders})
  `).all(...nodeIds, ...nodeIds);
}

function _truncate(s, n = 90) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function compileSkeleton({ max_sentences = 6 } = {}) {
  const top = _topPoolNodes(40);
  if (top.length === 0) return { ok: false, reason: 'pool empty', skeleton_text: '' };

  const ids = top.map(n => n.id);
  const labelMap = new Map(top.map(n => [n.id, _truncate(n.l0 || n.l1 || n.id, 70)]));
  const edges = _edgesBetween(ids);
  if (edges.length === 0) {
    // No edges between top — list isolated highlights so engine still gets context.
    const sentences = top.slice(0, max_sentences).map(n => `• ${labelMap.get(n.id)}`);
    return {
      ok: true,
      skeleton_text: sentences.join('\n'),
      edges_used: 0,
      nodes_covered: sentences.length,
      method: 'isolated-highlights',
    };
  }

  // Group edges by role
  const byRole = new Map();
  for (const e of edges) {
    const role = EDGE_ROLE[e.edge_type] || 'relate';
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(e);
  }

  // Render: ranked sentences per role, capped at max_sentences total
  const sentences = [];
  const usedEdges = new Set();
  const usedNodes = new Set();
  const rolesSorted = [...byRole.keys()].sort((a, b) => byRole.get(b).length - byRole.get(a).length);
  for (const role of rolesSorted) {
    const arr = byRole.get(role);
    arr.sort((a, b) => b.strength - a.strength);
    const top1 = arr[0];
    const k = `${top1.source}\u0000${top1.target}`;
    if (usedEdges.has(k)) continue;
    usedEdges.add(k);
    usedNodes.add(top1.source); usedNodes.add(top1.target);
    const left = labelMap.get(top1.source) || top1.source;
    const right = labelMap.get(top1.target) || top1.target;
    sentences.push(`[${ROLE_LABELS[role] || role}] ${left} → ${right}`);
    if (sentences.length >= max_sentences) break;
  }

  return {
    ok: true,
    skeleton_text: sentences.join('\n'),
    edges_used: usedEdges.size,
    nodes_covered: usedNodes.size,
    method: 'pool-edge-skeleton',
  };
}

export function compile({ query = '' } = {}) {
  const skel = compileSkeleton({ max_sentences: 8 });
  if (!skel.ok) return { ok: false, reason: skel.reason };

  const top = _topPoolNodes(40);
  const ids = top.map(n => n.id);
  const edges = _edgesBetween(ids);
  const role_distribution = {};
  for (const e of edges) {
    const r = EDGE_ROLE[e.edge_type] || 'relate';
    role_distribution[r] = (role_distribution[r] || 0) + 1;
  }
  const node_roles = {};
  for (const e of edges) {
    const r = EDGE_ROLE[e.edge_type] || 'relate';
    if (!node_roles[e.source]) node_roles[e.source] = r;
    if (!node_roles[e.target]) node_roles[e.target] = r;
  }
  const tension_map = {};
  for (const e of edges) {
    const r = EDGE_ROLE[e.edge_type] || '';
    if (r === 'tension' || r === 'contradiction') {
      if (!tension_map[e.source]) tension_map[e.source] = [];
      tension_map[e.source].push({ with: e.target, edge_type: e.edge_type });
    }
  }
  const claims = top.slice(0, 8).map(n => ({
    node_id: n.id,
    text: _truncate(n.l1 || n.l0 || '', 200),
    score: n.score,
  }));
  const tensions = Object.entries(tension_map).flatMap(([src, arr]) =>
    arr.map(t => ({ source: src, target: t.with, edge_type: t.edge_type })));

  return {
    ok: true,
    compiled: {
      skeleton: skel.skeleton_text,
      edge_count: edges.length,
      role_distribution,
      claims,
      tensions,
      style_guidance: [],
      narrative_ir: {
        mode: 'pool-edge-skeleton',
        node_roles,
        tension_map,
        narrative_plan: skel.skeleton_text,
      },
    },
  };
}
