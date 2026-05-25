// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module restart-resume
 * Shared helpers for restart handoff capsules and pending turn discovery.
 *
 * This intentionally does not resume LLM streams. It only reconstructs enough
 * persisted state for the next turn to continue from the last visible step.
 */

const TERMINAL_STATUSES = ['completed', 'failed', 'interrupted', 'aborted', 'stale'];
const RESUMABLE_STATUSES = ['started', 'interrupted', 'aborted'];
const DEFAULT_EXCLUDED_TRIGGERS = ['mimir_autonomous', 'restart_resume', 'restart_resume_dashboard'];

function cap(value, max = 260) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function hasTable(db, name) {
  try {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  } catch {
    return false;
  }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  } catch {
    return false;
  }
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

export function findInterruptedTurn(db, {
  sessionId = null,
  sessionLike = null,
  lookbackMinutes = 20,
  excludedTriggers = DEFAULT_EXCLUDED_TRIGGERS,
} = {}) {
  if (!db || !hasTable(db, 'turn_journal')) return null;

  const where = [
    `status IN (${placeholders(RESUMABLE_STATUSES)})`,
    `user_message IS NOT NULL`,
    `COALESCE(updated_at, created_at) > datetime('now', ?)`,
  ];
  const params = [...RESUMABLE_STATUSES, `-${Math.max(1, lookbackMinutes)} minutes`];
  if (hasColumn(db, 'turn_journal', 'stop_reason')) {
    where.push(`COALESCE(stop_reason, '') != 'interrupted_by_user'`);
  }

  if (sessionId) {
    where.push(`session_id = ?`);
    params.push(sessionId);
  } else if (sessionLike) {
    where.push(`session_id LIKE ?`);
    params.push(sessionLike);
  }

  if (excludedTriggers?.length) {
    where.push(`COALESCE(trigger, '') NOT IN (${placeholders(excludedTriggers)})`);
    params.push(...excludedTriggers);
  }

  const sql = `
    SELECT t1.* FROM turn_journal t1
    WHERE ${where.join('\n      AND ')}
      AND NOT EXISTS (
        SELECT 1 FROM turn_journal t2
        WHERE t2.session_id = t1.session_id
          AND t2.id != t1.id
          AND t2.status IN (${placeholders(TERMINAL_STATUSES)})
          AND t2.created_at > t1.created_at
      )
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 1`;

  return db.prepare(sql).get(...params, ...TERMINAL_STATUSES) || null;
}

export function hasRecentResume(db, { sessionId = null, minutes = 3 } = {}) {
  if (!db || !hasTable(db, 'turn_journal')) return false;
  const where = [`trigger IN ('restart_resume', 'restart_resume_dashboard')`, `created_at > datetime('now', ?)`];
  const params = [`-${Math.max(1, minutes)} minutes`];
  if (sessionId) {
    where.push(`session_id = ?`);
    params.push(sessionId);
  }
  return !!db.prepare(`SELECT id FROM turn_journal WHERE ${where.join(' AND ')} LIMIT 1`).get(...params);
}

export function markTurnFailedForRestart(db, turnId) {
  if (!db || !turnId || !hasTable(db, 'turn_journal')) return 0;
  const result = db.prepare(
    `UPDATE turn_journal
     SET status='failed', error='engine_restart', finished_at=datetime('now'), updated_at=datetime('now')
     WHERE id=?`
  ).run(turnId);
  return result.changes || 0;
}

export function cleanupStaleInterruptedTurns(db, { olderThanMinutes = 60 } = {}) {
  if (!db || !hasTable(db, 'turn_journal')) return 0;
  const result = db.prepare(
    `UPDATE turn_journal
     SET status='stale', error='cleanup_on_boot', finished_at=datetime('now'), updated_at=datetime('now')
     WHERE status IN (${placeholders(RESUMABLE_STATUSES)})
       AND created_at < datetime('now', ?)`
  ).run(...RESUMABLE_STATUSES, `-${Math.max(1, olderThanMinutes)} minutes`);
  return result.changes || 0;
}

