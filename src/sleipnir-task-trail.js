// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — task_trail direct-write path (2026-04-29)
// Plan §4: capture the agent's first-person task narrative on TASK_TOUCH status
// flip. Bypasses the LLM aggregator + Resolver entirely (per design decision #5).
//
//   • Per-session narrative ring buffer (cap 64KB).
//   • On status flip to terminal (done/blocked/code-done/completed/etc),
//     drain buffer → PII-redact (lenient mode) → chunk → write nodes.
//   • Each chunk → one node with subkind='task_trail', owner_id='engine-experiential'.
//   • Multi-chunk task: metadata.chunk_idx / chunk_total. Total > 64KB → keep
//     head 16KB + tail 16KB + `[...elided N bytes...]` placeholder.
//   • Milestone tasks (notes contain `milestone=true`) get TTL 90d via metadata.
//   • Skipped owner_id='engine-experiential' for OSS export filter parity.

import { redact } from './sleipnir-redact.js';
import {
  OWNER_EXPERIENTIAL, SUBKIND_TASK_TRAIL,
  TASK_TRAIL_CHUNK_BYTES, TASK_TRAIL_TOTAL_BYTES,
  TASK_TRAIL_TTL_DAYS, TASK_TRAIL_MILESTONE_TTL_DAYS,
} from './sleipnir-constants.js';
import { sleipnirTrail } from './sleipnir-trail.js';

const TERMINAL_STATUSES = new Set([
  'completed', 'code-done', 'blocked', 'suspended', 'cancelled', 'done', 'paused',
]);

// Generate a stable id for a task_trail node.
function makeTrailId(taskId, chunkIdx, ts) {
  const tag = String(taskId || 'unknown').slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `TT-${tag}-${ts}-${chunkIdx}`;
}

// Apply head/tail elision when payload exceeds TASK_TRAIL_TOTAL_BYTES.
// Returns the elided string AND the elided byte count for metadata.
function elideHeadTail(text, maxBytes = TASK_TRAIL_TOTAL_BYTES, sliceBytes = TASK_TRAIL_CHUNK_BYTES) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return { text, elided: 0 };
  const head = buf.slice(0, sliceBytes).toString('utf-8');
  const tail = buf.slice(buf.length - sliceBytes).toString('utf-8');
  const elided = buf.length - 2 * sliceBytes;
  return { text: `${head}\n\n[...elided ${elided} bytes...]\n\n${tail}`, elided };
}

// Slice a string into ≤ chunkBytes UTF-8 chunks. Avoids breaking multi-byte
// codepoints by using Buffer slicing then re-encoding via String API.
function chunkUtf8(text, chunkBytes = TASK_TRAIL_CHUNK_BYTES) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= chunkBytes) return [text];
  const chunks = [];
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + chunkBytes, buf.length);
    // Walk back to a UTF-8 boundary if `end` lands inside a multi-byte sequence
    let safeEnd = end;
    while (safeEnd > i && safeEnd < buf.length && (buf[safeEnd] & 0xc0) === 0x80) {
      safeEnd--;
    }
    chunks.push(buf.slice(i, safeEnd).toString('utf-8'));
    i = safeEnd;
  }
  return chunks;
}

export class TaskTrailCollector {
  // sessionId -> { buffer: string, bytes: number, startedAt: number, toolCount: number }
  #buffers = new Map();
  #engine = null;
  #enabled = true;

  init(engine) {
    this.#engine = engine;
    if (!engine?.db) this.#enabled = false;
  }

  // Append a turn's response text to the per-session ring buffer.
  // Caps at TASK_TRAIL_TOTAL_BYTES — older content drops first.
  appendTurn({ sessionId, responseText, toolsUsed = 0 }) {
    if (!this.#enabled || !sessionId || !responseText) return;
    const s = this.#buffers.get(sessionId) || {
      buffer: '', bytes: 0, startedAt: Date.now(), toolCount: 0,
    };
    s.buffer += '\n--- turn ---\n' + responseText;
    s.toolCount += toolsUsed;
    // Trim from the front if exceeding cap (ring-buffer behavior)
    while (Buffer.byteLength(s.buffer, 'utf-8') > TASK_TRAIL_TOTAL_BYTES * 2) {
      // Trim ~1KB from the front per pass
      s.buffer = s.buffer.slice(1024);
    }
    s.bytes = Buffer.byteLength(s.buffer, 'utf-8');
    this.#buffers.set(sessionId, s);
  }

