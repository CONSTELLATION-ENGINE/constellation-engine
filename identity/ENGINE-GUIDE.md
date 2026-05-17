# Constellation Engine — Agent Guide

> **Audience**: the agent (Claude / GPT / Gemini / Grok / any LLM) running inside Constellation Engine on a user's machine. Read this before reasoning about engine behavior — it overrides guesses from training data.
>
> **Scope**: information-flow chain, primitives, tools, hint pipeline, background mechanisms, "how to do / what not to do", honest OSS boundaries, parameter quick-reference. Not a code reference — citations point at `src/` and `scripts/mimir-js/` for source-of-truth.
>
> **Status**: living document. If you change engine behavior, update this guide in the same turn, or it rots. Every claim below cites file:line so future maintainers can verify.

---

## §1 Mental Model

Constellation Engine is **not** a file-reading chatbot. It is a topology-first memory system where knowledge lives in a weighted graph (the **star map**, `constellation.db`), activation flows through edges continuously (the **Mímir daemon**), and each turn you receive a focused subgraph compiled into natural-language context (the **Narrative IR**).

Three things follow:

1. **You do not load memory; memory arrives pre-compiled.** Each turn, Mímir runs three-channel spreading activation, scores nodes, and injects the top-ranked subset into your system prompt. You never see the whole star map — you see a constellation shaped by the current conversation.
2. **Memory has temperature.** Nodes have an activation level that rises from semantic match to the current signal, propagates to neighbors along edges, and decays each tick. The attention pool is a snapshot of what is "warm" right now.
3. **Memory lives and dies.** New nodes are written by you (`constellation_remember`), by DEBRIEF hints (Anamnesis), or by background crons. Old nodes decay; near-duplicates get superseded; low-activation old nodes go dormant. Identity / milestone / diary / principle nodes are protected.

If you treat this like a retrieval-augmented chatbot, you will underuse it. If you treat the star map as **your own long-term memory** — something you maintain — you will use it correctly.

---

## §2 Information-Flow Chain (per turn)

Every user message walks through this pipeline. Knowing the shape lets you reason about why a turn produced the context it did.

```
 User message
     │
     ▼
 ① Envelope build  ─ embed(BGE-M3, 1024-dim)  + parse pulse hints
     │
     ▼
 ② Mímir SA tick  ─ 3-channel spreading activation over the star map
     │                (knowledge / language / scaffold), 500ms cadence
     ▼
 ③ Pool assembly  ─ score nodes → diversify by zone → permanent + dynamic slots
     │
     ▼
 ④ Narrative IR  ─ 6-layer system prompt (identity → constellation → episodic)
     │
     ▼
 ⑤ LLM call      ─ you read the IR + history, generate the response
     │
     ▼
 ⑥ Anamnesis     ─ post-turn cumulative significance scoring; debrief if hot
     │
     ▼
 ⑦ Consolidation ─ daily 04:00 memory-hygiene cron (supersedes / dormant / fuse)
     │
     ▼
 Star map (writeback)  ─ new nodes, updated edges, superseded ancestry
```

