// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenAI Chat Completions adapter (openai-completions wireFormat).
// Reused for: openai, ollama, deepseek, qwen, kimi, zhipu — all
// providers speaking OpenAI's chat-completions wire format.

import {
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  AdapterError,
  classifyByStatus,
  normalizeMessages,
  extractSystemAndMessages,
  buildResponse,
} from './_contract.js';
import { register } from './_registry.js';

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'safety';
    default:
      return 'stop';
  }
}

function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  if (typeof toolChoice === 'object' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

function buildRequest(opts) {
  // Strip embedded system messages and merge with top-level opts.system, matching
  // anthropic/gemini handling. Without this, callers passing both forms get two
  // system messages on openai but one merged on the others.
  const { messages: rest, system: extractedSystem } = extractSystemAndMessages(normalizeMessages(opts.messages));
  const merged = [opts.system, extractedSystem].filter(Boolean).join('\n\n');
  const messages = merged ? [{ role: 'system', content: merged }, ...rest] : rest;
  const body = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (Array.isArray(opts.tools) && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
      },
    }));
    const tc = mapToolChoice(opts.toolChoice);
    if (tc !== undefined) body.tool_choice = tc;
  }
  if (Array.isArray(opts.stopSequences) && opts.stopSequences.length) {
    body.stop = opts.stopSequences;
  }
  return body;
}

function parseResponse(data, model) {
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  let content = '';
  if (typeof msg.content === 'string') content = msg.content;
  else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((c) => (typeof c === 'string' ? c : c?.text || ''))
      .join('');
  }
  const toolCalls = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function?.arguments || '' };
      }
      toolCalls.push({ id: tc.id, name: tc.function?.name || '', input });
    }
  }
  const usage = {
    promptTokens: data?.usage?.prompt_tokens || 0,
    completionTokens: data?.usage?.completion_tokens || 0,
    cacheRead: data?.usage?.prompt_tokens_details?.cached_tokens || 0,
    cacheWrite: 0,
  };
  usage.totalTokens = data?.usage?.total_tokens || (usage.promptTokens + usage.completionTokens);
  return buildResponse({
    content,
    toolCalls,
    usage,
    model: data?.model || model,
    finishReason: mapFinishReason(choice?.finish_reason),
  });
}

export async function doGenerate(opts) {
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  };

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequest(opts)),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    if (err?.name === 'AbortError') {
      throw new AdapterError('openai request aborted/timed out', { code: 'transient', providerId: 'openai' });
    }
    throw new AdapterError(err?.message || 'openai network error', { code: 'transient', providerId: 'openai', raw: err });
  }
  cleanup();

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AdapterError(`openai non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`, {
      code: classifyByStatus(resp.status),
      status: resp.status,
      providerId: 'openai',
    });
  }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
    throw new AdapterError(`openai ${resp.status}: ${msg}`, {
      code: classifyByStatus(resp.status, msg),
      status: resp.status,
      providerId: 'openai',
      raw: data,
    });
  }
  return parseResponse(data, opts.model);
}

export async function* doStream(opts) {
  // Phase A scaffold: single-chunk stream wrapper. Phase B router replaces
  // this with the existing #streamClaudeProxy SSE parser delegated through here.
  const response = await doGenerate(opts);
  if (response.content) yield { type: 'text_delta', text: response.content };
  if (response.toolCalls.length) yield { type: 'tool_call_delta', toolCalls: response.toolCalls };
  yield { type: 'finish', finishReason: response.finishReason, response };
}

export function classifyError(err) {
  if (err instanceof AdapterError) return err.code;
  const msg = err?.message || '';
  if (/abort|timeout/i.test(msg)) return 'transient';
  if (/content_filter/i.test(msg)) return 'fatal';
  return 'transient';
}

export async function healthCheck({ baseUrl, apiKey } = {}) {
  if (!baseUrl) return { ok: false, error: 'missing baseUrl' };
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  const headers = {};
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  try {
    const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const models = Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.message || 'health check failed' };
  }
}

export const knownModels = [
  { id: 'gpt-5',      label: 'GPT-5 (flagship)',                tier: 'premium' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini (balanced, recommended)', tier: 'recommended' },
  { id: 'gpt-5-nano', label: 'GPT-5 nano (fastest, cheapest)',   tier: 'fast' },
  { id: 'gpt-4o',     label: 'GPT-4o (legacy)',                  tier: 'legacy' },
];

export const setupGuide = {
  apiKeyUrl: 'https://platform.openai.com/api-keys',
  baseUrlPlaceholder: 'https://api.openai.com/v1 (default)',
  helpText: 'OpenAI API keys start with sk- or sk-proj-. The Test Connection step verifies the key works against your billing account.',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  if (!apiKey) return null;
  const url = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.data)) return null;
    return data.data
      .filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id))
      .map((m) => ({ id: m.id, label: m.id }));
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'openai',
  wireFormat: 'openai-completions',
  authEnvVar: 'OPENAI_API_KEY',
  capabilities: {
    tools: true,
    streaming: true,
    systemPos: 'message',
    maxTokensRequired: false,
    promptCache: true,
  },
  knownModels,
  setupGuide,
  listModels,
  doGenerate,
  doStream,
  classifyError,
  healthCheck,
});

// Expose internals so other openai-compat adapters (ollama, deepseek, qwen,
// kimi, zhipu) can re-use the same transport with different id / capability metadata.
export const transport = { doGenerate, doStream, classifyError, healthCheck };

export default adapter;
