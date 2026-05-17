<p align="center">
  <img src="docs/logo.png" alt="Constellation Engine" width="180" height="180" />
</p>

<h1 align="center">Constellation Engine</h1>

<p align="center"><em>Knowledge Topology Runtime for Stateful AI Agents</em></p>

<p align="center">
  <a href="https://constellation-engine.com"><strong>Read the Codex</strong></a> ·
  <a href="https://github.com/CONSTELLATION-ENGINE/constellation-engine/releases"><strong>Download</strong></a> ·
  <a href="https://github.com/sponsors/devinrory-collab"><strong>Sponsor</strong></a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/node-20%2B-339933.svg" alt="Node 20+" />
  <img src="https://img.shields.io/badge/status-open%20source%202026-success.svg" alt="open source 2026" />
</p>

---

## What Is This

Constellation Engine is a **knowledge graph runtime** that gives AI agents something they have never had: **persistent, structured, evolving memory**.

Unlike conventional systems where each conversation starts from a blank slate, an agent running on Constellation Engine carries a living star map of everything it has learned. Knowledge nodes connect through typed, weighted edges. The topology itself becomes the agent's understanding of the world.

This is not a database. It is a **cognitive architecture** — memory is not stored, it is *grown*.

> RAG treats memory as **archive**.
> Knowledge graphs treat memory as **structure**.
> Constellation treats memory as **process**.

## How Information Flows

```
User input (chat / Telegram)
       ↓
   ┌───── L0 / L1 / L2 envelope write ────┐
   │  (cost-gradient: skeleton → full)    │
   └──────────────┬───────────────────────┘
                  ↓
        ┌─── Mímir daemon (background) ───┐
        │  500ms heartbeat tick:           │
        │    Multi-SA(K/L/S) diffuse →     │
        │    ping-pong inhibit ×3 → fuse   │
        │    delta = A_fast − baseline     │
        │  180s: Hebb writeback (BCM)      │
        │   1h: edge-decay (×0.998)        │
        │   1h: Leiden zones               │
        └──────────────┬───────────────────┘
                       ↓
            ┌──── Attention pool ────────────┐
            │  raw = 0.80·δ + 0.10·slow      │
            │      + 0.05·mass + 0.05·bridge │
            │  + type-multiplier             │
            └──────────────┬─────────────────┘
                           ↓
        ┌──── Turn assembly ─────────────────┐
        │  4-layer context budget:           │
        │   fixed 10% + constellation 28% +  │
        │   summary 10% + active 52%         │
        │  perm slots + dyn pool + rerank +  │
        │  precision tiers (min/med/full) +  │
        │  episodic + skeleton + anchor inj. │
        └──────────────┬─────────────────────┘
                       ↓
                      LLM
                       ↓
           Anamnesis debrief → consolidation
           judge → new nodes / edges →
           feedback into graph
```

Every turn, the star map is read, activated, sampled, rendered, then *rewritten* with what was learned. The graph is alive between conversations — Mímir keeps diffusing activation, decaying unused edges, and reclustering zones whether you are talking to the agent or not.

## How It's Different

Most stateful-memory systems for LLMs are some flavor of **Retrieval-Augmented Generation**: chunk, embed, store, then on each turn run a cosine search and stuff the top-k chunks into the prompt. This works — and Constellation borrows from it — but it has a structural ceiling:

| | Generic RAG | Constellation Engine |
|---|---|---|
| Memory unit | Opaque text chunk | Typed node + typed edges |
| Selection | Cosine similarity, top-k | Multi-SA diffusion + delta + bridge + rerank |
| State between turns | None — fresh search each time | Continuous activation field, Hebb writeback, edge decay |
| Forgetting | Manual purge or none | Continuous decay → dormancy → anamnesis |
| Cross-domain reasoning | Restricted to retrieved neighborhood | Bridge nodes surface distant connections |
| Identity / personality | Lives in system prompt only | Lives in graph (soul-core + permanent slots) |
| What you can audit | The chunks that were retrieved | Every node, every edge, every activation snapshot |

The asymmetry is the point: you can **subtract** dynamics from Constellation and you are left with something RAG-shaped. You cannot **add** dynamics to RAG and end up here — the storage format would not support it.

The metaphor we keep coming back to is the **hippocampus**: a system whose job is not to *hold* memories but to *route* them, decide what gets consolidated, what gets pruned, and what wakes up when a new signal arrives.

## Quick Start

### End users (Windows / macOS / Linux)

