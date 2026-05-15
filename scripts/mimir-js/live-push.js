// SPDX-License-Identifier: AGPL-3.0-or-later
// SSE producer: pushes live mimir events to the engine dashboard so /api/live
// EventSource subscribers see fresh tick/status/activations/pool without
// waiting on the slow polling fallback. Mirrors the Python daemon's
// _submit_push → _push_live → POST /api/live/push pipeline (mimir_daemon.py
// L5860-5874, L6048-6117).
//
// Cadence: heartbeat.js calls heartbeatPush() every 500ms (Python parity);
// pool snapshots fire every 30th heartbeat (~15s) to bound bandwidth.
//
// Channels (must match dashboard-ui.js HIGH_RATE_BUFFER_SKIP set):
//   mimir.tick            — every heartbeat
//   mimir.status.update   — every heartbeat
//   mimir.activations     — every heartbeat (client throttles render)
//   mimir.pool.update     — every 3rd heartbeat
//
// Engine port: read from CONSTELLATION_PORT (the env var the launcher uses
// for the engine's HTTP port). Defaults to 18800 to match electron/main.js's
// DEFAULT_PORT. Kill-switch: MIMIR_LIVE_PUSH=0 disables the producer entirely.

import http from 'node:http';
import { getDb } from './db.js';
import * as sa from './sa.js';
import { getStatus, getPool } from './pool.js';

const KILL = String(process.env.MIMIR_LIVE_PUSH || '').trim() === '0';
const ENGINE_HOST = process.env.ENGINE_HOST || '127.0.0.1';
// CONSTELLATION_PORT is the engine's HTTP port (electron/main.js spawns mimir
// with this set to the resolved enginePort). Falls back to the launcher's
// DEFAULT_PORT (18800) for dev runs that start mimir-js directly.
const ENGINE_PORT = parseInt(process.env.CONSTELLATION_PORT || '18800', 10);

const POOL_UPDATE_INTERVAL_TICKS = 30; // ~15s at 500ms heartbeat
let _ticksSincePoolUpdate = 0;
let _pushAttempts = 0;
let _pushDropped = 0;
let _pushErrors = 0;
let _lastError = null;
let _lastPushMs = 0;

export function pushLive({ tick, status, activations, pool }) {
  if (KILL) return;
  const events = [];
  if (typeof tick !== 'undefined') events.push({ type: 'mimir.tick', data: tick });
  if (status)                      events.push({ type: 'mimir.status.update', data: status });
  if (activations)                 events.push({ type: 'mimir.activations', data: { activations } });
  if (pool)                        events.push({ type: 'mimir.pool.update', data: pool });

  for (const evt of events) {
    _pushAttempts += 1;
    _pushEvent(evt.type, evt.data).then(() => {
      _lastPushMs = Date.now();
    }).catch((e) => {
      _pushErrors += 1;
      _lastError = `${evt.type}: ${e.message || e}`;
    });
  }
}

function _pushEvent(type, data) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ type, data: data || {} }), 'utf8');
    const req = http.request({
      host: ENGINE_HOST,
      port: ENGINE_PORT,
      path: '/api/live/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: 2000,
    }, (res) => {
      // Drain so the socket can be reused; we don't need the body.
      res.resume();
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`status ${res.statusCode}`));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('push timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Called from heartbeat.js every tick. Builds the four channel payloads and
// hands them to pushLive(); errors are silent at the call site but tracked
// in _lastError for /watchdog/status.
export function heartbeatPush() {
  if (KILL) return;

  let status, tick;
  try {
    status = getStatus();
    tick = status?.tick;
  } catch (e) {
    _lastError = `getStatus: ${e.message}`;
    _pushDropped += 1;
    return;
  }

  const events = { tick, status };

  // Activations: top 20 active nodes' SA activation, keyed by node id.
  // Matches Python daemon's mimir.activations payload shape.
  try {
    const db = getDb();
    const activations = {};
    const rows = db.prepare(`
      SELECT id FROM nodes
       WHERE state='active' AND superseded_at IS NULL
         AND source != 'autonomous:resolver-canary'
       ORDER BY accessed_at DESC LIMIT 20
    `).all();
    for (const r of rows) {
      const s = sa.getNodeState(r.id);
      activations[r.id] = s?.activation ?? 0;
    }
    events.activations = activations;
  } catch (e) {
    _lastError = `activations: ${e.message}`;
  }

  // Pool snapshot every Nth heartbeat (matches Python's 0.33Hz pool cadence).
  _ticksSincePoolUpdate += 1;
  if (_ticksSincePoolUpdate >= POOL_UPDATE_INTERVAL_TICKS) {
    _ticksSincePoolUpdate = 0;
    try {
      const pool = getPool({ size: 100 });
      const nodes = pool.nodes || [];
      events.pool = {
        pool_size: nodes.length,
        nodes: nodes.map(n => {
          const s = sa.getNodeState(n.id);
          return {
            id: n.id,
            l0: n.l0,
            dist: n.dist,
            activation: s?.activation ?? 0,
          };
        }),
      };
    } catch (e) {
      _lastError = `pool: ${e.message}`;
    }
  }

  pushLive(events);
}

export function liveStatus() {
  return {
    enabled: !KILL,
    engine_host: ENGINE_HOST,
    engine_port: ENGINE_PORT,
    attempts: _pushAttempts,
    errors: _pushErrors,
    dropped: _pushDropped,
    last_push_ms: _lastPushMs,
    last_error: _lastError,
  };
}
