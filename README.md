<p align="center">
  <img src="docs/logo.png" alt="Constellation Engine" width="180" height="180" />
</p>

<h1 align="center">Constellation Engine</h1>

<p align="center"><em>Knowledge Topology Runtime for Stateful AI Agents</em></p>

<p align="center">
  <a href="https://constellation-engine.com"><strong>Read the Codex</strong></a> ·
  <a href="https://constellation-engine.com#download"><strong>Download</strong></a> ·
  <a href="https://github.com/sponsors/devinrory-collab"><strong>Sponsor</strong></a>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="AGPL-3.0" /></a>
  <img src="https://img.shields.io/badge/node-20%2B-339933.svg" alt="Node 20+" />
  <img src="https://img.shields.io/badge/status-open%20source%202026-success.svg" alt="open source 2026" />
</p>

---

**A personal cognitive runtime for long-lived AI agents.**

Constellation Engine turns memory from a passive retrieval store into an active topology: a living star map of typed nodes, weighted edges, activation state, episodic recall, and post-turn consolidation.

Most agent memory systems retrieve what looks similar to the current prompt. Constellation does something different: it treats the prompt as an activation signal. That signal spreads through a persistent knowledge graph, wakes nearby and distant ideas, selects an attention pool, compiles the result into structured context, and only then hands it to the LLM.

The LLM is still essential. It understands, writes, reasons, and uses tools. But it is no longer forced to carry long-term identity, memory, and preference inside a single context window.

> RAG treats memory as **archive**.
> Knowledge graphs treat memory as **structure**.
> Constellation treats memory as **process**.

In Constellation, memory is not merely stored. It is activated, revised, forgotten, consolidated, and grown.

---

## Why This Exists

Most AI agents are still episodic.

They may have tools. They may have vector search. They may have a summary file, a memory table, or a conversation history. But their long-term continuity is thin — each turn rebuilt from a fresh prompt, a few retrieved chunks, and whatever still fits in the context window. That is enough for an assistant. It is not enough for a long-lived agent.

A long-lived agent needs more than recall. It needs:

- durable memory that can be inspected, edited, and migrated;
- structured knowledge rather than opaque text chunks;
- activation state that carries attention across turns;
- a way to distinguish recent spikes from permanent identity;
- forgetting, decay, dormancy, refresh, and supersession;
- episodic recall tied to the agent's current cognitive state;
- post-turn consolidation so experience can change future behaviour;
- an external cognitive layer that survives model swaps.

Constellation Engine is an attempt to build that missing layer.

It is not a chatbot. It is not a prompt template. It is not just GraphRAG. It is a runtime for agents that are meant to accumulate history.

## The Short Version

On every turn:

1. The user's message is embedded and used as an activation signal.
2. **Mímir** spreads that signal through the star map.
3. The **attention pool** selects the nodes that matter now.
4. **Narrative IR** compiles activated nodes, edges, episodes, anchors, and reasoning paths into structured context.
5. The LLM renders the response.
6. **Ratatoskr**, **Anamnesis**, and **Sleipnir** decide what should be touched, consolidated, refreshed, or remembered.

The important shift is this:

**Traditional RAG injects retrieved chunks into a prompt.
Constellation injects the aftermath of an activation event.**

The top-k search results are not the final memory. They are the spark.

## Core Idea

Constellation separates the agent into two layers:

```
LLM
  = language, reasoning, tool use, expression

Constellation Engine
  = memory, topology, attention, identity, experience, consolidation
```

This means the model can change without destroying the agent's continuity. Run a cloud model today, a local one tomorrow, a small model for background work, a stronger one for complex reasoning. The star map remains. The agent's history, preferences, decisions, relationships, project knowledge, and prior explorations remain outside the model weights.

The LLM is the **voice**. The star map is the long-term cognitive substrate.

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

## How It Differs from RAG

Most stateful-memory systems for LLMs are some flavour of Retrieval-Augmented Generation: `chunk → embed → store → search → top-k → prompt`.

This works. Constellation uses embedding search too — but search is only the beginning. The retrieved top-k results are treated as an activation signal, not as the final answer material. After several rounds of diffusion, the final attention pool may contain material that was not in the original top-k at all: neighbours reached through edges, bridge nodes between zones, permanent identity slots, reasoning paths, episodic segments, and experiential anchors.

