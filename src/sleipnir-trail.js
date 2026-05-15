// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — exploration trail capture + 3-layer noise gate (2026-04-29)
// Plan: engine-output/architecture-research/2026-04-29-experiential-anchor-planning-v2.md
// Step 2: telemetry-only write path. Step 3 (balanced-tier aggregator) consumes
// promoted trails from this table.

import { createHash } from 'node:crypto';
import { redact, isPureNoise } from './sleipnir-redact.js';
import {
  ALLOWED_CALLERS,
  CALLER_MAIN, CALLER_CRON, CALLER_SUBAGENT, CALLER_AUTONOMY,
  GATE_SILENT_DROP, GATE_TRAIL_ONLY, GATE_PROMOTE,
  SOURCE_CODE_GREP, SOURCE_CODE_READ, SOURCE_WEB_FETCH,
  SALIENCE_ACTIVATION_FLOOR, MIMIR_POOL_URL, POOL_CACHE_MS, POOL_FETCH_TIMEOUT_MS,
  NOVELTY_THRESHOLD, NOVELTY_LOOKBACK_DAYS,
  COOLDOWN_PROMOTE_MS, COOLDOWN_DEFAULT_MS,
} from './sleipnir-constants.js';

// ─── Caller-kind derivation from session id ─────────────────────────────────
// Mirrors BehaviorLogger.deriveSource taxonomy but folds it into the 4-class
// caller-kind matrix Sleipnir uses for its scope gate.
export function deriveCallerKind(sessionId, hint = null) {
  if (hint && (hint === CALLER_SUBAGENT || hint === CALLER_AUTONOMY ||
               hint === CALLER_MAIN || hint === CALLER_CRON)) {
    return hint;
  }
  const sid = sessionId || '';
  if (sid.startsWith('tg:') || sid.startsWith('dashboard')) return CALLER_MAIN;
  if (sid.startsWith('cron-')) return CALLER_CRON;
  // Mímir SA / curiosity / wakeup all qualify as autonomy (user excluded these)
  if (sid.startsWith('curiosity') || sid.startsWith('wakeup') ||
      sid.startsWith('mimir')) return CALLER_AUTONOMY;
  // Conservative default: treat unknown as main; user authorized scope = main + cron only.
  return CALLER_MAIN;
}

// ─── Cron-name derivation from session id (cron-explore-…) ──────────────────
export function deriveCronName(sessionId) {
  const sid = sessionId || '';
  if (!sid.startsWith('cron-')) return null;
  const tail = sid.replace('cron-', '');
  return tail.split('-')[0] || null;
}

// ─── Tool name → source_kind mapping ────────────────────────────────────────
// Returns null for tool calls Sleipnir does not capture (Edit, Write, etc).
export function toolToSourceKind(toolName) {
  if (!toolName) return null;
  const n = String(toolName);
  if (n === 'Grep' || n === 'grep_search') return SOURCE_CODE_GREP;
  if (n === 'Read' || n === 'file_read')   return SOURCE_CODE_READ;
  if (n === 'WebFetch' || n === 'web_fetch') return SOURCE_WEB_FETCH;
  return null;
}

// ─── Region URI synthesis ───────────────────────────────────────────────────
// Different sources need different region keys for dedup.
function synthRegion(sourceKind, input) {
  if (!input || typeof input !== 'object') return null;
  if (sourceKind === SOURCE_CODE_GREP) {
    const path = input.path || input.glob || '(root)';
    return `file://${path}`;
  }
  if (sourceKind === SOURCE_CODE_READ) {
    const path = input.file_path || input.path || '';
    return path ? `file://${path}` : null;
  }
  if (sourceKind === SOURCE_WEB_FETCH) {
    const url = input.url || input.endpoint || '';
    return url || null;
  }
  return null;
}

