// SPDX-License-Identifier: AGPL-3.0-or-later
// Native Anthropic Messages API adapter (anthropic-messages wireFormat).
// POST {baseUrl}/v1/messages with x-api-key + anthropic-version: 2023-06-01.

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  AdapterError,
  classifyByStatus,
  normalizeMessages,
  extractSystemAndMessages,
  buildResponse,
} from './_contract.js';
import { register } from './_registry.js';

export const ANTHROPIC_API_VERSION = '2023-06-01';

export function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'safety';
    default:
      return 'stop';
  }
}

export function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice === 'none') return undefined;
  if (typeof toolChoice === 'object' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name };
  }
  return undefined;
}

export function buildRequest(opts) {
  const { messages: rest, system: extractedSystem } = extractSystemAndMessages(normalizeMessages(opts.messages));
  const system = opts.system || extractedSystem || undefined;
  const body = {
    model: opts.model,
    messages: rest.map((m) => {
      // Anthropic content can be string or array of blocks; pass through
      if (typeof m.content === 'string') return { role: m.role, content: m.content };
      return { role: m.role, content: m.content };
    }),
    max_tokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
  };
  if (system) body.system = system;
  // tool_choice='none' must DROP tools entirely — Anthropic treats tools-present
  // without explicit tool_choice as `auto`, so the model would still call tools.
  const wantsTools = Array.isArray(opts.tools) && opts.tools.length && opts.toolChoice !== 'none';
  if (wantsTools) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema || t.parameters || { type: 'object', properties: {} },
    }));
    const tc = mapToolChoice(opts.toolChoice);
    if (tc) body.tool_choice = tc;
  }
  if (Array.isArray(opts.stopSequences) && opts.stopSequences.length) {
    body.stop_sequences = opts.stopSequences;
  }
  return body;
}

export function parseResponse(data, model) {
  let content = '';
  const toolCalls = [];
  if (Array.isArray(data?.content)) {
    for (const block of data.content) {
      if (block.type === 'text') content += block.text || '';
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  // Anthropic's input_tokens is fresh-only; include cacheRead so promptTokens
  // reflects total wire input (matches router's pre-B2 telemetry semantic).
  const inputTokens = data?.usage?.input_tokens || 0;
  const cacheRead = data?.usage?.cache_read_input_tokens || 0;
  const cacheWrite = data?.usage?.cache_creation_input_tokens || 0;
  const completionTokens = data?.usage?.output_tokens || 0;
  const promptTokens = inputTokens + cacheRead;
  const usage = {
    promptTokens,
    completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: promptTokens + completionTokens,
  };
  return buildResponse({
    content,
    toolCalls,
    usage,
    model: data?.model || model,
    finishReason: mapStopReason(data?.stop_reason),
  });
}

export async function doGenerate(opts) {
  const baseUrl = (opts.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
  const url = `${baseUrl}/v1/messages`;
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_API_VERSION,
  };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Track the listener so we can detach it after the request finishes; otherwise
  // long-lived caller signals (per-session AbortController) accumulate listeners.
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
      throw new AdapterError('anthropic request aborted/timed out', { code: 'transient', providerId: 'anthropic' });
    }
    throw new AdapterError(err?.message || 'anthropic network error', { code: 'transient', providerId: 'anthropic', raw: err });
  }
  cleanup();

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AdapterError(`anthropic non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`, {
      code: classifyByStatus(resp.status),
      status: resp.status,
      providerId: 'anthropic',
    });
  }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
    throw new AdapterError(`anthropic ${resp.status}: ${msg}`, {
      code: classifyByStatus(resp.status, msg),
      status: resp.status,
      providerId: 'anthropic',
      raw: data,
    });
  }
  return parseResponse(data, opts.model);
}

export async function* doStream(opts) {
  // Phase A scaffold: emit non-streaming response as a single-chunk stream.
  // Phase B router will replace with hand-rolled SSE parser for native streaming.
  const response = await doGenerate(opts);
  if (response.content) yield { type: 'text_delta', text: response.content };
  if (response.toolCalls.length) yield { type: 'tool_call_delta', toolCalls: response.toolCalls };
  yield { type: 'finish', finishReason: response.finishReason, response };
}

export function classifyError(err) {
  if (err instanceof AdapterError) return err.code;
  const msg = err?.message || '';
  if (/abort|timeout/i.test(msg)) return 'transient';
  if (/safety|refusal/i.test(msg)) return 'fatal';
  return 'transient';
}

export async function healthCheck({ baseUrl, apiKey } = {}) {
  if (!apiKey) return { ok: false, error: 'missing apiKey' };
  try {
    // Anthropic doesn't expose a /v1/models for OAuth tokens cleanly; do a min-token ping.
    const probe = await doGenerate({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
      temperature: 0,
      apiKey,
      baseUrl,
      timeoutMs: 15000,
    });
    return { ok: true, models: [probe.model].filter(Boolean) };
  } catch (err) {
    return { ok: false, error: err?.message || 'health check failed' };
  }
}

// Curated bundle for Wizard / Settings dropdowns. Live `/v1/models` results
// are merged on top so a freshly-shipped Anthropic model appears immediately
// without a code change. If the live fetch fails, this list is the fallback.
export const knownModels = [
  { id: 'claude-opus-4-7',           label: 'Premium tier (smartest, slowest)',    tier: 'premium' },
  { id: 'claude-sonnet-4-6',         label: 'Balanced tier (recommended)',         tier: 'recommended' },
  { id: 'claude-haiku-4-5-20251001', label: 'Fast tier (fastest, cheapest)',       tier: 'fast' },
];

export const setupGuide = {
  apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  baseUrlPlaceholder: 'https://api.anthropic.com (default)',
  helpText: 'Anthropic API keys start with sk-ant-api / sk-ant-oat / sk-ant-admin and need a billing account.',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  // Anthropic exposes /v1/models. Returns { data: [{id, display_name, ...}] }.
  if (!apiKey) return null;
  const url = `${(baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.data)) return null;
    return data.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'anthropic',
  wireFormat: 'anthropic-messages',
  authEnvVar: 'ANTHROPIC_API_KEY',
  capabilities: {
    tools: true,
    streaming: true,
    systemPos: 'top-level',
    maxTokensRequired: true,
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

export default adapter;
