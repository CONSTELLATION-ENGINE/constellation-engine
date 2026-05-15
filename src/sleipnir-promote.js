// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir Step 6 — Hybrid Promotion (2026-04-29)
// Plan: engine-output/architecture-research/2026-04-29-sleipnir-step6-hybrid-planning.md
//
// Promote ACCEPT rows from experiential_pending_review into the nodes table:
//   - Distilled L0/L1/L2 (balanced-tier LLM) lands in `nodes` (drives semantic retrieval / BFS)
//   - Raw excerpt (if any) lands in `experiential_raw` side table
//   - Promoted nodes start as state='dormant', weight=0.3, tag 'sleipnir-quarantine'
//     for 72h → graduateSleipnir() flips to state='active', tag 'experiential-graduated'
//   - Subtype-aware edges written directly (NOT via _suggestEdges, which always
//     emits 'associative' / Language channel)
//   - Single atomic transaction: nodes INSERT + UPDATE owner+state+weight + edges
//     INSERT + vec0 INSERT + experiential_raw INSERT + pending UPDATE + log INSERT
//
// All-or-nothing semantics: if any step fails, nothing is committed (P-4).
// Resolver bypass (P-3): RESOLVER_SUBKINDS doesn't include exploration_anchor,
// and Step 4's cos 0.85 ladder + 72h quarantine are the dedup layer.

import { redact } from './sleipnir-redact.js';
import {
  OWNER_EXPERIENTIAL, SUBKIND_EXPLORATION_ANCHOR,
  SUBTYPE_FACTUAL, SUBTYPE_NAVIGATIONAL, SUBTYPE_CONCEPTUAL,
} from './sleipnir-constants.js';
import liveBus from './live-bus.cjs';

// Volume caps (plan §4.3)
const MAX_PROMOTES_PER_TICK   = 5;
const MAX_PROMOTES_PER_24H    = 30;
const MAX_RAW_CHUNKS          = 8;
const MAX_RAW_CHARS_PER_CHUNK = 4096;

// Cos final-check before promote (plan §4 step 2)
const COS_DUP_THRESHOLD       = 0.85;
const COS_KNN_LIMIT           = 25;
const COS_KNN_TOP             = 3;

// Edge KNN matches _suggestEdges defaults so neighbor selection is consistent
const EDGE_COS_FLOOR          = 0.40;
const EDGE_KNN_LIMIT          = 11;
const EDGE_HUB_BIAS           = 1.2;
const EDGE_HUB_DEGREE         = 20;

// Subtype → TTL (accepted_expires_at, plan §6)
const TTL_FACTUAL_MS          = 30 * 24 * 3600_000;
const TTL_DEFAULT_MS          = 7  * 24 * 3600_000;

const QUARANTINE_TAGS         = ['sleipnir', 'sleipnir-quarantine'];

