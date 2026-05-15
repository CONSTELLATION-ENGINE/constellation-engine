// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module streaming-ir
 * @description Streaming IR v2 (Phase 2).
 *
 * Holds a per-session pool of dynamic slots that persist across turns. Each
 * update:
 *   1. refresh existing slots' A via EMA (α = emaAlpha) against the current pool
 *   2. evict slots missing ≥evictMissThreshold turns with A below evictAThreshold
 *   3. challenger-swap: if pool is full, a candidate whose raw A beats the weakest
 *      held slot's smoothed A by (1 + challengerMargin) displaces it
 *   4. promote remaining top-A candidates up to maxDynamic, skipping ids whose
 *      refractory cooldown has not expired
 *
 * Render order is first-seen-at ascending (stable for KV cache prefix reuse).
 * Anchors (permanent nodes) are passed through untouched — the daemon already
 * sorts and flags them, so state does not track them.
 *
 * See engine-output/architecture-research/2026-04-20-streaming-ir-v2-design.md.
 */

const DEFAULT_MAX_DYNAMIC = 15;
const DEFAULT_EVICT_MISS_THRESHOLD = 3;
const DEFAULT_EVICT_A_THRESHOLD = 0.15;
const DEFAULT_EMA_ALPHA = 0.3;
const DEFAULT_REFRACTORY_MS = 30000;
const DEFAULT_CHALLENGER_MARGIN = 0.10;
const MAX_SWAPS_PER_TURN = 3;

export class StreamingIRState {
  constructor(options = {}) {
    this.maxDynamic = options.maxDynamic ?? DEFAULT_MAX_DYNAMIC;
    this.evictMissThreshold = options.evictMissThreshold ?? DEFAULT_EVICT_MISS_THRESHOLD;
    this.evictAThreshold = options.evictAThreshold ?? DEFAULT_EVICT_A_THRESHOLD;
    this.emaAlpha = options.emaAlpha ?? DEFAULT_EMA_ALPHA;
    this.refractoryMs = options.refractoryMs ?? DEFAULT_REFRACTORY_MS;
    this.challengerMargin = options.challengerMargin ?? DEFAULT_CHALLENGER_MARGIN;

    /** @type {Array<{id: string, firstSeenAt: number, lastRefreshTurn: number, A: number, cachedNode: object}>} */
    this.dynamicSlots = [];
    /** @type {Map<string, number>} id → wall-clock ms until which the id is in refractory cooldown */
    this.cooldown = new Map();
    this.turnCounter = 0;
    this.lastPoolTick = null;
  }