function synthQuery(sourceKind, input) {
  if (!input || typeof input !== 'object') return null;
  if (sourceKind === SOURCE_CODE_GREP) return input.pattern || null;
  if (sourceKind === SOURCE_CODE_READ) {
    const off = input.offset, lim = input.limit;
    if (off || lim) return `lines ${off || 0}+${lim || ''}`;
    return null;
  }
  if (sourceKind === SOURCE_WEB_FETCH) return input.prompt || null;
  return null;
}

// ─── Signature for cheap dedup (hash of region+query) ──────────────────────
function computeSignature(region, query) {
  const h = createHash('sha256');
  h.update(String(region || ''));
  h.update('|');
  h.update(String(query || ''));
  return h.digest('hex').slice(0, 16);
}

// Raw-text cap on inbound capture: matches downstream promote.js ceiling
// (MAX_RAW_CHUNKS × MAX_RAW_CHARS_PER_CHUNK = 8 × 4096 = 32768). Keeps any
// single trail row from blowing up SQLite page size.
const RAW_TEXT_MAX = 32 * 1024;

// ─── L1 silent_drop hard rules (plan §3.2) ─────────────────────────────────
const PATH_BLACKLIST = [
  /\/node_modules\//, /\/\.git\//, /\.min\.js$/, /\/dist\//,
  /\/build\//, /\.lock$/, /\.map$/, /\/snapshots\//,
];

// Failed-read markers — Read/Grep/WebFetch tool errors should never become trails.
const FAILED_READ_RE = /^(Error:|ENOENT|EACCES|\(error\)|\(file not found\))/i;

function hardSilentDrop({ sourceKind, region, finding, dedupRecentMs, cooldownMs }) {
  // Tool result effectively empty
  if (typeof finding === 'string' && finding.length > 0 && finding.length < 30) {
    return { drop: true, reason: 'finding_too_short' };
  }
  // Tool result indicates a failed read — pure noise
  if (typeof finding === 'string' && FAILED_READ_RE.test(finding.trim())) {
    return { drop: true, reason: 'failed_read' };
  }
  // Path blacklist
  if (region && typeof region === 'string') {
    for (const re of PATH_BLACKLIST) {
      if (re.test(region)) return { drop: true, reason: 'path_blacklisted' };
    }
  }
  // Verdict-aware cooldown — caller passes cooldownMs (30min for promote-eligible, 2h default)
  const cd = typeof cooldownMs === 'number' ? cooldownMs : COOLDOWN_DEFAULT_MS;
  if (typeof dedupRecentMs === 'number' && dedupRecentMs < cd) {
    return { drop: true, reason: cd === COOLDOWN_PROMOTE_MS ? 'repeat_region_within_30min' : 'repeat_region_within_2h' };
  }
  return { drop: false };
}

// ─── Salience cache — read-only join against Mímir /pool ───────────────────
// Lazy refresh: stale cache triggers a fire-and-forget refetch but the current
// decision uses what's already there (sync gate, eventually consistent).
let _salientCache = { ts: 0, paths: new Set(), refreshing: false };

function _extractPathsFromL0(l0) {
  if (!l0 || typeof l0 !== 'string') return [];
  const out = [];
  // file:// URIs
  const u = l0.match(/file:\/\/[^\s)]+/g);
  if (u) for (const x of u) out.push(x.slice(7));
  // Paths or basenames with a code-file extension. Bare basenames are allowed
  // because most anchor L0s reference files by basename ("engine.cjs", "src/dashboard.js").
  // Over-promote risk (multiple files sharing a basename) is bounded by
  // the balanced-tier low_value filter + 30min cooldown; in practice basenames in this
  // codebase are unique. Match is suffix-only on fullPath (see _regionInSalientPool).
  const p = l0.match(/(?:[a-zA-Z0-9_\-]+\/)*[a-zA-Z0-9_\-]+\.(?:js|cjs|mjs|md|py|json|sh|html|css|sql)\b/g);
  if (p) for (const x of p) out.push(x);
  return out;
}

