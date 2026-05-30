// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module mimir-resolver
 * @description Mímir Autonomy v2 — Layer 2 LLM-resolver SHADOW writer module.
 *
 * Per Plan MD §4.3 Layer 2 + §4.8 Operational Contract.
 *
 * Behavior:
 *   - off    → returns {verdict:'INSERT', skipped:'mode_off'}, no LLM, no DB
 *   - shadow → calls compact-tier worker, writes audit row, returns verdict; CALLER
 *              still does plain INSERT (resolver does not gate writes)
 *   - enforce → returns verdict for caller to act on (REVISE/CONSOLIDATE/SKIP)
 *
 * In-scope subkinds (per §4.3 v3 narrowing):
 *   outreach / diary / external_fetch_summary / curiosity_probe / resolver_canary
 * Anamnesis_summary writes go straight INSERT (high volume, low dupe rate).
 *
 * IMMUTABLE_NODE_IDS bridge (Permanent Slots): if any neighbor or edgeTarget
 * is in the immutable set, REVISE/SKIP/CONSOLIDATE flips to INSERT (per §5.13).
 * The audit row preserves the original LLM verdict in `candidate_text_hash`
 * column suffix to avoid schema churn.
 */

import crypto from 'node:crypto';

const RESOLVER_SUBKINDS = new Set([
  'outreach',
  'diary',
  'external_fetch_summary',
  'curiosity_probe',
  'resolver_canary',
]);

const VALID_VERDICTS = new Set(['INSERT', 'REVISE', 'CONSOLIDATE', 'SKIP']);

const RESOLVER_TIMEOUT_MS = 3000;
const RESOLVER_TOP_K = 5;
const RESOLVER_WINDOW_DAYS = 30;
// Empty default → router resolves via _role='worker' → roles.worker → compactModel.
const RESOLVER_MODEL = process.env.CONSTELLATION_RESOLVER_MODEL || '';

let liveBus = null;
try {
  const mod = await import('./live-bus.cjs');
  liveBus = mod.default || mod;
} catch {
  liveBus = { safeEmit: () => {} };
}

export class MimirResolver {
  #engine;
  #llm;
  #conversationsDb;
  #immutableNodeIds;
  #stmts = null;

  constructor({ engine, llm, conversationsDb, immutableNodeIds }) {
    if (!engine) throw new Error('MimirResolver: engine required');
    if (!llm || typeof llm.chat !== 'function') {
      throw new Error('MimirResolver: llm.chat required');
    }
    if (!conversationsDb) throw new Error('MimirResolver: conversationsDb required');
    this.#engine = engine;
    this.#llm = llm;
    this.#conversationsDb = conversationsDb;
    this.#immutableNodeIds = immutableNodeIds instanceof Set
      ? immutableNodeIds : new Set();
  }

  /**
   * Hot-reload IMMUTABLE_NODE_IDS (e.g. after dashboard updates permanent slots).
   */
  setImmutableNodeIds(set) {
    this.#immutableNodeIds = set instanceof Set ? set : new Set();
  }

  getMode() {
    // Default 'shadow' (audit-only, no graph mutation): safe to leave ON so we
    // accumulate verdict telemetry. Flip to 'enforce' only after 48h SHADOW
    // gate. Set MIMIR_RESOLVER_MODE=off to fully disable.
    const v = (process.env.MIMIR_RESOLVER_MODE || 'shadow').toLowerCase();
    if (v !== 'shadow' && v !== 'enforce') return 'off';
    return v;
  }

