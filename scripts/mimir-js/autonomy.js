// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Autonomy — picker context + curiosity-zone tick loop.
// Mirrors the Python daemon's actions-mode dispatch (see
// scripts/mimir/mimir_daemon.py). The v4 multipool picker is the only
// active path; the v3 single-SA-argmax picker was retired 2026-05-07.
//
// V5a perturbation layer (2026-05-08) wraps the v4 picker context build
// to break zone-stickiness rumination: zone-stickiness override (P1),
// hard recency bail-path (P4.2), and L0 noise injection (P5) sit between
// pool build and L0 fuse. Identifier surface (function names, env
// MIMIR_AUTONOMY_V4, picker_version: 'v4', source: 'mimir_autonomy_v4',
// prompts/mimir-autonomy-v4-picker.md) is preserved as cross-arch contract;
// V5 lives in per-mechanism env knobs.
//
// Single LLM call (Option B): zone fires → picker prompt assembled here →
// engine /api/mimir/wakeup spawns one agent session that picks ONE of
// {reflection, curation, tension, profile, fetch, library_fetch, outreach}
// and executes it inline with its tools.
//
// Default policy: kill-switch ON unless user opts in via /config or env.
// Even with the worker armed, a fire requires (1) curiosity_enabled=true,
// (2) at least one action enabled, (3) zone mean above CURIOSITY_THRESHOLD.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

import { getDb } from './db.js';
import { embed, EMBED_DIM } from './embed.js';
import { appendDiary, knnDiary } from './diary.js';
import * as zones from './zones.js';
import * as sa from './sa.js';
import {
  buildAllPools, getAutonomyPhase, getPresetWeights,
  buildColdPool, buildNovelPool,
} from './autonomy-pools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const KILL = String(process.env.MIMIR_AUTONOMY_V3_ENABLED || '1').trim() === '0';
// Steady-state threshold once the pool is warm. The cold-start path (active
// node count below COLD_NODE_LIMIT) drops to COLD_THRESHOLD so a fresh install
// isn't gated forever — without this, a sub-25-node pool can't push any zone's
// mean activation above 0.30 and v3 picker never fires. Cold-start bootstrap
// (engine.cjs Phase 9.5) handles seed-driven fetches independently; this
// dynamic threshold is what lets the *picker* engage during the
// gap between bootstrap exit (active≥25) and steady-state pool warm-up.
const CURIOSITY_THRESHOLD_STEADY = parseFloat(process.env.MIMIR_CURIOSITY_THRESHOLD || '0.30');
const CURIOSITY_THRESHOLD_COLD   = parseFloat(process.env.MIMIR_CURIOSITY_THRESHOLD_COLD || '0.05');
const COLD_NODE_LIMIT            = parseInt(process.env.MIMIR_CURIOSITY_COLD_NODE_LIMIT || '500', 10);
const CHECK_INTERVAL_MS = parseInt(process.env.MIMIR_CURIOSITY_CHECK_MS || '60000', 10);
const COOLDOWN_MS = parseInt(process.env.MIMIR_CURIOSITY_COOLDOWN_MS || '900000', 10); // 15 min
const FUSE_HARD = 0.80;
const FUSE_WARN = 0.65;
const CANONICAL = ['reflection', 'curation', 'tension', 'profile', 'fetch', 'library_fetch', 'outreach'];

// Mirror of src/mimir-action-worker.js FETCH_DEFAULT_ALLOWLIST. Both modules
// own their own copy because the worker reads process.env at fetch time while
// autonomy.js publishes the list to /config so the dashboard can pre-populate
// the textarea (otherwise users see an empty box and assume nothing is allowed).
// Keep these two lists in sync when adding domains.
const FETCH_DEFAULT_ALLOWLIST = Object.freeze([
  'arxiv.org', 'scholar.google.com', 'semanticscholar.org',
  'plos.org', 'nature.com',
  'en.wikipedia.org', 'wikivoyage.org', 'britannica.com',
  'merriam-webster.com', 'ourworldindata.org',
  'stanford.edu', 'mit.edu',
  'developer.mozilla.org', 'docs.python.org', 'github.com',
  'stackoverflow.com', 'hn.algolia.com', 'news.ycombinator.com',
  'nih.gov', 'nlm.nih.gov', 'who.int', 'cdc.gov', 'mayoclinic.org',
  'bbc.com', 'bbc.co.uk', 'npr.org', 'reuters.com',
  'theguardian.com',
  'imdb.com', 'rottentomatoes.com', 'goodreads.com',
  'letterboxd.com', 'allmusic.com',
  'reddit.com', 'old.reddit.com',
  'espn.com',
  'allrecipes.com', 'seriouseats.com',
  'lonelyplanet.com', 'openstreetmap.org',
]);

let _intervalHandle = null;
let _lastFireMs = 0;

// ─── /config-writable autonomy state ─────────────────────────────────────
// Mirrors Python state.autonomy_v3_enabled_actions + caps. Hot-reloadable
// via POST /config. Persistence policy (synced from main repo 2026-05-05):
//   - User-explicit opt-in (curiosityEnabled flipped via /config) sets
//     curiosityUserExplicit=true. Same for autoMode (future).
//   - Graceful shutdown writes clean_shutdown=true sentinel → next boot
//     resets curiosityEnabled to OFF (factory default; user made an
//     intentional stop decision).
//   - Crash exit (SIGKILL, watchdog, host kill) leaves no sentinel →
//     next boot RESTORES curiosityEnabled if curiosityUserExplicit=true
//     (the user opted in; don't silently revoke their choice).
//   - 3+ unclean exits in 30 minutes → crash-loop guard forces OFF.
const CONFIG_PATH = resolve(__dirname, 'mimir-config.json');
const UNCLEAN_EXIT_WINDOW_MS = 30 * 60 * 1000;
const UNCLEAN_EXIT_LIMIT = 3;

const _state = {
  enabledActions: new Set(),       // subset of CANONICAL
  // Plan A (2026-05-05): freeExploration is derived from enabledActions.has('fetch').
  // It used to be a separately writable flag, which created a double-layer gating
  // surface where the dashboard toggle alone wasn't enough to actually enable fetch.
  outreachKill: String(process.env.MIMIR_OUTREACH_KILL || '0') === '1',
  outreachDailyCap: parseInt(process.env.MIMIR_AUTONOMY_OUTREACH_CAP || '3', 10),
  fetchDailyCap: parseInt(process.env.MIMIR_AUTONOMY_FETCH_CAP || '5', 10),
  profileDailyCap: parseInt(process.env.MIMIR_AUTONOMY_PROFILE_CAP || '5', 10),
  // Per-domain allowlist for autonomous fetches. null = use FETCH_DEFAULT_ALLOWLIST
  // (worker side already falls back to this constant when env is unset, so the
  // dashboard textarea would render empty without seeding). Array = user override
  // (also mirrored to process.env.MIMIR_FETCH_DOMAIN_ALLOWLIST for the worker).
  fetchAllowlist: null,
  curiosityEnabled: false,         // master gate; default OFF (LLM-call safety)
  curiosityUserExplicit: false,    // tracks intentional opt-in for crash recovery
  // Silence outputs: mute Telegram + dashboard chat broadcasts on fire_v3 picks.
  // DB writes (diary, nodes, mimir_action lifecycle) still run so the
  // observation panels remain accurate. Crash-survives via *_user_explicit.
  silenceOutputs: false,
  silenceOutputsUserExplicit: false,
  // Quiet hours: outreach gate (matches main arch). When `now.hour` ∈
  // [quietStartHour, quietEndHour) in `quietTz`, outreach is suppressed
  // (other actions still fire). 0/0 = no quiet window. Wraparound supported
  // (e.g. start=22, end=6 → quiet from 22:00 to 06:00 next day).
  quietStartHour: parseInt(process.env.MIMIR_QUIET_START_HOUR || '0', 10),
  quietEndHour:   parseInt(process.env.MIMIR_QUIET_END_HOUR   || '0', 10),
  quietTz: process.env.MIMIR_QUIET_TZ || 'UTC',
  killSwitch: KILL,
  enginePort: parseInt(process.env.ENGINE_PORT || '17890', 10),
  // crash-loop tracking
  uncleanExitHistory: [],
  curiosityHeldOffByCrashLoop: false,
  // last-known zone vec stash for fire-event diary embedding
  _lastPickerZvec: null,
  // v4 pool weights: when null the picker uses the phase preset
  // (cold-start / warm-up / steady). When set, user has locked an override
  // via the dashboard sliders — preset buttons reset to null.
  v4PoolWeights: null,
  // V5a Phase 1 — zone-stickiness tracker. recentZones is a FIFO of the
  // last 50 (zone_id, top_node_id) tuples observed at fire-event time. The
  // picker reads the tail (K=2 if total<10 else K=3); if all share the
  // same non-NULL zone, the next pick gets a one-shot weight override that
  // suppresses hot. Kill-switch: MIMIR_V5_STICKINESS=0.
  _v5StickinessState: { recentZones: [], totalFires: 0 },
  _v5NextPickOverrideWeights: null,
  // V5a Phase 5 — last L0 noise candidate id (stashed at picker context build,
  // surfaced into the next fire_v3 diary write so observation panels can
  // count noise→fire success rate). Reset per pick.
  _lastV5NoiseCandidateId: null,
  // V5a Phase 2 — engagement feedback per zone, Laplace-smoothed.
  // explorationFeedback: zoneId -> { engaged, ignored } counts. The picker uses
  // (engaged+1)/(engaged+ignored+2) to bias zone selection toward zones the
  // user actually engages with (replies, links opened, etc.).
  explorationFeedback: new Map(),
  // V5a Phase 2 fuse-zone discount: when a zone fires but L0 fuse skips it
  // (recent-write redundancy), record a (factor, ticksRemaining) penalty that
  // multiplies into the engagement weight and decays linearly to 1.0 over
  // `ticksRemaining` reads. NEW Map (separate from explorationFeedback) so
  // record_exploration_feedback writes don't race the decay countdown.
  // Kill-switch: MIMIR_V5_FUSE_DISCOUNT=0 returns base weight unchanged.
  _v4ZoneFuseDecay: new Map(),
};

