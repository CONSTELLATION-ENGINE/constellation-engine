// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module redact
 * @description Shared PII-stripping utility for diagnostic dumps (L0 CLI /
 * L2 dashboard Doctor tab / L3 external diagnose agent).
 *
 * Contract: every string leaving the engine for human or external inspection
 * must pass through one of `redact()` / `redactObject()` first. A raw session
 * id or message text reaching a bug report is treated as a leak.
 *
 * Not a full DLP. Patterns below cover the things we have actually seen in
 * this repo's logs: telegram ids, Anthropic keys, bot tokens, curl payloads
 * carrying user text, absolute paths that embed the local user.
 */

import { createHash } from 'node:crypto';

/** 8-byte hex prefix of SHA-256(s). '' for empty / nullish. */
export function shortHash(s) {
  if (s === null || s === undefined || s === '') return '';
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

/**
 * Deterministic token used in place of a redacted value so that the same
 * input redacts to the same placeholder across a dump — e.g. every mention
 * of the same chat id becomes `[tg:#a3f1b0c2]`, not a random UUID per match.
 */
function tag(kind, seed) {
  return `[${kind}:#${shortHash(seed)}]`;
}

// Ordered list — earlier rules shadow later ones when they would overlap.
// Each rule: [name, regex (global), replacer(match) → string].
const RULES = [
  ['anthropic_key',
    /sk-ant-[A-Za-z0-9_-]{20,}/g,
    (m) => tag('anthropic_key', m)],
  ['openai_key',
    /sk-[A-Za-z0-9]{20,}/g,
    (m) => tag('api_key', m)],
  ['bearer',
    /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    (m) => `Bearer ${tag('token', m)}`],
  ['tg_bot_token',
    /\b\d{8,12}:[A-Za-z0-9_-]{35,46}\b/g,
    (m) => tag('tg_bot', m)],
  ['tg_session',
    /tg:(\d{6,})/g,
    (_m, id) => `tg:${tag('tg_user', id).slice(1, -1)}`],
  ['email',
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (m) => tag('email', m)],
  // curl body: "text":"..." — user message embedded in a shell command
  ['curl_text_field',
    /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    (_m, body) => `"text":"${tag('text', body).slice(1, -1)}"`],
  // /home/<user>/... — replace only the user segment
  ['home_path',
    /\/home\/([A-Za-z0-9_.-]+)(?=\/|\b)/g,
    () => '/home/<user>'],
  // IPv4 addresses outside loopback
  ['ipv4',
    /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    (m) => tag('ip', m)],
];

/**
 * Redact a single string. Unknown strings pass through; each rule above is
 * applied once. Output is stable for a given input.
 *
 * @param {unknown} input
 * @returns {string} redacted string (non-strings are coerced via String())
 */
export function redact(input) {
  if (input === null || input === undefined) return '';
  let s = typeof input === 'string' ? input : String(input);
  for (const [, re, replacer] of RULES) {
    s = s.replace(re, replacer);
  }
  return s;
}

// Keys whose values are almost always PII and should be replaced wholesale
// with a hash, not pattern-scrubbed — cheaper than regexing a 20 KB message
// body, and safer when the field contains binary / non-UTF8.
const OPAQUE_KEYS = new Set([
  'sessionId', 'session_id', 'session',
  'speakerId', 'speaker_id', 'speaker',
  'chatId', 'chat_id',
  'userId', 'user_id',
  'userMessage', 'user_message', 'message', 'msg_text', 'text',
  'prompt', 'user_prompt',
  'apiKey', 'api_key', 'token', 'access_token', 'auth',
]);

/**
 * Deep-redact an object/array. Strings are scrubbed with `redact()`. Values
 * under a key name in OPAQUE_KEYS are replaced with a short hash instead
 * (so `{sessionId: "tg:123456789"}` becomes `{sessionId: "#a3f1b0c2"}`
 * without leaking the prefix). Cycles and depths > MAX_DEPTH collapse to
 * "[truncated]".
 *
 * @template T
 * @param {T} obj
 * @param {number} [depth=0]
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function redactObject(obj, depth = 0, seen = new WeakSet()) {
  const MAX_DEPTH = 8;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (obj === null || obj === undefined) return obj;
  const t = typeof obj;
  if (t === 'string') return redact(obj);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return obj;
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (Buffer.isBuffer?.(obj)) return `[buffer:${obj.length}]`;
  if (seen.has(/** @type {object} */ (obj))) return '[cycle]';
  seen.add(/** @type {object} */ (obj));
  if (Array.isArray(obj)) {
    return obj.map((v) => redactObject(v, depth + 1, seen));
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (OPAQUE_KEYS.has(k) && v !== null && v !== undefined) {
      out[k] = `#${shortHash(v)}`;
    } else {
      out[k] = redactObject(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Convenience: redact a whole JSON line. If parse fails, fall back to
 * string-level redaction so malformed lines still get scrubbed.
 */
export function redactJsonLine(line) {
  if (!line) return '';
  try {
    return JSON.stringify(redactObject(JSON.parse(line)));
  } catch {
    return redact(line);
  }
}
