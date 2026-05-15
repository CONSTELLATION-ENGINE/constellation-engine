// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanTokenWaste } from './doctor.js';
import { AgentRuntime } from './agent-runtime.js';
import { SubAgentManager } from './sub-agent.js';

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

function makeToolDef(name) {
  return [{ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
}

class FakeWasteDb {
  constructor() {
    this.turnCols = [
      'id','session_id','stage','status','tool_call_count','tool_cache_hits','suppressed_tool_calls',
      'total_tokens','tool_result_bytes','planner_guardrail_hits','stop_reason','updated_at',
    ];
    this.messageCols = ['role','session_id','content','tool_name','tool_result_bytes','tool_ok'];
  }
  prepare(sql) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    return {
      all: (...args) => {
        if (normalized.startsWith('PRAGMA table_info(turn_journal)')) {
          return this.turnCols.map(name => ({ name }));
        }
        if (normalized.startsWith('PRAGMA table_info(messages)')) {
          return this.messageCols.map(name => ({ name }));
        }
        if (normalized.includes('FROM turn_journal t') && normalized.includes('ORDER BY (')) {
          return [{
            id: 'turn-1', session_id: 'tg:test', stage: 'token_safety_valve', status: 'completed',
            tool_call_count: 6, tool_cache_hits: 0, suppressed_tool_calls: 1,
            total_tokens: 120000, tool_result_bytes: 50000, planner_guardrail_hits: 1,
            stop_reason: 'token_safety_valve', updated_at: '2026-03-14', cache_hit_ratio: 0,
          }];
        }
        if (normalized.includes('FROM turn_journal t') && normalized.includes('GROUP BY t.session_id')) {
          return [{ session_id: 'tg:test', tool_calls: 6, cache_hits: 0, cache_hit_ratio: 0, total_tokens: 120000 }];
        }
        if (normalized.includes('FROM pending_tool_runs p')) {
          return [{ session_id: 'tg:test', tool_name: 'memory_search', tool_input_json: '{"q":"same-key"}', calls: 2, turns: 1, completed: 1 }];
        }
        if (normalized.includes('FROM messages m')) {
          return [{ tool_name: 'memory_search', rows: 2, total_bytes: 3000, avg_bytes: 1500, errors: 0 }];
        }
        return [];
      },
      get: () => null,
      run: () => ({ changes: 0 }),
    };
  }
}

test('token waste doctor surfaces repeated tool patterns and near-valve turns', () => {
  const report = scanTokenWaste(new FakeWasteDb(), { sessionId: 'tg:test', limit: 10 });
  assert.equal(report.nearValveCount, 1);
  assert.ok(report.repeatedToolPatternCount >= 1);
  assert.equal(report.bloatedTools[0].tool_name, 'memory_search');
});

test('planner guardrail suppresses repeated tool plans and forces direct answer', async () => {
  const session = new FakeSessionManager();
  const tools = {
    getDefinitions() { return makeToolDef('lookup'); },
    isCacheSafeTool() { return false; },
    async executeStructured(name, input) {
      return {
        name,
        ok: true,
        content: `LOOKUP:${input.q}`,
        error: null,
        meta: { elapsedMs: 2, resultBytes: 16 },
      };
    },
  };
  let plannerCalls = 0;
  let mainCalls = 0;
  const llm = {
    config: { compactModel: 'compact-test' },
    async chat(messages, options = {}) {
      if (options._trigger === 'planner-guardrail') {
        plannerCalls += 1;
        return {
          content: JSON.stringify({
            need_tools: true,
            candidate_tools: ['lookup'],
            next_step: 'inspect identical lookup path',
            loop_risk: plannerCalls >= 2 ? 'high' : 'low',
            confidence: 0.9,
          }),
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
      }
      mainCalls += 1;
      if (mainCalls === 1) {
        assert.equal(options.tools?.length, 1);
        return { content: 'first pass', toolCalls: [{ id: 'tool-1', name: 'lookup', input: { q: 'same' } }], usage: { inputTokens: 12, outputTokens: 6 } };
      }
      assert.ok(!options.tools || options.tools.length === 0, 'guardrail should remove tools on repeated plan');
      return { content: 'final summary without more tools', usage: { inputTokens: 8, outputTokens: 7 } };
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
      maxToolRounds: 4,
      plannerRepeatLimit: 1,
    },
  });

  const result = await runtime.turn('tg:guardrail', 'trace the repeated lookup loop');
  assert.equal(plannerCalls, 2);
  assert.equal(result.toolRounds, 1);
  assert.match(result.response, /final summary/i);
  const guardrailPatch = session.turns.find(t => t.patch?.plannerGuardrailHits > 0 || t.patch?.stopReason === 'planner_repeat_guardrail');
  assert.ok(guardrailPatch, 'planner guardrail stats should be persisted to the turn journal');
});

test('technical patch agent includes symbol index, import graph, call sites, and verification harness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-intel-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'b.js'), [
      'export function findBug(input) {',
      '  return input?.tool_call_id || null;',
      '}',
    ].join('\n'));
    writeFileSync(join(root, 'src', 'a.js'), [
      "import { findBug } from './b.js';",
      'export function run(messages) {',
      '  return findBug(messages[0]);',
      '}',
    ].join('\n'));
    writeFileSync(join(root, 'src', 'c.js'), [
      "import { run } from './a.js';",
      'export function handler(messages) {',
      '  return run(messages);',
      '}',
    ].join('\n'));

    let captured = null;
    const llm = {
      async chat(messages) {
        captured = messages;
        return {
          content: 'Findings\n- symbol map captured\nPatch Sketch\n```diff\n+ normalizeToolCallId()\n```',
          usage: { promptTokens: 150, completionTokens: 80, totalTokens: 230 },
          model: 'patch-model',
        };
      },
    };

    const manager = new SubAgentManager({
      engine: {},
      llm,
      db: { prepare() { return { get() { return null; }, all() { return []; }, run() { return { changes: 0 }; } }; } },
      config: { projectRoot: root, maxTechnicalFiles: 4, maxTechnicalContextBytes: 16000, enableBackgroundWorker: false },
    });

    const result = await manager.runTechnicalPatchTask('Fix tool_call_id drift and provide minimal diff', {
      files: ['src/a.js', 'src/b.js'],
      query: 'findBug tool_call_id run',
    });

    assert.match(result.result, /Patch Sketch/);
    assert.ok(captured, 'LLM should have been called');
    const prompt = captured[1].content;
    assert.match(prompt, /Code Intelligence/);
    assert.match(prompt, /Symbol Index/);
    assert.match(prompt, /Import Graph/);
    assert.match(prompt, /Call Sites/);
    assert.match(prompt, /Verification Harness/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
