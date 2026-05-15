// SPDX-License-Identifier: AGPL-3.0-or-later
// Internal heartbeat loop: the daemon's own pulse. Without this, the watchdog
// (which checks every 15s and kills after 3 strikes / 45s) would page the
// supervisor whenever the engine goes quiet — fresh installs, idle sessions,
// or any window where no HTTP request hits a route handler. This loop also
// drives sa.step() at a steady cadence so the SA pool keeps diffusing even
// when no one queries /pool, which is what keeps the dashboard's tick counter
// and particle motion alive.
//
// Mirrors the Python daemon's `heartbeat_loop` async coroutine.
//
// Kill-switch: MIMIR_HEARTBEAT=0 disables the loop entirely (watchdog will
// then only see external HTTP-triggered heartbeats — useful for debugging,
// not for production).

import * as sa from './sa.js';
import { advanceTick } from './pool.js';
import { noteHeartbeat } from './watchdog.js';
import { heartbeatPush } from './live-push.js';

const KILL = String(process.env.MIMIR_HEARTBEAT || '').trim() === '0';
// Default 500ms matches main-arch Python daemon (`mimir_daemon.py --tick-ms 500`)
// so the dashboard sees a smooth 2Hz tick stream instead of jagged 1-tick-per-5s
// updates. Watchdog cadence (15s/45s) is unchanged — it's driven by noteHeartbeat()
// which fires on every loop iteration regardless of interval.
const INTERVAL_MS = parseInt(process.env.MIMIR_HEARTBEAT_INTERVAL_MS || '500', 10);

let _interval = null;
let _ticks = 0;
let _lastTickMs = 0;
let _lastError = null;

export function startHeartbeat() {
  if (KILL || _interval) return false;
  _interval = setInterval(() => {
    try {
      sa.step();
      // Bump pool's _tick so /status surfaces a fresh tick to the dashboard
      // every heartbeat (500ms), not just when /pool is polled (30s).
      advanceTick();
      // Push live updates to SSE subscribers (dashboard).
      heartbeatPush();
    } catch (e) {
      _lastError = e.message;
    }
    noteHeartbeat();
    _ticks += 1;
    _lastTickMs = Date.now();
  }, INTERVAL_MS);
  // unref so the heartbeat doesn't block process exit by itself; the
  // watchdog's interval is the load-bearing keepalive (intentionally not
  // unref'd in watchdog.js).
  _interval.unref?.();
  return true;
}

export function stopHeartbeat() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export function heartbeatStatus() {
  return {
    enabled: !KILL,
    interval_ms: INTERVAL_MS,
    ticks: _ticks,
    last_tick_ms: _lastTickMs,
    last_error: _lastError,
  };
}
