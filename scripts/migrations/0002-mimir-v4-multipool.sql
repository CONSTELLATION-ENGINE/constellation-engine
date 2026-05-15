-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002-mimir-v4-multipool.sql — Mímir Autonomy v4 substrate (Phase 0).
--
-- Plan: engine-output/architecture-research/2026-05-06-mimir-autonomy-v4-multipool-planning.md
--
-- Adds the two persisted columns the four-pool candidate generators
-- (Hot / Cold / Bridge / Novel) need on every nodes read, plus their indexes.
-- The matching trigger on diary_entries lives in scripts/mimir-js/diary.js
-- (_initSchema), because diary_entries is created lazily on first appendDiary
-- and may not exist when this migration runs.
--
--   nodes.fire_count  — per-node tally of "I was the picker's top_node".
--                       Bumped by the diary.js trigger on every fire_v3 row.
--                       Initialized 0; diary has historical truth so no
--                       back-fill is needed (Hot Pool tolerates a cold start).
--   nodes.zone_id     — Leiden community id. Persisted by zones.js after each
--                       refresh so Cold/Bridge/Novel pools can filter by zone
--                       without re-running modularity inline.

ALTER TABLE nodes ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN zone_id    INTEGER DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_nodes_fire_count ON nodes(fire_count) WHERE fire_count > 0;
CREATE INDEX IF NOT EXISTS idx_nodes_zone_id    ON nodes(zone_id)    WHERE zone_id IS NOT NULL;
