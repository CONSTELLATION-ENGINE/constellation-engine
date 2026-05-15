// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module doctor
 * @description Self-diagnosis, auto-repair, and file rollback system for Constellation Engine.
 * 
 * Provides:
 * - SnapshotManager: Git-like file snapshots stored in SQLite
 * - diagnose(): 10-point health check returning CheckResult[]
 * - repair(): Auto-fix common issues based on diagnose results
 * - Dashboard API routes and Telegram /doctor command integration
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { TranscriptIntegrityManager } from './transcript-integrity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;
const PROJECT_ROOT = resolve(__dirname, '..');

// ─── SnapshotManager ────────────────────────────────────────────────────────

/**
 * @typedef {Object} Snapshot
 * @property {number} id
 * @property {string} file_path
 * @property {string} content
 * @property {string} hash
 * @property {string} reason
 * @property {string} created_at
 */

/**
 * File snapshot manager backed by SQLite.
 * Stores file versions before modifications for safe rollback.
 */
export class SnapshotManager {
  /** @type {import('better-sqlite3').Database} */
  #db;
  /** @type {number} Max snapshots per file */
  #maxPerFile;

  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} [options]
   * @param {number} [options.maxPerFile=20] - Max snapshots retained per file
   */
  constructor(db, options = {}) {
    this.#db = db;
    this.#maxPerFile = options.maxPerFile || 20;
  }

  /**
   * Create the file_snapshots table if it doesn't exist.
   */
  ensureTable() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL,
        reason TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(file_path, hash)
      );
    `);
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_path
      ON file_snapshots(file_path, created_at DESC);
    `);
  }

  /**
   * Save a snapshot of the current file content.
   * @param {string} filePath - Absolute or relative file path
   * @param {string} [reason=''] - Reason for snapshot
   * @returns {{ saved: boolean, hash: string }} Whether a new snapshot was created
   */
  saveSnapshot(filePath, reason = '') {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      return { saved: false, hash: '' };
    }

    const content = readFileSync(absPath, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');

    try {
      this.#db.prepare(`
        INSERT OR IGNORE INTO file_snapshots (file_path, content, hash, reason)
        VALUES (?, ?, ?, ?)
      `).run(absPath, content, hash, reason);
    } catch {
      // UNIQUE constraint — same content already saved
      return { saved: false, hash };
    }

    // Prune old snapshots beyond maxPerFile
    this.#db.prepare(`
      DELETE FROM file_snapshots
      WHERE file_path = ? AND id NOT IN (
        SELECT id FROM file_snapshots
        WHERE file_path = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `).run(absPath, absPath, this.#maxPerFile);

    return { saved: true, hash };
  }

  /**
   * Rollback a file to its most recent snapshot.
   * @param {string} filePath - File path
   * @returns {{ success: boolean, snapshotId?: number, detail: string }}
   */
  rollback(filePath) {
    const absPath = resolve(filePath);
    const snap = this.#db.prepare(`
      SELECT id, content, created_at FROM file_snapshots
      WHERE file_path = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(absPath);

    if (!snap) {
      return { success: false, detail: `No snapshots found for ${filePath}` };
    }

    try {
      const dir = dirname(absPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(absPath, snap.content, 'utf-8');
      return { success: true, snapshotId: snap.id, detail: `Rolled back to snapshot #${snap.id} (${snap.created_at})` };
    } catch (e) {
      return { success: false, detail: `Write failed: ${e.message}` };
    }
  }

  /**
   * Rollback a file to a specific snapshot by ID.
   * @param {string} filePath
   * @param {number} snapshotId
   * @returns {{ success: boolean, detail: string }}
   */
  rollbackTo(filePath, snapshotId) {
    const absPath = resolve(filePath);
    const snap = this.#db.prepare(`
      SELECT content, created_at FROM file_snapshots
      WHERE file_path = ? AND id = ?
    `).get(absPath, snapshotId);

    if (!snap) {
      return { success: false, detail: `Snapshot #${snapshotId} not found for ${filePath}` };
    }

    try {
      writeFileSync(absPath, snap.content, 'utf-8');
      return { success: true, detail: `Rolled back to snapshot #${snapshotId} (${snap.created_at})` };
    } catch (e) {
      return { success: false, detail: `Write failed: ${e.message}` };
    }
  }

  /**
   * Rollback all tracked files to the most recent snapshot before a timestamp.
   * @param {string} beforeTimestamp - ISO timestamp
   * @returns {{ results: Array<{ file: string, success: boolean, detail: string }> }}
   */
  rollbackAll(beforeTimestamp) {
    const files = this.#db.prepare(`
      SELECT DISTINCT file_path FROM file_snapshots
      WHERE created_at < ?
    `).all(beforeTimestamp);

    const results = [];
    for (const { file_path } of files) {
      const snap = this.#db.prepare(`
        SELECT id, content, created_at FROM file_snapshots
        WHERE file_path = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT 1
      `).get(file_path, beforeTimestamp);

      if (!snap) {
        results.push({ file: file_path, success: false, detail: 'No snapshot before timestamp' });
        continue;
      }

      try {
        writeFileSync(file_path, snap.content, 'utf-8');
        results.push({ file: file_path, success: true, detail: `→ snapshot #${snap.id} (${snap.created_at})` });
      } catch (e) {
        results.push({ file: file_path, success: false, detail: e.message });
      }
    }

    return { results };
  }

  /**
   * List snapshots for a file.
   * @param {string} filePath
   * @param {number} [limit=20]
   * @returns {Snapshot[]}
   */
  listSnapshots(filePath, limit = 20) {
    const absPath = resolve(filePath);
    return this.#db.prepare(`
      SELECT id, file_path, hash, reason, created_at
      FROM file_snapshots
      WHERE file_path = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(absPath, limit);
  }

  /**
   * Snapshot all .js files in src/ directory.
   * @param {string} [reason='']
   * @returns {number} Number of new snapshots saved
   */
  snapshotAllSrc(reason = '') {
    let count = 0;
    try {
      const files = readdirSync(SRC_DIR).filter(f => f.endsWith('.js'));
      for (const f of files) {
        const { saved } = this.saveSnapshot(resolve(SRC_DIR, f), reason);
        if (saved) count++;
      }
    } catch { /* non-critical */ }
    return count;
  }
}

// ─── RepoManifestManager ────────────────────────────────────────────────────

/**
 * @typedef {Object} ManifestEntry
 * @property {string} path - Path relative to PROJECT_ROOT
 * @property {string} hash - sha256 hex
 * @property {number} size - File size in bytes
 * @property {string} captured_at - ISO timestamp
 */

/**
 * @typedef {Object} ManifestVerifyResult
 * @property {number} total - Total files in manifest
 * @property {number} ok - Files matching manifest
 * @property {Array<{path:string,reason:'modified'|'missing'}>} mismatches
 * @property {Array<string>} extra - Files present on disk but not in manifest (informational)
 * @property {string} [capturedAt] - When manifest was seeded
 */

const MANIFEST_SCAN_DIRS = ['src', 'scripts', 'schemas'];
const MANIFEST_FILE_EXTS = new Set(['.js', '.mjs', '.cjs', '.py', '.sql', '.json']);
const MANIFEST_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.venv', 'venv', 'dist', 'build']);
const MANIFEST_SKIP_EXT_SUFFIXES = ['.db', '.db-wal', '.db-shm', '.log'];

function walkManifestFiles(rootDir, relPrefix = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) {
      if (MANIFEST_SKIP_DIRS.has(ent.name)) continue;
      const sub = resolve(rootDir, ent.name);
      const subRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      out.push(...walkManifestFiles(sub, subRel));
    } else if (ent.isFile()) {
      const dot = ent.name.lastIndexOf('.');
      const ext = dot >= 0 ? ent.name.slice(dot) : '';
      if (!MANIFEST_FILE_EXTS.has(ext)) continue;
      if (MANIFEST_SKIP_EXT_SUFFIXES.some(s => ent.name.endsWith(s))) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      out.push({ relPath: rel, absPath: resolve(rootDir, ent.name) });
    }
  }
  return out;
}

/**
 * Repo manifest manager. Stores sha256 of engine source files so tampering
 * or corruption can be detected and repaired against SnapshotManager backups.
 */
export class RepoManifestManager {
  /** @type {import('better-sqlite3').Database} */
  #db;
  #scanDirs;

  constructor(db, options = {}) {
    this.#db = db;
    this.#scanDirs = options.scanDirs || MANIFEST_SCAN_DIRS;
  }

