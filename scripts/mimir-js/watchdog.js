// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent watchdog: a self-contained interval that checks heartbeat
// freshness and exits the process when the daemon is wedged. Runs on its own
// timer so a stuck SA tick or DB write can't starve it.
//
// Policy: 3 consecutive misses (no heartbeat update for STALL_THRESHOLD_MS
// each) -> log + process.exit(1). Parent supervisor (start.sh / Electron)
// restarts cleanly.
//
// Kill-switch: MIMIR_WATCHDOG=0 disables the watchdog entirely.

const KILL = String(process.env.MIMIR_WATCHDOG || '').trim() === '0';
const CHECK_INTERVAL_MS  = parseInt(process.env.MIMIR_WATCHDOG_INTERVAL_MS  || '15000', 10);
const STALL_THRESHOLD_MS = parseInt(process.env.MIMIR_WATCHDOG_STALL_MS     || '15000', 10);
const MAX_STRIKES        = parseInt(process.env.MIMIR_WATCHDOG_MAX_STRIKES  || '3',     10);

let _lastHeartbeatTs = Date.now();
let _strikes = 0;
let _interval = null;
let _onStallCallback = null;

export function noteHeartbeat() {
  _lastHeartbeatTs = Date.now();
  if (_strikes !== 0) _strikes = 0;
}

export function startWatchdog({ onStall = null } = {}) {
  if (KILL || _interval) return false;
  _onStallCallback = typeof onStall === 'function' ? onStall : null;
  _lastHeartbeatTs = Date.now();
  _interval = setInterval(() => {
    const since = Date.now() - _lastHeartbeatTs;
    if (since < STALL_THRESHOLD_MS) return;
    _strikes++;
    console.warn(`[mimir-js watchdog] missed heartbeat: strike ${_strikes}/${MAX_STRIKES} (idle ${since}ms)`);
    if (_strikes >= MAX_STRIKES) {
      console.error('[mimir-js watchdog] daemon wedged — exiting for supervisor restart');
      try { _onStallCallback && _onStallCallback({ strikes: _strikes, idleMs: since }); } catch {}
      // Give logs a chance to flush, then hard exit.
      setTimeout(() => process.exit(1), 250).unref();
    }
  }, CHECK_INTERVAL_MS);
  // intentionally NOT unref'd — the watchdog is the load-bearing guard for the
  // daemon. If the only remaining handle is the watchdog, the process should
  // stay alive on its watch.
  return true;
}

export function stopWatchdog() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export function watchdogStatus() {
  return {
    enabled: !KILL,
    last_heartbeat: new Date(_lastHeartbeatTs).toISOString(),
    strikes: _strikes,
    max_strikes: MAX_STRIKES,
    threshold_ms: STALL_THRESHOLD_MS,
  };
}
