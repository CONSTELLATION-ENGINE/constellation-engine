// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — PII redaction layer (2026-04-29)
// Plan §5: 4 ordered rules; mode = 'exploration' (strict) or 'task_trail' (lenient context preserved).
import { WORKDIR_PREFIX } from './sleipnir-constants.js';

// Rule 1 — Email
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// Rule 2 — API key / token (must come before R3 to avoid hex IP false positives)
//   sk-..., pk-..., tok_..., api-key=..., api_key=...
const RE_API_KEY = /\b(?:sk-|pk-|tok_|api[-_]?key[=:]\s*)[A-Za-z0-9_\-]{16,}/gi;

// Rule 3 — IPv4 (with optional port)
//   Excludes localhost, 127.0.0.1, 0.0.0.0 — dev-local not PII.
const RE_IPV4 = /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}(?::\d{1,5})?\b/g;
const LOCALHOST_IPS = new Set(['127.0.0.1', '0.0.0.0', '::1']);

// Rule 4 — Filesystem home path; preserve workdir prefix per user decision.
//   /home/<user>/foo  →  /home/<user>/foo  (only if not under WORKDIR_PREFIX)
const RE_HOME = /\/home\/[A-Za-z0-9_-]+\//g;

/**
 * Redact PII from text, returning the redacted version + a hits count.
 *
 * @param {string} text
 * @param {'exploration'|'task_trail'} mode
 * @returns {{ text: string, hits: number, ruleHits: Record<string, number> }}
 */
export function redact(text, mode = 'exploration') {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', hits: 0, ruleHits: {} };
  }
  const ruleHits = { R1_email: 0, R2_token: 0, R3_ip: 0, R4_home: 0 };
  let out = text;

  // R1 — emails
  out = out.replace(RE_EMAIL, () => { ruleHits.R1_email++; return '[email]'; });

  // R2 — tokens / API keys
  out = out.replace(RE_API_KEY, () => { ruleHits.R2_token++; return '[redacted_token]'; });

  // R3 — IPs (skip localhost)
  out = out.replace(RE_IPV4, (m) => {
    const bare = m.split(':')[0];
    if (LOCALHOST_IPS.has(bare)) return m;
    ruleHits.R3_ip++;
    return '[ip]';
  });

  // R4 — home paths; preserve workdir prefix exactly.
  // Check the *current* haystack `out` (not original `text`) at the match offset:
  // R1/R2/R3 may have shifted offsets, so checking `text` at this offset misfires.
  out = out.replace(RE_HOME, (match, offset, haystack) => {
    if (haystack.startsWith(WORKDIR_PREFIX, offset)) {
      return match; // preserve verbatim
    }
    ruleHits.R4_home++;
    return '/home/<user>/';
  });

  const hits = ruleHits.R1_email + ruleHits.R2_token + ruleHits.R3_ip + ruleHits.R4_home;
  return { text: out, hits, ruleHits };
}

/**
 * Convenience: returns true if redacted text is effectively empty (only PII was present).
 */
export function isPureNoise(originalText, redactedText) {
  if (!originalText || !redactedText) return true;
  // Strip placeholder tokens from redacted version
  const stripped = redactedText
    .replace(/\[email\]/g, '')
    .replace(/\[redacted_token\]/g, '')
    .replace(/\[ip\]/g, '')
    .replace(/\/home\/<user>\//g, '')
    .trim();
  return stripped.length < 10;
}
