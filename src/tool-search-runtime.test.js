// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolManager } from './tool-manager.js';
import { AgentRuntime } from './agent-runtime.js';

function makeFakeEngine() {
  return {
    db: {
      prepare(sql) {
        if (sql.includes('FROM nodes WHERE state=\'active\' AND lower(id) = lower(?)')) {
          return { all: (q) => q === 'incident-token-explosion-2026-03-13' ? [{ id: q, l0: 'Token explosion incident', l1: 'night audit', tags: '["incident","token-explosion"]', source: 'tool', access_count: 3 }] : [] };
        }
        if (sql.includes('FROM nodes n, json_each(n.tags)')) {
          return { all: () => [] };
        }
        if (sql.includes('LEFT JOIN json_each')) {
          return { all: () => [] };
        }
        if (sql.includes('FROM nodes_fts')) {
          return { all: () => [] };
        }
        return { all: () => [], get: () => null };
      },
    },
    renderSync(query) {
      return {
        text: `rendered:${query}`,
        nodes: query.includes('token-explosion') ? [{ id: 'incident-token-explosion-2026-03-13', l0: 'Token explosion incident', l1: 'night audit', tags: '["incident"]', source: 'tool', access_count: 2 }] : [],
      };
    },
    stats() { return { active: 1 }; },
    rememberSync(payload) { return payload.id; },
  };
}

class FakeSessionManager {
  constructor() {
    this.messages = [];
    this.turns = [];
    this.pending = [];
  }
  startTurn(sessionId, meta = {}) { const turn = { id: `turn-${this.turns.length + 1}`, sessionId, ...meta }; this.turns.push({ type: 'start', turn }); return turn; }
  updateTurn(turnId, patch = {}) { this.turns.push({ type: 'update', turnId, patch }); return { id: turnId, ...patch }; }
  finishTurn(turnId, patch = {}) { this.turns.push({ type: 'finish', turnId, patch }); return { id: turnId, ...patch }; }
  addMessage(sessionId, msg) { const row = { id: this.messages.length + 1, sessionId, ...msg }; this.messages.push(row); return row; }
  getSummary() { return ''; }
  getActiveMessages() { return []; }
  getActiveTokenCount() { return 0; }
  registerPendingToolRuns(...args) { this.pending.push(['register', ...args]); }
  completePendingToolRun(...args) { this.pending.push(['complete', ...args]); }
}

test('tool_search activates deferred tools for a session', async () => {
  const tools = new ToolManager(makeFakeEngine(), { deferLoading: true, toolSearchThreshold: 1 });
  const before = tools.getDefinitions({ sessionId: 'tg:1' }).map(t => t.function.name);
  assert.equal(before.includes('exec'), false);
  const result = await tools.execute('tool_search', { query: 'shell command', activate: true }, { sessionId: 'tg:1' });
  assert.match(result, /exec/);
  const after = tools.getDefinitions({ sessionId: 'tg:1' }).map(t => t.function.name);
  assert.equal(after.includes('exec'), true);
});

test('memory_search uses exact plus semantic-style reranking output', async () => {
  const tools = new ToolManager(makeFakeEngine(), { deferLoading: false });
  const result = await tools.execute('memory_search', { query: 'incident-token-explosion-2026-03-13', maxResults: 3 });
  assert.match(result, /incident-token-explosion-2026-03-13/);
  assert.match(result, /exact-id|semantic/);
  assert.match(result, /Rendered overview/);
});

test('agent runtime serializes turns per session and avoids polluting transcript with runtime errors', async () => {
  const session = new FakeSessionManager();
  let call = 0;
  const llm = {
    async chat() {
      call += 1;
      if (call === 1) {
        await new Promise(r => setTimeout(r, 40));
        return { content: 'first-ok', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      throw new Error('boom');
    },
    estimateTokens() { return 0; },
  };
  const runtime = new AgentRuntime({
    engine: makeFakeEngine(),
    sessionManager: session,
    llm,
    tools: { getDefinitions() { return []; } },
    config: { fixedRatio: 0.25, constellationRatio: 0.25, summaryRatio: 0.25, activeRatio: 0.25, fixedFiles: [] },
  });

  const [first, second] = await Promise.all([
    runtime.turn('tg:1', 'first'),
    runtime.turn('tg:1', 'second'),
  ]);

  assert.equal(first.response, 'first-ok');
  assert.match(second.response, /Runtime Error/);
  assert.deepEqual(session.messages.map(m => `${m.role}:${m.content}`), [
    'user:first',
    'assistant:first-ok',
    'user:second',
  ]);
});
