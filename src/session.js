// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module session
 * @description SQLite-backed session and message persistence for Constellation Engine.
 * 
 * Manages conversation sessions with full message history, compaction support,
 * and token counting. All data stored in the shared constellation.db.
 */

import { randomUUID } from 'node:crypto';
import { deriveCurrentUser } from './user-identity.js';

/**
 * @typedef {Object} Message
 * @property {number} id - Auto-increment ID
 * @property {string} sessionId - Parent session ID
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string} content - Message text
 * @property {Object|null} toolCalls - OpenAI-format tool_calls array
 * @property {string|null} toolCallId - For tool responses, the call ID being answered
 * @property {string|null} toolName - Executed tool name (for tool rows)
 * @property {boolean|null} toolOk - Whether tool execution succeeded
 * @property {number|null} toolLatencyMs - Tool execution latency in ms
 * @property {number|null} toolResultBytes - Serialized tool result size in bytes
 * @property {string|null} toolErrorCode - Structured tool error code, if any
 * @property {string|null} toolBatchId - Unique batch identifier for one assistant tool round
 * @property {number|null} toolRound - Tool loop round number within the turn
 * @property {number} tokenCount - Estimated token count
 * @property {string} createdAt - ISO timestamp
 * @property {boolean} compacted - Whether this message has been compacted away
 */

/**
 * @typedef {Object} Session
 * @property {string} id - UUID
 * @property {string} userId - Owner identifier
 * @property {string} summary - Accumulated compaction summaries
 * @property {string} createdAt - ISO timestamp
 * @property {string} lastActiveAt - ISO timestamp
 * @property {number} messageCount - Total messages in session
 * @property {boolean} isTemp - Whether this is a temporary (cron) session
 */


/**
 * @typedef {Object} ProcessedEvent
 * @property {string} source
 * @property {string} eventId
 * @property {string} sessionId
 * @property {string} eventType
 * @property {string} createdAt
 */

/**
 * @typedef {Object} TurnJournalEntry
 * @property {string} id
 * @property {string} sessionId
 * @property {string} status
 * @property {string} stage
 * @property {string|null} trigger
 * @property {string|null} eventKey
 * @property {string|null} userMessage
 * @property {string|null} error
 * @property {string} createdAt
 * @property {string} updatedAt
 */

// Average chars per token for estimation (conservative for multilingual content)
const CHARS_PER_TOKEN = 3.5;

/**
 * Session and message manager backed by SQLite.
 */
export class SessionManager {
  /** @type {import('better-sqlite3').Database} */
  #db;

  // Prepared statements (lazy-initialized)
  #stmts = {};

  // Session-scoped state for adaptive window management
  // Maps sessionId → { _lastCompactionAt: timestamp_ms }
  // Per-process cache layered over the persisted last_compaction_at column.
  #sessionState = new Map();

  // Engine boot time: a recent restart (often a crash recovery) is treated as
  // a compaction-grade event for a short grace window so post-crash sessions
  // get the wider raw-injection window during recovery.
  #engineBootAt = Date.now();

  // Runtime config (optional)
  #config;

  /**
   * @param {import('better-sqlite3').Database} db - Shared constellation.db handle
   * @param {{engine?: {ir?: {raw_context?: {expanded_hours?: number, expanded_max_turns?: number, max_turns?: number, min_hours?: number}}}}} [config] - Optional config override
   */
  constructor(db, config) {
    this.#db = db;
    this.#config = config || {};
    this.#initTables();
    this.#prepareStatements();
  }