  /**
   * Apply one update cycle from a fresh pool snapshot.
   *
   * @param {Array<object>} poolNodes - Pool response nodes (each has id, activation, permanent, ...)
   * @param {number} now - Wall-clock ms, used for firstSeenAt tie-break and cooldown expiry
   * @param {number|null} poolTick - Daemon tick counter; if it regresses, state resets
   * @returns {{orderedNodes: Array<object>, stats: object}}
   */
  update(poolNodes, now, poolTick = null) {
    // Daemon restart detection — tick regression wipes dynamic slots and
    // cooldowns. Anchors re-flow naturally from the current pool.
    if (this.lastPoolTick !== null && poolTick !== null && poolTick < this.lastPoolTick) {
      this.dynamicSlots = [];
      this.cooldown.clear();
    }
    this.lastPoolTick = poolTick;
    this.turnCounter += 1;

    // Purge expired cooldown entries so the map doesn't grow unbounded.
    for (const [id, expiry] of this.cooldown) {
      if (expiry <= now) this.cooldown.delete(id);
    }

    const perms = poolNodes.filter(n => n.permanent);
    const dyns = poolNodes.filter(n => !n.permanent);
    const dynById = new Map(dyns.map(n => [n.id, n]));

    // Step 1: refresh existing dynamic slots' A via EMA against current pool.
    // Missing nodes keep their smoothed A (no observation, no update).
    for (const slot of this.dynamicSlots) {
      const fresh = dynById.get(slot.id);
      if (fresh) {
        const freshA = fresh.activation ?? 0;
        slot.A = this.emaAlpha * freshA + (1 - this.emaAlpha) * slot.A;
        slot.cachedNode = fresh;
        slot.lastRefreshTurn = this.turnCounter;
      }
    }

    // Step 2: miss-based evict — slots that missed ≥threshold turns AND have
    // smoothed A below threshold. Track evicted ids for cooldown + stats.
    const survivors = [];
    const evictedIds = [];
    for (const slot of this.dynamicSlots) {
      const missed = this.turnCounter - slot.lastRefreshTurn;
      if (missed >= this.evictMissThreshold && slot.A < this.evictAThreshold) {
        evictedIds.push(slot.id);
        this.cooldown.set(slot.id, now + this.refractoryMs);
      } else {
        survivors.push(slot);
      }
    }
    this.dynamicSlots = survivors;

    // Build non-cooldown candidate list sorted by raw activation desc.
    // Refractory ids are excluded from promotion and challenger comparison.
    const heldIds = new Set(this.dynamicSlots.map(s => s.id));
    let candidates = dyns
      .filter(n => !heldIds.has(n.id) && !this.cooldown.has(n.id))
      .sort((a, b) => (b.activation ?? 0) - (a.activation ?? 0));

    // Step 3: challenger swap — when pool is full, let a strong candidate
    // displace the weakest held slot if it beats it by (1 + margin). Capped
    // at MAX_SWAPS_PER_TURN to damp thrashing on volatile pools.
    const swappedIds = [];
    let swapsThisTurn = 0;
    while (
      this.dynamicSlots.length >= this.maxDynamic
      && candidates.length > 0
      && swapsThisTurn < MAX_SWAPS_PER_TURN
    ) {
      let weakestIdx = 0;
      for (let i = 1; i < this.dynamicSlots.length; i++) {
        if (this.dynamicSlots[i].A < this.dynamicSlots[weakestIdx].A) weakestIdx = i;
      }
      const weakest = this.dynamicSlots[weakestIdx];
      const challenger = candidates[0];
      const challengerA = challenger.activation ?? 0;
      if (challengerA <= weakest.A * (1 + this.challengerMargin)) break;

      this.dynamicSlots.splice(weakestIdx, 1);
      this.cooldown.set(weakest.id, now + this.refractoryMs);
      swappedIds.push({ out: weakest.id, in: challenger.id });

      this.dynamicSlots.push({
        id: challenger.id,
        firstSeenAt: now,
        lastRefreshTurn: this.turnCounter,
        A: challengerA,
        cachedNode: challenger,
      });
      candidates = candidates.slice(1);
      swapsThisTurn++;
    }

    // Step 4: fill promotion — add top non-held, non-cooldown candidates until
    // maxDynamic is reached. New slots start with raw A (no EMA history).
    const promotedIds = [];
    for (const c of candidates) {
      if (this.dynamicSlots.length >= this.maxDynamic) break;
      this.dynamicSlots.push({
        id: c.id,
        firstSeenAt: now,
        lastRefreshTurn: this.turnCounter,
        A: c.activation ?? 0,
        cachedNode: c,
      });
      promotedIds.push(c.id);
    }

    // Step 5: render order — perms first (daemon-sorted), then dynamics in
    // first_seen_at ascending (KV cache friendly). Tie-break by id for
    // determinism when two slots share the same firstSeenAt tick.
    const orderedDyns = [...this.dynamicSlots]
      .sort((a, b) => (a.firstSeenAt - b.firstSeenAt) || a.id.localeCompare(b.id))
      .map(s => s.cachedNode);

    const orderedNodes = [...perms, ...orderedDyns];

    const stats = {
      turn: this.turnCounter,
      anchor_count: perms.length,
      dynamic_count: this.dynamicSlots.length,
      promoted: promotedIds.length,
      evicted: evictedIds.length,
      swapped: swappedIds.length,
      cooldown_size: this.cooldown.size,
      promoted_ids: promotedIds,
      evicted_ids: evictedIds,
      swapped_ids: swappedIds,
      churn_rate: this.dynamicSlots.length > 0
        ? (promotedIds.length + evictedIds.length + swappedIds.length) / this.dynamicSlots.length
        : 0,
    };

    return { orderedNodes, stats };
  }

  /** Hard reset — used on session teardown or daemon restart detection. */
  reset() {
    this.dynamicSlots = [];
    this.cooldown.clear();
    this.turnCounter = 0;
    this.lastPoolTick = null;
  }
}