// ─── V5a Phase 2 — engagement weight + fuse-zone discount ─────────────────
// Laplace-smoothed engaged/ignored ratio with a recency-of-fuse linear decay.
// Returns a value in [0, 1] (or [factor, 1] when discounted).
export function getEngagementWeight(zoneId) {
  const fb = _state.explorationFeedback.get(zoneId);
  let base;
  if (!fb) {
    base = 0.5;  // neutral prior — no data: (0+1)/(0+0+2) = 0.5
  } else {
    const engaged = Number(fb.engaged || 0);
    const ignored = Number(fb.ignored || 0);
    base = (engaged + 1) / (engaged + ignored + 2);
  }
  if (String(process.env.MIMIR_V5_FUSE_DISCOUNT || '1').trim() === '0') return base;

  const decay = _state._v4ZoneFuseDecay;
  if (!decay) return base;
  const entry = decay.get(zoneId);
  if (!entry) return base;
  let factor, ticksRemaining, initialTicks;
  try {
    factor = Number(entry[0]);
    ticksRemaining = Number(entry[1]);
    // Backward compat: stale 2-element entries assume initial = remaining.
    initialTicks = entry.length >= 3 ? Number(entry[2]) : ticksRemaining;
  } catch {
    decay.delete(zoneId);
    return base;
  }
  if (!Number.isFinite(factor) || !Number.isFinite(ticksRemaining) || ticksRemaining <= 0) {
    decay.delete(zoneId);
    return base;
  }
  if (!Number.isFinite(initialTicks) || initialTicks < 1) initialTicks = 1;
  // Linear decay: at write (ticks=initialTicks) effective=factor; at ticks=0
  // it's 1.0. Denominator scales with the *original* decay_ticks so re-arming
  // with a different ticks value preserves the spec slope.
  let effective = 1.0 - (1.0 - factor) * (ticksRemaining / initialTicks);
  if (effective < factor) effective = factor;
  else if (effective > 1.0) effective = 1.0;

  const newRemaining = ticksRemaining - 1;
  if (newRemaining <= 0) decay.delete(zoneId);
  else decay.set(zoneId, [factor, newRemaining, initialTicks]);

  return base * effective;
}

// Record a fuse-zone engagement discount. Re-arm on repeated fuse hits —
// a fresh (factor, ticks, initial) overwrites any stale entry. Stored 3-tuple
// keeps the original decayTicks so the linear-decay slope scales with it.
export function _v5DiscountZone(zoneId, factor = 0.5, decayTicks = 20) {
  if (zoneId == null) return;
  const f = Number(factor);
  const t = Number(decayTicks);
  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= 0) return;
  if (!_state._v4ZoneFuseDecay) return;
  _state._v4ZoneFuseDecay.set(zoneId, [f, t, t]);
}

// External callers (telemetry / response handlers) update engagement counts
// when the user engages with or ignores a zone-driven action.
//   kind='engaged'  → engaged++
//   kind='ignored'  → ignored++
export function recordExplorationFeedback(zoneId, kind) {
  if (zoneId == null) return;
  const fb = _state.explorationFeedback.get(zoneId) || { engaged: 0, ignored: 0 };
  if (kind === 'engaged') fb.engaged = (fb.engaged | 0) + 1;
  else if (kind === 'ignored') fb.ignored = (fb.ignored | 0) + 1;
  else return;
  _state.explorationFeedback.set(zoneId, fb);
}

// ─── V5a Phase 1 — zone-stickiness detector ───────────────────────────────
// Examines the tail K of _state._v5StickinessState.recentZones. K is
// cold-start aware: K=2 if total_fires<10 else K=3. NULL zones are
// treated as non-sticky (no signal). Returns { sticky, lastZones }.
function _v5CheckStickiness() {
  try {
    const ss = _state._v5StickinessState;
    if (!ss || !Array.isArray(ss.recentZones) || ss.recentZones.length === 0) {
      return { sticky: false, lastZones: [] };
    }
    const total = Number(ss.totalFires || 0);
    const K = total < 10 ? 2 : 3;
    const tail = ss.recentZones.slice(-K);
    if (tail.length < K) return { sticky: false, lastZones: tail.map(t => t[0]) };
    const zones = tail.map(t => t[0]);
    if (zones.some(z => z == null)) return { sticky: false, lastZones: zones };
    const sticky = zones.every(z => z === zones[0]);
    return { sticky, lastZones: zones };
  } catch (_) {
    return { sticky: false, lastZones: [] };
  }
}

// ─── V5a Phase 5 — L0 noise injection ─────────────────────────────────────
// With prob MIMIR_V5_NOISE_PROB (default 0.05), prepend one underused
// candidate (cold ∪ novel pool builders, de-duplicated against the existing
// menu) to pools.candidates. Operates on the candidate menu (not on `A`)
// so lateral inhibition / decay can't erase it.
// Kill-switch: MIMIR_V5_NOISE=0 disables both injection and the diary log.
function _v5InjectNoiseIntoMenu(pools) {
  let prob = parseFloat(process.env.MIMIR_V5_NOISE_PROB || '0.05');
  if (!Number.isFinite(prob)) prob = 0.05;
  if (prob <= 0.0 || Math.random() > prob) return null;
  const existingIds = new Set();
  for (const c of (pools.candidates || [])) {
    if (c && c.id) existingIds.add(c.id);
  }
  let cold = [], novel = [];
  try { cold = buildColdPool({ K: 10 }) || []; } catch (_) {}
  try { novel = buildNovelPool({ K: 10 }) || []; } catch (_) {}
  const union = [...cold, ...novel].filter(c => c && c.id && !existingIds.has(c.id));
  if (!union.length) return null;
  const chosen = union[Math.floor(Math.random() * union.length)];
  const cands = [chosen, ...(pools.candidates || [])];
  pools.candidates = cands;
  const byPool = { ...(pools.by_pool || {}) };
  byPool[chosen.pool] = (byPool[chosen.pool] || 0) + 1;
  pools.by_pool = byPool;
  return chosen;
}

// ─── quiet-hours helper (outreach gate) ──────────────────────────────────
//
// Precedence:
//   1. If `db` + (ownerId, personaId, platform, action) all provided AND a
//      persona_caps row exists with a non-trivial quiet window, use it.
//   2. Else fall back to the global window from _state (env-seeded).
//
// A "non-trivial" quiet window has both quiet_start_hour and quiet_end_hour
// set (non-null) AND not equal. Equal/null = "no window for this tuple"; in
// that case we fall through to the global window so direct-send graduations
// don't silently lose the user's evening cutoff.
function _lookupPersonaCapQuiet(db, { ownerId, personaId, platform, action }) {
  if (!db || typeof db.prepare !== 'function') return null;
  if (!ownerId || !personaId || !platform || !action) return null;
  try {
    const row = db.prepare(`
      SELECT quiet_start_hour, quiet_end_hour, quiet_tz
      FROM persona_caps
      WHERE owner_id = ? AND persona_id = ? AND platform = ? AND action = ?
      LIMIT 1
    `).get(String(ownerId), String(personaId), String(platform), String(action));
    if (!row) return null;
    const s = row.quiet_start_hour;
    const e = row.quiet_end_hour;
    if (s == null || e == null) return null;
    const start = Number(s);
    const end   = Number(e);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
    return { start, end, tz: row.quiet_tz || 'UTC' };
  } catch {
    return null;
  }
}

function _isInWindow(start, end, tz) {
  let hour;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC',
      hour: 'numeric', hour12: false,
    });
    hour = parseInt(fmt.format(new Date()), 10);
  } catch {
    hour = new Date().getUTCHours();  // tz lookup failed → UTC fallback
  }
  if (!Number.isFinite(hour)) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;  // wraparound (e.g. 22→6)
}

export function isQuietHoursNow(opts = null) {
  // Per-cap path: if caller supplied a tuple AND a persona_caps row exists
  // with a non-trivial window, that window wins.
  if (opts && opts.db) {
    const cap = _lookupPersonaCapQuiet(opts.db, opts);
    if (cap) return _isInWindow(cap.start, cap.end, cap.tz);
  }
  // Global fallback.
  const start = _state.quietStartHour | 0;
  const end = _state.quietEndHour | 0;
  if (start === end) return false;  // 0/0 or any equal pair → no quiet window
  return _isInWindow(start, end, _state.quietTz || 'UTC');
}

// Mirror action-gate state into THIS process's env (parity with how
// MIMIR_AUTONOMY_SILENCE_OUTPUTS is handled at line 196/388). The
// mimir-action-worker.js in the engine process reads the same vars; that
// cross-process sync is handled by dashboard.js's /api/mimir/config
// proxy interceptor (response-driven) and src/main.js's boot-time
// /config fetch. This local mirror keeps the daemon's own env consistent
// for any future in-process consumer or spawned child.
function _mirrorActionEnv() {
  process.env.MIMIR_FREE_EXPLORATION = _state.enabledActions.has('fetch') ? '1' : '0';
  process.env.MIMIR_ACTIVE_OUTREACH = _state.enabledActions.has('outreach') ? '1' : '0';
}

// ─── persistence ─────────────────────────────────────────────────────────
function _readConfigFile() {
  if (!existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    console.warn('[mimir-js autonomy] config read failed:', e.message);
    return null;
  }
}

function _writeConfigFile(obj) {
  try {
    const tmp = CONFIG_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, 2));
    renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    console.warn('[mimir-js autonomy] config write failed:', e.message);
  }
}

