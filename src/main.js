#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @module main
 * @description Constellation Engine standalone entry point.
 * 
 * Boot sequence (11 steps):
 *   1. Load config
 *   2. Open/verify constellation.db
 *   3. Initialize ConstellationEngine
 *   4. Initialize FTS5 virtual table + api_calls table
 *   5. Initialize SessionManager
 *   6. Initialize LLMRouter (with DB tracking)
 *   7. Initialize ToolManager
 *   8. Initialize AgentRuntime
 *   9. Initialize TelegramBot
 *  10. Initialize CronScheduler (SQLite-backed) + start all services
 *  11. Start Dashboard (HTTP Web UI)
 * 
 * Graceful shutdown on SIGINT/SIGTERM.
 */

// WSL2 fix: Node's undici fetch hangs on IPv6 routes to Telegram API.
// Force IPv4-first DNS resolution globally before any network calls.
// Timing/debug log toggle — default off, toggle with /timing command
global.TIMING_LOGS = false;

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// WSL2 fix: patch global fetch with undici Agent that forces IPv4 connect.
// Pool/keepalive tuning: 32 connections absorbs burst of 7-8 concurrent Mímir
// fetches at turn start plus proxy traffic without queueing into AbortSignal
// budgets. keepAliveTimeout 30s sits below aiohttp's 75s idle close to avoid
// reuse-race where client sends on a socket the server already half-closed.
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({
  connect: { family: 4 },
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  connections: 32,
}));

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { loadConfig, loadImmutableNodeIds } from './config.js';
import { SessionManager } from './session.js';
import { LLMRouter } from './llm-router.js';
import { ToolManager } from './tool-manager.js';
import { loadSkills } from './skill-loader.js';
import { AgentRuntime } from './agent-runtime.js';
import { TelegramBot } from './telegram.js';
import { CronScheduler } from './cron.js';
import { startDashboard } from './dashboard.js';
import { ProcedureExtractor } from './procedure-extractor.js';
import { DialecticReasoner } from './dialectic-reasoner.js';
import { TaskManager } from './task-manager.js';
import { deriveCurrentUser, OWNER_SPEAKER_ID, getCurrentIdentity, getStarMapOwnerId } from './user-identity.js';
import { SubAgentManager } from './sub-agent.js';
import { hookRuntime as hookConversationLogger, getRecentLog, listLogDates, pruneOldLogs as pruneConversationLogs, pruneObservabilityLogs } from './conversation-logger.js';
import { DbSnapshotManager } from './db-snapshots.js';
import { BehaviorLogger } from './behavior-logger.js';
import { SessionDebrief } from './session-debrief.js';
import { writeTaskTouches, writeCognitiveTouches, writeCompletionCandidates } from './pulse-handlers.js';
import { extractCompletionCandidates } from './task-completion-extractor.js';
import { matchActiveTasks, loadActiveTasks } from './task-completion-matcher.js';
import { sleipnirTrail, deriveCallerKind } from './sleipnir-trail.js';
import { taskTrailCollector, TaskTrailCollector } from './sleipnir-task-trail.js';
import liveBus from './live-bus.cjs';
import { log } from './logger.js';
import { TranscriptIntegrityManager } from './transcript-integrity.js';
import { ensureGatewayReady } from './gateway-manager.js';
import { ConversationStore } from './conversation-store.js';
import { MimirActionWorker } from './mimir-action-worker.js';
import { MimirResolver } from './mimir-resolver.js';
import { MimirReconsolidationQueue } from './mimir-reconsolidation-queue.js';
// State-Core v1 archived to archive/state-core-v1/ — replaced by upcoming alternative

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {{ shutdown: () => Promise<void> } | null} */
let app = null;

/**
 * Ratatoskr L0 dispatcher: extract pulse hints from a turn response and route
 * each kind to its writer. Two kinds are supported:
 *   - TASK_TOUCH      → identity/tasks.json (status flip / note append)
 *   - COGNITIVE_TOUCH → identity/cognitive-buffer.txt (ring buffer append)
 *
 * All writers also append an audit row to pulse_hint_log. Errors are swallowed
 * per-kind so one malformed hint can't stop the others.
 *
 * @param {object} engine - ConstellationEngine
 * @param {string} responseText - assistant turn text (pre-strip)
 */
async function maybeIngestPulseHints(engine, responseText, opts = {}) {
  if (!engine?.db || !responseText) return;
  // Default-on; user can disable via config.ratatoskr.enabled = false.
  if (opts.enabled === false) return;
  const sessionIdForDrain = opts.sessionId || null;
  const callerKind = opts.caller_kind || 'main';
  // Fast-path: if response carries no TOUCH markers AND the L2 extractor is
  // disabled, nothing to do. Keeps the per-turn overhead at ~1µs in the common
  // case (Mímir worker turns, subagent turns, etc.).
  const hasTouch = responseText.includes('TOUCH:');
  const l2Enabled = process.env.ENGINE_L2_TASK_EXTRACT_ENABLED !== '0';
  if (!hasTouch && !l2Enabled) return;

  // ── TASK_TOUCH (atomic tasks.json edit) ──────────────────────────────────
  if (hasTouch && responseText.includes('TASK_TOUCH:')) {
    try {
      const hints = BehaviorLogger.extractTaskTouches(responseText);
      if (hints.length > 0) {
        const r = writeTaskTouches(engine, hints);
        if (r.applied > 0 || r.missing > 0) {
          console.log(`[task-touch] applied ${r.applied}/${hints.length}; ${r.missing} missing task_id`);
        }
        if (r.applied > 0) {
          liveBus.safeEmit?.('ratatoskr.pulse', {
            kind: 'task-touch',
            applied: r.applied,
            missing: r.missing,
            samples: hints.slice(0, 3).map(h => ({ task_id: h.task_id, status: h.status || null, note: h.note ? String(h.note).slice(0, 80) : null })),
          });
        }
        // Sleipnir Step 2.5: on `in_progress → terminal` flip, drain task narrative
        // buffer into task_trail nodes. We only drain when we know the session id
        // (passed via opts.sessionId from the runtime turn listener).
        if (sessionIdForDrain && Array.isArray(r.flips) && r.flips.length > 0) {
          for (const f of r.flips) {
            if (f.from === 'in_progress' && TaskTrailCollector.isTerminalStatus(f.to)) {
              try {
                const milestone = !!(f.note && /\bmilestone(?:=true|:true|!)\b/i.test(f.note));
                const drain = taskTrailCollector.drainForTask({
                  taskId: f.task_id,
                  sessionId: sessionIdForDrain,
                  statusFrom: f.from,
                  statusTo: f.to,
                  extraNote: f.note,
                  milestone,
                });
                if (drain.written > 0) {
                  console.log(`[sleipnir-task-trail] task=${f.task_id} drained ${drain.written}/${drain.chunks} chunks (ttl=${drain.ttl_days}d, redacted=${drain.redaction_hits})`);
                  liveBus.safeEmit?.('ratatoskr.pulse', {
                    kind: 'task-trail-drain',
                    task_id: f.task_id,
                    chunks: drain.chunks,
                    elided_bytes: drain.elided_bytes,
                  });
                }
              } catch (e) {
                console.warn(`[sleipnir-task-trail] drain failed for ${f.task_id}: ${e.message}`);
              }
            }
          }
        }
      }
    } catch (e) { console.warn(`[pulse-hint] task-touch ingest failed: ${e.message}`); }
  }

  // ── COGNITIVE_TOUCH (ring buffer append) ─────────────────────────────────
  if (hasTouch && responseText.includes('COGNITIVE_TOUCH:')) {
    try {
      const hints = BehaviorLogger.extractCognitiveTouches(responseText);
      if (hints.length > 0) {
        const r = writeCognitiveTouches(engine, hints);
        if (r.appended > 0) {
          console.log(`[cognitive-touch] appended ${r.appended} line(s); buffer ${r.linesKept}L/${r.bytes}B`);
          liveBus.safeEmit?.('ratatoskr.pulse', {
            kind: 'cognitive-touch',
            appended: r.appended,
            samples: hints.slice(0, 3).map(h => ({ summary: (h.summary || h.note || '').slice(0, 80) })),
          });
        }
      }
    } catch (e) { console.warn(`[pulse-hint] cognitive-touch ingest failed: ${e.message}`); }
  }

  // ── L2 implicit task-completion candidates (Plan C hybrid, 2026-04-29) ──
  // Pattern-extract natural-language completion phrases ("X is shipped", "shipped Y")
  // and write to pulse_hint_log. The matcher (Phase 3) resolves to a real
  // task_id when possible; unmatched candidates are dropped to avoid noise.
  // Layer 3.5.2c (Phase 4) reads recent rows and surfaces an IR hint so
  // the agent can confirm via TASK_TOUCH next turn.
  // B1 (post-review): deriveCallerKind defaults unknown session ids to 'main',
  // which would let subagent / debug-patrol / bridge sessions feed the
  // extractor — exactly the pollution Planning §3 C2 forbids. Require an
  // explicit recognized prefix instead of trusting the fallthrough.
  const sidStr = String(opts.sessionId || '');
  const isKnownMain = sidStr.startsWith('tg:') || sidStr.startsWith('dashboard');
  const isKnownCron = sidStr.startsWith('cron-') && callerKind === 'cron';
  if (l2Enabled && (isKnownMain || isKnownCron)) {
    try {
      const candidates = extractCompletionCandidates(responseText);
      if (candidates.length > 0) {
        const activeTasks = loadActiveTasks();
        const matchedFn = activeTasks.length > 0
          ? (rawIdHint, phrase) => matchActiveTasks(rawIdHint, phrase, activeTasks)
          : null;
        const r = writeCompletionCandidates(engine, candidates, {
          source_kind: 'pattern',
          sessionId: sessionIdForDrain,
          matchedFn,
        });
        if (r.written > 0 || r.skipped > 0) {
          console.log(`[task-completion-l2] extracted=${candidates.length} written=${r.written} skipped=${r.skipped}`);
          if (r.written > 0) {
            liveBus.safeEmit?.('ratatoskr.pulse', {
              kind: 'task-completion-candidate',
              written: r.written,
              samples: candidates.slice(0, 3).map(c => ({
                phrase: c.phrase.slice(0, 80),
                conf: c.confidence_pre,
              })),
            });
          }
        }
      }
    } catch (e) { console.warn(`[pulse-hint] l2-task-completion failed: ${e.message}`); }
  }
}