function decodeEmb(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineFromBuffers(qBuf, aBuf) {
  const q = decodeEmb(qBuf), a = decodeEmb(aBuf);
  if (!q || !a || q.length !== a.length) return 0;
  let dot = 0, qn = 0, an = 0;
  for (let i = 0; i < q.length; i++) { dot += q[i] * a[i]; qn += q[i] * q[i]; an += a[i] * a[i]; }
  qn = Math.sqrt(qn); an = Math.sqrt(an);
  return (qn > 0 && an > 0) ? dot / (qn * an) : 0;
}

function chunkRaw(text) {
  if (!text || typeof text !== 'string') return [];
  const chunks = [];
  let i = 0;
  while (i < text.length && chunks.length < MAX_RAW_CHUNKS) {
    chunks.push(text.slice(i, i + MAX_RAW_CHARS_PER_CHUNK));
    i += MAX_RAW_CHARS_PER_CHUNK;
  }
  // Mark truncation if input exceeded MAX_RAW_CHUNKS * MAX_RAW_CHARS_PER_CHUNK
  if (i < text.length && chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = last.slice(0, Math.max(0, MAX_RAW_CHARS_PER_CHUNK - 12)) + '\n[…truncated]';
  }
  return chunks;
}

function makePromotedNodeId(reviewId, ts) {
  // EPR-<region>-<ts> → EA-PROMOTED-<region>-<ts>
  const tag = String(reviewId || 'unknown').replace(/^EPR-/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  return `EA-PROMOTED-${tag}-${ts}`;
}

// Map subtype → (edge_type, edge_direction) for subtype-aware edge writing (plan §4.1).
// Per peer-review Q4 decision: conceptual always 'associative' (drop brittle
// keyword sniff). Channel routing by edge_type: builds_on/contains → Scaffold,
// causal/contrastive → Knowledge, associative → Language.
function edgeSpecForSubtype(subtype) {
  switch (subtype) {
    case SUBTYPE_FACTUAL:
      // new node →builds_on→ existing anchor (Scaffold channel).
      return { edgeType: 'builds_on', direction: 'forward', topK: 3 };
    case SUBTYPE_NAVIGATIONAL:
      // existing anchor →hierarchical→ new node ("anchor contains pointer").
      // Plan §4.1 specified 'contains' but that isn't in VALID_EDGE_TYPES;
      // 'hierarchical' is the closest parent→child analog (Scaffold channel).
      return { edgeType: 'hierarchical', direction: 'reverse', topK: 2 };
    case SUBTYPE_CONCEPTUAL:
    default:
      // bidirectional, weaker (Language channel).
      return { edgeType: 'associative', direction: 'bidirectional', topK: 3 };
  }
}

export class SleipnirPromote {
  #engine = null;
  #enabled = true;
  #stmts = {};

  init({ engine }) {
    this.#engine = engine;
    if (!engine?.db || typeof engine._embed !== 'function') {
      this.#enabled = false;
      return;
    }
    const db = engine.db;
    this.#stmts.selectAccepted = db.prepare(`
      SELECT review_id, candidate_id, l0, l1, l2, subtype, embedding,
             trail_ids, notes, region,
             raw_excerpt, raw_line_range, raw_file_path
      FROM experiential_pending_review
      WHERE state = 'accepted'
        AND promoted_node_id IS NULL
      ORDER BY proposed_at ASC
      LIMIT ?
    `);
    this.#stmts.dailyCount = db.prepare(`
      SELECT COUNT(*) AS c FROM sleipnir_promote_log
      WHERE created_at > ? AND decision = 'promoted'
    `);
    this.#stmts.knnVec = db.prepare(
      `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ${EDGE_KNN_LIMIT}`
    );
    this.#stmts.knnVecDup = db.prepare(
      `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ${COS_KNN_LIMIT}`
    );
    this.#stmts.rowidToNode = db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
    this.#stmts.nodeMeta = db.prepare(`
      SELECT id, conn_count, subkind, state, owner_id
      FROM nodes
      WHERE id = ? AND state = 'active'
    `);
    this.#stmts.insertNode = db.prepare(`
      INSERT INTO nodes (
        id, state, created_at, accessed_at, l0, l1, l2, tags, tone, valence, arousal,
        weight, conn_count, access_count, source, node_type, updated_at,
        owner_id, event_at, subkind, subtype
      ) VALUES (
        @id, 'dormant', @now, @now, @l0, @l1, @l2, @tags, 'analytical', 0, 0.5,
        0.3, 0, 0, 'sleipnir-promote', 'self_act', @now,
        @owner, @now, @subkind, @subtype
      )
    `);
    this.#stmts.upsertRowid = db.prepare("INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)");
    this.#stmts.getRowid = db.prepare("SELECT rowid FROM node_rowids WHERE node_id = ?");
    this.#stmts.deleteVec = db.prepare("DELETE FROM node_embeddings WHERE id = ?");
    this.#stmts.insertVec = db.prepare("INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)");
    this.#stmts.insertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);
    this.#stmts.insertRaw = db.prepare(`
      INSERT INTO experiential_raw (node_id, chunk_idx, total_chunks, source_kind, file_path, line_range, raw_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#stmts.updatePending = db.prepare(`
      UPDATE experiential_pending_review
      SET promoted_node_id = ?, promoted_at = ?, state = 'promoted', accepted_expires_at = ?
      WHERE review_id = ?
    `);
    this.#stmts.insertLog = db.prepare(`
      INSERT INTO sleipnir_promote_log (review_id, promoted_node_id, decision, reason, cos_max_neighbor, edges_written, raw_chunks, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#stmts.insertFts = db.prepare("INSERT OR REPLACE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)");
  }

  isEnabled() { return this.#enabled; }

  /**
   * One promotion pass. Scans accepted+unpromoted rows, runs cos final-check
   * + daily-cap, then atomic-tx-promotes up to MAX_PROMOTES_PER_TICK.
   */
  async runOnce({ maxPromotes = MAX_PROMOTES_PER_TICK } = {}) {
    if (!this.#enabled) return { skipped: 'disabled', promoted: 0 };
    if (process.env.ENGINE_SLEIPNIR_PROMOTE_ENABLED === '0') {
      return { skipped: 'disabled-env', promoted: 0 };
    }

    // Daily cap check (volume cap, plan §4.3)
    const since24h = Date.now() - 24 * 3600_000;
    const dailyRow = this.#stmts.dailyCount.get(since24h);
    if ((dailyRow?.c || 0) >= MAX_PROMOTES_PER_24H) {
      return { skipped: 'daily-cap', promoted: 0, daily_count: dailyRow.c };
    }

    const rows = this.#stmts.selectAccepted.all(Math.min(maxPromotes, MAX_PROMOTES_PER_TICK));
    if (rows.length === 0) return { promoted: 0, scanned: 0 };

    let promoted = 0, skippedDup = 0, failedTx = 0;
    const results = [];
    for (const row of rows) {
      // Re-check daily cap mid-loop (cheap, prevents boundary overshoot)
      const midRow = this.#stmts.dailyCount.get(since24h);
      if ((midRow?.c || 0) >= MAX_PROMOTES_PER_24H) {
        results.push({ review_id: row.review_id, decision: 'skipped_volume_cap' });
        try {
          this.#stmts.insertLog.run(row.review_id, null, 'skipped_volume_cap', 'daily cap hit mid-tick', null, 0, 0, Date.now());
        } catch { /* */ }
        break;
      }

      try {
        const r = await this.#promoteOne(row);
        results.push(r);
        if (r.decision === 'promoted') promoted++;
        else if (r.decision === 'skipped_dup') skippedDup++;
        else if (r.decision === 'failed_tx') failedTx++;
      } catch (e) {
        failedTx++;
        results.push({ review_id: row.review_id, decision: 'failed_tx', error: e.message });
        try {
          this.#stmts.insertLog.run(row.review_id, null, 'failed_tx', e.message?.slice(0, 200) || 'unknown', null, 0, 0, Date.now());
        } catch { /* */ }
      }
    }

    return { scanned: rows.length, promoted, skipped_dup: skippedDup, failed_tx: failedTx, results };
  }

  async #promoteOne(row) {
    const ts = Date.now();
    const subtype = (row.subtype || SUBTYPE_CONCEPTUAL).toLowerCase();
    const ttlMs = (subtype === SUBTYPE_FACTUAL) ? TTL_FACTUAL_MS : TTL_DEFAULT_MS;
    const expiresAt = ts + ttlMs;
    const nodeId = makePromotedNodeId(row.review_id, ts);

    // Use stored embedding if available; else re-embed.
    let embedding = row.embedding ? Buffer.from(row.embedding) : null;
    if (!embedding) {
      const embedText = `${row.l0 || ''} ${row.l1 || ''}`.trim();
      try {
        embedding = await this.#engine._embed(embedText);
      } catch (e) {
        return this.#logAndReturn(row.review_id, null, 'failed_tx', `embed: ${e.message}`, null, 0, 0);
      }
      if (!embedding) {
        return this.#logAndReturn(row.review_id, null, 'failed_tx', 'embed returned null', null, 0, 0);
      }
    }

    // Step 2: cos final-check vs existing nodes (top-3 KNN @ 0.85 → skip)
    const dupResult = this.#cosFinalCheck(embedding);
    if (dupResult.isDup) {
      return this.#logAndReturn(row.review_id, null, 'skipped_dup',
        `cos=${dupResult.maxCos.toFixed(3)} vs ${dupResult.maxId}`, dupResult.maxCos, 0, 0);
    }

    // Step 4: PII redact on raw_excerpt (B-4)
    let rawText = (row.raw_excerpt && typeof row.raw_excerpt === 'string') ? row.raw_excerpt : null;
    let rawChunks = [];
    if (rawText) {
      const r = redact(rawText, 'exploration');
      rawText = r.text;
      rawChunks = chunkRaw(rawText);
    }

    // Step 1: classify subtype (already in row.subtype) → edge spec
    const edgeSpec = edgeSpecForSubtype(subtype);

    // Pre-compute KNN edge candidates outside the txn (SELECTs are safe to nest
    // but cleaner to pre-fetch).
    const edgeCandidates = this.#findEdgeNeighbors(nodeId, embedding, edgeSpec.topK);

    // Step 5: atomic transaction (P-4)
    const db = this.#engine.db;
    const insertFts = this.#stmts.insertFts;
    const insertNode = this.#stmts.insertNode;
    const upsertRowid = this.#stmts.upsertRowid;
    const getRowid = this.#stmts.getRowid;
    const deleteVec = this.#stmts.deleteVec;
    const insertVec = this.#stmts.insertVec;
    const insertEdge = this.#stmts.insertEdge;
    const insertRaw = this.#stmts.insertRaw;
    const updatePending = this.#stmts.updatePending;
    const insertLog = this.#stmts.insertLog;

    const tagsCsv = JSON.stringify(QUARANTINE_TAGS);
    const nowIso = new Date(ts).toISOString();
    let edgesWritten = 0;
    const edgeTime = nowIso;
    const cosMax = edgeCandidates.length > 0 ? edgeCandidates[0].cosSim : null;

    const txn = db.transaction(() => {
      // 1. Insert node (state='dormant', weight=0.3 from prepared stmt)
      insertNode.run({
        id: nodeId,
        now: nowIso,
        l0: String(row.l0 || '').slice(0, 200),
        l1: String(row.l1 || '').slice(0, 500),
        l2: String(row.l2 || '').slice(0, 2000),
        tags: tagsCsv,
        owner: OWNER_EXPERIENTIAL,
        subkind: SUBKIND_EXPLORATION_ANCHOR,
        subtype,
      });

      // 2. vec0 mapping
      upsertRowid.run(nodeId);
      const rid = getRowid.get(nodeId);
      deleteVec.run(rid.rowid);
      insertVec.run(BigInt(rid.rowid), embedding);

      // 3. FTS5 sync (mirrors engine.cjs:1003 pattern)
      try { insertFts.run(nodeId, String(row.l2 || ''), tagsCsv); } catch { /* */ }

      // 4. Subtype-aware edges (NOT _suggestEdges — that emits 'associative' only)
      for (const cand of edgeCandidates) {
        const strength = Math.min(0.7, Math.max(0.3, cand.cosSim * 0.7));
        if (edgeSpec.direction === 'reverse') {
          insertEdge.run(cand.nodeId, nodeId, edgeSpec.edgeType, strength, edgeTime, OWNER_EXPERIENTIAL);
          edgesWritten++;
        } else if (edgeSpec.direction === 'forward') {
          insertEdge.run(nodeId, cand.nodeId, edgeSpec.edgeType, strength, edgeTime, OWNER_EXPERIENTIAL);
          edgesWritten++;
        } else { // bidirectional
          insertEdge.run(nodeId, cand.nodeId, edgeSpec.edgeType, strength, edgeTime, OWNER_EXPERIENTIAL);
          insertEdge.run(cand.nodeId, nodeId, edgeSpec.edgeType, strength * 0.8, edgeTime, OWNER_EXPERIENTIAL);
          edgesWritten += 2;
        }
      }

      // 5. Raw chunks (P-1, side table)
      for (let i = 0; i < rawChunks.length; i++) {
        insertRaw.run(
          nodeId, i, rawChunks.length,
          inferSourceKind(subtype),
          row.raw_file_path || null,
          row.raw_line_range || null,
          rawChunks[i],
          ts,
        );
      }

      // 6. Mark pending row as promoted + stamp expiry
      updatePending.run(nodeId, ts, expiresAt, row.review_id);

      // 7. Audit log
      insertLog.run(row.review_id, nodeId, 'promoted', `subtype=${subtype} edges=${edgesWritten} raw_chunks=${rawChunks.length}`, cosMax, edgesWritten, rawChunks.length, ts);
    });

    try {
      txn();
    } catch (e) {
      return this.#logAndReturn(row.review_id, null, 'failed_tx', `tx: ${e.message?.slice(0, 200)}`, cosMax, 0, 0);
    }

    // Adjacency cache invalidation (best-effort, outside txn)
    try { this.#engine._adjCacheVersion = (this.#engine._adjCacheVersion || 0) + 1; } catch { /* */ }

    // Live tab visibility — fire after successful commit (best-effort, never throws)
    try {
      liveBus.safeEmit?.('sleipnir.promote', {
        review_id: row.review_id,
        promoted_node_id: nodeId,
        subtype,
        edges_written: edgesWritten,
        raw_chunks: rawChunks.length,
        cos_max_neighbor: cosMax,
        l0: String(row.l0 || '').slice(0, 120),
        ts,
      });
    } catch { /* */ }

    return {
      review_id: row.review_id,
      decision: 'promoted',
      promoted_node_id: nodeId,
      subtype,
      edges_written: edgesWritten,
      raw_chunks: rawChunks.length,
      cos_max_neighbor: cosMax,
    };
  }

  // KNN cos check: top-3 neighbors. If any cos > COS_DUP_THRESHOLD → dup.
  // Skips quarantined (dormant) nodes — those are already-promoted siblings.
  #cosFinalCheck(embedding) {
    let maxCos = 0, maxId = null;
    try {
      const vecRows = this.#stmts.knnVecDup.all(embedding);
      const candidates = [];
      for (const v of vecRows) {
        const m = this.#stmts.rowidToNode.get(v.id);
        if (!m) continue;
        const cosSim = 1 - (v.distance * v.distance) / 2;
        if (cosSim < COS_DUP_THRESHOLD - 0.1) break; // sorted; no point scanning further
        candidates.push({ id: m.node_id, cosSim });
        if (candidates.length >= COS_KNN_TOP) break;
      }
      for (const c of candidates) {
        const meta = this.#stmts.nodeMeta.get(c.id);
        if (!meta) continue; // dormant or missing — ignore for dedup
        if (c.cosSim > maxCos) { maxCos = c.cosSim; maxId = c.id; }
      }
    } catch { /* */ }
    return { isDup: maxCos >= COS_DUP_THRESHOLD, maxCos, maxId };
  }

  // KNN-with-hub-bias to pick edge neighbors. Mirrors _suggestEdges (engine.cjs:1389)
  // selection but caller controls top-K and gets back full metadata.
  #findEdgeNeighbors(selfNodeId, embedding, topK) {
    try {
      const vecRows = this.#stmts.knnVec.all(embedding);
      const scored = [];
      for (const v of vecRows) {
        const m = this.#stmts.rowidToNode.get(v.id);
        if (!m || m.node_id === selfNodeId) continue;
        const cosSim = 1 - (v.distance * v.distance) / 2;
        if (cosSim < EDGE_COS_FLOOR) continue;
        const meta = this.#stmts.nodeMeta.get(m.node_id);
        if (!meta) continue; // skip dormant / missing
        // Don't link to other quarantined Sleipnir nodes — wait until they graduate
        if (meta.subkind === SUBKIND_EXPLORATION_ANCHOR && meta.state !== 'active') continue;
        const hubBoost = (meta.conn_count || 0) > EDGE_HUB_DEGREE ? EDGE_HUB_BIAS : 1.0;
        scored.push({ nodeId: m.node_id, score: cosSim * hubBoost, cosSim });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK);
    } catch {
      return [];
    }
  }

  #logAndReturn(reviewId, nodeId, decision, reason, cosMax, edgesWritten, rawChunks) {
    try {
      this.#stmts.insertLog.run(reviewId, nodeId, decision, reason, cosMax, edgesWritten, rawChunks, Date.now());
    } catch { /* */ }
    return { review_id: reviewId, decision, reason };
  }
}

function inferSourceKind(subtype) {
  if (subtype === SUBTYPE_FACTUAL) return 'code_excerpt';
  if (subtype === SUBTYPE_NAVIGATIONAL) return 'code_excerpt';
  return 'reading_excerpt';
}

export const sleipnirPromote = new SleipnirPromote();
