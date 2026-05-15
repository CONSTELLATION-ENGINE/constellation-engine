// SPDX-License-Identifier: AGPL-3.0-or-later
// Native Gemini generateContent adapter (gemini-generate wireFormat).
// POST {baseUrl}/v1beta/models/{model}:generateContent?key={apiKey}

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

function mapFinishReason(reason) {
  // Gemini reports STOP even when functionCalls are present; the parseResponse
  // override below upgrades to 'tool_use' when toolCalls.length > 0.
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'safety';
    default:
      return 'stop';
  }
}

function mapRole(role) {
  // Gemini uses 'user' and 'model' (not 'assistant')
  if (role === 'assistant') return 'model';
  if (role === 'tool') return 'function';
  return role;
}

function messageToContents(messages) {
  // Convert OpenAI-style messages to Gemini contents[] of {role, parts}
  const out = [];
  for (const m of messages) {
    const role = mapRole(m.role);
    let parts;
    if (typeof m.content === 'string') {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map((c) => {
        if (typeof c === 'string') return { text: c };
        if (c?.type === 'text') return { text: c.text || '' };
        if (c?.type === 'tool_use') {
          return { functionCall: { name: c.name, args: c.input || {} } };
        }
        if (c?.type === 'tool_result') {
          return { functionResponse: { name: c.name || '', response: { content: c.content } } };
        }
        return { text: JSON.stringify(c) };
      });
    } else {
      parts = [{ text: String(m.content || '') }];
    }
    out.push({ role, parts });
  }
  return out;
}

function buildRequest(opts) {
  const { messages: rest, system: extractedSystem } = extractSystemAndMessages(normalizeMessages(opts.messages));
  const system = opts.system || extractedSystem || '';
  const body = {
    contents: messageToContents(rest),
    generationConfig: {
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      maxOutputTokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
    },
  };
  if (system) {
    body.systemInstruction = { role: 'system', parts: [{ text: system }] };
  }
  if (Array.isArray(opts.stopSequences) && opts.stopSequences.length) {
    body.generationConfig.stopSequences = opts.stopSequences;
  }
  if (Array.isArray(opts.tools) && opts.tools.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || t.input_schema || { type: 'object', properties: {} },
      })),
    }];
    if (opts.toolChoice) {
      let mode = 'AUTO';
      if (opts.toolChoice === 'required') mode = 'ANY';
      else if (opts.toolChoice === 'none') mode = 'NONE';
      else if (typeof opts.toolChoice === 'object' && opts.toolChoice.name) {
        mode = 'ANY';
        body.toolConfig = {
          functionCallingConfig: { mode, allowedFunctionNames: [opts.toolChoice.name] },
        };
      }
      if (!body.toolConfig) {
        body.toolConfig = { functionCallingConfig: { mode } };
      }
    }
  }
  return body;
}

function parseResponse(data, model) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  let content = '';
  const toolCalls = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p?.text === 'string') content += p.text;
    if (p?.functionCall) {
      // Deterministic id keyed by parts index so the same response always
      // produces the same id (used downstream for de-dup, replay, logging).
      toolCalls.push({
        id: `${p.functionCall.name}-${i}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  const usage = {
    promptTokens: data?.usageMetadata?.promptTokenCount || 0,
    completionTokens: data?.usageMetadata?.candidatesTokenCount || 0,
    cacheRead: data?.usageMetadata?.cachedContentTokenCount || 0,
    cacheWrite: 0,
  };
  usage.totalTokens = data?.usageMetadata?.totalTokenCount || (usage.promptTokens + usage.completionTokens);
  let finishReason = mapFinishReason(candidate?.finishReason);
  if (toolCalls.length && finishReason === 'stop') finishReason = 'tool_use';
  return buildResponse({
    content,
    toolCalls,
    usage,
    model: data?.modelVersion || model,
    finishReason,
  });
}

export async function doGenerate(opts) {
  const baseUrl = (opts.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const model = opts.model;
  if (!model) throw new AdapterError('gemini: model is required', { code: 'fatal', providerId: 'gemini' });
  if (!opts.apiKey) throw new AdapterError('gemini: apiKey is required', { code: 'auth', providerId: 'gemini' });
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
  const headers = { 'content-type': 'application/json' };

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
      throw new AdapterError('gemini request aborted/timed out', { code: 'transient', providerId: 'gemini' });
    }
    throw new AdapterError(err?.message || 'gemini network error', { code: 'transient', providerId: 'gemini', raw: err });
  }
  cleanup();

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AdapterError(`gemini non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`, {
      code: classifyByStatus(resp.status),
      status: resp.status,
      providerId: 'gemini',
    });
  }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${resp.status}`;
    throw new AdapterError(`gemini ${resp.status}: ${msg}`, {
      code: classifyByStatus(resp.status, msg),
      status: resp.status,
      providerId: 'gemini',
      raw: data,
    });
  }
  // Safety blocks: candidates[].finishReason === 'SAFETY' with empty parts.
  const candidate = data?.candidates?.[0];
  if (candidate && /^(SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII)$/.test(candidate.finishReason || '')) {
    if (!candidate.content?.parts?.length) {
      throw new AdapterError(`gemini blocked: ${candidate.finishReason}`, {
        code: 'fatal',
        providerId: 'gemini',
        raw: data,
      });
    }
  }
  return parseResponse(data, opts.model);
}

export async function* doStream(opts) {
  // Phase A scaffold: single-chunk wrapper. Phase B will hand-roll SSE on
  // :streamGenerateContent endpoint.
  const response = await doGenerate(opts);
  if (response.content) yield { type: 'text_delta', text: response.content };
  if (response.toolCalls.length) yield { type: 'tool_call_delta', toolCalls: response.toolCalls };
  yield { type: 'finish', finishReason: response.finishReason, response };
}

export function classifyError(err) {
  if (err instanceof AdapterError) return err.code;
  const msg = err?.message || '';
  if (/abort|timeout/i.test(msg)) return 'transient';
  if (/safety|recitation|blocked/i.test(msg)) return 'fatal';
  return 'transient';
}

export async function healthCheck({ baseUrl, apiKey } = {}) {
  if (!apiKey) return { ok: false, error: 'missing apiKey' };
  const root = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const url = `${root}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const data = await resp.json();
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => (m.name || '').replace(/^models\//, '')).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err?.message || 'health check failed' };
  }
}

export const knownModels = [
  { id: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro (smartest)',                 tier: 'premium' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (balanced, recommended)',  tier: 'recommended' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (fastest)',      tier: 'fast' },
];

export const setupGuide = {
  apiKeyUrl: 'https://aistudio.google.com/apikey',
  baseUrlPlaceholder: 'https://generativelanguage.googleapis.com (default)',
  helpText: 'Google AI Studio API keys are free for low-volume use. Paid tier required for production traffic.',
  testRoundTrip: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1 },
};

export async function listModels({ apiKey, baseUrl } = {}) {
  if (!apiKey) return null;
  const root = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const url = `${root}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.models)) return null;
    return data.models
      .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({ id: (m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }))
      .filter((m) => m.id);
  } catch {
    return null;
  }
}

const adapter = register({
  id: 'gemini',
  wireFormat: 'gemini-generate',
  authEnvVar: 'GEMINI_API_KEY',
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
