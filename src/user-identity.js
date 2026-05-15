// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module user-identity
 * @description Shared helper that maps a sessionId to a currentUser descriptor.
 *
 * Single source of truth for the "one instance = one user" isolation model.
 * Every subsystem that touches cross-user state (conversation-store queries,
 * episodic retrieval, cron writes, Anamnesis debrief, inbox capture) derives
 * identity here instead of re-parsing sessionId prefixes inline.
 *
 * Policy:
 * - OWNER_USER_ID env var declares the human owner. Accepts raw chat id
 *   ("123456789") or normalized form ("tg:123456789") — we compare against
 *   the "tg:<id>" speakerId after normalizing both sides. Telegram API calls
 *   use the raw form, speakerId matching uses the prefixed form.
 * - When OWNER_USER_ID is unset, any human sessionId is accepted (single-user
 *   self-host default — no enforcement, just passthrough).
 * - Star-map owner_id stamping is decoupled from OWNER_USER_ID; single-user
 *   self-host always stamps 'self' (see getStarMapOwnerId).
 *
 * Two identity primitives (introduced 2026-04-25, Plan C1):
 *  - getCurrentIdentity() → who is speaking RIGHT NOW (ALS-bound per turn,
 *    falls back to declared owner outside any turn context). Use for routing,
 *    filtering, attribution.
 *  - getOwnerIdentity() → declared owner of this engine instance (env-only).
 *    Use for cron/system/backup channels that act on the owner's behalf
 *    regardless of who triggered them.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const OWNER_USER_ID = (process.env.OWNER_USER_ID || '').trim();
const OWNER_SPEAKER_ID = OWNER_USER_ID
  ? (OWNER_USER_ID.startsWith('tg:') ? OWNER_USER_ID : `tg:${OWNER_USER_ID}`)
  : '';

/**
 * @typedef {Object} CurrentUser
 * @property {string} sessionId       - Original session id, unchanged.
 * @property {string} channel         - 'telegram' | 'cron' | 'autonomous' | 'dashboard' | 'socratic_pk' | 'system' | 'unknown'
 * @property {string} participant     - 'founder' | 'self' | 'unknown_ai' | 'unknown'
 * @property {string} speakerId       - Normalized speaker id: 'tg:<id>' | 'cron:auto' | 'autonomous:self' | 'dash:<prefix>' | 'system:self' | 'unknown:<sid>'
 * @property {boolean} isOwner        - True if this session is the declared owner or a system-owned (cron/autonomous) session.
 * @property {boolean} isSystem       - True for cron/autonomous/mimir — not a human interlocutor.
 * @property {boolean} isAutonomous   - True for curiosity/wakeup/mimir triggers.
 * @property {boolean} isCron         - True for cron-driven sessions.
 * @property {boolean} isHuman        - True for telegram/dashboard/socratic_pk (something on the other side).
 */

/**
 * Derive a CurrentUser descriptor from a sessionId.
 * Pure function — safe to call anywhere.
 * @param {string|null|undefined} sessionId
 * @returns {CurrentUser}
 */
export function deriveCurrentUser(sessionId) {
  const sid = (sessionId || '').trim();

  if (sid.startsWith('tg:')) {
    const raw = sid.slice(3);
    const tgId = raw.split(/[-:]/)[0];
    const speakerId = `tg:${tgId}`;
    return {
      sessionId: sid,
      channel: 'telegram',
      participant: 'founder',
      speakerId,
      isOwner: OWNER_SPEAKER_ID ? speakerId === OWNER_SPEAKER_ID : true,
      isSystem: false,
      isAutonomous: false,
      isCron: false,
      isHuman: true,
    };
  }

  if (sid.startsWith('cron-') || sid.startsWith('cron:')) {
    return {
      sessionId: sid,
      channel: 'cron',
      participant: 'self',
      speakerId: 'cron:auto',
      isOwner: true,
      isSystem: true,
      isAutonomous: false,
      isCron: true,
      isHuman: false,
    };
  }

  if (sid.startsWith('curiosity') || sid.startsWith('wakeup') || sid.startsWith('mimir')) {
    return {
      sessionId: sid,
      channel: 'autonomous',
      participant: 'self',
      speakerId: 'autonomous:self',
      isOwner: true,
      isSystem: true,
      isAutonomous: true,
      isCron: false,
      isHuman: false,
    };
  }

  if (sid.startsWith('dashboard')) {
    const prefix = sid.slice(0, 12) || 'anon';
    return {
      sessionId: sid,
      channel: 'dashboard',
      participant: 'founder',
      speakerId: `dash:${prefix}`,
      isOwner: OWNER_USER_ID ? false : true,
      isSystem: false,
      isAutonomous: false,
      isCron: false,
      isHuman: true,
    };
  }

  if (sid.startsWith('pk-') || sid.startsWith('socratic')) {
    const otherAi = sid.split(':')[1] || 'unknown_ai';
    return {
      sessionId: sid,
      channel: 'socratic_pk',
      participant: otherAi,
      speakerId: `ai:${otherAi}`,
      isOwner: false,
      isSystem: false,
      isAutonomous: false,
      isCron: false,
      isHuman: false,
    };
  }

  return {
    sessionId: sid,
    channel: 'unknown',
    participant: 'unknown',
    speakerId: sid ? `unknown:${sid.slice(0, 16)}` : 'unknown:empty',
    isOwner: OWNER_USER_ID ? false : true,
    isSystem: false,
    isAutonomous: false,
    isCron: false,
    isHuman: false,
  };
}