  /**
   * Create tables if they don't exist.
   * Uses WAL mode (likely already set by engine.js).
   */
  #initTables() {
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('busy_timeout = 5000'); // 5s — matches engine.cjs; Mímir batch writes can hold lock for 1-3s
    this.#db.pragma('synchronous = NORMAL'); // fsync on commit only

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        summary TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        last_active_at TEXT DEFAULT (datetime('now')),
        message_count INTEGER DEFAULT 0,
        is_temp INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        token_count INTEGER DEFAULT 0,
        compacted INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_active
        ON messages(session_id, compacted, id);

      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS processed_updates (
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT DEFAULT 'message',
        payload_hash TEXT,
        payload_preview TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (source, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_processed_updates_session_created
        ON processed_updates(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS turn_journal (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'started',
        stage TEXT NOT NULL DEFAULT 'received_user',
        trigger TEXT,
        event_key TEXT,
        user_message TEXT,
        options_json TEXT,
        user_message_id INTEGER,
        final_message_id INTEGER,
        tool_rounds INTEGER DEFAULT 0,
        tools_used_json TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_turn_journal_session_created
        ON turn_journal(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_turn_journal_status_updated
        ON turn_journal(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pending_tool_runs (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turn_journal(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input_json TEXT,
        assistant_message_id INTEGER,
        tool_batch_id TEXT,
        tool_round INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT DEFAULT (datetime('now')),
        finished_at TEXT,
        result_message_id INTEGER,
        result_preview TEXT,
        error_code TEXT,
        error TEXT,
        latency_ms INTEGER,
        result_bytes INTEGER,
        UNIQUE(session_id, tool_call_id)
      );

      CREATE INDEX IF NOT EXISTS idx_pending_tool_runs_session_status
        ON pending_tool_runs(session_id, status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pending_tool_runs_turn
        ON pending_tool_runs(turn_id, started_at DESC);
    `);

    this.#ensureMessageColumns([
      ['tool_name', 'TEXT'],
      ['tool_ok', 'INTEGER'],
      ['tool_latency_ms', 'INTEGER'],
      ['tool_result_bytes', 'INTEGER'],
      ['tool_error_code', 'TEXT'],
      ['tool_batch_id', 'TEXT'],
      ['tool_round', 'INTEGER'],
    ]);

    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_tool_name_created
        ON messages(tool_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_tool_batch
        ON messages(tool_batch_id);
    `);

    this.#ensureTurnColumns([
      ['tool_call_count', 'INTEGER'],
      ['tool_cache_hits', 'INTEGER'],
      ['suppressed_tool_calls', 'INTEGER'],
      ['input_tokens', 'INTEGER'],
      ['output_tokens', 'INTEGER'],
      ['total_tokens', 'INTEGER'],
      ['tool_result_bytes', 'INTEGER'],
      ['planner_invocations', 'INTEGER'],
      ['planner_guardrail_hits', 'INTEGER'],
      ['stop_reason', 'TEXT'],
    ]);

    this.#ensureSessionColumns([
      ['last_compaction_at', 'INTEGER'],
    ]);
  }

  #ensureSessionColumns(definitions) {
    const existing = new Set(
      this.#db.prepare(`PRAGMA table_info(sessions)`).all().map(row => row.name)
    );
    for (const [name, sqlType] of definitions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${sqlType}`);
      }
    }
  }

  #ensureMessageColumns(definitions) {
    const existing = new Set(
      this.#db.prepare(`PRAGMA table_info(messages)`).all().map(row => row.name)
    );

    for (const [name, sqlType] of definitions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${sqlType}`);
      }
    }
  }

  #ensureTurnColumns(definitions) {
    const existing = new Set(
      this.#db.prepare(`PRAGMA table_info(turn_journal)`).all().map(row => row.name)
    );

    for (const [name, sqlType] of definitions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE turn_journal ADD COLUMN ${name} ${sqlType}`);
      }
    }
  }

  /**
   * Prepare reusable statements for performance.
   */
  #prepareStatements() {
    this.#stmts = {
      getSession: this.#db.prepare(
        'SELECT * FROM sessions WHERE id = ?'
      ),
      getSessionByUser: this.#db.prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND is_temp = 0
         ORDER BY last_active_at DESC LIMIT 1`
      ),
      insertSession: this.#db.prepare(
        `INSERT INTO sessions (id, user_id, is_temp)
         VALUES (?, ?, ?)`
      ),
      updateSessionActivity: this.#db.prepare(
        `UPDATE sessions
         SET last_active_at = datetime('now'),
             message_count = message_count + 1
         WHERE id = ?`
      ),
      updateSummary: this.#db.prepare(
        `UPDATE sessions SET summary = ? WHERE id = ?`
      ),
      insertMessage: this.#db.prepare(
        `INSERT INTO messages (
          session_id, role, content, tool_calls, tool_call_id, token_count,
          tool_name, tool_ok, tool_latency_ms, tool_result_bytes, tool_error_code, tool_batch_id, tool_round
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      getActiveMessages: this.#db.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND compacted = 0
         ORDER BY id ASC`
      ),
      getActiveMessagesLimited: this.#db.prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND compacted = 0
         ORDER BY id DESC LIMIT ?`
      ),
      getActiveTokenCount: this.#db.prepare(
        `SELECT COALESCE(SUM(token_count), 0) as total
         FROM messages
         WHERE session_id = ? AND compacted = 0`
      ),
      markCompacted: this.#db.prepare(
        `UPDATE messages SET compacted = 1
         WHERE session_id = ? AND id < ? AND compacted = 0`
      ),
      deleteSession: this.#db.prepare(
        'DELETE FROM sessions WHERE id = ?'
      ),
      deleteSessionMessages: this.#db.prepare(
        'DELETE FROM messages WHERE session_id = ?'
      ),
      insertProcessedUpdate: this.#db.prepare(
        `INSERT OR IGNORE INTO processed_updates (source, event_id, session_id, event_type, payload_hash, payload_preview)
         VALUES (?, ?, ?, ?, ?, ?)`
      ),
      getProcessedUpdate: this.#db.prepare(
        `SELECT * FROM processed_updates WHERE source = ? AND event_id = ?`
      ),
      pruneProcessedUpdates: this.#db.prepare(
        `DELETE FROM processed_updates WHERE created_at < datetime('now', ?)`
      ),
      insertTurnJournal: this.#db.prepare(
        `INSERT INTO turn_journal (id, session_id, status, stage, trigger, event_key, user_message, options_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      updateTurnStage: this.#db.prepare(
        `UPDATE turn_journal
         SET stage = COALESCE(?, stage),
             status = COALESCE(?, status),
             tool_rounds = COALESCE(?, tool_rounds),
             tools_used_json = COALESCE(?, tools_used_json),
             user_message_id = COALESCE(?, user_message_id),
             final_message_id = COALESCE(?, final_message_id),
             error = COALESCE(?, error),
             tool_call_count = COALESCE(?, tool_call_count),
             tool_cache_hits = COALESCE(?, tool_cache_hits),
             suppressed_tool_calls = COALESCE(?, suppressed_tool_calls),
             input_tokens = COALESCE(?, input_tokens),
             output_tokens = COALESCE(?, output_tokens),
             total_tokens = COALESCE(?, total_tokens),
             tool_result_bytes = COALESCE(?, tool_result_bytes),
             planner_invocations = COALESCE(?, planner_invocations),
             planner_guardrail_hits = COALESCE(?, planner_guardrail_hits),
             stop_reason = COALESCE(?, stop_reason),
             updated_at = datetime('now'),
             finished_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE finished_at END
         WHERE id = ?`
      ),
      getTurnJournal: this.#db.prepare(
        `SELECT * FROM turn_journal WHERE id = ?`
      ),
      listRecentTurns: this.#db.prepare(
        `SELECT * FROM turn_journal WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
      ),
      insertPendingToolRun: this.#db.prepare(
        `INSERT INTO pending_tool_runs (id, turn_id, session_id, tool_call_id, tool_name, tool_input_json, assistant_message_id, tool_batch_id, tool_round, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(session_id, tool_call_id) DO UPDATE SET
           turn_id = excluded.turn_id,
           tool_name = excluded.tool_name,
           tool_input_json = excluded.tool_input_json,
           assistant_message_id = excluded.assistant_message_id,
           tool_batch_id = excluded.tool_batch_id,
           tool_round = excluded.tool_round,
           status = 'pending',
           started_at = datetime('now'),
           finished_at = NULL,
           result_message_id = NULL,
           result_preview = NULL,
           error_code = NULL,
           error = NULL,
           latency_ms = NULL,
           result_bytes = NULL`
      ),
      updatePendingToolRun: this.#db.prepare(
        `UPDATE pending_tool_runs
         SET status = ?,
             finished_at = datetime('now'),
             result_message_id = COALESCE(?, result_message_id),
             result_preview = COALESCE(?, result_preview),
             error_code = COALESCE(?, error_code),
             error = COALESCE(?, error),
             latency_ms = COALESCE(?, latency_ms),
             result_bytes = COALESCE(?, result_bytes)
         WHERE turn_id = ? AND tool_call_id = ?`
      ),
      listPendingToolRuns: this.#db.prepare(
        `SELECT * FROM pending_tool_runs WHERE session_id = ? AND status = 'pending' ORDER BY started_at ASC`
      ),
      listStalePendingToolRuns: this.#db.prepare(
        `SELECT * FROM pending_tool_runs WHERE status = 'pending' AND started_at < datetime('now', ?) ORDER BY started_at ASC`
      ),
    };
  }

  /**
   * Estimate token count for a string.
   * Uses character-based heuristic (good enough for budget checks;
   * exact counting done by LLM router on actual API calls).
   * @param {string} text
   * @returns {number}
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Get existing session for user, or create a new one.
   * For single-user mode, this typically returns the one active session.
   * @param {string} userId
   * @returns {Session}
   */
  getOrCreate(userId) {
    const existing = this.#stmts.getSessionByUser.get(userId);
    if (existing) {
      return this.#rowToSession(existing);
    }

    const id = randomUUID();
    this.#stmts.insertSession.run(id, userId, 0);
    return this.#rowToSession(this.#stmts.getSession.get(id));
  }

  /**
   * Create a temporary session (for cron isolated execution).
   * Temp sessions can be deleted after use.
   * @param {string} label - Human-readable label (used as userId)
   * @returns {Session}
   */
  createTemp(label) {
    const id = `temp-${randomUUID()}`;
    this.#stmts.insertSession.run(id, label, 1);
    return this.#rowToSession(this.#stmts.getSession.get(id));
  }

  /**
   * Add a message to a session.
   * @param {string} sessionId
   * @param {Object} msg
   * @param {'system'|'user'|'assistant'|'tool'} msg.role
   * @param {string} msg.content
   * @param {Object} [msg.toolCalls] - Tool calls from assistant
   * @param {string} [msg.toolCallId] - Tool call ID being responded to
   * @param {string} [msg.toolName] - Executed tool name
   * @param {boolean} [msg.toolOk] - Whether the tool succeeded
   * @param {number} [msg.toolLatencyMs] - Tool runtime in ms
   * @param {number} [msg.toolResultBytes] - Serialized tool result bytes
   * @param {string} [msg.toolErrorCode] - Structured tool error code
   * @param {string} [msg.toolBatchId] - Unique batch ID for one assistant tool round
   * @param {number} [msg.toolRound] - Tool loop round number
   * @param {number} [msg.tokenCount] - Pre-computed token count (auto-estimated if omitted)
   * @returns {Message}
   */
  /**
   * Ensure a session row exists (auto-create if missing).
   * @param {string} sessionId
   */
  ensureSession(sessionId, { createIfMissing = true } = {}) {
    const existing = this.#stmts.getSession.get(sessionId);
    if (!existing) {
      if (!createIfMissing) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      // Normalize user_id from the session prefix so all sessions for a given
      // user share the same group key (e.g. all cron tasks → 'cron:auto',
      // owner's tg → 'tg:OWNER_ID'). Falls back to the sessionId for unknown
      // formats so the NOT NULL constraint still holds.
      const derived = deriveCurrentUser(sessionId);
      const userId = derived.speakerId || sessionId;
      this.#stmts.insertSession.run(sessionId, userId, 0);
      return this.#rowToSession(this.#stmts.getSession.get(sessionId));
    }
    return this.#rowToSession(existing);
  }

  addMessage(sessionId, msg) {
    // Auto-create session if it doesn't exist
    this.ensureSession(sessionId, { createIfMissing: true });

    const tokenCount = msg.tokenCount ?? this.estimateTokens(msg.content);
    const toolCallsJson = msg.toolCalls ? JSON.stringify(msg.toolCalls) : null;

    // Retry wrapper to handle "database is locked" from Mímir daemon write contention
    // busy_timeout=5000 handles most cases; this retry catches edge cases where lock is held longer
    let result;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = this.#stmts.insertMessage.run(
          sessionId,
          msg.role,
          msg.content ?? '',
          toolCallsJson,
          msg.toolCallId ?? msg.tool_call_id ?? null,
          tokenCount,
          msg.toolName ?? msg.tool_name ?? null,
          typeof (msg.toolOk ?? msg.tool_ok) === 'boolean' ? Number(msg.toolOk ?? msg.tool_ok) : null,
          msg.toolLatencyMs ?? msg.tool_latency_ms ?? null,
          msg.toolResultBytes ?? msg.tool_result_bytes ?? null,
          msg.toolErrorCode ?? msg.tool_error_code ?? null,
          msg.toolBatchId ?? msg.tool_batch_id ?? null,
          msg.toolRound ?? msg.tool_round ?? null,
        );
        break;
      } catch (e) {
        if (e.message?.includes('locked') && attempt < 4) {
          // Escalating delays: 500ms, 1000ms, 1500ms, 2000ms — gives Mímir time to release lock
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1));
        } else { throw e; }
      }
    }

    try {
      this.#stmts.updateSessionActivity.run(sessionId);
    } catch (e) {
      if (!e.message?.includes('locked')) throw e;
      // Non-critical — skip silently
    }

    return {
      id: Number(result.lastInsertRowid),
      sessionId,
      role: msg.role,
      content: msg.content ?? '',
      toolCalls: msg.toolCalls ?? null,
      toolCallId: msg.toolCallId ?? msg.tool_call_id ?? null,
      toolName: msg.toolName ?? msg.tool_name ?? null,
      toolOk: typeof (msg.toolOk ?? msg.tool_ok) === 'boolean' ? (msg.toolOk ?? msg.tool_ok) : ((msg.toolOk ?? msg.tool_ok) == null ? null : Boolean(msg.toolOk ?? msg.tool_ok)),
      toolLatencyMs: msg.toolLatencyMs ?? msg.tool_latency_ms ?? null,
      toolResultBytes: msg.toolResultBytes ?? msg.tool_result_bytes ?? null,
      toolErrorCode: msg.toolErrorCode ?? msg.tool_error_code ?? null,
      toolBatchId: msg.toolBatchId ?? msg.tool_batch_id ?? null,
      toolRound: msg.toolRound ?? msg.tool_round ?? null,
      tokenCount,
      createdAt: new Date().toISOString(),
      compacted: false,
    };
  }

  /**
   * Load all active (non-compacted) messages for a session.
   * @param {string} sessionId
   * @param {number} [limit] - Max messages to return (newest first if limited)
   * @returns {Message[]}
   */
  getActiveMessages(sessionId, limit) {
    const rows = limit
      ? this.#stmts.getActiveMessagesLimited.all(sessionId, limit).reverse()
      : this.#stmts.getActiveMessages.all(sessionId);
    return rows.map(r => this.#rowToMessage(r));
  }

  /**
   * Get accumulated compaction summary for a session.
   * @param {string} sessionId
   * @returns {string}
   */
  getSummary(sessionId) {
    const session = this.#stmts.getSession.get(sessionId);
    return session?.summary ?? '';
  }

  /**
   * Perform compaction: append new summary text and mark old messages as compacted.
   * @param {string} sessionId
   * @param {string} summary - New summary text to append
   * @param {number} compactBeforeId - Mark messages with id < this as compacted
   */
  compact(sessionId, summary, compactBeforeId) {
    const txn = this.#db.transaction(() => {
      // Append summary (preserve previous summaries with separator)
      const currentSummary = this.getSummary(sessionId);
      const newSummary = currentSummary
        ? `${currentSummary}\n\n---\n\n${summary}`
        : summary;
      this.#stmts.updateSummary.run(newSummary, sessionId);

      // Mark old messages as compacted
      this.#stmts.markCompacted.run(sessionId, compactBeforeId);
    });

    txn();

    // Record compaction timestamp for adaptive window management
    this.recordCompactionTimestamp(sessionId);
  }

  /**
   * Record when compaction occurred for this session. Persists to disk so the
   * adaptive window expansion survives engine restarts (crash + resume).
   * Used to trigger adaptive window expansion (4h→8h) for 12h after compaction.
   * @param {string} sessionId
   */
  recordCompactionTimestamp(sessionId) {
    const now = Date.now();
    if (!this.#sessionState.has(sessionId)) this.#sessionState.set(sessionId, {});
    this.#sessionState.get(sessionId)._lastCompactionAt = now;
    try {
      this.#db.prepare(
        'UPDATE sessions SET last_compaction_at = ? WHERE id = ?'
      ).run(now, sessionId);
    } catch { /* sessions row may not exist yet for transient sessions */ }
  }

  /**
   * Get the adaptive window configuration for this session.
   * Expansion fires when ANY of:
   *   - Engine compaction happened in the last 12h (persisted)
   *   - Engine booted in the last 60min (covers crash-restart recovery — the
   *     freshly-resumed Claude Code-side session needs wider raw context to
   *     reconstruct what its prior incarnation was working on)
   * @param {string} sessionId
   * @returns {{hours: number, maxTurns: number, isExpandedWindow: boolean, reason: string}}
   */
  getAdaptiveWindow(sessionId) {
    const cooldownMs = 12 * 60 * 60 * 1000;
    const bootGraceMs = 60 * 60 * 1000;
    const now = Date.now();

    const rc = (this.#config?.engine?.ir?.raw_context) || {};
    const defaultHours = rc.min_hours ?? 4;
    const defaultMaxTurns = rc.max_turns ?? 80;
    const expandedHours = rc.expanded_hours ?? 8;
    const expandedMaxTurns = rc.expanded_max_turns ?? 120;

    let lastCompaction = (this.#sessionState.get(sessionId) || {})._lastCompactionAt || 0;
    if (!lastCompaction) {
      try {
        const row = this.#db.prepare(
          'SELECT last_compaction_at FROM sessions WHERE id = ?'
        ).get(sessionId);
        if (row && row.last_compaction_at) {
          lastCompaction = row.last_compaction_at;
          if (!this.#sessionState.has(sessionId)) this.#sessionState.set(sessionId, {});
          this.#sessionState.get(sessionId)._lastCompactionAt = lastCompaction;
        }
      } catch { /* table may be mid-migration */ }
    }
    const sinceCompaction = now - lastCompaction;
    const sinceBoot = now - this.#engineBootAt;

    const compactionExpanded = lastCompaction > 0 && sinceCompaction < cooldownMs;
    const bootExpanded = sinceBoot < bootGraceMs;
    const isExpandedWindow = compactionExpanded || bootExpanded;
    const reason = compactionExpanded ? 'compaction' : (bootExpanded ? 'boot_grace' : 'default');

    return {
      hours: isExpandedWindow ? expandedHours : defaultHours,
      maxTurns: isExpandedWindow ? expandedMaxTurns : defaultMaxTurns,
      isExpandedWindow,
      reason,
    };
  }

  /**
   * Get total token count of active (non-compacted) messages.
   * @param {string} sessionId
   * @returns {number}
   */
  getActiveTokenCount(sessionId) {
    const row = this.#stmts.getActiveTokenCount.get(sessionId);
    return row?.total ?? 0;
  }

  /**
   * Delete a temporary session and all its messages.
   * @param {string} sessionId
   */
  deleteTemp(sessionId) {
    const txn = this.#db.transaction(() => {
      this.#stmts.deleteSessionMessages.run(sessionId);
      this.#stmts.deleteSession.run(sessionId);
    });
    txn();
  }

  /**
   * Hard truncate: keep only the most recent N messages, delete the rest.
   * Used as compaction fallback when summarization doesn't reduce tokens enough.
   * @param {string} sessionId
   * @param {number} keepCount - Number of recent messages to keep
   */
  hardTruncate(sessionId, keepCount = 8) {
    const allMessages = this.getActiveMessages(sessionId);
    if (allMessages.length <= keepCount) return;

    let keepStart = Math.max(0, allMessages.length - keepCount);
    keepStart = this.#adjustKeepStartForToolPairing(allMessages, keepStart);

    const toDelete = allMessages.slice(0, keepStart);
    const deleteStmt = this.#db.prepare('DELETE FROM messages WHERE id = ?');
    this.#db.transaction(() => {
      for (const msg of toDelete) deleteStmt.run(msg.id);
    })();
  }

  #adjustKeepStartForToolPairing(messages, startIdx) {
    let start = Math.max(0, startIdx);

    // Never start a kept tail in the middle of a tool-result run.
    // Walk backwards until we either hit the paired assistant tool-call turn
    // or a normal user/assistant boundary.
    while (start > 0 && messages[start]?.role === 'tool') {
      start--;
    }

    return start;
  }


  /**
   * Claim an inbound event idempotently.
   * @param {string} source
   * @param {string} eventId
   * @param {Object} [meta]
   * @param {string} [meta.sessionId]
   * @param {string} [meta.eventType='message']
   * @param {string} [meta.payloadHash]
   * @param {string} [meta.payloadPreview]
   * @returns {boolean} true when newly claimed, false if duplicate
   */
  claimInboundEvent(source, eventId, meta = {}) {
    if (!source || !eventId) throw new Error('source and eventId are required');
    const info = {
      sessionId: meta.sessionId ?? null,
      eventType: meta.eventType ?? 'message',
      payloadHash: meta.payloadHash ?? null,
      payloadPreview: meta.payloadPreview ?? null,
    };
    const result = this.#stmts.insertProcessedUpdate.run(
      source,
      eventId,
      info.sessionId,
      info.eventType,
      info.payloadHash,
      info.payloadPreview,
    );
    return result.changes > 0;
  }

  getInboundEvent(source, eventId) {
    const row = this.#stmts.getProcessedUpdate.get(source, eventId);
    if (!row) return null;
    return {
      source: row.source,
      eventId: row.event_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      createdAt: row.created_at,
    };
  }

  pruneInboundEvents(olderThan = '-7 days') {
    return this.#stmts.pruneProcessedUpdates.run(olderThan).changes;
  }

  startTurn(sessionId, meta = {}) {
    this.ensureSession(sessionId, { createIfMissing: true });
    const id = meta.id || randomUUID();
    this.#stmts.insertTurnJournal.run(
      id,
      sessionId,
      meta.status || 'started',
      meta.stage || 'received_user',
      meta.trigger || 'user',
      meta.eventKey || null,
      meta.userMessage || null,
      meta.options ? JSON.stringify(meta.options) : null,
    );
    return this.getTurn(id);
  }

  updateTurn(turnId, patch = {}) {
    this.#stmts.updateTurnStage.run(
      patch.stage ?? null,
      patch.status ?? null,
      patch.toolRounds ?? null,
      patch.toolsUsed ? JSON.stringify(patch.toolsUsed) : null,
      patch.userMessageId ?? null,
      patch.finalMessageId ?? null,
      patch.error ?? null,
      patch.toolCallCount ?? null,
      patch.toolCacheHits ?? null,
      patch.suppressedToolCalls ?? null,
      patch.inputTokens ?? null,
      patch.outputTokens ?? null,
      patch.totalTokens ?? null,
      patch.toolResultBytes ?? null,
      patch.plannerInvocations ?? null,
      patch.plannerGuardrailHits ?? null,
      patch.stopReason ?? null,
      patch.finishedAt ?? null,
      turnId,
    );
    return this.getTurn(turnId);
  }

  finishTurn(turnId, patch = {}) {
    return this.updateTurn(turnId, {
      ...patch,
      status: patch.status || 'completed',
      stage: patch.stage || 'completed',
      finishedAt: patch.finishedAt || new Date().toISOString(),
    });
  }

  getTurn(turnId) {
    const row = this.#stmts.getTurnJournal.get(turnId);
    return row ? this.#rowToTurn(row) : null;
  }

  listRecentTurns(sessionId, limit = 20) {
    return this.#stmts.listRecentTurns.all(sessionId, limit).map(r => this.#rowToTurn(r));
  }

  registerPendingToolRuns(turnId, sessionId, toolCalls, meta = {}) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 0;
    const tx = this.#db.transaction((calls) => {
      for (const tc of calls) {
        this.#stmts.insertPendingToolRun.run(
          `${turnId}:${tc.id}`,
          turnId,
          sessionId,
          tc.id,
          tc.name,
          tc.input ? JSON.stringify(tc.input) : null,
          meta.assistantMessageId ?? null,
          meta.toolBatchId ?? null,
          meta.round ?? 0,
        );
      }
    });
    tx(toolCalls);
    return toolCalls.length;
  }

  completePendingToolRun(turnId, toolCallId, patch = {}) {
    this.#stmts.updatePendingToolRun.run(
      patch.status || (patch.errorCode || patch.error ? 'failed' : 'completed'),
      patch.resultMessageId ?? null,
      patch.resultPreview ?? null,
      patch.errorCode ?? null,
      patch.error ?? null,
      patch.latencyMs ?? null,
      patch.resultBytes ?? null,
      turnId,
      toolCallId,
    );
  }

  listPendingToolRuns(sessionId) {
    return this.#stmts.listPendingToolRuns.all(sessionId).map(r => this.#rowToPendingToolRun(r));
  }

  listStalePendingToolRuns(olderThan = '-15 minutes') {
    return this.#stmts.listStalePendingToolRuns.all(olderThan).map(r => this.#rowToPendingToolRun(r));
  }

  /**
   * Convert a raw DB row to a Session object.
   * @param {Object} row
   * @returns {Session}
   */
  #rowToSession(row) {
    return {
      id: row.id,
      userId: row.user_id,
      summary: row.summary ?? '',
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      messageCount: row.message_count,
      isTemp: Boolean(row.is_temp),
    };
  }

  #rowToTurn(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      stage: row.stage,
      trigger: row.trigger ?? null,
      eventKey: row.event_key ?? null,
      userMessage: row.user_message ?? null,
      options: row.options_json ? JSON.parse(row.options_json) : null,
      userMessageId: row.user_message_id ?? null,
      finalMessageId: row.final_message_id ?? null,
      toolRounds: row.tool_rounds ?? 0,
      toolsUsed: row.tools_used_json ? JSON.parse(row.tools_used_json) : [],
      error: row.error ?? null,
      toolCallCount: row.tool_call_count ?? 0,
      toolCacheHits: row.tool_cache_hits ?? 0,
      suppressedToolCalls: row.suppressed_tool_calls ?? 0,
      inputTokens: row.input_tokens ?? null,
      outputTokens: row.output_tokens ?? null,
      totalTokens: row.total_tokens ?? null,
      toolResultBytes: row.tool_result_bytes ?? null,
      plannerInvocations: row.planner_invocations ?? 0,
      plannerGuardrailHits: row.planner_guardrail_hits ?? 0,
      stopReason: row.stop_reason ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at ?? null,
    };
  }

  #rowToPendingToolRun(row) {
    return {
      id: row.id,
      turnId: row.turn_id,
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      toolInput: row.tool_input_json ? JSON.parse(row.tool_input_json) : null,
      assistantMessageId: row.assistant_message_id ?? null,
      toolBatchId: row.tool_batch_id ?? null,
      toolRound: row.tool_round ?? 0,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      resultMessageId: row.result_message_id ?? null,
      resultPreview: row.result_preview ?? null,
      errorCode: row.error_code ?? null,
      error: row.error ?? null,
      latencyMs: row.latency_ms ?? null,
      resultBytes: row.result_bytes ?? null,
    };
  }

  /**
   * Convert a raw DB row to a Message object.
   * @param {Object} row
   * @returns {Message}
   */
  #rowToMessage(row) {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : null,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name ?? null,
      toolOk: row.tool_ok == null ? null : Boolean(row.tool_ok),
      toolLatencyMs: row.tool_latency_ms ?? null,
      toolResultBytes: row.tool_result_bytes ?? null,
      toolErrorCode: row.tool_error_code ?? null,
      toolBatchId: row.tool_batch_id ?? null,
      toolRound: row.tool_round ?? null,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      compacted: Boolean(row.compacted),
    };
  }
}