  ensureTable() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS repo_manifest (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        captured_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  #collect() {
    const files = [];
    for (const dir of this.#scanDirs) {
      const abs = resolve(PROJECT_ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const f of walkManifestFiles(abs, dir)) files.push(f);
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return files;
  }

  /**
   * Scan current repo state and write it as the new baseline manifest.
   * Overwrites any prior manifest rows for scanned paths.
   */
  seed() {
    this.ensureTable();
    const files = this.#collect();
    const now = new Date().toISOString();
    const insert = this.#db.prepare(`
      INSERT INTO repo_manifest (path, hash, size, captured_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, size=excluded.size, captured_at=excluded.captured_at
    `);
    const scanned = new Set();
    const tx = this.#db.transaction(() => {
      for (const f of files) {
        try {
          const content = readFileSync(f.absPath);
          const hash = createHash('sha256').update(content).digest('hex');
          insert.run(f.relPath, hash, content.length, now);
          scanned.add(f.relPath);
        } catch { /* unreadable — skip */ }
      }
      // Drop rows whose files no longer exist in scan scope
      const existing = this.#db.prepare(`SELECT path FROM repo_manifest`).all().map(r => r.path);
      for (const p of existing) {
        if (!scanned.has(p)) {
          const inScope = this.#scanDirs.some(d => p === d || p.startsWith(d + '/'));
          if (inScope) this.#db.prepare(`DELETE FROM repo_manifest WHERE path = ?`).run(p);
        }
      }
    });
    tx();
    return { count: scanned.size, capturedAt: now };
  }

  /**
   * Compare current repo state vs stored manifest.
   * @returns {ManifestVerifyResult}
   */
  verify() {
    this.ensureTable();
    const rows = this.#db.prepare(`SELECT path, hash, size, captured_at FROM repo_manifest`).all();
    const manifestByPath = new Map(rows.map(r => [r.path, r]));
    const mismatches = [];
    let ok = 0;
    let capturedAt = rows[0]?.captured_at || null;

    for (const [relPath, entry] of manifestByPath) {
      const absPath = resolve(PROJECT_ROOT, relPath);
      if (!existsSync(absPath)) {
        mismatches.push({ path: relPath, reason: 'missing' });
        continue;
      }
      try {
        const content = readFileSync(absPath);
        const hash = createHash('sha256').update(content).digest('hex');
        if (hash === entry.hash) {
          ok++;
        } else {
          mismatches.push({ path: relPath, reason: 'modified' });
        }
      } catch {
        mismatches.push({ path: relPath, reason: 'missing' });
      }
    }

    // Extra files (present on disk, not in manifest) — report only, don't flag as error
    const currentFiles = new Set();
    for (const dir of this.#scanDirs) {
      const abs = resolve(PROJECT_ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const f of walkManifestFiles(abs, dir)) currentFiles.add(f.relPath);
    }
    const extra = [];
    for (const p of currentFiles) {
      if (!manifestByPath.has(p)) extra.push(p);
    }

    return { total: manifestByPath.size, ok, mismatches, extra, capturedAt };
  }

  /**
   * Attempt to repair manifest mismatches by restoring each modified/missing
   * file from SnapshotManager if a matching hash snapshot exists.
   */
  repairFromSnapshots(snapshotManager) {
    const verifyResult = this.verify();
    const repaired = [];
    const failed = [];
    for (const mm of verifyResult.mismatches) {
      const absPath = resolve(PROJECT_ROOT, mm.path);
      const entry = this.#db.prepare(`SELECT hash FROM repo_manifest WHERE path = ?`).get(mm.path);
      if (!entry) {
        failed.push({ ...mm, reason_detail: 'no manifest row' });
        continue;
      }
      // Look for a snapshot matching the manifest hash exactly
      let restored = false;
      try {
        const snap = this.#db.prepare(
          `SELECT content FROM file_snapshots WHERE file_path = ? AND hash = ? ORDER BY created_at DESC LIMIT 1`
        ).get(absPath, entry.hash);
        if (snap) {
          writeFileSync(absPath, snap.content, 'utf-8');
          restored = true;
        }
      } catch { /* fall through */ }
      if (restored) {
        repaired.push(mm.path);
      } else {
        failed.push({ ...mm, reason_detail: 'no matching snapshot' });
      }
    }
    return { repaired, failed, totalMismatches: verifyResult.mismatches.length };
  }
}

// ─── Transcript helper ─────────────────────────────────────────────────────

function getTranscriptIntegrityManager(db, manager) {
  return manager instanceof TranscriptIntegrityManager ? manager : new TranscriptIntegrityManager(db);
}

function summarizeTranscriptIssues(report) {
  const issueTypes = Object.entries(report.byType || {}).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(', ');
  const failingSessions = (report.sessions || []).filter(s => s.issueCount > 0).length;
  return {
    failingSessions,
    issueTypes: issueTypes || 'none',
  };
}

function formatTranscriptSummary(report) {
  const { failingSessions, issueTypes } = summarizeTranscriptIssues(report);
  if (!report.issueCount) {
    return `${report.sessionsScanned} sessions scanned, 0 issues`;
  }
  return `${report.issueCount} issues across ${failingSessions}/${report.sessionsScanned} sessions (${issueTypes})`;
}

function formatTranscriptRepairSummary(result) {
  const verified = result.sessions.filter(s => s.verification?.ok).length;
  if (!result.repairedActions) {
    return `No transcript repairs needed (${verified}/${result.sessions.length} sessions verify clean)`;
  }
  return `${result.repairedActions} actions across ${result.repairedSessions}/${result.sessionsScanned} sessions; verify clean ${verified}/${result.sessions.length}`;
}

function formatTranscriptVerifySummary(result) {
  if (result.failedSessions === 0) {
    return `${result.okSessions}/${result.sessionsScanned} sessions verify clean`;
  }
  return `${result.failedSessions}/${result.sessionsScanned} sessions still failing provider replay`;
}


// ─── Runtime journal / pending-tool helpers ───────────────────────────────

function scanRuntimeJournal(db, { sessionId, staleOlderThan = '-15 minutes', limit = 20 } = {}) {
  const stalePending = sessionId
    ? db.prepare(`SELECT * FROM pending_tool_runs WHERE session_id = ? AND status = 'pending' AND started_at < datetime('now', ?) ORDER BY started_at ASC LIMIT ?`).all(sessionId, staleOlderThan, limit)
    : db.prepare(`SELECT * FROM pending_tool_runs WHERE status = 'pending' AND started_at < datetime('now', ?) ORDER BY started_at ASC LIMIT ?`).all(staleOlderThan, limit);

  const stuckTurns = sessionId
    ? db.prepare(`SELECT * FROM turn_journal WHERE session_id = ? AND status = 'started' AND finished_at IS NULL AND updated_at < datetime('now', ?) ORDER BY updated_at ASC LIMIT ?`).all(sessionId, staleOlderThan, limit)
    : db.prepare(`SELECT * FROM turn_journal WHERE status = 'started' AND finished_at IS NULL AND updated_at < datetime('now', ?) ORDER BY updated_at ASC LIMIT ?`).all(staleOlderThan, limit);

  const failedTurns = sessionId
    ? db.prepare(`SELECT * FROM turn_journal WHERE session_id = ? AND status = 'failed' AND updated_at > datetime('now', '-24 hours') ORDER BY updated_at DESC LIMIT ?`).all(sessionId, limit)
    : db.prepare(`SELECT * FROM turn_journal WHERE status = 'failed' AND updated_at > datetime('now', '-24 hours') ORDER BY updated_at DESC LIMIT ?`).all(limit);

  const failedTotalRow = sessionId
    ? db.prepare(`SELECT COUNT(*) AS c FROM turn_journal WHERE session_id = ? AND status = 'failed'`).get(sessionId)
    : db.prepare(`SELECT COUNT(*) AS c FROM turn_journal WHERE status = 'failed'`).get();
  const failedTurnTotal = failedTotalRow ? failedTotalRow.c : 0;

  const bySession = new Map();
  const touch = (sid) => {
    if (!bySession.has(sid)) bySession.set(sid, { sessionId: sid, stalePending: 0, stuckTurns: 0, failedTurns: 0 });
    return bySession.get(sid);
  };
  for (const row of stalePending) touch(row.session_id).stalePending += 1;
  for (const row of stuckTurns) touch(row.session_id).stuckTurns += 1;
  for (const row of failedTurns) touch(row.session_id).failedTurns += 1;

  return {
    sessionId: sessionId || null,
    sessions: [...bySession.values()].sort((a, b) => (b.stalePending + b.stuckTurns + b.failedTurns) - (a.stalePending + a.stuckTurns + a.failedTurns)),
    stalePendingCount: stalePending.length,
    stuckTurnCount: stuckTurns.length,
    failedTurnCount: failedTurns.length,
    failedTurnTotal,
    stalePending,
    stuckTurns,
    failedTurns,
  };
}

function formatRuntimeSummary(report) {
  const failedSegment = report.failedTurnTotal > report.failedTurnCount
    ? `${report.failedTurnCount} failed turns (24h, ${report.failedTurnTotal} total)`
    : `${report.failedTurnCount} failed turns (24h)`;
  return `${report.stalePendingCount} stale pending runs, ${report.stuckTurnCount} stuck turns, ${failedSegment}`;
}

function scanQueuedTasks(taskManager, { sessionId, olderThanMs = 15 * 60_000, limit = 25 } = {}) {
  if (!taskManager) {
    return { sessionId: sessionId || null, staleRunningCount: 0, pendingCount: 0, failedCount: 0, staleRunning: [], pending: [], failed: [], sessions: [] };
  }
  const staleRunning = taskManager.listStaleRunningTasks({ olderThanMs, sessionId, limit });
  const pending = taskManager.getPendingTasks(limit, { taskTypes: ['subagent_generic', 'subagent_technical', 'subagent_patch'] })
    .filter(t => !sessionId || t.sessionId === sessionId);
  const failed = taskManager.listTasks({ status: 'failed', sessionId, limit }).filter(t => String(t.taskType || '').startsWith('subagent_'));
  const bySession = new Map();
  const touch = (sid) => {
    const key = sid || '(none)';
    if (!bySession.has(key)) bySession.set(key, { sessionId: sid || null, staleRunning: 0, pending: 0, failed: 0 });
    return bySession.get(key);
  };
  for (const row of staleRunning) touch(row.sessionId).staleRunning += 1;
  for (const row of pending) touch(row.sessionId).pending += 1;
  for (const row of failed) touch(row.sessionId).failed += 1;
  return {
    sessionId: sessionId || null,
    staleRunningCount: staleRunning.length,
    pendingCount: pending.length,
    failedCount: failed.length,
    staleRunning, pending, failed,
    sessions: [...bySession.values()].sort((a,b)=>(b.staleRunning+b.pending+b.failed)-(a.staleRunning+a.pending+a.failed)),
  };
}

function formatTaskSummary(report) {
  return `${report.staleRunningCount} stale running, ${report.pendingCount} queued, ${report.failedCount} failed`;
}

export function scanTokenWaste(db, { sessionId = undefined, limit = 25 } = {}) {
  const hasCol = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column);
    } catch {
      return false;
    }
  };

  const turnCols = {
    toolCallCount: hasCol('turn_journal', 'tool_call_count'),
    toolCacheHits: hasCol('turn_journal', 'tool_cache_hits'),
    suppressedToolCalls: hasCol('turn_journal', 'suppressed_tool_calls'),
    totalTokens: hasCol('turn_journal', 'total_tokens'),
    toolResultBytes: hasCol('turn_journal', 'tool_result_bytes'),
    plannerGuardrailHits: hasCol('turn_journal', 'planner_guardrail_hits'),
    stopReason: hasCol('turn_journal', 'stop_reason'),
  };
  const msgCols = {
    toolName: hasCol('messages', 'tool_name'),
    toolBytes: hasCol('messages', 'tool_result_bytes'),
    toolOk: hasCol('messages', 'tool_ok'),
  };

  const turnClause = sessionId ? 'WHERE t.session_id = ?' : '';
  const turnParams = sessionId ? [sessionId, limit] : [limit];
  const pendingClause = sessionId ? 'WHERE p.session_id = ?' : '';
  const pendingParams = sessionId ? [sessionId, limit] : [limit];
  const messageClause = sessionId ? 'AND m.session_id = ?' : '';
  const messageParams = sessionId ? [sessionId, limit] : [limit];

  const toolCallExpr = turnCols.toolCallCount ? 'COALESCE(t.tool_call_count,0)' : '0';
  const toolCacheExpr = turnCols.toolCacheHits ? 'COALESCE(t.tool_cache_hits,0)' : '0';
  const suppressedExpr = turnCols.suppressedToolCalls ? 'COALESCE(t.suppressed_tool_calls,0)' : '0';
  const totalTokensExpr = turnCols.totalTokens ? 'COALESCE(t.total_tokens,0)' : '0';
  const toolBytesExpr = turnCols.toolResultBytes ? 'COALESCE(t.tool_result_bytes,0)' : '0';
  const plannerHitsExpr = turnCols.plannerGuardrailHits ? 'COALESCE(t.planner_guardrail_hits,0)' : '0';
  const stopReasonExpr = turnCols.stopReason ? 't.stop_reason' : "''";

  const wastefulTurns = db.prepare(`
    SELECT t.id, t.session_id, t.stage, t.status,
           ${toolCallExpr} AS tool_call_count,
           ${toolCacheExpr} AS tool_cache_hits,
           ${suppressedExpr} AS suppressed_tool_calls,
           ${totalTokensExpr} AS total_tokens,
           ${toolBytesExpr} AS tool_result_bytes,
           ${plannerHitsExpr} AS planner_guardrail_hits,
           ${stopReasonExpr} AS stop_reason,
           t.updated_at,
           CASE WHEN ${toolCallExpr} > 0 THEN ROUND(CAST(${toolCacheExpr} AS REAL) / ${toolCallExpr}, 3) ELSE 0 END AS cache_hit_ratio
    FROM turn_journal t
    ${turnClause}
    ORDER BY (${totalTokensExpr} + ${toolBytesExpr}) DESC, t.updated_at DESC
    LIMIT ?
  `).all(...turnParams);

  const lowCacheSessions = db.prepare(`
    SELECT t.session_id,
           SUM(${toolCallExpr}) AS tool_calls,
           SUM(${toolCacheExpr}) AS cache_hits,
           ROUND(CASE WHEN SUM(${toolCallExpr}) > 0 THEN CAST(SUM(${toolCacheExpr}) AS REAL) / SUM(${toolCallExpr}) ELSE 0 END, 3) AS cache_hit_ratio,
           SUM(${totalTokensExpr}) AS total_tokens
    FROM turn_journal t
    ${turnClause}
    GROUP BY t.session_id
    HAVING SUM(${toolCallExpr}) >= 3
    ORDER BY cache_hit_ratio ASC, total_tokens DESC
    LIMIT ?
  `).all(...turnParams);

  const repeatedTools = db.prepare(`
    SELECT p.session_id, p.tool_name, p.tool_input_json, COUNT(*) AS calls,
           COUNT(DISTINCT p.turn_id) AS turns,
           SUM(CASE WHEN p.status='completed' THEN 1 ELSE 0 END) AS completed
    FROM pending_tool_runs p
    ${pendingClause}
    GROUP BY p.session_id, p.tool_name, p.tool_input_json
    HAVING COUNT(*) > 1
    ORDER BY calls DESC, turns DESC
    LIMIT ?
  `).all(...pendingParams);

  const toolNameExpr = msgCols.toolName ? "COALESCE(m.tool_name, '(unknown)')" : "'(unknown)'";
  const msgBytesExpr = msgCols.toolBytes ? "COALESCE(m.tool_result_bytes, LENGTH(COALESCE(m.content, '')))" : "LENGTH(COALESCE(m.content, ''))";
  const msgErrorExpr = msgCols.toolOk ? 'SUM(CASE WHEN m.tool_ok = 0 THEN 1 ELSE 0 END)' : '0';

  const bloatedTools = db.prepare(`
    SELECT ${toolNameExpr} AS tool_name,
           COUNT(*) AS rows,
           SUM(${msgBytesExpr}) AS total_bytes,
           ROUND(AVG(${msgBytesExpr}), 1) AS avg_bytes,
           ${msgErrorExpr} AS errors
    FROM messages m
    WHERE m.role='tool' ${messageClause}
    GROUP BY ${toolNameExpr}
    HAVING COUNT(*) > 0
    ORDER BY total_bytes DESC, avg_bytes DESC
    LIMIT ?
  `).all(...messageParams);

  const nearValveTurns = wastefulTurns.filter(r => ['token_safety_valve', 'turn_token_budget_exceeded', 'max_tool_rounds'].includes(String(r.stage || '')) || ['token_safety_valve', 'turn_token_budget_exceeded', 'max_tool_rounds', 'planner_repeat_guardrail'].includes(String(r.stop_reason || '')));

  return {
    sessionId: sessionId || null,
    wastefulTurnCount: wastefulTurns.length,
    repeatedToolPatternCount: repeatedTools.length,
    lowCacheSessionCount: lowCacheSessions.length,
    bloatedToolCount: bloatedTools.length,
    nearValveCount: nearValveTurns.length,
    wastefulTurns,
    repeatedTools,
    lowCacheSessions,
    bloatedTools,
    nearValveTurns,
  };
}

function formatTokenWasteSummary(report) {
  return `${report.wastefulTurnCount} hot turns, ${report.repeatedToolPatternCount} repeated tool patterns, ${report.lowCacheSessionCount} low-cache sessions, ${report.nearValveCount} near safety-valve turns`;
}

// ─── Graph integrity scan (read-only, forensic) ─────────────────────────────
export function scanGraphIntegrity(db, { limit = 20 } = {}) {
  const hasCol = (table, column) => {
    try { return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column); }
    catch { return false; }
  };

  const out = {
    danglingEdgeCount: 0,
    danglingEdges: [],
    nullCreatedAtCount: 0,
    duplicateTagCount: 0,
    duplicateTagSamples: [],
    zeroEdgeActiveCount: 0,
    orphanOwnerEdgeCount: 0,
    issueCount: 0,
  };

  try {
    const dangling = db.prepare(`
      SELECT e.id, e.source, e.target, e.edge_type
        FROM edges e
        LEFT JOIN nodes ns ON ns.id = e.source
        LEFT JOIN nodes nt ON nt.id = e.target
       WHERE e.state='active' AND (ns.id IS NULL OR nt.id IS NULL)
       LIMIT ?
    `).all(limit);
    out.danglingEdges = dangling;
    out.danglingEdgeCount = db.prepare(`
      SELECT COUNT(*) c FROM edges e
        LEFT JOIN nodes ns ON ns.id = e.source
        LEFT JOIN nodes nt ON nt.id = e.target
       WHERE e.state='active' AND (ns.id IS NULL OR nt.id IS NULL)
    `).get().c;
  } catch (e) { out.danglingError = e.message; }

  try {
    out.nullCreatedAtCount = db.prepare(
      "SELECT COUNT(*) c FROM nodes WHERE state='active' AND (created_at IS NULL OR created_at='')"
    ).get().c;
  } catch (e) { out.nullCreatedAtError = e.message; }

  try {
    // duplicate tags — same tag repeated within a node's tags JSON array
    const rows = db.prepare("SELECT id, tags FROM nodes WHERE state='active' AND tags IS NOT NULL AND tags != ''").all();
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.tags);
        if (!Array.isArray(arr)) continue;
        const seen = new Set();
        const dups = [];
        for (const t of arr) {
          const k = String(t).toLowerCase();
          if (seen.has(k)) dups.push(t);
          else seen.add(k);
        }
        if (dups.length) {
          out.duplicateTagCount += 1;
          if (out.duplicateTagSamples.length < limit) out.duplicateTagSamples.push({ node: r.id, dups });
        }
      } catch {}
    }
  } catch (e) { out.duplicateTagError = e.message; }

  try {
    // active nodes with zero edges older than 30d
    out.zeroEdgeActiveCount = db.prepare(`
      SELECT COUNT(*) c FROM nodes n
       WHERE n.state='active'
         AND (n.created_at IS NULL OR n.created_at < datetime('now','-30 days'))
         AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.state='active' AND (e.source=n.id OR e.target=n.id))
    `).get().c;
  } catch (e) { out.zeroEdgeError = e.message; }

  if (hasCol('edges', 'owner_id') && hasCol('nodes', 'owner_id')) {
    try {
      out.orphanOwnerEdgeCount = db.prepare(`
        SELECT COUNT(*) c FROM edges e
          JOIN nodes ns ON ns.id = e.source
          JOIN nodes nt ON nt.id = e.target
         WHERE e.state='active' AND e.owner_id IS NOT NULL
           AND e.owner_id <> ns.owner_id AND e.owner_id <> nt.owner_id
      `).get().c;
    } catch (e) { out.orphanOwnerError = e.message; }
  }

  out.issueCount = out.danglingEdgeCount + out.nullCreatedAtCount + out.duplicateTagCount + out.orphanOwnerEdgeCount;
  return out;
}

function formatGraphIntegritySummary(r) {
  const parts = [];
  parts.push(`${r.danglingEdgeCount} dangling edges`);
  parts.push(`${r.nullCreatedAtCount} null created_at`);
  parts.push(`${r.duplicateTagCount} dup-tag nodes`);
  if (r.orphanOwnerEdgeCount) parts.push(`${r.orphanOwnerEdgeCount} orphan-owner edges`);
  if (r.zeroEdgeActiveCount) parts.push(`${r.zeroEdgeActiveCount} zero-edge >30d (advisory)`);
  return parts.join(', ');
}

// ─── Mímir embedding drift (file mtime vs newest node) ──────────────────────
export async function scanMimirEmbeddingDrift(db, config, { timeoutMs = 1500 } = {}) {
  const out = { cachePath: null, cacheExists: false, status: 'unknown' };
  const candidates = [
    resolve(PROJECT_ROOT, 'scripts', 'prototype', 'embeddings_cache.npz'),
    resolve(PROJECT_ROOT, 'scripts', 'mimir', 'embeddings_cache.npz'),
  ];
  const cachePath = candidates.find(p => existsSync(p)) || candidates[0];
  out.cachePath = cachePath;
  out.cacheExists = existsSync(cachePath);
  if (!out.cacheExists) { out.status = 'missing'; out.detail = 'no embeddings cache file found yet'; return out; }
  try {
    const st = statSync(cachePath);
    out.cacheMtime = st.mtime.toISOString();
    out.cacheSizeMB = (st.size / 1024 / 1024).toFixed(1);
  } catch (e) { out.status = 'stat_failed'; out.detail = e.message; return out; }

  try {
    const newest = db.prepare("SELECT MAX(created_at) m, COUNT(*) c FROM nodes WHERE state='active'").get();
    out.activeNodeCount = newest?.c ?? 0;
    out.newestNodeAt = newest?.m || null;
  } catch (e) { out.dbError = e.message; }

  try {
    const mimirPort = config?.mimir?.port || 18810;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${mimirPort}/status`, { signal: ac.signal });
    clearTimeout(t);
    if (r.ok) {
      const body = await r.json().catch(() => null);
      if (body && typeof body === 'object') {
        out.mimirNodes = body.n_nodes ?? null;
        out.mimirTick = body.tick ?? null;
      }
    }
  } catch {}

