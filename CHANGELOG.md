# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Consolidation apply paths are transaction-safe** (`engine.cjs`): `_applyFuse()` and `_applySupersede()` now wrap their multi-step node/edge updates in `BEGIN IMMEDIATE` / `COMMIT`, with rollback on failure. This prevents shutdowns, restarts, or thrown errors during consolidation from leaving a logically half-applied merge/supersede operation.

## [1.0.2] - 2026-05-24

Hotfix release for Codex-compatible providers, optional Codex OAuth setup, semantic anchor embeddings, and packaged launcher polish.

### Fixed (1.0.2)
- **Packaged Codex shim cold-start** (`src/gateway-manager.js`, `electron/onboarding/llm-config.js`, `config.example.json`): the Codex OAuth card tested the shim with Electron's bundled Node runtime, but saved `gatewayCommand="node scripts/codex-shim/server.js"` for later boots. Packaged installs on machines without a system `node` could pass first-run setup and then fail to restart the shim after relaunch. The engine now starts the bundled shim with `process.execPath`, no shell dependency, and passes the configured localhost host/port into the shim process.
- **Codex-compatible provider budget defaults** (`config.example.json`, `src/config.js`, `src/agent-runtime.js`): raised runtime soft warning defaults to `maxTurnTotalTokens=2000000` and `sessionTokenBudget=10000000`, and aligned fallback context ratios to `fixedRatio=0.10`, `constellationRatio=0.28`, `activeRatio=0.52`. This prevents Claude-era defaults from reappearing when configs are regenerated or partially missing, especially for Codex/OpenAI-compatible harnesses that report system/MCP overhead in usage.
- **Star-map dense retrieval hardening** (`engine.cjs`, `scripts/migrations/0003-semantic-anchor.sql`, `scripts/audit-star-embeddings.cjs`, `scripts/backfill-star-embeddings.cjs`): added optional `semantic_anchor` / `embedding_text_version` columns and a shared embedding-text builder so broad nodes can improve dense retrieval without bloating L0/L1/L2. Added dry-run-first audit/backfill tools for missing vec0 rows; the backfill writes only `node_rowids` / `node_embeddings` and does not create edges.
- **Electron launcher polish** (`electron/main.js`, `electron/package.json`): second-instance activation now focuses whichever window is actually open (main dashboard or onboarding wizard), and packaged builds explicitly include the canonical icon assets used by the launcher/installer.

### Added (1.0.2)
- **Optional Codex OAuth provider path** (`electron/onboarding/llm-config.js`, `scripts/codex-shim/server.js`, `src/gateway-manager.js`): first-run setup now offers a Codex CLI card for users who have installed Codex and run `codex login`. The local-only shim exposes an OpenAI-compatible endpoint on `127.0.0.1:3457`, never reads or stores Codex OAuth tokens, and runs Codex in read-only mode. This is an optional convenience path; API-key and local OpenAI-compatible providers remain the default stable setup.

## [1.0.1] - 2026-05-19

Hotfix release. Three silent-failure bugs surfaced by a 20-round research-cron sweep (Opus, 2026-05-19) that took the post-1.0.0 codebase as fixed input and walked the cognitive pipeline end-to-end looking for orphan producers / consumers.

### Fixed (1.0.1)
- **vec0 lookup column rename** (`engine.cjs`): consolidation's per-candidate embedding pull used `WHERE rowid = ?` on the sqlite-vec virtual table, but `vec0` exposes the primary key as `id`, not `rowid`. The SELECT returned nothing, leaving the consolidation judge embedding-blind on every pair. Fix: `WHERE id = ?`.
- **`mimir_actions` table now actually populated** (`src/dashboard.js`): the autonomy picker's success branch wrote to `mimir_outreach_audit` but never wrote the canonical row to `mimir_actions`. Consumer side (Critic gate, demotion-sweep, persona caps, outreach review queue) was reading from an always-empty table — silently no-op'd in production. Added the missing INSERT with try/catch + action guard + meta sanitization.
- **`self_act` consolidation policy** (`engine.cjs` `ALLOWED_OPS_BY_TYPE`): Mímir-emitted `self_act` nodes had no entry in the policy map, so the type gate rejected them before reaching the judge. Added `'self_act': ['FUSE', 'TIMELINE_MERGE', 'INDEPENDENT']` so they participate in consolidation like any other autonomous-source type.

### Notes (1.0.1)
- No schema migration; no env-var changes; no API changes.
- Dashboard bundle rebuilt to bake the `mimir_actions` INSERT into the obfuscated dist (the build-platform.sh `[1.5/6]` overlay step picks up the new bundle).
- electron-updater will offer 1.0.1 as a drop-in update for 1.0.0 installs once the release is published.

## [1.0.0] - 2026-05-18

