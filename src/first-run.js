// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module first-run
 * @description First-run sentinel + redirect middleware for OOBE wizard.
 *
 * Sentinel file (`data/.first-run-complete`) chosen over a config flag so it
 * survives `config.json` rewrites / git-pulls / restores. The wizard writes it
 * only after a successful Test Connection.
 *
 * Whitelist must include `/api/live`, `/api/mimir/*`, `/api/status` and static
 * assets — otherwise SSE clients reconnect-loop and cron/autonomy break on
 * day-one deploys. The auth gate runs before this middleware (so attackers
 * can't trigger setup remotely) but `/first-run` is bypassed from the auth
 * gate's redirect so a fresh deploy without a token can reach the wizard.
 */

import { existsSync, writeFileSync, unlinkSync, renameSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const SENTINEL_FILENAME = '.first-run-complete';

export function sentinelPath(dataDir) {
  return resolve(dataDir, SENTINEL_FILENAME);
}

export function checkSentinel(dataDir) {
  return existsSync(sentinelPath(dataDir));
}

export function readSentinel(dataDir) {
  const p = sentinelPath(dataDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return { completed_at: null, malformed: true }; }
}

export function touchSentinel(dataDir, payload = {}) {
  const p = sentinelPath(dataDir);
  const tmp = `${p}.tmp`;
  mkdirSync(dirname(p), { recursive: true });
  const body = JSON.stringify({ completed_at: new Date().toISOString(), ...payload }, null, 2);
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, p);
  return p;
}

export function deleteSentinel(dataDir) {
  const p = sentinelPath(dataDir);
  if (existsSync(p)) unlinkSync(p);
  return p;
}

const WHITELIST_EXACT = new Set([
  '/first-run',
  '/login',
  '/api/live',
  '/api/live/push',
  '/api/status',
  '/api/healthz',
  '/api/health/summary',
  '/api/license/status',
  '/favicon.ico',
  '/robots.txt',
]);

const WHITELIST_PREFIX = [
  '/first-run/',
  '/api/first-run/',
  '/api/mimir/',
  '/api/providers/',
  '/static/',
  '/assets/',
];

const STATIC_EXT = /\.(css|js|mjs|cjs|map|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|otf|eot)$/i;

export function isFirstRunWhitelisted(path) {
  if (WHITELIST_EXACT.has(path)) return true;
  for (const p of WHITELIST_PREFIX) if (path.startsWith(p)) return true;
  // Static-asset suffix match — restricted to non-API paths so an /api/foo.js
  // route can never silently bypass the first-run redirect. Without this guard
  // a future /api/cron/:name/run with name="daily.js" would slip through.
  if (!path.startsWith('/api/') && STATIC_EXT.test(path)) return true;
  return false;
}

/**
 * Build a per-request middleware. `getState()` is invoked on each request so
 * a live touch/delete is reflected without restart.
 *
 * @param {() => { complete: boolean, skip: boolean }} getState
 * @returns {(req, res, path) => boolean} returns true if handled (caller stops)
 */
export function buildFirstRunMiddleware(getState) {
  return function firstRunRedirect(req, res, path) {
    const { complete, skip } = getState();
    if (complete || skip) return false;
    if (isFirstRunWhitelisted(path)) return false;

    if (path.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'first-run incomplete', redirect: '/first-run' }));
      return true;
    }
    res.writeHead(302, { Location: '/first-run' });
    res.end();
    return true;
  };
}
