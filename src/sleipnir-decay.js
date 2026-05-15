// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — Three-channel decay (Step 6, 2026-04-29)
// Plan §6 Step 6: every 30-min sweep, age accepted experiential anchors via:
//   1. Time-decay channel — adaptive half-life based on confidence
//      (high-conf anchors decay slower: t½ = BASE_HALF_LIFE_DAYS / (1 - conf))
//   2. Git-mtime channel — if region maps to a path under WORKDIR_PREFIX and
//      that file was modified after last_refreshed_at, halve effective_strength
//   3. 5%-cron sample — sample 5% of accepted rows per cycle for cost control
//      (full table scan would re-stat hundreds of files per cycle)
//
// Anchors below MIN_STRENGTH transition state='aged_out' and stop appearing in
// IR injection (sleipnir-ir-inject.js filters state='accepted' only).

import fs from 'node:fs';
import path from 'node:path';
import { WORKDIR_PREFIX } from './sleipnir-constants.js';
import liveBus from './live-bus.cjs';

const BASE_HALF_LIFE_DAYS = 14;
const MIN_STRENGTH = 0.30;
const SAMPLE_FRACTION = 0.05;       // 5% of accepted rows per cycle
const MIN_SAMPLE_SIZE = 4;          // always sample at least this many
const GIT_MTIME_PENALTY = 0.5;      // halve strength if source moved
const ONE_DAY_MS = 24 * 3600_000;

