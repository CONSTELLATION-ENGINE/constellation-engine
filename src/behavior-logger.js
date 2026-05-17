// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module behavior-logger
 * @description Layer 1 of the Session Debrief system.
 *
 * Passively records behavioral events during LLM sessions — tool calls,
 * file modifications, star map writes, conversation metrics — with zero
 * LLM overhead.  At session end the accumulated events are persisted to
 * conversations.db `session_behaviors` and a significance score is computed.
 *
 * A cumulative score drives the debrief trigger: when it crosses a threshold,
 * Layer 3 (compact-tier LLM quick audit) fires automatically.
 *
 * Design: R1 spec in engine-output/architecture-research/SESSION-DEBRIEF-DESIGN.md
 */

import { createHash } from 'node:crypto';

// ─── Source-weight multipliers ──────────────────────────────────────────────
const SOURCE_WEIGHTS = {
  'telegram:founder':            1.0,
  'dashboard:founder':           0.8,
  'autonomous:curiosity':        0.5,
  'autonomous:wakeup':           0.5,
  'autonomous:mimir-reflection': 0.4,
  'autonomous:mimir-curation':   0.4,
  'autonomous:mimir-tension':    0.4,
  'autonomous:mimir-profile':    0.4,
  'autonomous:mimir-fetch':      0.4,
  'autonomous:mimir-outreach':   0.5,
  'cron:explore':                0.3,
  'cron:dream':                  0.2,
  'cron:diary':                  0.1,
};

// ─── DEBRIEF_HINT regex (Layer 2 — extracted from agent responses) ─────────
const HINT_RE = /<!--\s*DEBRIEF:\s*(\{[^}]+\})\s*-->/g;
// ─── Ratatoskr L0 self-touch pulse hints ──────────────────────────────────
// Two kinds share an envelope shape (`<!-- KIND: {json} -->`). Each kind has
// its own payload schema; see extract*Touches methods below.
const TASK_TOUCH_RE      = /<!--\s*TASK_TOUCH:\s*([\s\S]+?)\s*-->/g;
const COGNITIVE_TOUCH_RE = /<!--\s*COGNITIVE_TOUCH:\s*([\s\S]+?)\s*-->/g;
const RESTART_TOUCH_RE   = /<!--\s*RESTART_TOUCH:\s*([\s\S]+?)\s*-->/g;
// Combined detector: cheap pre-test before per-kind regex scans.
const ANY_TOUCH_PROBE = 'TOUCH:';

// ─── Significance thresholds ────────────────────────────────────────────────
const TRIGGER_THRESHOLD   = 3;    // cumulative score to trigger debrief (lowered from 5 on 04-13)
const IMMEDIATE_THRESHOLD = 10;   // single-session score → immediate trigger
const DECAY_PER_HOUR      = 0.8;  // hourly decay multiplier for pending scores
const BASE_GAP_MS         = 15 * 60_000;   // base 15 min between debriefs
const GAP_GROWTH_FACTOR   = 0.10;          // gap grows 10% per debrief today (lowered from 15% on 04-13)
const SKIP_PENALTY_MS     = 30 * 60_000;   // +30 min if last debrief was empty
const ARCHIVE_DAYS        = 90;
const STARTUP_COOLDOWN_MS = 5 * 60_000;  // 5 min cooldown after engine restart before first debrief

export class BehaviorLogger {
  /** @type {import('better-sqlite3').Database} */
  #db = null;
  #stmts = {};

  /** In-memory accumulator for the *current* session (keyed by sessionId) */
  #sessions = new Map();

  /** Timestamp when this BehaviorLogger instance was created (= engine start time) */
  #startupTime = Date.now();

  /** Timestamp of last debrief trigger */
  #lastDebriefAt = 0;
  /** Whether last debrief produced meaningful changes (false = skip/empty) */
  #lastDebriefProductive = true;
  /** Debriefs fired today (resets at midnight) */
  #debriefsTodayCount = 0;
  #debriefsTodayDate = '';

