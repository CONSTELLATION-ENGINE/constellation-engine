// SPDX-License-Identifier: AGPL-3.0-or-later
// Edge evolution: promote frequently co-activated edges from generic
// `relates_to` to fine-typed (causal/contrastive/hierarchical/associative/
// temporal) based on simple heuristics on the connected nodes' L0 text.
//
// v1 minimal port: rule-based classifier, no LLM call. Strengthens edges
// whose endpoints fire together repeatedly.
//
// Kill-switch: MIMIR_EDGE_EVOLUTION=0 disables the writer.
// Default: ON, runs once per EVOLUTION_INTERVAL_MS (default 30 min).

import { getDb } from './db.js';

const KILL = String(process.env.MIMIR_EDGE_EVOLUTION || '').trim() === '0';
const EVOLUTION_INTERVAL_MS = parseInt(process.env.MIMIR_EDGE_EVOLUTION_INTERVAL_MS || '1800000', 10);
const MIN_ACCESS_DELTA = 3;
const STRENGTH_BUMP   = 0.02;

let _lastRunTs = 0;
let _intervalHandle = null;

const PATTERNS = {
  causal:        [/\b(causes?|leads to|results in|produces|because|therefore|so that)\b/i],
  contrastive:   [/\b(but|however|whereas|unlike|opposite|contrary)\b/i],
  hierarchical:  [/\b(part of|subset of|kind of|category|parent|child|extends|inherits)\b/i],
  temporal:      [/\b(before|after|during|then|next|previously|subsequent)\b/i],
};

function _classifyText(text) {
  const t = String(text || '').slice(0, 800);
  for (const [type, regs] of Object.entries(PATTERNS)) {
    for (const r of regs) if (r.test(t)) return type;
  }
  return 'associative';
}

export function evolveEdges({ limit = 50, dryRun = false } = {}) {
  if (KILL) return { ok: false, killed: true, promoted: 0 };
  const db = getDb();

  let candidates = [];
  try {
    candidates = db.prepare(`
      SELECT e.rowid AS rowid, e.source AS src, e.target AS dst,
             e.edge_type, e.strength, e.access_count,
             ns.l0 AS src_l0, nt.l0 AS dst_l0,
             ns.l1 AS src_l1, nt.l1 AS dst_l1
        FROM edges e
        JOIN nodes ns ON ns.id = e.source
        JOIN nodes nt ON nt.id = e.target
       WHERE COALESCE(e.edge_type, 'relates_to') IN ('relates_to', 'associative')
         AND COALESCE(e.access_count, 0) >= ?
         AND ns.state = 'active' AND nt.state = 'active'
         AND ns.superseded_at IS NULL AND nt.superseded_at IS NULL
       ORDER BY e.access_count DESC
       LIMIT ?
    `).all(MIN_ACCESS_DELTA, Math.max(1, Math.min(500, limit | 0)));
  } catch (e) {
    return { ok: false, error: e.message, promoted: 0 };
  }

  if (candidates.length === 0) {
    _lastRunTs = Date.now();
    return { ok: true, promoted: 0, candidates: 0 };
  }

  const promotions = { causal: 0, contrastive: 0, hierarchical: 0, temporal: 0, associative: 0 };
  const txn = db.transaction(() => {
    for (const c of candidates) {
      const combined = [c.src_l0, c.src_l1, c.dst_l0, c.dst_l1].filter(Boolean).join(' | ');
      const newType = _classifyText(combined);
      if (newType === 'associative' && c.edge_type === 'relates_to') {
        // Already a generic association; just bump strength.
        if (!dryRun) {
          try {
            db.prepare(`UPDATE edges SET strength = MIN(1.0, COALESCE(strength,0.5) + ?) WHERE rowid = ?`)
              .run(STRENGTH_BUMP, c.rowid);
          } catch {}
        }
        promotions.associative++;
        continue;
      }
      if (!dryRun) {
        try {
          db.prepare(`
            UPDATE edges
               SET edge_type = ?,
                   strength = MIN(1.0, COALESCE(strength,0.5) + ?)
             WHERE rowid = ?
          `).run(newType, STRENGTH_BUMP, c.rowid);
        } catch {}
      }
      promotions[newType] = (promotions[newType] || 0) + 1;
    }
  });
  try { txn(); }
  catch (e) { return { ok: false, error: e.message, promoted: 0 }; }
  _lastRunTs = Date.now();

  const total = Object.values(promotions).reduce((a, b) => a + b, 0);
  return { ok: true, promoted: total, by_type: promotions, candidates: candidates.length, dry_run: dryRun };
}

export function startEvolutionLoop() {
  if (KILL || _intervalHandle) return false;
  _intervalHandle = setInterval(() => {
    if (Date.now() - _lastRunTs < EVOLUTION_INTERVAL_MS) return;
    try { evolveEdges({}); }
    catch (e) { console.warn('[mimir-js edge-evolution] tick failed:', e.message); }
  }, EVOLUTION_INTERVAL_MS).unref();
  return true;
}

export function stopEvolutionLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function evolutionStatus() {
  return {
    enabled: !KILL,
    last_run: _lastRunTs ? new Date(_lastRunTs).toISOString() : null,
    interval_ms: EVOLUTION_INTERVAL_MS,
  };
}
