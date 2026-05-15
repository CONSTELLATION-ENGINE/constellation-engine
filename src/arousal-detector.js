// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-turn arousal detector for Mímir Step 8 (master plan §8).
//
// Reads a user message and returns alpha ∈ [0.5, 2.0]:
//   1.0 = neutral baseline; <1 = subdued (one-word ack, factual short); >1 = aroused
//   (emotion words, exclamation density, question urgency, length spikes).
//
// Alpha modulates three downstream Mímir behaviours when piped to the daemon
// via the /signal payload:
//   • SA propagation strength — input_signal vector scaled by alpha
//   • Pressure dP per detector — already reads state.alpha
//   • Mimir-action-worker write strength — alpha snapshot in action payload
//
// Numbers are deliberately small and bounded; the goal is "noticeable
// modulation, not state-machine swings". Tuning parameters are exported
// constants so Step 9 dashboard can override at runtime.

export const AROUSAL_MIN = 0.5;
export const AROUSAL_MAX = 2.0;
export const AROUSAL_DEFAULT = 1.0;

const SHORT_LEN_FLOOR = 10;     // ≤ → subdued
const LONG_LEN_BUMP   = 200;    // ≥ → +length_bonus
const VERY_LONG_LEN   = 800;
const EXCLAIM_STEP    = 0.08;
const EXCLAIM_CAP     = 0.40;
const QUESTION_STEP   = 0.04;
const QUESTION_CAP    = 0.20;
const EMOJI_PER       = 0.06;
const EMOJI_CAP       = 0.30;
const ALLCAPS_STEP    = 0.08;
const ALLCAPS_CAP     = 0.24;
const POSITIVE_STEP   = 0.08;
const NEGATIVE_STEP   = 0.10;
const EMOTION_CAP     = 0.45;

// Strength markers — bilingual; match as substrings.
// Positive arousal: enthusiasm, surprise, urgency-good
const POSITIVE_MARKERS = [
  '太棒', '牛逼', '完美', '太好了', '惊艳', '爱了', '哇', '震撼', '太爱',
  'awesome', 'amazing', 'love this', 'love it', 'perfect', 'incredible', 'wow',
  'fantastic', 'omg', 'oh my', 'brilliant', 'excellent', 'nailed it', 'killer',
  'beautiful', 'genius', 'finally', 'no way', 'holy', 'huge',
];

// Negative / urgency arousal: frustration, urgency-bad, alarm
const NEGATIVE_MARKERS = [
  '完蛋', '糟了', '错了', '不行', '急', '必须', '紧急', '崩了', '失败', '坏了',
  '挂了', '断了', '不对', '怎么搞的', '到底',
  'urgent', 'broken', 'failed', 'failing', 'must ', 'cannot', 'must not',
  'wtf', 'damn', 'crash', 'hate ', 'awful', 'terrible', 'shit', 'fucked',
  'stuck', 'cant ', "can't believe", "shouldn't", 'why is this', 'this sucks',
  'worst', 'nightmare',
];

// Tools/IDs that should not count as ALLCAPS — common abbreviations.
const ALLCAPS_STOPLIST = new Set([
  'OK', 'OKAY', 'API', 'CPU', 'GPU', 'URL', 'JSON', 'HTTP', 'HTTPS', 'SQL',
  'DB', 'UI', 'AI', 'LLM', 'MCP', 'OSS', 'PR', 'CI', 'OS', 'ID', 'TZ',
  'SA', 'IR', 'BFS', 'TTL', 'WSL', 'KDP', 'PK', 'WIP',
]);

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
// Conservative token splitter: ASCII whitespace; CJK words don't trigger ALLCAPS anyway.
const ALLCAPS_RE = /\b[A-Z]{2,}\b/g;

/**
 * Compute per-turn arousal alpha from a user message.
 * Pure function; never throws on malformed input.
 *
 * @param {string} text - Raw user message
 * @returns {number} alpha in [AROUSAL_MIN, AROUSAL_MAX]
 */
export function computeArousal(text) {
  if (typeof text !== 'string' || !text) return AROUSAL_DEFAULT;
  const s = text.trim();
  if (!s) return AROUSAL_DEFAULT;

  let alpha = AROUSAL_DEFAULT;

  // Length factor — very short (acks) subdue, very long energise mildly.
  const len = s.length;
  if (len <= SHORT_LEN_FLOOR) {
    alpha -= 0.15;
  } else if (len >= VERY_LONG_LEN) {
    alpha += 0.08;
  } else if (len >= LONG_LEN_BUMP) {
    alpha += 0.04;
  }

  // Exclamation density (consecutive ! count more, but cap).
  const exclaims = (s.match(/!|！/g) || []).length;
  if (exclaims > 0) {
    alpha += Math.min(EXCLAIM_CAP, exclaims * EXCLAIM_STEP);
  }

  // Question density — questions raise arousal slightly (uncertainty / urgency).
  const questions = (s.match(/\?|？/g) || []).length;
  if (questions > 0) {
    alpha += Math.min(QUESTION_CAP, questions * QUESTION_STEP);
  }

  // Emoji density.
  const emojis = (s.match(EMOJI_RE) || []).length;
  if (emojis > 0) {
    alpha += Math.min(EMOJI_CAP, emojis * EMOJI_PER);
  }

  // ALLCAPS tokens (stoplist filtered).
  const caps = (s.match(ALLCAPS_RE) || []).filter(t => !ALLCAPS_STOPLIST.has(t));
  if (caps.length > 0) {
    alpha += Math.min(ALLCAPS_CAP, caps.length * ALLCAPS_STEP);
  }

  // Emotion strength markers — substring scan in lowercased copy.
  const lower = s.toLowerCase();
  let posHits = 0;
  let negHits = 0;
  for (const m of POSITIVE_MARKERS) {
    if (lower.includes(m)) posHits++;
  }
  for (const m of NEGATIVE_MARKERS) {
    if (lower.includes(m)) negHits++;
  }
  if (posHits > 0 || negHits > 0) {
    const emotionBump = Math.min(
      EMOTION_CAP,
      posHits * POSITIVE_STEP + negHits * NEGATIVE_STEP,
    );
    alpha += emotionBump;
  }

  if (Number.isNaN(alpha) || !Number.isFinite(alpha)) return AROUSAL_DEFAULT;
  return Math.max(AROUSAL_MIN, Math.min(AROUSAL_MAX, alpha));
}

/**
 * Round to 3 decimals for transport — shrinks /signal payload noise without
 * losing meaningful resolution (alpha is multiplicative, 0.001 imperceptible).
 */
export function roundArousal(alpha) {
  return Math.round(alpha * 1000) / 1000;
}
