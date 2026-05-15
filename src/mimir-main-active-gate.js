// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir main-active gate. Shared suppression check for autonomy entrypoints.
//
// Rationale: when user is actively engaged with the main session, agent-
// initiated autonomy (free-mode reactor, curiosity_probe, outreach, external
// fetch) should yield. Service-layer paths (cron, anamnesis, consolidation,
// resolver, critic) are NOT gated — they're not agent-initiated.
//
// "Active" = the most recent founder-channel message is within `windowSec`.
// Filter is critical: must be channel='telegram' AND participant='founder',
// otherwise autonomy's own self-writes (channel='autonomous') count as
// activity and cause autonomy to self-suppress in a loop.
//
// Thresholds (user 2026-04-28):
//   free / curiosity_probe        → 600s   (10 min)
//   outreach / external_fetch     → 3600s  (1 h)
//
// Skip-this-tick semantics: callers should not requeue. Free-mode cadence is
// a cooldown timer (4h default); a skipped tick means the next eligible tick
// fires at the next cadence boundary. This matches the design intent (if work
// pauses for more than an hour, the system may want to spontaneously emit) —
// the gate is a yield, not a backlog.

import liveBus from './live-bus.cjs';

const SHORT_WINDOW_S = 600;   // free-mode reactor + curiosity_probe
const LONG_WINDOW_S  = 3600;  // outreach + external_fetch

const SHORT_KINDS = new Set(['free', 'curiosity_probe']);
const LONG_KINDS  = new Set(['outreach', 'external_fetch']);

function windowFor(subkind) {
  if (LONG_KINDS.has(subkind)) return LONG_WINDOW_S;
  if (SHORT_KINDS.has(subkind)) return SHORT_WINDOW_S;
  return SHORT_WINDOW_S; // safe default for unknown kinds
}

/**
 * @param {{convStore: object, subkind: string, now?: number, ownerId?: string}} args
 * @returns {{suppress: boolean, reason: string, threshold_s: number, age_s: number|null}}
 */
export function shouldSuppress({ convStore, subkind, now, ownerId }) {
  const threshold_s = windowFor(subkind);
  const nowMs = typeof now === 'number' ? now : Date.now();

  if (!convStore || typeof convStore.getLastFounderMsgAt !== 'function') {
    return { suppress: false, reason: 'no_conv_store', threshold_s, age_s: null };
  }

  const lastMs = convStore.getLastFounderMsgAt();
  if (!lastMs) {
    return { suppress: false, reason: 'no_founder_history', threshold_s, age_s: null };
  }

  const age_s = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  if (age_s < threshold_s) {
    try {
      liveBus.safeEmit('mimir.suppressed', {
        subkind,
        reason: 'main_active',
        age_s,
        threshold_s,
        ownerId: ownerId || null,
      });
    } catch { /* live bus is best-effort */ }
    return { suppress: true, reason: 'main_active', threshold_s, age_s };
  }

  return { suppress: false, reason: 'cleared', threshold_s, age_s };
}

export const _windows = { SHORT_WINDOW_S, LONG_WINDOW_S };