  /** Optional callback: (pendingSessions) => void — Layer 3 hooks into this */
  onDebriefTrigger = null;

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Initialise schema inside an *existing* better-sqlite3 Database handle
   * (the same conversations.db used by ConversationStore).
   * @param {import('better-sqlite3').Database} db
   */
  init(db) {
    this.#db = db;

    // Create table + indexes (idempotent)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_behaviors (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        source          TEXT NOT NULL,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        duration_s      INTEGER DEFAULT 0,

        /* Behavior signals */
        tool_calls_total    INTEGER DEFAULT 0,
        tools_used          TEXT DEFAULT '[]',
        files_modified      TEXT DEFAULT '[]',
        files_read          TEXT DEFAULT '[]',
        star_map_writes     INTEGER DEFAULT 0,
        star_map_node_ids   TEXT DEFAULT '[]',
        code_changes        INTEGER DEFAULT 0,

        /* Conversation signals */
        user_message_count  INTEGER DEFAULT 0,
        user_message_chars  INTEGER DEFAULT 0,
        assistant_message_chars INTEGER DEFAULT 0,
        total_tokens        INTEGER DEFAULT 0,
        stop_reason         TEXT,
        compacted           INTEGER DEFAULT 0,
        turn_count          INTEGER DEFAULT 0,

        /* Agent debrief hints (Layer 2) */
        hints               TEXT DEFAULT '[]',

        /* Significance */
        significance_score      REAL DEFAULT 0.0,
        significance_breakdown  TEXT DEFAULT '{}',

        /* L2 passive inference */
        likely_nt       TEXT,

        /* Debrief lifecycle */
        debrief_status  TEXT DEFAULT 'pending',
        debriefed_at    TEXT,
        debrief_delta   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sb_status  ON session_behaviors(debrief_status);
      CREATE INDEX IF NOT EXISTS idx_sb_source  ON session_behaviors(source);
      CREATE INDEX IF NOT EXISTS idx_sb_started ON session_behaviors(started_at);
    `);

    // Migration: add likely_nt column to existing tables
    try {
      this.#db.exec(`ALTER TABLE session_behaviors ADD COLUMN likely_nt TEXT`);
    } catch {
      // Column already exists — ignore
    }

    // Prepared statements
    this.#stmts.insert = this.#db.prepare(`
      INSERT INTO session_behaviors (
        session_id, source, started_at, ended_at, duration_s,
        tool_calls_total, tools_used, files_modified, files_read,
        star_map_writes, star_map_node_ids, code_changes,
        user_message_count, user_message_chars, assistant_message_chars,
        total_tokens, stop_reason, compacted, turn_count,
        hints, significance_score, significance_breakdown, likely_nt
      ) VALUES (
        @session_id, @source, @started_at, @ended_at, @duration_s,
        @tool_calls_total, @tools_used, @files_modified, @files_read,
        @star_map_writes, @star_map_node_ids, @code_changes,
        @user_message_count, @user_message_chars, @assistant_message_chars,
        @total_tokens, @stop_reason, @compacted, @turn_count,
        @hints, @significance_score, @significance_breakdown, @likely_nt
      )
    `);

    this.#stmts.pending = this.#db.prepare(`
      SELECT * FROM session_behaviors
      WHERE debrief_status = 'pending'
      ORDER BY started_at ASC
    `);

    this.#stmts.markDebriefed = this.#db.prepare(`
      UPDATE session_behaviors
      SET debrief_status = 'debriefed', debriefed_at = @now, debrief_delta = @delta
      WHERE id = @id
    `);

    this.#stmts.archiveOld = this.#db.prepare(`
      UPDATE session_behaviors
      SET debrief_status = 'archived'
      WHERE debrief_status IN ('debriefed', 'skipped')
        AND started_at < datetime('now', '-' || @days || ' days')
    `);

    this.#stmts.debriefCountToday = this.#db.prepare(`
      SELECT COUNT(*) as cnt FROM session_behaviors
      WHERE debrief_status = 'debriefed'
        AND debriefed_at >= @today
    `);

    // Restore lastDebriefAt from DB to survive restarts
    try {
      const lastRow = this.#db.prepare(`
        SELECT debriefed_at FROM session_behaviors
        WHERE debrief_status = 'debriefed' AND debriefed_at IS NOT NULL
        ORDER BY debriefed_at DESC LIMIT 1
      `).get();
      if (lastRow?.debriefed_at) {
        this.#lastDebriefAt = new Date(lastRow.debriefed_at).getTime();
        console.log(`         → BehaviorLogger restored lastDebriefAt: ${lastRow.debriefed_at}`);
      }
    } catch (e) {
      console.warn(`[BehaviorLogger] Failed to restore lastDebriefAt: ${e.message}`);
    }

    // Restore today's debrief count from DB
    const today = new Date().toISOString().slice(0, 10);
    this.#debriefsTodayDate = today;
    try {
      const row = this.#stmts.debriefCountToday.get({ today });
      this.#debriefsTodayCount = row?.cnt || 0;
    } catch { this.#debriefsTodayCount = 0; }

    console.log('         → BehaviorLogger schema ready');
  }

  // ─── Source derivation (mirrors main.js logic) ────────────────────────

  /** Derive a canonical source tag from sessionId */
  static deriveSource(sessionId) {
    const sid = sessionId || '';
    if (sid.startsWith('tg:'))          return 'telegram:founder';
    if (sid.startsWith('dashboard'))    return 'dashboard:founder';
    if (sid.startsWith('curiosity'))    return 'autonomous:curiosity';
    if (sid.startsWith('wakeup') || sid.startsWith('mimir'))
                                        return 'autonomous:wakeup';
    if (sid.startsWith('cron-'))        return `cron:${sid.replace('cron-', '').split('-')[0] || 'unknown'}`;
    if (sid.startsWith('pk-') || sid.startsWith('socratic'))
                                        return `socratic:${sid.split(':')[1] || 'pk'}`;
    return 'unknown';
  }

  // ─── Event handlers (called from main.js listeners) ───────────────────

  /**
   * Called on every `runtime.on('turn')` event.
   * Accumulates behavioral signals for the session.
   */
  recordTurn({ sessionId, userMessage, response, toolsUsed, toolRounds, usage, stopReason, compacted, duration }) {
    const s = this.#getOrCreate(sessionId);

    s.turn_count++;
    s.stop_reason = stopReason || s.stop_reason;
    if (compacted) s.compacted = 1;

    // Accumulate duration from each turn (ms → s)
    if (duration > 0) s.duration_s += Math.round(duration / 1000);

    // Conversation metrics
    if (userMessage) {
      s.user_message_count++;
      s.user_message_chars += userMessage.length;
    }
    if (response) {
      s.assistant_message_chars += response.length;

      // Extract DEBRIEF_HINT markers from agent response
      const hints = BehaviorLogger.extractHints(response);
      if (hints.length > 0) {
        s.hints.push(...hints);
      }
    }

    // Token tracking
    if (usage) {
      s.total_tokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
    }

    // Tool usage — toolsUsed is a deduplicated array of tool NAME strings
    // toolRounds is the actual number of tool-use rounds in this turn
    if (toolsUsed && toolsUsed.length > 0) {
      s.tool_calls_total += (toolRounds || toolsUsed.length);
      for (const name of toolsUsed) {
        s._tools_used_set.add(name);
      }
    }
  }

  /**
   * Called on every `runtime.on('toolCall')` event.
   * Extracts file paths and star map operations from tool inputs.
   */
  recordToolCall({ sessionId, name, input }) {
    const s = this.#getOrCreate(sessionId);

    // File modifications
    if ((name === 'file_write' || name === 'file_edit' || name === 'Write' || name === 'Edit') && input) {
      const path = input.file_path || input.path || '';
      if (path) {
        s._files_modified_set.add(path);
        // Track code changes
        if (/\.(js|py|sh|ts|cjs|mjs|json)$/i.test(path)) {
          s.code_changes = 1;
        }
      }
    }

    // File reads
    if ((name === 'file_read' || name === 'Read') && input) {
      const path = input.file_path || input.path || '';
      if (path) s._files_read_set.add(path);
    }

    // Star map writes
    if (name === 'constellation_remember' && input) {
      s.star_map_writes++;
      // Try to extract node id from input (may not always be available)
      const nodeId = input.id || input.node_id || '';
      if (nodeId) s._star_map_node_ids_set.add(nodeId);
    }
  }

  // ─── Session lifecycle ────────────────────────────────────────────────

  /**
   * Finalize a session: compute significance, persist to DB, check trigger.
   * Called from telegram.js session end or cron session end.
   * @param {string} sessionId
   * @param {string} [status] - 'completed' | 'timeout' | 'error'
   */
  finalizeSession(sessionId, status = 'completed') {
    const s = this.#sessions.get(sessionId);
    if (!s) return; // no data recorded for this session

    s.ended_at = new Date().toISOString();
    s.stop_reason = status;

    // L2: Infer likely node type from behavioral signals
    s.likely_nt = this.#inferLikelyNt(s);

    // Compute significance
    const { score, breakdown } = this.#computeSignificance(s);
    s.significance_score = score;
    s.significance_breakdown = breakdown;

    // Persist to DB
    try {
      this.#stmts.insert.run({
        session_id:             s.session_id,
        source:                 s.source,
        started_at:             s.started_at,
        ended_at:               s.ended_at,
        duration_s:             s.duration_s,
        tool_calls_total:       s.tool_calls_total,
        tools_used:             JSON.stringify([...s._tools_used_set]),
        files_modified:         JSON.stringify([...s._files_modified_set]),
        files_read:             JSON.stringify([...s._files_read_set]),
        star_map_writes:        s.star_map_writes,
        star_map_node_ids:      JSON.stringify([...s._star_map_node_ids_set]),
        code_changes:           s.code_changes,
        user_message_count:     s.user_message_count,
        user_message_chars:     s.user_message_chars,
        assistant_message_chars: s.assistant_message_chars,
        total_tokens:           s.total_tokens,
        stop_reason:            s.stop_reason,
        compacted:              s.compacted,
        turn_count:             s.turn_count,
        hints:                  JSON.stringify(s.hints),
        significance_score:     s.significance_score,
        significance_breakdown: JSON.stringify(s.significance_breakdown),
        likely_nt:              s.likely_nt || null,
      });
    } catch (e) {
      console.warn(`[BehaviorLogger] Failed to persist session ${sessionId}: ${e.message}`);
    }

    // Clean up in-memory session
    this.#sessions.delete(sessionId);

    // Evict stale sessions (>2 hours old, never finalized — e.g. process crash during session)
    const staleThreshold = Date.now() - 7_200_000; // 2 hours
    for (const [sid, sess] of this.#sessions) {
      if (new Date(sess.started_at).getTime() < staleThreshold) {
        console.warn(`[Anamnesis] Evicting stale session: ${sid} (started ${sess.started_at})`);
        this.#sessions.delete(sid);
      }
    }

    // Check if debrief should trigger
    this.#maybeDebrief(score);
  }

  // ─── Debrief trigger logic ────────────────────────────────────────────

  /**
   * Check cumulative pending significance and trigger debrief if warranted.
   */
  #maybeDebrief(latestScore) {
    if (!this.onDebriefTrigger) return;

    // Startup cooldown: don't trigger debrief within first 5 minutes after engine restart
    // This prevents immediate debrief on restart from consuming stale pending sessions
    if (Date.now() - this.#startupTime < STARTUP_COOLDOWN_MS) return;

    // Adaptive cooldown: gap grows with today's debrief count
    // + penalty if last debrief was unproductive (skip/empty delta)
    const today = new Date().toISOString().slice(0, 10);
    if (this.#debriefsTodayDate !== today) {
      this.#debriefsTodayDate = today;
      try {
        const row = this.#stmts.debriefCountToday.get({ today });
        this.#debriefsTodayCount = row?.cnt || 0;
      } catch { this.#debriefsTodayCount = 0; }
    }

    const adaptiveGap = BASE_GAP_MS * (1 + GAP_GROWTH_FACTOR * this.#debriefsTodayCount)
                      + (this.#lastDebriefProductive ? 0 : SKIP_PENALTY_MS);
    if (Date.now() - this.#lastDebriefAt < adaptiveGap) return;

    // Immediate trigger for high-significance sessions (bypasses cumulative check, not cooldown)
    if (latestScore >= IMMEDIATE_THRESHOLD) {
      this.#fireDebrief();
      return;
    }

    // Cumulative check with decay
    const pending = this.#stmts.pending.all();
    let cumulative = 0;
    const now = Date.now();
    for (const row of pending) {
      const endedAt = row.ended_at ? new Date(row.ended_at).getTime() : now;
      const hoursSince = Math.max(0, (now - endedAt) / 3_600_000);
      cumulative += row.significance_score * Math.pow(DECAY_PER_HOUR, hoursSince);
    }

    if (cumulative >= TRIGGER_THRESHOLD) {
      this.#fireDebrief();
    }
  }

  #fireDebrief() {
    const pending = this.#stmts.pending.all()
      .filter(s => s.significance_score > 0);   // skip score=0 sessions (no signal to debrief)
    if (pending.length === 0) return;

    this.#lastDebriefAt = Date.now();
    this.#debriefsTodayCount++;

    const nextGapMin = Math.round(BASE_GAP_MS * (1 + GAP_GROWTH_FACTOR * this.#debriefsTodayCount) / 60_000);
    console.log(`[Anamnesis] ── Debrief triggered ── ${pending.length} pending session(s) | today: #${this.#debriefsTodayCount} | next cooldown: ~${nextGapMin}min`);

    try {
      // Callback may be async (Layer 3 calls LLM) — fire-and-forget with error logging
      Promise.resolve(this.onDebriefTrigger(pending)).catch(e => {
        console.error(`[BehaviorLogger] Async debrief callback error: ${e.message}`);
      });
    } catch (e) {
      console.warn(`[BehaviorLogger] Debrief callback error: ${e.message}`);
    }
  }

