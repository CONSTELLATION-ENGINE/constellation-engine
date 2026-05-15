# SSE Live Push Implementation (OSS v0.3.0)

## Problem
OSS had SSE infrastructure (endpoints + client subscription) but **zero producers** in mimir-js. Result:
- Tick counter frozen (waiting for 30s polling)
- Particle animation stopped until next status poll
- Dashboard feels sluggish/laggy vs main architecture

## Solution: `scripts/mimir-js/live-push.js`

### Core Functions

#### `heartbeatPush()`
Called from heartbeat loop every 5s:
- Gathers tick, status, activations from pool.js
- Gathers pool nodes every 3rd heartbeat (~15s)
- Calls `pushLive({tick, status, activations, pool})`

#### `pushLive({tick, status, activations, pool})`
Formats and POSTs to `/api/live/push`:
```json
{
  "type": "mimir.tick" | "mimir.status.update" | "mimir.activations" | "mimir.pool.update",
  "data": {...}
}
```

### Event Types

| Type | Frequency | Source | Dashboard Handler |
|------|-----------|--------|------------------|
| `mimir.tick` | 1 Hz (5s heartbeat) | `getStatus().tick` | Updates counter element |
| `mimir.status.update` | 1 Hz (5s heartbeat) | `getStatus()` | `applyMimirStatus()` |
| `mimir.activations` | 1 Hz (5s heartbeat) | SA pool state | `applyMimirActivations()` |
| `mimir.pool.update` | 0.33 Hz (~15s) | `getPool(size=100)` | `applyMimirPool()` |

### Feature Flag
- Env: `MIMIR_LIVE_PUSH`
- Default: **ON** (!== '0')
- Kill-switch: `MIMIR_LIVE_PUSH=0`
- Status endpoint: `/watchdog/status` -> `live` field

### Fallback
- Original polling in dashboard-ui.js remains active
- If SSE drops, dashboard automatically falls back to polling
- Errors in pushLive are silently swallowed (not critical)

## Files Changed
1. **Created**: `scripts/mimir-js/live-push.js` (~200 lines)
2. **Modified**: `scripts/mimir-js/heartbeat.js` (+2 lines)
   - Import live-push
   - Call heartbeatPush() after each heartbeat
3. **Modified**: `scripts/mimir-js/index.js` (+2 lines)
   - Import liveStatus
   - Add live field to /watchdog/status

## Build
```bash
./scripts/build-platform.sh linux x64
./scripts/build-platform.sh win32 x64
./scripts/build-platform.sh darwin arm64
```

Artifacts at: `dist/electron/`
- Constellation-0.1.0.AppImage (Linux)
- Constellation Setup 0.1.0.exe (Windows)
- Constellation-0.1.0-arm64-mac.zip (macOS)
