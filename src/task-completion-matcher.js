// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module task-completion-matcher
 * @description Resolve L2 task-completion candidates to concrete task ids.
 *
 *   Three matching modes (Planning §2 Q3 — "string-first, BGE fallback"):
 *     1. exact_id      — rawIdHint === task.id           (score 1.0)
 *     2. title_jaccard — directional Jaccard ≥0.6        (score ≤1.0)
 *     3. bge           — cosine similarity ≥0.72         (score ≤1.0)
 *
 *   Modes 1–2 are synchronous and cheap; mode 3 is async and optional, only
 *   invoked when the active task list is large enough that string-only
 *   matching becomes unreliable (≥20 active tasks per Planning §2). The
 *   matcher is tolerant of malformed/empty inputs and never throws.
 *
 *   "Active" means status NOT in {completed, suspended, blocked} — those
 *   tasks shouldn't pull in completion hints (already-done work doesn't get
 *   "shipped" again, and blocked work isn't being completed by definition).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = resolve(__dirname, '..', 'identity', 'tasks.json');

const INACTIVE_STATUS = new Set(['completed', 'suspended', 'blocked']);
const STOP_TOKENS = new Set([
  '', 'a', 'an', 'the', 'of', 'is', 'are', 'and', 'or', 'to', 'in', 'on',
  'at', 'for', 'with', 'by', 'as', 'be', 'it', 'this', 'that',
  'has', 'have', 'had', 'was', 'were', 'will', 'would', 'should', 'could',
  'i', 'you', 'we', 'me', 'us', 'them', 'they', 'he', 'she',
  'not', 'no', 'just', 'all', 'so', 'do', 'does', 'did', 'been', 'being',
  '了', '的', '在', '吗', '呢', '是', '和', '与', '或',
]);

const BGE_THRESHOLD = 0.72;
// Directional Jaccard threshold (overlap / min-side). Tuned at 0.4 because
// phrases routinely carry completion language (CJK "shipped/done" tokens like
// bu-shu-wan-le, plus English "shipped") that inflates phrase token count
// without contributing to subject matching; 0.4 keeps recall on mixed phrases
// such as "ratatoskr v2 <shipped-CJK>" matching "ratatoskr-v2-*".
const TITLE_JACCARD_THRESHOLD = 0.4;
const BGE_MIN_ACTIVE_TASKS = 20;

/**
 * Load active tasks from identity/tasks.json. Returns [{id, title, status}].
 * Best-effort: read/parse failures yield an empty array (matcher then no-ops).
 */
