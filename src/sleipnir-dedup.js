// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — cos dedup gate + Resolver SHADOW (Step 4, 2026-04-29)
// Plan §6 Step 4: for each pending review, embed candidate, find max cos vs
// existing experiential nodes, decide SKIP / REVISE / ACCEPT.
//
// Thresholds (user decision):
//   cos ≥ 0.85  → SKIP    (drop, mark review state='rejected')
//   0.75-0.85   → REVISE  (mark state='revising', notes carry overlap_id)
//   < 0.75      → ACCEPT  (mark state='accepted'; node-write happens later)
//
// SHADOW mode for Step 4: do not promote to nodes table — just record verdict.
// Promotion to actual nodes happens in Step 5/6 after observation period.
//
// task_trail subkind is excluded — user decision #5 (task_trail skips Resolver entirely).

import {
  OWNER_EXPERIENTIAL, SUBKIND_EXPLORATION_ANCHOR,
} from './sleipnir-constants.js';

const SKIP_THRESHOLD   = 0.85;
const REVISE_THRESHOLD = 0.75;
const KNN_LIMIT = 32;

export class SleipnirDedup {
  #engine = null;
  #resolver = null;   // optional: MimirResolver for SHADOW logging
  #enabled = true;
  #stmts = {};

  init({ engine, resolver = null }) {
    this.#engine = engine;
    this.#resolver = resolver;
    if (!engine?.db || typeof engine._embed !== 'function') { this.#enabled = false; return; }

    this.#stmts.fetchPending = engine.db.prepare(`
      SELECT review_id, candidate_id, l0, l1, l2, subtype, trail_ids, notes, proposed_at
      FROM experiential_pending_review
      WHERE state = 'pending'
        AND resolver_verdict IS NULL
      ORDER BY proposed_at ASC
      LIMIT ?
    `);
    this.#stmts.updateReview = engine.db.prepare(`
      UPDATE experiential_pending_review
      SET resolver_verdict = ?, cos_dedup_score = ?, state = ?, notes = ?, embedding = ?,
          effective_strength = ?, region = ?, last_refreshed_at = ?
      WHERE review_id = ?
    `);
  }

  async runOnce({ batchSize = 8 } = {}) {
    if (!this.#enabled) return { skipped: 'disabled', processed: 0 };

    const rows = this.#stmts.fetchPending.all(batchSize);
    if (rows.length === 0) return { processed: 0 };

    let accepted = 0, revised = 0, rejected = 0, errors = 0;
    const summary = [];

    for (const r of rows) {
      try {
        const composedText = `${r.l0}\n${r.l1}\n${r.l2}`.trim();
        let embedding = null;
        try { embedding = await this.#engine._embed(composedText); }
        catch (e) {
          // Fail-open: mark as accepted with note, don't block
          this.#stmts.updateReview.run('embed_failed', null, 'accepted', appendNote(r.notes, { embed_error: e.message }), null, 0.5, parseRegion(r.notes), Date.now(), r.review_id);
          accepted++;
          summary.push({ review_id: r.review_id, action: 'accepted_fail_open', reason: 'embed_failed' });
          continue;
        }

        const { maxCos, neighborId } = this.#cosNeighbor(embedding);
        const score = maxCos;

        let verdict, nextState;
        if (score >= SKIP_THRESHOLD) {
          verdict = 'SKIP';
          nextState = 'rejected';
          rejected++;
        } else if (score >= REVISE_THRESHOLD) {
          verdict = 'REVISE';
          nextState = 'revising';
          revised++;
        } else {
          verdict = 'ACCEPT';
          nextState = 'accepted';
          accepted++;
        }

        // Optional Resolver SHADOW pass — purely observational for Step 4.
        let shadowVerdict = null;
        if (this.#resolver && r.subtype) {
          try {
            const shadow = await this.#resolver.resolve({
              text: composedText,
              embedding,
              subkind: SUBKIND_EXPLORATION_ANCHOR,
              ownerId: OWNER_EXPERIENTIAL,
              candidateNodeId: r.candidate_id,
              edgeTargets: [],
              pinned: false,
            });
            shadowVerdict = shadow?.verdict || null;
          } catch (e) {
            shadowVerdict = `error:${e.message}`;
          }
        }

        const finalVerdict = `${verdict}${shadowVerdict ? `|shadow:${shadowVerdict}` : ''}`;
        const newNotes = appendNote(r.notes, {
          cos_neighbor: neighborId,
          cos_score: score,
          shadow_resolver: shadowVerdict,
        });
        const conf = parseConfidence(r.notes);
        const region = parseRegion(r.notes);
        this.#stmts.updateReview.run(finalVerdict, score, nextState, newNotes, embedding, conf, region, Date.now(), r.review_id);
        summary.push({ review_id: r.review_id, verdict, cos: score, shadow: shadowVerdict, neighbor: neighborId });
      } catch (e) {
        errors++;
        summary.push({ review_id: r.review_id, error: e.message });
      }
    }

    return { processed: rows.length, accepted, revised, rejected, errors, summary };
  }

  // Find max cosine vs existing engine-experiential exploration_anchor nodes.
  #cosNeighbor(embedding) {
    if (!embedding) return { maxCos: 0, neighborId: null };
    try {
      const vecResults = this.#engine.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ${KNN_LIMIT}`
      ).all(embedding);
      if (vecResults.length === 0) return { maxCos: 0, neighborId: null };

      const rowidList = vecResults.map(v => v.id);
      const phRowid = rowidList.map(() => '?').join(',');
      const mapRows = this.#engine.db.prepare(
        `SELECT rowid, node_id FROM node_rowids WHERE rowid IN (${phRowid})`
      ).all(...rowidList);
      const rowidToNodeId = new Map(mapRows.map(m => [m.rowid, m.node_id]));
      if (rowidToNodeId.size === 0) return { maxCos: 0, neighborId: null };