export function loadAutonomyConfig() {
  const cfg = _readConfigFile();
  if (!cfg) return;

  const now = Date.now();
  const histIn = Array.isArray(cfg.unclean_exits) ? cfg.unclean_exits : [];
  const recent = histIn
    .filter(t => Number.isFinite(t) && (now - t) < UNCLEAN_EXIT_WINDOW_MS);

  const prevClean = Boolean(cfg.clean_shutdown);
  if (!prevClean) {
    recent.push(now);
    console.warn(
      `[mimir-js stability] Detected unclean prior exit (no clean_shutdown sentinel). ` +
      `Unclean exits in last ${Math.round(UNCLEAN_EXIT_WINDOW_MS/60000)}min: ${recent.length}`
    );
  } else {
    recent.length = 0;  // graceful prior shutdown — reset crash counter
  }
  _state.uncleanExitHistory = recent;
  const crashLoop = recent.length >= UNCLEAN_EXIT_LIMIT;

  _state.curiosityUserExplicit = Boolean(cfg.curiosity_user_explicit);
  _state.silenceOutputsUserExplicit = Boolean(cfg.autonomy_silence_outputs_user_explicit);

  // Silence-outputs follows the same crash-vs-graceful policy as curiosity.
  // Graceful prior shutdown → reset to OFF (factory default; user must re-toggle).
  // Crash exit + user_explicit → restore (the user opted in; don't silently revoke).
  if (prevClean) {
    _state.silenceOutputs = false;
    if (_state.silenceOutputsUserExplicit) {
      _state.silenceOutputsUserExplicit = false;
    }
  } else if (_state.silenceOutputsUserExplicit && Boolean(cfg.autonomy_silence_outputs)) {
    _state.silenceOutputs = true;
  }
  // Mirror to env so the worker (in engine process) reads the right value
  // without a /config POST. dashboard.js's worker-config push handles the
  // cross-process case after a /config write.
  process.env.MIMIR_AUTONOMY_SILENCE_OUTPUTS = _state.silenceOutputs ? '1' : '0';

  if (prevClean) {
    _state.curiosityEnabled = false;
    if (_state.curiosityUserExplicit) {
      console.log(
        '[mimir-js stability] Graceful prior shutdown — curiosity_enabled reset to OFF ' +
        '(was user-explicit; user must re-enable to resume).'
      );
      _state.curiosityUserExplicit = false;
    }
  } else if (crashLoop) {
    _state.curiosityEnabled = false;
    _state.curiosityHeldOffByCrashLoop = true;
    console.error(
      `[mimir-js stability] Crash-loop guard: ${recent.length} unclean exits in ` +
      `${Math.round(UNCLEAN_EXIT_WINDOW_MS/60000)}min — curiosity HELD OFF this boot ` +
      `despite user_explicit=${_state.curiosityUserExplicit}.`
    );
  } else if (_state.curiosityUserExplicit && Boolean(cfg.curiosity_enabled)) {
    _state.curiosityEnabled = true;
    console.warn(
      '[mimir-js stability] Restoring curiosity_enabled=true after unclean prior exit ' +
      '(user_explicit was set).'
    );
  }

  if (Array.isArray(cfg.v3_enabled_actions)) {
    const valid = new Set(CANONICAL);
    let restored = new Set(cfg.v3_enabled_actions.filter(a => valid.has(a)));
    // Plan A (2026-05-05): outbound actions (fetch, outreach) follow the
    // same crash-vs-graceful policy as curiosityEnabled — graceful prior
    // shutdown strips them so the user must explicitly re-arm outbound
    // behavior; crash + user_explicit restores them so a daemon respawn
    // doesn't silently revoke opt-in. Inbound actions only touch local
    // state and always restore.
    const stripOutbound = prevClean || crashLoop || !_state.curiosityUserExplicit;
    if (stripOutbound) {
      const dropped = ['fetch', 'outreach'].filter(a => restored.has(a));
      if (dropped.length) {
        for (const a of dropped) restored.delete(a);
        console.log(
          `[mimir-js stability] Stripped outbound v3 actions [${dropped.join(',')}] on boot ` +
          `(prev_clean=${prevClean}, crash_loop=${crashLoop}, user_explicit=${_state.curiosityUserExplicit}). ` +
          `User must re-toggle to re-arm outbound behavior.`
        );
      }
    }
    _state.enabledActions = restored;
  }
  if (Number.isFinite(cfg.v3_outreach_daily_cap)) _state.outreachDailyCap = cfg.v3_outreach_daily_cap;
  if (Number.isFinite(cfg.v3_fetch_daily_cap)) _state.fetchDailyCap = cfg.v3_fetch_daily_cap;
  if (Number.isFinite(cfg.v3_profile_daily_cap)) _state.profileDailyCap = cfg.v3_profile_daily_cap;
  // freeExploration removed — derived from enabledActions.has('fetch') on read.
  if (typeof cfg.autonomy_outreach_kill === 'boolean') _state.outreachKill = cfg.autonomy_outreach_kill;
  // Quiet hours (outreach gate). Always restore — they're user preferences,
  // not LLM-spending toggles, so the crash/graceful policy doesn't apply.
  if (Number.isFinite(cfg.quiet_start_hour)) _state.quietStartHour = cfg.quiet_start_hour | 0;
  if (Number.isFinite(cfg.quiet_end_hour))   _state.quietEndHour   = cfg.quiet_end_hour   | 0;
  if (typeof cfg.quiet_tz === 'string' && cfg.quiet_tz.trim()) _state.quietTz = cfg.quiet_tz.trim();
  // Fetch allowlist override (null = use FETCH_DEFAULT_ALLOWLIST).
  if (Array.isArray(cfg.fetch_allowlist)) {
    const parsed = cfg.fetch_allowlist.map(s => String(s).trim().toLowerCase()).filter(Boolean);
    if (parsed.length) {
      _state.fetchAllowlist = parsed;
      process.env.MIMIR_FETCH_DOMAIN_ALLOWLIST = parsed.join(',');
    }
  }
  // v4 pool weights override (null = follow phase preset). Stored as plain
  // {hot,cold,bridge,novel} ints; clamp on load defends against tampering.
  if (cfg.v4_pool_weights && typeof cfg.v4_pool_weights === 'object') {
    const w = cfg.v4_pool_weights;
    const clamp = v => Number.isFinite(v) ? Math.max(0, Math.min(20, Math.floor(v))) : null;
    const hot = clamp(w.hot), cold = clamp(w.cold), bridge = clamp(w.bridge), novel = clamp(w.novel);
    if (hot != null && cold != null && bridge != null && novel != null) {
      _state.v4PoolWeights = { hot, cold, bridge, novel };
    }
  }
  _mirrorActionEnv();
}

export function saveAutonomyConfig({ cleanShutdown = false } = {}) {
  // Plan A: autonomy_free_exploration is no longer a separate persisted flag;
  // it's derived from `enabledActions.has('fetch')` so the dashboard toggle
  // is the single source of truth.
  const cfg = {
    curiosity_enabled: _state.curiosityEnabled,
    curiosity_user_explicit: _state.curiosityUserExplicit,
    autonomy_silence_outputs: _state.silenceOutputs,
    autonomy_silence_outputs_user_explicit: _state.silenceOutputsUserExplicit,
    clean_shutdown: Boolean(cleanShutdown),
    unclean_exits: _state.uncleanExitHistory,
    v3_enabled_actions: [...CANONICAL].filter(a => _state.enabledActions.has(a)),
    v3_outreach_daily_cap: _state.outreachDailyCap,
    v3_fetch_daily_cap: _state.fetchDailyCap,
    v3_profile_daily_cap: _state.profileDailyCap,
    autonomy_outreach_kill: _state.outreachKill,
    quiet_start_hour: _state.quietStartHour,
    quiet_end_hour: _state.quietEndHour,
    quiet_tz: _state.quietTz,
    v4_pool_weights: _state.v4PoolWeights ? { ..._state.v4PoolWeights } : null,
    fetch_allowlist: Array.isArray(_state.fetchAllowlist) ? _state.fetchAllowlist.slice() : null,
  };
  _writeConfigFile(cfg);
}

export function getAutonomyState() {
  // Read v4 phase + gate inputs (best-effort; if the autonomy_pools module
  // hasn't loaded the DB yet, fall back to a static placeholder so the
  // dashboard's first poll doesn't error). The dashboard renders the gate
  // values + phase next to the pool sliders.
  let v4 = null;
  try {
    const info = getAutonomyPhase();
    const v4Enabled = String(process.env.MIMIR_AUTONOMY_V4 || '1').trim() !== '0';
    const effectiveWeights = _state.v4PoolWeights || getPresetWeights(info.phase);
    v4 = {
      enabled: v4Enabled,
      phase: info.phase,
      gates: info.gates,
      inputs: info.inputs,
      pool_weights: effectiveWeights,
      pool_weights_locked: !!_state.v4PoolWeights,
    };
  } catch { /* DB not ready — dashboard will fill in on later polls */ }

  return {
    autonomy_curiosity: _state.curiosityEnabled,
    autonomy_outreach: _state.enabledActions.has('outreach'),
    autonomy_external_fetch: _state.enabledActions.has('fetch') || _state.enabledActions.has('library_fetch'),
    autonomy_kill_switch: _state.killSwitch,
    autonomy_phase: _state.enabledActions.size === 0 ? 'A' : 'B',
    autonomy_v4: v4,
    v3_enabled_actions: [...CANONICAL].filter(a => _state.enabledActions.has(a)),
    v3_outreach_daily_cap: _state.outreachDailyCap,
    v3_fetch_daily_cap: _state.fetchDailyCap,
    v3_profile_daily_cap: _state.profileDailyCap,
    // Plan A: derived from enabledActions for back-compat with old dashboard reads.
    autonomy_free_exploration: _state.enabledActions.has('fetch'),
    autonomy_outreach_kill: _state.outreachKill,
    autonomy_silence_outputs: _state.silenceOutputs,
    fetch_allowlist: Array.isArray(_state.fetchAllowlist)
      ? _state.fetchAllowlist.slice()
      : [...FETCH_DEFAULT_ALLOWLIST],
    fetch_allowlist_is_default: !Array.isArray(_state.fetchAllowlist),
    quiet_start_hour: _state.quietStartHour,
    quiet_end_hour: _state.quietEndHour,
    quiet_tz: _state.quietTz,
    quiet_hours_now: isQuietHoursNow(),
    last_fire_ms: _lastFireMs,
    stability: {
      curiosity_user_explicit: _state.curiosityUserExplicit,
      curiosity_held_off_by_crash_loop: _state.curiosityHeldOffByCrashLoop,
      autonomy_silence_outputs_user_explicit: _state.silenceOutputsUserExplicit,
      recent_unclean_exits: _state.uncleanExitHistory.length,
    },
  };
}

