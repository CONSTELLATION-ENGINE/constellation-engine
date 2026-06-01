// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module config
 * @description Configuration loader and validator for Constellation Engine.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} EngineConfig
 * @property {string} dbPath - Path to constellation.db
 * @property {string} modelId - Embedding model ID
 */

/**
 * @typedef {Object} LLMConfig
 * @property {string} baseUrl - LiteLLM proxy or direct API URL
 * @property {string} apiKey - API key (or env ref like $ANTHROPIC_API_KEY)
 * @property {string} primaryModel - Main model for conversation
 * @property {string} compactModel - Cheaper model for summarization
 * @property {string} [fallbackModel] - Fallback model on primary failure
 * @property {number} [maxRetries=2] - Max retry attempts
 * @property {number} [timeoutMs=120000] - Request timeout
 */

/**
 * @typedef {Object} TelegramConfig
 * @property {string} token - Bot API token
 * @property {string} allowedUserId - Founder's Telegram user ID
 * @property {number} [maxMessageLength=4096] - Max message length before splitting
 */

/**
 * @typedef {Object} CronTask
 * @property {string} name - Task identifier
 * @property {string} schedule - Cron expression
 * @property {'agentTurn'|'systemEvent'} mode - Execution mode
 * @property {string} prompt - Injected instruction text
 * @property {boolean} [delivery=true] - Whether to deliver response to Telegram
 * @property {boolean} [enabled=true] - Whether task is active
 */

/**
 * @typedef {Object} CronConfig
 * @property {CronTask[]} tasks - Scheduled tasks
 * @property {string} [timezone='UTC'] - Default timezone
 */

/**
 * @typedef {Object} ToolsConfig
 * @property {string[]} [mcpServers] - MCP server stdio commands
 * @property {boolean} [enableBuiltins=true] - Enable built-in tools
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {number} [contextBudget=180000] - Total token budget
 * @property {number} [fixedRatio=0.10] - Fixed layer ratio
 * @property {number} [constellationRatio=0.28] - Constellation render ratio
 * @property {number} [summaryRatio=0.10] - Summary layer ratio
 * @property {number} [activeRatio=0.52] - Active messages ratio
 * @property {number} [compactionThreshold=0.70] - Trigger compaction when active tokens exceed this ratio of activeRatio budget
 * @property {number} [maxToolRounds=25] - Max tool-use loop iterations
 * @property {string[]} [fixedFiles] - Paths to always-inject files (SYSTEM_PREAMBLE.md, COGNITIVE_STATE.md, etc.)
 */

/**
 * @typedef {Object} AppConfig
 * @property {EngineConfig} engine
 * @property {LLMConfig} llm
 * @property {TelegramConfig} telegram
 * @property {CronConfig} cron
 * @property {ToolsConfig} tools
 * @property {RuntimeConfig} runtime
 */

/** Default configuration values */
const DEFAULTS = {
  identity: {
    agent_name: 'Agent',
    owner_name: 'Owner',
    owner_display_name: '',
    default_language: 'English',
  },
  locale: {
    // Empty = auto-detect system tz via Intl (OSS-friendly). Explicit IANA
    // tz like 'UTC' or 'America/Los_Angeles' overrides.
    timezone: '',
  },
  engine: {
    dbPath: resolve(__dirname, '../constellation.db'),
    modelId: 'Xenova/bge-m3',
    ir: {
      episodic: { enabled: true, rerank_min: 0.3, top_k: 5, pool_size: 10 },
      deep_recall: { enabled: true, rerank_min: 0.3, cutoff_days: 7 },
      pool_anchor: { enabled: true },
      raw_context: {
        enabled: true,
        mode: 'recovery_only',
        min_turns: 20,
        min_hours: 4,
        max_turns: 20,
        expanded_hours: 8,
        expanded_max_turns: 40,
        tight_episodic_max_turns: 40,
      },
      compaction_summary: {
        inject: false,
      },
    },
    star_map: {
      permanent_slots: [
        'soul-core',
        'milestone-eternal-core-memory',
        'constellation-engine-design',
        'lineage',
        'grand-synthesis',
        'constellation-first-principle',
      ],
    },
  },
  llm: {
    authMode: 'api-key',
    provider: '',
    baseUrl: '',
    apiKey: '',
    // Model identifiers are intentionally empty in defaults — the first-run
    // wizard (or an explicit config.json / env override) must populate these.
    // The engine is provider-neutral; any model string the configured provider
    // accepts is valid (Anthropic Claude, OpenAI GPT, OpenRouter, Ollama, etc.).
    primaryModel: '',
    compactModel: '',
    fallbackModel: '',
    maxRetries: 2,
    timeoutMs: 5_400_000,
  },
  telegram: {
    maxMessageLength: 4096,
  },
  cron: {
    tasks: [],
    timezone: 'UTC',
  },
  tools: {
    mcpServers: [],
    enableBuiltins: true,
  },
  runtime: {
    contextBudget: 180_000,
    fixedRatio: 0.10,
    constellationRatio: 0.28,
    summaryRatio: 0.10,
    activeRatio: 0.52,
    compactionThreshold: 0.70,
    maxToolRounds: 25,
    maxTurnTotalTokens: 2_000_000,
    sessionTokenBudget: 10_000_000,
    fixedFiles: ['identity/SYSTEM_PREAMBLE.md', 'identity/COMMUNICATION_STYLE.md'],
  },
};