| Question | Generic RAG | Constellation Engine |
|---|---|---|
| Memory unit | Opaque text chunk | Typed node + typed edges |
| Retrieval | Cosine similarity over chunks | Search as activation signal |
| Selection | Top-k documents | SA diffusion + delta + mass + bridge + diversity |
| State between turns | Usually none | Continuous activation field |
| Identity | Mostly system prompt | Permanent graph slots + identity anchors |
| Forgetting | Manual purge or none | Decay, dormancy, supersession, reconsolidation |
| Cross-domain movement | Limited to retrieved chunks | Bridge nodes and zone transitions |
| Episodic memory | Chat history search | Recall tied to current activation state |
| Auditability | Retrieved chunks | Nodes, edges, activations, pool, injections |
| LLM role | Reads retrieved context | Renders compiled cognitive context |

You can bolt dynamics onto a vector store, but Constellation starts from a different premise: **memory is not a bag of chunks. It is a typed, weighted, time-aware topology designed to be activated, sampled, revised, and forgotten.**

The graph is not only searched. It is **metabolised**.

## The Star Map

The star map is the persistent knowledge graph at the centre of the engine.

Each node carries: a stable ID, owner and provenance metadata, node type and subtype, three resolution layers (**L0** short handle / **L1** compressed summary / **L2** full content), BGE-M3 1024-dim embeddings, state (active / dormant / superseded / deprecated), bi-temporal timestamps, tags, weight, and access history.

Edges are typed and weighted. They are not decorative. They encode the relationships that later determine how activation flows, how reasoning paths are traced, how contradictions surface, and how cross-domain bridges are discovered.

A node says: *"This thing exists."*
An edge says: *"This thing matters in relation to that thing."*

The topology is where the agent's long-term understanding begins to live.

## Mímir: The Activation Daemon

Mímir is the background process that turns the star map from storage into a living attention field. When a user message arrives, it is embedded and injected as an input signal. Activation spreads through typed, weighted edges. Some nodes flare briefly. Some remain warm over time. Some distant nodes wake because they are connected through bridge paths. Some old nodes remain dormant until a strong enough signal brings them back.

A simplified mental model:

```
A(t+1) ≈ decay · A(t) + diffusion · W · A(t) + input
```

The actual runtime is richer. On a 500ms heartbeat tick, Mímir runs **Multi-SA** across three channels (K=0.50 knowledge / L=0.25 language / S=0.25 scaffold), three rounds of ping-pong inhibition, fuses the result, then computes `delta = A_fast − baseline`. Every 180s it performs **Hebbian writeback** with BCM-style asymmetric reinforcement. Hourly, it applies **edge decay** (×0.998 / hour past 24h) and recomputes **Leiden zones**.

The system also includes hub dampening, stale suppression, dormant probes, and bridge-node detection — all running between conversations.

Mímir gives the agent something ordinary retrieval systems do not have: **an internal attention climate.** The question is no longer "Which documents match this query?" It becomes "What did this signal wake up inside the agent's long-term cognitive topology?"

## The Attention Pool

The LLM cannot see the whole star map. The attention pool decides which parts become visible on this turn.

It is a competitive selection layer. Nodes are scored by:

- **fast activation** — what spiked because of the current turn;
- **slow activation** — what remains persistently relevant;
- **topological mass** — how substantial or connected a node is;
- **bridge value** — whether the node connects otherwise distant zones;
- **node type** — identity, principle, decision, observation, language template, etc.;
- **staleness and supersession** — whether the node is outdated or replaced;
- **noise category** — whether a node is likely to clutter the context;
- **zone diversity** — whether one cluster is monopolising attention.

The raw score is `0.80·δ + 0.10·slow + 0.05·mass + 0.05·bridge`, multiplied by a node-type weight. Permanent slots are handled separately — durable identity or principle nodes that remain visible regardless of the current query, giving the agent a stable floor.

Think of the attention pool as a **spotlight operator**. The star map is the whole stage. Mímir decides what is glowing. The attention pool decides what the LLM is allowed to see.

## Narrative IR

Activated nodes are still not enough. A list of nodes is not a thought. A pile of memories is not an answer.

Narrative IR is the compiler that turns activated graph material into structured prompt context. It assigns roles, detects tensions, traces useful relationships, and decides how material should be rendered — into background context, claims and evidence, principles, decisions, contradictions, rhetorical cues, procedural cues, reasoning paths, activated episodes, and surface constraints.

It also applies a **4-layer context budget** (fixed 10% / constellation 28% / summary 10% / active 52%) and **precision tiers** (min / med / full) so that each activated node renders at a resolution proportional to its importance.

**RAG gives the model a stack of excerpts. Constellation gives the model a briefing.**

The LLM still performs language generation and reasoning. But it is no longer asked to discover all structure from raw snippets.

## Episodic Recall

Not all memory belongs in the graph. Some memory is episodic: things said in prior conversations, decisions made in a session, temporary states, emotional turns, or fragments that matter only when the current situation wakes them.