export function applyConfigPatch(body) {
  const VALID = new Set(CANONICAL);
  const changed = [];

  if ('autonomy_kill_switch' in body && Boolean(body.autonomy_kill_switch)) {
    _state.enabledActions.clear();
    _state.curiosityEnabled = false;
    _state.killSwitch = true;
    changed.push('autonomy_kill_switch=engaged');
  }
  if ('curiosity_enabled' in body) {
    _state.curiosityEnabled = Boolean(body.curiosity_enabled);
    if (_state.curiosityEnabled) _state.killSwitch = false;
    // User-explicit opt-in tracking — see loadAutonomyConfig() for crash recovery.
    _state.curiosityUserExplicit = Boolean(body.curiosity_enabled);
    changed.push(`curiosity_enabled=${_state.curiosityEnabled}`);
  }
  if ('autonomy_enabled_modes' in body || 'v3_enabled_actions' in body) {
    const raw = body.autonomy_enabled_modes ?? body.v3_enabled_actions ?? [];
    let parsed;
    if (typeof raw === 'string') parsed = raw.split(',').map(s => s.trim()).filter(Boolean);
    else if (Array.isArray(raw)) parsed = raw.map(s => String(s).trim()).filter(Boolean);
    else parsed = [];
    const bad = parsed.filter(m => !VALID.has(m));
    if (bad.length) return { ok: false, error: `invalid modes: ${bad.join(',')}; valid: ${[...VALID].join(',')}` };
    _state.enabledActions = new Set(parsed);
    if (_state.enabledActions.size > 0) _state.killSwitch = false;
    changed.push(`autonomy_enabled_modes=${[...parsed].sort().join(',')}`);
  }
  if ('autonomy_mode_toggle' in body) {
    const tog = body.autonomy_mode_toggle;
    if (tog && typeof tog === 'object' && VALID.has(tog.mode)) {
      if (tog.on) _state.enabledActions.add(tog.mode);
      else _state.enabledActions.delete(tog.mode);
      changed.push(`autonomy_mode_toggle:${tog.mode}=${tog.on ? 'on' : 'off'}`);
    } else {
      return { ok: false, error: 'autonomy_mode_toggle requires {mode, on}' };
    }
  }
  // Plan A deprecation shim (2026-05-05): old endpoint kept for backwards-compat;
  // routes through the v3 enabled set so dashboard + state stay in lock-step.
  if ('autonomy_free_exploration' in body) {
    const on = Boolean(body.autonomy_free_exploration);
    if (on) _state.enabledActions.add('fetch');
    else _state.enabledActions.delete('fetch');
    console.warn(
      "[mimir-js deprecated] autonomy_free_exploration POST → " +
      "use autonomy_v3_action_toggle {action:'fetch', on}"
    );
    changed.push(`autonomy_free_exploration=${on} (deprecated→v3:fetch)`);
  }
  if ('autonomy_active_outreach' in body) {
    const on = Boolean(body.autonomy_active_outreach);
    if (on) _state.enabledActions.add('outreach');
    else _state.enabledActions.delete('outreach');
    console.warn(
      "[mimir-js deprecated] autonomy_active_outreach POST → " +
      "use autonomy_v3_action_toggle {action:'outreach', on}"
    );
    changed.push(`autonomy_active_outreach=${on} (deprecated→v3:outreach)`);
  }
  if ('autonomy_outreach_kill' in body) {
    _state.outreachKill = Boolean(body.autonomy_outreach_kill);
    changed.push(`autonomy_outreach_kill=${_state.outreachKill}`);
  }
  if ('autonomy_silence_outputs' in body) {
    _state.silenceOutputs = Boolean(body.autonomy_silence_outputs);
    _state.silenceOutputsUserExplicit = Boolean(body.autonomy_silence_outputs);
    process.env.MIMIR_AUTONOMY_SILENCE_OUTPUTS = _state.silenceOutputs ? '1' : '0';
    changed.push(`autonomy_silence_outputs=${_state.silenceOutputs}`);
  }
  if ('autonomy_v3_outreach_daily_cap' in body || 'v3_outreach_daily_cap' in body) {
    const n = parseInt(body.autonomy_v3_outreach_daily_cap ?? body.v3_outreach_daily_cap, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10000) {
      _state.outreachDailyCap = n;
      changed.push(`v3_outreach_daily_cap=${n}`);
    }
  }
  if ('autonomy_v3_fetch_daily_cap' in body || 'v3_fetch_daily_cap' in body) {
    const n = parseInt(body.autonomy_v3_fetch_daily_cap ?? body.v3_fetch_daily_cap, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10000) {
      _state.fetchDailyCap = n;
      changed.push(`v3_fetch_daily_cap=${n}`);
    }
  }
  if ('autonomy_v3_profile_daily_cap' in body || 'v3_profile_daily_cap' in body) {
    const n = parseInt(body.autonomy_v3_profile_daily_cap ?? body.v3_profile_daily_cap, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 10000) {
      _state.profileDailyCap = n;
      changed.push(`v3_profile_daily_cap=${n}`);
    }
  }
  if ('autonomy_fetch_allowlist' in body || 'fetch_allowlist' in body) {
    const raw = body.autonomy_fetch_allowlist ?? body.fetch_allowlist;
    let parsed;
    if (raw == null || (typeof raw === 'string' && !raw.trim())) {
      parsed = null;
    } else if (typeof raw === 'string') {
      parsed = raw.split(/[\n,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (Array.isArray(raw)) {
      parsed = raw.map(s => String(s).trim().toLowerCase()).filter(Boolean);
    } else {
      return { ok: false, error: 'fetch_allowlist must be array or newline/comma-separated string' };
    }
    if (parsed && parsed.length > 500) {
      return { ok: false, error: 'fetch_allowlist exceeds 500 domains' };
    }
    _state.fetchAllowlist = parsed && parsed.length ? parsed : null;
    if (_state.fetchAllowlist) {
      process.env.MIMIR_FETCH_DOMAIN_ALLOWLIST = _state.fetchAllowlist.join(',');
    } else {
      delete process.env.MIMIR_FETCH_DOMAIN_ALLOWLIST;
    }
    changed.push(`fetch_allowlist=${_state.fetchAllowlist ? `${_state.fetchAllowlist.length} domains` : 'default'}`);
  }
  // Quiet hours (outreach gate). Dashboard sends `autonomy_quiet_*` keys;
  // accept the shorter `quiet_*` aliases too for /config CLI parity.
  if ('autonomy_quiet_start_hour' in body || 'quiet_start_hour' in body) {
    const n = parseInt(body.autonomy_quiet_start_hour ?? body.quiet_start_hour, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      _state.quietStartHour = n;
      changed.push(`quiet_start_hour=${n}`);
    }
  }
  if ('autonomy_quiet_end_hour' in body || 'quiet_end_hour' in body) {
    const n = parseInt(body.autonomy_quiet_end_hour ?? body.quiet_end_hour, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 23) {
      _state.quietEndHour = n;
      changed.push(`quiet_end_hour=${n}`);
    }
  }
  if ('autonomy_quiet_tz' in body || 'quiet_tz' in body) {
    const tz = String(body.autonomy_quiet_tz ?? body.quiet_tz ?? '').trim();
    if (tz) {
      // Validate by attempting to construct a formatter. Bad tz throws.
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        _state.quietTz = tz;
        changed.push(`quiet_tz=${tz}`);
      } catch {
        return { ok: false, error: `invalid quiet_tz: ${tz}` };
      }
    }
  }
  // v4 pool weights override. Two write paths:
  //   - v4_pool_weights: {hot, cold, bridge, novel}     → user-locked override
  //   - v4_pool_weights_reset: true                     → clear override (use preset)
  // The dashboard's preset buttons (cold-start/warm-up/steady) send a reset
  // alongside the matching weights so the UI stays in sync; explicit slider
  // moves send `v4_pool_weights` only and lock the override.
  if (body.v4_pool_weights_reset === true) {
    _state.v4PoolWeights = null;
    changed.push('v4_pool_weights_reset');
  }
  if ('v4_pool_weights' in body && body.v4_pool_weights && typeof body.v4_pool_weights === 'object') {
    const w = body.v4_pool_weights;
    const clamp = v => {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.min(20, Math.floor(n)));
    };
    const hot = clamp(w.hot), cold = clamp(w.cold), bridge = clamp(w.bridge), novel = clamp(w.novel);
    if (hot == null || cold == null || bridge == null || novel == null) {
      return { ok: false, error: 'v4_pool_weights requires {hot, cold, bridge, novel} (ints 0..20)' };
    }
    if (hot + cold + bridge + novel === 0) {
      return { ok: false, error: 'v4_pool_weights all-zero would yield empty candidate menu' };
    }
    _state.v4PoolWeights = { hot, cold, bridge, novel };
    changed.push(`v4_pool_weights=${hot},${cold},${bridge},${novel}`);
  }
  _mirrorActionEnv();
  return { ok: true, changed };
}

// ─── curiosity check — find zone with highest mean activation ────────────
function _activeThreshold() {
  // Cold pool? Drop the bar so the picker can engage at all. saState.idx is
  // the canonical "active node count" the picker would consider — communities
  // alone undercount because un-zoned nodes still contribute pressure.
  try {
    const saState = sa.ensureState();
    const n = saState && saState.idx ? saState.idx.size : 0;
    if (n > 0 && n < COLD_NODE_LIMIT) return CURIOSITY_THRESHOLD_COLD;
  } catch { /* fall through to steady */ }
  return CURIOSITY_THRESHOLD_STEADY;
}

function checkCuriosity() {
  const saState = sa.ensureState();
  if (!saState) return null;
  const comms = zones.getCommunities();
  if (!comms || comms.length === 0) return null;

  const threshold = _activeThreshold();
  const allActive = [];

  for (let zid = 0; zid < comms.length; zid++) {
    const ids = comms[zid] || [];
    if (ids.length === 0) continue;
    let sum = 0, count = 0, topNode = '', topAct = 0;
    for (const nid of ids) {
      const idx = saState.idx.get(nid);
      if (idx == null) continue;
      const a = saState.A_fast[idx];
      if (!Number.isFinite(a) || a <= 0) continue;
      sum += a;
      count++;
      if (a > topAct) { topAct = a; topNode = nid; }
    }
    if (count === 0) continue;
    const mean = sum / count;
    if (mean >= threshold) {
      allActive.push({ zone: zid, mean, top_node: topNode, top_act: topAct });
    }
  }

  if (allActive.length === 0) return null;

  // V5a Phase 2 — bias zone selection by engagement weight (Laplace-smoothed
  // engaged/ignored ratio × fuse-zone discount). Zones the user has engaged
  // with rise; zones the picker recently fuse-skipped fall. Kill-switch via
  // MIMIR_V5_FUSE_DISCOUNT=0 (decay branch) — base prior still applies.
  for (const z of allActive) {
    z.engagement_weight = getEngagementWeight(z.zone);
    z.weighted_mean = z.mean * z.engagement_weight;
  }
  allActive.sort((a, b) => b.weighted_mean - a.weighted_mean);
  const top = allActive[0];
  return {
    top_zone: { zone: top.zone, mean: top.mean, top_node: top.top_node, top_act: top.top_act,
                engagement_weight: top.engagement_weight, weighted_mean: top.weighted_mean },
    all_active_zones: allActive,
    ticks_since_input: 0,
    threshold,
  };
}

// ─── L2 → cosine helper for normalized vec0 distances ────────────────────
function l2DistToCosine(d) { return 1.0 - (d * d) / 2.0; }

// ─── recent self_acts in last 7d for anti-repetition + cosine fuse ───────
function recentSelfActs(hoursBack = 168, limit = 100) {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    return db.prepare(`
      SELECT id, l0, l1, kind, COALESCE(event_at, created_at) AS ts
        FROM nodes
       WHERE node_type = 'self_act'
         AND COALESCE(event_at, created_at) >= ?
       ORDER BY COALESCE(event_at, created_at) DESC
       LIMIT ?
    `).all(cutoff, limit);
  } catch (e) {
    console.warn('[mimir-js autonomy] recent self_acts query failed:', e.message);
    return [];
  }
}

