# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
