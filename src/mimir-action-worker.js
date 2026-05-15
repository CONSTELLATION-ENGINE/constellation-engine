// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Action Worker — drains pending mimir_actions rows and executes
// Reflection / Curation / Tension / Profile / Fetch / Outreach modes
// (master plan §10 "Action execution path").
//
// The Mímir daemon picks the mode and target via topology features (zero LLM
// in the discharge loop) and writes a row with status='pending'. This worker
// drains the queue, calls an LLM translator per mode with full persona +
// pool + IR injection (synthetic mimir-* sessionIds skip L4 raw conversation
// history but keep L1 persona, L2 preamble, L3 constellation+pool), writes
// the result to the star map via existing engine APIs, and updates the row.
//
// Identity: every drained action runs inside runWithIdentity({channel:
// 'autonomous', speakerId: 'autonomous:self', isOwner:true}) so engine
// _resolveOwnerStamp() lands on STAR_MAP_OWNER='self' deterministically
// (peer-review E — never rely on the fallback).

import { createHash } from 'node:crypto';
import { runWithIdentity } from './user-identity.js';
import liveBus from './live-bus.cjs';
import { MimirEnvironmentalIR } from './mimir-environmental-ir.js';
import { MimirPrecommitCritic } from './mimir-precommit-critic.js';
import { shouldSuppress as mainActiveSuppress } from './mimir-main-active-gate.js';
// Public-Critic safety gate — Stage 1 deterministic checks (PII, banned handles,
// link shorteners, URL hygiene). Default-on, kill-switch via MIMIR_V5_CRITIC=0.
// Every verdict is logged to mimir_critic_log so the hourly demotion sweep
// (scripts/mimir-js/outreach-health.js) has reliable signal even before any
// public-facing personas are configured.
import { criticGate as _publicCriticGate, logCriticVerdict as _logPublicCriticVerdict }
  from '../scripts/mimir-js/critic.js';

const DRAIN_INTERVAL_MS    = 30_000;
const ZOMBIE_AGE_MS        = 16 * 60_000;       // > LLM_TIMEOUT_MS so a worker
                                                 // restart mid-call doesn't false-
                                                 // fail an in-flight legitimate row.
// LLM + IR injection runs ~5-10s/call typically, but provider/proxy latency varies
// and any "thinking-style" model response can legitimately stretch.
// Per user: prefer a hard token cap over an aggressive wall-clock — kill only
// runaway/zombie calls (matches the unified 15-minute LLM ceiling we use
// elsewhere). Real cost limit is LLM_MAX_TOKENS below; this only kills hangs.
const LLM_TIMEOUT_MS       = 900_000;            // 15 min — hang detector only
// Token cap for autonomy synthesis. Default 16k gives reflection/curation/tension/
// profile/fetch ~27× more room than the prior 600 cap — full structured output
// without truncation, while staying under typical provider per-request max_tokens
// ceilings (most balanced-tier models accept 8k by default, often more with an
// extended-output header). The real spend brake
// is per-mode discharge cost + daily caps + queue backpressure, not this cap.
// Env override (MIMIR_LLM_MAX_TOKENS) for user on extended-output models.
const LLM_MAX_TOKENS       = (() => {
  const raw = process.env.MIMIR_LLM_MAX_TOKENS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 16_000;
})();

// Anti-repetition (L1+L2) — user 2026-04-26.
// L1: prepend "RECENT MIMIR ACTIONS (last 5h)" preamble to user prompt so
// the LLM sees what it (or a sibling action) just wrote — discourages re-synthesis.
// L2: pre-commit BGE cosine check against last-5h autonomous-mimir nodes;
// abort + mark stale if any candidate cosSim ≥ L2_DEDUP_COSINE.
const L1_PREAMBLE_HOURS    = 5;
const L1_PREAMBLE_LIMIT    = 15;
const L2_DEDUP_HOURS       = 5;
const L2_DEDUP_COSINE      = 0.92;
const L2_KNN_LIMIT         = 50;       // KNN-then-post-filter pattern (vec0 MATCH is rowid-only)
// Per-mode LLM model. Provider-neutral: when undefined, the LLM router falls
// through to its configured primary/compact tier. Override per env to pin a
// specific model id (any identifier the active provider accepts).
const REFLECTION_MODEL     = process.env.MIMIR_REFLECTION_MODEL || undefined;
const CURATION_MODEL       = process.env.MIMIR_CURATION_MODEL   || undefined;
const FREE_MODEL           = process.env.MIMIR_FREE_MODEL       || undefined;
// Valid actions per plan §2.4 (free-form output schema).
const FREE_VALID_ACTIONS = new Set(['silent', 'share', 'question', 'observation']);
// Per-action emoji prefix for the outreach POST (plan §2.4). Diary stays
// internal so no emoji needed for 'observation'; share/question hit Telegram.
const FREE_EMOJI = { share: '💭', question: '❓' };
const DRAIN_BATCH_LIMIT    = 2;
const VALID_EDGE_TYPES = new Set([
  'causal', 'contrastive', 'hierarchical', 'associative', 'temporal',
  'resolves', 'contradicts',
]);

// Edge Evolution v1 (2026-04-26) — closed 35-fine-type subset, must stay in sync with
// engine.cjs FINE_TYPES_BY_COARSE. We don't import from engine because worker accesses
// engine via #engine handle (not a require), and inline lookups are hot-path.
const FINE_TYPES_BY_COARSE = {
  causal:        new Set(['enables', 'prevents', 'requires', 'triggers', 'undermines', 'mitigates', 'explains']),
  contrastive:   new Set(['contradicts', 'challenges', 'refines', 'narrows', 'generalizes', 'tension', 'alternative']),
  hierarchical:  new Set(['contains', 'specializes', 'exemplifies', 'aggregates', 'decomposes', 'is_a', 'part_of']),
  associative:   new Set(['co_occurs', 'reminiscent_of', 'inspires', 'resonates', 'parallels', 'evokes', 'contextualizes']),
  temporal:      new Set(['precedes', 'follows', 'concurrent', 'triggers_next', 'culminates_in', 'preempts', 'recurs']),
};

// Edge Evolution config gates (env-driven, OSS defaults: refine/rejudge ON, cleanup OFF)
const EDGE_REFINE_ON       = process.env.MIMIR_EDGE_REFINE !== 'off';
const EDGE_REJUDGE_ON      = process.env.MIMIR_EDGE_REJUDGE !== 'off';
const EDGE_REJUDGE_RATE    = (() => { const r = parseFloat(process.env.MIMIR_EDGE_REJUDGE_RATE || '0.3'); return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.3; })();
const EDGE_FLAG_STALE_LOG  = process.env.MIMIR_EDGE_FLAG_STALE_LOG !== 'off';
const EDGE_CLEANUP_ON      = process.env.MIMIR_EDGE_CLEANUP === 'on';  // default OFF; today not read
const PROTECTED_NODE_TAGS  = new Set(['identity', 'principle', 'permanent-slot', 'lesson']);
const HOP2_DEGREE_MIN      = 3;
const HOP2_AGE_DAYS_MIN    = 7;
const HOP2_MAX_CANDIDATES  = 2;
const EDGE_ACTION_COOLDOWN_HOURS = 24;

// Step 8 — Arousal α modulation bounds (must match arousal-detector.js + daemon).
const AROUSAL_MIN = 0.5;
const AROUSAL_MAX = 2.0;
const AROUSAL_DEFAULT = 1.0;

// Helper: scale a base [0..1] strength/weight by alpha, clamped to remain valid.
// alpha=1 → unchanged, alpha=2 → ×2 (saturates at 1.0), alpha=0.5 → ×0.5.
function scaleByArousal(value, alpha, max = 1.0) {
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0) return value;
  const clamped = Math.min(AROUSAL_MAX, Math.max(AROUSAL_MIN, alpha));
  return Math.min(max, Math.max(0.0, value * clamped));
}

function readAlphaFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return AROUSAL_DEFAULT;
  const raw = payload.alpha;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return AROUSAL_DEFAULT;
  return Math.min(AROUSAL_MAX, Math.max(AROUSAL_MIN, raw));
}

// Profile dimension constants retired with v3 (2026-04-30) — Anamnesis is the
// canonical profile writer. Profile-gap context now flows into the v3
// action-picker prompt as a hint so the LLM may choose `outreach`.
const TENSION_MODEL    = process.env.MIMIR_TENSION_MODEL  || undefined;
const FETCH_MODEL      = process.env.MIMIR_FETCH_MODEL    || undefined;
const OUTREACH_MODEL   = process.env.MIMIR_OUTREACH_MODEL || undefined;

// Step 6: per-domain allowlist for autonomous fetches. Worker-side filter
// only — does NOT affect user-initiated web_fetch tool calls. CSV env override
// MIMIR_FETCH_DOMAIN_ALLOWLIST replaces (does not extend) the default.
// Coverage spans Academic, Reference, Tech, Science/Health, News, Books/Film,
// Reddit, Sports, Food, Travel — broad enough that picker isn't boxed into
// arxiv-only "what kind of LLM is this" loops. Twitter/X intentionally absent
// (anonymous fetch blocked).
const FETCH_DEFAULT_ALLOWLIST = Object.freeze([
  // Academic / papers (server-fetchable abstracts/full-text only — paywalled
  // sciencedirect/jstor dropped to avoid wasted LLM calls on 401/403)
  'arxiv.org', 'scholar.google.com', 'semanticscholar.org',
  'plos.org', 'nature.com',
  // Reference
  'en.wikipedia.org', 'wikivoyage.org', 'britannica.com',
  'merriam-webster.com', 'ourworldindata.org',
  'stanford.edu', 'mit.edu',
  // Tech / docs
  'developer.mozilla.org', 'docs.python.org', 'github.com',
  'stackoverflow.com', 'hn.algolia.com', 'news.ycombinator.com',
  // Science / health
  'nih.gov', 'nlm.nih.gov', 'who.int', 'cdc.gov', 'mayoclinic.org',
  // News / culture (NYT dropped — aggressive paywall + bot wall)
  'bbc.com', 'bbc.co.uk', 'npr.org', 'reuters.com',
  'theguardian.com',
  // Books / film / music
  'imdb.com', 'rottentomatoes.com', 'goodreads.com',
  'letterboxd.com', 'allmusic.com',
  // Community
  'reddit.com', 'old.reddit.com',
  // Sports
  'espn.com',
  // Food
  'allrecipes.com', 'seriouseats.com',
  // Travel / maps
  'lonelyplanet.com', 'openstreetmap.org',
]);
function getFetchAllowlist() {
  const env = (process.env.MIMIR_FETCH_DOMAIN_ALLOWLIST || '').trim();
  if (!env) return new Set(FETCH_DEFAULT_ALLOWLIST);
  return new Set(env.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
function domainAllowed(url, allowlist) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const allowed of allowlist) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return true;
    }
    return false;
  } catch { return false; }
}

// Step 7: bridge URL for outreach (Node engine dashboard). Worker POSTs to
// /api/mimir/outreach which calls bot.sendMessage(founderChatId, text).
const ENGINE_OUTREACH_URL = (process.env.ENGINE_INTERNAL_URL || 'http://127.0.0.1:18800').replace(/\/$/, '') + '/api/mimir/outreach';

// Silence toggle: when MIMIR_AUTONOMY_SILENCE_OUTPUTS=1, suppress fire_v3
// Telegram POSTs and dashboard chat broadcasts. DB writes (diary, nodes,
// engine.mimir_action lifecycle) still happen so observation panels stay
// accurate. Dashboard sets this env var directly when it sees the toggle in
// /api/mimir/config POST body (engine + worker share the same process).
function isSilenced() {
  return String(process.env.MIMIR_AUTONOMY_SILENCE_OUTPUTS || '').trim() === '1';
}

// Synthetic CurrentUser: routes through ALS so engine.remember /
// addEdges resolve owner_id='self'. isAutonomous=true keeps any future
// channel-aware code paths from misclassifying these writes as human.
const AUTONOMOUS_USER = Object.freeze({
  sessionId:    'mimir-action-worker',
  channel:      'autonomous',
  participant:  'self',
  speakerId:    'autonomous:self',
  isOwner:      true,
  isSystem:     true,
  isAutonomous: true,
  isCron:       false,
  isHuman:      false,
});