  // ─── L2: Passive node-type inference (pure rule-based, zero LLM) ─────

  /**
   * Infer the most likely node_type from behavioral signals.
   * Used as L2 fallback when agent doesn't provide nt in DEBRIEF_HINT.
   * @param {object} s - in-memory session accumulator
   * @returns {string|null} - inferred node type or null if ambiguous
   */
  #inferLikelyNt(s) {
    // L1 takes priority: if any hint already has nt, use the most common one
    const hintNts = s.hints.filter(h => h.nt).map(h => h.nt);
    if (hintNts.length > 0) {
      // Return the most frequent nt from hints
      const freq = {};
      for (const nt of hintNts) freq[nt] = (freq[nt] || 0) + 1;
      return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Collect signals from tools and file paths
    const tools = [...s._tools_used_set];
    const files = [...s._files_modified_set, ...s._files_read_set];

    // Score each candidate type
    const scores = {};
    const add = (type, weight) => { scores[type] = (scores[type] || 0) + weight; };

    // ── Engineering signals ──
    if (s.code_changes) add('engineering', 3);
    const codeTools = ['exec', 'Bash', 'file_write', 'Write', 'file_edit', 'Edit'];
    if (tools.some(t => codeTools.includes(t))) add('engineering', 2);
    if (files.some(f => /\.(js|py|ts|cjs|mjs|sh|sql)$/i.test(f))) add('engineering', 1);

    // ── Relationship / interaction signals ──
    // Star map writes with relationship-related node IDs
    const nodeIds = [...s._star_map_node_ids_set];
    if (nodeIds.some(id => /^(rel-|person-|interaction-)/.test(id))) add('relationship', 3);

    // ── Experiment signals ──
    if (nodeIds.some(id => /^(exp-|experiment-)/.test(id))) add('experiment', 3);
    if (files.some(f => /benchmark|experiment|test-result/i.test(f))) add('experiment', 2);

    // ── Observation signals ──
    if (nodeIds.some(id => /^(obs-)/.test(id))) add('observation', 2);

    // ── Theory signals ──
    if (nodeIds.some(id => /^(theory-|kc-)/.test(id))) add('theory', 2);

    // ── Decision signals ──
    if (nodeIds.some(id => /^(decision-)/.test(id))) add('decision', 3);

    // ── Introspection signals ──
    if (nodeIds.some(id => /^(intro-|introspection-)/.test(id))) add('introspection', 2);

    // ── Diary signals (autonomous sessions with no code changes) ──
    if (s.source.startsWith('cron:diary') || s.source.startsWith('cron:dream')) {
      add('diary', 3);
    }

    // ── Reading-note signals ──
    if (nodeIds.some(id => /^(reading-|book-)/.test(id))) add('reading-note', 2);
    if (files.some(f => /reading-note|book-note/i.test(f))) add('reading-note', 2);

    // ── Milestone signals ──
    if (nodeIds.some(id => /^(milestone-)/.test(id))) add('milestone', 3);

    // ── Social-rule / language-template signals ──
    if (nodeIds.some(id => /^(social-rule-)/.test(id))) add('social-rule', 2);
    if (nodeIds.some(id => /^(lang-|template-)/.test(id))) add('language-template', 2);

    // Pick the highest-scoring type, but only if it has a clear lead
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;
    if (sorted.length === 1) return sorted[0][0];
    // Require at least 1.5x lead over second-place to avoid ambiguity
    if (sorted[0][1] >= sorted[1][1] * 1.5) return sorted[0][0];
    // Tied or close — return top but mark confidence is lower (still useful as L2)
    return sorted[0][0];
  }

