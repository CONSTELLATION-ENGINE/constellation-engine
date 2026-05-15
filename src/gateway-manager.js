// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module gateway-manager
 * @description Probes a user-managed OpenAI-compatible local LLM gateway.
 *
 * The OSS engine never bundles, recommends, or auto-spawns a proxy. If the
 * user wires `authMode='claude-proxy'` in their config, they are expected to
 * have already started their own gateway process at the configured baseUrl.
 * This module only health-probes that endpoint at boot.
 */

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
    const res = await fetch(`${root}/health`, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: true, status: res.status, root, data };
    }
    return { ok: false, status: res.status, root };
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

  for (let attempt = 0; attempt < 5; attempt++) {
    const health = await probeGatewayHealth({ baseUrl: probeUrl, apiKey, timeoutMs: 3000 });
    if (health.ok) {
      logger.log('         → Gateway already running at ' + health.root);
      return { started: false, ...health };
    }
    if (attempt < 4) await sleep(1500);
  }

  throw new Error(
    `Local LLM gateway at ${probeUrl} did not respond to /health. ` +
    `Start your gateway process before launching Constellation, or switch authMode to 'api-key' for direct provider access.`
  );
}
