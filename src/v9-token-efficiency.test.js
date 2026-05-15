// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from './agent-runtime.js';
import { ToolManager } from './tool-manager.js';
import { LLMRouter } from './llm-router.js';

function makeEngine() {
  return {
    db: {
      prepare() { return { all: () => [], get: () => null, run: () => ({ changes: 0 }) }; },
    },
    renderSync(query) {
      return { text: `rendered:${query}`, nodes: [] };
    },
    stats() { return { active: 0 }; },
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

test('agent runtime reuses identical cache-safe tool calls within a turn', async () => {
  const session = new FakeSessionManager();
  let execCount = 0;
  const tools = {
    getDefinitions() { return [{ type: 'function', function: { name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]; },
    isCacheSafeTool(name) { return name === 'lookup'; },
    async executeStructured(name, input) {
      execCount += 1;
      return {
        name,
        ok: true,
        content: `RESULT:${input.q}`,
        error: null,
        meta: { elapsedMs: 3, resultBytes: 9 },
      };
    },
  };
  let chatCount = 0;
  const llm = {
    async chat() {
      chatCount += 1;
      if (chatCount === 1) return { content: 'checking', toolCalls: [{ id: 'tool-1', name: 'lookup', input: { q: 'same' } }], usage: { inputTokens: 10, outputTokens: 5 } };
      if (chatCount === 2) return { content: 'double check', toolCalls: [{ id: 'tool-2', name: 'lookup', input: { q: 'same' } }], usage: { inputTokens: 10, outputTokens: 5 } };
      return { content: 'done', usage: { inputTokens: 5, outputTokens: 5 } };
    },
  };

  const runtime = new AgentRuntime({
    engine: makeEngine(),
    sessionManager: session,
    llm,
    tools,
    config: {
      fixedRatio: 0.25,
      constellationRatio: 0.25,
      summaryRatio: 0.25,
      activeRatio: 0.25,
      fixedFiles: [],
      maxToolRounds: 5,
    },
  });

  const result = await runtime.turn('tg:1', 'find it');
  assert.equal(execCount, 1);
  assert.equal(result.toolCacheHits, 1);
  assert.match(session.messages.find(m => m.role === 'tool' && m.tool_call_id === 'tool-2')?.content || '', /Tool Cache Hit/);
});

test('tool_search auto-activation is capped to avoid tool definition bloat', async () => {
  const tools = new ToolManager(makeEngine(), { deferLoading: true, toolSearchThreshold: 1, maxAutoActivateTools: 2 });
  const result = await tools.execute('tool_search', { query: 'browser', activate: true, limit: 8 }, { sessionId: 'tg:1' });
  const activated = tools.getActivatedTools('tg:1');
  assert.ok(activated.length <= 2);
  assert.match(result, /Activated for this session:/);
});

test('llm router splits stable and dynamic system prompt for prompt caching', async () => {
  const router = new LLMRouter({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    provider: 'anthropic',
    primaryModel: 'claude-sonnet-4-20250514',
  });

  const originalFetch = globalThis.fetch;
  let capturedBody = null;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'end_turn',
        };
      },
    };
  };

  try {
    await router.chat([
      { role: 'system', content: 'stable block\n\n<!-- SYSTEM_CACHE_BREAK -->\n\ndynamic block' },
      { role: 'user', content: 'hello' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Array.isArray(capturedBody.system), true);
  assert.equal(capturedBody.system.length, 2);
  assert.deepEqual(capturedBody.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(capturedBody.system[1].cache_control, undefined);
});