  // Drift heuristic: cache mtime significantly behind newest node
  try {
    if (out.newestNodeAt) {
      const cacheMs = Date.parse(out.cacheMtime);
      const newestMs = Date.parse(out.newestNodeAt);
      if (Number.isFinite(cacheMs) && Number.isFinite(newestMs)) {
        const lagMs = newestMs - cacheMs;
        out.lagMinutes = Math.round(lagMs / 60000);
        if (lagMs <= 10 * 60_000) out.status = 'fresh';
        else if (lagMs <= 60 * 60_000) out.status = 'lagging';
        else out.status = 'stale';
      } else out.status = 'unknown';
    } else out.status = 'empty_db';
  } catch { out.status = 'unknown'; }

  return out;
}

function formatMimirDriftSummary(r) {
  if (!r.cacheExists) return 'no cache file yet';
  const parts = [`cache ${r.cacheSizeMB}MB`];
  if (r.lagMinutes != null) parts.push(`${r.lagMinutes}m behind newest node`);
  if (r.mimirNodes != null) parts.push(`daemon sees ${r.mimirNodes} nodes`);
  parts.push(`status=${r.status}`);
  return parts.join(', ');
}

// ─── Regression sentinels (auto-resume orphans, digest leaks) ───────────────
export function scanRegressionSentinels(db, { limit = 10 } = {}) {
  const hasCol = (table, column) => {
    try { return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === column); }
    catch { return false; }
  };
  const out = { issueCount: 0 };

  try {
    // Auto-resume orphans: 'started' turns older than 10m with a newer completed turn in same session
    const sessionIdCol = hasCol('turn_journal', 'session_id');
    if (sessionIdCol) {
      const rows = db.prepare(`
        SELECT t1.id, t1.session_id, t1.updated_at
          FROM turn_journal t1
         WHERE t1.status='started'
           AND (julianday('now') - julianday(COALESCE(t1.updated_at, t1.created_at))) * 24 * 60 > 10
           AND EXISTS (
             SELECT 1 FROM turn_journal t2
              WHERE t2.session_id = t1.session_id
                AND t2.status='completed'
                AND t2.created_at > COALESCE(t1.updated_at, t1.created_at)
           )
         LIMIT ?
      `).all(limit);
      out.autoResumeOrphans = rows;
      out.autoResumeOrphanCount = rows.length;
    } else {
      out.autoResumeOrphanCount = 0;
      out.autoResumeOrphans = [];
    }
  } catch (e) { out.autoResumeError = e.message; out.autoResumeOrphanCount = 0; }

  try {
    // Exploration digest leaks: nodes whose session_id starts with tg: / tg_ (should have been filtered)
    if (hasCol('nodes', 'session_id')) {
      out.leakedDigestNodeCount = db.prepare(
        "SELECT COUNT(*) c FROM nodes WHERE state='active' AND (session_id LIKE 'tg:%' OR session_id LIKE 'tg\\_%' ESCAPE '\\')"
      ).get().c;
    } else {
      out.leakedDigestNodeCount = 0;
    }
  } catch (e) { out.leakError = e.message; out.leakedDigestNodeCount = 0; }

  try {
    // turn_journal rows with NULL session_id (should never happen)
    out.nullSessionTurnCount = db.prepare(
      "SELECT COUNT(*) c FROM turn_journal WHERE session_id IS NULL OR session_id=''"
    ).get().c;
  } catch { out.nullSessionTurnCount = 0; }

  out.issueCount = (out.autoResumeOrphanCount || 0) + (out.leakedDigestNodeCount || 0) + (out.nullSessionTurnCount || 0);
  return out;
}

function formatRegressionSentinelSummary(r) {
  const parts = [];
  parts.push(`${r.autoResumeOrphanCount || 0} auto-resume orphans`);
  parts.push(`${r.leakedDigestNodeCount || 0} leaked-digest nodes`);
  if (r.nullSessionTurnCount) parts.push(`${r.nullSessionTurnCount} null-session turns`);
  return parts.join(', ');
}

function recoverQueuedTasks(taskManager, { sessionId, olderThanMs = 15 * 60_000, limit = 50, dryRun = false } = {}) {
  if (!taskManager) return { staleRunningCount: 0, recovered: 0, actions: [], tasks: [] };
  const recovered = taskManager.recoverStaleRunningTasks({ olderThanMs, sessionId, limit, taskTypes: ['subagent_generic', 'subagent_technical', 'subagent_patch'], dryRun });
  const scan = scanQueuedTasks(taskManager, { sessionId, olderThanMs, limit });
  return {
    ...scan,
    recovered: recovered.actions.length,
    actions: recovered.actions,
    recoveredTasks: recovered.tasks,
  };
}

