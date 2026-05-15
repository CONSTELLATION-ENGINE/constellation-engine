// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module injection-log
 * @description Records what context was injected into each turn's prompt.
 *
 * Privacy: never stores raw user text or raw session IDs. Only lengths, short
 * SHA-256 hashes (for correlation across turns without revealing content), and
 * aggregate numbers like rerank scores and segment counts. Rotated at 10 MB,
 * keeps the last 5 rotated files.
 *
 * Written to engine-output/injection-log.jsonl (one record per turn).
 */

import { appendFileSync, statSync, renameSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const LOG_DIR = join(PROJECT_ROOT, 'engine-output');
const LOG_FILE = join(LOG_DIR, 'injection-log.jsonl');

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED = 5;
const CHECK_INTERVAL = 50;

try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

let writeCount = 0;

function maybeRotate() {
  writeCount++;
  if (writeCount % CHECK_INTERVAL !== 0) return;
  let size = 0;
  try { size = statSync(LOG_FILE).size; } catch { return; }
  if (size < MAX_SIZE) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try { renameSync(LOG_FILE, join(LOG_DIR, `injection-log.${ts}.jsonl`)); } catch {}
  try {
    const rotated = readdirSync(LOG_DIR)
      .filter(f => f.startsWith('injection-log.') && f.endsWith('.jsonl') && f !== 'injection-log.jsonl')
      .sort().reverse();
    for (const f of rotated.slice(MAX_ROTATED)) {
      try { unlinkSync(join(LOG_DIR, f)); } catch {}
    }
  } catch {}
}

function shortHash(s) {
  if (!s) return '';
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function detectLang(s) {
  if (!s) return 'unk';
  return /[\u4e00-\u9fff]/.test(s) ? 'zh' : 'en';
}

/**
 * Record one injection event. All values are optional; pass whatever is known.
 *
 * @param {Object} rec
 * @param {string} [rec.sessionId]        - raw session id (will be hashed)
 * @param {string} [rec.speakerId]        - raw speaker id (will be hashed)
 * @param {string} [rec.userMessage]      - raw message (will NOT be stored,
 *                                          only length + hash + lang)
 * @param {Object} [rec.episodic]         - {segments, top_rerank, chars, deep_recall}
 * @param {Object} [rec.deepRecall]       - {segments, top_rerank, chars, triggered_by}
 * @param {Object} [rec.poolAnchor]       - {segments, chars}
 * @param {Object} [rec.autoExpand]       - {seg_id, top_rerank, margin, chars, msgs?, truncated?, skipped?}
 * @param {Object} [rec.raw]              - {turns, span_min, chars, mode}
 * @param {Object} [rec.adaptiveWindow]   - {isExpanded, hours, maxTurns, compaction_triggered_window_8h}
 * @param {number[]} [rec.segment_ids_fetched] - seg IDs fetched via conversation_fetch_raw this turn
 * @param {number} [rec.totalChars]       - total injected char count
 * @param {number} [rec.latencyMs]        - total pipeline latency if known
 */
export function logInjection(rec) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      session_h: shortHash(rec.sessionId),
      speaker_h: shortHash(rec.speakerId),
      msg_len: rec.userMessage ? rec.userMessage.length : 0,
      msg_h: shortHash(rec.userMessage),
      lang: detectLang(rec.userMessage),
      episodic: rec.episodic || null,
      deep_recall: rec.deepRecall || null,
      pool_anchor: rec.poolAnchor || null,
      auto_expand: rec.autoExpand || null,
      raw: rec.raw || null,
      adaptive_window: rec.adaptiveWindow || null,
      segment_ids_fetched: Array.isArray(rec.segment_ids_fetched) && rec.segment_ids_fetched.length > 0
        ? rec.segment_ids_fetched
        : null,
      total_chars: rec.totalChars || 0,
      latency_ms: rec.latencyMs || 0,
    };
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    maybeRotate();
  } catch {
    // never let logging break a turn
  }
}
