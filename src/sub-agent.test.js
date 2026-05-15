// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubAgentManager } from './sub-agent.js';

function makeFakeDb() {
  return {
    prepare(sql) {
      if (sql.includes('INSERT INTO api_calls')) {
        return { run() {} };
      }
      return {
        get() { return null; },
        all() { return []; },
        run() { return { changes: 0 }; },
      };
    },
  };
}

test('technical sub-agent uses clean technical prompt and targeted file retrieval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-tech-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'logs'), { recursive: true });
    writeFileSync(join(root, 'src', 'agent-runtime.js'), [
      'export function toolBug(messages) {',
      '  const toolResult = messages.find(m => m.role === "tool");',
      '  return toolResult?.tool_call_id || toolResult?.toolCallId || null;',
      '}',
    ].join('\n'));
    writeFileSync(join(root, 'logs', 'runtime.log'), 'messages.39.content.0.tool_result.tool_use_id: Field required\n');

    let captured = null;
    const llm = {
      async chat(messages) {
        captured = messages;
        return {
          content: 'Findings\n- observed missing tool_use_id\nRoot Cause\n- field drift\nFix\n- normalize ids',
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          model: 'test-model',
        };
      },
    };

    const manager = new SubAgentManager({
      engine: {},
      llm,
      db: makeFakeDb(),
      config: { projectRoot: root, maxTechnicalFiles: 4, maxTechnicalContextBytes: 12000 },
    });

    const result = await manager.runTechnicalTask('Locate root cause of tool_use_id loss and provide minimal fix', {
      query: 'tool_use_id agent runtime',
      files: ['src/agent-runtime.js'],
      includeLogs: true,
    });

    assert.match(result.result, /Root Cause/);
    assert.ok(result.matchedFiles.some(f => f.includes('src/agent-runtime.js')));
    assert.ok(captured, 'LLM should have been called');
    assert.match(captured[0].content, /No persona|purely technical/i);
    assert.match(captured[1].content, /Technical Context/);
    assert.match(captured[1].content, /agent-runtime\.js/);
    assert.match(captured[1].content, /tool_use_id/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('technical patch agent uses patch-focused prompt and returns matched files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-patch-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'doctor.js'), [
      'export function recoverTask(id) {',
      '  return `recover:${id}`;',
      '}',
    ].join('\n'));

    let captured = null;
    const llm = {
      async chat(messages) {
        captured = messages;
        return {
          content: 'Findings\n- stale task found\nRoot Cause\n- missing recovery\nPatch Plan\n- add reclaim step\nPatch Sketch\n```diff\n+ recoverQueuedTasks()\n```\nVerification\n- run doctor\nRollback\n- revert helper',
          usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
          model: 'patch-model',
        };
      },
    };

    const manager = new SubAgentManager({
      engine: {},
      llm,
      db: makeFakeDb(),
      config: { projectRoot: root, maxTechnicalFiles: 4, maxTechnicalContextBytes: 12000, enableBackgroundWorker: false },
    });

    const result = await manager.runTechnicalPatchTask('Provide minimal safe patch for task recovery chain', {
      files: ['src/doctor.js'],
      query: 'recover task doctor',
    });

    assert.match(result.result, /Patch Plan/);
    assert.ok(result.matchedFiles.some(f => f.includes('src/doctor.js')));
    assert.ok(captured, 'LLM should have been called');
    assert.match(captured[0].content, /patch agent/i);
    assert.match(captured[1].content, /Candidate Files|Technical Context/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
