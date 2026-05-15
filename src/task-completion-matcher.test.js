// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for task-completion-matcher.js — runs under `node --test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchActiveTasks,
  matchActiveTasksBge,
  tokenize,
  _internal,
} from './task-completion-matcher.js';

const sampleTasks = [
  { id: 'ratatoskr-v2-task-cognitive-touch', title: 'Ratatoskr v2 — TASK_TOUCH + COGNITIVE_TOUCH 主体' },
  { id: 'sleipnir-step6-shipped', title: 'Sleipnir Step 6 hybrid promotion' },
  { id: 'multi-sa-reactivation-closure', title: 'Multi-SA reactivation phase 4 closure' },
  { id: 'auth-refactor', title: 'Auth refactor to remove session token storage' },
  { id: 'opensource-prep', title: 'Open source preparation master plan' },
];

test('1. exact id match — rawIdHint hits task.id directly', () => {
  const r = matchActiveTasks('sleipnir-step6-shipped', 'shipped', sampleTasks);
  assert.equal(r?.task_id, 'sleipnir-step6-shipped');
  assert.equal(r?.mode, 'exact_id');
  assert.equal(r?.score, 1.0);
});

test('2. token overlap on title — "shipped Step 6" → sleipnir-step6-shipped', () => {
  const r = matchActiveTasks(null, 'shipped Step 6 hybrid', sampleTasks);
  assert.equal(r?.task_id, 'sleipnir-step6-shipped');
  assert.equal(r?.mode, 'title_jaccard');
});

test('3. ambiguous short id — "ratatoskr v2 部署完了" matches via title tokens', () => {
  const r = matchActiveTasks(null, 'ratatoskr v2 部署完了', sampleTasks);
  assert.equal(r?.task_id, 'ratatoskr-v2-task-cognitive-touch');
});

test('4. no match — phrase shares no tokens with any title', () => {
  const r = matchActiveTasks(null, 'pizza dinner finished', sampleTasks);
  assert.equal(r, null);
});

test('5. colloquial — "搞掂咗 multi-sa" matches via shared tokens', () => {
  const r = matchActiveTasks(null, '搞掂咗 multi-sa', sampleTasks);
  assert.equal(r?.task_id, 'multi-sa-reactivation-closure');
});

test('6. typo in id — falls through to title match', () => {
  const r = matchActiveTasks('ratatosker-v2', 'ratatoskr v2 task touch shipped', sampleTasks);
  // Mode 1 fails (typo); Mode 2 picks up via title.
  assert.equal(r?.task_id, 'ratatoskr-v2-task-cognitive-touch');
  assert.equal(r?.mode, 'title_jaccard');
});

test('7. BGE-only — small task set returns null without invoking embed', async () => {
  let called = 0;
  const r = await matchActiveTasksBge('something obscure', sampleTasks, async () => { called++; return [1]; });
  assert.equal(r, null);
  assert.equal(called, 0, 'BGE skipped when active<20');
});

test('8. BGE — large task set picks highest cos above threshold', async () => {
  // Synthetic 20 tasks; embeds are stubbed: phrase=1.0 only matches task[5].
  const tasks = Array.from({ length: 25 }, (_, i) => ({ id: `t-${i}`, title: `task title ${i}` }));
  // Stub: phrase hash 'x', titles hash to (i / 25). cos similarity by hash equality.
  const embedFn = async (text) => {
    if (text === 'x') return [1, 0];
    const m = /(\d+)/.exec(text);
    const i = m ? Number(m[1]) : 0;
    // Match only when i==17 (cos==1), all others ~0.5
    return i === 17 ? [1, 0] : [0.5, Math.sqrt(0.75)];
  };
  const r = await matchActiveTasksBge('x', tasks, embedFn);
  assert.equal(r?.task_id, 't-17');
  assert.equal(r?.mode, 'bge');
  assert.ok(r.score >= 0.72);
});

test('tokenize — CJK chars split per-character, ASCII splits on punctuation', () => {
  const t = tokenize('shipped step-6 部署完了');
  assert.ok(t.includes('shipped'));
  assert.ok(t.includes('step'));
  assert.ok(t.includes('6'));
  assert.ok(t.includes('部'));
  assert.ok(t.includes('署'));
});

test('tokenize — stopwords filtered, single chars/empties dropped', () => {
  const t = tokenize('the of and shipped');
  assert.deepEqual(t, ['shipped']);
});

test('cosine similarity — orthogonal=0, identical≈1, mismatched-length=0', () => {
  assert.equal(_internal.cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(_internal.cosineSimilarity([1, 1], [1, 1]) - 1) < 1e-9);
  assert.equal(_internal.cosineSimilarity([1], [1, 0]), 0);
});

test('matcher — empty active list returns null', () => {
  assert.equal(matchActiveTasks('any', 'shipped', []), null);
});

test('B2 regression — single-char CJK overlap must not match', () => {
  // "做完了" tokens (after CJK split + filter) = ["做","完","了" stop?]; assume "完" remains.
  // A title containing only "完" overlap should NOT trigger a match.
  const tasks = [
    { id: 'opensource-default-crons', title: '完成 default crons' },
    { id: 'unrelated-task', title: 'something else entirely' },
  ];
  const r = matchActiveTasks(null, '做完了', tasks);
  assert.equal(r, null, 'one-char CJK overlap must not produce a match');
});