First stable release. Same engine that's been running in production daily, with a final pre-launch polish pass on top of the 0.3.0r26 line.

### Added (1.0.0)
- **Single-chunk cron delivery** (`src/telegram.js`, `src/cron.js`): cron reports now post as one Telegram message instead of being shredded into ~900-char fragments. `send()` / `sendLong()` accept a `{ style: 'single' | 'layered' }` override; cron paths force `single`. User-driven `/talk` replies still use the layered chunker.
- **IR anti-hallucination pass** (`src/narrative-ir.js`): duty-section tail now carries an explicit deep-retrieval trigger ("if a fact isn't in this packet, dig — don't invent") plus an anti-fabrication hard rule. Reduces low-confidence completions when the pool covers a topic but the L0/L1 layers are thin.
- **Top-N force-full precision** (`src/agent-runtime.js`): the top-7 dynamic pool nodes by score now render at `precision='full'` regardless of token budget. Cap raised from the legacy 5-slot heuristic. `POOL_TOP_N_FORCE_FULL` env override (default 7).
- **RESTART_TOUCH pulse hint** (`src/behavior-logger.js`, `src/pulse-handlers.js`, `src/main.js`, `electron/main.js`): fifth pulse marker joins DEBRIEF / TASK_TOUCH / COGNITIVE_TOUCH / ANCHOR_TOUCH. The agent can request an in-place engine restart via this marker; the Electron launcher catches the exit signal and respawns without dropping session state.
- **`library_read_log` table** (`scripts/mimir-js/diary.js`): records every library read with a 24h KNN-dedup window. Surfaces as a digest for the consolidation re-sweep loop.

### Changed (1.0.0)
- **Consolidation cosine threshold** lowered 0.70 → 0.65 (`engine.cjs` `CONSOLIDATION_COSINE_THRESHOLD`). Catches more fusion candidates at the cost of more judge calls; offset by the auto-supersede + type-gate paths.
- **Reconsolidate batch threshold** raised 0.85 → 0.92 (`scripts/mimir-js/reconsolidate.js` `SUPERSEDE_THRESHOLD`) plus a `SUPERSEDE_BLOCKED_TYPES` gate. The pure-cosine batch path no longer bypasses the judge's TIMELINE_MERGE classification for borderline pairs — true verdicts route through the periodic re-sweep instead.
- **Lever B re-sweep** added to `engine.cjs` `_consolidationResweep()`: every 6h, re-scan recent active nodes through the full judge. Kill-switch `ENGINE_CONSOLIDATION_RESWEEP=0`.

### Added (r26)
- **`/status` payload surfaces mechanism toggles**: `rumination_enabled` and `novelty_gate_enabled` now read out of `getStatus()` alongside `sa` and `leiden`, so dashboards can pull mechanism state from one endpoint without polling `/rumination/status` and `/hebb/status` separately. `/config` GET/POST still authoritative for runtime flips.

### Fixed (r26)
- **`edges.valid_from` now defaults to current epoch-ms on INSERT** (`schema.sql`). Bi-temporal reads filter on `valid_from`, and main-arch installs got the default expression via `migrate_phase1c`; OSS shipped without it, so rows from any INSERT path that didn't explicitly stamp `valid_from` would land NULL and silently fall out of the time-window filter. New `DEFAULT (CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))` matches main-arch behavior.

### Added (r25)
- **Predictive priming** ported to `mimir-js/sa.js` (Python parity: `SIGNAL_HISTORY_SIZE=20`, `PRIMING_STRENGTH=0.08`, `PRIMING_DECAY=0.97`). After every `/signal` injection, current `A_fast` is snapshotted into a per-instance signal history. Each tick predicts the next-likely activation pattern via cosine-similarity-weighted average of "what came after past signals like this one" and pre-warms those nodes through the same 3-channel fusion weights as the forward pass. Already-active nodes are damped 10× to push priming outward into unexplored space. Kill-switch: `MIMIR_PRIMING=0`. Default-ON.
- **Reverse propagation** ported to `mimir-js/sa.js` (Python parity: `REVERSE_PROPAGATION_SCALE=0.15`, `DIRECTED_EDGE_TYPES` = supports/extends/exemplifies/contains/depends_on/enables/causes/inspires/supersedes). Per-channel reverse CSR matrices built alongside forward CSR during `_buildState()`; each tick adds a fusion-weighted backward diffusion pass so activation flows effect→cause along directed edges (abductive reasoning substrate). Kill-switch: `MIMIR_REVERSE_PROP=0`. Default-ON.
- **Novelty gate** ported to `mimir-js/hebb.js` (Python parity: `NOVELTY_GATE_THRESHOLD=0.3`, `NOVELTY_EMA_ALPHA=0.1`, `EMA_MAX_SIZE=3000`). LTP (+0.02) now only fires when `|coact − EMA|` exceeds the threshold — strengthening surprising co-activations and skipping over well-predicted ones. EMA dict prunes at 3000 entries (drop ≤0.01 noise floor, then keep top half by EMA value). Kill-switch: `MIMIR_NOVELTY_GATE=0`. Default-ON.
- **Rumination** ported as `mimir-js/rumination.js` (Python parity: `rumination_interval_s=120`, `rumination_strength=0.35`, `rumination_n_nodes=12`, idle ≥60s). When the daemon goes idle, pick a Leiden zone weighted 70% by mean `A_slow` (recent cognitive afterglow) + 30% by zone size; re-inject `0.35` energy into the top 12 nodes by `weight · (1 + log(1+access_count))`. Mirrors the brain's default-mode network. Kill-switch: `MIMIR_RUMINATION=0`. Default-ON. Routes: `POST /rumination/run`, `GET /rumination/status`.
- **`/config`** GET and POST now expose four mechanism toggles (`rumination_enabled`, `novelty_gate_enabled`, `reverse_propagation_enabled`, `priming_enabled`) for runtime control without restart. Env-var kill-switches remain the durable off-switch.

