// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider adapter contract — see 2026-04-26-llm-multi-provider-deployment-plan.md §4
//
// Each adapter exports a default object implementing this shape:
//   { id, wireFormat, authEnvVar, capabilities, doGenerate, doStream, classifyError, healthCheck }
//
// ROUTER-OWNED responsibilities (adapter MUST NOT replicate):
//   1. OAuth refresh state (single-flight + credentials.json write-back). Adapter
//      throws AdapterError({code:'auth'}) on 401/403; router catches and refreshes.
//   2. Retry / fallback chains. Adapter performs ONE call attempt per invocation —
//      no internal retry loop, no automatic backoff. Router owns retry policy.
//   3. 'stream_incomplete' sentinel. Adapter only emits the closed-set finishReasons
//      ('stop'|'tool_use'|'length'|'safety'|'error'); router post-processes the
//      stream and inserts 'stream_incomplete' if the socket dies before a terminal.
//   4. SYSTEM_CACHE_BREAK splitting + Anthropic cache_control block injection.
//      The Anthropic adapter receives a pre-built system field (string OR array of
//      blocks); it passes whatever it gets straight through. Router builds the
//      blocks via #buildAnthropicSystemBlocks before invoking the adapter.
//   5. Anthropic conversation repair (de-orphan tool_results, drop dangling
//      tool_uses, merge consecutive same-role turns). Router runs
//      #repairAndFormatAnthropicMessages BEFORE handing messages to the adapter.
//   6. Streaming tool-call accumulation across deltas. Either the adapter buffers
//      partial JSON internally and emits one fully-formed tool_call_delta with
//      complete input on the 'finish' event, OR the router does it post-stream;
//      callers see fully-formed toolCalls only.
//
// Adapters are pure transport — no shared mutable state across calls.

export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_TIMEOUT_MS = 5_400_000;

export const FINISH_REASONS = Object.freeze([
  'stop',
  'tool_use',
  'length',
  'safety',
  'error',
  'stream_incomplete',
]);

export const ERROR_CLASSES = Object.freeze([
  'rate_limit',
  'auth',
  'transient',
  'fatal',
  'overloaded',
]);

export function classifyByStatus(status, message = '') {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status >= 500 && status < 600) return 'transient';
  if (status === 408) return 'transient';
  if (/safety|content[_-]?filter/i.test(message)) return 'fatal';
  if (status >= 400 && status < 500) return 'fatal';
  return 'transient';
}

export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

export function extractSystemAndMessages(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system') {
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        // Join text-block content rather than stringifying the JSON shape.
        text = m.content
          .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text || '' : ''))
          .filter(Boolean)
          .join('');
      }
      if (text) sys.push(text);
    } else {
      rest.push(m);
    }
  }
  return { system: sys.join('\n\n'), messages: rest };
}

export function buildResponse({ content = '', toolCalls = [], usage = {}, model = '', finishReason = 'stop' } = {}) {
  if (!FINISH_REASONS.includes(finishReason)) finishReason = 'stop';
  return {
    content: String(content || ''),
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
    usage: {
      promptTokens: usage.promptTokens || 0,
      completionTokens: usage.completionTokens || 0,
      totalTokens: usage.totalTokens || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
    },
    model,
    finishReason,
  };
}

export class AdapterError extends Error {
  constructor(message, { code = 'transient', status = null, providerId = null, raw = null } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status;
    this.providerId = providerId;
    this.raw = raw;
  }
}
