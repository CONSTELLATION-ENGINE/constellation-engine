// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module logger
 * @description Central structured logger for Constellation Engine.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log.info('cron', 'Task started', { taskName: 'daily-diary' });
 *   log.error('telegram', 'Send failed', { chatId, err: e.message });
 *
 * Output:
 *   - stdout: human-readable with emoji severity prefix
 *   - logs/engine.jsonl: JSON Lines for machine parsing / tracing
 *
 * Log rotation: engine.jsonl rotated at 50 MB, keeps last 7 rotated files.
 */

import { appendFileSync, readFileSync, statSync, renameSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const LOG_DIR = join(PROJECT_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'engine.jsonl');

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_ROTATED = 7;
const CHECK_INTERVAL = 100; // check file size every N writes

// Ensure logs/ exists
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const LEVELS = /** @type {const} */ ({ debug: 0, info: 1, warn: 2, error: 3, fatal: 4 });
const PREFIXES = { debug: '🔍', info: '  ', warn: '⚠', error: '❌', fatal: '🔴' };

let minLevel = LEVELS.info;
let writeCount = 0;
let lastSize = 0;

/**
 * Set minimum log level.
 * @param {'debug'|'info'|'warn'|'error'|'fatal'} level
 */
export function setLevel(level) {
  if (level in LEVELS) minLevel = LEVELS[level];
}

/** Rotate log file if it exceeds MAX_SIZE. */
function maybeRotate() {
  writeCount++;
  if (writeCount % CHECK_INTERVAL !== 0) return;
  try {
    lastSize = statSync(LOG_FILE).size;
  } catch { lastSize = 0; }
  if (lastSize < MAX_SIZE) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rotated = join(LOG_DIR, `engine.${ts}.jsonl`);
  try { renameSync(LOG_FILE, rotated); } catch {}
  pruneOldLogs();
}

/** Remove rotated logs beyond MAX_ROTATED. */
function pruneOldLogs() {
  try {
    const files = readdirSync(LOG_DIR)
      .filter(f => f.startsWith('engine.') && f.endsWith('.jsonl') && f !== 'engine.jsonl')
      .sort()
      .reverse();
    for (const f of files.slice(MAX_ROTATED)) {
      try { unlinkSync(join(LOG_DIR, f)); } catch {}
    }
  } catch {}
}

/**
 * Write a structured log entry.
 * @param {'debug'|'info'|'warn'|'error'|'fatal'} level
 * @param {string} component
 * @param {string} msg
 * @param {Object} [data]
 */
function write(level, component, msg, data) {
  if (LEVELS[level] < minLevel) return;

  const ts = new Date().toISOString();
  const entry = { ts, level, component, msg, ...data };

  // JSON Lines file output
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    maybeRotate();
  } catch {}

  // Console output (human-readable)
  const prefix = PREFIXES[level] || '  ';
  const extra = data ? ` ${JSON.stringify(data)}` : '';
  const line = `${prefix} [${component}] ${msg}${extra}`;

  if (level === 'error' || level === 'fatal') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** @type {Record<string, (component: string, msg: string, data?: Object) => void>} */
export const log = {
  debug: (component, msg, data) => write('debug', component, msg, data),
  info:  (component, msg, data) => write('info', component, msg, data),
  warn:  (component, msg, data) => write('warn', component, msg, data),
  error: (component, msg, data) => write('error', component, msg, data),
  fatal: (component, msg, data) => write('fatal', component, msg, data),
  setLevel,
};

// Prune old logs on import
pruneOldLogs();

/**
 * Read recent log entries from engine.jsonl.
 *
 * `ownerId` filters to entries where either `owner_id` or `ownerId` in the
 * payload matches. Entries without either field pass through — most
 * infrastructure logs (boot, snapshot, rotation) aren't owner-scoped and
 * should still show up for the owner viewing the dashboard.
 *
 * @param {{ component?: string, level?: string, limit?: number, ownerId?: string }} opts
 * @returns {Object[]}
 */
export function readRecentLogs({ component, level, limit = 50, ownerId } = {}) {
  try {
    const raw = readFileSync(LOG_FILE, 'utf-8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    let entries = lines
      .slice(-limit * 3)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (component) entries = entries.filter(e => e.component === component);
    if (level) {
      const minLvl = LEVELS[level] ?? 0;
      entries = entries.filter(e => (LEVELS[e.level] ?? 0) >= minLvl);
    }
    if (ownerId) {
      entries = entries.filter(e => {
        const eo = e.owner_id ?? e.ownerId;
        return eo === undefined || eo === null || eo === ownerId;
      });
    }
    return entries.slice(-limit);
  } catch { return []; }
}