### Fixed (r25)
- **Identity bootstrap on standalone boots**: `src/main.js` now scaffolds `identity/`, `identity/tasks.json` (default `{"tasks":[]}`), `identity/COGNITIVE_STATE.md`, `engine-inbox/`, and `library/` on every launch (idempotent). Previously only the Electron path (`electron/main.js`) did this, so `node src/main.js` could hit ENOENT inside Anamnesis writes if those files were missing from the repo. Defensive `mkdirSync({recursive:true})` guard also added to `session-debrief.js#backupAndWrite()` so any other write path lands the parent directory before `writeFileSync`.

### Changed (r24)
- **Sponsor verification is now permanent on first success.** The dashboard previously re-queried the Worker every 7 days and would re-show the support banner if the cache aged out. Now, once a sponsor (recurring or one-time) verifies once, the banner stays dismissed permanently. Cancellations on the recurring path still propagate through the GitHub Sponsors webhook → CF Worker → engine.

### Fixed (r22)
- **`engine.cjs` `_validEdgeEndpointsSql` edges:0 regression**: helper defaulted `edgeAlias` to `''`, producing bare `source`/`target` in EXISTS subqueries. Since the `nodes` table has its own `source` column (text: diary/knowledge/inbox), SQLite's subquery scoping resolved `source` to the inner `nodes.source` instead of the outer `edges.source` — making `EXISTS` always false and silently zeroing every edge-counting path (dashboard stats, `conn_count` writes, etc.). Default now `'edges'`; all five callsites use bare `FROM edges`, so the fix flows through.
- **ANCHOR_TOUCH pulse marker leaking into user-visible text**: `dashboard.js` `PULSE_MARKER_RE` plus two inline strip regexes and both `telegram.js` send-path replacers covered only `TASK_TOUCH|COGNITIVE_TOUCH|DEBRIEF`. ANCHOR_TOUCH (added later) now included in all five strip sites.
- **`logs/anamnesis-parse-failures/` unbounded growth**: parse-failure dumps now cap to the 50 most recent files; older entries unlink on write.

### Added
- First public OSS release scaffolding
- **Anamnesis auto-archive** (`session-debrief.js`): tasks with status `completed`/`expired`/`failed` that have sat ≥7 days move to `identity/tasks-archive.json`. Triple safety gate — status whitelist, parseable timestamp, 7-day dwell — `in_progress`/`pending`/`blocked`/`suspended`/`code-ready`/`code-done` are never touched. On archive write failure, all tasks remain in the active list.
- **Cognitive-state auto-roll** (`session-debrief.js`): when `identity/COGNITIVE_STATE.md` exceeds 64 KB, a full snapshot is appended to `cognitive-state-archive.md` and the active file is trimmed to H1 + the last ~32 KB.
- **Default `memory-hygiene` cron** at `0 4 * * *` ships ON: nightly star-map hygiene (supersedes / dormant / weak-edge / noise / fusion / stale / gardener) + system health check via `/api/doctor` + event-timeline detection + inbox review. Users can disable in the Dashboard Cron Editor.
- **Dashboard Tour Step 6** ("Cron Editor") now explains the default-on memory-hygiene cron and why to keep it enabled.

### Changed
- `LICENSE` now ships verbatim AGPL-3.0 text
- `CONTRIBUTING.md` rewritten to match the actual `npm` scripts and runtime layout
- Identity templates updated to drop stale provider/transport references

## [0.3.0] - 2026-05-04

Initial public preview. Subsequent releases will document changes here using the [Unreleased] section above; entries are promoted into a versioned section when a release is tagged.