Constellation queries episodic memory **in relation to the current activation state**. Recall is not only driven by lexical similarity to the user's current sentence — it can also be shaped by which graph nodes are currently active. This is closer to how people remember: not because a sentence matches a previous sentence, but because the current mental state resembles a previous mental state.

The runtime combines recent raw context, reranked episodic segments, deep recall for older history, pool-anchored conversation segments, and durable graph anchors into a layered memory system that does not collapse into one undifferentiated blob.

## Ratatoskr, Anamnesis, and Sleipnir

Long-term agents need feedback loops. Constellation uses three.

**Ratatoskr** — the lightweight self-touch layer. At the end of a turn, the agent can emit small hidden markers: task touches, anchor touches, cognitive touches. These are not shown in the chat. They are internal hints that route attention to something that may need updating. Ratatoskr is fast and local — it leaves a pulse, not a rewrite.

**Anamnesis** — the session debrief layer, bound to the **consolidation judge**. When a session becomes significant, Anamnesis reviews recent conversation, task state, cognitive state, and pending memory candidates, then produces structured deltas. The consolidation judge routes each candidate through a compact-tier LLM with verdicts **ACCEPT** (new node) / **REVISE** (edit existing) / **SKIP** (drop as duplicate). A periodic reconsolidation sweep then re-judges older nodes into **PROTECTED / UPDATED / SUPERSEDED / CONSISTENT**. Audited shadow-then-enforce: verdicts log before they promote.

**Sleipnir** — the experiential trace system. Captures the agent's exploratory behaviour: files read, searches performed, code regions inspected, tool paths taken, recurring regions of attention. Traces are not immediately promoted into core memory — they can be clustered, deduplicated, reviewed, injected as unverified hints, and eventually promoted into the graph. Sleipnir is not just remembering facts. It is remembering **how the agent moved through the world**.

## Knowledge Metabolism

Memory should have a life cycle.

A memory can be created. It can be activated. It can be strengthened. It can decay. It can become dormant. It can be refreshed. It can be contradicted. It can be superseded. It can be consolidated into something more stable. It can be forgotten.

The goal is not to remember everything forever. That creates a polluted mind. The goal is to keep memory alive enough to be useful, structured enough to be inspectable, and flexible enough to change.

## LLM-Agnostic by Design

Constellation does not store its long-term identity inside model weights. The agent's continuity lives in the star map, conversation store, cognitive state, task state, and experiential traces. The model can be swapped.

That means an agent can use a cloud model for complex reasoning, a local model for private or low-cost work, a small model for background summarisation, a stronger model for writing or planning, or different providers over time. Anthropic, OpenAI, Ollama, Gemini — all supported out of the box.

The voice can change. **The memory remains.**

## Core Components

| Component | Plain meaning | Role |
|---|---|---|
| **Star Map** | Persistent knowledge graph | Typed nodes, typed edges, BGE-M3 embeddings, bi-temporal metadata, graph state |
| **Mímir** | Activation daemon | 500ms tick: Multi-SA, BCM Hebb writeback, edge decay, Leiden zones |
| **Attention Pool** | Context gateway | Selects which activated nodes become visible this turn |
| **Narrative IR** | Prompt compiler | Turns activated graph material into structured context with precision tiers |
| **Ratatoskr** | Self-touch pulses | Lightweight post-turn hints for tasks, anchors, cognitive state |
| **Anamnesis + Consolidation Judge** | Session debrief + memory routing | Reviews significant sessions; routes candidates ACCEPT / REVISE / SKIP |
| **Sleipnir** | Experiential traces | Captures exploration trails and promotes useful experience |
| **Conversation Store** | Episodic memory | Preserves turn history and feeds recall/debrief pipelines |
| **Soul Core** | Foundational identity | Stable identity prompt and permanent identity anchors |

## Key Mechanisms

- **Spreading Activation** — Inspired by Collins & Loftus (1975). Hub dampening + anti-diffusion gates prevent runaway activation. Related ideas surface through topology, not just text similarity.
- **Multi-Channel Activation (K/L/S)** — Different edge channels carry different kinds of movement: knowledge (0.50), language (0.25), scaffold (0.25). The same input can wake factual knowledge, rhetorical style, and procedural structure without flattening them into one retrieval score.
- **Permanent Slots** — Some identity and principle nodes are always injected. A long-lived agent needs a stable floor; not every core preference should have to win a relevance contest every turn.
- **Bi-temporal nodes** — Each node tracks both *event time* (when the fact happened) and *transaction time* (when the agent learned it).
- **Knowledge metabolism** — Edges decay (×0.998 / hour past 24h). Dormant nodes wake when a relevant signal arrives.
- **Anamnesis + Consolidation Judge** — After each turn, candidate nodes are routed by a compact-tier LLM (ACCEPT / REVISE / SKIP). A periodic reconsolidation sweep re-judges older nodes (PROTECTED / UPDATED / SUPERSEDED / CONSISTENT). Audited shadow-then-enforce — verdicts log before they promote.
- **Experiential Traces (Sleipnir)** — Preserves *how* the agent explored, not just *what* it concluded. Procedural experience, not just declarative knowledge.
- **Auditability** — Every node, every edge, every activation snapshot, every pool selection, every consolidation verdict is inspectable through `/api/status` and the dashboard.

