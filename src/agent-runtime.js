// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module agent-runtime
 * @description Core conversation loop for Constellation Engine.
 * 
 * Orchestrates the full turn cycle:
 *   1. Load session context (active messages + compaction summary)
 *   2. Render constellation for current query focus
 *   3. Assemble system prompt with fixed files + constellation + summary
 *   4. Send to LLM with tool definitions
 *   5. Execute tool calls in a loop (up to maxToolRounds)
 *   6. Persist messages (user + assistant + tool results)
 *   7. Check compaction threshold → trigger if exceeded
 *   8. Return final response
 * 
 * Design decisions:
 * - Four-layer context budget: fixed(30%) + constellation(30%) + summary(10%) + active(30%)
 * - Constellation renders dynamically based on user message focus
 * - Compaction produces summary text AND writes to constellation (knowledge preservation)
 * - Tool loop has hard limit to prevent infinite cycles
 * - All errors are caught and surfaced as assistant messages, never swallowed
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import liveBus from './live-bus.cjs';

// ─── Load behavior domain tags from taxonomy for IR routing ─────────────────
const __dirname_rt = dirname(fileURLToPath(import.meta.url));
let BEHAVIOR_DOMAIN_TAGS = new Set(['social-intelligence', 'language-arts', 'meta-cognition']);
try {
  const taxPath = resolve(__dirname_rt, '..', 'config', 'node_taxonomy.json');
  const tax = JSON.parse(readFileSync(taxPath, 'utf8'));
  const bd = tax?.ir_routing?.behavior_domains;
  if (Array.isArray(bd) && bd.length > 0) BEHAVIOR_DOMAIN_TAGS = new Set(bd);
  // Expand behavior domain tags to include all Tier 2 subtags (match mimir_daemon.py expansion)
  const tier2Map = tax?.tier2_tags;
  if (tier2Map && typeof tier2Map === 'object') {
    for (const domain of [...BEHAVIOR_DOMAIN_TAGS]) {
      const subtags = tier2Map[domain];
      if (Array.isArray(subtags)) subtags.forEach(t => BEHAVIOR_DOMAIN_TAGS.add(t));
    }
  }
} catch { /* taxonomy not available, use defaults */ }
import { buildTimeContext, resolveTimezone } from './time.js';
import { selectPrecision, renderNode } from './narrative-ir.js';
import { StreamingIRState } from './streaming-ir.js';
import { deriveCurrentUser, OWNER_USER_ID, OWNER_SPEAKER_ID, runWithIdentity, enforceOwnerIdentity } from './user-identity.js';
import { logInjection } from './injection-log.js';

// ─── Mímir daemon URL (centralized) ─────────────────────────────────────────
const MIMIR_URL = process.env.MIMIR_URL || 'http://127.0.0.1:18810';

// mimirFetch: single retry on AbortError with 100ms jitter. Guards against
// undici keepalive reuse race where the server idle-closed a socket just as
// the client dispatched on it — the first attempt times out, the retry gets
// a fresh connection. Only retries the initial network/timeout failure;
// returns non-ok responses (e.g., 503) without retrying so fallback paths
// (like rerank=false) still trigger.
async function mimirFetch(url, opts = {}, timeoutMs = 20_000) {
  const tryOnce = () => fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  try {
    return await tryOnce();
  } catch (e) {
    if (e?.name !== 'AbortError' && e?.name !== 'TimeoutError') throw e;
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 100) + 50));
    return await tryOnce();
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RuntimeConfig
 * @property {number} contextBudget - Total token budget, default 180000
 * @property {number} fixedRatio - Fixed layer ratio, default 0.10
 * @property {number} constellationRatio - Constellation layer ratio, default 0.28
 * @property {number} summaryRatio - Summary layer ratio, default 0.10
 * @property {number} activeRatio - Active messages ratio, default 0.52
 * @property {number} compactionThreshold - Trigger compaction when active tokens exceed this ratio of activeRatio budget, default 0.85
 * @property {number} maxToolRounds - Max tool-use loop iterations, default 15
 * @property {string[]} fixedFiles - Paths to always-injected files (SYSTEM_PREAMBLE.md, COGNITIVE_STATE.md, etc.)
 * @property {string} [systemPreamble] - Optional hardcoded system preamble
 */

/**
 * @typedef {Object} TurnResult
 * @property {string} response - Final text response
 * @property {Object} usage - Accumulated token usage { inputTokens, outputTokens }
 * @property {number} toolRounds - Number of tool execution rounds
 * @property {boolean} compacted - Whether compaction was triggered
 * @property {string[]} toolsUsed - Names of tools that were called
 */

/**
 * @typedef {Object} TurnOptions
 * @property {string} [model] - Override model for this turn
 * @property {boolean} [skipConstellation] - Skip constellation rendering
 * @property {string} [systemOverride] - Replace entire system prompt (for cron systemEvent)
 * @property {Object} [extraContext] - Additional key-value pairs injected into system prompt
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  compileMode: 'single',       // 'single' = standard primary-model path; 'two_pass' = Mode B + Route C (9B)
  twoPassR1Model: '',          // R1 model override; empty = use llm.compactModel
  contextBudget: 180000,
  fixedRatio: 0.10,
  constellationRatio: 0.28,
  summaryRatio: 0.10,
  activeRatio: 0.52,
  compactionThreshold: 0.85,
  maxToolRounds: 40,
  maxToolCallsPerTurn: 24,
  maxRepeatedToolSignature: 2,
  maxTurnTotalTokens: 2000000,
  sessionTokenBudget: 10000000,
  sessionTimeoutMs: 14400000,
  maxToolResultCharsPerCall: 12000,
  maxToolResultCharsPerTurn: 32000,
  plannerEnabled: true,
  plannerMaxTokens: 220,
  plannerSimilarityThreshold: 0.82,
  plannerRepeatLimit: 2,
  plannerMaxHistoryChars: 5000,
  plannerModel: '',
  fixedFiles: [],
  systemPreamble: '',
  streamingIR: {
    enabled: false,
    maxDynamic: 15,
    evictMissThreshold: 3,
    evictAThreshold: 0.15,
    emaAlpha: 0.3,
    refractoryMs: 30000,
    challengerMargin: 0.10,
  },
};

const SYSTEM_CACHE_BREAK = '<!-- SYSTEM_CACHE_BREAK -->';

const DEFAULT_IDENTITY = {
  agent_name: 'Agent',
  owner_name: 'Owner',
  owner_display_name: '',
  default_language: 'English',
};

function buildKeySystemInstructions(identity) {
  const agent = identity?.agent_name || DEFAULT_IDENTITY.agent_name;
  const owner = identity?.owner_name || DEFAULT_IDENTITY.owner_name;
  return `You are ${agent}. Match ${owner}'s language. State the conclusion first, then the supporting details — do not narrate the reasoning steps. Technical terms may stay in English.`;
}

// ─── Dynamic Context Budget ─────────────────────────────────────────────────
// Scale context budget based on message complexity to balance speed vs depth.
// Short casual messages get a smaller budget (faster response).
// Long complex messages get a larger budget (more constellation + history).
// The configured contextBudget acts as the ceiling, not the floor.
const BUDGET_FLOOR = 60000;    // minimum: ~15K fixed + 12K constellation + 6K summary + 27K active
const BUDGET_COMFORT = 120000; // normal conversations
// Ceiling is cfg.contextBudget from config.json (e.g. 300K)

// ─── Per-Tool Watchdog ──────────────────────────────────────────────────────
// Promise.race timeout per tool call. Bash needs longer (compile/test); experiments
// honor their own tc.input.timeout (capped at HARD ceiling); everything else 2 min.
const TOOL_WATCHDOG_BASH_MS = 600_000;          // 10 min — tests, builds, long shell
const TOOL_WATCHDOG_DEFAULT_MS = 120_000;       // 2 min — file/IO/lookup tools
const TOOL_WATCHDOG_EXPERIMENT_HARD_MS = 5_400_000; // 90 min — never exceed even if input requests more

/**
 * Estimate dynamic context budget based on user message complexity.
 * @param {string} userMessage
 * @param {object} cfg - runtime config (has contextBudget as ceiling)
 * @param {object} [options] - turn options (cron, systemOverride, etc.)
 * @returns {number} effective budget
 */
function estimateDynamicBudget(userMessage, cfg, options = {}) {
  const ceiling = cfg.contextBudget || 180000;

  // Mímir autonomous worker calls: short focus hint, no L4 raw history,
  // skips heavy IR fetches. Use COMFORT (120K) so persona + pool + full
  // constellation render gets enough room — balanced-tier reasoning quality
  // drops sharply when we starve the IR.
  if (options.trigger === 'mimir_autonomous'
      || (options.source && String(options.source).startsWith('mimir_'))) {
    return Math.min(BUDGET_COMFORT, ceiling);
  }

  // Cron tasks and system-override turns: use comfort budget (they're automated, speed matters)
  if (options.trigger === 'cron' || options.source === 'cron' || options.systemOverride) {
    return Math.min(BUDGET_COMFORT, ceiling);
  }

  const msgLen = (userMessage || '').length;
  const msgTokens = Math.ceil(msgLen / 3.5);

  // Short messages (< 50 tokens, ~175 chars): casual chat → floor budget
  if (msgTokens < 50) return BUDGET_FLOOR;

  // Medium messages (50-200 tokens): normal conversation → comfort budget
  if (msgTokens < 200) return Math.min(BUDGET_COMFORT, ceiling);

  // Long messages (200-500 tokens): detailed question → 75% ceiling
  if (msgTokens < 500) return Math.min(Math.floor(ceiling * 0.75), ceiling);

  // Very long messages (500+ tokens): complex task → full ceiling
  return ceiling;
}

const COMPACTION_INSTRUCTION = `You are a conversation summarizer. Summarize the following conversation excerpt, preserving:
1. Key decisions and their reasoning
2. Important facts and data points mentioned
3. User preferences and instructions expressed
4. Unresolved questions or pending tasks
5. Emotional tone and relationship dynamics

Be concise but complete. Use bullet points. Preserve any names, numbers, dates, and technical terms exactly.
Output ONLY the summary, no preamble.`;

// ─── AgentRuntime ───────────────────────────────────────────────────────────

export class AgentRuntime extends EventEmitter {
  /** @type {import('./config.js').default} */
  #config;
  /** @type {RuntimeConfig} */
  #runtimeConfig;
  /** @type {import('../engine.cjs')} */
  #engine;
  /** @type {import('./session.js').SessionManager} */
  #session;
  /** @type {import('./llm-router.js').LLMRouter} */
  #llm;
  /** @type {import('./tool-manager.js').ToolManager|null} */
  #tools;
  /** @type {import('./conversation-store.js').ConversationStore|null} */
  #convStore;
  /** @type {Map<string, Promise<any>>} */
  #sessionQueues = new Map();
  /** @type {Map<string, StreamingIRState>} */
  #streamingIR = new Map();
  /** @type {{agent_name: string, owner_name: string, owner_display_name: string, default_language: string}} */
  #identity = DEFAULT_IDENTITY;
  /** @type {string} cached project root for {{PROJECT_ROOT}} substitution */
  #projectRoot = '';
  /** @type {string} cached channels label for {{CHANNELS}} substitution */
  #channelsLabel = '';
  /** @type {Object} engine.ir config */
  #irConfig = {};
  /** @type {string} IANA timezone resolved at construction */
  #timezone = resolveTimezone('');
  /** @type {string} precomputed key system instructions (identity-aware) */
  #keySystemInstructions = buildKeySystemInstructions(DEFAULT_IDENTITY);

  /**
   * @param {Object} deps
   * @param {Object} deps.engine - Constellation engine instance
   * @param {import('./session.js').SessionManager} deps.sessionManager
   * @param {import('./llm-router.js').LLMRouter} deps.llm
   * @param {Object|null} deps.tools - ToolManager (can be null for P0-P2 minimal)
   * @param {Object|null} deps.convStore - ConversationStore instance
   * @param {RuntimeConfig} [deps.config]
   * @param {Object} [deps.identity] - identity config { agent_name, owner_name, owner_display_name }
   * @param {Object} [deps.irConfig] - engine.ir config (IR layer toggles + thresholds)
   * @param {Object} [deps.locale] - locale config { timezone } — empty tz = auto-detect
   */
  // ─── Render cache for identity/principles (5-minute TTL) ───
  _renderCache = new Map(); // key → { text, ts }
  _RENDER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor({ engine, sessionManager, llm, tools = null, convStore = null, config = {}, identity = null, irConfig = null, locale = null }) {
    super();
    this.#engine = engine;
    this.#session = sessionManager;
    this.#llm = llm;
    this.#tools = tools;
    this.#convStore = convStore;
    this.#runtimeConfig = { ...DEFAULT_CONFIG, ...config };
    if (identity && typeof identity === 'object') {
      this.#identity = { ...DEFAULT_IDENTITY, ...identity };
    }
    this.#keySystemInstructions = buildKeySystemInstructions(this.#identity);
    this.#irConfig = irConfig && typeof irConfig === 'object' ? irConfig : {};
    this.#timezone = resolveTimezone(locale && typeof locale === 'object' ? locale.timezone : '');

    // Validate ratios sum to ~1.0
    const { fixedRatio, constellationRatio, summaryRatio, activeRatio } = this.#runtimeConfig;
    const sum = fixedRatio + constellationRatio + summaryRatio + activeRatio;
    if (Math.abs(sum - 1.0) > 0.01) {
      throw new Error(`Context budget ratios must sum to 1.0, got ${sum.toFixed(3)}`);
    }
  }

  /**
   * Set ConversationStore after construction (initialized later in boot sequence).
   * @param {import('./conversation-store.js').ConversationStore} store
   */
  setConvStore(store) {
    this.#convStore = store;
  }

  /** @returns {{agent_name: string, owner_name: string, owner_display_name: string}} */
  getIdentity() {
    return { ...this.#identity };
  }

  /** Public read-only handle for downstream consumers (cron, telegram, anchor-refresh). */
  get llm() {
    return this.#llm;
  }

  /** @returns {Object} engine.ir config */
  getIrConfig() {
    return this.#irConfig;
  }

  /**
   * Hot-mutate IR config (deep merge). Used by /engine command and
   * Dashboard Settings to toggle layers without a restart. The new
   * value takes effect on the next turn.
   * @param {Object} partial - subset of engine.ir to merge in
   * @returns {Object} the new full irConfig
   */
  setIrConfig(partial) {
    if (!partial || typeof partial !== 'object') return this.#irConfig;
    const merge = (a, b) => {
      const out = { ...a };
      for (const k of Object.keys(b)) {
        if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
          out[k] = merge(a[k], b[k]);
        } else {
          out[k] = b[k];
        }
      }
      return out;
    };
    this.#irConfig = merge(this.#irConfig, partial);
    return this.#irConfig;
  }

  /**
   * Runtime hard-limit floors — below these, sessions become unusable.
   * Enforced server-side so the Dashboard panel can't brick itself.
   */
  static RUNTIME_LIMIT_FLOORS = Object.freeze({
    maxToolRounds: 10,          // at least 10 tool calls per turn
    sessionTokenBudget: 100000, // at least 100K tokens per session
    sessionTimeoutMs: 600000,   // at least 10 minutes
  });

  /** @returns {{maxToolRounds: number, sessionTokenBudget: number, sessionTimeoutMs: number}} */
  getRuntimeLimits() {
    return {
      maxToolRounds: this.#runtimeConfig.maxToolRounds,
      sessionTokenBudget: this.#runtimeConfig.sessionTokenBudget,
      sessionTimeoutMs: this.#runtimeConfig.sessionTimeoutMs,
    };
  }

  /**
   * Hot-mutate runtime hard limits. Floor-clamped server-side. Used by
   * Dashboard Settings to raise/lower session ceilings without a restart.
   * New values take effect on the next turn / next session timeout schedule.
   * @param {Partial<{maxToolRounds: number, sessionTokenBudget: number, sessionTimeoutMs: number}>} partial
   * @returns {{maxToolRounds: number, sessionTokenBudget: number, sessionTimeoutMs: number}}
   */
  setRuntimeLimits(partial) {
    if (!partial || typeof partial !== 'object') return this.getRuntimeLimits();
    const floors = AgentRuntime.RUNTIME_LIMIT_FLOORS;
    for (const key of ['maxToolRounds', 'sessionTokenBudget', 'sessionTimeoutMs']) {
      if (partial[key] == null) continue;
      const n = Number(partial[key]);
      if (!Number.isFinite(n)) continue;
      this.#runtimeConfig[key] = Math.max(Math.floor(n), floors[key]);
    }
    return this.getRuntimeLimits();
  }

  /**
   * Execute a single conversation turn.
   * 
   * @param {string} sessionId - Session identifier
   * @param {string} userMessage - User input text
   * @param {TurnOptions} [options={}]
   * @returns {Promise<TurnResult>}
   */
  async turn(sessionId, userMessage, options = {}) {
    // Plan C2 (2026-04-25): Bind per-turn identity to AsyncLocalStorage *outside*
    // the queue so ALS context propagates through every await in #executeTurn
    // (and through engine writes via the ALS-aware _resolveOwnerStamp resolver).
    // Concurrent turns from different sessions never see each other's identity.
    const currentUser = deriveCurrentUser(sessionId);
    enforceOwnerIdentity('agent-runtime#turn', currentUser);
    return await runWithIdentity(currentUser, () =>
      this.#enqueueTurn(sessionId, () => this.#executeTurn(sessionId, userMessage, options))
    );
  }

  async #executeTurn(sessionId, userMessage, options = {}) {
    const startTime = Date.now();
    const signal = options.signal || null; // AbortSignal from cron or caller
    const sessionTokensUsed = options.sessionTokensUsed || 0; // cumulative tokens from prior retries
    this._lastCompileSnapshot = null; // reset per-turn

    // ─── Multi-user isolation choke-point ─────────────────────────────────
    // All downstream subsystems that touch cross-user state (raw injection,
    // episodic query, rerank expansion, pool-anchor, deep recall) derive
    // identity from this single descriptor. Never re-parse sessionId inline.
    const currentUser = deriveCurrentUser(sessionId);
    if (OWNER_USER_ID && currentUser.isHuman && !currentUser.isOwner) {
      console.warn(`  ⚠ Foreign user turn: ${currentUser.speakerId} (owner=${OWNER_USER_ID}) — proceeding with isolation, not mixing into owner state`);
    }
    options._currentUser = currentUser;
    const turnEffectiveSpeakerId = OWNER_USER_ID
      ? (currentUser.isOwner ? OWNER_SPEAKER_ID : (currentUser.speakerId || ''))
      : '';
    // Per-turn star-map owner stamp now resolves via ALS (Plan C2, 2026-04-25):
    // turn() wraps this method with runWithIdentity(currentUser, ...), and
    // engine.cjs#_resolveOwnerStamp() reads getCurrentIdentity() through the
    // installed _identityResolver. No mutable engine field write needed.
    const result = {
      response: '',
      // First-round assistant text. The picker prompt (Mímir Autonomy v3) asks
      // the LLM to emit a JSON envelope BEFORE calling any tools. After tool
      // rounds, response holds the final summary and the envelope is lost —
      // mimir-js /session_end needs the first round to back-fill chosen_action
      // onto the fire_v3 diary row.
      firstResponse: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      toolRounds: 0,
      compacted: false,
      toolsUsed: [],
      toolCacheHits: 0,
      suppressedToolCalls: 0,
    };