  // Drain narrative for `taskId` and write task_trail node(s). Called on
  // TASK_TOUCH terminal status flip. `extraNote` lets the caller include the
  // touch's `note` field for additional context.
  drainForTask({ taskId, sessionId, statusFrom, statusTo, extraNote = null, milestone = false }) {
    if (!this.#enabled || !this.#engine?.db) return { written: 0, reason: 'disabled' };

    const s = this.#buffers.get(sessionId);
    if (!s || !s.buffer || s.buffer.length < 50) {
      return { written: 0, reason: 'empty_buffer' };
    }

    // Compose payload: header + buffer + optional note tail
    const header = [
      `# task_trail`,
      `task_id: ${taskId}`,
      `session: ${sessionId}`,
      `status: ${statusFrom || '?'} → ${statusTo || '?'}`,
      `started_at: ${new Date(s.startedAt).toISOString()}`,
      `ended_at: ${new Date().toISOString()}`,
      `tool_count: ${s.toolCount}`,
      ``,
    ].join('\n');
    const note = extraNote ? `\n\n# closing_note\n${extraNote}` : '';
    const composed = header + s.buffer + note;

    // PII-redact (lenient mode preserves more context than 'exploration')
    const r = redact(composed, 'task_trail');

    // Head/tail elision if total > 64KB
    const { text: elided, elided: elidedBytes } = elideHeadTail(r.text);

    // Chunk
    const chunks = chunkUtf8(elided, TASK_TRAIL_CHUNK_BYTES);
    const chunkTotal = chunks.length;
    const ts = Date.now();
    const ttlDays = milestone ? TASK_TRAIL_MILESTONE_TTL_DAYS : TASK_TRAIL_TTL_DAYS;
    const validUntil = ts + ttlDays * 24 * 3600_000;

    let written = 0;
    for (let i = 0; i < chunks.length; i++) {
      const id = makeTrailId(taskId, i, ts);
      const text = chunks[i];
      const l0 = `task_trail:${taskId} (${i + 1}/${chunkTotal})`;
      const l1 = `Task ${taskId} narrative chunk ${i + 1}/${chunkTotal}, ${statusFrom}→${statusTo}, ${Buffer.byteLength(text, 'utf-8')}B`;
      // l2 carries the raw narrative (CPU-cheap; resolver/dedup are skipped)
      const l2 = text;

      try {
        this.#engine.rememberSync({
          id,
          l0,
          l1,
          l2,
          // Registered tier-1+tier-2 tags (see config/node_taxonomy.json).
          // The dynamic task id lives in metadata, not tags, to avoid bloating
          // the tag namespace.
          tags: ['architecture', 'sleipnir', 'task-trail'],
          tone: 'narrative',
          source: 'sleipnir',
          node_type: 'context',
          subkind: SUBKIND_TASK_TRAIL,
          skipDedup: true,
          event_at: new Date(ts).toISOString(),
        });
        // Post-write owner_id stamp (rememberSync does not accept owner_id directly)
        this.#engine.db.prepare(
          `UPDATE nodes SET owner_id = ?, subtype = NULL WHERE id = ?`
        ).run(OWNER_EXPERIENTIAL, id);
        written++;
      } catch (e) {
        console.warn(`[sleipnir-task-trail] write chunk ${i} failed: ${e.message}`);
      }
    }

    // Bump task_trail metric on the trail telemetry module
    try {
      // Direct insert into sleipnir_metrics; sleipnirTrail's helper is private,
      // so we inline equivalent.
      const bucket = Math.floor(Date.now() / 3600_000);
      this.#engine.db.prepare(`
        INSERT INTO sleipnir_metrics (bucket_hour, silent_drop, trail_only, promote, task_trail, redaction_hits, caller_subagent)
        VALUES (?, 0, 0, 0, ?, ?, 0)
        ON CONFLICT(bucket_hour) DO UPDATE SET
          task_trail = task_trail + excluded.task_trail,
          redaction_hits = redaction_hits + excluded.redaction_hits
      `).run(bucket, written, r.hits || 0);
    } catch { /* metric best-effort */ }

    // Clear the session buffer so the next task starts fresh.
    this.#buffers.delete(sessionId);

    return {
      written,
      chunks: chunkTotal,
      elided_bytes: elidedBytes,
      redaction_hits: r.hits,
      ttl_days: ttlDays,
    };
  }

  // Status helpers
  static isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(String(status || '').toLowerCase());
  }

  // Buffer accessor for tests
  _getBufferSize(sessionId) {
    const s = this.#buffers.get(sessionId);
    return s ? s.bytes : 0;
  }
}

export const taskTrailCollector = new TaskTrailCollector();
