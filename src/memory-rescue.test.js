import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMemoryRescueTermBundle,
  extractMemoryRescueTerms,
  renderMemoryRescueSection,
  scoreMemoryRescueTrigger,
} from './memory-rescue.js';

test('memory rescue trigger fires on named entity plus weak recall', () => {
  const result = scoreMemoryRescueTrigger({
    query: 'Polanyi Great Transformation embeddedness money theory',
    episodicStats: { segments: 2, chars: 220, top_rerank: 0.1 },
    poolFallback: false,
    topPoolIds: ['soul-core', 'grand-synthesis'],
  });
  assert.equal(result.shouldRun, true);
  assert.ok(result.score >= 3.2);
  assert.ok(result.reasons.includes('named_or_technical_entity'));
  assert.ok(result.reasons.includes('episodic_low_confidence'));
});

test('memory rescue trigger fires on pool fallback plus project-state query', () => {
  const result = scoreMemoryRescueTrigger({
    query: 'How did we disable the Social Radar scheduler with SOCIAL_RADAR_AUTO earlier?',
    episodicStats: { segments: 0, chars: 0 },
    poolFallback: true,
    poolDynamicCount: 0,
    topPoolIds: ['soul-core'],
  });
  assert.equal(result.shouldRun, true);
  assert.ok(result.reasons.includes('pool_fallback'));
  assert.ok(result.reasons.includes('project_state'));
});

test('memory rescue trigger suppresses simple acknowledgements', () => {
  const result = scoreMemoryRescueTrigger({
    query: 'ok',
    episodicStats: { segments: 0, chars: 0 },
    poolFallback: true,
  });
  assert.equal(result.shouldRun, false);
  assert.ok(result.reasons.includes('query_too_short'));
});

test('memory rescue trigger suppresses simple greetings even on pool fallback', () => {
  const result = scoreMemoryRescueTrigger({
    query: 'Hello, who are you?',
    episodicStats: { segments: 0, chars: 0 },
    poolFallback: true,
  });
  assert.equal(result.shouldRun, false);
  assert.ok(result.reasons.includes('simple_greeting_suppressed'));
});

test('memory rescue extracts technical and code-like terms', () => {
  const terms = extractMemoryRescueTerms('Check `SOCIAL_RADAR_AUTO`, social-radar.disabled, and Sleipnir Gate');
  assert.ok(terms.some(t => t.includes('SOCIAL_RADAR_AUTO')));
  assert.ok(terms.some(t => t.includes('social-radar.disabled')));
  assert.ok(terms.some(t => /Sleipnir Gate/i.test(t)));
});

test('memory rescue separates entities from recall intent phrases', () => {
  const bundle = extractMemoryRescueTermBundle('I just remembered that we previously added an LLM and IR prompt reminder for low relevance memory recall and manual deep recall; can you check whether it still exists?');
  assert.ok(bundle.entities.includes('LLM'));
  assert.ok(bundle.entities.includes('IR'));
  assert.ok(bundle.intentPhrases.some(t => /previously/i.test(t)));
  assert.ok(bundle.intentPhrases.some(t => /low relevance/i.test(t)));
  assert.equal(bundle.searchTerms.some(t => /I just remembered/i.test(t)), false);
  assert.equal(bundle.searchTerms.some(t => /can you check/i.test(t)), false);
});

test('memory rescue render includes selected star and conversation candidates', () => {
  const section = renderMemoryRescueSection({
    judge: {
      parsed: {
        quality: 'excellent',
        summary: 'Directly recovered missing memories.',
        selected: [
          { key: 'S1', id: 'polanyi-node', relevance: 0.94, why: 'Direct Polanyi node.' },
          { key: 'C1', id: 'msg9', relevance: 0.88, why: 'Recent scheduler shutdown.' },
        ],
      },
    },
    starRows: [{ source: 'star', id: 'polanyi-node', l0: 'Polanyi embedded economy', l1: 'Money is a fictitious commodity.' }],
    convRows: [{ source: 'conversation', id: 9, timestamp: '2026-06-01T09:00:00Z', content: 'Social Radar scheduler disabled with SOCIAL_RADAR_AUTO gate.' }],
  });
  assert.ok(section.text.includes('Anamnesis Memory Rescue'));
  assert.ok(section.text.includes('Star:polanyi-node'));
  assert.ok(section.text.includes('Conversation:msg9'));
  assert.equal(section.selectedCount, 2);
});

test('memory rescue render drops low-relevance selected candidates', () => {
  const section = renderMemoryRescueSection({
    judge: {
      parsed: {
        quality: 'mixed',
        selected: [
          { key: 'S1', id: 'direct-node', relevance: 0.82, why: 'Direct hit.' },
          { key: 'S2', id: 'adjacent-node', relevance: 0.42, why: 'Only adjacent background.' },
        ],
      },
    },
    starRows: [
      { source: 'star', id: 'direct-node', l0: 'Direct memory', l1: 'Useful content.' },
      { source: 'star', id: 'adjacent-node', l0: 'Adjacent memory', l1: 'Noisy background.' },
    ],
    convRows: [],
  });
  assert.ok(section.text.includes('Star:direct-node'));
  assert.equal(section.text.includes('Star:adjacent-node'), false);
  assert.equal(section.selectedCount, 1);
});