    const turn = this.#session.startTurn(sessionId, {
      trigger: options.trigger || options.source || 'user',
      eventKey: options.eventKey || null,
      userMessage,
      options,
      stage: 'received_user',
      status: 'started',
    });
    const turnId = turn.id;

    try {
      const userRow = this.#session.addMessage(sessionId, {
        role: 'user',
        content: userMessage,
      });
      this.#session.updateTurn(turnId, {
        stage: 'user_persisted',
        userMessageId: userRow.id,
      });

      let systemPrompt = options.systemOverride
        ? options.systemOverride
        : await this.buildSystemPrompt(sessionId, userMessage, options);
      // Append extra context (used by state-core to add monitoring data WITHOUT replacing identity)
      if (options.systemAppend) {
        systemPrompt = systemPrompt + '\n\n' + options.systemAppend;
      }
      this.#session.updateTurn(turnId, { stage: 'system_prompt_built' });
      if (global.TIMING_LOGS) console.log(`  [Timing] buildSystemPrompt done, assembling messages...`);

      // ─── Mode B + Route C: Two-Pass Pre-Flight ───────────────────────
      // When compileMode is 'two_pass', run a lightweight R1 skeleton pass
      // before the main LLM call. R1 outputs a skeleton + <need_info> tags;
      // resolved supplementary info is injected into the R2 system prompt.
      // Skip R1 for short/trivial messages — not worth ~10s of compact-tier latency
      const _msgLen = (userMessage || '').trim().length;
      const _skipR1 = _msgLen < 15 || /^(ok|yes|no|thanks|got it|continue|go|nice|cool|lol|👍|🙏|💯)$/i.test((userMessage || '').trim());
      console.log(`  [TwoPass] compileMode=${this.#runtimeConfig.compileMode}, hasSystemOverride=${!!options.systemOverride}, hasUserMessage=${!!userMessage}, msgLen=${_msgLen}, skipR1=${_skipR1}`);
      if (this.#runtimeConfig.compileMode === 'two_pass' && !options.systemOverride && userMessage && !_skipR1) {
        console.log(`  [TwoPass] R1 pre-flight starting...`);
        liveBus.safeEmit('runtime.twoPass', { stage: 'r1_start', msgLen: _msgLen });
        const _tpStart = Date.now();
        const preFlight = await this.#executeTwoPassPreFlight(sessionId, userMessage, systemPrompt, options);
        console.log(`  [TwoPass] R1 pre-flight result: ${preFlight ? 'success' : 'null (fallback to single-pass)'}, took ${Date.now() - _tpStart}ms`);
        liveBus.safeEmit('runtime.twoPass', { stage: preFlight ? 'r1_done' : 'r1_fallback', ms: Date.now() - _tpStart });
        if (preFlight) {
          const r2Append = [AgentRuntime.#R2_HEADER, `### Skeleton\n${preFlight.skeleton}`];
          if (preFlight.supplementary) {
            r2Append.push(`### Supplementary Information\n${preFlight.supplementary}`);
          }
          systemPrompt = systemPrompt + '\n\n' + r2Append.join('\n\n');
          this.#session.updateTurn(turnId, { stage: 'two_pass_r1_done' });
          if (global.TIMING_LOGS) console.log(`  [TwoPass] R1 pre-flight done in ${Date.now() - _tpStart}ms`);
        }
      }

      const { messages } = this.#assembleMessages(sessionId, systemPrompt);
      this.#session.updateTurn(turnId, { stage: 'messages_assembled' });
      if (global.TIMING_LOGS) console.log(`  [Timing] messages assembled, starting LLM call`);

      // Calculate context pressure for adaptive budgeting in deferred tools
      const totalInjectedChars = messages.reduce((acc, m) => acc + (m.content?.length || 0), 0);
      const contextBudget = this.#runtimeConfig.contextBudget || 180000;
      const ctxPressure = totalInjectedChars / (contextBudget * 0.3); // Pressure within active context ratio
      globalThis._ctxPressure = Math.min(ctxPressure, 1.0);

      let toolDefs = this.#tools ? this.#tools.getDefinitions({ sessionId, userMessage }) : [];

      let currentMessages = [...messages];
      let assistantContent = '';
      let loopCount = 0;
      const maxRounds = this.#runtimeConfig.maxToolRounds;
      const turnState = {
        totalToolCalls: 0,
        totalTurnTokens: 0,
        toolSignatureCounts: new Map(),
        memoizedToolResults: new Map(),
        toolContextChars: 0,
        totalToolResultBytes: 0,
        cacheHits: 0,
        suppressedToolCalls: 0,
        plannerInvocations: 0,
        plannerGuardrailHits: 0,
        plannerHistory: [],
        stopReason: null,
      };

      // Early abort check — if signal was triggered during buildSystemPrompt/assembleMessages, skip LLM entirely
      if (signal?.aborted) {
        const reason = signal.reason || 'aborted';
        turnState.stopReason = reason === 'interrupted_by_user' ? 'interrupted_by_user' : 'aborted';
        this.emit('turnInterrupted', { sessionId, turnId, stage: 'pre_llm', reason });
        this.#session.finishTurn(turnId, {
          stage: 'interrupted_pre_llm',
          status: 'interrupted',
          stopReason: turnState.stopReason,
        });
        return { ...result, response: '' };
      }

      while (loopCount <= maxRounds) {
        // Check abort signal (from cron timeout or user interruption)
        if (signal?.aborted) {
          const reason = signal.reason || 'aborted';
          if (reason === 'interrupted_by_user') {
            turnState.stopReason = 'interrupted_by_user';
            this.emit('turnInterrupted', { sessionId, turnId, rounds: loopCount, reason });
            // Do NOT inject fallback content — partial AI response should be discarded
          } else {
            turnState.stopReason = 'aborted';
            this.emit('warning', { type: 'turn_aborted', sessionId, turnId, rounds: loopCount });
            assistantContent = assistantContent || '[Turn aborted by caller (timeout or cancellation)]';
          }
          break;
        }

        this.#session.updateTurn(turnId, {
          stage: 'llm_requested',
          toolRounds: loopCount,
          toolsUsed: result.toolsUsed,
        });

        const plannerDecision = await this.#applyPlannerGuardrail({
          sessionId,
          turnId,
          userMessage,
          currentMessages,
          toolDefs,
          loopCount,
          turnState,
          options,
        });
        if (plannerDecision?.toolDefs) toolDefs = plannerDecision.toolDefs;
        if (plannerDecision?.guardrailNote) {
          currentMessages = [...currentMessages, { role: 'user', content: plannerDecision.guardrailNote }];
        }

        // ─── LLM call: streaming or non-streaming ───
        let llmResponse;
        const useStreaming = !!(options.stream && typeof this.#llm.streamChat === 'function');
        const _llmStart = Date.now();
        let _ttftLogged = false;

        if (useStreaming) {
          // Streaming path: emit textDelta events as tokens arrive
          const streamChunks = [];
          let streamToolCalls = null;
          let streamUsage = null;
          let streamModel = '';
          let streamFinishReason = 'stop';

          // Race stream iteration against abort signal so timeouts can interrupt
          // a hanging stream. Without this, for-await blocks indefinitely waiting
          // for the next SSE event and never checks signal.aborted.
          const stream = this.#llm.streamChat(currentMessages, {
            model: options.model,
            _role: options._role || 'main',
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            appendSystemPrompt: this.#keySystemInstructions,
            _trigger: options.trigger || options.source || 'user',
            _sessionId: sessionId,
            _maxRetries: 0, // Don't retry on timeout — let Telegram's auto-retry handle it
          });

          const abortPromise = signal
            ? new Promise((_, reject) => {
                if (signal.aborted) return reject(new Error(signal.reason || 'aborted'));
                signal.addEventListener('abort', () => reject(new Error(signal.reason || 'aborted')), { once: true });
              })
            : null;

          try {
            while (true) {
              // Race next stream event against abort signal
              const iterResult = abortPromise
                ? await Promise.race([stream.next(), abortPromise])
                : await stream.next();
              if (iterResult.done) break;
              const event = iterResult.value;

              if (signal?.aborted) {
                streamFinishReason = 'interrupted';
                break;
              }
              if (event.type === 'text_delta') {
                if (!_ttftLogged) { if (global.TIMING_LOGS) console.log(`  [TTFT] ${Date.now() - _llmStart}ms from LLM call to first token`); _ttftLogged = true; }
                streamChunks.push(event.text);
                this.emit('textDelta', { sessionId, text: event.text, round: loopCount });
              }
              if (event.type === 'tool_calls') {
                streamToolCalls = event.toolCalls;
              }
              if (event.type === 'done') {
                streamUsage = event.response?.usage || null;
                streamModel = event.response?.model || '';
                streamFinishReason = event.response?.finishReason || 'stop';
              }
            }
          } catch (abortErr) {
            // Abort signal fired while waiting for stream — treat as timeout
            if (signal?.aborted) {
              streamFinishReason = 'interrupted';
            } else {
              throw abortErr; // Re-throw non-abort errors
            }
          } finally {
            // Clean up: return the generator to release resources
            try { await stream.return(); } catch {}
          }

          llmResponse = {
            content: streamChunks.length ? streamChunks.join('') : null,
            toolCalls: streamToolCalls,
            usage: streamUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            model: streamModel,
            finishReason: streamFinishReason,
          };
        } else {
          // Non-streaming path: race LLM call against abort signal
          const llmPromise = this.#llm.chat(currentMessages, {
            model: options.model,
            _role: options._role || 'main',
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            appendSystemPrompt: this.#keySystemInstructions,
            _trigger: options.trigger || options.source || 'user',
            _sessionId: sessionId,
            _maxRetries: 0, // Don't retry on timeout — let Telegram's auto-retry handle it
          });

          if (signal) {
            // Race the LLM call against the abort signal
            const abortPromise = new Promise((_, reject) => {
              if (signal.aborted) return reject(new Error(signal.reason || 'aborted'));
              signal.addEventListener('abort', () => reject(new Error(signal.reason || 'aborted')), { once: true });
            });
            try {
              llmResponse = await Promise.race([llmPromise, abortPromise]);
            } catch (abortErr) {
              // Signal was aborted during LLM call — set stopReason and break
              turnState.stopReason = 'aborted';
              assistantContent = assistantContent || '[Turn aborted by caller (timeout)]';
              this.emit('warning', { type: 'turn_aborted_mid_llm', sessionId, turnId, rounds: loopCount });
              break;
            }
          } else {
            llmResponse = await llmPromise;
          }
        }

        if (llmResponse.usage) {
          const inTok = llmResponse.usage.inputTokens || llmResponse.usage.promptTokens || 0;
          const outTok = llmResponse.usage.outputTokens || llmResponse.usage.completionTokens || 0;
          result.usage.inputTokens += inTok;
          result.usage.outputTokens += outTok;
          turnState.totalTurnTokens += inTok + outTok;
        }

        // Budget tracking (observability only — do not abort the turn/session).
        // Principle: no mechanism should easily interrupt a session. Hard backstops
        // are maxToolRounds and the LLM's own context limit.
        if (turnState.totalTurnTokens > this.#runtimeConfig.maxTurnTotalTokens && !turnState.turnBudgetWarned) {
          turnState.turnBudgetWarned = true;
          this.emit('warning', {
            type: 'turn_token_budget_exceeded',
            sessionId,
            turnId,
            used: turnState.totalTurnTokens,
            limit: this.#runtimeConfig.maxTurnTotalTokens,
            rounds: loopCount,
            action: 'continue',
          });
        }

        const sessionBudget = options.sessionTokenBudget || this.#runtimeConfig.sessionTokenBudget;
        const sessionTotalUsed = sessionTokensUsed + turnState.totalTurnTokens;
        if (sessionBudget && sessionTotalUsed > sessionBudget && !turnState.sessionBudgetWarned) {
          turnState.sessionBudgetWarned = true;
          this.emit('warning', {
            type: 'session_token_budget_exceeded',
            sessionId,
            turnId,
            used: sessionTotalUsed,
            limit: sessionBudget,
            thisTurn: turnState.totalTurnTokens,
            priorRetries: sessionTokensUsed,
            rounds: loopCount,
            action: 'continue',
          });
        }

        if (llmResponse.content) {
          assistantContent = llmResponse.content;
          if (!result.firstResponse) result.firstResponse = llmResponse.content;
          this.emit('llmChunk', {
            sessionId, round: loopCount,
            content: llmResponse.content.slice(0, 300),
            hasToolCalls: !!(llmResponse.toolCalls && llmResponse.toolCalls.length > 0),
          });
        }

        if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0 && this.#tools) {
          loopCount++;
          result.toolRounds = loopCount;

          const assistantToolTurn = this.#session.addMessage(sessionId, {
            role: 'assistant',
            content: llmResponse.content || '',
            toolCalls: llmResponse.toolCalls,
          });

          currentMessages.push({
            role: 'assistant',
            content: llmResponse.content || '',
            tool_calls: llmResponse.toolCalls,
          });

          for (const tc of llmResponse.toolCalls) {
            this.emit('toolCall', {
              sessionId, round: loopCount, name: tc.name,
              input: tc.input, id: tc.id,
            });
          }

          const toolBatchId = `assistant-${assistantToolTurn.id}`;
          this.#session.registerPendingToolRuns(turnId, sessionId, llmResponse.toolCalls, {
            assistantMessageId: assistantToolTurn.id,
            toolBatchId,
            round: loopCount,
          });
          this.#session.updateTurn(turnId, {
            stage: 'tools_pending',
            toolRounds: loopCount,
          });

          const toolResults = await this.#prepareAndExecuteTools(llmResponse.toolCalls, loopCount, turnState, {
            sessionId,
            turnId,
            toolBatchId,
            assistantMessageId: assistantToolTurn.id,
            speakerId: turnEffectiveSpeakerId,
          });

          for (const tc of llmResponse.toolCalls) {
            if (!result.toolsUsed.includes(tc.name)) {
              result.toolsUsed.push(tc.name);
            }
          }

          for (const tr of toolResults) {
            this.emit('toolResult', {
              sessionId, round: loopCount, name: tr.name || tr.id,
              result: (tr.content || '').slice(0, 500),
              // Plan A 2026-04-29 — Sleipnir hybrid storage needs full text,
              // not the 500-char dashboard preview. Capped at 32KB to match
              // downstream promote.js raw chunk ceiling.
              rawContent: (tr.content || '').slice(0, 32 * 1024),
              ok: tr.ok,
              id: tr.id,
            });
          }

          for (const tr of toolResults) {
            const content = this.#shapeToolResultForContext(tr, turnState);
            const toolMsg = {
              role: 'tool',
              content,
              tool_call_id: tr.id,
              tool_name: tr.name,
              tool_ok: tr.ok,
              tool_latency_ms: tr.latencyMs,
              tool_result_bytes: tr.resultBytes,
              tool_error_code: tr.errorCode,
              tool_batch_id: toolBatchId,
              tool_round: loopCount,
            };
            const toolRow = this.#session.addMessage(sessionId, toolMsg);
            this.#session.completePendingToolRun(turnId, tr.id, {
              status: tr.ok ? 'completed' : 'failed',
              resultMessageId: toolRow.id,
              resultPreview: content.slice(0, 240),
              errorCode: tr.errorCode,
              error: tr.ok ? null : content.slice(0, 500),
              latencyMs: tr.latencyMs,
              resultBytes: tr.resultBytes,
            });
            turnState.totalToolResultBytes += Number(tr.resultBytes || Buffer.byteLength(String(content || '')) || 0);
            currentMessages.push(toolMsg);
          }

          this.#compressHistoricalToolResults(currentMessages, loopCount);

          const estimatedTokens = JSON.stringify(currentMessages).length / 3.5;
          const tokenLimit = this.#runtimeConfig.contextBudget * 0.85;
          if (estimatedTokens > tokenLimit) {
            this.emit('warning', {
              type: 'token_budget_exceeded',
              sessionId,
              estimated: Math.round(estimatedTokens),
              limit: Math.round(tokenLimit),
              rounds: loopCount,
            });
            console.warn(`[Runtime] Token safety valve: ~${Math.round(estimatedTokens)} tokens exceeds ${Math.round(tokenLimit)} limit at round ${loopCount}`);
            turnState.stopReason = 'token_safety_valve';
            this.#session.updateTurn(turnId, {
              stage: 'token_safety_valve',
              toolRounds: loopCount,
              toolsUsed: result.toolsUsed,
              totalTokens: turnState.totalTurnTokens,
              toolCallCount: turnState.totalToolCalls,
              toolCacheHits: turnState.cacheHits,
              suppressedToolCalls: turnState.suppressedToolCalls,
              toolResultBytes: turnState.totalToolResultBytes,
              plannerInvocations: turnState.plannerInvocations,
              plannerGuardrailHits: turnState.plannerGuardrailHits,
              stopReason: turnState.stopReason,
            });
            break;
          }

          if (loopCount >= maxRounds) {
            this.emit('warning', {
              type: 'max_tool_rounds',
              sessionId,
              rounds: loopCount,
            });
            turnState.stopReason = 'max_tool_rounds';
            this.#session.updateTurn(turnId, {
              stage: 'max_tool_rounds',
              toolRounds: loopCount,
              toolsUsed: result.toolsUsed,
              totalTokens: turnState.totalTurnTokens,
              toolCallCount: turnState.totalToolCalls,
              toolCacheHits: turnState.cacheHits,
              suppressedToolCalls: turnState.suppressedToolCalls,
              toolResultBytes: turnState.totalToolResultBytes,
              plannerInvocations: turnState.plannerInvocations,
              plannerGuardrailHits: turnState.plannerGuardrailHits,
              stopReason: turnState.stopReason,
            });
            const finalResponse = await this.#llmCallMaybeStream(currentMessages, { model: options.model, _role: options._role || 'main', signal: options.signal, _trigger: options.trigger || options.source || 'user', _sessionId: sessionId }, useStreaming, sessionId, loopCount);
            if (finalResponse.content) assistantContent = finalResponse.content;
            if (finalResponse.usage) {
              result.usage.inputTokens += finalResponse.usage.inputTokens || 0;
              result.usage.outputTokens += finalResponse.usage.outputTokens || 0;
            }
            break;
          }

          toolDefs = this.#tools ? this.#tools.getDefinitions({ sessionId, userMessage, toolRounds: loopCount }) : [];

          this.#session.updateTurn(turnId, {
            stage: 'tool_results_persisted',
            toolRounds: loopCount,
            toolsUsed: result.toolsUsed,
            toolCallCount: turnState.totalToolCalls,
            toolCacheHits: turnState.cacheHits,
            suppressedToolCalls: turnState.suppressedToolCalls,
            totalTokens: turnState.totalTurnTokens,
            toolResultBytes: turnState.totalToolResultBytes,
            plannerInvocations: turnState.plannerInvocations,
            plannerGuardrailHits: turnState.plannerGuardrailHits,
            stopReason: turnState.stopReason,
          });
          continue;
        }

        // Map LLM finishReason to stopReason when loop ends normally (no tool calls)
        if (!turnState.stopReason && llmResponse?.finishReason) {
          if (llmResponse.finishReason === 'stream_incomplete') {
            // Stream was interrupted mid-flight (proxy crash, connection drop)
            // This triggers network_error retry in telegram.js
            turnState.stopReason = 'network_error';
            console.warn(`[Runtime] Stream ended without finish event — proxy/LLM connection likely interrupted. responseLen=${(assistantContent || '').length}`);
          } else if (llmResponse.finishReason === 'safety') {
            // Provider safety filter blocked the response (Gemini SAFETY, Anthropic refusal, etc.)
            // Do NOT auto-retry — same prompt will trigger same block. User-facing path should surface refusal.
            turnState.stopReason = 'safety_blocked';
            this.emit('warning', { type: 'llm_safety_blocked', sessionId, turnId, rounds: loopCount, responseLen: (assistantContent || '').length });
            console.warn(`[Runtime] LLM safety filter blocked response (finishReason=safety). responseLen=${(assistantContent || '').length}`);
          } else if (llmResponse.finishReason === 'length') {
            turnState.stopReason = 'max_tokens';
            this.emit('warning', { type: 'llm_max_tokens', sessionId, turnId, rounds: loopCount, responseLen: (assistantContent || '').length });
            console.warn(`[Runtime] LLM hit output token limit (finishReason=length), response may be truncated. responseLen=${(assistantContent || '').length}`);
          } else {
            turnState.stopReason = 'completed';
          }
        } else if (!turnState.stopReason) {
          turnState.stopReason = 'completed';
        }
        break;
      }

      // SAFETY NET: ensure stopReason is never null after the while loop
      if (!turnState.stopReason) {
        if (assistantContent) {
          turnState.stopReason = 'completed';
          console.warn(`[Runtime] stopReason was null after while loop despite having response (len=${assistantContent.length}). Set to 'completed'. finishReason=${llmResponse?.finishReason}`);
        } else {
          turnState.stopReason = 'aborted';
          console.warn(`[Runtime] stopReason was null after while loop with no response. Set to 'aborted'. loopCount=${loopCount}`);
        }
      }

      // If interrupted by user, don't persist partial AI response to history
      if (turnState.stopReason === 'interrupted_by_user') {
        result.response = '';
        this.#session.finishTurn(turnId, {
          stage: 'interrupted_by_user',
          status: 'interrupted',
          toolRounds: result.toolRounds,
          toolsUsed: result.toolsUsed,
          toolCallCount: turnState.totalToolCalls,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: turnState.totalTurnTokens,
          stopReason: 'interrupted_by_user',
        });
      } else {
        result.response = assistantContent;
        const finalAssistant = this.#session.addMessage(sessionId, {
          role: 'assistant',
          content: assistantContent,
        });
        this.#session.finishTurn(turnId, {
          stage: 'assistant_response_persisted',
          status: 'completed',
          finalMessageId: finalAssistant.id,
          toolRounds: result.toolRounds,
          toolsUsed: result.toolsUsed,
          toolCallCount: turnState.totalToolCalls,
          toolCacheHits: turnState.cacheHits,
          suppressedToolCalls: turnState.suppressedToolCalls,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: turnState.totalTurnTokens,
          toolResultBytes: turnState.totalToolResultBytes,
          plannerInvocations: turnState.plannerInvocations,
          plannerGuardrailHits: turnState.plannerGuardrailHits,
          stopReason: turnState.stopReason,
        });
      }

      result.toolCacheHits = turnState.cacheHits;
      result.suppressedToolCalls = turnState.suppressedToolCalls;
      result.stopReason = turnState.stopReason;
      result.compacted = await this.#maybeCompact(sessionId);

      this.emit('turn', {
        sessionId,
        turnId,
        userMessage,
        duration: Date.now() - startTime,
        ...result,
        latency_ms: Date.now() - startTime,
        stop_reason: result.stopReason || null,
        tokens_in: result.usage?.inputTokens || 0,
        tokens_out: result.usage?.outputTokens || 0,
      });

      // ─── Phase 0.5: Compiler Training Data Auto-Collection ───────────
      // Save (pool_snapshot + compile_result, primary_response) pairs for future
      // T5-small training. Only saves when: (1) compile was successful, (2) the
      // primary LLM produced a non-trivial response, (3) turn completed normally.
      try {
        const snap = this._lastCompileSnapshot;
        if (snap && snap.ok && assistantContent && assistantContent.length > 50
            && result.stopReason !== 'aborted' && options.trigger !== 'mimir_autonomous') {
          const trainingEntry = {
            timestamp: new Date().toISOString(),
            session_id: sessionId,
            turn_id: turnId,
            user_message: userMessage,
            pool: (snap.pool || []).map(n => ({
              id: n.id, score: n.score, activation: n.activation,
              zone: n.zone, permanent: n.permanent,
            })),
            compiled: {
              skeleton: snap.compiled?.skeleton || '',
              edge_count: snap.compiled?.edge_count || 0,
              role_distribution: snap.compiled?.role_distribution || {},
              claims: (snap.compiled?.claims || []).slice(0, 10),
              tensions: (snap.compiled?.tensions || []).slice(0, 5),
              style_guidance: (snap.compiled?.style_guidance || []).slice(0, 8),
            },
            response: assistantContent,
            response_tokens: result.usage?.outputTokens || 0,
          };
          const fs = await import('node:fs');
          const path = await import('node:path');
          const trainingDir = resolve(__dirname_rt, '..', 'data', 'compiler-training');
          if (!existsSync(trainingDir)) mkdirSync(trainingDir, { recursive: true });
          const dateStr = new Date().toISOString().slice(0, 10);
          const filePath = path.join(trainingDir, `training-${dateStr}.jsonl`);
          await fs.promises.appendFile(filePath, JSON.stringify(trainingEntry) + '\n');
        }
      } catch {
        // Training data collection is best-effort — never block the main flow
      }

      return result;
    } catch (error) {
      // If abort signal caused this error, set stopReason so caller can detect it
      console.log(`  [AgentRuntime] Catch: error="${error.message?.slice(0, 200)}", name="${error.name}", signal.aborted=${signal?.aborted}, signal.reason=${signal?.reason}`);
      if (signal?.aborted) {
        const reason = signal.reason || 'aborted';
        result.stopReason = reason === 'interrupted_by_user' ? 'interrupted_by_user' : 'aborted';
      } else if (error.message?.includes('timed out') || error.message?.includes('timeout') || error.name === 'AbortError') {
        // Proxy or LLM router timed out before the caller's AbortController fired
        // Mark as aborted so the caller (telegram.js) can trigger auto-retry
        result.stopReason = 'aborted';
      } else if (error.message?.includes('ECONNREFUSED') || error.message?.includes('ECONNRESET') || error.message?.includes('ENOTFOUND') || error.message?.includes('ECONNABORTED') || error.message?.includes('EPIPE') || error.message?.includes('ETIMEDOUT') || error.message?.includes('502') || error.message?.includes('503') || error.message?.includes('504')) {
        // Network connectivity error — proxy/LLM is down, retrying won't help
        result.stopReason = 'network_error';
        console.warn(`  [AgentRuntime] Network error (not retryable): ${error.message?.slice(0, 200)}`);
      } else if (error.message?.includes('database is locked') || error.message?.includes('SQLITE_BUSY')) {
        // SQLite write lock contention — transient, don't trigger auto-retry loop
        result.stopReason = 'db_locked';
        console.warn(`  [AgentRuntime] SQLite lock contention (transient): ${error.message?.slice(0, 200)}`);
      } else {
        // Unknown error — still set stopReason so caller can handle it
        result.stopReason = 'aborted';
        console.warn(`  [AgentRuntime] Non-timeout error treated as aborted: ${error.message?.slice(0, 200)}`);
      }
      console.log(`  [AgentRuntime] Set stopReason=${result.stopReason}`);

      this.#session.finishTurn(turnId, {
        status: signal?.aborted ? 'aborted' : 'failed',
        stage: signal?.aborted ? 'aborted' : 'failed',
        error: error.message,
        stopReason: result.stopReason,
        toolRounds: result.toolRounds,
        toolsUsed: result.toolsUsed,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.inputTokens + result.usage.outputTokens,
      });

      if (this.listenerCount('error') > 0) {
        this.emit('error', { sessionId, turnId, error });
      }

      return {
        ...result,
        response: signal?.aborted ? (assistantContent || '') : `[Runtime Error] ${error.message}`,
      };
    }
    // No finally-clear needed: ALS scope unwinds automatically when runWithIdentity
    // returns. Concurrent turns from different sessions never share identity.
  }

  #enqueueTurn(sessionId, fn) {
    const previous = this.#sessionQueues.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    const cleanup = current.finally(() => {
      if (this.#sessionQueues.get(sessionId) === cleanup) {
        this.#sessionQueues.delete(sessionId);
      }
    });
    this.#sessionQueues.set(sessionId, cleanup);
    return cleanup;
  }

  /**
   * Build the complete system prompt with four-layer context budget.
   * 
   * @param {string} sessionId
   * @param {string} userMessage - Used as constellation focus
   * @param {TurnOptions} [options={}]
   * @returns {Promise<string>}
   */
  async buildSystemPrompt(sessionId, userMessage, options = {}) {
    const _t0 = Date.now();
    const _lap = (label) => { if (global.TIMING_LOGS) console.log(`  [buildSP] ${label}: +${Date.now() - _t0}ms`); };
    const cfg = this.#runtimeConfig;
    const budget = estimateDynamicBudget(userMessage, cfg, options);
    // Reuse the choke-point descriptor set in #executeTurn, or derive lazily
    // when buildSystemPrompt is called outside the normal turn path.
    const currentUser = options._currentUser || deriveCurrentUser(sessionId);
    // Effective speaker_id for episodic queries:
    //   - OWNER_USER_ID set + own-instance session (owner's telegram /
    //     cron / autonomous / dashboard): use OWNER_USER_ID. This lets
    //     cron/dashboard see the owner's history, not just their own writes.
    //   - OWNER_USER_ID set + foreign human session: use their own
    //     speakerId — they get isolated to their own + system messages.
    //   - OWNER_USER_ID unset (permissive single-user mode): use empty
    //     string so Python falls through to the legacy no-filter path
    //     (pre-Plan-Y behavior preserved for dev / self-host).
    const effectiveSpeakerId = OWNER_USER_ID
      ? (currentUser.isOwner ? OWNER_SPEAKER_ID : (currentUser.speakerId || ''))
      : '';

    // Store effective budget for assembleMessages to use the same value
    this._lastEffectiveBudget = budget;

    const fixedBudget = Math.floor(budget * cfg.fixedRatio);
    const constellationBudget = Math.floor(budget * cfg.constellationRatio);
    const summaryBudget = Math.floor(budget * cfg.summaryRatio);
    // Note: activeRatio is used by message assembly, not system prompt
    // activeRatio is used by message assembly, not system prompt

    const stableSections = [];
    const dynamicSections = [];

    // ─── Layer 1: Fixed files ─────────────────────────────────────
    const fixedContent = this.#loadFixedFiles(fixedBudget);
    if (fixedContent) {
      stableSections.push(fixedContent);
    }

    // ─── Layer 2: Preamble (if any) ──────────────────────────────
    if (cfg.systemPreamble) {
      stableSections.push(cfg.systemPreamble);
    }

    // ─── Layer 2.5: Cold-start autonomy preamble (Phase 9.4) ─────
    // Injects an English paragraph encouraging the user to try Mímir Autonomy.
    // Active only when engine_meta.autonomy_enabled_at IS NULL (read per-turn
    // so the preamble drops away the moment the user enables autonomy). The
    // file is read per-turn so edits hot-reload without an engine restart.
    // Bypassed for Mímir/cron internal turns (no human in the loop to nudge).
    const _trig = String(options.trigger || '').toLowerCase();
    const _src = String(options.source || '').toLowerCase();
    const _internalTrig = _trig === 'mimir_autonomous' || _trig.startsWith('cron') || _src.startsWith('mimir_');
    if (!_internalTrig && this.#engine && this.#engine.db) {
      try {
        const row = this.#engine.db.prepare(
          "SELECT value FROM engine_meta WHERE key = 'autonomy_enabled_at'"
        ).get();
        const autonomyEnabled = !!(row && row.value);
        if (!autonomyEnabled) {
          const coldPath = resolve('data/system-preamble-cold-start.md');
          if (existsSync(coldPath)) {
            const coldText = readFileSync(coldPath, 'utf-8').trim();
            if (coldText) stableSections.push(coldText);
          }
        }
      } catch {}
    }

    _lap('layers 1-2 done');

    // ─── Pre-launch: Fire Mímir HTTP calls BEFORE BFS ────────────────────────
    // These promises start flying immediately. BFS runs concurrently.
    // By the time BFS finishes, HTTP responses are likely already available.
    const _isMimirTrigger = options.trigger === 'mimir_autonomous'
      || (options.source && options.source.startsWith('mimir_'));

    // Cron turns get a lightweight Mímir path: hard-cap pool to ~30 nodes and
    // skip expensive IR/reasoning calls. The full ~76KB pool render was
    // triggering SQLite LIKE complexity crashes and crowding out the write task
    // that the cron actually exists to perform. Cron agents fetch what they
    // need via tools — they don't need the full semantic context.
    const _isCronTurn = String(options._trigger || '').toLowerCase() === 'cron'
      || String(options.trigger || '').toLowerCase().startsWith('cron');
    const _CRON_POOL_CAP = 30;

    // Check pool cache (3s TTL for rapid turns)
    const _poolCacheKey = '_mimirPoolCache';
    const _poolCacheTTL = 3000;
    const _cachedPool = this[_poolCacheKey];
    const _poolCacheHit = _cachedPool && (Date.now() - _cachedPool.ts) < _poolCacheTTL;

    const _poolPromise = _poolCacheHit
      ? Promise.resolve(_cachedPool.data)
      : mimirFetch(`${MIMIR_URL}/pool`, {}, 20000)
          .then(r => r.ok ? r.json() : null)
          .catch(e => { console.warn('[Mímir] pool fetch failed:', e.message); return null; });

    const _compilePromise = (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 10)
      ? mimirFetch(`${MIMIR_URL}/compile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userMessage.slice(0, 500) }),
        }, 15000).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);

    // Path B: Language skeleton compiler — compile pool nodes into actual sentences
    const _skeletonPromise = (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 5)
      ? mimirFetch(`${MIMIR_URL}/compile_skeleton`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_sentences: 6 }),
        }, 15000).then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);

    // Path C: Reasoning path compiler — BFS paths between semantic anchors
    const _reasoningPathPromise = (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 10)
      ? mimirFetch(`${MIMIR_URL}/reason/paths`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: userMessage.slice(0, 500), max_hops: 5, max_paths: 3 }),
        }, 20000).then(r => r.ok ? r.json() : null).catch(e => {
          console.error('[Mímir] reasoning paths fetch failed:', e.message);
          return null;
        })
      : Promise.resolve(null);

    // Pre-launch: digest + conversations + episodic (parallel with pool/compile)
    const _digestPromise = !_isMimirTrigger
      ? mimirFetch(`${MIMIR_URL}/digest?limit=10`, {}, 15000)
          .then(r => r.ok ? r.json() : null).catch(e => {
            console.error('[Mímir] digest fetch failed:', e.message);
            return null;
          })
      : Promise.resolve(null);

    const _retrievePromise = (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 10)
      ? mimirFetch(`${MIMIR_URL}/retrieve_conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: userMessage.slice(0, 500),
            limit: 5,
            use_activation: true,
            time_decay_days: 60,
          }),
        }, 20000).then(r => r.ok ? r.json() : null).catch(e => {
          console.error('[Mímir] conversations fetch failed:', e.message);
          return null;
        })
      : Promise.resolve(null);

    // Pre-launch: anchor-injection query embedding (Plan B Layer 3.5.2).
    // Hoisted from inline await so BGE encode (~250ms) overlaps pool fetch.
    const _anchorEmbedPromise = (!_isMimirTrigger
        && !_isCronTurn
        && this.#engine
        && this.#engine.db
        && typeof userMessage === 'string'
        && userMessage.trim().length >= 5
        && process.env.ENGINE_ANCHOR_PARALLEL_INJECT !== '0')
      ? Promise.resolve()
          .then(() => this.#engine._embed(userMessage.slice(0, 800)))
          .catch(() => null)
      : Promise.resolve(null);

    // Pre-launch: Episodic Memory Query — topic-segment-based retrieval with cross-activation
    // Date extraction for temporal queries (supports CN/EN formats)
    let _episodicDateFrom = null, _episodicDateTo = null, _episodicKeywords = null;
    if (typeof userMessage === 'string' && userMessage.length > 0) {
      const _now = new Date();
      const _today = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
      const _isoDate = (d) => d.toISOString().slice(0, 10);
      const _addDays = (d, n) => new Date(d.getTime() + n * 86400000);

      // Try absolute date patterns
      const _absPatterns = [
        // 2026-03-25 or 2026/03/25
        /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/,
        // March 25, 2026 or March 25th 2026
        /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i,
        // 03-25 or 03/25 (no year)
        /(?:^|[^\d])(\d{1,2})[-\/](\d{1,2})(?:[^\d]|$)/,
      ];

      const _monthNames = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

      let _dateMatch = null;

      // Full ISO date: 2026-03-25
      const _m1 = userMessage.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (_m1) {
        _dateMatch = new Date(parseInt(_m1[1]), parseInt(_m1[2]) - 1, parseInt(_m1[3]));
      }

      // English month: March 25 or March 25th, 2026
      if (!_dateMatch) {
        const _m2 = userMessage.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i);
        if (_m2) {
          const mon = _monthNames[_m2[1].toLowerCase()];
          const day = parseInt(_m2[2]);
          const year = _m2[3] ? parseInt(_m2[3]) : _now.getFullYear();
          _dateMatch = new Date(year, mon, day);
        }
      }

      // Short date without year: 03-25 or 03/25 (only if not already matched)
      if (!_dateMatch) {
        const _m4 = userMessage.match(/(?:^|[^\d])(\d{1,2})[-\/](\d{1,2})(?:[^\d]|$)/);
        if (_m4) {
          const mon = parseInt(_m4[1]);
          const day = parseInt(_m4[2]);
          if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
            _dateMatch = new Date(_now.getFullYear(), mon - 1, day);
          }
        }
      }

      if (_dateMatch && !isNaN(_dateMatch.getTime())) {
        _episodicDateFrom = _isoDate(_dateMatch);
        _episodicDateTo = _isoDate(_addDays(_dateMatch, 1));
      }

      // Relative date patterns
      if (!_episodicDateFrom) {
        if (/yesterday/.test(userMessage)) {
          _episodicDateFrom = _isoDate(_addDays(_today, -1));
          _episodicDateTo = _isoDate(_today);
        } else if (/day before yesterday/.test(userMessage)) {
          _episodicDateFrom = _isoDate(_addDays(_today, -2));
          _episodicDateTo = _isoDate(_addDays(_today, -1));
        } else if (/last\s*week/.test(userMessage)) {
          const dayOfWeek = _today.getDay() || 7;  // Mon=1..Sun=7
          const lastMonday = _addDays(_today, -dayOfWeek - 6);
          const lastSunday = _addDays(lastMonday, 7);
          _episodicDateFrom = _isoDate(lastMonday);
          _episodicDateTo = _isoDate(lastSunday);
        } else if (/last\s*month/.test(userMessage)) {
          const firstOfThisMonth = new Date(_now.getFullYear(), _now.getMonth(), 1);
          const firstOfLastMonth = new Date(_now.getFullYear(), _now.getMonth() - 1, 1);
          _episodicDateFrom = _isoDate(firstOfLastMonth);
          _episodicDateTo = _isoDate(firstOfThisMonth);
        } else if (/today/.test(userMessage)) {
          _episodicDateFrom = _isoDate(_today);
          _episodicDateTo = _isoDate(_addDays(_today, 1));
        }
      }

      // Extract keywords: significant non-date words from the query
      // Only pass keywords if they seem like content words (>2 chars, not common stop words)
      const _stopWords = new Set(['what', 'when', 'where', 'how', 'did', 'was', 'the', 'about', 'that', 'this', 'with',
        'from', 'have', 'been', 'will', 'can', 'are', 'for', 'and', 'but', 'not', 'you', 'happened']);
      const _words = userMessage.replace(/[^\w]+/g, ' ').split(/\s+/).filter(w =>
        w.length > 2 && !_stopWords.has(w.toLowerCase()) && !/^\d+$/.test(w)
      );
      if (_words.length > 0 && _words.length <= 10) {
        _episodicKeywords = _words.slice(0, 5).join(' ');
      }
    }

    const _episodicPoolSize = typeof this.#irConfig?.episodic?.pool_size === 'number'
      ? this.#irConfig.episodic.pool_size
      : 10;
    const _deepRecallPoolSize = typeof this.#irConfig?.deep_recall?.pool_size === 'number'
      ? this.#irConfig.deep_recall.pool_size
      : 5;
    const _episodicBody = {
      query: userMessage ? userMessage.slice(0, 500) : '',
      session_id: options.sessionId || currentUser.sessionId || '',
      speaker_id: effectiveSpeakerId,
      pool_size: _episodicPoolSize,
      include_messages: true,
      use_star_map: true,
    };
    if (_episodicDateFrom) _episodicBody.date_from = _episodicDateFrom;
    if (_episodicDateTo) _episodicBody.date_to = _episodicDateTo;
    if (_episodicKeywords) _episodicBody.keywords = _episodicKeywords;

    // During Mímir boot (~5s) the reranker is preheating — Mímir returns 503
    // with Retry-After. Rather than skipping episodic entirely, fall back to
    // rerank=false (pure ANN blend, no rerank) so the user still gets context.
    const _fetchEpisodic = async (body) => {
      try {
        const r = await mimirFetch(`${MIMIR_URL}/episodic_query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, 20000);
        if (r.status === 503) {
          return await mimirFetch(`${MIMIR_URL}/episodic_query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, rerank: false }),
          }, 20000).then(r2 => (r2.ok ? r2.json() : null));
        }
        return r.ok ? r.json() : null;
      } catch (e) {
        console.error('[Mímir] episodic query failed:', e.message);
        return null;
      }
    };
    const _episodicPromise = (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 10)
      ? _fetchEpisodic(_episodicBody)
      : Promise.resolve(null);

    // ─── Deep Recall keyword gate ─────────────────────────────────
    // Trigger words like "remember/back then/last week" signal the user is
    // trying to recall something specific from the past — run a second
    // pure-semantic query with zero recency tie-break so old-but-relevant
    // segments can surface even if today's chatter is thematically similar.
    const _deepRecallRe = /remember|recall|back then|earlier|previously|used to|way back|last week|last month|last year|a while ago|some time ago|the other day/i;
    const _deepRecallKeywordHit = !_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 10 && _deepRecallRe.test(userMessage);
    const _deepRecallTriggeredBy = _deepRecallKeywordHit ? 'keyword' : null;
    const _deepRecallBody = _deepRecallKeywordHit ? {
      query: userMessage.slice(0, 500),
      session_id: options.sessionId || currentUser.sessionId || '',
      speaker_id: effectiveSpeakerId,
      pool_size: _deepRecallPoolSize,
      include_messages: true,
      use_star_map: false,  // don't let star map bias deep recall
      deep_recall: true,
    } : null;
    const _deepRecallPromise = _deepRecallKeywordHit
      ? _fetchEpisodic(_deepRecallBody)
      : Promise.resolve(null);

    // ─── Layer 3: Constellation render (three-focus strategy) ────
    // Three-focus strategy: identity + topic + principles
    // Optimized: identity & principles cached (5min TTL), all three run in parallel
    if (!options.skipConstellation && this.#engine) {
      try {
        const parts = [];
        const renderFn = this.#engine.render
          ? (f, o) => this.#engine.render(f, o)
          : (f, o) => this.#engine.renderSync(f, o);

        // P19: split identity into agent-side (soul-core) and user-side
        // (user-profile + wizard-profile-seed) with separate renders + headings.
        // 60/40 budget split — agent identity drives tone/voice continuity,
        // user attrs are reference-only.
        const identityBudgetTotal = Math.floor(constellationBudget * 0.25);
        const agentIdentityBudget = Math.floor(identityBudgetTotal * 0.60);
        const userIdentityBudget = Math.floor(identityBudgetTotal * 0.40);
        const topicBudget = Math.floor(constellationBudget * 0.60);
        const principleBudget = Math.floor(constellationBudget * 0.15);
        const now = Date.now();

        // P19 [C5]: skip soul-core if it carries the pending-design sentinel
        // (post-migration state until user completes Stage 6a). Better to render
        // graceful absence than feed the agent a defaults blob it would treat
        // as authored identity.
        let agentSeeds = ['soul-core', 'milestone-eternal-core-memory'];
        try {
          const sc = this.#engine.db?.prepare(
            "SELECT l2 FROM nodes WHERE id = 'soul-core' AND state = 'active'"
          ).get();
          if (sc && /_status: pending_user_design_/.test(String(sc.l2 || ''))) {
            agentSeeds = ['milestone-eternal-core-memory'];
          }
        } catch { /* sentinel check is best-effort */ }
        const userSeeds = ['user-profile', 'wizard-profile-seed'];

        // Check cache for identity and principles (stable, rarely change)
        const idAgentCache = this._renderCache.get('identity:agent');
        const idUserCache  = this._renderCache.get('identity:user');
        const prCache = this._renderCache.get('principles');
        const idAgentHit = idAgentCache && (now - idAgentCache.ts) < this._RENDER_CACHE_TTL;
        const idUserHit  = idUserCache  && (now - idUserCache.ts)  < this._RENDER_CACHE_TTL;
        const prCacheHit = prCache && (now - prCache.ts) < this._RENDER_CACHE_TTL;

        // Launch all renders in parallel — cache hits resolve instantly
        // Truncate userMessage for topic render — LIKE patterns with huge text
        // (e.g. daily-diary prompts with 24h of conversation injected) hit
        // SQLite's "pattern too complex" limit. 500 chars is plenty for topic seeding.
        const topicFocus = (typeof userMessage === 'string' && userMessage.length > 500)
          ? userMessage.slice(0, 500)
          : userMessage;
        const [agentIdentityResult, userIdentityResult, topicResult, principleResult] = await Promise.all([
          idAgentHit
            ? Promise.resolve(idAgentCache.text)
            : renderFn(agentSeeds, { budget: agentIdentityBudget, maxDepth: 1, maxL2: 3, useVector: false }),
          idUserHit
            ? Promise.resolve(idUserCache.text)
            : renderFn(userSeeds, { budget: userIdentityBudget, maxDepth: 1, maxL2: 3, useVector: false }),
          renderFn(topicFocus, { budget: topicBudget, maxDepth: 2, maxL2: 3 }),
          prCacheHit
            ? Promise.resolve(prCache.text)
            : renderFn('design-principle', { budget: principleBudget, maxDepth: 1, maxL2: 1, useVector: false }),
        ]);

        // 3a-i. ⭐ About Me — agent identity (soul-core + milestone)
        const rawAgentText = typeof agentIdentityResult === 'string' ? agentIdentityResult : agentIdentityResult?.text ?? '';
        const agentText = this.#trimToTokenBudget(rawAgentText, agentIdentityBudget);
        if (agentText.trim()) parts.push(`⭐ About Me (Who I Am)\n\n${agentText}`);
        if (!idAgentHit) this._renderCache.set('identity:agent', { text: rawAgentText, ts: now });

        // 3a-ii. ⭐ About You — user identity (user-profile + wizard-profile-seed)
        const rawUserText = typeof userIdentityResult === 'string' ? userIdentityResult : userIdentityResult?.text ?? '';
        const userText = this.#trimToTokenBudget(rawUserText, userIdentityBudget);
        if (userText.trim()) parts.push(`⭐ About You (My Operator)\n\n${userText}`);
        if (!idUserHit) this._renderCache.set('identity:user', { text: rawUserText, ts: now });

        // 3b. Topic (always fresh, never cached)
        const rawTopicText = typeof topicResult === 'string' ? topicResult : topicResult?.text ?? '';
        const topicText = this.#trimToTokenBudget(rawTopicText, topicBudget);
        if (topicText.trim()) parts.push(`🔍 Constellation: ${userMessage.slice(0, 60)}\n\n${topicText}`);

        // 3c. Principles
        const rawPrincipleText = typeof principleResult === 'string' ? principleResult : principleResult?.text ?? '';
        const principleText = this.#trimToTokenBudget(rawPrincipleText, principleBudget);
        if (principleText.trim()) parts.push(`📐 Principles\n\n${principleText}`);
        if (!prCacheHit) this._renderCache.set('principles', { text: rawPrincipleText, ts: now });

        if (parts.length > 0) {
          dynamicSections.push(`## 🌌 Constellation (Live Render)\n\n${parts.join('\n\n── ──\n\n')}`);
        }
      } catch (err) {
        this.emit('warning', { type: 'constellation_render_error', error: err.message });
      }
    }

    // Observability: per-turn IR+pool snapshot written to JSONL at turn end.
    // Populated progressively as layers compute.
    const _irLogState = {
      pool: [],          // top-15 post-rerank pool nodes
      rerank: null,      // {in, kept, dropped, fallback, query_len}
      poolMeta: null,    // {tick, energy, K_max, L_max, S_max, llm_inject_limit}
      bfsMs: null,       // layer 3 BFS elapsed
      poolMs: null,      // layer 3.5 pool done elapsed
      rerankMs: null,    // rerank call elapsed
    };

    _lap('layer 3 BFS done');
    _irLogState.bfsMs = Date.now() - _t0;
    // ─── Cross-layer node dedup: track which node IDs have been rendered ──
    // Prevents the same node's content from appearing in multiple IR layers,
    // recovering ~8-12% wasted tokens from pool→compiler→reasoning overlap.
    const _renderedNodeIds = new Set();

    // ─── Layer 3.5: Mímir Attention Pool (enriched) ───────────────────────
    // Fetch the attention pool — a scored, diversity-penalized selection of the
    // most relevant nodes for context injection. Falls back to /state if /pool
    // is unavailable.
    let _mimirDetail = null; // hoisted so Layer 3.5.1 can reuse it
    let _compileSnapshot = null; // hoisted for Phase 0.5 training data collection
    this._lastCompileSnapshot = null; // cross-method bridge for training data collection
    // Hoisted: top dynamic (non-permanent) pool node IDs for Layer 3.7 pool-anchored segments.
    // Captured after Layer 3.5 finalizes the pool so we know what the reranker kept.
    let _topDynamicPoolIds = [];

    try {
      const poolRes = await _poolPromise;
      // Cache pool result for rapid turns
      if (!_poolCacheHit && poolRes) {
        this[_poolCacheKey] = { data: poolRes, ts: Date.now() };
      }

      if (poolRes && poolRes.ok && poolRes.nodes && poolRes.nodes.length > 0) {
          // ── Attention Pool path ──
          // R2 dual-track: permanents (identity anchors) always passthrough —
          // they do NOT consume the dynamic LLM budget. Only dynamics are sliced
          // by llmLimit. This ensures permanents don't squeeze knowledge top-K.
          // Daemon sorts dyns-first/perms-last (2026-04-18); we re-assemble
          // perms-first for render so identityLines fill before enrichedLines.
          const _rawPerms = poolRes.nodes.filter(n => n.permanent);
          const _rawDyns  = poolRes.nodes.filter(n => !n.permanent);
          // Cron turns get a hard cap (~30 dynamics) to prevent 76KB pool render.
          // Non-cron: daemon's llm_inject_limit = perm_count + dyn_budget; subtract
          // perm_count to get the dynamic budget (permanents always in on top).
          const _dynBudget = _isCronTurn
            ? _CRON_POOL_CAP
            : Math.max(0, (poolRes.llm_inject_limit || 65) - _rawPerms.length);
          const poolNodes = [..._rawPerms, ..._rawDyns.slice(0, _dynBudget)];
          const llmLimit = poolNodes.length;
          // Capture daemon-level meta for observability log
          _irLogState.poolMeta = {
            tick: poolRes.tick ?? null,
            energy: poolRes.energy ?? null,
            K_max: poolRes.K_max ?? null,
            L_max: poolRes.L_max ?? null,
            S_max: poolRes.S_max ?? null,
            llm_inject_limit: poolRes.llm_inject_limit ?? null,
            perm_count: _rawPerms.length,
            dyn_count: _rawDyns.length,
          };

          // IR fallback: when all dynamic nodes are at or below baseline (no real
          // spike above ambient activation), suppress knowledge/style/episodic/cue
          // sections and let the model answer from identity + general knowledge.
          // Threshold mirrors Mímir's POOL_DYNAMIC_DELTA_THRESHOLD.
          // Lowered 0.003→0.001 after permanent-slot separation (2026-04-17):
          // dynamic deltas settled lower post-separation, 0.003 over-triggered.
          const POOL_DYNAMIC_DELTA_THRESHOLD = 0.001;
          const _dynamicNodes = poolNodes.filter(n => !n.permanent);
          const allDeltasLow = _dynamicNodes.length === 0
            || _dynamicNodes.every(n => (n.delta ?? 0) < POOL_DYNAMIC_DELTA_THRESHOLD);

          // ── Plan E: Query-cosine rerank filter (pool → rerank → IR) ──
          // Drop dynamic nodes whose BGE-M3 embedding is far from the user
          // query, even if their activation is high. Targets meta-principle
          // nodes that would otherwise dominate pool scoring on any query.
          // Permanents bypass; bridge nodes get +0.1 cosine bonus.
          let _rerankStats = null;
          const RERANK_ENABLED = (process.env.POOL_RERANK ?? '1') === '1';
          if (
            RERANK_ENABLED
            && !_isMimirTrigger
            && !_isCronTurn
            && !allDeltasLow
            && _dynamicNodes.length >= 15
            && userMessage
          ) {
            try {
              const FILLER_RE = /^(ok|yes|no|go|sure|right|continue)[\s,.!?]*$/i;
              const trimmed = userMessage.trim();
              let queryText = trimmed;
              if (trimmed.length < 10 || FILLER_RE.test(trimmed)) {
                if (this.#convStore) {
                  try {
                    const now = new Date();
                    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    // Scope rerank filler-expansion to the current session only
                    // (otherwise a foreign user's short reply would expand against
                    // the owner's recent messages).
                    const recent = this.#convStore.getByTimeRange(
                      since.toISOString(), now.toISOString(), 30,
                      { sessionId: currentUser.sessionId }
                    );
                    const recentUser = recent
                      .filter(m => m.role === 'user' && m.content && m.content.length > 3)
                      .slice(-4)
                      .map(m => m.content);
                    if (recentUser.length >= 2) queryText = recentUser.join(' ');
                  } catch {}
                }
              }
              const keepCount = Math.max(20, Math.floor(_dynamicNodes.length * 0.6));
              if (keepCount < _dynamicNodes.length) {
                const bridgeIds = _dynamicNodes
                  .filter(n => (n.bridge || 0) > 0)
                  .map(n => n.id);
                const _rerankT0 = Date.now();
                const rerankRes = await fetch(`${MIMIR_URL}/rerank`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    node_ids: _dynamicNodes.map(n => n.id),
                    query_text: queryText.slice(0, 800),
                    keep_count: keepCount,
                    bridge_ids: bridgeIds,
                    bridge_bonus: 0.1,
                  }),
                  signal: AbortSignal.timeout(8000),
                }).then(r => r.ok ? r.json() : null).catch(e => {
                  console.warn('[Mímir] rerank failed:', e.message);
                  return null;
                });
                if (rerankRes && rerankRes.ok && Array.isArray(rerankRes.kept)) {
                  // R2-a: Sort dynamics by cosine descending (rerankRes.kept order),
                  // not by original pool order. Permanents stay first (identity anchors);
                  // dynamics after them are ranked by query relevance.
                  const keepSet = new Set(rerankRes.kept.map(r => r.id));
                  const cosineRank = new Map(rerankRes.kept.map((r, i) => [r.id, i]));
                  const oldIdx = new Map(poolNodes.map((n, i) => [n.id, i]));
                  const permanents = poolNodes
                    .filter(n => n.permanent)
                    .sort((a, b) => (oldIdx.get(a.id) ?? 1e9) - (oldIdx.get(b.id) ?? 1e9));
                  const dynamics = poolNodes
                    .filter(n => !n.permanent && keepSet.has(n.id))
                    .sort((a, b) => (cosineRank.get(a.id) ?? 1e9) - (cosineRank.get(b.id) ?? 1e9));
                  const filtered = [...permanents, ...dynamics];
                  poolNodes.length = 0;
                  poolNodes.push(...filtered);
                  _rerankStats = {
                    in: _dynamicNodes.length,
                    kept: rerankRes.kept.length,
                    dropped: rerankRes.dropped.length,
                    query_len: queryText.length,
                    fallback: queryText !== trimmed,
                  };
                  _irLogState.rerank = _rerankStats;
                  _irLogState.rerankMs = Date.now() - _rerankT0;
                  try { console.log(`[Mímir/rerank] ${_rerankStats.in}→${_rerankStats.kept} (dropped ${_rerankStats.dropped}${_rerankStats.fallback ? ', fallback query' : ''})`); } catch {}
                  const _topScore = (rerankRes.kept[0] && typeof rerankRes.kept[0].score === 'number')
                    ? Number(rerankRes.kept[0].score.toFixed(3)) : null;
                  const _cutScore = (rerankRes.kept.length > 0 && typeof rerankRes.kept[rerankRes.kept.length - 1].score === 'number')
                    ? Number(rerankRes.kept[rerankRes.kept.length - 1].score.toFixed(3)) : null;
                  liveBus.safeEmit('mimir.rerank', {
                    mode: 'pool',
                    in: _rerankStats.in,
                    kept: _rerankStats.kept,
                    dropped: _rerankStats.dropped,
                    fallback: _rerankStats.fallback,
                    ms: _irLogState.rerankMs,
                    top_score: _topScore,
                    cut_score: _cutScore,
                    query_len: _rerankStats.query_len,
                  });
                }
              }
            } catch (err) {
              this.emit('warning', { type: 'rerank_error', error: err.message });
            }
          }

          // ── Streaming IR v2 ──
          // Replace poolNodes with a session-persistent streaming view: anchors
          // passthrough + dynamic slots carried across turns in first-seen-at
          // order. See engine-output/architecture-research/2026-04-20-streaming-ir-v2-design.md.
          // Config: runtime.streamingIR block in config.json (enabled + tuning params).
          // STREAMING_IR env var overrides config.enabled for quick A/B toggles.
          const streamingCfg = this.#runtimeConfig.streamingIR || {};
          const streamingEnabled = process.env.STREAMING_IR !== undefined
            ? process.env.STREAMING_IR === '1'
            : !!streamingCfg.enabled;
          let _streamingTierRank = null;
          if (streamingEnabled && !_isMimirTrigger && !_isCronTurn) {
            try {
              let streamingState = this.#streamingIR.get(sessionId);
              if (!streamingState) {
                streamingState = new StreamingIRState(streamingCfg);
                this.#streamingIR.set(sessionId, streamingState);
              }
              const { orderedNodes, stats } = streamingState.update(
                poolNodes, Date.now(), poolRes.tick ?? null
              );
              // Build tier rank by A desc among dynamics — render order is
              // first_seen_at (KV cache friendly), but tier ⭐/◆/◇ must still
              // reflect relevance-by-activation per design §render.
              _streamingTierRank = new Map();
              const dynById = orderedNodes.filter(n => !n.permanent);
              [...dynById]
                .sort((a, b) => (b.activation ?? 0) - (a.activation ?? 0))
                .forEach((n, i) => _streamingTierRank.set(n.id, i));
              poolNodes.length = 0;
              poolNodes.push(...orderedNodes);
              _irLogState.streaming = stats;
              try {
                console.log(`[Mímir/streaming] turn=${stats.turn} anchors=${stats.anchor_count} dyn=${stats.dynamic_count} promoted=${stats.promoted} evicted=${stats.evicted} swapped=${stats.swapped ?? 0} cooldown=${stats.cooldown_size ?? 0} churn=${(stats.churn_rate * 100).toFixed(0)}%`);
              } catch {}
              liveBus.safeEmit('mimir.streaming', {
                turn: stats.turn, anchors: stats.anchor_count, dyn: stats.dynamic_count,
                promoted: stats.promoted, evicted: stats.evicted, swapped: stats.swapped ?? 0,
                cooldown: stats.cooldown_size ?? 0, churn: Number((stats.churn_rate * 100).toFixed(0)),
              });
            } catch (err) {
              this.emit('warning', { type: 'streaming_ir_error', error: err.message });
            }
          }

          // Phase 5: Three-channel IR routing — split pool by sa_channel into
          // knowledge (+fused) / language / scaffold buckets, render as separate
          // IR sections. Feature flag allows single-env rollback.
          const IR_CHANNEL_ROUTING = (process.env.IR_CHANNEL_ROUTING ?? '1') === '1';
          // Dynamic per-channel line cap: min(20% of pool, ceiling 10)
          const channelLineCap = Math.max(3, Math.min(Math.floor(poolNodes.length * 0.2), 10));

          // Phase 6: node_type secondary routing. Within the pool, route nodes
          // to IR layers by their semantic role (node_type), not just how they
          // activated (sa_channel). Principles → Activated Principles. Episodic
          // types → Activated Episodes. Style types → Style Guidance (augments
          // tag-based detection). Knowledge types stay in sa_channel routing.
          const NODE_TYPE_ROUTING = (process.env.NODE_TYPE_ROUTING ?? '1') === '1';
          const NT_PRINCIPLE = new Set(['principle']);
          const NT_EPISODIC = new Set([
            'diary', 'introspection', 'conversation-insight',
            'interaction', 'milestone', 'decision',
          ]);
          const NT_STYLE = new Set(['social-rule', 'language-template']);
          const NT_IDENTITY = new Set(['identity', 'relationship']);
          const PRINCIPLE_TOTAL_CAP = 5;
          const PRINCIPLE_ZONE_CAP = 2;
          const EPISODIC_TOTAL_CAP = 6;
          const EPISODIC_ZONE_CAP = 2;

          // Build _mimirDetail compatible structure for Layer 3.5.1
          // Preserve zone and edges for reasoning layer (was previously lost)
          _mimirDetail = {
            top_nodes: poolNodes.map(n => ({
              id: n.id,
              activation: n.activation,
              zone: n.zone,
              edges: n.edges || [],
            })),
          };

          // Derive zone summary from pool nodes
          const zoneCounts = {};
          for (const n of poolNodes) {
            const z = n.zone !== undefined ? n.zone : -1;
            zoneCounts[z] = (zoneCounts[z] || 0) + 1;
          }
          const topZones = Object.entries(zoneCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([z, cnt]) => `Z${z}(${cnt} in pool)`)
            .join(', ');

          // Enrich pool nodes with L0 content from star map
          // Three-way IR Tag Routing (node-type level):
          //   1. Identity nodes (permanent) → Reserved identity channel (never competed)
          //   2. Behavior nodes (SI/tool-use/etc.) → Style Guidance
          //   3. Knowledge nodes → Attention Pool (competitive)
          // Phase 5: IR Channel Routing (sa_channel level, within knowledge path):
          //   knowledge + fused → Attention Pool (main knowledge section)
          //   language          → Rhetorical Cues (style/association)
          //   scaffold          → Procedural Cues (structure/dependency)
          let identityLines = [];
          let enrichedLines = [];
          let languageLines = [];
          let scaffoldLines = [];
          let behaviorGuidanceLines = [];
          let principleLines = [];
          let episodicLines = [];
          // Phase 5.1: Zone-level diversification to prevent single-cluster monopoly.
          //   L channel: saturated clusters (e.g. si-comfort, si-lang-*) share one zone,
          //   filling all Rhetorical slots with redundant nodes. Per-zone cap forces
          //   the channel to surface nodes from multiple zones.
          //   Style Guidance: no prior cap — 60 social-intelligence nodes could all
          //   land here. Apply total cap + per-zone diversification.
          const L_ZONE_CAP = 2;
          const S_ZONE_CAP = 3;
          const STYLE_GUIDANCE_TOTAL_CAP = 6;
          const STYLE_GUIDANCE_ZONE_CAP = 2;
          const languageZoneCounts = {};
          const scaffoldZoneCounts = {};
          const behaviorZoneCounts = {};
          const principleZoneCounts = {};
          const episodicZoneCounts = {};
          const languageDropped = [];
          const scaffoldDropped = [];
          const behaviorDropped = [];
          const principleDropped = [];
          const episodicDropped = [];
          // Relative rank among knowledge-pool nodes. Absolute thresholds emitted
          // ⭐ only ~5.7% of turns, so the tier carried almost no signal. Rank-based
          // keeps the top/mid/weak distinction informative at any activation level.
          let knowledgePoolRank = 0;
          // Force top-N dynamic (non-permanent) nodes to precision='full' regardless
          // of activation. Targets node-fragmentation hallucinations: the most
          // relevant nodes per turn often sit at medium precision (single-line
          // emoji template) which strips the body content the model needs to
          // ground copy. Permanents already get full; top-N adds the highest-
          // signal dynamics. OSS lacks streaming IR — poolNodes is rerank-ordered
          // (cosine desc) after Plan E, so first-N non-permanent is the right pick.
          const TOP_N_FORCE_FULL = Number(process.env.POOL_TOP_N_FORCE_FULL ?? 7);
          const _topNFullSet = new Set();
          if (TOP_N_FORCE_FULL > 0) {
            const _dyns = poolNodes.filter(n => !n.permanent);
            for (let i = 0; i < Math.min(TOP_N_FORCE_FULL, _dyns.length); i++) {
              _topNFullSet.add(_dyns[i].id);
            }
          }
          if (this.#engine && this.#engine.db) {
            try {
              const ids = poolNodes.map(n => n.id);
              const placeholders = ids.map(() => '?').join(',');
              const { sql: _ownSqlPool, params: _ownPPool } = this.#engine._ownerSqlClause();
              const rows = this.#engine.db.prepare(
                `SELECT id, l0, l1, l2, tags, node_type, subkind, superseded_at, superseded_by, created_at, updated_at, deprecated_at FROM nodes WHERE id IN (${placeholders}) AND state = 'active' AND deprecated_at IS NULL${_ownSqlPool}`
              ).all(...ids, ..._ownPPool);
              const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));

              for (const n of poolNodes) {
                const row = rowMap[n.id];
                const scorePct = (n.score * 100).toFixed(1);
                const actPct = (n.activation * 100).toFixed(1);
                const zone = n.zone !== undefined ? `Z${n.zone}` : '';

                // Check if this node belongs to a behavior domain
                let nodeTags = [];
                if (row?.tags) {
                  try { nodeTags = JSON.parse(row.tags); } catch { nodeTags = row.tags.split(',').map(t => t.trim()); }
                  if (!Array.isArray(nodeTags)) nodeTags = [];
                }
                const isBehaviorNode = nodeTags.some(t => BEHAVIOR_DOMAIN_TAGS.has(t));
                const isKnowledgeNode = nodeTags.length === 0 || nodeTags.some(t => !BEHAVIOR_DOMAIN_TAGS.has(t));
                const isMixed = isBehaviorNode && isKnowledgeNode;

                if (row) {
                  const createdDay = row.created_at ? row.created_at.slice(0, 10) : '';
                  const updatedDay = row.updated_at ? row.updated_at.slice(0, 10) : '';
                  const dateTag = createdDay
                    ? (updatedDay && updatedDay !== createdDay ? ` ${createdDay} ↻${updatedDay}` : ` ${createdDay}`)
                    : '';
                  const nodeType = row.node_type || 'knowledge';
                  let precision = selectPrecision(n.activation, nodeType);
                  if (!n.permanent && _topNFullSet.has(n.id) && precision !== 'full') {
                    precision = 'full';
                  }
                  const renderedContent = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, precision);
                  const supersededTag = row.superseded_at
                    ? ` ⚠️SUPERSEDED${row.superseded_by ? ' by:' + row.superseded_by : ''}`
                    : '';

                  const zKey = n.zone !== undefined ? n.zone : -1;
                  // Phase 6: node_type routing takes precedence over sa_channel
                  // routing for principle/episodic/style/identity semantic types.
                  const isPrinciple = NODE_TYPE_ROUTING && NT_PRINCIPLE.has(nodeType);
                  const isEpisodic  = NODE_TYPE_ROUTING && NT_EPISODIC.has(nodeType);
                  const isStyleType = NODE_TYPE_ROUTING && NT_STYLE.has(nodeType);
                  const isIdentityType = NODE_TYPE_ROUTING && NT_IDENTITY.has(nodeType);
                  if (n.permanent) {
                    // Identity nodes → Reserved channel (independent budget, never squeezed)
                    // selectPrecision already returns 'full' for identity/milestone
                    identityLines.push(`  - 📌[score=${scorePct} act=${actPct} ${zone}${dateTag}] **${n.id}**: ${renderedContent}`);
                    _renderedNodeIds.add(n.id);
                  } else if (isIdentityType) {
                    // Phase 6: identity/relationship typed nodes → Identity anchors
                    // (augments permanent-flag detection for non-soul-core identity nodes)
                    identityLines.push(`  - 📌[score=${scorePct} act=${actPct} ${zone}${dateTag}] **${n.id}**: ${renderedContent}`);
                    _renderedNodeIds.add(n.id);
                  } else if (isPrinciple) {
                    // Phase 6: principle nodes → Activated Principles section (cap + zone diversify)
                    const pCount = principleZoneCounts[zKey] || 0;
                    if (principleLines.length < PRINCIPLE_TOTAL_CAP && pCount < PRINCIPLE_ZONE_CAP) {
                      const principleRendered = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, precision);
                      principleLines.push(`  - ⚖️[score=${scorePct} act=${actPct}${zone ? ' ' + zone : ''}${dateTag}] **${n.id}**: ${principleRendered}${supersededTag}`);
                      principleZoneCounts[zKey] = pCount + 1;
                      _renderedNodeIds.add(n.id);
                    } else {
                      principleDropped.push(n.id);
                    }
                  } else if (isEpisodic) {
                    // Phase 6: episodic types → Activated Episodes section (cap + zone diversify)
                    const eCount = episodicZoneCounts[zKey] || 0;
                    if (episodicLines.length < EPISODIC_TOTAL_CAP && eCount < EPISODIC_ZONE_CAP) {
                      const epRendered = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, precision);
                      episodicLines.push(`  - 📔[score=${scorePct} act=${actPct}${zone ? ' ' + zone : ''}${dateTag}] **${n.id}**: ${epRendered}${supersededTag}`);
                      episodicZoneCounts[zKey] = eCount + 1;
                      _renderedNodeIds.add(n.id);
                    } else {
                      episodicDropped.push(n.id);
                    }
                  } else if (isStyleType || (isBehaviorNode && !isMixed)) {
                    // Phase 6: social-rule/language-template typed nodes + tag-based
                    // pure behavior nodes both funnel into Style Guidance (with caps).
                    const bCount = behaviorZoneCounts[zKey] || 0;
                    if (behaviorGuidanceLines.length < STYLE_GUIDANCE_TOTAL_CAP && bCount < STYLE_GUIDANCE_ZONE_CAP) {
                      const guidance = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, 'medium');
                      behaviorGuidanceLines.push(`  - ${guidance}`);
                      behaviorZoneCounts[zKey] = bCount + 1;
                      _renderedNodeIds.add(n.id);
                    } else {
                      behaviorDropped.push(n.id);
                    }
                  } else {
                    // Knowledge nodes + Mixed nodes → Attention Pool (competitive, dynamic)
                    const chTag = n.sa_channel && n.sa_channel !== 'fused' ? ` ch:${n.sa_channel}` : '';
                    // Tier by relative rank (top 3 = ⭐, next 5 = ◆, rest = ◇).
                    // Under STREAMING_IR, render order is first_seen_at but tier
                    // must reflect activation — look up precomputed A-rank.
                    const effectiveRank = _streamingTierRank?.get(n.id) ?? knowledgePoolRank;
                    const tier = effectiveRank < 3 ? '⭐' : (effectiveRank < 8 ? '◆' : '◇');
                    knowledgePoolRank++;
                    const line = `  - ${tier} [score=${scorePct} act=${actPct}${zone ? ' ' + zone : ''}${dateTag}${chTag}] **${n.id}**: ${renderedContent}${supersededTag}`;
                    // Phase 5: Route by sa_channel into L/S buckets when flag enabled.
                    // knowledge/fused/unknown → main attention pool; language → Rhetorical; scaffold → Procedural.
                    // Phase 5.1: Per-zone cap in L/S to prevent single-cluster monopoly.
                    let skipRender = false;
                    if (IR_CHANNEL_ROUTING && n.sa_channel === 'language') {
                      const lCount = languageZoneCounts[zKey] || 0;
                      if (languageLines.length < channelLineCap && lCount < L_ZONE_CAP) {
                        languageLines.push(line);
                        languageZoneCounts[zKey] = lCount + 1;
                      } else {
                        skipRender = true;
                        languageDropped.push(n.id);
                      }
                    } else if (IR_CHANNEL_ROUTING && n.sa_channel === 'scaffold') {
                      const sCount = scaffoldZoneCounts[zKey] || 0;
                      if (scaffoldLines.length < channelLineCap && sCount < S_ZONE_CAP) {
                        scaffoldLines.push(line);
                        scaffoldZoneCounts[zKey] = sCount + 1;
                      } else {
                        skipRender = true;
                        scaffoldDropped.push(n.id);
                      }
                    } else {
                      enrichedLines.push(line);
                    }
                    if (!skipRender) {
                      _renderedNodeIds.add(n.id);
                      // Mixed nodes also contribute to style guidance (with same cap)
                      if (isMixed) {
                        const bCount = behaviorZoneCounts[zKey] || 0;
                        if (behaviorGuidanceLines.length < STYLE_GUIDANCE_TOTAL_CAP && bCount < STYLE_GUIDANCE_ZONE_CAP) {
                          const guidance = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, 'medium');
                          behaviorGuidanceLines.push(`  - ${guidance}`);
                          behaviorZoneCounts[zKey] = bCount + 1;
                        }
                      }
                    }
                  }
                } else {
                  enrichedLines.push(`  - [score=${scorePct} act=${actPct}] ${n.id}`);
                  _renderedNodeIds.add(n.id);
                }
              }
            } catch {
              enrichedLines = poolNodes.map(n =>
                `  - ${n.id} (score=${(n.score * 100).toFixed(0)})`
              );
            }
          } else {
            enrichedLines = poolNodes.map(n =>
              `  - ${n.id} (score=${(n.score * 100).toFixed(0)})`
            );
          }

          // Inject Style Guidance from behavior nodes BEFORE attention pool
          // (style instructions should come early in system prompt)
          if (behaviorGuidanceLines.length > 0 && !allDeltasLow) {
            dynamicSections.push(
              `## 🎭 Style Guidance (from social-intelligence nodes)\n` +
              `The following communication principles were activated by the conversation context. ` +
              `Let these naturally inform your tone, warmth, and expression — do not quote them directly.\n` +
              behaviorGuidanceLines.join('\n')
            );
          }

          // Phase 6: Activated Principles — principle-typed nodes rendered as
          // binding axioms ahead of the evidence pool.
          if (NODE_TYPE_ROUTING && principleLines.length > 0 && !allDeltasLow) {
            dynamicSections.push(
              `## 📐 Activated Principles (from activation state)\n` +
              `Principle-class nodes surfaced by the conversation. Treat these as load-bearing axioms — decisions should stay consistent with them.\n` +
              principleLines.join('\n')
            );
          }

          // L3-4: Compilation Principles — teach the compiler how to use the pool.
          // Inserted once here; applies to both single and two_pass paths.
          if (!allDeltasLow) {
            dynamicSections.push(
              `## 📘 Compilation Principles\n` +
              `- Information priority: Reasoning Paths > Attention Pool top nodes (⭐) > Style Guidance > Episodic Memory\n` +
              `- Tier symbols (relative ranking inside the pool, not an absolute score): ⭐ top 3 (most relevant) · ◆ next 5 (moderately relevant) · ◇ the rest (weakly relevant, often SA-spread aftershocks)\n` +
              `- Relevance judgment: ⭐/◆ only indicate pool rank, not guaranteed topical fit. First check whether the top nodes are semantically aligned with the user's question — use them when they fit, ignore them when they do not\n` +
              `- Counter-example: user asks "what's the weather today" while the top ⭐ is "user likes coffee". Do not force "according to my records you like coffee" — the node is unrelated; just say "I don't have weather data on hand"\n` +
              `- Composition freedom: you do not need to mention every node in the context. Pick the 3-5 that genuinely fit the user's question and weave them into the reply. The star map is raw material, not a script — use it to write warm, logical, human-sounding prose; repeated content should appear only once\n` +
              `- Honesty + deep retrieval: if the top ⭐/◆ all miss the point, first check whether this is a memory-recall question (user asking about prior work / decisions / project state / "do you remember X"):\n` +
              `  · Yes → default to one graph_lookup(query, k=15) (~19s, the primary LLM filters the BGE+SA pool); if still empty, one memory_search; only fall back to "I'm not sure" after both come up empty. Hard cap 3 retrieval rounds per turn — do not loop\n` +
              `  · No (casual chitchat with no recall intent) → just say "I'm not sure" instead of fabricating; do not burn ~19s on small talk`
            );
          }

          // Identity nodes have their own reserved section — never squeezed by knowledge competition
          const identitySection = identityLines.length > 0
            ? `Identity anchors (permanent, reserved):\n${identityLines.join('\n')}\n`
            : '';

          const droppedTotal = languageDropped.length + scaffoldDropped.length + behaviorDropped.length
                             + principleDropped.length + episodicDropped.length;
          const diversifyTag = droppedTotal > 0
            ? ` | Diversified: L-${languageDropped.length} S-${scaffoldDropped.length} B-${behaviorDropped.length} P-${principleDropped.length} E-${episodicDropped.length} (same-zone excess dropped)`
            : '';
          const typeRoutingTag = NODE_TYPE_ROUTING
            ? ` | TypeRoute: P=${principleLines.length} E=${episodicLines.length}`
            : '';
          if (allDeltasLow) {
            // IR fallback: no dynamic node spiked above baseline. Render identity
            // anchors only and signal the model to answer from general knowledge.
            const fallbackTag = ` | FALLBACK: no dynamic candidates exceeded baseline (Δ<${POOL_DYNAMIC_DELTA_THRESHOLD})`;
            dynamicSections.push(
              `## 🧠 Mímir Attention Pool (tick ${poolRes.tick})\n` +
              `Pool: ${poolRes.pool_size} candidates → ${poolNodes.length} injected${fallbackTag}\n` +
              identitySection +
              `(No dynamic candidates exceeded baseline — answer from identity + general knowledge, or call graph_lookup(query) for focused deep retrieval if you think the graph has relevant nodes.)`
            );
            try { console.log(`[Mímir/IR] fallback active: ${_dynamicNodes.length} dynamic nodes, all Δ<${POOL_DYNAMIC_DELTA_THRESHOLD}`); } catch {}
          } else {
            dynamicSections.push(
              `## 🧠 Mímir Attention Pool (tick ${poolRes.tick})\n` +
              `Pool: ${poolRes.pool_size} candidates → ${poolNodes.length} injected (pressure: ${poolRes.pool_pressure || 0}) | Zones: ${topZones}` +
              (poolRes.pool_channel_compilation ? ` | Channels: K=${poolRes.pool_channel_compilation.knowledge||0} L=${poolRes.pool_channel_compilation.language||0} S=${poolRes.pool_channel_compilation.scaffold||0}` : '') +
              typeRoutingTag + diversifyTag + `\n` +
              identitySection +
              `Attention pool (scored, diversified):\n${enrichedLines.join('\n')}`
            );

            // Phase 5: Three-channel IR — Rhetorical Cues (Language) / Procedural Cues (Scaffold).
            // These sections surface associative and structural signals that would
            // otherwise be buried in the main pool, giving them dedicated attention.
            if (IR_CHANNEL_ROUTING && languageLines.length > 0) {
              dynamicSections.push(
                `## 🗣 Rhetorical Cues (Language channel)\n` +
                `Associative / parallel / inspirational nodes — let these shape tone, phrasing, and analogies without quoting directly.\n` +
                languageLines.join('\n')
              );
            }
            if (IR_CHANNEL_ROUTING && scaffoldLines.length > 0) {
              dynamicSections.push(
                `## 🔗 Procedural Cues (Scaffold channel)\n` +
                `Structural / dependency / enablement nodes — surface prerequisites, ordering, and containment relations relevant to the task.\n` +
                scaffoldLines.join('\n')
              );
            }

            // Phase 6: Activated Episodes — diary/introspection/conversation-insight
            // /interaction/milestone/decision typed nodes. These are temporally
            // situated experiences, not general knowledge claims.
            if (NODE_TYPE_ROUTING && episodicLines.length > 0) {
              dynamicSections.push(
                `## 📔 Activated Episodes (from activation state)\n` +
                `Episodic traces surfaced by the conversation — past decisions, reflections, and interactions. Use as context, not directives.\n` +
                episodicLines.join('\n')
              );
            }
          }
          // Capture top dynamic IDs for Layer 3.7 pool-anchored segment lookup.
          // Skip permanents (identity anchors have old created_at that would pull irrelevant segments).
          _topDynamicPoolIds = poolNodes
            .filter(n => !n.permanent)
            .slice(0, 8)
            .map(n => n.id);
          // Pool snapshot for JSONL observability log (top 15 final-ordered nodes).
          // poolNodes only exists in this /pool branch; fallback /state path skips.
          _irLogState.pool = poolNodes.slice(0, 15).map(n => ({
            id: n.id,
            score: n.score ?? null,
            delta: n.delta ?? null,
            baseline: n.baseline ?? null,
            cosine: n.cosine ?? null,
            activation: n.activation ?? null,
            mass: n.mass ?? null,
            bridge: n.bridge ?? null,
            permanent: !!n.permanent,
            sa_channel: n.sa_channel ?? null,
            zone: n.zone ?? null,
          }));
        } else {
          // ── Fallback to /state ──
          const detail = await fetch(`${MIMIR_URL}/state`, {
            signal: AbortSignal.timeout(1000),
          }).then(r => r.ok ? r.json() : null).catch(() => null);

          _mimirDetail = detail;
          if (detail && detail.top_nodes && detail.top_nodes.length > 0) {
            const topZones = (detail.top_zones || []).slice(0, 4)
              .map(z => `Z${z.zone}(${z.size} nodes, ${(z.mean_activation * 100).toFixed(1)}%)`)
              .join(', ');

            const topSlice = detail.top_nodes.slice(0, 12);
            let enrichedLines = [];
            let fallbackBehaviorLines = [];
            if (this.#engine && this.#engine.db) {
              try {
                const ids = topSlice.map(n => n.id);
                const placeholders = ids.map(() => '?').join(',');
                const { sql: _ownSqlTop, params: _ownPTop } = this.#engine._ownerSqlClause();
                const rows = this.#engine.db.prepare(
                  `SELECT id, l0, l1, l2, tags, node_type, subkind, created_at FROM nodes WHERE id IN (${placeholders}) AND state = 'active'${_ownSqlTop}`
                ).all(...ids, ..._ownPTop);
                const rowMap = Object.fromEntries(rows.map(r => [r.id, r]));
                const fallbackKnowledgeSlice = [];
                for (const n of topSlice) {
                  const row = rowMap[n.id];
                  let fallbackTags = [];
                if (row?.tags) {
                  try { fallbackTags = JSON.parse(row.tags); } catch { fallbackTags = row.tags.split(',').map(t => t.trim()); }
                  if (!Array.isArray(fallbackTags)) fallbackTags = [];
                }
                const isBehavior = fallbackTags.some(t => BEHAVIOR_DOMAIN_TAGS.has(t));
                const isKnowledge = fallbackTags.length === 0 || fallbackTags.some(t => !BEHAVIOR_DOMAIN_TAGS.has(t));
                const isMixedFb = isBehavior && isKnowledge;
                  if (isBehavior) {
                    const content = row?.l1 || row?.l0 || '';
                    if (content) fallbackBehaviorLines.push(`  - **${n.id}**: ${content.slice(0, 200)}`);
                  }
                  if (!isBehavior || isMixedFb) {
                    // Pure knowledge + Mixed → knowledge compilation
                    fallbackKnowledgeSlice.push(n);
                  }
                }
                enrichedLines = fallbackKnowledgeSlice.map(n => {
                  const row = rowMap[n.id];
                  const pct = (n.activation * 100).toFixed(1);
                  if (row) {
                    const nodeType = row.node_type || 'knowledge';
                    const precision = selectPrecision(n.activation, nodeType);
                    const content = renderNode({ id: n.id, l0: row.l0, l1: row.l1, l2: row.l2, node_type: nodeType }, precision);
                    return `  - [${pct}%] **${n.id}**: ${content}`;
                  }
                  return `  - [${pct}%] ${n.id}`;
                });
              } catch {
                enrichedLines = topSlice.map(n =>
                  `  - ${n.id} (${(n.activation * 100).toFixed(0)}%)`
                );
              }
            } else {
              enrichedLines = topSlice.map(n =>
                `  - ${n.id} (${(n.activation * 100).toFixed(0)}%)`
              );
            }

            // Render Style Guidance from behavior nodes (fallback path)
            if (fallbackBehaviorLines.length > 0) {
              dynamicSections.push(
                `## 🎭 Style Guidance\n` +
                `${fallbackBehaviorLines.join('\n')}`
              );
            }

            dynamicSections.push(
              `## 🧠 Mímir State\n` +
              `Zones: ${topZones}\n` +
              `Top activations (with content):\n${enrichedLines.join('\n')}`
            );
          }
        }
    } catch (e) {
      console.error('[Mímir] Layer 3.5 failed:', e.message);
    }

    _lap('layer 3.5 pool done');
    _irLogState.poolMs = Date.now() - _t0;
    // ─── Layer 3.5.1: Automatic Reasoning from Activation State ─────────────
    // For Founder (non-Mímir) sessions, run reasoning algorithms based on the
    // current activation pattern and inject structured results into the prompt.
    try {
      if (!_isMimirTrigger && !_isCronTurn && userMessage && userMessage.length >= 20 && _mimirDetail) {
        const topNodes = (_mimirDetail.top_nodes || []).slice(0, 12);
        const highNodes = topNodes.filter(n => n.activation > 0.3);
        const reasoningTimeout = AbortSignal.timeout(8000);

        // Determine which zones the highly-activated nodes belong to
        const highZones = new Set(highNodes.map(n => n.zone));

        // Determine reasoning mode
        let reasoningResult = null;

        if (highNodes.length >= 2 && highZones.size >= 2) {
          // Two+ highly activated nodes in DIFFERENT zones → analogy
          const [a, b] = highNodes.slice(0, 2);
          try {
            const res = await fetch(`${MIMIR_URL}/reason/analogy`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ node_a: a.id, node_b: b.id }),
              signal: reasoningTimeout,
            }).then(r => r.ok ? r.json() : null);
            if (res) {
              const score = res.combined_score ?? res.similarity ?? 0;
              const structural = res.structural_similarity ?? 0;
              const semantic = res.semantic_similarity ?? 0;
              reasoningResult = {
                type: 'analogy',
                summary: `${a.id} ↔ ${b.id}\nSimilarity: ${(score*100).toFixed(0)}% (structural=${(structural*100).toFixed(0)}%, semantic=${(semantic*100).toFixed(0)}%)`,
              };
            }
          } catch (e) { console.warn('[Mímir] analogy reasoning failed:', e.message); }
        } else if (highNodes.length >= 1) {
          // Check for supports edges
          const hasSupports = highNodes.some(n =>
            n.edges && n.edges.some(e => e.type === 'supports')
          );
          // Check for question words → abduction
          const questionPattern = /why|how|what\s+caused|what\s+made/i;
          if (questionPattern.test(userMessage)) {
            // Abduction from highest activated node
            try {
              const res = await fetch(`${MIMIR_URL}/reason/abduction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conclusion_id: highNodes[0].id }),
                signal: reasoningTimeout,
              }).then(r => r.ok ? r.json() : null);
              if (res && res.explanations) {
                const top = res.explanations.slice(0, 5).map(e =>
                  `  - ${e.node_id}: score=${e.score?.toFixed(3)} (depth=${e.depth})`
                ).join('\n');
                reasoningResult = {
                  type: 'abduction',
                  summary: `Explaining: ${highNodes[0].id}\nTop explanations:\n${top}`,
                };
              }
            } catch (e) { console.warn('[Mímir] abduction reasoning failed:', e.message); }
          } else if (hasSupports) {
            // Deduction from top 3 premises
            const premises = highNodes.slice(0, 3).map(n => n.id);
            try {
              const res = await fetch(`${MIMIR_URL}/reason/deduction`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ premises }),
                signal: reasoningTimeout,
              }).then(r => r.ok ? r.json() : null);
              if (res && res.paths) {
                const top = res.paths.slice(0, 5).map(p =>
                  `  - ${p.path_labels?.slice(0, 3).join(' → ')}${p.path_labels?.length > 3 ? '…' : ''} (strength=${p.strength})`
                ).join('\n');
                reasoningResult = {
                  type: 'deduction',
                  summary: `From: ${premises.join(', ')}\n${res.n_paths} deduction paths found:\n${top}`,
                };
              }
            } catch (e) { console.warn('[Mímir] deduction reasoning failed:', e.message); }
          }
        }

        if (reasoningResult) {
          // Truncate to ~500 tokens (rough estimate: 1 token ≈ 4 chars)
          let text = reasoningResult.summary;
          if (text.length > 2000) text = text.slice(0, 2000) + '…';
          const label = reasoningResult.type === 'analogy' ? 'Analogy'
            : reasoningResult.type === 'deduction' ? 'Deduction'
            : 'Abduction';
          dynamicSections.push(
            `## 🔬 Mímir Reasoning — ${label}\n${text}`
          );
        }
      }
    } catch (e) {
      console.error('[Mímir] Layer 3.5.1 reasoning failed:', e.message);
    }

    _lap('layer 3.5.1 reasoning done');

    // ─── Layer 3.5.2: Parallel Anchor Injection (Plan B) ──────────────────
    // Anchors compete poorly in the SA attention pool: POOL_DELTA_GATE
    // suppresses baseline-tracking nodes, and the IR fallback path only
    // surfaces PERMANENT_SLOT_IDS. This path runs a direct cosine KNN of the
    // user message against `subkind='anchor'` nodes (engine-self-knowledge
    // owner) and injects top-3 hits via the same Layer 3 wrapper used by the
    // pool. Independent of pool state; deduped against _renderedNodeIds so
    // we never double-render an anchor the pool already showed.
    if (!_isMimirTrigger
        && !_isCronTurn
        && this.#engine
        && this.#engine.db
        && typeof userMessage === 'string'
        && userMessage.trim().length >= 5
        && process.env.ENGINE_ANCHOR_PARALLEL_INJECT !== '0') {
      const _anchorPT0 = Date.now();
      try {
        const ANCHOR_COSINE_FLOOR = 0.45;
        const ANCHOR_TOP_K = 3;
        const queryEmbBuf = await _anchorEmbedPromise;
        if (!queryEmbBuf) throw new Error('anchor_embed_unavailable');
        // vec0 has no JOIN/WHERE filtering — KNN top-50 over 3927 nodes rarely
        // contains the 25 anchor nodes (0.6% of corpus). Scan anchors directly:
        // fetch all 25 (rowid, embedding) pairs and compute cosine in JS.
        const anchorRows = this.#engine.db.prepare(
          `SELECT n.id, n.l0, n.l1, n.l2, n.created_at, n.subkind, n.node_type, ne.embedding
             FROM nodes n
             JOIN node_rowids nr ON nr.node_id = n.id
             JOIN node_embeddings ne ON ne.id = nr.rowid
            WHERE n.owner_id IN ('engine-self-knowledge', 'engine-experiential')
              AND (
                (n.subkind = 'anchor' AND n.state = 'active')
                OR (n.subkind = 'exploration_anchor' AND n.state IN ('active', 'dormant'))
              )
              AND n.deprecated_at IS NULL`
        ).all();
        // Decode query embedding once
        const qF32 = new Float32Array(queryEmbBuf.buffer, queryEmbBuf.byteOffset, queryEmbBuf.byteLength / 4);
        let qNorm = 0;
        for (let i = 0; i < qF32.length; i++) qNorm += qF32[i] * qF32[i];
        qNorm = Math.sqrt(qNorm);
        const scored = [];
        let _anchorTopCosSeen = 0;
        for (const a of anchorRows) {
          const aBuf = a.embedding;
          const aF32 = new Float32Array(aBuf.buffer, aBuf.byteOffset, aBuf.byteLength / 4);
          let dot = 0, aNorm = 0;
          for (let i = 0; i < aF32.length; i++) { dot += qF32[i] * aF32[i]; aNorm += aF32[i] * aF32[i]; }
          aNorm = Math.sqrt(aNorm);
          const cosSim = (qNorm > 0 && aNorm > 0) ? dot / (qNorm * aNorm) : 0;
          if (cosSim > _anchorTopCosSeen) _anchorTopCosSeen = cosSim;
          scored.push({ cosSim, row: a });
        }
        scored.sort((x, y) => y.cosSim - x.cosSim);
        const _anchorHits = [];
        for (const s of scored) {
          if (s.cosSim < ANCHOR_COSINE_FLOOR) break;
          if (_renderedNodeIds.has(s.row.id)) continue;
          _anchorHits.push(s);
          if (_anchorHits.length >= ANCHOR_TOP_K) break;
        }
        if (_anchorHits.length === 0) {
          try { console.log(`[Mímir/anchor-parallel] hits=0 anchors_scanned=${anchorRows.length} top_cos_seen=${_anchorTopCosSeen.toFixed(3)} floor=${ANCHOR_COSINE_FLOOR} ms=${Date.now() - _anchorPT0}`); } catch {}
        }
        if (_anchorHits.length > 0) {
          const lines = [];
          for (const hit of _anchorHits) {
            const nodeType = hit.row.node_type || 'knowledge';
            const rendered = renderNode(
              { id: hit.row.id, l0: hit.row.l0, l1: hit.row.l1, l2: hit.row.l2, node_type: nodeType },
              'full'
            );
            lines.push(`[cos=${hit.cosSim.toFixed(3)}] **${hit.row.id}**\n${rendered}`);
            _renderedNodeIds.add(hit.row.id);
          }
          dynamicSections.push(
            `## 🔱 Anchored Memory (parallel cosine match)\n` +
            `Direct BGE cosine top-${_anchorHits.length} against engine anchor nodes (bypasses SA pool gating).\n\n` +
            lines.join('\n\n')
          );
          try { console.log(`[Mímir/anchor-parallel] hits=${_anchorHits.length} top_cos=${_anchorHits[0].cosSim.toFixed(3)} ms=${Date.now() - _anchorPT0}`); } catch {}
          liveBus.safeEmit('mimir.anchor_parallel', {
            hits: _anchorHits.length,
            top_cos: Number(_anchorHits[0].cosSim.toFixed(3)),
            ms: Date.now() - _anchorPT0,
          });
        }
      } catch (err) {
        this.emit('warning', { type: 'anchor_parallel_inject_error', error: err.message });
      }
    }

    // ─── Layer 3.5.2b: Sleipnir Experiential Anchor Injection ─────────────
    // Aggregator-derived exploration anchors that passed cos dedup. SHADOW
    // mode: lives only in experiential_pending_review until Step 6 promotion.
    // Always labeled "[experiential, unverified, conf=X.XX]" so the model
    // treats them with appropriate skepticism.
    if (!_isMimirTrigger
        && !_isCronTurn
        && this.#engine
        && this.#engine.db
        && typeof userMessage === 'string'
        && userMessage.trim().length >= 5
        && process.env.ENGINE_SLEIPNIR_IR_INJECT !== '0') {
      const _sleipPT0 = Date.now();
      try {
        const queryEmbBuf = await _anchorEmbedPromise;
        if (queryEmbBuf) {
          const { buildSleipnirInjection } = await import('./sleipnir-ir-inject.js');
          const result = buildSleipnirInjection(this.#engine, queryEmbBuf, _renderedNodeIds);
          if (result) {
            dynamicSections.push(result.block);
            try { console.log(`[Sleipnir/inject] hits=${result.hits.length} top_cos=${result.hits[0].cosSim.toFixed(3)} ms=${Date.now() - _sleipPT0}`); } catch {}
            try { liveBus.safeEmit('sleipnir.inject', { hits: result.hits.length, top_cos: Number(result.hits[0].cosSim.toFixed(3)), ms: Date.now() - _sleipPT0 }); } catch {}
          }
        }
      } catch (err) {
        this.emit('warning', { type: 'sleipnir_inject_error', error: err.message });
      }
    }

    // ─── Layer 3.5.2c: L2 Task-Completion Candidate Hint ──────────────────
    // Read recent pulse_hint_log rows of kind='task-completion-candidate'
    // and surface at most one IR hint so the agent can confirm via TASK_TOUCH
    // next turn. Per Planning §5 Phase 4: 3-min recency window, skip if a
    // matching task already had an explicit TASK_TOUCH within 6h, mark
    // processed_at after injection (one-shot). Default OFF — flip via
    // ENGINE_L2_TASK_EXTRACT_INJECT=1 after Phase 6 shadow validation.
    if (!_isMimirTrigger
        && !_isCronTurn
        && this.#engine
        && this.#engine.db
        && process.env.ENGINE_L2_TASK_EXTRACT_INJECT !== '0') {
      try {
        const db = this.#engine.db;
        const now = Date.now();
        const rows = db.prepare(`
          SELECT id, received_at, target_id, payload, severity
          FROM pulse_hint_log
          WHERE kind = 'task-completion-candidate'
            AND received_at >= ?
            AND processed_at IS NULL
            AND severity IN ('param','signal')
          ORDER BY received_at DESC
          LIMIT 5
        `).all(now - 3 * 60 * 1000);
        if (rows && rows.length > 0) {
          // Suppress when a TASK_TOUCH already landed within 6h on the same id.
          const explicitCutoff = now - 6 * 3600 * 1000;
          // R1 (post-review): exclude failed/missing-id audit rows. A typo'd
          // TASK_TOUCH against a non-existent task writes payload.applied=false
          // and would otherwise poison the suppression set with junk ids.
          const sixHourTouches = db.prepare(`
            SELECT DISTINCT target_id FROM pulse_hint_log
            WHERE kind = 'task-touch'
              AND received_at >= ?
              AND target_id IS NOT NULL
              AND json_extract(payload, '$.applied') = 1
          `).all(explicitCutoff);
          const recentlyTouched = new Set(sixHourTouches.map(r => r.target_id));

          let chosen = null;
          for (const r of rows) {
            let p = {};
            try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
            if (r.target_id && recentlyTouched.has(r.target_id)) continue;
            const conf = Number.isFinite(p.confidence) ? p.confidence : 0;
            if (conf < 0.7) continue;
            chosen = { id: r.id, target_id: r.target_id, payload: p };
            break;
          }
          if (chosen) {
            // R2 (post-review): atomic claim — only inject if THIS turn wins
            // the race to mark the row processed. Two near-concurrent turns
            // could otherwise both surface the same hint.
            let claimed = false;
            try {
              const upd = db.prepare(`
                UPDATE pulse_hint_log
                SET processed_at = ?, processed_by = 'l2-ir-inject'
                WHERE id = ? AND processed_at IS NULL
              `).run(Date.now(), chosen.id);
              claimed = upd.changes === 1;
            } catch { /* best-effort */ }
            if (claimed) {
              const confStr = Number.isFinite(chosen.payload.confidence)
                ? Number(chosen.payload.confidence).toFixed(2)
                : '0.00';
              const phr = (chosen.payload.phrase || '').slice(0, 80);
              const tgt = chosen.target_id || '(unmatched)';
              const conflictTag = chosen.payload.conflict_with_explicit
                ? `[task-conflict] explicit / implicit divergence — verify`
                : `[task-hint, conf=${confStr}] "${phr}" → ${tgt} (consider TASK_TOUCH)`;
              dynamicSections.push(`## 🐿️ Task-Completion Hint (L2)\n${conflictTag}`);
              try { liveBus.safeEmit('ratatoskr.pulse', {
                kind: 'task-completion-injected',
                target_id: tgt,
                conf: Number(confStr),
              }); } catch {}
            }
          }
        }
      } catch (err) {
        this.emit('warning', { type: 'l2_task_hint_inject_error', error: err.message });
      }
    }

    // ─── Layer 3.6: Compiler Skeleton Injection ───────────────────────────
    // Call /compile to get a topology-compiled narrative skeleton from the
    // attention pool. This gives the primary LLM a structured reasoning scaffold derived
    // purely from graph topology (zero LLM, zero training).
    try {
      // Optimization B: await the pre-launched /compile promise (fired in parallel with status→pool)
      {
        const compileRes = await _compilePromise;

        if (compileRes && compileRes.ok && compileRes.compiled) {
          const c = compileRes.compiled;
          // Save compile snapshot for Phase 0.5 training data collection
          _compileSnapshot = compileRes;
          this._lastCompileSnapshot = compileRes;
          // Only inject if the compiler found meaningful structure
          if (c.skeleton && c.edge_count > 0) {
            const ir = c.narrative_ir || {};
            const modeLabel = ir.mode ? ` | mode: ${ir.mode}` : '';
            let compilerBlock = `## 📐 Topology Compiler (${c.edge_count} edges, ${Object.keys(c.role_distribution || {}).length} roles${modeLabel})\n`;

            // Narrative IR metadata: mode + node roles (if available)
            if (ir.mode && ir.node_roles && Object.keys(ir.node_roles).length > 0) {
              const roleGroups = {};
              for (const [nid, role] of Object.entries(ir.node_roles)) {
                if (!roleGroups[role]) roleGroups[role] = [];
                roleGroups[role].push(nid);
              }
              const roleSummary = Object.entries(roleGroups)
                .map(([role, ids]) => `${role}: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '...' : ''}`)
                .join(' | ');
              compilerBlock += `Suggested mode: **${ir.mode}** | Roles: ${roleSummary}\n`;

              // Tension map summary
              if (ir.tension_map && ir.tension_map.primary) {
                const tm = ir.tension_map;
                compilerBlock += `Primary tension: ${tm.primary.sentence}`;
                if (tm.has_resolution) {
                  compilerBlock += ` → Resolution via: ${tm.resolution_candidates.slice(0, 2).join(', ')}`;
                }
                compilerBlock += '\n';
              }
              // Narrative plan summary for the primary LLM
              if (ir.narrative_plan && ir.narrative_plan.length > 0) {
                const planSteps = ir.narrative_plan
                  .filter(s => s.has_content)
                  .map(s => s.section.replace(/_/g, ' '))
                  .join(' → ');
                if (planSteps) compilerBlock += `Suggested narrative flow: ${planSteps}\n`;
              }
              compilerBlock += '\n';
            }

            compilerBlock += c.skeleton;

            // Add key claims if available (dedup: skip nodes already rendered in attention pool)
            if (c.claims && c.claims.length > 0) {
              const dedupedClaims = c.claims.filter(cl => !_renderedNodeIds.has(cl.id));
              if (dedupedClaims.length > 0) {
                const claimLines = dedupedClaims.slice(0, 6).map(cl =>
                  `  - [score=${(cl.score * 100).toFixed(0)}] ${cl.content.slice(0, 100)}`
                ).join('\n');
                compilerBlock += `\n\nKey claims:\n${claimLines}`;
                // Track these claims as rendered
                for (const cl of dedupedClaims.slice(0, 6)) {
                  if (cl.id) _renderedNodeIds.add(cl.id);
                }
              }
            }

            // Add tensions if available
            if (c.tensions && c.tensions.length > 0) {
              const tensionLines = c.tensions.slice(0, 4).map(t =>
                `  - ${t.sentence}`
              ).join('\n');
              compilerBlock += `\n\nTensions:\n${tensionLines}`;
            }

            // Add style guidance from behavior-domain nodes (language-arts, social-intelligence, meta-cognition)
            if (c.style_guidance && c.style_guidance.length > 0) {
              const sgLines = c.style_guidance.slice(0, 8).map(sg =>
                `  - ${sg}`
              ).join('\n');
              compilerBlock += `\n\n🎨 Style Guidance (from activated expression/behavior nodes):\n${sgLines}`;
            }

            dynamicSections.push(compilerBlock);
          }
        }
      }
    } catch {
      // Compiler not available — silently skip
    }

    _lap('layer 3.6 compile done');

    // ─── Layer 3.6.5: Language Skeleton (Path B) ──────────────────────────
    // Inject actual compiled sentences from the pool skeleton compiler.
    // These serve as a structural draft that the LLM polishes.
    try {
      const skeletonRes = await _skeletonPromise;
      if (skeletonRes && skeletonRes.ok && skeletonRes.skeleton_text && skeletonRes.edges_used > 0) {
        let skBlock = `## 📝 Structural Skeleton (${skeletonRes.edges_used} edges → ${skeletonRes.nodes_covered} nodes)\n`;
        skBlock += `Below is a structural skeleton auto-compiled from the star-map topology (${skeletonRes.method} method). Use its logical structure to organize your reply, but rephrase in natural language — do not copy verbatim:\n\n`;
        skBlock += skeletonRes.skeleton_text;
        dynamicSections.push(skBlock);
      }
    } catch {
      // Skeleton compiler not available — silently skip
    }

    _lap('layer 3.6.5 skeleton done');

    // ─── Layer 3.6.7: Reasoning Paths (Path C) ─────────────────────────
    // Inject BFS reasoning paths between semantically relevant anchor nodes.
    // These provide 100% signal chains (vs attention pool's 30-40% signal).
    try {
      const rpRes = await _reasoningPathPromise;
      if (rpRes && rpRes.ok && rpRes.compiled_text && rpRes.unique_paths > 0) {
        let rpBlock = `## 🔗 Reasoning Paths (${rpRes.unique_paths} paths, ${rpRes.compiled_paragraphs} segments)\n`;
        rpBlock += `Below are logic chains auto-traced from the user's message along star-map reasoning edges. They were derived via semantic anchoring + BFS path search and have very high signal purity. Prioritize these reasoning paths when composing your reply:\n\n`;
        rpBlock += rpRes.compiled_text;
        // Add anchor info for transparency
        if (rpRes.anchors && rpRes.anchors.length > 0) {
          const anchorList = rpRes.anchors.slice(0, 5).map(a => a.id).join(', ');
          rpBlock += `\n\nSemantic anchors: ${anchorList}`;
        }
        dynamicSections.push(rpBlock);
      }
    } catch {
      // Reasoning paths not available — silently skip
    }

    _lap('layer 3.6.7 reasoning paths done');

    // ─── Layer 3.7: Episodic Memory (replaces raw 24h dump) ─────
    // Topic-segment-based retrieval with cross-activation from star map.
    // Falls back to raw 24h dump if episodic query is not available.
    // Relevance gate threshold (reranker logit delta). Below this, even the best
    // segment is barely more likely to be relevant than not — injection would
    // be mostly noise. Tuned 2026-04-21 (user-approved).
    const _irCfg = this.#irConfig || {};
    const _irEpisodic = _irCfg.episodic || {};
    const _irDeep = _irCfg.deep_recall || {};
    const _irPoolAnchor = _irCfg.pool_anchor || {};
    const _irRaw = _irCfg.raw_context || {};
    const _episodicEnabled = _irEpisodic.enabled !== false;
    const _deepRecallEnabled = _irDeep.enabled !== false;
    const _poolAnchorEnabled = _irPoolAnchor.enabled !== false;
    const _rawContextEnabled = _irRaw.enabled !== false;
    const EPISODIC_RERANK_MIN = typeof _irEpisodic.rerank_min === 'number' ? _irEpisodic.rerank_min : 0.3;
    const DEEP_RERANK_MIN = typeof _irDeep.rerank_min === 'number' ? _irDeep.rerank_min : EPISODIC_RERANK_MIN;
    let episodicInjected = false;
    // Auto-expand state (populated by episodic block, consumed after pool-anchor).
    let _autoExpandCandidate = null;
    const _poolAnchorSegIdSet = new Set();
    // Track what actually made it into the prompt so we can emit one PII-safe
    // injection-log record at the bottom of this layer.
    const _injectionStats = { episodic: null, deepRecall: null, poolAnchor: null, raw: null };
    // Reset per-turn fetch tracking — conversation_fetch_raw writes into globalThis
    // during this turn's tool round; we'll copy back into _injectionStats below.
    if (!globalThis._injectionStats) globalThis._injectionStats = {};
    globalThis._injectionStats.segment_ids_fetched = [];
    if (!_episodicEnabled) {
      console.log('  ⊘ Episodic injection disabled via config');
    }
    {
      try {
        const episodicRes = _episodicEnabled ? await _episodicPromise : null;
        if (episodicRes && episodicRes.ok && episodicRes.episodic_context) {
          const topSeg = Array.isArray(episodicRes.segments) ? episodicRes.segments[0] : null;
          const topRerank = topSeg && typeof topSeg.rerank_score === 'number' ? topSeg.rerank_score : null;
          const allRerank = Array.isArray(episodicRes.segments)
            ? episodicRes.segments.map(s => (typeof s.rerank_score === 'number' ? s.rerank_score : null)).filter(x => x !== null)
            : [];
          if (topRerank !== null && topRerank < EPISODIC_RERANK_MIN) {
            console.log(`  · Episodic skipped: top rerank_score=${topRerank.toFixed(2)} < ${EPISODIC_RERANK_MIN} (no clearly relevant segment)`);
            _injectionStats.episodic = { segments: episodicRes.pool_size || 0, top_rerank: topRerank, top5_rerank: allRerank.slice(0, 5), chars: 0, skipped: 'below_gate' };
          } else {
            let ctx = episodicRes.episodic_context;
            if (ctx.length > 20) {
              // Token budget: cap episodic context at ~10K tokens (~40K chars)
              const EPISODIC_MAX_CHARS = 40000;
              if (ctx.length > EPISODIC_MAX_CHARS) {
                ctx = ctx.slice(0, EPISODIC_MAX_CHARS) + '\n\n[...truncated for token budget]';
              }
              // Fat-metadata segment index: lets the LLM reference specific seg IDs
              // when calling conversation_fetch_raw for verbatim recall.
              const segs = Array.isArray(episodicRes.segments) ? episodicRes.segments : [];
              const segIndex = segs.slice(0, 12).map(s => {
                const id = s.id;
                const time = (s.created_at || '').slice(0, 16).replace('T', ' ');
                const flags = [];
                if (s.has_decision) flags.push('decision');
                const flagStr = flags.length > 0 ? ` {${flags.join(',')}}` : '';
                return `seg${id}@${time}·${s.msg_count || 0}msg${flagStr}`;
              }).join(' | ');
              const indexLine = segIndex
                ? `Segment IDs (call \`conversation_fetch_raw\` with these for verbatim text): ${segIndex}\n\n`
                : '';
              dynamicSections.push(
                `## 🧠 Episodic Memory (${episodicRes.pool_size} topic segments${episodicRes.cross_activated ? ', cross-activated with star map' : ''})\n` +
                `Relevant conversation history retrieved by semantic similarity and star map activation.\n` +
                `Use this to recall previous discussions, decisions, and context.\n\n` +
                indexLine +
                ctx
              );
              episodicInjected = true;
              _injectionStats.episodic = {
                segments: episodicRes.pool_size || 0,
                top_rerank: topRerank,
                top5_rerank: allRerank.slice(0, 5),
                chars: ctx.length,
                cross_activated: !!episodicRes.cross_activated,
              };
              if (topSeg && Number.isInteger(topSeg.start_msg_id) && Number.isInteger(topSeg.end_msg_id)) {
                _autoExpandCandidate = { topSeg, topRerank, allRerank };
              }
            }
          }
        }
      } catch (err) {
        console.warn(`  ⚠ Episodic query failed, falling back to raw only: ${err.message || err}`);
      }

      // Deep Recall: keyword-triggered fires in parallel with episodic.
      // A margin/below_gate fallback existed here but fired 0 times across 46
      // turns of observation (keyword path covers recall queries; pool≥8 +
      // margin<0.3 never coincided in practice). Removed per OSS principle
      // of not shipping dormant defensive mechanisms.
      let _deepResolved = null;
      if (_deepRecallEnabled) {
        try {
          _deepResolved = await _deepRecallPromise;
        } catch (err) {
          console.warn(`  ⚠ Deep recall (keyword) failed: ${err.message || err}`);
        }
      }

      if (_deepResolved && _deepResolved.ok && _deepResolved.episodic_context && _deepResolved.episodic_context.length > 20) {
        const dTopSeg = Array.isArray(_deepResolved.segments) ? _deepResolved.segments[0] : null;
        const dTopRerank = dTopSeg && typeof dTopSeg.rerank_score === 'number' ? dTopSeg.rerank_score : null;
        if (dTopRerank !== null && dTopRerank < DEEP_RERANK_MIN) {
          console.log(`  · Deep recall skipped: top rerank_score=${dTopRerank.toFixed(2)} < ${DEEP_RERANK_MIN}`);
          _injectionStats.deepRecall = { triggered_by: _deepRecallTriggeredBy, segments: _deepResolved.pool_size || 0, top_rerank: dTopRerank, chars: 0, skipped: 'below_gate' };
        } else {
          let dctx = _deepResolved.episodic_context;
          const DEEP_MAX_CHARS = 15000;
          if (dctx.length > DEEP_MAX_CHARS) {
            dctx = dctx.slice(0, DEEP_MAX_CHARS) + '\n\n[...truncated]';
          }
          const reason = `${this.#identity.owner_name} used a recall cue (remember / earlier / last time…)`;
          dynamicSections.push(
            `## 🕰️ Deep Recall (keyword-triggered, ${_deepResolved.pool_size || 0} old-but-relevant segments)\n` +
            `${reason}. Segments surface purely by semantic similarity with no recency bias — they may be weeks or months old.\n\n` +
            dctx
          );
          _injectionStats.deepRecall = { triggered_by: _deepRecallTriggeredBy, segments: _deepResolved.pool_size || 0, top_rerank: dTopRerank, chars: dctx.length };
        }
      }

      // ─── Layer 3.7: Pool-Anchored Segments ──────────────────────────
      // Each active pool node has a created_at — the moment it was written to
      // the star map. Pulling conversation segments around that moment gives us
      // the raw dialogue that *produced* the concept, complementing the
      // compiled L0 summary already in the pool render.
      //
      // Gated: skip on Mímir triggers and cron (both see pool differently and
      // don't need the conversation anchor) and when no dynamic nodes made it
      // through rerank.
      if (_poolAnchorEnabled && !_isMimirTrigger && !_isCronTurn && _topDynamicPoolIds.length > 0) {
        try {
          const anchorRes = await fetch(`${MIMIR_URL}/segments_by_anchors`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              node_ids: _topDynamicPoolIds,
              window_minutes: 30,
              limit: 6,
              speaker_id: effectiveSpeakerId,
            }),
            signal: AbortSignal.timeout(5000),
          }).then(r => r.ok ? r.json() : null).catch(e => {
            console.warn('[Mímir] pool-anchor query failed:', e.message);
            return null;
          });
          if (anchorRes && anchorRes.ok && Array.isArray(anchorRes.segments) && anchorRes.segments.length > 0) {
            for (const s of anchorRes.segments) {
              if (s && s.id != null) _poolAnchorSegIdSet.add(s.id);
            }
            const lines = anchorRes.segments.map(s => {
              const segId = s.id || '?';
              const when = (s.created_at || '').slice(0, 16).replace('T', ' ');
              const msgCount = s.msg_count || 0;
              const charCount = String(s.summary || '').length;
              const tokenEstimate = Math.ceil(charCount / 3.8); // Conservative token estimate
              const summary = s.summary || '';
              // Infer flags from summary text (cheap keyword detection)
              const flags = [];
              if (/decide/i.test(summary)) flags.push('decision');
              if (/\?|question/i.test(summary)) flags.push('question');
              if (/```|code/i.test(summary)) flags.push('code');
              if (/error|failed/i.test(summary)) flags.push('error');
              const flagStr = flags.length > 0 ? `{${flags.join(',')}}` : '';
              const who = s.speaker_name || 'Unknown';
              const body = summary || `(${msgCount} msgs)`;
              return `[seg${segId} · ${when} · ${msgCount}msgs · ~${tokenEstimate}tok ${flagStr} · spk:${who}] ${body}`;
            });
            const body = lines.join('\n');
            dynamicSections.push(
              `## 🎯 Pool-Anchored Context (${anchorRes.segments.length} segments around ${anchorRes.anchors} pool node creation times)\n` +
              `Conversations that produced the concepts in the current attention pool — use to recall the original reasoning or context that led to these ideas.\n\n` +
              body
            );
            _injectionStats.poolAnchor = { segments: anchorRes.segments.length, anchors: anchorRes.anchors || 0, chars: body.length };
          }
        } catch (err) {
          console.warn(`  ⚠ Pool-anchor injection failed: ${err.message || err}`);
        }
      }

      // ─── Conditional Auto-Expand (top-1 verbatim) ───────────────
      // When the episodic top-1 is a clear winner (high rerank + clear margin
      // over runner-up), auto-pull a bounded verbatim excerpt of that single
      // segment. Three-check dedup prevents 4-fidelity duplication
      // (raw-window / pool-anchor / two-turn replay). Default ON, kill-switch
      // via ENGINE_AUTO_EXPAND_ENABLED=0.
      const _autoExpand = _irCfg.auto_expand || {};
      const _autoExpandEnabled = process.env.ENGINE_AUTO_EXPAND_ENABLED !== '0'
        && _autoExpand.enabled !== false;
      if (_autoExpandEnabled && _autoExpandCandidate && this.#convStore) {
        try {
          const AE_RERANK_MIN = typeof _autoExpand.rerank_min === 'number' ? _autoExpand.rerank_min : 1.5;
          const AE_MARGIN_MIN = typeof _autoExpand.margin_min === 'number' ? _autoExpand.margin_min : 0.5;
          const AE_MAX_CHARS = typeof _autoExpand.max_chars === 'number' ? _autoExpand.max_chars : 3000;
          const { topSeg, topRerank: r1, allRerank } = _autoExpandCandidate;
          const r2 = allRerank.length >= 2 ? allRerank[1] : -999;
          const margin = r1 - r2;
          // Raw-window dedup: if seg was created within the raw-context window,
          // it'll appear verbatim in the raw block below — no auto-expand needed.
          const rawHours = typeof _irRaw.min_hours === 'number' ? _irRaw.min_hours : 4;
          const rawCutoffISO = new Date(Date.now() - rawHours * 60 * 60 * 1000).toISOString();
          let skipReason = null;
          if (r1 < AE_RERANK_MIN) skipReason = 'below_gate';
          else if (margin < AE_MARGIN_MIN) skipReason = 'margin_too_tight';
          else if (topSeg.created_at && topSeg.created_at >= rawCutoffISO) skipReason = 'dup_raw_window';
          else if (_poolAnchorSegIdSet.has(topSeg.id)) skipReason = 'dup_pool_anchor';
          else if (globalThis._lastAutoExpandedSegId === topSeg.id) skipReason = 'dup_replay_guard';

          if (skipReason) {
            _injectionStats.autoExpand = {
              seg_id: topSeg.id, top_rerank: r1, margin, chars: 0, skipped: skipReason,
            };
          } else {
            const sessionLike = (currentUser.isSystem && OWNER_SPEAKER_ID)
              ? `${OWNER_SPEAKER_ID}%`
              : (topSeg.session_id || null);
            const verb = this.#convStore.getSegmentVerbatim({
              startMsgId: topSeg.start_msg_id,
              endMsgId: topSeg.end_msg_id,
              sessionIdLike: sessionLike,
              maxChars: AE_MAX_CHARS,
            });
            if (verb && verb.text && verb.text.length > 0) {
              dynamicSections.push(
                `## 📜 Verbatim Top Segment (auto-expanded · seg${topSeg.id} · rerank=${r1.toFixed(2)} · margin=${margin.toFixed(2)})\n` +
                `Highest-confidence episodic match — full raw text below for direct recall.\n\n` +
                verb.text
              );
              globalThis._lastAutoExpandedSegId = topSeg.id;
              _injectionStats.autoExpand = {
                seg_id: topSeg.id, top_rerank: r1, margin,
                chars: verb.text.length, msgs: verb.msgCount, truncated: !!verb.truncated,
              };
            } else {
              _injectionStats.autoExpand = {
                seg_id: topSeg.id, top_rerank: r1, margin, chars: 0, skipped: 'empty_segment',
              };
            }
          }
        } catch (err) {
          console.warn(`  ⚠ Auto-expand failed (silent): ${err.message || err}`);
        }
      }

      // Recent raw messages — always inject alongside episodic for full fidelity.
      // Episodic gives semantic breadth; raw messages give verbatim recent detail
      // (critical for code work continuity after timeouts/restarts).
      //
      // Window: hybrid max(MIN_TURNS, MIN_HOURS) with MAX_TURNS cap. The cap
      // adapts on a clear rerank signal only — when episodic top-score is high
      // AND top-3 cluster tightly (small spread), episodic is doing the heavy
      // lifting and we can drop raw to the tight_episodic cap. Short user
      // messages are NOT penalized (subagent challenge 2026-04-22).
      if (_rawContextEnabled && this.#convStore) {
        try {
          const now = new Date();
          const MIN_HOURS = typeof _irRaw.min_hours === 'number' ? _irRaw.min_hours : 4;
          const MIN_TURNS = typeof _irRaw.min_turns === 'number' ? _irRaw.min_turns : 20;
          const MAX_TURNS_DEFAULT = typeof _irRaw.max_turns === 'number' ? _irRaw.max_turns : 80;
          const TIGHT_MAX_TURNS = typeof _irRaw.tight_episodic_max_turns === 'number'
            ? _irRaw.tight_episodic_max_turns
            : 40;

          // Adaptive window: compaction triggers 8h window for 12h cooldown
          let adaptiveWindow = this.#session.getAdaptiveWindow(sessionId);

          // Silent-compaction detection: if the prior turn for this session
          // was >2h ago, the Claude Code-side context was almost certainly
          // summarized between then and now. The engine never receives that
          // signal directly, so we infer it from the gap and stamp a
          // compaction marker — this widens the raw window for THIS turn and
          // persists for 12h so subsequent resumes also benefit.
          try {
            const lastRow = this.#convStore.getByTimeRange(
              new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
              now.toISOString(),
              1,
              currentUser.isSystem && OWNER_SPEAKER_ID
                ? { sessionIdLike: `${OWNER_SPEAKER_ID}%` }
                : { sessionId: currentUser.sessionId }
            );
            const lastTs = lastRow.length ? new Date(lastRow[lastRow.length - 1].timestamp).getTime() : 0;
            const gapMs = lastTs ? (now.getTime() - lastTs) : 0;
            if (lastTs && gapMs > 2 * 60 * 60 * 1000 && !adaptiveWindow.isExpandedWindow) {
              this.#session.recordCompactionTimestamp(sessionId);
              adaptiveWindow = this.#session.getAdaptiveWindow(sessionId);
            }
          } catch { /* never let detection break a turn */ }

          const ADAPTIVE_MAX_TURNS = adaptiveWindow.maxTurns; // 120 if expanded, 80 if default
          const ADAPTIVE_MAX_HOURS = adaptiveWindow.hours; // 8 if expanded, 4 if default

          let MAX_TURNS = ADAPTIVE_MAX_TURNS;
          const ep = _injectionStats.episodic;
          if (ep && Array.isArray(ep.top5_rerank) && ep.top5_rerank.length >= 3) {
            const [r1, r2, r3] = ep.top5_rerank;
            const tight = (r1 - r3) < 0.6; // top-3 cluster tight → strong signal
            if (r1 >= 1.5 && tight) MAX_TURNS = TIGHT_MAX_TURNS;
          }

          // Record in stats for monitoring
          if (!_injectionStats.adaptiveWindow) {
            _injectionStats.adaptiveWindow = {
              isExpanded: adaptiveWindow.isExpandedWindow,
              hours: adaptiveWindow.hours,
              maxTurns: ADAPTIVE_MAX_TURNS,
              reason: adaptiveWindow.reason || 'default',
              compaction_triggered_window_8h: adaptiveWindow.isExpandedWindow,
            };
          }

          // Cast a 24h net; we'll trim by whichever of (last MIN_TURNS turns) / (last ADAPTIVE_MAX_HOURS h) is larger.
          const netCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          // SQL-scope: owner human sessions look at their own session_id; system
          // sessions (cron/autonomous) need to see what the owner was just
          // discussing on tg, so they widen to the owner's tg session prefix.
          const rawScope = (currentUser.isSystem && OWNER_SPEAKER_ID)
            ? { sessionIdLike: `${OWNER_SPEAKER_ID}%` }
            : { sessionId: currentUser.sessionId };
          const rawRecent = this.#convStore.getByTimeRange(
            netCutoff.toISOString(), now.toISOString(), 300,
            rawScope
          );
          // Even with SQL scoping, keep a precise in-memory guard. For owner
          // human sessions require exact session match; for system sessions
          // accept any row from the owner's tg session(s). Always strip the
          // 'cortana_internal' role and self-talk so raw shows real dialogue.
          const convoMsgs = rawRecent.filter(m => {
            if (currentUser.isSystem && OWNER_SPEAKER_ID) {
              if (!m.session_id || !m.session_id.startsWith(OWNER_SPEAKER_ID)) return false;
            } else {
              if (m.session_id !== currentUser.sessionId) return false;
            }
            if (m.role === 'cortana_internal') return false;
            if (m.participant === 'self') return false;
            return true;
          });
          if (convoMsgs.length > 0) {
            const minCutoffISO = new Date(now.getTime() - ADAPTIVE_MAX_HOURS * 60 * 60 * 1000).toISOString();
            const byTime = convoMsgs.filter(m => m.timestamp >= minCutoffISO);
            const byCount = convoMsgs.slice(-MIN_TURNS);
            // Pick whichever window covers more, then cap at MAX_TURNS.
            const chosen = (byTime.length > byCount.length ? byTime : byCount).slice(-MAX_TURNS);
            const spanMins = chosen.length
              ? Math.round((now.getTime() - new Date(chosen[0].timestamp).getTime()) / 60000)
              : 0;
            const spanLabel = spanMins >= 60 ? `${(spanMins / 60).toFixed(1)}h` : `${spanMins}m`;
            const ownerLabel = this.#identity.owner_name;
            const agentLabel = this.#identity.agent_name;
            const lines = chosen.map((m, i) => {
              const ts = m.timestamp ? m.timestamp.slice(11, 16) : '?';
              const role = m.role === 'user' ? ownerLabel : agentLabel;
              const isRecent = i >= chosen.length - 5;
              const maxLen = isRecent ? 1500 : (episodicInjected ? 600 : 400);
              const preview = m.content.length > maxLen
                ? m.content.slice(0, maxLen) + '...'
                : m.content;
              return `[${ts}] ${role}: ${preview}`;
            });
            const header = episodicInjected
              ? `## 📋 Recent Verbatim Context (${chosen.length} turns / ${spanLabel})\nFull detail of the most recent exchanges — use for immediate work continuity.\n`
              : `## 📋 Recent Conversation Context (${chosen.length} turns / ${spanLabel})\nUse this to understand what ${ownerLabel} and ${agentLabel} were recently working on, pending tasks, and ongoing discussions.\n`;
            const rawBody = lines.join('\n');
            dynamicSections.push(header + rawBody);
            _injectionStats.raw = {
              turns: chosen.length,
              span_min: spanMins,
              chars: rawBody.length,
              max_turns_cap: MAX_TURNS,
              adaptive: MAX_TURNS === 40 ? 'tight_episodic' : 'default',
            };
          }
        } catch (err) {
          console.warn(`  ⚠ Raw recent injection failed: ${err.message || err}`);
        }
      }

      // ─── Emit one PII-safe injection-log record per turn ──
      try {
        const total = (_injectionStats.episodic?.chars || 0)
          + (_injectionStats.deepRecall?.chars || 0)
          + (_injectionStats.poolAnchor?.chars || 0)
          + (_injectionStats.autoExpand?.chars || 0)
          + (_injectionStats.raw?.chars || 0);
        // Pull verbatim-fetch tool activity recorded during this turn's tool round
        const fetched = Array.isArray(globalThis._injectionStats?.segment_ids_fetched)
          ? globalThis._injectionStats.segment_ids_fetched.slice()
          : [];
        if (fetched.length > 0) _injectionStats.segment_ids_fetched = fetched;
        logInjection({
          sessionId: options.sessionId || currentUser.sessionId || '',
          speakerId: effectiveSpeakerId,
          userMessage,
          episodic: _injectionStats.episodic,
          deepRecall: _injectionStats.deepRecall,
          poolAnchor: _injectionStats.poolAnchor,
          autoExpand: _injectionStats.autoExpand,
          raw: _injectionStats.raw,
          adaptiveWindow: _injectionStats.adaptiveWindow,
          segment_ids_fetched: _injectionStats.segment_ids_fetched,
          totalChars: total,
        });
      } catch { /* never break a turn on logging */ }
    }

    // ─── Layer 3.8: Checkpoint instructions for wakeup sessions ──
    if (_isMimirTrigger) {
      const sessionType = options.source === 'mimir_curiosity' ? 'curiosity-driven autonomous exploration'
        : options.source === 'mimir_continuation' ? 'activation continuation (high residual activation)'
        : 'task checkpoint resume';
      dynamicSections.push(
        `## 📋 Checkpoint Protocol (${sessionType})\n` +
        `This session was autonomously triggered by Mímir (${sessionType}).\n` +
        `The user message above contains the full checkpoint chain with previous progress.\n\n` +
        `Instructions:\n` +
        `1. Read the checkpoint chain carefully — do NOT repeat work already completed\n` +
        `2. Continue from exactly where the last session left off\n` +
        `3. If the task is already complete, summarize the result concisely\n` +
        `4. Focus on the original task — do not start new unrelated work\n` +
        (options.source === 'mimir_curiosity'
          ? `5. This is a curiosity-driven exploration — share interesting findings with ${this.#identity.owner_name} via Telegram`
          : `5. If you cannot complete the task, save a clear summary of progress and next steps`)
      );
    }

    _lap('layer 3.7 episodic done');
    // ─── Layer 3.9: Await pre-launched digest + conversations ──
    // These were fired in parallel with /pool at the top of the Mímir block
    if (!_isMimirTrigger) {
      try {
        const [digestRes, convRes] = await Promise.all([_digestPromise, _retrievePromise]);

        // engine.ir.mimir_inject.enabled (default false) — when off, Mímir
        // autonomous + cron sessions are filtered out of digest + conversation
        // recall so they don't compete with the user's main thread for raw
        // context. Star map / SA surfacing is unaffected.
        const _allowMimirInject = this.#irConfig?.mimir_inject?.enabled === true;
        const _isAutonomousSid = (sid) => {
          const s = sid || '';
          return s.startsWith('cron-')
            || s.startsWith('curiosity')
            || s.startsWith('wakeup')
            || s.startsWith('mimir')
            || s.startsWith('continuation-');
        };

        // Process digest — filter exploration/continuation to avoid polluting main-session raw.
        // Exploration findings already write directly to star map; SA surfaces them via attention pool.
        if (digestRes && digestRes.count > 0) {
          const filtered = (digestRes.sessions || []).filter(s => {
            if (s.type === 'curiosity' || s.type === 'continuation') return false;
            const sid = s.session_id || '';
            if (sid.startsWith('tg:') || sid.startsWith('tg_')) return false;
            if (!_allowMimirInject) {
              if (s.type === 'wakeup') return false;
              if (_isAutonomousSid(sid)) return false;
            }
            return true;
          });
          if (filtered.length > 0) {
            const lines = filtered.map(s => {
              const typeLabel = '🧠 Autonomous wakeup';
              const ago = Math.round((Date.now() / 1000 - s.updated_at) / 60);
              const timeStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
              return `- [${typeLabel}] ${timeStr}: ${s.summary.slice(0, 150)}`;
            });
            dynamicSections.push(
              `## 📨 Recent Autonomous Activity (${filtered.length} sessions)\n` +
              `These sessions ran autonomously while you were not active. Their findings are part of your continuous memory.\n` +
              lines.join('\n')
            );
          }
        }

        // Process conversations (skip if episodic memory already injected — it supersedes this)
        if (!episodicInjected && convRes && convRes.ok && convRes.results && convRes.results.length > 0) {
          const snippets = convRes.results
            .filter(r => r.score > 0.3)
            .filter(r => _allowMimirInject || !_isAutonomousSid(r.session_id))
            .map(r => {
              const ts = r.timestamp ? r.timestamp.slice(0, 16).replace('T', ' ') : '?';
              const role = r.role === 'user' ? this.#identity.owner_name : this.#identity.agent_name;
              const preview = r.content.slice(0, 200).replace(/\n/g, ' ');
              return `- [${ts}] ${role}: ${preview}`;
            });
          if (snippets.length > 0) {
            dynamicSections.push(
              `## 💬 Relevant Past Conversations\n` +
              `Conversation snippets retrieved from buffer (by semantic relevance to current message).\n` +
              snippets.join('\n')
            );
          }
        }
      } catch (e) {
        console.error('[Mímir] Layer 3.9 parallel fetch failed:', e.message);
      }
    }

    // ─── Layer 4: Compaction summary ─────────────────────────────
    const summary = this.#session.getSummary(sessionId);
    if (summary) {
      const trimmedSummary = this.#trimToTokenBudget(summary, summaryBudget);
      dynamicSections.push(`## Conversation Summary (compacted)\n\n${trimmedSummary}`);
    }

    // ─── Layer 5: Extra context ──────────────────────────────────
    if (options.extraContext) {
      const extraLines = Object.entries(options.extraContext)
        .map(([k, v]) => `**${k}**: ${v}`)
        .join('\n');
      dynamicSections.push(`## Context\n\n${extraLines}`);
    }

    // ─── Layer 5.5: L4 DEBRIEF_HINT reminder DISABLED 2026-05-01 ───
    // user feedback: reminder leaks through to user-visible text. The DEBRIEF
    // marker stripping at telegram.js handles user-facing output, but this
    // dynamicSection lands in the model prompt and can echo back. Keep the
    // logic dormant; re-enable only if we route it strictly to system frame.

    // ─── Layer 5.6: L3-5 noise-suppression trailer ───────────────────
    // Final gentle reminder — placed right before Current time so it sits
    // adjacent to the user message as the last instruction the model sees.
    dynamicSections.push(
      `## 🧹 Noise-suppression duty\n` +
      `- ⭐/◆/◇ are relative ranks within the pool — they do not guarantee topical relevance. First check whether the top ⭐/◆ are semantically aligned with the user's question:\n` +
      `  · Aligned → answer based on those nodes\n` +
      `  · Off-topic → say "I'm not sure about this" rather than forcing together unrelated content\n` +
      `- ◇ pool-bottom nodes are by default SA-spread aftershocks; unless clearly related to the current question, do not use them to answer\n` +
      `- Answer style follows Style Guidance; do not echo any metadata from the context (score/act/zone/tick)\n` +
      `- 📜 Verbatim / 📔 Episodic / 🎯 Pool-Anchored history blocks are **internal scaffolding** for your recall only — never quote the user messages or assistant replies inside them back as if they were your own new output\n` +
      `- **Deep-retrieval trigger**: when the pool didn't cover what the user asked and they're asking about prior work / decisions / project state / "do you remember X" — first call \`graph_lookup(query, k=15)\` (~19s); if still empty, \`memory_search\`; only then say "I'm not sure". Hard cap of 3 retrieval rounds per turn — don't spiral. Casual chitchat with no recall need: skip retrieval and acknowledge the gap\n` +
      `- **Anti-fabrication hard rule**: any concrete claim (numbers / file paths / function names / decisions / dates / parameters) must be grounded in pool / anchors / conversation history / tool output. "I remember" / "it should be" / "probably" is not evidence. No grounding → say "I'm not sure" or open a tool to verify — fabricated detail looks confident but gets caught`
    );

    // ─── Layer 6: Time awareness (tz-configurable) ───────────────
    // OSS-friendly: timezone resolved from config.locale.timezone at
    // construction; empty = system tz → UTC fallback. Last-turn gap is
    // pulled from ConversationStore (chronological, role ∈ user/assistant).
    let lastTurnAt = null;
    try {
      const recent = this.#convStore?.getRecent?.(1) || [];
      const last = recent[recent.length - 1];
      if (last && last.timestamp) lastTurnAt = last.timestamp;
    } catch { /* convStore may be uninitialized on first turn */ }
    dynamicSections.push(buildTimeContext({ lastTurnAt, timezone: this.#timezone }));

    const stableText = stableSections.filter(Boolean).join('\n\n---\n\n').trim();
    const dynamicText = dynamicSections.filter(Boolean).join('\n\n---\n\n').trim();
    const finalPrompt = (stableText && dynamicText) ? `${stableText}\n\n${SYSTEM_CACHE_BREAK}\n\n${dynamicText}` : [stableText, dynamicText].filter(Boolean).join('\n\n---\n\n');
    _lap(`DONE (prompt ~${Math.round(finalPrompt.length / 4)} tokens, ${finalPrompt.length} chars)`);

    // ─── Observability: per-turn IR+pool JSONL record ───────────────────
    // Accumulates cross-turn noise/recall/timing data. Must never throw —
    // wrapped in try/catch with fire-and-forget semantics.
    try {
      const nowIso = new Date().toISOString();
      const date = nowIso.slice(0, 10);
      const logDir = resolve(__dirname_rt, '..', 'data', 'logs', 'ir-pool');
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      const channel = _isCronTurn
        ? 'cron'
        : (_isMimirTrigger ? 'autonomous' : 'telegram');
      const irBytes = dynamicSections
        .filter(Boolean)
        .map(s => {
          const firstLine = s.split('\n', 1)[0] || '';
          return { head: firstLine.slice(0, 80), bytes: Buffer.byteLength(s, 'utf8') };
        });
      const record = {
        ts: nowIso,
        session_id: sessionId,
        channel,
        trigger: options.trigger || options._trigger || null,
        user_msg: (userMessage || '').slice(0, 200),
        user_msg_len: (userMessage || '').length,
        pool: _irLogState.pool,
        pool_meta: _irLogState.poolMeta,
        rerank: _irLogState.rerank,
        streaming: _irLogState.streaming,
        ir_bytes: irBytes,
        ir_section_count: irBytes.length,
        prompt_chars: finalPrompt.length,
        timing: {
          bfs_ms: _irLogState.bfsMs,
          pool_ms: _irLogState.poolMs,
          rerank_ms: _irLogState.rerankMs,
          total_ms: Date.now() - _t0,
        },
      };
      appendFileSync(
        resolve(logDir, `${date}.jsonl`),
        JSON.stringify(record) + '\n',
        'utf8'
      );
    } catch { /* observability must never break a turn */ }

    return finalPrompt;
  }

  /**
   * Force compaction on a session regardless of threshold.
   * @param {string} sessionId
   */
  async forceCompact(sessionId) {
    await this.#performCompaction(sessionId);
  }

  /**
   * Delete a temporary session (used by cron cleanup).
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    this.#session.deleteTemp(sessionId);
  }

  /**
   * Get runtime stats for monitoring.
   * @param {string} sessionId
   * @returns {Object}
   */
  getStats(sessionId) {
    const cfg = this.#runtimeConfig;
    const activeBudget = Math.floor(cfg.contextBudget * cfg.activeRatio);
    const activeTokens = this.#session.getActiveTokenCount(sessionId);

    return {
      contextBudget: cfg.contextBudget,
      activeBudget,
      activeTokens,
      activeUtilization: activeTokens / activeBudget,
      compactionThreshold: cfg.compactionThreshold,
      wouldCompact: (activeTokens / activeBudget) > cfg.compactionThreshold,
    };
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  /**
   * Load and concatenate fixed files within token budget.
   * @param {number} tokenBudget
   * @returns {string|null}
   */
  #loadFixedFiles(tokenBudget) {
    const files = this.#runtimeConfig.fixedFiles;
    if (!files || files.length === 0) return null;

    const sections = [];
    let usedTokens = 0;

    for (const filePath of files) {
      const fullPath = resolve(filePath);
      if (!existsSync(fullPath)) {
        this.emit('warning', { type: 'missing_fixed_file', path: fullPath });
        continue;
      }

      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const content = this.#substituteTemplate(raw);
        const tokens = this.#estimateTokens(content);

        if (usedTokens + tokens > tokenBudget) {
          // Trim to fit remaining budget
          const remaining = tokenBudget - usedTokens;
          if (remaining > 100) { // Only include if meaningful content fits
            const trimmed = this.#trimToTokenBudget(content, remaining);
            sections.push(`## ${this.#fileLabel(filePath)}\n\n${trimmed}`);
          }
          break;
        }

        sections.push(`## ${this.#fileLabel(filePath)}\n\n${content}`);
        usedTokens += tokens;
      } catch (err) {
        this.emit('warning', { type: 'fixed_file_read_error', path: fullPath, error: err.message });
      }
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  /**
   * Substitute {{UPPER_SNAKE}} placeholders in fixed-file content.
   * Sources: this.#identity (live; updated by setIdentity()) + sensible defaults.
   * SETUP.md still documents the placeholders for users who edit by hand —
   * this pass means the OSS-shipped templates "just work" without manual edits.
   *
   * @param {string} content
   * @returns {string}
   */
  #substituteTemplate(content) {
    if (!content || content.indexOf('{{') < 0) return content;

    const id = this.#identity || DEFAULT_IDENTITY;
    const agentName = (id.agent_name || DEFAULT_IDENTITY.agent_name).trim();
    const ownerName = (id.owner_name || DEFAULT_IDENTITY.owner_name).trim();
    const language = (id.default_language || DEFAULT_IDENTITY.default_language).trim();

    if (!this.#projectRoot) {
      try { this.#projectRoot = resolve(__dirname_rt, '..'); } catch { this.#projectRoot = '.'; }
    }
    if (!this.#channelsLabel) {
      this.#channelsLabel = 'Dashboard (http://localhost:18800), CLI, optional Telegram';
    }

    return content
      .replace(/\{\{AGENT_NAME\}\}/g, agentName)
      .replace(/\{\{OWNER_NAME\}\}/g, ownerName)
      .replace(/\{\{DEFAULT_LANGUAGE\}\}/g, language)
      .replace(/\{\{PROJECT_ROOT\}\}/g, this.#projectRoot)
      .replace(/\{\{CHANNELS\}\}/g, this.#channelsLabel);
  }

  /**
   * Update identity at runtime (e.g. after Stage 5 chat extraction). Refreshes
   * key-system-instructions and clears the render cache so the next turn picks
   * up the new name without an engine restart.
   * @param {{agent_name?: string, owner_name?: string, owner_display_name?: string, default_language?: string}} patch
   */
  setIdentity(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...this.#identity };
    for (const k of ['agent_name', 'owner_name', 'owner_display_name', 'default_language']) {
      if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim();
    }
    this.#identity = next;
    this.#keySystemInstructions = buildKeySystemInstructions(next);
    if (this._renderCache && typeof this._renderCache.clear === 'function') {
      this._renderCache.clear();
    }
  }

  /**
   * Extract a display label from a file path.
   * @param {string} filePath
   * @returns {string}
   */
  #fileLabel(filePath) {
    const parts = filePath.split('/');
    return parts[parts.length - 1].replace(/\.md$/i, '').toUpperCase();
  }

  /**
   * Helper: call LLM with or without streaming. When streaming, emits textDelta events.
   * Returns a standard LLMResponse in both cases.
   */
  async #llmCallMaybeStream(messages, chatOptions, useStreaming, sessionId, round) {
    if (useStreaming && typeof this.#llm.streamChat === 'function') {
      let content = '';
      let toolCalls = null;
      let usage = null;
      let model = '';
      let finishReason = 'stop';

      for await (const event of this.#llm.streamChat(messages, chatOptions)) {
        if (event.type === 'text_delta') {
          content += event.text;
          this.emit('textDelta', { sessionId, text: event.text, round });
        }
        if (event.type === 'tool_calls') toolCalls = event.toolCalls;
        if (event.type === 'done') {
          usage = event.response?.usage || null;
          model = event.response?.model || '';
          finishReason = event.response?.finishReason || 'stop';
        }
      }

      return {
        content: content || null,
        toolCalls,
        usage: usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model,
        finishReason,
      };
    }
    return await this.#llm.chat(messages, chatOptions);
  }

  /**
   * Assemble the messages array for LLM call.
   * System prompt is first, then summary context (as system), then active messages.
   * 
   * @param {string} sessionId
   * @param {string} systemPrompt
   * @returns {{ messages: Array, activeCount: number }}
   */
  #assembleMessages(sessionId, systemPrompt) {
    const cfg = this.#runtimeConfig;
    // Use the dynamic budget from buildSystemPrompt if available, else fall back to config
    const effectiveBudget = this._lastEffectiveBudget || cfg.contextBudget;
    const activeBudget = Math.floor(effectiveBudget * cfg.activeRatio);

    // Load active messages
    const activeMessages = this.#session.getActiveMessages(sessionId);

    // Trim active messages to fit budget (keep most recent)
    const trimmedActive = this.#trimMessagesToBudget(activeMessages, activeBudget);

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
    ];

    // Add active conversation messages
    for (const msg of trimmedActive) {
      const entry = { role: msg.role, content: msg.content };

      // Reconstruct tool_calls for assistant messages
      if (msg.toolCalls) {
        entry.tool_calls = typeof msg.toolCalls === 'string'
          ? JSON.parse(msg.toolCalls)
          : msg.toolCalls;
      }

      // Add tool_call_id for tool result messages
      const toolCallId = msg.tool_call_id ?? msg.toolCallId ?? null;
      if (toolCallId) {
        entry.tool_call_id = toolCallId;
      }

      messages.push(entry);
    }

    return { messages, activeCount: trimmedActive.length };
  }

  /**
   * Trim messages array to fit within token budget, keeping most recent.
   * @param {Array} messages
   * @param {number} tokenBudget
   * @returns {Array}
   */
  #trimMessagesToBudget(messages, tokenBudget) {
    // Work backwards from most recent
    let totalTokens = 0;
    let startIdx = messages.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = this.#estimateTokens(messages[i].content || '');
      if (totalTokens + msgTokens > tokenBudget) break;
      totalTokens += msgTokens;
      startIdx = i;
    }

    startIdx = this.#adjustTrimStartForToolPairing(messages, startIdx);
    return messages.slice(startIdx);
  }

  #adjustTrimStartForToolPairing(messages, startIdx) {
    let start = Math.max(0, startIdx);
    while (start > 0 && messages[start]?.role === 'tool') {
      start--;
    }
    return start;
  }

  #stableStringify(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(v => this.#stableStringify(v)).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${this.#stableStringify(value[k])}`).join(',')}}`;
  }

  #toolSignature(toolCall) {
    return `${toolCall.name}::${this.#stableStringify(toolCall.input || {})}`;
  }

  #makeGuardrailToolResult(tc, message, roundNumber, code = 'guardrail_suppressed') {
    const content = `[Tool Guardrail:${tc.name}] ${message}`;
    return {
      id: tc.id,
      name: tc.name,
      content,
      ok: false,
      errorCode: code,
      latencyMs: 0,
      resultBytes: Buffer.byteLength(content),
      round: roundNumber,
      cached: false,
      guardrail: true,
    };
  }

  #makeCachedToolResult(tc, cached, roundNumber, repetitionCount) {
    const preview = String(cached.preview || cached.content || '').slice(0, 500);
    const content = repetitionCount > this.#runtimeConfig.maxRepeatedToolSignature
      ? `[Tool Guardrail:${tc.name}] Identical call repeated ${repetitionCount} times in this turn. Reuse the prior result from round ${cached.round}; no re-execution performed.`
      : `[Tool Cache Hit:${tc.name}] Reusing identical result from round ${cached.round} (tool_call_id ${cached.originalToolCallId}).${preview ? `
