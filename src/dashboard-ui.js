// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module dashboard-ui (public stub)
 *
 * Returns a minimal headless landing page. The official Electron build
 * overlays an obfuscated full UI bundle on top of this file at packaging
 * time (see scripts/build-platform.sh step [1.5/6]).
 *
 * See:
 *   LICENSING.md
 *   engine-output/architecture-research/2026-05-15-dashboard-separation-option-b-stub.md
 */

const DOCS_URL = 'https://constellation-engine.com';
const SOURCE_URL = 'https://github.com/devinrory-collab/constellation-engine';

export function buildHTML(_authToken, _identity = null) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Constellation Engine (headless)</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 640px;
    margin: 60px auto;
    padding: 0 24px;
    color: #2a2a2a;
  }
  h1 { margin: 0 0 8px; font-size: 22px; }
  .tag { color: #888; font-size: 13px; margin-bottom: 24px; }
  p { margin: 14px 0; }
  a { color: #2255cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; background: rgba(127,127,127,0.12); padding: 2px 6px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #1a1a1a; }
    a { color: #79a6ff; }
  }
</style>
</head>
<body>
  <h1>Constellation Engine</h1>
  <div class="tag">headless build — dashboard UI not included</div>
  <p>You're running the open-source engine from source. The dashboard UI ships only in the official packaged build.</p>
  <p>The engine itself is fully functional — cron tasks, the Mímir autonomy loop, the agent runtime, the telegram bot, and the database are all running. You can interact via the telegram bot or by extending the API (<code>/api/status</code>, <code>/engine.ready</code>).</p>
  <p>Official build: <a href="${DOCS_URL}">${DOCS_URL}</a></p>
  <p>Source: <a href="${SOURCE_URL}">${SOURCE_URL}</a></p>
</body>
</html>`;
}
