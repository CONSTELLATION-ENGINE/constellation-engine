# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
