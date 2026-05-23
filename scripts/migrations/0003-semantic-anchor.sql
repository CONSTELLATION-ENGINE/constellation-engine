-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0003-semantic-anchor.sql — optional dense-retrieval embedding surface.
--
-- semantic_anchor lets broad, high-value nodes opt into a compact embedding-only
-- text surface without bloating their human-readable L0/L1/L2 envelope.
-- embedding_text_version is a lightweight invalidation marker for future
-- embedding-surface migrations.

ALTER TABLE nodes ADD COLUMN semantic_anchor TEXT;
ALTER TABLE nodes ADD COLUMN embedding_text_version INTEGER DEFAULT 1;