async function _refetchSalientPaths() {
  if (_salientCache.refreshing) return;
  _salientCache.refreshing = true;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POOL_FETCH_TIMEOUT_MS);
  let nextPaths = null;
  try {
    const res = await fetch(MIMIR_POOL_URL, { signal: ctrl.signal });
    if (res.ok) {
      const data = await res.json();
      const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
      const paths = new Set();
      for (const n of nodes) {
        if (!n || typeof n.activation !== 'number') continue;
        if (n.activation < SALIENCE_ACTIVATION_FLOOR) continue;
        for (const p of _extractPathsFromL0(n.l0)) paths.add(p);
      }
      nextPaths = paths;
    }
  } catch { /* timeout / pool down — keep last good paths */ }
  finally {
    clearTimeout(t);
    // Always advance ts so we don't refetch on every gate decision when /pool is down.
    // Keep prior paths on failure so the gate degrades gracefully.
    _salientCache = {
      ts: Date.now(),
      paths: nextPaths !== null ? nextPaths : _salientCache.paths,
      refreshing: false,
    };
  }
}

function _salientPathsSnapshot() {
  // Stale → kick off async refetch but return current set immediately.
  if (Date.now() - _salientCache.ts > POOL_CACHE_MS) {
    _refetchSalientPaths().catch(() => {});
  }
  return _salientCache.paths;
}

// True if the trail region's full path ends with any path/basename mentioned
// by an attended pool node. One-directional suffix match: a pool basename
// "engine.cjs" matches any region file ending in "engine.cjs" (acceptable
// over-promote in practice; basenames in this codebase are mostly unique).
function _regionInSalientPool(region) {
  if (!region || typeof region !== 'string') return false;
  if (!region.startsWith('file://')) return false;
  const fullPath = region.slice(7);
  const paths = _salientPathsSnapshot();
  if (paths.size === 0) return false;
  for (const p of paths) {
    if (!p) continue;
    if (fullPath === p || fullPath.endsWith('/' + p) || fullPath.endsWith(p)) return true;
  }
  return false;
}

