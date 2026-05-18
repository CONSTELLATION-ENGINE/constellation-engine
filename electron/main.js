// SPDX-License-Identifier: AGPL-3.0-or-later
// Constellation Engine — Electron launcher (L1).
//
// Boot path (per 04-27 plan §5.2 + 04-28 OSS-folder plan §6 Phase D):
//   1. Acquire single-instance lock; second double-click focuses existing window.
//   2. Probe configured port; on EADDRINUSE escalate to user.
//   3. Spawn `node ../src/main.js --port <chosen>` as IPC-piped child.
//   4. Read child stdout for `engine.ready { port, pid, version }`; correlate pid.
//   5. Poll http://127.0.0.1:<port>/api/status (belt-and-suspenders) until 200.
//   6. Open Dashboard window pointed at the engine URL.
//
// Graceful shutdown:
//   - IPC `shutdown` message → engine SIGINT path (WAL checkpoint, save Mímir).
//   - Wait up to 8s; escalate via tree-kill if still alive.
//
// Pre-start WAL cleanup (mirrors main arch start.sh:96-105):
//   - Before each engine spawn, run PRAGMA wal_checkpoint(TRUNCATE) on
//     constellation.db + conversations.db. After a crash, residual WAL
//     pages can otherwise produce "database is locked" or stale-read
//     symptoms on first reopen. better-sqlite3 ships with the engine.

const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const { fork } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const envCheck   = require('./onboarding/env-check');
const sentinel   = require('./onboarding/sentinel');
const downloader = require('./onboarding/downloader');
const llmConfig  = require('./onboarding/llm-config');

const CE_APP_ICON = path.join(__dirname, 'build-resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

const DEFAULT_PORT   = parseInt(process.env.CONSTELLATION_PORT || '18800', 10);
// First-boot worst-case = base init (~5–10s) + Mímir warmup serial calls,
// dominated by /embed which awaits a cold BGE-M3 ONNX load (~30–50s on
// slow disk / WSL2). engine.ready emits only after dashboard.listen at
// step 11, which sits behind the warmup. Old 30s budget killed engines
// mid-warmup on first boot; retry-after-page-cache succeeded under 30s,
// masking the bug. 120s covers cold ONNX + cold sockets + headroom.
const READY_TIMEOUT  = 120_000;
const SHUTDOWN_GRACE = 8_000;

// Path resolution differs between dev and packaged modes:
//   - dev:      ENGINE_DIR = repo root (writable, contains src/, data/, ...).
//   - packaged: ENGINE_DIR = <user>/engine, populated on first launch by
//               copying <resources>/engine. The engine source assumes a
//               writable root (conversations.db, data/logs/, identity/, ...
//               all live under engine root) — AppImage's squashfs is
//               read-only, so we stage the runtime copy under user.
let ENGINE_DIR     = null;
let ENGINE_ENTRY   = null;
let PID_FILE       = null;

let mainWindow = null;
let splashWindow = null;
let wizardWindow = null;
let engineChild = null;
let enginePort = DEFAULT_PORT;
let engineReady = false;
let engineInfo = { pid: null, port: null, version: null };
// Set true before any operator-initiated shutdown (Stop/Restart). Read by the
// child exit handler to decide whether to fire `engine:crashed`. Cleared after
// the next spawnEngine completes.
let userInitiatedStop = false;
// True only between advance-to-engine spawning the child and the wizard window
// closing as part of the success path. Wizard 'close' handler reads this to
// distinguish "advance closed me" from "user X'd out mid-flight" (B1).
let wizardAdvancing = false;
// Latest live HTTP healthcheck result (B2). engineReady = stdout-confirmed ready.
// engineHealthy = heartbeat probe within last interval. Combined for engine:status.
let engineHealthy = false;
let engineHealthyAt = 0;
let healthcheckTimer = null;
const HEALTHCHECK_INTERVAL_MS = 30_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const logBuffer = [];
const LOG_BUFFER_MAX = 5_000;

// Boot log auto-flush: captureLog only buffers in-memory + emits IPC, which
// means a wizard-skip user lands on dashboard without ever clicking the
// "save log" button — diagnostic captureLog lines (sentinel diag, boot
// decision) become unreachable. Persist every line to disk under
// userData/logs/launcher-boot.log; truncated at first launch flush so each
// boot has a clean fresh log. Lazy because app.getPath() requires app ready.
let bootLogPath = null;
let bootLogReady = false;
function ensureBootLogPath() {
  if (bootLogReady) return bootLogPath;
  try { if (!app.isReady()) return null; } catch { return null; }
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    bootLogPath = path.join(logsDir, 'launcher-boot.log');
    fs.writeFileSync(bootLogPath, `──── launcher boot @ ${new Date().toISOString()} (v${app.getVersion()}) ────\n`, 'utf-8');
    const backlog = logBuffer.map(e => `[${new Date(e.ts).toISOString()}] ${e.line}\n`).join('');
    if (backlog) fs.appendFileSync(bootLogPath, backlog);
    bootLogReady = true;
  } catch {}
  return bootLogPath;
}

// ─── Single-instance lock ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ─── Port probe ────────────────────────────────────────────────────────
function probePort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', (err) => {
        resolve({ ok: false, code: err.code });
      })
      .once('listening', () => {
        tester.close(() => resolve({ ok: true }));
      })
      .listen(port, '127.0.0.1');
  });
}

// ─── Engine spawn ──────────────────────────────────────────────────────
function captureLog(line) {
  logBuffer.push({ ts: Date.now(), line });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine:log', line);
  }
  try {
    const p = ensureBootLogPath();
    if (p) fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

// ─── Mímir spawn (mimir-js, in-process JS replacement for Python daemon) ─
// Boots before the engine so /status / /pool answer immediately when agent
// runtime probes them. Lifetime is tied to the launcher: a single Mímir
// child outlives engine restarts (we tear it down on app quit).
let mimirChild = null;
const MIMIR_BASE_PORT = parseInt(process.env.MIMIR_PORT || '18810', 10);
const MIMIR_PORT_RANGE = 10;              // 18810..18819 fallback span
let mimirResolvedPort = null;             // set after runtime.json poll succeeds
let mimirRuntimeFile = null;              // resolved once initPaths() runs
let installId = null;                     // cross-process handshake token
let mimirShuttingDown = false;            // suppresses respawn on app quit
let mimirRespawnTimer = null;
let mimirRespawnAttempts = 0;             // exponential backoff counter
let mimirWatchdogTimer = null;
let mimirWatchdogMissed = 0;              // consecutive /status probe failures
let mimirProbeInflight = false;           // single-flight: skip overlapping probes
// Hard-stop guard: if mimir crashes ≥ MIMIR_CRASH_LIMIT times within
// MIMIR_CRASH_WINDOW_MS, stop respawning. Without this, a structural failure
// (e.g. port range fully consumed, missing native dep) tight-loops forever
// and floods the log; the user gets no signal until they open diagnostics.
const mimirCrashTimestamps = [];
const MIMIR_CRASH_WINDOW_MS = 60_000;
const MIMIR_CRASH_LIMIT = 3;
let mimirHardStopped = false;
let mimirHardStopReason = null;

const MIMIR_WATCHDOG_INTERVAL_MS = 30_000;
const MIMIR_WATCHDOG_KILL_AFTER = 3;      // 3 misses (~90s) → kill+respawn
const MIMIR_RUNTIME_POLL_INTERVAL_MS = 200;
const MIMIR_RUNTIME_POLL_TIMEOUT_MS = 30_000;

function ensureInstallId() {
  // Generated once per install, persisted under userData so it survives engine
  // re-extracts. Handed to mimir + engine as INSTALL_ID env; mimir echoes it
  // via /status so the launcher can detect "talking to a foreign daemon".
  if (installId) return installId;
  const idFile = path.join(app.getPath('userData'), 'install-id');
  try {
    if (fs.existsSync(idFile)) {
      const existing = fs.readFileSync(idFile, 'utf-8').trim();
      if (existing) { installId = existing; return installId; }
    }
  } catch {}
  installId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, installId, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    captureLog(`[launcher] install-id persist failed: ${err.message} (using ephemeral id)`);
  }
  return installId;
}

function pollRuntimeFile(file, expectInstallId, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.install_id === expectInstallId && Number.isInteger(parsed.port)) {
            return resolve({ ok: true, runtime: parsed });
          }
          if (parsed && parsed.install_id && parsed.install_id !== expectInstallId) {
            return resolve({ ok: false, error: `foreign install_id ${parsed.install_id}` });
          }
        }
      } catch {}
      if (Date.now() > deadline) return resolve({ ok: false, error: 'runtime.json poll timeout' });
      setTimeout(tick, MIMIR_RUNTIME_POLL_INTERVAL_MS);
    };
    tick();
  });
}

function spawnMimir() {
  if (mimirHardStopped) {
    captureLog(`[mimir-js] hard-stopped (${mimirHardStopReason}) — refusing spawn`);
    return null;
  }
  if (mimirChild && mimirChild.exitCode === null) return mimirChild;
  const entry = path.join(ENGINE_DIR, 'scripts', 'mimir-js', 'index.js');
  if (!fs.existsSync(entry)) {
    captureLog(`[mimir-js] entry not found at ${entry} — skipping (engine will degrade gracefully)`);
    return null;
  }
  const dbPath = path.join(ENGINE_DIR, 'constellation.db');
  // Drop any stale runtime advertisement before spawning so the post-spawn
  // poll only sees a file written by *this* child. A previous mimir that
  // crashed before its own unlinkSync would otherwise leave a misleading
  // file in place pointing at a now-defunct port.
  try { fs.unlinkSync(mimirRuntimeFile); } catch {}
  mimirResolvedPort = null;
  mimirChild = fork(entry, [], {
    cwd: ENGINE_DIR,
    silent: true,
    env: {
      ...process.env,
      MIMIR_PORT: String(MIMIR_BASE_PORT),
      MIMIR_PORT_RANGE: String(MIMIR_PORT_RANGE),
      MIMIR_HOST: '127.0.0.1',
      CONSTELLATION_DB: dbPath,
      INSTALL_ID: installId,
      MIMIR_RUNTIME_FILE: mimirRuntimeFile,
      // Engine HTTP port for SSE push target (live-push.js posts to
      // /api/live/push so dashboard EventSource sees fresh tick/status/
      // activations/pool without slow polling). enginePort is set by the
      // port walk before spawnEngine() calls spawnMimir(), defaulting to
      // DEFAULT_PORT (18800) on first boot.
      CONSTELLATION_PORT: String(enginePort),
    },
  });
  captureLog(`[mimir-js] spawned pid=${mimirChild.pid} base_port=${MIMIR_BASE_PORT} range=${MIMIR_PORT_RANGE}`);
  mimirChild.stdout?.setEncoding('utf-8');
  mimirChild.stderr?.setEncoding('utf-8');
  mimirChild.stdout?.on('data', (chunk) => {
    chunk.split(/\r?\n/).filter(Boolean).forEach(line => captureLog(`[mimir] ${line}`));
  });
  mimirChild.stderr?.on('data', (chunk) => {
    chunk.split(/\r?\n/).filter(Boolean).forEach(line => captureLog(`[mimir-err] ${line}`));
  });
  mimirChild.on('exit', (code, signal) => {
    captureLog(`[mimir-js] exited code=${code} signal=${signal}`);
    mimirChild = null;
    mimirResolvedPort = null;
    if (mimirShuttingDown) return;
    // Track crash timestamps for hard-stop detection.
    const now = Date.now();
    mimirCrashTimestamps.push(now);
    while (mimirCrashTimestamps.length && mimirCrashTimestamps[0] < now - MIMIR_CRASH_WINDOW_MS) {
      mimirCrashTimestamps.shift();
    }
    if (mimirCrashTimestamps.length >= MIMIR_CRASH_LIMIT) {
      mimirHardStopped = true;
      mimirHardStopReason = `${mimirCrashTimestamps.length} crashes in ${MIMIR_CRASH_WINDOW_MS / 1000}s`;
      captureLog(`[mimir-js] HARD STOP — ${mimirHardStopReason}; respawn halted`);
      showMimirHardStopNotification(mimirHardStopReason);
      return;
    }
    scheduleMimirRespawn();
  });
  // Reset watchdog state on a clean spawn so a freshly-started child gets a
  // full grace period before its first probe.
  mimirWatchdogMissed = 0;
  startMimirWatchdog();
  return mimirChild;
}