// ─── topology_gap, contradiction, cross_domain hint blocks ──────────────
function findLocalGaps(topNodeIds) {
  if (!topNodeIds || topNodeIds.length === 0) return [];
  try {
    const db = getDb();
    const placeholders = topNodeIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT source, target, strength FROM edges
       WHERE state='active' AND COALESCE(strength, 0.5) < 0.30
         AND (source IN (${placeholders}) OR target IN (${placeholders}))
       ORDER BY strength ASC LIMIT 5
    `).all(...topNodeIds, ...topNodeIds);
    return rows.map(r => `${r.source} ↔ ${r.target} (str=${(r.strength ?? 0).toFixed(2)})`);
  } catch { return []; }
}

function findContradictions(zoneNodeIds) {
  if (!zoneNodeIds || zoneNodeIds.length === 0) return [];
  try {
    const db = getDb();
    const NEG = ['contradicts', 'challenges', 'contrasts', 'supersedes'];
    const z = zoneNodeIds.slice(0, 50);
    const placeholders = z.map(() => '?').join(',');
    const negPlaceholders = NEG.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT source, target, strength, edge_type FROM edges
       WHERE state='active'
         AND edge_type IN (${negPlaceholders})
         AND source IN (${placeholders}) AND target IN (${placeholders})
       ORDER BY strength DESC LIMIT 5
    `).all(...NEG, ...z, ...z);
    return rows;
  } catch { return []; }
}

// ─── v4 picker context (multi-source candidate menu) ─────────────────────
// Plan: engine-output/architecture-research/2026-05-06-mimir-autonomy-v4-multipool-planning.md
//
// Hands the picker a candidate menu drawn from four pools (Hot/Cold/Bridge/
// Novel) per the current autonomy phase's preset weights, plus `candidate_id`
// in the output schema. Retains the L0 fuse, recent_self_acts,
// action_diversity_warning, topology hints, and contradiction/cross-domain
// blocks — valve hygiene that applies independently of candidate sourcing.
// (The earlier v3 single-SA-argmax picker was retired 2026-05-07.)

// Nodes that have been the picker's chosen candidate ≥3 times in 7d.
// Used as a soft anti-hyperfixation penalty in the v4 prompt (Phase 5
// strengthens this further; Phase 3 just surfaces the list).
function recentTopNodes7d(threshold = 3) {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const rows = db.prepare(
      "SELECT json_extract(meta, '$.top_node') AS node_id, COUNT(*) AS n " +
      "  FROM diary_entries " +
      " WHERE kind = 'fire_v3' AND ts >= ? " +
      "   AND json_extract(meta, '$.top_node') IS NOT NULL " +
      " GROUP BY node_id " +
      "HAVING n >= ? " +
      " ORDER BY n DESC LIMIT 20"
    ).all(cutoff, threshold);
    return rows.map(r => ({ id: r.node_id, count: Number(r.n) }));
  } catch { return []; }
}