function recoverRuntimeState(db, { sessionId, staleOlderThan = '-15 minutes', limit = 50, dryRun = false } = {}) {
  const scan = scanRuntimeJournal(db, { sessionId, staleOlderThan, limit });
  if (dryRun) {
    return {
      ...scan,
      recoveredPending: 0,
      recoveredTurns: 0,
      sessionsAffected: 0,
      actions: [],
    };
  }

  const actions = [];
  let recoveredPending = 0;
  let recoveredTurns = 0;
  const affected = new Set();

  const tx = db.transaction(() => {
    for (const row of scan.stalePending) {
      const toolMsgId = row.result_message_id || null;
      db.prepare(`UPDATE pending_tool_runs
        SET status = 'aborted',
            finished_at = datetime('now'),
            error_code = COALESCE(error_code, 'doctor_recovered'),
            error = COALESCE(error, 'Doctor recovered stale pending tool run'),
            result_preview = COALESCE(result_preview, '[doctor] stale pending tool run recovered')
        WHERE id = ?`).run(row.id);
      recoveredPending += 1;
      affected.add(row.session_id);
      actions.push({ type: 'abort_pending_tool_run', sessionId: row.session_id, turnId: row.turn_id, toolCallId: row.tool_call_id, toolName: row.tool_name, resultMessageId: toolMsgId });
    }

    const turnsToFail = new Map();
    for (const row of scan.stalePending) turnsToFail.set(row.turn_id, { session_id: row.session_id, reason: `Doctor recovered stale pending tool run(s)` });
    for (const row of scan.stuckTurns) turnsToFail.set(row.id, { session_id: row.session_id, reason: `Doctor recovered stuck turn with no final response` });

    for (const [turnId, meta] of turnsToFail.entries()) {
      const updated = db.prepare(`UPDATE turn_journal
        SET status = 'failed',
            stage = 'doctor_recovered',
            error = COALESCE(error, ?),
            updated_at = datetime('now'),
            finished_at = COALESCE(finished_at, datetime('now'))
        WHERE id = ? AND (status = 'started' OR status = 'failed')`).run(meta.reason, turnId);
      if (updated.changes > 0) {
        recoveredTurns += 1;
        affected.add(meta.session_id);
        actions.push({ type: 'fail_turn', sessionId: meta.session_id, turnId, reason: meta.reason });
      }
    }
  });
  tx();

  return {
    ...scanRuntimeJournal(db, { sessionId, staleOlderThan, limit }),
    recoveredPending,
    recoveredTurns,
    sessionsAffected: affected.size,
    actions,
  };
}

// ─── Health Check (diagnose) ────────────────────────────────────────────────

/**
 * @typedef {Object} CheckResult
 * @property {string} name - Check name
 * @property {'✅'|'⚠️'|'❌'} status - Check status
 * @property {string} detail - Details
 * @property {boolean} [autoFixed] - Whether auto-fixed during check
 */

/**
 * Run all health checks.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} config - App config
 * @param {SnapshotManager} [snapshotManager]
 * @returns {Promise<CheckResult[]>}
 */
export async function diagnose(db, config, snapshotManager, options = {}) {
  const results = [];
  const taskManager = options.taskManager || null;

  // 1. Database readable, node count > 0
  try {
    const row = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE state = 'active'").get();
    if (row.c > 0) {
      results.push({ name: 'Database', status: '✅', detail: `${row.c} active nodes` });
    } else {
      results.push({ name: 'Database', status: '⚠️', detail: 'Database readable but 0 active nodes' });
    }
  } catch (e) {
    results.push({ name: 'Database', status: '❌', detail: `DB error: ${e.message}` });
  }

  // 2. src/*.js syntax check
  try {
    const jsFiles = readdirSync(SRC_DIR).filter(f => f.endsWith('.js'));
    const badFiles = [];
    for (const f of jsFiles) {
      try {
        const content = readFileSync(resolve(SRC_DIR, f), 'utf-8');
        // Basic syntax check via new Function (won't catch ESM import issues but catches syntax)
        // Use Node's vm module for better checking
        const { Script } = await import('node:vm');
        new Script(content, { filename: f });
      } catch (syntaxErr) {
        // ESM imports cause syntax errors in Script, so check for actual parse errors
        if (syntaxErr.message && !syntaxErr.message.includes('Cannot use import') &&
            !syntaxErr.message.includes('Cannot use \'import.meta\'') &&
            !syntaxErr.message.includes('Unexpected token \'export\'')) {
          badFiles.push(`${f}: ${syntaxErr.message.split('\n')[0]}`);
        }
      }
    }
    if (badFiles.length === 0) {
      results.push({ name: 'Source Files', status: '✅', detail: `${jsFiles.length} files OK` });
    } else {
      results.push({ name: 'Source Files', status: '❌', detail: badFiles.join('; ') });
    }
  } catch (e) {
    results.push({ name: 'Source Files', status: '❌', detail: e.message });
  }

  // 3. Identity files exist
  try {
    const fixedFiles = config.runtime?.fixedFiles || [];
    const missing = fixedFiles.filter(f => !existsSync(f));
    if (missing.length === 0) {
      results.push({ name: 'Identity Files', status: '✅', detail: `${fixedFiles.length} files present` });
    } else {
      results.push({ name: 'Identity Files', status: '⚠️', detail: `Missing: ${missing.map(f => f.split('/').pop()).join(', ')}` });
    }
  } catch (e) {
    results.push({ name: 'Identity Files', status: '⚠️', detail: e.message });
  }

  // 4. WAL file size check
  try {
    const walPath = config.engine?.dbPath + '-wal';
    if (existsSync(walPath)) {
      const walSize = statSync(walPath).size;
      const walMB = (walSize / 1024 / 1024).toFixed(1);
      if (walSize > 50 * 1024 * 1024) {
        db.pragma('wal_checkpoint(TRUNCATE)');
        results.push({ name: 'WAL Size', status: '⚠️', detail: `${walMB}MB — auto checkpoint triggered`, autoFixed: true });
      } else {
        results.push({ name: 'WAL Size', status: '✅', detail: `${walMB}MB` });
      }
    } else {
      results.push({ name: 'WAL Size', status: '✅', detail: 'No WAL file (non-WAL mode or clean)' });
    }
  } catch (e) {
    results.push({ name: 'WAL Size', status: '⚠️', detail: e.message });
  }

  // 5. Disk space > 1GB
  try {
    if (process.platform === 'win32') {
      // Windows: use statfs via fs (Node 18.15+). Falls back to ⚠️ if unsupported.
      try {
        const { statfsSync } = await import('node:fs');
        const st = statfsSync(PROJECT_ROOT);
        const available = Number(st.bavail) * Number(st.bsize);
        const availGB = (available / 1e9).toFixed(1);
        if (available > 1e9) {
          results.push({ name: 'Disk Space', status: '✅', detail: `${availGB}GB available` });
        } else {
          results.push({ name: 'Disk Space', status: '❌', detail: `Only ${availGB}GB available (< 1GB)` });
        }
      } catch (winErr) {
        results.push({ name: 'Disk Space', status: '⚠️', detail: 'statfs unavailable on this Node version' });
      }
    } else {
    const output = execSync('df -B1 . 2>/dev/null || echo "0 0 0 0"', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const available = parseInt(parts[3] || '0', 10);
      const availGB = (available / 1e9).toFixed(1);
      if (available > 1e9) {
        results.push({ name: 'Disk Space', status: '✅', detail: `${availGB}GB available` });
      } else {
        results.push({ name: 'Disk Space', status: '❌', detail: `Only ${availGB}GB available (< 1GB)` });
      }
    } else {
      results.push({ name: 'Disk Space', status: '⚠️', detail: 'Could not parse df output' });
    }
    }
  } catch {
    results.push({ name: 'Disk Space', status: '⚠️', detail: 'df command unavailable' });
  }

  // 6. node_modules integrity
  try {
    const pkgPath = resolve(PROJECT_ROOT, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = Object.keys(pkg.dependencies || {});
      const missing = deps.filter(d => !existsSync(resolve(PROJECT_ROOT, 'node_modules', d)));
      if (missing.length === 0) {
        results.push({ name: 'Dependencies', status: '✅', detail: `${deps.length} packages OK` });
      } else {
        results.push({ name: 'Dependencies', status: '❌', detail: `Missing: ${missing.join(', ')}` });
      }
    } else {
      results.push({ name: 'Dependencies', status: '⚠️', detail: 'No package.json found' });
    }
  } catch (e) {
    results.push({ name: 'Dependencies', status: '⚠️', detail: e.message });
  }

  // 7. Config file valid
  try {
    const configPath = resolve(PROJECT_ROOT, 'config.json');
    if (existsSync(configPath)) {
      JSON.parse(readFileSync(configPath, 'utf-8'));
      results.push({ name: 'Config File', status: '✅', detail: 'config.json valid' });
    } else {
      results.push({ name: 'Config File', status: '❌', detail: 'config.json not found' });
    }
  } catch (e) {
    results.push({ name: 'Config File', status: '❌', detail: `Parse error: ${e.message}` });
  }

  // (removed: LLM Proxy / Cron Table / Dashboard Port — redundant with Settings/Cron/Live tabs)

  // 11. Transcript integrity (tool call / tool result health)
  try {
    const transcriptIntegrity = getTranscriptIntegrityManager(db, options.transcriptIntegrity);
    const report = transcriptIntegrity.scan({
      provider: options.provider || 'anthropic',
      limit: options.transcriptLimit || 25,
      persist: false,
    });
    results.push({
      name: 'Transcript Integrity',
      status: report.issueCount === 0 ? '✅' : '⚠️',
      detail: formatTranscriptSummary(report),
    });
  } catch (e) {
    results.push({ name: 'Transcript Integrity', status: '❌', detail: `Scan failed: ${e.message}` });
  }

  // 12. Runtime journal health
  try {
    const runtimeReport = scanRuntimeJournal(db, {
      sessionId: options.sessionId,
      staleOlderThan: options.runtimeOlderThan || '-15 minutes',
      limit: options.runtimeLimit || 25,
    });
    const taskReport = scanQueuedTasks(taskManager, {
      sessionId: options.sessionId,
      olderThanMs: 15 * 60_000,
      limit: options.runtimeLimit || 25,
    });
    const wasteReport = scanTokenWaste(db, {
      sessionId: options.sessionId,
      limit: options.runtimeLimit || 25,
    });
    results.push({
      name: 'Turn Journal',
      status: runtimeReport.stuckTurnCount === 0 && runtimeReport.failedTurnCount === 0 ? '✅' : '⚠️',
      detail: runtimeReport.failedTurnTotal > runtimeReport.failedTurnCount
        ? `${runtimeReport.stuckTurnCount} stuck turns, ${runtimeReport.failedTurnCount} failed turns (24h, ${runtimeReport.failedTurnTotal} total)`
        : `${runtimeReport.stuckTurnCount} stuck turns, ${runtimeReport.failedTurnCount} failed turns (24h)`,
    });
    results.push({
      name: 'Pending Tool Runs',
      status: runtimeReport.stalePendingCount === 0 ? '✅' : '⚠️',
      detail: `${runtimeReport.stalePendingCount} stale pending runs across ${runtimeReport.sessions.length} sessions`,
    });
    results.push({
      name: 'Background Tasks',
      status: taskReport.staleRunningCount === 0 ? '✅' : '⚠️',
      detail: formatTaskSummary(taskReport),
    });
    results.push({
      name: 'Token Waste',
      status: wasteReport.nearValveCount === 0 ? '✅' : '⚠️',
      detail: formatTokenWasteSummary(wasteReport),
    });
  } catch (e) {
    results.push({ name: 'Turn Journal', status: '❌', detail: `Runtime scan failed: ${e.message}` });
  }

  // 13. SQLite integrity check
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const first = rows[0] || {};
    const v = first.integrity_check ?? first.value ?? Object.values(first)[0];
    if (v === 'ok') {
      results.push({ name: 'SQLite Integrity', status: '✅', detail: 'ok' });
    } else {
      const summary = rows.slice(0, 3).map(r => Object.values(r)[0]).join('; ');
      results.push({ name: 'SQLite Integrity', status: '❌', detail: summary });
    }
  } catch (e) {
    results.push({ name: 'SQLite Integrity', status: '⚠️', detail: e.message });
  }

  // 14. Owner isolation consistency
  try {
    const scopeOn = process.env.ENGINE_OWNER_SCOPE === '1';
    const nodeOwners = db.prepare("SELECT owner_id, COUNT(*) as c FROM nodes WHERE state='active' GROUP BY owner_id").all();
    const edgeNull = db.prepare('SELECT COUNT(*) as c FROM edges WHERE owner_id IS NULL').get().c;
    const nodeNull = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE owner_id IS NULL').get().c;
    const distinctOwners = nodeOwners.filter(r => r.owner_id !== null).length;
    if (scopeOn && (nodeNull > 0 || edgeNull > 0)) {
      results.push({ name: 'Owner Isolation', status: '❌', detail: `ENGINE_OWNER_SCOPE=1 but ${nodeNull} nodes / ${edgeNull} edges have NULL owner_id` });
    } else if (distinctOwners > 1) {
      const breakdown = nodeOwners.map(r => `${r.owner_id ?? 'null'}:${r.c}`).join(', ');
      results.push({ name: 'Owner Isolation', status: '⚠️', detail: `${distinctOwners} owner ids present — ${breakdown}` });
    } else {
      results.push({ name: 'Owner Isolation', status: '✅', detail: scopeOn ? `scope=1, single owner` : `scope=0, single owner` });
    }
  } catch (e) {
    results.push({ name: 'Owner Isolation', status: '⚠️', detail: e.message });
  }

  // 15. Mímir health + model files
  try {
    const mimirPort = config.mimir?.port || 18810;
    const reachable = await checkPort('127.0.0.1', mimirPort, 1500);
    if (!reachable) {
      results.push({ name: 'Mímir Daemon', status: '❌', detail: `port ${mimirPort} not listening` });
    } else {
      let healthDetail = `port ${mimirPort} listening`;
      let healthStatus = '✅';
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2000);
        const r = await fetch(`http://127.0.0.1:${mimirPort}/status`, { signal: ac.signal });
        clearTimeout(t);
        if (r.ok) {
          let body;
          try { body = await r.json(); } catch { body = null; }
          if (body && typeof body === 'object') {
            const parts = [];
            if (body.status) parts.push(body.status);
            if (body.tick != null) parts.push(`tick=${body.tick}`);
            if (body.n_nodes != null) parts.push(`nodes=${body.n_nodes}`);
            healthDetail = parts.length ? parts.join(', ') : `status ${r.status}`;
            if (body.status && body.status !== 'running' && body.status !== 'ok') {
              healthStatus = '⚠️';
            }
          } else {
            healthDetail = `status ${r.status}`;
          }
        } else {
          healthStatus = '⚠️';
          healthDetail = `/status ${r.status}`;
        }
      } catch (probeErr) {
        healthStatus = '⚠️';
        healthDetail = `/status probe failed: ${probeErr.message?.slice(0, 80)}`;
      }
      results.push({ name: 'Mímir Daemon', status: healthStatus, detail: healthDetail });
    }
  } catch (e) {
    results.push({ name: 'Mímir Daemon', status: '⚠️', detail: e.message });
  }

  // 16. Repo Manifest (file integrity vs recorded baseline — advisory only)
  // NOTE: Drift is reported but NEVER treated as an error and NEVER auto-repaired.
  // Legitimate edits naturally produce drift; only explicit /api/doctor/manifest/repair
  // (with confirm=true) rolls files back from snapshots.
  try {
    const manifestMgr = new RepoManifestManager(db);
    manifestMgr.ensureTable();
    const hasManifest = db.prepare('SELECT COUNT(*) as c FROM repo_manifest').get().c > 0;
    if (!hasManifest) {
      results.push({ name: 'Repo Manifest', status: '✅', detail: 'no baseline seeded (optional — POST /api/doctor/manifest/seed to enable)' });
    } else {
      const v = manifestMgr.verify();
      if (v.mismatches.length === 0) {
        results.push({ name: 'Repo Manifest', status: '✅', detail: `${v.ok}/${v.total} files match baseline` });
      } else {
        const preview = v.mismatches.slice(0, 3).map(m => `${m.path}(${m.reason})`).join(', ');
        const more = v.mismatches.length > 3 ? `, +${v.mismatches.length - 3} more` : '';
        // Advisory (not error): drift usually means legitimate edits. Re-seed to accept current state.
        results.push({
          name: 'Repo Manifest',
          status: '⚠️',
          detail: `${v.mismatches.length} drift (advisory): ${preview}${more} — re-seed to accept`,
          advisory: true,
        });
      }
    }
  } catch (e) {
    results.push({ name: 'Repo Manifest', status: '⚠️', detail: e.message });
  }

  // 17a. Graph integrity (dangling edges, null created_at, duplicate tags, orphan owner)
  try {
    const gi = scanGraphIntegrity(db);
    const status = gi.issueCount === 0 ? '✅' : (gi.danglingEdgeCount > 0 || gi.orphanOwnerEdgeCount > 0 ? '❌' : '⚠️');
    results.push({ name: 'Graph Integrity', status, detail: formatGraphIntegritySummary(gi) });
  } catch (e) {
    results.push({ name: 'Graph Integrity', status: '⚠️', detail: `scan failed: ${e.message}` });
  }

  // 17b. Mímir embedding cache drift
  try {
    const md = await scanMimirEmbeddingDrift(db, config);
    const status = md.status === 'fresh' ? '✅'
      : (md.status === 'lagging' || md.status === 'missing') ? '⚠️'
      : (md.status === 'stale') ? '❌'
      : '✅'; // empty_db / unknown → non-actionable
    results.push({ name: 'Mímir Embedding Drift', status, detail: formatMimirDriftSummary(md) });
  } catch (e) {
    results.push({ name: 'Mímir Embedding Drift', status: '⚠️', detail: `scan failed: ${e.message}` });
  }

  // 17c. Regression sentinels (auto-resume orphans, leaked digest nodes, null session_id)
  try {
    const rs = scanRegressionSentinels(db);
    const status = rs.issueCount === 0 ? '✅' : '⚠️';
    results.push({ name: 'Regression Sentinels', status, detail: formatRegressionSentinelSummary(rs) });
  } catch (e) {
    results.push({ name: 'Regression Sentinels', status: '⚠️', detail: `scan failed: ${e.message}` });
  }

  // 17. Recent error count (tail engine.jsonl)
  try {
    const logPath = resolve(PROJECT_ROOT, 'logs', 'engine.jsonl');
    if (!existsSync(logPath)) {
      results.push({ name: 'Recent Errors', status: '✅', detail: 'no engine.jsonl yet' });
    } else {
      const raw = readFileSync(logPath, 'utf-8');
      const lines = raw.split('\n').slice(-500);
      const cutoff = Date.now() - 60 * 60_000; // last hour
      let errCount = 0;
      let sample = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.level !== 'error' && e.level !== 'fatal') continue;
          if (e.ts && Date.parse(e.ts) < cutoff) break;
          errCount++;
          if (!sample) sample = `[${e.component}] ${String(e.msg || '').slice(0, 80)}`;
        } catch {}
      }
      if (errCount === 0) {
        results.push({ name: 'Recent Errors', status: '✅', detail: 'no errors in last hour' });
      } else {
        results.push({
          name: 'Recent Errors',
          status: errCount > 10 ? '❌' : '⚠️',
          detail: `${errCount} in last hour — ${sample}`,
        });
      }
    }
  } catch (e) {
    results.push({ name: 'Recent Errors', status: '⚠️', detail: e.message });
  }

  // Tag each result with a UI section for grouped rendering.
  const SECTION_BY_NAME = {
    'Database': 'engine',
    'Source Files': 'engine',
    'Identity Files': 'engine',
    'WAL Size': 'engine',
    'Disk Space': 'engine',
    'Dependencies': 'engine',
    'Config File': 'engine',
    'SQLite Integrity': 'engine',
    'Repo Manifest': 'engine',
    'Turn Journal': 'runtime',
    'Pending Tool Runs': 'runtime',
    'Background Tasks': 'runtime',
    'Token Waste': 'runtime',
    'Transcript Integrity': 'runtime',
    'Owner Isolation': 'runtime',
    'Mímir Daemon': 'subsystem',
    'Mímir Embedding Drift': 'subsystem',
    'Graph Integrity': 'subsystem',
    'Regression Sentinels': 'subsystem',
    'Recent Errors': 'subsystem',
  };
  for (const r of results) {
    if (!r.section) r.section = SECTION_BY_NAME[r.name] || 'subsystem';
  }

  return results;
}

