// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module llm-router
 * @description LLM routing layer with Anthropic direct + LiteLLM proxy support,
 *              automatic retry, fallback, streaming, and tool-use handling.
 *
 * Hardened design goals:
 * - Separate transport, auth refresh, model candidate selection, and error classification
 * - Use IPv4-friendly HTTP transport in WSL instead of raw undici fetch for critical LLM calls
 * - Prevent OAuth refresh storms with singleflight + cooldown
 * - Keep model / transport cooldown scoped so one bad lane does not poison everything
 * - Sanitize payloads before JSON.stringify so relay/browser text cannot poison the request body
 */

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import liveBus from './live-bus.cjs';
import {
  buildRequest as buildAnthropicRequest,
  parseResponse as parseAnthropicWireResponse,
} from './providers/anthropic.js';

// ─── OAuth + Transport Helpers ──────────────────────────────────────────────

function normalizeExpiresAt(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

function normalizeBearerToken(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isAnthropicSetupToken(token) {
  return /^sk-ant-oat/i.test(normalizeBearerToken(token));
}

function readOAuthCredentials(credentialsPath) {
  try {
    const raw = readFileSync(credentialsPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth || creds?.oauth || creds;
    const accessToken = normalizeBearerToken(oauth?.accessToken || oauth?.token || '');
    if (accessToken) {
      return {
        accessToken,
        refreshToken: normalizeBearerToken(oauth?.refreshToken || '') || null,
        expiresAt: normalizeExpiresAt(oauth?.expiresAt || 0),
        clientId: oauth?.clientId || 'claude-cli',
        credentials: creds,
      };
    }
  } catch {}
  return null;
}

/**
 * Normalize OpenAI/Anthropic streaming usage payloads into the internal
 * { promptTokens, completionTokens, totalTokens, cacheRead, cacheWrite } shape.
 * Handles proxy responses that may include prompt_tokens_details.cached_tokens
 * or cache_read_input_tokens/cache_creation_input_tokens (Anthropic cache fields).
 */
function parseStreamUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const cacheRead = raw.cache_read_input_tokens || raw.prompt_tokens_details?.cached_tokens || 0;
  const cacheWrite = raw.cache_creation_input_tokens || 0;
  const completion = raw.completion_tokens || raw.output_tokens || 0;
  // OpenAI prompt_tokens already INCLUDES cached_tokens; Anthropic input_tokens is fresh-only.
  // Normalize promptTokens to always represent TOTAL input (fresh+cached) so addition is safe.
  const promptTokens = raw.prompt_tokens != null
    ? raw.prompt_tokens
    : (raw.input_tokens || 0) + cacheRead;
  return {
    promptTokens,
    completionTokens: completion,
    totalTokens: promptTokens + completion,
    cacheRead,
    cacheWrite,
  };
}

function toWellFormedLoose(value) {
  if (typeof value !== 'string') return value;
  if (typeof value.toWellFormed === 'function') return value.toWellFormed();
  return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function sanitizeJsonValue(value) {
  if (typeof value === 'string') return toWellFormedLoose(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeJsonValue(v);
    return out;
  }
  return value;
}

function nodeRequest(url, init = {}, { timeoutMs = 5_400_000, ipv4Only = true } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;
    const headers = init.headers || {};
    const body = init.body;
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: init.method || 'GET',
      headers: typeof headers.entries === 'function' ? Object.fromEntries(headers.entries()) : headers,
      family: ipv4Only ? 4 : undefined,
    };

    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = client.request(options, (res) => {
      if (res.socket) res.socket.setKeepAlive(true, 30_000);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          headers: res.headers || {},
          async text() { return raw; },
          async json() { return JSON.parse(raw || '{}'); },
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), { name: 'AbortError' }));
    });
    if (payload) {
      const flushed = req.write(payload);
      if (!flushed) {
        req.once('drain', () => req.end());
      } else {
        req.end();
      }
    } else {
      req.end();
    }
  });
}

/**
 * Streaming HTTP request that yields parsed SSE events from an OpenAI-compatible endpoint.
 * Used for `stream: true` requests to user-managed local gateways.
 *
 * OpenAI SSE format:
 *   data: {"id":"...","choices":[{"delta":{"content":"Hello"},...}],...}
 *   data: [DONE]
 *
 * @param {string} url
 * @param {Object} init - { method, headers, body }
 * @param {Object} opts - { timeoutMs, ipv4Only }
 * @yields {{ type: 'delta', text: string } | { type: 'tool_call_delta', index: number, id?: string, name?: string, arguments?: string } | { type: 'done', data: Object|null } | { type: 'error', error: string }}
 */
async function* nodeRequestStream(url, init = {}, {
  timeoutMs = 5_400_000,
  ipv4Only = true,
} = {}) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const client = isHttps ? https : http;
  const headers = init.headers || {};
  const body = init.body;
  const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const options = {
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    method: init.method || 'POST',
    headers: typeof headers.entries === 'function' ? Object.fromEntries(headers.entries()) : headers,
    family: ipv4Only ? 4 : undefined,
  };
  if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
  const reqStartMs = Date.now();

  // We use a push-pull pattern: the HTTP response pushes chunks into a queue,
  // and the async generator pulls from it. This avoids buffering the entire response.
  const queue = [];
  let resolve = null;
  let done = false;
  let error = null;

  const push = (item) => {
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  };

  const pull = () => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    if (done) return Promise.resolve(null);
    return new Promise(r => { resolve = r; });
  };

  // ── Stream diagnostics (captured for failure attribution) ──
  const _diag = {
    upstream_request_id: null,      // Anthropic/proxy request ID from response headers
    stream_start_ms: null,          // When first SSE data arrived
    last_event_type: null,          // Last SSE event type seen (delta/tool_call_delta/finish/done)
    last_event_ms: null,            // Timestamp of last SSE event
    close_initiator: 'unknown',     // Who closed: 'hard_timeout' | 'socket_error' | 'res_error' | 'req_error' | 'normal'
    socket_error: null,             // Raw socket/network error message if any
    total_chunks: 0,                // Total SSE data chunks received
    total_bytes: 0,                 // Total bytes received
    http_status: null,              // HTTP response status code
  };

  const req = client.request(options, (res) => {
    _diag.http_status = res.statusCode;
    _diag.upstream_request_id = res.headers?.['x-request-id'] || res.headers?.['request-id'] || res.headers?.['cf-ray'] || null;

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        _diag.close_initiator = 'http_error';
        error = { status: res.statusCode, body, _diag };
        push(null);
        done = true;
      });
      return;
    }

    // TCP keepalive: OS-level dead connection detection (probes every 10s after 10s idle)
    if (res.socket) res.socket.setKeepAlive(true, 10_000);
    let sseBuffer = '';
    res.on('data', (chunk) => {
      _diag.total_chunks++;
      _diag.total_bytes += chunk.length;
      _diag.last_event_ms = Date.now();
      sseBuffer += chunk.toString('utf-8');
      // SSE events are separated by double newlines
      const parts = sseBuffer.split(/\r?\n\r?\n/);
      sseBuffer = parts.pop() || '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const lines = part.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
              _diag.last_event_type = 'done';
              push({ type: 'done', data: null });
            } else {
              try {
                const parsed = JSON.parse(dataStr);
                _diag.last_event_type = 'chunk';
                if (_diag.stream_start_ms === null) _diag.stream_start_ms = Date.now();
                push({ type: 'chunk', data: parsed });
              } catch {
                // Ignore malformed JSON lines
              }
            }
          }
          // Ignore event:, id:, retry: lines — we only care about data:
        }
      }
    });
    res.on('end', () => {
      // Flush any remaining buffer
      if (sseBuffer.trim()) {
        const lines = sseBuffer.split(/\r?\n/);
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
              push({ type: 'done', data: null });
            } else {
              try { push({ type: 'chunk', data: JSON.parse(dataStr) }); } catch {}
            }
          }
        }
      }
      if (!_diag.close_initiator || _diag.close_initiator === 'unknown') _diag.close_initiator = 'normal';
      done = true;
      push(null); // Signal end
    });
    res.on('error', (err) => {
      _diag.close_initiator = 'res_error';
      _diag.socket_error = err.message;
      error = { status: 0, body: err.message, _diag };
      done = true;
      push(null);
    });
  });

  req.on('error', (err) => {
    if (!error) {
      _diag.close_initiator = 'req_error';
      _diag.socket_error = err.message;
      error = { status: 0, body: err.message, _diag };
    }
    done = true;
    push(null);
  });

  // Hard safety-net timeout (default 90 min). TCP keepalive (10s) handles real
  // connection drops; this is the absolute ceiling. Soft liveness heartbeat
  // removed 2026-04-28 (caused two ungraceful engine deaths today).
  req.setTimeout(timeoutMs, () => {
    _diag.close_initiator = 'hard_timeout';
    error = { status: 0, body: `Hard timeout after ${timeoutMs}ms`, _diag };
    req.destroy();
    done = true;
    push(null);
  });

  if (payload) {
    const flushed = req.write(payload);
    if (!flushed) {
      req.once('drain', () => req.end());
    } else {
      req.end();
    }
  } else {
    req.end();
  }

  // Yield parsed SSE events. Wrapped in try/finally so a consumer-side
  // generator return (mid-stream break) immediately tears down the underlying
  // request instead of waiting for the hard ceiling.
  try {
    while (true) {
      const item = await pull();
      if (item === null) break;
      if (item.type === 'done') {
        yield item;
        break;
      }
      if (item.type === 'chunk') {
        // OpenAI proxies with stream_options.include_usage emit a trailing chunk
        // where choices:[] and usage:{...}. Capture it before the choice guard skips it.
        if (item.data?.usage) {
          yield { type: 'usage', usage: item.data.usage, model: item.data?.model || '' };
        }

        // Parse OpenAI-format SSE chunk
        const choice = item.data?.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};

        // Text content delta
        if (delta.content) {
          yield { type: 'delta', text: delta.content };
        }

        // Tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: 'tool_call_delta',
              index: tc.index ?? 0,
              id: tc.id || undefined,
              name: tc.function?.name || undefined,
              arguments: tc.function?.arguments || undefined,
            };
          }
        }

        // Finish reason
        if (choice.finish_reason) {
          yield { type: 'finish', reason: choice.finish_reason, usage: item.data?.usage || null, model: item.data?.model || '' };
        }
      }
    }
  } finally {
    if (!done) { try { req.destroy(); } catch { /* socket may already be torn down */ } done = true; }
  }

  // Yield stream diagnostics so consumer can log them on stream_incomplete
  yield { type: '_diag', _diag };

  // If there was an HTTP error, throw it
  if (error) {
    const err = new Error(`[${error.status || 'network'}] ${typeof error.body === 'string' ? error.body.slice(0, 300) : 'Stream error'}`);
    err.status = error.status;
    if (error._diag) err._diag = error._diag;
    if (error.code) err.code = error.code;
    throw err;
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LLMConfig
 * @property {string} baseUrl - API base URL (Anthropic: 'https://api.anthropic.com', LiteLLM: 'http://localhost:4000')
 * @property {string} apiKey - API key (resolved from env by config.js)
 * @property {string} primaryModel - Main (premium-tier) model id, provider-specific wire format
 * @property {string} compactModel - Cheaper (fast-tier) model id for summarization, provider-specific wire format
 * @property {string} [fallbackModel] - Fallback on primary failure
 * @property {number} [maxRetries=2] - Max retry attempts per model
 * @property {number} [timeoutMs=120000] - Request timeout in ms
 * @property {string} [provider='anthropic'] - 'anthropic' | 'openai' (for LiteLLM)
 * @property {string} [authMode='api-key'] - 'api-key' | 'claude-proxy' | 'oauth' | 'gateway'
 * @property {string} [proxyUrl] - Claude CLI proxy URL (for authMode='claude-proxy')
 * @property {string} [oauthToken] - OAuth token (for authMode='oauth')
 */

/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'|'tool'} role
 * @property {string|Array} content - String or content blocks array
 * @property {string} [tool_call_id] - For tool result messages
 * @property {Array} [tool_calls] - For assistant messages with tool use
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string|null} content - Text response
 * @property {ToolCall[]|null} toolCalls - Tool calls if any
 * @property {Object} usage - { promptTokens, completionTokens, totalTokens }
 * @property {string} model - Actual model used
 * @property {string} finishReason - 'stop' | 'tool_use' | 'length' | 'error'
 */

