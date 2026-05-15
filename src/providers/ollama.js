// SPDX-License-Identifier: AGPL-3.0-or-later
// Ollama adapter — speaks OpenAI chat-completions wireFormat at /v1/chat/completions.
// Reuses ./openai.js transport with Ollama-specific id, defaults, and version probe.
// Ollama supports tool_calls only on v0.4+; healthCheck downgrades capabilities.tools
// to false if the running daemon is older.

import { register } from './_registry.js';
import { transport as openaiTransport } from './openai.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';

function withDefaults(opts) {
  return {
    ...opts,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
    // Ollama doesn't require an API key; pass undefined so the shared transport
    // skips the Authorization header rather than sending a malformed one.
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

function parseSemver(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export async function healthCheck({ baseUrl } = {}) {
  // Ollama exposes /api/version (NOT under /v1). Strip the /v1 suffix to probe it.
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '').replace(/\/v1$/, '');
  const url = `${root}/api/version`;
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const version = data?.version || '';
    const parsed = parseSemver(version);
    const supportsTools = parsed ? (parsed.major > 0 || parsed.minor >= 4) : false;
    // Refine the registered capability so the router gates tool routing correctly.
    // Default registered value is optimistic `true`; downgrade if probe says otherwise.
    if (adapter && adapter.capabilities) {
      adapter.capabilities.tools = supportsTools;
    }
    // Also list installed models via /api/tags so the wizard can render them.
    let models = [];
    try {
      const tagsResp = await fetch(`${root}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(5000) });
      if (tagsResp.ok) {
        const tagsData = await tagsResp.json();
        models = Array.isArray(tagsData?.models) ? tagsData.models.map((m) => m.name || m.model).filter(Boolean) : [];
      }
    } catch {
      // tags is best-effort
    }
    return { ok: true, version, models, supportsTools };
  } catch (err) {
    return { ok: false, error: err?.message || 'health check failed' };
  }
}

export const knownModels = [
  { id: 'llama3.3',     label: 'Llama 3.3 70B (recommended)',  tier: 'recommended' },
  { id: 'llama3.2:3b',  label: 'Llama 3.2 3B (fast, small)',    tier: 'fast' },
  { id: 'qwen2.5',      label: 'Qwen 2.5 7B (multilingual)',   tier: 'balanced' },
  { id: 'mistral',      label: 'Mistral 7B (general purpose)', tier: 'balanced' },
];

export const setupGuide = {
  apiKeyUrl: 'https://ollama.com/download',
  baseUrlPlaceholder: 'http://127.0.0.1:11434/v1 (default)',
  helpText: 'Ollama runs locally — no API key required. Install Ollama, then pull a model with: ollama pull llama3.3',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ baseUrl } = {}) {
  // Ollama exposes /api/tags (NOT under /v1). Strip /v1 to probe.
  const root = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '').replace(/\/v1$/, '');
  try {
    const resp = await fetch(`${root}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.models)) return null;
    return data.models
      .map((m) => ({ id: m.name || m.model, label: m.name || m.model }))
      .filter((m) => m.id);
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'ollama',
  wireFormat: 'openai-completions',
  authEnvVar: null, // local daemon, no key required
  capabilities: {
    tools: true, // optimistic; healthCheck refines based on /api/version
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
