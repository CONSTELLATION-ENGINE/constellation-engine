// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public test suite — headless surface only. The full dashboard-route test
// ("Dashboard health summary exposes structured tool metrics") lives in the
// private constellation-dashboard repo, since it asserts on routes that the
// public stub dashboard returns 503 for. See:
//   engine-output/architecture-research/2026-05-15-dashboard-separation-option-b-stub.md
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SessionManager } from './session.js';
import { ToolManager } from './tool-manager.js';

function makeEngine() {
  return {
    stats() { return { active: 0 }; },
    rememberSync() { return 'node-1'; },
    querySync() { return []; },
    searchMemory() { return []; },
  };
}

test('SessionManager persists structured tool observability fields', () => {
  const db = new Database(':memory:');
  const session = new SessionManager(db);
  const sid = 's-observe';

  session.addMessage(sid, { role: 'user', content: 'hi' });
  session.addMessage(sid, {
    role: 'tool',
    content: 'done',
    tool_call_id: 'tool-1',
    tool_name: 'web_fetch',
    tool_ok: true,
    tool_latency_ms: 123,
    tool_result_bytes: 456,
    tool_error_code: null,
    tool_batch_id: 'assistant-42',
    tool_round: 2,
  });

  const msg = session.getActiveMessages(sid).at(-1);
  assert.equal(msg.toolCallId, 'tool-1');
  assert.equal(msg.toolName, 'web_fetch');
  assert.equal(msg.toolOk, true);
  assert.equal(msg.toolLatencyMs, 123);
  assert.equal(msg.toolResultBytes, 456);
  assert.equal(msg.toolBatchId, 'assistant-42');
  assert.equal(msg.toolRound, 2);
});

test('ToolManager executeStructured returns structured success and error envelopes', async () => {
  const tools = new ToolManager(makeEngine(), {});
  tools.register({
    name: 'explode',
    description: 'boom',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const err = new Error('fetch failed upstream');
      err.code = 'ECONNRESET';
      throw err;
    },
  });

  const ok = await tools.executeStructured('constellation_stats', {});
  assert.equal(ok.ok, true);
  assert.equal(typeof ok.content, 'string');
  assert.ok(ok.meta.resultBytes >= 0);

  const bad = await tools.executeStructured('explode', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.type, 'network_error');
  assert.match(bad.content, /\[Tool Error:explode\]/);
});

test('Public dashboard stub serves /api/status with engine version', async () => {
  const { startDashboard } = await import('./dashboard.js');
  const port = 18839;
  const dash = startDashboard({ port, bootTime: Date.now() });
  await new Promise(r => setTimeout(r, 100));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.build, 'stub');
    assert.equal(data.dashboardUi, false);
    assert.equal(typeof data.engineVersion, 'string');
    assert.ok(data.uptimeMs >= 0);
  } finally {
    dash.close();
  }
});

test('Public dashboard stub returns 503 with route+hint for documented surfaces', async () => {
  const { startDashboard } = await import('./dashboard.js');
  const port = 18840;
  const dash = startDashboard({ port, bootTime: Date.now() });
  await new Promise(r => setTimeout(r, 100));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/wizard/check-environment`);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error, 'dashboard_stub');
    assert.equal(data.route, '/api/wizard/check-environment');
    assert.ok(data.hint);
    assert.ok(data.docs);
  } finally {
    dash.close();
  }
});