/**
 * @typedef {Object} ToolCall
 * @property {string} id - Tool call ID
 * @property {string} name - Tool/function name
 * @property {Object} input - Tool arguments
 */

/**
 * @typedef {Object} ChatOptions
 * @property {Object[]} [tools] - Tool definitions
 * @property {number} [temperature=0.7] - Sampling temperature
 * @property {number} [maxTokens=8192] - Max tokens to generate
 * @property {string} [model] - Override model for this call
 * @property {boolean} [stream=false] - Enable streaming
 * @property {string} [system] - System prompt (extracted from messages for Anthropic)
 */

// ─── Error Classes ──────────────────────────────────────────────────────────

/**
 * Typed LLM error with structured metadata.
 */
export class LLMError extends Error {
  /**
   * @param {string} message
   * @param {Object} meta
   * @param {string} meta.code - Error code: 'rate_limit' | 'timeout' | 'auth' | 'overloaded' | 'unknown'
   * @param {string} meta.model - Model that failed
   * @param {Error} [meta.cause] - Original error
   * @param {number} [meta.status] - HTTP status code
   */
  constructor(message, { code, model, cause, status } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code || 'unknown';
    this.model = model || 'unknown';
    this.cause = cause;
    this.status = status;
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT_MS = 5_400_000; // 90 min hard ceiling — TCP keepalive (10s) handles actual dead pipes
const DEFAULT_MAX_RETRIES = 2;
const CHARS_PER_TOKEN = 3.5; // Conservative for mixed CJK + English

// Retry config
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const SYSTEM_CACHE_BREAK = '<!-- SYSTEM_CACHE_BREAK -->';
const MODEL_404_COOLDOWN_MS = 10 * 60_000;
const TRANSPORT_404_COOLDOWN_MS = 5 * 60_000;
const TRANSPORT_AUTH_COOLDOWN_MS = 2 * 60_000;
const TRANSPORT_DEGRADED_COOLDOWN_MS = 45_000;
const AUTH_REFRESH_COOLDOWN_MS = 60_000;
const OAUTH_NEAR_EXPIRY_MS = 5 * 60_000;
const OAUTH_RELOAD_INTERVAL_MS = 15_000;
const PROXY_MODEL_CATALOG_TTL_MS = 10 * 60_000;
const TRANSPORT_FAILURE_WINDOW_MS = 60_000;
const TRANSPORT_FAILURE_THRESHOLD = 2;

// Soft liveness heartbeat REMOVED 2026-04-28. Caused two ungraceful engine
// deaths today (engine.log lines 58476/58507 at 14:13 NZST, 58951/58959 at
// 16:50 NZST — boot followed heartbeat_stall with no SIGINT/SIGTERM). The
// req.destroy() during fallback-to-non-streaming retry took the parent down.
// Only the hard ceiling per role remains, enforced via req.setTimeout.
const HARD_CEILING_PROFILES = {
  worker:  900_000,
  explore: 900_000,
  main:  5_400_000,
};
const HARD_CEILING_DEFAULT = HARD_CEILING_PROFILES.main;

// Status codes that trigger retry
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);

// ─── Phase C: Multi-Provider Config Migration ──────────────────────────────
// Synthesize nested {providers, roles, limits} from legacy flat config keys.
// Both shapes coexist (flat keys remain live) until callers migrate to roles.

function detectLLMConfigShape(llm) {
  const hasNested = !!(llm && (llm.providers || llm.roles || llm.limits));
  const hasFlat = !!(llm && (llm.primaryModel || llm.proxyUrl || llm.compactModel || llm.fallbackModel));
  return { hasNested, hasFlat };
}

function synthesizeNestedFromFlat(llm) {
  const authMode = llm.authMode || 'api-key';
  const providers = {};
  let activeProvider;

  if (authMode === 'claude-proxy' || (llm.proxyUrl && !llm.baseUrl)) {
    activeProvider = 'claude-proxy';
    providers['claude-proxy'] = {
      wireFormat: 'openai-completions',
      baseUrl: llm.proxyUrl,
      apiKeyEnv: llm.apiKey ? 'CLAUDE_PROXY_TOKEN' : null,
    };
    if (llm.proxyVendor || llm.proxyHealthModel || llm.proxyStartupTimeoutMs || llm.proxyAutoStart) {
      const autoStart = {};
      if (llm.proxyVendor) autoStart.command = llm.proxyVendor;
      if (llm.proxyHealthModel) autoStart.healthModel = llm.proxyHealthModel;
      if (llm.proxyStartupTimeoutMs) autoStart.timeoutMs = llm.proxyStartupTimeoutMs;
      providers['claude-proxy'].autoStart = autoStart;
    }
  } else if (authMode === 'gateway') {
    activeProvider = 'gateway';
    providers.gateway = {
      wireFormat: 'openai-completions',
      baseUrl: llm.baseUrl,
      apiKeyEnv: 'GATEWAY_API_KEY',
    };
  } else {
    activeProvider = 'anthropic';
    providers.anthropic = {
      wireFormat: 'anthropic-messages',
      baseUrl: llm.baseUrl || 'https://api.anthropic.com',
      apiKeyEnv: authMode === 'oauth' ? null : 'ANTHROPIC_API_KEY',
    };
    if (authMode === 'oauth') {
      if (llm.oauthToken) providers.anthropic.oauthToken = llm.oauthToken;
      if (llm.oauthCredentialsPath) providers.anthropic.oauthCredentialsPath = llm.oauthCredentialsPath;
    }
  }

  const primary = llm.primaryModel;
  const compact = llm.compactModel;
  const fb = llm.fallbackModel;
  const roles = {
    main: {
      primary: { provider: activeProvider, model: primary },
      fallback: fb ? [{ provider: activeProvider, model: fb }] : [],
    },
    anamnesis:     { primary: { provider: activeProvider, model: compact || primary } },
    consolidation: { primary: { provider: activeProvider, model: compact || primary } },
    worker:        { primary: { provider: activeProvider, model: primary } },
    explore:       { primary: { provider: activeProvider, model: primary } },
    compact:       { primary: { provider: activeProvider, model: compact || primary } },
  };

  const limits = {};
  if (llm.maxRetries !== undefined) limits.maxRetries = llm.maxRetries;
  if (llm.timeoutMs !== undefined) limits.timeoutMs = llm.timeoutMs;

  return { providers, roles, limits };
}

// Standard role registry — boot-time backfill ensures every entry has a
// resolvable {provider, model}. Adding a new role here makes upgrade boots
// auto-fill it from the user's `main` role, so partial-config users (V5
// pre-`compact` wizard, hand-edited JSON, etc.) stop tripping the
// `[LLMRouter] unknown role "..."` warning at runtime.
const STANDARD_ROLES = ['main', 'anamnesis', 'consolidation', 'worker', 'explore', 'compact'];

/**
 * If user config has nested `roles` but is missing one or more standard
 * roles, fill them in from `main` (compact prefers compactModel flat key
 * if present). Mutates `llm` in place. Returns the list of filled role
 * names so the caller can decide whether to write the config back.
 */
function backfillMissingRoles(llm) {
  if (!llm || !llm.roles) return [];
  const main = llm.roles.main && llm.roles.main.primary;
  if (!main || !main.model) return []; // no anchor to backfill from
  const filled = [];
  for (const r of STANDARD_ROLES) {
    if (llm.roles[r] && llm.roles[r].primary && llm.roles[r].primary.model) continue;
    const useCompactFlat = (r === 'compact' || r === 'anamnesis' || r === 'consolidation') && llm.compactModel;
    const model = useCompactFlat ? llm.compactModel : main.model;
    llm.roles[r] = { primary: { provider: main.provider || null, model } };
    filled.push(r);
  }
  return filled;
}

/**
 * Atomically write back the backfilled roles into config.json.
 * Only touches `llm.roles[r]` for roles in `filledNames`; leaves other keys
 * untouched. Uses .tmp + renameSync, same race-safety as atomicWriteConfigLLM.
 */
function atomicWriteRoleBackfill(configPath, filledNames, currentRoles) {
  if (!configPath || !filledNames || filledNames.length === 0) return false;
  let raw;
  try { raw = readFileSync(configPath, 'utf-8'); }
  catch (err) {
    console.warn(`[LLMRouter] role backfill: could not read ${configPath}: ${err.message}`);
    return false;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    console.warn(`[LLMRouter] role backfill: malformed JSON at ${configPath}: ${err.message}`);
    return false;
  }
  parsed.llm = parsed.llm || {};
  parsed.llm.roles = parsed.llm.roles || {};
  for (const r of filledNames) {
    if (currentRoles[r]) parsed.llm.roles[r] = currentRoles[r];
  }
  const tmpPath = configPath + '.role-backfill.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2));
    renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[LLMRouter] role backfill: write failed: ${err.message}`);
    return false;
  }
}

/**
 * Atomically write nested llm.{providers,roles,limits} into config.json
 * without disturbing flat keys (which remain live for back-compat).
 * Uses .tmp + renameSync to be safe against the dashboard.js / doctor.js race.
 */
function atomicWriteConfigLLM(configPath, nested) {
  if (!configPath) return false;
  let raw;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    console.warn(`[LLMRouter] config migration: could not read ${configPath}: ${err.message}`);
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[LLMRouter] config migration: malformed JSON at ${configPath}: ${err.message}`);
    return false;
  }
  parsed.llm = parsed.llm || {};
  // Only insert nested keys if not already present (idempotent)
  if (parsed.llm.providers && parsed.llm.roles) return false;
  if (nested.providers) parsed.llm.providers = nested.providers;
  if (nested.roles) parsed.llm.roles = nested.roles;
  if (nested.limits && Object.keys(nested.limits).length > 0) parsed.llm.limits = nested.limits;

  const tmpPath = configPath + '.llm-migrate.tmp';
  try {
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2));
    renameSync(tmpPath, configPath);
    return true;
  } catch (err) {
    console.warn(`[LLMRouter] config migration: write failed: ${err.message}`);
    return false;
  }
}