export async function buildV4PickerContext(curiosity) {
  if (_state.killSwitch) return null;
  if (!_state.curiosityEnabled) return null;
  if (_state.enabledActions.size === 0) return null;

  const tplPath = resolve(__dirname, '..', '..', 'prompts', 'mimir-autonomy-v4-picker.md');
  if (!existsSync(tplPath)) {
    console.warn('[mimir-js autonomy] v4 picker template missing:', tplPath);
    return null;
  }
  let template;
  try { template = readFileSync(tplPath, 'utf8'); }
  catch (e) { console.warn('[mimir-js autonomy] v4 template read failed:', e.message); return null; }

  const topZone = curiosity.top_zone || {};
  const zoneId = topZone.zone ?? 'unknown';
  const zoneMean = topZone.mean || 0.0;
  const ticksSince = curiosity.ticks_since_input || 0;

  // ── Build the candidate menu from the four pools ──────────────────────
  let phaseInfo;
  try { phaseInfo = getAutonomyPhase(); }
  catch (e) {
    console.warn('[mimir-js autonomy] phase compute failed:', e.message);
    phaseInfo = { phase: 'warm-up', gates: {}, inputs: {} };
  }
  // V5a Phase 1.1/1.2 — zone-stickiness override. If the last K fired
  // zones all share the same non-NULL zone, flip pool weights to
  // {hot:0, cold:0.4, bridge:0.3, novel:0.3} for THIS pick to break out
  // of zone-stickiness loops. Override is consumed once and cleared
  // below so a subsequent non-sticky fire returns to baseline.
  // Kill-switch: MIMIR_V5_STICKINESS=0 disables detection.
  if (String(process.env.MIMIR_V5_STICKINESS || '1').trim() !== '0') {
    try {
      const { sticky, lastZones } = _v5CheckStickiness();
      if (sticky) {
        _state._v5NextPickOverrideWeights = { hot: 0, cold: 0.4, bridge: 0.3, novel: 0.3 };
        try {
          appendDiary({
            kind: 'v5_stickiness_override',
            text: `V5a L1: last ${lastZones.length} fires shared zone ${lastZones[0]}; flipping weights`,
            source: 'mimir_autonomy_v4',
            meta: {
              last_zones: lastZones,
              override_weights: _state._v5NextPickOverrideWeights,
              total_fires: Number(_state._v5StickinessState.totalFires || 0),
            },
          });
        } catch (_) {}
      }
    } catch (e) { /* best-effort */ }
  }
  // Resolution priority: override (consumed once) > user-locked weights
  // > phase preset. Override is cleared after read.
  let weights;
  if (_state._v5NextPickOverrideWeights != null) {
    weights = { ..._state._v5NextPickOverrideWeights };
    _state._v5NextPickOverrideWeights = null;
  } else {
    weights = _state.v4PoolWeights || getPresetWeights(phaseInfo.phase);
  }
  let pools;
  try { pools = buildAllPools({ weights }); }
  catch (e) {
    console.warn('[mimir-js autonomy] buildAllPools failed:', e.message);
    return null;
  }
  if (!pools.candidates.length) {
    console.log('[mimir-js autonomy v4] empty candidate menu — skipping fire (threshold OK but pools empty)');
    return null;
  }

  // ── Anti-hyperfixation list (last 7d ≥3 fires per node) ──────────────
  const recentTopNodes = recentTopNodes7d(3);
  const recentTopIds = new Set(recentTopNodes.map(n => n.id));

  // Hard recency filter. V5a Phase 4 (OSS posture per Decision 8.8): default
  // stays OFF on OSS for cold-start safety; users opt in via
  // MIMIR_V4_HARD_RECENCY_FILTER=1. V5a Phase 4.2 bail-path is wired in below
  // so opt-in users never silently fall through to a stale hot-dupe menu.
  const hardRecencyFilter = String(process.env.MIMIR_V4_HARD_RECENCY_FILTER || '0').trim() === '1';
  if (hardRecencyFilter && recentTopIds.size > 0 && pools.candidates.length > 0) {
    const before = pools.candidates.length;
    const filtered = pools.candidates.filter(c => !recentTopIds.has(c.id));
    if (filtered.length > 0) {
      pools.candidates = filtered;
      const yields = { hot: 0, cold: 0, bridge: 0, novel: 0 };
      for (const c of filtered) yields[c.pool] = (yields[c.pool] || 0) + 1;
      pools.by_pool = yields;
      console.log(`[mimir-js autonomy v4] V5a P4 hard recency filter: ${before}→${filtered.length} (dropped ${before - filtered.length} hyperfixated)`);
    } else {
      // V5a Phase 4.2 bail: prefer non-hot over hot dupes when filter empties menu.
      const nonHot = pools.candidates.filter(c => c.pool !== 'hot');
      if (nonHot.length > 0) {
        pools.candidates = nonHot;
        const yields = { hot: 0, cold: 0, bridge: 0, novel: 0 };
        for (const c of nonHot) yields[c.pool] = (yields[c.pool] || 0) + 1;
        pools.by_pool = yields;
        console.log(`[mimir-js autonomy v4] V5a P4.2 hard recency bail: ${before}→${nonHot.length} non-hot (dropped ${before - nonHot.length} hot dupes)`);
      } else {
        console.log(`[mimir-js autonomy v4] V5a P4.2 hard recency bail: no non-hot candidates; keeping all ${before} hot dupes`);
      }
    }
  }

  // ── V5a Phase 5: L0 noise injection ──────────────────────────────────
  // Reset per-call before deciding so prior call's id can't leak into
  // the next picker's fire-event meta on a no-op draw.
  _state._lastV5NoiseCandidateId = null;
  if (String(process.env.MIMIR_V5_NOISE || '1').trim() !== '0') {
    let noiseCand = null;
    try { noiseCand = _v5InjectNoiseIntoMenu(pools); }
    catch (e) { /* best-effort */ }
    if (noiseCand && noiseCand.id) {
      _state._lastV5NoiseCandidateId = noiseCand.id;
      try {
        appendDiary({
          kind: 'v5_noise',
          text: `V5a L0: injected noise candidate ${noiseCand.id} from ${noiseCand.pool} pool`,
          source: 'mimir_autonomy_v4',
          meta: { noise_candidate_id: noiseCand.id, source_pool: noiseCand.pool },
        });
      } catch (_) {}
    }
  }

  // ── L0 fuse uses the chosen-zone's hottest text (same as v3) ─────────
  const comms = zones.getCommunities();
  const zoneNodeIds = (comms[zoneId] || []).slice(0, 50);
  const saState = sa.ensureState();
  const withAct = [];
  if (saState) {
    for (const nid of zoneNodeIds) {
      const idx = saState.idx.get(nid);
      if (idx == null) continue;
      withAct.push([nid, saState.A_fast[idx]]);
    }
    withAct.sort((a, b) => b[1] - a[1]);
  }
  let zoneTopText = '';
  let nodeL0Map = new Map();
  try {
    if (withAct.length) {
      const ids = withAct.slice(0, 10).map(x => x[0]);
      const rows = getDb().prepare(`
        SELECT id, l0 FROM nodes WHERE id IN (${ids.map(() => '?').join(',')})
      `).all(...ids);
      for (const r of rows) nodeL0Map.set(r.id, r.l0 || '');
      let i = 0;
      for (const [nid] of withAct.slice(0, 10)) {
        const l0Raw = (nodeL0Map.get(nid) || '').trim().replace(/\n/g, ' ');
        if (i < 3 && l0Raw) zoneTopText += ' ' + l0Raw;
        i++;
      }
    }
  } catch (e) {
    console.warn('[mimir-js autonomy v4] zone snapshot failed:', e.message);
  }

  let fuseWarnBlock = '';
  let zvec = null;
  try {
    const ztext = zoneTopText.trim();
    if (ztext) {
      const vecs = await embed([ztext]);
      zvec = vecs[0];
      if (zvec && zvec.length === EMBED_DIM) {
        let simPairs = [];
        try {
          const hits = knnDiary(zvec, { k: 10, maxAgeHours: 168, kinds: ['fire_v3'] });
          for (const h of hits) {
            const dist = parseFloat(h.distance);
            if (!Number.isFinite(dist)) continue;
            const cos = l2DistToCosine(dist);
            simPairs.push([cos, `diary#${h.id}`, (h.text || '').slice(0, 140), h.kind || '']);
          }
        } catch { /* vec0 missing — fall back below */ }
        if (simPairs.length === 0) {
          const recentRowsLocal = recentSelfActs(168, 100);
          const texts = []; const meta = [];
          for (const r of recentRowsLocal) {
            const t = ((r.l0 || '') + ' ' + (r.l1 || '')).trim();
            if (t) { texts.push(t.slice(0, 512)); meta.push([r.id, r.l0 || '', r.kind || '']); }
          }
          if (texts.length) {
            const smat = await embed(texts);
            for (let i = 0; i < smat.length; i++) {
              let dot = 0;
              for (let j = 0; j < EMBED_DIM; j++) dot += smat[i][j] * zvec[j];
              simPairs.push([dot, meta[i][0], meta[i][1], meta[i][2]]);
            }
          }
        }
        simPairs.sort((a, b) => b[0] - a[0]);
        const maxSim = simPairs.length ? simPairs[0][0] : 0;
        if (maxSim >= FUSE_HARD) {
          console.log(`[mimir-js autonomy v4] L0 hard fuse: zone ${zoneId} cos=${maxSim.toFixed(3)} → ${simPairs[0][1]}; skip`);
          try {
            appendDiary({
              kind: 'skip_fuse',
              text: `L0 fuse skipped zone ${zoneId} (cos=${maxSim.toFixed(3)} → ${simPairs[0][1]})`,
              source: 'mimir_autonomy_v4',
              meta: { mode: 'actions', zone: zoneId, cosine: Math.round(maxSim * 1e4) / 1e4, matched: simPairs[0][1] },
            });
          } catch {}
          // Phase 2 — penalize this zone's next-tick engagement weight so
          // the picker rotates instead of re-firing the same fuse-bound zone.
          // Defaults are tuned for sparse user graphs (typically 50–500 nodes,
          // avg_degree ~5–15) where the picker has fewer alternatives — a
          // gentler discount avoids starving zones that lack semantic neighbors.
          // Knobs (env-overridable for tuning without code change):
          //   MIMIR_V5_FUSE_DISCOUNT_FACTOR (default 0.7)
          //   MIMIR_V5_FUSE_DISCOUNT_TICKS  (default 10)
          try {
            const _f = Number(process.env.MIMIR_V5_FUSE_DISCOUNT_FACTOR);
            const _t = Number(process.env.MIMIR_V5_FUSE_DISCOUNT_TICKS);
            const factor = Number.isFinite(_f) && _f > 0 ? _f : 0.7;
            const ticks = Number.isFinite(_t) && _t > 0 ? Math.floor(_t) : 10;
            _v5DiscountZone(zoneId, factor, ticks);
          } catch (_) {}
          return null;
        }
        if (maxSim >= FUSE_WARN) {
          const lines = ['### ⚠️ L0 dedup warning (zone topic overlaps recent self_acts)'];
          lines.push(`  - max cosine to last-7d self_act/diary: **${maxSim.toFixed(3)}** (warn-tier 0.65–0.80)`);
          lines.push('  - top similar prior writes:');
          for (let i = 0; i < Math.min(3, simPairs.length); i++) {
            const [s, sid, sl0, skind] = simPairs[i];
            const sshort = sl0.length > 100 ? sl0.slice(0, 100) + '…' : sl0;
            lines.push(`    - [${s.toFixed(3)}] ${sid} [${skind}] ${sshort}`);
          }
          lines.push('  - **Rule**: pick a materially different angle, target, or action — output blocked at cos>0.80 if too similar.');
          fuseWarnBlock = lines.join('\n');
        }
      }
    }
  } catch (e) {
    console.warn('[mimir-js autonomy v4] L0 fuse failed:', e.message);
  }
  _state._lastPickerZvec = zvec;

  // ── Recent self_acts (anti-repetition, top 3) ────────────────────────
  const recentRows = recentSelfActs(168, 100);
  const recentLines = [];
  for (const r of recentRows.slice(0, 3)) {
    const l0 = (r.l0 || '').trim().replace(/\n/g, ' ').slice(0, 120);
    recentLines.push(`  - ${r.id} [${r.kind || '?'}]${l0 ? ' — ' + l0 + (r.l0.length > 120 ? '…' : '') : ''}`);
  }
  const recentSelfActsBlock = recentLines.length ? recentLines.join('\n') : '  (no recent self_acts in last 24h)';

  // ── 24h action distribution + caps ───────────────────────────────────
  const outreach24h = recentRows.filter(r => r.kind === 'outreach').length;
  const fetch24h = recentRows.filter(r => r.kind === 'fetch' || r.kind === 'library_fetch').length;
  const profile24h = recentRows.filter(r => r.kind === 'profile').length;

  // ── action_diversity_warning (mirrors v3 logic) ──────────────────────
  let diversityWarningBlock = '';
  let actionDistribution24h = [];
  if (process.env.MIMIR_DIVERSITY_DISABLE !== '1') {
    try {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const cut24h = now - 24 * 3600;
      const cut7d = now - 7 * 86400;
      const rows24h = db.prepare(
        "SELECT json_extract(meta, '$.chosen_action') AS act, COUNT(*) AS n " +
        "  FROM diary_entries " +
        " WHERE kind = 'fire_v3' AND ts >= ? " +
        "   AND json_extract(meta, '$.chosen_action') IS NOT NULL " +
        " GROUP BY act ORDER BY n DESC"
      ).all(cut24h);
      const rows7d = db.prepare(
        "SELECT json_extract(meta, '$.chosen_action') AS act, COUNT(*) AS n " +
        "  FROM diary_entries " +
        " WHERE kind = 'fire_v3' AND ts >= ? " +
        "   AND json_extract(meta, '$.chosen_action') IS NOT NULL " +
        " GROUP BY act"
      ).all(cut7d);
      const total24h = rows24h.reduce((s, r) => s + Number(r.n), 0);
      actionDistribution24h = rows24h.map(r => ({ action: r.act, n: Number(r.n) }));
      const seen7d = new Map(rows7d.filter(r => r.act).map(r => [r.act, Number(r.n)]));
      const enabledForCheck = CANONICAL.filter(a => _state.enabledActions.has(a));
      if (total24h >= 3 && rows24h.length > 0) {
        const topAct = rows24h[0].act || '';
        const topN = Number(rows24h[0].n);
        const topShare = total24h > 0 ? topN / total24h : 0;
        const dominanceTriggered = !!topAct && topShare >= 0.60;
        const starved = enabledForCheck.filter(a => a !== 'skip' && (seen7d.get(a) || 0) === 0);
        if (dominanceTriggered || starved.length > 0) {
          const distParts = rows24h.map(r => {
            const a = r.act || '(unknown)';
            const n = Number(r.n);
            const pct = Math.round(100 * n / total24h);
            return `${a}: ${n} (${pct}%)`;
          });
          const lines = ['\n### action_diversity_warning'];
          lines.push(`  - last 24h autonomy fires (n=${total24h}): ${distParts.join(', ')}`);
          if (dominanceTriggered) {
            const sharePct = Math.round(topShare * 100);
            lines.push(
              `  - **\`${topAct}\` is dominating (${sharePct}% of 24h)** — ` +
              `prefer a different enabled action this turn unless this candidate ` +
              `surfaces a NEW signal that prior \`${topAct}\` self_acts have not covered.`
            );
          }
          if (starved.length) {
            lines.push(
              `  - **Starved actions (0 fires in last 7d)**: ${starved.join(', ')}. ` +
              `If any candidate supports one of them, prefer it.`
            );
          }
          diversityWarningBlock = lines.join('\n') + '\n';
        }
      }
    } catch (e) {
      console.warn('[mimir-js autonomy v4] diversity warning query failed:', e.message);
    }
  }

  // ── Topology / contradiction / cross-domain hints (zone-scoped) ──────
  const inQuietHours = isQuietHoursNow();
  const enabledList = CANONICAL
    .filter(a => _state.enabledActions.has(a))
    .filter(a => !(a === 'outreach' && inQuietHours));
  const topNodeIds = withAct.slice(0, 3).map(x => x[0]);
  const topologyGaps = findLocalGaps(topNodeIds);
  const contradictions = findContradictions(zoneNodeIds);
  const allZones = (curiosity.all_active_zones || []).filter(z => z.zone !== zoneId).slice(0, 3);

  let topologyBlock = '';
  if (topologyGaps.length) {
    const lines = ['### topology_gap_hint (weak edges from zone tops, str<0.3)'];
    for (const g of topologyGaps) lines.push(`  - ${g}`);
    lines.push('  - **Hint**: a `curation` action could sharpen these or add a missing link.');
    topologyBlock = '\n' + lines.join('\n') + '\n';
  }
  let contradictionBlock = '';
  if (contradictions.length) {
    const lines = ['### contradiction_hint (negative-type edges within zone)'];
    for (const r of contradictions) {
      const sl0 = (nodeL0Map.get(r.source) || '').slice(0, 60);
      const tl0 = (nodeL0Map.get(r.target) || '').slice(0, 60);
      lines.push(`  - [${r.edge_type}] ${r.source} ⊣ ${r.target} (str=${(r.strength ?? 0).toFixed(2)}): ${sl0} vs. ${tl0}`);
    }
    lines.push('  - **Hint**: a `tension` action could synthesize the conflict explicitly.');
    contradictionBlock = '\n' + lines.join('\n') + '\n';
  }
  let crossDomainBlock = '';
  if (allZones.length) {
    const lines = ['### cross_domain_hint (other zones warm at the same tick)'];
    for (const z of allZones) {
      const tl0 = (nodeL0Map.get(z.top_node) || '').slice(0, 80);
      lines.push(`  - Zone ${z.zone} (mean=${(z.mean || 0).toFixed(3)}, top: ${z.top_node || '?'} — ${tl0})`);
    }
    lines.push('  - **Hint**: a `reflection` synthesizing the cross-zone pattern, or `curation` adding bridge edges.');
    crossDomainBlock = '\n' + lines.join('\n') + '\n';
  }

  // ── Render the candidate menu (compact JSON, one per line for legibility)
  const candidateLines = pools.candidates.map(c => {
    const safeL0 = (c.l0 || '').replace(/\n/g, ' ').slice(0, 140);
    return JSON.stringify({
      id: c.id,
      l0: safeL0,
      pool: c.pool,
      fire_count: c.fire_count,
      age_days: c.age_days == null ? null : Math.round(c.age_days * 10) / 10,
      zone_id: c.zone_id,
      edge_density: c.edge_density,
      activation: c.activation == null ? null : Math.round(c.activation * 1e3) / 1e3,
    });
  });
  const candidateBlock = '[\n  ' + candidateLines.join(',\n  ') + '\n]';

  const recentTopBlock = recentTopNodes.length
    ? recentTopNodes.map(n => `  - ${n.id} (chosen ${n.count}× in 7d)`).join('\n')
    : '  (no node chosen ≥3× in last 7d)';

  const distLine = actionDistribution24h.length
    ? actionDistribution24h.map(d => `${d.action}: ${d.n}`).join(', ')
    : '(no fires in last 24h)';

  const contextBlock = (
    `\n\n---\n## Runtime context (filled by daemon)\n\n` +
    `- **trigger_zone**: \`${zoneId}\`\n` +
    `- **zone_mean**: \`${zoneMean.toFixed(4)}\`\n` +
    `- **ticks_since_input**: \`${ticksSince}\`\n` +
    `- **autonomy_phase**: \`${phaseInfo.phase}\`\n` +
    `- **pool_weights**: \`${JSON.stringify(weights)}\`\n` +
    `- **pool_yields**: \`${JSON.stringify(pools.by_pool)}\` (after dedup, total=${pools.candidates.length})\n` +
    `- **enabled_actions**: \`${JSON.stringify(enabledList)}\` (only pick from this list)\n` +
    `- **outreach_daily_cap**: \`${_state.outreachDailyCap}\` (used in 24h: ${outreach24h})\n` +
    `- **fetch_daily_cap**: \`${_state.fetchDailyCap}\` (used in 24h: ${fetch24h})\n` +
    `- **profile_daily_cap**: \`${_state.profileDailyCap}\` (used in 24h: ${profile24h})\n\n` +
    `### candidates\n\`\`\`json\n${candidateBlock}\n\`\`\`\n\n` +
    `### recent_top_nodes_7d (anti-hyperfixation: avoid these as candidate_id unless new angle)\n${recentTopBlock}\n\n` +
    `### action_distribution_observed (24h)\n  - ${distLine}\n\n` +
    `### recent_self_acts (last 24h, for anti-repetition)\n${recentSelfActsBlock}\n` +
    topologyBlock + contradictionBlock + crossDomainBlock + diversityWarningBlock +
    (fuseWarnBlock ? '\n' + fuseWarnBlock + '\n' : '')
  );

  const execBlock = (
    `\n\n---\n## Execution (act inline with your tools)\n\n` +
    `After choosing the candidate + action, you MUST execute in the SAME session. ` +
    `Total wall-clock for this wakeup is capped at 120s.\n\n` +
    `- **\`reflection\`** / **\`curation\`** / **\`tension\`** / **\`profile\`** → call ` +
    `\`constellation_remember\` once with the synthesized text as \`text\`, ` +
    `\`source: 'mimir_autonomy_v4'\`, \`tags\` including the action name.\n` +
    `- **\`fetch\`** → only if \`fetch\` ∈ enabled_actions: use \`web_fetch\` on an allowlisted URL, ` +
    `then \`constellation_remember\` the digest.\n` +
    `- **\`library_fetch\`** → call the \`library_fetch\` tool with the relative path; then \`constellation_remember\` a digest.\n` +
    `- **\`outreach\`** → send the question via Telegram (subject to outreach_daily_cap + quiet hours).\n` +
    `- **\`skip\`** → emit JSON and return.\n\n` +
    `**Output**: emit the JSON object first (single block, no fences) so the daemon can log your choice, ` +
    `THEN execute and return a brief confirmation line.\n`
  );

  // Stash so _curiosityTick can include the picker's pool/candidate metadata
  // in the fire_v3 diary write (Phase 6 telemetry; pool field is already used).
  _state._lastV4Pools = pools;
  _state._lastV4Phase = phaseInfo.phase;

  return template + contextBlock + execBlock;
}

