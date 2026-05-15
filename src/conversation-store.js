// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module conversation-store
 * @description Manages conversations.db — a universal interaction archive
 * with BGE-M3 (1024-dim) embeddings for semantic retrieval.
 *
 * Stores ALL interactions, not just user-agent dialogue:
 * - Telegram conversations (with the user, future humans)
 * - Cross-agent sessions (with other AIs)
 * - Cron/autonomous reasoning output (internal monologue)
 * - Dashboard interactions
 *
 * Fields: role, content, channel, participant, session_id, embedding
 *
 * Star map = distilled knowledge (brain)
 * Conversations.db = complete interaction history (notebook)
 * Mímir = routing layer (decides what to pull from where)
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = resolve(__dirname, '../conversations.db');

export class ConversationStore {
  /** @type {import('better-sqlite3').Database} */
  #db = null;
  /** @type {object} embedder function (engine._embed) */
  #embedFn = null;
  #stmts = {};
  /** @type {Array<{msgId:number, text:string, attempts:number, lastErr:string}>} */
  #embedRetryQueue = [];
  /** @type {NodeJS.Timeout|null} */
  #embedRetryTimer = null;

  /**
   * @param {string} [dbPath] - Path to conversations.db
   */
  constructor(dbPath = DEFAULT_DB_PATH) {
    this._dbPath = dbPath;
  }