// ─── LLMRouter ──────────────────────────────────────────────────────────────

export class LLMRouter extends EventEmitter {
  /** @type {LLMConfig} */
  #config;

  /** @type {import('better-sqlite3').Database|null} */
  #db;

  /** Expose config for model switching tool */
  get config() { return this.#config; }

  /**
   * Hot-reconfigure the router with new LLM settings.
   * Only updates fields that are provided; leaves others untouched.
   * Does NOT re-validate auth (caller should test connection separately).
   * @param {Partial<LLMConfig>} patch
   */
  reconfigure(patch) {
    const allowedKeys = [
      'authMode', 'provider', 'baseUrl', 'apiKey', 'proxyUrl', 'proxyCommand',
      'proxyVendor', 'proxyHealthModel', 'proxyStartupTimeoutMs', 'proxyAutoStart',
      'primaryModel', 'compactModel', 'fallbackModel', 'maxRetries', 'timeoutMs',
      'oauthToken', 'oauthCredentialsPath',
      // Phase C: nested multi-provider shape — coexists with flat keys above
      'providers', 'roles', 'limits',
    ];
    for (const key of allowedKeys) {
      if (patch[key] !== undefined) {
        this.#config[key] = patch[key];
      }
    }
    // Reset cooldowns on reconfigure so new provider starts fresh
    this.#modelCooldowns.clear();
    this.#transportCooldowns.clear();
    this.#proxyModelCatalog = null;
    this.emit('reconfigure', { config: this.#config });
  }

  /**
   * Phase C: resolve a logical role to a concrete {provider, model, fallback[]}.
   * Unknown role → warn + default to 'main' (or throw under STRICT_ROLES=1).
   * Falls back to legacy flat keys when no nested roles map is present so
   * pre-migration callsites continue to work during the rollout window.
   * @param {string} _role
   * @param {{ strict?: boolean }} [options]
   * @returns {{ provider: string|null, model: string, fallback: Array<{provider:string,model:string}> }}
   */
  #resolveRole(_role, options = {}) {
    const role = _role || 'main';
    const roles = this.#config.roles;
    const strict = options.strict ?? (process.env.STRICT_ROLES === '1');

    if (roles && roles[role] && roles[role].primary) {
      const target = roles[role];
      return {
        provider: target.primary.provider || null,
        model: target.primary.model,
        fallback: Array.isArray(target.fallback) ? target.fallback : [],
      };
    }

    if (roles && role !== 'main') {
      if (strict) {
        throw new LLMError(`Unknown role: ${role}`, { code: 'unknown', model: 'init' });
      }
      console.warn(`[LLMRouter] unknown role "${role}", falling back to "main"`);
      if (roles.main && roles.main.primary) {
        return {
          provider: roles.main.primary.provider || null,
          model: roles.main.primary.model,
          fallback: Array.isArray(roles.main.fallback) ? roles.main.fallback : [],
        };
      }
    }

    // Legacy fallback: nested shape absent (pre-migration boot or doctor.js minimal config)
    const flatProvider = this.#config.providers ? Object.keys(this.#config.providers)[0] : null;
    return {
      provider: flatProvider,
      model: role === 'compact' && this.#config.compactModel
        ? this.#config.compactModel
        : this.#config.primaryModel,
      fallback: this.#config.fallbackModel
        ? [{ provider: flatProvider, model: this.#config.fallbackModel }]
        : [],
    };
  }

  /** @type {import('better-sqlite3').Statement|null} */
  #insertApiCall;

  /** @type {Map<string, number>} model -> cooldown until ms */
  #modelCooldowns = new Map();

  /** @type {Map<string, number>} transport -> cooldown until ms */
  #transportCooldowns = new Map();

  /** @type {{ models: string[], fetchedAt: number }|null} */
  #proxyModelCatalog = null;

  /** @type {{ token: string|null, expiresAt: number, checkedAt: number, refreshPromise: Promise<string|null>|null, refreshCooldownUntil: number, authFlavor: string }} */
  #oauthState = { token: null, expiresAt: 0, checkedAt: 0, refreshPromise: null, refreshCooldownUntil: 0, authFlavor: 'unknown' };

  /** @type {Map<string, number[]>} */
  #recentTransportFailures = new Map();

  /**
   * @param {LLMConfig} config
   * @param {import('better-sqlite3').Database} [db] - SQLite database for api_calls tracking
   * @param {string|null} [configPath] - Path to config.json for first-boot migration write-back
   */
  constructor(config, db = null, configPath = null) {
    super();
    this.#config = {
      maxRetries: DEFAULT_MAX_RETRIES,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      provider: 'anthropic',
      ...config,
    };
    this.#db = db;
    this.#insertApiCall = null;

    if (this.#db) {
      try {
        this.#insertApiCall = this.#db.prepare(`
          INSERT INTO api_calls (model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, duration_ms, trigger, session_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      } catch { /* table may not exist yet */ }
    }

    // Phase C: dual-shape migration. Synthesize nested {providers, roles, limits}
    // from flat keys when missing; persist to config.json on first boot.
    // Flat keys remain live in this.#config for back-compat with callers that
    // still read primaryModel / compactModel / proxyUrl directly.
    {
      const shape = detectLLMConfigShape(this.#config);
      if (!shape.hasNested && shape.hasFlat) {
        const nested = synthesizeNestedFromFlat(this.#config);
        this.#config.providers = nested.providers;
        this.#config.roles = nested.roles;
        if (Object.keys(nested.limits).length > 0) this.#config.limits = nested.limits;
        if (configPath) {
          const wrote = atomicWriteConfigLLM(configPath, nested);
          if (wrote) console.log('[LLMRouter] migrated config.json llm block to nested {providers, roles, limits}');
        }
      }
      // Phase C+: backfill any standard roles missing from a partial nested
      // config (V5 pre-`compact` wizard, hand-edited JSON). Quiet when
      // nothing's missing; warns once + writes back when it had to fill.
      const filled = backfillMissingRoles(this.#config);
      if (filled.length > 0) {
        console.log(`[LLMRouter] backfilled missing roles from "main": ${filled.join(', ')}`);
        if (configPath) atomicWriteRoleBackfill(configPath, filled, this.#config.roles);
      }
    }

    // Validate auth based on mode
    const authMode = this.#config.authMode || 'api-key';
    if (authMode === 'api-key' && !this.#config.apiKey) {
      throw new LLMError('API key is required', { code: 'auth', model: 'init' });
    }
    if (authMode === 'gateway' && (!this.#config.baseUrl || !this.#config.apiKey)) {
      throw new LLMError('baseUrl + apiKey are required for authMode="gateway"', { code: 'auth', model: 'init' });
    }
    if (authMode === 'oauth') {
      const explicitToken = normalizeBearerToken(this.#config.oauthToken || '');
      if (explicitToken) {
        this.#applyOAuthMaterial({ accessToken: explicitToken, expiresAt: 0 }, { source: 'config' });
      } else if (this.#config.oauthCredentialsPath) {
        const fresh = readOAuthCredentials(this.#config.oauthCredentialsPath);
        if (fresh?.accessToken) {
          this.#applyOAuthMaterial(fresh, { source: 'credentials' });
        }
      }
      if (!this.#config.oauthToken) {
        throw new LLMError('OAuth token is required for authMode="oauth" (set llm.oauthToken or llm.oauthCredentialsPath)', { code: 'auth', model: 'init' });
      }
    }
    if (authMode === 'claude-proxy' && !this.#config.proxyUrl) {
      throw new LLMError('proxyUrl is required for authMode="claude-proxy"', { code: 'auth', model: 'init' });
    }
    // When using claude-proxy with OAuth credentials as fallback,
    // eagerly load the token so #ensureOAuthToken / #callAnthropic can use it.
    if (authMode === 'claude-proxy' && !this.#config.apiKey) {
      let loaded = false;
      if (this.#config.oauthCredentialsPath) {
        const fresh = readOAuthCredentials(this.#config.oauthCredentialsPath);
        if (fresh?.accessToken) {
          this.#applyOAuthMaterial(fresh, { source: 'credentials' });
          loaded = true;
        }
      }
      // Auto-discover Claude CLI credentials if explicit path failed
      if (!loaded) {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const candidatePaths = [
          home + '/.claude/credentials.json',
          home + '/.config/claude/credentials.json',
        ];
        for (const p of candidatePaths) {
          const fresh = readOAuthCredentials(p);
          if (fresh?.accessToken) {
            this.#config.oauthCredentialsPath = p;
            this.#applyOAuthMaterial(fresh, { source: 'auto-discover' });
            break;
          }
        }
      }
    }
    if (!this.#config.primaryModel) {
      throw new LLMError('Primary model is required', { code: 'unknown', model: 'init' });
    }
  }

  #detectOAuthFlavor(token, material = null) {
    const normalized = normalizeBearerToken(token || material?.accessToken || '');
    if (!normalized) return 'unknown';
    if (isAnthropicSetupToken(normalized)) return 'setup-token';
    if (material?.refreshToken || material?.expiresAt) return 'oauth-access-token';
    return 'manual-bearer';
  }

  #applyOAuthMaterial(material, { source = 'unknown' } = {}) {
    const token = normalizeBearerToken(material?.accessToken || '');
    if (!token) return null;
    this.#oauthState.token = token;
    this.#oauthState.expiresAt = normalizeExpiresAt(material?.expiresAt || 0);
    this.#oauthState.checkedAt = Date.now();
    this.#oauthState.authFlavor = this.#detectOAuthFlavor(token, material);
    this.#config.oauthToken = token;
    this.#oauthState.source = source;
    return token;
  }

  #hasExplicitOAuthToken() {
    return !!normalizeBearerToken(this.#config.oauthToken || '');
  }

  #isSetupTokenMode() {
    return this.#detectOAuthFlavor(this.#config.oauthToken, { refreshToken: null, expiresAt: 0 }) === 'setup-token' || this.#oauthState.authFlavor === 'setup-token';
  }

  #canAutoRefreshOAuth() {
    if ((this.#config.authMode || 'api-key') !== 'oauth') return false;
    if (this.#hasExplicitOAuthToken()) return false;
    return !!this.#config.oauthCredentialsPath && this.#oauthState.authFlavor === 'oauth-access-token';
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Send a chat completion request with automatic retry and fallback.
   * 
   * @param {LLMMessage[]} messages - Conversation messages
   * @param {ChatOptions} [options={}]
   * @returns {Promise<LLMResponse>}
   * @throws {LLMError} When all models and retries exhausted
   */
  async chat(messages, options = {}) {
    const requestedModel = options.model || this.#resolveRole(options._role).model;
    const candidates = await this.#buildCandidatePlan(requestedModel, options);

    let lastError;
    const effectiveCandidates = options._noFallback ? candidates.slice(0, 1) : candidates;
    for (let idx = 0; idx < effectiveCandidates.length; idx++) {
      const candidate = effectiveCandidates[idx];
      try {
        const response = await this.#callWithRetry(messages, { ...options, model: candidate.model }, candidate);
        return response;
      } catch (err) {
        lastError = err;
        const next = effectiveCandidates[idx + 1] || null;
        if (next) {
          this.emit('fallback', {
            from: `${candidate.transport}:${candidate.model}`,
            to: `${next.transport}:${next.model}`,
            error: err,
          });
        }
        if (this.#shouldShortCircuitFallback(err)) break;
      }
    }

    throw lastError;
  }

  /**
   * Streaming chat via claude-proxy (OpenAI SSE format).
   * Yields text deltas as they arrive from the LLM.
   * Falls back to non-streaming chat() if proxy doesn't support streaming.
   *
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} [options={}]
   * @yields {{ type: 'text_delta', text: string } | { type: 'tool_calls', toolCalls: ToolCall[] } | { type: 'done', response: LLMResponse }}
   */
  async *streamChat(messages, options = {}) {
    const authMode = this.#config.authMode || 'api-key';

    // Only claude-proxy supports streaming through the OpenAI SSE format
    // For other transports, fall back to non-streaming
    if (authMode !== 'claude-proxy' || !this.#config.proxyUrl) {
      const response = await this.chat(messages, options);
      if (response.content) {
        yield { type: 'text_delta', text: response.content };
      }
      if (response.toolCalls?.length) {
        yield { type: 'tool_calls', toolCalls: response.toolCalls };
      }
      yield { type: 'done', response };
      return;
    }

    try {
      yield* this.#streamClaudeProxy(messages, options);
    } catch (err) {
      // On TIMEOUT errors, do NOT fall back — propagate so caller can trigger auto-retry
      // Fallback to non-streaming would start another 13-min call, blocking abort signal detection
      if (err?._diag) {
        console.warn('[LLM] Stream failure diagnostics:', JSON.stringify(err._diag));
      }
      if (/timed out|timeout/i.test(err?.message) || err?.code === 'timeout' || err?.name === 'AbortError') {
        console.warn('[LLM] Stream timed out, propagating error for auto-retry:', err.message);
        throw err;
      }
      // On other streaming errors (parse errors, etc.), fall back to non-streaming
      console.warn('[LLM] Stream failed, falling back to non-streaming:', err.message);
      const response = await this.chat(messages, options);
      if (response.content) {
        yield { type: 'text_delta', text: response.content };
      }
      if (response.toolCalls?.length) {
        yield { type: 'tool_calls', toolCalls: response.toolCalls };
      }
      yield { type: 'done', response };
    }
  }

  /**
   * Internal: Stream via claude-proxy using OpenAI SSE format.
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} options
   * @yields {Object} Stream events
   */
  async *#streamClaudeProxy(messages, options) {
    const model = options.model || this.#resolveRole(options._role).model;
    const resolvedTimeout = options._timeoutMs || this.#resolveHardCeiling(options);

    const body = {
      model,
      messages: messages.map(m => this.#formatMessageForOpenAI(m)),
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      stream: true,
      stream_options: { include_usage: true },
      timeout: resolvedTimeout,
    };

    if (options.system) {
      body.messages.unshift({ role: 'system', content: options.system });
    }
    // Pass short key instructions as real system prompt via CLI --append-system-prompt
    if (options.appendSystemPrompt) {
      body.appendSystemPrompt = options.appendSystemPrompt;
    }
    if (options.tools?.length) {
      body.tools = options.tools.map(t => this.#formatToolForOpenAI(t));
    }

    const proxyUrl = this.#config.proxyUrl.replace(/\/+$/, '');
    const url = `${proxyUrl}/chat/completions`;
    const ipv4Only = this.#config.ipv4Only !== false;

    // Accumulate full response for tracking and return
    let fullContent = '';
    let finishReason = 'stop';
    let receivedFinishEvent = false;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let responseModel = model;
    let streamDiag = null; // Transport-layer diagnostics from nodeRequestStream
    const toolCallAccumulator = new Map(); // index → { id, name, arguments }
    const startMs = Date.now();

    for await (const event of nodeRequestStream(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#config.apiKey ? { 'Authorization': `Bearer ${this.#config.apiKey}` } : {}),
      },
      body: this.#jsonBody(body),
    }, {
      timeoutMs: resolvedTimeout,
      ipv4Only,
    })) {

      if (event.type === 'delta') {
        fullContent += event.text;
        yield { type: 'text_delta', text: event.text };
      }

      if (event.type === 'tool_call_delta') {
        let tc = toolCallAccumulator.get(event.index);
        if (!tc) {
          tc = { id: '', name: '', arguments: '' };
          toolCallAccumulator.set(event.index, tc);
        }
        if (event.id) tc.id = event.id;
        if (event.name) tc.name = event.name;
        if (event.arguments) tc.arguments += event.arguments;
      }

      if (event.type === 'finish') {
        receivedFinishEvent = true;
        finishReason = event.reason || 'stop';
        if (event.usage) {
          usage = parseStreamUsage(event.usage);
        }
        // Do NOT overwrite responseModel with event.model — some upstreams
        // mislabel the model id in finish/usage events. Trust the request.
      }

      if (event.type === 'usage') {
        // Trailing usage-only chunk — may arrive after finish, may carry cache fields
        // that the finish event lacked. Always merge/overwrite with latest.
        usage = parseStreamUsage(event.usage);
      }

      if (event.type === '_diag') {
        streamDiag = event._diag; // Capture diagnostics from transport layer
      }

      if (event.type === 'done') {
        break;
      }
    }

    // Detect abnormal stream termination: no finish event received means
    // the proxy/LLM connection was interrupted mid-stream
    if (!receivedFinishEvent && toolCallAccumulator.size === 0) {
      console.warn(`[LLM] Stream ended without finish event (content=${fullContent.length} chars). Marking as stream_incomplete.`);
      if (streamDiag) {
        console.warn('[LLM] stream_incomplete diagnostics:', JSON.stringify(streamDiag));
      } else {
        console.warn('[LLM] stream_incomplete: no transport diagnostics available');
      }
      finishReason = 'stream_incomplete';
    }

    // Build tool calls from accumulated deltas
    let toolCalls = null;
    if (toolCallAccumulator.size > 0) {
      toolCalls = [];
      for (const [, tc] of toolCallAccumulator) {
        let input = {};
        if (tc.arguments) {
          try { input = JSON.parse(tc.arguments); } catch { input = { raw: tc.arguments }; }
        }
        toolCalls.push({ id: tc.id, name: tc.name, input });
      }
      finishReason = 'tool_use';
      yield { type: 'tool_calls', toolCalls };
    }

    const response = {
      content: fullContent || null,
      toolCalls,
      usage,
      model: responseModel,
      finishReason: finishReason === 'tool_calls' ? 'tool_use' : (finishReason || 'stop'),
    };

    // Track API call
    this.#trackApiCall(response, { ...options, model }, startMs);
    this.#clearTransportFailures('claude-proxy');

    yield { type: 'done', response };
  }

  #shouldShortCircuitFallback(err) {
    return err?.code === 'payload' || err?.code === 'auth_permanent' || err?.code === 'auth_refreshable';
  }

  async #buildCandidatePlan(requestedModel, options = {}) {
    const models = this.#buildModelCandidates(requestedModel);
    const transports = this.#buildTransportCandidates(options);
    const plan = [];
    for (const model of models) {
      for (const transport of transports) {
        plan.push({ model, transport });
      }
    }
    return plan;
  }

  #buildModelCandidates(requestedModel) {
    const now = Date.now();
    const unique = [];
    const push = (model) => {
      if (!model || unique.includes(model)) return;
      const cooldownUntil = this.#modelCooldowns.get(model) || 0;
      if (cooldownUntil > now) return;
      unique.push(model);
    };

    push(requestedModel);
    if (this.#config.fallbackModel && this.#config.fallbackModel !== requestedModel) push(this.#config.fallbackModel);
    const dynamicFallback = this.#config._dynamicFallbackModel;
    if (dynamicFallback) push(dynamicFallback);
    if (unique.length === 0) unique.push(requestedModel || this.#config.primaryModel);
    return unique;
  }

  #markModelUnavailable(model, ms = MODEL_404_COOLDOWN_MS) {
    if (!model) return;
    this.#modelCooldowns.set(model, Date.now() + ms);
  }

  #markTransportUnavailable(transport, ms = TRANSPORT_404_COOLDOWN_MS) {
    if (!transport) return;
    this.#transportCooldowns.set(transport, Date.now() + ms);
  }

  #buildTransportCandidates(options = {}) {
    const authMode = this.#config.authMode || 'api-key';
    const transports = [];
    if (authMode === 'gateway') {
      transports.push('openai');
    } else if (authMode === 'claude-proxy') {
      transports.push('claude-proxy');
      // DEPRECATED: Anthropic direct fallback removed. OAuth direct-to-Anthropic is blocked
      // by Anthropic (401 on third-party tokens). Adding 'anthropic' here only wastes retry
      // budget with guaranteed failures. Use claude-proxy exclusively.
      // If a real API key is ever configured, this can be re-enabled.
      if (this.#config.apiKey && !this.#config.apiKey.startsWith('sk-ant-oat')) transports.push('anthropic');
    } else if (authMode === 'oauth' || this.#config.provider === 'anthropic') {
      transports.push('anthropic');
      if (this.#config.proxyUrl) transports.push('claude-proxy');
    } else {
      transports.push('openai');
      if (this.#config.proxyUrl) transports.push('claude-proxy');
    }

    const unique = transports.filter((t, idx) => transports.indexOf(t) === idx);
    const available = unique.filter(t => !this.#isTransportCooling(t));
    const ordered = available.length > 0 ? available : unique;

    if (ordered.includes('anthropic') && ordered.includes('claude-proxy') && this.#isTransportDegraded('anthropic')) {
      return ordered.sort((a, b) => (a === 'claude-proxy' ? -1 : 1));
    }

    const trigger = String(options._trigger || '').toLowerCase();
    if (trigger.includes('planner') && ordered.includes('anthropic') && ordered.includes('claude-proxy') && this.#isTransportDegraded('anthropic')) {
      return ['claude-proxy', 'anthropic'];
    }

    return ordered;
  }

  #isTransportCooling(transport) {
    return (this.#transportCooldowns.get(transport) || 0) > Date.now();
  }

  #isTransportDegraded(transport) {
    if (this.#isTransportCooling(transport)) return true;
    const failures = this.#recentTransportFailures.get(transport) || [];
    const now = Date.now();
    return failures.filter(ts => (now - ts) <= TRANSPORT_FAILURE_WINDOW_MS).length >= TRANSPORT_FAILURE_THRESHOLD;
  }

  #noteTransportFailure(transport) {
    if (!transport) return;
    const now = Date.now();
    const failures = (this.#recentTransportFailures.get(transport) || []).filter(ts => (now - ts) <= TRANSPORT_FAILURE_WINDOW_MS);
    failures.push(now);
    this.#recentTransportFailures.set(transport, failures);
    if (failures.length >= TRANSPORT_FAILURE_THRESHOLD) {
      this.#markTransportUnavailable(transport, TRANSPORT_DEGRADED_COOLDOWN_MS);
    }
  }

  #clearTransportFailures(transport) {
    if (!transport) return;
    this.#recentTransportFailures.delete(transport);
    this.#transportCooldowns.delete(transport);
  }

  async #callViaTransport(transport, messages, options) {
    if (transport === 'claude-proxy') return await this.#callClaudeProxy(messages, options);
    if (transport === 'anthropic') return await this.#callAnthropic(messages, options);
    return await this.#callOpenAI(messages, options);
  }

  // Delegate one call attempt to a provider adapter. Pure transport — no retry,
  // no OAuth refresh, no stream_incomplete detection (router-owned per
  // src/providers/_contract.js). Maps AdapterError → LLMError so the existing
  // #callWithRetry classifier sees a familiar shape. Adapter must already be
  // resolved by the caller (B2/B3 will pass the registered adapter instance).
  async #callViaAdapter(adapter, opts) {
    if (!adapter || typeof adapter.doGenerate !== 'function') {
      throw new LLMError('callViaAdapter: adapter missing doGenerate', { code: 'unknown', model: opts?.model });
    }
    try {
      return await adapter.doGenerate(opts);
    } catch (err) {
      if (err && err.name === 'AdapterError') {
        throw new LLMError(err.message, {
          code: err.code || 'unknown',
          model: opts?.model,
          status: err.status || undefined,
          cause: err,
        });
      }
      throw err;
    }
  }

  async #discoverProxyModels(force = false) {
    if (!this.#config.proxyUrl) return [];
    const now = Date.now();
    if (!force && this.#proxyModelCatalog && (now - this.#proxyModelCatalog.fetchedAt) < PROXY_MODEL_CATALOG_TTL_MS) {
      return this.#proxyModelCatalog.models;
    }
    try {
      const url = this.#config.proxyUrl.replace(/\/chat\/completions$/, '/models').replace(/\/v1$/, '/models');
      const resp = await this.#fetch(url, { method: 'GET' }, { transport: 'claude-proxy', timeoutMs: Math.min(this.#config.timeoutMs, 30000) });
      if (!resp.ok) return [];
      const data = await resp.json();
      const models = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
      this.#proxyModelCatalog = { models, fetchedAt: now };
      return models;
    } catch {
      return [];
    }
  }

  async #discoverReplacementModel(failedModel) {
    const available = await this.#discoverProxyModels();
    if (!available.length) return null;
    // Look for a same-family substitute (token shared with the failed model id).
    // Provider-agnostic: works for any naming scheme — pick the first available
    // model whose id shares any non-trivial token with the failed model, then
    // fall back to the first available model overall.
    const failed = String(failedModel || '').toLowerCase();
    const tokens = failed.split(/[^a-z0-9]+/).filter(t => t && t.length >= 3);
    for (const tok of tokens) {
      const hit = available.find(m => String(m).toLowerCase() !== failed && String(m).toLowerCase().includes(tok));
      if (hit) return hit;
    }
    return available.find(m => String(m).toLowerCase() !== failed) || available[0] || null;
  }

  /**
   * Summarize text using the compact (cheaper) model.
   * 
   * @param {string} text - Text to summarize
   * @param {string} [instruction] - Custom summarization instruction
   * @returns {Promise<string>} Summary text
   */
  async summarize(text, instruction) {
    const prompt = instruction || 
      'Summarize the following conversation concisely, preserving key decisions, ' +
      'facts, and context. Use the same language as the original. Be dense but complete.';

    const response = await this.chat(
      [{ role: 'user', content: `${prompt}\n\n---\n\n${text}` }],
      {
        model: this.#config.compactModel || this.#config.primaryModel,
        _role: 'compact',
        temperature: 0.3,
        maxTokens: 2048,
      }
    );

    return response.content || '';
  }

  /**
   * Estimate token count without API call.
   * Uses chars/3.5 heuristic — conservative for mixed CJK + English.
   * 
   * @param {string|Object} input - Text string or message object/array
   * @returns {number} Estimated token count
   */
  estimateTokens(input) {
    if (!input) return 0;
    
    let text;
    if (typeof input === 'string') {
      text = input;
    } else if (Array.isArray(input)) {
      text = input.map(m => {
        if (typeof m === 'string') return m;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content.map(b => b.text || '').join('');
        }
        return JSON.stringify(m);
      }).join('\n');
    } else if (typeof input === 'object') {
      text = typeof input.content === 'string' ? input.content : JSON.stringify(input);
    } else {
      text = String(input);
    }
    
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Health check — verify API key and model access.
   * @returns {Promise<{ok: boolean, model: string, error?: string}>}
   */
  async healthCheck() {
    try {
      const response = await this.chat(
        [{ role: 'user', content: 'Reply with exactly: OK' }],
        { maxTokens: 10, temperature: 0 }
      );
      return { ok: true, model: response.model };
    } catch (err) {
      return { ok: false, model: this.#config.primaryModel, error: err.message };
    }
  }

  // ─── Private: Retry Logic ───────────────────────────────────────────────

  /**
   * Call LLM with exponential backoff retry.
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} options
   * @returns {Promise<LLMResponse>}
   */
  async #callWithRetry(messages, options, candidate) {
    const maxRetries = options._maxRetries ?? this.#config.maxRetries;
    const startMs = Date.now();
    let lastError;
    let effectiveOptions = { ...options };
    let usedAnthropicSanitizeRetry = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.#callViaTransport(candidate.transport, messages, effectiveOptions);
        this.#clearTransportFailures(candidate.transport);
        this.emit('success', { model: effectiveOptions.model, attempt, transport: candidate.transport, usage: response.usage });
        this.#trackApiCall(response, effectiveOptions, startMs);
        return response;
      } catch (err) {
        const classified = this.#classifyError(err, candidate);
        lastError = classified.error;

        const isAnthropicTransport = candidate.transport === 'anthropic' || candidate.transport === 'claude-proxy';
        if (isAnthropicTransport && classified.kind === 'payload_invalid' && !usedAnthropicSanitizeRetry && this.#isAnthropicToolProtocolError(classified.error)) {
          usedAnthropicSanitizeRetry = true;
          effectiveOptions = { ...effectiveOptions, _anthropicRepairMode: 'aggressive' };
          this.emit('warning', { type: 'anthropic_sanitize_retry', model: effectiveOptions.model, transport: candidate.transport, error: classified.error.message });
          attempt -= 1;
          continue;
        }

        if (classified.kind === 'model_not_found') {
          this.#markModelUnavailable(effectiveOptions.model);
          const replacement = await this.#discoverReplacementModel(effectiveOptions.model);
          if (replacement && replacement !== effectiveOptions.model && !effectiveOptions._modelAutoReplaced) {
            this.#config._dynamicFallbackModel = replacement;
            effectiveOptions = { ...effectiveOptions, model: replacement, _modelAutoReplaced: true };
            this.emit('warning', { type: 'model_autoreplaced', from: options.model, to: replacement, transport: candidate.transport });
            attempt -= 1;
            continue;
          }
          throw classified.error;
        }

        if (classified.kind === 'auth_refreshable') {
          const previousToken = this.#oauthState.token || normalizeBearerToken(this.#config.oauthToken || '');
          const reloaded = await this.#ensureOAuthToken({ forceRefresh: true, reason: 'auth_error' });
          if (reloaded && reloaded !== previousToken) {
            attempt -= 1;
            continue;
          }

          if (this.#canAutoRefreshOAuth()) {
            const refreshed = await this.#refreshOAuthTokenSingleflight('auth_error');
            if (refreshed && refreshed !== previousToken) {
              attempt -= 1;
              continue;
            }
          }

          this.#markTransportUnavailable(candidate.transport, TRANSPORT_AUTH_COOLDOWN_MS);
          const extra = this.#isSetupTokenMode()
            ? ' — Claude setup-token looks invalid or expired. Replace llm.oauthToken with a fresh `claude setup-token` value.'
            : ' — OAuth credential needs re-authentication.';
          throw new LLMError(`${classified.error.message}${extra}`, { code: 'auth_permanent', model: effectiveOptions.model, status: classified.error.status, cause: classified.error });
        }

        if (classified.kind === 'transport_transient') {
          this.#noteTransportFailure(candidate.transport);
        }

        if (classified.kind === 'provider_temporary' || classified.kind === 'transport_transient' || classified.kind === 'timeout' || classified.kind === 'rate_limit') {
          const isRateLimit = classified.kind === 'rate_limit';
          const effectiveMaxRetries = isRateLimit ? Math.max(maxRetries, 4) : maxRetries;
          if (attempt < effectiveMaxRetries) {
            const baseDelay = isRateLimit ? BASE_DELAY_MS * 3 : BASE_DELAY_MS;
            const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, isRateLimit ? 60_000 : MAX_DELAY_MS);
            this.emit('retry', { model: effectiveOptions.model, attempt: attempt + 1, delay, transport: candidate.transport, error: classified.error });
            await sleep(delay);
            continue;
          }
        }

        throw classified.error;
      }
    }

    throw lastError;
  }

  #classifyError(err, candidate) {
    const model = candidate?.model || err?.model || 'unknown';
    const status = err?.status || 0;
    const message = String(err?.message || '');
    const base = err instanceof LLMError ? err : new LLMError(message || 'LLM request failed', { code: 'unknown', model, cause: err, status });

    if (status === 404) return { kind: 'model_not_found', error: new LLMError(base.message, { code: 'model_not_found', model, status, cause: base.cause || base }) };
    if (status === 401 || status === 403) return { kind: 'auth_refreshable', error: new LLMError(base.message, { code: 'auth_refreshable', model, status, cause: base.cause || base }) };
    if (status === 429 || status === 529) return { kind: 'rate_limit', error: base };
    if (status >= 500) return { kind: 'provider_temporary', error: base };
    if (status === 400) return { kind: 'payload_invalid', error: new LLMError(base.message, { code: 'payload', model, status, cause: base.cause || base }) };
    if (base.code === 'timeout' || /timed out/i.test(message)) return { kind: 'timeout', error: new LLMError(base.message, { code: 'timeout', model, status, cause: base.cause || base }) };
    if (/fetch failed|econnreset|enotfound|eai_again|socket hang up|network error/i.test(message) || base.code === 'network') {
      return { kind: 'transport_transient', error: new LLMError(base.message, { code: 'network', model, status, cause: base.cause || base }) };
    }
    // Code-based fallbacks for AdapterError-mapped LLMErrors that arrive without a status
    // (e.g. JSON parse failures, network-layer surface). Status-based branches above
    // already handle the normal HTTP-error path; this just catches the edge case.
    if (base.code === 'rate_limit' || base.code === 'overloaded') return { kind: 'rate_limit', error: base };
    if (base.code === 'auth') return { kind: 'auth_refreshable', error: new LLMError(base.message, { code: 'auth_refreshable', model, status, cause: base.cause || base }) };
    if (base.code === 'transient') return { kind: 'transport_transient', error: new LLMError(base.message, { code: 'network', model, status, cause: base.cause || base }) };
    return { kind: 'fatal', error: base };
  }

  async #ensureOAuthToken({ forceRefresh = false, reason = 'request' } = {}) {
    if ((this.#config.authMode || 'api-key') !== 'oauth') {
      // Non-oauth mode (e.g. claude-proxy fallback): return the eagerly-loaded
      // token from oauthState if available, otherwise try reading credentials file.
      if (this.#oauthState.token) return this.#oauthState.token;
      if (this.#config.oauthCredentialsPath) {
        const fresh = readOAuthCredentials(this.#config.oauthCredentialsPath);
        if (fresh?.accessToken) {
          this.#applyOAuthMaterial(fresh, { source: 'credentials' });
          return this.#oauthState.token;
        }
      }
      return this.#config.oauthToken || null;
    }

    const explicitToken = normalizeBearerToken(this.#config.oauthToken || '');
    if (explicitToken) {
      if (explicitToken !== this.#oauthState.token || this.#oauthState.authFlavor === 'unknown') {
        this.#applyOAuthMaterial({ accessToken: explicitToken, expiresAt: 0 }, { source: 'config' });
      }
      return explicitToken;
    }

    const now = Date.now();
    if (!forceRefresh && this.#oauthState.token && (now - this.#oauthState.checkedAt) < OAUTH_RELOAD_INTERVAL_MS) {
      return this.#oauthState.token;
    }

    const fresh = this.#config.oauthCredentialsPath ? readOAuthCredentials(this.#config.oauthCredentialsPath) : null;
    if (fresh?.accessToken) {
      this.#applyOAuthMaterial(fresh, { source: 'credentials' });
    }

    const nearExpiry = this.#oauthState.expiresAt > 0 && (this.#oauthState.expiresAt - now) < OAUTH_NEAR_EXPIRY_MS;
    if (this.#canAutoRefreshOAuth() && (forceRefresh || nearExpiry) && !this.#isTransportDegraded('anthropic')) {
      const refreshed = await this.#refreshOAuthTokenSingleflight(reason);
      if (refreshed) return refreshed;
    }
    return this.#oauthState.token || this.#config.oauthToken;
  }

  async #refreshOAuthTokenSingleflight(reason = 'refresh') {
    if (!this.#canAutoRefreshOAuth()) return null;
    const now = Date.now();
    if (this.#oauthState.refreshPromise) return await this.#oauthState.refreshPromise;
    if (this.#oauthState.refreshCooldownUntil > now) return null;

    this.#oauthState.refreshPromise = (async () => {
      try {
        const current = this.#config.oauthCredentialsPath ? readOAuthCredentials(this.#config.oauthCredentialsPath) : null;
        if (!current?.refreshToken) return current?.accessToken || this.#config.oauthToken || null;

        console.log('[LLM] OAuth token expired or near expiry, refreshing...');
        const resp = await this.#fetch('https://console.anthropic.com/v1/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizeJsonValue({
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken,
            client_id: current.clientId || 'claude-cli',
          })),
        }, { transport: 'anthropic', timeoutMs: 20000, skipAuthRefresh: true });

        if (resp.ok) {
          const data = await resp.json();
          current.credentials.claudeAiOauth.accessToken = data.access_token;
          current.credentials.claudeAiOauth.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
          if (data.refresh_token) current.credentials.claudeAiOauth.refreshToken = data.refresh_token;
          writeFileSync(this.#config.oauthCredentialsPath, JSON.stringify(current.credentials, null, 2));
          this.#oauthState.token = data.access_token;
          this.#oauthState.expiresAt = normalizeExpiresAt(current.credentials.claudeAiOauth.expiresAt);
          this.#oauthState.checkedAt = Date.now();
          this.#config.oauthToken = data.access_token;
          console.log('[LLM] OAuth token refreshed successfully');
          return data.access_token;
        }

        console.warn(`[LLM] OAuth refresh API failed: ${resp.status}; waiting for external re-auth or token update.`);
        this.#oauthState.refreshCooldownUntil = Date.now() + AUTH_REFRESH_COOLDOWN_MS;
        return null;
      } catch (e) {
        console.error('[LLM] OAuth refresh error:', e.message);
        this.#oauthState.refreshCooldownUntil = Date.now() + AUTH_REFRESH_COOLDOWN_MS;
        return null;
      } finally {
        this.#oauthState.refreshPromise = null;
      }
    })();

    return await this.#oauthState.refreshPromise;
  }

  #resolveTimeoutMs(options = {}, transport) {
    if (options._timeoutMs) return options._timeoutMs;
    const trigger = String(options._trigger || '').toLowerCase();
    if (trigger.includes('planner')) return Math.min(this.#config.timeoutMs, 45_000);
    if (trigger.includes('summar') || trigger.includes('compact')) return Math.min(this.#config.timeoutMs, 180_000);
    if (trigger.includes('cron') || trigger.includes('distill')) return Math.min(this.#config.timeoutMs, 5_400_000);
    return this.#config.timeoutMs;
  }

  // Hard ceiling for a streaming call, by role. Soft liveness heartbeat is
  // removed (2026-04-28); only the hard timeout remains. Per-call override
  // via options._heartbeat.hardCeilingMs is honored for back-compat.
  #resolveHardCeiling(options = {}) {
    if (options._heartbeat && Number.isFinite(options._heartbeat.hardCeilingMs)) {
      return options._heartbeat.hardCeilingMs;
    }
    const role = String(options._role || 'main');
    return HARD_CEILING_PROFILES[role] || HARD_CEILING_DEFAULT;
  }

  /**
   * Record an API call in the api_calls table.
   * @param {LLMResponse} response
   * @param {ChatOptions} options
   * @param {number} startMs - Timestamp when the call started
   */
  #trackApiCall(response, options, startMs) {
    if (!this.#insertApiCall) return;
    try {
      const promptTotal = response.usage?.promptTokens || 0;
      const cacheRead = response.usage?.cacheRead || 0;
      const freshInput = Math.max(0, promptTotal - cacheRead);
      this.#insertApiCall.run(
        response.model || options.model || '',
        freshInput,
        response.usage?.completionTokens || 0,
        cacheRead,
        response.usage?.cacheWrite || 0,
        0, // cost_usd (can be computed later)
        Date.now() - startMs,
        options._trigger || null,
        options._sessionId || null,
      );
      liveBus.safeEmit('llm.call', {
        model: response.model || options.model || '',
        trigger: options._trigger || null,
        sessionId: options._sessionId || null,
        input: freshInput,
        output: response.usage?.completionTokens || 0,
        cacheRead,
        cacheWrite: response.usage?.cacheWrite || 0,
        ms: Date.now() - startMs,
      });
    } catch { /* non-critical */ }
  }

  // ─── Private: Anthropic Messages API ────────────────────────────────────

  /**
   * Direct call to Anthropic Messages API.
   * Handles: system prompt extraction, tool formatting, response parsing.
   * 
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} options
   * @returns {Promise<LLMResponse>}
   */
  async #callAnthropic(messages, options) {
    const repairMode = options._anthropicRepairMode || 'normal';

    // Extract system message (Anthropic uses top-level `system` field)
    let systemPrompt = options.system || '';
    const rawConversationMessages = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
      } else {
        rawConversationMessages.push(msg);
      }
    }

    const { conversationMessages, repairInfo } = this.#repairAndFormatAnthropicMessages(rawConversationMessages, repairMode);
    if (this.#hasAnthropicRepairChanges(repairInfo)) {
      this.emit('warning', {
        type: 'anthropic_history_repaired',
        mode: repairMode,
        ...repairInfo,
      });
    }

    // Build request body via adapter wire-format helper. Router pre-builds the
    // system blocks (cache_control injection) and pre-converts tools (OpenAI →
    // Anthropic shape); buildAnthropicRequest then assembles the final body.
    const preparedTools = options.tools?.length
      ? options.tools.map(t => this.#formatToolForAnthropic(t))
      : undefined;
    const preparedSystem = systemPrompt
      ? this.#buildAnthropicSystemBlocks(systemPrompt)
      : undefined;
    const body = buildAnthropicRequest({
      model: options.model,
      messages: conversationMessages,
      system: preparedSystem,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      tools: preparedTools,
      // Forced-tool-choice path for Mímir picker (2026-05-11 refactor).
      // Adapter `mapToolChoice` translates {name:'X'} → {type:'tool', name:'X'}.
      // When undefined, Anthropic defaults to 'auto'.
      toolChoice: options.toolChoice,
    });

    // Build headers based on auth mode
    const authMode = this.#config.authMode || 'api-key';
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
    if (authMode === 'gateway' && (!this.#config.baseUrl || !this.#config.apiKey)) {
      throw new LLMError('baseUrl + apiKey are required for authMode="gateway"', { code: 'auth', model: 'init' });
    }
    if (authMode === 'oauth') {
      const token = await this.#ensureOAuthToken({ reason: options._trigger || 'anthropic_request' });
      headers['Authorization'] = `Bearer ${token}`;
      if (this.#oauthState.authFlavor === 'oauth-access-token' && this.#config.oauthUseBetaHeader === true) {
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      }
    } else if (this.#config.apiKey) {
      headers['x-api-key'] = this.#config.apiKey;
    } else if (this.#config.oauthCredentialsPath || normalizeBearerToken(this.#config.oauthToken || '')) {
      // Fallback: use OAuth credentials even when authMode != 'oauth'
      // (e.g. claude-proxy mode falling back to direct Anthropic API)
      const token = await this.#ensureOAuthToken({ reason: options._trigger || 'anthropic_fallback' });
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        throw new LLMError('No credentials for Anthropic direct API (OAuth token could not be resolved)', { code: 'auth', model: options.model });
      }
    } else {
      throw new LLMError('No credentials for Anthropic direct API (no apiKey configured)', { code: 'auth', model: options.model });
    }

    // Make request
    const url = `${this.#config.baseUrl}/v1/messages`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      body: this.#jsonBody(body),
    }, { transport: 'anthropic', timeoutMs: this.#resolveTimeoutMs(options, 'anthropic') });

    if (!response.ok) {
      await this.#handleErrorResponse(response, options.model);
    }

    const data = await response.json();
    const inputTokens = data?.usage?.input_tokens || 0;
    const cacheRead = data?.usage?.cache_read_input_tokens || 0;
    const cacheWrite = data?.usage?.cache_creation_input_tokens || 0;
    if (cacheRead > 0 || cacheWrite > 0) {
      const hitRate = inputTokens > 0 ? Math.round(cacheRead / inputTokens * 100) : 0;
      console.log(`[LLM] Cache: read=${cacheRead}, write=${cacheWrite}, input=${inputTokens}, hit=${hitRate}%`);
    } else if (inputTokens > 0) {
      console.log(`[LLM] Cache: MISS (input=${inputTokens}, no cache activity)`);
    }
    return parseAnthropicWireResponse(data, options.model);
  }

  #repairAndFormatAnthropicMessages(messages, mode = 'normal') {
    const normalized = messages
      .map(msg => this.#normalizeMessage(msg))
      .filter(Boolean);

    const conversationMessages = [];
    const repairInfo = {
      normalizedFieldAliases: 0,
      mergedToolResultMessages: 0,
      mergedConsecutiveTurns: 0,
      droppedOrphanToolResults: 0,
      droppedDanglingToolUses: 0,
      strippedEmptyTextBlocks: 0,
    };

    for (let i = 0; i < normalized.length; i++) {
      const msg = normalized[i];

      if (msg._normalizedAliases) {
        repairInfo.normalizedFieldAliases += msg._normalizedAliases;
      }

      if (msg.role === 'tool') {
        // Tool results are only valid when consumed immediately after an assistant tool_use turn.
        repairInfo.droppedOrphanToolResults++;
        continue;
      }

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        let j = i + 1;
        const toolMessages = [];
        while (j < normalized.length && normalized[j].role === 'tool') {
          toolMessages.push(normalized[j]);
          j++;
        }

        const resultsById = new Map();
        for (const toolMsg of toolMessages) {
          if (toolMsg.tool_call_id && !resultsById.has(toolMsg.tool_call_id)) {
            resultsById.set(toolMsg.tool_call_id, toolMsg);
          }
        }

        const matchedCalls = [];
        for (const tc of msg.tool_calls) {
          if (tc.id && resultsById.has(tc.id)) {
            matchedCalls.push(tc);
          } else {
            repairInfo.droppedDanglingToolUses++;
          }
        }

        for (const toolMsg of toolMessages) {
          if (!toolMsg.tool_call_id || !msg.tool_calls.some(tc => tc.id === toolMsg.tool_call_id)) {
            repairInfo.droppedOrphanToolResults++;
          }
        }

        const textBlocks = this.#toAnthropicTextBlocks(msg.content, repairInfo);

        if (matchedCalls.length === 0) {
          if (textBlocks.length > 0) {
            this.#pushAnthropicMessage(conversationMessages, { role: 'assistant', content: textBlocks }, repairInfo);
          }
          i = j - 1;
          continue;
        }

        const assistantContent = [
          ...textBlocks,
          ...matchedCalls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.input ?? {},
          })),
        ];
        this.#pushAnthropicMessage(conversationMessages, { role: 'assistant', content: assistantContent }, repairInfo);

