# Constellation Launcher (Electron)

Game-launcher-style Electron shell that boots the Constellation engine, polls
its `/api/status`, and opens the Dashboard.

## Usage

```bash
cd electron
npm install
npm start
```

The launcher will:

1. Acquire a single-instance lock (second double-click focuses the existing window).
2. Probe port `18800` (override via `CONSTELLATION_PORT`).
3. Spawn `node ../src/main.js --port 18800` as an IPC-piped child.
4. Wait for the engine's structured `engine.ready { port, pid, version }` line on stdout.
5. Poll `http://127.0.0.1:18800/api/status` until it returns 200.
6. Replace the splash with the library window; the user clicks **Open Dashboard**.

## Phase coverage

| Phase | Scope                                                                         | Status     |
|-------|-------------------------------------------------------------------------------|------------|
| L1    | Single-instance lock, port probe, structured `engine.ready`, IPC shutdown    | shipped    |
| L2    | Logs tab, Stop/Restart/Diagnose, redacted support bundle, telemetry opt-in   | pending    |
| L3    | Tray icon, auto-update with signature verification, uninstall flow           | pending    |
| L4    | Cross-platform packaging (macOS notarization, Windows EV, Linux AppImage)    | pending    |

## Graceful shutdown

On window close the launcher sends `{ type: 'shutdown' }` over the IPC channel
that `child_process.fork()` provides. The engine (`src/main.js`) listens for
this on `process.on('message')` and runs the same path as `SIGINT` (WAL
checkpoint, save Mímir state). After 8s the launcher falls back to `tree-kill`
to avoid Windows `TerminateProcess` skipping the WAL checkpoint.
