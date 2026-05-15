// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module pulse-handlers
 * @description Ratatoskr L0 pulse-hint writers for TASK_TOUCH and COGNITIVE_TOUCH.
 *
 *   TASK_TOUCH      — flips status / appends note in identity/tasks.json (atomic).
 *   COGNITIVE_TOUCH — appends a single line to identity/cognitive-buffer.txt
 *                     via pulse-buffer ring writer (40 lines / 4096 bytes cap).
 *
 * Both kinds also append an audit row to constellation.db pulse_hint_log so the
 * Anamnesis layer can elide redundant proposals and the Dashboard can surface
 * a recent-pulse feed.
 *
 * All writes are best-effort and silent on no-op (missing task id, etc.).
 */

import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRingBuffer } from './pulse-buffer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = resolve(__dirname, '..', 'identity');
const TASKS_PATH = resolve(IDENTITY_DIR, 'tasks.json');
const COGNITIVE_BUFFER_PATH = resolve(IDENTITY_DIR, 'cognitive-buffer.txt');
const TASKS_BACKUP_SUFFIX = '.bak';

const TASK_TOUCH_OWNER = 'self';                 // tasks.json is whole-engine state
const COGNITIVE_TOUCH_OWNER = 'self';            // cognitive buffer is whole-engine state
const ALLOWED_STATUS = new Set(['pending','in_progress','code-done','completed','blocked','suspended']);
const TASK_NOTES_MAX_LINES = 20;                 // cap notes history per task to prevent unbounded growth

// ────────────────────────────────────────────────────────────────────────────
// pulse_hint_log audit helper

/**
 * Append a row to constellation.db pulse_hint_log. Best-effort; errors logged
 * but never thrown so the calling pulse-handler stays resilient.
 *
 * @param {object} db - better-sqlite3 handle
 * @param {{kind:string, owner_id?:string, target_kind?:string, target_id?:string, payload?:object, severity?:string, source_hint?:string}} entry
 */
