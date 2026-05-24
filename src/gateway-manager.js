// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module gateway-manager
 * @description Probes local OpenAI-compatible LLM gateways.
 *
 * Most gateways are user-managed and are only health-probed. The one bundled
 * exception is Codex OAuth: when the first-run wizard writes
 * gatewayVendor='codex-shim', we may start the local-only shim that talks to
 * the user's already-authenticated Codex CLI.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function trimSlash(url) { return String(url || '').replace(/\/+$/, ''); }
function toGatewayRoot(baseUrl) { return trimSlash(baseUrl).replace(/\/v1$/i, ''); }
function makeHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export async function probeGatewayHealth({ baseUrl, apiKey, timeoutMs = 4000 }) {
  const root = toGatewayRoot(baseUrl);
  const headers = makeHeaders(apiKey);
  try {
    for (const path of ['/health', '/healthz']) {
      const res = await fetch(`${root}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: true, status: res.status, root, data, path };
      }
      if (res.status !== 404) return { ok: false, status: res.status, root, path };
    }
    return { ok: false, status: 404, root };
  } catch (err) {
    return { ok: false, status: null, root, error: err.message };
  }
}

export async function probeGatewayChat({ baseUrl, apiKey, model, timeoutMs = 15000 }) {
  const root = toGatewayRoot(baseUrl);
  const headers = makeHeaders(apiKey);
  try {
    const res = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || process.env.CONSTELLATION_GATEWAY_PROBE_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body, root };
  } catch (err) {
    return { ok: false, status: null, body: '', root, error: err.message };
  }
}

export async function ensureGatewayReady(llmConfig, logger = console) {
  const authMode = llmConfig?.authMode || '';
  if (!['gateway', 'claude-proxy'].includes(authMode)) return { skipped: true };

  const probeUrl = authMode === 'claude-proxy' ? (llmConfig.proxyUrl || llmConfig.baseUrl) : llmConfig.baseUrl;
  const apiKey = llmConfig.apiKey || (authMode === 'claude-proxy' ? 'not-needed' : '');
  const isCodexShim = String(llmConfig.gatewayVendor || llmConfig.proxyVendor || '').toLowerCase() === 'codex-shim';

  for (let attempt = 0; attempt < 5; attempt++) {
    const health = await probeGatewayHealth({ baseUrl: probeUrl, apiKey, timeoutMs: 3000 });
    if (health.ok) {
      logger.log('         → Gateway already running at ' + health.root);
      return { started: false, ...health };
    }
    if (attempt < 4) await sleep(1500);
  }

  if (authMode === 'gateway' && isCodexShim) {
    return startCodexShim(llmConfig, logger);
  }

  throw new Error(
    `Local LLM gateway at ${probeUrl} did not respond to /health. ` +
    `Start your gateway process before launching Constellation, or switch authMode to 'api-key' for direct provider access.`
  );
}

async function startCodexShim(llmConfig, logger) {
  const rootDir = resolve(process.cwd());
  const shimScript = resolve(rootDir, 'scripts', 'codex-shim', 'server.js');
  const command = process.execPath;
  const args = [shimScript];
  const startupTimeoutMs = Math.max(5000, Number(llmConfig.gatewayStartupTimeoutMs || 25000));
  const model = llmConfig.gatewayHealthModel || llmConfig.primaryModel || 'gpt-5.4-mini';
  const baseUrl = llmConfig.baseUrl || 'http://127.0.0.1:3457/v1';
  const shimEndpoint = parseShimEndpoint(baseUrl);

  logger.log('         → Starting local Codex OAuth shim...');
  logger.log('         → ' + [command, ...args].join(' '));
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_SHIM_MODEL: model,
      CODEX_SHIM_HOST: shimEndpoint.host,
      CODEX_SHIM_PORT: String(shimEndpoint.port),
    },
  });
  child.stdout?.on('data', (d) => process.stdout.write('[codex-shim] ' + d));
  child.stderr?.on('data', (d) => process.stderr.write('[codex-shim] ' + d));
  child.unref();

  const deadline = Date.now() + startupTimeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    await sleep(700);
    const health = await probeGatewayHealth({ baseUrl, apiKey: llmConfig.apiKey || 'local', timeoutMs: 2500 });
    if (health.ok) {
      logger.log('         → Codex shim started (PID ' + child.pid + ') at ' + health.root);
      return { started: true, pid: child.pid, child, ...health };
    }
    lastErr = health.error || `status ${health.status || 'unknown'}`;
  }
  throw new Error(`Codex shim failed to become healthy after ${startupTimeoutMs}ms. Last probe: ${lastErr || 'unknown'}`);
}

function parseShimEndpoint(baseUrl) {
  try {
    const u = new URL(toGatewayRoot(baseUrl));
    return {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    };
  } catch {
    return { host: '127.0.0.1', port: 3457 };
  }
}
