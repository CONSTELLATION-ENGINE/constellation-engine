// SPDX-License-Identifier: AGPL-3.0-or-later
// Custom OpenAI-compatible adapter — point at any /v1/chat/completions endpoint
// (local proxy, OAuth bridge, third-party relay). Reuses ./openai.js transport.
// Most local bridges accept any non-empty Authorization header; if no key is
// provided we forward the literal "local" sentinel so adapters that *require*
// a header still get one.

import { register } from './_registry.js';
import { transport as openaiTransport } from './openai.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';
const KEYLESS_SENTINEL = 'local';

function withDefaults(opts) {
  return {
    ...opts,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
    apiKey: opts.apiKey && opts.apiKey.trim() ? opts.apiKey : KEYLESS_SENTINEL,
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
    apiKey: apiKey || KEYLESS_SENTINEL,
  });
}

export const knownModels = [];

export const setupGuide = {
  apiKeyUrl: null,
  baseUrlPlaceholder: 'http://127.0.0.1:8080/v1',
  helpText: 'Free-text base URL + model. Most local bridges accept any non-empty key — leave the field blank to use a "local" sentinel.',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${root}/models`;
  try {
    const headers = { authorization: `Bearer ${apiKey || KEYLESS_SENTINEL}` };
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
  id: 'custom',
  wireFormat: 'openai-completions',
  authEnvVar: 'CUSTOM_OPENAI_API_KEY',
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