export function loadActiveTasks() {
  try {
    const raw = readFileSync(TASKS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    return tasks
      .filter(t => t && t.id && !INACTIVE_STATUS.has(t.status))
      .map(t => ({ id: String(t.id), title: String(t.title || ''), status: String(t.status || '') }));
  } catch (e) {
    console.warn(`[task-completion-match] loadActiveTasks failed: ${e.message}`);
    return [];
  }
}

/**
 * Tokenize a string for Jaccard match. Lowercased; ASCII split on whitespace
 * + common punctuation (hyphen, underscore, dot, etc.); CJK characters are
 * each their own token (no segmenter dependency). Stopwords filtered.
 */
export function tokenize(s) {
  if (!s || typeof s !== 'string') return [];
  const lower = s.toLowerCase();
  const tokens = [];
  for (const part of lower.split(/[\s\-_/.,;:!?。，！？、]+/)) {
    if (!part) continue;
    let cur = '';
    for (const ch of part) {
      if (/[\u4e00-\u9fa5]/.test(ch)) {
        if (cur) { tokens.push(cur); cur = ''; }
        tokens.push(ch);
      } else {
        cur += ch;
      }
    }
    if (cur) tokens.push(cur);
  }
  // Keep CJK chars and digits even at length 1 (each CJK char is content-
  // bearing; "Step 6" loses meaning if "6" is filtered). Single-letter ASCII
  // is dropped as noise. Stopwords always filtered.
  return tokens.filter(t => {
    if (!t || STOP_TOKENS.has(t)) return false;
    if (t.length === 1) return /[\u4e00-\u9fa5\d]/.test(t);
    return true;
  });
}

function intersectionCount(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let n = 0;
  const seen = new Set();
  for (const t of a) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (setB.has(t)) n++;
  }
  return n;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Synchronous match: exact id, then directional Jaccard on title tokens.
 * Returns the highest-scoring match above threshold, or null.
 *
 * Directional Jaccard = overlap / min(|phraseTokens|, |titleTokens|).
 * Picked over symmetric Jaccard because task titles tend to be far longer
 * than user phrases — symmetric Jaccard would systematically under-score
 * legitimate matches (e.g. "shipped Step 6" vs a 12-token title).
 *
 * @param {string|null} rawIdHint
 * @param {string} phrase
 * @param {Array<{id:string, title:string}>} activeTasks
 * @returns {{task_id:string, score:number, mode:string}|null}
 */
export function matchActiveTasks(rawIdHint, phrase, activeTasks) {
  if (!Array.isArray(activeTasks) || activeTasks.length === 0) return null;

  // Mode 1: exact id
  if (rawIdHint && typeof rawIdHint === 'string') {
    const idLower = rawIdHint.trim().toLowerCase();
    const exact = activeTasks.find(t => t.id.toLowerCase() === idLower);
    if (exact) return { task_id: exact.id, score: 1.0, mode: 'exact_id' };
  }

  // Mode 2: title token Jaccard (directional)
  const phraseSource = `${phrase || ''} ${rawIdHint || ''}`.trim();
  const phraseTokens = tokenize(phraseSource);
  if (phraseTokens.length === 0) return null;

  let best = null;
  for (const t of activeTasks) {
    const titleTokens = tokenize(t.title);
    if (titleTokens.length === 0) continue;
    const overlap = intersectionCount(phraseTokens, titleTokens);
    // B2 (post-review): per-char CJK tokenization + low ratio threshold caused
    // single-char accidental matches (e.g. a 3-char "done" phrase matching any
    // title that contained the same single completion glyph). Require >=2 token
    // overlap unconditionally — the ratio gate is a secondary filter, not primary.
    if (overlap < 2) continue;
    const ratio = overlap / Math.min(phraseTokens.length, titleTokens.length);
    if (ratio >= TITLE_JACCARD_THRESHOLD && (!best || ratio > best.score)) {
      best = { task_id: t.id, score: Number(ratio.toFixed(3)), mode: 'title_jaccard' };
    }
  }
  return best;
}

/**
 * BGE fallback: embeds the phrase and each active title, returns highest
 * cos≥0.72 match. Skipped when active.length<20 (string match is sufficient
 * at small scale and we don't pay the embedding cost for marginal gain).
 *
 * Embedding failures are non-fatal; they degrade to "no match" and the
 * candidate gets dropped at the writer.
 *
 * @param {string} phrase
 * @param {Array<{id:string, title:string}>} activeTasks
 * @param {(text:string) => Promise<Float32Array|number[]|null>} embedFn
 * @returns {Promise<{task_id:string, score:number, mode:string}|null>}
 */
export async function matchActiveTasksBge(phrase, activeTasks, embedFn) {
  if (!Array.isArray(activeTasks) || activeTasks.length < BGE_MIN_ACTIVE_TASKS) return null;
  if (typeof embedFn !== 'function' || !phrase) return null;

  let queryEmb;
  try { queryEmb = await embedFn(phrase); }
  catch (e) { console.warn(`[task-completion-match] BGE query embed failed: ${e.message}`); return null; }
  if (!queryEmb) return null;

  let best = null;
  for (const t of activeTasks) {
    if (!t.title) continue;
    let titleEmb;
    try { titleEmb = await embedFn(t.title); }
    catch { continue; }
    if (!titleEmb) continue;
    const cos = cosineSimilarity(toArray(queryEmb), toArray(titleEmb));
    if (cos >= BGE_THRESHOLD && (!best || cos > best.score)) {
      best = { task_id: t.id, score: Number(cos.toFixed(3)), mode: 'bge' };
    }
  }
  return best;
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v);
  if (Buffer.isBuffer?.(v)) {
    const f = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
    return Array.from(f);
  }
  return [];
}

export const _internal = {
  tokenize,
  cosineSimilarity,
  intersectionCount,
  TITLE_JACCARD_THRESHOLD,
  BGE_THRESHOLD,
  BGE_MIN_ACTIVE_TASKS,
};