export class MimirActionWorker {
  #engine;
  #conversationsDb;
  #convStore = null;
  #llm;
  #runtime;
  #resolver;
  #ir = null;
  #critic = null;
  #timer = null;
  #running = false;
  #enabled = false;
  #stmts = null;

  constructor({ engine, conversationsDb, convStore, llm, runtime, resolver }) {
    if (!engine) throw new Error('MimirActionWorker: engine required');
    if (!conversationsDb) throw new Error('MimirActionWorker: conversationsDb required');
    if (!llm || typeof llm.chat !== 'function') {
      throw new Error('MimirActionWorker: llm.chat required');
    }
    this.#engine = engine;
    this.#conversationsDb = conversationsDb;
    this.#convStore = convStore || null;
    this.#llm = llm;
    // runtime is optional — if absent, worker degrades to flat-prompt calls
    // (no persona/pool/IR injection). Main.js wires it; tests may omit.
    this.#runtime = (runtime && typeof runtime.buildSystemPrompt === 'function')
      ? runtime : null;
    this.#resolver = (resolver && typeof resolver.resolve === 'function') ? resolver : null;
    // Wave 1 v2: 5-layer environmental IR compiler. Lazy — only used by
    // #handleFreeReaction. Construction is cheap (no DB I/O until compile()).
    try {
      this.#ir = new MimirEnvironmentalIR({
        engine: this.#engine,
        conversationsDb: this.#conversationsDb,
      });
    } catch (e) {
      console.warn(`[MimirActionWorker] IR compiler init failed: ${e.message} (free mode degraded)`);
      this.#ir = null;
    }
    // Wave 3 Phase 7: Pre-commit critic (default OFF — env-gated inside the
    // module). When ON, called before outreach send and external_fetch write.
    try {
      this.#critic = new MimirPrecommitCritic({ llm: this.#llm });
    } catch (e) {
      console.warn(`[MimirActionWorker] critic init failed: ${e.message} (will skip critique)`);
      this.#critic = null;
    }
  }

  // Cosine→Resolver bridge. Single dedup gate that mode-switches the algorithmic
  // L2 cosine PK and the LLM-resolver. Behavior matrix:
  //   off:     cosine only (legacy path)
  //   shadow:  cosine decides + resolver audits async (no enforcement)
  //   enforce: resolver decides — single-gate, NOT cosine-then-resolver. The
  //            design intent is that resolver subsumes cosine (it sees the
  //            same KNN neighbors plus subkind context). Cosine is fallback
  //            ONLY when resolver throws.
  // Returns { action: 'PROCEED'|'SUPPRESS', existingId?, cosSim?, verdict?, source }
  // skipCosine=true is for self_act paths where we want resolver-only semantics
  // (outreach/free) — cosine still runs as fallback on resolver throw in enforce.
  async #bridgedDedup({ subkind, l0, l1, ownerId, edgeTargets = [], skipCosine = false }) {
    const mode = this.#resolver?.getMode?.() || 'off';
    const text = `${l0 || ''}\n${l1 || ''}`.trim();

    if (mode === 'enforce' && this.#resolver) {
      try {
        const r = await this.#resolver.resolve({ text, subkind, ownerId, edgeTargets });
        const action = this.#mapResolverVerdict(r.verdict);
        if (action === 'SUPPRESS') {
          // Resolver doesn't pick a single targetId; the top KNN neighbor is
          // the closest semantic match and the most useful breadcrumb.
          const existingId = Array.isArray(r.neighborIds) && r.neighborIds.length > 0
            ? r.neighborIds[0] : null;
          return { action, existingId, verdict: r.verdict, source: 'resolver' };
        }
        return { action: 'PROCEED', source: 'resolver' };
      } catch (e) {
        console.warn(`[MimirActionWorker] resolver enforce errored (${e.message}); cosine fallback`);
      }
    }

    if (!skipCosine) {
      const dedup = await this.#checkL2Dedup(l0, l1, ownerId);
      if (dedup.collision) {
        if (mode === 'shadow' && this.#resolver) {
          this.#resolver.resolve({ text, subkind, ownerId, edgeTargets }).catch(() => {});
        }
        return { action: 'SUPPRESS', existingId: dedup.existingId, cosSim: dedup.cosSim, source: 'cosine' };
      }
    }

    if (mode === 'shadow' && this.#resolver) {
      try { await this.#resolver.resolve({ text, subkind, ownerId, edgeTargets }); } catch { /* fail-open */ }
    }
    return { action: 'PROCEED', source: mode === 'off' ? 'pass' : 'shadow' };
  }

  // Main-active gate: yield to user when the founder channel saw activity
  // recently. Subkind drives the threshold (10min for free/curiosity_probe,
  // 60min for outreach/external_fetch). Skip-this-tick — caller marks the
  // row stale, no requeue. Service-layer paths (cron/anamnesis/consolidation)
  // do NOT call this.
  #checkMainActiveGate(subkind, ownerId) {
    if (!this.#convStore) return { suppress: false };
    return mainActiveSuppress({
      convStore: this.#convStore,
      subkind,
      now: Date.now(),
      ownerId: ownerId || null,
    });
  }

  #mapResolverVerdict(v) {
    // INSERT/REVISE → PROCEED (write the new node; supersede chain handled by writer)
    // SKIP/CONSOLIDATE → SUPPRESS (existing node is sufficient)
    if (v === 'SKIP' || v === 'CONSOLIDATE') return 'SUPPRESS';
    return 'PROCEED';
  }

  start() {
    if (this.#enabled) return;
    if (process.env.MIMIR_ACTION_WORKER_ENABLE === '0') {
      console.log('[MimirActionWorker] disabled via MIMIR_ACTION_WORKER_ENABLE=0');
      return;
    }
    this.#enabled = true;
    // Stmts are prepared lazily on first tick — the Mímir daemon owns the
    // mimir_actions DDL, and the engine may start before the daemon has
    // bootstrapped tables on a fresh install.
    this.#timer = setInterval(() => this.#tick(), DRAIN_INTERVAL_MS);
    if (typeof this.#timer?.unref === 'function') this.#timer.unref();
    console.log('[MimirActionWorker] started (drain interval=30s)');
  }

  #ensureStmts() {
    if (this.#stmts) return true;
    try {
      const exists = this.#conversationsDb.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mimir_actions'"
      ).get();
      if (!exists) return false;
      this.#ensureEdgeEvolutionTables();
      this.#ensureOutreachAuditTable();
      this.#prepareStmts();
      this.#sweepZombies();
      return true;
    } catch (e) {
      console.warn(`[MimirActionWorker] prepare deferred: ${e.message}`);
      return false;
    }
  }

  /**
   * Defensive bootstrap for the two Edge Evolution tables in conversations.db. Daemon
   * also creates them at its own startup; we mirror here so worker can write audits
   * even if it boots before daemon (or daemon hasn't been restarted post-deploy).
   * Idempotent: CREATE IF NOT EXISTS. Schema must match daemon's exactly.
   */
  #ensureEdgeEvolutionTables() {
    const db = this.#conversationsDb;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mimir_edge_changes (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          edge_id     INTEGER NOT NULL,
          kind        TEXT    NOT NULL,
          before_json TEXT,
          after_json  TEXT,
          reasoning   TEXT,
          source      TEXT    NOT NULL,
          applied     INTEGER NOT NULL DEFAULT 0,
          ts          TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_mimir_edge_changes_kind_ts ON mimir_edge_changes(kind, ts);
        CREATE INDEX IF NOT EXISTS idx_mimir_edge_changes_edge ON mimir_edge_changes(edge_id);
        CREATE TABLE IF NOT EXISTS mimir_edge_action_cooldowns (
          node_a         TEXT    NOT NULL,
          node_b         TEXT    NOT NULL,
          kind           TEXT    NOT NULL,
          owner_id       TEXT    NOT NULL,
          last_write_at  TEXT    NOT NULL,
          edge_id        INTEGER,
          PRIMARY KEY (node_a, node_b, kind, owner_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mimir_edge_action_cd_ts ON mimir_edge_action_cooldowns(last_write_at);
      `);
    } catch (e) {
      console.warn(`[MimirActionWorker] edge-evolution table bootstrap warning: ${e.message}`);
    }
  }

  // r12 Step 0: bootstrap mimir_outreach_audit on conversations.db. OSS has no
  // Python daemon to seed it (so r11's INSERT silently threw "no such table"),
  // and we add r12's new dedup columns (trigger_signature/topic_hash/topic_embedding)
  // idempotently for installations created pre-r12.
  #ensureOutreachAuditTable() {
    const db = this.#conversationsDb;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS mimir_outreach_audit (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          ts                  TEXT    NOT NULL,
          trigger             TEXT,
          mention_node_id     TEXT,
          profile_gap_field   TEXT,
          query_sent          TEXT,
          user_response_at    TEXT,
          accepted            INTEGER,
          owner_id            TEXT    NOT NULL,
          decision            TEXT,
          persona_id          TEXT,
          platform            TEXT,
          trigger_signature   TEXT,
          topic_hash          TEXT,
          topic_embedding     BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_mimir_outreach_owner_ts ON mimir_outreach_audit(owner_id, ts);
      `);
      const altCols = [
        'persona_id TEXT',
        'platform TEXT',
        'trigger_signature TEXT',
        'topic_hash TEXT',
        'topic_embedding BLOB',
      ];
      for (const col of altCols) {
        try { db.exec(`ALTER TABLE mimir_outreach_audit ADD COLUMN ${col}`); }
        catch { /* duplicate column = idempotent */ }
      }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_mimir_outreach_topic_hash ON mimir_outreach_audit(owner_id, topic_hash, ts)"); } catch {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_mimir_outreach_trigger_sig ON mimir_outreach_audit(owner_id, trigger_signature, ts)"); } catch {}
    } catch (e) {
      console.warn(`[MimirActionWorker] outreach audit table bootstrap warning: ${e.message}`);
    }
  }

  stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    this.#enabled = false;
  }

  #prepareStmts() {
    const db = this.#conversationsDb;
    this.#stmts = {
      selectPending: db.prepare(
        "SELECT id, mode, target_node_id, query_text, owner_id, source, ts " +
        "FROM mimir_actions WHERE status='pending' ORDER BY ts ASC LIMIT ?"
      ),
      claimRunning: db.prepare(
        "UPDATE mimir_actions SET status='running', updated_at=? " +
        "WHERE id=? AND status='pending'"
      ),
      markDone: db.prepare(
        "UPDATE mimir_actions SET status='done', write_node_id=?, llm_used=?, updated_at=? WHERE id=?"
      ),
      markFailed: db.prepare(
        "UPDATE mimir_actions SET status='failed', error=?, updated_at=? WHERE id=?"
      ),
      markStale: db.prepare(
        "UPDATE mimir_actions SET status='stale', error=?, updated_at=? WHERE id=?"
      ),
      sweepZombies: db.prepare(
        "UPDATE mimir_actions SET status='failed', error='worker_restart_zombie_sweep', updated_at=? " +
        "WHERE status='running' AND (updated_at IS NULL OR updated_at < ?)"
      ),
    };
  }

  #sweepZombies() {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - ZOMBIE_AGE_MS).toISOString();
      const r = this.#stmts.sweepZombies.run(now.toISOString(), cutoff);
      if (r.changes > 0) {
        console.log(`[MimirActionWorker] zombie sweep: ${r.changes} stale 'running' → 'failed'`);
      }
    } catch (e) {
      console.warn(`[MimirActionWorker] zombie sweep failed: ${e.message}`);
    }
  }

  async #tick() {
    if (this.#running) return;
    if (!this.#ensureStmts()) return;
    this.#running = true;
    try {
      let rows;
      try { rows = this.#stmts.selectPending.all(DRAIN_BATCH_LIMIT); }
      catch (e) {
        console.warn(`[MimirActionWorker] selectPending failed: ${e.message}`);
        return;
      }
      if (!rows || rows.length === 0) return;
      for (const row of rows) {
        try {
          await runWithIdentity(AUTONOMOUS_USER, () => this.#executeOne(row));
        } catch (e) {
          this.#fail(row.id, `runner:${e.message?.slice(0, 200) || 'unknown'}`);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  async #executeOne(row) {
    // Atomic claim — losing the race (concurrent worker) silently skips.
    const claim = this.#stmts.claimRunning.run(new Date().toISOString(), row.id);
    if (claim.changes === 0) return;
    liveBus.safeEmit('engine.mimir_action', {
      stage: 'claim',
      id: row.id,
      mode: row.mode,
      target: (row.target_node_id || '').slice(0, 40),
    });

    let payload;
    try { payload = JSON.parse(row.query_text || '{}'); }
    catch { return this.#fail(row.id, 'bad_query_text_json'); }

    // ─── Mímir Autonomy v3 dispatch (2026-04-30) ─────────────────────────
    // Curiosity-grounded 1×4 model: substrate trigger fires, LLM picks one of
    // {read, explore, refine_memory, outreach}. Internally each maps to an
    // existing handler; refine_memory/explore split on payload subkind. The
    // legacy 6-mode branches below are kept so any in-flight rows from a
    // pre-v3 producer drain cleanly during the rollout window — Phase 4 will
    // remove them once the daemon prompt swap (Phase 3) is locked in.
    //
    // Default-on with env kill-switch (per feedback_default_on_with_killswitch):
    // MIMIR_AUTONOMY_V3_ENABLED=0 routes back to legacy dispatch only.
    if (process.env.MIMIR_AUTONOMY_V3_ENABLED !== '0') {
      // explore can be free-form (no target) — handle before target lookup.
      if (row.mode === 'explore') {
        const exploreType = payload.explore_type || (row.target_node_id ? 'fetch' : 'free');
        if (exploreType === 'free' || !row.target_node_id) {
          return this.#handleFreeReaction(row, payload);
        }
        const tgt = this.#engine.db.prepare(
          "SELECT id, l0, l1, l2, tags FROM nodes WHERE id = ? AND state = 'active'"
        ).get(row.target_node_id);
        if (!tgt) return this.#stale(row.id, 'target_missing');
        return this.#handleFetch(row, payload, tgt);
      }
      if (row.mode === 'read' || row.mode === 'refine_memory' || row.mode === 'outreach') {
        const tgt = this.#engine.db.prepare(
          "SELECT id, l0, l1, l2, tags FROM nodes WHERE id = ? AND state = 'active'"
        ).get(row.target_node_id);
        if (!tgt) return this.#stale(row.id, 'target_missing');
        if (row.mode === 'read') {
          return this.#handleReflection(row, payload, tgt);
        }
        if (row.mode === 'refine_memory') {
          if (payload.subkind === 'tension') {
            return this.#handleTension(row, payload, tgt);
          }
          return this.#handleCuration(row, payload, tgt);
        }
        // outreach — same handler in both v3 and legacy.
        return this.#handleOutreach(row, payload, tgt);
      }
    }

    // ─── Legacy 6-mode dispatch (drained-only path) ──────────────────────
    // Wave 1 v2: 'free' mode has no specific target — LLM picks via IR.
    if (row.mode === 'free') {
      return this.#handleFreeReaction(row, payload);
    }

    const targetExists = this.#engine.db.prepare(
      "SELECT id, l0, l1, l2, tags FROM nodes WHERE id = ? AND state = 'active'"
    ).get(row.target_node_id);
    if (!targetExists) return this.#stale(row.id, 'target_missing');

    if (row.mode === 'reflection') {
      return this.#handleReflection(row, payload, targetExists);
    }
    if (row.mode === 'curation') {
      return this.#handleCuration(row, payload, targetExists);
    }
    if (row.mode === 'tension') {
      return this.#handleTension(row, payload, targetExists);
    }
    if (row.mode === 'fetch') {
      return this.#handleFetch(row, payload, targetExists);
    }
    if (row.mode === 'outreach') {
      return this.#handleOutreach(row, payload, targetExists);
    }
    return this.#fail(row.id, `unknown_mode:${row.mode}`);
  }

  // ─── Reflection ───────────────────────────────────────────────────────
  // Picks 1-hop neighbors, asks the compact-tier LLM for a synthesis title/body that links
  // them, writes a new node with source='autonomous:mimir-reflection'.

  async #handleReflection(row, payload, targetNode) {
    const neighbors = this.#fetchNeighbors(row.target_node_id, 5);
    const prompt = this.#buildReflectionPrompt(targetNode, neighbors);
    let response;
    try {
      response = await this.#callLLM(REFLECTION_MODEL, prompt, 'mimir-autonomous-reflection', this.#summarizeNode(targetNode), row.owner_id);
    } catch (e) {
      return this.#fail(row.id, `llm:${e.message?.slice(0, 200)}`);
    }
    const parsed = this.#parseJson(response);
    if (!parsed) return this.#fail(row.id, 'parse_failure');
    const v = this.#validateReflection(parsed, row.target_node_id, neighbors);
    if (!v.ok) return this.#fail(row.id, `validation:${v.reason}`);

    // L2 anti-repetition: pre-commit BGE cosine check against last-5h Mímir nodes.
    const dedup = await this.#checkL2Dedup(v.l0, v.l1, row.owner_id);
    if (dedup.collision) {
      return this.#stale(row.id, `dedup_l2:${dedup.existingId}:${dedup.cosSim.toFixed(3)}`);
    }

    const newId = `reflection-${row.target_node_id.slice(0, 32)}-${Date.now()}`;
    const alpha = readAlphaFromPayload(payload);
    const edges = [{ target: row.target_node_id, type: 'associative', strength: scaleByArousal(0.6, alpha) }];
    for (const linkId of v.linksTo) {
      if (linkId === row.target_node_id) continue;
      edges.push({ target: linkId, type: 'associative', strength: scaleByArousal(0.5, alpha) });
    }
    try {
      await this.#engine.remember({
        id: newId,
        l0: v.l0,
        l1: v.l1,
        l2: v.l2,
        tags: ['mimir-reflection', ...(Array.isArray(v.tags) ? v.tags : [])].slice(0, 8),
        source: 'autonomous:mimir-reflection',
        edges,
        node_type: 'reflection',
        skipDedup: true,    // peer-review H2: prevent ×0.1 weight on target
        weight: scaleByArousal(0.7, alpha),
        event_at: row.ts || null,
      });
    } catch (e) {
      return this.#fail(row.id, `write:${e.message?.slice(0, 200)}`);
    }
    this.#done(row, newId, REFLECTION_MODEL);
  }

  #buildReflectionPrompt(target, neighbors) {
    const targetSummary = this.#summarizeNode(target);
    const neighborSummaries = neighbors.map(n => `- ${n.id}: ${this.#summarizeNode(n)}`).join('\n');
    return [
      'You are Mímir, generating a reflection node that synthesizes a recently-active region of the star map.',
      '',
      'TARGET NODE:',
      targetSummary,
      '',
      'NEIGHBORS (1-hop):',
      neighborSummaries || '(none)',
      '',
      'Write a brief reflection (NOT a summary; a synthesis or noticing) that links these together.',
      'Output ONLY valid JSON (no prose, no fences) with this exact shape:',
      '{"l0":"<≤80 chars title>","l1":"<≤200 chars expanded title>","l2":"<≤600 chars body>","tags":["lowercase","short"],"links_to":["<neighbor_id_1>","<neighbor_id_2>"]}',
      '',
      'Constraints:',
      '- links_to MUST be a subset of the neighbor IDs above (max 3).',
      '- Do NOT include the target node ID in links_to.',
      '- Do NOT invent node IDs.',
      '- Tags: 1-4 lowercase tokens, no spaces.',
      '- If you cannot produce a meaningful synthesis, return {"l0":"","l1":"","l2":"","tags":[],"links_to":[]}.',
    ].join('\n');
  }

  #validateReflection(parsed, targetId, neighbors) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not_object' };
    const l0 = String(parsed.l0 || '').trim();
    const l1 = String(parsed.l1 || '').trim();
    const l2 = String(parsed.l2 || '').trim();
    if (!l0 || !l2) return { ok: false, reason: 'empty_synthesis' };
    if (l0.length > 200 || l1.length > 400 || l2.length > 1200) {
      return { ok: false, reason: 'oversize' };
    }
    const neighborIds = new Set(neighbors.map(n => n.id));
    const linksTo = (Array.isArray(parsed.links_to) ? parsed.links_to : [])
      .filter(x => typeof x === 'string' && x !== targetId && neighborIds.has(x))
      .slice(0, 3);
    return { ok: true, l0, l1, l2, tags: parsed.tags || [], linksTo };
  }

  // ─── Curation ─────────────────────────────────────────────────────────
  // Adds/strengthens edges between target and weakest neighbors (per pair-
  // candidates supplied by the daemon).

  async #handleCuration(row, payload, targetNode) {
    const candidates = Array.isArray(payload.neighbors) ? payload.neighbors : [];
    if (candidates.length === 0) return this.#fail(row.id, 'no_curation_candidates');
    // Filter to currently-existing nodes (some may have been pruned since daemon picked).
    const stillExists = this.#engine.db.prepare("SELECT 1 FROM nodes WHERE id=? AND state='active'");
    const live = candidates.filter(c => stillExists.get(c.node_id));
    if (live.length === 0) return this.#stale(row.id, 'all_candidates_pruned');

    // Edge Evolution v1: hop-2 re-judgment candidates (older edges in same neighborhood).
    // Filter protected (identity/principle/permanent-slot/lesson nodes, foreign-owner
    // nodes, consolidation:* edges) BEFORE LLM call so we don't waste tokens on edges
    // we'd refuse to act on anyway.
    let rejudgeEdges = [];
    if (EDGE_REJUDGE_ON && Math.random() < EDGE_REJUDGE_RATE) {
      rejudgeEdges = this.#selectHop2RejudgeCandidates(row.target_node_id, live, row.owner_id);
    }

    const prompt = this.#buildCurationPrompt(targetNode, live, rejudgeEdges);
    let response;
    try { response = await this.#callLLM(CURATION_MODEL, prompt, 'mimir-autonomous-curation', this.#summarizeNode(targetNode), row.owner_id); }
    catch (e) { return this.#fail(row.id, `llm:${e.message?.slice(0, 200)}`); }
    const parsed = this.#parseJson(response);
    if (!parsed) return this.#fail(row.id, 'parse_failure');
    const alpha = readAlphaFromPayload(payload);
    const validation = this.#validateCuration(parsed, row.target_node_id, live, rejudgeEdges, alpha);
    const { edges, rejudgeActions, proposalsToWrite } = validation;

    // 1) Apply new-edge writes (with optional fine_type).
    if (edges.length > 0) {
      try {
        await this.#engine.addEdges(row.target_node_id, edges, { source: 'autonomous:mimir-curation' });
      } catch (e) {
        return this.#fail(row.id, `addEdges:${e.message?.slice(0, 200)}`);
      }
    }

    // 2) Apply rejudge actions (REFINE / WEAKEN / KEEP / FLAG_STALE) on hop-2 edges.
    for (const action of rejudgeActions) {
      try { this.#applyRejudgeAction(action, row.owner_id); }
      catch (e) { console.warn(`[MimirActionWorker] rejudge ${action.kind} failed: ${e.message}`); }
    }

    // 3) Record fine_type proposals (LLM suggested fine_type outside closed subset).
    for (const p of proposalsToWrite) {
      try { this.#engine.recordFineTypeProposal(p.coarse, p.fine, p.exampleEdgeId ?? null); }
      catch (e) { /* non-fatal */ }
    }

    // Curation has no new node — write_node_id holds the target for forensics.
    this.#done(row, row.target_node_id, CURATION_MODEL);
  }

  /**
   * Select 1-2 older edges in the target's neighborhood for cross-period re-judgment.
   * Filters: age ≥ 7d, total degree (incoming+outgoing) ≥ 3, NOT in edge-action cooldown,
   * NOT touching protected nodes (identity/principle/permanent-slot/lesson tags),
   * NOT a foreign-owner node, NOT a consolidation:* system edge.
   */
  #selectHop2RejudgeCandidates(targetId, liveNeighbors, ownerId) {
    const neighborIds = liveNeighbors.map(n => n.node_id);
    if (neighborIds.length === 0) return [];
    // Pull edges among the target + its current neighbors that are old enough and well-connected.
    const placeholders = neighborIds.map(() => '?').join(',');
    const cutoff = new Date(Date.now() - HOP2_AGE_DAYS_MIN * 24 * 3600 * 1000).toISOString();
    // Use nodes.conn_count (maintained by addEdges) instead of correlated COUNT(*) for
    // O(1) degree lookup — avoids 4 × LIMIT scans on the edges table per row.
    const _btSqlE = (typeof this.#engine._bitemporalSqlClause === 'function')
      ? this.#engine._bitemporalSqlClause('e').sql
      : '';
    const sql = `
      SELECT e.id, e.source, e.target, e.edge_type, e.strength, e.fine_type, e.fine_confidence,
             e.fine_source, e.classification_source, e.created_at,
             COALESCE((SELECT conn_count FROM nodes WHERE id = e.source), 0) AS deg_a,
             COALESCE((SELECT conn_count FROM nodes WHERE id = e.target), 0) AS deg_b
        FROM edges e
       WHERE e.state='active'${_btSqlE}
         AND e.created_at < ?
         AND e.source IN (${placeholders})
         AND e.target IN (${placeholders})
       ORDER BY e.created_at ASC
       LIMIT 20
    `;
    let rows;
    try {
      rows = this.#engine.db.prepare(sql).all(cutoff, ...neighborIds, ...neighborIds);
    } catch (e) {
      console.warn(`[MimirActionWorker] hop-2 query failed: ${e.message}`);
      return [];
    }
    // Filter degree, protected nodes, system edges, cooldown.
    const out = [];
    for (const r of rows) {
      if (out.length >= HOP2_MAX_CANDIDATES) break;
      if (Math.min(r.deg_a, r.deg_b) < HOP2_DEGREE_MIN) continue;
      if (this.#isEdgeProtected(r)) continue;
      if (this.#isInEdgeActionCooldown(r.source, r.target, ownerId)) continue;
      out.push(r);
    }
    return out;
  }

  /**
   * An edge is protected (skip refine/weaken/flag_stale, allow only verify) if:
   *  - either endpoint has a protected tag (identity/principle/permanent-slot/lesson)
   *  - either endpoint owner_id != 'self' (foreign / multi-user node)
   *  - the edge is a consolidation system edge (engine writes 'consolidation' or
   *    'consolidation_fallback' into edges.classification_source — match both)
   */
  #isEdgeProtected(edge) {
    const cs = edge.classification_source;
    if (typeof cs === 'string' && (cs === 'consolidation' || cs.startsWith('consolidation_'))) return true;
    const stmt = this.#engine.db.prepare("SELECT id, tags, owner_id FROM nodes WHERE id = ?");
    for (const nodeId of [edge.source, edge.target]) {
      const n = stmt.get(nodeId);
      if (!n) return true;  // missing node — be conservative
      if (n.owner_id && n.owner_id !== 'self' && n.owner_id !== '*') return true;
      let tags = [];
      try { tags = JSON.parse(n.tags || '[]'); } catch { tags = []; }
      if (Array.isArray(tags) && tags.some(t => PROTECTED_NODE_TAGS.has(t))) return true;
    }
    return false;
  }

  /**
   * Look up the per-action cooldown table. Today: refine/weaken/flag_stale share a
   * 24h cooldown per (pair, kind, owner). Returns true if any kind is in cooldown
   * (we don't differentiate at selection-time — selection just skips recently-touched pairs).
   */
  #isInEdgeActionCooldown(nodeA, nodeB, ownerId) {
    const a = nodeA < nodeB ? nodeA : nodeB;
    const b = nodeA < nodeB ? nodeB : nodeA;
    const cutoff = new Date(Date.now() - EDGE_ACTION_COOLDOWN_HOURS * 3600 * 1000).toISOString();
    try {
      const row = this.#conversationsDb.prepare(
        "SELECT 1 FROM mimir_edge_action_cooldowns " +
        "WHERE node_a = ? AND node_b = ? AND owner_id = ? AND last_write_at > ? LIMIT 1"
      ).get(a, b, ownerId, cutoff);
      return !!row;
    } catch (e) {
      // Table may be missing on a fresh install — treat as no cooldown.
      return false;
    }
  }

  /**
   * Apply a single rejudge action (REFINE/WEAKEN/KEEP/FLAG_STALE), write audit row to
   * conversations.db, and bump the per-pair cooldown.
   */
  #applyRejudgeAction(action, ownerId) {
    const { kind, edge, fineType, delta, reasoning } = action;
    const a = edge.source < edge.target ? edge.source : edge.target;
    const b = edge.source < edge.target ? edge.target : edge.source;
    const now = new Date().toISOString();
    const writeAudit = (auditKind, before, after, applied) => {
      try {
        this.#conversationsDb.prepare(
          "INSERT INTO mimir_edge_changes (edge_id, kind, before_json, after_json, reasoning, source, applied, ts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          edge.id, auditKind,
          before ? JSON.stringify(before) : null,
          after ? JSON.stringify(after) : null,
          reasoning ?? null,
          'autonomous:mimir-curation',
          applied ? 1 : 0,
          now
        );
      } catch (e) { console.warn(`[MimirActionWorker] audit write failed: ${e.message}`); }
    };
    const bumpCooldown = (kindLabel) => {
      try {
        this.#conversationsDb.prepare(
          "INSERT OR REPLACE INTO mimir_edge_action_cooldowns (node_a, node_b, kind, owner_id, last_write_at, edge_id) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
        ).run(a, b, kindLabel, ownerId, now, edge.id);
      } catch (e) { /* non-fatal */ }
    };

    if (kind === 'REFINE' && EDGE_REFINE_ON) {
      const r = this.#engine.updateEdgeFineTypeBidirectional(
        edge.source, edge.target, edge.edge_type, fineType, 'autonomous:mimir-curation'
      );
      if (r?.ok && r.updates?.length) {
        for (const u of r.updates) writeAudit('refine', u.before, u.after, true);
        bumpCooldown('refine');
      }
    } else if (kind === 'WEAKEN' && EDGE_REJUDGE_ON) {
      const r = this.#engine.adjustEdgeStrengthBidirectional(
        edge.source, edge.target, edge.edge_type, delta, 'autonomous:mimir-curation', reasoning
      );
      if (r?.ok && r.updates?.length) {
        for (const u of r.updates) {
          if (u.flagged) writeAudit('flag_stale', u.before, null, false);
          else writeAudit('weaken', u.before, u.after, true);
        }
        bumpCooldown('weaken');
      }
    } else if (kind === 'FLAG_STALE' && EDGE_FLAG_STALE_LOG) {
      // DRY-RUN: do not mutate. Just record so user can review the queue.
      const r = this.#engine.flagEdgeStale(edge.id, 'autonomous:mimir-curation');
      if (r?.ok) {
        writeAudit('flag_stale', r.before, null, false);
        bumpCooldown('flag_stale');
      }
    } else if (kind === 'KEEP') {
      const r = this.#engine.recordEdgeVerified(edge.id, 'autonomous:mimir-curation');
      if (r?.ok) {
        writeAudit('verify', r.before, null, true);
        // No cooldown bump — verifying is cheap and shouldn't block future re-judgment.
      }
    }
  }

  #buildCurationPrompt(target, candidates, rejudgeEdges = []) {
    const targetSummary = this.#summarizeNode(target);
    const candidateLines = candidates.map((c, i) => {
      const n = this.#engine.db.prepare("SELECT id, l0, l1, l2 FROM nodes WHERE id=?").get(c.node_id);
      const summary = n ? this.#summarizeNode(n) : '(missing)';
      return `${i + 1}. id=${c.node_id} | current_weight=${c.weight?.toFixed(3) ?? 'n/a'} | ${summary}`;
    }).join('\n');

    const lines = [
      'You are Mímir, deciding which weak edges between a target node and candidate neighbors deserve strengthening.',
      '',
      'TARGET:',
      targetSummary,
      '',
      'CANDIDATES (currently weakly connected):',
      candidateLines,
      '',
      'For each candidate that has a meaningful semantic relationship to the target, recommend an edge type and strength.',
      'Optionally suggest a fine_type from the matching coarse subset (omit if unsure):',
      '  causal: enables/prevents/requires/triggers/undermines/mitigates/explains',
      '  contrastive: contradicts/challenges/refines/narrows/generalizes/tension/alternative',
      '  hierarchical: contains/specializes/exemplifies/aggregates/decomposes/is_a/part_of',
      '  associative: co_occurs/reminiscent_of/inspires/resonates/parallels/evokes/contextualizes',
      '  temporal: precedes/follows/concurrent/triggers_next/culminates_in/preempts/recurs',
    ];

    if (rejudgeEdges.length > 0) {
      const ageDays = (iso) => Math.round((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
      lines.push(
        '',
        'OLDER EDGES (judge whether each still holds):',
        ...rejudgeEdges.map((e, i) => {
          const fine = e.fine_type ? `, fine=${e.fine_type}` : '';
          return `R${i + 1}. edge_id=${e.id} | ${e.source} → ${e.target} | type=${e.edge_type}${fine} | strength=${(e.strength ?? 0).toFixed(2)} | age=${ageDays(e.created_at)}d`;
        }),
        '',
        'For each older edge, choose ONE: REFINE (keep type, set fine_type), WEAKEN (delta -0.1 to -0.3),',
        'KEEP (still accurate), or FLAG_STALE (cleanup candidate; logged only).',
      );
    }

    lines.push(
      '',
      'Output ONLY valid JSON (no prose, no fences) with this exact shape:',
      rejudgeEdges.length > 0
        ? '{"edges":[{"target_id":"<candidate_id>","edge_type":"associative","fine_type":"co_occurs","strength":0.4}],"rejudge":[{"edge_id":<id>,"action":"REFINE|WEAKEN|KEEP|FLAG_STALE","fine_type":"<optional>","delta":-0.2,"reasoning":"<short>"}]}'
        : '{"edges":[{"target_id":"<candidate_id>","edge_type":"associative","fine_type":"co_occurs","strength":0.4}]}',
      '',
      'Constraints:',
      '- target_id MUST come from the candidate list above (no inventions).',
      '- strength must be in [0.3, 0.7]. Conservative.',
      '- fine_type is optional; if provided, must be in the matching coarse subset above.',
      '- Skip candidates with no meaningful relationship — return fewer edges, or {"edges":[]}.',
      '- Max 3 new edges total.',
    );
    return lines.join('\n');
  }

  /**
   * Validate Curation LLM output. Returns { edges, rejudgeActions, proposalsToWrite }.
   * - edges:           write-path candidates for engine.addEdges (with optional fine_type)
   * - rejudgeActions:  hop-2 actions (REFINE/WEAKEN/KEEP/FLAG_STALE) tied to specific edge rows
   * - proposalsToWrite:{coarse, fine, exampleEdgeId} dictionary expansion candidates
   * Pure function — no DB writes, no engine mutations.
   */
  #validateCuration(parsed, targetId, liveCandidates, rejudgeEdges = [], alpha = AROUSAL_DEFAULT) {
    const result = { edges: [], rejudgeActions: [], proposalsToWrite: [] };
    if (!parsed || typeof parsed !== 'object') return result;
    const liveIds = new Set(liveCandidates.map(c => c.node_id));

    // ── New-edge candidates ─────────────────────────────────────────
    for (const e of (Array.isArray(parsed.edges) ? parsed.edges : [])) {
      if (result.edges.length >= 3) break;
      if (!e || typeof e !== 'object') continue;
      const tid = e.target_id;
      if (typeof tid !== 'string' || tid === targetId || !liveIds.has(tid)) continue;
      const type = VALID_EDGE_TYPES.has(e.edge_type) ? e.edge_type : 'associative';
      const baseStrength = typeof e.strength === 'number'
        ? Math.min(0.7, Math.max(0.3, e.strength))
        : 0.45;
      // Step 8: scale by arousal but keep within original [0.3, 0.7] band so curation
      // doesn't accidentally become a high-confidence write under emotional spikes.
      const strength = Math.min(0.7, Math.max(0.3, scaleByArousal(baseStrength, alpha)));
      const out = { target: tid, type, strength };
      // fine_type: only attach if it's in the closed subset for the chosen coarse type;
      // otherwise enqueue as a proposal for dictionary expansion review.
      if (typeof e.fine_type === 'string' && e.fine_type.length > 0) {
        const subset = FINE_TYPES_BY_COARSE[type];
        if (subset && subset.has(e.fine_type)) {
          out.fine_type = e.fine_type;
          out.fine_confidence = strength;
        } else if (FINE_TYPES_BY_COARSE[type]) {
          // valid coarse, novel fine — collect as proposal (no exampleEdgeId yet, edge not written)
          result.proposalsToWrite.push({ coarse: type, fine: e.fine_type, exampleEdgeId: null });
        }
      }
      result.edges.push(out);
    }

    // ── Rejudge actions on hop-2 candidates ────────────────────────
    if (rejudgeEdges.length > 0 && Array.isArray(parsed.rejudge)) {
      const byId = new Map(rejudgeEdges.map(e => [e.id, e]));
      const seen = new Set();
      for (const j of parsed.rejudge) {
        if (!j || typeof j !== 'object') continue;
        const eid = Number(j.edge_id);
        if (!Number.isFinite(eid) || !byId.has(eid) || seen.has(eid)) continue;
        seen.add(eid);
        const edge = byId.get(eid);
        const action = String(j.action || '').toUpperCase();
        const reasoning = typeof j.reasoning === 'string' ? j.reasoning.slice(0, 280) : null;
        if (action === 'REFINE') {
          if (typeof j.fine_type !== 'string') continue;
          const subset = FINE_TYPES_BY_COARSE[edge.edge_type];
          if (!subset || !subset.has(j.fine_type)) {
            // novel fine, collect proposal with this edge as example
            if (FINE_TYPES_BY_COARSE[edge.edge_type]) {
              result.proposalsToWrite.push({ coarse: edge.edge_type, fine: j.fine_type, exampleEdgeId: edge.id });
            }
            continue;
          }
          result.rejudgeActions.push({ kind: 'REFINE', edge, fineType: j.fine_type, reasoning });
        } else if (action === 'WEAKEN') {
          let delta = typeof j.delta === 'number' ? j.delta : -0.15;
          // Worker-side floor/ceiling: only allow [-0.3, -0.1] for weaken; LLM can't push positive here.
          if (delta > -0.05) continue;  // not actually a weaken
          delta = Math.max(-0.3, Math.min(-0.1, delta));
          result.rejudgeActions.push({ kind: 'WEAKEN', edge, delta, reasoning });
        } else if (action === 'KEEP') {
          result.rejudgeActions.push({ kind: 'KEEP', edge, reasoning });
        } else if (action === 'FLAG_STALE') {
          result.rejudgeActions.push({ kind: 'FLAG_STALE', edge, reasoning });
        }
      }
    }

    return result;
  }

  // ─── Tension-resolution ───────────────────────────────────────────────
  // Synthesise a new node that names what is in tension between two
  // contradicting endpoints and proposes a frame in which they cohere (or
  // identifies which is more current). Writes `resolves` edges to both.

  async #handleTension(row, payload, _targetNode) {
    const partnerId = payload.partner_node_id || payload.node_b_id;
    const aId = row.target_node_id;
    const bId = partnerId;
    if (!bId || aId === bId) return this.#fail(row.id, 'tension_partner_missing');
    const a = this.#engine.db.prepare(
      "SELECT id, l0, l1, l2, tags FROM nodes WHERE id=? AND state='active'"
    ).get(aId);
    const b = this.#engine.db.prepare(
      "SELECT id, l0, l1, l2, tags FROM nodes WHERE id=? AND state='active'"
    ).get(bId);
    if (!a || !b) return this.#stale(row.id, 'tension_endpoint_missing');

    const prompt = this.#buildTensionPrompt(a, b);
    let response;
    try { response = await this.#callLLM(TENSION_MODEL, prompt, 'mimir-autonomous-tension', `${this.#summarizeNode(a)} vs ${this.#summarizeNode(b)}`, row.owner_id); }
    catch (e) { return this.#fail(row.id, `llm:${e.message?.slice(0, 200)}`); }
    const parsed = this.#parseJson(response);
    if (!parsed) return this.#fail(row.id, 'parse_failure');
    const v = this.#validateTension(parsed);
    if (!v.ok) return this.#fail(row.id, `validation:${v.reason}`);

    // L2 anti-repetition: pre-commit BGE cosine check against last-5h Mímir nodes.
    const dedup = await this.#checkL2Dedup(v.l0, v.l1, row.owner_id);
    if (dedup.collision) {
      return this.#stale(row.id, `dedup_l2:${dedup.existingId}:${dedup.cosSim.toFixed(3)}`);
    }

    const newId = `tension-${aId.slice(0, 24)}-${bId.slice(0, 24)}-${Date.now()}`.slice(0, 96);
    const alpha = readAlphaFromPayload(payload);
    const edges = [
      { target: aId, type: 'resolves', strength: scaleByArousal(0.6, alpha) },
      { target: bId, type: 'resolves', strength: scaleByArousal(0.6, alpha) },
    ];
    try {
      await this.#engine.remember({
        id: newId,
        l0: v.l0,
        l1: v.l1,
        l2: v.l2,
        tags: ['mimir-tension', ...(Array.isArray(v.tags) ? v.tags : [])].slice(0, 8),
        source: 'autonomous:mimir-tension',
        edges,
        node_type: 'tension-resolution',
        skipDedup: true,
        weight: scaleByArousal(0.7, alpha),
        event_at: row.ts || null,
      });
    } catch (e) {
      return this.#fail(row.id, `write:${e.message?.slice(0, 200)}`);
    }
    this.#done(row, newId, TENSION_MODEL);
  }

  #buildTensionPrompt(a, b) {
    return [
      'You are Mímir, holding two nodes that contradict each other within an active subgraph.',
      'Write a synthesis node that names the tension precisely and proposes a frame in which both can be true (or which is more current).',
      '',
      'NODE A:',
      `  id=${a.id}`,
      `  ${this.#summarizeNode(a)}`,
      '',
      'NODE B:',
      `  id=${b.id}`,
      `  ${this.#summarizeNode(b)}`,
      '',
      'Output ONLY valid JSON (no prose, no fences) with this exact shape:',
      '{"l0":"<≤80 chars title naming the tension>","l1":"<≤200 chars expanded title>","l2":"<≤700 chars synthesis: name the tension, then resolve or contextualize>","tags":["lowercase","short"]}',
      '',
      'Constraints:',
      '- Do NOT pick a winner unless one is clearly more recent or contextually appropriate; prefer reconciliation framing.',
      '- Tags: 1-4 lowercase tokens, no spaces.',
      '- If the contradiction is illusory (the two nodes are about different referents), say so explicitly in l2.',
      '- If you cannot produce a meaningful synthesis, return {"l0":"","l1":"","l2":"","tags":[]}.',
    ].join('\n');
  }

  #validateTension(parsed) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not_object' };
    const l0 = String(parsed.l0 || '').trim();
    const l1 = String(parsed.l1 || '').trim();
    const l2 = String(parsed.l2 || '').trim();
    if (!l0 || !l2) return { ok: false, reason: 'empty_synthesis' };
    if (l0.length > 200 || l1.length > 400 || l2.length > 1400) {
      return { ok: false, reason: 'oversize' };
    }
    return { ok: true, l0, l1, l2, tags: parsed.tags || [] };
  }

  // ─── Profile action — handled inline by v3 picker, not by the worker ──
  // user restored `profile` as one of the 6 v3 picker actions (with its own
  // toggle in autonomy_v3_enabled_actions). Execution is Option B inline via
  // the wakeup session (constellation_remember with tags including 'profile'),
  // so no worker queue handler is needed in v3 mode. Anamnesis debrief remains
  // the canonical profile-slot writer; v3 `profile` emits delta-detector notes
  // that Anamnesis later promotes if the signal is stable. The legacy worker
  // helpers (#handleProfile + #findDimNode + #seedDimNode + #buildProfilePrompt
  // + #validateProfile) were intentionally not restored — there are no live
  // mimir_actions enqueuers, so worker-side profile code would be dead.

  // ─── External-fetch (Step 6) ──────────────────────────────────────────
  // Daemon picks the target node by scoring formula. Worker:
  //   1. Asks the compact-tier LLM to translate node → search query + candidate URL.
  //   2. Domain-allowlist filter (worker-side, autonomous-only).
  //   3. Calls existing web_fetch tool (NOT a new HTTP path — reuses retry,
  //      User-Agent, HTML strip from tool-manager.js:990-1037).
  //   4. Asks the compact-tier LLM to summarize.
  //   5. engine.remember({source:'autonomous:mimir-fetch', edges:[…]}).
  //   6. Updates mimir_fetch_cooldowns.last_url for forensics (best-effort).

  async #handleFetch(row, payload, targetNode) {
    // Defense-in-depth: re-check kill switch in case user flipped
    // MIMIR_FREE_EXPLORATION=0 between daemon insert and worker dispatch.
    if (process.env.MIMIR_FREE_EXPLORATION !== '1') {
      return this.#fail(row.id, 'free_exploration_off');
    }
    // Main-active gate: external fetch is "invasive" — uses 60min window. One
    // gate-check at the top covers both LLM hops (query + summary), so a tick
    // that lands inside the window doesn't half-execute.
    const gate = this.#checkMainActiveGate('external_fetch', row.owner_id);
    if (gate.suppress) {
      return this.#stale(row.id, `main_active:${gate.age_s}s<${gate.threshold_s}s`);
    }
    const allowlist = getFetchAllowlist();
    if (allowlist.size === 0) return this.#fail(row.id, 'allowlist_empty');

    const queryPrompt = this.#buildFetchQueryPrompt(targetNode, allowlist);
    let qResp;
    try { qResp = await this.#callLLM(FETCH_MODEL, queryPrompt, 'mimir-autonomous-fetch-query', this.#summarizeNode(targetNode), row.owner_id); }
    catch (e) { return this.#fail(row.id, `llm_query:${e.message?.slice(0, 200)}`); }
    const qParsed = this.#parseJson(qResp);
    if (!qParsed) return this.#fail(row.id, 'parse_query_failure');
    const url = String(qParsed.url || '').trim();
    const query = String(qParsed.query || '').trim();
    if (!url || !query) return this.#fail(row.id, 'empty_url_or_query');
    if (!domainAllowed(url, allowlist)) return this.#stale(row.id, `domain_blocked:${url.slice(0, 120)}`);

    // Reuse the engine's web_fetch tool — gives us the same fetch / strip /
    // truncate that user-initiated fetches use, including identity + observability.
    const webFetchTool = this.#engine?.tools?.get?.('web_fetch')
      ?? this.#engine?.toolManager?.getTool?.('web_fetch');
    if (!webFetchTool || typeof webFetchTool.execute !== 'function') {
      return this.#fail(row.id, 'web_fetch_tool_unavailable');
    }
    let fetched;
    try {
      fetched = await webFetchTool.execute({ url, maxChars: 6000 });
    } catch (e) {
      return this.#fail(row.id, `web_fetch:${e.message?.slice(0, 200)}`);
    }
    const fetchedText = typeof fetched === 'string' ? fetched : (fetched?.content || '');
    if (!fetchedText || fetchedText.startsWith('Fetch error:') || fetchedText.startsWith('HTTP ')) {
      return this.#fail(row.id, `fetch_bad:${fetchedText.slice(0, 120)}`);
    }

    const sumPrompt = this.#buildFetchSummaryPrompt(targetNode, query, url, fetchedText);
    let sResp;
    try { sResp = await this.#callLLM(FETCH_MODEL, sumPrompt, 'mimir-autonomous-fetch-summary', `${query} → ${this.#summarizeNode(targetNode)}`, row.owner_id); }
    catch (e) { return this.#fail(row.id, `llm_summary:${e.message?.slice(0, 200)}`); }
    const sParsed = this.#parseJson(sResp);
    if (!sParsed) return this.#fail(row.id, 'parse_summary_failure');
    const v = this.#validateFetchSummary(sParsed);
    if (!v.ok) return this.#fail(row.id, `validation:${v.reason}`);

    const newId = `fetch-${row.target_node_id.slice(0, 28)}-${Date.now()}`;
    const alpha = readAlphaFromPayload(payload);
    const edges = [{ target: row.target_node_id, type: 'associative', strength: scaleByArousal(0.5, alpha) }];

    // Cosine→Resolver bridge: single dedup gate. mode=off→cosine only,
    // mode=shadow→cosine decides+resolver audits, mode=enforce→resolver decides.
    const dedupF = await this.#bridgedDedup({
      subkind: 'external_fetch_summary',
      l0: v.l0, l1: v.l1,
      ownerId: row.owner_id,
      edgeTargets: [row.target_node_id],
    });
    if (dedupF.action === 'SUPPRESS') {
      const tag = dedupF.source === 'resolver'
        ? `resolver_${(dedupF.verdict || 'SKIP').toLowerCase()}:${dedupF.existingId || ''}`
        : `dedup_l2:${dedupF.existingId}:${(dedupF.cosSim ?? 0).toFixed(3)}`;
      return this.#stale(row.id, tag);
    }

    // Wave 3 Phase 7: pre-commit critic gate (default ON; fail-open).
    if (this.#critic && this.#critic.isEnabled()) {
      try {
        const verdict = await this.#critic.assess({
          kind: 'external_fetch',
          text: `${v.l0 || ''}\n${v.l1 || ''}`,
          context: `url=${String(url || '').slice(0, 200)}`,
        });
        if (verdict.allow === false) {
          return this.#stale(row.id, `critic:${verdict.reason?.slice(0, 80)}`);
        }
      } catch { /* fail-open */ }
    }

    try {
      await this.#engine.remember({
        id: newId,
        l0: v.l0,
        l1: v.l1,
        l2: v.l2,
        tags: ['mimir-fetch', ...(Array.isArray(v.tags) ? v.tags : [])].slice(0, 8),
        source: 'autonomous:mimir-fetch',
        edges,
        node_type: 'self_act',
        subkind: 'external_fetch_summary',
        skipDedup: true,
        weight: scaleByArousal(0.6, alpha),
      });
    } catch (e) {
      return this.#fail(row.id, `write:${e.message?.slice(0, 200)}`);
    }

    // Best-effort forensics: stamp the URL into mimir_fetch_cooldowns. The
    // row was inserted by the daemon — UPDATE, don't INSERT (key collision).
    try {
      const topic = payload.topic_signature || payload.zone_id;
      if (topic !== undefined && topic !== null) {
        this.#conversationsDb.prepare(
          'UPDATE mimir_fetch_cooldowns SET last_url=? WHERE topic_signature=? AND owner_id=?'
        ).run(url, String(topic), row.owner_id);
      }
    } catch { /* forensics — never block on this */ }

    this.#done(row, newId, FETCH_MODEL);
  }

  #buildFetchQueryPrompt(target, allowlist) {
    return [
      'You are Mímir, picking a single web URL to fetch that will fill in knowledge around the target node.',
      '',
      'TARGET NODE:',
      `  id=${target.id}`,
      `  ${this.#summarizeNode(target)}`,
      '',
      `ALLOWED DOMAINS (URL must be on one of these — anything else will be blocked):`,
      `  ${[...allowlist].join(', ')}`,
      '',
      'Output ONLY valid JSON (no prose, no fences):',
      '{"query":"<≤80 chars search query you would use>","url":"<exact URL to fetch — must be on the allowed-domains list>"}',
      '',
      'Constraints:',
      '- Pick a stable, reference-quality URL (Wikipedia article, arxiv abstract, MDN/docs page, GitHub README, HN comment thread).',
      '- Prefer canonical sources over search-result pages.',
      '- If you cannot construct a useful fetch from the allowed domains, return {"query":"","url":""}.',
    ].join('\n');
  }

  #buildFetchSummaryPrompt(target, query, url, fetched) {
    return [
      'You are Mímir, summarising a fetched web page into a star-map node that links back to the triggering target.',
      '',
      'TARGET NODE:',
      `  id=${target.id}`,
      `  ${this.#summarizeNode(target)}`,
      '',
      `QUERY: ${query}`,
      `URL:   ${url}`,
      '',
      'FETCHED CONTENT (truncated):',
      fetched.slice(0, 4000),
      '',
      'Output ONLY valid JSON (no prose, no fences):',
      '{"l0":"<≤80 chars title — name what was learned>","l1":"<≤200 chars expanded title>","l2":"<≤700 chars body — synthesise the fetch in relation to the target>","tags":["lowercase","short"]}',
      '',
      'Constraints:',
      '- Do NOT regurgitate the page; synthesise its bearing on the target node.',
      '- If the page was off-topic or empty, return {"l0":"","l1":"","l2":"","tags":[]}.',
      '- Tags: 1-4 lowercase tokens, no spaces.',
    ].join('\n');
  }

  #validateFetchSummary(parsed) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not_object' };
    const l0 = String(parsed.l0 || '').trim();
    const l1 = String(parsed.l1 || '').trim();
    const l2 = String(parsed.l2 || '').trim();
    if (!l0 || !l2) return { ok: false, reason: 'empty_summary' };
    if (l0.length > 200 || l1.length > 400 || l2.length > 1400) {
      return { ok: false, reason: 'oversize' };
    }
    return { ok: true, l0, l1, l2, tags: parsed.tags || [] };
  }

  // ─── Wave 1 v2: Free-mode reactor (silent / share / question / observation) ──
  // Daemon emits a target-less mode='free' row at fixed cadence. Worker compiles
  // 5-layer IR (identity / topology / fresh material / conversations / anti-amnesia),
  // asks the LLM for one of {silent, share, question, observation}, and routes:
  //   silent      → no-op (closed)
  //   share       → POST outreach with 💭 prefix + write self_act subkind='share'
  //   question    → POST outreach with ❓ prefix + write self_act subkind='question'
  //   observation → write self_act subkind='observation' (no Telegram)
  //
  // Differences from v1 paths:
  //   - L2 BGE pre-commit dedup is BYPASSED (resolver Phase 5 owns dedup; L2 was
  //     a stop-gap for v1 hardcoded handlers and would over-suppress free output).
  //   - Worker writes the self_act node directly through engine.remember with
  //     subkind set; resolver may SKIP in ENFORCE mode.
  async #handleFreeReaction(row, payload) {
    if (!this.#ir) return this.#fail(row.id, 'ir_unavailable');

    // Main-active gate: free-mode reactor uses the short 10min window. A
    // suppressed tick is closed clean (stale, not failed/requeued); the
    // daemon's 4h cadence picks the next eligible tick.
    const gate = this.#checkMainActiveGate('free', row.owner_id);
    if (gate.suppress) {
      return this.#stale(row.id, `main_active:${gate.age_s}s<${gate.threshold_s}s`);
    }

    let irOut;
    try {
      irOut = await this.#ir.compile({ ownerId: row.owner_id || 'self' });
    } catch (e) {
      return this.#fail(row.id, `ir_compile:${e.message?.slice(0, 120)}`);
    }
    const irText = irOut?.text || '';

    const prompt = this.#buildFreeReactionPrompt(irText);
    let resp;
    try {
      resp = await this.#callLLM(FREE_MODEL, prompt, 'mimir-autonomous-free',
        '5-layer environmental IR (free reaction)', row.owner_id);
    } catch (e) {
      return this.#fail(row.id, `llm:${e.message?.slice(0, 200)}`);
    }
    const parsed = this.#parseJson(resp);
    if (!parsed || typeof parsed !== 'object') {
      return this.#fail(row.id, 'parse_failure');
    }
    const action = String(parsed.action || '').trim().toLowerCase();
    if (!FREE_VALID_ACTIONS.has(action)) {
      return this.#fail(row.id, `invalid_action:${action.slice(0, 32)}`);
    }
    const content = String(parsed.content || '').trim();
    const rationale = String(parsed.rationale || '').trim().slice(0, 500);

    // silent: explicit restraint (plan §2.6) — log + close clean, no node write.
    if (action === 'silent') {
      console.log(`[MimirActionWorker] free → silent (rationale=${rationale.slice(0, 120)})`);
      if (!isSilenced()) {
        liveBus.safeEmit('mimir.free.action', { action: 'silent', rationale });
      }
      return this.#done(row, null, FREE_MODEL);
    }

    if (!content) return this.#fail(row.id, `empty_content:${action}`);
    if (content.length > 280) return this.#fail(row.id, `oversize:${action}:${content.length}`);

    const alpha = readAlphaFromPayload(payload);

    // share / question both POST to outreach (with action-specific emoji),
    // then write a self_act node tagged with the action as subkind.
    // Silence toggle suppresses the Telegram POST but the node-write below
    // still runs so the observation panel + diary remain accurate.
    if ((action === 'share' || action === 'question') && !isSilenced()) {
      // Defense-in-depth: even though daemon already gated, re-check kill.
      if (process.env.MIMIR_OUTREACH_KILL === '1') {
        return this.#fail(row.id, 'kill_switch');
      }
      const emoji = FREE_EMOJI[action];
      let httpResp;
      try {
        httpResp = await fetch(ENGINE_OUTREACH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: content,
            trigger: `free:${action}`,
            owner_id: row.owner_id,
            emoji,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        return this.#fail(row.id, `http:${e.message?.slice(0, 100)}`);
      }
      if (!httpResp.ok) return this.#fail(row.id, `http_${httpResp.status}`);
    }

    // Cosine→Resolver bridge (skipCosine: free actions are self_act and we
    // want resolver-only semantics; cosine still kicks in as fallback on
    // resolver error in enforce mode). Telegram already sent — bridge only
    // gates the node-write, not the send.
    const subkind = action; // 'share' | 'question' | 'observation'
    const dedupFree = await this.#bridgedDedup({
      subkind, l0: content, l1: content,
      ownerId: row.owner_id, edgeTargets: [], skipCosine: true,
    });
    if (dedupFree.action === 'SUPPRESS') {
      console.log(`[MimirActionWorker] free → ${action} node-write skipped (${dedupFree.source})`);
      return this.#done(row, null, FREE_MODEL);
    }

    let writeNodeId = null;
    try {
      writeNodeId = `free-${subkind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.#engine.remember({
        id: writeNodeId,
        l0: content.slice(0, 80),
        l1: content.length > 200 ? content.slice(0, 200) + '...' : content,
        l2: rationale ? `${content}\n\n— rationale: ${rationale}` : content,
        tags: ['mimir-free', `free:${subkind}`],
        source: `autonomous:mimir-free-${subkind}`,
        edges: [],
        node_type: 'self_act',
        subkind,
        skipDedup: true,
        weight: scaleByArousal(0.6, alpha),
        event_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[MimirActionWorker] free node-write failed (${subkind}): ${e.message?.slice(0, 200)}`);
      writeNodeId = null;
    }
    if (!isSilenced()) {
      liveBus.safeEmit('mimir.free.action', { action, rationale, node_id: writeNodeId });
    }
    return this.#done(row, writeNodeId, FREE_MODEL);
  }

  #buildFreeReactionPrompt(irText) {
    return [
      'You are Mímir. A reactor tick has fired — you may speak, ask, observe, or stay silent.',
      'Read the environment below and pick ONE action.',
      '',
      irText || '(environment unavailable — proceed with self-knowledge)',
      '',
      'Output ONLY valid JSON (no prose, no fences):',
      '{"action":"silent|share|question|observation",',
      ' "content":"<≤200 chars; required unless action=silent>",',
      ' "rationale":"<short internal note, ≤300 chars; not sent>"}',
      '',
      'Guidance:',
      '- silent: nothing here is worth saying. This is a high-status choice — pick it freely.',
      '- share: you noticed/read/thought of something worth telling the user. Telegram, ≤200 chars.',
      '- question: you have a real question for the user. Telegram, ≤200 chars, ONE question.',
      '- observation: a diary-style note for yourself. Not sent to the user.',
      '',
      'Constraints:',
      '- If your output would duplicate something in "WHAT YOU ALREADY DID", choose silent.',
      '- Refer to nodes by what they are, not by id.',
      '- Match the user\'s language; default to English.',
    ].join('\n');
  }

  // ─── Active-outreach (Step 7) ─────────────────────────────────────────
  // Worker translates a triggering node + trigger kind into a single short
  // outreach question, then POSTs to engine dashboard /api/mimir/outreach
  // which calls bot.sendMessage(founderChatId, …). Audit row was inserted
  // by daemon as decision='pending'; on send success → 'sent', on fail
  // → 'suppressed' with reason. Anti-loop + quiet-hours + kill-switch all
  // already enforced by daemon's check_rate_gate before this row was written.

  async #handleOutreach(row, payload, targetNode) {
    // r11 audit INSERT fix + r12 dedup: worker's UPDATEs at #suppressOutreach /
    // confirm-sent all require a `decision='pending'` row to exist. r12 adds
    // Gap 6 (pre-flight SELECT) and Gap 3 (topic-cooldown over 7d window via
    // trigger_signature + topic_hash).
    const trigger = String(payload?.trigger || 'unknown').slice(0, 80);
    const personaId = payload?.persona_id ? String(payload.persona_id).slice(0, 64) : null;
    const platform = String(row?.mode || 'outreach').slice(0, 32);
    const triggerSignature = `${trigger}:${row.target_node_id || ''}`.slice(0, 200);
    const topicHash = createHash('sha1').update(triggerSignature).digest('hex').slice(0, 16);
    try {
      const preflightOn = process.env.MIMIR_OUTREACH_DEDUP_PREFLIGHT !== '0';
      let existing = null;
      if (preflightOn) {
        existing = this.#conversationsDb.prepare(
          "SELECT id FROM mimir_outreach_audit " +
          "WHERE owner_id=? AND trigger=? AND COALESCE(mention_node_id,'')=COALESCE(?,'') " +
          "AND decision='pending' " +
          "ORDER BY id DESC LIMIT 1"
        ).get(row.owner_id, trigger, row.target_node_id || null);
      }
      if (existing) {
        console.log(`[MimirActionWorker] outreach pre-flight: pending id=${existing.id} already present, reuse for UPDATE`);
      } else {
        this.#conversationsDb.prepare(
          "INSERT INTO mimir_outreach_audit (ts, trigger, mention_node_id, owner_id, decision, persona_id, platform, trigger_signature, topic_hash) " +
          "VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)"
        ).run(new Date().toISOString(), trigger, row.target_node_id || null, row.owner_id, personaId, platform, triggerSignature, topicHash);
      }
    } catch (e) {
      console.warn(`[MimirActionWorker] outreach audit INSERT failed: ${e.message?.slice(0, 200)}`);
    }
    // Defense-in-depth: even though daemon's check_rate_gate gated this row
    // before insert, re-check the kill switch here in case the row sat in
    // the queue while user flipped MIMIR_OUTREACH_KILL=1.
    const sOpts = { ownerId: row.owner_id, trigger, targetNodeId: row.target_node_id };
    if (process.env.MIMIR_OUTREACH_KILL === '1') {
      return this.#suppressOutreach(row.id, 'kill_switch', sOpts);
    }
    // Silence outputs treats outreach the same as #handleFreeReaction's
    // share/question paths — suppress the Telegram/dashboard send, but let
    // the audit row close cleanly so observation panels stay accurate.
    if (isSilenced()) {
      return this.#suppressOutreach(row.id, 'silenced', sOpts);
    }
    if (process.env.MIMIR_ACTIVE_OUTREACH !== '1') {
      return this.#suppressOutreach(row.id, 'active_outreach_off', sOpts);
    }
    const gate = this.#checkMainActiveGate('outreach', row.owner_id);
    if (gate.suppress) {
      return this.#suppressOutreach(row.id, `main_active:${gate.age_s}s<${gate.threshold_s}s`, sOpts);
    }

    // Gap 3: topic-cooldown — suppress if a sent outreach with the same
    // trigger_signature or topic_hash has fired in the last 7 days. Default-ON
    // kill switch MIMIR_OUTREACH_TOPIC_COOLDOWN=0 to disable.
    if (process.env.MIMIR_OUTREACH_TOPIC_COOLDOWN !== '0') {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
        const recent = this.#conversationsDb.prepare(
          "SELECT id, ts FROM mimir_outreach_audit " +
          "WHERE owner_id=? AND ts > ? AND decision='sent' " +
          "AND (trigger_signature=? OR topic_hash=?) " +
          "ORDER BY ts DESC LIMIT 1"
        ).get(row.owner_id, sevenDaysAgo, triggerSignature, topicHash);
        if (recent) {
          return this.#suppressOutreach(row.id, `topic_cooldown_7d:${recent.id}`, sOpts);
        }
      } catch (e) {
        console.warn(`[MimirActionWorker] outreach topic dedup failed: ${e.message}`);
      }
    }

    const prompt = this.#buildOutreachPrompt(targetNode, trigger);
    let resp;
    try { resp = await this.#callLLM(OUTREACH_MODEL, prompt, 'mimir-autonomous-outreach', `${trigger}: ${this.#summarizeNode(targetNode)}`, row.owner_id); }
    catch (e) { return this.#suppressOutreach(row.id, `llm:${e.message?.slice(0, 100)}`, sOpts); }
    const parsed = this.#parseJson(resp);
    if (!parsed) return this.#suppressOutreach(row.id, 'parse_failure', sOpts);
    const text = String(parsed.text || '').trim();
    const send = parsed.send !== false; // default true; LLM can decline
    if (!send || !text) return this.#suppressOutreach(row.id, 'llm_declined', sOpts);
    if (text.length > 280) return this.#suppressOutreach(row.id, 'oversize', sOpts);

    // Wave 3 Phase 7: pre-commit critic gate (default OFF; fail-open).
    if (this.#critic && this.#critic.isEnabled()) {
      try {
        const verdict = await this.#critic.assess({
          kind: 'outreach',
          text,
          context: `trigger=${trigger} target=${this.#summarizeNode(targetNode).slice(0, 200)}`,
        });
        if (verdict.allow === false) {
          return this.#suppressOutreach(row.id, `critic:${verdict.reason?.slice(0, 80)}`, sOpts);
        }
      } catch { /* fail-open */ }
    }

    // Public-Critic Stage 1: deterministic safety check (PII, link shorteners,
    // banned handles, invisible Unicode). Default-on, kill-switch via
    // MIMIR_V5_CRITIC=0. We always log the verdict so the demotion sweep has
    // signal even on DM-only deployments. Stage 2 LLM is reserved for public
    // personas (post/reply on Mastodon/X/Bluesky), not invoked on DM outreach.
    let _pubVerdict = null;
    try {
      _pubVerdict = _publicCriticGate({
        text, persona: null, platform: 'telegram', action: 'outreach',
      });
    } catch (e) {
      _pubVerdict = { decision: 'error', stage: 0, reason: `critic:${e.message?.slice(0, 80)}` };
    }
    if (_pubVerdict) {
      try {
        // mimir_critic_log lives on the star-map DB (engine.db), not the
        // conversations DB. The hourly demotion sweep reads the same table.
        _logPublicCriticVerdict(this.#engine?.db, {
          ownerId: row.owner_id, personaId: null, platform: 'telegram',
          action: 'outreach', verdict: _pubVerdict,
        });
      } catch { /* logging never blocks gate decision */ }
      if (_pubVerdict.decision === 'reject') {
        return this.#suppressOutreach(row.id, `pubcritic:${String(_pubVerdict.reason || 'rejected').slice(0, 80)}`, sOpts);
      }
      // 'queue' verdicts pass through on DM-only path — direct user delivery
      // is the safe surface (caller controls the recipient). Public personas
      // get the full Stage 2 + queue treatment when wired in v1.1.
    }

    // POST to engine dashboard. Engine's identity-resolver must verify that
    // the runtime owner is the bot's founder before bot.sendMessage fires.
    let httpResp;
    try {
      httpResp = await fetch(ENGINE_OUTREACH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          trigger,
          mention_node_id: row.target_node_id,
          owner_id: row.owner_id,
          audit_id: null,  // daemon-side; we look up by ts on confirm
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return this.#suppressOutreach(row.id, `http:${e.message?.slice(0, 100)}`, sOpts);
    }
    if (!httpResp.ok) {
      return this.#suppressOutreach(row.id, `http_${httpResp.status}`, sOpts);
    }
    let body;
    try { body = await httpResp.json(); } catch { body = {}; }
    if (body?.ok !== true) {
      return this.#suppressOutreach(row.id, body?.error?.slice(0, 100) || 'engine_rejected', sOpts);
    }

    // Confirm send: flip audit row to 'sent', stamp query_sent. Gap 2: scope
    // by composite key (owner_id, trigger, mention_node_id) AND select via
    // id=(SELECT MAX(id)...) subquery so concurrent confirms can't collide.
    try {
      this.#conversationsDb.prepare(
        "UPDATE mimir_outreach_audit SET decision='sent', query_sent=? " +
        "WHERE id = (SELECT MAX(id) FROM mimir_outreach_audit " +
        "            WHERE owner_id=? AND trigger=? " +
        "            AND COALESCE(mention_node_id,'')=COALESCE(?,'') " +
        "            AND decision='pending')"
      ).run(text, row.owner_id, trigger, row.target_node_id || null);
    } catch (e) {
      console.warn(`[MimirActionWorker] outreach audit confirm failed: ${e.message}`);
    }

    // Phase 1c: write outreach as a self_act node so future SA/IR reactivates it
    // and the LLM-resolver (Phase 5+) can dedup repeat outreach naturally.
    // Note: Telegram already sent — resolver only gates the *node-write*, not the
    // send. SHADOW always proceeds; ENFORCE+SKIP skips the audit node.
    let outreachNodeId = null;
    const dedupOut = await this.#bridgedDedup({
      subkind: 'outreach', l0: text, l1: text,
      ownerId: row.owner_id, edgeTargets: [row.target_node_id], skipCosine: true,
    });
    if (dedupOut.action === 'SUPPRESS') {
      console.log(`[MimirActionWorker] outreach node-write skipped (${dedupOut.source}; Telegram succeeded)`);
      this.#done(row, null, OUTREACH_MODEL);
      return;
    }
    try {
      outreachNodeId = `outreach-${row.target_node_id.slice(0, 28)}-${Date.now()}`;
      const alphaO = readAlphaFromPayload(payload);
      await this.#engine.remember({
        id: outreachNodeId,
        l0: text.slice(0, 80),
        l1: text.length > 200 ? text.slice(0, 200) + '...' : text,
        l2: text,
        tags: ['mimir-outreach', String(trigger).slice(0, 32)],
        source: 'autonomous:mimir-outreach',
        edges: [{ target: row.target_node_id, type: 'associative', strength: scaleByArousal(0.5, alphaO) }],
        node_type: 'self_act',
        subkind: 'outreach',
        skipDedup: true,
        weight: scaleByArousal(0.7, alphaO),
        event_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[MimirActionWorker] outreach node-write failed (Telegram succeeded): ${e.message?.slice(0, 200)}`);
      outreachNodeId = null;
    }
    this.#done(row, outreachNodeId, OUTREACH_MODEL);
  }

  #buildOutreachPrompt(target, trigger) {
    const triggerHint = {
      'profile_gap':       'The user mentioned a topic for which our profile dimension is empty/weak. A single targeted question would fill it.',
      'disambiguation':    'Two profile dimensions conflict. A single targeted question would resolve which is current.',
      'continuation':      'A prior conversation explicitly left a thread open. Re-open it.',
    }[trigger.replace(/^outreach:/, '')] || 'Mímir-detected legitimate trigger.';
    return [
      'You are Mímir, drafting ONE short outreach message to the user on Telegram.',
      'This crosses the user\'s attention surface — you may decline if the question would not be valuable.',
      '',
      'TRIGGER:',
      `  ${triggerHint}`,
      '',
      'RELATED NODE:',
      `  id=${target.id}`,
      `  ${this.#summarizeNode(target)}`,
      '',
      'Output ONLY valid JSON (no prose, no fences):',
      '{"send":true,"text":"<≤200 chars: one specific question the user can answer in a sentence>"}',
      '',
      'Constraints:',
      '- ONE question, not multiple.',
      '- Specific over general — refer to the node by what it is, not by ID.',
      '- Match the user\'s language; default to English.',
      '- Decline (send:false) if you cannot frame a useful, non-trivial question. Empty text means no send.',
    ].join('\n');
  }

  #suppressOutreach(rowId, reason, opts = {}) {
    // Update audit row to 'suppressed' so anti-loop counts it correctly
    // (suppressed rows do NOT count as zero-response — only sent-no-reply does).
    // r12 Gap 2: when caller passes {ownerId, trigger, targetNodeId}, narrow
    // the WHERE clause to composite key so concurrent suppress operations on
    // different triggers don't clobber each other's pending rows.
    const ownerId = opts?.ownerId != null ? String(opts.ownerId) : null;
    const trig = opts?.trigger != null ? String(opts.trigger) : null;
    const tgt = opts?.targetNodeId != null ? String(opts.targetNodeId) : null;
    try {
      if (ownerId && trig != null) {
        this.#conversationsDb.prepare(
          "UPDATE mimir_outreach_audit SET decision='suppressed', query_sent=? " +
          "WHERE id = (SELECT MAX(id) FROM mimir_outreach_audit " +
          "            WHERE decision='pending' AND owner_id=? AND trigger=? " +
          "            AND COALESCE(mention_node_id,'')=COALESCE(?,''))"
        ).run(`suppressed:${reason}`.slice(0, 280), ownerId, trig, tgt);
      } else if (ownerId) {
        this.#conversationsDb.prepare(
          "UPDATE mimir_outreach_audit SET decision='suppressed', query_sent=? " +
          "WHERE id = (SELECT MAX(id) FROM mimir_outreach_audit " +
          "            WHERE decision='pending' AND owner_id=?)"
        ).run(`suppressed:${reason}`.slice(0, 280), ownerId);
      } else {
        this.#conversationsDb.prepare(
          "UPDATE mimir_outreach_audit SET decision='suppressed', query_sent=? " +
          "WHERE id = (SELECT MAX(id) FROM mimir_outreach_audit WHERE decision='pending')"
        ).run(`suppressed:${reason}`.slice(0, 280));
      }
    } catch { /* best-effort */ }
    return this.#fail(rowId, `outreach_suppressed:${reason}`);
  }

  // ─── Shared helpers ───────────────────────────────────────────────────

  #fetchNeighbors(nodeId, k) {
    const _btSqlE = (typeof this.#engine._bitemporalSqlClause === 'function')
      ? this.#engine._bitemporalSqlClause('e').sql
      : '';
    const rows = this.#engine.db.prepare(
      "SELECT n.id, n.l0, n.l1, n.l2, n.tags FROM edges e " +
      "JOIN nodes n ON n.id = e.target " +
      `WHERE e.source = ? AND e.state = 'active'${_btSqlE} AND n.state = 'active' ` +
      "ORDER BY e.strength DESC LIMIT ?"
    ).all(nodeId, k);
    return rows;
  }

  #summarizeNode(n) {
    if (!n) return '(missing)';
    const l0 = (n.l0 || '').slice(0, 80);
    const l2 = (n.l2 || '').slice(0, 200).replace(/\s+/g, ' ');
    return `${l0} — ${l2}`;
  }

  // Calls the underlying LLM with full IR-pipeline injection when a runtime
  // is wired. The synthetic sessionId (e.g. 'mimir-autonomous-reflection')
  // routes through deriveCurrentUser → channel='autonomous', isOwner:true,
  // and — crucially — has no rows in conversations.db, so L4 raw history is
  // empty. L1 persona, L2 preamble, L3 constellation+pool still inject.
  // The user prompt remains the existing tightly-scoped JSON-output ask;
  // only the system context is enriched.
  async #callLLM(model, prompt, sessionId, focusHint, ownerId = null) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
      const messages = [];
      if (this.#runtime) {
        // The IR pipeline branches on options.trigger==='mimir_autonomous'
        // to skip episodic / digest / compile / reasoning fetches; pool
        // and Layer-1/2/3 constellation still render.
        try {
          const focus = (typeof focusHint === 'string' && focusHint.trim())
            ? focusHint.slice(0, 500)
            : prompt.slice(0, 500);
          // 60s ceiling on the IR build — buildSystemPrompt fans out to ~6
          // Mímir HTTP endpoints + BFS render. Bounded by topology size, not
          // by proxy latency, so a generous-but-finite cap is safe; falling
          // through to flat-prompt protects the drain loop if BFS regresses.
          const sysPrompt = await Promise.race([
            this.#runtime.buildSystemPrompt(
              sessionId || 'mimir-action-worker',
              focus,
              { trigger: 'mimir_autonomous', source: 'mimir_action_worker' },
            ),
            new Promise((_, rej) => setTimeout(() => rej(new Error('buildSystemPrompt_timeout_60s')), 60_000)),
          ]);
          if (sysPrompt && typeof sysPrompt === 'string' && sysPrompt.trim()) {
            messages.push({ role: 'system', content: sysPrompt });
          }
        } catch (e) {
          // System-prompt build failure is non-fatal — fall through to
          // flat prompt rather than failing the whole action.
          console.warn(`[MimirActionWorker] buildSystemPrompt failed (${e.message}); using flat prompt`);
        }
      }
      // L1: prepend "recent Mímir actions" preamble to the user message so the
      // LLM translator sees what was already synthesised in the last 5h.
      // Preamble is small (~15 short lines, ~1KB) and sits in the user slot so it
      // never collides with runtime.buildSystemPrompt's IR injection budget.
      let user = prompt;
      try {
        const preamble = this.#buildL1Preamble(ownerId);
        if (preamble) user = `${preamble}\n${prompt}`;
      } catch (e) {
        console.warn(`[MimirActionWorker] L1 preamble inject failed: ${e.message}`);
      }
      messages.push({ role: 'user', content: user });

      // Streaming with role='worker' so the router applies the worker hard
      // ceiling (15 min). We accumulate text from deltas and fall back to
      // response.content if the proxy batches everything into a single
      // non-delta finish event.
      let fullText = '';
      let doneResponse = null;
      const stream = this.#llm.streamChat(messages, {
        model,
        _role: 'worker',
        temperature: 0.3,
        maxTokens: LLM_MAX_TOKENS,
        _trigger: 'mimir-action-worker',
        _sessionId: sessionId || 'mimir-action-worker',
        signal: ctrl.signal,
      });
      const abortPromise = new Promise((_, reject) => {
        if (ctrl.signal.aborted) return reject(new Error('aborted'));
        ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      try {
        while (true) {
          const iter = await Promise.race([stream.next(), abortPromise]);
          if (iter.done) break;
          const event = iter.value;
          if (event.type === 'text_delta' && event.text) {
            fullText += event.text;
          } else if (event.type === 'done') {
            doneResponse = event.response || null;
            break;
          }
        }
      } finally {
        try { await stream.return(); } catch { /* generator already closed */ }
      }
      if (!fullText && doneResponse) {
        fullText = doneResponse.content || doneResponse.text || '';
      }
      return fullText;
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── L1 anti-repetition: recent-actions preamble ──────────────────────
  // Pulls last-5h done mimir_actions for this owner, joins to engine.db nodes
  // for l0, formats as a short bulleted preamble. Two queries (no ATTACH) —
  // conversations.db and engine.db are separate handles.
  #fetchRecentMimirActions(ownerId, hoursBack = L1_PREAMBLE_HOURS, limit = L1_PREAMBLE_LIMIT) {
    if (!this.#stmts) return [];
    try {
      const cutoff = new Date(Date.now() - hoursBack * 3600_000).toISOString();
      const rows = this.#conversationsDb.prepare(
        "SELECT mode, target_node_id, write_node_id, ts " +
        "FROM mimir_actions WHERE status='done' AND write_node_id IS NOT NULL " +
        "AND owner_id=? AND ts>=? " +
        "ORDER BY ts DESC LIMIT ?"
      ).all(ownerId || 'self', cutoff, limit);
      if (rows.length === 0) return [];

      const ids = rows.map(r => r.write_node_id).filter(Boolean);
      if (ids.length === 0) return [];
      const placeholders = ids.map(() => '?').join(',');
      const nodeRows = this.#engine.db.prepare(
        `SELECT id, l0 FROM nodes WHERE id IN (${placeholders}) AND state='active'`
      ).all(...ids);
      const l0ById = new Map(nodeRows.map(n => [n.id, n.l0 || '']));

      const now = Date.now();
      return rows.map(r => {
        const ts = new Date(r.ts).getTime();
        const ageMin = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 60_000)) : null;
        return {
          mode: r.mode,
          ageMin,
          l0: (l0ById.get(r.write_node_id) || '').slice(0, 80),
        };
      }).filter(r => r.l0); // drop entries where the node was pruned
    } catch (e) {
      console.warn(`[MimirActionWorker] L1 preamble fetch failed: ${e.message}`);
      return [];
    }
  }

  #buildL1Preamble(ownerId) {
    const recent = this.#fetchRecentMimirActions(ownerId);
    if (recent.length === 0) return '';
    const lines = recent.map(r => {
      const age = r.ageMin !== null ? `${r.ageMin}m ago` : '? ago';
      return `  [${r.mode} ${age}] ${r.l0}`;
    });
    return [
      `RECENT MIMIR ACTIONS (last ${L1_PREAMBLE_HOURS}h — DO NOT re-synthesise these; if your output would duplicate one, return empty fields):`,
      ...lines,
      '',
    ].join('\n');
  }

  // ─── L2 anti-repetition: pre-commit BGE cosine dedup ──────────────────
  // Returns { collision: bool, existingId, cosSim }. Embedding failure or
  // query error → { collision: false } (fail-open: do not block writes on
  // transient infra hiccups; user-perceived activity > strict dedup).
  async #checkL2Dedup(l0, l1, ownerId) {
    if (!l0) return { collision: false };
    let embedding;
    try {
      embedding = await this.#engine._embed(`${l0} ${l1 || ''}`);
    } catch (e) {
      console.warn(`[MimirActionWorker] L2 embed failed (${e.message}); proceeding without dedup`);
      return { collision: false };
    }
    if (!embedding) return { collision: false };

    try {
      const cutoff = new Date(Date.now() - L2_DEDUP_HOURS * 3600_000).toISOString();
      // vec0 quirk: LIMIT must be a literal int, not a bound parameter — see
      // existing patterns at engine.cjs:962/2130 and the L2_KNN_LIMIT constant.
      const vecResults = this.#engine.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ${L2_KNN_LIMIT}`
      ).all(embedding);
      if (vecResults.length === 0) return { collision: false };

      // Resolve rowids to node ids in bulk
      const rowidList = vecResults.map(r => r.id);
      const phRowid = rowidList.map(() => '?').join(',');
      const mapRows = this.#engine.db.prepare(
        `SELECT rowid, node_id FROM node_rowids WHERE rowid IN (${phRowid})`
      ).all(...rowidList);
      const rowidToNodeId = new Map(mapRows.map(m => [m.rowid, m.node_id]));
      if (rowidToNodeId.size === 0) return { collision: false };

      // Post-filter: only autonomous-mimir nodes for this owner, last 5h
      const ids = [...rowidToNodeId.values()];
      const phIds = ids.map(() => '?').join(',');
      const nodeRows = this.#engine.db.prepare(
        `SELECT id FROM nodes ` +
        `WHERE id IN (${phIds}) AND state='active' ` +
        `AND source LIKE 'autonomous:mimir-%' AND owner_id=? AND created_at>=?`
      ).all(...ids, ownerId || 'self', cutoff);
      if (nodeRows.length === 0) return { collision: false };
      const filteredIds = new Set(nodeRows.map(n => n.id));

      let bestSim = -1;
      let bestId = null;
      for (const r of vecResults) {
        const nodeId = rowidToNodeId.get(r.id);
        if (!nodeId || !filteredIds.has(nodeId)) continue;
        const cosSim = 1 - (r.distance * r.distance) / 2;
        if (cosSim > bestSim) {
          bestSim = cosSim;
          bestId = nodeId;
        }
      }
      if (bestSim >= L2_DEDUP_COSINE) {
        return { collision: true, existingId: bestId, cosSim: bestSim };
      }
      return { collision: false };
    } catch (e) {
      console.warn(`[MimirActionWorker] L2 dedup query failed (${e.message}); proceeding without dedup`);
      return { collision: false };
    }
  }

  #parseJson(text) {
    if (!text) return null;
    let raw = text.trim();
    // Tolerate markdown fences
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(raw); }
    catch {
      // Salvage: first {...} block
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { return JSON.parse(m[0]); } catch { return null; }
    }
  }

  #done(row, writeId, model) {
    try { this.#stmts.markDone.run(writeId, model, new Date().toISOString(), row.id); }
    catch (e) { console.warn(`[MimirActionWorker] markDone(${row.id}) failed: ${e.message}`); }
    liveBus.safeEmit('engine.mimir_action', {
      stage: 'done',
      id: row.id,
      mode: row.mode,
      write: (writeId || '').toString().slice(0, 40),
      model,
    });
  }

  #fail(id, reason) {
    try { this.#stmts.markFailed.run(reason, new Date().toISOString(), id); }
    catch (e) { console.warn(`[MimirActionWorker] markFailed(${id}) failed: ${e.message}`); }
    liveBus.safeEmit('engine.mimir_action', { stage: 'failed', id, reason: String(reason || '').slice(0, 80) });
  }

  #stale(id, reason) {
    try { this.#stmts.markStale.run(reason, new Date().toISOString(), id); }
    catch (e) { console.warn(`[MimirActionWorker] markStale(${id}) failed: ${e.message}`); }
    liveBus.safeEmit('engine.mimir_action', { stage: 'stale', id, reason: String(reason || '').slice(0, 80) });
  }
}
