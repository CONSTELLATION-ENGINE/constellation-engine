// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir-JS Outreach Health Sweeps (OSS port of mimir-outreach-health.js).
//
//   runDemotionSweep    — flips persona_caps.direct_send_enabled back to 0
//                         when a (persona, platform, action) tuple's Critic
//                         reject rate exceeds threshold over the trailing 24h
//                         (with a minimum sample size to avoid noise).
//
//   runSourceDeleteSweep — HEAD-checks nodes.external_source_uri for live
//                          imported nodes; on 404/410 marks the node
//                          state='archived_external_deleted' so dead links
//                          stop fueling autonomy and stay visible to the user.
//
// Both are independent and can be invoked from a cron job (hourly cadence
// recommended). Either can be disabled via env without affecting the other.
//
// Schema dependency:
//   - `mimir_critic_log` table (created in engine.cjs _init)
//   - `persona_caps` table with `direct_send_enabled` column
//   - `nodes` table with `external_source_uri` column

const SOURCE_DELETE_BATCH    = parseInt(process.env.MIMIR_SOURCE_DELETE_BATCH || '20',    10);
const SOURCE_DELETE_TIMEOUT_MS = parseInt(process.env.MIMIR_SOURCE_DELETE_TIMEOUT_MS || '8000', 10);

const KILL_SOURCE_DELETE = String(process.env.MIMIR_SOURCE_DELETE_KILL || '').trim() === '1';

/**
 * runDemotionSweep — r20 Option B (OSS): the review-queue workflow was
 * removed and direct_send is permanently ON, so auto-demotion is now a no-op
 * stub. Kept for callers / cron schedules so removing it doesn't have to
 * cascade through main.js. Critic rejects still drop unsafe drafts at the gate.
 */
export function runDemotionSweep(_args = {}) {
  return { skipped: 'oss_direct_send_permanent', processed: 0, demoted: 0 };
}

/**
 * runSourceDeleteSweep — HEAD-checks nodes.external_source_uri for live
 * imported nodes. On 404/410, marks state='archived_external_deleted'.
 * Errors (DNS, timeout, 5xx) are LEFT untouched — only definitive deletions
 * trigger archive. The user retains manual reactivation rights.
 */
export async function runSourceDeleteSweep({ engine } = {}) {
  if (KILL_SOURCE_DELETE) return { skipped: 'kill_switch' };
  if (!engine?.db) return { skipped: 'engine_db_unavailable' };

  let nodes;
  try {
    nodes = engine.db.prepare(
      "SELECT id, external_source_uri FROM nodes " +
      "WHERE state = 'active' " +
      "AND external_source_uri IS NOT NULL " +
      "AND external_source_uri != '' " +
      "ORDER BY id LIMIT ?"
    ).all(SOURCE_DELETE_BATCH);
  } catch (e) {
    // OSS may not have external_source_uri column on older DBs — bail without error.
    return { skipped: 'nodes_query_failed', error: e.message?.slice(0, 80) };
  }
  if (!nodes.length) return { processed: 0, archived: 0 };

  const archiveStmt = engine.db.prepare(
    "UPDATE nodes SET state = 'archived_external_deleted' WHERE id = ? AND state = 'active'"
  );

  const archived = [];
  const errors = [];
  for (const n of nodes) {
    let url;
    try { url = new URL(n.external_source_uri); }
    catch { continue; } // skip malformed URLs (don't archive — could be a typo)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    let status;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), SOURCE_DELETE_TIMEOUT_MS);
      try {
        const resp = await fetch(url.href, {
          method: 'HEAD',
          redirect: 'follow',
          signal: ctrl.signal,
        });
        status = resp.status;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      errors.push({ id: n.id, error: (e.message || String(e)).slice(0, 80) });
      continue;
    }
    if (status === 404 || status === 410) {
      try {
        archiveStmt.run(n.id);
        archived.push({ id: n.id, status, uri: n.external_source_uri });
      } catch (e) {
        errors.push({ id: n.id, error: 'update_failed:' + e.message.slice(0, 80) });
      }
    }
  }

  return {
    processed: nodes.length,
    archived: archived.length,
    errors: errors.length,
    archived_nodes: archived,
    error_nodes: errors,
  };
}