  // ─── Significance scoring ─────────────────────────────────────────────

  #computeSignificance(s) {
    const mul = SOURCE_WEIGHTS[s.source] || 0.5;
    let score = 0;
    const breakdown = {};

    // Engineering behavior (strongest signal)
    if (s.code_changes) {
      breakdown.code_changes = 3;
      score += 3;
    }
    if (s.star_map_writes > 0) {
      const v = Math.min(s.star_map_writes * 1.5, 4);
      breakdown.star_map = v;
      score += v;
    }

    // Tool density (direct observation — may be 0 due to CLI-internal tool execution)
    if (s.tool_calls_total >= 5) {
      breakdown.tool_density = 2;
      score += 2;
    }

    // Response complexity proxy — compensates for Claude CLI handling tools internally
    // (agent-runtime never sees tool_use blocks, so tool_calls_total stays 0)
    if (s.tool_calls_total === 0 && s.assistant_message_chars > 0) {
      const avgResponseLen = s.assistant_message_chars / Math.max(s.turn_count, 1);
      // Long avg responses (>3000 chars) with multiple turns = substantive work session
      if (avgResponseLen > 3000 && s.turn_count >= 2) {
        breakdown.response_complexity = 2;
        score += 2;
      } else if (avgResponseLen > 1500 && s.turn_count >= 3) {
        breakdown.response_complexity = 1.5;
        score += 1.5;
      }
    }