// ─── tick loop ───────────────────────────────────────────────────────────
// Periodic no-fire diagnostic (every ~10 ticks ≈ 10min by default). Lets us
// triage "why isn't the picker firing" without forcing per-tick logs.
let _diagnosticTickCounter = 0;
async function _curiosityTick() {
  if (_state.killSwitch || !_state.curiosityEnabled) return;
  if (_state.enabledActions.size === 0) return;
  const now = Date.now();
  if (now - _lastFireMs < COOLDOWN_MS) return;

  const curiosity = checkCuriosity();
  if (!curiosity) {
    _diagnosticTickCounter += 1;
    if (_diagnosticTickCounter % 10 === 0) {
      let nActive = 0;
      try { nActive = sa.ensureState()?.idx?.size || 0; } catch {}
      console.log(
        `[mimir-js autonomy] no-fire tick: threshold=${_activeThreshold().toFixed(3)} ` +
        `(n_active=${nActive}, cold_limit=${COLD_NODE_LIMIT}); ` +
        `reason=zone_mean_below_threshold or no_zones`
      );
    }
    return;
  }
  _diagnosticTickCounter = 0;

  // v4 multipool is the only picker (the v3 single-SA-argmax path was
  // retired 2026-05-07). Env kill switch MIMIR_AUTONOMY_V4=0 disables
  // curiosity firing entirely; there is no fallback.
  if (String(process.env.MIMIR_AUTONOMY_V4 || '1').trim() === '0') return;
  const pickerVersion = 'v4';
  let prompt;
  try {
    prompt = await buildV4PickerContext(curiosity);
  } catch (e) {
    console.warn('[mimir-js autonomy] v4 picker build failed:', e.message);
    return;
  }
  if (!prompt) return;

  const sessionId = `curiosity-${Math.floor(Date.now() / 1000)}`;

  // ── Hybrid A+C: Pre-picker decision via forced tool_choice ──
  // 2026-05-11 refactor. MIMIR_PICKER_TOOL_CHOICE=ON (default) → POST
  // picker prompt to engine /api/mimir/picker which forces Anthropic
  // select_action tool_call. chosen_action is guaranteed structured,
  // stamped on fire_v3 IMMEDIATELY. OFF → legacy wakeup-as-decider path.
  const tcEnabled = String(process.env.MIMIR_PICKER_TOOL_CHOICE || '1').trim() !== '0';
  const perActionEnabled = String(process.env.MIMIR_AUTONOMY_PER_ACTION_ENDPOINTS || '1').trim() !== '0';
  let pickerObj = null;
  if (tcEnabled) {
    try {
      pickerObj = await _resolvePickerActionViaToolCall(
        prompt, sessionId,
        process.env.MIMIR_PICKER_MODEL || 'claude-sonnet-4',
      );
    } catch (e) {
      console.warn('[mimir-js autonomy] picker pre-call exception:', e.message);
      pickerObj = null;
    }
  }

  // Dispatch routing — peer-review §11-F3:
  //   curation/tension/profile → /api/autonomy/curation
  //   fetch/library_fetch       → /api/autonomy/fetch
  //   outreach.*                → /api/autonomy/outreach
  //   reflection                → /api/mimir/wakeup w/ pre_picked_action
  //   skip                      → diary log + no dispatch
  //   None / picker off         → legacy wakeup with raw prompt
  let dispatchUrl = null;
  let dispatchBody = null;
  if (pickerObj && perActionEnabled) {
    const act = (pickerObj.action || '').trim();
    const common = {
      session_id: sessionId,
      action: act,
      candidate_id: pickerObj.candidate_id || null,
      rationale: pickerObj.rationale || '',
      payload: pickerObj.payload || {},
      chain_after: pickerObj.chain_after || null,
      original_message: prompt.slice(0, 500),
    };
    if (act === 'curation' || act === 'tension' || act === 'profile') {
      dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/autonomy/curation`;
      dispatchBody = common;
    } else if (act === 'fetch' || act === 'library_fetch') {
      dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/autonomy/fetch`;
      dispatchBody = common;
    } else if (act.startsWith('outreach.')) {
      dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/autonomy/outreach`;
      dispatchBody = common;
    } else if (act === 'reflection') {
      dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/mimir/wakeup`;
      dispatchBody = {
        session_id: sessionId,
        source: 'mimir_curiosity',
        role: 'primary',
        pre_picked_action: {
          action: act,
          candidate_id: pickerObj.candidate_id || null,
          rationale: pickerObj.rationale || '',
          payload: pickerObj.payload || {},
          chain_after: pickerObj.chain_after || null,
        },
        original_message: prompt.slice(0, 500),
      };
    } else if (act === 'skip') {
      try {
        appendDiary({
          kind: 'skip_picker_result',
          text: `Picker chose skip (rationale: ${(pickerObj.rationale || '').slice(0, 200)})`,
          source: 'mimir_autonomy_v4',
          sessionId,
          meta: {
            mode: 'actions',
            zone: curiosity.top_zone.zone,
            chosen_action: 'skip',
            chosen_action_source: pickerObj.source || 'tool_call',
          },
        });
      } catch (_) { /* best-effort */ }
      dispatchUrl = null;  // skip wakeup; still write fire_v3 below
    } else {
      console.warn(`[mimir-js autonomy] unknown picker action '${act}', falling through to legacy wakeup`);
      dispatchUrl = null;
    }
  }
  if (pickerObj && !perActionEnabled && pickerObj.action !== 'skip') {
    // Kill-switch combo: PICKER=ON + PER_ACTION=OFF → all actions (except
    // skip) route through wakeup with pre_picked_action (decision works,
    // execution stays on wakeup).
    dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/mimir/wakeup`;
    dispatchBody = {
      session_id: sessionId,
      source: 'mimir_curiosity',
      role: 'primary',
      pre_picked_action: {
        action: pickerObj.action,
        candidate_id: pickerObj.candidate_id || null,
        rationale: pickerObj.rationale || '',
        payload: pickerObj.payload || {},
        chain_after: pickerObj.chain_after || null,
      },
      original_message: prompt.slice(0, 500),
    };
  } else if (pickerObj && !perActionEnabled && pickerObj.action === 'skip') {
    // PICKER=ON + PER_ACTION=OFF + skip → diary log + no dispatch (consistent
    // with the (ON, ON) skip branch above).
    try {
      appendDiary({
        kind: 'skip_picker_result',
        text: `Picker chose skip (rationale: ${(pickerObj.rationale || '').slice(0, 200)})`,
        source: 'mimir_autonomy_v4',
        sessionId,
        meta: {
          mode: 'actions',
          zone: curiosity.top_zone.zone,
          chosen_action: 'skip',
          chosen_action_source: pickerObj.source || 'tool_call',
        },
      });
    } catch (_) { /* best-effort */ }
    dispatchUrl = null;
  }
  if (dispatchUrl === null && !(pickerObj && pickerObj.action === 'skip')) {
    dispatchUrl = `http://127.0.0.1:${_state.enginePort}/api/mimir/wakeup`;
    dispatchBody = {
      prompt,
      session_id: sessionId,
      source: 'mimir_curiosity',
      role: 'primary',  // tier-aware: engine resolver picks user's primary model
    };
  }

  // P38c: log the dispatch decision before the fetch so OSS users can see the
  // wake_llm event in real time (the post-success log on line ~1461 fires
  // *after* the engine endpoint returns — too late for cold-debug).
  {
    const dispatchAction = (pickerObj && pickerObj.action) || 'legacy_prompt';
    console.log(`[mimir-js autonomy] wake_llm: dispatching ${dispatchAction} → ${dispatchUrl || 'skip'} (session ${sessionId})`);
  }

  try {
    let data = null;
    if (dispatchUrl !== null) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(dispatchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dispatchBody),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      data = await res.json().catch(() => ({}));
    } else {
      // Skip path — synthesize ok response so fire_v3 still writes
      data = { ok: true, session_id: sessionId, started: false };
    }
    if (data && data.ok) {
      _lastFireMs = now;
      console.log(`[mimir-js autonomy] curiosity session ${sessionId} started (zone ${curiosity.top_zone.zone}, mean=${curiosity.top_zone.mean.toFixed(3)}, dispatch=${dispatchUrl || 'skip'})`);
      try {
        const meta = {
          mode: 'actions',
          zone: curiosity.top_zone.zone,
          zone_mean: curiosity.top_zone.mean,
          top_node: curiosity.top_zone.top_node,
          enabled_actions: [...CANONICAL].filter(a => _state.enabledActions.has(a)),
          picker_version: pickerVersion,
          autonomy_phase: _state._lastV4Phase || null,
          pool_yields: _state._lastV4Pools?.by_pool || null,
          pool_weights: _state._lastV4Pools?.weights || null,
        };
        // Hybrid A+C: stamp chosen_action / source / candidate_id BEFORE
        // diary append — no session_end race.
        if (pickerObj) {
          if (typeof pickerObj.action === 'string' && pickerObj.action) {
            meta.chosen_action = pickerObj.action.slice(0, 32);
          }
          if (typeof pickerObj.source === 'string' && pickerObj.source) {
            meta.chosen_action_source = pickerObj.source;
          }
          if (typeof pickerObj.candidate_id === 'string' && pickerObj.candidate_id) {
            meta.candidate_id = pickerObj.candidate_id.slice(0, 128);
          }
        }
        // Stash candidate_id → pool mapping so /session_end can resolve the
        // chosen candidate's pool without re-running the pool builders.
        const cands = _state._lastV4Pools?.candidates || [];
        if (cands.length) {
          const m = {};
          for (const c of cands) m[c.id] = c.pool;
          meta.candidate_pools = m;
        }
        // V5a Phase 5: thread the noise candidate id (if any) into fire_v3 meta
        // so observation panels can correlate noise injections with subsequent
        // picks. Cleared per-call in buildV4PickerContext on no-op draws.
        if (_state._lastV5NoiseCandidateId) {
          meta.v5a_noise_candidate_id = _state._lastV5NoiseCandidateId;
        }
        appendDiary({
          kind: 'fire_v3',
          text: `[actions] Picker fired: Zone ${curiosity.top_zone.zone} (top: ${curiosity.top_zone.top_node}, mean=${curiosity.top_zone.mean.toFixed(3)}, picker=${pickerVersion})`,
          source: 'mimir_autonomy_v4',
          sessionId,
          meta,
          embedding: _state._lastPickerZvec || null,
        });
        // V5a Phase 1.2 — push (zone, top_node) onto the stickiness FIFO
        // (cap 50). Tracking at fire-event time is the OSS-side equivalent
        // of main arch's session_end push; the firing zone is the right
        // signal regardless of what the LLM ultimately picks. Kill-switch:
        // MIMIR_V5_STICKINESS=0 short-circuits both push and detector.
        if (String(process.env.MIMIR_V5_STICKINESS || '1').trim() !== '0') {
          try {
            const ss = _state._v5StickinessState;
            const zid = curiosity.top_zone?.zone;
            const tnode = curiosity.top_zone?.top_node || null;
            if (zid != null && String(zid).toLowerCase() !== 'unknown') {
              const zNum = Number.isFinite(Number(zid)) ? Number(zid) : zid;
              ss.recentZones.push([zNum, tnode]);
              if (ss.recentZones.length > 50) ss.recentZones.shift();
              ss.totalFires = Number(ss.totalFires || 0) + 1;
            }
          } catch (_) {}
        }
      } catch (e) { /* best-effort */ }
    } else {
      console.warn('[mimir-js autonomy] wakeup rejected:', (data && data.error) || 'no response');
      try {
        appendDiary({
          kind: 'skip_rejected',
          text: `Wakeup rejected: ${(data && data.error) || 'unknown'}`,
          source: 'mimir_autonomy_v4',
          sessionId,
          meta: { mode: 'actions', zone: curiosity.top_zone.zone },
        });
      } catch {}
    }
  } catch (e) {
    console.warn('[mimir-js autonomy] wakeup POST failed:', e.message);
  }
}