Preview:
${preview}` : ''}`;
    return {
      id: tc.id,
      name: tc.name,
      content,
      ok: true,
      errorCode: repetitionCount > this.#runtimeConfig.maxRepeatedToolSignature ? 'repeated_tool_call_suppressed' : null,
      latencyMs: 0,
      resultBytes: Buffer.byteLength(content),
      round: roundNumber,
      cached: true,
    };
  }

  async #applyPlannerGuardrail({ sessionId, turnId, userMessage, currentMessages, toolDefs, loopCount, turnState, options }) {
    if (!this.#runtimeConfig.plannerEnabled || !this.#tools || !Array.isArray(toolDefs) || toolDefs.length === 0) {
      return { toolDefs };
    }

    const plannerModel = options.plannerModel || this.#runtimeConfig.plannerModel || this.#llm?.config?.compactModel;
    if (!plannerModel) {
      return { toolDefs };
    }

    try {
      const availableToolNames = toolDefs.map(td => td?.function?.name || td?.name).filter(Boolean);
      const historyPreview = JSON.stringify(currentMessages.slice(-6)).slice(-this.#runtimeConfig.plannerMaxHistoryChars);
      const plannerPrompt = [
        'You are a lightweight planning guardrail for an AI agent.',
        'Return strict JSON with keys: need_tools (boolean), candidate_tools (array of tool names), next_step (string), loop_risk (low|medium|high), confidence (0-1).',
        'Be conservative: if the agent can answer from current evidence, set need_tools=false.',
        'If prior plans are repeating, recommend summarizing current findings instead of calling more tools.',
        `User task: ${userMessage}`,
        `Tool rounds so far: ${loopCount}`,
        `Available tools: ${availableToolNames.join(', ') || '(none)'}`,
        'Recent transcript excerpt:',
        historyPreview,
      ].join('\n');
      const resp = await this.#llm.chat([
        { role: 'system', content: 'Return JSON only. No prose.' },
        { role: 'user', content: plannerPrompt },
      ], {
        model: plannerModel,
        _role: 'compact',
        temperature: 0.1,
        maxTokens: this.#runtimeConfig.plannerMaxTokens,
        _trigger: 'planner-guardrail',
        _sessionId: sessionId,
        _maxRetries: 0,
        _noFallback: true,
      });

      turnState.plannerInvocations += 1;
      const plan = this.#parsePlannerResponse(resp?.content || '');
      if (!plan) {
        this.#session.updateTurn(turnId, { plannerInvocations: turnState.plannerInvocations });
        return { toolDefs };
      }

      const signature = this.#makePlannerSignature(plan);
      turnState.plannerHistory.push(signature);
      const last = turnState.plannerHistory[turnState.plannerHistory.length - 2] || null;
      const similar = last ? this.#plannerSimilarity(signature, last) >= this.#runtimeConfig.plannerSimilarityThreshold : false;

      let guardrailNote = null;
      let filtered = toolDefs;
      if (Array.isArray(plan.candidate_tools) && plan.candidate_tools.length > 0) {
        filtered = this.#filterToolDefs(toolDefs, plan.candidate_tools);
      }
      if (plan.need_tools === false) {
        filtered = [];
      }
      if (similar && loopCount >= 1) {
        turnState.plannerGuardrailHits += 1;
        if (turnState.plannerGuardrailHits >= this.#runtimeConfig.plannerRepeatLimit || String(plan.loop_risk || '').toLowerCase() === 'high') {
          filtered = [];
          turnState.stopReason = turnState.stopReason || 'planner_repeat_guardrail';
          guardrailNote = 'Planner guardrail: your recent tool plan is materially repeating. Do not call more tools unless there is a clearly different next step. Summarize what you know, state what is still missing, and ask for a narrower target if needed.';
        }
      }

      this.#session.updateTurn(turnId, {
        plannerInvocations: turnState.plannerInvocations,
        plannerGuardrailHits: turnState.plannerGuardrailHits,
        stopReason: turnState.stopReason,
      });
      return { toolDefs: filtered, guardrailNote };
    } catch {
      return { toolDefs };
    }
  }

  #parsePlannerResponse(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    let candidate = raw;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidate = fence[1].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #makePlannerSignature(plan) {
    const tools = (plan.candidate_tools || []).map(String).sort().join('|');
    const next = String(plan.next_step || '').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();
    return `${plan.need_tools ? 'tools' : 'answer'}::${tools}::${next}`.slice(0, 600);
  }

  #plannerSimilarity(a, b) {
    const sa = new Set(String(a || '').split(/\s+|::|\|/).filter(Boolean));
    const sb = new Set(String(b || '').split(/\s+|::|\|/).filter(Boolean));
    if (!sa.size || !sb.size) return 0;
    const inter = [...sa].filter(x => sb.has(x)).length;
    const union = new Set([...sa, ...sb]).size || 1;
    return inter / union;
  }

  #filterToolDefs(toolDefs, candidateNames = []) {
    const wanted = new Set(candidateNames.map(String));
    return toolDefs.filter(td => {
      const name = td?.function?.name || td?.name;
      return name === 'tool_search' || wanted.has(name);
    });
  }

  async #prepareAndExecuteTools(toolCalls, roundNumber, turnState, meta = {}) {
    const maxCalls = this.#runtimeConfig.maxToolCallsPerTurn;
    const results = [];
    const toExecute = [];
    const firstSafeCallBySignature = new Map();
    const aliasSafeCalls = [];

    for (const tc of toolCalls) {
      const signature = this.#toolSignature(tc);
      const count = (turnState.toolSignatureCounts.get(signature) || 0) + 1;
      turnState.toolSignatureCounts.set(signature, count);
      const cacheSafe = this.#tools?.isCacheSafeTool?.(tc.name) ?? false;
      const cached = turnState.memoizedToolResults.get(signature);

      if (turnState.totalToolCalls >= maxCalls) {
        turnState.suppressedToolCalls += 1;
        results.push(this.#makeGuardrailToolResult(tc, `Per-turn tool call budget of ${maxCalls} reached. Narrow the task or summarize what you already learned before requesting more tools.`, roundNumber, 'tool_call_budget_exceeded'));
        continue;
      }

      if (cacheSafe && cached) {
        turnState.cacheHits += 1;
        turnState.totalToolCalls += 1;
        results.push(this.#makeCachedToolResult(tc, cached, roundNumber, count));
        continue;
      }

      if (cacheSafe && firstSafeCallBySignature.has(signature)) {
        turnState.cacheHits += 1;
        turnState.totalToolCalls += 1;
        aliasSafeCalls.push({ tc, signature, count, originalId: firstSafeCallBySignature.get(signature) });
        continue;
      }

      if (!cacheSafe && count > 1) {
        turnState.suppressedToolCalls += 1;
        turnState.totalToolCalls += 1;
        results.push(this.#makeGuardrailToolResult(tc, 'Repeated identical side-effecting call suppressed within the same turn to avoid duplicate writes/exec/actions.', roundNumber, 'repeated_side_effect_suppressed'));
        continue;
      }

      turnState.totalToolCalls += 1;
      if (cacheSafe) firstSafeCallBySignature.set(signature, tc.id);
      toExecute.push(tc);
    }

    const executed = toExecute.length > 0
      ? await this.#executeTools(toExecute, roundNumber, meta)
      : [];

    const executedMap = new Map(executed.map(r => [r.id, r]));
    for (const r of executed) {
      const signature = this.#toolSignature({ name: r.name, input: toolCalls.find(tc => tc.id === r.id)?.input || {} });
      if ((this.#tools?.isCacheSafeTool?.(r.name) ?? false) && r.ok) {
        turnState.memoizedToolResults.set(signature, {
          ...r,
          round: roundNumber,
          preview: String(r.content || '').slice(0, 500),
          originalToolCallId: r.id,
        });
      }
    }

    for (const alias of aliasSafeCalls) {
      const cached = turnState.memoizedToolResults.get(alias.signature);
      if (cached) {
        results.push(this.#makeCachedToolResult(alias.tc, cached, roundNumber, alias.count));
      } else {
        results.push(this.#makeGuardrailToolResult(alias.tc, 'Identical cache-safe call was deduplicated, but its primary execution did not produce a reusable result.', roundNumber, 'dedupe_primary_missing'));
      }
    }

    for (const tc of toolCalls) {
      const existing = results.find(r => r.id === tc.id);
      if (existing) continue;
      results.push(executedMap.get(tc.id));
    }

    return results;
  }

  #shapeToolResultForContext(tr, turnState) {
    const maxPerCall = this.#runtimeConfig.maxToolResultCharsPerCall;
    const maxPerTurn = this.#runtimeConfig.maxToolResultCharsPerTurn;
    const original = String(tr.content || '');
    const meta = [
      tr.name || 'tool',
      tr.cached ? 'cache-hit' : null,
      tr.latencyMs != null ? `${tr.latencyMs}ms` : null,
      tr.resultBytes != null ? `${tr.resultBytes}B` : null,
      tr.errorCode ? `code=${tr.errorCode}` : null,
    ].filter(Boolean).join(' · ');

    let content = original;
    let localCap = tr.ok === false ? Math.min(maxPerCall, 8000) : maxPerCall;
    if (turnState.toolContextChars > maxPerTurn * 0.7) {
      localCap = Math.min(localCap, 2400);
    }

    if (content.length > localCap) {
      const head = content.slice(0, Math.floor(localCap * 0.75));
      const tail = content.slice(-Math.floor(localCap * 0.15));
      content = `[Tool Result Shaped] ${meta}
${head}${tail ? `
…
${tail}` : ''}
[truncated from ${original.length} chars]`;
    } else if (meta) {
      content = `[Tool Result] ${meta}
${content}`;
    }

    if (turnState.toolContextChars + content.length > maxPerTurn) {
      const remaining = Math.max(1000, maxPerTurn - turnState.toolContextChars);
      const clipped = content.slice(0, remaining);
      content = `${clipped}
[turn tool-context cap reached at ${maxPerTurn} chars]`;
    }

    turnState.toolContextChars += content.length;
    return content;
  }

  /**
   * Execute a batch of tool calls.
   * @param {Array} toolCalls - Array of { id, name, input }
   * @param {number} roundNumber
   * @returns {Promise<Array<{ id: string, name: string, content: string, ok: boolean, errorCode: string|null, latencyMs: number, resultBytes: number, round: number }>>}
   */
  async #executeTools(toolCalls, roundNumber = 0, meta = {}) {
    if (!this.#tools) {
      return toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        content: '[Tool Error] Tool execution not available',
        ok: false,
        errorCode: 'tooling_unavailable',
        latencyMs: 0,
        resultBytes: Buffer.byteLength('[Tool Error] Tool execution not available'),
        round: roundNumber,
      }));
    }

    const SEQUENTIAL_TOOLS = new Set([
      'exec', 'file_write', 'file_edit', 'constellation_remember',
    ]);

    const sequential = [];
    const parallel = [];
    for (const tc of toolCalls) {
      if (SEQUENTIAL_TOOLS.has(tc.name)) sequential.push(tc);
      else parallel.push(tc);
    }

    // Per-tool watchdog: prevents a single stuck tool from holding the whole turn open
    // until session_timeout (90 min). 'exec' may legitimately be a long experiment, so we
    // honor tc.input.timeout (capped at HARD ceiling); everything else is bounded tightly.
    const watchdogMsFor = (tc) => {
      if (tc.name === 'exec') {
        const requested = Number(tc?.input?.timeout) || 0;
        const baseline = Math.max(TOOL_WATCHDOG_BASH_MS, requested);
        return Math.min(baseline, TOOL_WATCHDOG_EXPERIMENT_HARD_MS);
      }
      return TOOL_WATCHDOG_DEFAULT_MS;
    };

    const executeOne = async (tc) => {
      const watchdogMs = watchdogMsFor(tc);
      let watchdogTimer = null;
      const watchdog = new Promise((_, reject) => {
        watchdogTimer = setTimeout(() => {
          const err = new Error(`Tool watchdog: ${tc.name} did not return within ${watchdogMs / 1000}s`);
          err.code = 'tool_watchdog_timeout';
          reject(err);
        }, watchdogMs);
      });
      const startedAt = Date.now();
      let result;
      try {
        const envelope = await Promise.race([
          this.#tools.executeStructured(tc.name, tc.input, { ...meta, toolCallId: tc.id, roundNumber }),
          watchdog,
        ]);
        result = {
          id: tc.id,
          name: tc.name,
          content: envelope.content,
          ok: Boolean(envelope.ok),
          errorCode: envelope.error?.type ?? null,
          latencyMs: envelope.meta?.elapsedMs ?? (Date.now() - startedAt),
          resultBytes: envelope.meta?.resultBytes ?? Buffer.byteLength(envelope.content || ''),
          round: roundNumber,
        };
      } catch (err) {
        this.emit('warning', {
          type: 'tool_execution_error',
          tool: tc.name,
          error: err.message,
        });
        const content = `[Tool Error:${tc.name}] ${err.message}`;
        result = {
          id: tc.id,
          name: tc.name,
          content,
          ok: false,
          errorCode: err?.code || 'tool_execution_error',
          latencyMs: Date.now() - startedAt,
          resultBytes: Buffer.byteLength(content),
          round: roundNumber,
        };
      } finally {
        if (watchdogTimer) clearTimeout(watchdogTimer);
      }
      liveBus.safeEmit('runtime.tool', {
        tool: result.name,
        ok: result.ok,
        duration_ms: result.latencyMs,
        bytes: result.resultBytes,
        round: result.round,
        sessionId: meta?.sessionId || null,
        errorCode: result.errorCode,
      });
      return result;
    };

    const parallelResults = parallel.length > 0
      ? await Promise.all(parallel.map(executeOne))
      : [];

    const sequentialResults = [];
    for (const tc of sequential) {
      sequentialResults.push(await executeOne(tc));
    }

    const resultMap = new Map();
    for (const r of [...parallelResults, ...sequentialResults]) {
      resultMap.set(r.id, r);
    }
    return toolCalls.map(tc => resultMap.get(tc.id));
  }

  #compressHistoricalToolResults(messages, currentRound) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg?.role !== 'tool') continue;
      if (msg.tool_ok === false || msg.toolOk === false) continue;
      const round = msg.tool_round ?? msg.toolRound ?? null;
      if (round == null || round >= currentRound - 1) continue;
      if (typeof msg.content !== 'string' || msg.content.length <= 900) continue;
      if (/\[compressed older tool result\]/.test(msg.content)) continue;

      messages[i] = {
        ...msg,
        content: this.#compressToolContent(msg),
      };
    }
  }

  #compressToolContent(msg) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    const head = content.slice(0, 420);
    const tail = content.length > 220 ? content.slice(-220) : '';
    const suffix = tail ? `
…
${tail}` : '';
    const meta = [
      msg.tool_name ?? msg.toolName ?? 'tool',
      (msg.tool_latency_ms ?? msg.toolLatencyMs) != null ? `${msg.tool_latency_ms ?? msg.toolLatencyMs}ms` : null,
      (msg.tool_result_bytes ?? msg.toolResultBytes) != null ? `${msg.tool_result_bytes ?? msg.toolResultBytes}B` : null,
    ].filter(Boolean).join(' · ');
    const header = meta ? `[compressed older tool result] ${meta}` : '[compressed older tool result]';
    return `${header}
${head}${suffix}`;
  }

  /**
   * Check if compaction threshold is exceeded and compact if so.
   * @param {string} sessionId
   * @returns {Promise<boolean>} Whether compaction was triggered
   */
  async #maybeCompact(sessionId) {
    const cfg = this.#runtimeConfig;
    const activeBudget = Math.floor(cfg.contextBudget * cfg.activeRatio);
    const activeTokens = this.#session.getActiveTokenCount(sessionId);
    const threshold = activeBudget * cfg.compactionThreshold;

    if (activeTokens > threshold) {
      await this.#performCompaction(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Perform compaction: summarize old messages + write to constellation + update session.
   * @param {string} sessionId
   */
  async #performCompaction(sessionId) {
    const activeMessages = this.#session.getActiveMessages(sessionId);
    if (activeMessages.length < 4) return; // Too few to compact

    // Keep the last 4 messages, but never cut into the middle of a tool-result run.
    const keepCount = 4;
    let keepStart = Math.max(0, activeMessages.length - keepCount);
    keepStart = this.#adjustTrimStartForToolPairing(activeMessages, keepStart);
    const toCompact = activeMessages.slice(0, keepStart);
    const compactBeforeId = activeMessages[keepStart]?.id;

    if (toCompact.length === 0 || !compactBeforeId) return;

    // Build text to summarize
    const conversationText = toCompact
      .map(m => {
        if (m.role === 'tool') {
          const status = m.toolOk === false || m.tool_ok === false ? 'error' : 'ok';
          const label = m.toolName ?? m.tool_name ?? 'tool';
          return `[tool:${label} ${status}]: ${m.content || '(empty)'}`;
        }
        return `[${m.role}]: ${m.content || '(empty)'}`;
      })
      .join('\n\n');

    try {
      // Summarize using compact model
      const summary = await this.#llm.summarize(conversationText, COMPACTION_INSTRUCTION);

      // Update session with summary (also stamps adaptive-window compaction timestamp).
      this.#session.compact(sessionId, summary, compactBeforeId);

      // Compaction summaries no longer written to star map.
      // Star map + conversation DB + Anamnesis provide sufficient memory coverage.
      // Compaction still works normally for context window management.

      this.emit('compaction', {
        sessionId,
        messagesCompacted: toCompact.length,
        summaryLength: summary.length,
      });

      // Verify compaction actually reduced tokens
      const afterTokens = this.#session.getActiveTokenCount(sessionId);
      const beforeThreshold = this.#runtimeConfig.contextBudget * this.#runtimeConfig.activeRatio * this.#runtimeConfig.compactionThreshold;
      if (afterTokens > beforeThreshold * 0.7) {
        // Compaction didn't help enough — hard truncate as fallback
        this.emit('warning', { type: 'compaction_insufficient', sessionId, afterTokens, threshold: beforeThreshold });
        this.#session.hardTruncate(sessionId, 8);
      }

    } catch (err) {
      // Compaction failed — hard truncate as fallback instead of leaving context bloated
      this.emit('error', {
        type: 'compaction_failed_fallback',
        sessionId,
        error: err.message,
      });
      try { this.#session.hardTruncate(sessionId, 8); } catch {}
    }
  }

  /**
   * ─── Mode B + Route C: Two-Pass Compilation ───────────────────────────────
   * R1 (pre-flight): Lightweight LLM call with reasoning paths + top nodes only.
   *   Outputs a response skeleton + <need_info>query</need_info> tags for gaps.
   * R2 (main pass): Full LLM call with R1 skeleton + supplementary info injected.
   */

  // R1 prompt template — compact, focused on skeleton + need_info tagging
  static #R1_TEMPLATE = `You are an AI assistant in skeleton-draft mode.

## Your Task
Read the user's message and the provided context (reasoning paths + top knowledge nodes).
Produce a SKELETON response — an outline of the key points you would make.

## Rules
1. Write the skeleton in the SAME language the user used (Chinese → Chinese, English → English).
2. For any factual claim or knowledge point you are NOT confident about from the provided context, wrap a short query in <need_info>your query here</need_info> tags. The engine will resolve these before your final pass.
3. Keep the skeleton concise — bullet points, not full paragraphs.
4. Do NOT fabricate facts. If unsure, use <need_info> instead.
5. Maximum 5 <need_info> tags per response.
6. Do NOT output any <think> or reasoning tags.`;

  // R2 system append — prepended to the normal system prompt for the main pass
  static #R2_HEADER = `## Pre-flight Context (from skeleton pass)
The following skeleton and supplementary information were compiled in a pre-flight pass.
Use them to produce your final, complete response. Do not mention the skeleton or pre-flight process.`;

  /**
   * Execute two-pass pre-flight: R1 skeleton → need_info resolution → R2 injection.
   * @param {string} sessionId
   * @param {string} userMessage
   * @param {string} systemPrompt - The full system prompt (already built)
   * @param {object} options - Turn options
   * @returns {Promise<{skeleton: string, supplementary: string}|null>} null = fallback to single-pass
   */
  async #executeTwoPassPreFlight(sessionId, userMessage, systemPrompt, options = {}) {
    const R1_TIMEOUT = 30000;
    const R1_MAX_OUTPUT = 2048;
    try {
      // Build R1 messages: instructions + context in user message (NOT system).
      // Some upstream gateways override system messages with their own identity,
      // so we inject context via the user message for portability.
      const r1Context = this.#extractR1Context(systemPrompt);
      const r1UserMessage = `${AgentRuntime.#R1_TEMPLATE}\n\n## Context\n${r1Context}\n\n## User Query\n${userMessage}`;

      const r1Messages = [
        { role: 'user', content: r1UserMessage },
      ];

      // R1 call — use compact model, no tools, hard timeout
      let r1Timer;
      const r1Response = await Promise.race([
        this.#llm.chat(r1Messages, {
          model: this.#runtimeConfig.twoPassR1Model || this.#llm?.config?.compactModel || undefined,
          _role: 'compact',
          _noFallback: true,
          maxTokens: R1_MAX_OUTPUT,
          _trigger: 'twopass-r1',
          _sessionId: sessionId,
        }),
        new Promise((_, reject) => { r1Timer = setTimeout(() => reject(new Error('R1 timeout')), R1_TIMEOUT); }),
      ]).finally(() => clearTimeout(r1Timer));

      const skeleton = (r1Response.content || '').trim();
      console.log(`  [TwoPass] R1 skeleton length: ${skeleton.length} chars`);
      console.log(`  [TwoPass] R1 skeleton preview: ${skeleton.slice(0, 300)}...`);
      if (!skeleton || skeleton.length < 20) {
        console.warn('[TwoPass] R1 skeleton too short, falling back to single-pass');
        return null;
      }

      // Extract and resolve <need_info> tags
      const needInfoQueries = this.#extractNeedInfo(skeleton);
      console.log(`  [TwoPass] Found ${needInfoQueries.length} need_info queries: ${JSON.stringify(needInfoQueries.slice(0, 5))}`);
      let supplementary = '';
      if (needInfoQueries.length > 0) {
        supplementary = await this.#resolveNeedInfo(needInfoQueries);
        console.log(`  [TwoPass] Supplementary length: ${supplementary.length} chars`);
      }

      // Strip <need_info> tags from skeleton for R2
      const cleanSkeleton = skeleton.replace(/<need_info>[\s\S]*?<\/need_info>/g, '').trim();
      console.log(`  [TwoPass] Clean skeleton length: ${cleanSkeleton.length} chars`);

      return { skeleton: cleanSkeleton, supplementary };
    } catch (err) {
      console.warn(`[TwoPass] Pre-flight failed: ${err.message}\n${err.stack}`);
      return null;
    }
  }

  /**
   * Extract reasoning paths + top pool nodes from the full system prompt for R1.
   * Keeps only the most relevant context to stay within R1's compact budget.
   * @param {string} systemPrompt
   * @returns {string}
   */
  #extractR1Context(systemPrompt) {
    const sections = [];

    // Extract reasoning paths section (Layer 3.5.1)
    const reasoningMatch = systemPrompt.match(/## 🔗 Reasoning Paths[\s\S]*?(?=\n## |$)/);
    if (reasoningMatch) {
      sections.push(reasoningMatch[0].slice(0, 3000));
    }

    // Extract attention pool section (top nodes only — first 2000 chars)
    const poolMatch = systemPrompt.match(/## 🧠 (?:Mímir Attention Pool|Mímir State|Episodic Memory)[\s\S]*?(?=\n## |$)/);
    if (poolMatch) {
      sections.push(poolMatch[0].slice(0, 2000));
    }

    // Phase 6: include Activated Principles (load-bearing axioms) if present
    const principleMatch = systemPrompt.match(/## 📐 Activated Principles[\s\S]*?(?=\n## |$)/);
    if (principleMatch) {
      sections.push(principleMatch[0].slice(0, 1200));
    }
    // Phase 6: include Activated Episodes (past decisions/reflections) if present
    const episodicMatch = systemPrompt.match(/## 📔 Activated Episodes[\s\S]*?(?=\n## |$)/);
    if (episodicMatch) {
      sections.push(episodicMatch[0].slice(0, 1200));
    }

    // Extract constellation live render (topic portion only)
    const constellationMatch = systemPrompt.match(/🔍 Constellation:[\s\S]*?(?=\n── ──|\n## |$)/);
    if (constellationMatch) {
      sections.push(constellationMatch[0].slice(0, 2000));
    }

    if (sections.length === 0) {
      // Fallback: take last 3000 chars of system prompt (likely the most dynamic parts)
      sections.push(systemPrompt.slice(-3000));
    }

    return sections.join('\n\n');
  }

  /**
   * Extract <need_info>query</need_info> tags from R1 skeleton.
   * @param {string} text
   * @returns {string[]} Array of query strings (max 5)
   */
  #extractNeedInfo(text) {
    const matches = [];
    const regex = /<need_info>([\s\S]*?)<\/need_info>/g;
    let m;
    while ((m = regex.exec(text)) !== null && matches.length < 5) {
      const query = m[1].trim();
      if (query.length > 0 && query.length < 500) {
        matches.push(query);
      }
    }
    return matches;
  }

  /**
   * Resolve need_info queries against constellation (star map) and return supplementary text.
   * Each query gets 10s timeout; results are concatenated.
   * @param {string[]} queries
   * @returns {Promise<string>}
   */
  async #resolveNeedInfo(queries) {
    // Dynamic budget: 20s base + 8s per query, capped at 60s
    // All queries run in parallel sharing the same deadline
    const totalBudget = Math.min(20000 + queries.length * 8000, 60000);
    const deadline = Date.now() + totalBudget;

    // Run all queries in parallel with shared deadline
    const promises = queries.map(async (query, i) => {
      try {
        const remaining = () => Math.max(deadline - Date.now(), 500); // floor 500ms to avoid instant timeout
        let qTimer;
        const result = await Promise.race([
          (async () => {
            // Primary: constellation render (star map semantic search)
            if (this.#engine && typeof this.#engine.renderSync === 'function') {
              const rendered = this.#engine.renderSync(query, { budget: 1500, maxDepth: 2, maxL2: 2 });
              const text = typeof rendered === 'string' ? rendered : rendered?.text;
              if (text && text.trim().length > 20) return { source: 'constellation', text: text.trim() };
            }
            // Fallback: web search — gets whatever time is left in the budget
            const timeLeft = remaining();
            if (timeLeft < 2000) return null; // Not enough time for a web search
            const webResult = await this.#webSearch(query, timeLeft);
            if (webResult) return { source: 'web', text: webResult };
            return null;
          })(),
          new Promise((_, reject) => { qTimer = setTimeout(() => reject(new Error('query timeout')), remaining()); }),
        ]).finally(() => clearTimeout(qTimer));
        if (result) return { idx: i, query, answer: result.text, source: result.source };
      } catch {
        // Timeout or error — skip this query
      }
      return null;
    });

    const resolved = (await Promise.all(promises)).filter(Boolean);
    // Debug: log resolution sources
    for (const r of resolved) {
      console.log(`  [TwoPass] need_info resolved: source=${r.source}, query="${r.query.slice(0, 60)}..."`);
    }

    if (resolved.length === 0) return '';

    const lines = resolved.map(r => {
      const prefix = r.source === 'web' ? '[Web Search] ' : '';
      return `### Q: ${r.query}\n${prefix}${r.answer}`;
    });
    const joined = lines.join('\n\n');
    // Cap supplementary text to prevent R2 prompt bloat
    return joined.length > 8000 ? joined.slice(0, 8000) + '\n[…truncated]' : joined;
  }

  /**
   * Web search via DuckDuckGo HTML. Returns top-3 results as formatted text.
   * @param {string} query
   * @param {number} [timeoutMs=12000] - Timeout in ms, dynamically passed from remaining budget
   * @returns {Promise<string|null>}
   */
  async #webSearch(query, timeoutMs = 12000) {
    const WEB_TIMEOUT = Math.min(Math.max(timeoutMs, 3000), 20000); // clamp 3-20s
    const MAX_RESULTS = 3;
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'ConstellationEngine/1.0 (Knowledge Graph)',
          'Accept-Language': 'en-US,en;q=0.9,zh;q=0.8',
        },
        signal: AbortSignal.timeout(WEB_TIMEOUT),
      });
      if (!resp.ok) return null;
      const html = await resp.text();

      // Extract search results from DuckDuckGo HTML response
      // Each result is in a <div class="result"> with <a class="result__a"> (title) and <a class="result__snippet"> (snippet)
      const results = [];
      const resultRegex = /<[a-z]+[^>]*class="result__a"[^>]*>([\s\S]*?)<\/[a-z]+>[\s\S]*?<[a-z]+[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/[a-z]+>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < MAX_RESULTS) {
        const title = match[1].replace(/<[^>]+>/g, '').trim();
        const snippet = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").trim();
        if (title && snippet) {
          results.push(`**${title}**: ${snippet}`);
        }
      }

      if (results.length === 0) return null;
      return results.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * @param {number} tokenBudget
   * @returns {string}
   */
  #trimToTokenBudget(text, tokenBudget) {
    const charBudget = Math.floor(tokenBudget * 3.0); // Inverse of chars/3.0 (calibrated for zh+en mix)
    if (text.length <= charBudget) return text;
    return text.slice(0, charBudget) + '\n\n[...truncated]';
  }

  /**
   * Estimate token count from text (chars / 3.0 for zh+en mixed content).
   * CJK characters tokenize ~1.5-2 tokens per char; 3.0 is conservative safe ratio.
   * @param {string} text
   * @returns {number}
   */
  #estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.0);
  }
}

export default AgentRuntime;
