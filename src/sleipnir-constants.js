// SPDX-License-Identifier: AGPL-3.0-or-later
// Sleipnir — experiential anchor pattern v2 (2026-04-29)
// Plan: engine-output/architecture-research/2026-04-29-experiential-anchor-planning-v2.md
//
// Owner-id constants used by Sleipnir + cross-cutting code that needs to
// distinguish pinned anchors from sleipnir-derived nodes from regular content.

// Existing engine-wide owners (do not change — referenced across the codebase):
export const OWNER_SELF = 'self';                              // STAR_MAP_OWNER, all main-session content
export const OWNER_SELF_KNOWLEDGE = 'engine-self-knowledge';   // pinned 25 v1 anchors

// Sleipnir owners (new this commit):
export const OWNER_EXPERIENTIAL = 'engine-experiential';       // Sleipnir exploration_anchor + task_trail nodes

// Caller kinds (write-side gate)
export const CALLER_MAIN = 'main';
export const CALLER_CRON = 'cron';
export const CALLER_SUBAGENT = 'subagent';   // rejected by Sleipnir per user decision
export const CALLER_AUTONOMY = 'autonomy';   // Mímir SA tick — has its own self_act, also rejected
export const ALLOWED_CALLERS = new Set([CALLER_MAIN, CALLER_CRON]);

// Source kinds (whence the trail came)
export const SOURCE_CODE_GREP = 'code_grep';
export const SOURCE_CODE_READ = 'code_read';
export const SOURCE_WEB_FETCH = 'web_fetch';
export const SOURCE_READING = 'reading';
export const SOURCE_AUTONOMOUS = 'autonomous';

// Subtype (under subkind='exploration_anchor')
export const SUBTYPE_FACTUAL = 'factual';
export const SUBTYPE_NAVIGATIONAL = 'navigational';
export const SUBTYPE_CONCEPTUAL = 'conceptual';

// Subkinds
export const SUBKIND_EXPLORATION_ANCHOR = 'exploration_anchor';
export const SUBKIND_TASK_TRAIL = 'task_trail';
export const SUBKIND_ANCHOR = 'anchor';   // pinned manual anchors (existing)

// Capacity caps (v2 decisions)
export const TASK_TRAIL_CHUNK_BYTES = 16 * 1024;   // 16KB per chunk (typical agent turns 5-10KB)
export const TASK_TRAIL_TOTAL_BYTES = 64 * 1024;   // 64KB before head/tail elision
export const TASK_TRAIL_TTL_DAYS = 14;             // soft-delete after 14d
export const TASK_TRAIL_MILESTONE_TTL_DAYS = 90;   // milestone-tagged trails kept longer

export const PENDING_REVIEW_CAP = 200;             // FIFO cap

// Three-layer noise gate verdicts
export const GATE_SILENT_DROP = 'silent_drop';
export const GATE_TRAIL_ONLY = 'trail_only';
export const GATE_PROMOTE = 'promote';

// Boot-time prune thresholds (used by engine.cjs DDL block)
export const TRAIL_TTL_DAYS = 7;
export const TRAIL_PROMOTED_TTL_DAYS = 30;

// Workdir prefix preserved during PII R4 (per user decision)
export const WORKDIR_PREFIX = '$HOME/constellation-engine/';

// ─── Gate redesign 2026-04-29: salience + novelty hybrid ────────────────────
// Aggregator cluster threshold (was hardcoded 3, relaxed to 2 for immediacy)
export const TRAIL_GROUP_THRESHOLD = 2;

// Clause 2 (salience) — region promotes if a pool node mentions it AND its activation ≥ floor
export const SALIENCE_ACTIVATION_FLOOR = 0.3;
export const MIMIR_POOL_URL = 'http://127.0.0.1:18810/pool';
export const POOL_CACHE_MS = 5_000;
export const POOL_FETCH_TIMEOUT_MS = 1500;

// Clause 3 (novelty) — cold first-touch by main session
export const NOVELTY_THRESHOLD = 0.7;
export const NOVELTY_LOOKBACK_DAYS = 30;

// Verdict-aware cooldown — promote candidates respect a shorter window
export const COOLDOWN_PROMOTE_MS = 30 * 60_000;
export const COOLDOWN_DEFAULT_MS = 2 * 3600_000;
