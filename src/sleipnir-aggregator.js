// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — balanced-tier LLM aggregator (SHADOW mode for Step 3, 2026-04-29)
// Plan §6 Step 3: scan exploration_trail for unprocessed promoted trails (or
// regions with ≥3 trail rows in the past 7 days). Group by region, ask balanced-tier LLM
// to synthesize a candidate experiential anchor (l0/l1/l2 + subtype), and
// write to experiential_pending_review. SHADOW mode = nothing flips into the
// nodes table here; Step 4 (cos dedup + Resolver SHADOW) handles that.
//
// Subtypes:
//   factual       — concrete code/api fact ("BFS at engine.cjs:2561, MAX_SEEDS=40")
//   navigational  — where to look ("aggregator code lives in src/sleipnir-aggregator.js")
//   conceptual    — abstraction ("Mímir uses spreading-activation with τ=1800s decay")
//
// FUTURE — Step 6 promotion (when accepted candidates become real nodes):
//   factual / navigational → write `builds_on` edges to related file/module
//                             anchors (scaffold-tier, surfaces in Procedural Cues)
//   conceptual            → write `causal` or `associative` edges to related
//                             concept anchors (knowledge/language tier)
// Until Step 6 is built, candidates live only in experiential_pending_review
// and surface via Layer 3.5.2b independent injection (no SA pool routing).

import { redact } from './sleipnir-redact.js';
import {
  OWNER_EXPERIENTIAL, SUBKIND_EXPLORATION_ANCHOR,
  SUBTYPE_FACTUAL, SUBTYPE_NAVIGATIONAL, SUBTYPE_CONCEPTUAL,
  PENDING_REVIEW_CAP, TRAIL_GROUP_THRESHOLD,
} from './sleipnir-constants.js';
import liveBus from './live-bus.cjs';

const VALID_SUBTYPES = new Set([SUBTYPE_FACTUAL, SUBTYPE_NAVIGATIONAL, SUBTYPE_CONCEPTUAL]);
const PROPOSER_TAG = 'sleipnir-aggregator-shadow';
const REGION_LOOKBACK_MS = 7 * 24 * 3600_000;
const PENDING_TTL_MS = 14 * 24 * 3600_000;

const SYSTEM_PROMPT = `You are Sleipnir Aggregator — a synthesis layer that turns raw exploration trails (grep / read / web fetch events) into structured experiential anchor candidates.

Given a cluster of trails about the same region, output ONE JSON object with these fields:
  subtype: "factual" | "navigational" | "conceptual"
  l0:      ≤120 chars pointer ("BFS at engine.cjs:2561")
  l1:      ≤300 chars summary (one-paragraph description)
  l2:      ≤1200 chars full content (specific facts, code refs, line numbers)
  confidence: 0.5-0.9 float — your read on whether this is solid enough to inject into IR
  reason:  ≤200 chars on why this is worth keeping (or "low_value" + drop)

Rules:
- Output STRICT JSON, no prose, no markdown fences.
- If trails are too thin / contradictory / pure noise, set subtype=null and reason="low_value".
- Prefer specific line numbers / function names / config keys over hand-wavy descriptions.
- Never invent facts not present in the trails.
- subtype 'factual' = concrete fact (numbers, code locations, API specs)
- subtype 'navigational' = where-to-find pointer ("X lives in src/Y.js")
- subtype 'conceptual' = abstraction or principle that emerges from the trails
`;

function buildUserPrompt(region, trails) {
  const lines = trails.map((t, i) => {
    const meta = t.metadata ? ` [${t.metadata.slice(0, 80)}]` : '';
    return `Trail ${i + 1} (${t.source_kind} @ ${new Date(t.occurred_at).toISOString()}):\n  query: ${t.query || '(none)'}\n  finding: ${t.finding || '(none)'}${meta}`;
  }).join('\n\n');
  return `Region: ${region}\n\nTrails (${trails.length}):\n\n${lines}\n\nReturn JSON only.`;
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  // Strip markdown fences if model insists
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Try to locate the first {...} block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* */ } }
  return null;
}

