// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for task-completion-extractor.js — runs under `node --test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCompletionCandidates, loadLexicon, _internal } from './task-completion-extractor.js';

const lex = loadLexicon();

test('1. zh past-tense — "L0 dispatcher 跑通了" emits one candidate', () => {
  const out = extractCompletionCandidates('L0 dispatcher 跑通了。', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].lang, 'zh');
  assert.ok(out[0].phrase.includes('跑通了'));
  assert.ok(out[0].confidence_pre >= 0.65);
});

test('2. en past-tense — "Step 6 shipped" emits one candidate', () => {
  const out = extractCompletionCandidates('Step 6 shipped.', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].lang, 'en');
  assert.ok(/shipped/.test(out[0].phrase));
});

test('3. mixed zh+en — "Phase 2 部署完了" emits one candidate', () => {
  const out = extractCompletionCandidates('Phase 2 部署完了。', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].lang, 'zh');
});

test('4. negation — "我还没部署完" emits zero candidates', () => {
  const out = extractCompletionCandidates('我还没部署完，先验证一下。', lex);
  assert.equal(out.length, 0);
});

test('5. future tense — "going to ship the auth refactor" emits zero', () => {
  const out = extractCompletionCandidates('I am going to ship the auth refactor next week.', lex);
  assert.equal(out.length, 0);
});

test('6. multi-sentence — only the completed sentence emits', () => {
  const text = '做完了 task A. 还没部署 task B.';
  const out = extractCompletionCandidates(text, lex);
  assert.equal(out.length, 1);
  assert.ok(/做完了/.test(out[0].phrase));
});

test('7. no-match — "Hello world how are you" emits zero', () => {
  const out = extractCompletionCandidates('Hello world how are you today?', lex);
  assert.equal(out.length, 0);
});

test('8. explicit task id — "task: ratatoskr-v2-task-cognitive-touch shipped" extracts id', () => {
  const out = extractCompletionCandidates('task: ratatoskr-v2-task-cognitive-touch shipped successfully.', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw_id_hint, 'ratatoskr-v2-task-cognitive-touch');
  assert.ok(out[0].confidence_pre >= 0.85);
});

test('9. confidence ≥0.7 when past-tense marker present without explicit id', () => {
  const out = extractCompletionCandidates('Auth refactor completed.', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].raw_id_hint, null);
  assert.ok(out[0].confidence_pre >= 0.7);
});

test('10. one match per segment — "shipped done deployed" yields 1 not 3', () => {
  const out = extractCompletionCandidates('Sprint shipped done deployed.', lex);
  assert.equal(out.length, 1);
});

test('11. zh colloquial — "搞掂咗" matches via 搞掂', () => {
  const out = extractCompletionCandidates('呢个工程搞掂晒。', lex);
  assert.equal(out.length, 1);
  assert.equal(out[0].lang, 'zh');
});

test('12. multi-paragraph — newline boundary respected; two completions = two candidates', () => {
  const text = 'L0 跑通了\n\nPhase 6 也实装完毕。';
  const out = extractCompletionCandidates(text, lex);
  assert.equal(out.length, 2);
});

test('grammar-gate utility — "will ship" with word boundary detected', () => {
  const lex2 = loadLexicon();
  assert.equal(_internal.isNegated('will ship the feature', lex2), true);
  assert.equal(_internal.isNegated('willing to consider', lex2), false, 'willing should not match "will "');
});

test('segmenter — handles CJK punctuation and ASCII punctuation', () => {
  const segs = _internal.segmentText('A 完成了。B finished.\n\nC done.');
  assert.equal(segs.length, 3);
});

test('scoreCandidate — explicit id wins over past-tense bonus', () => {
  const s1 = _internal.scoreCandidate('shipped', { kind: 'explicit', value: 'foo' });
  const s2 = _internal.scoreCandidate('shipped', null);
  assert.ok(s1 > s2);
  assert.ok(s1 >= 0.85);
});

test('lexicon loader — missing file returns empty lexicon, never throws', () => {
  const lex2 = loadLexicon('/tmp/nonexistent-lexicon-xyz.json');
  assert.ok(Array.isArray(lex2.completion_phrases));
  assert.ok(Array.isArray(lex2.negation_prefixes));
});