// ─── Auto-Repair ────────────────────────────────────────────────────────────

/**
 * Auto-repair issues found by diagnose.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} config
 * @param {CheckResult[]} issues - Results from diagnose()
 * @param {SnapshotManager} [snapshotManager]
 * @returns {Promise<CheckResult[]>} Repair results
 */
export async function repair(db, config, issues, snapshotManager, options = {}) {
  const repairs = [];
  const taskManager = options.taskManager || null;

  for (const issue of issues) {
    if (issue.status === '✅') continue;

    switch (issue.name) {
      case 'WAL Size': {
        if (issue.detail.includes('MB')) {
          try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            repairs.push({ name: 'WAL Checkpoint', status: '✅', detail: 'Truncated WAL', autoFixed: true });
          } catch (e) {
            repairs.push({ name: 'WAL Checkpoint', status: '❌', detail: e.message });
          }
        }
        break;
      }

      case 'Source Files': {
        // Try to rollback broken files
        if (snapshotManager && issue.detail) {
          const fileMatches = issue.detail.match(/(\w[\w-]*\.js):/g);
          if (fileMatches) {
            for (const match of fileMatches) {
              const filename = match.replace(':', '');
              const filePath = resolve(SRC_DIR, filename);
              const result = snapshotManager.rollback(filePath);
              repairs.push({
                name: `Rollback ${filename}`,
                status: result.success ? '✅' : '❌',
                detail: result.detail,
                autoFixed: result.success,
              });
            }
          }
        }
        break;
      }

      case 'Dependencies': {
        if (issue.detail.includes('Missing')) {
          try {
            execSync('npm install --production 2>&1', {
              cwd: PROJECT_ROOT,
              timeout: 60_000,
              encoding: 'utf-8',
            });
            repairs.push({ name: 'npm install', status: '✅', detail: 'Dependencies restored', autoFixed: true });
          } catch (e) {
            repairs.push({ name: 'npm install', status: '❌', detail: `Failed: ${e.message.slice(0, 200)}` });
          }
        }
        break;
      }

      case 'Config File': {
        if (issue.status === '❌') {
          try {
            // Try to rebuild from defaults
            const { DEFAULTS } = await import('./config.js');
            const configPath = resolve(PROJECT_ROOT, 'config.json');
            // If file exists but corrupted, backup first
            if (existsSync(configPath)) {
              const backup = configPath + '.bak.' + Date.now();
              writeFileSync(backup, readFileSync(configPath, 'utf-8'), 'utf-8');
            }
            // Don't overwrite with pure defaults — that would lose all customization
            repairs.push({ name: 'Config Recovery', status: '⚠️', detail: 'Config corrupted. Backup created. Manual review needed.' });
          } catch (e) {
            repairs.push({ name: 'Config Recovery', status: '❌', detail: e.message });
          }
        }
        break;
      }

      case 'Cron Table': {
        if (issue.detail.includes('not found')) {
          try {
            db.exec(`
              CREATE TABLE IF NOT EXISTS cron_jobs (
                name TEXT PRIMARY KEY,
                schedule TEXT NOT NULL,
                mode TEXT DEFAULT 'agentTurn',
                prompt TEXT DEFAULT '',
                delivery INTEGER DEFAULT 1,
                enabled INTEGER DEFAULT 1,
                created_at TEXT DEFAULT (datetime('now'))
              )
            `);
            repairs.push({ name: 'Cron Table', status: '✅', detail: 'Table created', autoFixed: true });
          } catch (e) {
            repairs.push({ name: 'Cron Table', status: '❌', detail: e.message });
          }
        }
        break;
      }

      // NOTE: 'Repo Manifest' is intentionally NOT auto-repaired here.
      // Rolling back legitimate in-progress edits is a catastrophic UX failure.
      // Manifest repair must be triggered explicitly via /api/doctor/manifest/repair
      // with confirm=true in the body, never as a side-effect of generic /doctor repair.

      default:
        // No auto-repair for other issues
        break;
    }
  }

  try {
    const transcriptIntegrity = getTranscriptIntegrityManager(db, options.transcriptIntegrity);
    const transcriptResult = transcriptIntegrity.repair({
      provider: options.provider || 'anthropic',
      mode: options.transcriptMode || 'safe',
      limit: options.transcriptLimit || 25,
      dryRun: false,
    });
    repairs.push({
      name: 'Transcript Integrity',
      status: transcriptResult.sessions.some(s => !(s.verification?.ok)) ? '⚠️' : '✅',
      detail: formatTranscriptRepairSummary(transcriptResult),
      autoFixed: transcriptResult.repairedActions > 0,
    });
  } catch (e) {
    repairs.push({ name: 'Transcript Integrity', status: '❌', detail: `Repair failed: ${e.message}` });
  }

  try {
    const runtimeResult = recoverRuntimeState(db, {
      sessionId: options.sessionId,
      staleOlderThan: options.runtimeOlderThan || '-15 minutes',
      limit: options.runtimeLimit || 50,
      dryRun: false,
    });
    repairs.push({
      name: 'Runtime Journal Recovery',
      status: (runtimeResult.stalePendingCount === 0 && runtimeResult.stuckTurnCount === 0) ? '✅' : '⚠️',
      detail: `${runtimeResult.recoveredPending} pending runs aborted, ${runtimeResult.recoveredTurns} turns recovered; remaining ${formatRuntimeSummary(runtimeResult)}`,
      autoFixed: (runtimeResult.recoveredPending + runtimeResult.recoveredTurns) > 0,
    });
  } catch (e) {
    repairs.push({ name: 'Runtime Journal Recovery', status: '❌', detail: `Recovery failed: ${e.message}` });
  }

  if (repairs.length === 0) {
    repairs.push({ name: 'No Repairs', status: '✅', detail: 'Nothing to fix or no auto-fix available' });
  }

  return repairs;
}