Download the latest installer from the [Releases](https://github.com/CONSTELLATION-ENGINE/constellation-engine/releases) page and run it. The desktop app launches a setup wizard that walks you through provider keys, your agent's foundational identity prompt (the **soul core**), and (optionally) memory import from your existing notes. SQLite ships bundled — no system database install required.

### Developers (clone & run)

1. **Prerequisites**: Node.js 20+
2. **Install**: `npm install`
3. **Configure**: `cp .env.example .env` and fill in at least one provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or point to a local Ollama instance)
4. **Run engine + dashboard**: `npm start` (boots on `http://127.0.0.1:18800`)
5. **Run desktop shell** (optional): `cd electron && npm install && npm start`

> **Headless build note**: Running from this source tree produces a **headless engine** — `src/dashboard.js` and `src/dashboard-ui.js` are minimal stubs. The engine boots fully (cron, Mímir autonomy, agent runtime, telegram bot, database, REST `/api/status`), but the visual dashboard UI ships only in the official packaged Electron build. See [LICENSING.md](./LICENSING.md) for the rationale and AGPL §13 boundary.

## Architecture & Components

The OSS engine ships four cooperating subsystems. Each is independently auditable, swappable, and observable through `/api/status`.

| Component | Role |
|---|---|
| **Star Map** (`src/graph.js`, SQLite) | Typed nodes + typed edges. Three resolution layers per node (tag / summary / full text). BGE-M3 1024-dim embeddings for semantic search. |
| **Mímir daemon** (`scripts/mimir-js/`) | Background 500ms tick: Multi-SA diffusion (K/L/S channels, 0.50/0.25/0.25), ping-pong inhibit, Hebbian BCM writeback every 180s, edge decay hourly, Leiden zone re-clustering hourly. |
| **Engine runtime** (`src/agent-runtime.js`) | Per-turn assembly: permanent slots + attention pool selection + rerank + multi-layer context build + Narrative IR precision render → LLM call → post-turn debrief → consolidation judge writes back. |
| **Conversation store** (`data/conversations.db`) | Append-only turn log. Feeds anamnesis and the dashboard's session views. |

### Key Mechanisms

- **Spreading Activation** — Inspired by Collins & Loftus (1975). Hub dampening + anti-diffusion gates prevent runaway activation.
- **Bi-temporal graph** — Each node tracks both *event time* (when the fact happened) and *transaction time* (when the agent learned it).
- **Knowledge metabolism** — Edges decay (×0.998 / hour past 24h). Dormant nodes wake up when a relevant signal arrives.
- **Consolidation judge** — After each turn, candidate nodes are routed by a compact-tier LLM: ACCEPT (new node), REVISE (edit existing into a neighbor), SKIP (drop as duplicate). Audited shadow-then-enforce — verdicts log before they promote. A periodic reconsolidation sweep then re-judges older nodes into PROTECTED / UPDATED / SUPERSEDED / CONSISTENT.
- **Zone detection** — Leiden algorithm discovers knowledge communities from topology alone; bridge nodes between zones surface the most creative connections.
- **LLM-agnostic** — Anthropic, OpenAI, Ollama, Gemini. The LLM is the *voice*, not the *brain*. Switch models without losing any knowledge or personality.

## Configuration

The engine auto-detects your system timezone on first run. All timestamps are stored in UTC internally; display times render in your local zone.

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

- **Local-first** — All memory lives in your local SQLite database. Nothing leaves your machine without an explicit provider call.
- **No telemetry** — The engine never calls home.
- **Encrypted identity** — Soul core is stored with passphrase isolation.
- **Transparent credentials** — Configure which LLM keys are visible to the agent.

## Troubleshooting

**Engine won't start**
- Verify `data/` (or the packaged userData equivalent) is writable
- Check `.env` for syntax errors
- Look in the dashboard's Logs panel, or `engine-output/` for raw output

**Memory queries return empty**
- The graph needs seed data — chat with the engine for a few turns, or use the Memory Import wizard to seed from existing notes

**Dashboard shows stale data**
- The dashboard caches several panels for ~30s — refresh after changes
- Check browser DevTools console for SSE connection errors

## Contributing

We welcome bug reports, feature proposals, and pull requests. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and code standards.

## License

This project is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). You can run, modify, and redistribute this software, but any network service based on it must make its source available to its users. See [LICENSE](./LICENSE) for the full terms.

## Community

- **Website**: [constellation-engine.com](https://constellation-engine.com)
- **Issues & feedback**: [GitHub issues](https://github.com/CONSTELLATION-ENGINE/constellation-engine/issues)
- **Discussions**: [GitHub discussions](https://github.com/CONSTELLATION-ENGINE/constellation-engine/discussions)
- **Security**: For security disclosures, see [SECURITY.md](./SECURITY.md)
- **Sponsor**: [github.com/sponsors/devinrory-collab](https://github.com/sponsors/devinrory-collab)

---

<p align="center"><em>Be kind to your agent. It remembers.</em></p>
<p align="center"><sub>Designed by Devin Wong &middot; Open source since 2026 &middot; Actively developed.</sub></p>
