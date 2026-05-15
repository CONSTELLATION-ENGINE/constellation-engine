// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module task-completion-extractor
 * @description L2 implicit task-completion candidate extractor (Plan C hybrid).
 *
 *   Reads a free-text agent turn and emits zero-or-more "completion candidate"
 *   records. Each candidate represents a natural-language hint that some task
 *   may have just been finished — e.g. "L0 dispatcher [CJK done-marker]" or
 *   "Step 6 shipped". Candidates are best-effort: they feed into matcher (string-
 *   first + BGE fallback) downstream and ultimately into IR injection that
 *   prompts the agent to emit a confirming TASK_TOUCH.
 *
 *   Key gates (per Planning §4 blind-spots):
 *     BS1 grammar — sentences whose head contains a negation/future prefix
 *                   are skipped wholesale.
 *     BS2 lexicon-driven — config/task-completion-patterns.json carries all
 *                          phrase/negation/id-extractor rules; no hard-codes
 *                          in this file beyond defensive fallbacks.
 *
 *   Errors (malformed lexicon, broken regex) are caught and the offending
 *   pattern is skipped with a warn — extractor must never throw into the
 *   pulse-hint dispatcher.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEXICON_PATH = resolve(__dirname, '..', 'config', 'task-completion-patterns.json');

let _cachedLexicon = null;
let _cachedLexiconMtime = 0;

/**
 * Load (and cache) the lexicon. Rebuilds compiled regexes on each load so
 * the in-memory shape always matches the JSON. Returns a frozen object.
 */
export function loadLexicon(lexiconPath = DEFAULT_LEXICON_PATH) {
  try {
    const raw = readFileSync(lexiconPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const lex = {
      completion_phrases: [],
      negation_prefixes: Array.isArray(parsed.negation_prefixes) ? parsed.negation_prefixes.slice() : [],
      task_id_extractors: [],
    };
    for (const cp of parsed.completion_phrases || []) {
      try {
        lex.completion_phrases.push({ lang: cp.lang || 'unknown', re: new RegExp(cp.pattern) });
      } catch (e) {
        console.warn(`[l2-extract] bad completion phrase pattern (${cp.pattern}): ${e.message}`);
      }
    }
    for (const idex of parsed.task_id_extractors || []) {
      try {
        lex.task_id_extractors.push({
          kind: idex.kind || 'phrase',
          re: new RegExp(idex.pattern, idex.flags || ''),
        });
      } catch (e) {
        console.warn(`[l2-extract] bad task id extractor (${idex.pattern}): ${e.message}`);
      }
    }
    _cachedLexicon = Object.freeze(lex);
    _cachedLexiconMtime = Date.now();
    return _cachedLexicon;
  } catch (e) {
    console.warn(`[l2-extract] lexicon load failed (${lexiconPath}): ${e.message}`);
    return _cachedLexicon || Object.freeze({ completion_phrases: [], negation_prefixes: [], task_id_extractors: [] });
  }
}

/**
 * Convenience: get the cached lexicon, lazily loading the first time.
 */
function getLexicon() {
  if (_cachedLexicon) return _cachedLexicon;
  return loadLexicon();
}

/**
 * Split text into segments along sentence-final punctuation and newlines.
 * Keeps punctuation with the preceding segment so grammar-gate prefixes can
 * be detected correctly. Empty segments are filtered.
 */
const SEGMENT_MAX_CHARS = 1000;

function segmentText(text) {
  if (!text || typeof text !== 'string') return [];
  // CJK sentence-final punctuation splits immediately (no trailing whitespace
  // required — CJK rarely uses one). ASCII .!? split only when followed by
  // whitespace, so "U.S.A." or version "1.2.3" don't get over-split. Newlines
  // always split.
  const parts = text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/g);
  // B3 (post-review): long segments must be TRUNCATED, not dropped — agents
  // routinely emit 2k+ char paragraphs and silently filtering them killed
  // recall on the most common turn shape. Keep the regex worst-case bounded
  // by truncating to SEGMENT_MAX_CHARS, which is enough to capture any
  // realistic completion phrase (they sit near the end of a turn, not mid-
  // sentence). If the phrase is in the truncated tail it'll be caught next
  // turn or by Anamnesis.
  return parts
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => s.length > SEGMENT_MAX_CHARS ? s.slice(0, SEGMENT_MAX_CHARS) : s);
}