      const ids = [...rowidToNodeId.values()];
      const phIds = ids.map(() => '?').join(',');
      const filtered = this.#engine.db.prepare(
        `SELECT id FROM nodes
          WHERE id IN (${phIds})
            AND state = 'active'
            AND owner_id = ?
            AND subkind = ?`
      ).all(...ids, OWNER_EXPERIENTIAL, SUBKIND_EXPLORATION_ANCHOR);
      if (filtered.length === 0) return { maxCos: 0, neighborId: null };
      const filterSet = new Set(filtered.map(n => n.id));

      let bestSim = 0, bestId = null;
      for (const r of vecResults) {
        const nodeId = rowidToNodeId.get(r.id);
        if (!nodeId || !filterSet.has(nodeId)) continue;
        const cos = 1 - (r.distance * r.distance) / 2;
        if (cos > bestSim) { bestSim = cos; bestId = nodeId; }
      }
      return { maxCos: bestSim, neighborId: bestId };
    } catch {
      return { maxCos: 0, neighborId: null };
    }
  }

  getDedupSnapshot(limit = 20) {
    if (!this.#engine?.db) return [];
    try {
      return this.#engine.db.prepare(`
        SELECT review_id, subtype, state, resolver_verdict, cos_dedup_score, l0
        FROM experiential_pending_review
        WHERE resolver_verdict IS NOT NULL
        ORDER BY proposed_at DESC
        LIMIT ?
      `).all(limit);
    } catch { return []; }
  }
}

function appendNote(existingNotes, extra) {
  let parsed = {};
  if (existingNotes) {
    try { parsed = JSON.parse(existingNotes); } catch { parsed = { _raw: existingNotes }; }
  }
  return JSON.stringify({ ...parsed, ...extra });
}

function parseConfidence(notes) {
  if (!notes) return 0.5;
  try {
    const n = JSON.parse(notes);
    const c = Number(n.confidence);
    if (Number.isFinite(c) && c > 0) return Math.min(0.95, Math.max(0.5, c));
  } catch { /* malformed notes — fall through */ }
  return 0.5;
}

function parseRegion(notes) {
  if (!notes) return null;
  try {
    const n = JSON.parse(notes);
    if (typeof n.region === 'string' && n.region.length > 0) return n.region;
  } catch { /* malformed */ }
  return null;
}

export const sleipnirDedup = new SleipnirDedup();
