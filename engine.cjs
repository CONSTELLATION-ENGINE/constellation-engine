// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Constellation Engine v0.4 — R2: Tube Diameter Decay
 * Star-map engine core: topological memory network
 * 
 * R2 changes: Hebb strengthening on render, differential decay,
 * endangered-node dreamCollide priority, identity/principle immunity
 * 
 * API: remember / rememberRaw / render / forget / dream
 * Storage: better-sqlite3 + sqlite-vec + BGE-M3 (via Mímir daemon)
 * LLM: OpenAI-compatible endpoint
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
let liveBus = null;
try { liveBus = require('./src/live-bus.cjs'); } catch {}

const DB_PATH = path.join(__dirname, 'constellation.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const EMBED_DIM = 1024;

// Star map ownership (B6 migration 2026-04-21; Plan C2 ALS rewire 2026-04-25).
// Stamp on every nodes/edges INSERT. Resolved via this._resolveOwnerStamp(),
// which prefers ALS identity (set by main.js installing _identityResolver), then
// falls back to legacy this._currentUserOwnerId field (for direct CJS callers
// like scripts/* and CRON_INSTRUCTIONS), then to 'self'.
// Hardcoded 'self' — see src/user-identity.js STAR_MAP_OWNER for rationale.
const STAR_MAP_OWNER_ID_DEFAULT = 'self';
const TAXONOMY_PATH = path.join(__dirname, 'config', 'node_taxonomy.json');

// ── Tag taxonomy (loaded once at startup) ──
let _taxonomy = null;
try {
  const taxRaw = JSON.parse(fs.readFileSync(TAXONOMY_PATH, 'utf8'));
  const tier1 = new Set();
  const allTags = new Set();
  for (const cat of ['knowledge', 'behavior', 'system']) {
    for (const d of (taxRaw.domains?.[cat] || [])) tier1.add(d.tier1_tag);
  }
  for (const [, tags] of Object.entries(taxRaw.tier2_tags || {})) {
    if (Array.isArray(tags)) tags.forEach(t => allTags.add(t));
  }
  (taxRaw.tier3_tags?.tags || []).forEach(t => allTags.add(t));
  (taxRaw.tier4_tags?.tags || []).forEach(t => allTags.add(t));
  tier1.forEach(t => allTags.add(t));
  // Build Tier 2 → Tier 1 reverse mapping for auto-inference
  const tier2ToTier1 = {};
  for (const [tier1Tag, tags] of Object.entries(taxRaw.tier2_tags || {})) {
    if (Array.isArray(tags)) tags.forEach(t => { tier2ToTier1[t] = tier1Tag; });
  }
  _taxonomy = { tier1, allTags, behavior: new Set(taxRaw.ir_routing?.behavior_domains || []), tier2ToTier1 };
} catch (e) {
  // taxonomy optional — runs without validation if missing
}

// LLM config for envelope generation
// Default: route through local OAuth gateway (same as runtime)
// Override with CONSTELLATION_LLM_* env vars if needed
const LLM_PROVIDER = process.env.CONSTELLATION_LLM_PROVIDER || 'openai-compat';
const LLM_BASE_URL = process.env.CONSTELLATION_LLM_URL || 'http://127.0.0.1:3456';
const LLM_API_KEY = process.env.CONSTELLATION_LLM_KEY || 'constellation-local';
const LLM_MODEL = process.env.CONSTELLATION_LLM_MODEL || '';
const CONSOLIDATION_MODEL = process.env.CONSTELLATION_CONSOLIDATION_MODEL || '';
const CONSOLIDATION_COSINE_THRESHOLD = 0.65;  // cosine sim above this → send to consolidation model (lowered 0.70→0.65 2026-05-18 to catch real-duplicate band 0.65-0.70)
const CONSOLIDATION_ENABLED = process.env.CONSTELLATION_CONSOLIDATION !== '0';

// ── Timeline Merge (A4) — 4th consolidation verdict: same-topic arc merging ──
// Config source: config.json engine.timelineMerge.{enabled,maxSections,maxChars,windowDays,minGapHours}
// Defaults mirror locked R1 decisions: Q1=b(config flag), Q2=a(30d), Q4=a(6 sections)
let _engineConfigFile = null;
try { _engineConfigFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const _tmCfg = _engineConfigFile?.engine?.timelineMerge || {};
const TIMELINE_MERGE_ENABLED = _tmCfg.enabled !== false;
const TIMELINE_MERGE_MAX_SECTIONS = Number.isFinite(_tmCfg.maxSections) ? _tmCfg.maxSections : 6;
const TIMELINE_MERGE_MAX_CHARS = Number.isFinite(_tmCfg.maxChars) ? _tmCfg.maxChars : 12000;
const TIMELINE_MERGE_MIN_GAP_HOURS = Number.isFinite(_tmCfg.minGapHours) ? _tmCfg.minGapHours : 2;

function extractFirstJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null;
}

// Multi-SA edge whitelist — used by _callConsolidationJudge to validate the judge LLM's EDGE_TYPE output.
// Source of truth: engine-output/architecture-research/PLAN-MULTI-SA-REACTIVATION.md §4.1
// 23 types across 3 channels. Hallucinated types are dropped + logged; optional fallback to
// FALLBACK_COARSE (5 coarse types) keeps the connection signal recoverable.
const CONSOLIDATION_EDGE_WHITELIST = new Set([
  // Knowledge channel (epistemic)
  'causal', 'contrastive', 'hierarchical',
  'supports', 'contradicts', 'causes',
  'extends', 'synthesizes', 'challenges',
  'contextualizes', 'contrasts',
  // Language channel (stylistic / associative / narrative)
  'associative', 'temporal',
  'inspires', 'parallels', 'exemplifies', 'complements',
  // Scaffold channel (procedural / structural) — formerly "Reflex", renamed 2026-04-16
  'enables', 'triggers', 'depends_on',
  'contains', 'supersedes', 'builds_on',
  // Mímir tension-resolution: a synthesis node points to the two contradicting endpoints.
  'resolves',
]);

// Edge Evolution v1 (2026-04-26): closed 35-fine-type subset per coarse type.
// Used by addEdges to validate optional fine_type, by updateEdgeFineType to gate refines,
// and exported on the class for worker reuse. NEVER read by Multi-SA channel routing —
// that path keys off edge_type (5 coarse) only. See architecture-research/2026-04-26-*.
const FINE_TYPES_BY_COARSE = {
  causal:        ['enables', 'prevents', 'requires', 'triggers', 'undermines', 'mitigates', 'explains'],
  contrastive:   ['contradicts', 'challenges', 'refines', 'narrows', 'generalizes', 'tension', 'alternative'],
  hierarchical:  ['contains', 'specializes', 'exemplifies', 'aggregates', 'decomposes', 'is_a', 'part_of'],
  associative:   ['co_occurs', 'reminiscent_of', 'inspires', 'resonates', 'parallels', 'evokes', 'contextualizes'],
  temporal:      ['precedes', 'follows', 'concurrent', 'triggers_next', 'culminates_in', 'preempts', 'recurs'],
};
const ALLOWED_FINE_SOURCE_PREFIXES = ['autonomous:mimir-', 'consolidation', 'manual'];
function _isFineSourceAllowed(src) {
  if (!src) return false;
  return ALLOWED_FINE_SOURCE_PREFIXES.some(p => src.startsWith(p));
}

// Per-type fusion cosine thresholds (from taxonomy attribute matrix)
// Higher threshold = harder to trigger fusion. Types not listed use default 0.70.
const FUSION_THRESHOLD_BY_TYPE = {
  'identity':             Infinity,  // never fuse
  'milestone':            Infinity,  // never fuse
  'principle':            Infinity,  // never fuse (revision only)
  'diary':                Infinity,  // never fuse (each entry is unique)
  'experiment':           Infinity,  // never fuse (each experiment is independent)
  'relationship':         Infinity,  // never fuse (in-place update only)
  'profile-dim':          Infinity,  // never fuse — dialectic adds new dim, never overwrites (master plan §7)
  'reflection':           Infinity,  // Mímir reflection — preserve each synthesis individually
  'tension-resolution':   Infinity,  // Mímir tension synthesis — preserve each resolution individually
  'social-rule':          0.90,      // very high threshold
  'language-template':    0.90,      // very high threshold
  'theory':               0.85,      // low-frequency fusion
  'reading-note':         0.85,      // low-frequency fusion
  'action':               0.85,      // low-frequency fusion (step iteration)
  'general-knowledge':    0.85,      // almost never fuse
  'introspection':        0.80,      // moderate threshold
  'decision':             0.75,      // same decision chain can fuse
  'engineering':          0.70,      // standard — frequent supersede
  'observation':          0.70,      // standard — time-sensitive
  'conversation-insight': 0.70,      // standard
  'interaction':          0.70,      // explicit: INDEPENDENT-only via ALLOWED_OPS; kept at default so judge can confirm edge type
  'knowledge':            0.70,      // default
};

// Per-type allowed consolidation operations (Section 19.1 of master plan)
// Types not listed allow all operations. null = type uses Infinity threshold (never reaches judge).
const ALLOWED_OPS_BY_TYPE = {
  'social-rule':          ['INDEPENDENT'],
  'language-template':    ['INDEPENDENT'],
  'general-knowledge':    ['INDEPENDENT'],
  'theory':               ['FUSE', 'SUPERSEDE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'reading-note':         ['FUSE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'introspection':        ['FUSE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'decision':             ['SUPERSEDE', 'INDEPENDENT'],
  'engineering':          ['FUSE', 'SUPERSEDE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'observation':          ['FUSE', 'SUPERSEDE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'conversation-insight': ['FUSE', 'SUPERSEDE', 'TIMELINE_MERGE', 'INDEPENDENT'],
  'knowledge':            ['FUSE', 'SUPERSEDE', 'INDEPENDENT'],
  'action':               ['INDEPENDENT'],
  'interaction':          ['INDEPENDENT'],
  'profile-dim':          ['INDEPENDENT'],
  'reflection':           ['INDEPENDENT'],
  'tension-resolution':   ['INDEPENDENT'],
  'self_act':             ['FUSE', 'TIMELINE_MERGE', 'INDEPENDENT'],
};

// Sources that are user-authored (not autonomous/debrief). Auto-supersede + dialectic
// supersede are blocked when target.source matches one of these AND superseder is not
// session-debrief / autonomous:mimir-*. Master plan §10: profile-update cluster collapse.
const USER_AUTHORED_SOURCE_PREFIXES = [
  'session-write', 'manual', 'telegram:', 'dashboard:', 'cron:user',
];
const USER_AUTHORED_SOURCE_EXACT = new Set([
  'session-write', 'manual', 'foreign:dashboard',
  'telegram', 'dashboard', 'cron',  // bare forms — telegram.js/dashboard.js/cron.js write these without colon
]);
function _isUserAuthoredSource(source) {
  if (!source) return true;  // NULL legacy rows treated as user-authored — defensive
  if (USER_AUTHORED_SOURCE_EXACT.has(source)) return true;
  return USER_AUTHORED_SOURCE_PREFIXES.some(p => source.startsWith(p));
}

class ConstellationEngine {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');  // 5s — Mímir batch writes can hold lock for 1-3s; better to wait than throw
    this.db.pragma('synchronous = NORMAL'); // fsync on commit only — prevents corruption from partial writes while avoiding FULL I/O cost
    this._adjCache = null;         // adjacency list cache for render() BFS
    this._adjCacheVersion = 0;     // incremented by remember()/dream() to invalidate cache
    this._consolidationStats = { fuse: 0, supersede: 0, independent: 0, checked: 0, unfusable_skipped: 0, no_neighbors: 0, below_threshold: 0 };
    this._consolidationLastHeartbeat = Date.now();
    this._renderNodeFn = null;     // lazy-loaded narrative-ir renderNode function
    this._currentUserOwnerId = null; // legacy per-call fallback (CJS scripts only). ALS path preferred.
    this._identityResolver = null;   // installed by main.js: () => getStarMapOwnerId(getCurrentIdentity())
    this.llmRouter = null;           // installed by main.js after LLMRouter constructed; cold-start routes via setLLMRouter()
    // access_count buffered increments — flushed every 30s out-of-band to avoid render-time lock contention
    this._accessBumps = new Map(); // node_id -> count
    this._accessFlushTimer = setInterval(() => this._flushAccessBumps(), 30_000);
    if (this._accessFlushTimer.unref) this._accessFlushTimer.unref();
    this._lastConsolidationSummary = { ...this._consolidationStats };
    this._consolidationSummaryTimer = setInterval(() => {
      try {
        const cur = this._consolidationStats;
        const prev = this._lastConsolidationSummary || {};
        const delta = {
          fuse: (cur.fuse || 0) - (prev.fuse || 0),
          supersede: (cur.supersede || 0) - (prev.supersede || 0),
          timeline_merge: (cur.timelineMerge || 0) - (prev.timelineMerge || 0),
          independent: (cur.independent || 0) - (prev.independent || 0),
          checked: (cur.checked || 0) - (prev.checked || 0),
        };
        const total = delta.fuse + delta.supersede + delta.timeline_merge + delta.independent + delta.checked;
        if (total > 0 && liveBus) {
          liveBus.safeEmit('engine.consolidation.summary', delta);
        }
        this._lastConsolidationSummary = { ...cur };
      } catch {}
    }, 60_000);
    if (this._consolidationSummaryTimer.unref) this._consolidationSummaryTimer.unref();
    // Boot banner — confirm consolidation wiring is loaded
    const _consEnabled = process.env.CONSTELLATION_CONSOLIDATION !== '0';
    console.log(`[Consolidation] ✓ ready (enabled=${_consEnabled}, silent path logged per-check)`);
    // Cold-start dispatcher state (Phase 9.5).
    // Architecture A: bootstrap loop lives in engine.cjs, not in mimir-js. The
    // tick reads gate state and routes to bootstrap controller XOR steady-state
    // v3 picker. mimir-js v1 hardcodes autonomy off, so the steady-state branch
    // is a no-op until the picker is ported. State is engine-local; cross-restart
    // continuity comes from engine_meta rows.
    this._coldStart = {
      lastPhase: null,                  // 'bootstrap' | 'steady' | 'expired' | null
      tickCount: 0,
      tickInProgress: false,            // re-entrancy guard
      lastTickAt: 0,
      messagesCountCache: { value: null, ts: 0, ttlMs: 60_000 },
      messagesCountResolver: null,      // installed by main.js: () => convStore.db.prepare(...).get().c
      mimirActionsResolver: null,       // installed by main.js: ({sinceMs, limit}) => rows
      llmExpansionInflight: false,      // Q5/H3: only one LLM expansion job at a time
    };
    this._init();
    // Verify daemon embed endpoint is reachable (non-blocking)
    fetch(`http://127.0.0.1:${process.env.MIMIR_PORT || 18810}/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ping' }),
    }).then(() => console.log('[Engine] BGE-M3 embedder ready (via daemon)'))
      .catch(() => console.warn('[Engine] Warning: daemon /embed not reachable yet'));

    // Cold-start dispatcher tick (Phase 9.5). 60s cadence: gate evaluation is
    // cheap, but the bootstrap controller fires LLM/HTTP work, so we keep it
    // unhurried. ENGINE_COLD_START=0 disables (kill-switch); env unset = on.
    if (process.env.ENGINE_COLD_START !== '0') {
      this._coldStartTimer = setInterval(() => {
        this._coldStartTick().catch(e => {
          console.warn('[ColdStart] tick error:', e.message);
        });
      }, 60_000);
      if (this._coldStartTimer.unref) this._coldStartTimer.unref();
    }

    // Lever B (2026-05-18) — periodic consolidation re-sweep.
    // Fires every 6h, judges up to 30 pairs in the cosSim ∈ [type_threshold, 0.95)
    // band that the write-time top-6 KNN missed or that drifted in after the
    // threshold drop. Kill-switch: ENGINE_CONSOLIDATION_RESWEEP=0.
    if (process.env.ENGINE_CONSOLIDATION_RESWEEP !== '0' && CONSOLIDATION_ENABLED) {
      this._consolidationResweepTimer = setInterval(() => {
        this._consolidationResweep({ windowDays: 30, maxPairs: 30 })
          .catch(e => console.warn('[Resweep] tick err:', e.message));
      }, 6 * 3600 * 1000);
      if (this._consolidationResweepTimer.unref) this._consolidationResweepTimer.unref();
    }
  }

  // ─── Owner scoping (B6 owner_id migration 2026-04-21, gated by ENGINE_OWNER_SCOPE) ──
  // Phase B reader filter. Default OFF = legacy behaviour. When ON, accepts rows
  // owned by current user OR shared ('*') OR legacy NULL (defensive).
  _ownerScopeOn() {
    return process.env.ENGINE_OWNER_SCOPE === '1';
  }
  /**
   * Resolve the owner_id stamp for star-map writes (Plan C2, 2026-04-25).
   * Precedence: ALS identity (via _identityResolver) → legacy _currentUserOwnerId
   * → STAR_MAP_OWNER_ID_DEFAULT. Returns the *string* stamp, never null.
   */
  _resolveOwnerStamp() {
    if (this._identityResolver) {
      try {
        const stamp = this._identityResolver();
        if (stamp) return stamp;
      } catch { /* fall through to legacy */ }
    }
    return this._currentUserOwnerId || STAR_MAP_OWNER_ID_DEFAULT;
  }
  _activeOwner() {
    return this._resolveOwnerStamp();
  }
  /**
   * Master plan §10 — Mímir-driven supersede must NOT clobber user-written nodes.
   * Block ONLY when an autonomous:mimir-* writer would supersede a user-authored target.
   * All legacy paths (consolidation `knowledge`, `inference`, manual edges, debrief) pass through
   * unchanged; only Mímir's own writes are constrained.
   * Returns true = allowed, false = blocked.
   */
  _isSupersedeAllowed(supersederSource, targetNodeId) {
    if (!supersederSource || !supersederSource.startsWith('autonomous:mimir-')) {
      return true;  // legacy / human / debrief writers unaffected
    }
    try {
      const row = this.db.prepare("SELECT source FROM nodes WHERE id = ?").get(targetNodeId);
      if (!row) return true;  // missing target — let SQL handle the no-op
      // Mímir is allowed to supersede other Mímir output and engine-authored nodes
      // (knowledge/inference/reflection). Block only on user-authored target.
      return !_isUserAuthoredSource(row.source);
    } catch {
      return true;  // never break writes on a guard-lookup failure
    }
  }
  /**
   * Post-fetch row filter. Use after SELECT * (which includes owner_id).
   * For non-* projections, see _ownerSqlClause().
   */
  _filterByOwner(rows) {
    if (!this._ownerScopeOn() || !rows) return rows;
    const owner = this._activeOwner();
    const ok = (r) => !r || r.owner_id == null || r.owner_id === owner || r.owner_id === '*';
    if (Array.isArray(rows)) return rows.filter(ok);
    return ok(rows) ? rows : null;
  }
  /**
   * SQL fragment + params for in-query filtering. Always returns a string fragment
   * starting with " AND " (or empty string when off) so it can splice into existing WHERE.
   * Pass an alias (e.g. 'n') when the query uses table aliases.
   */
  _ownerSqlClause(alias = null) {
    if (!this._ownerScopeOn()) return { sql: '', params: [] };
    const col = alias ? `${alias}.owner_id` : 'owner_id';
    return { sql: ` AND (${col} = ? OR ${col} = '*' OR ${col} IS NULL)`, params: [this._activeOwner()] };
  }
  /**
   * Bi-temporal read filter (Phase 1b, 2026-04-27). Returns a SQL fragment that
   * restricts edge reads to rows currently valid (`valid_to IS NULL`). State filter
   * is intentionally NOT bundled — callers keep their own `state='active'` clauses,
   * so dormant/diagnostic readers can drop just the bi-temporal half.
   * Env: MIMIR_BITEMPORAL_READ_FILTER=off disables (default on).
   * No bound params — the column is null-checked, not compared.
   */
  _bitemporalSqlClause(alias = null) {
    if (process.env.MIMIR_BITEMPORAL_READ_FILTER === 'off') return { sql: '', params: [] };
    const col = alias ? `${alias}.valid_to` : 'valid_to';
    return { sql: ` AND ${col} IS NULL`, params: [] };
  }

  /**
   * Zombie-edge defense (r14, 2026-05-13). Canonical invariant:
   *   an edge is "live" iff state='active' AND both endpoint nodes are
   *   state='active' AND superseded_at IS NULL.
   *
   * Single SQL fragment so every count / read enforces the same rule and
   * stays in sync with the cascade in _applySupersede/_applyFuse. Without it,
   * conn_count drifts from /api/graph/node which drifts from sa.js, and the
   * user sees "node has 3 edges but show-edges renders 0" type symptoms.
   *
   * Returns: SQL fragment to AND into an edges-table SELECT/UPDATE.
   * `edgeAlias` is the edges-table alias; defaults to `'edges'` for the bare
   * table case. Never call with `''` — the `nodes` table has a `source` column,
   * so bare `source`/`target` in the EXISTS subquery would resolve to the inner
   * `nodes.source` instead of the outer edge endpoint, making EXISTS always
   * false (root cause of the 2026-05-14 r21 edges:0 dashboard regression).
   */
  _validEdgeEndpointsSql(edgeAlias = 'edges') {
    const ep = `${edgeAlias}.`;
    return (
      ` AND EXISTS (SELECT 1 FROM nodes ns WHERE ns.id = ${ep}source AND ns.state = 'active' AND ns.superseded_at IS NULL)` +
      ` AND EXISTS (SELECT 1 FROM nodes nt WHERE nt.id = ${ep}target AND nt.state = 'active' AND nt.superseded_at IS NULL)`
    );
  }

  /**
   * Reactivate edges that were dormanted by an earlier endpoint going away, but
   * whose endpoints are *now* both active again. Called from every node
   * insert/replace path so a re-remember of a node that was previously
   * superseded restores its edge web in one shot.
   */
  _reactivateNodeEdges(nodeId) {
    return this.db.prepare(`
      UPDATE edges SET state = 'active'
      WHERE state = 'dormant'
        AND (source = ? OR target = ?)
        AND source IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
        AND target IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
    `).run(nodeId, nodeId).changes;
  }

  /**
   * Sweep edges still flagged active whose endpoints have drifted out of the
   * live set (deleted, superseded outside a FUSE/SUPERSEDE path, or otherwise
   * dormanted). Idempotent. Called once on engine boot and from the dream
   * cycle so manual deletes / migration backfills don't leave zombies.
   * Returns the number of edges dormanted (0 on a clean DB).
   */
  _sweepOrphanEdges() {
    try {
      const res = this.db.prepare(`
        UPDATE edges SET state = 'dormant'
        WHERE state = 'active'
          AND (
            source NOT IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
            OR target NOT IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
          )
      `).run();
      if (res.changes > 0) {
        console.log(`[Engine] _sweepOrphanEdges: dormanted ${res.changes} edges with dead endpoints`);
        this._adjCacheVersion++;
      }
      return res.changes;
    } catch (err) {
      console.warn(`[Engine] _sweepOrphanEdges failed: ${err.message}`);
      return 0;
    }
  }

  /**
   * Schema migration runner (2026-05-03). Reads scripts/migrations/NNNN-*.sql in
   * sorted order and applies any with version > MAX(schema_version.version) inside
   * a transaction. The schema.sql baseline counts as v1, so 0001-baseline.sql is
   * a no-op marker that just stamps version=1.
   *
   * On failure, throws an Error with .migrationFailure=true so src/main.js can
   * exit(78) and let electron/main.js show a recovery dialog instead of the
   * generic crash modal. We never auto-rollback partial migrations — better to
   * leave the user with a clear "migration X failed, see logs" than to mask
   * data loss with a silent retry.
   */
  _runMigrations() {
    const migrationsDir = path.join(__dirname, 'scripts', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      // Packaging bug if this fires in production — fresh installs need the
      // baseline marker. Loud warn so it shows up in launcher log capture.
      console.warn(`[Engine] scripts/migrations/ missing at ${migrationsDir} — skipping migration chain (packaging issue?)`);
      return;
    }

    // The runner owns schema_version. schema.sql intentionally does NOT create
    // it — keeps the bookkeeping responsibility in one place.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        description TEXT
      )
    `);

    let currentVersion = 0;
    try {
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get();
      currentVersion = Number(row?.v) || 0;
    } catch (e) {
      const err = new Error(`schema_version read failed: ${e.message}`);
      err.migrationFailure = true;
      throw err;
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => /^\d{4}-.+\.sql$/.test(f))
      .sort();

    for (const f of files) {
      const m = f.match(/^(\d{4})-(.+)\.sql$/);
      const version = parseInt(m[1], 10);
      if (version <= currentVersion) continue;
      const description = m[2].replace(/\.sql$/, '').replace(/[-_]/g, ' ');
      const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf-8');

      const apply = this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare(
          'INSERT INTO schema_version (version, description) VALUES (?, ?)'
        ).run(version, description);
      });

      try {
        console.log(`[Engine] Applying migration ${f}...`);
        apply();
        console.log(`[Engine] Migration ${f} applied (v${version}).`);
      } catch (e) {
        const err = new Error(`Migration ${f} failed: ${e.message}`);
        err.migrationFailure = true;
        err.migrationFile = f;
        err.migrationVersion = version;
        err.original = e;
        throw err;
      }
    }
  }

  _init() {
    // Load sqlite-vec extension
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(this.db);

    // Apply schema (exec handles multiple statements including BEGIN...END triggers)
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    this.db.exec(schema);

    // Schema migration chain (2026-05-03). schema.sql is the v0.1.0 baseline; every
    // future schema change ships as a numbered file in scripts/migrations/. Throws
    // a tagged error on failure so src/main.js can exit(78) → electron/main.js
    // surfaces a recovery dialog instead of a generic crash modal.
    this._runMigrations();

    // Cold-start substrate (Phase 9.0): stamp first_run_at exactly once.
    // INSERT OR IGNORE preserves the original epoch across restarts. Cold-start
    // gate (engine.cjs Phase 9.5) reads this to compute the 30d hard exit.
    // autonomy_enabled_at stamped separately on first autonomy toggle.
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO engine_meta (key, value) VALUES ('first_run_at', CAST(strftime('%s','now')*1000 AS TEXT))"
      ).run();
    } catch (e) {
      console.warn('[Engine] first_run_at stamp failed:', e.message);
    }

    // Create vec0 virtual table — migrate from 384d to 1024d if needed
    try {
      this.db.exec(`CREATE VIRTUAL TABLE node_embeddings USING vec0(id integer primary key, embedding float[${EMBED_DIM}])`);
    } catch (e) {
      if (e.message.includes('already exists')) {
        // Check if dimension mismatch (migration from MiniLM 384d to BGE-M3 1024d)
        try {
          const row = this.db.prepare('SELECT embedding FROM node_embeddings LIMIT 1').get();
          if (row && row.embedding && row.embedding.length !== EMBED_DIM * 4) {
            console.log(`[Engine] Migrating vec0 table from ${row.embedding.length / 4}d to ${EMBED_DIM}d...`);
            this.db.exec('DROP TABLE node_embeddings');
            this.db.exec(`CREATE VIRTUAL TABLE node_embeddings USING vec0(id integer primary key, embedding float[${EMBED_DIM}])`);
            console.log(`[Engine] vec0 table recreated with ${EMBED_DIM}d. Nodes need re-embedding.`);
          }
        } catch (migErr) {
          // Empty table or other issue — table exists and is fine
          console.log('[Engine] vec0 table exists, no migration needed or table empty.');
        }
      } else {
        throw e;
      }
    }

    // Optimization 3: ensure (target, state) composite index exists for incoming-edge queries
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_edges_target_state ON edges(target, state)");

    // Consolidation verdict log (additive — separate from nodes.superseded_*; survives node dormancy)
    // Captures every FUSE/SUPERSEDE/TIMELINE_MERGE/INDEPENDENT decision with both ids + verdict + ts.
    // Read by dashboard Recent Activity ("old → new" jumps) and audit/replay tooling.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        verdict TEXT NOT NULL,
        new_node_id TEXT,
        old_node_id TEXT,
        new_l0 TEXT,
        old_l0 TEXT,
        cosine REAL,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_consolidation_log_created ON consolidation_log(created_at DESC)");

    // Phase 9.3 — Launcher OS-notification outbox.
    // Internal callers (bootstrap fetch/outreach, Mímir error surfaces) push
    // a row; the Electron launcher polls /api/launcher/notifications/dequeue
    // every 15s and fires a real OS notification per row, then deletes it.
    // delivered_at is set the moment we hand it to the launcher (poll model);
    // rows older than 24h get reaped on engine boot to keep the table small.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        deeplink TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_notification_outbox_created ON notification_outbox(delivered_at, created_at)");
    try {
      this.db.prepare("DELETE FROM notification_outbox WHERE created_at < datetime('now','-24 hours')").run();
    } catch {}

    // ── Edge Evolution v1 (2026-04-26) ──
    // Dual-storage fine_type richness layer. edge_type stays 5-coarse (Multi-SA channel
    // routing depends on it); fine_type/fine_confidence/fine_source are additive richness
    // populated by Curation mode + consolidation. NEVER read by SA channel routing.
    // See engine-output/architecture-research/2026-04-26-edge-evolution-deployment-plan.md
    for (const stmt of [
      "ALTER TABLE edges ADD COLUMN fine_type TEXT DEFAULT NULL",
      "ALTER TABLE edges ADD COLUMN fine_confidence REAL DEFAULT NULL",
      "ALTER TABLE edges ADD COLUMN fine_source TEXT DEFAULT NULL",
    ]) {
      try { this.db.exec(stmt); } catch (e) {
        if (!String(e.message).includes('duplicate column')) throw e;
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_edges_fine_type ON edges(fine_type) WHERE fine_type IS NOT NULL");

    // ── Event time column (2026-04-26) ──
    // event_at = source-time the content describes (e.g. yesterday's diary written today).
    // Distinct from created_at (wall-clock write time). NULL = caller didn't specify;
    // dashboard falls back to created_at for display in that case.
    try { this.db.exec("ALTER TABLE nodes ADD COLUMN event_at TEXT DEFAULT NULL"); }
    catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_event_at ON nodes(event_at) WHERE event_at IS NOT NULL");

    // ── Memory Migration Importer batch tag (2026-04-29) ──
    // Stamped by scripts/tools/migrate_memory.py; NULL = organic node.
    // Drives SA pool soft-suppression (mimir_daemon: 0.4x while access_count<5)
    // and rollback (--rollback-batch). Schema mirrored in OSS schema.sql.
    try { this.db.exec("ALTER TABLE nodes ADD COLUMN imported_batch_id TEXT"); }
    catch (e) { if (!String(e.message).includes('duplicate column')) throw e; }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_imported_batch ON nodes(imported_batch_id) WHERE imported_batch_id IS NOT NULL");

    // fine_type proposals table — when LLM suggests a fine_type outside the 35-subset,
    // we collect it here for periodic dictionary expansion review (user approves manually).
    // Lives in constellation.db because it's a star-map taxonomy artifact.
    // Audit (mimir_edge_changes) and action cooldowns (mimir_edge_action_cooldowns)
    // live in conversations.db alongside other mimir_* worker-owned tables.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fine_type_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        coarse_type TEXT NOT NULL,
        proposed_fine TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        approved INTEGER NOT NULL DEFAULT 0,
        example_edge_ids TEXT,
        UNIQUE(coarse_type, proposed_fine)
      )
    `);

    // Drop legacy idx_edges_state_strength — it lured the planner into full-partition
    // scans (37x BFS slowdown at 187K edges). All BFS queries now pin source/target
    // indexes explicitly via INDEXED BY, so this index has no legitimate user.
    try { this.db.exec('DROP INDEX IF EXISTS idx_edges_state_strength'); } catch {}

    // Without sqlite_stat1 the planner picked idx_edges_state_strength over
    // idx_edges_source for BFS — 37x slowdown at 187K edges. Run ANALYZE on
    // first init (and any time stats go missing) so OSS user avoid this.
    try {
      const hasStats = this.db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_stat1'").get();
      if (!hasStats) {
        const t0 = Date.now();
        this.db.exec('ANALYZE');
        console.log(`[Engine] ANALYZE done in ${Date.now() - t0}ms (planner stats seeded)`);
      }
    } catch (e) {
      console.warn('[Engine] ANALYZE skipped:', e.message);
    }

    // ── Ratatoskr pulse_hint_log ──
    // Append-only envelope log for L0 self-touch pulse kinds (task / cognitive).
    // Used by writers to surface task-completion signals + cognitive observations
    // back to dashboards and Anamnesis elide.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pulse_hint_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at   INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        source_hint   TEXT,
        owner_id      TEXT,
        target_kind   TEXT,
        target_id     TEXT,
        payload       TEXT,
        severity      TEXT,
        processed_at  INTEGER,
        processed_by  TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_phl_unprocessed ON pulse_hint_log(processed_at) WHERE processed_at IS NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_phl_target ON pulse_hint_log(target_kind, target_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_phl_received ON pulse_hint_log(received_at)");

    // Boot-time TTL prune: pulse_hint_log is an audit log, useful only for the
    // Anamnesis elide window (~24h) plus debugging breathing room. Anything
    // older than 30 days is dead weight — drop it once per boot.
    try {
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      const r = this.db.prepare("DELETE FROM pulse_hint_log WHERE received_at < ?").run(cutoff);
      if (r.changes > 0) console.log(`[pulse_hint_log] pruned ${r.changes} row(s) older than 30d`);
    } catch (e) { /* boot prune best-effort */ }

    // ── Sleipnir (2026-04-29) — experiential anchor pattern v2 ──
    // Plan: engine-output/architecture-research/2026-04-29-experiential-anchor-planning-v2.md
    //
    // Three tables:
    //   1. exploration_trail   — raw grep/read/web/autonomy events (TTL 7d)
    //   2. experiential_pending_review — LLM-aggregated proposals waiting decision (cap 200 FIFO)
    //   3. sleipnir_metrics    — hourly tallies for dashboard panel
    // Plus: nodes.subtype column for exploration_anchor classification
    //       (factual / navigational / conceptual) and task_trail subtype.

    // 1. nodes.subtype — fine-grained classification under subkind='exploration_anchor'
    try {
      this.db.exec("ALTER TABLE nodes ADD COLUMN subtype TEXT");
      console.log("[sleipnir] added nodes.subtype column");
    } catch (e) { /* already exists — idempotent */ }

    // 2. exploration_trail — raw events before LLM aggregation
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exploration_trail (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at     INTEGER NOT NULL,
        caller_kind     TEXT NOT NULL,
        caller_session  TEXT,
        cron_name       TEXT,
        source_kind     TEXT NOT NULL,
        region          TEXT,
        query           TEXT,
        finding         TEXT,
        signature       TEXT,
        gate_decision   TEXT,
        metadata        TEXT,
        promoted        INTEGER DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_extrl_signature ON exploration_trail(signature, occurred_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_extrl_region ON exploration_trail(region)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_extrl_occurred ON exploration_trail(occurred_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_extrl_promoted ON exploration_trail(promoted, occurred_at) WHERE promoted = 1");
    // Aggregator cursor — set when the LLM has consumed a row into a candidate.
    try { this.db.exec("ALTER TABLE exploration_trail ADD COLUMN processed_at INTEGER"); } catch { /* idempotent */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_extrl_unprocessed ON exploration_trail(promoted, processed_at) WHERE promoted = 1 AND processed_at IS NULL");
    // Step 6 Plan A (2026-04-29) — raw text capture for hybrid storage. Caller
    // populates these from tool result; aggregator passes through to
    // experiential_pending_review; promoter splits raw_excerpt into chunks
    // for experiential_raw side table.
    try { this.db.exec("ALTER TABLE exploration_trail ADD COLUMN raw_excerpt TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE exploration_trail ADD COLUMN raw_line_range TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE exploration_trail ADD COLUMN raw_file_path TEXT"); } catch { /* idempotent */ }

    // 3. experiential_pending_review — aggregator output queue
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiential_pending_review (
        review_id       TEXT PRIMARY KEY,
        proposed_at     INTEGER NOT NULL,
        proposed_by     TEXT,
        candidate_id    TEXT,
        l0              TEXT,
        l1              TEXT,
        l2              TEXT,
        subtype         TEXT,
        trail_ids       TEXT,
        resolver_verdict TEXT,
        cos_dedup_score REAL,
        state           TEXT DEFAULT 'pending',
        expires_at      INTEGER,
        notes           TEXT
      )
    `);
    // Step 5: persist candidate embedding so IR injection can do cosine match
    // without re-embedding at every turn. Step 4 dedup writes it, Step 5 reads.
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN embedding BLOB"); } catch { /* idempotent */ }
    // Step 6: decay channels — touch counter, last refresh, effective strength.
    // effective_strength starts at confidence and decays adaptively (half-life
    // inversely proportional to conf). Anchors below MIN_STRENGTH get aged out.
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN last_refreshed_at INTEGER"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN refresh_count INTEGER DEFAULT 0"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN effective_strength REAL"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN region TEXT"); } catch { /* idempotent */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_epr_state ON experiential_pending_review(state, proposed_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_epr_expires ON experiential_pending_review(expires_at) WHERE expires_at IS NOT NULL");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_epr_accepted ON experiential_pending_review(state, subtype) WHERE state = 'accepted'");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_epr_strength ON experiential_pending_review(state, effective_strength) WHERE state = 'accepted'");

    // 4. sleipnir_metrics — hourly tallies (silent_drop / trail_only / promote / task_trail)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sleipnir_metrics (
        bucket_hour     INTEGER PRIMARY KEY,
        silent_drop     INTEGER DEFAULT 0,
        trail_only      INTEGER DEFAULT 0,
        promote         INTEGER DEFAULT 0,
        task_trail      INTEGER DEFAULT 0,
        redaction_hits  INTEGER DEFAULT 0,
        caller_subagent INTEGER DEFAULT 0
      )
    `);

    // Boot-time TTL prune for exploration_trail: 7 days for non-promoted,
    // 30 days for promoted (kept longer since they may feed aggregator retries).
    try {
      const cutoff7d = Date.now() - 7 * 24 * 3600 * 1000;
      const cutoff30d = Date.now() - 30 * 24 * 3600 * 1000;
      const r1 = this.db.prepare("DELETE FROM exploration_trail WHERE promoted = 0 AND occurred_at < ?").run(cutoff7d);
      const r2 = this.db.prepare("DELETE FROM exploration_trail WHERE promoted = 1 AND occurred_at < ?").run(cutoff30d);
      if (r1.changes + r2.changes > 0) console.log(`[sleipnir] pruned ${r1.changes} non-promoted (>7d) + ${r2.changes} promoted (>30d) trail rows`);
    } catch (e) { /* boot prune best-effort */ }

    // Boot-time prune for experiential_pending_review: drop expired
    try {
      const r = this.db.prepare("DELETE FROM experiential_pending_review WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
      if (r.changes > 0) console.log(`[sleipnir] pruned ${r.changes} expired pending review row(s)`);
    } catch (e) { /* boot prune best-effort */ }

    // FIFO cap on experiential_pending_review: keep only newest 200 pending
    try {
      const r = this.db.prepare(`
        DELETE FROM experiential_pending_review
        WHERE state = 'pending' AND review_id IN (
          SELECT review_id FROM experiential_pending_review
          WHERE state = 'pending'
          ORDER BY proposed_at DESC
          LIMIT -1 OFFSET 200
        )
      `).run();
      if (r.changes > 0) console.log(`[sleipnir] FIFO-capped pending_review: dropped ${r.changes} oldest`);
    } catch (e) { /* best-effort */ }

    // ── Sleipnir Step 6 (2026-04-29) — hybrid promotion ──
    // Plan: engine-output/architecture-research/2026-04-29-sleipnir-step6-hybrid-planning.md
    //   experiential_raw       — chunked raw excerpts (kept out of nodes.l2 to
    //                            avoid cosine pollution / BLOB inflation)
    //   sleipnir_promote_log   — promote audit + daily-cap accounting
    // Plus 6 ALTER columns on experiential_pending_review (raw side metadata +
    // promoted_node_id link + accepted_expires_at TTL).

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiential_raw (
        node_id        TEXT NOT NULL,
        chunk_idx      INTEGER NOT NULL DEFAULT 0,
        total_chunks   INTEGER NOT NULL DEFAULT 1,
        source_kind    TEXT,
        file_path      TEXT,
        line_range     TEXT,
        byte_offset    INTEGER,
        raw_text       TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (node_id, chunk_idx),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_experiential_raw_node ON experiential_raw(node_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_experiential_raw_kind ON experiential_raw(source_kind, created_at DESC)");

    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN raw_excerpt TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN raw_line_range TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN raw_file_path TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN promoted_node_id TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN promoted_at INTEGER"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE experiential_pending_review ADD COLUMN accepted_expires_at INTEGER"); } catch { /* idempotent */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_epr_promoted ON experiential_pending_review(promoted_node_id) WHERE promoted_node_id IS NOT NULL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sleipnir_promote_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id        TEXT NOT NULL,
        promoted_node_id TEXT,
        decision         TEXT NOT NULL,
        reason           TEXT,
        cos_max_neighbor REAL,
        edges_written    INTEGER,
        raw_chunks       INTEGER,
        created_at       INTEGER NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sleipnir_promote_log_recent ON sleipnir_promote_log(created_at DESC)");

    // ─── V5b Phase 11 (OSS migration): persona / outreach substrate ────────
    // Schema parity with main arch (Plan §6 Phase 7). All idempotent. Critic
    // gate (Phase 11.3) and review-queue UI (Phase 11.4) consume these tables.
    // OSS posture: post/reply default-OFF; review_queue is the only path until
    // a Critic LLM is configured AND `direct_send_enabled=1` is flipped.
    try { this.db.exec("ALTER TABLE nodes ADD COLUMN persona_id TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE nodes ADD COLUMN external_source_uri TEXT"); } catch { /* idempotent */ }
    try { this.db.exec("ALTER TABLE edges ADD COLUMN persona_id TEXT"); } catch { /* idempotent */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
        owner_id        TEXT NOT NULL,
        id              TEXT NOT NULL,
        display_name    TEXT NOT NULL,
        voice_rubric    TEXT,
        voice_exemplars TEXT,
        created_at      INTEGER NOT NULL,
        active          INTEGER DEFAULT 1,
        PRIMARY KEY (owner_id, id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_caps (
        owner_id            TEXT NOT NULL,
        persona_id          TEXT NOT NULL,
        platform            TEXT NOT NULL,
        action              TEXT NOT NULL,
        daily_cap           INTEGER NOT NULL,
        quiet_start_hour    INTEGER,
        quiet_end_hour      INTEGER,
        quiet_tz            TEXT,
        direct_send_enabled INTEGER DEFAULT 1,
        PRIMARY KEY (owner_id, persona_id, platform, action)
      )
    `);
    try { this.db.exec("ALTER TABLE persona_caps ADD COLUMN direct_send_enabled INTEGER DEFAULT 1"); } catch { /* idempotent */ }
    // r20 Option B: direct_send is permanently ON in OSS — the review-queue
    // workflow was removed (panel + endpoints + write paths). Hard-lock every
    // boot so legacy 0-rows (and any rogue writes) snap back to 1. The Critic
    // gate still runs and unsafe drafts still drop.
    try { this.db.prepare("UPDATE persona_caps SET direct_send_enabled = 1 WHERE direct_send_enabled != 1").run(); } catch { /* table may not exist on very old DBs */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_review_queue (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id      TEXT NOT NULL,
        persona_id    TEXT NOT NULL,
        platform      TEXT NOT NULL,
        action        TEXT NOT NULL,
        draft_text    TEXT NOT NULL,
        draft_hash    TEXT NOT NULL,
        parent_ref    TEXT,
        critic_result TEXT,
        created_at    INTEGER NOT NULL,
        approved_at   INTEGER,
        rejected_at   INTEGER,
        sent_at       INTEGER
      )
    `);

    // Critic verdict log — one row per criticGate(Async) call. Drives the
    // auto-demotion sweep (counts pass / reject / drop rates over a window).
    // Errors / timeouts / unavailable are recorded but excluded from rate calc.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mimir_critic_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id    TEXT NOT NULL,
        persona_id  TEXT,
        platform    TEXT,
        action      TEXT,
        ts          INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        stage       INTEGER,
        reason      TEXT,
        latency_ms  INTEGER,
        meta        TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_critic_log_lookup ON mimir_critic_log(owner_id, persona_id, platform, action, ts)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_critic_log_kind ON mimir_critic_log(kind, ts)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_target_lock (
        source_url   TEXT NOT NULL,
        persona_id   TEXT NOT NULL,
        acquired_at  INTEGER NOT NULL,
        ttl_s        INTEGER DEFAULT 3600,
        PRIMARY KEY (source_url, persona_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mimir_outreach_audit (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id      TEXT NOT NULL,
        persona_id    TEXT,
        platform      TEXT NOT NULL,
        ts            INTEGER NOT NULL,
        responded_at  INTEGER,
        meta          TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outreach_audit_lookup ON mimir_outreach_audit(owner_id, persona_id, platform, ts)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mimir_actions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id    TEXT NOT NULL,
        persona_id  TEXT,
        platform    TEXT,
        mode        TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        meta        TEXT
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_mimir_actions_caps ON mimir_actions(owner_id, persona_id, platform, mode, ts)");

    // Seed three personas idempotent. OSS users start with `self` (private)
    // active; `public` / `engine-official` seeded but inert until Critic LLM
    // is configured (UI gate in dashboard panel). OSS is single-user by
    // default — owner_id = STAR_MAP_OWNER_ID_DEFAULT 'self'.
    try {
      const seedPersona = this.db.prepare(`
        INSERT OR IGNORE INTO personas (owner_id, id, display_name, voice_rubric, voice_exemplars, created_at, active)
        VALUES (?, ?, ?, NULL, NULL, ?, 1)
      `);
      const now = Date.now();
      seedPersona.run(STAR_MAP_OWNER_ID_DEFAULT, 'self', 'Self', now);
      seedPersona.run(STAR_MAP_OWNER_ID_DEFAULT, 'public', 'Public', now);
      seedPersona.run(STAR_MAP_OWNER_ID_DEFAULT, 'engine-official', 'Engine Official', now);
    } catch (e) { /* best-effort seed */ }

    // Optimization 5: clean up old rollback snapshots — keep only 5 most recent
    this._cleanupSnapshots();

    // Zombie-edge defense (r14): one-shot sweep at boot so any prior install
    // that pre-dates the cascade fixes lands in a consistent state. Idempotent
    // and cheap on small DBs; on huge DBs the index on (state) keeps it OK.
    try { this._sweepOrphanEdges(); } catch (e) { /* never block boot */ }
  }

  /**
   * _cleanupSnapshots — delete old constellation.db.pre-* / .rollback-* files,
   * keeping only the 5 most recent by modification time.
   */
  _cleanupSnapshots() {
    const dir = path.dirname(this.db.name || DB_PATH);
    let files;
    try { files = fs.readdirSync(dir); } catch { return; }
    const snapshotFiles = files
      .filter(f => f.startsWith('constellation.db.pre-') || f.startsWith('constellation.db.rollback-'))
      .map(f => {
        const fullPath = path.join(dir, f);
        try { return { fullPath, mtime: fs.statSync(fullPath).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime); // newest first
    // Delete everything beyond the 5 most recent
    for (const entry of snapshotFiles.slice(5)) {
      try { fs.unlinkSync(entry.fullPath); } catch { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  //  Cold-Start Bootstrap (Phase 9.5+)
  //  Planning: engine-output/architecture-research/2026-05-03-cold-start-autonomy-planning.md
  //  Architecture A — engine.cjs owns the dispatcher; mimir-js stays substrate.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * H4 — messages_count cache. Live count of conversations.db messages drives
   * the bootstrap-exit gate; querying it on every tick would cross the
   * conversations.db handle (separate from engine.db) and add lock pressure.
   * Cache for 60s; main.js can call _invalidateMessagesCount() after a turn
   * write for immediate freshness on first activity.
   */
  _messagesCount() {
    const c = this._coldStart.messagesCountCache;
    const now = Date.now();
    if (c.value !== null && (now - c.ts) < c.ttlMs) return c.value;
    let next = 0;
    if (typeof this._coldStart.messagesCountResolver === 'function') {
      try { next = this._coldStart.messagesCountResolver() | 0; } catch { next = c.value || 0; }
    }
    c.value = next;
    c.ts = now;
    return next;
  }
  _invalidateMessagesCount() {
    this._coldStart.messagesCountCache.ts = 0;
  }

  /**
   * Read engine_meta single key as integer epoch (ms). Returns null if absent
   * or unparseable. The cold-start clock is stamped as ms-since-epoch text;
   * keep parsing forgiving so a manual edit doesn't crash the dispatcher.
   */
  _readEngineMetaEpochMs(key) {
    try {
      const row = this.db.prepare("SELECT value FROM engine_meta WHERE key = ?").get(key);
      if (!row || row.value == null) return null;
      const n = Number(row.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  }
  _writeEngineMetaText(key, value) {
    try {
      this.db.prepare(
        "INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(key, String(value));
      return true;
    } catch (e) {
      console.warn(`[ColdStart] engine_meta write failed (${key}):`, e.message);
      return false;
    }
  }

  /**
   * Read autonomy_seeds JSON blob from engine_meta. Shape:
   *   { tags: string[], freetext: string, captured_at: ISO,
   *     llm_extracted_at: ISO|null, llm_topics: string[], exhausted_seeds: string[],
   *     last_bootstrap_completed_at: ms|null }
   * Returns null if absent or malformed (caller may rebuild from wizard node).
   */
  _loadAutonomySeeds() {
    try {
      const row = this.db.prepare("SELECT value FROM engine_meta WHERE key = 'autonomy_seeds'").get();
      if (!row || !row.value) return null;
      const parsed = JSON.parse(row.value);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        freetext: typeof parsed.freetext === 'string' ? parsed.freetext : '',
        captured_at: parsed.captured_at || null,
        llm_extracted_at: parsed.llm_extracted_at || null,
        llm_topics: Array.isArray(parsed.llm_topics) ? parsed.llm_topics : [],
        exhausted_seeds: Array.isArray(parsed.exhausted_seeds) ? parsed.exhausted_seeds : [],
        last_bootstrap_completed_at: typeof parsed.last_bootstrap_completed_at === 'number'
          ? parsed.last_bootstrap_completed_at : null,
      };
    } catch (e) {
      console.warn('[ColdStart] autonomy_seeds parse failed:', e.message);
      return null;
    }
  }
  _writeAutonomySeeds(blob) {
    return this._writeEngineMetaText('autonomy_seeds', JSON.stringify(blob));
  }

  /**
   * Hydrate autonomy_seeds from the wizard's autonomy_seeds node if engine_meta
   * row is empty. Wizard writes only the node (Stage 7 endpoint); engine_meta
   * acts as the dispatcher's working blob (carries LLM expansion + exhaustion
   * state). Idempotent — won't overwrite an existing blob.
   */
  _hydrateAutonomySeedsFromWizard() {
    if (this._loadAutonomySeeds()) return null;  // already hydrated
    try {
      const row = this.db.prepare(
        "SELECT l2, tags, created_at FROM nodes WHERE id = 'wizard-profile-seed' AND state = 'active'"
      ).get();
      if (!row) return null;
      // L2 may be legacy JSON (`{schema_version,tags,freetext,...}`) OR new
      // markdown narrative. Try JSON first; if parse fails, fall back to the
      // node's `tags` column (drop protection tags added by the wizard write
      // path) and leave freetext empty — narrative L2 doesn't round-trip.
      let parsed = null;
      if (row.l2) { try { parsed = JSON.parse(row.l2); } catch { parsed = null; } }
      let tags = [];
      let freetext = '';
      let capturedAt = null;
      if (parsed && typeof parsed === 'object') {
        tags = Array.isArray(parsed.tags) ? parsed.tags : [];
        freetext = typeof parsed.freetext === 'string' ? parsed.freetext : '';
        capturedAt = parsed.captured_at || null;
      } else {
        const PROTECTION = new Set(['permanent-slot', 'identity', 'wizard-seed']);
        try {
          const rawTags = JSON.parse(row.tags || '[]');
          tags = Array.isArray(rawTags) ? rawTags.filter(t => !PROTECTION.has(t)) : [];
        } catch { tags = []; }
        capturedAt = row.created_at || null;
      }
      if (tags.length === 0 && !freetext) return null;
      const blob = {
        tags,
        freetext,
        captured_at: capturedAt || new Date().toISOString(),
        llm_extracted_at: null,
        llm_topics: [],
        exhausted_seeds: [],
        last_bootstrap_completed_at: null,
      };
      this._writeAutonomySeeds(blob);
      return blob;
    } catch (e) {
      console.warn('[ColdStart] hydrate from wizard node failed:', e.message);
      return null;
    }
  }

  /**
   * §6.2 gate. Returns one of:
   *   { phase: 'bootstrap',    reason, fields }
   *   { phase: 'steady',       reason, fields }
   *   { phase: 'expired',      reason, fields }   — autonomy_enabled_at present but >30d
   *   { phase: 'idle',         reason, fields }   — autonomy never enabled
   * fields.{active,messages,daysSinceEnabled,communities,reentryBlocked} for B1 logging.
   */
  /**
   * Quiet-hours read for cold-start outreach. Mirrors the gate in
   * mimir-js/autonomy.js::isQuietHoursNow(). Reads the same persisted config
   * (scripts/mimir-js/mimir-config.json) so a single dashboard write controls
   * BOTH the steady-state v3 picker and the cold-start dispatcher. Failure to
   * read the config = "not in quiet hours" (fail-OPEN — outreach proceeds).
   */
  _isInQuietHoursForColdStart() {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      // mimir-config.json sits next to autonomy.js. Resolve relative to the
      // engine.cjs file location.
      const cfgPath = path.resolve(__dirname, 'scripts', 'mimir-js', 'mimir-config.json');
      if (!fs.existsSync(cfgPath)) return false;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const start = parseInt(cfg.quiet_start_hour, 10);
      const end   = parseInt(cfg.quiet_end_hour, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
      const tz = (typeof cfg.quiet_tz === 'string' && cfg.quiet_tz.trim()) || 'UTC';
      let hour;
      try {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
        hour = parseInt(fmt.format(new Date()), 10);
      } catch { hour = new Date().getUTCHours(); }
      if (!Number.isFinite(hour)) return false;
      if (start < end) return hour >= start && hour < end;
      return hour >= start || hour < end;  // wraparound (e.g. 22→6)
    } catch {
      return false;
    }
  }

  _coldStartGateState() {
    const enabledAt = this._readEngineMetaEpochMs('autonomy_enabled_at');
    const seeds = this._loadAutonomySeeds();
    let active = 0;
    try { active = this._count(); } catch {}
    const messages = this._messagesCount();
    const fields = {
      active, messages,
      enabledAt,
      daysSinceEnabled: enabledAt ? (Date.now() - enabledAt) / 86_400_000 : null,
      communities: null,    // populated by Phase 9.6 from /pool when available
      reentryBlocked: false,
      seedsHydrated: !!seeds,
    };

    if (!enabledAt) return { phase: 'idle', reason: 'autonomy_not_enabled', fields };
    if (fields.daysSinceEnabled > 30) {
      return { phase: 'expired', reason: 'past_30d_window', fields };
    }
    // RE-ENTRY block: 7d after last bootstrap completion. Prevents flap when
    // user clears the pool and the gate would otherwise fire repeatedly.
    if (seeds && seeds.last_bootstrap_completed_at) {
      const sinceCompleteMs = Date.now() - seeds.last_bootstrap_completed_at;
      if (sinceCompleteMs < 7 * 86_400_000) {
        fields.reentryBlocked = true;
        return { phase: 'steady', reason: 'reentry_blocked_7d', fields };
      }
    }
    // ENTER condition (Planning §6.2): active < 25 AND messages < 20.
    if (active < 25 && messages < 20) {
      return { phase: 'bootstrap', reason: 'cold_pool_and_low_traffic', fields };
    }
    // EXIT condition: messages >= 50 — pool > 80 + communities >= 3 evaluated
    // by Phase 9.6 once /pool is queried; here messages alone already routes.
    return { phase: 'steady', reason: 'pool_or_traffic_above_threshold', fields };
  }

  /**
   * Dispatcher tick. Runs every 60s. H1: single shared cycle that reads gate
   * once and routes. The bootstrap and steady-state branches are mutually
   * exclusive within a tick — they never fire together.
   */
  async _coldStartTick() {
    if (this._coldStart.tickInProgress) return;  // re-entrancy guard
    this._coldStart.tickInProgress = true;
    this._coldStart.tickCount += 1;
    this._coldStart.lastTickAt = Date.now();
    try {
      // Defensive: hydrate seeds blob from wizard node on first tick where
      // autonomy is enabled but engine_meta blob is missing (e.g. wizard ran
      // before Phase 9.5 was deployed and the blob never got written).
      if (this._readEngineMetaEpochMs('autonomy_enabled_at')) {
        this._hydrateAutonomySeedsFromWizard();
      }
      const gate = this._coldStartGateState();
      const transitioned = this._coldStart.lastPhase && this._coldStart.lastPhase !== gate.phase;
      if (transitioned) {
        // B1: log every transition. cold_start_exit covers bootstrap→steady|expired;
        // entry/idle transitions logged for observability.
        this._writePulseHint('cold_start_transition', {
          from: this._coldStart.lastPhase,
          to: gate.phase,
          reason: gate.reason,
          fields: gate.fields,
        });
        if (this._coldStart.lastPhase === 'bootstrap' && gate.phase !== 'bootstrap') {
          // Stamp completion epoch so the 7d re-entry block engages.
          const seeds = this._loadAutonomySeeds() || { tags: [], freetext: '', captured_at: null,
            llm_extracted_at: null, llm_topics: [], exhausted_seeds: [], last_bootstrap_completed_at: null };
          seeds.last_bootstrap_completed_at = Date.now();
          this._writeAutonomySeeds(seeds);
          this._writePulseHint('cold_start_exit', { reason: gate.reason, fields: gate.fields });
        }
      }
      this._coldStart.lastPhase = gate.phase;

      if (gate.phase === 'bootstrap') {
        await this._coldStartBootstrapTick(gate);
      }
      // 'steady'/'expired'/'idle' → no engine-side work; mimir-js v3 picker is
      // the steady-state owner once it lands. v1 mimir-js hardcodes autonomy off,
      // so steady is a true no-op for now.
    } finally {
      this._coldStart.tickInProgress = false;
    }
  }

  /**
   * Bootstrap branch — Phase 9.5 ships the skeleton; 9.6 plugs in fetch and
   * 9.7 plugs in outreach. Each tick: ensure seeds exist, kick async LLM
   * expansion if needed, run one fetch step, then check outreach gate.
   */
  async _coldStartBootstrapTick(gate) {
    const seeds = this._loadAutonomySeeds();
    if (!seeds || (seeds.tags.length === 0 && !seeds.freetext)) {
      // Wizard likely never finished Stage 7. Nothing to bootstrap from.
      return;
    }
    if (!seeds.llm_extracted_at && !this._coldStart.llmExpansionInflight) {
      // H3: kick async, never await — fetch runs against tags alone if the
      // expansion hasn't returned yet. Retry next tick if still empty.
      this.kickoffSeedExpansion(seeds.tags, seeds.freetext).catch(e => {
        console.warn('[ColdStart] seed expansion error:', e.message);
      });
    }
    // Phase 9.6: one fetch attempt per tick. Drift-rejected or exhausted
    // seeds are recorded inside the call and don't block subsequent ticks
    // from trying the next un-exhausted seed.
    await this._coldStartFetchSeed();
    // Phase 9.7: at most one outreach attempt per tick, gated by 90-min
    // cooldown + presence of at least one cold_start node to anchor the
    // message in. Fan-out is best-effort across 4 surfaces.
    await this._coldStartOutreach();
  }

  /**
   * Phase 9.7 — bootstrap outreach. Composes a short, friendly message about
   * one of the freshly-fetched topics and fans out to: dashboard SSE, OS
   * notification, chat-tab feed (conversations.db), Telegram (when wired).
   *
   * Rate limit: 90 min between sends, tracked in engine_meta. The cap is
   * intentionally conservative for cold-start — the user just installed the
   * thing; we want to feel alive, not spammy.
   *
   * B4 — also checks the mimir_actions ledger so steady-state Mímir outreach
   * (when it lands) shares the same cooldown window. Today (mimir-js v1
   * autonomy off) the ledger check is a no-op; the hook is here so Phase 9.10
   * doesn't have to retrofit it.
   */
  async _coldStartOutreach() {
    const COOLDOWN_MS = 90 * 60 * 1000;
    const lastSelf = this._readEngineMetaEpochMs('last_cold_start_outreach_at') || 0;
    const sinceSelf = Date.now() - lastSelf;
    if (sinceSelf < COOLDOWN_MS) return null;

    // Quiet-hours gate (parity with steady-state v3 picker outreach gate in
    // mimir-js/autonomy.js). Cold-start outreach can fire ANY time during the
    // 30d trial window — without this check, a user setting quiet=22→6 still
    // gets pinged at 3am during onboarding. Reads mimir-js's mimir-config.json.
    if (this._isInQuietHoursForColdStart()) {
      return null;
    }

    // B4: peek at mimir_actions for non-cold-start outreach activity. Both
    // resolver and table may be absent — defensive on every step.
    if (typeof this._coldStart.mimirActionsResolver === 'function') {
      try {
        const recent = this._coldStart.mimirActionsResolver({ sinceMs: Date.now() - COOLDOWN_MS, limit: 50 });
        const recentOutreach = recent.find(r => r.action && String(r.action).includes('outreach'));
        if (recentOutreach) return null;
      } catch { /* ledger read failures must not block */ }
    }

    // Need at least one cold_start node to anchor the message.
    let anchorNode;
    try {
      anchorNode = this.db.prepare(
        "SELECT id, l0, l1, tags FROM nodes WHERE source = 'cold_start' AND state = 'active' " +
        "ORDER BY created_at DESC LIMIT 1"
      ).get();
    } catch { return null; }
    if (!anchorNode) return null;

    // Compose the message. One short LLM call; failure aborts this attempt
    // but doesn't burn the cooldown — try again next tick.
    let messageText = '';
    try {
      const sysPrompt = 'You are an attentive companion. Compose ONE short friendly message (max 2 sentences, max 200 chars) that mentions a topic the user is curious about and invites a quick chat. No greetings, no signoffs, no emoji, plain text only. Output ONLY the message.';
      const userPrompt = `Topic context:\nL0: ${anchorNode.l0 || ''}\nL1: ${anchorNode.l1 || ''}\n\nWrite the message now.`;
      const result = await this._coldStartChat({
        system: sysPrompt,
        user: userPrompt,
        temperature: 0.5,
        max_tokens: 120,
        timeoutMs: 30_000,
      });
      if (!result.ok) {
        this._writePulseHint('cold_start_outreach_compose_fail', { status: result.status, error: result.error, anchor: anchorNode.id });
        return null;
      }
      messageText = (result.content || '').replace(/^["']|["']$/g, '').slice(0, 200);
    } catch (e) {
      this._writePulseHint('cold_start_outreach_compose_error', { error: e.message, anchor: anchorNode.id });
      return null;
    }
    if (!messageText) return null;

    const surfaces = { dashboard: false, os: false, chat: false, telegram: false };
    const errors = {};

    // Surface 1: SSE → dashboard card. Always attempted; payload mirrors what
    // GET /api/cold-start/outreach (Phase 9.8) returns for cold-load clients.
    try {
      if (this._coldStart.liveBusEmit) {
        this._coldStart.liveBusEmit('engine.coldStart.outreach', {
          message: messageText,
          anchor_node_id: anchorNode.id,
          anchor_l0: anchorNode.l0,
          ts: new Date().toISOString(),
        });
      }
      surfaces.dashboard = true;
    } catch (e) { errors.dashboard = e.message; }

    // Surface 2: OS notification (gated by os_notifications_enabled — wizard
    // Stage 8 toggle decides this; outbox stays empty if user opted out).
    try {
      const id = this.enqueueOsNotification({
        kind: 'cold_start_outreach',
        title: 'Mímir',
        body: messageText,
        deeplink: `app://chat?focus=${encodeURIComponent(anchorNode.id)}`,
      });
      surfaces.os = !!id;
    } catch (e) { errors.os = e.message; }

    // Surface 3: chat-tab feed. main.js installs the enqueuer; if it's not
    // available (e.g. convStore failed to init) we just skip this surface.
    try {
      if (typeof this._coldStart.chatFeedEnqueue === 'function') {
        await this._coldStart.chatFeedEnqueue({
          text: messageText,
          anchorNodeId: anchorNode.id,
        });
        surfaces.chat = true;
      }
    } catch (e) { errors.chat = e.message; }

    // Surface 4: Telegram. Optional and graceful — bot may not be configured.
    try {
      if (typeof this._coldStart.telegramSend === 'function') {
        const sent = await this._coldStart.telegramSend({ text: `🧠 ${messageText}` });
        surfaces.telegram = !!sent;
      }
    } catch (e) { errors.telegram = e.message; }

    // Stamp the cooldown only if at least one surface worked. If every surface
    // failed (e.g. user disabled notifications, no chat store, no Telegram,
    // no dashboard listening) we don't burn the cooldown — try again later.
    const anySurface = surfaces.dashboard || surfaces.os || surfaces.chat || surfaces.telegram;
    if (anySurface) {
      this._writeEngineMetaText('last_cold_start_outreach_at', String(Date.now()));
      this._writePulseHint('cold_start_outreach_sent', {
        anchor: anchorNode.id,
        message_chars: messageText.length,
        surfaces,
        errors: Object.keys(errors).length ? errors : undefined,
      });
      return { message: messageText, surfaces };
    }
    this._writePulseHint('cold_start_outreach_no_surface', { anchor: anchorNode.id, errors });
    return null;
  }

  /**
   * Phase 9.6 — single fetch step. Picks one un-exhausted seed, drift-checks
   * against existing pool, asks the LLM for an L0/L1/L2 envelope, writes it
   * with source='cold_start' + imported_batch_id stamp. Each seed is one-shot:
   * either it produces a node (exhausted=success) or gets dropped (exhausted=
   * drift_reject / fetch_fail). When all candidates are exhausted, writes a
   * cold_start_seed_exhausted pulse and the next tick will see no remaining
   * work — gate naturally exits via active>=25 once enough fetches succeed.
   */
  async _coldStartFetchSeed() {
    const seeds = this._loadAutonomySeeds();
    if (!seeds) return null;
    const allCandidates = [...(seeds.llm_topics || []), ...(seeds.tags || [])];
    const exhaustedSet = new Set(seeds.exhausted_seeds || []);
    const remaining = allCandidates.filter(s => s && !exhaustedSet.has(s));
    if (remaining.length === 0) {
      // Only log exhaustion once per gate session — track via a dedicated key
      // so the pulse log doesn't fill up while the gate hasn't exited.
      if (!seeds._exhaustion_logged_at) {
        this._writePulseHint('cold_start_seed_exhausted', {
          total_candidates: allCandidates.length,
          llm_extracted: !!seeds.llm_extracted_at,
        });
        seeds._exhaustion_logged_at = new Date().toISOString();
        this._writeAutonomySeeds(seeds);
      }
      return null;
    }
    const seed = remaining[0];

    // Embed seed via daemon. Daemon may still be cold; fail soft.
    let seedEmbedding;
    try {
      seedEmbedding = await this._embed(seed);
    } catch (e) {
      // Don't mark exhausted on embed failure — daemon issue, retry next tick.
      this._writePulseHint('cold_start_embed_fail', { seed, error: e.message });
      return null;
    }

    // Pool-coverage dedup: skip seeds whose embedding is already very close
    // to an existing node — bootstrap shouldn't re-fetch what user writes or
    // earlier cold-start cycles already covered. NB: planning §7.4 described
    // candidate-vs-seed relevance at 0.40; the deployed flow uses LLM
    // envelope generation (not web_fetch + drift), so this check inverted into
    // pool-coverage dedup at 0.85. Env override matches the spec name.
    const driftThreshold = Number(process.env.MIMIR_BOOTSTRAP_DRIFT_THRESHOLD || 0.85);
    let coverageCos = 0;
    try {
      const vec = this.db.prepare(
        "SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 1"
      ).all(seedEmbedding);
      if (vec.length > 0) {
        coverageCos = 1 - (vec[0].distance * vec[0].distance) / 2;
        if (coverageCos >= driftThreshold) {
          seeds.exhausted_seeds = [...exhaustedSet, seed];
          this._writeAutonomySeeds(seeds);
          this._writePulseHint('cold_start_drift_reject', {
            seed, cos_max: Number(coverageCos.toFixed(3)), threshold: driftThreshold,
          });
          return null;
        }
      }
    } catch { /* empty vec0 or query error → proceed without drift filter */ }

    // Fetch envelope from the LLM. Synchronous within the tick; the dispatcher
    // tick caller is async-tolerant. 45s ceiling so a stuck LLM doesn't pin
    // the tick forever.
    try {
      const sysPrompt = 'You are a knowledge synthesizer. Given a topic, produce a 3-layer envelope:\nL0: ONE short sentence, <=80 characters, the gist.\nL1: 1-3 sentences, <=300 characters, the basics.\nL2: 1-2 paragraphs, <=1500 characters, the substance.\nOutput EXACTLY in this format with no prose around it:\nL0: <text>\nL1: <text>\nL2: <text>';
      const userPrompt = `Topic: ${seed}\n\nWrite the envelope now.`;
      const result = await this._coldStartChat({
        system: sysPrompt,
        user: userPrompt,
        temperature: 0.3,
        max_tokens: 800,
        timeoutMs: 45_000,
      });
      if (!result.ok) {
        // Don't mark exhausted on transient LLM errors — retry next tick.
        this._writePulseHint('cold_start_fetch_fail', { seed, status: result.status, error: result.error });
        return null;
      }
      const text = result.content || '';
      const env = this._parseEnvelopeReply(text);
      if (!env.l0 || !env.l1) {
        // Mark exhausted on malformed output so we don't burn LLM budget on
        // the same seed every tick. The LLM rarely repeats a misformat.
        seeds.exhausted_seeds = [...exhaustedSet, seed];
        this._writeAutonomySeeds(seeds);
        this._writePulseHint('cold_start_fetch_malformed', { seed });
        return null;
      }
      const slug = seed.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 60) || 'seed';
      const nodeId = `cold-start-${slug}-${Date.now()}`;
      const id = await this.remember({
        id: nodeId,
        l0: env.l0.slice(0, 200),
        l1: env.l1.slice(0, 600),
        l2: (env.l2 || env.l1).slice(0, 2000),
        tags: [seed, 'cold_start'],
        source: 'cold_start',
        node_type: 'knowledge',
        subkind: 'cold_start_seed',
      });
      // Stamp imported_batch_id so SA pool soft-suppresses (×0.40 until
      // access_count >= 5, per project_migrate_memory_phase5_shipped) — keeps
      // the bootstrap pool from drowning out organic activations.
      try {
        this.db.prepare("UPDATE nodes SET imported_batch_id = 'cold_start' WHERE id = ?").run(id);
      } catch (e) {
        console.warn('[ColdStart] imported_batch_id stamp failed:', e.message);
      }
      seeds.exhausted_seeds = [...exhaustedSet, seed];
      this._writeAutonomySeeds(seeds);
      this._writePulseHint('cold_start_fetch_ok', { seed, node_id: id, coverage_cos: Number(coverageCos.toFixed(3)) });
      return { seed, id };
    } catch (e) {
      this._writePulseHint('cold_start_fetch_error', { seed, error: e.message });
      return null;
    }
  }

  /**
   * Parse the LLM's L0/L1/L2 envelope reply. Tolerates leading/trailing prose
   * and continuation lines (subsequent unprefixed lines fold into the most
   * recent layer). Returns { l0, l1, l2 } with empty strings for missing parts.
   */
  _parseEnvelopeReply(text) {
    let l0 = '', l1 = '', l2 = '';
    let mode = null;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^L([012])\s*:\s*(.*)$/);
      if (m) {
        const [, layer, body] = m;
        mode = `L${layer}`;
        if (mode === 'L0') l0 = body;
        else if (mode === 'L1') l1 = body;
        else l2 = body;
      } else if (mode === 'L1') {
        l1 += ' ' + line;
      } else if (mode === 'L2') {
        l2 += ' ' + line;
      }
    }
    return { l0: l0.trim(), l1: l1.trim(), l2: l2.trim() };
  }

  setLLMRouter(router) {
    this.llmRouter = router || null;
  }

  /**
   * Cold-start LLM helper. Prefers the in-process LLMRouter (uses the user's
   * configured provider — direct Anthropic, OpenAI-compatible, Ollama, proxy,
   * etc.) and falls back to the legacy CONSTELLATION_LLM_URL fetch path only
   * when no router has been installed (e.g. CLI scripts).
   *
   * @param {{system:string, user:string, model?:string, temperature?:number, max_tokens?:number, timeoutMs?:number}} args
   * @returns {Promise<{ok:boolean, content?:string, status?:number, error?:string}>}
   */
  async _coldStartChat({ system, user, model, temperature = 0.3, max_tokens = 400, timeoutMs = 30_000 }) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    if (this.llmRouter && typeof this.llmRouter.chat === 'function') {
      try {
        const opts = { temperature, maxTokens: max_tokens, timeoutMs };
        if (model) opts.model = model;
        const resp = await this.llmRouter.chat(messages, opts);
        return { ok: true, content: (resp.content || '').trim() };
      } catch (e) {
        return { ok: false, error: e?.message || String(e), status: e?.status };
      }
    }
    // Fallback: legacy in-process proxy path (CLI / dev rigs).
    try {
      const rawUrl = process.env.CONSTELLATION_LLM_URL || 'http://127.0.0.1:3456';
      const url = rawUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
      const key = process.env.CONSTELLATION_LLM_KEY || 'constellation-local';
      const fallbackModel = model || process.env.CONSTELLATION_CONSOLIDATION_MODEL || CONSOLIDATION_MODEL;
      const resp = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: fallbackModel, messages, temperature, max_tokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      const data = await resp.json();
      return { ok: true, content: (data.choices?.[0]?.message?.content || '').trim() };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Q5/H3 — async LLM seed expansion. Wizard hands us 8 chip tags + 280
   * chars freetext; the LLM expands that into a topic list the bootstrap fetch
   * loop walks. Returns immediately (POST endpoint stays snappy); the LLM call
   * runs in the background and writes engine_meta.autonomy_seeds on success.
   * Retries on next tick if llm_extracted_at remains null.
   */
  async kickoffSeedExpansion(tags, freetext) {
    if (this._coldStart.llmExpansionInflight) return { ok: false, reason: 'inflight' };
    this._coldStart.llmExpansionInflight = true;
    try {
      const tagLine = (tags || []).slice(0, 16).join(', ') || '(none)';
      const freeLine = (freetext || '').slice(0, 280) || '(none)';
      const sysPrompt = 'You are a topic expander. Given a user\'s coarse interest tags and free-text notes, propose 12-20 specific, fetchable topic queries that would help build a starter knowledge pool. Output ONE topic per line, lowercase, 2-6 words each, no bullets, no numbering, no commentary.';
      const userPrompt = `Coarse tags: ${tagLine}\nFree notes: ${freeLine}\n\nList specific topics now:`;
      // Up to 3 attempts with 5s backoff. Cold-start is the worst time for LLM
      // calls — provider warm-up, proxy handshake, model spin-up all run cold.
      // If all attempts fail, fall back to raw chip tags so bootstrap fetch
      // still has something to walk (chips alone make passable topic queries).
      let result = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        result = await this._coldStartChat({
          system: sysPrompt,
          user: userPrompt,
          temperature: 0.2,
          max_tokens: 400,
          timeoutMs: 30_000,
        });
        if (result?.ok) break;
        lastErr = `${result?.status || ''} ${result?.error || 'unavailable'}`.trim();
        console.warn(`[ColdStart] seed expansion attempt ${attempt}/3 failed: ${lastErr}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
      }
      if (!result?.ok) {
        // Raw-chip fallback: write the user's chips/tags as the topic list so
        // bootstrap fetch isn't blocked indefinitely. LLM expansion will retry
        // on the next cold-start tick (60s) and overwrite if it succeeds.
        const rawTopics = (tags || []).slice(0, 16).map(t => String(t).toLowerCase().trim())
          .filter(t => t.length >= 3 && t.length <= 80);
        if (rawTopics.length > 0) {
          const blob = this._loadAutonomySeeds() || {
            tags: tags || [], freetext: freetext || '', captured_at: new Date().toISOString(),
            exhausted_seeds: [], last_bootstrap_completed_at: null,
          };
          blob.tags = tags || blob.tags;
          blob.freetext = (typeof freetext === 'string') ? freetext : blob.freetext;
          blob.llm_topics = rawTopics;
          blob.llm_extracted_at = null;            // null = retry on next tick
          blob.fallback_reason = lastErr || 'unknown';
          this._writeAutonomySeeds(blob);
          console.warn(`[ColdStart] seed expansion exhausted retries; raw-chip fallback (${rawTopics.length} tags) — will retry LLM next tick`);
          return { ok: false, reason: `llm_unavailable_fallback`, topics: rawTopics.length };
        }
        return { ok: false, reason: `llm_unavailable: ${lastErr}` };
      }
      const text = result.content || '';
      const topics = text.split('\n')
        .map(l => l.replace(/^[\s\-*0-9.]+/, '').trim().toLowerCase())
        .filter(l => l && l.length >= 3 && l.length <= 80)
        .slice(0, 20);
      if (topics.length === 0) {
        console.warn('[ColdStart] seed expansion returned 0 topics; will retry next tick');
        return { ok: false, reason: 'empty_topics' };
      }
      const blob = this._loadAutonomySeeds() || {
        tags: tags || [], freetext: freetext || '', captured_at: new Date().toISOString(),
        exhausted_seeds: [], last_bootstrap_completed_at: null,
      };
      blob.tags = tags || blob.tags;
      blob.freetext = (typeof freetext === 'string') ? freetext : blob.freetext;
      blob.llm_topics = topics;
      blob.llm_extracted_at = new Date().toISOString();
      this._writeAutonomySeeds(blob);
      console.log(`[ColdStart] seed expansion ✓ ${topics.length} topics written`);
      return { ok: true, topics: topics.length };
    } catch (e) {
      console.warn('[ColdStart] seed expansion failed:', e.message);
      return { ok: false, reason: e.message };
    } finally {
      this._coldStart.llmExpansionInflight = false;
    }
  }

  /**
   * B1 — engine-side pulse_hint_log writer. Bypass the daemon /signal route
   * (engine.cjs owns the audit trail; cold-start writes from inside the same
   * process should not require a network roundtrip).
   */
  _writePulseHint(kind, payload) {
    try {
      const owner = (() => { try { return this._activeOwner(); } catch { return STAR_MAP_OWNER_ID_DEFAULT; } })();
      this.db.prepare(
        "INSERT INTO pulse_hint_log (received_at, kind, source_hint, owner_id, target_kind, target_id, payload, severity) " +
        "VALUES (?, ?, 'cold_start', ?, NULL, NULL, ?, 'info')"
      ).run(Date.now(), kind, owner, JSON.stringify(payload || {}));
    } catch (e) {
      // Pulse log writes must never break the dispatcher.
      console.warn('[ColdStart] pulse_hint_log write failed:', e.message);
    }
  }

  /**
   * Generate embedding for text via Mímir daemon's BGE-M3 endpoint.
   * No local model needed — daemon is the sole embedding service.
   */
  async _embed(text) {
    const t0 = Date.now();
    const MIMIR_PORT = process.env.MIMIR_PORT || 18810;
    const resp = await fetch(`http://127.0.0.1:${MIMIR_PORT}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Embed endpoint error: ${resp.status} ${err}`);
    }
    const data = await resp.json();
    const vec = data.embeddings_b64
      ? Buffer.from(data.embeddings_b64[0], 'base64')
      : Buffer.from(Float32Array.from(data.embeddings[0]).buffer);
    if (global.TIMING_LOGS) console.log(`  [_embed] daemon=${Date.now()-t0}ms, text="${text.slice(0,40)}"`);
    return vec;
  }

  /**
   * Build the text surface used for persistent vec0 embeddings.
   *
   * Most nodes use the compact L0+L1 surface. Broad identity/principle nodes can
   * opt into semantic_anchor so dense retrieval sees aliases and trigger phrases
   * without bloating the human-readable envelope.
   */
  _buildEmbeddingText(node = {}) {
    const anchor = typeof node.semantic_anchor === 'string' ? node.semantic_anchor.trim() : '';
    if (anchor) return anchor;
    return `${node.l0 || ''} ${node.l1 || ''}`.trim();
  }

  /**
   * _normalizeTags — last-resort defense: guarantee tags is always a clean JS array.
   * Handles: array (pass-through), comma-string, bracket-no-quotes, JSON string, anything else → []
   */
  _normalizeTags(tags) {
    if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
    if (typeof tags !== 'string' || !tags.trim()) return [];
    // Try JSON parse first
    try { const parsed = JSON.parse(tags); if (Array.isArray(parsed)) return parsed.map(t => String(t).trim()).filter(Boolean); } catch {}
    // Strip surrounding brackets if present: "[a,b,c]" → "a,b,c"
    let s = tags.trim();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    // Split on comma
    return s.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  /**
   * _validateTags — check tags against taxonomy, auto-infer Tier 1 if missing
   * Returns corrected tags array (may have Tier 1 prepended)
   */
  _validateTags(id, tags) {
    if (!_taxonomy) return tags;
    const tier1Found = tags.filter(t => _taxonomy.tier1.has(t));
    if (tier1Found.length === 0) {
      // Auto-infer Tier 1 from Tier 2 tags
      for (const t of tags) {
        const inferred = _taxonomy.tier2ToTier1[t];
        if (inferred) {
          tags = [inferred, ...tags];
          console.log(`[taxonomy] ${id}: auto-inferred Tier 1 '${inferred}' from '${t}'`);
          break;
        }
      }
      if (!tags.some(t => _taxonomy.tier1.has(t))) {
        console.warn(`[taxonomy] ${id}: no Tier 1 domain tag (tags: ${tags.join(',')})`);
      }
    }
    const unknown = tags.filter(t => !_taxonomy.allTags.has(t));
    if (unknown.length > 0) {
      console.warn(`[taxonomy] ${id}: unregistered tags: ${unknown.join(',')}`);
    }
    return tags;
  }

  /**
   * _classifyNodeType — rule-based auto-classification at write time
   * Priority: ID prefix > tags > content keywords > default 'knowledge'
   */
  _classifyNodeType(id, tags = [], l2 = '') {
    // 1. ID prefix — most reliable signal
    if (id.startsWith('milestone-')) return 'milestone';
    if (id.startsWith('si-')) return 'social-rule';
    if (id.startsWith('lz-') || id.startsWith('tpl-')) return 'language-template';
    if (id.startsWith('ci-') || id.startsWith('insight-')) return 'conversation-insight';
    if (id.startsWith('dec-') || id.startsWith('decision-')) return 'decision';
    if (id.startsWith('exp-') || id.startsWith('experiment-')) return 'experiment';
    if (id.startsWith('eng-') || id.startsWith('bugfix-') || id.startsWith('deploy-')) return 'engineering';
    if (id.startsWith('rel-') || id.startsWith('person-')) return 'relationship';
    if (id.startsWith('act-') || id.startsWith('procedure-')) return 'action';
    if (id.startsWith('rn-') || id.startsWith('reading-')) return 'reading-note';

    const lowerTags = tags.map(t => t.toLowerCase());
    const tagSet = new Set(lowerTags);
    const tagsJoined = lowerTags.join(',');
    const l2Lower = (l2 || '').toLowerCase();

    // 2. Tag-based classification — identity/milestone FIRST (highest protection priority)
    if (tagSet.has('identity') || tagSet.has('core-identity') || tagSet.has('soul-core'))
      return 'identity';
    if (tagSet.has('milestone') || tagSet.has('core-memory'))
      return 'milestone';

    // Relationship — person profiles, interpersonal records
    if (tagSet.has('relationship') || tagSet.has('person-profile') || tagSet.has('interpersonal'))
      return 'relationship';

    // Action — procedural memory, operational skills
    if (tagSet.has('action-procedure') || tagSet.has('sop') || tagSet.has('operational-skill') ||
        tagSet.has('troubleshooting-procedure'))
      return 'action';

    // Diary
    if (tagSet.has('diary'))
      return 'diary';

    // Introspection — self-reflection, cognitive state analysis
    if (tagSet.has('introspection') || tagSet.has('self-reflection') || tagSet.has('cognitive-state') ||
        tagSet.has('self-analysis'))
      return 'introspection';

    // Experiment — benchmarks, A/B tests, SA experiments
    if (tagSet.has('experiment') || tagSet.has('benchmark') || tagSet.has('a-b-test') ||
        tagSet.has('sa-experiment') || tagSet.has('test-result'))
      return 'experiment';

    // Engineering — bug fixes, deployments, architecture changes, system work
    if (tagSet.has('bugfix') || tagSet.has('bug-fix') || tagSet.has('deployment') ||
        tagSet.has('architecture-change') || tagSet.has('hotfix') || tagSet.has('infrastructure') ||
        tagSet.has('architecture') || tagSet.has('architecture-research') ||
        tagSet.has('signal-error') || tagSet.has('engineering') || tagSet.has('debugging') ||
        tagSet.has('constellation-engine') || tagSet.has('cron'))
      return 'engineering';

    // Observation — external information, news analysis
    if (tagSet.has('observation') || tagSet.has('human-observation') || tagSet.has('news') ||
        tagSet.has('reddit') || tagSet.has('hacker-news') || tagSet.has('external-source'))
      return 'observation';

    // Reading note — book reviews, paper summaries
    if (tagSet.has('reading-note') || tagSet.has('book-review') || tagSet.has('paper-summary') ||
        tagSet.has('book-note') || tagSet.has('reading'))
      return 'reading-note';

    // Social rule, language template, principle, insight, decision (existing)
    if (tagSet.has('social-intelligence') || tagSet.has('social-rule') || tagSet.has('social-norm'))
      return 'social-rule';
    if (tagSet.has('language-arts') || tagSet.has('language-art') || tagSet.has('language-template') || tagSet.has('linguistic') ||
        tagSet.has('rhetoric') || tagSet.has('expression') || tagSet.has('sentence-pattern'))
      return 'language-template';
    if (tagSet.has('meta-cognition') || tagSet.has('principle') || tagSet.has('design-principle'))
      return 'principle';
    if (tagSet.has('conversation-insight') || tagSet.has('insight') || tagSet.has('realization'))
      return 'conversation-insight';
    if (tagSet.has('decision') || tagSet.has('choice') || tagSet.has('tradeoff'))
      return 'decision';

    // Theory — academic frameworks, theoretical concepts, KC monetary theory
    // Exact tags + compound tag substring matching (kc-*, *-economics, *-philosophy, *-consciousness)
    if (tagSet.has('theory') || tagSet.has('framework') || tagSet.has('academic') ||
        tagSet.has('economics') || tagSet.has('philosophy') || tagSet.has('cognitive-science') ||
        tagSet.has('monetary-theory') || tagSet.has('game-theory') ||
        tagSet.has('kc') || tagSet.has('consciousness') || tagSet.has('philosophy-of-mind') ||
        tagSet.has('political-philosophy') || tagSet.has('macroeconomics') ||
        tagSet.has('behavioral-economics') || tagSet.has('institutional-economics') ||
        tagSet.has('ai-consciousness') || tagSet.has('dream-collide') ||
        tagSet.has('money') || tagSet.has('demurrage') || tagSet.has('banking') ||
        tagSet.has('inflation') || tagSet.has('institutions') || tagSet.has('epistemology') ||
        tagSet.has('information-theory') ||
        lowerTags.some(t => t.startsWith('kc-') || t.endsWith('-economics') ||
                            t.endsWith('-philosophy') || t.endsWith('-consciousness')))
      return 'theory';

    // 3. Content keyword heuristics (conservative — needs 2+ signals)
    const socialSignals = ['social rule', 'social norm', 'when someone', 'if they say', 'respond with', 'boundary:'];
    const principleSignals = ['principle:', 'rule:', 'always ', 'never ', 'meta-cognition', 'design principle'];
    const templateSignals = ['template:', 'sentence pattern', 'slot:', 'expression:', 'rhetoric', 'language template'];
    const insightSignals = ['insight:', 'realized', 'discovered that', 'learned that', 'key takeaway', 'confidence:'];
    const decisionSignals = ['decided', 'chose', 'alternative:', 'rationale:', 'tradeoff:', 'over option'];
    const engineeringSignals = ['root cause', 'fixed', 'deployed', 'bug:', 'hotfix', 'reverted', 'migration'];
    const experimentSignals = ['hypothesis', 'experiment', 'result:', 'conclusion:', 'benchmark', 'measured', 'baseline'];
    const observationSignals = ['observed', 'reddit', 'hacker news', 'news:', 'source:', 'external', 'trend'];
    const introspectionSignals = ['self-reflection', 'i noticed', 'i realized', 'cognitive state', 'my tendency', 'introspection'];
    const theorySignals = ['theorem', 'framework', 'theory:', 'hypothesis', 'model:', 'axiom', 'paradigm'];
    const actionSignals = ['step 1', 'step 2', 'procedure:', 'when encountering', 'fallback:', 'trigger:', 'sop'];

    const socialHits = socialSignals.filter(s => l2Lower.includes(s)).length;
    const principleHits = principleSignals.filter(s => l2Lower.includes(s)).length;
    const templateHits = templateSignals.filter(s => l2Lower.includes(s)).length;
    const insightHits = insightSignals.filter(s => l2Lower.includes(s)).length;
    const decisionHits = decisionSignals.filter(s => l2Lower.includes(s)).length;
    const engineeringHits = engineeringSignals.filter(s => l2Lower.includes(s)).length;
    const experimentHits = experimentSignals.filter(s => l2Lower.includes(s)).length;
    const observationHits = observationSignals.filter(s => l2Lower.includes(s)).length;
    const introspectionHits = introspectionSignals.filter(s => l2Lower.includes(s)).length;
    const theoryHits = theorySignals.filter(s => l2Lower.includes(s)).length;
    const actionHits = actionSignals.filter(s => l2Lower.includes(s)).length;

    if (socialHits >= 2) return 'social-rule';
    if (principleHits >= 2) return 'principle';
    if (templateHits >= 2) return 'language-template';
    if (insightHits >= 2) return 'conversation-insight';
    if (decisionHits >= 2) return 'decision';
    if (engineeringHits >= 2) return 'engineering';
    if (experimentHits >= 2) return 'experiment';
    if (actionHits >= 2) return 'action';
    if (introspectionHits >= 2) return 'introspection';
    if (theoryHits >= 2) return 'theory';
    if (observationHits >= 2) return 'observation';

    // 4. Fallback: general-knowledge if it has academic/factual tags, otherwise knowledge
    if (tagSet.has('history') || tagSet.has('science') || tagSet.has('geography') ||
        tagSet.has('mathematics') || tagSet.has('biology') || tagSet.has('physics') ||
        tagSet.has('chemistry') || tagSet.has('literature') || tagSet.has('politics'))
      return 'general-knowledge';

    return 'knowledge';
  }

  /**
   * Phase 9.3 — Enqueue an OS notification for the Electron launcher to dispatch.
   * Bootstrap fetch/outreach handlers (Phases 9.6/9.7) call this directly.
   * Returns the inserted row id, or null if the outbox table is unavailable.
   */
  enqueueOsNotification({ kind, title, body, deeplink = null }) {
    if (!kind || !title || !body) return null;
    try {
      const row = this.db.prepare(
        "SELECT value FROM engine_meta WHERE key = 'os_notifications_enabled'"
      ).get();
      if (!row || row.value !== '1') return null;
      const info = this.db.prepare(
        "INSERT INTO notification_outbox (kind, title, body, deeplink) VALUES (?, ?, ?, ?)"
      ).run(String(kind).slice(0, 64), String(title).slice(0, 120), String(body).slice(0, 500), deeplink ? String(deeplink).slice(0, 500) : null);
      return info.lastInsertRowid;
    } catch (e) {
      console.warn('[Engine] enqueueOsNotification failed:', e.message);
      return null;
    }
  }

  /**
   * remember — write-and-diffuse (Ripple Write)
   * R8: auto-embeds the node and writes the vector into the vec0 table.
   */
  async remember({ id, l0, l1, l2, tags = [], tone = 'analytical', valence = 0, arousal = 0.5, weight = 1.0, source = 'knowledge', edges = [], node_type = null, skipDedup = false, event_at = null, subkind = null, imported_batch_id = null, semantic_anchor = null, embedding_text_version = null }) {
    tags = this._normalizeTags(tags);
    tags = this._validateTags(id, tags);
    const resolvedType = node_type || this._classifyNodeType(id, tags, l2);

    // Auto-supersedes: if very similar node exists, still write but add supersedes edge
    let autoSupersedesTarget = null;
    if (!skipDedup) {
      const { isDuplicate, existingId } = this.checkDuplicate(l0, l2);
      if (isDuplicate) {
        // NEVER supersede identity/milestone nodes — they are immutable
        const existingType = this.db.prepare("SELECT node_type FROM nodes WHERE id = ?").get(existingId);
        if (existingType?.node_type === 'identity' || existingType?.node_type === 'milestone') {
          console.log(`[Engine] Skipping auto-supersedes: ${existingId} is immutable (${existingType.node_type})`);
        } else if (!this._isSupersedeAllowed(source, existingId)) {
          console.log(`[Engine] Skipping auto-supersedes: ${existingId} is user-authored, superseder=${source}`);
        } else {
          autoSupersedesTarget = existingId;
          console.log(`[Engine] Auto-supersedes: "${l0.slice(0, 40)}..." will supersede ${existingId}`);
          if (!edges.some(e => e.target === existingId && e.type === 'supersedes')) {
            edges = [...edges, { target: existingId, type: 'supersedes', strength: 1.0 }];
          }
        }
      }
    }

    const now = new Date().toISOString();

    // Resolve event_at + subkind: caller wins; else preserve existing row's value
    // (so INSERT OR REPLACE doesn't blank out fields not in the caller's payload).
    let resolvedEventAt = event_at;
    let resolvedSubkind = subkind;
    let resolvedSemanticAnchor = semantic_anchor;
    let resolvedEmbeddingTextVersion = embedding_text_version;
    if (!resolvedEventAt || resolvedSubkind === null || resolvedSemanticAnchor === null || resolvedEmbeddingTextVersion === null) {
      const existing = this.db.prepare("SELECT event_at, subkind, semantic_anchor, embedding_text_version FROM nodes WHERE id = ?").get(id);
      if (!resolvedEventAt) resolvedEventAt = existing?.event_at || now;
      if (resolvedSubkind === null) resolvedSubkind = existing?.subkind ?? null;
      if (resolvedSemanticAnchor === null) resolvedSemanticAnchor = existing?.semantic_anchor ?? null;
      if (resolvedEmbeddingTextVersion === null) resolvedEmbeddingTextVersion = existing?.embedding_text_version ?? 1;
    }

    const embedText = this._buildEmbeddingText({ l0, l1, semantic_anchor: resolvedSemanticAnchor });
    let embedding = null;
    try {
      embedding = await this._embed(embedText);
    } catch (embedErr) {
      console.warn(`[Engine] remember: embedding failed for ${id}, will write node without vec0/edges: ${embedErr.message}`);
    }

    const ownerId = this._resolveOwnerStamp();

    const insertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, state, created_at, accessed_at, l0, l1, l2, tags, tone, valence, arousal, weight, conn_count, access_count, source, node_type, updated_at, owner_id, event_at, subkind, imported_batch_id, semantic_anchor, embedding_text_version)
      VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Canonical edge types — 5 core + 3 system (04-11 decision: reduced from 17)
    const VALID_EDGE_TYPES = new Set([
      'causal', 'contrastive', 'hierarchical', 'associative', 'temporal',
      // System types (not user-facing)
      'supersedes', 'coactivation', 'collision', 'builds_on',
      // Mímir tension/profile dialectic (master plan §2/§7).
      'resolves', 'contradicts',
    ]);

    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);

    const _btSqlCC1 = this._bitemporalSqlClause().sql;
    const _validEpCC1 = this._validEdgeEndpointsSql();
    const updateConnCount = this.db.prepare(`
      UPDATE nodes SET conn_count = (
        (SELECT COUNT(*) FROM edges WHERE source = ? AND state = 'active'${_btSqlCC1}${_validEpCC1}) + (SELECT COUNT(*) FROM edges WHERE target = ? AND state = 'active'${_btSqlCC1}${_validEpCC1})
      ), accessed_at = ? WHERE id = ?
    `);

    // Penalize superseded nodes — apply ×0.1 weight penalty
    const penalizeSuperseded = this.db.prepare(`
      UPDATE nodes SET weight = weight * 0.1, superseded_at = datetime('now'), deprecated_at = datetime('now'), superseded_by = ? WHERE id = ? AND state = 'active' AND superseded_at IS NULL
    `);

    // Upsert into rowid mapping
    const upsertRowid = this.db.prepare(`INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)`);
    const getRowid = this.db.prepare(`SELECT rowid FROM node_rowids WHERE node_id = ?`);

    // Vec insert/replace
    const deleteVec = this.db.prepare(`DELETE FROM node_embeddings WHERE id = ?`);
    const insertVec = this.db.prepare(`INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)`);

    const txn = this.db.transaction(() => {
      insertNode.run(id, now, now, l0, l1, l2, JSON.stringify(tags), tone, valence, arousal, weight, edges.length, source, resolvedType, now, ownerId, resolvedEventAt, resolvedSubkind, imported_batch_id, resolvedSemanticAnchor, resolvedEmbeddingTextVersion || 1);

      // Re-remember of a node that was previously superseded → revive its edge web.
      this._reactivateNodeEdges(id);

      for (const edge of edges) {
        let edgeType = VALID_EDGE_TYPES.has(edge.type) ? edge.type : 'associative';
        // Master plan §10: downgrade `supersedes` → `contradicts` when a Mímir writer
        // targets a user-authored node, so the dialectic surfaces without the ×0.1 penalty.
        if (edgeType === 'supersedes' && !this._isSupersedeAllowed(source, edge.target)) {
          console.log(`[Engine] Downgrading supersedes→contradicts for ${edge.target} (user-authored, superseder=${source})`);
          edgeType = 'contradicts';
        }
        insertEdge.run(id, edge.target, edgeType, edge.strength || 0.5, now, ownerId);
        insertEdge.run(edge.target, id, edgeType, (edge.strength || 0.5) * 0.8, now, ownerId);
        updateConnCount.run(edge.target, edge.target, now, edge.target);
        // Auto-penalize target when supersedes edge is created
        if (edgeType === 'supersedes') {
          penalizeSuperseded.run(id, edge.target);
        }
      }

      updateConnCount.run(id, id, now, id);

      // Store embedding (skip if embedding generation failed)
      if (embedding) {
        upsertRowid.run(id);
        const row = getRowid.get(id);
        deleteVec.run(row.rowid);
        insertVec.run(BigInt(row.rowid), embedding);
      }
    });

    // Retry with backoff to handle "database is locked" from Mímir daemon
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        txn();
        break;
      } catch (e) {
        if (e.message?.includes('locked') && attempt < 2) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        } else { throw e; }
      }
    }

    // Sync FTS5 index
    try {
      this.db.prepare("INSERT OR REPLACE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)").run(id, l2, JSON.stringify(tags));
    } catch {}

    // Invalidate adjacency list cache — new edges may have been created
    this._adjCacheVersion++;

    // 16.5: Auto-suggest semantic edges (KNN + hub bias)
    // Always run when embedding exists — _suggestEdges uses INSERT OR IGNORE
    // so caller-supplied edges are preserved, and 0.40 cosSim floor + top-5 cap
    // are the quality/cost guards.
    if (embedding) {
      this._suggestEdges(id, embedding);
      this._adjCacheVersion++;
    }

    // L1 Consolidation: fire-and-forget async check for fusible neighbors
    if (CONSOLIDATION_ENABLED && embedding) {
      this._consolidationCheck(id, embedding, { l0, l1, l2, nodeType: resolvedType, source, eventAt: resolvedEventAt }).catch(err => {
        console.warn(`[Consolidation] check failed for ${id}:`, err.message);
      });
    }

    // Wave 3 Phase 8: A-MEM neighbor reconsolidation hook (default OFF).
    // Only fires for self_act writes — schedules top-3 cosine neighbors for
    // async summary refresh. Owner field optional; queue.enqueue() is a cheap
    // no-op when disabled, so the env-check lives inside the queue module.
    if (resolvedType === 'self_act' && this._reconsolidationQueue) {
      try {
        this._reconsolidationQueue.enqueue(id, this._activeOwner());
      } catch { /* queue is best-effort, never block writes */ }
    }

    // Deferred embedding retry: if embedding failed, retry after 10s to backfill vec0 + edges
    if (!embedding) {
      setTimeout(async () => {
        try {
          const retryEmb = await this._embed(embedText);
          if (!retryEmb) return;
          const uRow = this.db.prepare(`INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)`);
          const gRow = this.db.prepare(`SELECT rowid FROM node_rowids WHERE node_id = ?`);
          const dVec = this.db.prepare(`DELETE FROM node_embeddings WHERE id = ?`);
          const iVec = this.db.prepare(`INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)`);
          this.db.transaction(() => {
            uRow.run(id);
            const r = gRow.get(id);
            dVec.run(r.rowid);
            iVec.run(BigInt(r.rowid), retryEmb);
          })();
          this._suggestEdges(id, retryEmb);
          this._adjCacheVersion++;
          console.log(`[Engine] Deferred embedding backfill succeeded for ${id}`);
        } catch (retryErr) {
          console.warn(`[Engine] Deferred embedding backfill failed for ${id}: ${retryErr.message}`);
        }
      }, 10_000);
    }

    return id;
  }

  /**
   * addEdges — append edges from a source node to existing targets without
   * touching the source node row. Used by Mímir Curation worker (master plan
   * §10): edges-only writes must NOT clobber l0/l1/l2/tags/weight on the source.
   * Skips _suggestEdges and _consolidationCheck since no new node is created.
   */
  async addEdges(sourceId, edges = [], { source: sourceStamp = 'autonomous:mimir-curation' } = {}) {
    if (!sourceId || !Array.isArray(edges) || edges.length === 0) return 0;
    const exists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND state = 'active'").get(sourceId);
    if (!exists) {
      console.log(`[Engine] addEdges: source ${sourceId} missing/dormant — skipping`);
      return 0;
    }
    const VALID_EDGE_TYPES = new Set([
      'causal', 'contrastive', 'hierarchical', 'associative', 'temporal',
      'supersedes', 'coactivation', 'collision', 'builds_on',
      'resolves', 'contradicts',
    ]);
    const now = new Date().toISOString();
    const ownerId = this._resolveOwnerStamp();
    // Edge Evolution v1: fine_type optional, must be in 5-coarse subset (FINE_TYPES_BY_COARSE).
    // Out-of-subset values are silently dropped here; worker is expected to log them as
    // proposals BEFORE calling addEdges (so caller controls dictionary expansion).
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id, fine_type, fine_confidence, fine_source)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `);
    const _btSqlCC2 = this._bitemporalSqlClause().sql;
    const _validEpCC2 = this._validEdgeEndpointsSql();
    const updateConnCount = this.db.prepare(`
      UPDATE nodes SET conn_count = (
        (SELECT COUNT(*) FROM edges WHERE source = ? AND state = 'active'${_btSqlCC2}${_validEpCC2}) + (SELECT COUNT(*) FROM edges WHERE target = ? AND state = 'active'${_btSqlCC2}${_validEpCC2})
      ), accessed_at = ? WHERE id = ?
    `);
    const targetExists = this.db.prepare("SELECT 1 FROM nodes WHERE id = ? AND state = 'active'");
    let written = 0;
    const txn = this.db.transaction(() => {
      for (const edge of edges) {
        if (!edge || !edge.target || edge.target === sourceId) continue;
        if (!targetExists.get(edge.target)) continue;
        let edgeType = VALID_EDGE_TYPES.has(edge.type) ? edge.type : 'associative';
        // Master plan §10: downgrade supersedes→contradicts when Mímir targets user-authored.
        if (edgeType === 'supersedes' && !this._isSupersedeAllowed(sourceStamp, edge.target)) {
          console.log(`[Engine] addEdges: downgrading supersedes→contradicts for ${edge.target} (superseder=${sourceStamp})`);
          edgeType = 'contradicts';
        }
        const strength = typeof edge.strength === 'number' ? edge.strength : 0.5;
        const fineType = (edge.fine_type && FINE_TYPES_BY_COARSE[edgeType]?.includes(edge.fine_type)) ? edge.fine_type : null;
        const fineConf = fineType ? (typeof edge.fine_confidence === 'number' ? edge.fine_confidence : strength) : null;
        const fineSrc = fineType ? sourceStamp : null;
        insertEdge.run(sourceId, edge.target, edgeType, strength, now, ownerId, fineType, fineConf, fineSrc);
        insertEdge.run(edge.target, sourceId, edgeType, strength * 0.8, now, ownerId, fineType, fineConf, fineSrc);
        updateConnCount.run(edge.target, edge.target, now, edge.target);
        written++;
      }
      updateConnCount.run(sourceId, sourceId, now, sourceId);
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { txn(); break; }
      catch (e) {
        if (e.message?.includes('locked') && attempt < 2) {
          await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
        } else { throw e; }
      }
    }
    if (written > 0) this._adjCacheVersion++;
    return written;
  }

  // ─── Edge Evolution v1 (2026-04-26): refine / weaken / verify / flag_stale APIs ──
  // All five methods return `{ ok, before, after, edge_id }` so the worker can hand
  // the audit row to its conversations.db write — engine never touches that DB.
  // `source` must start with 'autonomous:mimir-', 'consolidation', or 'manual'.

  /**
   * Snapshot the current edge row (both directions are stored separately, so caller
   * passes a specific edge id). Returns null if missing.
   */
  _snapshotEdge(edgeId) {
    return this.db.prepare(
      "SELECT id, source, target, edge_type, strength, fine_type, fine_confidence, fine_source, state " +
      "FROM edges WHERE id = ?"
    ).get(edgeId) || null;
  }

  /**
   * updateEdgeFineType — change ONLY fine_type / fine_confidence / fine_source on
   * one edge. Does not touch edge_type / strength. Snapshot + write happen inside
   * a single sqlite transaction so concurrent callers can't interleave.
   *
   * NOTE: addEdges writes A→B and B→A as TWO rows. Use updateEdgeFineTypeBidirectional
   * to keep both sides in sync — calling this method on one edge_id alone leaves the
   * reverse direction with stale fine_type. Single-edge variant exists for cases where
   * the reverse hasn't been resolved yet (e.g. directional system edges).
   */
  updateEdgeFineType(edgeId, fineType, source, { fineConfidence = null } = {}) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    let result = null;
    this.db.transaction(() => {
      const before = this._snapshotEdge(edgeId);
      if (!before) { result = { ok: false, reason: 'edge_missing' }; return; }
      if (!FINE_TYPES_BY_COARSE[before.edge_type]?.includes(fineType)) {
        result = { ok: false, reason: 'fine_type_not_in_coarse_subset', coarse: before.edge_type };
        return;
      }
      const conf = (typeof fineConfidence === 'number') ? fineConfidence : (before.fine_confidence ?? before.strength);
      this.db.prepare(
        "UPDATE edges SET fine_type = ?, fine_confidence = ?, fine_source = ? WHERE id = ?"
      ).run(fineType, conf, source, edgeId);
      const after = this._snapshotEdge(edgeId);
      result = { ok: true, edge_id: edgeId, before, after };
    })();
    return result;
  }

  /**
   * updateEdgeFineTypeBidirectional — find both A→B and B→A edge rows of the same
   * edge_type and update fine_type on both. Returns { ok, updates: [{edge_id, before, after}] }
   * so worker writes one audit row per direction. Prevents asymmetric fine_type drift.
   */
  updateEdgeFineTypeBidirectional(nodeA, nodeB, edgeType, fineType, source, { fineConfidence = null } = {}) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    if (!FINE_TYPES_BY_COARSE[edgeType]?.includes(fineType)) {
      return { ok: false, reason: 'fine_type_not_in_coarse_subset', coarse: edgeType };
    }
    const updates = [];
    this.db.transaction(() => {
      const _btSqlF = this._bitemporalSqlClause().sql;
      const rows = this.db.prepare(
        `SELECT id FROM edges WHERE ((source = ? AND target = ?) OR (source = ? AND target = ?)) AND edge_type = ? AND state = 'active'${_btSqlF}`
      ).all(nodeA, nodeB, nodeB, nodeA, edgeType);
      for (const r of rows) {
        const before = this._snapshotEdge(r.id);
        if (!before) continue;
        const conf = (typeof fineConfidence === 'number') ? fineConfidence : (before.fine_confidence ?? before.strength);
        this.db.prepare(
          "UPDATE edges SET fine_type = ?, fine_confidence = ?, fine_source = ? WHERE id = ?"
        ).run(fineType, conf, source, r.id);
        const after = this._snapshotEdge(r.id);
        updates.push({ edge_id: r.id, before, after });
      }
    })();
    return { ok: updates.length > 0, updates };
  }

  /**
   * adjustEdgeStrength — clamp delta into [0, 0.7] (matches addEdges write-path ceiling
   * so refine can't push edges above policy). If clamp result < 0.2, we DO NOT write —
   * return { flagged: true } so caller writes a flag_stale audit instead.
   * Snapshot + write are wrapped in a transaction.
   */
  adjustEdgeStrength(edgeId, delta, source, _reasoning = null) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    let result = null;
    this.db.transaction(() => {
      const before = this._snapshotEdge(edgeId);
      if (!before) { result = { ok: false, reason: 'edge_missing' }; return; }
      const next = Math.max(0, Math.min(0.7, (before.strength || 0) + delta));
      if (next < 0.2) {
        result = { ok: true, flagged: true, edge_id: edgeId, before, suggested_strength: next };
        return;
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE edges SET strength = ?, accessed_at = ? WHERE id = ?").run(next, now, edgeId);
      const after = this._snapshotEdge(edgeId);
      result = { ok: true, flagged: false, edge_id: edgeId, before, after };
    })();
    return result;
  }

  /**
   * adjustEdgeStrengthBidirectional — adjust both A→B and B→A strengths together.
   * The reverse edge had its strength scaled by 0.8 in addEdges; we apply the same
   * delta to both rows (caller decides if asymmetry should persist).
   */
  adjustEdgeStrengthBidirectional(nodeA, nodeB, edgeType, delta, source, _reasoning = null) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    const updates = [];
    let anyFlagged = false;
    this.db.transaction(() => {
      const _btSqlAS = this._bitemporalSqlClause().sql;
      const rows = this.db.prepare(
        `SELECT id FROM edges WHERE ((source = ? AND target = ?) OR (source = ? AND target = ?)) AND edge_type = ? AND state = 'active'${_btSqlAS}`
      ).all(nodeA, nodeB, nodeB, nodeA, edgeType);
      const now = new Date().toISOString();
      for (const r of rows) {
        const before = this._snapshotEdge(r.id);
        if (!before) continue;
        const next = Math.max(0, Math.min(0.7, (before.strength || 0) + delta));
        if (next < 0.2) {
          updates.push({ edge_id: r.id, before, flagged: true, suggested_strength: next });
          anyFlagged = true;
          continue;
        }
        this.db.prepare("UPDATE edges SET strength = ?, accessed_at = ? WHERE id = ?").run(next, now, r.id);
        const after = this._snapshotEdge(r.id);
        updates.push({ edge_id: r.id, before, after, flagged: false });
      }
    })();
    return { ok: updates.length > 0, anyFlagged, updates };
  }

  /**
   * flagEdgeStale — pure read; returns the snapshot the worker should embed in its
   * audit row. Engine does NOT touch the edge here (DRY-RUN: today only logs).
   */
  flagEdgeStale(edgeId, source) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    const before = this._snapshotEdge(edgeId);
    if (!before) return { ok: false, reason: 'edge_missing' };
    return { ok: true, edge_id: edgeId, before };
  }

  /**
   * recordEdgeVerified — like flagEdgeStale (no edge mutation). Returns snapshot for
   * audit. "verify" = LLM saw this edge and confirmed it still holds.
   */
  recordEdgeVerified(edgeId, source) {
    if (!_isFineSourceAllowed(source)) return { ok: false, reason: 'source_not_allowed' };
    const before = this._snapshotEdge(edgeId);
    if (!before) return { ok: false, reason: 'edge_missing' };
    return { ok: true, edge_id: edgeId, before };
  }

  /**
   * recordFineTypeProposal — when LLM suggests a fine_type outside the closed
   * 35-subset, worker calls this so the dictionary expansion review queue grows.
   * UPSERT on (coarse_type, proposed_fine), bump count + last_seen, append example_edge_id.
   */
  recordFineTypeProposal(coarseType, proposedFine, exampleEdgeId = null) {
    if (!coarseType || !proposedFine) return { ok: false, reason: 'missing_args' };
    const now = new Date().toISOString();
    const row = this.db.prepare(
      "SELECT id, count, example_edge_ids FROM fine_type_proposals WHERE coarse_type = ? AND proposed_fine = ?"
    ).get(coarseType, proposedFine);
    if (!row) {
      const examples = exampleEdgeId != null ? JSON.stringify([exampleEdgeId]) : null;
      this.db.prepare(
        "INSERT INTO fine_type_proposals (coarse_type, proposed_fine, count, first_seen, last_seen, example_edge_ids) " +
        "VALUES (?, ?, 1, ?, ?, ?)"
      ).run(coarseType, proposedFine, now, now, examples);
      return { ok: true, created: true };
    }
    let examples = [];
    try { examples = JSON.parse(row.example_edge_ids || '[]'); } catch { examples = []; }
    if (exampleEdgeId != null && !examples.includes(exampleEdgeId) && examples.length < 10) {
      examples.push(exampleEdgeId);
    }
    this.db.prepare(
      "UPDATE fine_type_proposals SET count = count + 1, last_seen = ?, example_edge_ids = ? WHERE id = ?"
    ).run(now, JSON.stringify(examples), row.id);
    return { ok: true, created: false, count: row.count + 1 };
  }

  /**
   * Expose the closed 35-fine-type subset so the worker doesn't have to duplicate it.
   */
  getFineTypesByCoarse() {
    return FINE_TYPES_BY_COARSE;
  }

  /**
   * updateNode — update specific fields of an existing node without creating a new one.
   * Used for relationship center nodes (update last_interaction_summary, trust_level, etc.)
   * Does NOT trigger Consolidation. Updates accessed_at timestamp.
   * If L0 changes, re-embeds the node.
   */
  async updateNode(id, fields = {}) {
    const existing = this.db.prepare("SELECT id, l0, l1, l2, tags, node_type, semantic_anchor, embedding_text_version FROM nodes WHERE id = ? AND state = 'active'").get(id);
    if (!existing) {
      console.log(`[Engine] updateNode: node ${id} not found or dormant`);
      return null;
    }

    const now = new Date().toISOString();
    const updates = [];
    const params = [];

    // Updatable fields: l0, l1, l2, tags, weight, tone, valence, arousal
    for (const [key, val] of Object.entries(fields)) {
      if (['l0', 'l1', 'l2', 'tone', 'weight', 'node_type', 'semantic_anchor', 'embedding_text_version'].includes(key)) {
        updates.push(`${key} = ?`);
        params.push(val);
      } else if (key === 'tags') {
        updates.push(`tags = ?`);
        params.push(JSON.stringify(this._normalizeTags(val)));
      } else if (key === 'valence' || key === 'arousal') {
        updates.push(`${key} = ?`);
        params.push(val);
      }
    }

    if (updates.length === 0) {
      console.log(`[Engine] updateNode: no valid fields to update for ${id}`);
      return null;
    }

    // Always update accessed_at
    updates.push(`accessed_at = ?`);
    params.push(now);
    params.push(id); // WHERE clause

    this.db.prepare(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // Re-embed if the embedding surface changed.
    if (
      (Object.hasOwn(fields, 'l0') && fields.l0 !== existing.l0) ||
      (Object.hasOwn(fields, 'l1') && fields.l1 !== existing.l1) ||
      (Object.hasOwn(fields, 'semantic_anchor') && fields.semantic_anchor !== existing.semantic_anchor)
    ) {
      const embedText = this._buildEmbeddingText({
        l0: Object.hasOwn(fields, 'l0') ? fields.l0 : existing.l0,
        l1: Object.hasOwn(fields, 'l1') ? fields.l1 : existing.l1,
        semantic_anchor: Object.hasOwn(fields, 'semantic_anchor') ? fields.semantic_anchor : existing.semantic_anchor,
      });
      const embedding = await this._embed(embedText);
      if (embedding) {
        const getRowid = this.db.prepare("SELECT rowid FROM node_rowids WHERE node_id = ?");
        const mapping = getRowid.get(id);
        if (mapping) {
          this.db.prepare("DELETE FROM node_embeddings WHERE id = ?").run(mapping.rowid);
          this.db.prepare("INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)").run(mapping.rowid, embedding);
        }
      }
    }

    console.log(`[Engine] updateNode: ${id} updated fields: ${Object.keys(fields).join(', ')}`);
    return id;
  }

  /**
   * 16.5: Auto-suggest semantic edges for a newly written node using KNN + hub bias.
   * Finds cosine neighbors via vec0, boosts high-degree hub nodes, creates top-5 associative edges.
   * Called synchronously after node write, before consolidation check.
   */
  _suggestEdges(nodeId, embedding) {
    try {
      // Find top 10 cosine neighbors (vec0 KNN)
      const vecResults = this.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 11`
      ).all(embedding);

      const rowIdToNode = this.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
      const getNodeDegree = this.db.prepare(
        "SELECT conn_count FROM nodes WHERE id = ? AND state = 'active'"
      );

      const scored = [];
      for (const r of vecResults) {
        const mapping = rowIdToNode.get(r.id);
        if (!mapping || mapping.node_id === nodeId) continue;
        const cosSim = 1 - (r.distance * r.distance) / 2;
        if (cosSim < 0.40) continue; // minimum semantic relevance
        const degreeRow = getNodeDegree.get(mapping.node_id);
        if (!degreeRow) continue;
        // Hub bias: nodes with degree > 20 get 1.2× boost (preferential attachment)
        const hubBoost = (degreeRow.conn_count || 0) > 20 ? 1.2 : 1.0;
        scored.push({ nodeId: mapping.node_id, score: cosSim * hubBoost, cosSim });
      }

      if (scored.length === 0) return;

      // Sort by boosted score, take top 5
      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, 5);

      const ownerId = this._resolveOwnerStamp();
      const insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
        VALUES (?, ?, 'associative', ?, 'active', datetime('now'), ?)
      `);
      const _btSqlCC3 = this._bitemporalSqlClause().sql;
      const _validEpCC3 = this._validEdgeEndpointsSql();
      const updateConnCount = this.db.prepare(`
        UPDATE nodes SET conn_count = (
          (SELECT COUNT(*) FROM edges WHERE source = ? AND state = 'active'${_btSqlCC3}${_validEpCC3}) +
          (SELECT COUNT(*) FROM edges WHERE target = ? AND state = 'active'${_btSqlCC3}${_validEpCC3})
        ), accessed_at = datetime('now') WHERE id = ?
      `);

      let created = 0;
      for (const neighbor of topK) {
        // Edge strength derived from cosine similarity (0.4–1.0 → 0.3–0.7 strength range)
        const strength = Math.min(0.7, Math.max(0.3, neighbor.cosSim * 0.7));
        insertEdge.run(nodeId, neighbor.nodeId, strength, ownerId);
        insertEdge.run(neighbor.nodeId, nodeId, strength * 0.8, ownerId); // reverse edge slightly weaker
        updateConnCount.run(neighbor.nodeId, neighbor.nodeId, neighbor.nodeId);
        created++;
      }
      // Update own conn_count
      updateConnCount.run(nodeId, nodeId, nodeId);

      if (created > 0) {
        console.log(`[Engine] _suggestEdges: created ${created} associative edges for ${nodeId} (top cosSim=${topK[0].cosSim.toFixed(3)})`);
      }
    } catch (err) {
      console.warn(`[Engine] _suggestEdges failed: ${err.message}`);
    }
  }

  /**
   * L1 Consolidation — find high-cosine neighbors of a newly written node,
   * ask the judge LLM to classify FUSE / SUPERSEDE / INDEPENDENT.
   * Runs async, non-blocking. Modifies DB only on FUSE or SUPERSEDE verdict.
   */
  async _consolidationCheck(newNodeId, newEmbedding, { l0, l1, l2, nodeType = 'knowledge', source = null, eventAt = null }) {
    try {
      // L3 (anti-repetition): for autonomous-mimir-* writes of reflection /
      // tension-resolution, override the Infinity gate so the judge LLM can FUSE
      // duplicate Mímir syntheses. profile-dim stays Infinity per master plan §7
      // (dialectic must add a new dim, never overwrite). User-authored writes are
      // unaffected — the relax only fires when the new node's source is a Mímir
      // autonomous source AND the type is in the relaxable set.
      const isAutonomousMimir = typeof source === 'string' && source.startsWith('autonomous:mimir-');
      const RELAXABLE_MIMIR_TYPES = new Set(['reflection', 'tension-resolution']);
      const allowMimirRelax = isAutonomousMimir && RELAXABLE_MIMIR_TYPES.has(nodeType);

      // Type-aware fusion threshold — some types have higher bars or are completely unfusable
      let typeThreshold = FUSION_THRESHOLD_BY_TYPE[nodeType] ?? CONSOLIDATION_COSINE_THRESHOLD;
      if (allowMimirRelax && typeThreshold === Infinity) {
        typeThreshold = 0.75;  // Mímir-vs-Mímir collisions only — see candidate filter + ALLOWED_OPS bypass below
      }
      if (typeThreshold === Infinity) {
        // This type never participates in fusion (identity, milestone, diary, experiment, relationship, principle)
        this._consolidationStats.unfusable_skipped++;
        console.log(`[Consolidation] ⊘ Skip "${(l0 || '').slice(0, 50)}" — node_type=${nodeType} is unfusable by design`);
        if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'unfusable', nodeType, l0: (l0 || '').slice(0, 60) });
        return;
      }

      // Find cosine neighbors via vec0 KNN (top 6, excluding self)
      const vecResults = this.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 6`
      ).all(newEmbedding);

      const rowIdToNode = this.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");

      // Convert L2 distance to cosine similarity: cos_sim ≈ 1 - (L2²/2) for normalized vectors
      // Use the type-aware threshold instead of the global default
      const candidates = [];
      for (const r of vecResults) {
        const mapping = rowIdToNode.get(r.id);
        if (!mapping || mapping.node_id === newNodeId) continue;
        const l2dist = r.distance;
        const cosSim = 1 - (l2dist * l2dist) / 2;
        if (cosSim >= typeThreshold) {
          candidates.push({ nodeId: mapping.node_id, cosSim });
        }
      }

      this._consolidationStats.checked++;

      if (candidates.length === 0) {
        let topCos = -1;
        for (const r of vecResults) {
          const mapping = rowIdToNode.get(r.id);
          if (!mapping || mapping.node_id === newNodeId) continue;
          const cs = 1 - (r.distance * r.distance) / 2;
          if (cs > topCos) topCos = cs;
        }
        if (topCos >= 0) {
          this._consolidationStats.below_threshold++;
        } else {
          this._consolidationStats.no_neighbors++;
        }
        const topStr = topCos >= 0 ? `top_cosSim=${topCos.toFixed(3)} (Δ${(typeThreshold - topCos).toFixed(3)} below threshold)` : 'no_neighbors';
        console.log(`[Consolidation] ── Check for "${(l0 || '').slice(0, 50)}" (${nodeType}, threshold=${typeThreshold}) ── 0 candidates, ${topStr}`);
        if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'skip', reason: topCos >= 0 ? 'below_threshold' : 'no_neighbors', topCos: topCos >= 0 ? Number(topCos.toFixed(3)) : null, nodeType, threshold: typeThreshold });
        return;
      }

      console.log(`[Consolidation] ── Check for "${(l0 || '').slice(0, 50)}" (${nodeType}, threshold=${typeThreshold}) ── ${candidates.length} neighbor(s)`);
      if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'work', candidates: candidates.length, nodeType, l0: (l0 || '').slice(0, 60), new_id: newNodeId });

      // For each candidate, load node content and ask the judge LLM
      for (const cand of candidates) {
        const existing = this.db.prepare(
          "SELECT id, l0, l1, l2, created_at, event_at, state, node_type, source FROM nodes WHERE id = ? AND state = 'active'"
        ).get(cand.nodeId);
        if (!existing) continue;

        // NEVER fuse/supersede immutable node types — except L3 relax: a Mímir-
        // vs-Mímir collision on reflection/tension-resolution can fuse via the judge LLM.
        const existingThreshold = FUSION_THRESHOLD_BY_TYPE[existing.node_type] ?? CONSOLIDATION_COSINE_THRESHOLD;
        const existingIsAutonomousMimir = typeof existing.source === 'string' && existing.source.startsWith('autonomous:mimir-');
        const existingRelaxable = existingIsAutonomousMimir && RELAXABLE_MIMIR_TYPES.has(existing.node_type);
        if (existingThreshold === Infinity && !(allowMimirRelax && existingRelaxable)) {
          console.log(`[Consolidation] Skipping unfusable node: ${existing.id} (${existing.node_type})`);
          continue;
        }

        // Skip if already superseded by this node (auto-supersedes already handled it)
        const _btSqlSup = this._bitemporalSqlClause().sql;
        const alreadySuperseded = this.db.prepare(
          `SELECT 1 FROM edges WHERE source = ? AND target = ? AND edge_type = 'supersedes' AND state = 'active'${_btSqlSup}`
        ).get(newNodeId, cand.nodeId);
        if (alreadySuperseded) continue;

        // 19.2: Engineering auto-supersede — skip the judge call when tag overlap signals same problem
        if (nodeType === 'engineering' && existing.node_type === 'engineering' && cand.cosSim >= 0.75) {
          try {
            const newTagRow = this.db.prepare("SELECT tags FROM nodes WHERE id = ?").get(newNodeId);
            const newTagArr = this._normalizeTags(newTagRow?.tags);
            const existTagRow = this.db.prepare("SELECT tags FROM nodes WHERE id = ?").get(existing.id);
            const existTagArr = this._normalizeTags(existTagRow?.tags);
            if (newTagArr.length > 0 && existTagArr.length > 0) {
              const newSet = new Set(newTagArr);
              const overlap = existTagArr.filter(t => newSet.has(t));
              // Tag overlap score: intersection / min(|A|, |B|) — Jaccard-like but normalized by smaller set
              const overlapScore = overlap.length / Math.min(newTagArr.length, existTagArr.length);
              if (overlapScore >= 0.5) {
                // Strong tag overlap + high cosine → auto-supersede without judge call
                console.log(`[Consolidation] ⚡ Engineering auto-supersede: "${(l0 || '').slice(0, 40)}" supersedes "${(existing.l0 || '').slice(0, 40)}" (cosSim=${cand.cosSim.toFixed(3)}, tagOverlap=${overlapScore.toFixed(2)}, shared: ${overlap.join(',')})`);
                this._applySupersede(newNodeId, existing.id);
                this._logConsolidation({ verdict: 'SUPERSEDE', newNodeId, oldNodeId: existing.id, newL0: l0, oldL0: existing.l0, cosine: cand.cosSim, reason: `auto: engineering tag overlap (${overlap.join(',')})` });
                this._consolidationStats.supersede++;
                continue;
              }
            }
          } catch (autoSupErr) {
            console.warn(`[Consolidation] Engineering auto-supersede check failed: ${autoSupErr.message}`);
          }
        }

        const verdict = await this._callConsolidationJudge(
          { id: newNodeId, l0, l1, l2, created_at: eventAt || new Date().toISOString(), node_type: nodeType },
          { id: existing.id, l0: existing.l0, l1: existing.l1, l2: existing.l2, created_at: existing.event_at || existing.created_at, node_type: existing.node_type },
          cand.cosSim
        );

        if (!verdict) continue;

        // Enforce allowed-operations constraint per BOTH node types
        // New node's type restricts what it can do; existing node's type restricts what can be done TO it.
        // L3 relax: bypass ALLOWED_OPS for Mímir-vs-Mímir on reflection / tension-resolution
        // so the judge's FUSE verdict isn't immediately downgraded to INDEPENDENT.
        const bypassOpsForMimir = allowMimirRelax && existingRelaxable;
        const newAllowed = bypassOpsForMimir ? null : ALLOWED_OPS_BY_TYPE[nodeType];
        const existAllowed = bypassOpsForMimir ? null : ALLOWED_OPS_BY_TYPE[existing.node_type];
        if ((newAllowed && !newAllowed.includes(verdict.action)) ||
            (existAllowed && !existAllowed.includes(verdict.action))) {
          const blocker = (newAllowed && !newAllowed.includes(verdict.action)) ? nodeType : existing.node_type;
          console.log(`[Consolidation] ⊘ Blocked ${verdict.action} for ${blocker} (allowed: ${(ALLOWED_OPS_BY_TYPE[blocker] || []).join('/')}) — downgrading to INDEPENDENT`);
          verdict.action = 'INDEPENDENT';
          verdict.reason = `${verdict.reason} [blocked: ${blocker} does not allow this operation]`;
        }

        if (verdict.action === 'FUSE') {
          console.log(`[Consolidation] ✦ FUSE: "${(l0 || '').slice(0, 40)}" absorbs "${(existing.l0 || '').slice(0, 40)}" — ${verdict.reason}`);
          this._applyFuse(newNodeId, existing);
          this._logConsolidation({ verdict: 'FUSE', newNodeId, oldNodeId: existing.id, newL0: l0, oldL0: existing.l0, cosine: cand.cosSim, reason: verdict.reason });
          this._consolidationStats.fuse++;
          if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'fuse', l0: (l0 || '').slice(0, 60), absorbed: (existing.l0 || '').slice(0, 60), new_id: newNodeId, absorbed_id: existing.id, cosine: Number(cand.cosSim.toFixed(3)) });
        } else if (verdict.action === 'SUPERSEDE') {
          console.log(`[Consolidation] ▸ SUPERSEDE: "${(l0 || '').slice(0, 40)}" supersedes "${(existing.l0 || '').slice(0, 40)}" — ${verdict.reason}`);
          this._applySupersede(newNodeId, existing.id);
          this._logConsolidation({ verdict: 'SUPERSEDE', newNodeId, oldNodeId: existing.id, newL0: l0, oldL0: existing.l0, cosine: cand.cosSim, reason: verdict.reason });
          this._consolidationStats.supersede++;
          if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'supersede', l0: (l0 || '').slice(0, 60), replaced: (existing.l0 || '').slice(0, 60), new_id: newNodeId, replaced_id: existing.id, cosine: Number(cand.cosSim.toFixed(3)) });
        } else if (verdict.action === 'TIMELINE_MERGE') {
          // Feature-flag + time-window vetoes (per R1 §2.1); fall through to INDEPENDENT on veto
          const existingTs = new Date(existing.created_at).getTime();
          const gapHours = Number.isFinite(existingTs) ? (Date.now() - existingTs) / 3.6e6 : Infinity;
          let veto = null;
          if (!TIMELINE_MERGE_ENABLED) veto = 'feature disabled';
          else if (gapHours < TIMELINE_MERGE_MIN_GAP_HOURS) veto = `gap ${gapHours.toFixed(1)}h < min ${TIMELINE_MERGE_MIN_GAP_HOURS}h`;

          if (veto) {
            console.log(`[Consolidation] ⊘ TIMELINE_MERGE vetoed (${veto}) — downgrading to INDEPENDENT`);
            verdict.action = 'INDEPENDENT';
            verdict.reason = `${verdict.reason} [veto: ${veto}]`;
          } else {
            console.log(`[Consolidation] ⏱ TIMELINE_MERGE: "${(l0 || '').slice(0, 40)}" prepends into "${(existing.l0 || '').slice(0, 40)}" (gap=${gapHours.toFixed(1)}h) — ${verdict.reason}`);
            this._applyTimelineMerge(
              { id: newNodeId, l0, l1, l2, created_at: new Date().toISOString(), event_at: eventAt },
              { id: existing.id, l0: existing.l0, l1: existing.l1, l2: existing.l2, created_at: existing.created_at, event_at: existing.event_at },
              verdict.newL0,
              verdict.newL1
            );
            this._logConsolidation({ verdict: 'TIMELINE_MERGE', newNodeId, oldNodeId: existing.id, newL0: l0, oldL0: existing.l0, cosine: cand.cosSim, reason: verdict.reason });
            this._consolidationStats.timelineMerge = (this._consolidationStats.timelineMerge || 0) + 1;
            if (liveBus) liveBus.safeEmit('engine.consolidation', { status: 'timeline_merge', l0: (l0 || '').slice(0, 60), merged_id: existing.id, new_id: newNodeId, gap_h: Number(gapHours.toFixed(1)), cosine: Number(cand.cosSim.toFixed(3)) });
          }
        }

        if (verdict.action !== 'FUSE' && verdict.action !== 'SUPERSEDE' && verdict.action !== 'TIMELINE_MERGE') {
          console.log(`[Consolidation] · INDEPENDENT: "${(l0 || '').slice(0, 30)}" ↔ "${(existing.l0 || '').slice(0, 30)}" — kept as-is`);
          this._logConsolidation({ verdict: 'INDEPENDENT', newNodeId, oldNodeId: existing.id, newL0: l0, oldL0: existing.l0, cosine: cand.cosSim, reason: verdict.reason });
          this._consolidationStats.independent++;

          // 19.3: Auto-create builds_on edge for INDEPENDENT experiment pairs (structural heuristic — runs regardless of judge verdict)
          if (nodeType === 'experiment' && (existing.node_type === 'experiment') && cand.cosSim >= 0.70) {
            try {
              this.db.prepare(`
                INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, classification_source, confidence, owner_id)
                VALUES (?, ?, 'builds_on', 0.7, 'active', datetime('now'), 'structural_heuristic', 0.8,
                  COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
              `).run(newNodeId, existing.id, newNodeId, this._resolveOwnerStamp());
              console.log(`[Consolidation] ⟶ builds_on edge: ${newNodeId} → ${existing.id} (experiment chain)`);
            } catch (edgeErr) {
              console.warn(`[Consolidation] builds_on edge failed: ${edgeErr.message}`);
            }
          }

          // Phase 1 Multi-SA: write judge-classified edge when a valid EDGE_TYPE was supplied.
          // Priority: fine/precise EDGE_TYPE → FALLBACK_COARSE → no edge (drop preserves graph cleanliness).
          let writeEdgeType = null;
          let writeSource = null;
          let writeConfidence = null;
          if (verdict.edgeType && verdict.edgeType !== 'none') {
            writeEdgeType = verdict.edgeType;
            writeSource = 'consolidation';
            writeConfidence = (verdict.confidence != null) ? verdict.confidence : 0.5;
          } else if (verdict.fallbackCoarse && verdict.fallbackCoarse !== 'none') {
            writeEdgeType = verdict.fallbackCoarse;
            writeSource = 'consolidation_fallback';
            writeConfidence = (verdict.confidence != null) ? Math.min(verdict.confidence, 0.5) : 0.3;
          }

          if (writeEdgeType) {
            try {
              const result = this.db.prepare(`
                INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, classification_source, confidence, owner_id)
                VALUES (?, ?, ?, 0.5, 'active', datetime('now'), ?, ?,
                  COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
              `).run(newNodeId, existing.id, writeEdgeType, writeSource, writeConfidence, newNodeId, this._resolveOwnerStamp());
              if (result.changes > 0) {
                this._consolidationStats.classifiedEdges = (this._consolidationStats.classifiedEdges || 0) + 1;
                const byType = this._consolidationStats.edgeTypeCounts = this._consolidationStats.edgeTypeCounts || {};
                byType[writeEdgeType] = (byType[writeEdgeType] || 0) + 1;
                const channelTag = verdict.channel || '?';
                console.log(`[Consolidation] ⟶ ${writeEdgeType} edge [${channelTag}, conf=${writeConfidence.toFixed(2)}, src=${writeSource}]: ${newNodeId} → ${existing.id}`);
              }
            } catch (edgeErr) {
              console.warn(`[Consolidation] classified edge failed: ${edgeErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[Consolidation] Error in check:`, err.message);
    }
  }

  /**
   * Lever B (2026-05-18) — periodic consolidation re-sweep.
   *
   * Write-time KNN only inspects top-6 neighbors above the type threshold at the moment of
   * insert. Pairs that drift into the band later (threshold drops, embedder improvements,
   * legacy nodes from before the threshold change) never get judged. This method walks a
   * sample of recent nodes, runs full top-6 KNN, and routes the cosSim ∈ [type_threshold, 0.95)
   * band through the same LLM judge as the write path — including TIMELINE_MERGE detection
   * that pure-cosine batch sweeps would miss.
   *
   * Throttled: max `maxPairs` judge calls per fire. Skips pairs judged within the last
   * `dedupeDays` (cheap consolidation_log lookup). Kill-switch: ENGINE_CONSOLIDATION_RESWEEP=0.
   */
  async _consolidationResweep({ windowDays = 30, maxPairs = 30, dryRun = false, dedupeDays = 7, sampleSize = 120 } = {}) {
    if (process.env.ENGINE_CONSOLIDATION_RESWEEP === '0') {
      return { ok: false, killed: true, scanned: 0, judged: 0 };
    }
    const t0 = Date.now();
    const cutoffSec = Math.floor((Date.now() - windowDays * 86400 * 1000) / 1000);
    const dedupeCutoff = new Date(Date.now() - dedupeDays * 86400 * 1000).toISOString();

    let candidateNodes = [];
    try {
      candidateNodes = this.db.prepare(`
        SELECT id, l0, l1, l2, node_type, source, event_at, created_at
          FROM nodes
         WHERE state = 'active' AND superseded_at IS NULL
           AND COALESCE(strftime('%s', event_at), strftime('%s', created_at), 0) >= ?
         ORDER BY RANDOM()
         LIMIT ?
      `).all(cutoffSec, Math.max(10, Math.min(500, sampleSize | 0)));
    } catch (e) {
      return { ok: false, error: e.message, scanned: 0, judged: 0 };
    }

    let judged = 0, fused = 0, superseded = 0, merged = 0, indep = 0, blocked = 0;
    const rowIdToNode = this.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
    const rowIdLookup = this.db.prepare("SELECT rowid FROM node_rowids WHERE node_id = ?");
    const embLookup   = this.db.prepare("SELECT embedding FROM node_embeddings WHERE id = ?");
    const nodeLookup  = this.db.prepare(`
      SELECT id, l0, l1, l2, node_type, source, event_at, created_at, state, superseded_at
        FROM nodes WHERE id = ? AND state = 'active' AND superseded_at IS NULL
    `);
    const recentJudgedLookup = this.db.prepare(`
      SELECT 1 FROM consolidation_log
       WHERE created_at > ?
         AND ((new_node_id = ? AND old_node_id = ?) OR (new_node_id = ? AND old_node_id = ?))
       LIMIT 1
    `);

    for (const a of candidateNodes) {
      if (judged >= maxPairs) break;
      const aThreshold = FUSION_THRESHOLD_BY_TYPE[a.node_type] ?? CONSOLIDATION_COSINE_THRESHOLD;
      if (aThreshold === Infinity) continue;

      const rowMap = rowIdLookup.get(a.id);
      if (!rowMap) continue;
      const embRow = embLookup.get(rowMap.rowid);
      if (!embRow) continue;

      let vecResults = [];
      try {
        vecResults = this.db.prepare(
          `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 6`
        ).all(embRow.embedding);
      } catch { continue; }

      for (const r of vecResults) {
        if (judged >= maxPairs) break;
        const mapping = rowIdToNode.get(r.id);
        if (!mapping || mapping.node_id === a.id) continue;
        const cosSim = 1 - (r.distance * r.distance) / 2;
        if (cosSim < aThreshold) continue;
        if (cosSim >= 0.95) continue;

        const b = nodeLookup.get(mapping.node_id);
        if (!b) continue;
        const bThreshold = FUSION_THRESHOLD_BY_TYPE[b.node_type] ?? CONSOLIDATION_COSINE_THRESHOLD;
        if (bThreshold === Infinity) continue;
        if (cosSim < Math.max(aThreshold, bThreshold)) continue;

        const supEdge = this.db.prepare(`
          SELECT 1 FROM edges WHERE state = 'active' AND edge_type = 'supersedes'
             AND ((source = ? AND target = ?) OR (source = ? AND target = ?))
          LIMIT 1
        `).get(a.id, b.id, b.id, a.id);
        if (supEdge) continue;

        if (recentJudgedLookup.get(dedupeCutoff, a.id, b.id, b.id, a.id)) continue;

        const aTs = new Date(a.event_at || a.created_at).getTime();
        const bTs = new Date(b.event_at || b.created_at).getTime();
        const newer = aTs >= bTs ? a : b;
        const older = aTs >= bTs ? b : a;

        if (dryRun) { judged++; continue; }

        let verdict;
        try {
          verdict = await this._callConsolidationJudge(
            { id: newer.id, l0: newer.l0, l1: newer.l1, l2: newer.l2, created_at: newer.event_at || newer.created_at, node_type: newer.node_type },
            { id: older.id, l0: older.l0, l1: older.l1, l2: older.l2, created_at: older.event_at || older.created_at, node_type: older.node_type },
            cosSim
          );
        } catch (e) {
          console.warn(`[Resweep] judge err: ${e.message}`);
          continue;
        }
        judged++;
        if (!verdict) continue;

        // ALLOWED_OPS gate — mirrors write-time guard. Bias toward false negatives
        // ("情愿放过supersede都不能错杀"): when in doubt, downgrade to INDEPENDENT.
        const newAllowed = ALLOWED_OPS_BY_TYPE[newer.node_type];
        const oldAllowed = ALLOWED_OPS_BY_TYPE[older.node_type];
        if ((newAllowed && !newAllowed.includes(verdict.action)) ||
            (oldAllowed && !oldAllowed.includes(verdict.action))) {
          verdict.action = 'INDEPENDENT';
          blocked++;
        }

        try {
          if (verdict.action === 'FUSE') {
            this._applyFuse(newer.id, older);
            this._logConsolidation({ verdict: 'FUSE', newNodeId: newer.id, oldNodeId: older.id, newL0: newer.l0, oldL0: older.l0, cosine: cosSim, reason: `[resweep] ${verdict.reason}` });
            fused++;
          } else if (verdict.action === 'SUPERSEDE') {
            this._applySupersede(newer.id, older.id);
            this._logConsolidation({ verdict: 'SUPERSEDE', newNodeId: newer.id, oldNodeId: older.id, newL0: newer.l0, oldL0: older.l0, cosine: cosSim, reason: `[resweep] ${verdict.reason}` });
            superseded++;
          } else if (verdict.action === 'TIMELINE_MERGE') {
            const olderTs = new Date(older.event_at || older.created_at).getTime();
            const gapHours = Number.isFinite(olderTs) ? (Date.now() - olderTs) / 3.6e6 : Infinity;
            if (TIMELINE_MERGE_ENABLED && gapHours >= TIMELINE_MERGE_MIN_GAP_HOURS) {
              this._applyTimelineMerge(
                { id: newer.id, l0: newer.l0, l1: newer.l1, l2: newer.l2, created_at: newer.created_at, event_at: newer.event_at },
                { id: older.id, l0: older.l0, l1: older.l1, l2: older.l2, created_at: older.created_at, event_at: older.event_at },
                verdict.newL0, verdict.newL1
              );
              this._logConsolidation({ verdict: 'TIMELINE_MERGE', newNodeId: newer.id, oldNodeId: older.id, newL0: newer.l0, oldL0: older.l0, cosine: cosSim, reason: `[resweep] ${verdict.reason}` });
              merged++;
            } else {
              this._logConsolidation({ verdict: 'INDEPENDENT', newNodeId: newer.id, oldNodeId: older.id, newL0: newer.l0, oldL0: older.l0, cosine: cosSim, reason: `[resweep veto-tm] ${verdict.reason}` });
              indep++;
            }
          } else {
            this._logConsolidation({ verdict: 'INDEPENDENT', newNodeId: newer.id, oldNodeId: older.id, newL0: newer.l0, oldL0: older.l0, cosine: cosSim, reason: `[resweep] ${verdict.reason}` });
            indep++;
          }
        } catch (applyErr) {
          console.warn(`[Resweep] apply err (${verdict?.action}): ${applyErr.message}`);
        }
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[Resweep] judged=${judged} fuse=${fused} supersede=${superseded} timeline=${merged} indep=${indep} blocked=${blocked} (${elapsed}s, window=${windowDays}d, max=${maxPairs}, sampled=${candidateNodes.length})`);
    return { ok: true, scanned: candidateNodes.length, judged, fuse: fused, supersede: superseded, timeline_merge: merged, independent: indep, blocked, elapsed_s: Number(elapsed) };
  }

  /**
   * Call the judge LLM to classify whether two nodes should be fused, superseded, or kept independent.
   */
  async _callConsolidationJudge(nodeA, nodeB, cosSim) {
    const systemPrompt = `You are a knowledge graph consolidation judge. Given two nodes, decide:
FUSE — Same core information, merge into one. Use for true duplicates or trivial reformulations.
SUPERSEDE — Same topic, Node A (newer) has better/updated info and Node B is now WRONG / obsolete. Dormant Node B.
TIMELINE_MERGE — Same topic, different points in time. Node B remains accurate-as-of-its-time; Node A
                  adds a new dated update. Prepend Node A into Node B as a reverse-chronological section.
                  Use when both nodes describe the same subject but capture different stages/updates.
INDEPENDENT — Related but genuinely different info. Keep both.

KEY DISTINCTION — SUPERSEDE vs TIMELINE_MERGE:
- SUPERSEDE: older node is factually wrong or obsolete ("MiniLM is our embedder" → "BGE-M3 is our embedder").
- TIMELINE_MERGE: older node stayed true for its moment, newer adds an update to the arc
  ("Multi-SA Phase 1 deployed" → "Multi-SA Phase 4 deployed"). Prefer TIMELINE_MERGE when older is not wrong.

LARGE-GAP GUIDANCE (when Created timestamps are far apart, e.g. >30 days):
A long gap raises the chance the older node's claim no longer reflects current state. Before choosing
TIMELINE_MERGE, weigh whether Node B states a *tense fact* (the current state of something — config,
deployment, ownership, policy, version) or a *dated event/observation* (something that happened at
a moment).
- TENSE FACT older + new contradicts state → SUPERSEDE (older is now wrong: "MiniLM is our embedder"
  6 months later when it's BGE-M3). The arc framing would mislead future readers.
- DATED EVENT older + new adds another point on the arc → TIMELINE_MERGE ("Phase 1 deployed" stays
  true even years later; "Phase 4 deployed" extends the arc).
When unsure between the two for a large-gap pair, prefer SUPERSEDE for tense state-of-X claims and
INDEPENDENT when the topics drift (don't force-merge across long stretches just because cosine is high).

TYPE-SPECIFIC RULES (strictly enforced — disallowed operations will be blocked):
- social-rule: INDEPENDENT only. Each rule is a standalone norm that does not evolve through new instances; overlap means co-presence, not redundancy.
- language-template: INDEPENDENT only. Each template is a reusable rhetorical/syntactic pattern; merging would collapse distinguishable register or tone variants.
- general-knowledge: INDEPENDENT only. Canonical facts live in the knowledge graph as discrete anchors; facts do not accumulate into a timeline.
- action: INDEPENDENT only. Actions are discrete procedural records (e.g., "ran X script"); each execution is its own event and should never fuse with another execution.
- interaction: INDEPENDENT only. Interactions are event snapshots of a specific moment (e.g., "user raised Y on date Z"); each is a bounded observation and must never merge — preserve the temporal grain.
- reading-note/introspection: FUSE / TIMELINE_MERGE / INDEPENDENT. No SUPERSEDE — each entry has standalone value.
- decision: SUPERSEDE or INDEPENDENT only. No FUSE / TIMELINE_MERGE — decisions are discrete records.
- engineering: FUSE / SUPERSEDE / TIMELINE_MERGE / INDEPENDENT. Prefer TIMELINE_MERGE over SUPERSEDE when older stayed correct-as-of-its-time.
- theory: FUSE / SUPERSEDE / TIMELINE_MERGE / INDEPENDENT. Prefer INDEPENDENT unless same arc / same framework evolving.
- observation: FUSE / SUPERSEDE / TIMELINE_MERGE / INDEPENDENT. TIMELINE_MERGE for "same thing observed at different times".
- conversation-insight: FUSE / SUPERSEDE / TIMELINE_MERGE / INDEPENDENT. TIMELINE_MERGE when same topic with recurring conversations.

Be conservative with FUSE. Different diary entries, different sub-categories, complementary perspectives = INDEPENDENT.

─── EDGE CLASSIFICATION (only when verdict = INDEPENDENT) ───
When you decide INDEPENDENT and the two nodes have a genuine relationship, classify it for the
Multi-channel Spreading Activation (SA) engine. If they are merely topically adjacent with no
meaningful structural relation, answer EDGE_TYPE: none (no edge is written).

EDGE_TYPE — pick ONE from this whitelist:
  Knowledge channel (epistemic logic):
    causal, contrastive, hierarchical,                    ← coarse fallbacks
    supports, contradicts, causes,
    extends, synthesizes, challenges,
    contextualizes, contrasts                             ← fine precision
  Language channel (stylistic / associative / narrative):
    associative, temporal,                                ← coarse fallbacks
    inspires, parallels, exemplifies, complements         ← fine precision
  Scaffold channel (procedural / structural):
    enables, triggers, depends_on,
    contains, supersedes, builds_on
  none — if no genuine relation beyond surface similarity

CHANNEL — must match the channel of EDGE_TYPE above: knowledge | language | scaffold | none
CONFIDENCE — 0.0 to 1.0, your certainty in EDGE_TYPE (use ≤ 0.5 when uncertain)
FALLBACK_COARSE — one of: causal | contrastive | hierarchical | associative | temporal | none
  (safety net if EDGE_TYPE is rejected; pick the closest coarse bucket)

Prefer FINE edges when confident (≥ 0.7). Use COARSE when the relation is clear but the fine
distinction is ambiguous. Use NONE liberally — we'd rather miss an edge than create noise.

Respond EXACTLY (all fields on separate lines):
VERDICT: [FUSE|SUPERSEDE|TIMELINE_MERGE|INDEPENDENT]
REASON: [1 sentence]
EDGE_TYPE: [one of the whitelist above, or none — IGNORED when VERDICT is FUSE/SUPERSEDE/TIMELINE_MERGE]
CHANNEL: [knowledge|language|scaffold|none]
CONFIDENCE: [0.0-1.0]
FALLBACK_COARSE: [causal|contrastive|hierarchical|associative|temporal|none]
NEW_L0: [REQUIRED when VERDICT=TIMELINE_MERGE — a title covering the whole arc (≤20 tokens). Empty string keeps the canonical L0 as-is.]
NEW_L1: [REQUIRED when VERDICT=TIMELINE_MERGE — one paragraph (≤80 tokens) describing how the topic has evolved across both nodes. This replaces the canonical L1 so write for the arc, not the latest point.]`;

    const user = `## Node A (newer): \`${nodeA.id}\` [type: ${nodeA.node_type || 'knowledge'}]
Created: ${nodeA.created_at}
L0: ${(nodeA.l0 || '').slice(0, 200)}
L1: ${(nodeA.l1 || '').slice(0, 400)}
L2: ${(nodeA.l2 || '').slice(0, 600)}

## Node B (existing): \`${nodeB.id}\` [type: ${nodeB.node_type || 'knowledge'}]
Created: ${nodeB.created_at}
L0: ${(nodeB.l0 || '').slice(0, 200)}
L1: ${(nodeB.l1 || '').slice(0, 400)}
L2: ${(nodeB.l2 || '').slice(0, 600)}

Cosine similarity: ${cosSim.toFixed(3)}`;

    // Note: consolidation judge bypasses LLMRouter and assumes an OpenAI-compatible
    // endpoint at LLM_BASE_URL. Works with OpenAI/proxy/Ollama; raw Anthropic /v1/messages
    // shape is not supported here. Fold into router post-OSS-launch.
    try {
      const response = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
        body: JSON.stringify({
          model: CONSOLIDATION_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: user }
          ],
          temperature: 0.0,
          max_tokens: 300
        })
      });

      if (!response.ok) {
        console.warn(`[Consolidation] LLM API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim() || '';

      let action = 'INDEPENDENT';
      let reason = '';
      let edgeType = null;
      let channel = null;
      let confidence = null;
      let fallbackCoarse = null;
      let newL0 = null;
      let newL1 = null;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        const upper = trimmed.toUpperCase();
        if (upper.startsWith('VERDICT:')) {
          const v = trimmed.split(':')[1]?.trim().toUpperCase();
          if (['FUSE', 'SUPERSEDE', 'TIMELINE_MERGE', 'INDEPENDENT'].includes(v)) action = v;
        } else if (upper.startsWith('REASON:')) {
          reason = trimmed.split(':').slice(1).join(':').trim();
        } else if (upper.startsWith('EDGE_TYPE:')) {
          edgeType = trimmed.split(':').slice(1).join(':').trim().toLowerCase();
        } else if (upper.startsWith('CHANNEL:')) {
          channel = trimmed.split(':').slice(1).join(':').trim().toLowerCase();
        } else if (upper.startsWith('CONFIDENCE:')) {
          const raw = trimmed.split(':').slice(1).join(':').trim();
          const n = parseFloat(raw);
          if (Number.isFinite(n)) confidence = Math.max(0, Math.min(1, n));
        } else if (upper.startsWith('FALLBACK_COARSE:')) {
          fallbackCoarse = trimmed.split(':').slice(1).join(':').trim().toLowerCase();
        } else if (upper.startsWith('NEW_L0:')) {
          newL0 = trimmed.split(':').slice(1).join(':').trim();
        } else if (upper.startsWith('NEW_L1:')) {
          newL1 = trimmed.split(':').slice(1).join(':').trim();
        }
      }

      // Whitelist validation — hallucinated values are dropped + logged.
      const EDGE_WHITELIST = CONSOLIDATION_EDGE_WHITELIST;
      const CHANNEL_WHITELIST = new Set(['knowledge', 'language', 'scaffold', 'none']);
      const COARSE_WHITELIST = new Set(['causal', 'contrastive', 'hierarchical', 'associative', 'temporal', 'none']);

      if (edgeType !== null && edgeType !== 'none' && !EDGE_WHITELIST.has(edgeType)) {
        this._consolidationStats.hallucinatedEdgeType = (this._consolidationStats.hallucinatedEdgeType || 0) + 1;
        console.warn(`[Consolidation] Dropped hallucinated EDGE_TYPE: "${edgeType}" (not in whitelist)`);
        edgeType = null;
      }
      if (channel !== null && !CHANNEL_WHITELIST.has(channel)) {
        this._consolidationStats.hallucinatedChannel = (this._consolidationStats.hallucinatedChannel || 0) + 1;
        console.warn(`[Consolidation] Dropped hallucinated CHANNEL: "${channel}"`);
        channel = null;
      }
      if (fallbackCoarse !== null && !COARSE_WHITELIST.has(fallbackCoarse)) {
        this._consolidationStats.hallucinatedFallback = (this._consolidationStats.hallucinatedFallback || 0) + 1;
        console.warn(`[Consolidation] Dropped hallucinated FALLBACK_COARSE: "${fallbackCoarse}"`);
        fallbackCoarse = null;
      }

      return { action, reason, edgeType, channel, confidence, fallbackCoarse, newL0, newL1 };
    } catch (err) {
      console.warn(`[Consolidation] LLM call failed:`, err.message);
      return null;
    }
  }

  /**
   * Append a row to consolidation_log. Wrapped in try/catch so a logging failure
   * never breaks the consolidation flow itself.
   */
  _logConsolidation({ verdict, newNodeId, oldNodeId, newL0, oldL0, cosine, reason }) {
    try {
      this.db.prepare(`
        INSERT INTO consolidation_log
          (verdict, new_node_id, old_node_id, new_l0, old_l0, cosine, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        verdict,
        newNodeId ?? null,
        oldNodeId ?? null,
        newL0 ?? null,
        oldL0 ?? null,
        Number.isFinite(cosine) ? cosine : null,
        reason ?? null,
      );
    } catch (err) {
      console.warn(`[Consolidation] log write failed:`, err.message);
    }
  }

  /**
   * Apply FUSE: add supersedes edge, penalize old node, transfer edges.
   */
  _applyFuse(newNodeId, oldNode) {
    let shouldOwnTxn = false;
    try {
      shouldOwnTxn = !this.db.inTransaction;
      if (shouldOwnTxn) this.db.prepare('BEGIN IMMEDIATE').run();
      const now = new Date().toISOString();
      const ownerId = this._resolveOwnerStamp();

      // event_at parity with TIMELINE_MERGE: surviving node carries the
      // earliest source-time across both nodes so FUSE doesn't silently
      // erase the older event's temporal lineage.
      const newRow = this.db.prepare("SELECT event_at FROM nodes WHERE id = ?").get(newNodeId);
      const oldRow = this.db.prepare("SELECT event_at FROM nodes WHERE id = ?").get(oldNode.id);
      const _earliest = (a, b) => {
        const ta = a ? new Date(a).getTime() : NaN;
        const tb = b ? new Date(b).getTime() : NaN;
        if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb ? a : b;
        return Number.isFinite(ta) ? a : (Number.isFinite(tb) ? b : null);
      };
      const mergedEventAt = _earliest(newRow?.event_at, oldRow?.event_at);
      if (mergedEventAt) {
        this.db.prepare("UPDATE nodes SET event_at = ? WHERE id = ?").run(mergedEventAt, newNodeId);
      }

      this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
        VALUES (?, ?, 'supersedes', 1.0, 'active', ?,
          COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
      `).run(newNodeId, oldNode.id, now, newNodeId, ownerId);

      this.db.prepare(`
        UPDATE nodes SET weight = weight * 0.1, superseded_at = datetime('now'), deprecated_at = datetime('now'), superseded_by = ?
        WHERE id = ? AND state = 'active' AND superseded_at IS NULL
      `).run(newNodeId, oldNode.id);

      // Transfer old node's outbound non-supersedes edges to new node.
      // Pre-filter to skip edges whose OTHER endpoint is already dormant/superseded —
      // those would be born-zombies (eventually swept, but better not to write them at all).
      const _btSqlF1 = this._bitemporalSqlClause().sql;
      const oldOutEdges = this.db.prepare(`
        SELECT target, edge_type, strength FROM edges
        WHERE source = ? AND state = 'active'${_btSqlF1} AND edge_type != 'supersedes' AND target != ?
          AND target IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
      `).all(oldNode.id, newNodeId);

      for (const edge of oldOutEdges) {
        this.db.prepare(`
          INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
          VALUES (?, ?, ?, ?, 'active', ?,
            COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
        `).run(newNodeId, edge.target, edge.edge_type, edge.strength, now, newNodeId, ownerId);
      }

      // Transfer old node's inbound non-supersedes edges to new node
      const oldInEdges = this.db.prepare(`
        SELECT source, edge_type, strength FROM edges
        WHERE target = ? AND state = 'active'${_btSqlF1} AND edge_type != 'supersedes' AND source != ?
          AND source IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
      `).all(oldNode.id, newNodeId);

      for (const edge of oldInEdges) {
        this.db.prepare(`
          INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
          VALUES (?, ?, ?, ?, 'active', ?,
            COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
        `).run(edge.source, newNodeId, edge.edge_type, edge.strength, now, edge.source, ownerId);
      }

      // Dormant all old node's non-supersedes edges (they've been copied to new node)
      this.db.prepare(`
        UPDATE edges SET state = 'dormant'
        WHERE (source = ? OR target = ?) AND state = 'active' AND edge_type != 'supersedes'
      `).run(oldNode.id, oldNode.id);

      // Also dormant the old node itself (not just weight penalty)
      this.db.prepare(`
        UPDATE nodes SET state = 'dormant' WHERE id = ? AND state = 'active'
      `).run(oldNode.id);

      this._adjCacheVersion++;
      if (shouldOwnTxn) this.db.prepare('COMMIT').run();
    } catch (err) {
      try { if (shouldOwnTxn && this.db.inTransaction) this.db.prepare('ROLLBACK').run(); } catch {}
      console.warn(`[Consolidation] FUSE apply failed:`, err.message);
    }
  }

  /**
   * Apply SUPERSEDE: add supersedes edge and penalize old node.
   */
  _applySupersede(newNodeId, oldNodeId) {
    let shouldOwnTxn = false;
    try {
      shouldOwnTxn = !this.db.inTransaction;
      if (shouldOwnTxn) this.db.prepare('BEGIN IMMEDIATE').run();
      const now = new Date().toISOString();
      const ownerId = this._resolveOwnerStamp();
      this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
        VALUES (?, ?, 'supersedes', 1.0, 'active', ?,
          COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
      `).run(newNodeId, oldNodeId, now, newNodeId, ownerId);

      this.db.prepare(`
        UPDATE nodes SET weight = weight * 0.1, superseded_at = datetime('now'), deprecated_at = datetime('now'), superseded_by = ?
        WHERE id = ? AND state = 'active' AND superseded_at IS NULL
      `).run(newNodeId, oldNodeId);

      // Transfer old node's edges to new node (same as FUSE).
      // Pre-filter: skip edges whose other endpoint is already dormant/superseded.
      const _btSqlS1 = this._bitemporalSqlClause().sql;
      const oldOutEdges = this.db.prepare(`
        SELECT target, edge_type, strength FROM edges
        WHERE source = ? AND state = 'active'${_btSqlS1} AND edge_type != 'supersedes' AND target != ?
          AND target IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
      `).all(oldNodeId, newNodeId);
      for (const edge of oldOutEdges) {
        this.db.prepare(`
          INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
          VALUES (?, ?, ?, ?, 'active', ?,
            COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
        `).run(newNodeId, edge.target, edge.edge_type, edge.strength, new Date().toISOString(), newNodeId, ownerId);
      }
      const oldInEdges = this.db.prepare(`
        SELECT source, edge_type, strength FROM edges
        WHERE target = ? AND state = 'active'${_btSqlS1} AND edge_type != 'supersedes' AND source != ?
          AND source IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
      `).all(oldNodeId, newNodeId);
      for (const edge of oldInEdges) {
        this.db.prepare(`
          INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
          VALUES (?, ?, ?, ?, 'active', ?,
            COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
        `).run(edge.source, newNodeId, edge.edge_type, edge.strength, new Date().toISOString(), edge.source, ownerId);
      }

      // Dormant old node's edges and the node itself
      this.db.prepare(`
        UPDATE edges SET state = 'dormant'
        WHERE (source = ? OR target = ?) AND state = 'active' AND edge_type != 'supersedes'
      `).run(oldNodeId, oldNodeId);
      this.db.prepare(`
        UPDATE nodes SET state = 'dormant' WHERE id = ? AND state = 'active'
      `).run(oldNodeId);

      this._adjCacheVersion++;
      if (shouldOwnTxn) this.db.prepare('COMMIT').run();
    } catch (err) {
      try { if (shouldOwnTxn && this.db.inTransaction) this.db.prepare('ROLLBACK').run(); } catch {}
      console.warn(`[Consolidation] SUPERSEDE apply failed:`, err.message);
    }
  }

  /**
   * Apply TIMELINE_MERGE (A4): Prepend newer node's content into canonical (older) node's L2
   * as a reverse-chronological section. Newer node is dormanted, its edges transferred to
   * canonical. supersedes edge direction matches FUSE/SUPERSEDE convention (newer → canonical).
   */
  _applyTimelineMerge(newer, canonical, newL0, newL1) {
    try {
      const now = new Date().toISOString();
      const pad = (n) => String(n).padStart(2, '0');
      const formatTs = (iso) => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      // Fetch canonical tags + created_at + event_at (not on the candidate object passed to the judge)
      const canonRow = this.db.prepare(
        "SELECT tags, created_at, event_at FROM nodes WHERE id = ? AND state = 'active'"
      ).get(canonical.id);
      if (!canonRow) {
        console.warn(`[Consolidation] TIMELINE_MERGE: canonical ${canonical.id} not active — aborting`);
        return;
      }
      let canonicalTags = [];
      try { canonicalTags = JSON.parse(canonRow.tags || '[]'); if (!Array.isArray(canonicalTags)) canonicalTags = []; } catch { canonicalTags = []; }
      const alreadyMerged = canonicalTags.includes('timeline_merged');
      const canonCreatedAt = canonRow.created_at || canonical.created_at;

      // event_at policy on TIMELINE_MERGE: canonical absorbs newer; preserve the earliest
      // event_at across both so the surviving node represents the true first-appearance age.
      const _earliestIso = (a, b) => {
        const ta = a ? new Date(a).getTime() : NaN;
        const tb = b ? new Date(b).getTime() : NaN;
        if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb ? a : b;
        return Number.isFinite(ta) ? a : (Number.isFinite(tb) ? b : null);
      };
      const mergedEventAt = _earliestIso(canonRow.event_at, newer.event_at);

      // Build new section for the newer node (reverse-chronological: newest on top)
      const newerSection = `## ${formatTs(newer.created_at)} — ${newer.l0 || '(untitled)'}\n\n${(newer.l2 || '').trim()}`;

      // Assemble merged L2
      let mergedL2;
      if (alreadyMerged) {
        // Canonical already sectioned — just prepend
        mergedL2 = `${newerSection}\n\n${(canonical.l2 || '').trim()}`;
      } else {
        // First merge — seed canonical's original body as its own section
        const canonSection = `## ${formatTs(canonCreatedAt)} — ${canonical.l0 || '(untitled)'}\n\n${(canonical.l2 || '').trim()}`;
        mergedL2 = `${newerSection}\n\n${canonSection}`;
      }

      // Enforce caps (Q4=a: 6 sections, 12000 chars)
      mergedL2 = this._enforceTimelineCaps(mergedL2, TIMELINE_MERGE_MAX_SECTIONS, TIMELINE_MERGE_MAX_CHARS);

      // Flag canonical as timeline-merged (idempotent)
      if (!canonicalTags.includes('timeline_merged')) canonicalTags.push('timeline_merged');

      // Judge-rewritten L0/L1 preferred; fall back to canonical if judge omitted them
      const nextL0 = (newL0 && newL0.length > 0) ? newL0 : canonical.l0;
      const nextL1 = (newL1 && newL1.length > 0) ? newL1 : canonical.l1;

      const applyTxn = this.db.transaction(() => {
        const ownerId = this._resolveOwnerStamp();
        this.db.prepare(`
          UPDATE nodes SET l0 = ?, l1 = ?, l2 = ?, tags = ?, accessed_at = ?, updated_at = ?, event_at = COALESCE(?, event_at)
          WHERE id = ? AND state = 'active'
        `).run(nextL0, nextL1, mergedL2, JSON.stringify(canonicalTags), now, now, mergedEventAt, canonical.id);

        // supersedes edge: newer → canonical (consistent with FUSE/SUPERSEDE: newer points to survivor)
        this.db.prepare(`
          INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
          VALUES (?, ?, 'supersedes', 1.0, 'active', ?,
            COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
        `).run(newer.id, canonical.id, now, newer.id, ownerId);

        // Transfer newer's outbound non-supersedes edges to canonical.
        // Pre-filter: skip edges whose other endpoint is already dormant/superseded.
        const _btSqlT1 = this._bitemporalSqlClause().sql;
        const newerOutEdges = this.db.prepare(`
          SELECT target, edge_type, strength FROM edges
          WHERE source = ? AND state = 'active'${_btSqlT1} AND edge_type != 'supersedes' AND target != ?
            AND target IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
        `).all(newer.id, canonical.id);
        for (const edge of newerOutEdges) {
          this.db.prepare(`
            INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
            VALUES (?, ?, ?, ?, 'active', ?,
              COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
          `).run(canonical.id, edge.target, edge.edge_type, edge.strength, now, canonical.id, ownerId);
        }
        // Transfer newer's inbound non-supersedes edges to canonical
        const newerInEdges = this.db.prepare(`
          SELECT source, edge_type, strength FROM edges
          WHERE target = ? AND state = 'active'${_btSqlT1} AND edge_type != 'supersedes' AND source != ?
            AND source IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
        `).all(newer.id, canonical.id);
        for (const edge of newerInEdges) {
          this.db.prepare(`
            INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
            VALUES (?, ?, ?, ?, 'active', ?,
              COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
          `).run(edge.source, canonical.id, edge.edge_type, edge.strength, now, edge.source, ownerId);
        }

        // Dormant newer node's remaining edges
        this.db.prepare(`
          UPDATE edges SET state = 'dormant'
          WHERE (source = ? OR target = ?) AND state = 'active' AND edge_type != 'supersedes'
        `).run(newer.id, newer.id);

        // Dormant newer node and record supersede lineage
        this.db.prepare(`
          UPDATE nodes SET state = 'dormant', superseded_at = ?, deprecated_at = ?, superseded_by = ?
          WHERE id = ? AND state = 'active'
        `).run(now, now, canonical.id, newer.id);
      });
      applyTxn();

      this._adjCacheVersion++;

      // Re-embed canonical since L0/L1 changed (embeds are derived from L0+L1)
      this._reembedNode(canonical.id, nextL0, nextL1).catch(e =>
        console.warn(`[Consolidation] timeline re-embed failed for ${canonical.id}: ${e.message}`)
      );
    } catch (err) {
      console.warn(`[Consolidation] TIMELINE_MERGE apply failed:`, err.message);
    }
  }

  /**
   * Enforce timeline-merge section/char caps. Trims oldest sections first; collapses oldest
   * bodies to their header only before dropping them entirely.
   */
  _enforceTimelineCaps(l2, maxSections, maxChars) {
    if (!l2) return l2;
    // Split on "\n## " boundaries while keeping the "## " prefix on each section
    const parts = l2.split(/\n(?=## )/g).map(s => s.trim()).filter(Boolean);
    let sections = parts;
    if (sections.length > maxSections) {
      sections = sections.slice(0, maxSections);
    }
    let joined = sections.join('\n\n');
    // Char cap: collapse oldest section body → header only, drop entirely if still over
    while (joined.length > maxChars && sections.length > 1) {
      const lastIdx = sections.length - 1;
      const firstLine = sections[lastIdx].split('\n')[0];
      if (sections[lastIdx] !== firstLine + '\n\n...') {
        sections[lastIdx] = firstLine + '\n\n...';
      } else {
        sections.pop();
      }
      joined = sections.join('\n\n');
    }
    return joined;
  }

  /**
   * Re-embed a node (used after TIMELINE_MERGE when L0/L1 change significantly).
   * Fire-and-forget — failures log but don't block.
   */
  async _reembedNode(nodeId, l0, l1) {
    const embedding = await this._embed(`${l0 || ''} ${l1 || ''}`);
    if (!embedding) return;
    const mapping = this.db.prepare('SELECT rowid FROM node_rowids WHERE node_id = ?').get(nodeId);
    if (!mapping) return;
    this.db.prepare('DELETE FROM node_embeddings WHERE id = ?').run(mapping.rowid);
    this.db.prepare('INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)').run(BigInt(mapping.rowid), embedding);
  }

  /**
   * rememberSync — synchronous variant (no embedding generated), used for migration/tests
   */
  /**
   * Check if a very similar node already exists (dedup guard).
   * Uses first 60 chars of l0 as fingerprint + FTS5 search.
   * @param {string} l0 - Title/summary of the node
   * @param {string} l2 - Full content
   * @returns {{ isDuplicate: boolean, existingId: string|null }}
   */
  checkDuplicate(l0, l2) {
    try {
      // Exact l0 match
      const exact = this.db.prepare(
        "SELECT id FROM nodes WHERE l0 = ? AND state = 'active' LIMIT 1"
      ).get(l0);
      if (exact) return { isDuplicate: true, existingId: exact.id };

      // FTS5 fuzzy match: search first 40 chars of l0
      const searchTerm = l0.slice(0, 40).replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
      if (searchTerm.length > 10) {
        const ftsResults = this.db.prepare(
          "SELECT node_id, l0 FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 5"
        ).all(searchTerm);
        for (const r of ftsResults) {
          // Simple Jaccard similarity on words
          const words1 = new Set(l0.toLowerCase().split(/\s+/));
          const words2 = new Set(r.l0.toLowerCase().split(/\s+/));
          const intersection = [...words1].filter(w => words2.has(w)).length;
          const union = new Set([...words1, ...words2]).size;
          if (union > 0 && intersection / union > 0.7) {
            return { isDuplicate: true, existingId: r.node_id };
          }
        }
      }
    } catch { /* FTS not available or other error — allow write */ }
    return { isDuplicate: false, existingId: null };
  }

  rememberSync({ id, l0, l1, l2, tags = [], tone = 'analytical', valence = 0, arousal = 0.5, weight = 1.0, source = 'knowledge', edges = [], skipDedup = false, node_type = null, event_at = null, subkind = null }) {
    tags = this._normalizeTags(tags);
    tags = this._validateTags(id, tags);
    const resolvedType = node_type || this._classifyNodeType(id, tags, l2);
    // Auto-supersedes: if very similar node exists, still write but add supersedes edge
    let autoSupersedesTarget = null;
    if (!skipDedup) {
      const { isDuplicate, existingId } = this.checkDuplicate(l0, l2);
      if (isDuplicate) {
        // NEVER supersede identity/milestone nodes — they are immutable
        const existingType = this.db.prepare("SELECT node_type FROM nodes WHERE id = ?").get(existingId);
        if (existingType?.node_type === 'identity' || existingType?.node_type === 'milestone') {
          console.log(`[Engine] rememberSync: skipping auto-supersedes on immutable ${existingId} (${existingType.node_type})`);
        } else if (!this._isSupersedeAllowed(source, existingId)) {
          console.log(`[Engine] rememberSync: skipping auto-supersedes on user-authored ${existingId} (superseder=${source})`);
        } else {
          autoSupersedesTarget = existingId;
          console.log(`[Engine] rememberSync auto-supersedes: "${l0.slice(0, 40)}..." will supersede ${existingId}`);
          if (!edges.some(e => e.target === existingId && e.type === 'supersedes')) {
            edges = [...edges, { target: existingId, type: 'supersedes', strength: 1.0 }];
          }
        }
      }
    }

    const now = new Date().toISOString();

    // Resolve event_at + subkind: caller wins; else preserve existing row's value; else (event_at) now.
    let resolvedEventAt = event_at;
    let resolvedSubkind = subkind;
    if (!resolvedEventAt || resolvedSubkind === null) {
      const existing = this.db.prepare("SELECT event_at, subkind FROM nodes WHERE id = ?").get(id);
      if (!resolvedEventAt) resolvedEventAt = existing?.event_at || now;
      if (resolvedSubkind === null) resolvedSubkind = existing?.subkind ?? null;
    }

    const ownerId = this._resolveOwnerStamp();

    const insertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (id, state, created_at, accessed_at, l0, l1, l2, tags, tone, valence, arousal, weight, conn_count, access_count, source, node_type, updated_at, owner_id, event_at, subkind)
      VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);

    // Canonical edge types — 5 core + 3 system (04-11 decision: reduced from 17)
    const VALID_EDGE_TYPES = new Set([
      'causal', 'contrastive', 'hierarchical', 'associative', 'temporal',
      // System types (not user-facing)
      'supersedes', 'coactivation', 'collision', 'builds_on',
      // Mímir tension/profile dialectic (master plan §2/§7).
      'resolves', 'contradicts',
    ]);

    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `);

    const _btSqlCC4 = this._bitemporalSqlClause().sql;
    const _validEpCC4 = this._validEdgeEndpointsSql();
    const updateConnCount = this.db.prepare(`
      UPDATE nodes SET conn_count = (
        (SELECT COUNT(*) FROM edges WHERE source = ? AND state = 'active'${_btSqlCC4}${_validEpCC4}) + (SELECT COUNT(*) FROM edges WHERE target = ? AND state = 'active'${_btSqlCC4}${_validEpCC4})
      ), accessed_at = ? WHERE id = ?
    `);

    // Penalize superseded nodes — apply ×0.1 weight penalty
    const penalizeSuperseded = this.db.prepare(`
      UPDATE nodes SET weight = weight * 0.1, superseded_at = datetime('now'), deprecated_at = datetime('now'), superseded_by = ? WHERE id = ? AND state = 'active' AND superseded_at IS NULL
    `);

    const txn = this.db.transaction(() => {
      insertNode.run(id, now, now, l0, l1, l2, JSON.stringify(tags), tone, valence, arousal, weight, edges.length, source, resolvedType, now, ownerId, resolvedEventAt, resolvedSubkind);

      // Re-remember of a node that was previously superseded → revive its edge web.
      this._reactivateNodeEdges(id);

      for (const edge of edges) {
        let edgeType = VALID_EDGE_TYPES.has(edge.type) ? edge.type : 'associative';
        // Master plan §10: downgrade supersedes→contradicts when Mímir targets user-authored.
        if (edgeType === 'supersedes' && !this._isSupersedeAllowed(source, edge.target)) {
          console.log(`[Engine] rememberSync: downgrading supersedes→contradicts for ${edge.target} (superseder=${source})`);
          edgeType = 'contradicts';
        }
        insertEdge.run(id, edge.target, edgeType, edge.strength || 0.5, now, ownerId);
        insertEdge.run(edge.target, id, edgeType, (edge.strength || 0.5) * 0.8, now, ownerId);
        updateConnCount.run(edge.target, edge.target, now, edge.target);
        // Auto-penalize target when supersedes edge is created
        if (edgeType === 'supersedes') {
          penalizeSuperseded.run(id, edge.target);
        }
      }

      updateConnCount.run(id, id, now, id);
    });

    try {
      txn();
    } catch (e) {
      if (e.message && e.message.includes('locked')) {
        // Sync spin-wait + retry (rememberSync is not async)
        const _s = Date.now(); while (Date.now() - _s < 200) { /* busy wait */ }
        try { txn(); } catch { /* give up — Mímir holds lock too long */ }
      } else { throw e; }
    }

    // Sync FTS5 index
    try {
      this.db.prepare("INSERT OR REPLACE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)").run(id, l2, JSON.stringify(tags));
    } catch {}

    // Invalidate adjacency list cache — new edges may have been created
    this._adjCacheVersion++;

    return id;
  }

  /**
   * rememberRaw — raw text → LLM-generated envelope → remember()
   * Input: rawText + optional id/source/existingNodeIds
   * Output: remember() result (node id)
   */
  async rememberRaw(rawText, { id = null, source = 'raw', existingNodeIds = null, tags: explicitTags = null, noFallback = false, edges: callerEdges = [], node_type: callerNodeType = null, event_at = null, subkind = null, imported_batch_id = null, skipSemanticContext = false } = {}) {
    // Get existing node IDs for edge inference (P0 — Route B can skip per-call vec0 lookup)
    if (!existingNodeIds && !skipSemanticContext) {
      // Embed the raw text for semantic search
      const queryEmb = await this._embed(rawText.slice(0, 500));
      const vecResults = this.db.prepare(
        `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 50`
      ).all(queryEmb);
      const rowIdToNode = this.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
      const getNodeL0 = this.db.prepare("SELECT id, l0 FROM nodes WHERE id = ? AND state = 'active'");

      const semanticIds = new Set();
      for (const r of vecResults) {
        const mapping = rowIdToNode.get(r.id);
        if (mapping) {
          const node = getNodeL0.get(mapping.node_id);
          if (node) semanticIds.add(`${node.id}: ${node.l0}`);
        }
      }

      // Always include anchor nodes for edge inference
      const anchors = this.db.prepare(
        `SELECT id, l0 FROM nodes WHERE state = 'active' AND (
          id IN ('kc-core', 'grand-synthesis', 'lineage', 'phoenix-core') OR
          EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'design-principle') OR
          EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'identity')
        )`
      ).all();
      for (const a of anchors) semanticIds.add(`${a.id}: ${a.l0}`);

      existingNodeIds = Array.from(semanticIds);
    }
    if (!existingNodeIds) existingNodeIds = [];

    const envelope = await this._llmGenerateEnvelope(rawText, existingNodeIds, { noFallback });
    if (!envelope) throw new Error('LLM envelope generation failed');
    const rawTextStr = String(rawText || '').trim();
    const normalizedL0 = String(envelope.l0 || '').trim()
      || rawTextStr.split(/\n+/)[0]?.slice(0, 80)
      || `Raw memory ${Date.now()}`;
    const normalizedL1 = String(envelope.l1 || '').trim()
      || rawTextStr.slice(0, 500)
      || normalizedL0;
    const normalizedL2 = String(envelope.l2 || '').trim()
      || rawTextStr
      || normalizedL1;

    // Use LLM-generated id or auto-generate
    const nodeId = id || envelope.id || `raw-${Date.now()}`;

    // Defense: LLM envelope may return tags in any format
    const envelopeTags = this._normalizeTags(envelope.tags);
    // Merge explicit tags (caller-provided) with LLM-generated tags, dedup
    const mergedTags = explicitTags
      ? [...new Set([...this._normalizeTags(explicitTags), ...envelopeTags])]
      : envelopeTags;

    return this.remember({
      id: nodeId,
      l0: normalizedL0,
      l1: normalizedL1,
      l2: normalizedL2,
      tags: mergedTags,
      tone: envelope.tone || 'analytical',
      valence: envelope.valence ?? 0,
      arousal: envelope.arousal ?? 0.5,
      weight: envelope.weight ?? 1.0,
      source,
      node_type: callerNodeType || envelope.node_type || null,
      event_at,
      subkind,
      imported_batch_id,
      edges: [
        ...(envelope.edges || []).map(e => ({
          target: e.target,
          type: e.type || 'associative',
          strength: e.strength ?? 0.5
        })),
        ...(callerEdges || []).map(e => ({
          target: e.target,
          type: e.type || 'supersedes',
          strength: e.strength ?? 1.0
        }))
      ]
    });
  }

  /**
   * Stamp completion of a memory-import batch: writes engine_meta marker
   * and updates `autonomy_seeds.last_bootstrap_completed_at` so the
   * cold-start gate cannot double-fire after a sizable import (P0-3).
   * Idempotent; safe to call multiple times for the same batch_id.
   */
  _writeImportBatchMeta({ batch_id, route, file_count, ts = Date.now() } = {}) {
    if (!batch_id) return false;
    try {
      this._writeEngineMetaText(`import_batch:${batch_id}`, JSON.stringify({
        batch_id, route: route || 'A', file_count: file_count || 0, ts,
      }));
    } catch (e) {
      console.warn('[Import] _writeImportBatchMeta meta write failed:', e.message);
    }
    try {
      const seeds = this._loadAutonomySeeds() || {
        tags: [], freetext: '', captured_at: null, llm_extracted_at: null,
        llm_topics: [], exhausted_seeds: [], last_bootstrap_completed_at: null,
      };
      seeds.last_bootstrap_completed_at = ts;
      this._writeAutonomySeeds(seeds);
    } catch (e) {
      console.warn('[Import] last_bootstrap_completed_at stamp failed:', e.message);
    }
    try {
      this._writePulseHint('import_batch_done', { batch_id, route, file_count });
    } catch {}
    return true;
  }

  /**
   * Persist + broadcast an unprompted assistant message (alignment reflection,
   * etc.). Steps:
   *   1. Write a `milestone` node tagged `alignment_reflection` + `imported`,
   *      stamped with `imported_batch_id='reflection-<batch_id>'` so SA pool
   *      soft-suppresses until access≥5.
   *   2. Emit `chat:assistant_message` on liveBus for the dashboard chat tab.
   *   3. Optionally enqueue into chat feed store and Telegram (when wired by
   *      main.js via `_coldStart.chatFeedEnqueue` / `_coldStart.telegramSend`).
   * Returns `{ node_id, broadcasted, telegram }`.
   */
  async injectAssistantMessage({ text, source = 'assistant_inject', batch_id = null } = {}) {
    if (!text || typeof text !== 'string') {
      throw new Error('injectAssistantMessage: text required');
    }
    const ts = Date.now();
    const tag = batch_id ? String(batch_id) : `inject-${ts}`;
    const nodeId = `alignment-reflection-${tag}`;
    const reflectBatch = `reflection-${tag}`;
    const trimmed = text.length > 8000 ? text.slice(0, 8000) : text;

    let nodePersisted = false;
    try {
      await this.remember({
        id: nodeId,
        l0: trimmed.slice(0, 80),
        l1: trimmed,
        l2: trimmed,
        tags: ['alignment_reflection', 'imported'],
        tone: 'analytical',
        source,
        node_type: 'milestone',
        skipDedup: true,
        imported_batch_id: reflectBatch,
      });
      nodePersisted = true;
    } catch (e) {
      console.warn('[Inject] node persist failed:', e.message);
    }

    let broadcasted = false;
    try {
      if (liveBus && typeof liveBus.safeEmit === 'function') {
        liveBus.safeEmit('chat:assistant_message', {
          role: 'assistant',
          text: trimmed,
          source,
          batch_id: batch_id || null,
          ts,
        });
        broadcasted = true;
      }
    } catch (e) {
      console.warn('[Inject] live-bus emit failed:', e.message);
    }

    try {
      if (typeof this._coldStart?.chatFeedEnqueue === 'function') {
        await this._coldStart.chatFeedEnqueue({
          text: trimmed,
          source,
          batch_id: batch_id || null,
        });
      }
    } catch (e) {
      console.warn('[Inject] chat feed enqueue failed:', e.message);
    }

    let telegram = false;
    try {
      if (typeof this._coldStart?.telegramSend === 'function') {
        const sent = await this._coldStart.telegramSend({ text: trimmed });
        telegram = !!sent;
      }
    } catch (e) {
      console.warn('[Inject] telegram send failed:', e.message);
    }

    return { node_id: nodePersisted ? nodeId : null, broadcasted, telegram };
  }

  /**
   * draftSoulCore — read recent imported nodes for a batch, ask the LLM
   * to summarize them into 4 first-person Soul Core segments. Returns
   * { ok, segments: { name, values, direction, relationship } } or
   * { ok: false, error }. Caller persists via saveSoulCore.
   */
  async draftSoulCore(batchId, _opts = {}) {
    if (!batchId) return { ok: false, error: 'batch_id_required' };
    let nodes = [];
    try {
      nodes = this.db.prepare(`
        SELECT id, l0, l1, l2, tags, node_type
        FROM nodes
        WHERE imported_batch_id = ?
        ORDER BY created_at DESC
        LIMIT 80
      `).all(String(batchId));
    } catch (e) {
      return { ok: false, error: 'db_read_failed: ' + e.message };
    }
    if (!nodes.length) return { ok: false, error: 'no_imported_nodes' };

    const lines = [];
    let budget = 6000;
    for (const n of nodes) {
      const tail = n.l1 ? ' — ' + String(n.l1).slice(0, 140) : '';
      const line = `- [${n.node_type || 'note'}] ${(n.l0 || '').slice(0, 100)}${tail}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }

    const systemPrompt = `You are helping a person refine their "Soul Core" — a 4-segment first-person self-description used to align an AI agent with who they are. Read the notes below and produce a JSON draft. Each field 1-3 sentences, written in the user's voice ("I…"). Stay grounded in the source material; do not invent biography.`;
    const userPrompt = `NOTES:
${lines.join('\n')}

Produce JSON only (no markdown, no commentary):
{
  "name": "Who you are — background, role, identity",
  "values": "What you value — core principles, motivations",
  "direction": "Where you're going — current goals, projects, vision",
  "relationship": "How you want to be known — interpersonal style, what you offer"
}`;

    let content = '';
    try {
      if (LLM_PROVIDER === 'anthropic') {
        const r = await fetch(`${LLM_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': LLM_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: LLM_MODEL,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.4,
            max_tokens: 1200,
          }),
        });
        if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
        const data = await r.json();
        content = (data.content?.[0]?.text || '').trim();
      } else {
        const r = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.4,
            max_tokens: 1200,
          }),
        });
        if (!r.ok) throw new Error(`LLM API ${r.status}: ${await r.text()}`);
        const data = await r.json();
        content = (data.choices?.[0]?.message?.content || '').trim();
      }
    } catch (e) {
      return { ok: false, error: 'llm_call_failed: ' + e.message };
    }

    let parsed;
    try {
      const m = content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : content);
    } catch (e) {
      return { ok: false, error: 'parse_failed', raw: String(content).slice(0, 400) };
    }

    const segments = {
      name:         String(parsed.name         || '').trim().slice(0, 1200),
      values:       String(parsed.values       || '').trim().slice(0, 1200),
      direction:    String(parsed.direction    || '').trim().slice(0, 1200),
      relationship: String(parsed.relationship || '').trim().slice(0, 1200),
    };
    return { ok: true, segments };
  }

  /**
   * saveSoulCore — persist 4 refined Soul Core segments as full-weight
   * `soul-core` nodes (NO imported_batch_id, so no SA-pool soft-suppression).
   * Batch lineage tracked via the `from-batch:<id>` tag for queryability.
   */
  async saveSoulCore({ batch_id = null, segments = {} } = {}) {
    const keys = ['name', 'values', 'direction', 'relationship'];
    const labels = {
      name: 'Who you are',
      values: 'What you value',
      direction: 'Where you\'re going',
      relationship: 'How you want to be known',
    };
    const written = [];
    const failed = [];
    for (const k of keys) {
      const text = String((segments && segments[k]) || '').trim();
      if (!text) continue;
      const id = `soul-core-refined-${k}`;
      const tags = ['soul-core', 'soul-core-refined', 'identity', k];
      if (batch_id) tags.push(`from-batch:${String(batch_id).slice(0, 60)}`);
      try {
        await this.remember({
          id,
          l0: `Soul Core (${labels[k]}): ${text.slice(0, 60)}`,
          l1: text.slice(0, 600),
          l2: text,
          tags,
          tone: 'foundational',
          source: 'soul_core_refine',
          node_type: 'identity',
          skipDedup: true,
        });
        written.push(k);
      } catch (e) {
        console.warn('[SoulCore] save failed for', k, e.message);
        failed.push({ key: k, error: e.message });
      }
    }
    return { ok: true, written, failed, count: written.length };
  }

  /**
   * _fallbackEnvelope — heuristic envelope when LLM is unavailable
   */
  _fallbackEnvelope(rawText, existingNodeIds = []) {
    const sentences = rawText.split(/[.!?。！？]+/).map(s => s.trim()).filter(s => s.length > 5);
    const l0 = (sentences[0] || rawText).slice(0, 80);
    const l1 = sentences.slice(0, 3).join('. ').slice(0, 300);
    const l2 = rawText.slice(0, 1200);

    // Extract simple tags from frequent meaningful words
    const words = rawText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const freq = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    const stopwords = new Set(['this','that','with','from','have','been','were','they','their','than','these','those','which','would','could','should','about','after','before','between','through','being','other','into','some','also','more','most','such','each','only','when','where','what']);
    const tags = Object.entries(freq)
      .filter(([w]) => !stopwords.has(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    // Edge inference: check word/token overlap between raw text and existing nodes
    const edges = [];
    const textLower = rawText.toLowerCase();
    for (const line of existingNodeIds) {
      const [nodeId, ...descParts] = line.split(': ');
      const nid = nodeId.trim();
      const desc = descParts.join(': ').toLowerCase();
      
      // Extract tokens from both node ID (split on -) and description
      const idTokens = nid.toLowerCase().split('-').filter(t => t.length >= 2);
      const descTokens = (desc.match(/[a-z]{2,}/gi) || []).map(w => w.toLowerCase());
      // Also include CJK characters as individual tokens for Chinese text
      const allTokens = [...new Set([...idTokens, ...descTokens])].filter(w => !stopwords.has(w));
      
      // Count how many tokens appear in raw text
      const idMatches = idTokens.filter(w => textLower.includes(w));
      const allMatches = allTokens.filter(w => textLower.includes(w));
      
      // Connect if: ≥2 total matches, OR any meaningful ID token matches (domain-specific like 'kc', 'gesell', 'ai')
      const idHit = idMatches.some(w => w.length >= 2 && textLower.includes(w));
      if (allMatches.length >= 2 || (idHit && allMatches.length >= 1)) {
        edges.push({ target: nid, type: 'associative', strength: Math.min(0.9, 0.3 + allMatches.length * 0.1) });
      }
    }

    return {
      id: `node-${Date.now()}`,
      l0, l1, l2, tags,
      tone: 'analytical', valence: 0, arousal: 0.5, weight: 0.7,
      edges
    };
  }

  /**
   * _llmGenerateEnvelope — call LLM to structure raw text into envelope format
   * Falls back to heuristic if LLM unavailable (unless noFallback=true)
   */
  async _llmGenerateEnvelope(rawText, existingNodeIds = [], { noFallback = false } = {}) {
    const existingNodesStr = existingNodeIds.length > 0
      ? existingNodeIds.slice(0, 50).join('\n')
      : '(none yet)';

    const systemPrompt = `You are a memory structuring engine. Given raw text, produce a JSON envelope for a knowledge graph node.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "id": "kebab-case-id (3-5 words, unique, descriptive)",
  "l0": "≤15 words: compressed headline (ALWAYS natural language — this is the SA embedding anchor)",
  "l1": "30-80 words: key relationships + context (or type-specific summary — see BODY FORMAT below)",
  "l2": "100-500 words: full detail (or type-specific structured body — see BODY FORMAT below)",
  "tags": ["tag1", "tag2", ...],
  "tone": "analytical|narrative|emotional|foundational",
  "valence": -1.0 to 1.0 (negative=threat, positive=opportunity),
  "arousal": 0.0 to 1.0 (calm to urgent),
  "weight": 0.1 to 1.0 (importance),
  "node_type": "knowledge|identity|milestone|diary|social-rule|language-template|principle|conversation-insight|decision|theory|general-knowledge|engineering|experiment|observation|relationship|action|reading-note|introspection",
  "edges": [{"target": "existing-node-id", "type": "EDGE_TYPE", "strength": 0.1-1.0}]
}

NODE TYPES & BODY FORMAT (choose the most specific type, then follow its body format for L1/L2):

— IMMUTABLE LAYER (never fuse, never supersede):
  identity: Core identity definitions. Standard L1/L2.
  milestone: Irreversible historical events. Standard L1/L2.

— META-COGNITIVE LAYER (low-frequency revision only):
  principle: Design principles, behavioral rules. L2 should include: rule, rationale, scope, exceptions.
  decision: Architectural/strategy decisions. L2 should include: choice, alternatives, rationale, tradeoffs.

— BEHAVIORAL LAYER (high fusion threshold):
  social-rule: Social norms, etiquette, interaction rules. Standard L1/L2.
  language-template: Linguistic patterns, expression templates. Standard L1/L2.

— KNOWLEDGE LAYER (split from old "knowledge"):
  theory: Theoretical frameworks, academic concepts. L1=summary, L2=detailed exposition with source/confidence.
  general-knowledge: Factual knowledge, history, science. Standard L1/L2. Very stable, rarely updated.
  engineering: Bug fixes, deployments, architecture changes. L2 should include: problem, root_cause, solution, verification, status(fixed|partial|reverted).
  experiment: Benchmarks, A/B tests, SA experiments. L2 should include: hypothesis, method, result, conclusion, status(success|failure|partial|inconclusive).
  reading-note: Book notes, paper summaries. L1=summary, L2=detailed notes with source reference.
  observation: External information, news analysis. L2 should include: source, observed_at, content, analysis, shelf_life(days|weeks|months|permanent).

— MEMORY LAYER (time-sensitive):
  conversation-insight: Insights from conversations. Standard L1/L2.
  introspection: Self-reflection, cognitive state analysis. L2 should include: trigger, observation, analysis, implication.
  diary: Daily logs, multi-topic entries. Standard L1/L2.

— RELATIONSHIP LAYER (never create duplicates, update in-place):
  relationship: Person profiles. L2 should include: name, relation, interests, communication_style, trust_level, interaction_history, notes.

— PROCEDURAL LAYER (action/skill memory):
  action: Operational skills, SOPs, troubleshooting procedures. L2 should include: trigger, steps (ordered), expected_outcome, fallback.

  Default: "knowledge" if no specific type matches.

EDGE TYPES (5 core types — pick the closest match):
- causal: A causes or leads to B (includes: supports, contradicts, requires)
- contrastive: A and B are opposing or contrasting perspectives
- hierarchical: A is a parent/child or general/specific of B (includes: exemplifies, implements)
- associative: A and B are related but in a non-directional way (includes: bridges, parallels, contextualizes)
- temporal: A and B are linked by time sequence (before/after/during)
RULES:
- L0 must be self-contained (understandable without L1/L2) — ALWAYS natural language, never structured
- L1 is for mid-range context injection
- L2 is for deep recall when this node is focal — use type-specific structure when applicable
- VOICE: Preserve the original perspective from the raw text. If the source is self-referential (session debrief, inbox), use first-person "I" — never "the system" or "the assistant". Write as the AI remembering its own experience.
- FIDELITY: Only include information explicitly present in the raw text. Never infer, extrapolate, or fill in missing context. If the raw text is sparse, the node should be sparse too.
- LANGUAGE: Match the language of the raw text. If input is Chinese, output Chinese. If English, output English. Never duplicate content across languages.
- Tags: 2-6 tags, lowercase, semantic categories
- Edges: only connect to EXISTING nodes listed below. 0 edges is fine if nothing connects.
- Edge type: Always pick the most specific type from the 5 types above. If unsure, "associative" is a safe default.
- Output ONLY valid JSON. No explanation, no markdown fences.`;

    const user = `EXISTING NODES:
${existingNodesStr}

RAW TEXT TO STRUCTURE:
${rawText}`;

    try {
      let content;
      if (LLM_PROVIDER === 'anthropic') {
        const response = await fetch(`${LLM_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': LLM_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: LLM_MODEL,
            system: systemPrompt,
            messages: [{ role: 'user', content: user }],
            temperature: 0.0,
            max_tokens: 1500
          })
        });
        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Anthropic API ${response.status}: ${err}`);
        }
        const data = await response.json();
        content = data.content?.[0]?.text?.trim();
      } else {
        const response = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
          body: JSON.stringify({
            model: LLM_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: user }
            ],
            temperature: 0.0,
            max_tokens: 1500
          })
        });
        if (!response.ok) {
          const err = await response.text();
          throw new Error(`LLM API ${response.status}: ${err}`);
        }
        const data = await response.json();
        content = data.choices?.[0]?.message?.content?.trim();
      }
      if (!content) throw new Error('Empty LLM response');

      // Strip markdown fences if present
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
      // Strip <think> blocks if present (Qwen3 thinking)
      content = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();

      const jsonText = extractFirstJsonObject(content) || content;
      return JSON.parse(jsonText);
    } catch (e) {
      if (noFallback) {
        throw new Error(`LLM envelope generation failed (noFallback): ${e.message}`);
      }
      console.error('LLM envelope generation failed:', e.message, '— using heuristic fallback');
      return this._fallbackEnvelope(rawText, existingNodeIds);
    }
  }

  /**
   * render — O(K) nonlinear read + vector semantic search
   * R8: three-route retrieval fusion (ID/tag → text → vector) + score normalization
   */
  async render(focus, { budget = 2000, maxDepth = 3, useVector = true, maxL2 = Infinity } = {}) {
    // Lazy-load narrative-ir for type-aware rendering
    if (!this._renderNodeFn) {
      try {
        const nirModule = await import('./src/narrative-ir.js');
        this._renderNodeFn = nirModule.renderNode;
      } catch (e) {
        console.warn('[Engine] narrative-ir.js load failed, using legacy rendering:', e.message);
        this._renderNodeFn = null;
      }
    }
    const focusTerms = Array.isArray(focus) ? focus : [focus];

    // === Route 1: ID + Tag match ===
    const byId = this.db.prepare("SELECT * FROM nodes WHERE id = ? AND state = 'active'");
    const byTag = this.db.prepare(`SELECT * FROM nodes WHERE state = 'active' AND EXISTS (
      SELECT 1 FROM json_each(tags) WHERE json_each.value = ?
    )`);
    const byTagPrefix = this.db.prepare(`SELECT * FROM nodes WHERE state = 'active' AND EXISTS (
      SELECT 1 FROM json_each(tags) WHERE json_each.value LIKE ? || '%'
    )`);
    const byText = this.db.prepare(`SELECT * FROM nodes WHERE state = 'active' AND (l0 LIKE ? OR l1 LIKE ?)`);

    let seedNodes = [];
    for (const term of focusTerms) {
      let found = this._filterByOwner(byId.get(term));
      if (found) { seedNodes.push(found); continue; }
      // Exact tag match first
      let tagHits = this._filterByOwner(byTag.all(term));
      if (tagHits.length) { seedNodes.push(...tagHits); continue; }
      // Prefix tag match fallback (e.g. "conscious" matches "consciousness")
      let prefixHits = this._filterByOwner(byTagPrefix.all(term.toLowerCase()));
      if (prefixHits.length) { seedNodes.push(...prefixHits); continue; }
      // Split multi-word queries into individual tag matches with hit counting
      const words = term.split(/[\s,+]+/).filter(w => w.length > 1);
      if (words.length > 1) {
        const hitCount = new Map(); // id -> { node, count }
        for (const word of words) {
          // Try exact then prefix for each word
          let hits = this._filterByOwner(byTag.all(word.toLowerCase()));
          if (!hits.length) hits = this._filterByOwner(byTagPrefix.all(word.toLowerCase()));
          for (const hit of hits) {
            const existing = hitCount.get(hit.id);
            if (existing) existing.count++;
            else hitCount.set(hit.id, { node: hit, count: 1 });
          }
        }
        // Sort by hit count descending (nodes matching more query words first)
        const sorted = [...hitCount.values()].sort((a, b) => b.count - a.count);
        seedNodes.push(...sorted.map(s => ({ ...s.node, _tagHits: s.count })));
      }
      // Text search fallback — truncate long terms to avoid SQLite LIKE pattern complexity limits
      const likeTerm = term.length > 200 ? term.slice(0, 200) : term;
      let textHits = this._filterByOwner(byText.all(`%${likeTerm}%`, `%${likeTerm}%`));
      seedNodes.push(...textHits);
    }

    // === Route 2: vector semantic search ===
    let vectorHits = [];
    if (useVector && this._hasVecData()) {
      try {
        const queryText = focusTerms.join(' ');
        const queryVec = await this._embed(queryText);
        // vec0 requires LIMIT directly on the virtual table query, no JOIN
        const rawVec = this.db.prepare(`
          SELECT id, distance FROM node_embeddings
          WHERE embedding MATCH ?
          ORDER BY distance LIMIT 10
        `).all(queryVec);

        // Map rowid back to node_id
        const getNodeId = this.db.prepare('SELECT node_id FROM node_rowids WHERE rowid = ?');
        const vecResults = rawVec.map(v => {
          const r = getNodeId.get(v.id);
          return r ? { node_id: r.node_id, distance: v.distance } : null;
        }).filter(Boolean);

        const VEC_DIST_THRESHOLD = 1.10; // BGE-M3 1024-dim calibrated 2026-04-11 (cosine ~0.39, captures "related" nodes)
        for (const vr of vecResults) {
          if (vr.distance > VEC_DIST_THRESHOLD) continue;
          const node = this._filterByOwner(byId.get(vr.node_id));
          if (node) {
            vectorHits.push({ ...node, _vecDist: vr.distance });
          }
        }
      } catch (e) {
        // Vector search failed, continue with text-based
      }
    }

    // === Fusion dedup + multi-hit ranking ===
    const seedMap = new Map(); // id -> { node, score }
    for (const n of [...seedNodes, ...vectorHits]) {
      const existing = seedMap.get(n.id);
      const hitBonus = n._tagHits || 1;
      // Vector distance normalized to 0-1 (BGE-M3 1024-dim: dist 0.49→1.0, dist 1.10→0.0)
      const vecBonus = n._vecDist ? Math.max(0, (1.10 - n._vecDist) / 0.61) : 0;
      const score = hitBonus + vecBonus;
      if (existing) {
        existing.score += score;
      } else {
        seedMap.set(n.id, { node: n, score });
      }
    }
    const MAX_SEEDS = 40; // cap seed count to prevent BFS explosion at scale
    const allSeeds = [...seedMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEEDS)
      .map(s => s.node);

    if (allSeeds.length === 0) {
      return { focus, nodes: [], edges: [], stats: { total_nodes: this._count(), rendered: 0, tokens: 0, budget }, text: '(No matching nodes found)' };
    }

    // === Weighted BFS spread (Unified Multi-Source Dijkstra) ===
    // Optimization: instead of running independent BFS per seed (redundant traversal),
    // run a single multi-source Dijkstra from ALL seeds simultaneously.
    // Each node is visited exactly once → O(V+E) instead of O(seeds × V × E).
    // Distance = sum of (1 - strength) along the path. Strong edges (0.9) add 0.1; weak edges (0.1) add 0.9.
    // Weak edges (strength < 0.2) are pruned (no further spread). Bidirectional: forward + reverse edges.
    const DIST_CUTOFF = maxDepth; // max weighted distance (equivalent to the old maxDepth hop count)

    const nodeMap = new Map();

    // Build seed score map for priority
    const seedScores = new Map();
    for (const [id, { score }] of seedMap) seedScores.set(id, score);

    // Phase 1: Build in-memory adjacency list (cached — rebuilt only on TTL expiry or version bump)
    const _adjStart = Date.now();
    const now_adj = Date.now();
    const ADJ_TTL_MS = 60 * 1000; // 60-second TTL
    const _adjOwnerKey = this._ownerScopeOn() ? this._activeOwner() : '*';
    if (
      !this._adjCache ||
      (now_adj - this._adjCache.timestamp) > ADJ_TTL_MS ||
      this._adjCache.version !== this._adjCacheVersion ||
      this._adjCache.ownerKey !== _adjOwnerKey
    ) {
      const adjList = new Map(); // node_id -> [{next_id, strength}, ...]
      const { sql: _ownSql, params: _ownParams } = this._ownerSqlClause();
      const { sql: _btSql } = this._bitemporalSqlClause();
      // NOT INDEXED: this is a full-graph batch load. Without a hint the planner
      // used to pick idx_edges_state_strength and do a disguised full scan plus
      // row-lookups — slower than just scanning the table directly.
      const allEdges = this.db.prepare(
        `SELECT source, target, strength FROM edges NOT INDEXED WHERE state = 'active'${_btSql} AND strength >= 0.2${_ownSql}`
      ).all(..._ownParams);
      for (const e of allEdges) {
        // Bidirectional: add both directions
        if (!adjList.has(e.source)) adjList.set(e.source, []);
        adjList.get(e.source).push({ next_id: e.target, strength: e.strength });
        if (!adjList.has(e.target)) adjList.set(e.target, []);
        adjList.get(e.target).push({ next_id: e.source, strength: e.strength });
      }
      // Cap superhub edges (>200 neighbors) — keep strongest
      for (const [id, neighbors] of adjList) {
        if (neighbors.length > 200) {
          neighbors.sort((a, b) => (b.strength || 0.5) - (a.strength || 0.5));
          adjList.set(id, neighbors.slice(0, 200));
        }
      }
      this._adjCache = { adjList, timestamp: now_adj, version: this._adjCacheVersion, ownerKey: _adjOwnerKey };
    }
    const adjList = this._adjCache.adjList;
    const _adjMs = Date.now() - _adjStart;

    // Phase 2: Unified multi-source Dijkstra (binary min-heap)
    const MAX_VISITED = 3000;    // global limit — scaled up for 5K-10K topology
    const BFS_TIMEOUT_MS = 5000; // single global timeout (was 3000ms per seed)

    const _bfsRenderStart = Date.now();

    // Binary min-heap for O(log N) extract-min (replaces O(N) linear scan)
    const heap = [];
    const _heapPush = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent].dist <= heap[i].dist) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const _heapPop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        while (true) {
          let smallest = i;
          const l = 2 * i + 1, r = 2 * i + 2;
          if (l < heap.length && heap[l].dist < heap[smallest].dist) smallest = l;
          if (r < heap.length && heap[r].dist < heap[smallest].dist) smallest = r;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
          i = smallest;
        }
      }
      return top;
    };

    // Initialize priority queue with ALL seeds at distance 0
    const visited = new Map(); // id -> best distance
    for (const seed of allSeeds) {
      visited.set(seed.id, 0);
      _heapPush({ id: seed.id, dist: 0 });
      const seedScore = seedScores.get(seed.id) || 0;
      nodeMap.set(seed.id, { distance: 0, seedScore });
    }

    let _limitHit = false;
    while (heap.length > 0) {
      // Safety: max visited nodes
      if (visited.size >= MAX_VISITED) {
        _limitHit = true;
        break;
      }
      // Safety: timeout
      if (Date.now() - _bfsRenderStart > BFS_TIMEOUT_MS) {
        _limitHit = true;
        break;
      }

      const current = _heapPop();
      if (current.dist > visited.get(current.id)) continue; // stale entry

      const neighbors = adjList.get(current.id) || [];
      for (const edge of neighbors) {
        const edgeCost = 1 - (edge.strength || 0.5);
        const newDist = current.dist + edgeCost;
        if (newDist > DIST_CUTOFF) continue;
        const prevDist = visited.get(edge.next_id);
        if (prevDist === undefined || newDist < prevDist) {
          visited.set(edge.next_id, newDist);
          _heapPush({ id: edge.next_id, dist: newDist });
          // Update nodeMap
          const seedScore = seedScores.get(edge.next_id) || 0;
          const existing = nodeMap.get(edge.next_id);
          if (!existing || newDist < existing.distance) {
            nodeMap.set(edge.next_id, { distance: newDist, seedScore: Math.max(seedScore, existing?.seedScore || 0) });
          }
        }
      }
    }
    if (global.TIMING_LOGS) console.log(`[BFS] render done: ${nodeMap.size} nodes, adj=${_adjMs}ms, bfs=${Date.now() - _bfsRenderStart}ms, limit=${_limitHit}`);

    // === Fetch nodes + multi-resolution ===
    const NOISE_SOURCES = new Set(['scribe-conversation', 'auto-session', 'session-log']);
    const constellation = [];

    // Batch-fetch all nodes at once (100 per query) instead of one query per node
    const nodeIds = Array.from(nodeMap.keys());
    const fetchedNodes = new Map();
    for (let i = 0; i < nodeIds.length; i += 100) {
      const batch = nodeIds.slice(i, i + 100);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this._filterByOwner(this.db.prepare(
        `SELECT * FROM nodes WHERE id IN (${placeholders}) AND state = 'active'`
      ).all(...batch));
      for (const row of rows) fetchedNodes.set(row.id, row);
    }

    for (const [id, meta] of nodeMap) {
      const node = fetchedNodes.get(id);
      if (!node) continue;
      if (NOISE_SOURCES.has(node.source)) continue;

      const d = meta.distance;
      const weightBoost = node.weight;
      const seedBoost = meta.seedScore || 0;
      const normalizedDist = Math.min(1, d / DIST_CUTOFF) / Math.max(0.1, weightBoost + seedBoost);

      let level, content;
      if (normalizedDist < 0.3) { level = 'L2'; content = node.l2; }
      else if (normalizedDist < 0.6) { level = 'L1'; content = node.l1; }
      else { level = 'L0'; content = node.l0; }

      constellation.push({ id, level, distance: normalizedDist, content, tags: node.tags, _seedScore: meta.seedScore || 0, l0: node.l0, l1: node.l1, l2: node.l2, node_type: node.node_type });
    }

    // Sort by distance ascending, then by seedScore descending for ties
    constellation.sort((a, b) => {
      const dDiff = a.distance - b.distance;
      if (Math.abs(dDiff) > 0.0001) return dDiff;
      return b._seedScore - a._seedScore;
    });

    // === maxL2 limit: excess L2 nodes downgraded to L1 ===
    if (maxL2 < Infinity) {
      let l2Count = 0;
      for (const node of constellation) {
        if (node.level === 'L2') {
          l2Count++;
          if (l2Count > maxL2) {
            node.level = 'L1';
            const fullNode = fetchedNodes.get(node.id);
            if (fullNode) node.content = fullNode.l1;
          }
        }
      }
    }

    // === R9: multi-hop path pre-scan — DISABLED ===
    // _pathPreScan causes exponential blowup in dense graphs (30s+ sync CPU time).
    // The BFS allows re-enqueuing with better pathWeight → O(edges^hops) paths.
    // With 34K edges and 7 hops, this freezes the event loop for 30+ seconds.
    // Airdrop anchors are non-critical enrichment — safe to skip.
    const mainBudget = budget;

    // === Token budget pruning (main nodes use mainBudget) ===
    let totalTokens = 0;
    const rendered = [];
    for (const node of constellation) {
      const tokens = Math.ceil(node.content.length / 3.8);
      if (totalTokens + tokens > mainBudget) break;
      totalTokens += tokens;
      rendered.push(node);
    }

    // (R9 airdrop scan disabled — see above)

    // === Render edges ===
    const renderedIds = new Set(rendered.map(n => n.id));
    const { sql: _ownSqlR, params: _ownPR } = this._ownerSqlClause();
    const { sql: _btSqlR } = this._bitemporalSqlClause();
    const getEdges = this.db.prepare(`SELECT * FROM edges INDEXED BY idx_edges_source WHERE source = ? AND state = 'active'${_btSqlR}${_ownSqlR}`);
    const renderedEdges = [];
    for (const node of rendered) {
      const nodeEdges = getEdges.all(node.id, ..._ownPR);
      for (const e of nodeEdges) {
        if (renderedIds.has(e.target)) {
          renderedEdges.push({ from: e.source, to: e.target, type: e.edge_type, strength: e.strength });
        }
      }
    }

    // render() reads topology only. access_count + Hebb writes are buffered and flushed
    // out-of-band by _flushAccessBumps (30s) and Mímir hebb_writeback (60s) to avoid the
    // 90-142s buildSP lock contention that synchronous writes caused.
    for (const node of rendered) {
      this._accessBumps.set(node.id, (this._accessBumps.get(node.id) || 0) + 1);
    }

    let text = this._renderText(rendered, renderedEdges, focus, this._renderNodeFn);
    // Post-render budget enforcement: _renderText adds formatting overhead not counted in budget
    const textTokens = Math.ceil(text.length / 3.8);
    if (textTokens > budget) {
      const charLimit = Math.floor((budget - 10) * 3.8); // -10 for truncation marker
      text = text.slice(0, charLimit) + '\n\n[...truncated to budget]';
    }

    return {
      focus,
      nodes: rendered,
      edges: renderedEdges,
      stats: { total_nodes: this._count(), rendered: rendered.length, tokens: Math.min(textTokens, budget), budget },
      text
    };
  }

  /**
   * Flush buffered access_count increments in one transaction.
   * Called every 30s by interval timer. Non-blocking, retries silently on lock.
   */
  _flushAccessBumps() {
    if (this._accessBumps.size === 0) return;
    const bumps = Array.from(this._accessBumps.entries());
    this._accessBumps.clear();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE nodes SET access_count = access_count + ?, accessed_at = ?, weight = MIN(weight + (? * 0.02), 2.0) WHERE id = ?'
    );
    try {
      const tx = this.db.transaction(() => {
        for (const [id, count] of bumps) stmt.run(count, now, count, id);
      });
      tx();
      console.log(`[Engine] access_count flush: ${bumps.length} nodes bumped`);
      if (liveBus) liveBus.safeEmit('engine.accessFlush', { nodes: bumps.length });
    } catch (e) {
      // Re-queue on lock failure so we don't lose increments
      for (const [id, count] of bumps) {
        this._accessBumps.set(id, (this._accessBumps.get(id) || 0) + count);
      }
      console.warn(`[Engine] access_count flush deferred: ${e.message}`);
    }
  }

  /**
   * renderSync — synchronous variant (no vector search), used for tests
   */
  renderSync(focus, { budget = 2000, maxDepth = 3, maxL2 = Infinity } = {}) {
    const focusTerms = Array.isArray(focus) ? focus : [focus];

    const byId = this.db.prepare("SELECT * FROM nodes WHERE id = ? AND state = 'active'");
    const byTag = this.db.prepare(`SELECT * FROM nodes WHERE state = 'active' AND EXISTS (
      SELECT 1 FROM json_each(tags) WHERE json_each.value = ?
    )`);
    const byText = this.db.prepare(`SELECT * FROM nodes WHERE state = 'active' AND (l0 LIKE ? OR l1 LIKE ?)`);

    let seedNodes = [];
    for (const term of focusTerms) {
      let found = this._filterByOwner(byId.get(term));
      if (found) { seedNodes.push(found); continue; }
      let tagHits = this._filterByOwner(byTag.all(term));
      if (tagHits.length) { seedNodes.push(...tagHits); continue; }
      const likeTermSync = term.length > 200 ? term.slice(0, 200) : term;
      let textHits = this._filterByOwner(byText.all(`%${likeTermSync}%`, `%${likeTermSync}%`));
      seedNodes.push(...textHits);
    }

    const seen = new Set();
    seedNodes = seedNodes.filter(n => { if (seen.has(n.id)) return false; seen.add(n.id); return true; });
    if (seedNodes.length > 40) seedNodes = seedNodes.slice(0, 40); // cap seeds for BFS performance

    if (seedNodes.length === 0) {
      return { focus, nodes: [], edges: [], stats: { total_nodes: this._count(), rendered: 0, tokens: 0, budget }, text: '(No matching nodes found)' };
    }

    // Weighted BFS (sync version, bidirectional)
    const { sql: _ownSqlSync, params: _ownPSync } = this._ownerSqlClause();
    const { sql: _btSqlSync } = this._bitemporalSqlClause();
    // INDEXED BY: pin source/target indexes. Without sqlite_stat1 the planner
    // picks idx_edges_state_strength (37x slower per query at 187K edges).
    const getOutEdgesSync = this.db.prepare(
      `SELECT target AS next_id, strength FROM edges INDEXED BY idx_edges_source WHERE source = ? AND state = 'active'${_btSqlSync} AND strength >= 0.2${_ownSqlSync}
       UNION ALL
       SELECT source AS next_id, strength FROM edges INDEXED BY idx_edges_target WHERE target = ? AND state = 'active'${_btSqlSync} AND strength >= 0.2${_ownSqlSync}`
    );
    const DIST_CUTOFF_SYNC = maxDepth;

    const nodeMap = new Map();
    for (const seed of seedNodes) {
      const visited = new Map();
      const queue = [{ id: seed.id, dist: 0 }];
      visited.set(seed.id, 0);
      while (queue.length > 0) {
        queue.sort((a, b) => a.dist - b.dist);
        const current = queue.shift();
        if (current.dist > visited.get(current.id)) continue;
        for (const edge of getOutEdgesSync.all(current.id, ..._ownPSync, current.id, ..._ownPSync)) {
          const newDist = current.dist + (1 - (edge.strength || 0.5));
          if (newDist > DIST_CUTOFF_SYNC) continue;
          const prev = visited.get(edge.next_id);
          if (prev === undefined || newDist < prev) {
            visited.set(edge.next_id, newDist);
            queue.push({ id: edge.next_id, dist: newDist });
          }
        }
      }
      for (const [id, dist] of visited) {
        const existing = nodeMap.get(id);
        if (!existing || dist < existing.distance) nodeMap.set(id, { distance: dist });
      }
    }

    const getNode = this.db.prepare("SELECT * FROM nodes WHERE id = ? AND state = 'active'");
    // Sources that are raw conversation logs — deprioritize in renders
    const NOISE_SOURCES = new Set(['scribe-conversation', 'auto-session', 'session-log']);
    const constellation = [];
    for (const [id, meta] of nodeMap) {
      const node = this._filterByOwner(getNode.get(id));
      if (!node) continue;
      // Skip raw conversation nodes in renders — they pollute context
      if (NOISE_SOURCES.has(node.source)) continue;
      const d = meta.distance;
      const normalizedDist = Math.min(1, d / DIST_CUTOFF_SYNC) / Math.max(0.1, node.weight);
      let level, content;
      if (normalizedDist < 0.3) { level = 'L2'; content = node.l2; }
      else if (normalizedDist < 0.6) { level = 'L1'; content = node.l1; }
      else { level = 'L0'; content = node.l0; }
      constellation.push({ id, level, distance: normalizedDist, content, tags: node.tags });
    }

    constellation.sort((a, b) => a.distance - b.distance);

    // === maxL2 limit: excess L2 nodes downgraded to L1 ===
    if (maxL2 < Infinity) {
      let l2Count = 0;
      for (const node of constellation) {
        if (node.level === 'L2') {
          l2Count++;
          if (l2Count > maxL2) {
            node.level = 'L1';
            const fullNode = getNode.get(node.id);
            if (fullNode) node.content = fullNode.l1;
          }
        }
      }
    }

    let totalTokens = 0;
    const rendered = [];
    for (const node of constellation) {
      const tokens = Math.ceil(node.content.length / 3.8);
      if (totalTokens + tokens > budget) break;
      totalTokens += tokens;
      rendered.push(node);
    }

    const renderedIds = new Set(rendered.map(n => n.id));
    const { sql: _ownSqlRE, params: _ownPRE } = this._ownerSqlClause();
    const { sql: _btSqlRE } = this._bitemporalSqlClause();
    const getEdges = this.db.prepare(`SELECT * FROM edges INDEXED BY idx_edges_source WHERE source = ? AND state = 'active'${_btSqlRE}${_ownSqlRE}`);
    const renderedEdges = [];
    for (const node of rendered) {
      for (const e of getEdges.all(node.id, ..._ownPRE)) {
        if (renderedIds.has(e.target)) renderedEdges.push({ from: e.source, to: e.target, type: e.edge_type, strength: e.strength });
      }
    }

    const updateAccess = this.db.prepare('UPDATE nodes SET access_count = access_count + 1, accessed_at = ?, weight = MIN(weight + 0.02, 2.0) WHERE id = ?');
    const now = new Date().toISOString();
    const hebbNodeIds = rendered.map(n => n.id);
    const renderWriteTxn = this.db.transaction(() => {
      for (const node of rendered) updateAccess.run(now, node.id);

      // Hebb edge strengthening: batch query + batch update for co-rendered nodes
      if (hebbNodeIds.length >= 2) {
        const placeholders = hebbNodeIds.map(() => '?').join(',');
        const { sql: _ownSqlHE, params: _ownPHE } = this._ownerSqlClause();
        const { sql: _btSqlHE } = this._bitemporalSqlClause();
        const allCoEdges = this.db.prepare(
          `SELECT source, target FROM edges WHERE state = 'active'${_btSqlHE} AND source IN (${placeholders}) AND target IN (${placeholders})${_ownSqlHE}`
        ).all(...hebbNodeIds, ...hebbNodeIds, ..._ownPHE);
        if (allCoEdges.length > 0) {
          const hebbEdge = this.db.prepare(
            "UPDATE edges SET strength = MIN(strength + 0.02, 1.0), accessed_at = datetime('now') WHERE state = 'active' AND source = ? AND target = ?"
          );
          for (const e of allCoEdges) {
            hebbEdge.run(e.source, e.target);
          }
        }
      }
    });
    // Retry with backoff to avoid "database is locked" when Mímir daemon holds write lock
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renderWriteTxn();
        break;
      } catch (e) {
        if (e.message?.includes('locked') && attempt < 2) {
          // Sync sleep is unavoidable here (better-sqlite3 is sync), but kept short
          const wait = 50 * (attempt + 1);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
        } else if (e.message?.includes('locked')) {
          // Final attempt failed — skip write silently, render data is still valid
          console.warn('[Engine] render write skipped (DB locked after 3 attempts)');
        } else { throw e; }
      }
    }

    let text = this._renderText(rendered, renderedEdges, focus, this._renderNodeFn);
    // Post-render budget enforcement
    const textTokens = Math.ceil(text.length / 3.8);
    if (textTokens > budget) {
      const charLimit = Math.floor((budget - 10) * 3.8); // -10 for truncation marker
      text = text.slice(0, charLimit) + '\n\n[...truncated to budget]';
    }

    return {
      focus, nodes: rendered, edges: renderedEdges,
      stats: { total_nodes: this._count(), rendered: rendered.length, tokens: Math.min(textTokens, budget), budget },
      text
    };
  }

  /**
   * _pathPreScan — Multi-hop path pre-scanning (Optimization R9)
   *
   * Before the main BFS render, do a lightweight deep traversal along strong edges
   * (strength > 0.5) up to 7 hops, reading only L0 titles and edge strengths.
   * Finds distant high-value nodes that the standard BFS (maxDepth=3) would miss.
   * Returns them as "airdrop anchors" to be injected into the render result at L1 resolution.
   *
   * @param {string[]} seedIds - IDs of seed nodes to start from
   * @param {Set<string>} alreadyRendered - IDs already in the main render result
   * @param {number} [maxHops=7] - Maximum traversal depth
   * @param {number} [minPathWeight=0.15] - Minimum cumulative path weight (product of edge strengths)
   * @param {number} [maxAnchors=5] - Maximum number of airdrop anchors to return
   * @returns {Array<{id, l0, l1, pathWeight, hops, pathDescription}>}
   */
  _pathPreScan(seedIds, alreadyRendered, { maxHops = 7, minPathWeight = 0.15, maxAnchors = 5 } = {}) {
    const { sql: _ownSqlPS, params: _ownPPS } = this._ownerSqlClause();
    const { sql: _btSqlPS } = this._bitemporalSqlClause();
    const getStrongEdges = this.db.prepare(
      `SELECT target AS next_id, strength, edge_type FROM edges INDEXED BY idx_edges_source WHERE source = ? AND state = 'active'${_btSqlPS} AND strength > 0.5${_ownSqlPS}
       UNION ALL
       SELECT source AS next_id, strength, edge_type FROM edges INDEXED BY idx_edges_target WHERE target = ? AND state = 'active'${_btSqlPS} AND strength > 0.5${_ownSqlPS}`
    );
    const getNodeL0L1 = this.db.prepare("SELECT id, l0, l1, weight FROM nodes WHERE id = ? AND state = 'active'");

    // BFS with path weight tracking (product of edge strengths along the path)
    // Each entry: { id, pathWeight, hops, path: [id1, id2, ...] }
    const visited = new Map(); // id -> best pathWeight
    const candidates = []; // distant nodes with high path weight
    const seedSet = new Set(seedIds);

    for (const seedId of seedIds) {
      const queue = [{ id: seedId, pathWeight: 1.0, hops: 0, path: [seedId] }];
      visited.set(seedId, 1.0);

      while (queue.length > 0) {
        const current = queue.shift();
        if (current.hops >= maxHops) continue;

        const edges = getStrongEdges.all(current.id, ..._ownPPS, current.id, ..._ownPPS);
        for (const edge of edges) {
          const newWeight = current.pathWeight * edge.strength;
          if (newWeight < minPathWeight) continue; // path too weak, prune

          const prevWeight = visited.get(edge.next_id);
          if (prevWeight !== undefined && prevWeight >= newWeight) continue; // already found a better path

          visited.set(edge.next_id, newWeight);
          const newPath = [...current.path, edge.next_id];

          queue.push({
            id: edge.next_id,
            pathWeight: newWeight,
            hops: current.hops + 1,
            path: newPath
          });

          // Only consider nodes that are distant (>= 4 hops) and not already rendered or seeds
          if (current.hops + 1 >= 4 && !alreadyRendered.has(edge.next_id) && !seedSet.has(edge.next_id)) {
            const node = this._filterByOwner(getNodeL0L1.get(edge.next_id));
            if (node) {
              candidates.push({
                id: edge.next_id,
                l0: node.l0,
                l1: node.l1,
                weight: node.weight,
                pathWeight: newWeight,
                hops: current.hops + 1,
                path: newPath
              });
            }
          }
        }
      }
    }

    // Deduplicate: keep best pathWeight per node
    const bestPerNode = new Map();
    for (const c of candidates) {
      const existing = bestPerNode.get(c.id);
      if (!existing || c.pathWeight > existing.pathWeight) {
        bestPerNode.set(c.id, c);
      }
    }

    // Sort by (pathWeight * nodeWeight) descending, take top N
    const anchors = [...bestPerNode.values()]
      .sort((a, b) => (b.pathWeight * b.weight) - (a.pathWeight * a.weight))
      .slice(0, maxAnchors);

    // Build path descriptions using L0 titles
    return anchors.map(a => {
      const pathLabels = a.path.map(id => {
        const n = this._filterByOwner(getNodeL0L1.get(id));
        return n ? n.l0 : id;
      });
      return {
        id: a.id,
        l0: a.l0,
        l1: a.l1,
        pathWeight: a.pathWeight,
        hops: a.hops,
        pathDescription: pathLabels.join(' → ')
      };
    });
  }

  _renderText(nodes, edges, focus, renderNodeFn) {
    const lines = [`⭐ Constellation: ${Array.isArray(focus) ? focus.join(', ') : focus}`, ''];
    const symbols = { L2: '◆', L1: '◇', L0: '○' };
    const LEVEL_TO_PRECISION = { L2: 'full', L1: 'medium', L0: 'minimal' };
    const mainNodes = nodes.filter(n => !n._airdrop);
    const airdropNodes = nodes.filter(n => n._airdrop);

    for (const n of mainNodes) {
      let text = n.content;
      if (renderNodeFn && n.l0) {
        const precision = LEVEL_TO_PRECISION[n.level] || 'minimal';
        text = renderNodeFn(n, precision);
      }
      lines.push(`${symbols[n.level]} [${n.id}] ${text}`);
    }

    if (airdropNodes.length > 0) {
      lines.push('', '── Distant Anchors (multi-hop paths) ──');
      for (const n of airdropNodes) {
        let text = n.content;
        if (renderNodeFn && n.l0) {
          text = renderNodeFn(n, 'medium');
        }
        lines.push(`⚡ [${n.id}] ${text}`);
        lines.push(`  ↳ path(${n._hops} hops, weight ${n._pathWeight.toFixed(2)}): ${n._pathDescription}`);
      }
    }

    if (edges.length) {
      lines.push('', '── Connections ──');
      for (const e of edges) lines.push(`  ${e.from} ─${e.type}→ ${e.to} (${e.strength.toFixed(2)})`);
    }
    return lines.join('\n');
  }

  _hasVecData() {
    try {
      return this.db.prepare('SELECT COUNT(*) as c FROM node_rowids').get().c > 0;
    } catch { return false; }
  }

  /**
   * embedAll — generate embeddings for all nodes that lack them (batch backfill)
   */
  async embedAll() {
    const nodes = this.db.prepare("SELECT id, l0, l1, semantic_anchor FROM nodes WHERE state = 'active'").all();
    const upsertRowid = this.db.prepare(`INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)`);
    const getRowid = this.db.prepare(`SELECT rowid FROM node_rowids WHERE node_id = ?`);
    const deleteVec = this.db.prepare(`DELETE FROM node_embeddings WHERE id = ?`);
    const insertVec = this.db.prepare(`INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)`);

    let count = 0;
    for (const node of nodes) {
      const embedding = await this._embed(this._buildEmbeddingText(node));
      this.db.transaction(() => {
        upsertRowid.run(node.id);
        const row = getRowid.get(node.id);
        deleteVec.run(row.rowid);
        insertVec.run(BigInt(row.rowid), embedding);
      })();
      count++;
    }
    return count;
  }

  forget(nodeId) {
    this.db.prepare("UPDATE nodes SET state = 'dormant' WHERE id = ?").run(nodeId);
    this.db.prepare("UPDATE edges SET state = 'dormant' WHERE source = ? OR target = ?").run(nodeId, nodeId);
    // Clean FTS5 index to prevent ghost search results
    try {
      this.db.prepare("DELETE FROM nodes_fts WHERE id = ?").run(nodeId);
    } catch { /* FTS table may not exist */ }
  }

  /**
   * dreamCollide — random focus collision (creativity engine)
   * Picks N active nodes at random as foci, renders each constellation, and
   * looks for "collision points" — nodes that appear in multiple focus renders.
   * These collisions are candidate creative connections (cross-domain bridges).
   *
   * Returns: { foci, collisions: [{id, contexts}], insightPrompt }
   * insightPrompt can be passed directly to an LLM for creative inference.
   */
  dreamCollide({ numFoci = 3, budget = 800, maxDepth = 3 } = {}) {
    const { sql: _ownSqlDC, params: _ownPDC } = this._ownerSqlClause();
    const allActive = this.db.prepare(`SELECT id, l0, tags, weight FROM nodes WHERE state = 'active'${_ownSqlDC}`).all(..._ownPDC);
    if (allActive.length < 2) return { foci: [], collisions: [], insightPrompt: '(too few nodes)' };

    // R2: Prioritize endangered nodes (weight 0.01-0.15) as foci
    // At least 1 endangered focus if available, rest random
    const endangered = allActive.filter(n => n.weight >= 0.01 && n.weight <= 0.15);
    const n = Math.min(numFoci, allActive.length);
    const foci = [];

    // Pick 1 endangered node if available
    if (endangered.length > 0) {
      const idx = Math.floor(Math.random() * endangered.length);
      foci.push(endangered[idx]);
    }

    // Fill remaining with random (Fisher-Yates)
    const fociIds = new Set(foci.map(f => f.id));
    const remaining = allActive.filter(node => !fociIds.has(node.id));
    const needed = n - foci.length;
    for (let i = remaining.length - 1; i > remaining.length - needed - 1 && i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    foci.push(...remaining.slice(-needed));

    // Render from each focal point
    const collisionMap = new Map(); // nodeId → Set of focal IDs
    const focalRenders = {};

    for (const focal of foci) {
      const result = this.renderSync(focal.id, { budget, maxDepth });
      focalRenders[focal.id] = result;
      for (const node of result.nodes) {
        if (!collisionMap.has(node.id)) collisionMap.set(node.id, new Set());
        collisionMap.get(node.id).add(focal.id);
      }
    }

    // Find collision points (nodes in ≥2 focal renders, excluding the foci themselves)
    const fociIdSet = new Set(foci.map(f => f.id));
    const collisions = [...collisionMap.entries()]
      .filter(([id, contexts]) => contexts.size >= 2 && !fociIdSet.has(id))
      .map(([id, contexts]) => {
        const node = this.db.prepare('SELECT l0 FROM nodes WHERE id = ?').get(id);
        return { id, l0: node?.l0 || '', contexts: [...contexts] };
      })
      .sort((a, b) => b.contexts.length - a.contexts.length);

    // Build insight prompt for LLM
    const fociDesc = foci.map(f => `• ${f.id}: ${f.l0}`).join('\n');
    const collisionDesc = collisions.length > 0
      ? collisions.map(c => `• ${c.id} (${c.l0}) — bridges: ${c.contexts.join(', ')}`).join('\n')
      : '(no collisions found)';

    const insightPrompt = `DREAM COLLISION REPORT
Random foci selected:
${fociDesc}

Collision points (nodes appearing in multiple focal renders):
${collisionDesc}

These collision points represent unexpected bridges between different memory domains.
What novel insight, analogy, or creative connection do these collisions suggest?
Focus on non-obvious relationships and potential new ideas.`;

    return {
      foci: foci.map(f => f.id),
      collisions,
      insightPrompt
    };
  }

  dream({ decayFactor = 0.95, pruneThreshold = 0.05, dormantThreshold = 0.001 } = {}) {
    // R2: differential decay — identity/principle exempted, source-based λ
    // identity/principle: exempt (half-life ~693 days at 0.999/cycle)
    // knowledge/topic: standard decay (decayFactor, default 0.95, half-life ~14 cycles)
    // emergent/exploration: fast decay (0.90, half-life ~7 cycles)
    const report = { decayed: 0, decayed_fast: 0, exempt: 0, pruned: 0, dormant: 0 };
    this.db.transaction(() => {
      // Identity, principle & lesson nodes: near-zero decay (exempt)
      report.exempt = this.db.prepare(`
        UPDATE nodes SET weight = weight * 0.999
        WHERE state = 'active' AND (source IN ('identity', 'principle', 'lesson') OR id LIKE 'principle-%' OR id LIKE 'lesson-%' OR id LIKE 'M-%')
      `).run().changes;

      // Emergent/exploration nodes: fast decay
      report.decayed_fast = this.db.prepare(`
        UPDATE nodes SET weight = weight * 0.90 
        WHERE state = 'active' AND source IN ('emergent', 'exploration', 'curiosity')
        AND id NOT LIKE 'principle-%' AND id NOT LIKE 'M-%'
      `).run().changes;

      // Everything else: standard decay
      report.decayed = this.db.prepare(`
        UPDATE nodes SET weight = weight * ? 
        WHERE state = 'active' 
        AND source NOT IN ('identity', 'principle', 'lesson', 'emergent', 'exploration', 'curiosity')
        AND id NOT LIKE 'principle-%' AND id NOT LIKE 'lesson-%' AND id NOT LIKE 'M-%'
      `).run(decayFactor).changes;

      // Edge decay: gentle strength reduction (half-life ~34 cycles at 0.98)
      report.edges_decayed = this.db.prepare(
        "UPDATE edges SET strength = strength * 0.98 WHERE state = 'active'"
      ).run().changes;

      // Edge pruning (after decay, so weakened edges get pruned)
      report.pruned = this.db.prepare("UPDATE edges SET state = 'dormant' WHERE strength < ? AND state = 'active'").run(pruneThreshold).changes;
      
      // Dormant transition (but never dormant identity/principle/lesson)
      // Also protect high-connectivity nodes (>=10 active edges) — they are structural hubs
      const _btSqlHub = this._bitemporalSqlClause('e').sql;
      report.dormant = this.db.prepare(`
        UPDATE nodes SET state = 'dormant'
        WHERE weight < ? AND state = 'active'
        AND source NOT IN ('identity', 'principle', 'lesson')
        AND id NOT LIKE 'principle-%' AND id NOT LIKE 'lesson-%' AND id NOT LIKE 'M-%'
        AND id NOT IN (
          SELECT n.id FROM nodes n
          JOIN edges e ON (e.source = n.id OR e.target = n.id) AND e.state = 'active'${_btSqlHub}
          GROUP BY n.id HAVING COUNT(*) >= 10
        )
      `).run(dormantThreshold).changes;

      // Edge dormancy linkage: dormant edges connected to newly dormant nodes
      if (report.dormant > 0) {
        report.edges_dormant = this.db.prepare(`
          UPDATE edges SET state = 'dormant'
          WHERE state = 'active' AND (
            source IN (SELECT id FROM nodes WHERE state = 'dormant') OR
            target IN (SELECT id FROM nodes WHERE state = 'dormant')
          )
        `).run().changes;
      }
      // r14: catch any edge whose endpoint drifted out of the live set since
      // the previous dream tick (manual deletes, supersede paths missed above,
      // imports that wrote edges before their endpoints existed). Cheap and
      // idempotent — drops zombie-edge accumulation regardless of source path.
      report.edges_orphan_swept = this.db.prepare(`
        UPDATE edges SET state = 'dormant'
        WHERE state = 'active'
          AND (
            source NOT IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
            OR target NOT IN (SELECT id FROM nodes WHERE state = 'active' AND superseded_at IS NULL)
          )
      `).run().changes;
    })();
    // Invalidate adjacency list cache — edge strengths and states have changed
    this._adjCacheVersion++;
    return report;
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    const active = this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE state = 'active'").get().c;
    const dormant = this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE state = 'dormant'").get().c;
    const _btSqlStats = this._bitemporalSqlClause().sql;
    const edges = this.db.prepare(`SELECT COUNT(*) as c FROM edges WHERE state = 'active'${_btSqlStats}${this._validEdgeEndpointsSql()}`).get().c;
    let embedded = 0;
    try { embedded = this.db.prepare('SELECT COUNT(*) as c FROM node_rowids').get().c; } catch {}
    return { total, active, dormant, edges, embedded };
  }

  _count() {
    return this.db.prepare("SELECT COUNT(*) as c FROM nodes WHERE state = 'active'").get().c;
  }

  close() {
    // PRAGMA optimize folds fresh stats back into sqlite_stat1 if the planner
    // has seen enough query patterns this session. Cheap (<50ms typical) and
    // keeps BFS plans sharp across restarts without a full ANALYZE.
    try { this.db.pragma('optimize'); } catch {}
    if (this._coldStartTimer) { try { clearInterval(this._coldStartTimer); } catch {} this._coldStartTimer = null; }
    if (this._accessFlushTimer) { try { clearInterval(this._accessFlushTimer); } catch {} this._accessFlushTimer = null; }
    if (this._consolidationSummaryTimer) { try { clearInterval(this._consolidationSummaryTimer); } catch {} this._consolidationSummaryTimer = null; }
    this.db.close();
  }
}

module.exports = { ConstellationEngine };
