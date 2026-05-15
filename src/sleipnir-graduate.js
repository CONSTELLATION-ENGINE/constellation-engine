// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir Step 6 — Quarantine Graduation (2026-04-29)
// Plan §5.1: hourly cron flips dormant Sleipnir nodes ≥72h old to active.
//   state='dormant' + tag 'sleipnir-quarantine'  →
//   state='active'  + tag 'experiential-graduated'
//
// Both SA pool loader (mimir_daemon.py:1789 WHERE state='active') and main
// IR pool reader (agent-runtime.js:1790 state='active') filter dormant out
// for free, so the quarantine is essentially zero-cost.

const QUARANTINE_HOURS = 72;
const BATCH_SIZE       = 50;

export class SleipnirGraduate {
  #engine = null;
  #enabled = true;

  init({ engine }) {
    this.#engine = engine;
    if (!engine?.db) this.#enabled = false;
  }

  isEnabled() { return this.#enabled; }

  /**
   * One graduation pass. Returns telemetry summary.
   * Idempotent: rows whose ts is older than 72h AND tag includes
   * 'sleipnir-quarantine' get flipped; subsequent runs see no matches.
   */
  runOnce() {
    if (!this.#enabled) return { skipped: 'disabled', graduated: 0 };
    if (process.env.ENGINE_SLEIPNIR_GRADUATE_ENABLED === '0') {
      return { skipped: 'disabled-env', graduated: 0 };
    }

    const db = this.#engine.db;
    const cutoffMs = Date.now() - QUARANTINE_HOURS * 3600_000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // Select first; SQLite has no native string REPLACE in UPDATE that we can
    // batch + audit cleanly, so do select → JS-side tag rewrite → UPDATE per row.
    let candidates;
    try {
      candidates = db.prepare(`
        SELECT id, tags
        FROM nodes
        WHERE state = 'dormant'
          AND tags LIKE '%sleipnir-quarantine%'
          AND created_at <= ?
        LIMIT ?
      `).all(cutoffIso, BATCH_SIZE);
    } catch (e) {
      return { skipped: 'select-failed', error: e.message, graduated: 0 };
    }

    if (candidates.length === 0) return { graduated: 0, scanned: 0 };

    const updateNode = db.prepare(`
      UPDATE nodes
      SET state = 'active', weight = 1.0, tags = ?, accessed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'dormant'
    `);
    const nowIso = new Date().toISOString();
    let graduated = 0, errors = 0;

    const txn = db.transaction(() => {
      for (const c of candidates) {
        let tagArr = [];
        try { tagArr = JSON.parse(c.tags || '[]'); } catch { tagArr = []; }
        const next = tagArr
          .filter(t => t !== 'sleipnir-quarantine')
          .concat(tagArr.includes('experiential-graduated') ? [] : ['experiential-graduated']);
        try {
          const r = updateNode.run(JSON.stringify(next), nowIso, nowIso, c.id);
          if (r.changes > 0) graduated++;
        } catch {
          errors++;
        }
      }
    });

    try {
      txn();
    } catch (e) {
      return { graduated: 0, error: e.message, scanned: candidates.length };
    }

    return { graduated, scanned: candidates.length, errors };
  }
}

export const sleipnirGraduate = new SleipnirGraduate();
