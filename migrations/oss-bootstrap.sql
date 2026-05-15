-- SPDX-License-Identifier: AGPL-3.0-or-later
-- OSS Bootstrap — pre-stamp migrations the OSS schema.sql already covers.
--
-- Plan §5.2: fresh installs run the bootstrap, never the historical migration
-- chain. Our OSS-specific schema.sql bakes in every column/trigger/index that
-- main acquires via the numbered migrations, so we pre-stamp those migration
-- ids here. If a user later runs the migration scripts manually, they
-- INSERT OR IGNORE on these ids and skip cleanly.
--
-- This file is applied AFTER schema.sql (which creates the migrations table).

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

INSERT OR IGNORE INTO schema_version (version, description)
  VALUES (1, 'OSS bootstrap — bi-temporal + owner_id + event_at + edge evolution');

-- Pre-stamp migrations that the OSS schema.sql already covers.
INSERT OR IGNORE INTO migrations (id, applied_at) VALUES
  ('phase1a_bitemporal_v3',        datetime('now')),
  ('owner_id_v1',                  datetime('now')),
  ('edge_evolution_v1',            datetime('now')),
  ('event_at_v1',                  datetime('now')),
  ('subkind_v1',                   datetime('now'));