/**
 * True when a sessionId belongs to this instance's own owner or its
 * system side (cron/autonomous). Foreign human sessions return false
 * whenever OWNER_USER_ID is configured.
 */
export function isOwnInstanceSession(sessionId) {
  return deriveCurrentUser(sessionId).isOwner;
}

/**
 * Resolve the owner_id stamp for star-map writes.
 * - Foreign human sessions → 'foreign:<channel>' (audit trail).
 * - Owner / system sessions → 'self'.
 *
 * Star-map owner is hardcoded 'self' — not env-configurable. Rationale:
 * OWNER_USER_ID is a Telegram identity with a different format; mixing the
 * two scopes has repeatedly produced empty-graph crashes and drift rows.
 * Foreign-channel audit trail ('foreign:dashboard' etc.) handles the
 * adaptability baseline for future multi-user scenarios without exposing
 * a footgun env var.
 */
const STAR_MAP_OWNER = 'self';
export function getStarMapOwnerId(currentUser = null) {
  if (currentUser && !currentUser.isOwner) {
    return `foreign:${currentUser.channel || 'unknown'}`;
  }
  return STAR_MAP_OWNER;
}

// ─── Identity context (Plan C1, 2026-04-25) ──────────────────────────────
// AsyncLocalStorage carries the current-turn CurrentUser descriptor through
// async boundaries so deep callees (engine writes, retrieval, debrief) can
// read identity without threading sessionId through every signature.
//
// Wiring of runWithIdentity() at entry points (agent-runtime#executeTurn,
// cron task, dashboard turn, MCP bridge) happens in C2. Until then,
// getCurrentIdentity() falls back to the owner-as-current default, which
// matches today's "no per-turn override" behavior for system-level writes.
const _identityStore = new AsyncLocalStorage();

/**
 * @typedef {Object} OwnerIdentity
 * @property {string} userId      - Raw OWNER_USER_ID env value (e.g. '123456789'). Empty when unset.
 * @property {string} speakerId   - Normalized 'tg:<id>'. Empty when OWNER_USER_ID unset.
 * @property {string} ownerStamp  - Star-map owner_id stamp; always 'self' (see STAR_MAP_OWNER rationale).
 * @property {boolean} declared   - True when OWNER_USER_ID is set; false for unconfigured self-host.
 */

/** @type {Readonly<OwnerIdentity>} */
const OWNER_IDENTITY = Object.freeze({
  userId: OWNER_USER_ID,
  speakerId: OWNER_SPEAKER_ID,
  ownerStamp: STAR_MAP_OWNER,
  declared: !!OWNER_USER_ID,
});

// Frozen CurrentUser used when getCurrentIdentity() is called outside any ALS
// scope (startup tasks, system cron writes, tests). Matches deriveCurrentUser
// shape so consumers don't need to special-case the no-context path.
//
// speakerId is unconditionally 'system:self' — never the owner's tg:<id>.
// Reason: a 'system' channel masquerading as the owner's telegram speakerId
// would let downstream tg-keyed filters mis-match system writes as user turns.
// Owner identity stays reachable via getOwnerIdentity().speakerId.
/** @type {Readonly<CurrentUser>} */
const _OWNER_AS_CURRENT_FALLBACK = Object.freeze({
  sessionId: '',
  channel: 'system',
  participant: 'self',
  speakerId: 'system:self',
  isOwner: true,
  isSystem: true,
  isAutonomous: false,
  isCron: false,
  isHuman: false,
});

/**
 * Identity for the current async context — i.e. the user/system on whose
 * behalf this code path is executing right now.
 *
 * Precedence:
 *  1. ALS context (set by runWithIdentity at an entry-point turn).
 *  2. Owner-as-current fallback — for code that runs outside any per-turn
 *     scope (engine startup, scheduled writes, tests).
 *
 * @returns {CurrentUser}
 */
