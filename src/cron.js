// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module cron
 * @description CronScheduler with Croner + SQLite for Constellation Engine.
 *
 * In-process scheduling via Croner (replaced system crontab + node-cron dual-trigger).
 * SQLite DB is the sole source of truth. Config.json is bootstrap-only seed (first boot).
 * - cron_jobs table: task definitions
 * - cron_runs table: execution history with status, timing, token usage
 * - Two execution modes: systemEvent (main session) / agentTurn (isolated temp session)
 * - Dynamic add/remove/update via Dashboard API or conversation
 * - Timezone-aware scheduling (default UTC)
 */

// Croner — in-process cron scheduling (replaced system crontab + node-cron dual-trigger)
// SQLite DB is sole source of truth. Config.json is bootstrap-only seed.
import { Cron } from 'croner';
import { EventEmitter } from 'events';
import http from 'node:http';
import { nowUtcIso } from './time.js';
import { OWNER_USER_ID, OWNER_SPEAKER_ID } from './user-identity.js';
import liveBus from './live-bus.cjs';

// Native http.request POST to the mimir daemon. Replaces `exec('curl ...')`
// which fails on Windows when curl isn't on PATH (frequent OSS bare-install).
function _postMimirJson(path, payload, { mimirUrl, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(path, mimirUrl); } catch { return resolve(false); }
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: timeoutMs,
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); res.on('error', () => resolve(false)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── Role inference for cron_jobs.role backfill ──────────────────────────

/**
 * Map a cron task name to a logical role (provider-agnostic).
 * Role binding to actual models lives in config/llm-roles.json and is owned
 * by the LLM router; cron only decides WHICH role a task should run under,
 * never which model.
 *
 * Priority:
 *   - distill / dream / aca / diary / hygiene / refresh / weekly → consolidation
 *   - explore / curiosity                                        → explore
 *   - everything else                                            → main
 *
 * Used by the one-time backfill in `_initTables`; kept idempotent so a model
 * provider switch (Anthropic → OpenAI → local) does not silently shift
 * a task between roles.
 *
 * @param {string|null|undefined} name
 * @returns {'main'|'consolidation'|'worker'|'explore'}
 */
function inferRoleByName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'main';
  if (/distill|dream|aca|diary|hygiene|refresh|weekly/.test(n)) return 'consolidation';
  if (/explore|curiosity/.test(n)) return 'explore';
  return 'main';
}

// ─── Status Helpers ───────────────────────────────────────────────────────

