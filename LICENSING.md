# Licensing

## Engine: AGPL-3.0-or-later

The Constellation Engine source in this repository (`src/`, `scripts/`, `electron/`,
`identity/`, `library/`, etc.) is licensed under the **GNU Affero General Public
License v3.0 or later**. See [LICENSE](./LICENSE) for the full text.

In short:

- You may use, study, modify, and redistribute the engine.
- If you run a **modified** version as a network service, you must offer the
  corresponding source code to users of that service (AGPL §13).
- Forks and derivatives must remain AGPL-3.0-or-later.

## Dashboard UI (official build): separately licensed

The official packaged Electron build ships an additional component — the
**Constellation Dashboard UI** — that is **not** part of this public repository.
At packaging time, an obfuscated bundle is overlaid on top of the public stub
files (`src/dashboard.js`, `src/dashboard-ui.js`).

- **In this public source tree:** `src/dashboard.js` and `src/dashboard-ui.js`
  are minimal stubs (AGPL-3.0-or-later, same as the rest of the engine) that
  keep the engine bootable headless. The stub exposes `GET /api/status` and
  `GET /engine.ready`; documented routes (`/api/wizard/*`, `/api/first-run/*`,
  `/api/onboarding/*`, `/api/telegram/*`, `/api/auth/*`) return `503` with a
  hint pointing to the official build.
- **In the official packaged build:** the stubs are replaced at build time by
  a closed-source, all-rights-reserved bundle produced from a separate private
  repository. That bundle is distributed under its own terms as a bundled
  aggregate alongside the AGPL engine, per AGPL §13's recognition of "mere
  aggregation" of independently-licensed works that communicate at arm's length.

### Precedent

This split — open-source core + closed-source aggregated dashboard / control
plane — is common in the AGPL ecosystem:

- **Plausible Analytics** (AGPL core, paid managed-host frontend extras)
- **Sentry** (BSL/FSL core with closed enterprise extensions)
- **GitLab CE / EE** (MIT core, proprietary EE features)
- **Mattermost** (MIT core, proprietary enterprise editions)

### What "corresponding source" means here

Anyone running this engine — modified or not — and exposing it to users over a
network must offer the corresponding source for the **engine** portion (this
repository plus your modifications). The dashboard UI bundle in the official
build is an independent aggregate work and is **not** covered by that
obligation.

If you are building a derivative service and want a fully open frontend,
implement your own UI against the engine's REST surface (the route list is
documented in `src/dashboard.js`).

## Other components

- Vendored libraries (`vendor/`, `library/`, third-party `node_modules`) retain
  their original upstream licenses.
- Brand assets (logos, "Constellation Engine" name) are reserved; reuse for
  forks is permitted under fair-use / nominative-use principles but please
  rename derivative distributions to avoid confusion.

## Questions

Open an issue at <https://github.com/CONSTELLATION-ENGINE/constellation-engine> or email
the maintainer.