export function getCurrentIdentity() {
  const fromALS = _identityStore.getStore();
  return fromALS || _OWNER_AS_CURRENT_FALLBACK;
}

/**
 * Declared owner identity (env-derived, immutable for the process lifetime).
 * Use for system/cron/backup channels that should always act as the owner
 * regardless of who triggered the work.
 *
 * @returns {OwnerIdentity}
 */
export function getOwnerIdentity() {
  return OWNER_IDENTITY;
}

/**
 * Bind `currentUser` to ALS for the duration of `fn`. Callees within `fn`
 * (and any awaited continuations) see this identity via getCurrentIdentity().
 *
 * Wrap entry-point turns so descendants don't need sessionId threaded through
 * every layer. The store is async-context-scoped, so concurrent turns from
 * different sessions never see each other's identity.
 *
 * @template T
 * @param {CurrentUser} currentUser  Result of deriveCurrentUser(sessionId).
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithIdentity(currentUser, fn) {
  return _identityStore.run(currentUser, fn);
}

// ─── Strict-owner enforcement (Plan C4, 2026-04-25) ──────────────────────
// Defense-in-depth gate that rejects malformed / unrecognized speakerIds
// at engine entry points. The legitimate channels in deriveCurrentUser all
// produce one of these prefixes; an `unknown:*` speakerId means a session
// id slipped past the dispatcher and should not be allowed to write owner-
// scoped state in strict deployments.
//
// Three states (env ENGINE_STRICT_OWNER):
//   '1' | 'true' | 'on' | 'strict'  → throw on violation
//   '0' | 'false' | 'off'           → skip validation entirely
//   anything else (incl. unset)     → 'warn' (log only)
//
// OSS fresh-install auto-degrade: when OWNER_USER_ID is unset there is no
// declared owner to defend, so strict mode resolves to 'off' regardless of
// the env var. This keeps `git clone && npm start` quiet for new self-host
// user while still defaulting to 'warn' for configured deployments.
const _LEGAL_OWNER_SPEAKER_PATTERNS = [
  /^tg:\d+$/,                   // telegram: derived from chat id
  /^cron:auto$/,                // cron-driven sessions
  /^autonomous:self$/,          // curiosity / wakeup / mimir
  /^dash:[\w-]+$/,              // dashboard sessions (sid prefix)
  /^system:(self|legacy)$/,     // ALS fallback + grandfathered conv rows
  /^ai:[\w-]+$/,                // socratic_pk peer AI
];

function _isLegalOwnerSpeaker(speakerId) {
  return _LEGAL_OWNER_SPEAKER_PATTERNS.some((p) => p.test(speakerId || ''));
}

/**
 * Resolve current strict-owner mode from env. Auto-degrades to 'off' when
 * OWNER_USER_ID is unset (OSS fresh install — nothing to enforce).
 *
 * @returns {'off'|'warn'|'strict'}
 */
export function getStrictOwnerMode() {
  if (!OWNER_USER_ID) return 'off';
  const raw = (process.env.ENGINE_STRICT_OWNER || '').trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'strict') return 'strict';
  if (raw === '0' || raw === 'false' || raw === 'off') return 'off';
  return 'warn';
}

/**
 * Validate that `currentUser.speakerId` matches a legal channel prefix.
 * Behavior follows getStrictOwnerMode():
 *  - 'off':    no-op, returns { ok: true }.
 *  - 'warn':   logs a single line and returns { ok: false, reason }.
 *  - 'strict': throws Error with code 'STRICT_OWNER_VIOLATION'.
 *
 * Call at entry points (e.g. agent-runtime#turn) so malformed sessions
 * never reach owner-scoped writes.
 *
 * @param {string} entryPoint  - Human-readable site label for diagnostics.
 * @param {CurrentUser} currentUser
 * @returns {{ok: boolean, mode: string, reason?: string}}
 */
export function enforceOwnerIdentity(entryPoint, currentUser) {
  const mode = getStrictOwnerMode();
  if (mode === 'off') return { ok: true, mode };
  const speakerId = currentUser?.speakerId || '';
  if (_isLegalOwnerSpeaker(speakerId)) return { ok: true, mode };

  const reason = `non-whitelist speakerId="${speakerId}" channel="${currentUser?.channel || 'undefined'}" sessionId="${currentUser?.sessionId || ''}"`;
  if (mode === 'strict') {
    const err = new Error(`[strict-owner] ${entryPoint}: ${reason}`);
    err.code = 'STRICT_OWNER_VIOLATION';
    throw err;
  }
  console.warn(`  ⚠ [strict-owner:warn] ${entryPoint}: ${reason}`);
  return { ok: false, mode, reason };
}

export { OWNER_USER_ID, OWNER_SPEAKER_ID, STAR_MAP_OWNER };