        const userContent = matchedCalls.map(tc =>
          this.#formatAnthropicToolResult(resultsById.get(tc.id))
        );
        this.#pushAnthropicMessage(conversationMessages, { role: 'user', content: userContent }, repairInfo, { mergePlainText: false });

        if (toolMessages.length > 1) {
          repairInfo.mergedToolResultMessages += toolMessages.length - 1;
        }

        i = j - 1;
        continue;
      }

      const textBlocks = this.#toAnthropicTextBlocks(msg.content, repairInfo);
      if (textBlocks.length === 0) continue;

      this.#pushAnthropicMessage(conversationMessages, {
        role: msg.role,
        content: textBlocks,
      }, repairInfo);
    }

    if (mode === 'aggressive') {
      while (conversationMessages.length > 0) {
        const last = conversationMessages[conversationMessages.length - 1];
        if (last.role === 'assistant' && last.content?.some(b => b.type === 'tool_use')) {
          repairInfo.droppedDanglingToolUses += last.content.filter(b => b.type === 'tool_use').length;
          const textOnly = last.content.filter(b => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
          if (textOnly.length > 0) {
            last.content = textOnly;
            break;
          }
          conversationMessages.pop();
          continue;
        }
        break;
      }
    }

    return { conversationMessages, repairInfo };
  }

  #normalizeMessage(msg) {
    if (!msg || !msg.role) return null;

    let normalizedAliases = 0;
    const toolCallsSource = msg.tool_calls ?? msg.toolCalls ?? null;
    if (msg.toolCalls && !msg.tool_calls) normalizedAliases++;
    const toolCallId = msg.tool_call_id ?? msg.toolCallId ?? null;
    if (msg.toolCallId && !msg.tool_call_id) normalizedAliases++;

    const normalized = {
      role: msg.role,
      content: msg.content ?? '',
      _normalizedAliases: normalizedAliases,
    };

    if (toolCallsSource) {
      normalized.tool_calls = this.#normalizeToolCalls(toolCallsSource);
    }
    if (toolCallId) {
      normalized.tool_call_id = toolCallId;
    }

    return normalized;
  }

  #normalizeToolCalls(toolCalls) {
    let calls = toolCalls;
    if (typeof calls === 'string') {
      try {
        calls = JSON.parse(calls);
      } catch {
        calls = [];
      }
    }
    if (!Array.isArray(calls)) return [];

    return calls.map((tc, index) => {
      const argsSource = tc.input ?? tc.arguments ?? tc.function?.arguments ?? {};
      let input = argsSource;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { input = { raw: input }; }
      }
      return {
        id: tc.id ?? tc.toolCallId ?? `tool-call-${index}`,
        name: tc.name ?? tc.toolName ?? tc.function?.name ?? 'unknown_tool',
        input: (input && typeof input === 'object') ? input : {},
      };
    }).filter(tc => tc.id && tc.name);
  }

  #toAnthropicTextBlocks(content, repairInfo) {
    if (content == null) return [];

    const makeTextBlock = (value) => {
      const text = String(value ?? '');
      if (!text.trim()) {
        repairInfo.strippedEmptyTextBlocks++;
        return null;
      }
      return { type: 'text', text };
    };

    if (typeof content === 'string') {
      const block = makeTextBlock(content);
      return block ? [block] : [];
    }

    if (Array.isArray(content)) {
      const blocks = [];
      for (const block of content) {
        if (!block) continue;
        if (typeof block === 'string') {
          const textBlock = makeTextBlock(block);
          if (textBlock) blocks.push(textBlock);
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          const textBlock = makeTextBlock(block.text);
          if (textBlock) blocks.push(textBlock);
          continue;
        }
        const textBlock = makeTextBlock(JSON.stringify(block));
        if (textBlock) blocks.push(textBlock);
      }
      return blocks;
    }

    const block = makeTextBlock(JSON.stringify(content));
    return block ? [block] : [];
  }

  #pushAnthropicMessage(target, message, repairInfo, { mergePlainText = true } = {}) {
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return;

    const hasStructuredBlocks = content.some(block => block.type !== 'text');
    const last = target[target.length - 1];

    if (
      mergePlainText &&
      last &&
      last.role === message.role &&
      !last.content.some(block => block.type !== 'text') &&
      !hasStructuredBlocks
    ) {
      last.content.push({ type: 'text', text: content.map(block => block.text).join('\n\n') });
      repairInfo.mergedConsecutiveTurns++;
      return;
    }

    target.push({
      role: message.role,
      content,
    });
  }

  #formatAnthropicToolResult(toolMsg) {
    const rawContent = toolMsg?.content;
    let content;
    if (Array.isArray(rawContent)) {
      content = rawContent;
    } else if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (rawContent == null) {
      content = '';
    } else {
      content = JSON.stringify(rawContent);
    }

    const block = {
      type: 'tool_result',
      tool_use_id: toolMsg?.tool_call_id,
      content,
    };

    if (this.#looksLikeToolError(rawContent)) {
      block.is_error = true;
    }

    return block;
  }

  #looksLikeToolError(content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return /^error[:\s]/i.test(text) || /^\[tool error/i.test(text) || /Error executing /i.test(text);
  }

  #hasAnthropicRepairChanges(repairInfo) {
    return Object.values(repairInfo).some(v => Number(v) > 0);
  }

  #isAnthropicToolProtocolError(err) {
    const msg = String(err?.message || '');
    return /tool_result/i.test(msg)
      || /tool_use_id/i.test(msg)
      || /immediately after/i.test(msg)
      || /roles must alternate/i.test(msg);
  }

  /**
   * Format a message for Anthropic's format.
   * Converts tool_calls/tool results to Anthropic content blocks.
   * 
   * @param {LLMMessage} msg
   * @returns {Object} Anthropic-formatted message
   */
  #formatMessageForAnthropic(msg) {
    const normalized = this.#normalizeMessage(msg);
    if (!normalized) {
      return { role: 'user', content: [{ type: 'text', text: '' }] };
    }

    if (normalized.role === 'tool') {
      return {
        role: 'user',
        content: [this.#formatAnthropicToolResult(normalized)],
      };
    }

    if (normalized.role === 'assistant' && normalized.tool_calls?.length) {
      const content = [
        ...this.#toAnthropicTextBlocks(normalized.content, {
          strippedEmptyTextBlocks: 0,
        }),
        ...normalized.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input ?? {},
        })),
      ];
      return { role: 'assistant', content };
    }

    return {
      role: normalized.role,
      content: this.#toAnthropicTextBlocks(normalized.content, {
        strippedEmptyTextBlocks: 0,
      }),
    };
  }

  /**
   * Format a tool definition for Anthropic's format.
   * Accepts both OpenAI-style and Anthropic-style definitions.
   * 
   * @param {Object} tool
   * @returns {Object} Anthropic tool definition
   */
  #buildAnthropicSystemBlocks(systemPrompt) {
    const text = String(systemPrompt || '');
    if (!text.includes(SYSTEM_CACHE_BREAK)) {
      return [{
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      }];
    }

    const [stableRaw, ...rest] = text.split(SYSTEM_CACHE_BREAK);
    const stable = stableRaw.trim();
    const dynamic = rest.join(SYSTEM_CACHE_BREAK).trim();
    const blocks = [];
    if (stable) {
      blocks.push({
        type: 'text',
        text: stable,
        cache_control: { type: 'ephemeral' },
      });
    }
    if (dynamic) {
      blocks.push({ type: 'text', text: dynamic });
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text }];
  }

  #formatToolForAnthropic(tool) {
    // Already in Anthropic format
    if (tool.input_schema) return tool;

    // OpenAI format → Anthropic
    if (tool.type === 'function' && tool.function) {
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
      };
    }

    // Bare format
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
    };
  }

  // Anthropic response parsing + stop-reason mapping moved to src/providers/anthropic.js
  // (parseResponse + mapStopReason). #callAnthropic imports them as parseAnthropicWireResponse.

  // ─── Private: Claude CLI Proxy (OpenAI-compatible) ─────────────────────

  /**
   * Call Claude via local CLI proxy (OpenAI-compatible format).
   * The proxy forwards requests using Claude CLI's OAuth token.
   * 
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} options
   * @returns {Promise<LLMResponse>}
   */
  async #callClaudeProxy(messages, options) {
    const resolvedTimeout = this.#resolveTimeoutMs(options, 'claude-proxy');
    const body = {
      model: options.model,
      messages: messages.map(m => this.#formatMessageForOpenAI(m)),
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      timeout: resolvedTimeout, // pass to proxy so subprocess uses matching timeout
    };

    if (options.system) {
      body.messages.unshift({ role: 'system', content: options.system });
    }

    // Pass short key instructions as real system prompt via CLI --append-system-prompt
    if (options.appendSystemPrompt) {
      body.appendSystemPrompt = options.appendSystemPrompt;
    }

    if (options.tools?.length) {
      body.tools = options.tools.map(t => this.#formatToolForOpenAI(t));
      // Forced tool_choice (2026-05-12 picker fix): claude-proxy is OpenAI-shape,
      // accept the same translation as #callOpenAI. Without this, Mímir picker's
      // forced select_action call collapses to plain LLM text → action=null.
      if (options.toolChoice) {
        if (typeof options.toolChoice === 'string') {
          body.tool_choice = options.toolChoice;
        } else if (options.toolChoice.name) {
          body.tool_choice = { type: 'function', function: { name: options.toolChoice.name } };
        }
      }
    }

    const proxyUrl = this.#config.proxyUrl.replace(/\/+$/, '');
    const url = `${proxyUrl}/chat/completions`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#config.apiKey ? { 'Authorization': `Bearer ${this.#config.apiKey}` } : {}),
      },
      body: this.#jsonBody(body),
    }, { transport: 'claude-proxy', timeoutMs: this.#resolveTimeoutMs(options, 'claude-proxy') });

    if (!response.ok) {
      await this.#handleErrorResponse(response, options.model);
    }

    const data = await response.json();
    return this.#parseOpenAIResponse(data, options.model);
  }

  // ─── Private: OpenAI-Compatible (LiteLLM) ──────────────────────────────

  /**
   * Call OpenAI-compatible endpoint (LiteLLM proxy).
   * 
   * @param {LLMMessage[]} messages
   * @param {ChatOptions} options
   * @returns {Promise<LLMResponse>}
   */
  async #callOpenAI(messages, options) {
    const body = {
      model: options.model,
      messages: messages.map(m => this.#formatMessageForOpenAI(m)),
      max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    };

    if (options.system) {
      body.messages.unshift({ role: 'system', content: options.system });
    }

    if (options.tools?.length) {
      body.tools = options.tools.map(t => this.#formatToolForOpenAI(t));
      // Forced-tool-choice for Mímir picker (2026-05-11). OpenAI shape:
      // string ('auto'|'none'|'required') OR {type:'function', function:{name}}.
      // Router input accepts {name:'X'} → translated here.
      if (options.toolChoice) {
        if (typeof options.toolChoice === 'string') {
          body.tool_choice = options.toolChoice;
        } else if (options.toolChoice.name) {
          body.tool_choice = { type: 'function', function: { name: options.toolChoice.name } };
        }
      }
    }

    // Accept both `https://host/v1` and `https://host` (OpenAI-standard ships with /v1;
    // the wizard's Test Connection assumes /v1 is in baseUrl too). Without this strip,
    // `http://127.0.0.1:3456/v1` produced `/v1/v1/chat/completions` → 404.
    const apiBase = (this.#config.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    const url = `${apiBase}/v1/chat/completions`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#config.apiKey}`,
      },
      body: this.#jsonBody(body),
    }, { transport: 'openai', timeoutMs: this.#resolveTimeoutMs(options, 'openai') });

    if (!response.ok) {
      await this.#handleErrorResponse(response, options.model);
    }

    const data = await response.json();
    return this.#parseOpenAIResponse(data, options.model);
  }

  /**
   * Format message for OpenAI-compatible API.
   * @param {LLMMessage} msg
   * @returns {Object}
   */
  #formatMessageForOpenAI(msg) {
    const normalized = this.#normalizeMessage(msg);
    if (!normalized) return { role: 'user', content: '' };

    if (normalized.role === 'tool') {
      return {
        role: 'tool',
        content: typeof normalized.content === 'string' ? normalized.content : JSON.stringify(normalized.content),
        tool_call_id: normalized.tool_call_id,
      };
    }

    if (normalized.role === 'assistant' && normalized.tool_calls?.length) {
      return {
        role: 'assistant',
        content: normalized.content || null,
        tool_calls: normalized.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.input || {}),
          },
        })),
      };
    }

    return { role: normalized.role, content: normalized.content };
  }

  /**
   * Format tool for OpenAI-compatible API.
   * @param {Object} tool
   * @returns {Object}
   */
  #formatToolForOpenAI(tool) {
    if (tool.type === 'function') return tool;

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
      },
    };
  }

  /**
   * Parse OpenAI-compatible response.
   * @param {Object} data
   * @param {string} [requestedModel] - The model the caller asked for; trusted over data.model.
   *   Some local gateways echo back a different model id than what was requested.
   * @returns {LLMResponse}
   */
  #parseOpenAIResponse(data, requestedModel) {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new LLMError('No choices in response', { code: 'unknown', model: requestedModel || data.model });
    }

    const msg = choice.message;
    let toolCalls = null;

    if (msg.tool_calls?.length) {
      toolCalls = msg.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));
    }

    // Usage: try OpenAI format first, then Anthropic format, then estimate from content
    const u = data.usage || {};
    const cacheRead = u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    // OpenAI prompt_tokens INCLUDES cached; Anthropic input_tokens is fresh-only.
    // Normalize promptTokens to total input so totalTokens = prompt + completion is correct.
    let promptTokens = u.prompt_tokens != null
      ? u.prompt_tokens
      : (u.input_tokens || 0) + cacheRead;
    let completionTokens = u.completion_tokens || u.output_tokens || 0;
    // If proxy returned no usage data, estimate from response content length
    if (completionTokens === 0 && msg.content) {
      completionTokens = Math.ceil(msg.content.length / 3.5);
    }

    return {
      content: msg.content || null,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cacheRead,
        cacheWrite,
      },
      model: requestedModel || data.model || 'unknown',
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason || 'stop'),
    };
  }


  #jsonBody(body) {
    return JSON.stringify(this.#sanitizeForJson(body));
  }

  #sanitizeForJson(value) {
    if (typeof value === 'string') return this.#sanitizeString(value);
    if (Array.isArray(value)) return value.map(v => this.#sanitizeForJson(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.#sanitizeForJson(v);
      return out;
    }
    return value;
  }

  #sanitizeString(text) {
    const str = String(text ?? '');
    if (typeof str.toWellFormed === 'function') return str.toWellFormed();
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          out += str[i] + str[i + 1];
          i += 1;
        } else {
          out += '�';
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        out += '�';
      } else {
        out += str[i];
      }
    }
    return out;
  }

  // ─── Private: HTTP + Error Handling ─────────────────────────────────────

  /**
   * Fetch with timeout.
   * @param {string} url
   * @param {Object} options
   * @returns {Promise<Response>}
   */
  async #fetch(url, options, ctx = {}) {
    const timeoutMs = ctx.timeoutMs || this.#config.timeoutMs;
    const ipv4Only = this.#config.ipv4Only !== false;
    const requestImpl = this.#config.requestImpl;

    try {
      if (typeof requestImpl === 'function') {
        return await requestImpl(url, options, { ...ctx, timeoutMs, ipv4Only });
      }
      return await nodeRequest(url, options, { timeoutMs, ipv4Only });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new LLMError(`Request timed out after ${timeoutMs}ms`, {
          code: 'timeout',
          model: 'unknown',
          cause: err,
        });
      }
      throw new LLMError(`Network error: ${err.message}`, {
        code: 'network',
        model: 'unknown',
        cause: err,
      });
    }
  }

  /**
   * Handle non-OK HTTP response — parse error and throw typed LLMError.
   * @param {Response} response
   * @param {string} model
   * @throws {LLMError}
   */
  async #handleErrorResponse(response, model) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }

    let errorMessage;
    try {
      const parsed = JSON.parse(errorBody);
      errorMessage = parsed.error?.message || parsed.message || errorBody;
    } catch {
      errorMessage = errorBody || `HTTP ${response.status}`;
    }

    const authMode = this.#config.authMode || 'api-key';
    let code;
    if (response.status === 401 || response.status === 403) {
      code = 'auth';
      if (authMode === 'gateway' && (!this.#config.baseUrl || !this.#config.apiKey)) {
      throw new LLMError('baseUrl + apiKey are required for authMode="gateway"', { code: 'auth', model: 'init' });
    }
    if (authMode === 'oauth') {
        errorMessage += this.#isSetupTokenMode() ? ' — setup-token may be invalid or expired. Replace llm.oauthToken with a fresh `claude setup-token` value.' : ' — OAuth credential may have expired or needs re-authentication.';
      }
    } else if (response.status === 429) {
      code = 'rate_limit';
    } else if (response.status === 529) {
      code = 'overloaded';
    } else {
      code = 'unknown';
    }

    throw new LLMError(`[${response.status}] ${errorMessage}`, {
      code,
      model,
      status: response.status,
    });
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default LLMRouter;
