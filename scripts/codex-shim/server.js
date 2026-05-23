// Codex OAuth shim — exposes OpenAI-compatible /v1/chat/completions on 127.0.0.1:3457
// backed by the user's locally-installed `codex` CLI.
//
// Why this exists: Constellation's engine talks to OpenAI-compatible HTTP
// providers, while Codex CLI is a local command. This small local-only adapter
// lets users who have already signed in with `codex login` use that local
// Codex client from the normal provider flow.
//
// Boundaries:
// - The shim never reads, stores, or forwards the user's Codex OAuth token.
// - It binds to localhost by default.
// - It strips OPENAI_API_KEY/OPENAI_BASE_URL from the child env so an unrelated
//   API key in the engine environment does not accidentally change the user's
//   selected Codex CLI auth mode.
// - Codex is launched read-only and with no project rules loaded. This shim is
//   a text-generation bridge, not a way for Codex to edit the user's repo.

import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.CODEX_SHIM_PORT || 3457);
const HOST = process.env.CODEX_SHIM_HOST || '127.0.0.1';
// Default model used when the OpenAI-compatible caller omits body.model.
// Codex CLI v0.133.0 accepts explicit --model with ChatGPT Pro OAuth.
const DEFAULT_MODEL = process.env.CODEX_SHIM_MODEL || '';
const HARD_CEILING_MS = Number(process.env.CODEX_SHIM_TIMEOUT_MS || 5_400_000);
const CODEX_BIN = resolveCodexBin();

const app = express();
app.use(express.json({ limit: '32mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'codex-shim', port: PORT });
});

app.get('/v1/models', (_req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gpt-5.5',            object: 'model', owned_by: 'openai' },
      { id: 'gpt-5.4-mini',       object: 'model', owned_by: 'openai' },
      { id: 'gpt-5',              object: 'model', owned_by: 'openai' },
    ],
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = (body.model || DEFAULT_MODEL).trim();
  const stream = Boolean(body.stream);
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  const prompt = flattenMessagesToPrompt(messages);
  if (!prompt.trim()) {
    return res.status(400).json({ error: { message: 'empty prompt after flattening messages' } });
  }

  if (stream) {
    res.status(200).set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.flushHeaders?.();
    await runCodex({
      prompt, model, id, created,
      onDelta: (text) => writeSSEDelta(res, { id, created, model, text }),
      onUsage: (usage) => writeSSEUsage(res, { id, created, model, usage }),
      onDone: (finish) => writeSSEDone(res, { id, created, model, finish }),
      onError: (err) => writeSSEError(res, err),
      abortSignal: res,
    });
    return;
  }

  try {
    const result = await runCodexBuffered({ prompt, model });
    res.json({
      id, object: 'chat.completion', created, model: result.model || model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text || '' },
        finish_reason: result.finish || 'stop',
      }],
      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (err) {
    res.status(502).json({ error: { message: err?.message || 'codex exec failed', type: 'codex_shim_error' } });
  }
});

function flattenMessagesToPrompt(messages) {
  // Codex CLI takes one argv prompt. Preserve role boundaries so the model can
  // distinguish system instructions from prior turns.
  const parts = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const text = extractText(m.content);
    if (!text.trim()) continue;
    if (m.role === 'system')         parts.push(`<system>\n${text}\n</system>`);
    else if (m.role === 'assistant') parts.push(`<assistant>\n${text}\n</assistant>`);
    else if (m.role === 'tool')      parts.push(`<tool_result>\n${text}\n</tool_result>`);
    else                             parts.push(`<user>\n${text}\n</user>`);
  }
  return parts.join('\n\n');
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text') return c.text || '';
      if (c?.type === 'input_text') return c.text || '';
      return '';
    }).join('');
  }
  return '';
}

function spawnCodex({ prompt, model }) {
  const args = [
    'exec',
    '--json',
    '--color', 'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox', 'read-only',
  ];
  // Forward the requested model so engine roles actually select Codex tiers.
  // CODEX_SHIM_MODEL remains an operator override if present.
  const explicitModel = (process.env.CODEX_SHIM_MODEL || model || '').trim();
  if (explicitModel) args.push('--model', explicitModel);
  // Use stdin instead of argv for the prompt. Engine prompts can be hundreds of
  // KB after memory/tool context injection; passing them as argv trips E2BIG and
  // kills the shim before it can return an OpenAI-shaped error.
  args.push('-');

  // Strip unrelated OpenAI API env so Codex CLI uses the user's own configured
  // local Codex login/profile rather than inheriting Constellation's provider
  // environment by accident.
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;

  const child = spawn(CODEX_BIN, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* child may exit before reading stdin */ });
  child.stdin.end(prompt);
  return child;
}

function isExecutable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexBin() {
  const candidates = [];
  if (process.env.CODEX_BIN) candidates.push(process.env.CODEX_BIN);

  const home = process.env.HOME || '';
  const nvmNodeRoot = home ? join(home, '.nvm', 'versions', 'node') : '';
  if (nvmNodeRoot && existsSync(nvmNodeRoot)) {
    for (const version of readdirSync(nvmNodeRoot).sort().reverse()) {
      candidates.push(join(nvmNodeRoot, version, 'bin', 'codex'));
    }
  }
  candidates.push('/usr/local/bin/codex', '/usr/bin/codex');

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return 'codex';
}

