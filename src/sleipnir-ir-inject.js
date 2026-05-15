// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — IR Layer 3.5.2 injection (Step 5, 2026-04-29)
// Plan §6 Step 5: parallel cosine match against accepted experiential anchors
// in experiential_pending_review (state='accepted'), inject top-K with
// `[experiential, unverified, conf=X.XX]` prefix. Independent of SA pool;
// dedup against _renderedNodeIds via candidate_id.
//
// SHADOW philosophy: anchors live only in pending_review until Step 6 promotion;
// IR sees them through this injector. Dashboard toggle: ENGINE_SLEIPNIR_IR_INJECT.
//
// Threshold: COSINE_FLOOR 0.50 (slightly higher than 0.45 for verified anchors,
// since these are unverified; we want a stronger signal to surface them).

const COSINE_FLOOR = 0.50;
const TOP_K = 3;
const MAX_ROWS_SCANNED = 200;

function decodeEmb(buf) {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(qF32, aF32, qNorm) {
  let dot = 0, aNorm = 0;
  for (let i = 0; i < aF32.length; i++) { dot += qF32[i] * aF32[i]; aNorm += aF32[i] * aF32[i]; }
  aNorm = Math.sqrt(aNorm);
  return (qNorm > 0 && aNorm > 0) ? dot / (qNorm * aNorm) : 0;
}

/**
 * Compute top-K accepted experiential anchors by cosine similarity to the
 * given query embedding buffer. Returns a rendered markdown block (or null
 * if there are no hits / feature disabled / DB unavailable).
 *
 * @param {{ db: import('better-sqlite3').Database }} engine
 * @param {Buffer} queryEmbBuf - BGE-M3 embedding of the user message
 * @param {Set<string>} alreadyRendered - candidate_ids already in the prompt
 * @returns {{ block: string, hits: Array<{candidate_id:string, cosSim:number}> } | null}
 */
export function buildSleipnirInjection(engine, queryEmbBuf, alreadyRendered) {
  if (process.env.ENGINE_SLEIPNIR_IR_INJECT === '0') return null;
  if (!engine?.db || !queryEmbBuf) return null;

  let rows;
  try {
    rows = engine.db.prepare(`
      SELECT review_id, candidate_id, l0, l1, l2, subtype, embedding, notes, proposed_at
      FROM experiential_pending_review
      WHERE state = 'accepted'
        AND embedding IS NOT NULL
        AND promoted_node_id IS NULL
      ORDER BY proposed_at DESC
      LIMIT ?
    `).all(MAX_ROWS_SCANNED);
  } catch { return null; }

  if (!rows || rows.length === 0) return null;

  const qF32 = decodeEmb(queryEmbBuf);
  let qNorm = 0;
  for (let i = 0; i < qF32.length; i++) qNorm += qF32[i] * qF32[i];
  qNorm = Math.sqrt(qNorm);

  const scored = [];
  for (const r of rows) {
    const aF32 = decodeEmb(r.embedding);
    if (!aF32 || aF32.length !== qF32.length) continue;
    const cosSim = cosine(qF32, aF32, qNorm);
    scored.push({ cosSim, row: r });
  }
  scored.sort((x, y) => y.cosSim - x.cosSim);

  const hits = [];
  for (const s of scored) {
    if (s.cosSim < COSINE_FLOOR) break;
    if (alreadyRendered && alreadyRendered.has(s.row.candidate_id)) continue;
    hits.push(s);
    if (hits.length >= TOP_K) break;
  }

  if (hits.length === 0) return null;

  const lines = hits.map(h => {
    const r = h.row;
    let conf = 0;
    try {
      const n = JSON.parse(r.notes || '{}');
      conf = Number(n.confidence) || 0;
    } catch { /* tolerate malformed notes */ }
    const confStr = conf ? `, conf=${conf.toFixed(2)}` : '';
    const subtype = r.subtype || 'experiential';
    const header = `[experiential, unverified${confStr}] cos=${h.cosSim.toFixed(3)} | ${subtype} | **${r.candidate_id}**`;
    const body = [r.l0, r.l1, r.l2].filter(Boolean).join('\n');
    return `${header}\n${body}`;
  });

  // Mark candidates as rendered so downstream layers don't re-show
  if (alreadyRendered) {
    for (const h of hits) alreadyRendered.add(h.row.candidate_id);
  }

  // Touch: bump refresh_count + last_refreshed_at so the decay sweep boosts
  // recently-injected anchors. Best-effort, never fail the IR build on this.
  try {
    const now = Date.now();
    const stmt = engine.db.prepare(`
      UPDATE experiential_pending_review
      SET refresh_count = COALESCE(refresh_count, 0) + 1, last_refreshed_at = ?
      WHERE candidate_id = ? AND state = 'accepted'
    `);
    for (const h of hits) stmt.run(now, h.row.candidate_id);
  } catch { /* non-critical */ }

  const block =
    `## 🐎 Sleipnir Experiential Anchors (unverified, parallel cosine match)\n` +
    `Auto-derived from exploration trails by the Sleipnir aggregator; not yet promoted to graph. ` +
    `Treat as hints, verify before acting.\n\n` +
    lines.join('\n\n');

  return { block, hits: hits.map(h => ({ candidate_id: h.row.candidate_id, cosSim: h.cosSim })) };
}