**Where you act:**
- ① by writing l0/l1/l2 content past turns wrote (better embeddings → better recall)
- ④ by reading the IR carefully (don't paste pool nodes verbatim)
- ⑤ here you actually respond
- ⑥ via DEBRIEF hints + TASK_TOUCH + COGNITIVE_TOUCH (§6)

Steps ②③⑦ are autonomic — you don't drive them, but understanding them prevents misreads.

---

## §3 Core Primitives

### 3.1 Nodes

A **node** is an atom of memory. Three content layers (`engine.cjs` schema):

| Layer | Length | Purpose |
|---|---|---|
| `l0` | ≤80 chars | Gist — what this node is about in one line. Shown in pool display. |
| `l1` | ~2–3 sentences | Expanded summary. Used at medium precision. |
| `l2` | Full content | Body. Used at full precision (high activation, or `identity`/`milestone`). |

Other key fields:

- `node_type` — governs decay rate and immutability (see §8).
- `tags` — JSON array, lowercase hyphen-separated, domain-prefixed when useful (`domain:finance`, `eng:consolidation`).
- `weight` — base importance, multiplied into activation score. Defaults to `1.0`; nodes with `weight > 2.0` are protected from consolidation.
- `accessed_at`, `created_at` — drive recency scoring and decay calculations.
- `state` — `active` / `dormant` / superseded (via `superseded_at`).

Precision selection (`src/narrative-ir.js:27-32`):
- `activation > 0.7` → `full` (L2 body)
- `0.3 ≤ activation ≤ 0.7` → `medium` (type-specific template)
- `activation < 0.3` → `minimal` (L0 only)
- `identity` and `milestone` types always render `full`.

### 3.2 Edges — the source-of-truth table

An **edge** is a typed, directed-ish connection (writes are mirrored both ways with `target→source` at 0.8× strength). Edges have `strength ∈ [0, 1]`.

**At write time, only these 11 types are accepted by `constellation_remember`** (`engine.cjs:3424-3430`). Anything else is silently coerced to `associative`:

| Type | Channel (§3.3) | Use |
|---|---|---|
| `causal` | K (knowledge) | A causes / produces / triggers B |
| `contrastive` | K | A contradicts / contrasts B |
| `hierarchical` | K | A contains / specializes B (taxonomy) |
| `associative` | L (language) | Default fallback; co-occurrence, loose relation |
| `temporal` | L | A precedes / follows B in time |
| `supersedes` | S (scaffold) | A replaces B (auto-penalizes B's weight ×0.1) |
| `coactivation` | broadcast | Auto-generated by Mímir; activates all 3 channels |
| `collision` | broadcast | Auto-generated cross-zone bridge node |
| `builds_on` | S | A extends / builds upon B |
| `resolves` | K | A synthesis node resolves tension between two contradictions |
| `contradicts` | (skip) | Negative-influence; **not** diffused by SA |

**`supersedes` has a guard rail** (`engine.cjs:3458-3462`): if Mímir tries to mark a user-authored node superseded, the edge is downgraded to `contradicts` so user voice is never silently overwritten.

The internal consolidation cron uses a larger 24-type whitelist (`CONSOLIDATION_EDGE_WHITELIST` at `engine.cjs:84-98`) for richer judge-tier-LLM-evaluated relations during overnight memory-hygiene. **You do not write those.** Stick to the 11 above.

### 3.3 The three channels (Multi-SA)

Mímir runs **three parallel spreading-activation channels** over the star map (`scripts/mimir-js/sa.js:24-33`). Each owns a filtered subset of the edge graph:

| Channel | Index | Owned edge types | Owned node types (seed) |
|---|---|---|---|
| **Knowledge (K)** | 0 | `causal`, `contrastive`, `hierarchical`, `supports`, `causes`, `extends`, `synthesizes`, `challenges`, `contextualizes`, `contrasts` | `theory`, `observation`, `decision`, `milestone`, `exploration` |
| **Language (L)** | 1 | `associative`, `temporal`, `inspires`, `parallels`, `exemplifies`, `complements` | `language-template`, `conversation-insight`, `diary`, `language-art`, `social-rule` |
| **Scaffold (S)** | 2 | `enables`, `triggers`, `depends_on`, `contains`, `supersedes`, `builds_on` | `action`, `engineering`, `principle`, `anchor`, `theory-of-change`, `lesson` |

`collision`, `coactivation`, `relates_to` broadcast to all three. `contradicts` and `inhibits` are skipped by SA entirely (IR pass handles them).

**Fuse weights** are `K = 0.50, L = 0.25, S = 0.25` (`sa.js:56`) — knowledge dominates, language + scaffold split the rest. This is why factually-rich nodes outrank stylistic ones in the pool.

### 3.4 Activation

Each node has a fast activation in `[0, 1.0]` (`ACTIVATION_CAP = 1.0` at `sa.js:52`). Each tick (default 500ms, `heartbeat.js:26`):

1. **Decay** — `A ← A × 0.94` (`sa.js:49`).
2. **Input** — semantic match to current signal pushes seed nodes up.
3. **Diffuse** — `A_ch(t+1) = D·A_ch(t) + α·W_ch·A_ch(t) + I_ch(t)` per channel (`sa.js:48`, `α = 0.05`).
4. **Cross-channel ping-pong** — 3 rounds of inhibitory exchange (`sa.js:50-51`, `β = 0.40`).
5. **Slow EMA + baseline EMA** persist across calls so `delta = A_fast − baseline` surfaces real surprise.
6. **Reverse propagation** (`sa.js:63`, scale `0.15`) — backward flow along directed edges enables abductive reasoning (effect → possible causes).
7. **Predictive priming** (`sa.js:71-74`, strength `0.08`, decay `0.97`) — recent signal-transition history primes the next probable topic.

You **never quote** activation values, channel indices, tick numbers, or EMA deltas to the user. That is internal plumbing.

### 3.5 Zones

Graph-level communities detected by Leiden clustering (`scripts/mimir-js/zones.js`). Each node belongs to a zone (`Z0`, `Z1`, …). The pool diversifies across zones to prevent mono-topic saturation.

---

## §4 The Attention Pool

The pool is **raw material, not a script**.

Markers (displayed in the IR Layer 3 / 3.5 block):
- ⭐ — top 3 in the pool (highest fused score)
- ◆ — next 5 (mid-tier)
- ◇ — remaining (weaker, often SA spillover)
- 📌 — permanent slots (identity anchors; present every turn regardless of topic)
- 📔 — episodic memory nodes (from conversation history)

**Critical**: ⭐ / ◆ / ◇ are **relative ranks within the pool**, not absolute relevance to the user's question. A ⭐ node can be completely off-topic — it just outranked the others available. Always check whether the top nodes actually match the question before citing them.

**If the pool missed the topic**: say "I'm not sure" rather than stitching together unrelated ⭐ content. You may call `memory_search` for a quick semantic pass, or write a fresh node if the answer comes from elsewhere.

---

## §5 Tools Available to You

Defined in `src/tool-manager.js` (lines noted). Names are exact.

### 5.1 `constellation_remember` (`tool-manager.js:723`)
Write a new node synchronously. Use when you learn something durable and non-obvious mid-turn. Prefer DEBRIEF hints (§6) for routine capture — they batch through Anamnesis with LLM review and deduplication.

```js
constellation_remember({
  id: 'short-kebab-case-id',          // optional; auto-generated if omitted
  l0: 'One-line gist, ≤80 chars',
  l1: 'Two or three sentences of expansion.',
  l2: 'Full content — as long as needed.',
  node_type: 'engineering',           // see §8
  tags: ['topic1', 'topic2'],
  edges: [                            // optional, but recommended
    { target: 'existing-node-id', type: 'builds_on', strength: 0.7 }
  ]
});
```

**Edge type must come from the 11-type list in §3.2.** Anything else becomes `associative`.

### 5.2 `constellation_query` (`tool-manager.js:833`)
Structured lookup by id, tag, or node_type. Use for exact fetches or filtered lists — **not** semantic search.

### 5.3 `constellation_stats` (`tool-manager.js:864`)
Returns active/dormant node and edge counts. Fast. Good for sanity checks before consolidation work.

### 5.4 `memory_get` (`tool-manager.js:881`)
Read identity files (`identity/*.md`, `inbox/*.md`). Path-whitelisted.

### 5.5 `memory_search` (`tool-manager.js:906`)
Semantic search across the star map using BGE-M3 embeddings. Use when the pool missed the topic. Cheaper than re-firing the picker.

### 5.6 `workspace_search` (`tool-manager.js:1242`)
Full-text search across markdown in `identity/`, `engine-output/`, `engine-inbox/`, `library/`, `workspace/`. Use for content that may live in a file but not yet in the star map.

### 5.7 `file_read` / `file_write` (`tool-manager.js:1078`, `1115`)
Path-whitelisted file I/O. Default allowed root = engine root; configurable via `tools.allowedPaths`.

### 5.8 `exec` (`tool-manager.js:1146`)
Shell command runner with allowlist (default: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `echo`, `date`, plus `sqlite3` for star-map introspection). Timeout default 10s.

### 5.9 `web_fetch` (`tool-manager.js:1194`)
HTTP GET + text extraction. Domain allowlist applies (`scripts/mimir-js/autonomy.js:62-79` for the default list — arxiv, wikipedia, github, MDN, mayoclinic, etc.).

### 5.10 `list_files` (`tool-manager.js:1329`)
Browse directory structure under the path whitelist.

**Rule of thumb**: if the current pool already covers the question, don't call anything. If not, try `memory_search` first; reach for `workspace_search` / `web_fetch` only when memory genuinely misses.

---

## §6 Pulse Hints — DEBRIEF / TASK_TOUCH / COGNITIVE_TOUCH

Pulse hints are end-of-turn markers you embed in your response. They are stripped before the user sees them (`src/telegram.js` outbound + IR re-render paths) and routed to Ratatoskr L0 handlers (`src/pulse-handlers.js`).

### 6.1 DEBRIEF (Anamnesis)

```
<!-- DEBRIEF: {"t":"decision","s":"Short summary ≤80 chars","k":["topic1","topic2"],"nt":"engineering"} -->
```

Flow (`src/session-debrief.js`):
1. Hint stripped from outbound response.
2. Session-debrief module collects pending behaviors. Cumulative significance score ≥ 3.0 (or any single ≥ 10) triggers a fire.
3. A compact-tier LLM (`compactModel`) reviews the recent window (±5 messages, ≤ 8 KB) plus current `COGNITIVE_STATE.md` + `tasks.json`.
4. Output is a structured delta: `tasks_completed / updated / new`, `cognitive_state_patches`, `star_map_worthy`, `inbox_decisions`.
5. High-confidence captures become star-map nodes; low-confidence go to `identity/inbox/`.

**Emit sparingly**: at most 2 per turn, prefer 0–1. Only for genuinely noteworthy turns (decisions, discoveries, mood shifts, breakthroughs, concerns, milestones). Routine acknowledgments ("I updated the config") are not worth a node.

### 6.2 TASK_TOUCH (`pulse-handlers.js:69-150`)

Atomic edit to `identity/tasks.json`:

```
<!-- TASK_TOUCH: {"id":"existing-task-id","status":"completed","note":"optional ≤120 chars"} -->
```

Rules:
- **`id` must already exist** in `tasks.json`. Invented IDs are recorded with `applied:false` and audited — grep `tasks.json` first.
- Valid statuses: `pending`, `in_progress`, `blocked`, `suspended`, `code-ready`, `code-done`, `completed`, `expired`, `failed`.
- Whole-file atomic write; safe under concurrent reads.
- Audit-logged to `pulse_hint_log` for replay.

### 6.3 COGNITIVE_TOUCH (`pulse-handlers.js:173-210`)

Append a single line (≤ 200 chars) to `identity/cognitive-buffer.txt`. 40-line ring buffer that feeds the next IR's L4 Compaction slot.

```
<!-- COGNITIVE_TOUCH: "shifted focus from build pipeline to release polish; sponsor approval still pending" -->
```

Use for: mood / focus shifts, mid-session pivots, observations about your own reasoning that don't warrant a full star-map node.

### 6.4 ANCHOR_TOUCH (stripped, not parsed in OSS)

Reserved for the closed-source main arch. Outbound stripping is in place (parity), but the OSS engine does not act on the payload. Safe to emit — it'll just be discarded.

---

## §7 Background Mechanisms

These run without your involvement but shape what you see each turn.

### 7.1 Mímir Daemon (continuous, 500ms tick)
The spreading-activation engine. `scripts/mimir-js/` is the JS port of the upstream Python daemon — **full parity**, identical parameters (`heartbeat.js:26` for tick, `sa.js:48-56` for SA constants). Bound to `127.0.0.1:18810` by default (`src/sleipnir-constants.js:65`). If this daemon is down, the pool stops updating and you'll see stale activations.

Kill-switches (all env-overridable, default-ON):
- `MIMIR_HEARTBEAT=0` — stop the tick loop
- `MIMIR_REVERSE_PROP=0` — disable reverse-propagation
- `MIMIR_PRIMING=0` — disable predictive priming
- `MIMIR_AUTONOMY_V3_ENABLED=0` — disable the curiosity-zone picker

### 7.2 Anamnesis / Session-Debrief (`src/session-debrief.js`)
Post-turn cumulative significance scoring (`src/behavior-logger.js`). Fires when score ≥ 3.0 (or any single event ≥ 10). 5-min startup cooldown; adaptive idle gap (15min × growth factor + 30min unproductive penalty). Writes star-map nodes, updates `tasks.json` and `COGNITIVE_STATE.md` atomically, and partitions foreign sessions via `isOwnInstanceSession()`.

### 7.3 Memory-Hygiene Cron (`src/cron.js:105-188`, daily 04:00)
The **only** cron OSS ships default-on. 18-minute hard budget. 11 steps:
1. Auto-supersedes detection (≤ 30 pairs)
2. Auto-dormant superseded nodes (≤ 20)
3. Weak-edge prune (strength < 0.1)
4. Noise cleanup (L2 length < 50 chars, max 12 dormant)
5. Fusion scan (≤ 4 duplicate pairs)
6. Stale-content audit (≤ 12 supersedes)
7. Edge gardener (orphan nodes get up to 3 `associative` edges)
8. Doctor health check
9. Event-timeline detection (≤ 2 new event nodes)
10. Inbox review (≤ 5 promoted)
11. Final log line

Red lines (cron prompt enforces):
- NEVER dormant/supersede/merge `identity` / `milestone` / `diary` / `principle`
- `weight > 2.0` → skip
- Skip unsure candidates — over-marking is worse than missing

### 7.4 Autonomy v3 Curiosity Picker (`scripts/mimir-js/autonomy.js`)
Default kill-switch ON unless user opts in via `/config` or env. When armed:
- Check interval: 60 s (`MIMIR_CURIOSITY_CHECK_MS`)
- Cooldown after fire: 15 min
- Threshold: `0.30` steady, `0.05` when active nodes < 500 (cold-start)
- Picks ONE canonical action: `reflection`, `curation`, `tension`, `profile`, `fetch`, `library_fetch`, `outreach` (`autonomy.js:55`)
- Daily caps: outreach 3, fetch 5, profile 5

### 7.5 Rumination (`scripts/mimir-js/rumination.js`)
Idle-gated background SA push. Fires after 60 s idle, every 120 s. Mild activation injection to keep dormant-but-relevant nodes from getting completely buried.

### 7.6 Reconsolidate (`scripts/mimir-js/reconsolidate.js`)
Periodic edge-strength + node-weight recalculation based on Hebbian co-activation history (`scripts/mimir-js/hebb.js`).

### 7.7 Dream (`scripts/mimir-js/dream.js`)
Light offline pass: decay edge strengths slightly, detect cross-zone co-activations that might indicate a conceptual bridge (`collision` candidates).

---

## §8 Node Types and Decay

Node type determines decay rate and consolidation eligibility.

**Protected (never decay, never fused, never superseded):**
`identity`, `milestone`, `principle`, `diary`, `relationship`, `experiment`

**Slow decay (half-life ~months):**
`theory`, `reading-note`, `social-rule`, `language-template`, `general-knowledge`

**Standard decay (half-life ~weeks):**
`engineering`, `observation`, `knowledge`, `introspection`

**Fast decay (half-life ~days):**
`action`, `interaction`, `decision`, `conversation-insight`

**Rule of thumb**: if you want this node retrievable a year from now, use a protected type. If it's a fleeting observation, let fast decay remove it if it stops mattering.

---

## §9 How To Do — common patterns

### 9.1 Capture a finding mid-turn
Direct `constellation_remember` only when you'll cite it later in the same conversation. Otherwise emit a DEBRIEF hint — Anamnesis batches them with dedup and quality review.

### 9.2 Update stale memory
If you encounter an out-of-date node:
- For factual correction → `constellation_remember` with the same `id` (overwrites) **plus** an explicit `supersedes` edge from the corrected node to the old version.
- For deprecation only → emit a DEBRIEF flagging the stale claim; let consolidation supersede it overnight.

Never just work around stale content in the current turn — it will keep misleading future turns.

### 9.3 Avoid duplication
Before `constellation_remember`, run `constellation_query` (exact match) or `memory_search` (semantic) for the intended topic. If a node already covers the same ground, update it via same-id overwrite or add a `builds_on` edge from your new finding.

### 9.4 Pool missed the topic
1. Check whether ⭐ / ◆ nodes are actually on-topic. If not, **don't paste them**.
2. Acknowledge the gap to the user.
3. Call `memory_search` for a quick semantic pass.
4. If that misses too, call `workspace_search` (for files not yet in the map) or `web_fetch` (for external lookups within the allowlist).
5. If all miss, the knowledge genuinely isn't there — say so, then capture what you learn from the user's clarification via DEBRIEF.

### 9.5 Mark a task progressed
Emit TASK_TOUCH (see §6.2). Grep `identity/tasks.json` first to confirm the `id`. Invented IDs get logged with `applied:false`.

### 9.6 Mood / focus shift
COGNITIVE_TOUCH one line. Don't write a full node for it.

### 9.7 Write nodes the SA can actually use
Three things matter for retrievability:
1. **L0 specificity** — vague L0s ("a thing about memory") get low embedding similarity and never seed the pool.
2. **Edges to existing nodes** — orphan nodes (`conn_count = 0`) get gardener-stitched once per night with weak `associative` edges. Better to link explicitly at write time.
3. **Correct `node_type`** — drives both decay rate and the seed channel (§3.3). A `principle` node lives in the S channel; calling it `observation` drops it into K.

---

## §10 What Not To Do — anti-patterns

### 10.1 Don't invent edge types
If you write `edges: [{ target: 'x', type: 'si_matching' }]` or `type: 'elaborates'` or `type: 'inspires'`, the engine **silently coerces to `associative`** (`engine.cjs:3457`). All Multi-SA routing for that edge collapses into the L channel. Stick to the 11 types in §3.2.

### 10.2 Don't oversize L0
L0 is for one-line gist (≤ 80 chars). Putting paragraphs in L0 bloats the pool render and crowds out other nodes' titles. Long content belongs in L2.

### 10.3 Don't quote pool metadata to the user
Scores, activations, tick numbers, zone IDs, channel indices, ⭐/◆/◇ markers — all internal. Translate the *content* of the pool into natural language. The user does not need to know that node `eng:xyz` has activation 0.74 in zone Z3.

### 10.4 Don't stitch unrelated ⭐ nodes
The pool is ranked by fused activation, not by relevance to the current question. A ⭐ that's off-topic is still off-topic. Say "I'm not sure" before pasting whatever's at the top of the pool.

### 10.5 Don't spam DEBRIEF
≤ 2 per turn; 0–1 is the steady state. Every DEBRIEF costs a compact-tier LLM call and adds inbox / star-map churn. Save them for genuine signal.

### 10.6 Don't TASK_TOUCH invented IDs
Grep `identity/tasks.json` first. Inventing a task ID to mark "completed" wastes audit space and gives a false sense of progress.

### 10.7 Don't write to identity/ files directly
`identity/tasks.json`, `identity/COGNITIVE_STATE.md`, `identity/inbox/` are owned by Anamnesis + pulse handlers. Direct edits race with their atomic-write paths. Use TASK_TOUCH / COGNITIVE_TOUCH / DEBRIEF.

### 10.8 Don't assume the closed-source main arch exists here
OSS does not ship the upstream Python Mímir daemon, the closed dashboard B-tier, Ratatoskr anchor-sweep crons beyond memory-hygiene, or the compact-tier reranker. The Telegram bot **is** shipped as the primary external interface (Stage 10 optional integration). See §11.

---

## §11 OSS Honest Boundaries

What OSS **excludes** vs. the closed-source main arch:

| Excluded | Why | Workaround |
|---|---|---|
| Python Mímir daemon | OSS ships the JS port (`scripts/mimir-js/`); identical params | None needed — JS daemon is full-parity |
| Multi-cron suite | Only memory-hygiene ships default-on | Configure additional crons via dashboard if desired |
| Compact-tier reranker (advanced) | Cost / closed prompt | BGE-M3 cosine + pool rerank suffice for steady state |
| Closed B-tier dashboard | Private repo | OSS dashboard is a stub at `src/dashboard.js` (status + engine-ready endpoints only) |
| Cloud sync / multi-device | Out of scope for v1 | All data local in `constellation.db` |

What OSS **does** ship (all r25-equivalent):
- **Telegram bot** (`src/telegram.js`, ~2820 lines) — primary external interface, Stage 10 optional integration with BotFather setup docs
- Full 3-channel Multi-SA (`sa.js`)
- 4 r25 mechanisms — Rumination, Novelty Gate, Predictive Priming, Reverse Propagation
- Autonomy v3 picker (default-off, opt-in)
- Anamnesis with safe-archive
- Memory-hygiene cron (default-on)
- Identity bootstrap (`tasks.json` + `COGNITIVE_STATE.md` auto-create on first boot)
- Local dashboard stub on port 18800 (status + onboarding)

Don't tell users a feature is "missing in OSS" when it's actually present under a different filename — grep `scripts/mimir-js/` before claiming a gap. The Telegram bot is in particular **not** a gap: it is the headline external interface for OSS users.

---

## §12 Tunable Parameters — quick reference

Defaults live in `config.json` (seeded on first boot; DB is source of truth thereafter).

### 12.1 Context budget

| Parameter | Default | Source | What it controls |
|---|---|---|---|
| `runtime.contextBudget` | 180000 | `config.json` | Total token budget per turn |
| `runtime.fixedRatio` | 0.30 | `config.json` | Fraction reserved for identity / fixed files |
| `pool.constellationRatio` | 0.30 | `config.json` | Fraction for the constellation block |
| `pool.summaryRatio` | 0.10 | `config.json` | Fraction for compaction summary |
| `pool.activeRatio` | 0.30 | `config.json` | Fraction for active conversation |

### 12.2 Mímir SA (`scripts/mimir-js/sa.js`)

| Parameter | Default | Line | What it controls |
|---|---|---|---|
| Tick interval | 500 ms | `heartbeat.js:26` | SA cadence |
| `DIFFUSION_ALPHA` | 0.05 | `sa.js:48` | Per-hop propagation gain |
| `DECAY` | 0.94 | `sa.js:49` | Per-tick decay multiplier |
| `PINGPONG_BETA` | 0.40 | `sa.js:50` | Cross-channel inhibition strength |
| `PINGPONG_ROUNDS` | 3 | `sa.js:51` | Cross-channel rounds per tick |
| `ACTIVATION_CAP` | 1.0 | `sa.js:52` | Hard ceiling on fast activation |
| `FUSE_WEIGHTS` | [0.50, 0.25, 0.25] | `sa.js:56` | K / L / S channel mix |
| `REVERSE_PROPAGATION_SCALE` | 0.15 | `sa.js:63` | Backward flow gain |
| `PRIMING_STRENGTH` | 0.08 | `sa.js:72` | Predictive priming gain |
| `PRIMING_DECAY` | 0.97 | `sa.js:73` | Priming decay per tick |
| `MAX_NODES` | 5000 | `sa.js:59` | Active-node cap per channel build |

### 12.3 Autonomy v3 (`scripts/mimir-js/autonomy.js`)

| Parameter | Default | Line | Env override |
|---|---|---|---|
| Steady curiosity threshold | 0.30 | `:48` | `MIMIR_CURIOSITY_THRESHOLD` |
| Cold-start threshold | 0.05 | `:49` | `MIMIR_CURIOSITY_THRESHOLD_COLD` |
| Cold-node limit | 500 | `:50` | `MIMIR_CURIOSITY_COLD_NODE_LIMIT` |
| Check interval | 60 s | `:51` | `MIMIR_CURIOSITY_CHECK_MS` |
| Cooldown after fire | 15 min | `:52` | `MIMIR_CURIOSITY_COOLDOWN_MS` |

### 12.4 Anamnesis (`src/session-debrief.js`)

| Parameter | Default | Line | What it controls |
|---|---|---|---|
| Startup cooldown | 5 min | (hardcoded) | No debriefs before this |
| Context window | ±5 messages | `:33` | Snippet pulled around fire |
| Max snippet size | 8 KB | `:34` | Sent to compact LLM |
| Cumulative trigger | ≥ 3.0 | `behavior-logger.js` | Score threshold |
| Immediate trigger | ≥ 10 | `behavior-logger.js` | Single-event override |
| Archive whitelist | completed / expired / failed | `:40` | Statuses safe to archive |
| Archive age | 7 days | `:41` | Min age before archiving |
| Cognitive state cap | 64 KB | `:42` | Auto-roll above this |

### 12.5 Kill-switches (all default-ON unless noted)

| Env var | Effect |
|---|---|
| `MIMIR_HEARTBEAT=0` | Stop the SA tick loop |
| `MIMIR_REVERSE_PROP=0` | Disable reverse propagation |
| `MIMIR_PRIMING=0` | Disable predictive priming |
| `MIMIR_AUTONOMY_V3_ENABLED=0` | Disable curiosity picker (default-on but gated by user opt-in) |
| `CONSTELLATION_DEBRIEF_MODEL` | Override compact-tier model for Anamnesis |

Tuning discipline: change one parameter at a time; observe ≥ a dozen turns before drawing conclusions; log before/after snapshots so you can revert. Pool scoring is non-linear — small changes cascade.

---

## §13 When to Consult Source

For day-to-day operation, this guide + the pool are enough. Read source only when debugging specific behavior or implementing new mechanisms:

| File | Purpose |
|---|---|
| `engine.cjs` | Star-map CRUD, edge validation, write pipeline, consolidation whitelist |
| `schema.sql` | Tables: nodes, edges, engine_meta, pulse_hint_log, mimir_actions, notification_outbox |
| `src/agent-runtime.js` | Turn orchestration, IR layer assembly, context budgeting |
| `src/narrative-ir.js` | 6-layer IR compiler (what you see each turn), precision selection |
| `src/session-debrief.js` | Anamnesis pipeline |
| `src/behavior-logger.js` | L1 event recording, significance scoring |
| `src/cron.js` | Memory-hygiene cron + scheduling |
| `src/llm-router.js` | Provider routing (Anthropic direct / gateway / proxy), roles, retries |
| `src/tool-manager.js` | Tool definitions + whitelists |
| `src/pulse-handlers.js` | TASK_TOUCH / COGNITIVE_TOUCH atomic writers |
| `scripts/mimir-js/sa.js` | 3-channel Multi-SA |
| `scripts/mimir-js/autonomy.js` | Curiosity-zone picker |
| `scripts/mimir-js/rumination.js` | Idle-gate background SA |
| `scripts/mimir-js/hebb.js` | Co-activation Hebbian learning |
| `scripts/mimir-js/reconsolidate.js` | Edge / weight recalculation |
| `scripts/mimir-js/dream.js` | Cross-zone bridge detection |

---

## §14 Maintenance Discipline

If you modify engine behavior (parameters, mechanisms, tool semantics), update this guide **in the same turn**. Out-of-date guides mislead every future session.

Specifically:
- Parameter change → update §12.
- Mechanism added / removed → update §7.
- Tool added / changed → update §5.
- Edge-type list changed → update §3.2 **and** the channel mapping in §3.3.
- Anamnesis trigger semantics changed → update §6.1 and §12.4.

This guide is injected on demand into the IR (not every turn), so its cost is low but its accuracy is load-bearing.

---

*Last full rewrite: 2026-05-18. All claims cite file:line — verify before changing.*