/**
 * Main boot sequence.
 * @param {string} [configPath] - Optional path to config.json
 * @returns {Promise<Object>} Application context with shutdown()
 */
// Runtime-only dirs/files the engine reads but the repo doesn't ship: identity/,
// engine-inbox/, library/, plus tasks.json + COGNITIVE_STATE.md placeholders so
// Anamnesis writes never hit ENOENT on a bare standalone boot. Electron's main.js
// has its own copy of this for packaged installs; this covers `node src/main.js`.
// Idempotent — never overwrites, just creates what's missing.
function scaffoldRuntimeDirs(repoRoot) {
  const dirs = [
    'identity',
    'engine-inbox',
    'engine-inbox/uploads',
    'engine-inbox/uploads/images',
    'library',
  ];
  for (const d of dirs) {
    try { mkdirSync(resolve(repoRoot, d), { recursive: true }); } catch {}
  }
  const tasksFile = resolve(repoRoot, 'identity', 'tasks.json');
  if (!existsSync(tasksFile)) {
    try { writeFileSync(tasksFile, '{"tasks":[]}\n', 'utf-8'); } catch {}
  }
  const cogStateFile = resolve(repoRoot, 'identity', 'COGNITIVE_STATE.md');
  if (!existsSync(cogStateFile)) {
    try { writeFileSync(cogStateFile, '', 'utf-8'); } catch {}
  }
}