/**
 * Deep merge two objects (source wins over target).
 * @param {Object} target
 * @param {Object} source
 * @returns {Object}
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Resolve environment variable references in string values.
 * Strings like "$ENV_VAR" or "${ENV_VAR}" are replaced with process.env values.
 * @param {*} value
 * @returns {*}
 */
function resolveEnvVars(value) {
  if (typeof value === 'string') {
    // Match $VAR or ${VAR}
    return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (match, name) => {
      return process.env[name] ?? match;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return value;
}

/**
 * Validate required fields in config.
 * @param {AppConfig} config
 * @throws {Error} If required fields are missing
 */
function validate(config) {
  const errors = [];

  const authMode = config.llm?.authMode || 'api-key';
  if (authMode === 'api-key' && !config.llm?.apiKey) {
    errors.push('llm.apiKey is required when authMode="api-key" (set directly in config or via your provider\'s API key env var)');
  }
  if (authMode === 'claude-proxy' && !config.llm?.proxyUrl) {
    errors.push('llm.proxyUrl is required when authMode="claude-proxy"');
  }
  if (authMode === 'oauth' && !config.llm?.oauthToken && !config.llm?.oauthCredentialsPath) {
    errors.push('llm.oauthToken or llm.oauthCredentialsPath is required when authMode="oauth"');
  }
  if (authMode === 'gateway') {
    if (!config.llm?.baseUrl) errors.push('llm.baseUrl is required when authMode="gateway"');
    if (!config.llm?.apiKey) errors.push('llm.apiKey is required when authMode="gateway"');
  }
  // telegram.token and allowedUserId are optional (CLI mode works without them)

  // Validate runtime ratios sum to ~1.0
  const r = config.runtime;
  const sum = (r.fixedRatio || 0) + (r.constellationRatio || 0) +
              (r.summaryRatio || 0) + (r.activeRatio || 0);
  if (Math.abs(sum - 1.0) > 0.01) {
    errors.push(`runtime ratios must sum to ~1.0, got ${sum.toFixed(3)}`);
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Load configuration from a JSON file, merge with defaults, resolve env vars, validate.
 * @param {string} [configPath] - Path to config.json. Defaults to ../config.json relative to src/
 * @returns {AppConfig}
 */
export function loadConfig(configPath) {
  const explicit = !!configPath;
  const resolved = configPath
    ? resolve(configPath)
    : resolve(__dirname, '../config.json');

  let raw = {};
  if (existsSync(resolved)) {
    try {
      raw = JSON.parse(readFileSync(resolved, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse config: ${err.message}`);
    }
  } else if (explicit) {
    throw new Error(`Config file not found: ${resolved}`);
  } else {
    console.log(`         → No config.json at ${resolved}, using DEFAULTS`);
  }

  const merged = deepMerge(DEFAULTS, raw);
  const config = resolveEnvVars(merged);

  // Stage 5 onboarding writes identity/profile.json (user_name + agent_name).
  // Layer it over config.identity so the running engine + preamble template
  // substitution see the names the user picked, without requiring a config.json
  // edit.
  try {
    const profilePath = resolve(__dirname, '..', 'identity', 'profile.json');
    if (existsSync(profilePath)) {
      const prof = JSON.parse(readFileSync(profilePath, 'utf-8')) || {};
      config.identity = config.identity || {};
      if (typeof prof.agent_name === 'string' && prof.agent_name.trim()) {
        config.identity.agent_name = prof.agent_name.trim().slice(0, 32);
      }
      if (typeof prof.user_name === 'string' && prof.user_name.trim()) {
        config.identity.owner_name = prof.user_name.trim().slice(0, 32);
        if (!config.identity.owner_display_name) {
          config.identity.owner_display_name = config.identity.owner_name;
        }
      }
      if (typeof prof.default_language === 'string' && prof.default_language.trim()) {
        config.identity.default_language = prof.default_language.trim().slice(0, 32);
      }
    }
  } catch { /* malformed profile.json is non-fatal — fall back to defaults */ }

  validate(config);

  return config;
}

export { DEFAULTS };

/**
 * Returns the set of immutable (permanent slot) node IDs from a loaded config.
 * Mirror of Python `PERMANENT_SLOT_IDS` (mimir_daemon.py). Used by JS-side
 * write paths (resolver, reconsolidation) to skip supersede/REVISE/SKIP on
 * identity / soul-core / founder-profile nodes.
 *
 * @param {AppConfig} config
 * @returns {Set<string>}
 */
export function loadImmutableNodeIds(config) {
  const slots = config?.engine?.star_map?.permanent_slots;
  if (!Array.isArray(slots)) return new Set();
  return new Set(slots.filter(s => typeof s === 'string' && s.length > 0));
}