function makeReviewId(region, ts) {
  const tag = String(region || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  return `EPR-${tag}-${ts}`;
}

function makeCandidateId(region, ts) {
  const tag = String(region || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);
  return `EA-${tag}-${ts}`;
}

export class SleipnirAggregator {
  #engine = null;
  #llm = null;
  #enabled = true;
  #stmts = {};

  init({ engine, llm }) {
    this.#engine = engine;
    this.#llm = llm;
    if (!engine?.db || !llm) { this.#enabled = false; return; }

    this.#stmts.markProcessed = engine.db.prepare(
      `UPDATE exploration_trail SET processed_at = ? WHERE id = ?`
    );
    this.#stmts.insertReview = engine.db.prepare(`
      INSERT INTO experiential_pending_review (
        review_id, proposed_at, proposed_by, candidate_id,
        l0, l1, l2, subtype, trail_ids, resolver_verdict,
        cos_dedup_score, state, expires_at, notes,
        raw_excerpt, raw_line_range, raw_file_path
      ) VALUES (
        @review_id, @proposed_at, @proposed_by, @candidate_id,
        @l0, @l1, @l2, @subtype, @trail_ids, @resolver_verdict,
        @cos_dedup_score, @state, @expires_at, @notes,
        @raw_excerpt, @raw_line_range, @raw_file_path
      )
    `);
  }

  /**
   * One pass: scan promoted+unprocessed trails, plus regions hitting the
   * 3-trail threshold, group, ask balanced-tier LLM, write pending reviews.
   * Returns telemetry summary.
   */
  async runOnce({ maxClusters = 5 } = {}) {
    if (!this.#enabled) return { skipped: 'disabled', clusters: 0, written: 0 };

    const cutoff = Date.now() - REGION_LOOKBACK_MS;

    // Candidate clusters: region with ≥3 trails AND at least one unprocessed
    // trail in that region.
    const clusterRegions = this.#engine.db.prepare(`
      SELECT region, COUNT(*) AS cnt, SUM(CASE WHEN processed_at IS NULL THEN 1 ELSE 0 END) AS unproc
      FROM exploration_trail
      WHERE region IS NOT NULL
        AND occurred_at > ?
      GROUP BY region
      HAVING cnt >= ? AND unproc > 0
      ORDER BY cnt DESC
      LIMIT ?
    `).all(cutoff, TRAIL_GROUP_THRESHOLD, maxClusters);

    let written = 0;
    const clusterResults = [];
    for (const c of clusterRegions) {
      // Only feed unprocessed trails to balanced-tier LLM — re-feeding already-processed
      // ones costs tokens and produces near-duplicates that cos dedup then
      // suppresses. Cluster gate above already requires unproc > 0.
      const trails = this.#engine.db.prepare(`
        SELECT id, occurred_at, source_kind, query, finding, metadata, signature, processed_at,
               raw_excerpt, raw_line_range, raw_file_path
        FROM exploration_trail
        WHERE region = ? AND occurred_at > ? AND processed_at IS NULL
        ORDER BY occurred_at DESC
        LIMIT 12
      `).all(c.region, cutoff);

      if (trails.length < TRAIL_GROUP_THRESHOLD) continue;

      let candidate = null;
      try {
        candidate = await this.#callAggregatorLLM(c.region, trails);
      } catch (e) {
        clusterResults.push({ region: c.region, error: e.message });
        continue;
      }

      if (!candidate || candidate.subtype === null || !VALID_SUBTYPES.has(candidate.subtype)) {
        // balanced-tier LLM declined — mark trails processed so we don't keep retrying the same noise
        try {
          const ts = Date.now();
          for (const t of trails) this.#stmts.markProcessed.run(ts, t.id);
        } catch { /* */ }
        clusterResults.push({ region: c.region, action: 'dropped', reason: candidate?.reason || 'invalid_subtype' });
        continue;
      }

      const ts = Date.now();
      const reviewId = makeReviewId(c.region, ts);
      const candidateId = makeCandidateId(c.region, ts);

      // Pick the raw excerpt to forward: longest non-null across cluster trails.
      // Length tracks information density (a 4KB Read result beats a 200-char
      // Grep snippet for hybrid storage purposes). All redaction already done
      // upstream in sleipnir-trail.recordToolEvent.
      let bestRaw = { excerpt: null, lineRange: null, filePath: null, len: 0 };
      for (const t of trails) {
        const exc = t.raw_excerpt;
        if (typeof exc === 'string' && exc.length > bestRaw.len) {
          bestRaw = {
            excerpt: exc,
            lineRange: t.raw_line_range || null,
            filePath: t.raw_file_path || null,
            len: exc.length,
          };
        }
      }

      try {
        this.#stmts.insertReview.run({
          review_id: reviewId,
          proposed_at: ts,
          proposed_by: PROPOSER_TAG,
          candidate_id: candidateId,
          l0: String(candidate.l0 || '').slice(0, 200),
          l1: String(candidate.l1 || '').slice(0, 500),
          l2: String(candidate.l2 || '').slice(0, 2000),
          subtype: candidate.subtype,
          trail_ids: JSON.stringify(trails.map(t => t.id)),
          resolver_verdict: null,
          cos_dedup_score: null,
          state: 'pending',
          expires_at: ts + PENDING_TTL_MS,
          notes: JSON.stringify({
            region: c.region,
            trail_count: trails.length,
            confidence: candidate.confidence,
            reason: candidate.reason,
          }),
          raw_excerpt: bestRaw.excerpt,
          raw_line_range: bestRaw.lineRange,
          raw_file_path: bestRaw.filePath,
        });
        for (const t of trails) this.#stmts.markProcessed.run(ts, t.id);
        written++;
        clusterResults.push({ region: c.region, action: 'proposed', subtype: candidate.subtype, trail_count: trails.length });
      } catch (e) {
        clusterResults.push({ region: c.region, error: `db: ${e.message}` });
      }
    }

    // FIFO cap on pending reviews — drop oldest beyond cap (boot-time prune
    // also covers this; double-belt).
    try {
      this.#engine.db.prepare(`
        DELETE FROM experiential_pending_review
        WHERE state = 'pending' AND review_id IN (
          SELECT review_id FROM experiential_pending_review
          WHERE state = 'pending'
          ORDER BY proposed_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(PENDING_REVIEW_CAP);
    } catch { /* best-effort */ }

    const summary = { clusters: clusterRegions.length, written, results: clusterResults };

    // Live tab visibility — only emit when something happened (clusters scanned or written)
    if (clusterRegions.length > 0 || written > 0) {
      const proposed = clusterResults.filter(r => r.action === 'proposed').length;
      const dropped  = clusterResults.filter(r => r.action === 'dropped').length;
      const errors   = clusterResults.filter(r => r.error).length;
      try {
        liveBus.safeEmit?.('sleipnir.aggregate', {
          clusters: clusterRegions.length,
          written,
          proposed,
          dropped,
          errors,
          ts: Date.now(),
        });
      } catch { /* */ }
    }

    return summary;
  }

  async #callAggregatorLLM(region, trails) {
    const userPrompt = buildUserPrompt(region, trails);
    // Lenient PII redaction on prompt — same as task_trail
    const safePrompt = redact(userPrompt, 'task_trail').text;

    const messages = [{ role: 'user', content: safePrompt }];
    const resp = await this.#llm.chat(messages, {
      _role: 'sleipnir',
      system: SYSTEM_PROMPT,
      max_tokens: 1024,
      temperature: 0.2,
    });

    const text = (resp?.content || resp?.text || '').toString();
    const parsed = tryParseJson(text);
    if (!parsed) return null;

    // Coerce null-ish subtype
    if (parsed.subtype && typeof parsed.subtype === 'string') {
      parsed.subtype = parsed.subtype.toLowerCase();
    }
    if (parsed.subtype && !VALID_SUBTYPES.has(parsed.subtype)) parsed.subtype = null;
    return parsed;
  }

  // Diagnostic snapshot
  getPendingSnapshot(limit = 20) {
    if (!this.#engine?.db) return [];
    try {
      return this.#engine.db.prepare(`
        SELECT review_id, proposed_at, candidate_id, subtype, state, l0
        FROM experiential_pending_review
        WHERE state = 'pending'
        ORDER BY proposed_at DESC
        LIMIT ?
      `).all(limit);
    } catch { return []; }
  }
}

export const sleipnirAggregator = new SleipnirAggregator();
