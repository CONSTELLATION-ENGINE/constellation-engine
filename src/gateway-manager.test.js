// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeOpenAICompatibleGateway } from './gateway-manager.js';

test('probeOpenAICompatibleGateway marks healthy OpenAI-compatible gateway', async () => {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).endsWith('/v1/models')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ data: [] }); } };
    }
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ id: 'x', object: 'chat.completion', model: 'claude-sonnet-4-20250514', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }); },
    };
  };
  const result = await probeOpenAICompatibleGateway({ baseUrl: 'http://127.0.0.1:8317/v1', apiKey: 'abc', model: 'claude-sonnet-4-20250514' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].url), /\/v1\/chat\/completions$/);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer abc');
});