function showMimirHardStopNotification(reason) {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) {
      captureLog('[mimir-js] notifications unsupported — hard stop visible only in logs');
      return;
    }
    const n = new Notification({
      title: 'Mímir failed to start',
      body: `${reason}. Port ${MIMIR_BASE_PORT}–${MIMIR_BASE_PORT + MIMIR_PORT_RANGE - 1} may all be in use, or the daemon is failing on boot. Open Diagnostics for details.`,
      silent: false,
    });
    n.on('click', () => {
      if (mainWindow) {
        try { mainWindow.show(); mainWindow.focus(); } catch {}
      }
    });
    n.show();
  } catch (err) {
    captureLog(`[mimir-js] hard-stop notification failed: ${err.message}`);
  }
}

function scheduleMimirRespawn() {
  if (mimirShuttingDown || mimirHardStopped) return;
  if (mimirRespawnTimer) return;
  mimirRespawnAttempts += 1;
  // Exponential backoff: 1s, 5s, 15s, 30s (capped) — capped to avoid
  // tight respawn loops if Mímir is structurally broken (bad code, missing
  // dep). Resets to 0 once a respawn stays alive past the watchdog interval.
  const delays = [1_000, 5_000, 15_000, 30_000];
  const wait = delays[Math.min(mimirRespawnAttempts - 1, delays.length - 1)];
  captureLog(`[mimir-js] respawn in ${wait}ms (attempt #${mimirRespawnAttempts})`);
  mimirRespawnTimer = setTimeout(() => {
    mimirRespawnTimer = null;
    spawnMimir();
  }, wait);
  mimirRespawnTimer.unref?.();
}

function startMimirWatchdog() {
  if (mimirWatchdogTimer) return;
  mimirWatchdogTimer = setInterval(probeMimir, MIMIR_WATCHDOG_INTERVAL_MS);
  mimirWatchdogTimer.unref?.();
}

function probeMimir() {
  if (!mimirChild || mimirChild.exitCode !== null) return;
  if (!mimirResolvedPort) return;            // pre-bind: nothing to probe yet
  // Single-flight: if a slow probe is still pending, skip this tick rather
  // than stack three concurrent requests that all fail "missed" and
  // trip the kill threshold against an otherwise-healthy child.
  if (mimirProbeInflight) return;
  mimirProbeInflight = true;
  const settle = (ok) => {
    mimirProbeInflight = false;
    if (ok) {
      mimirWatchdogMissed = 0;
      mimirRespawnAttempts = 0;             // healthy run resets backoff
    } else {
      mimirWatchdogMissed += 1;
      if (mimirWatchdogMissed >= MIMIR_WATCHDOG_KILL_AFTER) killWedgedMimir();
    }
  };
  const req = http.get({ host: '127.0.0.1', port: mimirResolvedPort, path: '/status', timeout: 5_000 }, (res) => {
    const ok = res.statusCode === 200;
    res.resume();
    res.on('end', () => settle(ok));
    res.on('error', () => settle(false));
  });
  req.on('error', () => settle(false));
  req.on('timeout', () => { req.destroy(); settle(false); });
}

function killWedgedMimir() {
  if (!mimirChild) return;
  captureLog(`[mimir-js] watchdog: ${mimirWatchdogMissed} consecutive /status misses — killing for respawn`);
  mimirWatchdogMissed = 0;
  try { mimirChild.kill('SIGKILL'); } catch {}
  // exit handler will clear mimirChild and call scheduleMimirRespawn().
}

function shutdownMimir() {
  mimirShuttingDown = true;
  if (mimirRespawnTimer) { clearTimeout(mimirRespawnTimer); mimirRespawnTimer = null; }
  if (mimirWatchdogTimer) { clearInterval(mimirWatchdogTimer); mimirWatchdogTimer = null; }
  if (!mimirChild || mimirChild.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const settle = () => { if (!done) { done = true; resolve(); } };
    mimirChild.once('exit', settle);
    try { mimirChild.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { mimirChild?.kill('SIGKILL'); } catch {} settle(); }, 2_000).unref();
  });
}