export function buildRestartHandoffCapsule(db, turn, {
  includeRecentAssistant = true,
  maxChars = 3600,
} = {}) {
  try {
    if (!db || !turn?.id || !hasTable(db, 'turn_journal')) return '';
    const toolsUsed = parseJson(turn.tools_used_json, []);
    const lines = [
      `- turn: ${turn.id}`,
      `- session: ${turn.session_id}`,
      `- status/stage: ${turn.status || 'unknown'} / ${turn.stage || 'unknown'}`,
      `- trigger: ${turn.trigger || 'unknown'}`,
      `- updated: ${turn.updated_at || turn.created_at || 'unknown'}`,
    ];

    if (turn.tool_rounds || toolsUsed.length) {
      lines.push(`- progress: tool_rounds=${turn.tool_rounds || 0}; tools_used=${toolsUsed.length ? toolsUsed.join(', ') : '(none recorded)'}`);
    }
    if (turn.error) lines.push(`- last_error: ${cap(turn.error, 320)}`);

    if (hasTable(db, 'pending_tool_runs')) {
      const toolRuns = db.prepare(
        `SELECT tool_name, status, tool_round, error_code, error, result_preview, started_at, finished_at
         FROM pending_tool_runs
         WHERE turn_id = ?
         ORDER BY started_at ASC
         LIMIT 12`
      ).all(turn.id);
      if (toolRuns.length > 0) {
        lines.push('- tool run ledger:');
        for (const run of toolRuns) {
          const bits = [`${run.tool_name || 'unknown'} r${run.tool_round ?? 0}`, run.status || 'unknown'];
          if (run.error_code) bits.push(run.error_code);
          const detail = run.result_preview || run.error;
          lines.push(`  - ${bits.join(' / ')}${detail ? ` — ${cap(detail, 220)}` : ''}`);
        }
      }
    }

    if (hasTable(db, 'messages') && hasColumn(db, 'messages', 'tool_name')) {
      const recentToolMessages = db.prepare(
        `SELECT id, tool_name, tool_ok, tool_error_code, content, created_at
         FROM messages
         WHERE session_id = ?
           AND role = 'tool'
           AND created_at >= datetime(COALESCE(?, created_at), '-5 seconds')
         ORDER BY id DESC
         LIMIT 8`
      ).all(turn.session_id, turn.created_at);
      if (recentToolMessages.length > 0) {
        lines.push('- recent persisted tool results:');
        for (const msg of recentToolMessages.reverse()) {
          const ok = msg.tool_ok === 1 ? 'ok' : (msg.tool_ok === 0 ? 'failed' : 'unknown');
          const code = msg.tool_error_code ? ` / ${msg.tool_error_code}` : '';
          lines.push(`  - #${msg.id} ${msg.tool_name || 'tool'} ${ok}${code}: ${cap(msg.content, 240)}`);
        }
      }
    }

    if (includeRecentAssistant && hasTable(db, 'messages')) {
      const recentAssistantProgress = db.prepare(
        `SELECT id, content, created_at
         FROM messages
         WHERE session_id = ?
           AND role = 'assistant'
           AND created_at < COALESCE(?, datetime('now'))
           AND created_at >= datetime(COALESCE(?, datetime('now')), '-15 minutes')
         ORDER BY id DESC
         LIMIT 2`
      ).all(turn.session_id, turn.created_at, turn.created_at);
      if (recentAssistantProgress.length > 0) {
        lines.push('- recent completed assistant progress before interruption:');
        lines.push('  - use these as already-sent work summaries; do targeted verification only if needed, do not restart from scratch.');
        for (const msg of recentAssistantProgress.reverse()) {
          lines.push(`  - #${msg.id} at ${msg.created_at}: ${cap(msg.content, 520)}`);
        }
      }
    }

    lines.push('- resume rule: continue from the last completed step; verify before claiming code/deploy state; avoid re-running completed external-visible actions.');
    return lines.join('\n').slice(0, maxChars);
  } catch (e) {
    return `- handoff capsule build failed: ${cap(e.message, 240)}`;
  }
}

export function buildContinuationMessage(userMessage, handoffCapsule = '', { locale = 'en' } = {}) {
  if (locale === 'zh') {
    const handoffBlock = handoffCapsule ? `\n\n重启前工作交接胶囊：\n${handoffCapsule}` : '';
    return `[系统自动续接] 引擎刚刚重启完毕。重启前你正在回复的消息是：\n"${userMessage}"${handoffBlock}\n\n请基于交接胶囊继续，不要从头重做已完成的诊断/工具步骤；如果胶囊信息不足，再补最小必要验证。`;
  }
  const handoffBlock = handoffCapsule ? `\n\nRestart handoff capsule:\n${handoffCapsule}` : '';
  return `[System auto-continuation] The engine just finished restarting. The message you were replying to before the restart was:\n"${userMessage}"${handoffBlock}\n\nContinue from the handoff capsule. Do not restart completed diagnosis/tool work; only do targeted verification if needed.`;
}