// ─── Dashboard Integration ──────────────────────────────────────────────────

/**
 * Register doctor API routes on an existing HTTP server handler.
 * Returns a route handler function to be called from dashboard's server.
 * 
 * @param {Object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {Object} deps.config
 * @param {SnapshotManager} deps.snapshotManager
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, path: string, method: string, readBody: Function, json: Function) => Promise<boolean>}
 */
export function createDoctorRoutes({ db, config, snapshotManager, transcriptIntegrity, taskManager }) {
  /**
   * Handle doctor API routes.
   * @returns {boolean} true if route was handled
   */
  return async (req, res, path, method, readBody, json) => {
    // GET /api/doctor — run diagnostics
    if (path === '/api/doctor' && method === 'GET') {
      const results = await diagnose(db, config, snapshotManager, { transcriptIntegrity, taskManager });
      json(res, { results, timestamp: new Date().toISOString() });
      return true;
    }

    // GET /api/doctor/snapshots?file=xxx
    if (path === '/api/doctor/snapshots' && method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const file = url.searchParams.get('file');
      if (!file) {
        json(res, { error: 'file parameter required' }, 400);
        return true;
      }
      const snapshots = snapshotManager.listSnapshots(file);
      json(res, { snapshots });
      return true;
    }

    // POST /api/doctor/repair
    if (path === '/api/doctor/repair' && method === 'POST') {
      const issues = await diagnose(db, config, snapshotManager, { transcriptIntegrity, taskManager });
      const repairResults = await repair(db, config, issues, snapshotManager, { transcriptIntegrity, taskManager });
      json(res, { repairs: repairResults, timestamp: new Date().toISOString() });
      return true;
    }

    // POST /api/doctor/manifest/seed — capture current repo state as baseline
    if (path === '/api/doctor/manifest/seed' && method === 'POST') {
      try {
        const mgr = new RepoManifestManager(db);
        const out = mgr.seed();
        json(res, { ok: true, ...out });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/manifest/verify — compare disk vs manifest
    if (path === '/api/doctor/manifest/verify' && method === 'GET') {
      try {
        const mgr = new RepoManifestManager(db);
        mgr.ensureTable();
        const result = mgr.verify();
        json(res, { ok: true, ...result });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return true;
    }

    // POST /api/doctor/manifest/repair — restore mismatched files from snapshots
    // SAFETY: requires explicit { confirm: true } in body. Use dryRun:true to preview.
    if (path === '/api/doctor/manifest/repair' && method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req) || '{}');
        const mgr = new RepoManifestManager(db);
        if (body.dryRun === true) {
          const preview = mgr.verify();
          json(res, { ok: true, dryRun: true, ...preview });
          return true;
        }
        if (body.confirm !== true) {
          json(res, {
            ok: false,
            error: 'manifest repair is destructive — send { confirm: true } to proceed or { dryRun: true } to preview',
          }, 400);
          return true;
        }
        const result = mgr.repairFromSnapshots(snapshotManager);
        json(res, { ok: true, ...result });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return true;
    }

    // POST /api/doctor/rollback
    if (path === '/api/doctor/rollback' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.file) {
        json(res, { error: 'file is required' }, 400);
        return true;
      }
      const result = body.snapshotId
        ? snapshotManager.rollbackTo(body.file, body.snapshotId)
        : snapshotManager.rollback(body.file);
      json(res, result);
      return true;
    }

    // GET /api/doctor/runtime?action=scan&sessionId=...
    if (path === '/api/doctor/runtime' && method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const report = scanRuntimeJournal(db, { sessionId, staleOlderThan: url.searchParams.get('olderThan') || '-15 minutes', limit: Number(url.searchParams.get('limit') || 25) });
      json(res, report);
      return true;
    }

    // POST /api/doctor/runtime/recover
    if (path === '/api/doctor/runtime/recover' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const report = recoverRuntimeState(db, {
        sessionId: body.sessionId || undefined,
        staleOlderThan: body.olderThan || '-15 minutes',
        limit: Number(body.limit || 50),
      });
      json(res, report);
      return true;
    }

    // GET /api/doctor/tasks?action=scan&sessionId=...
    if (path === '/api/doctor/tasks' && method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const olderMs = Number(url.searchParams.get('olderMs') || 15 * 60_000);
      const report = scanQueuedTasks(taskManager, { sessionId, olderThanMs: olderMs, limit: Number(url.searchParams.get('limit') || 25) });
      json(res, report);
      return true;
    }

    // POST /api/doctor/tasks/recover
    if (path === '/api/doctor/tasks/recover' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const report = recoverQueuedTasks(taskManager, {
        sessionId: body.sessionId || undefined,
        olderThanMs: Number(body.olderMs || 15 * 60_000),
        limit: Number(body.limit || 50),
        dryRun: Boolean(body.dryRun),
      });
      json(res, report);
      return true;
    }

    // GET /api/doctor/token-waste?sessionId=...&limit=...
    if (path === '/api/doctor/token-waste' && method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const limit = Number(url.searchParams.get('limit') || 25);
      json(res, scanTokenWaste(db, { sessionId, limit }));
      return true;
    }

    // GET /api/doctor/transcript?action=scan|verify&sessionId=...&limit=...
    if (path === '/api/doctor/transcript' && method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const action = (url.searchParams.get('action') || 'scan').toLowerCase();
      const sessionId = url.searchParams.get('sessionId') || undefined;
      const limit = Number(url.searchParams.get('limit') || 25);
      const manager = getTranscriptIntegrityManager(db, transcriptIntegrity);
      if (action === 'verify') {
        json(res, manager.verify({ sessionId, limit, provider: 'anthropic' }));
      } else {
        json(res, manager.scan({ sessionId, limit, provider: 'anthropic', persist: false }));
      }
      return true;
    }

    // POST /api/doctor/transcript/repair
    if (path === '/api/doctor/transcript/repair' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const manager = getTranscriptIntegrityManager(db, transcriptIntegrity);
      const result = manager.repair({
        sessionId: body.sessionId || undefined,
        limit: Number(body.limit || 25),
        mode: body.mode === 'aggressive' ? 'aggressive' : 'safe',
        provider: 'anthropic',
        dryRun: Boolean(body.dryRun),
      });
      json(res, result);
      return true;
    }

    // GET /api/doctor/injections?limit=50
    // Tails engine-output/injection-log.jsonl. The writer (src/injection-log.js)
    // already PII-hashes session/speaker/message — this endpoint just reads.
    if (path === '/api/doctor/injections' && method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)));
        const logPath = resolve(PROJECT_ROOT, 'engine-output', 'injection-log.jsonl');
        if (!existsSync(logPath)) { json(res, { entries: [] }); return true; }
        const raw = readFileSync(logPath, 'utf-8');
        const lines = raw.split('\n').filter(Boolean).slice(-limit * 2);
        const entries = [];
        for (const l of lines) {
          try { entries.push(JSON.parse(l)); } catch {}
        }
        json(res, { entries: entries.slice(-limit) });
      } catch (e) {
        json(res, { entries: [], error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/errors?limit=50&hours=24
    // Tails logs/engine.jsonl for warn/error/fatal entries within the window.
    if (path === '/api/doctor/errors' && method === 'GET') {
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)));
        const hours = Math.max(1, Math.min(168, Number(url.searchParams.get('hours') || 24)));
        const logPath = resolve(PROJECT_ROOT, 'logs', 'engine.jsonl');
        if (!existsSync(logPath)) { json(res, { entries: [] }); return true; }
        const raw = readFileSync(logPath, 'utf-8');
        const lines = raw.split('\n').slice(-2000);
        const cutoff = Date.now() - hours * 3600_000;
        const keep = new Set(['warn', 'error', 'fatal']);
        const entries = [];
        for (const l of lines) {
          if (!l) continue;
          try {
            const e = JSON.parse(l);
            if (!keep.has(e.level)) continue;
            if (e.ts && Date.parse(e.ts) < cutoff) continue;
            entries.push(e);
          } catch {}
        }
        json(res, { entries: entries.slice(-limit) });
      } catch (e) {
        json(res, { entries: [], error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/graph-integrity
    if (path === '/api/doctor/graph-integrity' && method === 'GET') {
      try {
        json(res, scanGraphIntegrity(db));
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/mimir-drift
    if (path === '/api/doctor/mimir-drift' && method === 'GET') {
      try {
        json(res, await scanMimirEmbeddingDrift(db, config));
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/regression-sentinels
    if (path === '/api/doctor/regression-sentinels' && method === 'GET') {
      try {
        json(res, scanRegressionSentinels(db));
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
      return true;
    }

    // GET /api/doctor/support-bundle — one-shot PII-safe forensic export
    // Bundles: diagnose results, graph/drift/sentinel scans, recent errors,
    // system info, table row counts, sanitized config. No raw node content.
    if (path === '/api/doctor/support-bundle' && method === 'GET') {
      try {
        const bundle = { generated_at: new Date().toISOString(), schema_version: 1 };
        bundle.diagnose = await diagnose(db, config, snapshotManager, { transcriptIntegrity, taskManager });
        bundle.graph_integrity = (() => { try { return scanGraphIntegrity(db); } catch (e) { return { error: e.message }; } })();
        bundle.mimir_drift = await (async () => { try { return await scanMimirEmbeddingDrift(db, config); } catch (e) { return { error: e.message }; } })();
        bundle.regression_sentinels = (() => { try { return scanRegressionSentinels(db); } catch (e) { return { error: e.message }; } })();
        bundle.system = {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch,
          uptime_s: Math.round(process.uptime()),
          memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        };
        bundle.tables = {};
        try {
          const tables = ['nodes', 'edges', 'turn_journal', 'pending_tool_runs', 'messages', 'api_calls', 'cron_jobs', 'file_snapshots'];
          for (const t of tables) {
            try { bundle.tables[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; }
            catch { bundle.tables[t] = null; }
          }
        } catch {}
        try {
          const raw = readFileSync(resolve(PROJECT_ROOT, 'logs', 'engine.jsonl'), 'utf-8');
          const lines = raw.split('\n').slice(-500);
          const cutoff = Date.now() - 24 * 3600_000;
          const errors = [];
          for (const l of lines) {
            if (!l) continue;
            try {
              const e = JSON.parse(l);
              if (!['warn', 'error', 'fatal'].includes(e.level)) continue;
              if (e.ts && Date.parse(e.ts) < cutoff) continue;
              errors.push({ ts: e.ts, level: e.level, component: e.component, msg: String(e.msg || '').slice(0, 200) });
            } catch {}
          }
          bundle.recent_errors = errors.slice(-100);
        } catch { bundle.recent_errors = []; }
        // Sanitized config — strip keys, URLs with creds, tokens.
        const sanitize = (v) => {
          if (v == null) return v;
          if (typeof v !== 'object') return v;
          if (Array.isArray(v)) return v.map(sanitize);
          const out = {};
          for (const [k, val] of Object.entries(v)) {
            if (/key|token|secret|password|auth/i.test(k)) out[k] = '[redacted]';
            else out[k] = sanitize(val);
          }
          return out;
        };
        bundle.config = sanitize(config);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="constellation-support-bundle-' + Date.now() + '.json"');
        res.end(JSON.stringify(bundle, null, 2));
      } catch (e) {
        json(res, { error: e.message }, 500);
      }
      return true;
    }

    // POST /api/doctor/rollback-all
    if (path === '/api/doctor/rollback-all' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.before) {
        json(res, { error: 'before timestamp is required' }, 400);
        return true;
      }
      const result = snapshotManager.rollbackAll(body.before);
      json(res, result);
      return true;
    }

    return false;
  };
}

/**
 * Generate the Doctor section HTML for the dashboard.
 * @returns {string}
 */
export function doctorDashboardHTML() {
  return `
<h2>🩺 Doctor</h2>
<div id="doctor-section">
  <div style="margin-bottom:12px">
    <button class="btn" onclick="runDoctor()">🔍 Run Diagnosis</button>
    <button class="btn" onclick="runRepair()" style="margin-left:8px">🔧 Auto-Repair</button>
    <button class="btn" onclick="scanTranscript()" style="margin-left:8px">🧵 Scan Transcript</button>
    <button class="btn" onclick="repairTranscript()" style="margin-left:8px">🩹 Repair Transcript</button>
    <button class="btn" onclick="verifyTranscript()" style="margin-left:8px">✅ Verify Transcript</button>
  </div>
  <div style="margin-bottom:12px">
    <strong>Repo Manifest:</strong>
    <button class="btn" onclick="seedManifest()" style="margin-left:8px">📜 Seed Baseline</button>
    <button class="btn" onclick="verifyManifest()" style="margin-left:8px">🔎 Verify</button>
    <button class="btn" onclick="repairManifest()" style="margin-left:8px">🔧 Repair from Snapshots</button>
  </div>
  <div style="margin-bottom:12px">
    <div style="margin:10px 0 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <strong>Runtime Recovery:</strong>
      <input id="runtime-session" placeholder="Optional sessionId" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:4px 8px;border-radius:4px;width:220px">
      <button class="btn" onclick="scanRuntimeJournalUI()">🧰 Scan Runtime</button>
      <button class="btn" onclick="recoverRuntimeUI()">🚑 Recover Runtime</button>
      <button class="btn" onclick="scanTaskQueueUI()">🗂 Scan Tasks</button>
      <button class="btn" onclick="recoverTaskQueueUI()">♻️ Recover Tasks</button>
    </div>
    <input id="transcript-session" placeholder="Optional sessionId" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:4px 8px;border-radius:4px;width:220px">
    <select id="transcript-mode" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:4px 8px;border-radius:4px">
      <option value="safe">safe repair</option>
      <option value="aggressive">aggressive repair</option>
    </select>
  </div>
  <div id="doctor-results"></div>
  <div id="doctor-rollback" style="margin-top:12px">
    <input id="rollback-file" placeholder="File path to rollback" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;padding:4px 8px;border-radius:4px;width:300px">
    <button class="btn" onclick="rollbackFile()">⏪ Rollback</button>
    <button class="btn" onclick="listSnapshots()">📋 Snapshots</button>
  </div>
  <div id="snapshot-list" style="margin-top:8px"></div>
</div>

<script>
async function runDoctor() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '⏳ Running...';
  try {
    const r = await fetch('/api/doctor').then(r=>r.json());
    el.innerHTML = '<table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>'
      + r.results.map(c => '<tr><td>'+esc(c.name)+'</td><td>'+c.status+'</td><td>'+esc(c.detail)+'</td></tr>').join('')
      + '</tbody></table>';
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function runRepair() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🔧 Repairing...';
  try {
    const r = await fetch('/api/doctor/repair', {method:'POST'}).then(r=>r.json());
    el.innerHTML = '<table><thead><tr><th>Repair</th><th>Status</th><th>Detail</th></tr></thead><tbody>'
      + r.repairs.map(c => '<tr><td>'+esc(c.name)+'</td><td>'+c.status+'</td><td>'+esc(c.detail)+'</td></tr>').join('')
      + '</tbody></table>';
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function rollbackFile() {
  const file = document.getElementById('rollback-file').value;
  if (!file) return alert('Enter file path');
  try {
    const r = await fetch('/api/doctor/rollback', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file})}).then(r=>r.json());
    alert(r.detail || JSON.stringify(r));
  } catch(e) { alert(e.message); }
}
async function listSnapshots() {
  const file = document.getElementById('rollback-file').value;
  if (!file) return alert('Enter file path');
  try {
    const r = await fetch('/api/doctor/snapshots?file='+encodeURIComponent(file)).then(r=>r.json());
    const el = document.getElementById('snapshot-list');
    if (!r.snapshots?.length) { el.innerHTML = 'No snapshots'; return; }
    el.innerHTML = '<table><thead><tr><th>#</th><th>Hash</th><th>Reason</th><th>Time</th><th>Action</th></tr></thead><tbody>'
      + r.snapshots.map(s => '<tr><td>'+s.id+'</td><td><code>'+esc(s.hash.slice(0,12))+'</code></td><td>'+esc(s.reason)+'</td><td>'+esc(s.created_at)+'</td>'
        +'<td><button class="btn" onclick="rollbackTo(\\''+esc(file)+'\\','+s.id+')">⏪</button></td></tr>').join('')
      + '</tbody></table>';
  } catch(e) { document.getElementById('snapshot-list').innerHTML = '❌ ' + e.message; }
}
async function seedManifest() {
  const el = document.getElementById('doctor-results');
  if (!confirm('Seed current repo state as the trusted baseline? Previous manifest will be replaced.')) return;
  el.innerHTML = '📜 Seeding manifest...';
  try {
    const r = await fetch('/api/doctor/manifest/seed', {method:'POST'}).then(r=>r.json());
    if (r.ok) {
      el.innerHTML = '✅ Seeded '+r.count+' file(s) at '+esc(r.capturedAt);
    } else {
      el.innerHTML = '❌ '+esc(r.error || 'seed failed');
    }
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function verifyManifest() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🔎 Verifying manifest...';
  try {
    const r = await fetch('/api/doctor/manifest/verify').then(r=>r.json());
    if (!r.ok) { el.innerHTML = '❌ '+esc(r.error || 'verify failed'); return; }
    const baseline = r.capturedAt ? 'Baseline: '+esc(r.capturedAt) : '<em>No baseline — click Seed Baseline first.</em>';
    let body = '<p>'+baseline+'</p><p>OK: '+r.ok+'/'+r.total+' | Mismatches: '+r.mismatches.length+' | Extra: '+r.extra.length+'</p>';
    if (r.mismatches.length) {
      body += '<table><thead><tr><th>Path</th><th>Reason</th></tr></thead><tbody>'
        + r.mismatches.map(m => '<tr><td><code>'+esc(m.path)+'</code></td><td>'+esc(m.reason)+'</td></tr>').join('')
        + '</tbody></table>';
    }
    el.innerHTML = body;
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function repairManifest() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🔎 Previewing (dry-run)...';
  try {
    const preview = await fetch('/api/doctor/manifest/repair', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({dryRun:true}),
    }).then(r=>r.json());
    if (!preview.ok) { el.innerHTML = '❌ '+esc(preview.error || 'preview failed'); return; }
    const mismatches = preview.mismatches || [];
    if (!mismatches.length) { el.innerHTML = '✅ No mismatches detected — nothing to repair.'; return; }
    const confirmMsg = 'Restore '+mismatches.length+' file(s) from snapshots? On-disk contents will be overwritten. This is destructive.';
    if (!confirm(confirmMsg)) { el.innerHTML = '🛑 Cancelled. '+mismatches.length+' mismatch(es) left untouched.'; return; }
    el.innerHTML = '🔧 Repairing from snapshots...';
    const r = await fetch('/api/doctor/manifest/repair', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({confirm:true}),
    }).then(r=>r.json());
    if (!r.ok) { el.innerHTML = '❌ '+esc(r.error || 'repair failed'); return; }
    let body = '<p>Restored '+r.repaired.length+'/'+r.totalMismatches+' file(s). Unresolvable: '+r.failed.length+'</p>';
    if (r.repaired.length) body += '<p>✅ Restored:</p><ul>' + r.repaired.map(p => '<li><code>'+esc(p)+'</code></li>').join('') + '</ul>';
    if (r.failed.length) body += '<p>❌ Unresolvable:</p><ul>' + r.failed.map(f => '<li><code>'+esc(f.path)+'</code> — '+esc(f.reason_detail || '')+'</li>').join('') + '</ul>';
    el.innerHTML = body;
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function rollbackTo(file, id) {
  try {
    const r = await fetch('/api/doctor/rollback', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file,snapshotId:id})}).then(r=>r.json());
    alert(r.detail || JSON.stringify(r));
  } catch(e) { alert(e.message); }
}
async function scanRuntimeJournalUI() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🧰 Scanning runtime journal...';
  try {
    const sessionId = document.getElementById('runtime-session').value.trim();
    const qs = new URLSearchParams();
    if (sessionId) qs.set('sessionId', sessionId);
    const r = await fetch('/api/doctor/runtime?' + qs.toString()).then(r=>r.json());
    renderTranscriptTable('Runtime Journal', r.sessions || [], [
      { title: 'Session', render: s => s.sessionId },
      { title: 'Stale pending', render: s => s.stalePending },
      { title: 'Stuck turns', render: s => s.stuckTurns },
      { title: 'Failed turns', render: s => s.failedTurns },
    ]);
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function recoverRuntimeUI() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🚑 Recovering runtime state...';
  try {
    const sessionId = document.getElementById('runtime-session').value.trim();
    const r = await fetch('/api/doctor/runtime/recover', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId: sessionId || undefined})}).then(r=>r.json());
    renderTranscriptTable('Runtime Recovery', r.actions || [], [
      { title: 'Action', render: a => a.type },
      { title: 'Session', render: a => a.sessionId },
      { title: 'Turn', render: a => a.turnId || '' },
      { title: 'Tool/Reason', render: a => a.toolName || a.reason || '' },
    ]);
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
function transcriptParams() {
  const sessionId = document.getElementById('transcript-session').value.trim();
  const qs = new URLSearchParams();
  if (sessionId) qs.set('sessionId', sessionId);
  qs.set('limit', '25');
  return qs.toString();
}
function renderTranscriptTable(title, rows, columns) {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '<h3>'+esc(title)+'</h3><table><thead><tr>' + columns.map(c => '<th>'+esc(c.title)+'</th>').join('') + '</tr></thead><tbody>'
    + rows.map(row => '<tr>' + columns.map(c => '<td>'+esc(String(c.render(row) ?? ''))+'</td>').join('') + '</tr>').join('')
    + '</tbody></table>';
}
async function scanTaskQueueUI() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🗂 Scanning background tasks...';
  try {
    const sessionId = document.getElementById('runtime-session').value.trim();
    const qs = new URLSearchParams();
    if (sessionId) qs.set('sessionId', sessionId);
    const r = await fetch('/api/doctor/tasks?' + qs.toString()).then(r=>r.json());
    let html = '<h3>Background Tasks</h3><p>' + esc('Stale running: ' + r.staleRunningCount + ', pending: ' + r.pendingCount + ', failed: ' + r.failedCount) + '</p>';
    if (r.sessions?.length) html += '<ul>' + r.sessions.map(s => '<li><code>' + esc(s.sessionId || '(none)') + '</code>: stale ' + esc(String(s.staleRunning)) + ', pending ' + esc(String(s.pending)) + ', failed ' + esc(String(s.failed)) + '</li>').join('') + '</ul>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="color:#f85149">'+esc(e.message)+'</div>'; }
}

async function recoverTaskQueueUI() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '♻️ Recovering background tasks...';
  try {
    const sessionId = document.getElementById('runtime-session').value.trim();
    const r = await fetch('/api/doctor/tasks/recover', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId: sessionId || undefined})}).then(r=>r.json());
    let html = '<h3>Task Recovery</h3><p>' + esc('Recovered: ' + r.recovered + ', stale remaining: ' + r.staleRunningCount) + '</p>';
    if (r.actions?.length) html += '<ul>' + r.actions.map(a => '<li><code>' + esc(a.taskId) + '</code>: ' + esc(a.from) + ' → ' + esc(a.to) + ' (' + esc(a.taskType || '') + ')</li>').join('') + '</ul>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="color:#f85149">'+esc(e.message)+'</div>'; }
}

async function scanTranscript() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🧵 Scanning transcript...';
  try {
    const r = await fetch('/api/doctor/transcript?action=scan&' + transcriptParams()).then(r=>r.json());
    renderTranscriptTable('Transcript Scan', r.sessions || [], [
      { title: 'Session', render: s => s.sessionId },
      { title: 'Messages', render: s => s.messageCount },
      { title: 'Issues', render: s => s.issueCount },
      { title: 'Top types', render: s => (s.issues || []).slice(0,3).map(i => i.issueType).join(', ') || 'clean' },
    ]);
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function repairTranscript() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '🩹 Repairing transcript...';
  try {
    const sessionId = document.getElementById('transcript-session').value.trim();
    const mode = document.getElementById('transcript-mode').value;
    const r = await fetch('/api/doctor/transcript/repair', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId: sessionId || undefined, mode})}).then(r=>r.json());
    renderTranscriptTable('Transcript Repair', r.sessions || [], [
      { title: 'Session', render: s => s.sessionId },
      { title: 'Before', render: s => s.beforeIssueCount },
      { title: 'After', render: s => s.afterIssueCount },
      { title: 'Actions', render: s => (s.actions || []).map(a => a.actionType).join(', ') || 'none' },
    ]);
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
async function verifyTranscript() {
  const el = document.getElementById('doctor-results');
  el.innerHTML = '✅ Verifying transcript...';
  try {
    const r = await fetch('/api/doctor/transcript?action=verify&' + transcriptParams()).then(r=>r.json());
    renderTranscriptTable('Transcript Verify', r.sessions || [], [
      { title: 'Session', render: s => s.sessionId },
      { title: 'OK', render: s => s.ok ? 'yes' : 'no' },
      { title: 'Issue count', render: s => s.issueCount },
      { title: 'Top types', render: s => (s.issues || []).slice(0,3).map(i => i.issueType).join(', ') || 'clean' },
    ]);
  } catch(e) { el.innerHTML = '❌ ' + e.message; }
}
</script>`;
}

// ─── Telegram Command Handler ───────────────────────────────────────────────

/**
 * Format diagnose results for Telegram.
 * @param {CheckResult[]} results
 * @returns {string}
 */
export function formatDiagnoseForTelegram(results) {
  const lines = ['🩺 **Doctor Diagnosis**\n'];
  for (const r of results) {
    const fixed = r.autoFixed ? ' (auto-fixed)' : '';
    lines.push(`${r.status} **${r.name}**: ${r.detail}${fixed}`);
  }
  const ok = results.filter(r => r.status === '✅').length;
  const warn = results.filter(r => r.status === '⚠️').length;
  const fail = results.filter(r => r.status === '❌').length;
  lines.push(`\n**Summary**: ${ok} ✅ ${warn} ⚠️ ${fail} ❌`);
  return lines.join('\n');
}

/**
 * Handle /doctor Telegram command.
 * @param {Object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {Object} deps.config
 * @param {SnapshotManager} deps.snapshotManager
 * @param {string} text - Full command text after /doctor
 * @returns {Promise<string>} Response text
 */
export async function handleDoctorCommand({ db, config, snapshotManager, transcriptIntegrity, taskManager }, text) {
  const args = text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase() || '';

  if (subcommand === 'transcript') {
    const action = (args[1] || 'scan').toLowerCase();
    const maybeArg2 = args[2];
    const maybeArg3 = args[3];
    const manager = getTranscriptIntegrityManager(db, transcriptIntegrity);

    if (action === 'scan') {
      const report = manager.scan({ sessionId: maybeArg2, provider: 'anthropic', limit: 25, persist: false });
      const lines = ['🧵 **Transcript Scan**\n'];
      lines.push(`Sessions: ${report.sessionsScanned} | Issues: ${report.issueCount}`);
      for (const s of report.sessions.slice(0, 10)) {
        const top = (s.issues || []).slice(0, 3).map(i => i.issueType).join(', ') || 'clean';
        lines.push(`- \`${s.sessionId}\`: ${s.issueCount} issues (${top})`);
      }
      return lines.join('\n');
    }

    if (action === 'verify') {
      const report = manager.verify({ sessionId: maybeArg2, provider: 'anthropic', limit: 25 });
      const lines = ['✅ **Transcript Verify**\n'];
      lines.push(`Sessions: ${report.sessionsScanned} | Clean: ${report.okSessions} | Failed: ${report.failedSessions}`);
      for (const s of report.sessions.filter(s => !s.ok).slice(0, 10)) {
        const top = (s.issues || []).slice(0, 3).map(i => i.issueType).join(', ') || 'unknown';
        lines.push(`- \`${s.sessionId}\`: ${s.issueCount} issues (${top})`);
      }
      return lines.join('\n');
    }

    if (action === 'repair') {
      const explicitMode = ['safe', 'aggressive'].includes(maybeArg2) ? maybeArg2 : null;
      const mode = explicitMode || 'safe';
      const sessionId = explicitMode ? maybeArg3 : maybeArg2;
      const result = manager.repair({ sessionId, provider: 'anthropic', limit: 25, mode });
      const lines = ['🩹 **Transcript Repair**\n'];
      lines.push(`Mode: ${mode} | Actions: ${result.repairedActions} | Sessions repaired: ${result.repairedSessions}`);
      for (const s of result.sessions.slice(0, 10)) {
        const actions = (s.actions || []).map(a => a.actionType).slice(0, 4).join(', ') || 'none';
        lines.push(`- \`${s.sessionId}\`: ${s.beforeIssueCount} → ${s.afterIssueCount} (${actions})`);
      }
      return lines.join('\n');
    }

    return '⚠️ Usage: `/doctor transcript <scan|verify|repair> [sessionId]` or `/doctor transcript repair [safe|aggressive] [sessionId]`';
  }

  if (subcommand === 'token-waste' || subcommand === 'waste') {
    const sessionId = args[1] || undefined;
    const report = scanTokenWaste(db, { sessionId, limit: 25 });
    const lines = ['💸 **Token Waste**\n'];
    lines.push(formatTokenWasteSummary(report));
    for (const turn of report.wastefulTurns.slice(0, 8)) {
      lines.push(`- turn \`${turn.id}\` session=\`${turn.session_id}\` tools=${turn.tool_call_count} cache=${turn.tool_cache_hits} tokens=${turn.total_tokens} bytes=${turn.tool_result_bytes} stop=${turn.stop_reason || turn.stage || 'none'}`);
    }
    return lines.join('\n');
  }

  if (subcommand === 'runtime') {
    const action = (args[1] || 'scan').toLowerCase();
    const sessionId = args[2] || undefined;
    if (action === 'scan') {
      const report = scanRuntimeJournal(db, { sessionId, staleOlderThan: '-15 minutes', limit: 25 });
      const lines = ['🧰 **Runtime Journal**\n'];
      lines.push(formatRuntimeSummary(report));
      for (const s of report.sessions.slice(0, 10)) {
        lines.push(`- \`${s.sessionId}\`: pending ${s.stalePending}, stuck ${s.stuckTurns}, failed ${s.failedTurns}`);
      }
      return lines.join('\n');
    }
    if (action === 'recover') {
      const result = recoverRuntimeState(db, { sessionId, staleOlderThan: '-15 minutes', limit: 50 });
      const lines = ['🚑 **Runtime Recovery**\n'];
      lines.push(`${result.recoveredPending} pending runs aborted, ${result.recoveredTurns} turns recovered`);
      for (const a of result.actions.slice(0, 12)) {
        lines.push(`- ${a.type}: \`${a.sessionId}\`${a.turnId ? ` turn=${a.turnId}` : ''}${a.toolName ? ` tool=${a.toolName}` : ''}`);
      }
      return lines.join('\n');
    }
    return '⚠️ Usage: `/doctor runtime <scan|recover> [sessionId]`';
  }

  if (subcommand === 'tasks') {
    const action = (args[1] || 'scan').toLowerCase();
    const sessionId = args[2] || undefined;
    if (action === 'scan') {
      const report = scanQueuedTasks(taskManager, { sessionId, olderThanMs: 15 * 60_000, limit: 25 });
      const lines = ['🗂 **Task Queue**\n'];
      lines.push(formatTaskSummary(report));
      for (const s of report.sessions.slice(0, 10)) {
        lines.push(`- \`${s.sessionId || '(none)'}\`: stale ${s.staleRunning}, pending ${s.pending}, failed ${s.failed}`);
      }
      return lines.join('\n');
    }
    if (action === 'recover') {
      const result = recoverQueuedTasks(taskManager, { sessionId, olderThanMs: 15 * 60_000, limit: 50 });
      const lines = ['♻️ **Task Recovery**\n'];
      lines.push(`Recovered ${result.recovered} task(s); remaining ${formatTaskSummary(result)}`);
      for (const a of result.actions.slice(0, 12)) {
        lines.push(`- \`${a.taskId}\`: ${a.from} → ${a.to} (${a.taskType})`);
      }
      return lines.join('\n');
    }
    return '⚠️ Usage: `/doctor tasks <scan|recover> [sessionId]`';
  }

  if (subcommand === 'repair') {
    const issues = await diagnose(db, config, snapshotManager, { transcriptIntegrity, taskManager });
    const repairs = await repair(db, config, issues, snapshotManager, { transcriptIntegrity, taskManager });
    const lines = ['🔧 **Doctor Repair**\n'];
    for (const r of repairs) {
      lines.push(`${r.status} **${r.name}**: ${r.detail}`);
    }
    return lines.join('\n');
  }

  if (subcommand === 'rollback') {
    const file = args[1];
    if (!file) return '⚠️ Usage: `/doctor rollback <file_path>`';
    const result = snapshotManager.rollback(file);
    return result.success
      ? `✅ Rolled back: ${result.detail}`
      : `❌ Failed: ${result.detail}`;
  }

  if (subcommand === 'manifest') {
    const action = (args[1] || 'verify').toLowerCase();
    const mgr = new RepoManifestManager(db);
    if (action === 'seed') {
      const out = mgr.seed();
      return `📜 **Manifest Seeded**\n${out.count} file(s) captured at ${out.capturedAt}`;
    }
    if (action === 'verify') {
      mgr.ensureTable();
      const v = mgr.verify();
      const lines = ['📜 **Manifest Verify**'];
      lines.push(v.capturedAt ? `Baseline: ${v.capturedAt}` : 'No baseline recorded — run `/doctor manifest seed`');
      lines.push(`OK: ${v.ok}/${v.total} | Mismatches: ${v.mismatches.length} | Extra: ${v.extra.length}`);
      for (const m of v.mismatches.slice(0, 10)) {
        lines.push(`- ${m.reason === 'missing' ? '❌' : '⚠️'} \`${m.path}\` (${m.reason})`);
      }
      return lines.join('\n');
    }
    if (action === 'repair') {
      const r = mgr.repairFromSnapshots(snapshotManager);
      const lines = ['🔧 **Manifest Repair**'];
      lines.push(`Restored ${r.repaired.length}/${r.totalMismatches}; Unresolvable ${r.failed.length}`);
      for (const p of r.repaired.slice(0, 10)) lines.push(`- ✅ \`${p}\``);
      for (const f of r.failed.slice(0, 10)) lines.push(`- ❌ \`${f.path}\` (${f.reason_detail})`);
      return lines.join('\n');
    }
    return '⚠️ Usage: `/doctor manifest <seed|verify|repair>`';
  }

  if (subcommand === 'snapshots') {
    const file = args[1];
    if (!file) return '⚠️ Usage: `/doctor snapshots <file_path>`';
    const snaps = snapshotManager.listSnapshots(file);
    if (snaps.length === 0) return `No snapshots found for ${file}`;
    const lines = [`📋 **Snapshots for** \`${file.split('/').pop()}\`\n`];
    for (const s of snaps) {
      lines.push(`#${s.id} | \`${s.hash.slice(0, 8)}\` | ${s.reason || '-'} | ${s.created_at}`);
    }
    return lines.join('\n');
  }

  // Default: run diagnosis
  const results = await diagnose(db, config, snapshotManager, { transcriptIntegrity });
  return formatDiagnoseForTelegram(results);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Check if a TCP port is reachable.
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<boolean>}
 */
function checkPort(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export default { SnapshotManager, RepoManifestManager, diagnose, repair, handleDoctorCommand, createDoctorRoutes, doctorDashboardHTML };