function logPulseHint(db, entry) {
  if (!db || !entry?.kind) return;
  try {
    db.prepare(`
      INSERT INTO pulse_hint_log
        (received_at, kind, source_hint, owner_id, target_kind, target_id, payload, severity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      entry.kind,
      entry.source_hint || 'hint:agent-self',
      entry.owner_id || null,
      entry.target_kind || null,
      entry.target_id || null,
      entry.payload ? JSON.stringify(entry.payload) : null,
      entry.severity || null,
    );
  } catch (e) {
    console.warn(`[pulse-hint] log failed (${entry.kind}): ${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// TASK_TOUCH

/**
 * Apply a batch of TASK_TOUCH hints to identity/tasks.json. Atomic per-batch:
 * one read → one apply → one write (with .bak backup). Each hint may set a
 * status (whitelisted) and append a dated note. Unknown task_ids are dropped
 * with a warning — they'll be picked up by L1/L2 sweeps if real, or were typos.
 *
 * @param {object} engine - ConstellationEngine instance (for db access)
 * @param {Array<{task_id:string, status?:string, note?:string, reason?:string}>} hints
 * @returns {{applied:number, missing:number}}
 */
export function writeTaskTouches(engine, hints) {
  if (!engine?.db || !Array.isArray(hints) || hints.length === 0) {
    return { applied: 0, missing: 0 };
  }

  let raw;
  try { raw = readFileSync(TASKS_PATH, 'utf-8'); }
  catch (e) { console.warn(`[task-touch] read tasks.json failed: ${e.message}`); return { applied: 0, missing: 0 }; }

  let data;
  try { data = JSON.parse(raw); }
  catch (e) { console.warn(`[task-touch] parse tasks.json failed: ${e.message}`); return { applied: 0, missing: 0 }; }

  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const today = new Date().toISOString().slice(0, 10);

  let applied = 0, missing = 0;
  // Track status flips so callers can react (e.g. Sleipnir task_trail drain on
  // in_progress → terminal transitions).
  const flips = [];
  for (const h of hints) {
    const task = taskMap.get(h.task_id);
    if (!task) {
      missing++;
      logPulseHint(engine.db, {
        kind: 'task-touch',
        owner_id: TASK_TOUCH_OWNER,
        target_kind: 'task',
        target_id: h.task_id,
        payload: { ...h, applied: false, reason_skipped: 'task_id_not_found' },
        severity: 'param',
      });
      continue;
    }

    let changed = false;
    const priorStatus = task.status;

    if (h.status && ALLOWED_STATUS.has(h.status) && task.status !== h.status) {
      task.status = h.status;
      changed = true;
      flips.push({ task_id: h.task_id, from: priorStatus, to: h.status, note: h.note || null });
    }
    if (h.note) {
      const noteLine = `[${today}] ${h.note}`;
      const existing = task.notes ? String(task.notes).split('\n') : [];
      existing.push(noteLine);
      // Cap to last N lines to prevent unbounded growth across many touches.
      while (existing.length > TASK_NOTES_MAX_LINES) existing.shift();
      task.notes = existing.join('\n');
      changed = true;
    }
    if (changed) {
      task.updated = today;
      applied++;
    }

    logPulseHint(engine.db, {
      kind: 'task-touch',
      owner_id: TASK_TOUCH_OWNER,
      target_kind: 'task',
      target_id: h.task_id,
      payload: { ...h, applied: changed },
      severity: 'param',
    });
  }

  if (applied > 0) {
    // Refresh metadata, atomic write (.bak then writeFile)
    const statusCounts = {};
    for (const t of tasks) statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    data._updated = new Date().toISOString();
    data._task_summary = Object.entries(statusCounts).map(([s,c]) => `${c}_${s}`).join('_');

    try {
      if (existsSync(TASKS_PATH)) copyFileSync(TASKS_PATH, TASKS_PATH + TASKS_BACKUP_SUFFIX);
    } catch { /* backup best-effort */ }
    try {
      // Atomic write: tmp + rename. A crash between tmp write and rename leaves
      // the canonical tasks.json intact; the .bak above is the prior-state safety
      // net. Avoids the corruption window that a direct writeFileSync exposes.
      const tmp = TASKS_PATH + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmp, TASKS_PATH);
    } catch (e) {
      console.warn(`[task-touch] write tasks.json failed: ${e.message}`);
      return { applied: 0, missing, flips: [] };
    }
  }

  return { applied, missing, flips };
}

// ────────────────────────────────────────────────────────────────────────────
// COGNITIVE_TOUCH

/**
 * Append cognitive observations to the bounded ring buffer. Each hint becomes
 * one line: `<HH:MM> [topic?] line`. Buffer is the small companion to the
 * authoritative COGNITIVE_STATE.md — Anamnesis can read it at debrief time
 * to skip re-inferring observations the agent already self-noted.
 *
 * @param {object} engine - ConstellationEngine instance (for db access)
 * @param {Array<{line:string, topic?:string, reason?:string}>} hints
 * @returns {{appended:number, linesKept:number, bytes:number}|{appended:0}}
 */
export function writeCognitiveTouches(engine, hints) {
  if (!engine?.db || !Array.isArray(hints) || hints.length === 0) {
    return { appended: 0 };
  }

  const now = new Date();
  const stamp = now.toISOString().slice(11, 16);   // HH:MM (UTC, deterministic)
  let last = { linesKept: 0, bytes: 0 };
  let appended = 0;

  for (const h of hints) {
    const prefix = h.topic ? `[${String(h.topic).slice(0, 40)}] ` : '';
    const oneLine = `${stamp} ${prefix}${h.line}`;
    try {
      last = appendRingBuffer(COGNITIVE_BUFFER_PATH, oneLine);
      appended++;
      logPulseHint(engine.db, {
        kind: 'cognitive-touch',
        owner_id: COGNITIVE_TOUCH_OWNER,
        target_kind: 'cognitive-buffer',
        target_id: h.topic || null,
        payload: h,
        severity: 'signal',
      });
    } catch (e) {
      console.warn(`[cognitive-touch] append failed: ${e.message}`);
    }
  }
  return { appended, linesKept: last.linesKept, bytes: last.bytes };
}

// ────────────────────────────────────────────────────────────────────────────
// L2 task-completion candidates (implicit, Plan C hybrid — 2026-04-29)
//
// Distinct from TASK_TOUCH (L0 explicit) and Anamnesis tasks_completed (L1
// LLM-driven): these are pattern-extracted hints from natural language.
// They land in pulse_hint_log as kind='task-completion-candidate' awaiting
// either a confirming TASK_TOUCH (next turn, prompted by IR) or quiet
// expiry. Never directly mutate tasks.json — that would short-circuit the
// single-write-path invariant the rest of the L0/L1 plumbing relies on.

const L2_TASK_COMPLETION_OWNER = 'engine-self-knowledge';

/**
 * Append zero-or-more L2 task-completion candidates to pulse_hint_log.
 *
 * @param {object} engine - ConstellationEngine instance (for db access)
 * @param {Array<{phrase:string, lang:string, raw_id_hint:string|null, confidence_pre:number}>} candidates
 *        Output of `extractCompletionCandidates(text)` — caller already gated
 *        on caller_kind ∈ { main, cron } per Planning §3 C2.
 * @param {{source_kind?:'pattern'|'anamnesis-delta', sessionId?:string|null, matchedFn?:Function}} ctx
 *        matchedFn (optional) is the Phase-3 matcher — when present invoked
 *        as `matchedFn(rawIdHint, phrase) → { task_id, score, mode } | null`
 *        and rows whose match is null are dropped to avoid log noise. When
 *        absent (Phase 2 pre-matcher state) all rows are written with
 *        target_id=null to support extractor validation.
 * @returns {{written:number, skipped:number}}
 */
export function writeCompletionCandidates(engine, candidates, ctx = {}) {
  if (!engine?.db || !Array.isArray(candidates) || candidates.length === 0) {
    return { written: 0, skipped: 0 };
  }
  const sourceKind = ctx.source_kind || 'pattern';
  const matchedFn = typeof ctx.matchedFn === 'function' ? ctx.matchedFn : null;

  let written = 0, skipped = 0;
  for (const c of candidates) {
    if (!c || typeof c.phrase !== 'string') { skipped++; continue; }
    let match = null;
    if (matchedFn) {
      try { match = matchedFn(c.raw_id_hint || null, c.phrase) || null; }
      catch (e) { console.warn(`[task-completion-l2] matcher threw: ${e.message}`); match = null; }
      // Phase-3 contract: skip writes when no match — don't pollute log.
      if (!match) { skipped++; continue; }
    }
    // Severity: 'signal' once we have a confident match (≥0.85 or matcher hit
    // with score≥0.7); otherwise 'param' (shadow-only).
    const conf = Number.isFinite(c.confidence_pre) ? c.confidence_pre : 0;
    const matchScore = match?.score || 0;
    const severity = (conf >= 0.85 || matchScore >= 0.7) ? 'signal' : 'param';

    const payload = {
      phrase: c.phrase.slice(0, 200),
      lang: c.lang || 'unknown',
      raw_id_hint: c.raw_id_hint || null,
      confidence: conf,
      source_kind: sourceKind,
      session_id: ctx.sessionId || null,
    };
    if (match) {
      payload.match = { mode: match.mode || null, score: Number((matchScore || 0).toFixed(3)) };
    }
    if (c.conflict_with_explicit) payload.conflict_with_explicit = true;

    logPulseHint(engine.db, {
      kind: 'task-completion-candidate',
      owner_id: L2_TASK_COMPLETION_OWNER,
      target_kind: 'task',
      target_id: match?.task_id || null,
      payload,
      severity,
      source_hint: sourceKind === 'anamnesis-delta' ? 'hint:anamnesis-delta' : 'hint:agent-self',
    });
    written++;
  }
  return { written, skipped };
}

// ────────────────────────────────────────────────────────────────────────────
// Read helpers (consumed by Anamnesis Layer 1 elide-when-confirmed)

/**
 * Return TASK_TOUCH applications since a given timestamp (ms epoch). Used by
 * Anamnesis to elide proposals it would otherwise re-suggest.
 */
export function getRecentTaskTouches(db, sinceMs) {
  if (!db || !Number.isFinite(sinceMs)) return [];
  try {
    return db.prepare(`
      SELECT received_at, target_id, payload
      FROM pulse_hint_log
      WHERE kind='task-touch' AND received_at >= ?
      ORDER BY received_at DESC LIMIT 50
    `).all(sinceMs);
  } catch (e) {
    console.warn(`[pulse-hint] read recent task-touch failed: ${e.message}`);
    return [];
  }
}

/**
 * Read the current COGNITIVE buffer contents (small file; bounded by ring).
 */
export function readCognitiveBuffer() {
  try {
    if (!existsSync(COGNITIVE_BUFFER_PATH)) return '';
    return readFileSync(COGNITIVE_BUFFER_PATH, 'utf-8');
  } catch { return ''; }
}