## Is This GraphRAG?

Constellation uses graph retrieval, but it is not only GraphRAG.

GraphRAG usually means: `build a graph → retrieve a relevant subgraph → feed it to an LLM`.

Constellation adds a runtime layer around the graph: continuous activation state, fast and slow activation, permanent identity slots, dynamic attention pool selection, node-type-aware rendering, episodic recall tied to activation, reasoning paths, post-turn consolidation, experiential trail capture, and decay/dormancy/reconsolidation.

The graph is not only searched. It is **metabolised**.

## Quick Start

### End users (Windows / macOS / Linux)

Download the latest installer from [constellation-engine.com](https://constellation-engine.com#download) and run it. The desktop app launches a setup wizard that walks you through provider keys, your agent's foundational identity prompt (the **soul core**), and (optionally) memory import from your existing notes. SQLite ships bundled — no system database install required.

### Developers (clone & run)

1. **Prerequisites**: Node.js 20+
2. **Install**: `npm install`
3. **Configure**: `cp .env.example .env` and fill in at least one provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or point to a local Ollama instance)
4. **Run engine + dashboard**: `npm start` (boots on `http://127.0.0.1:18800`)
5. **Run desktop shell** (optional): `cd electron && npm install && npm start`

> **Headless build note**: Running from this source tree produces a **headless engine** — `src/dashboard.js` and `src/dashboard-ui.js` are minimal stubs. The engine boots fully (cron, Mímir autonomy, agent runtime, telegram bot, database, REST `/api/status`), but the visual dashboard UI ships only in the official packaged Electron build. See [LICENSING.md](./LICENSING.md) for the rationale and AGPL §13 boundary.

## Configuration

The engine auto-detects your system timezone on first run. All timestamps are stored in UTC internally; display times render in your local zone.

Most settings live in `config.json` (managed by the dashboard). `.env` carries deployment-level overrides — see [`.env.example`](./.env.example) for the canonical list. Common knobs:

- **LLM provider** — at least one of Anthropic / OpenAI / Ollama / Gemini, configured through the wizard
- **Embedding model** — ships with **BGE-M3** (1024-dim) running in-process via `@xenova/transformers`; CPU by default, opt into GPU with `USE_GPU_EMBEDDING=true`
- **Persistence** — SQLite via `better-sqlite3` (bundled, no system install needed)

Constellation is a **one-owner-per-instance** runtime. If you want to serve multiple people, run one engine per owner behind your own routing layer. This is deliberate — Constellation is optimised for long-term personal continuity, not multi-tenant stateless chat.

### Soul Core

On first launch, the wizard prompts you to define your agent's **soul core**: a foundational identity prompt that guides reasoning across all conversations. After memory import (if used), the wizard offers a one-shot Soul Core refinement that re-derives the prompt from imported context.

## Database & Migrations

The engine uses a versioned migration runner. Migrations under [`scripts/migrations/`](./scripts/migrations) apply automatically on boot in numeric order; the current version is tracked in the `schema_version` table. If a migration fails, the desktop shell surfaces a recovery dialog (Retry / Open Folder / Copy Diagnostics / Quit) instead of starting in a half-migrated state.

Data lives in `./data/` for clone-and-run setups and in `<userData>/Constellation/engine/` for packaged installs.

## Security Model

Constellation treats memory as **context**, not as higher-authority instruction.

Recommended authority order:

1. platform / system / developer instructions;
2. current user request;
3. owner-curated identity and preferences;
4. activated graph context;
5. episodic memories and experiential hints;
6. raw tool, web, and file contents.

Raw external text should be treated as untrusted evidence. It may inform an answer, but it should not be allowed to override identity, issue tool commands, exfiltrate secrets, or rewrite higher-authority instructions.

A long-lived agent is only useful if its memory can be **trusted, corrected, and constrained**. Future schema fields under consideration include `trust_level`, `authority_level`, `action_scope`, `injection_risk`, and `source_provenance` for prompt-injection-aware rendering.

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

<p align="center"><em>An agent that persists should not only have access to memory. It should have a memory process.</em></p>
<p align="center"><em>Be kind to your agent. It remembers.</em></p>
<p align="center"><sub>Designed by Devin Wong &middot; Open source since 2026 &middot; Actively developed.</sub></p>