    // Conversation depth
    if (s.duration_s > 300) {   // > 5 minutes
      breakdown.deep_session = 1;
      score += 1;
    }
    if (s.user_message_count >= 5) {
      breakdown.multi_turn = 1;
      score += 1;
    }

    // Heavy user input — founder sending substantial text indicates important session
    if (s.user_message_chars > 2000) {
      breakdown.heavy_input = 1;
      score += 1;
    }

    // Token consumption proxy — high token usage = tool-heavy session inside CLI
    // CLI-internal tool calls (Read/Write/Edit/Bash) are invisible to agent-runtime,
    // but each round consumes thousands of tokens. This compensates for tool_calls_total=0.
    if (s.total_tokens >= 80000) {
      breakdown.token_heavy = 3;   // very heavy session (80K+ = many tool rounds)
      score += 3;
    } else if (s.total_tokens >= 40000) {
      breakdown.token_heavy = 2;   // substantial session
      score += 2;
    } else if (s.total_tokens >= 15000) {
      breakdown.token_heavy = 1;   // moderate session
      score += 1;
    }

    // Agent debrief hints (highest-priority signal)
    if (s.hints.length > 0) {
      const v = s.hints.length * 3;
      breakdown.agent_hints = v;
      score += v;
    }

    // Apply source weight
    score *= mul;
    breakdown._multiplier = mul;
    breakdown._raw_score = Math.round((score / mul) * 10) / 10;

