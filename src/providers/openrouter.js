// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenRouter adapter — speaks OpenAI chat-completions wireFormat at /chat/completions.
// Reuses ./openai.js transport. listModels reads /api/v1/models for the catalog.

import { register } from './_registry.js';
import { transport as openaiTransport } from './openai.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function withDefaults(opts) {
  return {
    ...opts,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
  };
}

export async function doGenerate(opts) {
  return openaiTransport.doGenerate(withDefaults(opts));
}

export async function* doStream(opts) {
  yield* openaiTransport.doStream(withDefaults(opts));
}

export function classifyError(err) {
  return openaiTransport.classifyError(err);
}

export async function healthCheck({ baseUrl, apiKey } = {}) {
  return openaiTransport.healthCheck({
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    apiKey,
  });
}

export const knownModels = [];

export const setupGuide = {
  apiKeyUrl: 'https://openrouter.ai/keys',
  baseUrlPlaceholder: 'https://openrouter.ai/api/v1 (default)',
  helpText: 'OpenRouter forwards to many providers — pick any catalog id (e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o).',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${root}/models`;
  try {
    const headers = {};
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.data)) return null;
    return data.data
      .map((m) => ({ id: m.id, label: m.name || m.id }))
      .filter((m) => m.id);
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'openrouter',
  wireFormat: 'openai-completions',
  authEnvVar: 'OPENROUTER_API_KEY',
  capabilities: {
    tools: true,
    streaming: true,
    systemPos: 'message',
    maxTokensRequired: false,
    promptCache: false,
  },
  knownModels,
  setupGuide,
  listModels,
  doGenerate,
  doStream,
  classifyError,
  healthCheck,
});

export default adapter;