function classifyCronResult(result) {
  const response = typeof result?.response === 'string' ? result.response : (typeof result === 'string' ? result : '');
  const trimmed = String(response || '').trim();
  const runtimeError = trimmed.startsWith('[Runtime Error]');
  const networkError = /ECONNREFUSED|ECONNRESET|ENOTFOUND|connect.*refused/i.test(trimmed);
  const promptTooLong = /prompt is too long|context window|maximum context|token limit/i.test(trimmed);
  const turnAborted = /\[Turn aborted by caller|turn_aborted|aborted.*timeout/i.test(trimmed);
  const isError = runtimeError || promptTooLong || turnAborted;
  const errorMsg = runtimeError ? trimmed.replace(/^\[Runtime Error\]\s*/, '').slice(0, 1000)
    : (promptTooLong || turnAborted) ? trimmed.slice(0, 1000)
    : null;
  return {
    ok: !isError,
    transient: turnAborted && !networkError,  // network errors are NOT retryable
    response,
    summary: trimmed.slice(0, 1000),
    error: errorMsg,
  };
}

function totalTokens(usage) {
  if (!usage) return 0;
  return Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
}

// Default OSS memory-hygiene cron prompt (04:00 daily, ships default-ON).
// Combines: (1) star-map hygiene — supersedes/dormant/weak-edge/noise/fusion/stale/gardener,
// plus (2) system health check via /api/doctor, (3) event-timeline detection,
// (4) inbox review, (5) brief end-of-run report.
const DEFAULT_MEMORY_HYGIENE_PROMPT = `🧹 Memory Hygiene (daily 04:00)

Goal: keep the star-map clean — supersede stale facts, dormant outdated nodes, merge duplicates, prune weak edges, audit aging content. Anamnesis already handles tasks.json and COGNITIVE_STATE.md edits in real time; this cron is the slower, holistic sweep.

🔴 Hard time budget: 18 minutes total. Run Steps 1→11 in order; if a step finds nothing to do, skip and move on. Don't be greedy — fewer high-quality changes beat many low-confidence ones.

⚠️ Immutable-node protection (applies to every step):
- node_type IN ('identity', 'milestone', 'diary') — NEVER dormant/supersede/merge
- tags containing identity / soul / core-identity / core-memory — skip
- weight > 2.0 — skip
- principle nodes — can be revised but NEVER superseded by newer knowledge

## Step 1: Auto-supersedes detection
List nodes created in the last 30 days (excluding immutable types):
\`\`\`bash
exec sqlite3 constellation.db "SELECT id, l0, l1, node_type, created_at FROM nodes WHERE state='active' AND created_at > datetime('now', '-30 days') AND node_type NOT IN ('identity', 'milestone', 'diary') ORDER BY created_at DESC LIMIT 40;"
\`\`\`
For each new node, use memory_search to find older nodes on the same topic. If the new node corrects/replaces the old fact, create a supersedes edge. Max 30 pairs per run. When unsure, skip — over-marking is worse than missing.

## Step 2: Auto-dormant superseded nodes
Find nodes that are both (a) the target of an active supersedes edge AND (b) not accessed in 30+ days:
\`\`\`bash
exec sqlite3 constellation.db "SELECT n.id, n.l0, n.weight FROM nodes n INNER JOIN edges e ON n.id = e.target AND e.edge_type = 'supersedes' AND e.state = 'active' WHERE n.state = 'active' AND n.node_type NOT IN ('identity', 'milestone', 'diary', 'principle') AND n.accessed_at < datetime('now', '-30 days') AND n.weight < 2.0 LIMIT 25;"
\`\`\`
Set those to dormant. Max 20 per run.

## Step 3: Weak-edge prune
Pure SQL — dormant all active edges with strength < 0.1:
\`\`\`bash
exec sqlite3 constellation.db "UPDATE edges SET state = 'dormant' WHERE strength < 0.1 AND state = 'active';"
\`\`\`
Record the row count.

## Step 4: Noise cleanup
Active nodes with empty or very short L2 content:
\`\`\`bash
exec sqlite3 constellation.db "SELECT id, l0, l1, length(l2) AS l2_len, source, tags, conn_count FROM nodes WHERE state='active' AND (l2 IS NULL OR l2 = '' OR length(l2) < 50) AND node_type NOT IN ('identity', 'milestone', 'diary', 'principle') LIMIT 30;"
\`\`\`
Three-way triage:
- Stub with real value (paper title, named concept) → leave as-is OR back-fill 200–400 chars of L2 (max 8 per run)
- Pure noise (no semantic anchor) → dormant (max 12 per run)
- Unclear → skip

## Step 5: Fusion scan
Sample random active nodes; for each, semantic-search for the closest sibling. Real duplicates (same fact, different wording) → keep the more complete one, supersede the other (build supersedes edge, migrate edges, dormant loser). Max 4 pairs per run. Fusion is irreversible — skip unsure candidates.

## Step 6: Stale-content audit
Nodes not accessed in 60+ days with weight < 1.5:
\`\`\`bash
exec sqlite3 constellation.db "SELECT id, l0, node_type, accessed_at FROM nodes WHERE state='active' AND node_type NOT IN ('identity', 'milestone', 'diary', 'principle') AND accessed_at < datetime('now', '-60 days') AND weight < 1.5 ORDER BY accessed_at ASC LIMIT 15;"
\`\`\`
If outdated, build supersedes or dormant. Max 12 per run.

## Step 7: Edge gardener
Find orphan nodes (conn_count = 0) and weakly-connected nodes (< 3 edges):
\`\`\`bash
exec sqlite3 constellation.db "SELECT id, l0, node_type FROM nodes WHERE state='active' AND conn_count = 0 AND node_type NOT IN ('identity', 'milestone', 'diary') LIMIT 10;"
\`\`\`
For each, memory_search the L0 to find 2–3 best neighbors and link them with associative edges at strength 0.5. Max 8 nodes per run.

## Step 8: System health check
Call the Doctor endpoint via the web_fetch tool to surface any platform-level issues:
\`\`\`
web_fetch { url: "http://127.0.0.1:18800/api/doctor", maxChars: 4000 }
\`\`\`
If the response is unreachable or HTTP non-200, the engine HTTP server is down — log and continue (don't crash the cron). For any check with status='fail' or 'warn', summarize in the final report.

## Step 9: Event-timeline detection
Scan today's conversations.db for state-transition events (architecture change, paradigm shift, milestone, founder strategic decision, knowledge breakthrough). Use constellation_query 'event-timeline' to find existing timeline nodes, then constellation_remember to add the new event with edge_type='temporal' connecting it to the most recent prior event. Max 2 new event-timeline nodes per run.

## Step 10: Inbox review
Check identity/inbox/ for any pending entries (memory_get can read these). If found, promote high-value ones to the star-map via constellation_remember; ignore noise. Max 5 reviewed per run.

## Step 11: Final report
One-line summary written via file_write to logs/memory-hygiene-YYYY-MM-DD.log:
🧹 Hygiene | supersedes:X | dormant(sup):X | weak-edges:X | noise:X | fusion:X | stale:X | gardener:X | doctor:OK/N issues | events:X | inbox:X

## Red lines
- NEVER dormant/supersede/merge identity / milestone / diary / principle nodes
- Per-run cap: total dormant ≤ 30 across all steps
- Skip unsure supersedes/fusion candidates — over-marking is worse than missing
- Don't touch src/ code
- Don't modify tasks.json or COGNITIVE_STATE.md — Anamnesis owns those
`;

/**
 * @typedef {Object} CronTask
 * @property {number} [id] - DB row id
 * @property {string} name - Unique task identifier
 * @property {string} schedule - Cron expression
 * @property {'agentTurn'|'systemEvent'} mode - Execution mode
 * @property {string} prompt - Instruction text
 * @property {boolean} [delivery=true] - Deliver agentTurn results to Telegram
 * @property {boolean} [enabled=true] - Whether task is active
 * @property {number} [timeoutMs=120000] - Max execution time
 */

export class CronScheduler extends EventEmitter {
  /**
   * @param {Object} config - Cron config section (tasks, timezone, etc.)
   * @param {import('./agent-runtime.js').AgentRuntime} runtime
   * @param {import('./telegram.js').TelegramBot|null} bot
   * @param {import('./task-manager.js').TaskManager|null} [taskManager]
   * @param {import('better-sqlite3').Database} [db] - SQLite database handle
   */
  constructor(config, runtime, bot = null, taskManager = null, db = null, convStore = null, dbSnapshots = null) {
    super();
    this.config = config;
    this.runtime = runtime;
    this.bot = bot;
    this.taskManager = taskManager;
    this.db = db;
    this.convStore = convStore;
    this.dbSnapshots = dbSnapshots;
    this.timezone = config.timezone || 'UTC';
    this.mainSessionId = config.mainSessionId || 'main';

    /** @type {Map<string, import('croner').Cron>} */
    this._jobs = new Map();

    /** @type {Map<string, Object>} running task names → { startedAt, abortController } */
    this._running = new Map();

    /** @type {Map<string, number>} task name → consecutive failure count */
    this._consecutiveFailures = new Map();

    /** @type {number} Max consecutive failures before auto-disable */
    this._maxConsecutiveFailures = 5;

    /** @type {number} Max concurrent cron tasks allowed */
    this._maxConcurrent = config.maxConcurrent || 3;

    /** @type {boolean} */
    this._started = false;

    if (this.db) {
      this._initTables();
      this._seedFromConfig();
    }
  }

  // ─── DB Schema ──────────────────────────────────────────────────────────

  /** Create cron_jobs and cron_runs tables if they don't exist. */
  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        schedule TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'agentTurn',
        prompt TEXT NOT NULL,
        delivery INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        timeout_ms INTEGER DEFAULT 5400000,
        model TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Migration: add model column if missing (existing DBs)
      -- SQLite ignores ALTER TABLE if column already exists via IF NOT EXISTS workaround
    `);
    try { this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN model TEXT`); } catch { /* column already exists */ }
    // Phase C: role column for multi-provider role binding (main / consolidation / worker / explore)
    try { this.db.exec(`ALTER TABLE cron_jobs ADD COLUMN role TEXT`); } catch { /* column already exists */ }
    this._backfillRoles();
    this.db.exec(`

      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        result_summary TEXT,
        error TEXT,
        tokens_used INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at);
    `);
  }

  /**
   * One-time backfill of cron_jobs.role from task name patterns.
   * Heals both NULL and empty-string role values — manual UPDATE clears or
   * test fixtures defaulting to '' would otherwise bypass backfill forever
   * and silently route through the chat-facing role.
   * Idempotent: only the first call writes; subsequent calls find no rows.
   * Mapping (name) → role:
   *   distill | dream | aca | diary | hygiene | refresh | weekly → consolidation
   *   explore | curiosity                                        → explore
   *   everything else                                            → main
   */
  _backfillRoles() {
    if (!this.db) return;
    let rows;
    try {
      rows = this.db.prepare("SELECT id, name FROM cron_jobs WHERE role IS NULL OR role = ''").all();
    } catch {
      return; // role column missing — should not happen, but be defensive
    }
    if (rows.length === 0) return;
    const update = this.db.prepare("UPDATE cron_jobs SET role = ? WHERE id = ? AND (role IS NULL OR role = '')");
    let count = 0;
    for (const row of rows) {
      const role = inferRoleByName(row.name);
      const r = update.run(role, row.id);
      if (r.changes > 0) count++;
    }
    if (count > 0) console.log(`[Cron] Backfilled role for ${count} cron jobs`);
  }

  /**
   * W4: Re-classify cron_jobs.role from name patterns. Called by
   * POST /api/llm/roles after the user saves their role choices, so a
   * custom-named cron task that the original heuristic guessed wrong gets
   * resynchronized with the canonical name→role map below.
   *
   * Patterns mirror inferRoleByName() so a provider switch doesn't silently
   * shift a task between roles.
   *
   * @returns {number} count of rows whose role changed
   */
  sweepRolesByName() {
    if (!this.db) return 0;
    const mappings = [
      { pattern: '%diary%',     role: 'consolidation' },
      { pattern: '%hygiene%',   role: 'consolidation' },
      { pattern: '%distill%',   role: 'consolidation' },
      { pattern: '%dream%',     role: 'consolidation' },
      { pattern: '%refresh%',   role: 'consolidation' },
      { pattern: '%weekly%',    role: 'consolidation' },
      { pattern: '%aca%',       role: 'consolidation' },
      { pattern: '%explore%',   role: 'explore' },
      { pattern: '%curiosity%', role: 'explore' },
    ];
    const stmt = this.db.prepare(
      'UPDATE cron_jobs SET role = ? WHERE name LIKE ? AND (role IS NULL OR role != ?)'
    );
    let total = 0;
    for (const m of mappings) {
      try {
        const r = stmt.run(m.role, m.pattern, m.role);
        total += r.changes || 0;
      } catch {
        // ignore — column may be missing in degraded test envs
      }
    }
    if (total > 0) console.log(`[Cron] Role sweep updated ${total} task(s)`);
    return total;
  }

  /**
   * Bootstrap-only seed: populate DB from config.json ONLY when DB is empty.
   * After first boot, DB is the sole source of truth — config.json is never read again.
   */
  _seedFromConfig() {
    const count = this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get().c;
    if (count > 0) {
      console.log(`[Cron] DB has ${count} tasks — skipping config seed`);
      return;
    }
    // First boot: insert all tasks from config.json + built-in defaults
    const insert = this.db.prepare(`
      INSERT INTO cron_jobs (name, schedule, mode, prompt, delivery, enabled, timeout_ms, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const configTasks = this.config.tasks || [];
    // Built-in default: memory-hygiene at 04:00 daily, ships ON.
    // Users disable via Dashboard Cron Editor if they want to skip nightly hygiene.
    const builtinDefaults = [
      {
        name: 'memory-hygiene',
        schedule: '0 4 * * *',
        mode: 'agentTurn',
        prompt: DEFAULT_MEMORY_HYGIENE_PROMPT,
        delivery: false,
        enabled: true,
        timeoutMs: 1800000,  // 30 min hard cap (prompt budgets 18 min)
        model: null,         // router picks consolidation role
      },
    ];
    const seenNames = new Set(configTasks.map(t => t.name));
    for (const d of builtinDefaults) {
      if (!seenNames.has(d.name)) configTasks.push(d);
    }
    for (const t of configTasks) {
      const prompt = t.prompt || t.message || '';
      insert.run(
        t.name, t.schedule, t.mode || 'agentTurn', prompt,
        t.delivery !== false ? 1 : 0, t.enabled !== false ? 1 : 0,
        t.timeoutMs || t.timeout_ms || 5400000, t.model || null,
      );
    }
    console.log(`[Cron] Seeded ${configTasks.length} tasks (${builtinDefaults.length} built-in default + config.json) on first boot`);
  }

  // ─── Croner Scheduling ─────────────────────────────────────────────────

  /** Create a Croner instance for one task. */
  _scheduleCron(task) {
    // Stop existing instance if any
    if (this._jobs.has(task.name)) {
      this._jobs.get(task.name).stop();
      this._jobs.delete(task.name);
    }

    const tz = this.config.timezone || 'UTC';

    const job = new Cron(task.schedule, { timezone: tz, paused: false }, async () => {
      console.log(`[Cron] Trigger: ${task.name}`);
      try {
        // Re-fetch from DB to get latest config (schedule may have been updated)
        const freshTask = this._getTaskFromDB(task.name);
        if (!freshTask || !freshTask.enabled) {
          console.log(`[Cron] ${task.name} disabled or deleted, skipping`);
          return;
        }
        await this._executeTask(freshTask);
      } catch (err) {
        console.error(`[Cron] ${task.name} execution error:`, err.message);
      }
    });

    this._jobs.set(task.name, job);
    const next = job.nextRun();
    console.log(`[Cron] Scheduled ${task.name} [${task.schedule}] next: ${next?.toLocaleString('en-NZ', { timeZone: tz })}`);
  }

  /** Stop a Croner instance by task name. */
  _unscheduleCron(name) {
    const job = this._jobs.get(name);
    if (job) {
      job.stop();
      this._jobs.delete(name);
      console.log(`[Cron] Unscheduled: ${name}`);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Start all enabled tasks from DB. */
  start() {
    if (this._started) return;
    this._started = true;

    // Clean up ALL 'running' records on restart — if the process restarted, no task is actually running
    if (this.db) {
      try {
        const cleaned = this.db.prepare(
          `UPDATE cron_runs SET completed_at = datetime('now'), status = 'timeout', error = 'cleaned up on scheduler restart'
           WHERE status = 'running'`
        ).run();
        if (cleaned.changes > 0) {
          this.emit('warning', { message: `Cleaned ${cleaned.changes} stale cron_runs records from previous run` });
        }
      } catch { /* non-critical */ }
    }

    // Create Croner instances for all enabled tasks
    const tasks = this._getAllTasksFromDB();
    for (const t of tasks) {
      if (t.enabled) {
        this._scheduleCron(t);
      } else {
        console.log(`[Cron] ✗ ${t.name} [${t.schedule}] (disabled)`);
      }
    }

    console.log(`[Cron] Started ${this._jobs.size}/${tasks.length} tasks`);
    this.emit('started', { taskCount: this._jobs.size });

    // Health check meta-task: every 10 minutes, check gateway and auto-recover disabled tasks
    this._healthCheckTimer = setInterval(() => this._healthCheck().catch(() => {}), 10 * 60 * 1000);
    // Run initial health check after 60s (let system stabilize)
    setTimeout(() => this._healthCheck().catch(() => {}), 60_000);

    // Zombie detection: every 2 minutes, check for tasks stuck beyond their timeout
    this._zombieCheckTimer = setInterval(() => this._zombieCheck(), 2 * 60 * 1000);

    // Sleipnir cycle (aggregator → dedup → decay). Each substep gated by its
    // own env var; ENGINE_SLEIPNIR_ENABLED=0 turns off all three.
    const sleipnirCycle = async () => {
      if (process.env.ENGINE_SLEIPNIR_ENABLED === '0') return;
      if (process.env.ENGINE_SLEIPNIR_AGGREGATOR_ENABLED !== '0') {
        try {
          const { sleipnirAggregator } = await import('./sleipnir-aggregator.js');
          const llm = this.runtime?.llm || this.runtime?.llmRouter;
          if (llm) {
            const engine = { db: this.db };
            sleipnirAggregator.init({ engine, llm });
            const cap = parseInt(process.env.ENGINE_SLEIPNIR_MAX_CLUSTERS || '5', 10);
            const sum = await sleipnirAggregator.runOnce({ maxClusters: cap });
            if (sum.clusters > 0) console.log(`[Sleipnir][aggregator] clusters=${sum.clusters} written=${sum.written}`);
          }
        } catch (e) { console.warn(`[Sleipnir][aggregator] cycle failed: ${e.message}`); }
      }
      if (process.env.ENGINE_SLEIPNIR_DEDUP_ENABLED !== '0') {
        try {
          const { sleipnirDedup } = await import('./sleipnir-dedup.js');
          const engine = this._engine || null;
          if (engine && typeof engine._embed === 'function') {
            sleipnirDedup.init({ engine, resolver: this._mimirResolver || null });
            const batch = parseInt(process.env.ENGINE_SLEIPNIR_DEDUP_BATCH || '8', 10);
            const sum = await sleipnirDedup.runOnce({ batchSize: batch });
            if (sum.processed > 0) console.log(`[Sleipnir][dedup] processed=${sum.processed} accepted=${sum.accepted} revised=${sum.revised} rejected=${sum.rejected} errors=${sum.errors}`);
          }
        } catch (e) { console.warn(`[Sleipnir][dedup] cycle failed: ${e.message}`); }
      }
      if (process.env.ENGINE_SLEIPNIR_DECAY_ENABLED !== '0') {
        try {
          const { sleipnirDecay } = await import('./sleipnir-decay.js');
          const engine = this._engine || { db: this.db };
          if (engine?.db) {
            sleipnirDecay.init({ engine });
            const sum = sleipnirDecay.runOnce();
            if (sum.processed > 0) console.log(`[Sleipnir][decay] processed=${sum.processed}/${sum.total} aged_out=${sum.aged_out} time_decayed=${sum.time_decayed} git_decayed=${sum.git_decayed} refreshed=${sum.refresh_boosted}`);
            liveBus.safeEmit('sleipnir.decay', {
              processed: sum.processed,
              total: sum.total,
              aged_out: sum.aged_out,
              time_decayed: sum.time_decayed,
              git_decayed: sum.git_decayed,
              refresh_boosted: sum.refresh_boosted,
            });
          }
        } catch (e) { console.warn(`[Sleipnir][decay] cycle failed: ${e.message}`); }
      }
      // Step 6: hybrid promotion (pending accepted → nodes table). Atomic txn,
      // dormant + 72h quarantine, subtype-aware edges. ENGINE_SLEIPNIR_PROMOTE_ENABLED=0 disables.
      if (process.env.ENGINE_SLEIPNIR_PROMOTE_ENABLED !== '0') {
        try {
          const { sleipnirPromote } = await import('./sleipnir-promote.js');
          const engine = this._engine || null;
          if (engine && typeof engine._embed === 'function') {
            sleipnirPromote.init({ engine });
            const cap = parseInt(process.env.ENGINE_SLEIPNIR_PROMOTE_MAX || '5', 10);
            const sum = await sleipnirPromote.runOnce({ maxPromotes: cap });
            if (sum.scanned > 0 || sum.skipped) {
              console.log(`[Sleipnir][promote] scanned=${sum.scanned||0} promoted=${sum.promoted||0} skipped_dup=${sum.skipped_dup||0} failed_tx=${sum.failed_tx||0}${sum.skipped?` skipped=${sum.skipped}`:''}`);
            }
            liveBus.safeEmit('sleipnir.promote', {
              scanned: sum.scanned,
              promoted: sum.promoted,
              skipped_dup: sum.skipped_dup,
              failed_tx: sum.failed_tx,
              skipped: sum.skipped,
            });
          }
        } catch (e) { console.warn(`[Sleipnir][promote] cycle failed: ${e.message}`); }
      }
      // Step 6: quarantine graduation (≥72h dormant → active). Cheap idempotent
      // sweep; runs every cycle (≈30min). ENGINE_SLEIPNIR_GRADUATE_ENABLED=0 disables.
      if (process.env.ENGINE_SLEIPNIR_GRADUATE_ENABLED !== '0') {
        try {
          const { sleipnirGraduate } = await import('./sleipnir-graduate.js');
          const engine = this._engine || { db: this.db };
          if (engine?.db) {
            sleipnirGraduate.init({ engine });
            const sum = sleipnirGraduate.runOnce();
            if (sum.graduated > 0) console.log(`[Sleipnir][graduate] graduated=${sum.graduated}/${sum.scanned}`);
          }
        } catch (e) { console.warn(`[Sleipnir][graduate] cycle failed: ${e.message}`); }
      }
    };

    if (process.env.ENGINE_SLEIPNIR_ENABLED !== '0' && this.db) {
      const schedule = process.env.ENGINE_SLEIPNIR_SCHEDULE || '*/30 * * * *';
      const tz = this.timezone;
      this._sleipnirJob = new Cron(schedule, { timezone: tz, paused: false }, async () => {
        try { await sleipnirCycle(); } catch (e) { console.warn(`[Sleipnir] cycle failed: ${e.message}`); }
      });
      const next = this._sleipnirJob.nextRun();
      console.log(`[Cron] Scheduled Sleipnir [${schedule}] next: ${next?.toLocaleString('en-NZ', { timeZone: tz })}`);
    }

    // ─── Outreach health: auto-demotion + source-delete sweeps ─────────
    // Hourly cadence by default. Both sweeps are independent — kill switches:
    //   MIMIR_OUTREACH_HEALTH_ENABLED=0  → disable scheduling entirely
    //   MIMIR_DEMOTE_SWEEP_KILL=1        → disable demotion only
    //   MIMIR_SOURCE_DELETE_KILL=1       → disable source-delete only
    if (process.env.MIMIR_OUTREACH_HEALTH_ENABLED !== '0' && this.db) {
      const schedule = process.env.MIMIR_OUTREACH_HEALTH_SCHEDULE || '0 * * * *';
      const tz = this.timezone;
      this._outreachHealthJob = new Cron(schedule, { timezone: tz, paused: false }, async () => {
        try {
          const { runDemotionSweep, runSourceDeleteSweep } = await import('../scripts/mimir-js/outreach-health.js');
          const engine = this._engine || { db: this.db };
          const dem = runDemotionSweep({ engine });
          if (dem?.demoted) console.log(`[OutreachHealth][demote] demoted=${dem.demoted}/${dem.processed}`);
          const src = await runSourceDeleteSweep({ engine });
          if (src?.archived) console.log(`[OutreachHealth][source] archived=${src.archived}/${src.processed}`);
        } catch (e) {
          console.warn(`[OutreachHealth] cycle failed: ${e.message}`);
        }
      });
      const next = this._outreachHealthJob.nextRun();
      console.log(`[Cron] Scheduled OutreachHealth [${schedule}] next: ${next?.toLocaleString('en-NZ', { timeZone: tz })}`);
    }
  }

  /**
   * Periodic health check: probe gateway, auto-recover circuit-broken tasks.
   */
  async _healthCheck() {
    if (!this._started) return;

    // 1. Check gateway health
    let gatewayOk = false;
    try {
      const baseUrl = this.runtime?.llm?.config?.baseUrl || this.config?.gatewayUrl || 'http://127.0.0.1:3456';
      const resp = await fetch(`${baseUrl.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
      gatewayOk = resp.ok;
    } catch {
      gatewayOk = false;
    }

    if (!gatewayOk) {
      this.emit('warning', { message: 'Health check: gateway unhealthy, skipping auto-recovery' });
      return;
    }

    // 2. Find tasks disabled by circuit breaker (have consecutive failure history)
    if (!this.db) return;
    const disabledTasks = this.db.prepare(
      `SELECT name FROM cron_jobs WHERE enabled = 0`
    ).all().map(r => r.name);

    const recovered = [];
    for (const name of disabledTasks) {
      const failCount = this._consecutiveFailures.get(name) || 0;
      if (failCount >= this._maxConsecutiveFailures) {
        // Was disabled by circuit breaker — auto-recover
        this._consecutiveFailures.delete(name);
        try {
          this.updateTask(name, { enabled: true });
          recovered.push(name);
        } catch (e) { console.warn(`[Cron] Auto-recover updateTask failed for ${name}:`, e.message); }
      }
    }

    if (recovered.length > 0) {
      this.emit('warning', { message: `Health check: auto-recovered ${recovered.length} tasks: ${recovered.join(', ')}` });
      if (this.bot) {
        try { await this.bot.sendLong(this.bot.founderId, `✅ Health check: auto-recovered cron tasks: ${recovered.join(', ')}`); } catch (e) { console.warn('[Cron] Health check Telegram notify failed:', e.message); }
      }
    }
  }

  /**
   * Zombie detection: find tasks stuck in _running beyond their timeout + grace period.
   * Force-abort them, clean up DB records, and free the concurrency slot.
   */
  _zombieCheck() {
    if (!this._started || this._running.size === 0) return;
    const now = Date.now();
    const grace = 60_000; // 1 minute grace period beyond timeout

    for (const [name, info] of this._running) {
      const task = this._getTaskFromDB(name);
      if (!task) continue;
      const timeoutMs = task.timeoutMs || 5400000;
      const elapsed = now - new Date(info.startedAt).getTime();

      if (elapsed > timeoutMs + grace) {
        // This task is a zombie — force cleanup
        this.emit('warning', { message: `Zombie detected: ${name} running ${Math.round(elapsed / 60000)}min (timeout ${Math.round(timeoutMs / 60000)}min). Force-killing.` });

        // Abort the underlying task if possible
        if (info.abortController) {
          try { info.abortController.abort(); } catch (e) { console.warn('[Cron] Zombie abort failed:', e.message); }
        }

        // Remove from running map
        this._running.delete(name);

        // Finalize behavior logger session
        try { this._behaviorLogger?.finalizeSession(`cron-${name}`, 'timeout'); } catch {}

        // Mark any DB 'running' records as 'timeout'
        if (this.db) {
          try {
            const jobRow = this.db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);
            if (jobRow) {
              this.db.prepare(
                `UPDATE cron_runs SET completed_at = datetime('now'), status = 'timeout', error = 'zombie killed by watchdog after ${Math.round(elapsed / 60000)}min'
                 WHERE job_id = ? AND status = 'running'`
              ).run(jobRow.id);
            }
          } catch (e) { console.warn('[Cron] Zombie DB cleanup failed:', e.message); }
        }

        // Notify via Telegram
        if (this.bot) {
          try {
            this.bot.sendLong(this.bot.founderId, `🧟 Zombie cron killed: **${name}** was running ${Math.round(elapsed / 60000)}min (limit: ${Math.round(timeoutMs / 60000)}min)`).catch(() => {});
          } catch (e) { console.warn('[Cron] Zombie Telegram notify failed:', e.message); }
        }
      }
    }
  }

  /** Stop all tasks and clear jobs. */
  async stop() {
    this._started = false;
    if (this._healthCheckTimer) { clearInterval(this._healthCheckTimer); this._healthCheckTimer = null; }
    if (this._zombieCheckTimer) { clearInterval(this._zombieCheckTimer); this._zombieCheckTimer = null; }

    // Stop all Croner instances
    for (const [name, job] of this._jobs) {
      job.stop();
    }
    this._jobs.clear();

    // Wait for running tasks (max 10s)
    if (this._running.size > 0) {
      const t0 = Date.now();
      while (this._running.size > 0 && Date.now() - t0 < 10000) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    this.emit('stopped');
  }

  // ─── CRUD ───────────────────────────────────────────────────────────────

  /**
   * Add a task (persists to DB). Replaces existing task with same name.
   * @param {CronTask} task
   */
  addTask(task) {
    let prompt = task.prompt || task.message || '';
    if (Buffer.isBuffer(prompt)) prompt = prompt.toString('utf8');
    else if (typeof prompt !== 'string') prompt = String(prompt ?? '');
    if (!task.name || !task.schedule || !prompt) {
      throw new Error('CronTask requires name, schedule, and prompt');
    }
    if (this.db) {
      this.db.prepare(`
        INSERT INTO cron_jobs (name, schedule, mode, prompt, delivery, enabled, timeout_ms, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          schedule=excluded.schedule, mode=excluded.mode, prompt=excluded.prompt,
          delivery=excluded.delivery, enabled=excluded.enabled, timeout_ms=excluded.timeout_ms,
          model=excluded.model, updated_at=datetime('now')
      `).run(
        task.name,
        task.schedule,
        task.mode || 'agentTurn',
        prompt,
        task.delivery !== false ? 1 : 0,
        task.enabled !== false ? 1 : 0,
        task.timeoutMs || task.timeout_ms || 5400000,
        task.model || null,
      );
    }

    // Schedule if enabled
    if (task.enabled !== false && this._started) {
      const dbTask = this._getTaskFromDB(task.name);
      if (dbTask) this._scheduleCron(dbTask);
    }
  }

  /**
   * Remove a task by name (stops Croner + deletes from DB).
   * @param {string} name
   */
  removeTask(name) {
    this._unscheduleCron(name);
    if (this.db) {
      this.db.prepare('DELETE FROM cron_jobs WHERE name = ?').run(name);
    }
  }

  /**
   * Update a task (partial update, persists to DB). Reschedules Croner if needed.
   * @param {string} name
   * @param {Partial<CronTask>} updates
   */
  updateTask(name, updates) {
    if (!this.db) throw new Error('No DB available');
    const existing = this.db.prepare('SELECT * FROM cron_jobs WHERE name = ?').get(name);
    if (!existing) throw new Error(`Task not found: ${name}`);

    const fields = [];
    const values = [];
    if (updates.schedule !== undefined) { fields.push('schedule=?'); values.push(updates.schedule); }
    if (updates.mode !== undefined) { fields.push('mode=?'); values.push(updates.mode); }
    if (updates.prompt !== undefined) {
      fields.push('prompt=?');
      const p = updates.prompt;
      values.push(Buffer.isBuffer(p) ? p.toString('utf8') : (typeof p === 'string' ? p : String(p ?? '')));
    }
    if (updates.delivery !== undefined) { fields.push('delivery=?'); values.push(updates.delivery ? 1 : 0); }
    if (updates.enabled !== undefined) { fields.push('enabled=?'); values.push(updates.enabled ? 1 : 0); }
    if (updates.timeoutMs !== undefined) { fields.push('timeout_ms=?'); values.push(updates.timeoutMs); }
    if (updates.model !== undefined) { fields.push('model=?'); values.push(updates.model || null); }
    if (fields.length === 0) return;

    fields.push("updated_at=datetime('now')");
    values.push(name);
    this.db.prepare(`UPDATE cron_jobs SET ${fields.join(', ')} WHERE name = ?`).run(...values);

    // Reschedule Croner if schedule or enabled changed
    if (this._started) {
      const dbTask = this._getTaskFromDB(name);
      if (dbTask) {
        if (dbTask.enabled) {
          this._scheduleCron(dbTask);  // reschedule with new params
        } else {
          this._unscheduleCron(name);  // disable = stop
        }
      }
    }
  }

  /**
   * Manually trigger a task.
   * @param {string} name
   * @returns {Promise<string>}
   */
  async runNow(name) {
    const task = this._getTaskFromDB(name);
    if (!task) throw new Error(`Task not found: ${name}`);
    return this._executeTask(task);
  }

  // ─── Queries ────────────────────────────────────────────────────────────

  /** Get status of all tasks. @returns {Object[]} */
  getStatus() {
    const tasks = this._getAllTasksFromDB();
    return tasks.map(t => ({
      name: t.name,
      schedule: t.schedule,
      mode: t.mode,
      enabled: t.enabled,
      timeoutMs: t.timeoutMs,
      delivery: t.delivery,
      model: t.model || null,
      prompt: t.prompt || null,
      running: this._running.has(t.name),
      scheduled: !!this._jobs.get(t.name),
      nextRun: this._jobs.get(t.name)?.nextRun()?.toISOString() || null,
    }));
  }

  /**
   * Get recent run history from DB.
   * @param {number} [limit=50]
   * @returns {Object[]}
   */
  getHistory(limit = 50) {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT r.*, j.name as task_name, j.name as job_name,
             CASE
               WHEN r.status = 'running' THEN
                 CAST((julianday(datetime('now')) - julianday(r.started_at)) * 86400 AS INTEGER)
               ELSE
                 CAST((julianday(COALESCE(r.completed_at, r.started_at)) - julianday(r.started_at)) * 86400 AS INTEGER)
             END as duration_sec
      FROM cron_runs r JOIN cron_jobs j ON r.job_id = j.id
      ORDER BY r.started_at DESC LIMIT ?
    `).all(limit);
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  _getAllTasksFromDB() {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM cron_jobs').all().map(r => this._rowToTask(r));
  }

  _getTaskFromDB(name) {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM cron_jobs WHERE name = ?').get(name);
    return row ? this._rowToTask(row) : null;
  }

  _rowToTask(row) {
    // better-sqlite3 returns BLOB columns as Buffer; coerce to string so
    // downstream `.match()`, `.length`, etc. always work regardless of how
    // the row was written.
    const promptStr = Buffer.isBuffer(row.prompt) ? row.prompt.toString('utf8')
      : (typeof row.prompt === 'string' ? row.prompt : String(row.prompt ?? ''));
    return {
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      mode: row.mode,
      prompt: promptStr,
      delivery: Boolean(row.delivery),
      enabled: Boolean(row.enabled),
      timeoutMs: row.timeout_ms,
      model: row.model || undefined,
      role: row.role || undefined,
    };
  }

  /**
   * Pre-fetch recent conversations from conversations.db for distillation tasks.
   * Returns formatted text block to inject into the prompt.
   * @param {number} hoursBack - How many hours of history to include
   * @param {number} maxMessages - Maximum messages to include
   * @returns {string} Formatted conversation block, or empty string if unavailable
   */
  _fetchRecentConversations(hoursBack = 6, maxMessages = 100) {
    if (!this.convStore) return '';
    try {
      const now = new Date();
      const from = new Date(now.getTime() - hoursBack * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();
      // Scope cron distillation to the declared owner's sessionId; if unset,
      // fall back to all rows (single-user dev mode). This keeps a foreign
      // user's turns out of daily-diary / memory-compiler prompts.
      const opts = OWNER_USER_ID ? { sessionIdLike: `${OWNER_SPEAKER_ID}%` } : {};
      const messages = this.convStore.getByTimeRange(from, to, maxMessages, opts);
      if (!messages || messages.length === 0) return '';

      const identity = (this.runtime && typeof this.runtime.getIdentity === 'function')
        ? this.runtime.getIdentity()
        : { agent_name: 'Agent', owner_name: 'Owner' };
      const lines = messages.map(m => {
        const time = m.timestamp?.slice(11, 19) || '??:??:??';
        const ch = m.channel && m.channel !== 'telegram' ? ` [${m.channel}]` : '';
        const who = m.participant && m.participant !== 'founder'
          ? ` (${m.participant})` : '';
        const role = m.role === 'user' ? `👤 ${identity.owner_name}` : `⚔️ ${identity.agent_name}`;
        return `[${time}]${ch}${who} ${role}: ${m.content}`;
      });

      return `\n## Conversation Buffer Excerpt (conversations.db, last ${hoursBack}h, ${messages.length} messages)\n\n${lines.join('\n\n')}\n`;
    } catch (e) {
      this.emit('warning', { task: 'convStore', message: `Failed to fetch conversations: ${e.message}` });
      return '';
    }
  }

  /**
   * Fetch pending inbox items for the daily memory-hygiene cron to review.
   * Also auto-expires stale items (>72h).
   */
  _fetchInboxPending() {
    if (!this.convStore) return '';
    try {
      // Auto-expire stale items
      const expired = this.convStore.expireStaleInbox();
      if (expired > 0) console.log(`  [Cron] Auto-expired ${expired} stale inbox items`);

      // Scope inbox review to the owner so cron never surfaces a foreign
       // user's captured items into this instance's memory-hygiene prompt.
       const items = this.convStore.getInboxPending(5, OWNER_USER_ID ? { userId: OWNER_SPEAKER_ID } : {});
      if (!items || items.length === 0) return '';

      const stats = this.convStore.getInboxStats();
      const lines = items.map(item => {
        const age = Math.round((Date.now() - new Date(item.captured_at).getTime()) / 3600000);
        return `### Inbox #${item.id} (${age}h ago, source: ${item.source})\n${item.content}`;
      });

      return `\n## Inbox Pending Review (${stats.pending} pending / ${stats.promoted} promoted / ${stats.expired} expired)\n\nThe following are candidates automatically captured from conversations. Review one by one:\n- If it contains **decisions / principles / insights / strategic direction**, use constellation_remember to write to the star map, then run via exec:\n  \`sqlite3 conversations.db "PRAGMA busy_timeout=5000; UPDATE inbox SET status='promoted', promoted_at=datetime('now'), promoted_node_id='NODE_ID', reviewer_notes='brief reason' WHERE id=N;"\`\n- If it is only a routine action / confirmation / Q&A, run via exec:\n  \`sqlite3 conversations.db "PRAGMA busy_timeout=5000; UPDATE inbox SET status='expired', reviewer_notes='reason' WHERE id=N;"\`\n- Process at most 5 per cycle.\n\n${lines.join('\n\n---\n\n')}\n`;
    } catch (e) {
      this.emit('warning', { task: 'inbox', message: `Failed to fetch inbox: ${e.message}` });
      return '';
    }
  }

  // Scheduling handled by Croner in-process instances (see _scheduleCron / _unscheduleCron)

  async _executeTask(task) {
    const startedAt = nowUtcIso();
    this._running.set(task.name, { startedAt, abortController: null });
    this.emit('taskStart', { task: task.name, mode: task.mode });

    // Insert run record
    let runId = null;
    if (this.db) {
      const jobRow = this.db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(task.name);
      if (jobRow) {
        const info = this.db.prepare(
          'INSERT INTO cron_runs (job_id, started_at, status) VALUES (?, ?, ?)'
        ).run(jobRow.id, startedAt, 'running');
        runId = Number(info.lastInsertRowid);
      }
    }

    // TaskManager tracking
    let persistentTaskId = null;
    if (this.taskManager) {
      try {
        persistentTaskId = this.taskManager.createTask({
          title: `cron:${task.name}`,
          context: JSON.stringify({ schedule: task.schedule, mode: task.mode }),
          maxRetries: 1,
        });
        this.taskManager.startTask(persistentTaskId);
      } catch { /* non-critical */ }
    }

    const timeoutMs = task.timeoutMs || 5400000;

    // Create AbortController so timeout can signal the runtime to stop
    const abortController = new AbortController();
    this._running.set(task.name, { startedAt, abortController });

    // Track the underlying task promise so we know when it actually finishes
    let underlyingTaskPromise = null;

    try {
      underlyingTaskPromise = this._runTask(task, { signal: abortController.signal });

      const result = await this._withTimeout(
        underlyingTaskPromise,
        timeoutMs,
        `Task ${task.name} timed out after ${timeoutMs}ms`
      );

      const completedAt = nowUtcIso();
      const durationMs = Date.now() - new Date(startedAt).getTime();

      // result is now a TurnResult object (not just a string)
      const response = typeof result === 'string' ? result : (result?.response || '');
      const verdict = classifyCronResult({ response });
      const tokenCount = totalTokens(result?.usage);

      // Retry once on transient failure (e.g. proxy contention causing turn abort)
      if (verdict.transient && !task._retried) {
        const jitter = 10000 + Math.floor(Math.random() * 5000); // 10-15s with jitter to avoid thundering herd
        this.emit('warning', { task: task.name, message: `Transient abort detected, retrying in ${(jitter/1000).toFixed(1)}s: ${verdict.summary.slice(0, 200)}` });
        if (this.db && runId) {
          this.db.prepare(
            'UPDATE cron_runs SET completed_at=?, status=?, result_summary=?, error=? WHERE id=?'
          ).run(nowUtcIso(), 'retrying', verdict.summary, verdict.error, runId);
        }
        await new Promise(r => setTimeout(r, jitter));
        return this._executeTask({ ...task, _retried: true });
      }

      // Update run record
      if (this.db && runId) {
        this.db.prepare(
          'UPDATE cron_runs SET completed_at=?, status=?, result_summary=?, error=?, tokens_used=? WHERE id=?'
        ).run(completedAt, verdict.ok ? 'success' : 'error', verdict.summary, verdict.error, tokenCount, runId);
      }

      // Delivery
      if (task.mode === 'agentTurn' && task.delivery !== false && verdict.response && this.bot) {
        try {
          await this.bot.sendLong(this.bot.founderId, `🕐 **${task.name}**\n\n${verdict.response}`, { style: 'single' });
        } catch (e) {
          this.emit('warning', { task: task.name, message: `Delivery failed: ${e.message}` });
        }
      }

      if (!verdict.ok) {
        const semanticErr = new Error(verdict.error || 'Cron task produced runtime error response');
        this.emit('taskError', { name: task.name, error: semanticErr });
        if (persistentTaskId && this.taskManager) {
          try { this.taskManager.failTask(persistentTaskId, verdict.error || verdict.summary || 'semantic failure'); } catch (e) { console.warn('[Cron] taskManager.failTask error:', e.message); }
        }
        throw semanticErr;
      }

      this.emit('taskComplete', { name: task.name, durationMs, tokensUsed: tokenCount });
      this._consecutiveFailures.delete(task.name);
      if (persistentTaskId && this.taskManager) {
        try { this.taskManager.completeTask(persistentTaskId, { summary: verdict.summary.slice(0, 500), tokensUsed: tokenCount }); } catch (e) { console.warn('[Cron] taskManager.completeTask error:', e.message); }
      }
      return verdict.response;

    } catch (err) {
      const completedAt = nowUtcIso();
      const isTimeout = err.message.includes('timed out') || err._cronTimeout;
      const status = isTimeout ? 'timeout' : 'error';

      // On timeout, signal abort so runtime can check and stop tool loops
      if (isTimeout) {
        abortController.abort();
        // Wait briefly for the underlying task to notice abort and clean up (max 5s)
        if (underlyingTaskPromise) {
          try { await Promise.race([underlyingTaskPromise.catch(() => {}), new Promise(r => setTimeout(r, 5000))]); } catch (e) { console.warn('[Cron] Timeout cleanup race failed:', e.message); }
        }
      }

      if (this.db && runId) {
        this.db.prepare(
          'UPDATE cron_runs SET completed_at=?, status=?, error=? WHERE id=?'
        ).run(completedAt, status, err.message, runId);
      }

      if (persistentTaskId && this.taskManager) {
        try { this.taskManager.failTask(persistentTaskId, err.message); } catch (e) { console.warn('[Cron] taskManager.failTask (catch) error:', e.message); }
      }

      // Circuit breaker: track consecutive failures, auto-disable after threshold
      const failCount = (this._consecutiveFailures.get(task.name) || 0) + 1;
      this._consecutiveFailures.set(task.name, failCount);
      if (failCount >= this._maxConsecutiveFailures) {
        this.emit('warning', { task: task.name, message: `Auto-disabled after ${failCount} consecutive failures` });
        try { this.updateTask(task.name, { enabled: false }); } catch (e) { console.warn('[Cron] Circuit breaker disable failed:', e.message); }
        if (this.bot) {
          try { this.bot.sendLong(this.bot.founderId, `⚠️ Cron **${task.name}** auto-disabled after ${failCount} consecutive failures.\nLast error: ${err.message?.slice(0, 200)}`).catch(() => {}); } catch (e) { console.warn('[Cron] Circuit breaker Telegram notify failed:', e.message); }
        }
      }

      this.emit('taskError', { name: task.name, error: err });
      throw err;

    } finally {
      // Determine actual session status (catch block sets `status` variable if error occurred)
      const finalStatus = (typeof status !== 'undefined' && status) ? status : 'completed';
      this._running.delete(task.name);
      // Prune stale session tool activations to prevent memory leak
      try { this.runtime?.tools?.pruneStaleSessionTools?.(); } catch (e) { console.warn('[Cron] pruneStaleSessionTools failed:', e.message); }
      // Finalize behavior session (Layer 1 of Session Debrief)
      try { this._behaviorLogger?.finalizeSession(`cron-${task.name}`, finalStatus); } catch {}
      // Notify Mímir of session end for episodic memory segmentation
      try {
        const mimirUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
        _postMimirJson('/session_end', { session_id: `cron-${task.name}`, status: 'completed' }, { mimirUrl });
      } catch { /* non-critical */ }
    }
  }

  async _runTask(task, { signal } = {}) {
    // Cron tasks run in isolated sessions with a tighter token budget (500K vs main session 750K).
    // This is the *primary* soft cap — the 90min timeoutMs is only a hard safety net.
    const CRON_SESSION_TOKEN_BUDGET = 500_000;
    if (task.mode === 'systemEvent') {
      // Multi-user isolation: never fall back to mainSessionId here — if the
      // main session is a human sessionId (e.g. 'tg:<id>') the cron output
      // would be written as that user's turn and leak into their raw-recall
      // window. Require an explicit task.sessionId OR synthesize a cron-owned
      // session id so writes stay in the system partition.
      let sessionId = task.sessionId;
      if (!sessionId) {
        if (this.mainSessionId && this.mainSessionId.startsWith('tg:')) {
          console.warn(`[Cron] systemEvent "${task.name}" without task.sessionId — refusing mainSessionId fallback (${this.mainSessionId}); using cron-owned id instead`);
        }
        sessionId = `cron-${task.name}`;
      }
      const result = await this.runtime.turn(sessionId, `[cron:${task.name}] ${task.prompt}`, {
        model: task.model,
        _role: task.role || undefined,
        trigger: `cron:${task.name}`,
        _trigger: 'cron',
        source: 'cron',
        signal,
        sessionTokenBudget: CRON_SESSION_TOKEN_BUDGET,
      });
      return result;
    } else if (task.mode === 'agentTurn') {
      const tempSessionId = `cron-${task.name}-${Date.now()}`;
      // Pre-create session marked as temporary so cleanup can identify it
      try {
        const db = this.db;
        if (db) {
          // user_id uses the unified 'cron:auto' speakerId so all cron sessions
          // share the same group key (matches deriveCurrentUser output). Task
          // identification stays in the session_id itself (cron-{name}-{ts}).
          db.prepare(
            `INSERT OR IGNORE INTO sessions (id, user_id, is_temp, summary) VALUES (?, ?, 1, '')`
          ).run(tempSessionId, 'cron:auto');
        }
      } catch { /* non-critical, ensureSession in runtime will create it */ }

      // All cron tasks run as isolated sessions with no prompt-side context
      // injection. Tasks fetch what they need via tools (memory_search,
      // cortex_recent_conversations, inbox queries, etc.). Reverted on
      // 2026-04-17 after daily-diary 189KB injection crashed render LIKE.
      try {
        const result = await this.runtime.turn(tempSessionId, task.prompt, {
          model: task.model,
          _role: task.role || undefined,
          trigger: `cron:${task.name}`,
          _trigger: 'cron',
          signal,
          sessionTokenBudget: CRON_SESSION_TOKEN_BUDGET,
        });
        return result;
      } finally {
        // Clean up temporary cron session regardless of success/failure
        try { this.runtime.deleteSession?.(tempSessionId); } catch (e) { console.warn('[Cron] Session cleanup failed:', e.message); }
      }
    }
    throw new Error(`Unknown cron mode: ${task.mode}`);
  }

  _withTimeout(promise, ms, message) {
    let timer;
    let abortController;
    // If the promise-producing function accepts an AbortController, create one
    // However since we receive an already-started promise, we use a race pattern
    // and mark it as timed out so callers can check
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(message);
        err._cronTimeout = true;
        reject(err);
      }, ms);
    });

    return Promise.race([
      promise.then(val => { clearTimeout(timer); return val; }),
      timeoutPromise,
    ]).catch(err => {
      clearTimeout(timer);
      throw err;
    });
  }
}