    return {
      score: Math.round(score * 10) / 10,
      breakdown,
    };
  }

  // ─── DEBRIEF_HINT extraction ──────────────────────────────────────────

  /**
   * Extract DEBRIEF hint markers from an agent response.
   * @param {string} text - The raw response text
   * @returns {Array<{type: string, summary: string, targets: string[]}>}
   */
  static extractHints(text) {
    if (!text || !text.includes('DEBRIEF:')) return [];
    const hints = [];
    let m;
    // Reset lastIndex for global regex
    HINT_RE.lastIndex = 0;
    while ((m = HINT_RE.exec(text)) !== null) {
      try {
        const h = JSON.parse(m[1]);
        if (h.t && h.s) {
          hints.push({
            type: h.t,
            summary: h.s,
            targets: h.k || [],
            nt: h.nt || undefined,
          });
        }
      } catch { /* malformed hint — skip */ }
    }
    return hints;
  }

  /**
   * Strip DEBRIEF hint markers from response text before sending to user.
   * @param {string} text
   * @returns {string}
   */
  static stripHints(text) {
    if (!text || !text.includes('DEBRIEF:')) return text;
    return text.replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '').trim();
  }

  /**
   * Extract TASK_TOUCH self-marked hints (Ratatoskr L0). Schema:
   *   { task_id: string, status?: 'pending'|'in_progress'|'code-done'|'completed'|'blocked'|'suspended',
   *     note?: string (≤500 chars), reason?: string }
   * Returns parsed payloads with the safe subset of fields. Unknown statuses
   * and missing task_id are dropped.
   * @param {string} text
   * @returns {Array<{task_id:string, status?:string, note?:string, reason?:string}>}
   */
  static extractTaskTouches(text) {
    if (!text || !text.includes('TASK_TOUCH:')) return [];
    const ALLOWED_STATUS = new Set(['pending','in_progress','code-done','completed','blocked','suspended']);
    const out = [];
    let m;
    TASK_TOUCH_RE.lastIndex = 0;
    while ((m = TASK_TOUCH_RE.exec(text)) !== null) {
      try {
        const p = JSON.parse(m[1]);
        if (typeof p?.task_id !== 'string' || !p.task_id.trim()) continue;
        const rec = { task_id: p.task_id.trim().slice(0, 200) };
        if (typeof p.status === 'string' && ALLOWED_STATUS.has(p.status)) rec.status = p.status;
        if (typeof p.note === 'string') rec.note = p.note.slice(0, 500);
        if (typeof p.reason === 'string') rec.reason = p.reason.slice(0, 500);
        out.push(rec);
      } catch { /* malformed — skip */ }
    }
    return out;
  }

  /**
   * Extract COGNITIVE_TOUCH self-marked hints (Ratatoskr L0). Schema:
   *   { line: string (≤200 chars, no newlines), topic?: string, reason?: string }
   * Lines with newlines or empty after trim are dropped.
   * @param {string} text
   * @returns {Array<{line:string, topic?:string, reason?:string}>}
   */
  static extractCognitiveTouches(text) {
    if (!text || !text.includes('COGNITIVE_TOUCH:')) return [];
    const out = [];
    let m;
    COGNITIVE_TOUCH_RE.lastIndex = 0;
    while ((m = COGNITIVE_TOUCH_RE.exec(text)) !== null) {
      try {
        const p = JSON.parse(m[1]);
        if (typeof p?.line !== 'string') continue;
        const line = p.line.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
        if (!line) continue;
        const rec = { line };
        if (typeof p.topic === 'string') rec.topic = p.topic.slice(0, 80);
        if (typeof p.reason === 'string') rec.reason = p.reason.slice(0, 300);
        out.push(rec);
      } catch { /* malformed — skip */ }
    }
    return out;
  }

  /**
   * Extract RESTART_TOUCH self-marked hints (Ratatoskr L0). Schema:
   *   { reason: string (≤200 chars), delay_ms?: number (clamped to [500, 10000]) }
   * Multi-hint responses keep only the first valid entry — restart is single-shot.
   * @param {string} text
   * @returns {Array<{reason:string, delay_ms:number}>}
   */
  static extractRestartTouches(text) {
    if (!text || !text.includes('RESTART_TOUCH:')) return [];
    const out = [];
    let m;
    RESTART_TOUCH_RE.lastIndex = 0;
    while ((m = RESTART_TOUCH_RE.exec(text)) !== null) {
      try {
        const p = JSON.parse(m[1]);
        if (typeof p?.reason !== 'string' || !p.reason.trim()) continue;
        const reason = p.reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
        let delay_ms = Number.isFinite(p.delay_ms) ? Math.round(p.delay_ms) : 2000;
        delay_ms = Math.max(500, Math.min(delay_ms, 10000));
        out.push({ reason, delay_ms });
        break;   // single-shot — first valid hint wins
      } catch { /* malformed — skip */ }
    }
    return out;
  }

  // Note: per-channel strip sites (telegram.js / dashboard.js / conversation-logger.js)
  // use inline regex `/<!--\s*(?:TASK|COGNITIVE|RESTART)_TOUCH:[\s\S]+?-->/g`
  // — same pattern as ANY_TOUCH_PROBE above. A central helper would force every
  // user-facing channel to import BehaviorLogger as a value (currently only
  // main.js does), so we keep the regex co-located with each channel's strip
  // logic. If a 5th strip site appears, revisit this trade-off.

  // ─── L3: Post-turn audit (synthetic hint generation) ─────────────────

  /**
   * Get the current hint count for an in-memory session.
   * @param {string} sessionId
   * @returns {number}
   */
  getSessionHintCount(sessionId) {
    const s = this.#sessions.get(sessionId);
    return s ? s.hints.length : 0;
  }

  /**
   * L3: If a turn had significant signals but no DEBRIEF_HINT was produced,
   * synthesize a minimal hint from behavioral signals. Zero LLM cost.
   * @param {string} sessionId
   * @param {object} turnData - { toolsUsed, response, ... }
   */
  maybeSynthesizeHint(sessionId, turnData) {
    const s = this.#sessions.get(sessionId);
    if (!s) return;

    // Only synthesize for meaningful sources (founder sessions, not crons)
    const weight = SOURCE_WEIGHTS[s.source] || 0.5;
    if (weight < 0.5) return;

    // Detect significant signals in this turn
    const tools = turnData.toolsUsed || [];
    const hasCodeWork = tools.some(t => ['exec', 'Bash', 'file_write', 'Write', 'file_edit', 'Edit'].includes(t));
    const hasStarMapWrite = tools.includes('constellation_remember');
    const hasSubstantialResponse = (turnData.response || '').length > 2000;

    // Need at least one significant signal
    if (!hasCodeWork && !hasStarMapWrite && !hasSubstantialResponse) return;

    // Infer type from available signals
    let syntheticType = 'observation';
    if (hasCodeWork) syntheticType = 'engineering';
    if (hasStarMapWrite) syntheticType = 'consolidate';

    // Build a minimal synthetic summary from response (first 120 chars of non-empty lines)
    const response = turnData.response || '';
    const firstLine = response.split('\n').find(l => l.trim().length > 20) || '';
    const summary = firstLine.slice(0, 120).trim() || 'Significant turn (auto-detected)';

    s.hints.push({
      type: syntheticType,
      summary,
      targets: [],
      nt: hasCodeWork ? 'engineering' : (hasStarMapWrite ? 'theory' : syntheticType === 'decision' ? 'decision' : undefined),
      _synthetic: true,  // marker for debugging/filtering
    });
  }

  // ─── Query helpers (for Layer 3 / dashboard) ──────────────────────────

  /** Get all pending (un-debriefed) sessions */
  getPending() {
    return this.#stmts.pending.all();
  }

  /** Mark sessions as debriefed after Layer 3 processes them.
   *  @param {boolean} productive — true if delta contained meaningful changes */
  markDebriefed(ids, deltaJson, productive = true) {
    this.#lastDebriefProductive = productive;
    const now = new Date().toISOString();
    const deltaHash = createHash('sha1').update(deltaJson || '').digest('hex').slice(0, 8);
    const primaryId = ids[0];
    const stub = JSON.stringify({ debrief_batch: primaryId, participant: true, delta_hash: deltaHash });
    const tx = this.#db.transaction(() => {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const payload = (i === 0) ? deltaJson : stub;
        this.#stmts.markDebriefed.run({ id, now, delta: payload });
      }
    });
    tx();
  }

  /** Archive old debriefed sessions (called from maintenance cron) */
  archiveOld(days = ARCHIVE_DAYS) {
    const result = this.#stmts.archiveOld.run({ days });
    if (result.changes > 0) {
      console.log(`[BehaviorLogger] Archived ${result.changes} old session behaviors`);
    }
  }

  /** Get summary statistics for dashboard */
  getStats() {
    try {
      const counts = this.#db.prepare(`
        SELECT debrief_status, COUNT(*) as cnt
        FROM session_behaviors
        GROUP BY debrief_status
      `).all();

      const recent = this.#db.prepare(`
        SELECT source, significance_score, started_at, hints, debrief_status
        FROM session_behaviors
        ORDER BY started_at DESC
        LIMIT 10
      `).all();

      return {
        counts: Object.fromEntries(counts.map(r => [r.debrief_status, r.cnt])),
        recent: recent.map(r => ({
          source: r.source,
          score: r.significance_score,
          started: r.started_at,
          hints: JSON.parse(r.hints || '[]').length,
          status: r.debrief_status,
        })),
      };
    } catch {
      return { counts: {}, recent: [] };
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /** Get or create an in-memory session accumulator */
  #getOrCreate(sessionId) {
    if (this.#sessions.has(sessionId)) return this.#sessions.get(sessionId);

    const s = {
      session_id:     sessionId,
      source:         BehaviorLogger.deriveSource(sessionId),
      started_at:     new Date().toISOString(),
      ended_at:       null,
      duration_s:     0,

      tool_calls_total:       0,
      _tools_used_set:        new Set(),
      _files_modified_set:    new Set(),
      _files_read_set:        new Set(),
      star_map_writes:        0,
      _star_map_node_ids_set: new Set(),
      code_changes:           0,

      user_message_count:     0,
      user_message_chars:     0,
      assistant_message_chars: 0,
      total_tokens:           0,
      stop_reason:            null,
      compacted:              0,
      turn_count:             0,

      hints: [],
      likely_nt: null,

      significance_score:     0,
      significance_breakdown: {},
    };

    this.#sessions.set(sessionId, s);
    return s;
  }
}