// Pre-picker decision layer (2026-05-11 Hybrid A+C refactor).
// POSTs to engine /api/mimir/picker which issues a forced provider
// tool_choice: {type:"tool", name:"select_action"} call — guarantees
// structured output across all tiers (balanced tier bypasses prompt-trust
// JSON envelope; tool_choice is API-level enforcement).
//
// Returns parsed dict { action, candidate_id, rationale, payload,
// chain_after, source } on success, or null on timeout / endpoint error /
// endpoint returned action=null (last-resort fallthrough).
//
// Kill-switch: caller MUST check MIMIR_PICKER_TOOL_CHOICE !== '0' BEFORE
// invoking — when off, autonomy falls through to legacy wakeup-as-decider
// path with no regression.
async function _resolvePickerActionViaToolCall(pickerPrompt, sessionId, model) {
  if (!pickerPrompt) return null;
  try {
    const body = { picker_prompt: pickerPrompt, session_id: sessionId };
    if (model) body.model = model;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(
      `http://127.0.0.1:${_state.enginePort}/api/mimir/picker`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    const data = await res.json().catch(() => ({}));
    if (!data || !data.ok) return null;
    const action = data.action;
    if (typeof action !== 'string' || !action.trim()) return null;
    return {
      action: action.trim().slice(0, 32),
      candidate_id: data.candidate_id || null,
      rationale: data.rationale || '',
      payload: (data.payload && typeof data.payload === 'object') ? data.payload : {},
      chain_after: data.chain_after || null,
      source: data.source || 'tool_call',
    };
  } catch (e) {
    console.warn('[mimir-js autonomy] _resolvePickerActionViaToolCall failed:', e.message);
    return null;
  }
}

export function startAutonomyLoop() {
  if (_intervalHandle || _state.killSwitch) return false;
  _intervalHandle = setInterval(() => {
    _curiosityTick().catch(e => console.warn('[mimir-js autonomy] tick err:', e.message));
  }, CHECK_INTERVAL_MS).unref();
  return true;
}

export function stopAutonomyLoop() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function autonomyStatus() {
  return {
    enabled: !_state.killSwitch && _state.curiosityEnabled,
    kill_switch: _state.killSwitch,
    actions_enabled: [...CANONICAL].filter(a => _state.enabledActions.has(a)),
    last_fire_ms: _lastFireMs,
    cooldown_ms: COOLDOWN_MS,
    check_interval_ms: CHECK_INTERVAL_MS,
    threshold: _activeThreshold(),
    threshold_steady: CURIOSITY_THRESHOLD_STEADY,
    threshold_cold: CURIOSITY_THRESHOLD_COLD,
    cold_node_limit: COLD_NODE_LIMIT,
  };
}
