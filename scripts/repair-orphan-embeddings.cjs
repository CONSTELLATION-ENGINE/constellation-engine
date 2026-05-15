#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-time repair: backfill embeddings + suggest edges for nodes that were written
 * via rememberSync() fallback (missing vec0 entries).
 *
 * Usage: node scripts/repair-orphan-embeddings.js
 */
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'constellation.db');
const MIMIR_PORT = process.env.MIMIR_PORT || 18810;

async function embed(text) {
  const resp = await fetch(`http://127.0.0.1:${MIMIR_PORT}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) throw new Error(`Embed error: ${resp.status}`);
  const data = await resp.json();
  return data.embeddings_b64
    ? Buffer.from(data.embeddings_b64[0], 'base64')
    : Buffer.from(Float32Array.from(data.embeddings[0]).buffer);
}

async function main() {
  const db = Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);

  // Find active nodes without embeddings
  const orphans = db.prepare(`
    SELECT n.id, n.l0, n.l1, n.source, n.conn_count
    FROM nodes n
    LEFT JOIN node_rowids nr ON n.id = nr.node_id
    WHERE n.state = 'active'
      AND nr.node_id IS NULL
    ORDER BY n.created_at DESC
  `).all();

  console.log(`Found ${orphans.length} nodes without embeddings`);

  const upsertRowid = db.prepare(`INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)`);
  const getRowid = db.prepare(`SELECT rowid FROM node_rowids WHERE node_id = ?`);
  const deleteVec = db.prepare(`DELETE FROM node_embeddings WHERE id = ?`);
  const insertVec = db.prepare(`INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)`);
  const STAR_MAP_OWNER_ID = 'self';
  const insertEdge = db.prepare(`INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id) VALUES (?, ?, ?, ?, 'active', datetime('now'), COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))`);
  const updateConnCount = db.prepare(`
    UPDATE nodes SET conn_count = (
      (SELECT COUNT(*) FROM edges WHERE source = ? AND state = 'active') +
      (SELECT COUNT(*) FROM edges WHERE target = ? AND state = 'active')
    ) WHERE id = ?
  `);
  const rowIdToNode = db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
  const getNodeDegree = db.prepare("SELECT conn_count FROM nodes WHERE id = ? AND state = 'active'");

  let fixed = 0;
  let edgesCreated = 0;

  for (const node of orphans) {
    const embedText = `${node.l0} ${node.l1 || ''}`;
    try {
      const emb = await embed(embedText);

      // Insert embedding
      db.transaction(() => {
        upsertRowid.run(node.id);
        const r = getRowid.get(node.id);
        deleteVec.run(r.rowid);
        insertVec.run(BigInt(r.rowid), emb);
      })();

      // Suggest edges (same logic as _suggestEdges)
      const vecResults = db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 11`
      ).all(emb);

      const scored = [];
      for (const r of vecResults) {
        const mapping = rowIdToNode.get(r.id);
        if (!mapping || mapping.node_id === node.id) continue;
        const cosSim = 1 - (r.distance * r.distance) / 2;
        if (cosSim < 0.40) continue;
        const degreeRow = getNodeDegree.get(mapping.node_id);
        if (!degreeRow) continue;
        const hubBoost = (degreeRow.conn_count || 0) > 20 ? 1.2 : 1.0;
        scored.push({ nodeId: mapping.node_id, score: cosSim * hubBoost, cosSim });
      }

      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, 5);

      for (const cand of topK) {
        const strength = 0.3 + (cand.cosSim - 0.4) * 0.67;
        insertEdge.run(node.id, cand.nodeId, 'associative', Math.min(strength, 0.7), node.id, STAR_MAP_OWNER_ID);
        insertEdge.run(cand.nodeId, node.id, 'associative', Math.min(strength * 0.8, 0.56), cand.nodeId, STAR_MAP_OWNER_ID);
        updateConnCount.run(cand.nodeId, cand.nodeId, cand.nodeId);
        edgesCreated += 2;
      }
      updateConnCount.run(node.id, node.id, node.id);

      fixed++;
      console.log(`  ✓ ${node.id} — embedded + ${topK.length} edges suggested`);

      // Small delay to avoid overwhelming Mímir
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ✗ ${node.id} — ${err.message}`);
    }
  }

  console.log(`\nDone: ${fixed}/${orphans.length} nodes fixed, ${edgesCreated} edges created`);
  db.close();
}

main().catch(console.error);