  /** Expose the underlying DB handle for shared-schema modules (e.g. BehaviorLogger) */
  get db() { return this.#db; }

  /**
   * Open DB and create schema.
   * @param {Function} embedFn - async (text) => Buffer (1024-dim Float32Array, BGE-M3)
   */
  async init(embedFn) {
    const Database = (await import('better-sqlite3')).default;
    this.#db = new Database(this._dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('busy_timeout = 5000'); // 5s — matches engine.cjs; prevents timeout during Mímir lock contention
    this.#db.pragma('synchronous = NORMAL'); // fsync on commit only
    this.#embedFn = embedFn;

    // Load sqlite-vec for vector search
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(this.#db);

    // Create tables
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT,
        channel TEXT DEFAULT 'telegram',
        participant TEXT DEFAULT 'founder',
        model TEXT,
        tokens_used INTEGER,
        mimir_snapshot TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_participant ON messages(participant);
    `);

    // Migration: add columns to existing DB if missing
    try {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN channel TEXT DEFAULT 'telegram'`);
    } catch (e) { /* column already exists */ }
    try {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN participant TEXT DEFAULT 'founder'`);
    } catch (e) { /* column already exists */ }
    try {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN mimir_snapshot TEXT`);
    } catch (e) { /* column already exists */ }
    try {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN bookmarked INTEGER DEFAULT 0`);
    } catch (e) { /* column already exists */ }
    try {
      this.#db.exec(`ALTER TABLE messages ADD COLUMN bookmark_label TEXT`);
    } catch (e) { /* column already exists */ }

    // Inbox table for staging pipeline (wide capture → LLM review → promote to star map)
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        summary TEXT,
        source TEXT NOT NULL DEFAULT 'founder_chat',
        session_id TEXT,
        user_id TEXT,
        message_ids TEXT,
        captured_at TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'pending',
        evidence_score REAL DEFAULT 0.0,
        times_referenced INTEGER DEFAULT 0,
        capture_reason TEXT,
        promoted_at TEXT,
        promoted_node_id TEXT,
        reviewer_notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
      CREATE INDEX IF NOT EXISTS idx_inbox_captured ON inbox(captured_at);
    `);
    // Migration: add user_id column to existing inbox (idempotent)
    try {
      this.#db.exec(`ALTER TABLE inbox ADD COLUMN user_id TEXT`);
    } catch (e) { /* column already exists */ }
    try {
      this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_user ON inbox(user_id)`);
    } catch (e) { /* index already exists */ }
    // Dedup: prevent same content+session from being captured twice
    try {
      this.#db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_dedup ON inbox(session_id, content)`);
    } catch (e) { /* index already exists or content too large — non-critical */ }

    // Onboarding orchestration log (sole source of truth for onboarding completion).
    // Spec: 2026-05-01-oss-onboarding-planning.md §22.1 / §23.1 / §23.3.
    // stage is the natural key (e.g. '5-chat', '6-soul-core', '10-telegram').
    // payload holds wizard cross-stage drafts; final values move to profile.json / soul-core.md.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_progress (
        stage TEXT PRIMARY KEY,
        started_at INTEGER,
        completed_at INTEGER,
        payload TEXT
      );
    `);

    // MimirResolver audit table (Phase 1a §4.8). Lives in conversations.db by
    // audit/log convention. Auto-provisioned on first boot so OSS user don't
    // see "resolver_decisions table is missing" warning.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS resolver_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        candidate_text_hash TEXT NOT NULL,
        candidate_subkind TEXT,
        top_k_neighbor_ids TEXT,
        verdict TEXT NOT NULL,
        model TEXT NOT NULL,
        role TEXT NOT NULL,
        latency_ms INTEGER,
        enforced INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_resolver_decisions_ts ON resolver_decisions(ts);
      CREATE INDEX IF NOT EXISTS idx_resolver_decisions_verdict ON resolver_decisions(verdict, ts);
    `);

    // Vector table for embeddings (1024-dim BGE-M3)
    // Check for dimension mismatch BEFORE creating — IF NOT EXISTS won't throw on old 384d table
    try {
      const row = this.#db.prepare('SELECT embedding FROM message_embeddings LIMIT 1').get();
      if (row && row.embedding && row.embedding.length !== 1024 * 4) {
        console.log('[ConversationStore] Migrating message_embeddings from 384d to 1024d...');
        this.#db.exec('DROP TABLE message_embeddings');
      }
    } catch (e) { /* table doesn't exist yet — fine, will be created below */ }
    try {
      this.#db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings
        USING vec0(id INTEGER PRIMARY KEY, embedding float[1024]);
      `);
    } catch (e) {
      if (!e.message.includes('already exists')) throw e;
    }

    // Prepare statements
    // Dedup: add unique index if missing (migration safety)
    try {
      this.#db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(timestamp, role, content)`);
    } catch (e) { /* index already exists */ }

    this.#stmts.insert = this.#db.prepare(`
      INSERT OR IGNORE INTO messages (timestamp, role, content, session_id, channel, participant, model, tokens_used, mimir_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#stmts.insertVec = this.#db.prepare(`
      INSERT INTO message_embeddings (id, embedding) VALUES (?, ?)
    `);
    this.#stmts.count = this.#db.prepare('SELECT COUNT(*) as c FROM messages');
    this.#stmts.recent = this.#db.prepare(`
      SELECT id, timestamp, role, content, session_id, channel, participant
      FROM messages ORDER BY id DESC LIMIT ?
    `);
    this.#stmts.before = this.#db.prepare(`
      SELECT id, timestamp, role, content, session_id, channel, participant
      FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?
    `);
    // Range fetch by message-id for conditional auto-expand. Filter by either
    // exact session_id, a LIKE prefix (system → owner's tg sessions), or none.
    this.#stmts.segmentVerbatimByPrefix = this.#db.prepare(`
      SELECT id, timestamp, role, content, session_id, participant
      FROM messages
      WHERE id >= ? AND id <= ?
        AND session_id LIKE ?
        AND role != 'cortana_internal'
        AND (participant IS NULL OR participant != 'self')
      ORDER BY id ASC
    `);
    this.#stmts.segmentVerbatimAny = this.#db.prepare(`
      SELECT id, timestamp, role, content, session_id, participant
      FROM messages
      WHERE id >= ? AND id <= ?
        AND role != 'cortana_internal'
        AND (participant IS NULL OR participant != 'self')
      ORDER BY id ASC
    `);

    // Inbox prepared statements
    this.#stmts.inboxInsert = this.#db.prepare(`
      INSERT OR IGNORE INTO inbox (content, summary, source, session_id, user_id, message_ids, capture_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.#stmts.inboxPending = this.#db.prepare(`
      SELECT id, content, summary, source, session_id, user_id, message_ids, captured_at,
             evidence_score, times_referenced, capture_reason
      FROM inbox WHERE status = 'pending'
      ORDER BY captured_at ASC LIMIT ?
    `);
    this.#stmts.inboxPendingByUser = this.#db.prepare(`
      SELECT id, content, summary, source, session_id, user_id, message_ids, captured_at,
             evidence_score, times_referenced, capture_reason
      FROM inbox WHERE status = 'pending' AND (user_id = ? OR user_id IS NULL)
      ORDER BY captured_at ASC LIMIT ?
    `);
    this.#stmts.inboxPromote = this.#db.prepare(`
      UPDATE inbox SET status = 'promoted', promoted_at = datetime('now'),
        promoted_node_id = ?, reviewer_notes = ?
      WHERE id = ?
    `);
    this.#stmts.inboxExpire = this.#db.prepare(`
      UPDATE inbox SET status = 'expired', reviewer_notes = ?
      WHERE id = ?
    `);
    this.#stmts.inboxExpireStale = this.#db.prepare(`
      UPDATE inbox SET status = 'expired', reviewer_notes = 'auto-expired after 72h'
      WHERE status = 'pending' AND captured_at < datetime('now', '-72 hours')
    `);
    this.#stmts.inboxStats = this.#db.prepare(`
      SELECT status, COUNT(*) as c FROM inbox GROUP BY status
    `);

    const count = this.#stmts.count.get().c;
    console.log(`         → ConversationStore ready (${count} messages, ${this._dbPath})`);
    return this;
  }

  /**
   * Insert a message into the store with its embedding.
   * Fire-and-forget safe — errors are logged but don't propagate.
   */
  async insert(role, content, { sessionId, channel, participant, model, tokensUsed, mimirSnapshot } = {}) {
    if (!content || !content.trim()) return null;
    // Skip very short noise
    if (content.trim().length < 5) return null;

    try {
      const timestamp = new Date().toISOString();
      const snapshotStr = mimirSnapshot ? (typeof mimirSnapshot === 'string' ? mimirSnapshot : JSON.stringify(mimirSnapshot)) : null;
      const result = this.#stmts.insert.run(
        timestamp, role, content, sessionId || null,
        channel || 'telegram', participant || 'founder',
        model || null, tokensUsed || null, snapshotStr
      );
      const msgId = Number(result.lastInsertRowid);

      // Generate embedding async (don't block).
      // BGE-M3 encoder handles ~8K tokens; char-cap keeps per-message latency bounded.
      if (this.#embedFn) {
        try {
          const textForEmbed = content.slice(0, 1000);
          const embedding = await this.#embedFn(textForEmbed);
          this.#stmts.insertVec.run(BigInt(msgId), embedding);
        } catch (e) {
          // Queue for later retry — without the embedding, this message is
          // invisible to ANN search and cannot be segmented into topic_segments.
          this.#embedRetryQueue.push({ msgId, text: content.slice(0, 1000), attempts: 0, lastErr: e.message });
          console.warn(`  ⚠ ConvStore embed failed (msg ${msgId}): ${e.message} — queued for retry (${this.#embedRetryQueue.length} pending)`);
          this.#scheduleEmbedRetry();
        }
      }
      return { id: msgId, timestamp };
    } catch (e) {
      console.warn(`  ⚠ ConvStore insert failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Kick a debounced retry pass over the embed queue. Exponential-ish:
   * first attempt after 5s, capped at 60s per message. Messages that fail
   * 5 times get dropped (permanent loss — logged once).
   */
  #scheduleEmbedRetry() {
    if (this.#embedRetryTimer) return;
    this.#embedRetryTimer = setTimeout(async () => {
      this.#embedRetryTimer = null;
      if (!this.#embedFn || this.#embedRetryQueue.length === 0) return;
      const pending = this.#embedRetryQueue.splice(0, this.#embedRetryQueue.length);
      let ok = 0;
      for (const item of pending) {
        try {
          const emb = await this.#embedFn(item.text);
          this.#stmts.insertVec.run(BigInt(item.msgId), emb);
          ok++;
        } catch (e) {
          item.attempts += 1;
          item.lastErr = e.message;
          if (item.attempts >= 5) {
            console.warn(`  ⚠ ConvStore embed permanently dropped (msg ${item.msgId} after ${item.attempts} attempts): ${e.message}`);
          } else {
            this.#embedRetryQueue.push(item);
          }
        }
      }
      if (ok > 0) console.warn(`  ✓ ConvStore embed retry recovered ${ok} msgs (${this.#embedRetryQueue.length} still pending)`);
      if (this.#embedRetryQueue.length > 0) {
        this.#embedRetryTimer = setTimeout(() => this.#scheduleEmbedRetry(), 30_000);
        this.#embedRetryTimer.unref?.();
      }
    }, 5_000);
    this.#embedRetryTimer.unref?.();
  }

  /**
   * Retrieve conversation snippets relevant to a query.
   * Uses vector similarity + time decay weighting.
   *
   * @param {string} queryText - Text to search for
   * @param {Object} [opts]
   * @param {number} [opts.limit=10] - Max results
   * @param {number} [opts.timeDecayDays=30] - Half-life in days for time weighting
   * @param {string} [opts.role] - Filter by role ('user'|'assistant')
   * @param {string} [opts.channel] - Filter by channel ('telegram'|'socratic_pk'|'internal'|...)
   * @param {string} [opts.participant] - Filter by participant ('founder'|'chatgpt'|'self'|...)
   * @returns {Promise<Array<{id, timestamp, role, content, session_id, channel, participant, similarity, score}>>}
   */
  async search(queryText, { limit = 10, timeDecayDays = 30, role, channel, participant } = {}) {
    if (!this.#embedFn || !queryText) return [];

    try {
      const queryEmbed = await this.#embedFn(queryText.slice(0, 1000));

      // Vector search: get top candidates (fetch more than needed for time-decay reranking)
      const fetchN = Math.min(limit * 3, 100);
      const vecResults = this.#db.prepare(`
        SELECT id, distance
        FROM message_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(queryEmbed, fetchN);

      if (vecResults.length === 0) return [];

      // Fetch message details for these IDs
      const ids = vecResults.map(r => Number(r.id));
      const placeholders = ids.map(() => '?').join(',');
      const filters = [];
      const filterParams = [];
      if (role) { filters.push('AND role = ?'); filterParams.push(role); }
      if (channel) { filters.push('AND channel = ?'); filterParams.push(channel); }
      if (participant) { filters.push('AND participant = ?'); filterParams.push(participant); }
      const messages = this.#db.prepare(`
        SELECT id, timestamp, role, content, session_id, channel, participant
        FROM messages
        WHERE id IN (${placeholders})
        ${filters.join(' ')}
      `).all(...ids, ...filterParams);

      // Build lookup: id → message
      const msgMap = new Map(messages.map(m => [m.id, m]));

      // Score = similarity × time_weight
      const now = Date.now();
      const halfLifeMs = timeDecayDays * 24 * 60 * 60 * 1000;

      const scored = vecResults
        .filter(r => msgMap.has(Number(r.id)))
        .map(r => {
          const msg = msgMap.get(Number(r.id));
          const similarity = 1 - r.distance; // vec0 returns L2 distance, convert to similarity
          const ageMs = now - new Date(msg.timestamp).getTime();
          const timeWeight = Math.pow(0.5, ageMs / halfLifeMs);
          const score = similarity * 0.7 + timeWeight * 0.3; // 70% relevance, 30% recency
          return { ...msg, similarity, timeWeight, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return scored;
    } catch (e) {
      console.warn(`  ⚠ ConvStore search failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Get recent messages (simple chronological, no embedding needed).
   * @param {number} [limit=20]
   * @param {Object} [opts]
   * @param {string} [opts.ownerUserId] - When set, restrict to owner's tg
   *   session ('tg:{ownerUserId}%') OR non-tg sessions (cron/autonomous/
   *   dashboard, all owner-system in self-host mode). Excludes foreign tg user.
   * @returns {Array}
   */
  getRecent(limit = 20, { ownerUserId } = {}) {
    try {
      if (!ownerUserId) {
        return this.#stmts.recent.all(limit).reverse(); // chronological order
      }
      const rows = this.#db.prepare(`
        SELECT id, timestamp, role, content, session_id, channel, participant
        FROM messages
        WHERE (session_id LIKE ? OR session_id NOT LIKE 'tg:%' OR session_id IS NULL)
        ORDER BY timestamp DESC LIMIT ?
      `).all(`tg:${ownerUserId}%`, limit);
      return rows.reverse();
    } catch {
      return [];
    }
  }

  /**
   * Returns the timestamp (ms epoch) of the most recent owner-channel message
   * (channel='telegram' AND participant='founder' — 'founder' is the historical
   * DB enum value for the primary user; preserved for schema compatibility).
   * Used by the main-active gate to suppress autonomy when the user is actively
   * engaged. Filtering excludes autonomy's own self-writes (channel='autonomous'),
   * which would otherwise cause autonomy to self-suppress in a loop.
   * @returns {number|null} ms-since-epoch, or null if no owner messages exist
   */
  getLastFounderMsgAt() {
    try {
      const row = this.#db.prepare(`
        SELECT timestamp FROM messages
        WHERE channel = 'telegram' AND participant = 'founder'
        ORDER BY id DESC LIMIT 1
      `).get();
      if (!row || !row.timestamp) return null;
      const t = new Date(row.timestamp).getTime();
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * Get messages before a given ID (cursor pagination).
   * @param {number} beforeId - Message ID cursor
   * @param {number} [limit=50]
   * @returns {Array}
   */
  getBefore(beforeId, limit = 50) {
    try {
      return this.#stmts.before.all(beforeId, limit).reverse();
    } catch {
      return [];
    }
  }

  /**
   * Keyword search via SQL LIKE.
   * @param {string} keyword - Search term
   * @param {Object} [opts]
   * @param {string} [opts.from] - Start date YYYY-MM-DD
   * @param {string} [opts.to] - End date YYYY-MM-DD
   * @param {string} [opts.channel] - Channel filter
   * @param {number} [opts.limit=30]
   * @param {number} [opts.offset=0]
   * @returns {{ results: Array, total: number }}
   */
  keywordSearch(keyword, { from, to, channel, limit = 30, offset = 0, ownerUserId } = {}) {
    try {
      const conditions = ['content LIKE ?'];
      const params = [`%${keyword}%`];
      if (from) { conditions.push('timestamp >= ?'); params.push(from); }
      if (to) { conditions.push('timestamp <= ?'); params.push(to + 'T23:59:59'); }
      if (channel) { conditions.push('channel = ?'); params.push(channel); }
      if (ownerUserId) {
        // Restrict to owner's tg session OR system sessions (cron/autonomous/dashboard).
        conditions.push(`(session_id LIKE ? OR session_id NOT LIKE 'tg:%' OR session_id IS NULL)`);
        params.push(`tg:${ownerUserId}%`);
      }
      const where = conditions.join(' AND ');

      const total = this.#db.prepare(
        `SELECT COUNT(*) as c FROM messages WHERE ${where}`
      ).get(...params).c;

      const results = this.#db.prepare(`
        SELECT id, timestamp, role, content, session_id, channel, participant
        FROM messages WHERE ${where}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);

      return { results, total };
    } catch (e) {
      console.warn(`  ⚠ keywordSearch failed: ${e.message}`);
      return { results: [], total: 0 };
    }
  }

  /**
   * Get messages around a specific message ID (for search context).
   * @param {number} messageId - Center message ID
   * @param {number} [range=10] - Number of messages before and after
   * @returns {Array}
   */
  getContext(messageId, range = 10) {
    try {
      return this.#db.prepare(`
        SELECT id, timestamp, role, content, session_id, channel, participant
        FROM messages
        WHERE id >= ? AND id <= ?
        ORDER BY id ASC
      `).all(messageId - range, messageId + range);
    } catch {
      return [];
    }
  }

  /**
   * Get all messages in a date range for export.
   * @param {string} from - Start date YYYY-MM-DD
   * @param {string} to - End date YYYY-MM-DD
   * @param {string} [channel] - Channel filter
   * @returns {Array}
   */
  getForExport(from, to, channel) {
    try {
      const conditions = ['timestamp >= ?', 'timestamp <= ?', "role IN ('user', 'assistant')"];
      const params = [from, to + 'T23:59:59'];
      if (channel && channel !== 'all') { conditions.push('channel = ?'); params.push(channel); }
      return this.#db.prepare(`
        SELECT id, timestamp, role, content, channel, participant
        FROM messages WHERE ${conditions.join(' AND ')}
        ORDER BY timestamp ASC
      `).all(...params);
    } catch {
      return [];
    }
  }

  /**
   * Toggle bookmark on a message.
   * @param {number} messageId
   * @param {boolean} bookmarked
   * @param {string} [label]
   */
  setBookmark(messageId, bookmarked, label) {
    try {
      this.#db.prepare(
        'UPDATE messages SET bookmarked = ?, bookmark_label = ? WHERE id = ?'
      ).run(bookmarked ? 1 : 0, label || null, messageId);
    } catch (e) {
      console.warn(`  ⚠ setBookmark failed: ${e.message}`);
    }
  }

  /**
   * Get all bookmarked messages.
   * @returns {Array}
   */
  getBookmarks() {
    try {
      return this.#db.prepare(`
        SELECT id, timestamp, role, content, channel, participant, bookmark_label
        FROM messages WHERE bookmarked = 1
        ORDER BY timestamp DESC
      `).all();
    } catch {
      return [];
    }
  }

  /**
   * Delete all messages after a given message ID (for conversation fork/rollback).
   * Returns the number of deleted messages.
   */
  deleteAfter(messageId) {
    try {
      const msg = this.#db.prepare('SELECT timestamp FROM messages WHERE id = ?').get(messageId);
      if (!msg) return 0;
      const result = this.#db.prepare(
        'DELETE FROM messages WHERE timestamp > ? OR (timestamp = ? AND id > ?)'
      ).run(msg.timestamp, msg.timestamp, messageId);
      return result.changes;
    } catch (e) {
      console.warn(`  ⚠ deleteAfter failed: ${e.message}`);
      return 0;
    }
  }

  /**
   * Get message count.
   */
  get count() {
    try { return this.#stmts.count.get().c; } catch { return 0; }
  }

  /**
   * Search by time range, optionally scoped to a single session or sessionId prefix.
   * The scope parameter is the single choke-point for multi-user isolation —
   * callers in the raw-injection and rerank-expansion paths must pass either
   * `sessionId` (exact) or `sessionIdLike` (prefix with trailing %) so foreign
   * user' turns never bleed into this user's context window.
   *
   * @param {string} from - ISO date string
   * @param {string} to - ISO date string
   * @param {number} [limit=50]
   * @param {object} [opts]
   * @param {string} [opts.sessionId]     - exact session_id match
   * @param {string} [opts.sessionIdLike] - SQL LIKE pattern (already include %)
   */
  getByTimeRange(from, to, limit = 50, opts = {}) {
    try {
      const { sessionId, sessionIdLike } = opts || {};
      const conditions = ['timestamp >= ?', 'timestamp <= ?'];
      const params = [from, to];
      if (sessionId) {
        conditions.push('session_id = ?');
        params.push(sessionId);
      } else if (sessionIdLike) {
        conditions.push('session_id LIKE ?');
        params.push(sessionIdLike);
      }
      const sql = `
        SELECT id, timestamp, role, content, session_id, channel, participant
        FROM messages
        WHERE ${conditions.join(' AND ')}
        ORDER BY timestamp ASC
        LIMIT ?
      `;
      params.push(limit);
      return this.#db.prepare(sql).all(...params);
    } catch {
      return [];
    }
  }

  /**
   * Range-fetch raw messages belonging to a topic segment for conditional
   * auto-expand. Returns concatenated `[hh:mm] role: content` lines, capped
   * at maxChars with the standard truncation marker.
   *
   * @param {object} opts
   * @param {number} opts.startMsgId
   * @param {number} opts.endMsgId
   * @param {string} [opts.sessionIdLike] - SQL LIKE pattern (caller adds %); falls back to no scope
   * @param {number} [opts.maxChars=3000]
   * @returns {{text:string, msgCount:number, fullChars:number, truncated:boolean}|null}
   */
  getSegmentVerbatim(opts = {}) {
    try {
      const { startMsgId, endMsgId, sessionIdLike, maxChars = 3000 } = opts;
      if (!Number.isInteger(startMsgId) || !Number.isInteger(endMsgId) || endMsgId < startMsgId) {
        return null;
      }
      const rows = sessionIdLike
        ? this.#stmts.segmentVerbatimByPrefix.all(startMsgId, endMsgId, sessionIdLike)
        : this.#stmts.segmentVerbatimAny.all(startMsgId, endMsgId);
      if (!rows || rows.length === 0) return null;
      const lines = rows.map(m => {
        const ts = m.timestamp ? m.timestamp.slice(11, 16) : '?';
        const role = m.role === 'user' ? 'User' : (m.role === 'assistant' ? 'Assistant' : m.role);
        return `[${ts}] ${role}: ${m.content}`;
      });
      const full = lines.join('\n');
      const fullChars = full.length;
      let text = full;
      let truncated = false;
      if (fullChars > maxChars) {
        text = full.slice(0, maxChars) + '\n\n[...truncated for token budget]';
        truncated = true;
      }
      return { text, msgCount: rows.length, fullChars, truncated };
    } catch {
      return null;
    }
  }

  /**
   * Get distinct dates that have messages.
   * @returns {string[]} Array of YYYY-MM-DD strings, newest first
   */
  getDistinctDates() {
    try {
      return this.#db.prepare(`
        SELECT DISTINCT substr(timestamp, 1, 10) as d
        FROM messages
        ORDER BY d DESC
      `).all().map(r => r.d);
    } catch {
      return [];
    }
  }

  // ─── Inbox Methods (staging pipeline for star map promotion) ───────────

  /**
   * Capture a message pair (user + assistant) into inbox for later review.
   * @param {string} content - The user message content
   * @param {Object} opts
   * @param {string} [opts.summary] - One-line summary (generated later by LLM)
   * @param {string} [opts.source='founder_chat'] - Source channel
   * @param {string} [opts.sessionId] - Session ID
   * @param {number[]} [opts.messageIds] - Related message IDs
   * @param {string} [opts.reason] - Why captured
   */
  insertInbox(content, { summary, source = 'founder_chat', sessionId, userId, messageIds, reason } = {}) {
    try {
      this.#stmts.inboxInsert.run(
        content, summary || null, source, sessionId || null,
        userId || null,
        messageIds ? JSON.stringify(messageIds) : null,
        reason || 'auto_capture'
      );
    } catch (e) {
      console.warn(`  ⚠ Inbox insert failed: ${e.message}`);
    }
  }

  /**
   * Get pending inbox items for LLM review. Scope to a user when `userId`
   * is provided so one instance's reviewer can't see another user's queue;
   * NULL user_id rows (legacy, pre-migration) are always visible so they
   * don't get permanently stranded.
   * @param {number} [limit=5]
   * @param {object} [opts]
   * @param {string} [opts.userId] - speakerId (e.g. 'tg:<id>') to scope to
   * @returns {Array}
   */
  getInboxPending(limit = 5, opts = {}) {
    try {
      if (opts && opts.userId) {
        return this.#stmts.inboxPendingByUser.all(opts.userId, limit);
      }
      return this.#stmts.inboxPending.all(limit);
    } catch {
      return [];
    }
  }

  /**
   * Mark inbox item as promoted (written to star map).
   * @param {number} id - Inbox item ID
   * @param {string} nodeId - Star map node ID
   * @param {string} [notes] - Reviewer notes
   */
  promoteInbox(id, nodeId, notes) {
    try {
      this.#stmts.inboxPromote.run(nodeId, notes || null, id);
    } catch (e) {
      console.warn(`  ⚠ Inbox promote failed: ${e.message}`);
    }
  }

  /**
   * Mark inbox item as expired/rejected.
   * @param {number} id - Inbox item ID
   * @param {string} [notes] - Why rejected
   */
  expireInbox(id, notes) {
    try {
      this.#stmts.inboxExpire.run(notes || 'rejected by reviewer', id);
    } catch (e) {
      console.warn(`  ⚠ Inbox expire failed: ${e.message}`);
    }
  }

  /**
   * Auto-expire items older than 72 hours.
   * @returns {number} Number of expired items
   */
  expireStaleInbox() {
    try {
      const result = this.#stmts.inboxExpireStale.run();
      return result.changes;
    } catch {
      return 0;
    }
  }

  /**
   * Get inbox statistics.
   * @returns {{ pending: number, promoted: number, expired: number }}
   */
  getInboxStats() {
    try {
      const rows = this.#stmts.inboxStats.all();
      const stats = { pending: 0, promoted: 0, expired: 0 };
      for (const r of rows) stats[r.status] = r.c;
      return stats;
    } catch {
      return { pending: 0, promoted: 0, expired: 0 };
    }
  }

  /**
   * WAL checkpoint before shutdown.
   */
  checkpoint() {
    this.#db?.pragma('wal_checkpoint(TRUNCATE)');
    console.log('  → ConversationStore WAL checkpoint done');
  }

  /**
   * Close the database.
   */
  close() {
    try {
      // Cancel pending embed retry so it can't fire after DB close
      if (this.#embedRetryTimer) {
        clearTimeout(this.#embedRetryTimer);
        this.#embedRetryTimer = null;
      }
      this.#db?.close();
      console.log('  → ConversationStore closed');
    } catch (e) {
      console.warn(`  ⚠ ConvStore close error: ${e.message}`);
    }
  }
}