/**
 * Test if a segment's head contains a negation/future-tense token from the
 * lexicon. Uses lowercased substring match so "Will ship" ≡ "will ship".
 * Only the first ~32 chars of the segment are scanned — a negation buried
 * mid-sentence wouldn't actually negate the completion phrase (e.g.
 * "I shipped X but haven't deployed Y" should still emit X).
 */
function isNegated(segment, lexicon) {
  if (!segment) return false;
  const head = segment.slice(0, 32).toLowerCase();
  for (const np of lexicon.negation_prefixes || []) {
    if (!np) continue;
    const needle = np.toLowerCase();
    const isAscii = /^[\x00-\x7f]+$/.test(needle);
    if (!isAscii) {
      // CJK / mixed: substring match is safe enough — CJK has no word boundary
      // ambiguity (no "willing" → "will" false positive).
      if (head.includes(needle)) return true;
      continue;
    }
    // ASCII: require start boundary to avoid `not` matching `notify`.
    // End boundary only enforced when the needle ends in a letter — needles like
    // "will " or "going to" already encode their own trailing word boundary.
    const escaped = needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const endsWithLetter = /[a-z]$/.test(needle);
    const re = endsWithLetter
      ? new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i')
      : new RegExp(`(^|[^a-z])${escaped}`, 'i');
    if (re.test(head)) return true;
  }
  return false;
}

/**
 * Try each task-id extractor against a segment. Returns the first match's
 * captured group (group 1) or null. `explicit` extractors run first per
 * lexicon order — phrase fallback only fires when explicit didn't hit.
 */
function extractIdHint(segment, lexicon) {
  for (const idex of lexicon.task_id_extractors || []) {
    if (idex.kind !== 'explicit') continue;
    const m = segment.match(idex.re);
    if (m && m[1]) return { kind: 'explicit', value: m[1].trim().slice(0, 80) };
  }
  return null;
}

/**
 * Score a candidate. Phrase + explicit id → 0.85; phrase + past-tense marker
 * → 0.75; phrase only → 0.65. Capped at 0.95 so callers can reserve 1.0 for
 * out-of-band signals (e.g. explicit TASK_TOUCH never goes through here).
 */
function scoreCandidate(phrase, idHint) {
  let score = 0.65;
  if (idHint) score = 0.85;
  // Past-tense / completion markers in phrase add a small boost when no id.
  if (!idHint && /(?:了|shipped|done|deployed|landed|completed|finished|wrapped|merged|released|fixed|resolved|closed|live|pushed)/i.test(phrase)) {
    score = 0.75;
  }
  return Math.min(0.95, Number(score.toFixed(2)));
}

/**
 * Main entry point. Returns an array of candidates extracted from `text`.
 * Each candidate has shape:
 *   { phrase, lang, raw_id_hint, confidence_pre }
 *
 * Per Planning §4 BS5, callers should still gate on conf≥0.7 and apply
 * per-turn caps before injecting into IR.
 *
 * @param {string} text - the agent's turn text (already TOUCH-stripped is fine)
 * @param {object} [lexicon] - optional override; defaults to cached config
 * @returns {Array<{phrase:string, lang:string, raw_id_hint:string|null, confidence_pre:number}>}
 */
export function extractCompletionCandidates(text, lexicon) {
  const lex = lexicon || getLexicon();
  const segments = segmentText(text);
  const out = [];
  for (const seg of segments) {
    if (isNegated(seg, lex)) continue;
    let matched = null;
    for (const cp of lex.completion_phrases) {
      const m = seg.match(cp.re);
      if (m && m[0]) {
        matched = { phrase: m[0].trim().slice(0, 200), lang: cp.lang };
        break; // one match per segment per Planning §4 BS5
      }
    }
    if (!matched) continue;
    const idHint = extractIdHint(seg, lex);
    out.push({
      phrase: matched.phrase,
      lang: matched.lang,
      raw_id_hint: idHint ? idHint.value : null,
      confidence_pre: scoreCandidate(matched.phrase, idHint),
    });
  }
  return out;
}

// Test-only helpers
export const _internal = { segmentText, isNegated, extractIdHint, scoreCandidate, DEFAULT_LEXICON_PATH };