async function runCodex({ prompt, model, onDelta, onUsage, onDone, onError, abortSignal }) {
  let child;
  try {
    child = spawnCodex({ prompt, model });
  } catch (err) {
    onError(err);
    return;
  }
  let aborted = false;
  const cleanup = () => { aborted = true; try { child.kill('SIGTERM'); } catch { /* noop */ } };
  const hardTimer = setTimeout(() => {
    onError(new Error(`codex exec exceeded hard timeout (${HARD_CEILING_MS}ms)`));
    cleanup();
  }, HARD_CEILING_MS);
  // Only the streaming path subscribes to res 'close' so a client abort kills
  // the spawn. Non-stream callers omit abortSignal — req.on('close') would fire
  // after res.json() ends, racing with our exit handler and reporting code=null.
  abortSignal?.on?.('close', cleanup);

  let buffer = '';
  let emittedAny = false;
  let lastErrorText = '';
  let usage;
  let finishReason = 'stop';
  let stderrBuf = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const ev = extractCodexEvent(parsed);
      if (ev.usage) usage = ev.usage;
      if (ev.text) {
        if (ev.isError) {
          // Codex retries hammer the same 401 repeatedly — dedupe so we don't
          // flood the caller with copies of the same error message.
          if (ev.text === lastErrorText) continue;
          lastErrorText = ev.text;
        }
        // Per OpenClaw cli-runner parseCliJsonl: each message item is its own
        // text payload, not a cumulative snapshot. Append with a separator.
        onDelta((emittedAny ? '\n' : '') + ev.text);
        emittedAny = true;
      }
      if (ev.finishReason) finishReason = ev.finishReason;
    }
  });
  child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

  child.on('error', (err) => {
    clearTimeout(hardTimer);
    onError(err);
  });
  child.on('close', (code) => {
    clearTimeout(hardTimer);
    if (aborted) return;
    // Codex exits 0 even on auth/network failure; if we collected text, treat
    // as success regardless of code so the model's own error message reaches
    // the caller. Only synthesize an error when there's nothing useful.
    if (code !== 0 && !emittedAny && finishReason === 'stop') {
      const msg = stderrBuf.trim().slice(0, 500) || `codex exec exited ${code ?? 'null'} with no output`;
      onError(new Error(msg));
      return;
    }
    if (usage) onUsage(toOpenAIUsage(usage));
    onDone(finishReason);
  });
}

async function runCodexBuffered({ prompt, model }) {
  let text = '';
  let usage;
  return new Promise((resolve, reject) => {
    runCodex({
      prompt, model,
      onDelta: (delta) => { text += delta; },
      onUsage: (u) => { usage = u; },
      onDone: (finish) => resolve({ text, finish, model, usage }),
      onError: (err) => reject(err),
    });
  });
}

function extractCodexEvent(obj) {
  // Codex JSONL shapes (0.133): { type, item:{ type, text }, usage }
  // and lifecycle events: { type:'turn.complete' | 'turn.failed' | 'error', ... }
  const out = {};
  if (obj.usage && typeof obj.usage === 'object') out.usage = obj.usage;

  const item = obj.item;
  if (item && typeof item === 'object') {
    const itemType = String(item.type || '').toLowerCase();
    if (typeof item.text === 'string' && (itemType.includes('message') || itemType.includes('assistant') || itemType === '')) {
      out.text = item.text;
    } else if (Array.isArray(item.content)) {
      const collected = item.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
      if (collected) out.text = collected;
    }
  }
  // Some versions emit top-level { type:'assistant_message', text:... }
  if (!out.text && typeof obj.text === 'string') {
    const t = String(obj.type || '').toLowerCase();
    if (t.includes('message') || t.includes('assistant')) out.text = obj.text;
  }
  const tType = String(obj.type || '').toLowerCase();
  if (tType === 'turn.complete' || tType === 'done') out.finishReason = 'stop';
  if (tType === 'turn.failed' || tType === 'error') {
    out.finishReason = 'error';
    const errMsg = obj.error?.message || obj.message;
    if (typeof errMsg === 'string' && errMsg.trim()) {
      // Surface as assistant text so the engine sees a useful failure reply
      // instead of empty content. isError lets the caller dedupe codex's
      // retry-spam (it repeats the same 401 several times per failed turn).
      out.text = `[codex-shim] ${errMsg}`;
      out.isError = true;
    }
  }
  return out;
}

function toOpenAIUsage(raw) {
  const input  = raw.input_tokens  ?? raw.inputTokens  ?? raw.prompt_tokens     ?? 0;
  const output = raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: raw.total_tokens ?? (input + output),
  };
}

function writeSSEDelta(res, { id, created, model, text }) {
  const chunk = {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeSSEUsage(res, { id, created, model, usage }) {
  const chunk = {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    usage,
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeSSEDone(res, { id, created, model, finish }) {
  const final = {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }],
  };
  res.write(`data: ${JSON.stringify(final)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function writeSSEError(res, err) {
  const payload = { error: { message: err?.message || 'codex exec failed', type: 'codex_shim_error' } };
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch { /* connection may already be closed */ }
  res.end?.();
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[codex-shim] listening on http://${HOST}:${PORT} (default model: ${DEFAULT_MODEL})`);
});

server.on('error', (err) => {
  console.error(`[codex-shim] listen failed: ${err.message}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
