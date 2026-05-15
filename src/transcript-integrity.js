// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module transcript-integrity
 * @description Offline transcript scanner / repairer for persisted session history.
 *
 * Focuses on tool-call / tool-result integrity so long-lived sessions don't stay poisoned.
 *
 * The scanner is intentionally provider-aware. For Anthropic compatibility it checks whether
 * session history can be projected into the strict:
 *   assistant(tool_use...) -> user(tool_result...)
 * pattern without orphaned or dangling blocks.
 */

const CHARS_PER_TOKEN = 3.5;

/**
 * @typedef {Object} TranscriptIssue
 * @property {string} sessionId
 * @property {string} issueType
 * @property {'info'|'warn'|'error'} severity
 * @property {string} provider
 * @property {number[]} messageIds
 * @property {Object} details
 */

/**
 * @typedef {Object} RepairAction
 * @property {string} actionType
 * @property {number[]} [messageIds]
 * @property {Object} [details]
 */

export class TranscriptIntegrityManager {
  /** @type {import('better-sqlite3').Database} */
  #db;

  constructor(db) {
    this.#db = db;
    this.ensureTables();
  }

  ensureTables() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT DEFAULT 'anthropic',
        issue_type TEXT NOT NULL,
        severity TEXT DEFAULT 'warn',
        message_ids TEXT DEFAULT '[]',
        details_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_issues_session
        ON transcript_issues(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS transcript_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        mode TEXT DEFAULT 'safe',
        message_ids TEXT DEFAULT '[]',
        details_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_repairs_session
        ON transcript_repairs(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS messages_quarantine (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        original_message_id INTEGER,
        role TEXT,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        token_count INTEGER DEFAULT 0,
        compacted INTEGER DEFAULT 0,
        original_created_at TEXT,
        reason TEXT DEFAULT '',
        quarantined_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_quarantine_session
        ON messages_quarantine(session_id, quarantined_at DESC);
    `);

    this.#ensureColumns('messages', [
      ['tool_name', 'TEXT'],
      ['tool_ok', 'INTEGER'],
      ['tool_latency_ms', 'INTEGER'],
      ['tool_result_bytes', 'INTEGER'],
      ['tool_error_code', 'TEXT'],
      ['tool_batch_id', 'TEXT'],
      ['tool_round', 'INTEGER'],
    ]);

    this.#ensureColumns('messages_quarantine', [
      ['tool_name', 'TEXT'],
      ['tool_ok', 'INTEGER'],
      ['tool_latency_ms', 'INTEGER'],
      ['tool_result_bytes', 'INTEGER'],
      ['tool_error_code', 'TEXT'],
      ['tool_batch_id', 'TEXT'],
      ['tool_round', 'INTEGER'],
    ]);
  }

  #ensureColumns(tableName, definitions) {
    const existing = new Set(
      this.#db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name)
    );
    for (const [name, sqlType] of definitions) {
      if (!existing.has(name)) {
        this.#db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${sqlType}`);
      }
    }
  }

  /**
   * Scan active messages for one or more sessions.
   * @param {Object} [options]
   * @param {string} [options.sessionId]
   * @param {string} [options.provider='anthropic']
   * @param {number} [options.limit]
   * @param {boolean} [options.persist=true]
   * @returns {Object}
   */
  scan(options = {}) {
    const provider = options.provider || 'anthropic';
    const sessionIds = this.#selectSessionIds(options.sessionId, options.limit);
    const runId = `scan-${Date.now()}`;
    const sessions = [];
    const byType = new Map();
    let issueCount = 0;

    const insertIssue = this.#db.prepare(`
      INSERT INTO transcript_issues (run_id, session_id, provider, issue_type, severity, message_ids, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const sessionId of sessionIds) {
      const messages = this.#getMessages(sessionId);
      const issues = this.#scanMessages(sessionId, messages, provider);
      issueCount += issues.length;
      for (const issue of issues) {
        byType.set(issue.issueType, (byType.get(issue.issueType) || 0) + 1);
        if (options.persist !== false) {
          insertIssue.run(
            runId,
            issue.sessionId,
            issue.provider,
            issue.issueType,
            issue.severity,
            JSON.stringify(issue.messageIds || []),
            JSON.stringify(issue.details || {})
          );
        }
      }
      sessions.push({ sessionId, messageCount: messages.length, issueCount: issues.length, issues });
    }

    return {
      runId,
      provider,
      sessionsScanned: sessionIds.length,
      issueCount,
      byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
      sessions,
    };
  }

  /**
   * Repair transcript issues.
   * @param {Object} [options]
   * @param {string} [options.sessionId]
   * @param {'safe'|'aggressive'} [options.mode='safe']
   * @param {boolean} [options.dryRun=false]
   * @param {string} [options.provider='anthropic']
   * @param {number} [options.limit]
   * @returns {Object}
   */
  repair(options = {}) {
    const mode = options.mode || 'safe';
    const provider = options.provider || 'anthropic';
    const sessionIds = this.#selectSessionIds(options.sessionId, options.limit);
    const runId = `repair-${Date.now()}`;
    const sessions = [];
    let repairedSessions = 0;
    let repairedActions = 0;

    const insertRepair = this.#db.prepare(`
      INSERT INTO transcript_repairs (run_id, session_id, action_type, mode, message_ids, details_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const sessionId of sessionIds) {
      const beforeMessages = this.#getMessages(sessionId);
      const beforeIssues = this.#scanMessages(sessionId, beforeMessages, provider);
      const tx = this.#db.transaction(() => {
        const messages = this.#getMessages(sessionId);
        const plan = this.#buildRepairPlan(sessionId, messages, { mode, provider });
        if (!options.dryRun) {
          this.#applyPlan(sessionId, plan, mode);
        }
        return plan;
      });

      const plan = tx();
      if (plan.actions.length > 0) {
        repairedSessions++;
        repairedActions += plan.actions.length;
      }
      if (!options.dryRun) {
        for (const action of plan.actions) {
          insertRepair.run(
            runId,
            sessionId,
            action.actionType,
            mode,
            JSON.stringify(action.messageIds || []),
            JSON.stringify(action.details || {})
          );
        }
      }
      const afterIssues = options.dryRun
        ? beforeIssues
        : this.#scanMessages(sessionId, this.#getMessages(sessionId), provider);

      sessions.push({
        sessionId,
        actions: plan.actions,
        beforeIssueCount: beforeIssues.length,
        afterIssueCount: afterIssues.length,
        verification: this.#verifyMessages(this.#getMessages(sessionId), provider),
      });
    }

    return {
      runId,
      mode,
      provider,
      dryRun: Boolean(options.dryRun),
      sessionsScanned: sessionIds.length,
      repairedSessions,
      repairedActions,
      sessions,
    };
  }

  /**
   * Verify whether active transcript projects cleanly for a provider.
   * @param {Object} [options]
   * @param {string} [options.sessionId]
   * @param {string} [options.provider='anthropic']
   * @param {number} [options.limit]
   * @returns {Object}
   */
  verify(options = {}) {
    const provider = options.provider || 'anthropic';
    const sessionIds = this.#selectSessionIds(options.sessionId, options.limit);
    const sessions = [];
    let ok = 0;

    for (const sessionId of sessionIds) {
      const messages = this.#getMessages(sessionId);
      const verification = this.#verifyMessages(messages, provider);
      if (verification.ok) ok++;
      sessions.push({ sessionId, ...verification });
    }

    return {
      provider,
      sessionsScanned: sessionIds.length,
      okSessions: ok,
      failedSessions: sessionIds.length - ok,
      sessions,
    };
  }

  #selectSessionIds(sessionId, limit) {
    if (sessionId) return [sessionId];
    const rows = this.#db.prepare(`
      SELECT s.id AS session_id
      FROM sessions s
      WHERE EXISTS (
        SELECT 1 FROM messages m
        WHERE m.session_id = s.id AND m.compacted = 0
      )
      ORDER BY s.last_active_at DESC, s.id ASC
      LIMIT ?
    `).all(limit || 1000);
    return rows.map(r => r.session_id);
  }

  #getMessages(sessionId) {
    return this.#db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND compacted = 0
      ORDER BY id ASC
    `).all(sessionId).map(row => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content ?? '',
      rawToolCalls: row.tool_calls,
      toolCalls: this.#parseToolCalls(row.tool_calls),
      toolCallParseOk: row.tool_calls == null ? true : this.#canParseToolCalls(row.tool_calls),
      toolCallId: row.tool_call_id,
      tokenCount: row.token_count ?? 0,
      compacted: Boolean(row.compacted),
      createdAt: row.created_at,
      toolName: row.tool_name ?? null,
      toolOk: row.tool_ok == null ? null : Boolean(row.tool_ok),
      toolLatencyMs: row.tool_latency_ms ?? null,
      toolResultBytes: row.tool_result_bytes ?? null,
      toolErrorCode: row.tool_error_code ?? null,
      toolBatchId: row.tool_batch_id ?? null,
      toolRound: row.tool_round ?? null,
    }));
  }

  #scanMessages(sessionId, messages, provider) {
    const issues = [];
    if (provider !== 'anthropic') return issues;

    if (messages.length > 0 && messages[0].role === 'tool') {
      issues.push(this.#issue(sessionId, 'leading_orphan_tool_result', 'error', provider, [messages[0].id], {
        note: 'Session starts with a tool result and cannot be replayed safely.',
      }));
    }

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'tool') {
        issues.push(this.#issue(sessionId, 'orphan_tool_result', 'error', provider, [msg.id], {
          reason: 'Tool result not directly attached to an assistant tool-call turn.',
          toolCallId: msg.toolCallId || null,
        }));
        i++;
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.rawToolCalls && !msg.toolCallParseOk) {
          issues.push(this.#issue(sessionId, 'malformed_tool_calls_json', 'error', provider, [msg.id], {
            raw: String(msg.rawToolCalls).slice(0, 500),
          }));
        }

        const toolCalls = msg.toolCalls;
        if (toolCalls.length > 0) {
          const analysis = this.#analyzeToolRun(sessionId, msg, messages, i);
          issues.push(...analysis.issues);
          i = analysis.nextIndex;
          continue;
        }
      }

      i++;
    }

    return issues;
  }

  #analyzeToolRun(sessionId, assistantMsg, messages, assistantIndex) {
    const issues = [];
    const toolCalls = assistantMsg.toolCalls;
    const expectedIds = new Set(toolCalls.map(tc => tc.id));
    const seenIds = new Set();
    const duplicateIds = new Set();
    const toolRows = [];

    let j = assistantIndex + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      toolRows.push(messages[j]);
      j++;
    }

    if (toolCalls.some(tc => !tc.id || !tc.name)) {
      issues.push(this.#issue(sessionId, 'malformed_tool_call_entry', 'error', 'anthropic', [assistantMsg.id], {
        note: 'One or more tool_call entries are missing id or name.',
      }));
    }

    if (toolRows.length === 0) {
      issues.push(this.#issue(sessionId, 'dangling_tool_use', 'error', 'anthropic', [assistantMsg.id], {
        missingToolUseIds: [...expectedIds],
      }));
      return { issues, nextIndex: j };
    }

    for (const toolRow of toolRows) {
      if (!toolRow.toolCallId) {
        issues.push(this.#issue(sessionId, 'missing_tool_call_id', 'error', 'anthropic', [toolRow.id], {
          assistantMessageId: assistantMsg.id,
          repairableByInference: expectedIds.size - seenIds.size === 1,
        }));
        continue;
      }

      if (!expectedIds.has(toolRow.toolCallId)) {
        issues.push(this.#issue(sessionId, 'orphan_tool_result', 'error', 'anthropic', [assistantMsg.id, toolRow.id], {
          assistantToolUseIds: [...expectedIds],
          toolCallId: toolRow.toolCallId,
        }));
        continue;
      }

      if (seenIds.has(toolRow.toolCallId)) {
        duplicateIds.add(toolRow.toolCallId);
        issues.push(this.#issue(sessionId, 'duplicate_tool_result', 'warn', 'anthropic', [assistantMsg.id, toolRow.id], {
          toolCallId: toolRow.toolCallId,
        }));
        continue;
      }

      seenIds.add(toolRow.toolCallId);
    }

    for (const expectedId of expectedIds) {
      if (!seenIds.has(expectedId)) {
        issues.push(this.#issue(sessionId, 'missing_tool_result', 'error', 'anthropic', [assistantMsg.id], {
          toolCallId: expectedId,
        }));
      }
    }

    if (duplicateIds.size > 0) {
      issues.push(this.#issue(sessionId, 'tool_run_has_duplicates', 'warn', 'anthropic', [assistantMsg.id], {
        duplicateToolUseIds: [...duplicateIds],
      }));
    }

    return { issues, nextIndex: j };
  }

  #buildRepairPlan(sessionId, messages, { mode, provider }) {
    const actions = [];
    if (provider !== 'anthropic') return { actions };

    const normalizeAssistantToolCalls = (msg) => {
      if (!msg.rawToolCalls) return;
      if (!msg.toolCallParseOk) return;
      const canonical = JSON.stringify(msg.toolCalls);
      if (canonical !== (msg.rawToolCalls ?? null)) {
        actions.push({
          actionType: 'canonicalize_tool_calls',
          messageIds: [msg.id],
          details: { before: String(msg.rawToolCalls).slice(0, 500), after: canonical.slice(0, 500) },
        });
      }
    };

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'tool') {
        actions.push({
          actionType: 'quarantine_orphan_tool_result',
          messageIds: [msg.id],
          details: { reason: 'tool row outside assistant tool-call run', toolCallId: msg.toolCallId || null },
        });
        i++;
        continue;
      }

      if (msg.role === 'assistant') {
        normalizeAssistantToolCalls(msg);

        if (msg.rawToolCalls && !msg.toolCallParseOk) {
          actions.push({
            actionType: 'strip_malformed_tool_calls',
            messageIds: [msg.id],
            details: { raw: String(msg.rawToolCalls).slice(0, 500) },
          });
          i++;
          continue;
        }

        if (msg.toolCalls.length > 0) {
          const expectedIds = new Set(msg.toolCalls.map(tc => tc.id));
          const matchedIds = new Set();
          const usedToolRows = new Set();
          const toolRows = [];
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') {
            toolRows.push(messages[j]);
            j++;
          }

          // First pass: infer missing tool_call_id when there is exactly one unmatched expected call left.
          const duplicates = new Set();
          for (const toolRow of toolRows) {
            if (!toolRow.toolCallId) continue;
            if (expectedIds.has(toolRow.toolCallId) && !matchedIds.has(toolRow.toolCallId)) {
              matchedIds.add(toolRow.toolCallId);
              usedToolRows.add(toolRow.id);
            } else if (expectedIds.has(toolRow.toolCallId)) {
              duplicates.add(toolRow.toolCallId);
            }
          }

          for (const toolRow of toolRows) {
            if (toolRow.toolCallId) continue;
            const remaining = [...expectedIds].filter(id => !matchedIds.has(id));
            if (remaining.length === 1) {
              actions.push({
                actionType: 'fill_missing_tool_call_id',
                messageIds: [toolRow.id],
                details: { inferredToolCallId: remaining[0], assistantMessageId: msg.id },
              });
              matchedIds.add(remaining[0]);
              usedToolRows.add(toolRow.id);
            } else {
              actions.push({
                actionType: 'quarantine_orphan_tool_result',
                messageIds: [toolRow.id],
                details: { reason: 'missing tool_call_id and ambiguous inference', assistantMessageId: msg.id },
              });
            }
          }

          for (const toolRow of toolRows) {
            if (usedToolRows.has(toolRow.id)) continue;
            if (!toolRow.toolCallId || !expectedIds.has(toolRow.toolCallId)) {
              actions.push({
                actionType: 'quarantine_orphan_tool_result',
                messageIds: [toolRow.id],
                details: { reason: 'tool_call_id not present in preceding assistant tool_calls', assistantMessageId: msg.id, toolCallId: toolRow.toolCallId || null },
              });
              continue;
            }
            if (matchedIds.has(toolRow.toolCallId)) {
              actions.push({
                actionType: 'quarantine_duplicate_tool_result',
                messageIds: [toolRow.id],
                details: { assistantMessageId: msg.id, toolCallId: toolRow.toolCallId },
              });
            }
          }

          const survivingIds = new Set();
          for (const toolRow of toolRows) {
            const plannedRemoval = actions.some(a => (a.messageIds || []).includes(toolRow.id) && a.actionType.startsWith('quarantine_'));
            const inferred = actions.find(a => a.actionType === 'fill_missing_tool_call_id' && (a.messageIds || []).includes(toolRow.id));
            if (plannedRemoval) continue;
            const id = inferred?.details?.inferredToolCallId || toolRow.toolCallId;
            if (id && expectedIds.has(id) && !survivingIds.has(id)) survivingIds.add(id);
          }

          const survivingToolCalls = msg.toolCalls.filter(tc => survivingIds.has(tc.id));
          const originalIds = msg.toolCalls.map(tc => tc.id);
          const survivingCallIds = survivingToolCalls.map(tc => tc.id);

          if (survivingToolCalls.length !== msg.toolCalls.length) {
            if (survivingToolCalls.length > 0 || mode === 'aggressive') {
              actions.push({
                actionType: 'shrink_assistant_tool_calls',
                messageIds: [msg.id],
                details: { beforeIds: originalIds, afterIds: survivingCallIds },
              });
            }
          }

          if (survivingToolCalls.length === 0 && msg.toolCalls.length > 0) {
            actions.push({
              actionType: 'strip_assistant_tool_calls',
              messageIds: [msg.id],
              details: { beforeIds: originalIds, placeholderNeeded: !String(msg.content || '').trim() },
            });
          }

          i = j;
          continue;
        }
      }

      i++;
    }

    return { actions: this.#dedupeActions(actions) };
  }

  #dedupeActions(actions) {
    const seen = new Set();
    const result = [];
    for (const action of actions) {
      const key = `${action.actionType}:${JSON.stringify(action.messageIds || [])}:${JSON.stringify(action.details || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(action);
    }
    return result;
  }

  #applyPlan(sessionId, plan, mode) {
    const quarantineStmt = this.#db.prepare(`
      INSERT INTO messages_quarantine (
        session_id, original_message_id, role, content, tool_calls, tool_call_id, token_count, compacted,
        original_created_at, reason, tool_name, tool_ok, tool_latency_ms, tool_result_bytes, tool_error_code, tool_batch_id, tool_round
      )
      SELECT session_id, id, role, content, tool_calls, tool_call_id, token_count, compacted,
             created_at, ?, tool_name, tool_ok, tool_latency_ms, tool_result_bytes, tool_error_code, tool_batch_id, tool_round
      FROM messages WHERE id = ?
    `);
    const deleteStmt = this.#db.prepare('DELETE FROM messages WHERE id = ?');
    const updateToolIdStmt = this.#db.prepare('UPDATE messages SET tool_call_id = ? WHERE id = ?');
    const updateToolCallsStmt = this.#db.prepare('UPDATE messages SET tool_calls = ? WHERE id = ?');
    const stripToolCallsStmt = this.#db.prepare('UPDATE messages SET tool_calls = NULL, content = ?, token_count = ? WHERE id = ?');

    for (const action of plan.actions) {
      const messageId = action.messageIds?.[0];
      switch (action.actionType) {
        case 'canonicalize_tool_calls':
          updateToolCallsStmt.run(action.details.after, messageId);
          break;
        case 'fill_missing_tool_call_id':
          updateToolIdStmt.run(action.details.inferredToolCallId, messageId);
          break;
        case 'quarantine_orphan_tool_result':
        case 'quarantine_duplicate_tool_result': {
          quarantineStmt.run(action.details.reason || action.actionType, messageId);
          deleteStmt.run(messageId);
          break;
        }
        case 'shrink_assistant_tool_calls': {
          const toolCalls = this.#getMessageToolCalls(messageId).filter(tc => action.details.afterIds.includes(tc.id));
          if (toolCalls.length > 0) {
            updateToolCallsStmt.run(JSON.stringify(toolCalls), messageId);
          }
          break;
        }
        case 'strip_assistant_tool_calls':
        case 'strip_malformed_tool_calls': {
          const current = this.#db.prepare('SELECT content FROM messages WHERE id = ?').get(messageId);
          let content = current?.content ?? '';
          if (!String(content).trim()) {
            content = mode === 'aggressive'
              ? '[assistant tool call removed during transcript repair]'
              : '[assistant turn preserved after transcript repair]';
          }
          stripToolCallsStmt.run(content, Math.ceil(String(content).length / CHARS_PER_TOKEN), messageId);
          break;
        }
        default:
          break;
      }
    }
  }

  #getMessageToolCalls(messageId) {
    const row = this.#db.prepare('SELECT tool_calls FROM messages WHERE id = ?').get(messageId);
    return this.#parseToolCalls(row?.tool_calls);
  }

  #verifyMessages(messages, provider) {
    if (provider !== 'anthropic') {
      return { ok: true, issueCount: 0, issues: [] };
    }
    const issues = this.#scanMessages(messages[0]?.sessionId || '', messages, provider);
    return {
      ok: issues.length === 0,
      issueCount: issues.length,
      issues,
    };
  }

  #issue(sessionId, issueType, severity, provider, messageIds, details = {}) {
    return { sessionId, issueType, severity, provider, messageIds, details };
  }

  #canParseToolCalls(raw) {
    try {
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  #parseToolCalls(raw) {
    if (!raw) return [];
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((tc, index) => {
      const args = tc.input ?? tc.arguments ?? tc.function?.arguments ?? {};
      let input = args;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          input = { raw: input };
        }
      }
      return {
        id: tc.id ?? tc.toolCallId ?? null,
        name: tc.name ?? tc.toolName ?? tc.function?.name ?? null,
        input: (input && typeof input === 'object') ? input : {},
        order: index,
      };
    }).filter(Boolean);
  }
}

export default { TranscriptIntegrityManager };
