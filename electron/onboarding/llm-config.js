// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage 3 — LLM provider configuration (Day 3 of OSS sprint).
//
// Mirrors src/views/first-run.html + src/providers/* but runs PRE-engine in the
// Electron main process. Cannot reuse those ESM modules from CJS without a
// dynamic import dance, so the bundled provider metadata + HTTP test/list logic
// is duplicated here. Keep in sync with src/providers/*.knownModels when
// shipping a new model family.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROLE_IDS = ['main', 'anamnesis', 'consolidation', 'worker', 'explore', 'compact'];

// Provider metadata. id is the wizard-internal slug. providerId / wireFormat are
// what the engine will see in config/llm-roles.json (matches src/providers/*).
const PROVIDER_CARDS = [
  {
    id: 'anthropic',
    providerId: 'anthropic',
    wireFormat: 'anthropic-messages',
    name: 'Anthropic Claude',
    icon: '🅰️',
    tag: 'API key',
    desc: 'Premium / balanced / fast model tiers via the Anthropic API.',
    envVar: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
    helpText: 'Anthropic keys start with sk-ant-api / sk-ant-oat / sk-ant-admin. A billing account is required.',
    knownModels: [
      { id: 'claude-opus-4-7',           label: 'Premium tier (smartest, slowest)',       tier: 'premium' },
      { id: 'claude-sonnet-4-6',         label: 'Balanced tier (recommended)',            tier: 'recommended' },
      { id: 'claude-haiku-4-5-20251001', label: 'Fast tier (fastest, cheapest)',          tier: 'fast' },
    ],
  },
  {
    id: 'openai',
    providerId: 'openai',
    wireFormat: 'openai-completions',
    name: 'OpenAI',
    icon: '💚',
    tag: 'API key',
    desc: 'GPT-5 family via platform.openai.com.',
    envVar: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    helpText: 'OpenAI keys start with sk- or sk-proj-.',
    knownModels: [
      { id: 'gpt-5',      label: 'GPT-5 (flagship)',                   tier: 'premium' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini (balanced, recommended)', tier: 'recommended' },
      { id: 'gpt-5-nano', label: 'GPT-5 nano (fastest, cheapest)',     tier: 'fast' },
      { id: 'gpt-4o',     label: 'GPT-4o (legacy)',                    tier: 'legacy' },
    ],
  },
  {
    id: 'codex-oauth',
    providerId: 'gateway',
    wireFormat: 'openai-completions',
    name: 'Codex OAuth',
    icon: '⌘',
    tag: 'Codex CLI',
    desc: 'Use your local Codex CLI login. Optional path for ChatGPT/Codex users.',
    envVar: null,
    apiKeyUrl: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
    defaultBaseUrl: 'http://127.0.0.1:3457/v1',
    needsKey: false,
    helpText: 'Install Codex CLI, run `codex login`, then click Test connection. Constellation only talks to a local shim and never reads your OAuth token.',
    knownModels: [
      { id: 'gpt-5.5',      label: 'Codex premium tier',                tier: 'premium' },
      { id: 'gpt-5.4-mini', label: 'Codex balanced tier (recommended)', tier: 'recommended' },
      { id: 'gpt-5',        label: 'GPT-5 fallback',                    tier: 'balanced' },
    ],
  },
  {
    id: 'gemini',
    providerId: 'gemini',
    wireFormat: 'gemini-generate',
    name: 'Google Gemini',
    icon: '✨',
    tag: 'API key',
    desc: 'Free tier on aistudio.google.com for low-volume use.',
    envVar: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    needsKey: true,
    helpText: 'Google AI Studio keys are free for low-volume use; paid tier required for production traffic.',
    knownModels: [
      { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro (smartest)',                tier: 'premium' },
      { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash (balanced, recommended)', tier: 'recommended' },
      { id: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash Lite (fastest)',          tier: 'fast' },
    ],
  },
  {
    id: 'openrouter',
    providerId: 'openrouter',
    wireFormat: 'openai-completions',
    name: 'OpenRouter',
    icon: '🛣️',
    tag: 'API key',
    desc: 'One key, many models (Claude / GPT / Llama / etc).',
    envVar: 'OPENROUTER_API_KEY',
    apiKeyUrl: 'https://openrouter.ai/keys',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    helpText: 'OpenRouter forwards to many providers; pick any model id from the catalog (e.g. provider/model-name format).',
    knownModels: [],   // listModels populates from /api/v1/models
  },
  {
    id: 'ollama',
    providerId: 'ollama',
    wireFormat: 'openai-completions',
    name: 'Ollama (local)',
    icon: '🦙',
    tag: 'No key',
    desc: 'Local models via ollama.com. Runs on your hardware, no per-token cost.',
    envVar: null,
    apiKeyUrl: 'https://ollama.com/download',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    helpText: 'Install Ollama, then pull a model: ollama pull llama3.3',
    knownModels: [
      { id: 'llama3.3',     label: 'Llama 3.3 70B (recommended)',  tier: 'recommended' },
      { id: 'llama3.2:3b',  label: 'Llama 3.2 3B (fast, small)',   tier: 'fast' },
      { id: 'qwen2.5',      label: 'Qwen 2.5 7B (multilingual)',   tier: 'balanced' },
    ],
  },
  {
    id: 'lmstudio',
    providerId: 'lmstudio',
    wireFormat: 'openai-completions',
    name: 'LM Studio (local)',
    icon: '🏠',
    tag: 'No key',
    desc: 'Desktop app for local models with a graphical UI.',
    envVar: null,
    apiKeyUrl: 'https://lmstudio.ai/',
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    helpText: 'In LM Studio: load a model, then click "Local Server" to start the OpenAI-compatible endpoint.',
    knownModels: [],   // listModels reads /v1/models
  },
  {
    id: 'vllm',
    providerId: 'vllm',
    wireFormat: 'openai-completions',
    name: 'vLLM (self-hosted)',
    icon: '⚡',
    tag: 'Optional token',
    desc: 'High-performance server. For user running their own GPU cluster.',
    envVar: 'VLLM_API_KEY',
    apiKeyUrl: 'https://docs.vllm.ai/',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    needsKey: false,
    helpText: 'Run: vllm serve <model>. Set base URL to wherever vllm is listening.',
    knownModels: [],
  },
  {
    id: 'custom',
    providerId: 'custom',
    wireFormat: 'openai-completions',
    name: 'Custom (OpenAI-compatible)',
    icon: '🔧',
    tag: 'Advanced',
    desc: 'Point at any OpenAI-compatible endpoint — local proxy, OAuth bridge, or third-party relay.',
    envVar: 'CUSTOM_OPENAI_API_KEY',
    apiKeyUrl: null,
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    needsKey: false,
    allowFreeTextModel: true,
    helpText: 'Free-text base URL + model. Most local bridges accept any non-empty key — leave blank to use a "local" sentinel.',
    knownModels: [],
  },
];

function getCard(cardId) {
  return PROVIDER_CARDS.find((c) => c.id === cardId) || null;
}

// ─── listModels ───────────────────────────────────────────────────────
// Returns { ok, models: [{id,label,tier?}], source: 'live'|'bundled', error? }.
// Always falls back to knownModels on failure so the UI is never empty when
// the bundled list has entries.

async function listModels(cardId, opts = {}) {
  const card = getCard(cardId);
  if (!card) return { ok: false, models: [], source: 'bundled', error: 'unknown provider card' };
  const apiKey = (opts.apiKey || '').trim();
  const baseUrl = (opts.baseUrl || card.defaultBaseUrl || '').replace(/\/$/, '');
  const bundled = (card.knownModels || []).map((m) => ({ ...m, source: 'bundled' }));

  let live = null;
  try {
    if (cardId === 'anthropic') {
      if (!apiKey) live = null;
      else {
        const r = await _fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/models`, {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        });
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data?.data)) {
            live = data.data.map((m) => ({ id: m.id, label: m.display_name || m.id, source: 'live' }));
          }
        }
      }
    } else if (cardId === 'custom') {
      // Custom endpoints are user-supplied — many local bridges don't implement
      // /v1/models at all. Skip the live probe entirely; UI uses free-text entry.
      live = null;
    } else if (cardId === 'codex-oauth') {
      // The shim exposes a small static /v1/models list. Keep the wizard fast
      // and avoid starting Codex just to render a dropdown.
      live = null;
    } else if (cardId === 'openai' || cardId === 'openrouter' || cardId === 'vllm' || cardId === 'lmstudio') {
      const headers = {};
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
      const url = `${baseUrl}/models`;
      const r = await _fetch(url, { headers });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.data)) {
          let items = data.data.map((m) => ({ id: m.id, label: m.id, source: 'live' }));
          // OpenAI direct: filter to chat-capable families to keep dropdown sane.
          if (cardId === 'openai') items = items.filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id));
          live = items;
        }
      }
    } else if (cardId === 'gemini') {
      if (!apiKey) live = null;
      else {
        const url = `${baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const r = await _fetch(url);
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data?.models)) {
            live = data.models
              .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
              .map((m) => ({ id: (m.name || '').replace(/^models\//, ''), label: m.displayName || m.name, source: 'live' }))
              .filter((m) => m.id);
          }
        }
      }
    } else if (cardId === 'ollama') {
      // Ollama exposes /api/tags (NOT under /v1).
      const root = baseUrl.replace(/\/v1$/, '');
      const r = await _fetch(`${root}/api/tags`);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data?.models)) {
          live = data.models.map((m) => ({ id: m.name || m.model, label: m.name || m.model, source: 'live' })).filter((m) => m.id);
        }
      }
    }
  } catch (err) {
    return { ok: bundled.length > 0, models: bundled, source: 'bundled', error: err.message };
  }

  if (live && live.length) {
    // Merge bundled tier hints onto live entries by id.
    const tierMap = new Map((card.knownModels || []).map((m) => [m.id, m.tier]));
    for (const m of live) if (tierMap.has(m.id)) m.tier = tierMap.get(m.id);
    return { ok: true, models: live, source: 'live' };
  }
  let fallbackError = null;
  if (live === null && card.needsKey && !apiKey) fallbackError = 'API key not provided yet — using bundled list.';
  else if (Array.isArray(live) && live.length === 0)
    fallbackError = `${card.name} returned no compatible models. Pull/load one first, then click Refresh.`;
  return { ok: bundled.length > 0, models: bundled, source: 'bundled', error: fallbackError };
}

// ─── testConnection ───────────────────────────────────────────────────
// Returns { ok, latencyMs, error?, hint? }. One token round-trip per call.

async function testConnection(cardId, opts = {}) {
  const card = getCard(cardId);
  if (!card) return { ok: false, error: 'unknown provider card' };
  let apiKey = (opts.apiKey || '').trim();
  const baseUrl = (opts.baseUrl || card.defaultBaseUrl || '').replace(/\/$/, '');
  const model = (opts.model || '').trim();
  if (!model) return { ok: false, error: 'no model selected' };
  if (card.needsKey && !apiKey) return { ok: false, error: `API key required for ${card.name}` };
  // Custom card: most local OAuth bridges expect a non-empty Authorization header
  // even when they don't validate it. Substitute a 'local' sentinel when empty.
  if ((cardId === 'custom' || cardId === 'codex-oauth') && !apiKey) apiKey = 'local';

  const t0 = Date.now();
  try {
    if (cardId === 'anthropic') {
      const r = await _fetch(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      });
      return await _interpretAnthropic(r, t0);
    }
    if (cardId === 'gemini') {
      const url = `${baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const r = await _fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      });
      return await _interpretGeneric(r, t0, 'gemini');
    }
    if (cardId === 'codex-oauth') {
      const repoRoot = opts.repoRoot || process.cwd();
      const ready = await ensureCodexShimReady({ repoRoot, baseUrl, model });
      if (!ready.ok) return { ok: false, error: ready.error, hint: ready.hint };
    }
    // OpenAI-compatible: openai / openrouter / ollama / lmstudio / vllm / codex-oauth
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    const r = await _fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    });
    return await _interpretGeneric(r, t0, cardId);
  } catch (err) {
    return { ok: false, error: err?.message || String(err), hint: _hintForError(cardId, err) };
  }
}

async function _interpretAnthropic(resp, t0) {
  if (resp.ok) {
    try { await resp.json(); } catch {}
    return { ok: true, latencyMs: Date.now() - t0 };
  }
  let body;
  try { body = await resp.json(); } catch { body = {}; }
  const msg = body?.error?.message || body?.message || `HTTP ${resp.status}`;
  return { ok: false, latencyMs: Date.now() - t0, error: msg, hint: _hintForStatus(resp.status, 'anthropic') };
}

async function _interpretGeneric(resp, t0, cardId) {
  if (resp.ok) {
    try { await resp.json(); } catch {}
    return { ok: true, latencyMs: Date.now() - t0 };
  }
  let body;
  try { body = await resp.json(); } catch { body = {}; }
  const msg = body?.error?.message || body?.message || `HTTP ${resp.status}`;
  return { ok: false, latencyMs: Date.now() - t0, error: msg, hint: _hintForStatus(resp.status, cardId) };
}

function _hintForStatus(status, cardId) {
  if (status === 401 || status === 403) return 'Auth failed — double-check the API key and that it has not been revoked.';
  if (status === 429) return 'Rate-limited or out of quota. Wait a moment or top up the account.';
  if (status === 404 && (cardId === 'ollama' || cardId === 'lmstudio')) return 'Local model not found. Pull or load the model first.';
  if (status >= 500) return 'Provider is currently unstable. Retry in a moment.';
  return null;
}

function _hintForError(cardId, err) {
  const m = String(err?.message || err || '');
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(m)) {
    if (cardId === 'ollama')   return 'Could not reach Ollama. Run `ollama serve` and try again.';
    if (cardId === 'lmstudio') return 'Could not reach LM Studio. Open the app and click "Start Server".';
    if (cardId === 'vllm')     return 'Could not reach vLLM. Confirm `vllm serve` is running on the configured port.';
    if (cardId === 'codex-oauth') return 'Could not reach the local Codex shim. Install Codex CLI, run `codex login`, then test again.';
    return 'Network error — check internet connection and base URL.';
  }
  if (/abort|timeout/i.test(m)) return 'Request timed out (10s). Server may be slow to respond.';
  return null;
}

function _gatewayRoot(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
}

async function ensureCodexShimReady({ repoRoot, baseUrl, model }) {
  const root = _gatewayRoot(baseUrl || 'http://127.0.0.1:3457/v1');
  const health = await probeCodexShimHealth(root, 1500);
  if (health.ok) return health;

  const shimPath = path.join(repoRoot, 'scripts', 'codex-shim', 'server.js');
  if (!fs.existsSync(shimPath)) {
    return { ok: false, error: 'Codex shim is missing from this installation.' };
  }

  const child = spawn(process.execPath, [shimPath], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_SHIM_MODEL: model || process.env.CODEX_SHIM_MODEL || '',
    },
  });
  child.unref();

  const deadline = Date.now() + 25_000;
  let last = health.error || 'not ready';
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 700));
    const probe = await probeCodexShimHealth(root, 2000);
    if (probe.ok) return { ok: true, started: true, pid: child.pid, root };
    last = probe.error || `HTTP ${probe.status || 'unknown'}`;
  }
  return {
    ok: false,
    error: `Codex shim did not become ready at ${root}: ${last}`,
    hint: 'Make sure Codex CLI is installed and run `codex login` once in a terminal.',
  };
}

async function probeCodexShimHealth(root, timeoutMs) {
  try {
    const r = await _fetch(`${root}/healthz`, { timeoutMs });
    if (!r.ok) return { ok: false, status: r.status, root };
    const data = await r.json().catch(() => ({}));
    return { ok: true, status: r.status, root, data };
  } catch (err) {
    return { ok: false, root, error: err?.message || String(err) };
  }
}

async function _fetch(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 10_000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── saveConfig ───────────────────────────────────────────────────────
// Atomically writes .env (chmod 0600) + config.json (engine reads this on
// boot, see src/config.js loadConfig) + identity/.onboarding-stage.
// `roles` is a map of roleId → { cardId, model, apiKey, baseUrl }.

function _envEscape(v) {
  // Use double quotes; escape backslash, dollar, double-quote, backtick.
  return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`') + '"';
}

function _assertCleanKey(envVar, value) {
  // Reject control characters (especially \n / \r) that would otherwise allow
  // an attacker-controlled key to inject extra .env lines on parse round-trip.
  if (/[\u0000-\u001F\u007F]/.test(String(value))) {
    throw new Error(
      `${envVar} contains a control character (newline / tab / null byte) — refusing to write.`
    );
  }
}

function _readExistingEnv(envPath) {
  if (!fs.existsSync(envPath)) return { lines: [], keysToIdx: new Map() };
  const text = fs.readFileSync(envPath, 'utf-8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const keysToIdx = new Map();
  lines.forEach((line, i) => {
    // Tolerate lowercase, mixed-case, and leading whitespace so we don't append
    // a duplicate KEY= line when one already exists in non-canonical form.
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keysToIdx.set(m[1], i);
  });
  return { lines, keysToIdx };
}

function _mergeEnv(envPath, kv) {
  // Merge the new key=value pairs into existing .env, preserving comments
  // and other unrelated keys. Keys we own get overwritten; everything else
  // is left alone.
  const { lines, keysToIdx } = _readExistingEnv(envPath);
  for (const [k, v] of Object.entries(kv)) {
    if (v == null || v === '') {
      if (keysToIdx.has(k)) lines[keysToIdx.get(k)] = `# ${k}= (cleared by setup wizard)`;
      continue;
    }
    const newLine = `${k}=${_envEscape(v)}`;
    if (keysToIdx.has(k)) lines[keysToIdx.get(k)] = newLine;
    else lines.push(newLine);
  }
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  return lines.join('\n');
}

function saveConfig({ tier, roles, repoRoot }) {
  if (!tier || !roles || typeof roles !== 'object') {
    throw new Error('saveConfig: tier and roles required');
  }
  // Only `main` is mandatory. Roles omitted from the input are intentionally
  // unset so the engine's llm-router #resolveRole falls back to main — this is
  // the "single source of truth" semantic Simple tier uses (one model for all).
  if (!roles.main) throw new Error('saveConfig: missing role main');
  const presentRoles = ROLE_IDS.filter((r) => roles[r]);
  for (const r of presentRoles) {
    const slot = roles[r];
    const card = getCard(slot.cardId);
    if (!card) throw new Error(`saveConfig: unknown provider card ${slot.cardId} for role ${r}`);
    if (!slot.model) throw new Error(`saveConfig: role ${r} has no model`);
    if (card.needsKey && !slot.apiKey) throw new Error(`saveConfig: role ${r} (${card.name}) requires apiKey`);
  }

  // Aggregate ENV keys. Multiple roles can share one provider → one key.
  // If two roles use the same provider but different keys → reject.
  const envKv = {};
  for (const r of presentRoles) {
    const slot = roles[r];
    const card = getCard(slot.cardId);
    if (!card.envVar) continue;
    // Custom card with no key → fall back to 'local' sentinel so the openai
    // adapter still ships an Authorization header to the bridge.
    let apiKey = slot.apiKey;
    if (!apiKey && card.id === 'custom') apiKey = 'local';
    if (!apiKey) continue;
    if (envKv[card.envVar] && envKv[card.envVar] !== apiKey) {
      throw new Error(
        `saveConfig: role ${r} and an earlier role both use ${card.name} but with different keys. ` +
        `Only one ${card.envVar} can be stored in .env.`
      );
    }
    _assertCleanKey(card.envVar, apiKey);
    envKv[card.envVar] = apiKey;
  }

  // Build the engine's config.json shape. Mirrors the in-engine
  // `/api/first-run/save-config` endpoint (src/dashboard.js) so a re-run from
  // the dashboard produces an identical file. The engine reads ONLY config.json
  // (via src/config.js loadConfig) — the launcher's earlier llm-roles.json
  // path was never read by anything and produced "No config.json … using
  // DEFAULTS" + apiKey-required validation failure.
  const mainSlot = roles.main;
  const mainCard = getCard(mainSlot.cardId);

  // authMode: api-key for cloud providers; gateway for keyless local servers.
  // Both shapes require apiKey in validate(), so for keyless we ship the
  // 'local' sentinel — openai-compat adapter forwards it as Authorization.
  const isKeyless = !mainCard.envVar || !envKv[mainCard.envVar];
  const authMode = isKeyless ? 'gateway' : 'api-key';
  const apiKeyValue = mainCard.envVar && envKv[mainCard.envVar]
    ? '$' + mainCard.envVar
    : 'local';
  const baseUrl = mainSlot.baseUrl || mainCard.defaultBaseUrl || '';

  // Nested roles: { roleId: { primary: { provider, model } } }. Per-role API
  // keys live in .env (already merged above) and are picked up by adapters
  // when the router routes to them. Roles omitted here are intentionally
  // absent — the engine's llm-router resolves them to `main` automatically.
  const rolesOut = {};
  for (const r of presentRoles) {
    const slot = roles[r];
    const card = getCard(slot.cardId);
    rolesOut[r] = { primary: { provider: card.providerId, model: slot.model } };
  }

  const configBody = {
    llm: {
      authMode,
      provider: mainCard.providerId,
      baseUrl,
      apiKey: apiKeyValue,
      primaryModel: mainSlot.model,
      compactModel: roles.compact ? roles.compact.model : mainSlot.model,
      fallbackModel: mainSlot.model,
      roles: rolesOut,
    },
    _setupMeta: {
      tier,
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
    },
  };
  if (mainCard.id === 'codex-oauth') {
    Object.assign(configBody.llm, {
      provider: 'codex-oauth',
      gatewayVendor: 'codex-shim',
      gatewayCommand: 'node scripts/codex-shim/server.js',
      gatewayHealthModel: mainSlot.model,
      gatewayStartupTimeoutMs: 25_000,
    });
  }

  const envPath        = path.join(repoRoot, '.env');
  const envTmp         = `${envPath}.tmp`;
  const envBak         = `${envPath}.bak`;
  const cfgPath        = path.join(repoRoot, 'config.json');
  const cfgTmp         = `${cfgPath}.tmp`;
  const cfgBak         = `${cfgPath}.bak`;
  const stagePath      = path.join(repoRoot, 'identity', '.onboarding-stage');
  const stageTmp       = `${stagePath}.tmp`;
  const stageBak       = `${stagePath}.bak`;

  fs.mkdirSync(path.dirname(stagePath), { recursive: true });

  // Merge into existing config.json so user-edited fields outside `llm` and
  // `_setupMeta` survive a re-run of the wizard.
  let existingCfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      existingCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) || {};
    } catch { /* malformed → overwrite with fresh shape */ existingCfg = {}; }
  }
  const cfgMerged = {
    ...existingCfg,
    llm: { ...(existingCfg.llm || {}), ...configBody.llm },
    _setupMeta: configBody._setupMeta,
  };

  // Snapshot prior config so a mid-sequence rename failure can roll back to
  // the all-old state, never leaving env/config/stage out of sync.
  // The engine's `.first-run-complete` sentinel is NOT written here —
  // advance-to-engine writes it after the engine confirms ready, so a
  // boot failure leaves the user able to re-edit config without sentinel skew.
  const snapshots = [
    { src: envPath,   bak: envBak   },
    { src: cfgPath,   bak: cfgBak   },
    { src: stagePath, bak: stageBak },
  ];
  for (const { src, bak } of snapshots) {
    try { fs.copyFileSync(src, bak); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // Always remove stale .tmp from prior crashes — writeFileSync only honors
  // mode 0600 on file CREATE, so an existing tmp could keep its old perms.
  for (const t of [envTmp, cfgTmp, stageTmp]) {
    try { fs.unlinkSync(t); } catch {}
  }

  const envText = _mergeEnv(envPath, envKv);
  fs.writeFileSync(envTmp, envText, { encoding: 'utf-8', mode: 0o600 });
  fs.writeFileSync(cfgTmp, JSON.stringify(cfgMerged, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(stageTmp, '3-llm-done\n', 'utf-8');

  // Sequential renames with rollback on failure: if rename N fails, restore
  // 0..N-1 from .bak so the on-disk state matches what it was before saveConfig.
  const renames = [
    { tmp: envTmp,   final: envPath,   bak: envBak   },
    { tmp: cfgTmp,   final: cfgPath,   bak: cfgBak   },
    { tmp: stageTmp, final: stagePath, bak: stageBak },
  ];
  const completed = [];
  try {
    for (const r of renames) {
      fs.renameSync(r.tmp, r.final);
      if (r.final === envPath) {
        try { fs.chmodSync(envPath, 0o600); } catch {}
      }
      completed.push(r);
    }
  } catch (err) {
    // Roll back every rename that already landed.
    for (const r of completed.reverse()) {
      try {
        if (fs.existsSync(r.bak)) fs.copyFileSync(r.bak, r.final);
        else fs.unlinkSync(r.final);
      } catch {
        // best-effort; the .bak still exists for manual recovery
      }
    }
    // Clear any tmps still on disk
    for (const t of [envTmp, cfgTmp, stageTmp]) {
      try { fs.unlinkSync(t); } catch {}
    }
    throw new Error(`saveConfig rollback: ${err.message}`);
  }

  // All three landed — clean up .bak now that we're consistent.
  for (const { bak } of snapshots) {
    try { fs.unlinkSync(bak); } catch {}
  }

  return { ok: true, envPath, configPath: cfgPath, stagePath };
}

module.exports = {
  PROVIDER_CARDS,
  ROLE_IDS,
  getCard,
  listModels,
  testConnection,
  saveConfig,
};
