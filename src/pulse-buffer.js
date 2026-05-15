// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module pulse-buffer
 * @description Atomic ring-buffer file writer for Ratatoskr pulse-hint sinks.
 *
 * Future COGNITIVE_TOUCH / TASK_TOUCH handlers append to small per-kind log
 * files (e.g. identity/cognitive-buffer.txt). Files must stay bounded — both
 * line count and byte size — or they grow without bound. This module:
 *   1. Reads the existing file (or empty if missing).
 *   2. Appends the new line.
 *   3. Trims the head until both limits hold.
 *   4. Writes via tmp + rename for crash-safety.
 *
 * No external state, no DB, no async — safe to call from any sync writer.
 * Phase 1 ships the helper only; no caller wired yet.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_LINES = 40;
const DEFAULT_MAX_BYTES = 4096;

/**
 * Append a line to a ring-buffer file, trimming the head until the file fits
 * the configured caps. Atomic: writes to <path>.tmp then renames.
 *
 * @param {string} path - target file path
 * @param {string} line - line to append (newline appended automatically)
 * @param {{maxLines?: number, maxBytes?: number}} [opts]
 * @returns {{linesKept: number, bytes: number}}
 */
export function appendRingBuffer(path, line, opts = {}) {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (typeof line !== 'string') throw new TypeError('line must be a string');
  if (line.includes('\n')) throw new Error('line must not contain newlines');
  // Truncate over-cap single lines so the byte invariant always holds even when
  // the appended line itself is the cap-buster. Reserve 1 byte for the newline.
  if (Buffer.byteLength(line, 'utf-8') >= maxBytes) {
    const cap = Math.max(1, maxBytes - 1);
    while (Buffer.byteLength(line, 'utf-8') > cap) {
      line = line.slice(0, -1);
    }
  }

  let existing = '';
  if (existsSync(path)) {
    try { existing = readFileSync(path, 'utf-8'); } catch { existing = ''; }
  }
  const lines = existing.length === 0
    ? []
    : existing.split('\n').filter((ln, i, arr) => !(i === arr.length - 1 && ln === ''));
  lines.push(line);

  while (lines.length > maxLines) lines.shift();
  let body = lines.join('\n') + '\n';
  while (Buffer.byteLength(body, 'utf-8') > maxBytes && lines.length > 1) {
    lines.shift();
    body = lines.join('\n') + '\n';
  }

  const tmp = path + '.tmp';
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists or unwritable */ }
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, path);
  return { linesKept: lines.length, bytes: Buffer.byteLength(body, 'utf-8') };
}