function timeDecayFactor(ageMs, conf) {
  // Half-life in days; higher conf → longer half-life. Clamp conf into [0.5, 0.9]
  // so we never get a divide-by-zero or absurd half-life.
  const c = Math.max(0.5, Math.min(0.9, Number(conf) || 0.5));
  const halfLifeDays = BASE_HALF_LIFE_DAYS / (1 - c + 0.1); // 0.5→17.5d, 0.9→70d
  const ageDays = ageMs / ONE_DAY_MS;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function regionToPath(region) {
  if (!region || typeof region !== 'string') return null;
  // Region format from aggregator is the bucketed path produced by sleipnir-trail.
  // Most are file:src/foo.js or path:src/foo.js style; some are bare relative paths.
  const cleaned = region.replace(/^(file|path|repo):/, '');
  if (cleaned.includes('://')) return null;    // web fetches — skip
  // Reject path traversal — only allow paths inside WORKDIR_PREFIX
  const abs = path.resolve(WORKDIR_PREFIX, cleaned);
  if (!abs.startsWith(WORKDIR_PREFIX)) return null;
  return abs;
}

function getFileMtimeMs(absPath) {
  try {
    const st = fs.statSync(absPath);
    return st.mtimeMs;
  } catch { return null; }
}

export class SleipnirDecay {
  #engine = null;
  #enabled = true;

  init({ engine }) {
    this.#engine = engine;
    if (!engine?.db) { this.#enabled = false; return; }
  }

  /**
   * One sweep pass. Reads a sample of state='accepted' rows, applies the three
   * decay channels, persists effective_strength, ages out anchors below MIN.
   * Returns telemetry summary.
   */
  runOnce({ now = Date.now() } = {}) {
    if (!this.#enabled) return { skipped: 'disabled', processed: 0 };

    let total;
    try {
      total = this.#engine.db.prepare(`
        SELECT COUNT(*) AS c FROM experiential_pending_review WHERE state = 'accepted'
      `).get().c;
    } catch { return { skipped: 'query_failed', processed: 0 }; }

    if (total === 0) return { processed: 0, total: 0, aged_out: 0 };

    const sampleSize = Math.max(MIN_SAMPLE_SIZE, Math.ceil(total * SAMPLE_FRACTION));
    let rows;
    try {
      rows = this.#engine.db.prepare(`
        SELECT review_id, candidate_id, region, proposed_at, last_refreshed_at,
               refresh_count, effective_strength, notes
        FROM experiential_pending_review
        WHERE state = 'accepted'
        ORDER BY RANDOM()
        LIMIT ?
      `).all(sampleSize);
    } catch { return { skipped: 'sample_failed', processed: 0 }; }

    const update = this.#engine.db.prepare(`
      UPDATE experiential_pending_review
      SET effective_strength = ?, state = ?, notes = ?
      WHERE review_id = ?
    `);

    let agedOut = 0, decayed = 0, gitDecayed = 0, refreshed = 0;
    for (const r of rows) {
      const conf = (() => {
        try { const n = JSON.parse(r.notes || '{}'); return Number(n.confidence) || 0.7; } catch { return 0.7; }
      })();
      const lastRef = r.last_refreshed_at || r.proposed_at;
      const ageMs = Math.max(0, now - lastRef);
      let strength = Number(r.effective_strength);
      if (!Number.isFinite(strength) || strength <= 0) strength = conf;

      // Channel 1: time decay
      const tFactor = timeDecayFactor(ageMs, conf);
      const beforeTime = strength;
      strength = strength * tFactor;
      if (strength < beforeTime - 1e-6) decayed++;

      // Channel 2: git-mtime — only meaningful if region resolves to a real path
      const absPath = regionToPath(r.region);
      if (absPath) {
        const mtime = getFileMtimeMs(absPath);
        if (mtime && mtime > lastRef) {
          strength = strength * GIT_MTIME_PENALTY;
          gitDecayed++;
        }
      }

      // Channel 3: refresh boost — recent injection touches add a small bump
      // (refresh_count is bumped by the IR injector on render). Cap at 1.0.
      if (r.refresh_count && r.refresh_count > 0) {
        const bump = Math.min(0.2, r.refresh_count * 0.02);
        strength = Math.min(1.0, strength + bump);
        refreshed++;
      }

      strength = Math.max(0, Math.min(1.0, strength));

      let nextState = 'accepted';
      let newNotes = r.notes;
      if (strength < MIN_STRENGTH) {
        nextState = 'aged_out';
        agedOut++;
        try {
          const n = r.notes ? JSON.parse(r.notes) : {};
          n.aged_out_at = now;
          n.aged_out_strength = Number(strength.toFixed(4));
          newNotes = JSON.stringify(n);
        } catch { newNotes = JSON.stringify({ aged_out_at: now, aged_out_strength: Number(strength.toFixed(4)) }); }
      }

      try {
        update.run(strength, nextState, newNotes, r.review_id);
      } catch { /* per-row failure is non-fatal */ }
    }

    const summary = {
      processed: rows.length,
      total,
      aged_out: agedOut,
      time_decayed: decayed,
      git_decayed: gitDecayed,
      refresh_boosted: refreshed,
    };

    // Live tab visibility — only emit when something actually moved (skip silent no-ops)
    if (agedOut > 0 || decayed > 0 || gitDecayed > 0 || refreshed > 0) {
      try { liveBus.safeEmit?.('sleipnir.decay', { ...summary, ts: now }); } catch { /* */ }
    }

    return summary;
  }

  /**
   * Dashboard snapshot: counts by state + recent decay telemetry.
   */
  getSnapshot() {
    if (!this.#enabled) return null;
    try {
      const states = this.#engine.db.prepare(`
        SELECT state, COUNT(*) AS c
        FROM experiential_pending_review
        GROUP BY state
      `).all();
      const subtypes = this.#engine.db.prepare(`
        SELECT subtype, COUNT(*) AS c
        FROM experiential_pending_review
        WHERE state = 'accepted'
        GROUP BY subtype
      `).all();
      const strengthDist = this.#engine.db.prepare(`
        SELECT
          AVG(effective_strength) AS avg_strength,
          MIN(effective_strength) AS min_strength,
          MAX(effective_strength) AS max_strength
        FROM experiential_pending_review
        WHERE state = 'accepted' AND effective_strength IS NOT NULL
      `).get();
      return { states, subtypes, strength: strengthDist };
    } catch { return null; }
  }
}

export const sleipnirDecay = new SleipnirDecay();