// Tiny .env parser (avoid pulling in a runtime dep). Wizard saveConfig writes
// .env with values escaped via `_envEscape` (double-quoted, JSON-style escapes)
// or as bare values from manual edits. This handles both. Comments/blank lines
// are ignored. The parsed map is merged into the engine fork's env so that
// `$ANTHROPIC_API_KEY`-style references in config.json resolve at boot.
function _loadDotenv(envPath) {
  const out = {};
  if (!envPath || !fs.existsSync(envPath)) return out;
  let text;
  try { text = fs.readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, ''); }
  catch { return out; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\([\\"$`n])/g, (_, c) => c === 'n' ? '\n' : c);
    } else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function walCheckpointCleanup() {
  // PRAGMA wal_checkpoint(TRUNCATE) on each db before spawn. If the previous
  // run crashed, the WAL may still hold uncommitted pages; reopening without
  // checkpoint can surface as "database is locked" or stale reads. We only
  // touch dbs whose -wal sidecar exists; absent sidecar = clean prior close.
  let Database;
  try {
    Database = require(path.join(ENGINE_DIR, 'node_modules', 'better-sqlite3'));
  } catch (e) {
    captureLog(`[launcher] WAL cleanup skipped — better-sqlite3 not resolvable: ${e.message}`);
    return;
  }
  const targets = [
    path.join(ENGINE_DIR, 'constellation.db'),
    path.join(ENGINE_DIR, 'conversations.db'),
  ];
  for (const dbPath of targets) {
    if (!fs.existsSync(dbPath)) continue;
    if (!fs.existsSync(dbPath + '-wal')) continue;
    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      captureLog(`[launcher] WAL checkpoint done: ${path.basename(dbPath)}`);
    } catch (e) {
      // SQLITE_BUSY (locked by another process) is the most likely failure.
      // Don't block spawn — engine.cjs's open path will retry with busy_timeout.
      captureLog(`[launcher] WAL checkpoint skipped for ${path.basename(dbPath)}: ${e.message}`);
    }
  }
}

async function spawnEngine(port) {
  // Pre-start cleanup: drain WAL files left behind by an unclean prior exit
  // BEFORE either Mímir or the engine reopens these dbs. See top-of-file
  // comment for rationale (matches main arch start.sh).
  walCheckpointCleanup();

  // Mímir-js (in-process JS daemon) must be reachable before the engine's
  // first /pool / /status probe. spawnMimir() is idempotent — fast no-op
  // when the child is already alive. Then wait until mimir advertises its
  // resolved port via runtime.json: the engine must talk to whatever port
  // mimir actually bound (may have fallen back from 18810→18811+ if a
  // foreign daemon held the base port).
  spawnMimir();
  if (!mimirResolvedPort) {
    const result = await pollRuntimeFile(mimirRuntimeFile, installId, MIMIR_RUNTIME_POLL_TIMEOUT_MS);
    if (result.ok) {
      mimirResolvedPort = result.runtime.port;
      captureLog(`[mimir-js] resolved port=${mimirResolvedPort} install_id=${installId}`);
    } else {
      // Fail closed — falling back to MIMIR_BASE_PORT here would risk talking
      // to a foreign daemon (the very class of bug Fix 2 exists to prevent).
      // Bubble up so the caller can surface a clear error to the user.
      captureLog(`[mimir-js] runtime resolve failed: ${result.error} — refusing to spawn engine without verified Mímir port`);
      throw new Error(`Mímir failed to advertise its port (${result.error}). Check ports ${MIMIR_BASE_PORT}–${MIMIR_BASE_PORT + MIMIR_PORT_RANGE - 1} or restart the launcher.`);
    }
  }
  const mimirUrl = `http://127.0.0.1:${mimirResolvedPort}`;

  // Load .env so config.json's `$ANTHROPIC_API_KEY`-style refs resolve in the
  // forked engine. process.env wins on conflict so a CI/environment override
  // beats the on-disk file, matching dotenv's "don't clobber" default.
  const dotenvVars = _loadDotenv(path.join(ENGINE_DIR, '.env'));
  const mergedEnv = { ...dotenvVars, ...process.env };

  // Use fork() so we get an IPC channel for the structured shutdown message.
  // stdio: 'pipe' for stdout/stderr; 'ipc' is auto-added by fork.
  engineChild = fork(ENGINE_ENTRY, ['--port', String(port)], {
    cwd: ENGINE_DIR,
    silent: true,
    env: {
      ...mergedEnv,
      CONSTELLATION_PORT: String(port),
      MIMIR_URL: mimirUrl,
      // MIMIR_PORT must reflect the RESOLVED port (not the base 18810): some
      // dashboard/engine code paths read MIMIR_PORT directly. On Win11 mirrored
      // networking the WSL2 main-arch daemon may hold 18810, forcing OSS
      // mimir-js to fall back to 18811+ — without this, the dashboard would
      // talk to the foreign daemon and inherit its star-map (4000+ nodes,
      // first-run sentinel implicitly satisfied).
      MIMIR_PORT: String(mimirResolvedPort),
      INSTALL_ID: installId,
    },
  });

  try { fs.writeFileSync(PID_FILE, String(engineChild.pid)); } catch {}

  engineChild.stdout.setEncoding('utf-8');
  engineChild.stderr.setEncoding('utf-8');

  engineChild.stdout.on('data', (chunk) => {
    chunk.split(/\r?\n/).filter(Boolean).forEach(line => {
      captureLog(line);
      // Look for the structured ready line (anywhere on the line, since other prefixes may exist).
      const m = line.match(/engine\.ready\s+(\{.*\})/);
      if (m) {
        try {
          const info = JSON.parse(m[1]);
          if (info.pid === engineChild.pid) {
            engineReady = true;
            // Adopt the actual bound port — dashboard.js walks forward on
            // EADDRINUSE if the requested port was grabbed between pre-spawn
            // probe and engine listen (TOCTOU window). Without this, pollStatus
            // keeps probing the stale port and times out at 120s.
            if (Number.isInteger(info.port) && info.port !== enginePort) {
              captureLog(`[launcher] engine bound to ${info.port} (requested ${enginePort}) — adopting walk-forward port`);
              enginePort = info.port;
            }
            engineInfo = { pid: info.pid, port: info.port, version: info.version };
            captureLog(`[launcher] engine.ready confirmed (pid=${info.pid}, port=${info.port}, v=${info.version})`);
            startHealthcheck();
          } else {
            captureLog(`[launcher] WARN: engine.ready pid mismatch (expected ${engineChild.pid}, got ${info.pid}) — ignoring`);
          }
        } catch (e) {
          captureLog(`[launcher] failed to parse engine.ready: ${e.message}`);
        }
      }
    });
  });

  // Migration-failure metadata is emitted as a structured stderr line by
  // src/main.js boot catch. We pluck it here so the exit handler can show
  // a recovery dialog with the offending file/version, not just a crash modal.
  let migrationFailureMeta = null;
  engineChild.stderr.on('data', (chunk) => {
    chunk.split(/\r?\n/).filter(Boolean).forEach(line => {
      captureLog(`[stderr] ${line}`);
      const m = line.match(/engine\.migration_failure\s+(\{.*\})/);
      if (m) {
        try { migrationFailureMeta = JSON.parse(m[1]); }
        catch (e) { captureLog(`[launcher] migration_failure JSON parse failed: ${e.message}`); }
      }
    });
  });

  engineChild.on('exit', (code, signal) => {
    captureLog(`[launcher] engine exited code=${code} signal=${signal}`);
    const wasReady = engineReady;
    const wasUserInitiated = userInitiatedStop;
    const failedMigration = migrationFailureMeta;
    migrationFailureMeta = null;
    engineReady = false;
    engineChild = null;
    engineInfo = { pid: null, port: null, version: null };
    stopHealthcheck();
    try { fs.unlinkSync(PID_FILE); } catch {}
    // Schema migration failure: engine refused to start because a migration
    // threw. Surface a recovery dialog with the offending file so the user
    // can either retry, open the data folder, or copy logs for support.
    // Code 78 + parsed metadata is the contract from src/main.js boot catch.
    if (code === 78 && !wasUserInitiated) {
      showMigrationRecoveryDialog(failedMigration);
      userInitiatedStop = false;
      return;
    }
    // RESTART_TOUCH path: the engine wrote .restart-requested before exiting
    // cleanly to request a respawn (pulse-handlers.js writeRestartTouch). Treat
    // as user-initiated for the crash modal, then spawn a fresh engine on the
    // same port. We delete the flag here so a future un-flagged exit cleanly
    // surfaces as a crash again.
    const restartFlagPath = path.join(ENGINE_DIR, '.restart-requested');
    if (code === 0 && !wasUserInitiated && fs.existsSync(restartFlagPath)) {
      let reason = 'agent-self-trigger';
      const reasonPath = path.join(ENGINE_DIR, '.restart-reason');
      try { reason = fs.readFileSync(reasonPath, 'utf-8').trim() || reason; } catch {}
      try { fs.unlinkSync(restartFlagPath); } catch {}
      captureLog(`[launcher] RESTART_TOUCH detected (reason="${reason}") — respawning engine`);
      userInitiatedStop = false;
      const portForRespawn = enginePort;
      // Small delay so any subscribers see the exit event before the new spawn.
      setTimeout(() => {
        spawnEngine(portForRespawn).catch(e => {
          captureLog(`[launcher] RESTART_TOUCH respawn failed: ${e.message}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('engine:crashed', { code, signal, tail: recentLogTail(40) });
          }
        });
      }, 500);
      return;
    }
    // Crash = unexpected exit while we thought we were running. Operator-driven
    // Stop/Restart sets userInitiatedStop first, so we don't surface a modal in
    // those cases.
    if (wasReady && !wasUserInitiated && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:crashed', { code, signal, tail: recentLogTail(40) });
    }
    userInitiatedStop = false;
  });

  return engineChild;
}

// ─── Live healthcheck (B2) ─────────────────────────────────────────────
// engineReady is set once when the child's stdout emits engine.ready; it never
// flips to false unless the process actually exits. That misses "process alive
// but event-loop wedged" (DB lock, async deadlock). A 30 s background HTTP ping
// catches those cases — engine:status reports {ready, healthy} so renderers can
// distinguish "supposedly running" from "actually answering."
function probeHealth() {
  if (!engineChild || !engineReady) {
    engineHealthy = false;
    return;
  }
  const port = enginePort;
  const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: HEALTHCHECK_TIMEOUT_MS }, (res) => {
    if (res.statusCode === 200) {
      engineHealthy = true;
      engineHealthyAt = Date.now();
    } else {
      engineHealthy = false;
    }
    res.resume();
  });
  req.on('error', () => { engineHealthy = false; });
  req.on('timeout', () => { req.destroy(); engineHealthy = false; });
}

function startHealthcheck() {
  if (healthcheckTimer) return;
  // First probe shortly after engine reports ready, then on a fixed interval.
  setTimeout(probeHealth, 1500);
  healthcheckTimer = setInterval(probeHealth, HEALTHCHECK_INTERVAL_MS);
  startNotificationPoll();
}

function stopHealthcheck() {
  if (healthcheckTimer) { clearInterval(healthcheckTimer); healthcheckTimer = null; }
  engineHealthy = false;
  engineHealthyAt = 0;
  stopNotificationPoll();
}

// ─── OS notification poll (Phase 9.3) ────────────────────────────────
// Polls the engine outbox every 15s for queued notifications and surfaces
// each one via Electron's Notification class. The engine only writes to
// the outbox when engine_meta.os_notifications_enabled = '1', so we don't
// need a launcher-side opt-in check; if the table's empty we no-op.
let notificationPollTimer = null;
const NOTIFICATION_POLL_MS = 15_000;

function startNotificationPoll() {
  if (notificationPollTimer) return;
  setTimeout(pollNotifications, 3000);
  notificationPollTimer = setInterval(pollNotifications, NOTIFICATION_POLL_MS);
}

function stopNotificationPoll() {
  if (notificationPollTimer) { clearInterval(notificationPollTimer); notificationPollTimer = null; }
}

function pollNotifications() {
  if (!engineReady || !Notification.isSupported || !Notification.isSupported()) return;
  const req = http.request({
    host: '127.0.0.1',
    port: enginePort,
    path: '/api/launcher/notifications/dequeue',
    method: 'GET',
    timeout: 5_000,
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      try {
        const parsed = buf ? JSON.parse(buf) : {};
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        for (const item of items) {
          try {
            const n = new Notification({
              title: String(item.title || 'Constellation'),
              body: String(item.body || ''),
              silent: false,
            });
            if (item.deeplink) {
              n.on('click', () => {
                if (mainWindow) {
                  try { mainWindow.show(); mainWindow.focus(); } catch {}
                }
              });
            }
            n.show();
          } catch (e) {
            captureLog(`[launcher] notification dispatch failed: ${e.message}`);
          }
        }
      } catch {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => { try { req.destroy(); } catch {} });
  req.end();
}

// ─── Status polling (belt-and-suspenders) ─────────────────────────────
function pollStatus(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) return reject(new Error('engine status poll timeout'));
      if (!engineReady) {
        return setTimeout(tick, 500);
      }
      // Once engine.ready arrived, engineInfo.port reflects the actual bound
      // port (may differ from the spawn-time arg if dashboard walked forward
      // through an EADDRINUSE squat). Prefer it; fall back to the original
      // arg if the structured ready line was malformed.
      const probePort = (engineInfo && Number.isInteger(engineInfo.port)) ? engineInfo.port : port;
      const req = http.get({ host: '127.0.0.1', port: probePort, path: '/api/status', timeout: 2_000 }, (res) => {
        if (res.statusCode === 200) return resolve();
        res.resume();
        setTimeout(tick, 500);
      });
      req.on('error', () => setTimeout(tick, 500));
    };
    tick();
  });
}

// ─── Windows ──────────────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 360,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#0b0e1a',
    icon: CE_APP_ICON,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'splash-preload.js'),
    },
  });
  splashWindow.loadFile(path.join(__dirname, 'views', 'splash.html'));
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#0b0e1a',
    icon: CE_APP_ICON,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // L1 ships the library shell. L2 will fold in stop/restart/diagnose UI.
  mainWindow.loadFile(path.join(__dirname, 'views', 'library.html'), { query: { port: String(port) } });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Onboarding wizard window ─────────────────────────────────────────
function createWizard(opts = {}) {
  wizardWindow = new BrowserWindow({
    width: 960,
    height: 720,
    backgroundColor: '#0b0e1a',
    resizable: true,
    icon: CE_APP_ICON,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Forward the install/upgrade flag via query param so the wizard can render
  // a Skip CTA on Stage 1 for returning users (they keep their data — the
  // wizard just refreshes the sentinel's recorded app_version).
  const loadOpts = {};
  if (opts.versionMigrating) loadOpts.query = { versionMigrating: '1' };
  wizardWindow.loadFile(path.join(__dirname, 'views', 'wizard.html'), loadOpts);

  // B1 — wizard close mid-flight must not orphan the engine. The wizard's
  // success path sets wizardAdvancing=true and closes the window itself; any
  // OTHER close (user clicks X during Stage 4 boot, OS forces window close)
  // means engineChild was spawned but no main window exists to manage it.
  wizardWindow.on('close', async (e) => {
    if (wizardAdvancing) return;            // success path — let it close
    if (!engineChild) return;               // no engine running yet — safe close
    if (engineChild.exitCode !== null) return;
    // Defer the actual close until we've gracefully stopped the engine.
    e.preventDefault();
    captureLog('[launcher] wizard closed mid-flight while engine running — shutting engine down before exit');
    userInitiatedStop = true;
    try { await shutdownEngine(); } catch (err) {
      captureLog(`[launcher] wizard-close shutdown failed: ${err.message}`);
    }
    if (wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.destroy();
    }
  });

  wizardWindow.on('closed', () => {
    wizardWindow = null;
    // If the user X'd out the wizard after engine boot succeeded but before
    // calling onboarding:finish, route them straight to the dashboard. They
    // skipped Stage 7's quick quiz; that's fine — autonomy_seeds is optional
    // and bootstrap loop tolerates its absence.
    if (wizardAdvancing && engineReady && !mainWindow) {
      if (isPermissionAcknowledged()) {
        createMainWindow(enginePort);
      } else {
        createPermissionWindow(() => createMainWindow(enginePort));
      }
    }
  });
}

// ─── IPC handlers ─────────────────────────────────────────────────────
ipcMain.handle('engine:status', () => ({
  // ready    = stdout-confirmed startup (sticky until exit)
  // healthy  = last live HTTP probe answered within HEALTHCHECK_INTERVAL_MS
  // healthyAt = timestamp of last successful probe (renderer can show staleness)
  ready: engineReady,
  healthy: engineHealthy,
  healthyAt: engineHealthyAt || null,
  pid: engineChild ? engineChild.pid : null,
  port: enginePort,
  version: engineInfo.version || null,
  engineDir: ENGINE_DIR || null,
}));

// ─── Library lifecycle controls (Sprint 1 — B3) ───────────────────────
async function bootEngineFromLibrary() {
  if (engineChild) throw new Error('engine already running');
  let chosenPort = null;
  for (let i = 0; i < 10; i++) {
    const candidate = enginePort + i;
    const probe = await probePort(candidate);
    if (probe.ok) { chosenPort = candidate; break; }
  }
  if (chosenPort === null) {
    throw new Error(`Ports ${enginePort}–${enginePort + 9} are all in use.`);
  }
  enginePort = chosenPort;
  await spawnEngine(enginePort);
  await pollStatus(enginePort, Date.now() + READY_TIMEOUT);
}

ipcMain.handle('engine:start', async () => {
  if (engineChild) return { ok: false, error: 'engine already running' };
  try {
    await bootEngineFromLibrary();
    return { ok: true, port: enginePort };
  } catch (err) {
    if (engineChild) { try { engineChild.kill('SIGTERM'); } catch {} }
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('engine:stop', async () => {
  if (!engineChild) return { ok: false, error: 'engine not running' };
  userInitiatedStop = true;
  await shutdownEngine();
  return { ok: true };
});

ipcMain.handle('engine:restart', async () => {
  if (engineChild) {
    userInitiatedStop = true;
    await shutdownEngine();
  }
  // N1 — visual separator so operators can tell sessions apart in the buffer.
  captureLog(`──────── engine restart @ ${new Date().toISOString()} ────────`);
  try {
    await bootEngineFromLibrary();
    return { ok: true, port: enginePort };
  } catch (err) {
    if (engineChild) { try { engineChild.kill('SIGTERM'); } catch {} }
    return { ok: false, error: err.message };
  }
});

// Debug bar (B6) — proxied HTTP. Renderer can't talk to 127.0.0.1 directly
// (Electron CSP + CORS) so main process round-trips on its behalf.
ipcMain.handle('engine:request', async (_evt, opts = {}) => {
  if (!engineReady) return { ok: false, error: 'engine not running' };
  const method = (opts.method || 'GET').toUpperCase();
  const reqPath = opts.path || '/';
  const body = opts.body != null ? String(opts.body) : null;
  if (!/^[A-Z]+$/.test(method)) return { ok: false, error: 'invalid method' };
  if (typeof reqPath !== 'string' || !reqPath.startsWith('/')) {
    return { ok: false, error: 'path must start with /' };
  }
  return await new Promise((resolve) => {
    const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};
    const req = http.request({ host: '127.0.0.1', port: enginePort, path: reqPath, method, headers, timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({ ok: true, status: res.statusCode, body: text });
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
});

// Save the rolling log buffer to a tmp file and reveal it (Copy/Save logs).
ipcMain.handle('engine:save-log', async () => {
  try {
    const tmpDir = app.getPath('temp');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(tmpDir, `constellation-engine-${stamp}.log`);
    const body = logBuffer.map(e => `[${new Date(e.ts).toISOString()}] ${e.line}`).join('\n');
    fs.writeFileSync(logFile, body || '(no log lines captured yet)', 'utf-8');
    await shell.openPath(logFile);
    return { ok: true, path: logFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('engine:logs', (_evt, opts = {}) => {
  const since = opts.since || 0;
  return logBuffer.filter(e => e.ts > since);
});

ipcMain.handle('dashboard:open', () => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  shell.openExternal(`http://127.0.0.1:${enginePort}/`);
  return { ok: true };
});

ipcMain.handle('onboarding:env-check', async () => {
  return await envCheck.runAllChecks();
});

ipcMain.handle('onboarding:sentinel-status', () => ({
  complete: sentinel.isOnboardingComplete(),
  inconsistent: sentinel.isConfigInconsistent(),
  inconsistencyReason: sentinel.isConfigInconsistent()
    ? sentinel.readInconsistencyReason()
    : null,
}));

// ─── Stage 2: component download ──────────────────────────────────────
const downloadJobs = new Map();   // componentId → { ctrl: AbortController, emitter, donePromise }

ipcMain.handle('onboarding:list-components', () => {
  return downloader.listComponents().map(c => ({
    ...c,
    installed: downloader.isComponentInstalled(c.id, ENGINE_DIR),
  }));
});

ipcMain.handle('onboarding:download-start', (_evt, { componentId, mirrorOverride }) => {
  if (downloadJobs.has(componentId)) {
    return { ok: false, error: 'already running' };
  }
  const ctrl = new AbortController();
  let emitter;
  try {
    emitter = downloader.downloadComponent(componentId, {
      destRoot: ENGINE_DIR,
      signal: ctrl.signal,
      mirrorOverride: typeof mirrorOverride === 'number' ? mirrorOverride : undefined,
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const forward = (channel) => (payload) => {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
      wizardWindow.webContents.send(channel, payload);
    }
  };
  emitter.on('file:start',     forward('download:file-start'));
  emitter.on('file:done',      forward('download:file-done'));
  emitter.on('progress',       forward('download:progress'));
  emitter.on('mirror:fail',    forward('download:mirror-fail'));
  emitter.on('component:done', (p) => { downloadJobs.delete(componentId); forward('download:component-done')(p); });
  emitter.on('component:fail', (p) => { downloadJobs.delete(componentId); forward('download:component-fail')(p); });
  emitter.on('aborted',        (p) => { downloadJobs.delete(componentId); forward('download:aborted')(p); });

  // Swallow rejection so unhandledRejection doesn't crash the launcher; UI sees
  // the reason via the component:fail / aborted events emitted above.
  emitter.done.catch((err) => {
    captureLog(`[downloader] ${componentId} rejected: ${err.message}`);
  });

  downloadJobs.set(componentId, { ctrl, emitter });
  return { ok: true };
});

ipcMain.handle('onboarding:download-cancel', (_evt, { componentId }) => {
  const job = downloadJobs.get(componentId);
  if (!job) return { ok: false, error: 'no such job' };
  try { job.ctrl.abort(); } catch {}
  return { ok: true };
});

ipcMain.handle('onboarding:component-installed', (_evt, { componentId }) => {
  return { installed: downloader.isComponentInstalled(componentId, ENGINE_DIR) };
});

// ─── Stage 3: LLM configuration ──────────────────────────────────────
// Pre-engine: we run all provider HTTP calls in the launcher process. The
// engine isn't started yet, so the OSS /api/first-run/* endpoints aren't
// available. Atomic file writes happen here, then engine boots fresh.

ipcMain.handle('onboarding:llm-list-providers', () => {
  // Strip large bundled-model arrays out of the wire payload — UI doesn't need
  // them up front; it asks via llm-list-models when a slot picks a card.
  return llmConfig.PROVIDER_CARDS.map(({ id, name, icon, tag, desc, needsKey, defaultBaseUrl, helpText, apiKeyUrl, allowFreeTextModel }) => ({
    id, name, icon, tag, desc, needsKey, defaultBaseUrl, helpText, apiKeyUrl, allowFreeTextModel: !!allowFreeTextModel,
  }));
});

ipcMain.handle('onboarding:llm-list-models', async (_evt, opts = {}) => {
  try {
    const { cardId, apiKey, baseUrl } = opts || {};
    if (!cardId) return { ok: false, models: [], error: 'cardId required' };
    return await llmConfig.listModels(cardId, { apiKey, baseUrl });
  } catch (err) {
    return { ok: false, models: [], error: err?.message || String(err) };
  }
});

ipcMain.handle('onboarding:llm-test-connection', async (_evt, opts = {}) => {
  try {
    const { cardId, apiKey, baseUrl, model } = opts || {};
    if (!cardId) return { ok: false, error: 'cardId required' };
    return await llmConfig.testConnection(cardId, { apiKey, baseUrl, model });
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('onboarding:llm-save-config', async (_evt, payload = {}) => {
  try {
    const { tier, roles } = payload || {};
    const result = llmConfig.saveConfig({ tier, roles, repoRoot: ENGINE_DIR });
    captureLog(`[launcher] LLM config saved (tier=${tier})`);
    return result;
  } catch (err) {
    captureLog(`[launcher] LLM config save failed: ${err.message}`);
    return { ok: false, error: err?.message || String(err) };
  }
});

// ─── Wizard draft persistence (S6) ────────────────────────────────────
// Persist the wizard's typed-but-not-saved state so an accidental window close
// during Stage 3 doesn't force the user to retype everything. Saved file lives
// under userData (writable, per-user, survives engine reinstall) and is mode
// 0600 because it can contain unsaved API keys. Cleared on success or reset.
function wizardDraftPath() {
  return path.join(app.getPath('userData'), 'wizard-draft.json');
}

function clearWizardDraft() {
  try { fs.unlinkSync(wizardDraftPath()); } catch {}
}

// ─── Permission disclosure (Batch E) ──────────────────────────────────
// One-time consent page shown after engine boot, before dashboard opens.
// Sentinel lives next to engine's .first-run-complete so it survives
// launcher reinstalls but is reset by an engine-data wipe.
const PERMISSION_VERSION = '1.0';
let permissionWindow = null;
let pendingPostAck = null;

function permissionSentinelPath() {
  return path.join(ENGINE_DIR, 'data', '.permission-acknowledged');
}

function isPermissionAcknowledged() {
  if (process.env.CONSTELLATION_AUTO_ACK === '1') return true;
  try {
    const file = permissionSentinelPath();
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === PERMISSION_VERSION;
  } catch {
    return false;
  }
}

function writePermissionAck() {
  const file = permissionSentinelPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const body = JSON.stringify({
    acknowledged_at: new Date().toISOString(),
    version: PERMISSION_VERSION,
    scope: 'default-engine-root',
  }, null, 2);
  fs.writeFileSync(tmp, body, 'utf-8');
  fs.renameSync(tmp, file);
}

function createPermissionWindow(onAck) {
  if (permissionWindow && !permissionWindow.isDestroyed()) {
    permissionWindow.focus();
    pendingPostAck = onAck || null;
    return;
  }
  pendingPostAck = onAck || null;
  permissionWindow = new BrowserWindow({
    width: 760,
    height: 760,
    title: 'Constellation — Permissions',
    autoHideMenuBar: true,
    icon: CE_APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  permissionWindow.loadFile(path.join(__dirname, 'views', 'permission-disclosure.html'));
  permissionWindow.on('closed', () => {
    const wasAcknowledged = isPermissionAcknowledged();
    permissionWindow = null;
    if (!wasAcknowledged && !mainWindow) {
      // User dismissed disclosure without consenting; honor cancel = quit.
      captureLog('[launcher] permission window closed without ack — quitting');
      pendingPostAck = null;
      app.quit();
    }
  });
}

ipcMain.handle('permission:status', () => ({
  acknowledged: isPermissionAcknowledged(),
  version: PERMISSION_VERSION,
}));

ipcMain.handle('permission:acknowledge', () => {
  try {
    writePermissionAck();
    captureLog('[launcher] permission acknowledged');
    const cb = pendingPostAck;
    pendingPostAck = null;
    if (permissionWindow && !permissionWindow.isDestroyed()) {
      permissionWindow.close();
    }
    if (typeof cb === 'function') {
      try { cb(); } catch (err) { captureLog(`[launcher] post-ack hook failed: ${err.message}`); }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('permission:cancel', () => {
  pendingPostAck = null;
  if (permissionWindow && !permissionWindow.isDestroyed()) {
    permissionWindow.close();
  }
  // The 'closed' handler will quit if no ack was written.
  return { ok: true };
});

ipcMain.handle('permission:open-engine-folder', () => {
  if (!ENGINE_DIR) return { ok: false, error: 'engine dir not initialized' };
  shell.showItemInFolder(ENGINE_DIR);
  return { ok: true };
});

ipcMain.handle('permission:open-policy', () => {
  // Try a few likely bundled locations (dev + packaged), fall back to GitHub.
  const candidates = [
    path.join(__dirname, '..', 'PERMISSIONS.md'),                                   // dev / source layout
    path.join(process.resourcesPath || '', 'engine', 'PERMISSIONS.md'),             // packaged: extraResources mounts under resources/engine/
    path.join(process.resourcesPath || '', 'PERMISSIONS.md'),                       // fallback: bare resources/
    ENGINE_DIR ? path.join(ENGINE_DIR, 'PERMISSIONS.md') : null,                    // post-extract copy
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        shell.openPath(p);
        return { ok: true, path: p };
      }
    } catch {}
  }
  shell.openExternal('https://github.com/CONSTELLATION-ENGINE/constellation-engine/blob/main/PERMISSIONS.md');
  return { ok: true, fallback: 'github' };
});

ipcMain.handle('wizard:save-draft', (_evt, draft) => {
  try {
    if (!draft || typeof draft !== 'object') return { ok: false, error: 'draft must be an object' };
    const file = wizardDraftPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), draft }, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {} // best-effort on Windows
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard:load-draft', () => {
  try {
    const file = wizardDraftPath();
    if (!fs.existsSync(file)) return { ok: true, draft: null };
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ok: true, draft: parsed.draft || null, savedAt: parsed.savedAt || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wizard:clear-draft', () => {
  clearWizardDraft();
  return { ok: true };
});

ipcMain.handle('app:open-external', (_evt, url) => {
  if (typeof url !== 'string') return { ok: false, error: 'url must be a string' };
  // Defense in depth — only http(s) urls; never file://, javascript:, etc.
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) URLs allowed' };
  shell.openExternal(url);
  return { ok: true };
});

// ─── Stage 4: engine startup ─────────────────────────────────────────
function emitBootProgress(phase, message) {
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    wizardWindow.webContents.send('engine:boot-progress', { phase, message });
  }
}

function recentLogTail(n = 60) {
  return logBuffer.slice(-n).map(e => e.line).join('\n');
}

// Schema migration recovery dialog. Engine exits 78 when a migration threw;
// we show a modal with the file/version and let the user choose between
// "Retry" (relaunch app), "Open Data Folder" (so they can back up the .db),
// and "Copy Diagnostics" (clipboard the failure metadata + log tail). We
// never auto-rollback or auto-delete data — too risky for v0.1.0.
function showMigrationRecoveryDialog(meta) {
  const { clipboard } = require('electron');
  const file = meta?.file || '(unknown migration)';
  const version = meta?.version != null ? `v${meta.version}` : '(unknown version)';
  const errMsg = meta?.message || 'No error details captured. Check engine logs.';
  const tail = recentLogTail(50);
  const dataDir = app.getPath('userData');

  const detail = [
    `Migration: ${file} (${version})`,
    `Error: ${errMsg}`,
    '',
    'Your data may be in a partially-migrated state.',
    'Open the Data Folder and back up the .db files BEFORE retrying.',
    'You can copy diagnostics and reach out for support, or quit and restore from backup.',
    '',
    `Data folder: ${dataDir}`,
  ].join('\n');

  const buttons = ['Retry', 'Open Data Folder', 'Copy Diagnostics', 'Quit'];
  // Loop until user picks Retry or Quit. Open-Folder/Copy-Diagnostics re-show
  // the dialog so they can still choose afterwards. Loop avoids growing the JS
  // stack via recursion when a user mashes Open-Folder/Copy multiple times.
  while (true) {
    const choice = dialog.showMessageBoxSync(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, {
      type: 'error',
      title: 'Constellation — Schema Update Failed',
      message: 'A schema update could not be applied.',
      detail,
      buttons,
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });

    if (choice === 0) {
      app.relaunch();
      app.exit(0);
      return;
    } else if (choice === 1) {
      shell.openPath(dataDir).catch(() => {});
      continue;
    } else if (choice === 2) {
      const diag = [
        `Constellation OSS — migration failure diagnostics`,
        `Migration: ${file} (${version})`,
        `Error: ${errMsg}`,
        `Data folder: ${dataDir}`,
        ``,
        `--- recent log tail ---`,
        tail,
      ].join('\n');
      clipboard.writeText(diag);
      continue;
    } else {
      app.exit(0);
      return;
    }
  }
}

async function bootEngineWithProgress() {
  // Caller pre-checks engineChild; we still defend.
  if (engineChild) throw new Error('engine already running');

  emitBootProgress('spawn');

  // Pre-spawn port probe — walk forward from DEFAULT_PORT up to 10 ports if
  // the configured one is busy (matches env-check checkPort + Phase 3 boot).
  let chosenPort = null;
  for (let i = 0; i < 10; i++) {
    const candidate = enginePort + i;
    const probe = await probePort(candidate);
    if (probe.ok) { chosenPort = candidate; break; }
  }
  if (chosenPort === null) {
    throw new Error(`Ports ${enginePort}–${enginePort + 9} are all in use. Close another instance or change CONSTELLATION_PORT.`);
  }
  if (chosenPort !== enginePort) {
    captureLog(`[launcher] requested port ${enginePort} busy, using ${chosenPort}`);
    enginePort = chosenPort;
  }

  await spawnEngine(enginePort);

  // Best-effort substage progression. Engine doesn't emit structured phase
  // signals, so we time-escalate the label while polling for engine.ready.
  // If boot is faster than the timer, the wizard jumps from spawn → ready.
  const start = Date.now();
  let phase = 'spawn';
  const tick = setInterval(() => {
    if (engineReady) return;
    const elapsed = Date.now() - start;
    if (phase === 'spawn' && elapsed >= 1500)      { phase = 'db';     emitBootProgress('db'); }
    else if (phase === 'db'     && elapsed >= 4500) { phase = 'llm';    emitBootProgress('llm'); }
    else if (phase === 'llm'    && elapsed >= 12_000) { phase = 'warmup'; emitBootProgress('warmup'); }
  }, 250);

  try {
    await pollStatus(enginePort, Date.now() + READY_TIMEOUT);
  } finally {
    clearInterval(tick);
  }

  emitBootProgress('ready');
}

ipcMain.handle('onboarding:advance-to-engine', async () => {
  // Called by the wizard once it's ready to start the engine (Stage 3 saved
  // LLM config). Spawns engine, waits for ready, writes launcher sentinel,
  // and returns. The wizard then advances to Stage 7 (Quick Quiz). The
  // wizard window stays open until onboarding:finish closes it; the
  // dashboard window is opened by onboarding:finish, not here.
  if (engineChild) return { ok: false, error: 'engine already running' };
  try {
    await bootEngineWithProgress();
    // Atomic sentinel pair: only after the engine confirms ready do we mark
    // BOTH (a) engine first-run complete and (b) launcher onboarding complete.
    // Pre-fix order wrote (a) at saveConfig time, so a Stage-4 boot failure
    // left (a) set without (b) — re-launch then short-circuited the wizard
    // and stranded the user on a still-broken engine. New order: writes only
    // happen on the success path, never on failure.
    try {
      const engineSentinel = path.join(ENGINE_DIR, 'data', '.first-run-complete');
      fs.mkdirSync(path.dirname(engineSentinel), { recursive: true });
      fs.writeFileSync(engineSentinel, JSON.stringify({
        completed_at: new Date().toISOString(),
        source: 'launcher-bridge',
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      captureLog(`[launcher] engine sentinel write failed: ${err.message}`);
    }
    try {
      sentinel.writeOnboardingComplete({ source: 'advance-to-engine', app_version: app.getVersion() });
    } catch (err) {
      captureLog(`[launcher] launcher sentinel write failed: ${err.message}`);
    }
    try { clearWizardDraft(); } catch {}
    // Latch: wizard close handler now treats wizard close as success path
    // (engine survives). We never reset this — past this point, the engine
    // is the user's session and outlives the wizard window.
    wizardAdvancing = true;
    return { ok: true, port: enginePort };
  } catch (err) {
    captureLog(`[launcher] engine boot failed: ${err.message}`);
    // Push the last log lines along so the wizard's failure pane can show
    // a usable error without a separate IPC round-trip.
    const tail = recentLogTail(40);
    const detail = tail ? `${err.message}\n\n--- recent log ---\n${tail}` : err.message;
    emitBootProgress('fail', detail);
    // If engine partly started, kill it before returning so retry is clean.
    if (engineChild) {
      try { engineChild.kill('SIGTERM'); } catch {}
    }
    return { ok: false, error: detail };
  }
});

// Stage 7 finish: close wizard, open dashboard (or permission gate). Called
// by the wizard after Quick Quiz submit — or after a "skip" (no chips, no
// freetext). Sentinel + draft clear were already done in advance-to-engine,
// so this handler only owns window lifecycle.
// Version-skip path for returning users who already have data + a working
// LLM config from a prior install. Writes the sentinel with the new
// app_version (so the next boot fast-paths) and opens the dashboard. We
// don't touch any user data here — the existing engine sentinel and
// config.json stay as-is.
ipcMain.handle('onboarding:version-skip', async () => {
  try {
    sentinel.writeOnboardingComplete({ source: 'version-skip', app_version: app.getVersion() });
  } catch (err) {
    captureLog(`[launcher] version-skip sentinel write failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
  // Engine isn't running yet at this stage (we never spawned it because the
  // wizard re-opened on Phase 2). Boot it now and route the user straight
  // to the dashboard, the same way the returning-user fast path does.
  let chosenPort = null;
  for (let i = 0; i < 10; i++) {
    const candidate = DEFAULT_PORT + i;
    const probe = await probePort(candidate);
    if (probe.ok) { chosenPort = candidate; break; }
  }
  if (chosenPort === null) {
    return { ok: false, error: `Ports ${DEFAULT_PORT}–${DEFAULT_PORT + 9} all in use.` };
  }
  enginePort = chosenPort;
  try {
    await spawnEngine(enginePort);
    await pollStatus(enginePort, Date.now() + READY_TIMEOUT);
  } catch (err) {
    captureLog(`[launcher] version-skip engine boot failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
  wizardAdvancing = true;
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    try { wizardWindow.close(); } catch {}
    wizardWindow = null;
  }
  if (isPermissionAcknowledged()) {
    createMainWindow(enginePort);
  } else {
    createPermissionWindow(() => createMainWindow(enginePort));
  }
  return { ok: true };
});

ipcMain.handle('onboarding:finish', async () => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  // wizardAdvancing was latched true in advance-to-engine; close handler
  // now treats this as a success path and won't kill the engine.
  if (wizardWindow && !wizardWindow.isDestroyed()) {
    try { wizardWindow.close(); } catch {}
    wizardWindow = null;
  }
  if (isPermissionAcknowledged()) {
    createMainWindow(enginePort);
  } else {
    createPermissionWindow(() => createMainWindow(enginePort));
  }
  return { ok: true };
});

// Stage 7 seed submit: forward the wizard's chip+freetext payload to the
// engine so it can write a single autonomy_seeds node. We POST localhost so
// the engine owns the schema/owner_id/event_at logic — launcher stays thin.
ipcMain.handle('wizard:submit-profile-seed', async (_evt, payload) => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  const body = JSON.stringify(payload || {});
  return await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: enginePort,
      path: '/api/wizard/profile-seed',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60_000,
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
            resolve({ ok: true, ...parsed });
          } else {
            resolve({ ok: false, error: parsed.error || `http ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ ok: false, error: `parse error: ${e.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'engine request timeout' }); });
    req.write(body);
    req.end();
  });
});

// Stage 8: Request OS notification permission.
// Electron's main-process Notification class doesn't have a permission prompt
// per se — Notification.isSupported() is the closest gate. On macOS, the very
// first new Notification() call triggers the OS-level permission dialog; on
// Windows it's controlled by Settings → Notifications. We probe support and
// fire one no-op notification to surface the OS prompt where applicable.
ipcMain.handle('onboarding:request-notification-permission', async () => {
  try {
    if (!Notification.isSupported || !Notification.isSupported()) {
      return { ok: false, permission: 'unsupported' };
    }
    // Probe: construct + show a silent welcome notification. On macOS this
    // surfaces the system permission prompt the first time. On Linux/Windows
    // it's a soft welcome. Failure here doesn't block onboarding.
    try {
      const probe = new Notification({
        title: 'Constellation Engine',
        body: 'Notifications enabled.',
        silent: true,
      });
      probe.show();
    } catch {}
    return { ok: true, permission: 'granted' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Stage 8 follow-up: persist the user's opt-in decision to engine_meta.
// Only sent after permission probe so the engine flag mirrors actual capability.
ipcMain.handle('onboarding:set-notifications-opt-in', async (_e, enabled) => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  return await new Promise((resolve) => {
    const body = JSON.stringify({ enabled: !!enabled });
    const req = http.request({
      host: '127.0.0.1',
      port: enginePort,
      path: '/api/wizard/notifications-opt-in',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5_000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          resolve(res.statusCode === 200 && parsed.ok ? { ok: true } : { ok: false, error: parsed.error || `http ${res.statusCode}` });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
});

// ── Wizard Stage 10: Memory Import ──────────────────────────────
// Opens the native folder picker, walks/imports through the engine
// HTTP API, and forwards NDJSON progress lines to the wizard window
// as `wizard:import-progress` events. Also relays the post-import
// reflection trigger and Stage 11 Soul Core APIs.
ipcMain.handle('wizard:open-import-picker', async () => {
  const target = wizardWindow && !wizardWindow.isDestroyed() ? wizardWindow : null;
  try {
    const result = await dialog.showOpenDialog(target || undefined, {
      title: 'Choose a folder of memory notes (.md / .txt)',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, folder: result.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// P36: multi-file picker. Sibling to open-import-picker; the renderer chooses
// folder OR files (mutex). Drag-drop in the wizard window resolves File →
// absolute path via `webUtils.getPathForFile` in preload.js, so we never need
// a separate IPC for dropped files.
ipcMain.handle('wizard:open-import-files', async () => {
  const target = wizardWindow && !wizardWindow.isDestroyed() ? wizardWindow : null;
  try {
    const result = await dialog.showOpenDialog(target || undefined, {
      title: 'Choose memory notes (.md / .txt / .docx)',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Notes', extensions: ['md', 'txt', 'docx'] }],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, files: result.filePaths };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function postEngineJson(reqPath, payload, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    if (!engineReady) { resolve({ ok: false, error: 'engine not ready' }); return; }
    const body = JSON.stringify(payload || {});
    const req = http.request({
      host: '127.0.0.1',
      port: enginePort,
      path: reqPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
            resolve({ ok: true, ...parsed });
          } else {
            resolve({ ok: false, error: parsed.error || `http ${res.statusCode}`, ...parsed });
          }
        } catch (e) {
          resolve({ ok: false, error: `parse error: ${e.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'engine request timeout' }); });
    req.write(body);
    req.end();
  });
}

ipcMain.handle('wizard:import-preview', async (_evt, opts) => {
  return postEngineJson('/api/wizard/import/preview', {
    folder: opts?.folder || '',
    files: Array.isArray(opts?.files) ? opts.files : null,
    route: opts?.route === 'B' ? 'B' : 'A',
  }, 60_000);
});

ipcMain.handle('wizard:import-run', async (_evt, opts) => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  const folder = String(opts?.folder || '').trim();
  const files = Array.isArray(opts?.files) ? opts.files.filter((p) => typeof p === 'string' && p.trim()) : null;
  const route = opts?.route === 'B' ? 'B' : 'A';
  const batchId = String(opts?.batch_id || '').trim() || `import-${Date.now()}`;
  if (!folder && !(files && files.length)) return { ok: false, error: 'folder_or_files_required' };
  const target = wizardWindow && !wizardWindow.isDestroyed() ? wizardWindow : null;
  const send = (payload) => {
    if (target && !target.isDestroyed()) {
      try { target.webContents.send('wizard:import-progress', payload); } catch {}
    }
  };

  return await new Promise((resolve) => {
    const body = JSON.stringify({ folder, files, route, batch_id: batchId });
    const req = http.request({
      host: '127.0.0.1',
      port: enginePort,
      path: '/api/wizard/import/run',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 0,
    }, (res) => {
      // P1 NDJSON parser — accumulate partial chunks across packet boundaries
      let buffered = '';
      let final = null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffered += chunk;
        let idx;
        while ((idx = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, idx).trim();
          buffered = buffered.slice(idx + 1);
          if (!line) continue;
          let parsed;
          try { parsed = JSON.parse(line); }
          catch { send({ type: 'parse_error', raw: line.slice(0, 200) }); continue; }
          send(parsed);
          if (parsed && parsed.type === 'done') final = parsed;
          if (parsed && parsed.type === 'error') final = { ok: false, ...parsed };
        }
      });
      res.on('end', () => {
        if (buffered.trim()) {
          try {
            const parsed = JSON.parse(buffered.trim());
            send(parsed);
            if (parsed.type === 'done') final = parsed;
          } catch {}
        }
        if (final && final.type === 'done') {
          resolve({ ok: true, ...final });
        } else if (final) {
          resolve({ ok: false, ...final });
        } else {
          resolve({ ok: false, error: 'stream_ended_without_done' });
        }
      });
      res.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
});

ipcMain.handle('wizard:import-reflection', async (_evt, opts) => {
  return postEngineJson('/api/wizard/import/reflection', {
    batch_id: opts?.batch_id || '',
  }, 30_000);
});

ipcMain.handle('wizard:soul-core-draft', async (_evt, opts) => {
  return postEngineJson('/api/wizard/soul-core/draft', {
    batch_id: opts?.batch_id || '',
  }, 60_000);
});

ipcMain.handle('wizard:soul-core-save', async (_evt, opts) => {
  return postEngineJson('/api/wizard/soul-core/save', {
    batch_id: opts?.batch_id || '',
    segments: opts?.segments || {},
  }, 30_000);
});

// Stage 9: Get Telegram link code from engine
ipcMain.handle('onboarding:get-telegram-link-code', async () => {
  if (!engineReady) return { ok: false, error: 'engine not ready' };
  return await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: enginePort,
      path: '/api/telegram/link-code',
      method: 'GET',
      timeout: 10_000,
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try {
          const parsed = buf ? JSON.parse(buf) : {};
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
            resolve({ ok: true, ...parsed });
          } else {
            resolve({ ok: false, error: parsed.error || `http ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ ok: false, error: `parse error: ${e.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'engine request timeout' }); });
    req.end();
  });
});

// Stage 9 self-host BotFather flow: validate token, harvest chat_id, persist .env
ipcMain.handle('onboarding:telegram-test-token', async (_evt, opts) => {
  return postEngineJson('/api/onboarding/telegram/test-token', { token: opts?.token || '' }, 15_000);
});
ipcMain.handle('onboarding:telegram-fetch-chatid', async (_evt, opts) => {
  return postEngineJson('/api/onboarding/telegram/fetch-chatid', { token: opts?.token || '' }, 15_000);
});
ipcMain.handle('onboarding:telegram-save', async (_evt, opts) => {
  return postEngineJson('/api/onboarding/telegram/save', {
    token: opts?.token || '',
    chatId: opts?.chatId || '',
  }, 20_000);
});

// Retry: same as advance-to-engine, but only valid when engine isn't running.
ipcMain.handle('onboarding:engine-retry', async () => {
  if (engineChild) {
    // Stale child from a previous attempt; clean up before retry.
    try { engineChild.kill('SIGTERM'); } catch {}
    // Wait briefly for exit handler to clear engineChild.
    const deadline = Date.now() + 3000;
    while (engineChild && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (engineChild) return { ok: false, error: 'previous engine process did not exit; please relaunch the app' };
  }
  return { ok: true };
});

// Open the rolling log buffer in the OS default viewer.
ipcMain.handle('onboarding:open-engine-logs', async () => {
  try {
    const tmpDir = app.getPath('temp');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(tmpDir, `constellation-engine-${stamp}.log`);
    const body = logBuffer.map(e => `[${new Date(e.ts).toISOString()}] ${e.line}`).join('\n');
    fs.writeFileSync(logFile, body || '(no log lines captured yet)', 'utf-8');
    await shell.openPath(logFile);
    return { ok: true, path: logFile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Issue tracker.
ipcMain.handle('onboarding:report-issue', () => {
  shell.openExternal('https://github.com/CONSTELLATION-ENGINE/constellation-engine/issues/new');
  return { ok: true };
});

// Splash escape hatch: stop engine, delete BOTH sentinels, relaunch.
// Used when the splash boot path wedges (port stuck, engine crash loop,
// stale sentinel after corrupted install) and the user can't reach the
// wizard or library to reset from there. Typed .env / roles stay on disk —
// only the sentinels are cleared, so the wizard re-opens but API keys are
// preserved. Confirmation UI lives in splash.html.
ipcMain.handle('splash:reset-setup', async () => {
  try {
    if (engineChild) {
      try { engineChild.send({ type: 'shutdown' }); } catch {}
      const deadline = Date.now() + 3000;
      while (engineChild && engineChild.exitCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (engineChild && engineChild.exitCode === null) {
        try { engineChild.kill('SIGKILL'); } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
    }
    try { fs.unlinkSync(path.join(ENGINE_DIR, 'data', '.first-run-complete')); } catch {}
    try { sentinel.clearOnboardingComplete?.(); } catch {}
    // Belt-and-suspenders: delete launcher sentinel directly even if the
    // helper isn't exported (older builds). Path must match the sentinel
    // module's resolved location (ENGINE_DIR/data/.onboarding-complete) —
    // an earlier version targeted userData/.onboarding-complete which never
    // existed, so reset-setup was a silent no-op.
    try {
      const launcherSentinel = path.join(ENGINE_DIR, 'data', '.onboarding-complete');
      fs.unlinkSync(launcherSentinel);
    } catch {}
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Reset = stop engine + relaunch app. Sentinel isn't written until Stage 10,
// so no sentinel deletion is needed during Stage 4 reset. Typed .env / roles
// stay on disk so the user doesn't have to retype an API key.
ipcMain.handle('onboarding:engine-reset', async () => {
  try {
    if (engineChild) {
      // Graceful shutdown first (engine WAL checkpoints, saves Mímir).
      try { engineChild.send({ type: 'shutdown' }); } catch {}
      const deadline = Date.now() + SHUTDOWN_GRACE;
      while (engineChild && engineChild.exitCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      // Escalate to SIGTERM, then SIGKILL — must release the port before
      // relaunch, otherwise the new launcher's port probe fails immediately.
      if (engineChild && engineChild.exitCode === null) {
        try { engineChild.kill('SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (engineChild && engineChild.exitCode === null) {
        try { engineChild.kill('SIGKILL'); } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
    }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── Path resolution + first-run engine extraction ───────────────────
//
// In packaged mode the AppImage/dmg ships the engine source + node_modules
// under <resources>/engine (read-only squashfs on Linux). The engine assumes a
// writable engine root (writes conversations.db, data/logs/, etc. via paths
// resolved against __dirname/..). On first launch we copy the bundled engine
// into <user>/engine so the runtime has a writable home.
//
// Re-extract triggers when the bundle's package.json version changes — keeps
// data/, downloaded models, .env, tasks.json untouched (those aren't in the
// bundle filter).
async function initPaths() {
  if (app.isPackaged) {
    // 'userData' resolves to <APPDATA>/<productName>. Top-level productName
    // in package.json is "Constellation" so this matches the NSIS uninstall
    // hook ($APPDATA\Constellation). Without top-level productName, Electron
    // falls back to `name` and userData ends up under \constellation-launcher,
    // which the uninstaller then can't see — leaving the sentinel behind and
    // skipping the wizard on every reinstall.
    const userData = app.getPath('userData');
    ENGINE_DIR = path.join(userData, 'engine');
    const templateDir = path.join(process.resourcesPath, 'engine');
    await ensureEngineExtracted(templateDir, ENGINE_DIR);
  } else {
    ENGINE_DIR = path.resolve(__dirname, '..');
  }
  ENGINE_ENTRY = path.join(ENGINE_DIR, 'src', 'main.js');
  PID_FILE = path.join(ENGINE_DIR, 'data', '.engine.pid');
  mimirRuntimeFile = path.join(ENGINE_DIR, '.mimir-runtime.json');
  ensureInstallId();
  sentinel.setRoot(ENGINE_DIR);
}

let extractSplash = null;
function showExtractSplash() {
  extractSplash = new BrowserWindow({
    width: 480, height: 220,
    frame: false, resizable: false, alwaysOnTop: true,
    backgroundColor: '#0b0e1a',
    icon: CE_APP_ICON,
    webPreferences: { contextIsolation: true },
  });
  // Inline HTML — avoids depending on the to-be-copied views/ tree.
  const html = encodeURIComponent(
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:36px;font:14px -apple-system,system-ui,sans-serif;' +
    'color:#cfd6e4;background:#0b0e1a;text-align:center}' +
    'h1{font-size:18px;margin:0 0 12px;color:#e6ecf5;font-weight:500}' +
    'p{margin:0 0 18px;color:#8b94a8}' +
    '.bar{height:3px;background:#1a2238;border-radius:2px;overflow:hidden}' +
    '.bar>div{height:100%;width:30%;background:linear-gradient(90deg,#4a7bc8,#8b6fc8);' +
    'animation:slide 1.4s ease-in-out infinite}' +
    '@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(380%)}}' +
    '</style></head><body><h1>Setting up Constellation</h1>' +
    '<p>First-run install — extracting engine components.</p>' +
    '<div class="bar"><div></div></div></body></html>'
  );
  extractSplash.loadURL('data:text/html;charset=utf-8,' + html);
}
function closeExtractSplash() {
  if (extractSplash && !extractSplash.isDestroyed()) {
    extractSplash.close();
  }
  extractSplash = null;
}

async function ensureEngineExtracted(templateDir, targetDir) {
  let bundleVersion = '0';
  try {
    const tplPkg = JSON.parse(
      fs.readFileSync(path.join(templateDir, 'package.json'), 'utf-8')
    );
    bundleVersion = String(tplPkg.version || '0');
  } catch {}

  const versionFile = path.join(targetDir, '.bundle-version');
  let installedVersion = null;
  try { installedVersion = fs.readFileSync(versionFile, 'utf-8').trim(); } catch {}

  const entryExists = fs.existsSync(path.join(targetDir, 'src', 'main.js'));
  if (installedVersion !== bundleVersion || !entryExists) {
    showExtractSplash();
    try {
      await fsp.mkdir(targetDir, { recursive: true });
      // recursive copy preserves file modes (vec0.so executable bit, etc.).
      // force:true overwrites stale source on version bump; data/ stays
      // untouched because it isn't in the source tree.
      await fsp.cp(templateDir, targetDir, { recursive: true, force: true });
      await fsp.writeFile(versionFile, bundleVersion, 'utf-8');
    } finally {
      closeExtractSplash();
    }
  }
  await scaffoldRuntimeDirs(targetDir);
}

// Runtime-only dirs/files the engine reads at boot but the bundle doesn't
// ship: identity/, engine-inbox/uploads/, library/, plus tasks.json +
// COGNITIVE_STATE.md placeholders. Idempotent — never overwrites existing
// content, only creates what's missing. Runs every launch (cheap).
async function scaffoldRuntimeDirs(targetDir) {
  const dirs = [
    'identity',
    'engine-inbox',
    'engine-inbox/uploads',
    'engine-inbox/uploads/images',
    'library',
    'data',
    'data/logs',
    'data/logs/ir-pool',
    'data/compiler-training',
  ];
  for (const d of dirs) {
    try { await fsp.mkdir(path.join(targetDir, d), { recursive: true }); } catch {}
  }
  const tasksFile = path.join(targetDir, 'identity', 'tasks.json');
  try {
    await fsp.access(tasksFile);
  } catch {
    try { await fsp.writeFile(tasksFile, '{"tasks":[]}\n', 'utf-8'); } catch {}
  }
  const cogStateFile = path.join(targetDir, 'identity', 'COGNITIVE_STATE.md');
  try {
    await fsp.access(cogStateFile);
  } catch {
    try { await fsp.writeFile(cogStateFile, '', 'utf-8'); } catch {}
  }
}

// ─── Boot sequence ────────────────────────────────────────────────────
// While true, window-all-closed is suppressed. First-run extraction shows a
// transient splash that closes before the next window opens; without this
// guard the empty-window moment fires window-all-closed → app.quit() and the
// launcher exits before the wizard ever appears.
let bootInProgress = true;

async function boot() {
  await initPaths();

  // Prime the boot log file so the sentinel diag block (and every captureLog
  // afterwards) lands on disk under userData/logs/launcher-boot.log. Without
  // this the file is only created the first time captureLog runs *after* app
  // is ready — which is fine, but priming here makes the truncation deterministic.
  ensureBootLogPath();

  // Right-click Cut/Copy/Paste/Select All on every input/textarea across all
  // launcher windows (wizard, library, permission disclosure). Hooks into
  // BrowserWindow construction globally — must run before any window opens.
  // electron-context-menu@4 is ESM-only; load via dynamic import.
  try {
    const { default: contextMenu } = await import('electron-context-menu');
    contextMenu({
      showSelectAll: true,
      showCopyImage: false,
      showInspectElement: false,
      showSearchWithGoogle: false,
    });
  } catch (err) {
    captureLog(`[launcher] context-menu init failed: ${err.message}`);
  }

  // Phase 1: config-inconsistent fail-fast (per Planning §23.4)
  if (sentinel.isConfigInconsistent()) {
    createSplash();
    if (splashWindow) {
      splashWindow.webContents.send('splash:error',
        'Configuration inconsistency detected. Run `npm run doctor` from the repo root to repair, then relaunch.');
    }
    return;
  }

  // Phase 2: first-run routing
  // Sentinel = boot-time fast-path. Missing sentinel → load wizard, not engine.
  // (Engine-side reconciliation with onboarding_progress SQL table is Day 4 work.)

  // Diagnostic: surface the exact paths + state we're routing on so users who
  // hit "wizard skipped on fresh install" can read the launcher log and tell
  // us which sentinel survived. Writes app version, sentinel path, exists?,
  // recorded version, engine sentinel + config.json fingerprints. One block
  // per boot.
  try {
    const sp = sentinel.SENTINEL_PATH;
    const launcherExists = sentinel.isOnboardingComplete();
    const recordedVer = launcherExists ? sentinel.getCompletedVersion() : null;
    const engineSp = path.join(ENGINE_DIR, 'data', '.first-run-complete');
    const cfgSp = path.join(ENGINE_DIR, 'config.json');
    const engineExists = fs.existsSync(engineSp);
    let cfgHasSetupMeta = false;
    if (fs.existsSync(cfgSp)) {
      try {
        const c = JSON.parse(fs.readFileSync(cfgSp, 'utf-8'));
        cfgHasSetupMeta = !!(c && c._setupMeta && typeof c._setupMeta.completedAt === 'string' && c._setupMeta.completedAt.length > 0);
      } catch {}
    }
    captureLog(`[launcher] sentinel diag: appVersion=${app.getVersion()} engineDir=${ENGINE_DIR}`);
    captureLog(`[launcher] sentinel diag: launcherSentinel=${sp} exists=${launcherExists} recordedVersion=${recordedVer || 'null'}`);
    captureLog(`[launcher] sentinel diag: engineSentinel=${engineSp} exists=${engineExists} configSetupMeta=${cfgHasSetupMeta}`);
  } catch (err) {
    captureLog(`[launcher] sentinel diag failed: ${err.message}`);
  }

  // Backfill: pre-fix installs only wrote engine's .first-run-complete, never
  // the launcher's .onboarding-complete. If engine sentinel says setup finished
  // but launcher sentinel is missing, treat that as proof and write it now —
  // otherwise every existing user gets re-prompted from Stage 1 on relaunch.
  //
  // Sanity-gate: a bare .first-run-complete is NOT enough on its own — early
  // OSS builds touched it from non-wizard codepaths, and a stray sentinel
  // would skip the wizard on a fresh install with no LLM config saved (user
  // lands on a dashboard pointed at no provider). Require config.json to
  // also carry _setupMeta.completedAt — that field is only written by
  // llmConfig.saveConfig() at the wizard's Stage-4 success path.
  if (!sentinel.isOnboardingComplete()) {
    const engineSentinel = path.join(ENGINE_DIR, 'data', '.first-run-complete');
    const cfgPath = path.join(ENGINE_DIR, 'config.json');
    let wizardConfirmed = false;
    if (fs.existsSync(engineSentinel) && fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        if (cfg && cfg._setupMeta && typeof cfg._setupMeta.completedAt === 'string'
            && cfg._setupMeta.completedAt.length > 0) {
          wizardConfirmed = true;
        }
      } catch (err) {
        captureLog(`[launcher] config.json parse failed during backfill check: ${err.message}`);
      }
    }
    if (wizardConfirmed) {
      try {
        // Stamp backfilled sentinels with a placeholder version (NOT the
        // current app version) so the install/upgrade gate below detects
        // them as "pre-version-gate completion" and re-launches the wizard
        // with a Skip button. Writing the current version here would silently
        // mark every legacy install as "already on this version" and skip
        // the wizard for users who never saw it on this build.
        sentinel.writeOnboardingComplete({ source: 'engine-sentinel-backfill', app_version: '0.0.0-prebackfill' });
        captureLog('[launcher] backfilled .onboarding-complete from .first-run-complete + config.json _setupMeta (marked prebackfill)');
      } catch (err) {
        captureLog(`[launcher] sentinel backfill failed: ${err.message}`);
      }
    } else if (fs.existsSync(engineSentinel)) {
      captureLog('[launcher] engine sentinel found but config.json _setupMeta missing — forcing wizard');
    }
  }

  if (!sentinel.isOnboardingComplete()) {
    captureLog('[launcher] no sentinel found — launching onboarding wizard');
    createWizard();
    return;
  }

  // Install/upgrade gate: every release bumps package.json.version, and we
  // record that into the sentinel at completion. If the running app's version
  // doesn't match what the sentinel was last written with, treat this as a
  // fresh install/upgrade and re-launch the wizard. Returning users see a
  // "Skip — keep my data" button (rendered when ?versionMigrating=1 query is
  // present) so they don't have to redo Stage 4 LLM config. Cache-clearing
  // tricks can't bypass this — the comparison is between two on-disk facts
  // (app.getVersion from the bundled package.json vs. sentinel JSON).
  {
    const recordedVersion = sentinel.getCompletedVersion();
    const currentVersion = app.getVersion();
    if (recordedVersion !== currentVersion) {
      captureLog(`[launcher] install/upgrade detected (sentinel=${recordedVersion || 'null'}, app=${currentVersion}) — re-launching wizard with skip option`);
      createWizard({ versionMigrating: true });
      return;
    }
  }

  // Phase 3: returning-user fast path
  captureLog(`[launcher] sentinel + version matched (app=${app.getVersion()}) — fast-path to dashboard`);
  createSplash();

  // Walk forward from DEFAULT_PORT for up to 10 ports — old engine instances,
  // dev servers, etc. shouldn't hard-block a relaunch.
  let chosenPort = null;
  for (let i = 0; i < 10; i++) {
    const candidate = DEFAULT_PORT + i;
    const probe = await probePort(candidate);
    if (probe.ok) { chosenPort = candidate; break; }
    captureLog(`[launcher] port ${candidate} busy (${probe.code})`);
  }
  if (chosenPort === null) {
    if (splashWindow) splashWindow.webContents.send('splash:error',
      `Ports ${DEFAULT_PORT}–${DEFAULT_PORT + 9} all in use. Close another instance or set CONSTELLATION_PORT.`);
    return;
  }
  if (chosenPort !== DEFAULT_PORT) {
    captureLog(`[launcher] DEFAULT_PORT busy, using ${chosenPort} instead`);
  }
  enginePort = chosenPort;

  try {
    await spawnEngine(enginePort);
    await pollStatus(enginePort, Date.now() + READY_TIMEOUT);
    captureLog('[launcher] engine ready, opening main window');
  } catch (err) {
    captureLog(`[launcher] engine failed to become ready: ${err.message}`);
    if (splashWindow) splashWindow.webContents.send('splash:error', err.message);
    return;
  }

  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }
  // Stage 4.5 (Batch E) — first-launch-after-update path: existing users with
  // a valid onboarding sentinel but no permission ack see the disclosure once.
  if (isPermissionAcknowledged()) {
    createMainWindow(enginePort);
  } else {
    captureLog('[launcher] permission ack missing — showing disclosure before dashboard');
    createPermissionWindow(() => createMainWindow(enginePort));
  }

  // Auto-update: launch in the background once dashboard has been requested.
  // No-ops in dev (app.isPackaged guard inside).
  setupAutoUpdater();
}

// ─── Auto-update (electron-updater + GitHub Releases) ──────────────────
// One-click in-place upgrade. autoDownload=true so a fresh build lands in
// background; install is gated on a user click in the dashboard banner or the
// Settings tab, which then quits & relaunches into the new version.
//
// Guarded by app.isPackaged — dev runs (`npm start`) skip the updater entirely.
// GitHub Releases is the publish channel; repo handle comes from env GH_REPO
// (default CONSTELLATION-ENGINE/constellation-engine) so users on a fork can repoint
// without rebuilding. Single `latest` channel, no separate beta/insider.
//
// Unsigned binaries: SmartScreen / Gatekeeper warnings are skippable on first
// launch but the updater itself doesn't gate on signing — verified by
// electron-updater's release notes for v6.x. We accept the warning trade-off
// to avoid the certificate cost for v0.1.0.
let autoUpdater = null;
let updateInitialCheckTimer = null;
let updatePeriodicTimer = null;
let updateState = {
  status: 'idle',           // idle | checking | available | not-available | downloading | downloaded | error
  version: null,            // version string of the new release (when available/downloaded)
  progress: null,           // {percent, transferred, total, bytesPerSecond}
  error: null,              // last error message
  releaseNotes: null,       // string or null
  lastCheckedAt: null,      // ms
};

function pushUpdateState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:state', updateState);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    captureLog('[updater] dev mode — auto-updater disabled');
    return;
  }
  if (autoUpdater) {
    // Already initialized — boot() may have run twice (dashboard re-open after
    // permission disclosure cancel + retry). Don't double-stack timers/handlers.
    return;
  }
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    captureLog(`[updater] electron-updater not loadable: ${e.message}`);
    return;
  }

  // Repo override — env beats the build-time publish config so a fork can
  // point at its own releases without re-bundling. Malformed env (no slash)
  // falls back to the build-time publish block instead of throwing.
  const repo = process.env.GH_REPO || 'CONSTELLATION-ENGINE/constellation-engine';
  const [owner, name] = repo.split('/');
  if (owner && name) {
    try {
      autoUpdater.setFeedURL({ provider: 'github', owner, repo: name });
    } catch (e) {
      captureLog(`[updater] setFeedURL failed: ${e.message}`);
    }
  } else {
    captureLog(`[updater] GH_REPO="${repo}" malformed — using build-time publish config`);
  }

  // Logging — pipe updater chatter into the launcher buffer so /diagnostics
  // captures it alongside engine logs.
  autoUpdater.logger = {
    info: (m) => captureLog(`[updater] ${m}`),
    warn: (m) => captureLog(`[updater:warn] ${m}`),
    error: (m) => captureLog(`[updater:error] ${m}`),
    debug: () => {},
  };

  autoUpdater.autoDownload = true;       // start the download as soon as a check finds one
  autoUpdater.autoInstallOnAppQuit = false;  // gate install on explicit user click; never silent on quit

  autoUpdater.on('checking-for-update', () => {
    updateState = { ...updateState, status: 'checking', error: null, lastCheckedAt: Date.now() };
    pushUpdateState();
  });
  autoUpdater.on('update-available', (info) => {
    updateState = {
      ...updateState,
      status: 'available',
      version: info?.version || null,
      releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : null,
      error: null,
    };
    pushUpdateState();
  });
  autoUpdater.on('update-not-available', (info) => {
    updateState = {
      ...updateState,
      status: 'not-available',
      version: info?.version || null,
      error: null,
    };
    pushUpdateState();
  });
  autoUpdater.on('download-progress', (p) => {
    updateState = {
      ...updateState,
      status: 'downloading',
      progress: {
        percent: Math.round(p?.percent || 0),
        transferred: p?.transferred || 0,
        total: p?.total || 0,
        bytesPerSecond: p?.bytesPerSecond || 0,
      },
    };
    pushUpdateState();
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = {
      ...updateState,
      status: 'downloaded',
      version: info?.version || updateState.version,
      progress: { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
    };
    pushUpdateState();
  });
  autoUpdater.on('error', (err) => {
    updateState = { ...updateState, status: 'error', error: err?.message || String(err) };
    pushUpdateState();
  });

  // First check: 30s after dashboard opens (give the engine + dashboard a
  // beat to settle before we start GitHub HTTP traffic). Then every 4h.
  // Timer handles stashed module-side so a stray re-init can't double-fire.
  updateInitialCheckTimer = setTimeout(() => {
    try { autoUpdater.checkForUpdates(); }
    catch (e) { captureLog(`[updater] initial check failed: ${e.message}`); }
  }, 30_000);
  updatePeriodicTimer = setInterval(() => {
    try { autoUpdater.checkForUpdates(); }
    catch (e) { captureLog(`[updater] periodic check failed: ${e.message}`); }
  }, 4 * 60 * 60 * 1000);
}

ipcMain.handle('update:get-state', () => updateState);

ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Updates disabled in development.' };
  if (!autoUpdater) return { ok: false, error: 'Auto-updater not initialized.' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version || null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('update:install', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Updates disabled in development.' };
  if (!autoUpdater) return { ok: false, error: 'Auto-updater not initialized.' };
  if (updateState.status !== 'downloaded') return { ok: false, error: `No update ready (status=${updateState.status}).` };
  // quitAndInstall fires shutdown → app.quit → installer relaunches us. We
  // proactively shut the engine down first so the upgrade isn't racing a
  // child process that holds DB locks.
  userInitiatedStop = true;
  try { await shutdownEngine(); } catch {}
  try { await shutdownMimir(); } catch {}
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(false, true); }
    catch (e) { captureLog(`[updater] quitAndInstall failed: ${e.message}`); }
  });
  return { ok: true };
});

// ─── Graceful shutdown ────────────────────────────────────────────────
async function shutdownEngine() {
  if (!engineChild || engineChild.exitCode !== null) return;

  captureLog('[launcher] sending IPC shutdown to engine...');
  try { engineChild.send({ type: 'shutdown' }); } catch {}

  const deadline = Date.now() + SHUTDOWN_GRACE;
  while (engineChild && engineChild.exitCode === null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }

  if (engineChild && engineChild.exitCode === null) {
    captureLog('[launcher] engine did not exit in 8s; escalating via tree-kill');
    try {
      const treeKill = require('tree-kill');
      treeKill(engineChild.pid, 'SIGTERM');
    } catch (e) {
      captureLog(`[launcher] tree-kill failed: ${e.message}; falling back to child.kill()`);
      try { engineChild.kill('SIGTERM'); } catch {}
    }
  }
}

process.on('uncaughtException', (err) => {
  try { captureLog(`[launcher] uncaughtException: ${err && err.stack || err}`); } catch {}
  try {
    dialog.showErrorBox(
      'Constellation encountered an unexpected error',
      `${err && err.message || err}\n\nLog file may be in: ${app.getPath('userData')}`
    );
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try { captureLog(`[launcher] unhandledRejection: ${reason && reason.stack || reason}`); } catch {}
});

app.whenReady()
  .then(boot)
  .catch((err) => {
    captureLog(`[launcher] boot failed: ${err && err.stack || err}`);
    try {
      dialog.showErrorBox(
        'Constellation failed to start',
        `${err && err.message || err}\n\nLog file may be in: ${app.getPath('userData')}`
      );
    } catch {}
    app.quit();
  })
  .finally(() => { bootInProgress = false; });

app.on('window-all-closed', async () => {
  if (bootInProgress) return;
  await shutdownEngine();
  await shutdownMimir();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if ((engineChild && engineChild.exitCode === null) ||
      (mimirChild && mimirChild.exitCode === null)) {
    event.preventDefault();
    await shutdownEngine();
    await shutdownMimir();
    app.quit();
  }
});
