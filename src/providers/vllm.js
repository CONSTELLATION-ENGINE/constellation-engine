// SPDX-License-Identifier: AGPL-3.0-or-later
// vLLM adapter — speaks OpenAI chat-completions wireFormat at /v1/chat/completions.
// Reuses ./openai.js transport. Self-hosted GPU server; optional bearer token
// (--api-key on vllm serve).

import { register } from './_registry.js';
import { transport as openaiTransport } from './openai.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';

function withDefaults(opts) {
  return {
    ...opts,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
    apiKey: opts.apiKey || undefined,
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
  apiKeyUrl: 'https://docs.vllm.ai/',
  baseUrlPlaceholder: 'http://127.0.0.1:8000/v1 (default)',
  helpText: 'Run `vllm serve <model>`. If you started it with --api-key, paste that token; otherwise leave blank.',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${root}/models`;
  try {
    const headers = {};
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.data)) return null;
    return data.data
      .map((m) => ({ id: m.id, label: m.id }))
      .filter((m) => m.id);
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'vllm',
  wireFormat: 'openai-completions',
  authEnvVar: 'VLLM_API_KEY',
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