  #ensureStmts() {
    if (this.#stmts) return true;
    try {
      const exists = this.#conversationsDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='resolver_decisions'"
      ).get();
      if (!exists) return false;
      this.#stmts = {
        insert: this.#conversationsDb.prepare(`
          INSERT INTO resolver_decisions (
            ts, candidate_text_hash, candidate_subkind, top_k_neighbor_ids,
            verdict, model, role, latency_ms, enforced
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        statsByVerdict: this.#conversationsDb.prepare(`
          SELECT verdict, COUNT(*) AS cnt
          FROM resolver_decisions WHERE ts >= ?
          GROUP BY verdict
        `),
        statsBySubkind: this.#conversationsDb.prepare(`
          SELECT candidate_subkind AS subkind, verdict, COUNT(*) AS cnt
          FROM resolver_decisions WHERE ts >= ?
          GROUP BY candidate_subkind, verdict
        `),
        latencies: this.#conversationsDb.prepare(`
          SELECT latency_ms FROM resolver_decisions
          WHERE ts >= ? AND latency_ms IS NOT NULL
          ORDER BY latency_ms ASC
        `),
        canaryStats: this.#conversationsDb.prepare(`
          SELECT verdict, COUNT(*) AS cnt
          FROM resolver_decisions
          WHERE ts >= ? AND candidate_subkind='resolver_canary'
          GROUP BY verdict
        `),
      };
      return true;
    } catch (e) {
      console.warn(`[MimirResolver] stmt prep deferred: ${e.message}`);
      return false;
    }
  }

  /**
   * Main entry point. Returns verdict object regardless of mode.
   * In shadow: caller proceeds with plain INSERT (ignore verdict).
   * In enforce: caller acts on REVISE/CONSOLIDATE/SKIP.
   */
  async resolve({ text, embedding, subkind, ownerId, candidateNodeId, edgeTargets, pinned } = {}) {
    const t0 = Date.now();
    const mode = this.getMode();

    if (mode === 'off') {
      return { verdict: 'INSERT', finalVerdict: 'INSERT', skipped: 'mode_off', enforced: 0, latencyMs: 0 };
    }
    // Pinned exemption: anchor nodes + any caller-marked pinned node bypass the
    // resolver entirely. ENFORCE must never REVISE/CONSOLIDATE/SKIP these.
    if (pinned === true || subkind === 'anchor') {
      return { verdict: 'INSERT', finalVerdict: 'INSERT', skipped: 'pinned_exempt', enforced: 0, latencyMs: 0 };
    }
    if (!subkind || !RESOLVER_SUBKINDS.has(subkind)) {
      return { verdict: 'INSERT', finalVerdict: 'INSERT', skipped: 'subkind_out_of_scope', enforced: 0, latencyMs: 0 };
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { verdict: 'INSERT', finalVerdict: 'INSERT', skipped: 'empty_text', enforced: 0, latencyMs: 0 };
    }

    let neighbors = [];
    let llmVerdict = 'INSERT';
    let failKind = null; // null | 'embed_failed' | 'llm_timeout' | 'llm_error' | 'parse_failed'
    let originalVerdict = null;
    let immutableOverride = false;

    try {
      // Embed if not provided
      let embed = embedding;
      if (!embed || (Array.isArray(embed) && embed.length === 0)) {
        try {
          embed = await this.#engine._embed(text);
        } catch (e) {
          // Embedding failed → INSERT fail-safe (audit verdict EMBED_FAIL)
          return this.#audit({
            mode, subkind, text, neighbors: [], verdict: 'INSERT',
            failKind: 'embed_failed', t0, reason: 'embed_failed',
            errMsg: e?.message,
          });
        }
      }

      // Top-k self_act neighbors via vec0 (BUFFER 4× to allow post-filter)
      neighbors = this.#fetchTopKSelfActNeighbors(embed, ownerId);

      if (neighbors.length === 0) {
        // No prior self_act in scope → nothing to dedupe against
        return this.#audit({
          mode, subkind, text, neighbors: [], verdict: 'INSERT',
          t0, reason: 'no_neighbors',
        });
      }

      // LLM call with timeout
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), RESOLVER_TIMEOUT_MS);
      try {
        const prompt = this.#buildPrompt(text, subkind, neighbors);
        const resp = await this.#llm.chat(
          [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          {
            model: RESOLVER_MODEL || undefined,
            _role: 'worker',
            _trigger: 'mimir-resolver',
            _sessionId: 'mimir-resolver',
            _noFallback: true,
            temperature: 0,
            maxTokens: 80,
            signal: ctrl.signal,
          },
        );
        const respText = typeof resp === 'string' ? resp : (resp?.content || resp?.text || '');
        const parsed = this.#parseVerdict(respText);
        if (!parsed || !VALID_VERDICTS.has(parsed)) {
          failKind = 'parse_failed';
          llmVerdict = 'INSERT'; // fail-safe
        } else {
          llmVerdict = parsed;
        }
      } catch (e) {
        // Differentiate timeout (AbortController.abort) from other network/router errors
        const isAbort =
          ctrl.signal.aborted ||
          e?.name === 'AbortError' ||
          /abort/i.test(e?.message || '');
        failKind = isAbort ? 'llm_timeout' : 'llm_error';
        llmVerdict = 'INSERT';
      } finally {
        clearTimeout(timer);
      }

      // IMMUTABLE override: if neighbor or edgeTarget is permanent slot,
      // do not REVISE / SKIP / CONSOLIDATE — force INSERT to preserve identity.
      if (llmVerdict !== 'INSERT' && this.#immutableNodeIds.size > 0) {
        const touchesImmutable =
          neighbors.some(n => this.#immutableNodeIds.has(n.id)) ||
          (Array.isArray(edgeTargets) && edgeTargets.some(t => this.#immutableNodeIds.has(t)));
        if (touchesImmutable) {
          originalVerdict = llmVerdict;
          llmVerdict = 'INSERT';
          immutableOverride = true;
        }
      }

      return this.#audit({
        mode, subkind, text, neighbors, verdict: llmVerdict,
        failKind, originalVerdict, immutableOverride, t0,
      });
    } catch (e) {
      // Catastrophic — never let resolver throw upstream. Caller treats as INSERT.
      console.warn(`[MimirResolver] resolve failed: ${e.message}`);
      return { verdict: 'INSERT', skipped: 'resolver_error', enforced: 0, latencyMs: Date.now() - t0 };
    }
  }

  /**
   * Top-k self_act neighbors via vec0 KNN, post-filter by node_type/window/owner.
   * Bi-temporal read filter naturally applied via _bitemporalSqlClause if engine
   * provides it; otherwise plain state='active'.
   */
  #fetchTopKSelfActNeighbors(embedding, ownerId) {
    const out = [];
    try {
      const buf = embedding instanceof Buffer
        ? embedding
        : Buffer.from(new Float32Array(embedding).buffer);
      const vecRows = this.#engine.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      ).all(buf, RESOLVER_TOP_K * 4);

      const rowIdToNode = this.#engine.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
      const cutoffIso = new Date(Date.now() - RESOLVER_WINDOW_DAYS * 86400_000).toISOString();
      const baseSql = `
        SELECT id, l0, l1, subkind, owner_id, created_at
        FROM nodes
        WHERE id = ? AND node_type = 'self_act'
          AND state = 'active'
          AND created_at >= ?
      `;
      const ownerClause = ownerId ? ' AND owner_id = ?' : '';
      const stmt = this.#engine.db.prepare(baseSql + ownerClause);

      for (const v of vecRows) {
        if (out.length >= RESOLVER_TOP_K) break;
        const map = rowIdToNode.get(v.id);
        if (!map) continue;
        const params = ownerId
          ? [map.node_id, cutoffIso, ownerId]
          : [map.node_id, cutoffIso];
        const node = stmt.get(...params);
        if (!node) continue;
        const cosSim = 1 - (v.distance * v.distance) / 2;
        out.push({
          id: node.id,
          l0: node.l0,
          l1: node.l1,
          subkind: node.subkind,
          createdAt: node.created_at,
          cosSim,
        });
      }
    } catch (e) {
      console.warn(`[MimirResolver] neighbor fetch failed: ${e.message}`);
    }
    return out;
  }

  #buildPrompt(candidateText, subkind, neighbors) {
    const lines = neighbors.map((n, i) => {
      const summary = (n.l0 || n.l1 || '').toString().slice(0, 200);
      return `[${i + 1}] (cos=${n.cosSim.toFixed(2)}, ${n.subkind || 'self_act'}, ${n.createdAt})\n    ${summary}`;
    }).join('\n');

    return `New ${subkind} candidate:
"${candidateText.slice(0, 600)}"

Recent self-act memories (top-${neighbors.length} by cosine):
${lines}

Choose ONE verdict for the new candidate vs these neighbors:
- INSERT: genuinely new content, write as a new node
- REVISE: same proposition as a neighbor but with newer/refined info — supersede it
- CONSOLIDATE: substantially overlapping with a neighbor — merge text + bump weight
- SKIP: already covered, no value to write

Reply with exactly one word: INSERT | REVISE | CONSOLIDATE | SKIP`;
  }

  #parseVerdict(text) {
    if (typeof text !== 'string') return null;
    const m = text.toUpperCase().match(/\b(INSERT|REVISE|CONSOLIDATE|SKIP)\b/);
    return m ? m[1] : null;
  }

  #audit({ mode, subkind, text, neighbors, verdict, failKind, originalVerdict, immutableOverride, t0, reason, errMsg }) {
    const latencyMs = Date.now() - t0;
    const enforced = mode === 'enforce' ? 1 : 0;
    const role = 'worker';
    // Map failKind → audit-column verdict. Distinguishes infrastructure failures
    // (EMBED_FAIL, LLM_TIMEOUT, LLM_ERROR) from LLM-output failures (PARSE_FAIL).
    // Pre-phase1c collapsed all four into PARSE_FAIL, masking root cause.
    let finalVerdict = verdict;
    if (failKind === 'embed_failed') finalVerdict = 'EMBED_FAIL';
    else if (failKind === 'llm_timeout') finalVerdict = 'LLM_TIMEOUT';
    else if (failKind === 'llm_error') finalVerdict = 'LLM_ERROR';
    else if (failKind === 'parse_failed') finalVerdict = 'PARSE_FAIL';

    if (this.#ensureStmts()) {
      try {
        const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
        // Suffix orig verdict on hash to preserve audit trail without schema change
        let hashField = hash;
        if (immutableOverride && originalVerdict) {
          hashField = `${hash}|orig=${originalVerdict}`;
        } else if (reason) {
          hashField = `${hash}|r=${reason}`;
        }
        const neighborIds = JSON.stringify(neighbors.map(n => n.id));
        const ts = Math.floor(Date.now() / 1000);
        this.#stmts.insert.run(
          ts, hashField, subkind, neighborIds,
          finalVerdict, RESOLVER_MODEL || 'router-resolved', role, latencyMs, enforced,
        );
      } catch (e) {
        console.warn(`[MimirResolver] audit write failed: ${e.message}`);
      }
    }

    try {
      liveBus.safeEmit('mimir.resolver.decision', {
        mode, subkind, verdict: finalVerdict, latency_ms: latencyMs,
        neighbor_count: neighbors.length,
        immutable_override: !!immutableOverride,
      });
    } catch {}

    return {
      verdict, // For caller logic: PARSE_FAIL not surfaced — INSERT semantics
      finalVerdict,
      enforced,
      latencyMs,
      neighborIds: neighbors.map(n => n.id),
      immutableOverride: !!immutableOverride,
      originalVerdict,
    };
  }

  /**
   * Aggregated stats for /api/resolver/stats and dashboard panel.
   */
  getStats({ windowMs = 86_400_000 } = {}) {
    if (!this.#ensureStmts()) {
      return { ok: false, reason: 'table_unavailable' };
    }
    const cutoff = Math.floor((Date.now() - windowMs) / 1000);
    const verdictRows = this.#stmts.statsByVerdict.all(cutoff);
    const verdicts = {
      INSERT: 0, REVISE: 0, CONSOLIDATE: 0, SKIP: 0,
      PARSE_FAIL: 0, EMBED_FAIL: 0, LLM_TIMEOUT: 0, LLM_ERROR: 0,
    };
    for (const r of verdictRows) {
      if (r.verdict in verdicts) verdicts[r.verdict] = r.cnt;
      else verdicts[r.verdict] = r.cnt;
    }

    const subRows = this.#stmts.statsBySubkind.all(cutoff);
    const bySubkind = {};
    for (const r of subRows) {
      const k = r.subkind || '(null)';
      if (!bySubkind[k]) bySubkind[k] = {};
      bySubkind[k][r.verdict] = r.cnt;
    }

    const latRows = this.#stmts.latencies.all(cutoff);
    const latency = this.#computePercentiles(latRows.map(r => r.latency_ms));

    const canaryRows = this.#stmts.canaryStats.all(cutoff);
    let canarySkip = 0, canaryTotal = 0;
    for (const r of canaryRows) {
      canaryTotal += r.cnt;
      if (r.verdict === 'SKIP') canarySkip += r.cnt;
    }
    const canarySkipRate = canaryTotal > 0 ? canarySkip / canaryTotal : null;

    return {
      ok: true,
      mode: this.getMode(),
      window_ms: windowMs,
      verdicts,
      latency_ms: latency,
      by_subkind: bySubkind,
      canary: { skip_rate: canarySkipRate, count: canaryTotal },
    };
  }

  #computePercentiles(arr) {
    if (!arr || arr.length === 0) return { p50: null, p95: null, p99: null };
    const pick = (p) => arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))];
    return { p50: pick(0.50), p95: pick(0.95), p99: pick(0.99) };
  }

  /**
   * Explicit diagnostic canary: submit a fixed-content
   * `subkind='resolver_canary'` candidate through resolver audit only.
   *
   * This is not auto-started from main.js. Synthetic heartbeat telemetry can
   * look like real resolver traffic, and older canary node writes polluted the
   * user-visible star map. Node writes remain opt-in via
   * MIMIR_RESOLVER_CANARY_NODES=1 for rare forensic diagnostics.
   */
  #canaryTimer = null;
  startCanary({ intervalMs = 3600_000, ownerId = 'self' } = {}) {
    if (this.#canaryTimer) return;
    if (this.getMode() === 'off') {
      console.log('[MimirResolver] canary not started (mode=off)');
      return;
    }
    const tick = async () => {
      if (this.getMode() === 'off') return; // mode toggled off live
      const today = new Date().toISOString().slice(0, 10);
      const text = `Resolver canary heartbeat — ${today}`;
      try {
        const r = await this.resolve({
          text, subkind: 'resolver_canary', ownerId, edgeTargets: [],
        });
        // Write a canary node only when the resolver wouldn't dedup it
        // (i.e. first hour of the day when there is no prior). In ENFORCE
        // mode, REVISE/CONSOLIDATE/SKIP also indicate "neighbor exists".
        const finalV = r.finalVerdict || r.verdict;
        // Canary nodes pollute the user-visible star map, so we no longer
        // commit them in OSS — telemetry stays in resolver_decisions, the
        // node row was the dashboard-noise source. Opt back in with
        // MIMIR_RESOLVER_CANARY_NODES=1 if we ever need to inspect drift.
        if (process.env.MIMIR_RESOLVER_CANARY_NODES === '1' && (finalV === 'INSERT' || (r.skipped === 'no_neighbors'))) {
          try {
            await this.#engine.remember({
              id: `resolver-canary-${today}-${Math.floor(Date.now() / 1000)}`,
              l0: text, l1: text, l2: text,
              tags: ['resolver-canary'],
              source: 'autonomous:resolver-canary',
              node_type: 'self_act',
              subkind: 'resolver_canary',
              skipDedup: true,
              weight: 0.1,
            });
          } catch { /* canary write may collide on dedup, that's fine */ }
        }
        // Alarm: window 24h, after first hour, expect SKIP > 80%
        const stats = this.getStats({ windowMs: 86_400_000 });
        if (stats?.canary && stats.canary.count >= 2) {
          const skipRate = stats.canary.skip_rate ?? 0;
          if (skipRate < 0.80) {
            try {
              liveBus.safeEmit('mimir.canary.alert', {
                skip_rate: skipRate, count: stats.canary.count, window_h: 24,
              });
            } catch {}
            console.warn(`[MimirResolver] canary alarm: skip_rate=${skipRate.toFixed(2)} count=${stats.canary.count}`);
          }
        }
      } catch (e) {
        console.warn(`[MimirResolver] canary tick failed: ${e.message}`);
      }
    };
    this.#canaryTimer = setInterval(tick, intervalMs);
    if (typeof this.#canaryTimer.unref === 'function') this.#canaryTimer.unref();
    // Fire one immediately at startup so the first hour gets a sample.
    setTimeout(tick, 5_000).unref?.();
    console.log(`[MimirResolver] canary started (interval=${intervalMs}ms)`);
  }

  stopCanary() {
    if (this.#canaryTimer) clearInterval(this.#canaryTimer);
    this.#canaryTimer = null;
  }
}

const SYSTEM_PROMPT = `You are a memory-write resolver for an autonomous agent's self-act log.
You judge whether a new self-act candidate is novel relative to recent neighbors.
You return EXACTLY one verdict word: INSERT, REVISE, CONSOLIDATE, or SKIP.
Be strict: prefer SKIP over INSERT when content is substantively repetitive.
Prefer REVISE when the candidate is an updated version of a specific neighbor.
Prefer CONSOLIDATE when the candidate adds nuance to several near-duplicates.`;

export default MimirResolver;
