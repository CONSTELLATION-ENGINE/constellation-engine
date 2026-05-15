# Constellation Engine

An open-source autonomous multi-modal memory and reasoning architecture for long-context agent systems.

## Features

- **Bi-temporal graph memory** — tracks causality and agent evolution over time
- **Multi-SA architecture** — parallel semantic reasoning with reconciliation
- **Autonomy phases** — staged agent self-direction with safety gates
- **Native long-context** — optimized for 100k+ token conversations
- **Composable adapters** — plug in your own LLM, embedding, or persistence layer

## Quick Start

### End users (Windows / macOS)

Download the latest installer from the [GitHub Releases](https://github.com/devinrory-collab/constellation-engine/releases) page and run it. The desktop app launches a setup wizard that walks you through provider keys, your agent's foundational identity prompt (the **soul core** — see below), and (optionally) memory import. SQLite ships bundled — no system database install required.

### Developers (clone & run)

1. **Prerequisites**: Node.js 20+
2. **Install**: `npm install`
3. **Configure**: `cp .env.example .env` and fill in at least one provider key (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or point to a local Ollama instance)
4. **Run engine + dashboard**: `npm start` (boots on `http://127.0.0.1:18800`)
5. **Run desktop shell** (optional): `cd electron && npm install && npm start`

> **Note on the headless build**: Running from this source tree produces a
> **headless engine** — `src/dashboard.js` and `src/dashboard-ui.js` are
> minimal stubs. The engine boots fully (cron, Mímir autonomy, agent runtime,
> telegram bot, database, REST `/api/status`), but the visual dashboard UI
> ships only in the official packaged Electron build. See [LICENSING.md](./LICENSING.md)
> for the rationale and AGPL §13 boundary.

## Architecture Overview

```
┌─────────────────────┐
│   Your LLM/Agent    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Engine Dashboard  │ ← localhost:18800 (configurable via ENGINE_DASHBOARD_PORT)
└──────────┬──────────┘
           │
    ┌──────┴──────┬────────────┬──────────┐
    ▼             ▼            ▼          ▼
┌────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐
│ Memory │  │ Routing │  │ Autonomy │  │ Metrics │
│ Graph  │  │ (Multi  │  │  Phases  │  │ & Logs  │
│ (SQL)  │  │  SA)    │  │          │  │         │
└────────┘  └─────────┘  └──────────┘  └─────────┘
```

## Configuration

The engine auto-detects your system timezone on first run. All timestamps are stored in UTC internally; display times are rendered in your local zone.

### Adapter Configuration

Most settings live in `config.json` (managed by the dashboard). `.env` carries deployment-level overrides — see [`.env.example`](./.env.example) for the canonical list. Common knobs:

- **LLM provider** — at least one of Anthropic / OpenAI / Ollama / Gemini, configured through the wizard
- **Embedding model** — ships with **BGE-M3** (1024-dim) running in-process via `@xenova/transformers`; CPU by default, opt into GPU with `USE_GPU_EMBEDDING=true`
- **Persistence** — SQLite via `better-sqlite3` (bundled, no system install needed)

### Soul Core

On first launch, the wizard prompts you to define your agent's **soul core**: a foundational identity prompt that guides reasoning across all conversations. After memory import (if used), the wizard offers a one-shot Soul Core refinement that re-derives the prompt from imported context.

## Database & Migrations

The engine uses a versioned migration runner. Migrations under [`scripts/migrations/`](./scripts/migrations) apply automatically on boot in numeric order; the current version is tracked in the `schema_version` table. If a migration fails, the desktop shell surfaces a recovery dialog (Retry / Open Folder / Copy Diagnostics / Quit) instead of starting in a half-migrated state.

Data lives in `./data/` for clone-and-run setups and in `<userData>/Constellation/engine/` for packaged installs.

## Safety & Privacy

- **Local-first**: All memory lives in your local SQLite database (bundled)
- **No telemetry**: The engine never calls home
- **Encrypted identity**: Soul core is stored with passphrase isolation
- **Transparent credentials**: Configure which LLM keys are visible to the agent

## Troubleshooting

### Engine won't start
- Verify `data/` (or the packaged userData equivalent) is writable
- Check `.env` for syntax errors
- Look in the dashboard's Logs panel, or `engine-output/` for raw output

### Memory queries return empty
- The graph needs seed data — chat with the engine for a few turns, or use the Memory Import wizard to seed from existing notes

### Dashboard shows stale data
- The dashboard caches several panels for ~30s — refresh after changes
- Check browser DevTools console for SSE connection errors

## Contributing

We welcome bug reports, feature proposals, and pull requests. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and code standards.

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0).

In summary: you can run, modify, and redistribute this software, but any network service based on it must make its source available to its users. See [LICENSE](./LICENSE) for the full terms.

## Community

- **Issues & feedback**: [GitHub issues](https://github.com/devinrory-collab/constellation-engine/issues)
- **Discussions**: [GitHub discussions](https://github.com/devinrory-collab/constellation-engine/discussions)
- **Security**: For security disclosures, see [SECURITY.md](./SECURITY.md)

---

**Status**: Open source since 2026. Actively developed.
