// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * task-manager.js — persistent task queue, checkpoints, and recovery journal
 *
 * Provides:
 * - Session checkpoints for crash-resume experiments
 * - Generic task queue used by cron and async subagents
 * - Lease / heartbeat / stale-task recovery helpers for doctor and workers
 */

import Database from 'better-sqlite3';

function nowIso() {
  return new Date().toISOString();
}

function safeParse(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch { return parsed; }
    }
    return parsed;
  } catch {
    return value;
  }
}

class TaskManager {
  constructor(dbPathOrHandle) {
    this.db = typeof dbPathOrHandle?.prepare === 'function'
      ? dbPathOrHandle
      : new Database(dbPathOrHandle);
    this._ownsDb = typeof dbPathOrHandle?.prepare !== 'function';
    this._initTables();
    this._prepare();
    this._recoverOnBoot();
  }

  /**
   * On boot, recover any tasks that were 'running' when the engine last crashed/restarted.
   * These are stale by definition since no worker is alive to finish them.
   */
  _recoverOnBoot() {
    try {
      const result = this.recoverStaleRunningTasks({ olderThanMs: 0 });
      if (result.staleCount > 0) {
        console.log(`  🔧 TaskManager: recovered ${result.staleCount} stale running tasks from previous instance`);
      }
    } catch (e) {
      console.warn(`  ⚠ TaskManager boot recovery failed: ${e.message}`);
    }
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id    TEXT PRIMARY KEY,
        messages      TEXT NOT NULL,
        tool_index    INTEGER DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','cancelled')),
        context          TEXT,
        payload_json     TEXT,
        task_type        TEXT NOT NULL DEFAULT 'generic',
        session_id       TEXT,
        result           TEXT,
        result_preview   TEXT,
        error            TEXT,
        retry_count      INTEGER DEFAULT 0,
        max_retries      INTEGER DEFAULT 3,
        priority         INTEGER DEFAULT 0,
        source           TEXT,
        worker_id        TEXT,
        lease_expires_at TEXT,
        last_heartbeat_at TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        started_at       TEXT,
        completed_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_tasks_type_status ON tasks(task_type, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_status ON tasks(session_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);
    `);

    const existing = new Set(this.db.prepare(`PRAGMA table_info(tasks)`).all().map(r => r.name));
    const ensureColumns = [
      ['payload_json', 'TEXT'],
      ['task_type', `TEXT NOT NULL DEFAULT 'generic'`],
      ['session_id', 'TEXT'],
      ['result_preview', 'TEXT'],
      ['worker_id', 'TEXT'],
      ['lease_expires_at', 'TEXT'],
      ['last_heartbeat_at', 'TEXT'],
    ];
    for (const [name, sqlType] of ensureColumns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${sqlType}`);
    }
  }

  _prepare() {
    this.stmts = {
      insertCheckpoint: this.db.prepare(`
        INSERT INTO checkpoints (session_id, messages, tool_index, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          messages = excluded.messages,
          tool_index = excluded.tool_index,
          updated_at = excluded.updated_at
      `),
      getCheckpoint: this.db.prepare(`SELECT * FROM checkpoints WHERE session_id = ?`),
      clearCheckpoint: this.db.prepare(`DELETE FROM checkpoints WHERE session_id = ?`),
      cleanCheckpoints: this.db.prepare(`DELETE FROM checkpoints WHERE updated_at < ?`),

      insertTask: this.db.prepare(`
        INSERT INTO tasks (
          id, title, status, context, payload_json, task_type, session_id,
          max_retries, priority, source, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getTask: this.db.prepare(`SELECT * FROM tasks WHERE id = ?`),
      listBySession: this.db.prepare(`SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`),
      cancelTask: this.db.prepare(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`),
      completeTask: this.db.prepare(`
        UPDATE tasks
        SET status = 'done', result = ?, result_preview = ?, completed_at = ?, updated_at = ?,
            worker_id = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL
        WHERE id = ?
      `),
      failTask: this.db.prepare(`
        UPDATE tasks
        SET status = ?, error = ?, updated_at = ?,
            worker_id = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
            completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
        WHERE id = ?
      `),
      startTask: this.db.prepare(`
        UPDATE tasks
        SET status = 'running', started_at = ?, updated_at = ?, retry_count = retry_count + 1,
            worker_id = ?, lease_expires_at = ?, last_heartbeat_at = ?
        WHERE id = ?
      `),
      heartbeatTask: this.db.prepare(`
        UPDATE tasks
        SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND (? IS NULL OR worker_id = ?)
      `),
      reclaimTask: this.db.prepare(`
        UPDATE tasks
        SET status = ?, error = ?, updated_at = ?, worker_id = NULL,
            lease_expires_at = NULL, last_heartbeat_at = NULL,
            started_at = CASE WHEN ? = 'pending' THEN NULL ELSE started_at END
        WHERE id = ?
      `),
      stats: this.db.prepare(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`),
      cleanOldTasks: this.db.prepare(`DELETE FROM tasks WHERE status IN ('done', 'cancelled') AND updated_at < ?`),
    };
  }

  checkpoint(sessionId, messages, toolIndex = 0) {
    const now = nowIso();
    this.stmts.insertCheckpoint.run(sessionId, JSON.stringify(messages), toolIndex, now, now);
  }

  restore(sessionId) {
    const row = this.stmts.getCheckpoint.get(sessionId);
    if (!row) return null;
    return { messages: JSON.parse(row.messages), toolIndex: row.tool_index, updatedAt: row.updated_at };
  }

  clearCheckpoint(sessionId) {
    this.stmts.clearCheckpoint.run(sessionId);
  }

  cleanOldCheckpoints() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.stmts.cleanCheckpoints.run(cutoff).changes;
  }

  createTask({ title, context = null, payload = null, taskType = 'generic', sessionId = null, maxRetries = 3, priority = 0, source = 'auto' }) {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = nowIso();
    this.stmts.insertTask.run(
      id,
      title,
      context == null ? null : JSON.stringify(context),
      payload == null ? null : JSON.stringify(payload),
      taskType,
      sessionId,
      maxRetries,
      priority,
      source,
      now,
      now,
    );
    return id;
  }

  getTask(taskId) {
    const row = this.stmts.getTask.get(taskId);
    return row ? this._rowToTask(row) : null;
  }

  listTasks({ status = null, taskType = null, sessionId = null, limit = 20 } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (taskType) { clauses.push('task_type = ?'); params.push(taskType); }
    if (sessionId) { clauses.push('session_id = ?'); params.push(sessionId); }
    params.push(limit);
    const sql = `SELECT * FROM tasks ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params).map(row => this._rowToTask(row));
  }

  listRecentForSession(sessionId, limit = 10) {
    return this.stmts.listBySession.all(sessionId, limit).map(row => this._rowToTask(row));
  }

  getPendingTasks(limit = 10, { taskTypes = null } = {}) {
    const clauses = [`status IN ('pending', 'failed')`, `retry_count < max_retries`];
    const params = [];
    if (Array.isArray(taskTypes) && taskTypes.length > 0) {
      clauses.push(`task_type IN (${taskTypes.map(() => '?').join(',')})`);
      params.push(...taskTypes);
    }
    params.push(limit);
    const sql = `SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY priority DESC, created_at ASC LIMIT ?`;
    return this.db.prepare(sql).all(...params).map(row => this._rowToTask(row));
  }

  startTask(taskId, { workerId = null, leaseMs = 60_000 } = {}) {
    const now = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    this.stmts.startTask.run(now, now, workerId, leaseUntil, now, taskId);
    return this.getTask(taskId);
  }

  claimNextTask({ taskTypes = null, workerId = `worker-${process.pid}`, leaseMs = 60_000, sessionId = null } = {}) {
    const tx = this.db.transaction(() => {
      const clauses = [`status IN ('pending', 'failed')`, `retry_count < max_retries`];
      const params = [];
      if (Array.isArray(taskTypes) && taskTypes.length > 0) {
        clauses.push(`task_type IN (${taskTypes.map(() => '?').join(',')})`);
        params.push(...taskTypes);
      }
      if (sessionId) {
        clauses.push(`session_id = ?`);
        params.push(sessionId);
      }
      const row = this.db.prepare(`SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY priority DESC, created_at ASC LIMIT 1`).get(...params);
      if (!row) return null;
      const now = nowIso();
      const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      this.stmts.startTask.run(now, now, workerId, leaseUntil, now, row.id);
      return this.getTask(row.id);
    });
    return tx();
  }

  heartbeatTask(taskId, { workerId = null, leaseMs = 60_000 } = {}) {
    const now = nowIso();
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    return this.stmts.heartbeatTask.run(now, leaseUntil, now, taskId, workerId, workerId).changes > 0;
  }

  completeTask(taskId, result = null, meta = {}) {
    const now = nowIso();
    const resultJson = result == null ? null : JSON.stringify(result);
    const previewSource = meta.resultPreview || (typeof result === 'string' ? result : (result?.summary || result?.result || resultJson || ''));
    const preview = previewSource ? String(previewSource).slice(0, 800) : null;
    this.stmts.completeTask.run(resultJson, preview, now, now, taskId);
    return this.getTask(taskId);
  }

  failTask(taskId, errorMsg, meta = {}) {
    const now = nowIso();
    const task = this.getTask(taskId);
    if (!task) return null;
    const permanent = Boolean(meta.permanent) || task.retryCount >= task.maxRetries;
    const newStatus = permanent ? 'failed' : 'pending';
    this.stmts.failTask.run(newStatus, String(errorMsg || 'Task failed'), now, newStatus, now, taskId);
    return this.getTask(taskId);
  }

  cancelTask(taskId) {
    this.stmts.cancelTask.run(nowIso(), taskId);
    return this.getTask(taskId);
  }

  listStaleRunningTasks({ olderThanMs = 15 * 60_000, taskTypes = null, sessionId = null, limit = 50 } = {}) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const clauses = [`status = 'running'`, `(COALESCE(lease_expires_at, last_heartbeat_at, started_at, updated_at) < ?)`];
    const params = [cutoff];
    if (Array.isArray(taskTypes) && taskTypes.length > 0) {
      clauses.push(`task_type IN (${taskTypes.map(() => '?').join(',')})`);
      params.push(...taskTypes);
    }
    if (sessionId) {
      clauses.push(`session_id = ?`);
      params.push(sessionId);
    }
    params.push(limit);
    const sql = `SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY updated_at ASC LIMIT ?`;
    return this.db.prepare(sql).all(...params).map(row => this._rowToTask(row));
  }

  recoverStaleRunningTasks({ olderThanMs = 15 * 60_000, taskTypes = null, sessionId = null, limit = 50, dryRun = false } = {}) {
    const stale = this.listStaleRunningTasks({ olderThanMs, taskTypes, sessionId, limit });
    const actions = [];
    if (!dryRun) {
      const now = nowIso();
      const tx = this.db.transaction(() => {
        for (const task of stale) {
          const nextStatus = task.retryCount < task.maxRetries ? 'pending' : 'failed';
          const error = `Doctor recovered stale running task from worker ${task.workerId || 'unknown'} at ${now}`;
          this.stmts.reclaimTask.run(nextStatus, error, now, nextStatus, task.id);
          actions.push({ taskId: task.id, taskType: task.taskType, sessionId: task.sessionId, from: 'running', to: nextStatus });
        }
      });
      tx();
    } else {
      for (const task of stale) actions.push({ taskId: task.id, taskType: task.taskType, sessionId: task.sessionId, from: 'running', to: task.retryCount < task.maxRetries ? 'pending' : 'failed' });
    }
    return { staleCount: stale.length, actions, tasks: stale };
  }

  stats() {
    const rows = this.stmts.stats.all();
    const result = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of rows) result[r.status] = r.count;
    return result;
  }

  cleanOldTasks() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.stmts.cleanOldTasks.run(cutoff).changes;
  }

  _rowToTask(row) {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      context: safeParse(row.context),
      payload: safeParse(row.payload_json),
      taskType: row.task_type || 'generic',
      sessionId: row.session_id ?? null,
      result: safeParse(row.result),
      resultPreview: row.result_preview ?? null,
      error: row.error ?? null,
      retryCount: row.retry_count ?? 0,
      maxRetries: row.max_retries ?? 0,
      priority: row.priority ?? 0,
      source: row.source ?? null,
      workerId: row.worker_id ?? null,
      leaseExpiresAt: row.lease_expires_at ?? null,
      lastHeartbeatAt: row.last_heartbeat_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
    };
  }

  close() {
    if (this._ownsDb) this.db.close();
  }
}

export { TaskManager };
