// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module dashboard (public stub)
 *
 * Public stub for `startDashboard()`. The official Electron build overlays an
 * obfuscated full bundle on top of this file at packaging time (see
 * scripts/build-platform.sh step [1.5/6]). For a raw `npm install && npm start`
 * from the public source tree, this stub keeps the engine bootable headless:
 *
 *   - `GET /api/status`     → 200 JSON with engine version + uptime
 *   - `GET /engine.ready`   → 200 JSON (also emitted to stdout for the launcher)
 *   - `/api/wizard/*`, `/api/first-run/*`, `/api/onboarding/*`,
 *     `/api/telegram/*`, `/api/auth/*` → 503 with `route` + `hint` + `docs`
 *     (documented surface; full handlers ship in the official build)
 *   - anything else → 503 plain
 *
 * Forks wanting a headless wizard implement these route handlers themselves;
 * the engine core (cron / mimir-js / agent-runtime / telegram-bot / db) is
 * fully public AGPL-3.0 and runs independently of this dashboard layer.
 *
 * See:
 *   LICENSING.md
 *   engine-output/architecture-research/2026-05-15-dashboard-separation-option-b-stub.md
 */

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildHTML } from './dashboard-ui.js';

const STUB_ROUTE_PREFIXES = [
  '/api/wizard/',
  '/api/first-run/',
  '/api/onboarding/',
  '/api/telegram/',
  '/api/auth/',
];

const DOCS_URL = 'https://constellation-engine.com';

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res, body, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readEngineVersion() {
  try {
    const pkgPath = resolve(import.meta.dirname || '.', '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function startDashboard({
  db, scheduler, engine, port = 18800, bootTime, config,
  transcriptIntegrity, taskManager, relay, bot, llm,
  conversationLog, convStore, dashboardConfig, dbSnapshots,
  runtime, resolver, behaviorLogger,
} = {}) {
  const engineVersion = readEngineVersion();
  const startedAt = typeof bootTime === 'number' ? bootTime : Date.now();

  const server = createServer((req, res) => {
    let path = req.url || '/';
    const qIdx = path.indexOf('?');
    if (qIdx >= 0) path = path.slice(0, qIdx);

    try {
      if ((path === '/' || path === '/dashboard') && req.method === 'GET') {
        html(res, buildHTML(null, null));
        return;
      }

      if (path === '/api/status' && req.method === 'GET') {
        json(res, {
          ok: true,
          build: 'stub',
          engineVersion,
          uptimeMs: Date.now() - startedAt,
          dashboardUi: false,
          hint: 'Headless engine — full dashboard UI ships only in the official build',
          docs: DOCS_URL,
        });
        return;
      }

      if (path === '/engine.ready' && req.method === 'GET') {
        json(res, { port: listenPort, pid: process.pid, version: engineVersion });
        return;
      }

      if (STUB_ROUTE_PREFIXES.some(p => path.startsWith(p))) {
        json(res, {
          error: 'dashboard_stub',
          route: path,
          hint: 'Full handler ships only in the official build',
          docs: DOCS_URL,
        }, 503);
        return;
      }

      json(res, {
        error: 'dashboard_stub',
        hint: 'Use the official build for the dashboard UI',
        docs: DOCS_URL,
      }, 503);
    } catch (err) {
      if (!res.headersSent) json(res, { error: err.message }, 500);
    }
  });

  const LISTEN_PORT_RANGE = 10;
  let listenAttempt = 0;
  let listenPort = port;

  function tryListen() {
    server.listen(listenPort, '127.0.0.1', () => {
      console.log(`         → Dashboard (stub) listening on http://127.0.0.1:${listenPort}`);
      console.log(`engine.ready ${JSON.stringify({ port: listenPort, pid: process.pid, version: engineVersion })}`);
    });
  }

  server.on('error', (err) => {
    console.warn(`         ⚠ Dashboard listen error: ${err.code} ${err.message} (port=${listenPort})`);
    if (err.code === 'EADDRINUSE' && listenAttempt < LISTEN_PORT_RANGE - 1) {
      listenAttempt++;
      const nextPort = port + listenAttempt;
      console.warn(`         ↪ Port ${listenPort} busy — walking forward to ${nextPort}`);
      listenPort = nextPort;
      setImmediate(tryListen);
    }
  });

  tryListen();

  return {
    server,
    close() {
      server.close();
    },
  };
}