// ─── 5-clause gate decision (2026-04-29 redesign) ───────────────────────────
// Clauses (ordered by confidence):
//   1. follow_up_edit OR discovery_marker      → PROMOTE  (existing L3, kept)
//   2. region in active SA pool (act ≥ 0.3)    → PROMOTE  (NEW: salience)
//   3. novelty(region) ≥ 0.7 AND caller=main   → PROMOTE  (NEW: cold first-touch)
//   4. trail_count(7d) ≥ 2 (= TRAIL_GROUP_THRESHOLD) → handled by aggregator
//   5. else                                    → TRAIL_ONLY
//
// Returns { gate, reason, finding, redactionHits, promoteEligible }.
// promoteEligible signals to hardSilentDrop which cooldown to use.
function decideGate({
  sourceKind, region, query, finding, metadata,
  dedupRecentMs, hasFollowUpEdit,
  callerKind, novelty,
}) {
  // 0. PII redaction first — drop if redaction kills all content
  const r = redact(finding || '', 'exploration');
  if ((finding || '').length > 0 && isPureNoise(finding, r.text)) {
    return { gate: GATE_SILENT_DROP, reason: 'pii_only_after_redaction', finding: null, redactionHits: r.hits };
  }
  const cleaned = r.text;

  // Evaluate clauses 1-3 once. promoteEligible decides verdict-aware cooldown.
  const hasMarker = !!(cleaned && /原来是因为|终于找到|这里有 ?bug|EXPLORATION_PROMOTE|key insight|aha|turns out|finally found|root cause|figured out|got it now|breakthrough|the issue is|now i see|that's why/i.test(cleaned));
  const c1 = hasFollowUpEdit === true || hasMarker;
  const c2 = _regionInSalientPool(region);
  const c3 = (typeof novelty === 'number' && novelty >= NOVELTY_THRESHOLD && callerKind === CALLER_MAIN);
  const promoteEligible = !!(c1 || c2 || c3);
  const cooldownMs = promoteEligible ? COOLDOWN_PROMOTE_MS : COOLDOWN_DEFAULT_MS;

  // L1 hard silent_drop (verdict-aware cooldown)
  const hard = hardSilentDrop({ sourceKind, region, finding: cleaned, dedupRecentMs, cooldownMs });
  if (hard.drop) {
    return { gate: GATE_SILENT_DROP, reason: hard.reason, finding: null, redactionHits: r.hits };
  }

  // Clauses ordered by confidence
  if (hasFollowUpEdit === true) {
    return { gate: GATE_PROMOTE, reason: 'follow_up_edit', finding: cleaned, redactionHits: r.hits, promoteEligible: true };
  }
  if (hasMarker) {
    return { gate: GATE_PROMOTE, reason: 'discovery_marker', finding: cleaned, redactionHits: r.hits, promoteEligible: true };
  }
  if (c2) {
    return { gate: GATE_PROMOTE, reason: 'salience_pool_match', finding: cleaned, redactionHits: r.hits, promoteEligible: true };
  }
  if (c3) {
    return { gate: GATE_PROMOTE, reason: 'novelty_cold_main', finding: cleaned, redactionHits: r.hits, promoteEligible: true };
  }
  // Clauses 4 & 5 — trail_only; aggregator will pick up at count ≥ TRAIL_GROUP_THRESHOLD.
  return { gate: GATE_TRAIL_ONLY, reason: 'default_observation', finding: cleaned, redactionHits: r.hits };
}

// Salience cache is seeded explicitly via SleipnirTrail.init() — see below.
// Seeding at module-import time would fire HTTP fetches in tests/CI without
// the engine running.

// ─── SleipnirTrail — main API ───────────────────────────────────────────────
export class SleipnirTrail {
  /** @type {import('better-sqlite3').Database} */
  #db = null;
  #stmts = {};
  #enabled = true;

  init(db) {
    this.#db = db;
    if (!this.#db) { this.#enabled = false; return; }
    // Seed the salience cache once the engine boot has reached the point of
    // wiring Sleipnir. Mímir's HTTP server is started before this is called.
    _refetchSalientPaths().catch(() => {});
    this.#stmts.insertTrail = this.#db.prepare(`
      INSERT INTO exploration_trail (
        occurred_at, caller_kind, caller_session, cron_name,
        source_kind, region, query, finding, signature,
        gate_decision, metadata, promoted,
        raw_excerpt, raw_line_range, raw_file_path
      ) VALUES (
        @occurred_at, @caller_kind, @caller_session, @cron_name,
        @source_kind, @region, @query, @finding, @signature,
        @gate_decision, @metadata, @promoted,
        @raw_excerpt, @raw_line_range, @raw_file_path
      )
    `);
    this.#stmts.lookupRecent = this.#db.prepare(`
      SELECT MAX(occurred_at) AS recent FROM exploration_trail
      WHERE signature = ? AND occurred_at > ?
    `);
    this.#stmts.countRegion30d = this.#db.prepare(`
      SELECT COUNT(*) AS cnt FROM exploration_trail
      WHERE region = ? AND occurred_at > ?
    `);
    this.#stmts.metricInc = this.#db.prepare(`
      INSERT INTO sleipnir_metrics (bucket_hour, silent_drop, trail_only, promote, task_trail, redaction_hits, caller_subagent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_hour) DO UPDATE SET
        silent_drop = silent_drop + excluded.silent_drop,
        trail_only = trail_only + excluded.trail_only,
        promote = promote + excluded.promote,
        task_trail = task_trail + excluded.task_trail,
        redaction_hits = redaction_hits + excluded.redaction_hits,
        caller_subagent = caller_subagent + excluded.caller_subagent
    `);
  }

  // Increments the hourly metrics bucket.
  #bumpMetric(field, n = 1) {
    if (!this.#db) return;
    const bucket = Math.floor(Date.now() / 3600_000);
    const cols = { silent_drop: 0, trail_only: 0, promote: 0, task_trail: 0, redaction_hits: 0, caller_subagent: 0 };
    cols[field] = n;
    try {
      this.#stmts.metricInc.run(bucket,
        cols.silent_drop, cols.trail_only, cols.promote, cols.task_trail,
        cols.redaction_hits, cols.caller_subagent);
    } catch { /* metrics best-effort */ }
  }

  /**
   * Capture a tool-call as an exploration trail event.
   * Called from main.js's `runtime.on('toolResult')` listener (Plan A 2026-04-29 —
   * moved from toolCall to toolResult so raw text is available at insert time).
   *
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.toolName
   * @param {object} args.input
   * @param {string} [args.finding]  brief summary / preview (used for marker detection in gate)
   * @param {string} [args.callerKindHint]  override for explicit subagent stamping
   * @param {boolean} [args.hasFollowUpEdit]
   * @param {string} [args.rawText]  full tool result text (capped to RAW_TEXT_MAX); persisted for hybrid storage
   * @param {string} [args.lineRange]  e.g. "1-100" for Read tool, null otherwise
   * @param {string} [args.filePath]  resolved file path or url
   * @returns {{ gate: string, reason: string, captured: boolean }}
   */
  recordToolEvent({
    sessionId, toolName, input,
    finding = null, callerKindHint = null, hasFollowUpEdit = false,
    rawText = null, lineRange = null, filePath = null,
  }) {
    if (!this.#enabled || !this.#db) return { gate: null, reason: 'disabled', captured: false };

    // 1. Caller-kind gate (user: only main + cron capture)
    const callerKind = deriveCallerKind(sessionId, callerKindHint);
    if (!ALLOWED_CALLERS.has(callerKind)) {
      if (callerKind === CALLER_SUBAGENT) this.#bumpMetric('caller_subagent', 1);
      return { gate: null, reason: `caller_excluded:${callerKind}`, captured: false };
    }

    // 2. Source-kind filter (only grep/read/web for now)
    const sourceKind = toolToSourceKind(toolName);
    if (!sourceKind) return { gate: null, reason: 'unsupported_tool', captured: false };

    const region = synthRegion(sourceKind, input || {});
    const query = synthQuery(sourceKind, input || {});
    const signature = computeSignature(region, query);

    // 3. Recent-region dedup lookup (2h window covers both promote 30min + default 2h)
    let dedupRecentMs = null;
    try {
      const row = this.#stmts.lookupRecent.get(signature, Date.now() - 4 * 3600_000);
      if (row && row.recent) dedupRecentMs = Date.now() - row.recent;
    } catch { /* lookup best-effort */ }

    // 3b. Novelty — count of trails in this region over last 30d (clause 3)
    let novelty = 0;
    if (region) {
      try {
        const row = this.#stmts.countRegion30d.get(
          region, Date.now() - NOVELTY_LOOKBACK_DAYS * 24 * 3600_000
        );
        const cnt = row?.cnt || 0;
        novelty = 1.0 - Math.min(cnt / 10, 1.0);
      } catch { /* novelty stays 0 → clause 3 won't fire */ }
    }

    // 4. 5-clause gate
    const decision = decideGate({
      sourceKind, region, query, finding,
      metadata: input, dedupRecentMs, hasFollowUpEdit,
      callerKind, novelty,
    });

    if (decision.redactionHits > 0) this.#bumpMetric('redaction_hits', decision.redactionHits);

    if (decision.gate === GATE_SILENT_DROP) {
      this.#bumpMetric('silent_drop', 1);
      return { gate: decision.gate, reason: decision.reason, captured: false };
    }

    // 5. Persist to exploration_trail. Raw text is PII-redacted using the
    // same rule set as `finding` (already cleaned in decideGate). We re-run
    // redaction here because rawText is full content, not the truncated finding.
    let rawForDb = null;
    if (typeof rawText === 'string' && rawText.length > 0) {
      const rr = redact(rawText, 'exploration');
      rawForDb = rr.text.slice(0, RAW_TEXT_MAX);
    }
    try {
      this.#stmts.insertTrail.run({
        occurred_at: Date.now(),
        caller_kind: callerKind,
        caller_session: sessionId || null,
        cron_name: deriveCronName(sessionId),
        source_kind: sourceKind,
        region,
        query,
        finding: decision.finding,
        signature,
        gate_decision: decision.gate,
        metadata: JSON.stringify({
          tool: toolName,
          reason: decision.reason,
          input_summary: input ? Object.keys(input).slice(0, 5) : [],
        }),
        promoted: decision.gate === GATE_PROMOTE ? 1 : 0,
        raw_excerpt: rawForDb,
        raw_line_range: typeof lineRange === 'string' ? lineRange.slice(0, 64) : null,
        raw_file_path: typeof filePath === 'string' ? filePath.slice(0, 512) : null,
      });
    } catch (e) {
      // DB error: do not crash the host. Log once per error class would be nicer; for now suppress.
      return { gate: decision.gate, reason: `db_error:${e.message}`, captured: false };
    }

    if (decision.gate === GATE_PROMOTE) this.#bumpMetric('promote', 1);
    else this.#bumpMetric('trail_only', 1);

    return { gate: decision.gate, reason: decision.reason, captured: true };
  }

  /**
   * Phase A double-write hook for `_get_book_coverage`.
   * Caller (Python via dashboard bridge) passes already-aggregated region info.
   */
  recordBookCoverage({ bookId, mechanism, regionUri, callerSession = 'cron-explore' }) {
    if (!this.#enabled || !this.#db) return false;
    const callerKind = CALLER_CRON;
    const sourceKind = 'reading';
    const region = regionUri || `book://${bookId}`;
    const query = mechanism || null;
    const signature = computeSignature(region, query);
    try {
      this.#stmts.insertTrail.run({
        occurred_at: Date.now(),
        caller_kind: callerKind,
        caller_session: callerSession,
        cron_name: 'explore',
        source_kind: sourceKind,
        region,
        query,
        finding: null,
        signature,
        gate_decision: GATE_TRAIL_ONLY,
        metadata: JSON.stringify({ phase_a_double_write: true, book_id: bookId, mechanism }),
        promoted: 0,
        raw_excerpt: null,
        raw_line_range: null,
        raw_file_path: null,
      });
      this.#bumpMetric('trail_only', 1);
      return true;
    } catch { return false; }
  }

  /**
   * Read-side: list region URIs already explored (replaces _get_book_coverage).
   * Plan §2.2 new interface.
   */
  getExploredRegions({ source = 'reading', scopeUri = null, mechanism = null, withinDays = 30 }) {
    if (!this.#enabled || !this.#db) return new Set();
    const cutoff = Date.now() - withinDays * 24 * 3600_000;
    let sql = `
      SELECT DISTINCT region FROM exploration_trail
      WHERE source_kind = ? AND occurred_at > ?
    `;
    const args = [source, cutoff];
    if (scopeUri) { sql += ' AND region LIKE ?'; args.push(`${scopeUri}%`); }
    if (mechanism) { sql += ' AND query = ?'; args.push(mechanism); }
    try {
      const rows = this.#db.prepare(sql).all(...args);
      return new Set(rows.map(r => r.region).filter(Boolean));
    } catch { return new Set(); }
  }

  // Diagnostic — used by dashboard panel
  getMetricsSnapshot(hoursBack = 24) {
    if (!this.#enabled || !this.#db) return null;
    const cutoffBucket = Math.floor((Date.now() - hoursBack * 3600_000) / 3600_000);
    try {
      const row = this.#db.prepare(`
        SELECT
          COALESCE(SUM(silent_drop), 0)     AS silent_drop,
          COALESCE(SUM(trail_only), 0)      AS trail_only,
          COALESCE(SUM(promote), 0)         AS promote,
          COALESCE(SUM(task_trail), 0)      AS task_trail,
          COALESCE(SUM(redaction_hits), 0)  AS redaction_hits,
          COALESCE(SUM(caller_subagent), 0) AS caller_subagent
        FROM sleipnir_metrics
        WHERE bucket_hour >= ?
      `).get(cutoffBucket);
      return row;
    } catch { return null; }
  }
}

export const sleipnirTrail = new SleipnirTrail();