async function boot(configPath, options = {}) {
  const cliMode = options.cliMode || false;
  const startTime = Date.now();
  console.log('🌌  Constellation Engine — booting...\n');

  // ─── Step 0: Scaffold runtime dirs/files (idempotent) ─────────────────────
  scaffoldRuntimeDirs(resolve(__dirname, '..'));

  // ─── Step 1: Load config ──────────────────────────────────────────────────
  console.log('  [1/10] Loading config...');
  const config = loadConfig(configPath);
  console.log(`         → ${configPath || 'defaults + env'}`);

  if (options.port) {
    config.dashboard = { ...(config.dashboard || {}), port: options.port };
    console.log(`         → CLI --port override: dashboard.port=${options.port}`);
  }

  // ─── Step 1.5: Probe user-managed local gateway if opted in ───────────────────
  // authMode='gateway' (Ollama/LM Studio/Custom) and 'claude-proxy' both point at
  // a user-managed OpenAI-compatible local server. We don't spawn anything — if
  // the user opted into claude-proxy mode by hand-editing config, fail fast at
  // boot rather than on the first LLM call.
  let gatewayResult = null;
  if ((config.llm?.authMode || '') === 'claude-proxy') {
    console.log('  [1.5]  Probing local gateway...');
    gatewayResult = await ensureGatewayReady(config.llm, console);
  }

  // ─── Step 2: Open constellation.db ────────────────────────────────────────
  console.log('  [2/10] Opening constellation.db...');
  const Database = (await import('better-sqlite3')).default;
  const dbPath = config.engine.dbPath;
  const db = new Database(dbPath, {
    verbose: process.env.CONSTELLATION_SQL_DEBUG ? console.log : undefined,
  });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // 5s — matches engine.cjs; Mímir batch writes can hold lock for 1-3s
  db.pragma('synchronous = NORMAL'); // fsync on commit only — balances safety vs I/O performance
  console.log(`         → ${dbPath}`);

  // ─── Step 3: Initialize ConstellationEngine ───────────────────────────────
  console.log('  [3/10] Initializing ConstellationEngine...');
  const enginePath = resolve(__dirname, '../engine.cjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { ConstellationEngine } = require(enginePath);
  const engine = new ConstellationEngine(dbPath);
  // Sleipnir Step 2 (2026-04-29): wire trail telemetry to the engine DB. Trail
  // tables live alongside nodes/edges, not in conversations.db. Init is safe
  // before the resolver bridge — the trail module only reads/writes tables
  // already created by engine.cjs DDL above.
  try { sleipnirTrail.init(engine.db); } catch (e) {
    console.warn(`[Sleipnir] init failed: ${e.message}`);
  }
  // Sleipnir Step 2.5: per-session task narrative collector. Drains on
  // TASK_TOUCH terminal flips inside maybeIngestPulseHints below.
  try { taskTrailCollector.init(engine); } catch (e) {
    console.warn(`[Sleipnir] task-trail collector init failed: ${e.message}`);
  }
  // Plan C2 (2026-04-25): Install ALS-aware identity resolver. engine.cjs is CJS
  // and can't import the ESM user-identity module directly, so main.js bridges
  // the two by handing the engine a closure that reads the per-turn ALS context.
  // Without this, every star-map write would fall back to STAR_MAP_OWNER_ID_DEFAULT
  // even after agent-runtime wraps the turn with runWithIdentity().
  engine._identityResolver = () => getStarMapOwnerId(getCurrentIdentity());
  // Get stats for boot log
  let nodeCount = '?';
  try {
    const stats = engine.stats();
    nodeCount = stats.active ?? '?';
  } catch { /* non-critical */ }
  console.log(`         → Engine ready (${nodeCount} nodes)`);

  // ─── Step 4: Initialize FTS5 ──────────────────────────────────────────────
  console.log('  [4/10] Initializing FTS5 index...');
  try {
    // Drop old schema if exists, recreate with correct columns and tokenizer
    const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'").get();
    if (ftsExists) {
      // Check tokenizer: migrate from unicode61 to trigram for multilingual support
      const ftsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes_fts'").get();
      if (ftsSql && ftsSql.sql && !ftsSql.sql.includes('trigram')) {
        console.log('         → Migrating FTS5 tokenizer: unicode61 → trigram');
        db.exec('DROP TABLE nodes_fts');
      } else {
        // Verify schema columns match
        try {
          db.prepare('SELECT node_id, l2, tags FROM nodes_fts LIMIT 0').run();
        } catch {
          db.exec('DROP TABLE nodes_fts');
        }
      }
    }
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        node_id, l2, tags,
        tokenize='trigram'
      );
    `);
    // Populate FTS from existing nodes if empty
    const ftsCount = db.prepare('SELECT COUNT(*) as c FROM nodes_fts').get().c;
    if (ftsCount === 0) {
      const nodes = db.prepare(`
        SELECT id, l2, tags FROM nodes WHERE state = 'active'
      `).all();
      if (nodes.length > 0) {
        const insert = db.prepare('INSERT OR IGNORE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)');
        const tx = db.transaction((rows) => {
          for (const r of rows) {
            insert.run(r.id, r.l2, r.tags ?? '');
          }
        });
        tx(nodes);
        console.log(`         → FTS5 populated with ${nodes.length} nodes`);
      } else {
        console.log('         → FTS5 ready (empty)');
      }
    } else {
      console.log(`         → FTS5 ready (${ftsCount} entries)`);
    }
    // Backfill FTS5 gaps: nodes that exist but aren't in FTS5
    const ftsGap = db.prepare(`
      SELECT COUNT(*) as c FROM nodes n
      WHERE n.state = 'active' AND n.id NOT IN (SELECT node_id FROM nodes_fts)
    `).get().c;
    if (ftsGap > 0) {
      const missing = db.prepare(`
        SELECT id, l2, tags FROM nodes
        WHERE state = 'active' AND id NOT IN (SELECT node_id FROM nodes_fts)
      `).all();
      const insertFts = db.prepare('INSERT OR IGNORE INTO nodes_fts (node_id, l2, tags) VALUES (?, ?, ?)');
      const txFts = db.transaction((rows) => {
        for (const r of rows) insertFts.run(r.id, r.l2, r.tags ?? '');
      });
      txFts(missing);
      console.log(`         → FTS5 backfilled ${missing.length} missing nodes`);
    }
  } catch (e) {
    console.warn(`         ⚠ FTS5 init failed: ${e.message} (non-critical, continuing)`);
  }

  // ─── Step 4a.5: Auto-fix malformed tags (boot-time safety net) ──────────────
  try {
    const badTags = db.prepare(`
      SELECT id, tags FROM nodes
      WHERE tags IS NOT NULL AND tags <> '' AND json_valid(tags) = 0
    `).all();
    if (badTags.length > 0) {
      const fix = db.prepare('UPDATE nodes SET tags = ? WHERE id = ?');
      const txFix = db.transaction((rows) => {
        for (const r of rows) {
          let s = (r.tags || '').trim();
          if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
          const arr = s.split(',').map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
          fix.run(JSON.stringify(arr), r.id);
        }
      });
      txFix(badTags);
      console.log(`         → Fixed ${badTags.length} nodes with malformed tags`);
    }
  } catch (e) {
    console.warn(`         ⚠ Tags fix failed: ${e.message}`);
  }

  // ─── Step 4b: Create api_calls table ────────────────────────────────────────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read INTEGER DEFAULT 0,
        cache_write INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        trigger TEXT,
        session_id TEXT
      );
    `);
    console.log('         → api_calls table ready');
  } catch (e) {
    console.warn(`         ⚠ api_calls table init failed: ${e.message}`);
  }

  // ─── Step 4d: Initialize DbSnapshotManager ──────────────────────────────
  const convDbPath = resolve(__dirname, '../conversations.db');
  let dbSnapshots = null;
  try {
    dbSnapshots = new DbSnapshotManager(
      resolve(__dirname, '..'),
      { main: db },  // conversations DB not opened yet at this point
      { main: resolve(__dirname, '..', dbPath) }
    );
    const bootSnap = await dbSnapshots.createSnapshot('boot');
    log.info('boot', `DB snapshot on boot: ${bootSnap.id}`, { sizeMB: bootSnap.sizeMB });
  } catch (e) {
    console.warn(`         ⚠ DbSnapshotManager init failed: ${e.message}`);
  }

  // ─── Step 5: Initialize SessionManager ────────────────────────────────────
  console.log('  [5/10] Initializing SessionManager...');
  const sessions = new SessionManager(db, config);
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  console.log('         → Sessions ready + transcript integrity tables');

  // ─── Step 5b: Clean up stale pending_tool_runs from previous crash ───
  // Note: stale turn_journal entries are left for telegram.js to detect and resume.
  // After resumption, telegram.js marks them as failed. Any remaining stale turns
  // are cleaned up after a grace period by the SessionManager.
  try {
    const stalePending = db.prepare(
      `UPDATE pending_tool_runs SET status='failed', error='engine_crash_recovery', finished_at=datetime('now')
       WHERE status = 'pending'`
    ).run();
    if (stalePending.changes > 0) {
      console.log(`         → Recovered ${stalePending.changes} stale pending tool runs`);
    }
  } catch (e) {
    console.warn(`         ⚠ Stale tool run recovery failed: ${e.message}`);
  }

  // ─── Step 6: Initialize LLMRouter ─────────────────────────────────────────
  console.log('  [6/10] Initializing LLMRouter...');
  // Phase C: pass resolved config.json path so the dual-shape migration
  // can write {providers, roles, limits} back on first boot after upgrade.
  const resolvedConfigPath = configPath
    ? resolve(configPath)
    : resolve(__dirname, '../config.json');
  const llm = new LLMRouter(config.llm, db, resolvedConfigPath);
  llm.on('retry', ({ attempt, model, error }) => {
    console.warn(`  ⚠ LLM retry #${attempt} (${model}): ${error}`);
  });
  llm.on('fallback', ({ from, to, error }) => {
    console.warn(`  ⚠ LLM fallback: ${from} → ${to} (${error?.status || error?.code || error?.message?.slice(0, 80) || 'unknown'})`);
  });
  console.log(`         → LLM ready (${config.llm.primaryModel})`);

  // Hand the engine a reference so cold-start LLM calls (seed expansion,
  // bootstrap fetch envelopes, outreach compose) can route through the
  // user's actual provider instead of assuming an in-process proxy.
  if (typeof engine.setLLMRouter === 'function') {
    engine.setLLMRouter(llm);
  }

  // ─── Step 7: Initialize ToolManager ───────────────────────────────────────
  console.log('  [7/10] Initializing ToolManager...');
  const tools = new ToolManager(engine, config.tools);
  const taskManager = new TaskManager(config.engine.dbPath);
  console.log('         → TaskManager ready');

  // ─── Step 7b: Initialize SubAgentManager + register dive tools ─────────
  let bot = null;
  let scheduler = null;
  let dashboard = null;
  const subAgentManager = new SubAgentManager({ engine, llm, db, taskManager, config: config.subAgent || {} });
  subAgentManager.on('dive', ({ nodeId, durationMs, tokens }) => {
    console.log(`  🔍 Sub-agent dive: ${nodeId} (${durationMs}ms, ${tokens} tok)`);
  });
  subAgentManager.on('taskComplete', ({ taskId, durationMs }) => {
    console.log(`  ✅ Sub-agent task ${taskId} done (${durationMs}ms)`);
  });
  subAgentManager.on('technicalTask', ({ task, durationMs, matchedFiles, tokens }) => {
    console.log(`  🧠 Technical sub-agent: ${task} (${durationMs}ms, ${tokens || 0} tok, ${matchedFiles?.length || 0} files)`);
  });
  subAgentManager.on('technicalPatchTask', ({ task, durationMs, matchedFiles, tokens }) => {
    console.log(`  🩹 Patch sub-agent: ${task} (${durationMs}ms, ${tokens || 0} tok, ${matchedFiles?.length || 0} files)`);
  });
  subAgentManager.on('backgroundTaskQueued', ({ taskId, taskType }) => {
    console.log(`  📨 Background task queued: ${taskId} (${taskType})`);
  });
  subAgentManager.on('backgroundTaskComplete', async ({ taskId, taskType, sessionId, result, matchedFiles }) => {
    console.log(`  ✅ Background task ${taskId} done (${taskType})`);
    if (bot && sessionId?.startsWith('tg:')) {
      try {
        const summary = matchedFiles?.length ? `\n\nFiles: ${matchedFiles.join(', ')}` : '';
        await bot.sendLong(bot.founderId, `🧠 Background task complete: ${taskId}\nType: ${taskType}\n\n${String(result || '').slice(0, 3500)}${summary}`);
      } catch (e) {
        console.warn(`  ⚠ Background task delivery failed: ${e.message}`);
      }
    }
  });
  subAgentManager.on('backgroundTaskError', ({ taskId, taskType, error }) => {
    console.warn(`  ⚠ Background task ${taskId || 'unknown'} (${taskType || 'unknown'}) error: ${error}`);
  });

  // Register sub-agent tools
  tools.register({
    name: 'constellation_dive',
    deferLoading: true,
    keywords: ['deep dive node', 'full node analysis', 'read full l2'],
    description: 'Deep-dive into a specific constellation node to get full L2 content and analysis. Use when you see an interesting node in the L0 overview but need complete information.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Target node ID' },
        question: { type: 'string', description: 'Specific question to answer about this node' },
      },
      required: ['nodeId', 'question'],
    },
    parallel: true,
    execute: async (args) => {
      const result = await subAgentManager.dive(args.nodeId, args.question);
      return `## Dive: ${args.nodeId} (${result.connectedNodes} connected nodes)\n\n${result.conclusion}`;
    },
  });

  tools.register({
    name: 'constellation_search_dive',
    deferLoading: true,
    keywords: ['search and dive', 'deep memory research', 'investigate nodes'],
    description: 'Search constellation nodes matching keywords, then deep-dive for full information and analysis.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        question: { type: 'string', description: 'Specific question to answer' },
        maxNodes: { type: 'number', description: 'Max nodes to dive into (default: 3)' },
      },
      required: ['query', 'question'],
    },
    parallel: true,
    execute: async (args) => {
      const result = await subAgentManager.searchDive(args.query, args.question, { maxNodes: args.maxNodes });
      if (result.conclusions.length === 0) {
        return `No nodes found matching "${args.query}".`;
      }
      return result.conclusions
        .map(c => `## ${c.nodeId}\n${c.conclusion}`)
        .join('\n\n---\n\n');
    },
  });


  tools.register({
    name: 'technical_debug_subagent',
    deferLoading: true,
    keywords: ['debug code', 'technical subagent', 'root cause', 'patch plan', 'architecture audit', 'log analysis'],
    description: 'Spawn a pure technical sub-agent for code review, debugging, architecture diagnosis, and patch planning. It uses a clean technical prompt with no persona injection and can inspect selected source files/logs.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Precise technical task, bug, or architecture question to solve' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional preferred files or logs to inspect first' },
        query: { type: 'string', description: 'Optional codebase search hint if exact files are unknown' },
        maxFiles: { type: 'number', description: 'Maximum files/snippets to inspect (default: 6)' },
        includeWorkspace: { type: 'boolean', description: 'Whether to include workspace docs and markdown in retrieval (default: true)' },
        includeLogs: { type: 'boolean', description: 'Whether to include logs and tech-log files in retrieval (default: true)' },
        context: { type: 'string', description: 'Optional extra technical context such as stack traces or hypotheses' },
      },
      required: ['task'],
    },
    execute: async (args) => {
      const result = await subAgentManager.runTechnicalTask(args.task, {
        files: args.files,
        query: args.query,
        maxFiles: args.maxFiles,
        includeWorkspace: args.includeWorkspace,
        includeLogs: args.includeLogs,
        context: args.context,
      });
      const fileList = result.matchedFiles?.length ? `

Files: ${result.matchedFiles.join(', ')}` : '';
      return `${result.result}${fileList}`;
    },
  });


  tools.register({
    name: 'technical_patch_agent',
    deferLoading: true,
    keywords: ['patch agent', 'write patch plan', 'minimal fix', 'unified diff', 'implementation plan'],
    description: 'Spawn a pure technical patch agent for minimal safe code fixes. It focuses on root cause, concrete patch plan, and diff-style implementation guidance without persona injection.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Precise bug or technical change to patch' },
        files: { type: 'array', items: { type: 'string' }, description: 'Preferred files/logs to inspect first' },
        query: { type: 'string', description: 'Optional codebase search hint when exact files are unknown' },
        maxFiles: { type: 'number', description: 'Maximum files/snippets to inspect (default: 6)' },
        includeWorkspace: { type: 'boolean', description: 'Whether to include workspace docs and markdown in retrieval (default: true)' },
        includeLogs: { type: 'boolean', description: 'Whether to include logs and tech-log files in retrieval (default: true)' },
        context: { type: 'string', description: 'Optional extra technical context such as stack traces or constraints' },
      },
      required: ['task'],
    },
    execute: async (args) => {
      const result = await subAgentManager.runTechnicalPatchTask(args.task, {
        files: args.files,
        query: args.query,
        maxFiles: args.maxFiles,
        includeWorkspace: args.includeWorkspace,
        includeLogs: args.includeLogs,
        context: args.context,
      });
      const fileList = result.matchedFiles?.length ? `\n\nFiles: ${result.matchedFiles.join(', ')}` : '';
      return `${result.result}${fileList}`;
    },
  });

  tools.register({
    name: 'background_task_status',
    deferLoading: true,
    keywords: ['task status', 'background status', 'queued task', 'check async task'],
    description: 'Inspect asynchronous background sub-agent tasks by ID or list recent tasks for the current session.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Specific task ID to inspect' },
        limit: { type: 'number', description: 'If taskId omitted, list recent tasks for the current session (default: 5)' },
      },
    },
    parallel: true,
    execute: async (args, meta = {}) => {
      if (args.taskId) {
        const task = subAgentManager.getBackgroundTask(args.taskId);
        if (!task) return `No background task found for ${args.taskId}.`;
        return JSON.stringify(task, null, 2);
      }
      const sessionId = meta.sessionId || null;
      const tasks = subAgentManager.listBackgroundTasks({ sessionId, limit: args.limit || 5 });
      if (tasks.length === 0) return sessionId ? `No background tasks found for ${sessionId}.` : 'No recent background tasks.';
      return tasks.map(t => `${t.id} [${t.status}] ${t.taskType} :: ${t.title}${t.resultPreview ? `\n  preview: ${String(t.resultPreview).slice(0, 160)}` : ''}${t.error ? `\n  error: ${t.error}` : ''}`).join('\n\n');
    },
  });

  tools.register({
    name: 'run_background_task',
    deferLoading: true,
    keywords: ['background task', 'asynchronous task', 'independent task'],
    description: 'Start an independent background task that won\'t block the current conversation. Results are reported on completion.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description' },
        context: { type: 'string', description: 'Additional context (optional)' },
        kind: { type: 'string', description: 'Task kind: generic, technical, or patch (default: generic)' },
        files: { type: 'array', items: { type: 'string' }, description: 'Preferred files/logs for technical or patch background work' },
        query: { type: 'string', description: 'Optional codebase search hint for technical or patch background work' },
      },
      required: ['task'],
    },
    execute: async (args, meta = {}) => {
      const queued = subAgentManager.scheduleBackgroundTask(args.task, args.context || '', {
        kind: args.kind || 'generic',
        files: args.files,
        query: args.query,
        notifySessionId: meta.sessionId || null,
        source: 'tool',
      });
      return `Background task queued: ${queued.taskId} (${args.kind || 'generic'}). Use background_task_status to inspect progress.`;
    },
  });

  // ── graph_lookup: on-demand deep retrieval (LLM-filtered BGE+SA pool) ──
  // Layer B of the dual-layer retrieval design. Layer A (Mímir auto-inject)
  // handles baseline context <1s; Layer B gives the primary LLM a focused deep-dive
  // tool (~19s p50, 47% strong-rel / 21% noise on golden-set A/B).
  const GRAPH_LOOKUP_MIMIR_URL = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
  const GRAPH_LOOKUP_RETRIEVER_SYS = [
    'You are a star-map retriever. Given a query and a batch of candidate nodes, pick **the ones most relevant to the query**, ordered most-relevant first.',
    'Also judge the overall quality of the candidate pool:',
    '- sufficient: the pool contains >=10 clearly relevant nodes',
    '- thin:        only 3-9 relevant nodes',
    '- irrelevant:  <3 relevant nodes (query and candidate pool barely overlap)',
    '',
    'Selection criteria: prefer nodes that directly help answer / respond to the query; same-domain nodes come next; distant associations should be excluded.',
    '',
    'Output exactly one JSON object — no other text, no explanations, no code fences. Format:',
    '{',
    '  "coverage": "sufficient" | "thin" | "irrelevant",',
    '  "ids": ["id-1", "id-2", ...],',
    '  "reasons": ["one-sentence reason 1", ...]',
    '}',
    '',
    'Important: inside the reasons field, if you need to quote a phrase or fragment, use the corner-quote forms 「」 or 『』 — never ASCII double quotes ", which would break the JSON.',
  ].join('\n');

  tools.register({
    name: 'graph_lookup',
    alwaysVisible: true,
    parallel: false,
    cacheSafe: true,
    keywords: ['deep retrieval', 'focused graph search', 'constellation deep lookup', 'on-demand memory'],
    description: 'On-demand deep retrieval from the constellation graph. Use when the auto-injected Mímir pool is missing a concept you need, or when a sub-question deserves focused high-quality nodes. Triggers fresh SA on the query and has the primary LLM filter the BGE+SA pool to the top-K most relevant nodes. Slower than the auto-inject context (~19s p50) — only call when worth the latency.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused retrieval query (a specific concept or sub-question, not a broad topic).' },
        k: { type: 'number', description: 'Max nodes to return (default: 15, max: 25).' },
      },
      required: ['query'],
    },
    execute: async (args) => {
      const query = String(args?.query || '').trim();
      if (!query) return '[graph_lookup] Error: query is required.';
      const k = Math.max(1, Math.min(Number(args?.k) || 15, 25));

      try {
        // 1) Activate SA on the query (mutates Mímir state — intended, since
        //    the sub-topic is conversationally relevant anyway).
        const signalOk = await fetch(`${GRAPH_LOOKUP_MIMIR_URL}/signal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: query.slice(0, 800), source: 'graph_lookup' }),
          signal: AbortSignal.timeout(6000),
        }).then(r => r.ok).catch(() => false);
        if (!signalOk) {
          return '[graph_lookup] Mímir /signal unavailable. Fallback: call memory_search for keyword-based retrieval.';
        }

        // 2) Let SA settle (tick is ~1s; small buffer for safety).
        await new Promise(r => setTimeout(r, 1500));

        // 3) Fetch the activated pool.
        const poolRes = await fetch(`${GRAPH_LOOKUP_MIMIR_URL}/pool`, {
          signal: AbortSignal.timeout(6000),
        }).then(r => r.ok ? r.json() : null).catch(() => null);
        if (!poolRes || !Array.isArray(poolRes.nodes)) {
          return '[graph_lookup] Mímir /pool unavailable. Fallback: call memory_search.';
        }

        // 4) Keep non-permanent candidates sorted by score; cap at 100.
        const candidates = poolRes.nodes
          .filter(n => !n.permanent)
          .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
          .slice(0, 100);
        if (candidates.length === 0) {
          return `[graph_lookup] query="${query}" | coverage=irrelevant | pool was empty after activation. Fallback: memory_search.`;
        }

        // 5) Call premium-tier LLM as retriever.
        const lines = candidates.map(n => `${n.id} | ${String(n.l0 || '').replace(/\s+/g, ' ').slice(0, 140)}`);
        const userPrompt =
          `Query: ${query}\n\n` +
          `Candidate nodes (${lines.length} total):\n${lines.join('\n')}\n\n` +
          `Pick the ${k} most relevant node ids from above and judge the overall coverage of the candidate pool.`;

        let llmResp;
        try {
          llmResp = await llm.chat(
            [
              { role: 'system', content: GRAPH_LOOKUP_RETRIEVER_SYS },
              { role: 'user', content: userPrompt },
            ],
            {
              model: llm?.config?.primaryModel || undefined,
              temperature: 0.0,
              maxTokens: 3000,
              _trigger: 'graph_lookup',
            }
          );
        } catch (err) {
          return `[graph_lookup] LLM call failed: ${err.message}. Fallback: memory_search.`;
        }

        // 6) Parse JSON response.
        const rawContent = String(llmResp?.content || '').trim();
        let parsed = null;
        try {
          const start = rawContent.indexOf('{');
          const end = rawContent.lastIndexOf('}');
          if (start >= 0 && end > start) {
            parsed = JSON.parse(rawContent.slice(start, end + 1));
          }
        } catch {}
        if (!parsed || !Array.isArray(parsed.ids)) {
          return `[graph_lookup] Failed to parse retriever JSON. Candidates were present (${candidates.length}) but selection output was malformed. Try a narrower query or use memory_search.`;
        }

        const coverage = String(parsed.coverage || 'unknown').toLowerCase();
        const reasons = Array.isArray(parsed.reasons) ? parsed.reasons : [];
        const validIds = new Set(candidates.map(n => n.id));
        const seen = new Set();
        const picked = [];
        for (let i = 0; i < parsed.ids.length && picked.length < k; i++) {
          const id = String(parsed.ids[i] || '').trim();
          if (validIds.has(id) && !seen.has(id)) {
            seen.add(id);
            picked.push({ id, reason: String(reasons[i] || '').slice(0, 160) });
          }
        }
        if (picked.length === 0) {
          return `[graph_lookup] query="${query}" | coverage=${coverage} | retriever returned no valid IDs. Try memory_search or a different phrasing.`;
        }

        // 7) Enrich with L0/L1 from DB.
        let rowById = new Map();
        try {
          const placeholders = picked.map(() => '?').join(',');
          const rows = engine?.db?.prepare(
            `SELECT id, l0, l1 FROM nodes WHERE state='active' AND id IN (${placeholders})`
          ).all(...picked.map(p => p.id)) || [];
          rowById = new Map(rows.map(r => [r.id, r]));
        } catch (err) {
          console.warn(`[graph_lookup] DB enrich failed: ${err.message}`);
        }

        const header = `[graph_lookup] query="${query}" | coverage=${coverage} | picked=${picked.length}/${candidates.length}`;
        const body = picked.map((p, i) => {
          const r = rowById.get(p.id);
          const l0 = r?.l0 || '(l0 unavailable)';
          const l1 = r?.l1 && r.l1 !== r.l0 ? `\n    l1: ${String(r.l1).slice(0, 240)}` : '';
          const why = p.reason ? `\n    why: ${p.reason}` : '';
          return `${i + 1}. ${p.id}\n    l0: ${l0}${l1}${why}`;
        }).join('\n');

        return `${header}\n\n${body}`;
      } catch (err) {
        return `[graph_lookup] Exception: ${err.message}. Fallback: memory_search.`;
      }
    },
  });

  // Register model switching tools
  tools.registerModelTools(llm);

  // Load external skills (~/.constellation/skills/ + <engine>/skills/)
  try {
    const projectRoot = resolve(__dirname, '..');
    const skillResult = await loadSkills(tools, { projectRoot });
    if (skillResult.loaded.length > 0) {
      console.log(`         → ${skillResult.loaded.length} skill(s) loaded: ${skillResult.loaded.map(s => s.name).join(', ')}`);
    }
    for (const skip of skillResult.skipped) {
      console.warn(`         ⚠ Skill skipped: ${skip.dir} — ${skip.reason}`);
    }
  } catch (err) {
    console.warn(`         ⚠ Skill loader failed: ${err.message}`);
  }

  const toolDefs = tools.getDefinitions();
  console.log(`         → ${toolDefs.length} tools registered`);

  // ─── Step 8: Initialize AgentRuntime ──────────────────────────────────────
  console.log('  [8/10] Initializing AgentRuntime...');
  const runtime = new AgentRuntime({
    engine,
    sessionManager: sessions,
    llm,
    tools,
    config: config.runtime,
    identity: config.identity,
    irConfig: config.engine?.ir,
    locale: config.locale,
  });
  runtime.on('compaction', ({ sessionId }) => {
    console.log(`  📦 Compaction triggered for session ${sessionId}`);
  });
  runtime.on('warning', (data) => {
    const msg = data.message || data.error || data.type || JSON.stringify(data);
    console.warn(`  ⚠️ Runtime: ${msg}`);
  });
  console.log(`         → Runtime ready`);

  // ─── Step 8a.5: ConversationLogger (DEMOTED — md logs are now fallback only) ─
  // conversations.db is the primary store (Step 8a.6). md logs kept for legacy dashboard reads.
  // hookConversationLogger(runtime); // Disabled: convStore handles all new writes
  // Even with the logger demoted, we still need its prune helpers to keep
  // legacy md logs and per-day observability JSONL bounded on Win/Mac (no
  // bash/cron available there). Both run once at boot, fast, fail-silent.
  try { pruneConversationLogs(30); } catch {}
  try { pruneObservabilityLogs(60); } catch {}

  // ─── Step 8a.6: Initialize ConversationStore (ring buffer) ─────────────
  const convStore = new ConversationStore(resolve(__dirname, '../conversations.db'));
  try {
    await convStore.init(engine._embed.bind(engine));
    // Register conversations DB path in snapshot manager (uses file copy since DB handle is private)
    if (dbSnapshots) {
      try {
        dbSnapshots._registerDb('conversations', null, convDbPath);
      } catch {}
    }
    // Phase 9.5 (Architecture A): bridge the cross-DB resolvers the cold-start
    // dispatcher needs but cannot open itself. messages_count drives the
    // bootstrap-exit gate; mimir_actions ledger feeds Phase 9.7 outreach
    // rate-limiting (B4 — read-direct, no HTTP roundtrip to the daemon).
    if (engine._coldStart) {
      engine._coldStart.messagesCountResolver = () => {
        try {
          return convStore.db.prepare('SELECT COUNT(*) AS c FROM messages').get().c | 0;
        } catch { return 0; }
      };
      engine._coldStart.mimirActionsResolver = ({ sinceMs = 0, limit = 100 } = {}) => {
        try {
          const cutoff = sinceMs ? new Date(sinceMs).toISOString() : '1970-01-01T00:00:00';
          const tableExists = convStore.db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mimir_actions'"
          ).get();
          if (!tableExists) return [];
          return convStore.db.prepare(
            "SELECT id, action, status, ts, write_node_id FROM mimir_actions " +
            "WHERE ts >= ? ORDER BY ts DESC LIMIT ?"
          ).all(cutoff, limit | 0);
        } catch { return []; }
      };
      // Phase 9.7 outreach surfaces. Each is best-effort — engine.cjs treats
      // missing/throwing resolvers as that surface being unavailable.
      engine._coldStart.liveBusEmit = (event, payload) => {
        try { liveBus?.safeEmit?.(event, payload); } catch {}
      };
      engine._coldStart.chatFeedEnqueue = async ({ text, anchorNodeId }) => {
        // Write outreach as an assistant turn in conversations.db so the chat
        // tab renders it inline with the rest of the conversation. channel
        // 'cold_start' lets future filters distinguish autonomous outreach
        // from real assistant replies.
        try {
          await convStore.insert('assistant', text, {
            sessionId: `cold-start:${anchorNodeId}`,
            channel: 'cold_start',
            participant: 'self',
          });
          return true;
        } catch { return false; }
      };
    }
    // Hook: log every turn into conversations.db with embeddings + Mímir snapshot
    // Derive channel/participant from sessionId prefix
    runtime.on('turn', async ({ sessionId, userMessage, response, model, tokensUsed }) => {
      const sid = sessionId || '';
      let channel = 'unknown', participant = 'unknown';
      if (sid.startsWith('tg:')) {
        channel = 'telegram'; participant = 'founder';
      } else if (sid.startsWith('cron-')) {
        channel = 'cron'; participant = 'self';
      } else if (sid.startsWith('curiosity') || sid.startsWith('wakeup') || sid.startsWith('mimir')) {
        channel = 'autonomous'; participant = 'self';
      } else if (sid.startsWith('dashboard')) {
        channel = 'dashboard'; participant = 'founder';
      } else if (sid.startsWith('pk-') || sid.startsWith('socratic')) {
        channel = 'socratic_pk'; participant = sid.split(':')[1] || 'unknown_ai';
      }

      // Capture Mímir activation snapshot for Decoder training data
      let mimirSnapshot = null;
      try {
        const res = await fetch(`${process.env.MIMIR_URL || 'http://127.0.0.1:18810'}/status`);
        if (res.ok) {
          const status = await res.json();
          // Extract top-K active nodes with their activation levels
          const topNodes = (status.top_activations || []).slice(0, 20).map(n => ({
            id: n.node_id || n.id,
            activation: n.activation,
            l0: n.l0 || n.label,
          }));
          if (topNodes.length > 0) {
            mimirSnapshot = {
              tick: status.tick,
              active_count: status.active_count,
              top_k: topNodes,
              zones: (status.zones || []).slice(0, 5),
            };
          }
        }
      } catch { /* Mímir not running — skip snapshot */ }

      const mimirUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
      const ingestEpisodic = async (msgId, role, content, timestamp) => {
        if (!msgId || !content) return;
        try {
          await fetch(`${mimirUrl}/episodic_ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              msg_id: msgId,
              role,
              content: content.slice(0, 4000),
              session_id: sessionId || 'unknown',
              channel,
              participant,
              timestamp,
            }),
            signal: AbortSignal.timeout(5000),
          });
        } catch { /* Mímir down — skip episodic ingest */ }
      };

      if (userMessage) {
        const userRole = participant === 'self' ? 'cortana_internal' : 'user';
        const row = await convStore.insert(userRole, userMessage, { sessionId, channel, participant, mimirSnapshot });
        if (row) await ingestEpisodic(row.id, userRole, userMessage, row.timestamp);
      }
      if (response) {
        const row = await convStore.insert('assistant', response, { sessionId, channel, participant, model, tokensUsed, mimirSnapshot });
        if (row) await ingestEpisodic(row.id, 'assistant', response, row.timestamp);
      }
      // Phase 9.5 H4: invalidate cold-start messages_count cache on every turn
      // so the bootstrap-exit gate sees fresh counts within one tick of first
      // real activity (TTL would otherwise let it lag up to 60s).
      try { engine._invalidateMessagesCount?.(); } catch {}

      // ─── Inbox Capture: wide net for founder messages ─────────────────
      // All founder messages >= 30 chars go to inbox for later LLM review.
      // Short operational msgs ("ok" / "continue") are filtered out.
      // Daily memory-hygiene cron (04:00 NZ) reviews pending inbox items.
      if (channel === 'telegram' && participant === 'founder' && userMessage) {
        const trimmed = userMessage.trim();
        if (trimmed.length >= 30) {
          // Format with speaker attribution and timestamp for memory clarity
          const ts = new Date().toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
          const ownerLabel = config.identity?.owner_name || 'Owner';
          const agentLabel = config.identity?.agent_name || 'Agent';
          const contextSnippet = response
            ? `[${ownerLabel} ${ts}]: ${trimmed}\n[${agentLabel} ${ts}]: ${response.slice(0, 500)}`
            : `[${ownerLabel} ${ts}]: ${trimmed}`;
          // user_id pins the inbox item to a speaker so the Anamnesis reviewer
          // only sees this user's queue. Shared derivation keeps the tg:<id>
          // format aligned with topic_segmenter's extract_speaker.
          const userId = deriveCurrentUser(sid).isHuman ? deriveCurrentUser(sid).speakerId : null;
          convStore.insertInbox(contextSnippet, {
            source: 'founder_chat',
            sessionId,
            userId,
            reason: 'auto_capture_founder_msg',
          });
        }
      }
    });
    // Inject convStore into AgentRuntime for Layer 3.5.5 task context
    runtime.setConvStore(convStore);
    // Also wire to ToolManager so conversation_fetch_raw can query verbatim
    tools.setConvStore(convStore);
    console.log('         → ConversationStore hooked');
  } catch (e) {
    console.warn(`  ⚠ ConversationStore init failed: ${e.message} (non-critical)`);
  }

  // ─── Step 8a.7: Initialize BehaviorLogger (Session Debrief Layer 1) ─────
  const behaviorLogger = new BehaviorLogger();
  try {
    // Reuse ConversationStore's DB handle — avoids two independent writers on same WAL file
    const sharedDb = convStore.db;
    if (!sharedDb) throw new Error('ConversationStore DB not available');
    behaviorLogger.init(sharedDb);

    // Hook: record every turn's behavioral signals + L3 post-turn audit
    runtime.on('turn', (turnData) => {
      try {
        // Sleipnir Step 2.5: append turn response to per-session narrative
        // ring buffer. Drained on TASK_TOUCH terminal flip (see dispatcher).
        // Only main-session callers contribute task narratives.
        try {
          const sid = turnData.sessionId || '';
          const isMain = sid.startsWith('tg:') || sid.startsWith('dashboard');
          if (isMain && turnData.response) {
            taskTrailCollector.appendTurn({
              sessionId: turnData.sessionId,
              responseText: turnData.response,
              toolsUsed: Array.isArray(turnData.toolsUsed) ? turnData.toolsUsed.length : (turnData.toolRounds || 0),
            });
          }
        } catch (e) {
          console.warn(`[sleipnir-task-trail] append error: ${e.message}`);
        }
        const hintsBefore = behaviorLogger.getSessionHintCount(turnData.sessionId);
        behaviorLogger.recordTurn(turnData);
        const hintsAfter = behaviorLogger.getSessionHintCount(turnData.sessionId);

        // L3: If this turn produced no DEBRIEF_HINT but had significant signals,
        // synthesize a minimal hint from behavioral signals (zero LLM cost)
        if (hintsAfter === hintsBefore) {
          behaviorLogger.maybeSynthesizeHint(turnData.sessionId, turnData);
        }

        // Ratatoskr L0: parse TASK/COGNITIVE_TOUCH hints, route each kind to
        // its writer. Best-effort; L2 (cron) catches misses. Dispatcher also
        // runs L2 implicit task-completion extraction on every turn when
        // ENGINE_L2_TASK_EXTRACT_ENABLED=1 — call site no longer pre-filters
        // on `TOUCH:` because L2 runs on TOUCH-free turns. caller_kind passed
        // through so L2 can skip Mímir/subagent/cron-mimir
        // turns whose language doesn't represent user-visible task progress.
        const ratatoskrOn = config?.ratatoskr?.enabled !== false;
        if (ratatoskrOn && turnData.response) {
          const callerKind = deriveCallerKind(turnData.sessionId);
          maybeIngestPulseHints(engine, turnData.response, {
            sessionId: turnData.sessionId,
            caller_kind: callerKind,
          }).catch(e =>
            console.warn(`[pulse-hint] dispatcher failed: ${e.message}`));
        }
      } catch (e) {
        console.warn(`[BehaviorLogger] recordTurn error: ${e.message}`);
      }
    });

    // Hook: record tool call details (file paths, star map writes)
    // Plan A (2026-04-29) — Sleipnir trail capture moved from toolCall to
    // toolResult so raw text is available at insert time (hybrid storage).
    // Buffer inputs by tool-call id; toolResult listener pairs them.
    const sleipnirCallBuffer = new Map(); // toolCallId → { sessionId, name, input, ts }
    const SLEIPNIR_BUFFER_TTL_MS = 60_000;
    const SLEIPNIR_BUFFER_MAX = 200;
    // Periodic sweep: covers crash/abort paths where toolResult never fires
    // for a buffered toolCall (overflow-only GC would leak indefinitely if
    // traffic stays under the cap).
    setInterval(() => {
      const cutoff = Date.now() - SLEIPNIR_BUFFER_TTL_MS;
      for (const [k, v] of sleipnirCallBuffer) {
        if (v.ts < cutoff) sleipnirCallBuffer.delete(k);
      }
    }, SLEIPNIR_BUFFER_TTL_MS).unref();

    runtime.on('toolCall', (toolData) => {
      try { behaviorLogger.recordToolCall(toolData); } catch (e) {
        console.warn(`[BehaviorLogger] recordToolCall error: ${e.message}`);
      }
      if (toolData?.id) {
        sleipnirCallBuffer.set(toolData.id, {
          sessionId: toolData.sessionId,
          name: toolData.name,
          input: toolData.input,
          ts: Date.now(),
        });
        if (sleipnirCallBuffer.size > SLEIPNIR_BUFFER_MAX) {
          const cutoff = Date.now() - SLEIPNIR_BUFFER_TTL_MS;
          for (const [k, v] of sleipnirCallBuffer) {
            if (v.ts < cutoff) sleipnirCallBuffer.delete(k);
          }
        }
      }
    });

    runtime.on('toolResult', (resultData) => {
      // Sleipnir hybrid storage: pair toolCall input with toolResult raw text.
      // Cron sessions go through recordBookCoverage explicitly; ambient cron
      // toolCalls are bulk/sweep noise (gate redesign 2026-04-29 §4.1).
      const buffered = resultData?.id ? sleipnirCallBuffer.get(resultData.id) : null;
      if (!buffered) return;
      sleipnirCallBuffer.delete(resultData.id);
      // Skip failed tool runs — error text is noise for trail/raw storage.
      if (resultData.ok === false) return;

      try {
        const ck = deriveCallerKind(buffered.sessionId);
        if (ck !== 'cron') {
          const raw = typeof resultData.rawContent === 'string' ? resultData.rawContent : null;
          // Extract filePath/lineRange from input (tool-shape specific)
          const inp = buffered.input || {};
          let filePath = null, lineRange = null;
          if (buffered.name === 'Read' || buffered.name === 'file_read') {
            filePath = inp.file_path || inp.path || null;
            if (inp.offset || inp.limit) {
              const start = Number(inp.offset || 0) || 0;
              const lim = Number(inp.limit || 0) || 0;
              lineRange = lim > 0 ? `${start}-${start + lim}` : `${start}+`;
            }
          } else if (buffered.name === 'Grep' || buffered.name === 'grep_search') {
            filePath = inp.path || inp.glob || null;
          } else if (buffered.name === 'WebFetch' || buffered.name === 'web_fetch') {
            filePath = inp.url || inp.endpoint || null;
          }
          sleipnirTrail.recordToolEvent({
            sessionId: buffered.sessionId,
            toolName: buffered.name,
            input: buffered.input,
            finding: typeof resultData.result === 'string' ? resultData.result : null,
            rawText: raw,
            lineRange,
            filePath,
          });
        }
      } catch (e) {
        console.warn(`[Sleipnir] trail capture error: ${e.message}`);
      }
    });

    // ─── Layer 3: Session Debrief executor (compact-tier LLM) ──────────────────────
    const sessionDebrief = new SessionDebrief({
      llm,
      db: sharedDb,
      behaviorLogger,
      engine,
      identity: config.identity,
    });

    behaviorLogger.onDebriefTrigger = async (pendingSessions) => {
      try {
        await sessionDebrief.run(pendingSessions);
      } catch (err) {
        console.error(`[Anamnesis] Trigger error: ${err.message}`);
      }
    };

    console.log('         → Anamnesis hooked (BehaviorLogger L1 + SessionDebrief L3)');
  } catch (e) {
    console.warn(`  ⚠ BehaviorLogger init failed: ${e.message} (non-critical)`);
  }

  // ─── Step 8b: Initialize ProcedureExtractor ─────────────────────────────
  const procedureExtractor = new ProcedureExtractor(engine);
  // Hook: after each turn with enough tool calls, extract procedures
  runtime.on('turn', async ({ sessionId, toolsUsed }) => {
    if (toolsUsed && toolsUsed.length >= 3) {
      try {
        const msgs = sessions.getActiveMessages(sessionId);
        await procedureExtractor.extract(msgs, { source: sessionId });
      } catch (e) {
        console.warn(`  ⚠ Procedure extraction failed: ${e.message}`);
      }
    }
  });
  console.log('         → ProcedureExtractor hooked');

  // ─── Step 8c: Initialize DialecticReasoner ──────────────────────────────
  const dialecticReasoner = new DialecticReasoner(engine, {
    llmCall: async (userPrompt, systemPrompt) => {
      const response = await llm.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        model: config.llm.compactModel,
        temperature: 0.3,
        maxTokens: 2048,
        _trigger: 'dialectic-reasoner',
        _sessionId: 'dialectic-reasoner',
      });
      return response.content || '';
    },
  });

  // ─── Step 8d-pre: Initialize MimirResolver (Wave 2 SHADOW writer) ──────
  // Default mode is 'shadow' (audit-only) — flip to 'enforce' after 48h gate
  // or 'off' to fully disable. Audit table resolver_decisions is provisioned
  // by Phase 1a migration.
  let mimirResolver = null;
  try {
    if (convStore?.db) {
      const immutableNodeIds = loadImmutableNodeIds(config);
      // Wave 3 Phase 8: Reconsolidation queue. Default OFF (env-gated inside
      // module). engine.cjs:826 hook reads engine._reconsolidationQueue and
      // enqueues self_act node ids — when env is off, enqueue() is a no-op.
      try {
        const reconQueue = new MimirReconsolidationQueue({ engine });
        engine._reconsolidationQueue = reconQueue;
        if (reconQueue.isEnabled()) {
          reconQueue.start();
          console.log(`  → MimirReconsolidationQueue started (drain every 5min)`);
        }
      } catch (e) {
        console.warn(`  ⚠ MimirReconsolidationQueue init failed: ${e.message} (non-critical)`);
      }
      mimirResolver = new MimirResolver({
        engine,
        llm,
        conversationsDb: convStore.db,
        immutableNodeIds,
      });
      const _mode = mimirResolver.getMode();
      // S3a: warn if resolver is on but Phase 1a audit table is missing.
      // Non-fatal — resolver still answers verdicts in-memory (caller honors
      // them), but audit rows are silently lost.
      if (_mode !== 'off') {
        try {
          const _exists = convStore.db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='resolver_decisions'"
          ).get();
          if (!_exists) {
            console.warn(`  ⚠ MimirResolver mode=${_mode} but resolver_decisions table is missing — run schema migrations (scripts/migrate.js); audit rows will be skipped until then`);
          }
        } catch {}
      }
      console.log(`  → MimirResolver ready (mode=${_mode}, immutable_slots=${immutableNodeIds.size})`);
      // Pass resolver into ToolManager so constellation_remember (diary path)
      // gets shadow audit too.
      try { tools.setResolver(mimirResolver); } catch {}
      // Start canary if not off-mode
      if (_mode !== 'off') {
        try { mimirResolver.startCanary({ ownerId: 'self' }); } catch {}
      }
    }
  } catch (e) {
    console.warn(`  ⚠ MimirResolver init failed: ${e.message} (non-critical)`);
  }

  // ─── Step 8d: Initialize MimirActionWorker (Reflection + Curation) ─────
  // Drains pending mimir_actions rows written by the Mímir daemon's discharge
  // loop. Disabled-by-default at the daemon layer too (MIMIR_AUTONOMY_ENABLED_MODES
  // empty → no rows ever written). Worker just runs idle in that case.
  let mimirActionWorker = null;
  try {
    if (convStore?.db) {
      mimirActionWorker = new MimirActionWorker({
        engine,
        conversationsDb: convStore.db,
        convStore,
        llm,
        runtime,
        resolver: mimirResolver,
      });
      mimirActionWorker.start();
    } else {
      console.warn('  ⚠ MimirActionWorker skipped: convStore.db unavailable');
    }
  } catch (e) {
    console.warn(`  ⚠ MimirActionWorker init failed: ${e.message} (non-critical)`);
  }

  // ─── Step 9: Initialize TelegramBot ───────────────────────────────────────

  if (!cliMode) {
    console.log('  [9/10] Initializing TelegramBot...');
    const telegramTokenResolved = config.telegram.token && !config.telegram.token.startsWith('$');
    const telegramUserResolved = config.telegram.allowedUserId && !String(config.telegram.allowedUserId).startsWith('$');
    if (telegramTokenResolved && telegramUserResolved) {
      bot = new TelegramBot(config.telegram, runtime, sessions);
      bot.on('error', ({ error }) => {
        console.error(`  ❌ Telegram: ${error.message}`);
      });
      bot.setDbSnapshots(dbSnapshots);
      bot.setBehaviorLogger(behaviorLogger);

      // Phase 9.7: hand cold-start outreach a Telegram delivery hook. Bot may
      // be torn down later (network failure → bot=null) so we resolve the
      // current binding inside the closure rather than capturing it.
      if (engine._coldStart) {
        engine._coldStart.telegramSend = async ({ text }) => {
          try {
            if (!bot || typeof bot.send !== 'function') return false;
            await bot.send(text);
            return true;
          } catch { return false; }
        };
      }

      console.log('         → Telegram bot ready');
    } else {
      console.log('         → Telegram skipped (no token)');
    }

    // ─── Step 10: Initialize CronScheduler + Start services ──────────────────
    console.log(' [10/10] Starting services...');
    scheduler = new CronScheduler(config.cron, runtime, bot, taskManager, db, convStore, dbSnapshots);
    scheduler._behaviorLogger = behaviorLogger;
    scheduler._mimirResolver = mimirResolver;
    scheduler._engine = engine;
    scheduler.on('taskStart', ({ task: name, mode }) => {
      // Notify Founder when cron tasks begin
      if (bot && mode === 'agentTurn') {
        const cronLabels = {
          'daily-diary': '📝 Starting daily diary',
          'dream': '💭 Starting dreaming',
          'explore': '🌌 Starting free exploration',
          'memory-hygiene': '🧹 Starting memory hygiene',
          'weekly-review': '📝 Starting weekly review',
        };
        const label = cronLabels[name] || `⏰ Cron: ${name}`;
        try { bot.send(label); } catch {}
      }
    });
    scheduler.on('taskError', ({ name, error }) => {
      console.error(`  ❌ Cron [${name}]: ${error.message}`);
    });
    scheduler.on('taskComplete', ({ name, durationMs }) => {
      console.log(`  ✅ Cron [${name}] done (${durationMs}ms)`);
    });

    // Mímir warmup: pre-establish undici connection pool + JIT-compile fetch path
    // BEFORE bot starts accepting messages. Eliminates startup-burst timeouts where
    // the first user message raced against cold undici sockets / cold V8 paths.
    // Serialized: 5 parallel calls saturated the 6-worker executor, especially when
    // reranker preheat was still holding a slot.
    try {
      const warmUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
      const warmStart = Date.now();
      const warmCalls = [
        ['status', () => fetch(`${warmUrl}/status`, { signal: AbortSignal.timeout(5000) })],
        ['pool', () => fetch(`${warmUrl}/pool`, { signal: AbortSignal.timeout(10000) })],
        ['digest', () => fetch(`${warmUrl}/digest?limit=1`, { signal: AbortSignal.timeout(5000) })],
        ['reason/paths', () => fetch(`${warmUrl}/reason/paths`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'warmup', max_hops: 2, max_paths: 1 }),
          signal: AbortSignal.timeout(10000),
        })],
        ['retrieve_conversations', () => fetch(`${warmUrl}/retrieve_conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'warmup', limit: 1, use_activation: false, time_decay_days: 60 }),
          signal: AbortSignal.timeout(10000),
        })],
        // BGE-M3 is lazy-loaded on first call (~30s cold). Force-warm here so the
        // wizard's profile-seed POST doesn't race against a cold embedder model.
        ['embed', () => fetch(`${warmUrl}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'warmup' }),
          signal: AbortSignal.timeout(60000),
        })],
      ];
      let warmOk = 0;
      for (const [_name, call] of warmCalls) {
        try {
          const r = await call();
          if (r.ok) warmOk++;
        } catch { /* tolerated — warmup is best-effort */ }
      }
      console.log(`         → Mímir warmup: ${warmOk}/${warmCalls.length} endpoints ready (${Date.now() - warmStart}ms)`);
    } catch (e) {
      console.warn(`         ⚠ Mímir warmup error: ${e.message}`);
    }

    // Cross-process env sync: mirror MIMIR_FREE_EXPLORATION /
    // MIMIR_ACTIVE_OUTREACH from the daemon's persisted state into this
    // engine process's env so mimir-action-worker.js's gates match the
    // user's saved opt-ins on first dispatch (otherwise a fresh boot
    // rejects fetch/outreach as off until the user re-toggles).
    try {
      const cfgUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
      const r = await fetch(`${cfgUrl}/config`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const state = await r.json();
        const acts = Array.isArray(state?.v3_enabled_actions) ? state.v3_enabled_actions : [];
        process.env.MIMIR_FREE_EXPLORATION = acts.includes('fetch') ? '1' : '0';
        process.env.MIMIR_ACTIVE_OUTREACH = acts.includes('outreach') ? '1' : '0';
      }
    } catch { /* tolerated — daemon may still be booting; dashboard sync covers ongoing toggles */ }

    // Start Telegram polling
    if (bot) {
      try {
        await bot.start();
        console.log('         → Telegram polling started');
      } catch (e) {
        console.warn(`         ⚠ Telegram start failed: ${e.message}`);
        console.warn('           (check TELEGRAM_BOT_TOKEN — bot will not receive messages)');
        bot = null;
      }
    }

    // Start Cron scheduler
    scheduler.start();
    const taskCount = (config.cron.tasks ?? []).length;
    console.log(`         → Cron started (${taskCount} tasks)`);

    // ─── Step 11: Start Dashboard ───────────────────────────────────────────────
    console.log(' [11/11] Starting Dashboard...');
    try {
      dashboard = startDashboard({
        db, scheduler, engine, bot, llm, runtime,
        port: config.dashboard?.port || 18800,
        bootTime: startTime,
        config, transcriptIntegrity, taskManager, dbSnapshots,
        conversationLog: { getRecentLog, listLogDates },
        convStore,
        resolver: mimirResolver,
        behaviorLogger,
      });

      // Cloudflare Tunnel — opt-in only (requires user-installed `cloudflared`).
      // OSS users typically access dashboard via http://localhost:PORT directly;
      // tunnel is for advanced cases (remote access). Set config.dashboard.tunnel=true
      // to enable, after installing cloudflared from cloudflare.com.
      if (config.dashboard?.tunnel === true) {
        try {
          const { spawn: spawnChild } = await import('node:child_process');
          const tunnelPort = config.dashboard?.port || 18800;
          console.log('         ⚠ Cloudflare Tunnel enabled (config.dashboard.tunnel=true).');
          console.log('           All dashboard traffic transits Cloudflare\u2019s network');
          console.log('           via trycloudflare.com. Cloudflare\u2019s Terms of Service');
          console.log('           and Privacy Policy apply. Disable by setting');
          console.log('           dashboard.tunnel=false in config.json.');
          const tunnelProc = spawnChild('cloudflared', ['tunnel', '--url', `http://localhost:${tunnelPort}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
          });
          let urlSent = false;
          const handleOutput = (data) => {
            const line = data.toString();
            if (!urlSent) {
              const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
              if (match) {
                urlSent = true;
                const tunnelUrl = match[0];
                console.log(`         → Tunnel: ${tunnelUrl}`);
                if (bot) bot.tunnelUrl = tunnelUrl;
              }
            }
          };
          tunnelProc.stdout.on('data', handleOutput);
          tunnelProc.stderr.on('data', handleOutput);
          tunnelProc.on('error', (e) => {
            if (e.code === 'ENOENT') {
              console.log('         → Tunnel skipped (cloudflared not installed)');
            } else {
              console.warn(`         ⚠ Tunnel failed: ${e.message}`);
            }
          });
          dashboard._tunnelProc = tunnelProc;
        } catch (e) {
          console.warn(`         ⚠ Tunnel auto-start failed: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`         ⚠ Dashboard failed: ${e.message}`);
    }
  } else {
    console.log('  [9/10] Telegram, Cron, Dashboard skipped (CLI mode)');
  }

  // ─── Delayed cleanup: mark stale turn_journal entries as failed ──────────
  // Runs 30s after boot — gives telegram.js time to detect and resume interrupted turns
  setTimeout(() => {
    try {
      const cleaned = db.prepare(
        `UPDATE turn_journal SET status='failed', error='engine_crash_recovery', finished_at=datetime('now'), updated_at=datetime('now')
         WHERE status IN ('started','running') AND finished_at IS NULL`
      ).run();
      if (cleaned.changes > 0) {
        console.log(`  🧹 Cleaned ${cleaned.changes} stale turn_journal entries (not resumed)`);
      }
    } catch {}
  }, 30_000);

  // ─── Boot complete ────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  console.log(`\n🌌  Constellation Engine boot complete in ${elapsed}ms`);
  console.log(`   Engine: ${nodeCount} nodes | LLM: ${config.llm.primaryModel}`);
  console.log(`   Tools: ${toolDefs.length} | Sessions: ✅ | FTS5: ✅`);
  if (bot && scheduler) console.log(`   Telegram: polling | Cron: ${(config.cron.tasks ?? []).length} tasks`);
  console.log('');

  // Restart notification is handled by telegram.js #sendRestartNotification (consolidated)

  // ─── Async: Backfill missing embeddings (non-blocking) ──────────────────
  (async () => {
    try {
      const edb = engine.db;
      const embGap = edb.prepare(`
        SELECT COUNT(*) as c FROM nodes n
        WHERE n.state = 'active' AND n.id NOT IN (SELECT node_id FROM node_rowids)
      `).get().c;
      if (embGap > 0) {
        console.log(`  📐 Backfilling ${embGap} missing embeddings (background)...`);
        const missing = edb.prepare(`
          SELECT id, l0, l1 FROM nodes
          WHERE state = 'active' AND id NOT IN (SELECT node_id FROM node_rowids)
        `).all();
        let filled = 0;
        for (const node of missing) {
          try {
            const text = `${node.l0} ${node.l1 || ''}`;
            const embedding = await engine._embed(text);
            const upsert = edb.prepare('INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)');
            const getRow = edb.prepare('SELECT rowid FROM node_rowids WHERE node_id = ?');
            const delVec = edb.prepare('DELETE FROM node_embeddings WHERE id = ?');
            const insVec = edb.prepare('INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)');
            upsert.run(node.id);
            const row = getRow.get(node.id);
            delVec.run(row.rowid);
            insVec.run(BigInt(row.rowid), embedding);
            filled++;
          } catch (err) {
            if (filled === 0) console.warn(`  ⚠ Embedding error (node ${node.id}): ${err.message}`);
          }
        }
        console.log(`  📐 Embedding backfill complete: ${filled}/${embGap} nodes`);
      }
    } catch (e) {
      console.warn(`  ⚠ Embedding backfill failed: ${e.message}`);
    }
  })();

  /**
   * Graceful shutdown handler.
   */
  async function shutdown() {
    console.log('\n🌌  Constellation Engine shutting down...');
    try {
      if (dashboard?._tunnelProc) { dashboard._tunnelProc.kill(); console.log('  → Tunnel stopped'); }
      if (dashboard) dashboard.close(); console.log('  → Dashboard stopped');
    } catch {}
    try { if (mimirActionWorker) { mimirActionWorker.stop(); console.log('  → MimirActionWorker stopped'); } } catch {}
    try { await scheduler.stop(); console.log('  → Cron stopped'); } catch {}
    try { if (bot) await bot.stop(); console.log('  → Telegram stopped'); } catch {}
    try { subAgentManager.close(); console.log('  → SubAgent worker stopped'); } catch {}
    try { taskManager.close(); console.log('  → TaskManager closed'); } catch {}
    try {
      if (gatewayResult?.child) {
        gatewayResult.child.kill('SIGTERM');
        console.log('  → Gateway stopped (PID ' + gatewayResult.pid + ')');
      }
    } catch {}
    try { convStore.checkpoint?.(); } catch {}
    try { convStore.close(); } catch {}
    try { db.pragma('wal_checkpoint(TRUNCATE)'); console.log('  → WAL checkpoint (TRUNCATE) done'); } catch (e) {
      console.error('  → WAL checkpoint error:', e.message);
    }
    try { db.close(); console.log('  → DB closed'); } catch (e) {
      console.error('  → DB close error:', e.message);
    }
    console.log('🌌  Goodbye.\n');
  }

  return { shutdown, config, db, engine, sessions, llm, tools, runtime, bot, scheduler, dashboard, procedureExtractor, dialecticReasoner, taskManager, subAgentManager, dbSnapshots, transcriptIntegrity, convStore };
}

// ─── Entry Point (only when run directly) ──────────────────────────────────

const isDirectRun = process.argv[1]?.endsWith('main.js');

if (isDirectRun) {
  // Parse argv: support `--port N` (Electron launcher passes this when the
  // probed default port was busy and shifted forward). Remaining positional
  // is treated as a config path. Without this, argv[2]='--port' was being
  // handed to loadConfig as a filename, crashing boot at step 1/10.
  let cliPort = null;
  const positional = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--port' && i + 1 < process.argv.length) {
      cliPort = parseInt(process.argv[++i], 10);
    } else if (a.startsWith('--port=')) {
      cliPort = parseInt(a.slice('--port='.length), 10);
    } else {
      positional.push(a);
    }
  }
  const configPath = positional[0] || undefined;

  boot(configPath, cliPort ? { port: cliPort } : {})
    .then(result => {
      app = result;

      const onSignal = async (signal) => {
        console.log(`\nReceived ${signal}`);
        if (app) await app.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', () => onSignal('SIGINT'));
      process.on('SIGTERM', () => onSignal('SIGTERM'));

      // IPC shutdown channel for the Electron launcher.
      // Avoids Windows TerminateProcess (skips WAL checkpoint and risks DB corruption).
      // Launcher sends { type: 'shutdown' } over the IPC channel established by child_process.fork-style options;
      // here we accept it on any parent-child message.
      process.on('message', (msg) => {
        if (msg && typeof msg === 'object' && msg.type === 'shutdown') {
          onSignal('IPC:shutdown');
        }
      });

      process.on('unhandledRejection', (reason) => {
        console.error('⚠ Unhandled rejection:', reason);
      });

      setInterval(() => {}, 60_000);
    })
    .catch(err => {
      console.error('Boot failed:', err.message);
      console.error(err.stack);
      // Schema migration failures get a distinct exit code so electron/main.js
      // can show a recovery dialog instead of the generic crash modal.
      // Stderr line is also structured so the launcher can pull migration
      // metadata without re-running anything.
      if (err && err.migrationFailure) {
        const meta = {
          file: err.migrationFile || null,
          version: err.migrationVersion || null,
          message: err.original ? err.original.message : err.message,
        };
        console.error(`engine.migration_failure ${JSON.stringify(meta)}`);
        process.exit(78);
      }
      process.exit(1);
    });
}

export { boot };
