// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * tool-manager.js — tool manager
 *
 * Unified manager for built-in tools plus future MCP extensions.
 * Each tool is defined as { name, description, parameters, execute, parallel? }
 *
 * Built-in tools (P0-P1):
 *   constellation_remember — write a star-map node
 *   constellation_query   — query the star-map rendering
 *   constellation_stats   — star-map statistics
 *   file_read             — read a file (path whitelist)
 *   file_write            — write a file (path whitelist)
 *   exec                  — run a shell command (restricted)
 *   memory_search         — star-map embedding semantic search
 *   workspace_search      — full-text search across markdown files (identity/engine-output/engine-inbox/library/workspace)
 *   list_files            — browse directory structure
 *   web_fetch             — HTTP GET + text extraction
 *
 * @module tool-manager
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';

// Cross-platform recursive walker (replaces Unix `grep -r` / `find`). Yields
// absolute file paths under `root`. `filter(name)` decides whether to descend
// into a directory or include a file. Skips symlinks (cycle defense).
async function* _walkFiles(root, filter, maxDepth = 16) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      // Skip hidden/system dirs that explode on Windows (node_modules already
      // outside our search dirs by convention).
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
      else if (e.isFile() && (!filter || filter(e.name))) yield full;
    }
  }
}

function _globToRegex(glob) {
  // Minimal *.md / *.txt support — escapes regex metas, then * → .*
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

// ─── Tool Definition Schema ───

/**
 * @typedef {Object} ToolDefinition
 * @property {string} name - tool name
 * @property {string} description - description (shown to the LLM)
 * @property {Object} parameters - JSON Schema
 * @property {function(Object): Promise<string|Object>} execute - executor function
 * @property {boolean} [parallel=false] - whether the tool is safe to run in parallel
 */

/**
 * @typedef {Object} ToolsConfig
 * @property {string[]} [builtIn] - list of enabled built-in tool names (empty = all)
 * @property {string[]} [allowedPaths] - file_read/file_write whitelist directories
 * @property {string[]} [execAllowlist] - exec command whitelist prefixes
 * @property {number} [execTimeout=10000] - exec timeout in ms
 * @property {Object[]} [mcpServers] - MCP server configuration (Phase 2)
 * @property {boolean} [deferLoading=true] - Whether to defer non-core tools behind tool_search
 * @property {number} [toolSearchThreshold=10] - Minimum tool count before deferred loading kicks in
 * @property {string[]} [coreTools] - Tool names that always stay visible to the model
 */

/**
 * @typedef {Object} ToolExecutionEnvelope
 * @property {string} name
 * @property {boolean} ok
 * @property {string} content
 * @property {any} raw
 * @property {{type:string,message:string}|null} error
 * @property {{elapsedMs:number,resultBytes:number}} meta
 */

// ─── ToolManager ───

export class ToolManager extends EventEmitter {
  /** @type {Map<string, ToolDefinition>} */
  #tools = new Map();
  #engine;
  #config;
  #convStore = null;
  #resolver = null;
  /** @type {Map<string, Set<string>>} */
  #sessionActivatedTools = new Map();

  /**
   * @param {Object} engine - ConstellationEngine instance
   * @param {ToolsConfig} [config={}]
   */
  constructor(engine, config = {}) {
    super();
    this.#engine = engine;

    // Default safe paths if none configured: engine root + common subdirs
    const defaultAllowedPaths = [
      resolve(process.cwd()),  // engine root
    ];
    // Default safe exec commands if none configured
    const defaultExecAllowlist = [
      'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo', 'date',
      'node', 'sqlite3', 'cd', 'pwd', 'stat', 'file', 'sort', 'uniq',
      'diff', 'tr', 'cut', 'awk', 'sed', 'jq', 'du', 'df',
    ];

    this.#config = {
      builtIn: config.builtIn || [],
      allowedPaths: (config.allowedPaths && config.allowedPaths.length > 0) ? config.allowedPaths.map(p => resolve(p)) : defaultAllowedPaths,
      execAllowlist: config.execAllowlist || defaultExecAllowlist,
      execTimeout: config.execTimeout ?? 10000,
      mcpServers: config.mcpServers || [],
      deferLoading: config.deferLoading ?? true,
      toolSearchThreshold: config.toolSearchThreshold ?? 10,
      coreTools: config.coreTools || [
        'tool_search', 'constellation_remember', 'constellation_query', 'constellation_stats',
        'memory_search', 'memory_get', 'file_read', 'workspace_search', 'web_fetch', 'list_files',
      ],
      maxAutoActivateTools: config.maxAutoActivateTools ?? 4,
    };

    this.#registerBuiltIns();
  }

  // ─── Public API ───

  /**
   * Get OpenAI function-format definitions for all tools.
   * (agent-runtime calls this and forwards the result to the LLM.)
   * @returns {Object[]}
   */
  getDefinitions(options = {}) {
    // Keyword gate for conversation_fetch_raw: activate if keywords present
    const fetchRawKeywords = ['quote', 'verbatim', 'said exactly', 'word for word'];
    const userMsg = (options.userMessage || '').toLowerCase();
    if (fetchRawKeywords.some(kw => userMsg.includes(kw.toLowerCase()))) {
      if (options.sessionId && !this.getActivatedTools(options.sessionId).includes('conversation_fetch_raw')) {
        this.activateTools(options.sessionId, ['conversation_fetch_raw']);
      }
    }

    const visible = this.#getVisibleTools(options.sessionId);
    const defs = [];
    for (const tool of visible) {
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    return defs;
  }

  /**
   * Get OpenAI function schemas (alias of getDefinitions).
   * @returns {Object[]}
   */
  getSchemas(options = {}) {
    return this.getDefinitions(options);
  }

  /**
   * Execute one tool call and return a structured envelope.
   * @param {string} name
   * @param {Object} [args={}]
   * @returns {Promise<ToolExecutionEnvelope>}
   */
  async executeStructured(name, args = {}, meta = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      const content = `Error: unknown tool "${name}"`;
      return {
        name,
        ok: false,
        content,
        raw: null,
        error: { type: 'unknown_tool', message: content },
        meta: { elapsedMs: 0, resultBytes: Buffer.byteLength(content) },
      };
    }

    const start = Date.now();
    try {
      const raw = await tool.execute(args, meta);
      const content = this.#stringifyToolResult(raw);
      const elapsedMs = Date.now() - start;
      const resultBytes = Buffer.byteLength(content);
      const envelope = {
        name,
        ok: true,
        content,
        raw,
        error: null,
        meta: { elapsedMs, resultBytes },
      };
      this.emit('executed', { name, elapsed: elapsedMs, success: true, resultBytes });
      return envelope;
    } catch (err) {
      const elapsedMs = Date.now() - start;
      const error = this.#normalizeToolError(err);
      const content = `[Tool Error:${name}] ${error.message}`;
      const resultBytes = Buffer.byteLength(content);
      const envelope = {
        name,
        ok: false,
        content,
        raw: null,
        error,
        meta: { elapsedMs, resultBytes },
      };
      this.emit('executed', {
        name,
        elapsed: elapsedMs,
        success: false,
        error: error.message,
        errorCode: error.type,
        resultBytes,
      });
      return envelope;
    }
  }

  /**
   * Execute a single tool call (legacy-compatible: returns a string result).
   * @param {string} name - tool name
   * @param {Object} args - arguments
   * @returns {Promise<string>} execution result text
   */
  async execute(name, args = {}, meta = {}) {
    const envelope = await this.executeStructured(name, args, meta);
    return envelope.content;
  }

  /**
   * Execute tool calls in batch (parallel-safe ones in parallel, the rest serial).
   * @param {Array<{name: string, input: Object}>} toolCalls
   * @returns {Promise<Array<{name: string, result: string}>>}
   */
  async executeBatch(toolCalls) {
    const envelopes = await this.executeBatchStructured(toolCalls);
    return envelopes.map(({ name, content }) => ({ name, result: content }));
  }

  /**
   * Batch tool execution returning structured envelopes.
   * @param {Array<{name: string, input: Object}>} toolCalls
   * @returns {Promise<Array<ToolExecutionEnvelope & {index:number}>>}
   */
  async executeBatchStructured(toolCalls) {
    const indexed = toolCalls.map((tc, index) => ({ ...tc, __index: index }));
    const parallel = [];
    const serial = [];

    for (const tc of indexed) {
      const tool = this.#tools.get(tc.name);
      if (tool?.parallel) parallel.push(tc);
      else serial.push(tc);
    }

    const results = new Map();

    if (parallel.length > 0) {
      const parallelResults = await Promise.all(
        parallel.map(async (tc) => ({
          index: tc.__index,
          ...(await this.executeStructured(tc.name, tc.input, { batch: true, batchIndex: tc.__index })),
        }))
      );
      for (const r of parallelResults) results.set(r.index, r);
    }

    for (const tc of serial) {
      const envelope = await this.executeStructured(tc.name, tc.input, { batch: true, batchIndex: tc.__index });
      results.set(tc.__index, { index: tc.__index, ...envelope });
    }

    return indexed.map((tc) => results.get(tc.__index) || {
      index: tc.__index,
      name: tc.name,
      ok: false,
      content: 'Error: result not found',
      raw: null,
      error: { type: 'missing_result', message: 'Result not found in batch execution map.' },
      meta: { elapsedMs: 0, resultBytes: Buffer.byteLength('Error: result not found') },
    });
  }

  /**
   * Register a custom tool.
   * @param {ToolDefinition} tool
   */
  register(tool) {
    if (!tool.name || !tool.execute) {
      throw new Error('Tool must have name and execute function');
    }
    this.#tools.set(tool.name, {
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
      parallel: tool.parallel ?? false,
      keywords: tool.keywords || [],
      deferLoading: tool.deferLoading ?? false,
      alwaysVisible: tool.alwaysVisible ?? false,
      cacheSafe: tool.cacheSafe ?? false,
      ...tool,
    });
    this.emit('registered', { name: tool.name });
  }

  /**
   * Inject ConversationStore reference (used by conversation_fetch_raw).
   * @param {import('./conversation-store.js').ConversationStore} store
   */
  setConvStore(store) {
    this.#convStore = store;
  }

  /**
   * Inject MimirResolver (Wave 2 SHADOW writer). Optional.
   * @param {import('./mimir-resolver.js').MimirResolver} resolver
   */
  setResolver(resolver) {
    if (resolver && typeof resolver.resolve === 'function') {
      this.#resolver = resolver;
    }
  }

  activateTools(sessionId, names = []) {
    if (!sessionId || !Array.isArray(names) || names.length === 0) return [];
    let set = this.#sessionActivatedTools.get(sessionId);
    if (!set) {
      set = new Set();
      this.#sessionActivatedTools.set(sessionId, set);
    }
    const activated = [];
    for (const name of names) {
      if (!this.#tools.has(name)) continue;
      set.add(name);
      activated.push(name);
    }
    return activated;
  }

  getActivatedTools(sessionId) {
    return [...(this.#sessionActivatedTools.get(sessionId) || new Set())];
  }

  /**
   * Clear activated tools for a session (called on session cleanup).
   * @param {string} sessionId
   */
  clearSessionTools(sessionId) {
    this.#sessionActivatedTools.delete(sessionId);
  }

  /**
   * Prune stale session tool activations (sessions older than maxAgeMs).
   * Call periodically to prevent memory leak from cron temp sessions.
   */
  pruneStaleSessionTools() {
    // Simple approach: if map grows beyond 100 entries, clear oldest half
    if (this.#sessionActivatedTools.size > 100) {
      const keys = [...this.#sessionActivatedTools.keys()];
      const toRemove = keys.slice(0, Math.floor(keys.length / 2));
      for (const k of toRemove) this.#sessionActivatedTools.delete(k);
    }
  }

  searchTools(query, { limit = 8, sessionId = null, activate = false } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const tokens = this.#tokenize(q);
    const results = [];
    for (const tool of this.#tools.values()) {
      if (tool.name === 'tool_search') continue;
      const match = this.#scoreToolMatch(tool, q, tokens, sessionId);
      if (match.score <= 0) continue;
      results.push({
        name: tool.name,
        description: tool.description,
        deferLoading: Boolean(tool.deferLoading),
        activated: sessionId ? this.getActivatedTools(sessionId).includes(tool.name) : false,
        score: match.score,
        reasons: match.reasons,
        keywords: tool.keywords || [],
      });
    }
    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const sliced = results.slice(0, limit);
    if (activate && sessionId) {
      this.activateTools(sessionId, sliced.slice(0, this.#config.maxAutoActivateTools).map(r => r.name));
    }
    return sliced;
  }

  /**
   * List registered tool names.
   * @returns {string[]}
   */
  listTools() {
    return [...this.#tools.keys()];
  }

  /**
   * Return the raw stored definition for a tool (description + parameters + flags).
   * @param {string} name
   * @returns {ToolDefinition|null}
   */
  getRawDefinition(name) {
    const t = this.#tools.get(name);
    if (!t) return null;
    return {
      name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
      parallel: !!t.parallel,
      deferLoading: !!t.deferLoading,
      alwaysVisible: !!t.alwaysVisible,
      cacheSafe: !!t.cacheSafe,
      keywords: t.keywords || [],
    };
  }

  isCacheSafeTool(name) {
    return Boolean(this.#tools.get(name)?.cacheSafe);
  }

  /**
   * Number of registered tools.
   * @returns {number}
   */
  get size() {
    return this.#tools.size;
  }

  #stringifyToolResult(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return JSON.stringify(value, null, 2);
  }

  #normalizeToolError(err) {
    const message = err?.message ? String(err.message) : String(err || 'Unknown tool error');
    const code = String(err?.code || '').toLowerCase();

    let type = 'tool_error';
    if (code === 'enoent') type = 'not_found';
    else if (code === 'eacces' || code === 'eperm') type = 'permission_denied';
    else if (/timeout|timed out/i.test(message)) type = 'timeout';
    else if (/network|fetch failed|econn|enotfound|socket/i.test(message)) type = 'network_error';
    else if (/invalid|schema|json/i.test(message)) type = 'invalid_input';

    return { type, message };
  }

  #getVisibleTools(sessionId = null) {
    const tools = [...this.#tools.values()];
    const deferredEnabled = this.#config.deferLoading && tools.length > this.#config.toolSearchThreshold;
    if (!deferredEnabled) return tools;

    const activated = new Set(sessionId ? this.getActivatedTools(sessionId) : []);
    return tools.filter(tool => {
      if (tool.alwaysVisible) return true;
      if (!tool.deferLoading) return true;
      return activated.has(tool.name);
    });
  }

  #tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  #scoreToolMatch(tool, query, tokens, sessionId) {
    const name = tool.name.toLowerCase();
    const desc = String(tool.description || '').toLowerCase();
    const keywords = (tool.keywords || []).map(k => String(k).toLowerCase());
    const props = Object.keys(tool.parameters?.properties || {}).map(k => k.toLowerCase());
    let score = 0;
    const reasons = [];

    const wholeQuery = query.toLowerCase();
    if (name === wholeQuery) {
      score += 120;
      reasons.push('exact-name');
    } else if (name.includes(wholeQuery)) {
      score += 60;
      reasons.push('name-contains');
    }

    for (const token of tokens) {
      if (name.split(/[_-]+/).includes(token)) {
        score += 25;
        reasons.push(`name:${token}`);
        continue;
      }
      if (name.includes(token)) {
        score += 18;
        reasons.push(`name-part:${token}`);
      }
      if (keywords.some(k => k === token)) {
        score += 16;
        reasons.push(`keyword:${token}`);
      } else if (keywords.some(k => k.includes(token))) {
        score += 10;
        reasons.push(`keyword-part:${token}`);
      }
      if (props.some(p => p === token)) {
        score += 10;
        reasons.push(`arg:${token}`);
      }
      if (desc.includes(token)) {
        score += 6;
        reasons.push(`desc:${token}`);
      }
    }

    if (sessionId && this.getActivatedTools(sessionId).includes(tool.name)) {
      score += 4;
      reasons.push('already-active');
    }
    if (tool.deferLoading) score += 1;
    return { score, reasons: [...new Set(reasons)].slice(0, 4) };
  }

  async #searchConstellationDual(query, { limit = 5, sessionId = null } = {}) {
    const q = String(query || '').trim();
    if (!q || !this.#engine?.db) return [];
    const db = this.#engine.db;
    const tokens = this.#tokenize(q);
    const results = new Map();

    const add = (row, score, reason) => {
      if (!row?.id) return;
      const existing = results.get(row.id);
      if (existing) {
        existing.score += score;
        existing.reasons.add(reason);
      } else {
        results.set(row.id, { row, score, reasons: new Set([reason]) });
      }
    };

    const { sql: _ownSql, params: _ownP } = this.#engine._ownerSqlClause();
    const { sql: _ownSqlN, params: _ownPN } = this.#engine._ownerSqlClause('n');

    const byId = db.prepare(`SELECT id, l0, l1, l2, tags, source, access_count, weight FROM nodes WHERE state='active' AND lower(id) = lower(?)${_ownSql} LIMIT ?`).all(q, ..._ownP, limit);
    for (const row of byId) add(row, 120, 'exact-id');

    const byTag = db.prepare(`SELECT DISTINCT n.id, n.l0, n.l1, n.l2, n.tags, n.source, n.access_count, n.weight
      FROM nodes n, json_each(n.tags)
      WHERE n.state='active' AND lower(json_each.value) = lower(?)${_ownSqlN} LIMIT ?`).all(q, ..._ownPN, limit);
    for (const row of byTag) add(row, 90, 'exact-tag');

    const qTrunc = q.length > 200 ? q.slice(0, 200) : q;  // SQLite LIKE pattern length limit
    const byPrefix = db.prepare(`SELECT id, l0, l1, l2, tags, source, access_count, weight
      FROM nodes WHERE state='active' AND (lower(id) LIKE lower(?) OR l0 LIKE ? OR l1 LIKE ?)${_ownSql} LIMIT ?`).all(`${qTrunc}%`, `%${qTrunc}%`, `%${qTrunc}%`, ..._ownP, limit * 2);
    for (const row of byPrefix) add(row, 45, 'prefix-text');

    for (const token of tokens.slice(0, 6)) {
      const rows = db.prepare(`SELECT DISTINCT n.id, n.l0, n.l1, n.l2, n.tags, n.source, n.access_count, n.weight
        FROM nodes n LEFT JOIN json_each(n.tags)
        WHERE n.state='active' AND (
          lower(n.id) LIKE lower(?) OR lower(n.l0) LIKE lower(?) OR lower(n.l1) LIKE lower(?) OR lower(IFNULL(json_each.value,'')) LIKE lower(?)
        )${_ownSqlN} LIMIT ?`).all(`%${token}%`, `%${token}%`, `%${token}%`, `%${token}%`, ..._ownPN, limit * 2);
      for (const row of rows) add(row, 16, `token:${token}`);
    }

    try {
      // trigram tokenizer requires tokens >= 3 chars; filter short ones
      const ftsTokens = tokens.slice(0, 6).filter(t => t.replace(/"/g, '').length >= 3);
      if (ftsTokens.length > 0) {
        const ftsQuery = ftsTokens.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
        const ftsRows = db.prepare(`SELECT n.id, n.l0, n.l1, n.l2, n.tags, n.source, n.access_count, n.weight, bm25(nodes_fts) AS rank
          FROM nodes_fts JOIN nodes n ON n.id = nodes_fts.node_id
          WHERE nodes_fts MATCH ? AND n.state='active'${_ownSqlN}
          ORDER BY rank LIMIT ?`).all(ftsQuery, ..._ownPN, limit * 2);
        for (const row of ftsRows) add(row, 50, 'fts');
      }
    } catch {}

    try {
      const renderFn = this.#engine.render ? (f, o) => this.#engine.render(f, o) : (f, o) => this.#engine.renderSync(f, o);
      const rendered = await renderFn(q, { budget: Math.max(1200, limit * 500), maxDepth: 2, maxL2: 2, useVector: true });
      for (const node of rendered?.nodes || []) {
        add(node, 32, 'semantic');
      }
    } catch {}

    return [...results.values()]
      .sort((a, b) => b.score - a.score || (b.row.access_count || 0) - (a.row.access_count || 0))
      .slice(0, limit)
      .map(({ row, score, reasons }) => ({
        id: row.id,
        l0: row.l0,
        l1: row.l1,
        tags: this.#parseJsonArray(row.tags),
        source: row.source || null,
        score,
        reasons: [...reasons],
      }));
  }

  async #memoryGetExact(idOrTag, { limit = 5 } = {}) {
    const q = String(idOrTag || '').trim();
    if (!q || !this.#engine?.db) return [];
    const db = this.#engine.db;
    const { sql: _ownSql, params: _ownP } = this.#engine._ownerSqlClause();
    const { sql: _ownSqlN, params: _ownPN } = this.#engine._ownerSqlClause('n');
    const rows = [];
    rows.push(...db.prepare(`SELECT id, l0, l1, l2, tags, source, access_count, weight FROM nodes WHERE state='active' AND lower(id)=lower(?)${_ownSql} LIMIT ?`).all(q, ..._ownP, limit));
    rows.push(...db.prepare(`SELECT DISTINCT n.id, n.l0, n.l1, n.l2, n.tags, n.source, n.access_count, n.weight FROM nodes n, json_each(n.tags) WHERE n.state='active' AND lower(json_each.value)=lower(?)${_ownSqlN} LIMIT ?`).all(q, ..._ownPN, limit));
    const seen = new Set();
    return rows.filter(r => r && !seen.has(r.id) && seen.add(r.id)).slice(0, limit).map(row => ({
      id: row.id,
      l0: row.l0,
      l1: row.l1,
      l2: row.l2,
      tags: this.#parseJsonArray(row.tags),
      source: row.source || null,
    }));
  }

  #parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    try { return JSON.parse(value); } catch { return []; }
  }

  #formatMemoryResults(query, rows, { renderedText = null } = {}) {
    if (!rows || rows.length === 0) return `No matching memory nodes found for "${query}".`;
    const lines = [`Memory candidates for "${query}":`];
    rows.forEach((row, idx) => {
      const reasons = row.reasons?.length ? ` [${row.reasons.join(', ')}]` : '';
      const tags = row.tags?.length ? `\n   tags: ${row.tags.join(', ')}` : '';
      const summary = row.l1 || row.l0 || '';
      lines.push(`${idx + 1}. ${row.id}${reasons}${typeof row.score === 'number' ? ` (score ${row.score})` : ''}`);
      if (row.l0) lines.push(`   l0: ${row.l0}`);
      if (summary && summary !== row.l0) lines.push(`   l1: ${summary}`);
      if (row.source) lines.push(`   source: ${row.source}`);
      if (tags) lines.push(tags.trimEnd());
    });
    if (renderedText) {
      lines.push('\nRendered overview:\n' + renderedText);
    }
    return lines.join('\n');
  }

  #shouldDeferTool(name) {
    if (this.#config.coreTools.includes(name)) return false;
    const deferredByName = new Set([
      'exec', 'file_write', 'switch_model', 'get_model_info',
      'run_background_task', 'constellation_dive', 'constellation_search_dive'
    ]);
    return deferredByName.has(name);
  }

  // ─── Built-in Tools Registration ───

  #registerBuiltIns() {
    const enabled = new Set(this.#config.builtIn);
    const shouldEnable = (name) => enabled.size === 0 || enabled.has(name);

    // ── tool_search ──
    this.register({
      name: 'tool_search',
      description: 'Search the tool catalog to discover additional tools. Use this when you suspect there may be a more specific tool for the task. Matching tools are activated for this session so the model can call them on the next step.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What capability or task you need a tool for' },
          limit: { type: 'number', description: 'Maximum tools to return (default: 8)' },
          activate: { type: 'boolean', description: 'Whether to activate matching deferred tools for this session (default: true)' },
        },
        required: ['query'],
      },
      parallel: true,
      alwaysVisible: true,
      deferLoading: false,
      keywords: ['find tool', 'discover tool', 'search tools', 'capability'],
      execute: async (args, meta = {}) => {
        const results = this.searchTools(args.query, {
          limit: args.limit || 8,
          sessionId: meta.sessionId || null,
          activate: args.activate !== false,
        });
        if (results.length === 0) return `No tools matched "${args.query}".`;
        const activated = results.filter(r => r.activated || (meta.sessionId && this.getActivatedTools(meta.sessionId).includes(r.name))).map(r => r.name);
        return [
          `Tool matches for "${args.query}":`,
          ...results.map((r, idx) => `${idx + 1}. ${r.name}${r.deferLoading ? ' [deferred]' : ''} — ${r.description}${r.reasons?.length ? `\n   reasons: ${r.reasons.join(', ')}` : ''}`),
          activated.length ? `\nActivated for this session: ${activated.join(', ')}` : ''
        ].filter(Boolean).join('\n');
      },
    });

    // ── constellation_remember ──
    if (shouldEnable('constellation_remember')) {
      this.register({
        name: 'constellation_remember',
        description: 'Write a new node into the constellation memory graph. Use for important insights, decisions, or information worth preserving long-term.',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The content to remember. Write complete, self-contained descriptions with full context.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tags for categorization and retrieval (e.g., ["identity", "decision", "insight"])',
            },
            connections: {
              type: 'array',
              items: { type: 'string' },
              description: 'Node IDs to connect to (optional)',
            },
            event_at: {
              type: 'string',
              description: 'Optional ISO 8601 timestamp of when the event the content describes actually happened (e.g. "2026-04-25T18:00:00Z" for yesterday\'s diary written today). Defaults to now.',
            },
            subkind: {
              type: 'string',
              description: 'Optional: classify this self-utterance. Use "diary" for daily-diary cron entries. Setting one of {diary, outreach, external_fetch_summary, curiosity_probe, share, question, observation} also marks the node as a "self_act" so SA + rerank can naturally dedup against future similar utterances.',
            },
          },
          required: ['content'],
        },
        alwaysVisible: true,
        keywords: ['remember memory', 'write node', 'store insight', 'save constellation'],
        execute: async (args) => {
          let tags = args.tags || [];
          // Defense: LLM sometimes sends comma-separated string instead of array
          if (typeof tags === 'string') tags = tags.split(',').map(t => t.trim()).filter(Boolean);
          const content = args.content;

          // Phase 1c: subkind in the self_act subkind set → also stamp node_type='self_act'.
          // anamnesis_summary stays node_type='knowledge' (per plan §4.3) so it isn't in this set.
          const SELF_ACT_SUBKINDS = new Set([
            'outreach', 'diary', 'external_fetch_summary',
            'curiosity_probe', 'share', 'question', 'observation',
          ]);
          const rawSubkind = (typeof args.subkind === 'string' && args.subkind.trim()) ? args.subkind.trim() : null;
          const subkind = rawSubkind;
          const nodeType = (rawSubkind && SELF_ACT_SUBKINDS.has(rawSubkind)) ? 'self_act' : null;

          // Generate a slug-keyed ID (`tool-<subkind>-<slug>-MMDD-hhmm`) so nodes are scannable.
          const id = args.id || this.#generateToolNodeId(this.#extractSlugFromContent(content), rawSubkind);
          const l0 = content.slice(0, 80).replace(/\n/g, ' ');
          const l1 = content.length > 200 ? content.slice(0, 200) + '...' : content;
          const eventAt = (typeof args.event_at === 'string' && args.event_at.trim()) ? args.event_at.trim() : null;

          // Phase 5 Wave 2: SHADOW resolver — only for in-scope subkinds (diary
          // is the live one through this path; outreach/external_fetch flow
          // through mimir-action-worker). SHADOW always proceeds; ENFORCE+SKIP
          // returns a dedup-style message instead of writing.
          if (this.#resolver && rawSubkind === 'diary') {
            try {
              const r = await this.#resolver.resolve({
                text: content, subkind: 'diary', ownerId: null,
                edgeTargets: Array.isArray(args.connections) ? args.connections : [],
              });
              if (r.enforced === 1 && r.verdict === 'SKIP') {
                return `⚡ Resolver SKIP: diary entry already covered by recent self_acts (verdict=${r.finalVerdict || r.verdict}).`;
              }
            } catch { /* fail-open */ }
          }

          // Prefer async remember() for embedding generation; fall back to rememberSync
          let returnedId;
          try {
            if (this.#engine.remember) {
              returnedId = await this.#engine.remember({
                id,
                l0,
                l1,
                l2: content,
                tags,
                source: 'tool',
                edges: (args.connections || []).map(c => ({ target: c, type: 'contextualizes', strength: 0.5 })),
                event_at: eventAt,
                node_type: nodeType,
                subkind,
              });
            } else {
              returnedId = this.#engine.rememberSync({ id, l0, l1, l2: content, tags, source: 'tool', event_at: eventAt, node_type: nodeType, subkind });
            }
          } catch (asyncErr) {
            // Fallback to sync if async fails (e.g. embedder not loaded)
            console.warn(`[constellation_remember] remember() failed, falling back to rememberSync (NO embedding/edges): ${asyncErr.message}`);
            try {
              returnedId = this.#engine.rememberSync({ id, l0, l1, l2: content, tags, source: 'tool', event_at: eventAt, node_type: nodeType, subkind });
            } catch {
              return `[Tool Error:constellation_remember] Failed to write node: ${asyncErr.message}`;
            }
          }

          if (returnedId !== id) {
            return `⚡ Dedup: similar node already exists (${returnedId}). Refreshed its access time instead of creating duplicate.`;
          }
          return `Remembered: node ${id} (${content.length} chars, ${tags.length} tags)`;
        },
      });
    }

    // ── constellation_query ──
    if (shouldEnable('constellation_query')) {
      this.register({
        name: 'constellation_query',
        description: 'Query the constellation memory graph with a focus term. Returns topologically rendered nodes related to the query.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The focus query to search the constellation for',
            },
            budget: {
              type: 'number',
              description: 'Max tokens for the rendered output (default: 4000)',
            },
          },
          required: ['query'],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const result = this.#engine.renderSync(args.query, {
            budget: args.budget || 2200,
          });
          const text = typeof result === 'string' ? result : result?.text;
          return text || 'No constellation nodes found for this query.';
        },
      });
    }

    // ── constellation_stats ──
    if (shouldEnable('constellation_stats')) {
      this.register({
        name: 'constellation_stats',
        description: 'Get constellation memory graph statistics: node count, edge count, embedding count, etc.',
        parameters: { type: 'object', properties: {} },
        parallel: true,
        alwaysVisible: true,
        keywords: ['memory stats', 'constellation status', 'node count'],
        cacheSafe: true,
        execute: async () => {
          const stats = this.#engine.stats();
          return JSON.stringify(stats, null, 2);
        },
      });
    }

    // ── memory_get ──
    if (shouldEnable('memory_get')) {
      this.register({
        name: 'memory_get',
        description: 'Deterministically fetch memory nodes by exact node ID or exact tag. Use this when you know the slug, incident ID, architecture ID, or exact constellation tag.',
        parameters: {
          type: 'object',
          properties: {
            idOrTag: { type: 'string', description: 'Exact node ID or exact tag to fetch' },
            limit: { type: 'number', description: 'Maximum nodes to return (default: 5)' },
          },
          required: ['idOrTag'],
        },
        parallel: true,
        alwaysVisible: true,
        keywords: ['exact memory lookup', 'node id', 'tag lookup', 'incident id', 'architecture id'],
        cacheSafe: true,
        execute: async (args) => {
          const rows = await this.#memoryGetExact(args.idOrTag, { limit: args.limit || 5 });
          if (rows.length === 0) return `No exact memory node found for "${args.idOrTag}".`;
          return rows.map((row, idx) => `${idx + 1}. ${row.id}\n   l0: ${row.l0 || ''}\n   l1: ${row.l1 || ''}${row.tags?.length ? `\n   tags: ${row.tags.join(', ')}` : ''}`).join('\n');
        },
      });
    }

    // ── memory_search ──
    if (shouldEnable('memory_search')) {
      this.register({
        name: 'memory_search',
        description: 'Hybrid memory search across constellation nodes. Uses exact node/tag lookup, keyword/FTS recall, then semantic reranking. Best for finding incidents, architecture changes, audits, and synchronization records even when you only remember part of the title.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query text',
            },
            maxResults: {
              type: 'number',
              description: 'Max results to return (default: 5)',
            },
            includeOverview: {
              type: 'boolean',
              description: 'Include an extra rendered overview from the constellation (default: false, auto-enabled for very small result sets)',
            },
            overviewBudget: {
              type: 'number',
              description: 'Token budget for the optional rendered overview (default: 800)',
            },
          },
          required: ['query'],
        },
        parallel: true,
        alwaysVisible: true,
        keywords: ['semantic memory search', 'architecture optimization', 'incident lookup', 'token explosion', 'search constellation'],
        cacheSafe: true,
        execute: async (args) => {
          const maxResults = args.maxResults || 5;
          const rows = await this.#searchConstellationDual(args.query, { limit: maxResults });
          const includeOverview = args.includeOverview === true || rows.length <= 2;
          let renderedText = null;
          if (includeOverview) {
            try {
              const overviewBudget = Math.max(400, Math.min(args.overviewBudget || 800, 1800));
              const rendered = this.#engine.renderSync
                ? this.#engine.renderSync(args.query, { budget: overviewBudget, maxDepth: 2, maxL2: 2 })
                : await this.#engine.render(args.query, { budget: overviewBudget, maxDepth: 2, maxL2: 2 });
              renderedText = typeof rendered === 'string' ? rendered : rendered?.text || null;
            } catch {}
          }
          return this.#formatMemoryResults(args.query, rows, { renderedText });
        },
      });
    }

    // ── diary_search ──
    // Queries the RAW Mímir autonomy diary (independent SQLite file). Lets
    // the agent ask "have I already explored / outreached / fetched this?"
    // before deciding to act, and audit its own past autonomous activity.
    if (shouldEnable('diary_search')) {
      this.register({
        name: 'diary_search',
        description: 'Search the RAW autonomy diary — your own log of past picker fires, skips, fetches, and outreaches. Use this to check whether you have already explored a topic, asked a similar question, or hit the L0 fuse on this zone in the last week. Independent of the main constellation.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Free-text query for KNN match against past diary text (e.g. zone topic / outreach question). Omit for time-window scan.',
            },
            k: {
              type: 'number',
              description: 'Max results (default 5).',
            },
            maxAgeHours: {
              type: 'number',
              description: 'How far back to look (default 168 = 7d).',
            },
            kinds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by kind (e.g. ["fire_v3","skip_fuse","outreach"]). Time-scan only.',
            },
          },
          required: [],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const mimirUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
          const body = {
            query: args.query || '',
            k: Math.max(1, Math.min(args.k || 5, 50)),
            max_age_hours: args.maxAgeHours || 168,
            kinds: Array.isArray(args.kinds) ? args.kinds : null,
            mode: args.query ? 'knn' : 'recent',
          };
          const res = await fetch(`${mimirUrl}/diary_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error(`diary_search HTTP ${res.status}: ${await res.text()}`);
          }
          const data = await res.json();
          if (!data.ok) {
            throw new Error(`diary_search: ${data.error || 'unknown error'}`);
          }
          const hits = data.hits || [];
          if (hits.length === 0) {
            return `No diary entries matched (query=${JSON.stringify(args.query || '')}, window=${body.max_age_hours}h).`;
          }
          const lines = [`Diary hits (${hits.length}/${body.k}, window=${body.max_age_hours}h):`];
          for (const h of hits) {
            const ts = h.ts ? new Date(h.ts * 1000).toISOString().slice(0, 16).replace('T', ' ') : '?';
            const kind = h.kind || '?';
            const dist = (typeof h.distance === 'number') ? ` d=${h.distance.toFixed(3)}` : '';
            const text = (h.text || '').slice(0, 200);
            lines.push(`- [${ts}] ${kind}${dist}: ${text}`);
          }
          return lines.join('\n');
        },
      });
    }

    // ── library_fetch ──
    // Reads a file from the curated library/ via the mimir daemon. Daemon
    // canonicalizes the path, scopes it under <repo-root>/library/, MIME-sniffs,
    // PDF-extracts via pdftotext, and writes library_read_log on success.
    // Used by Actions/library_fetch picker action.
    if (shouldEnable('library_fetch')) {
      this.register({
        name: 'library_fetch',
        description: 'Read a file from your curated library/ (text or PDF). Path is relative under library/ and must not contain "..". PDFs auto-extract to text. The daemon logs the read to library_read_log so substrate.library_has_unread reflects future fires.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Relative path under library/ (e.g. "complexity-science/foo.pdf"). No leading "/" or "..".',
            },
            max_bytes: {
              type: 'number',
              description: 'Soft cap on returned text bytes (default 100000). PDF source is not capped at extraction; only the response body is truncated.',
            },
          },
          required: ['path'],
        },
        parallel: false,
        cacheSafe: false,
        execute: async (args) => {
          const mimirUrl = process.env.MIMIR_URL || 'http://127.0.0.1:18810';
          const body = {
            path: String(args.path || ''),
            max_bytes: Math.max(1, Math.min(args.max_bytes || 100000, 5_000_000)),
            mode: 'actions',
            origin: 'library_fetch',
          };
          const res = await fetch(`${mimirUrl}/library_fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error(`library_fetch HTTP ${res.status}: ${await res.text()}`);
          }
          const data = await res.json();
          if (!data.ok) {
            throw new Error(`library_fetch: ${data.error || 'unknown error'}`);
          }
          const head = `path=${data.path} kind=${data.kind} bytes=${data.bytes}${data.truncated ? ' (truncated)' : ''}`;
          return `${head}\n\n${data.text || ''}`;
        },
      });
    }

    // ── file_read ──
    if (shouldEnable('file_read')) {
      this.register({
        name: 'file_read',
        alwaysVisible: true,
        keywords: ['read file', 'open file', 'inspect file', 'view source'],
        description: 'Read the contents of a file. Path must be within allowed directories.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative to workspace or absolute)',
            },
            maxLines: {
              type: 'number',
              description: 'Maximum lines to read (default: all)',
            },
          },
          required: ['path'],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const filePath = this.#resolvePath(args.path);
          this.#validatePath(filePath);
          const content = await readFile(filePath, 'utf-8');
          if (args.maxLines) {
            const lines = content.split('\n');
            return lines.slice(0, args.maxLines).join('\n') +
              (lines.length > args.maxLines ? `\n... (${lines.length - args.maxLines} more lines)` : '');
          }
          return content;
        },
      });
    }

    // ── file_write ──
    if (shouldEnable('file_write')) {
      this.register({
        name: 'file_write',
        deferLoading: this.#shouldDeferTool('file_write'),
        keywords: ['write file', 'save file', 'patch file', 'edit file'],
        description: 'Write content to a file. Creates parent directories if needed. Path must be within allowed directories.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative to workspace or absolute)',
            },
            content: {
              type: 'string',
              description: 'Content to write',
            },
          },
          required: ['path', 'content'],
        },
        execute: async (args) => {
          const filePath = this.#resolvePath(args.path);
          this.#validatePath(filePath);
          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, args.content, 'utf-8');
          return `Written ${args.content.length} chars to ${args.path}`;
        },
      });
    }

    // ── exec ──
    if (shouldEnable('exec')) {
      this.register({
        name: 'exec',
        deferLoading: this.#shouldDeferTool('exec'),
        keywords: ['shell command', 'bash', 'terminal', 'run command'],
        description: 'Execute a shell command. Only allowed commands can be run. Timeout enforced.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute',
            },
          },
          required: ['command'],
        },
        execute: async (args) => {
          const cmd = args.command.trim();
          this.#validateCommand(cmd);

          // Guard against E2BIG: reject commands exceeding 64KB
          const cmdBytes = Buffer.byteLength(cmd, 'utf-8');
          if (cmdBytes > 64 * 1024) {
            return `Command too large (${cmdBytes} bytes). Max safe size is 65536 bytes. Simplify or split the command.`;
          }

          try {
            const [shellBin, shellFlag] = IS_WINDOWS ? ['cmd.exe', '/c'] : ['bash', '-c'];
            const { stdout, stderr } = await execFileAsync(shellBin, [shellFlag, cmd], {
              timeout: this.#config.execTimeout,
              maxBuffer: 1024 * 512, // 512KB
              cwd: process.cwd(),
            });
            const output = (stdout || '').trim();
            const errors = (stderr || '').trim();
            let result = '';
            if (output) result += output;
            if (errors) result += (result ? '\n\nSTDERR:\n' : '') + errors;
            return result || '(no output)';
          } catch (err) {
            if (err.killed) return `Command timed out after ${this.#config.execTimeout}ms`;
            return `Exit code ${err.code || 1}: ${err.stderr || err.message}`;
          }
        },
      });
    }

    // ── web_fetch ──
    if (shouldEnable('web_fetch')) {
      this.register({
        name: 'web_fetch',
        alwaysVisible: true,
        keywords: ['fetch url', 'read webpage', 'web page', 'http get'],
        description: 'Fetch a URL and extract readable text content. Useful for reading web pages.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to fetch',
            },
            maxChars: {
              type: 'number',
              description: 'Maximum characters to return (default: 6000)',
            },
          },
          required: ['url'],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const maxChars = args.maxChars || 6000;
          try {
            const resp = await fetch(args.url, {
              headers: { 'User-Agent': 'ConstellationEngine/1.0' },
              signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) return `HTTP ${resp.status}: ${resp.statusText}`;
            const text = await resp.text();
            // Basic HTML stripping
            const cleaned = text
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            return cleaned.length > maxChars
              ? cleaned.substring(0, maxChars) + `\n... (truncated, ${cleaned.length} total chars)`
              : cleaned;
          } catch (err) {
            return `Fetch error: ${err.message}`;
          }
        },
      });
    }
    // ── workspace_search ──
    if (shouldEnable('workspace_search')) {
      this.register({
        name: 'workspace_search',
        alwaysVisible: true,
        keywords: ['grep', 'search files', 'search workspace', 'search markdown'],
        description: 'Full-text search across all markdown files in workspace, identity, engine-output, engine-inbox, and library directories. Returns matching lines with file paths. Use this to find relevant knowledge, past explorations, diary entries, library materials, and inbox items by keyword or topic.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (grep pattern, case-insensitive)',
            },
            directories: {
              type: 'array',
              items: { type: 'string' },
              description: 'Directories to search (default: all). Options: identity, engine-output, engine-inbox, library, workspace',
            },
            maxResults: {
              type: 'number',
              description: 'Max matching files to return (default: 10)',
            },
            filePattern: {
              type: 'string',
              description: 'File glob pattern (default: *.md)',
            },
            maxChars: {
              type: 'number',
              description: 'Maximum characters to return (default: 6000)',
            },
          },
          required: ['query'],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const baseDir = resolve(process.cwd());
          const allDirs = ['identity', 'engine-output', 'engine-inbox', 'library', 'workspace'];
          const dirs = (args.directories && args.directories.length > 0) ? args.directories : allDirs;
          const pattern = args.filePattern || '*.md';
          const maxResults = args.maxResults || 10;
          const maxChars = args.maxChars || 6000;
          const searchDirs = dirs.map(d => resolve(baseDir, d)).filter(d => {
            try { return statSync(d).isDirectory(); } catch { return false; }
          });
          if (searchDirs.length === 0) return 'No valid directories found.';

          try {
            const nameRe = _globToRegex(pattern);
            const needle = String(args.query || '').toLowerCase();
            if (!needle) return 'Empty query.';
            const results = [];
            const matchedFiles = [];
            outer: for (const dir of searchDirs) {
              for await (const filePath of _walkFiles(dir, n => nameRe.test(n))) {
                let text;
                try { text = await readFile(filePath, 'utf-8'); } catch { continue; }
                if (text.toLowerCase().includes(needle)) {
                  matchedFiles.push(filePath);
                  if (matchedFiles.length >= maxResults) break outer;
                }
              }
            }
            if (matchedFiles.length === 0) return 'No matches found.';
            for (const filePath of matchedFiles) {
              let text;
              try { text = await readFile(filePath, 'utf-8'); } catch { continue; }
              const lines = text.split(/\r?\n/);
              const hits = [];
              for (let i = 0; i < lines.length && hits.length < 3; i++) {
                if (lines[i].toLowerCase().includes(needle)) {
                  hits.push(`${i + 1}:${lines[i]}`);
                }
              }
              const relPath = relative(baseDir, filePath).split(sep).join('/');
              results.push(`📄 ${relPath}\n${hits.join('\n')}`);
            }
            const joined = results.join('\n\n') || 'No matches found.';
            return joined.length > maxChars ? joined.slice(0, maxChars) + `\n... (truncated, ${joined.length} total chars)` : joined;
          } catch (err) {
            return `Search error: ${err.message}`;
          }
        },
      });
    }

    // ── list_files ──
    if (shouldEnable('list_files')) {
      this.register({
        name: 'list_files',
        alwaysVisible: true,
        keywords: ['list directory', 'browse files', 'show folder', 'workspace tree'],
        description: 'List files and directories. Use to browse engine-output, engine-inbox, library, identity, workspace structure.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (relative to engine root, e.g. "engine-output/exploration" or "library/KC")',
            },
            recursive: {
              type: 'boolean',
              description: 'List recursively (default: false)',
            },
            pattern: {
              type: 'string',
              description: 'Filter by glob pattern (e.g. "*.md")',
            },
          },
          required: ['path'],
        },
        parallel: true,
        cacheSafe: true,
        execute: async (args) => {
          const targetPath = this.#resolvePath(args.path);
          const { readdir } = await import('node:fs/promises');
          try {
            const entries = await readdir(targetPath, { withFileTypes: true });
            let results = entries.map(e => {
              const prefix = e.isDirectory() ? '📁 ' : '📄 ';
              return prefix + e.name;
            });
            if (args.pattern) {
              const { minimatch } = await import('minimatch').catch(() => ({ minimatch: null }));
              if (minimatch) {
                results = results.filter(r => {
                  const name = r.replace(/^[📁📄] /, '');
                  return minimatch(name, args.pattern);
                });
              }
            }
            if (args.recursive) {
              const baseDir = resolve(process.cwd());
              const nameRe = args.pattern ? _globToRegex(args.pattern) : null;
              const files = [];
              for await (const f of _walkFiles(targetPath, nameRe ? n => nameRe.test(n) : null, 3)) {
                files.push(relative(baseDir, f).split(sep).join('/'));
              }
              return files.join('\n') || '(empty)';
            }
            return results.join('\n') || '(empty directory)';
          } catch (err) {
            return `Error: ${err.message}`;
          }
        },
      });
    }

    // ── conversation_fetch_raw ──
    if (shouldEnable('conversation_fetch_raw')) {
      this.register({
        name: 'conversation_fetch_raw',
        deferLoading: true, // Always deferred; activated by keyword gate
        keywords: ['quote', 'verbatim', 'exact', 'word for word'],
        description: 'Fetch raw conversation messages by segment IDs. Use when you need the exact verbatim text of previous exchanges. Returns message previews first, then full content on request.',
        parameters: {
          type: 'object',
          properties: {
            segment_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Segment IDs to fetch (from fat metadata headers)',
            },
            max_total_tokens: {
              type: 'number',
              description: 'Max tokens to return across all segments (default: 2000, adaptive)',
            },
            preview_first: {
              type: 'boolean',
              description: 'Return 60-char preview per segment first for selection (default: true)',
            },
          },
          required: ['segment_ids'],
        },
        parallel: true,
        execute: async (args, meta = {}) => {
          if (!this.#convStore || !this.#convStore.db) {
            return 'Error: conversation store not available for verbatim fetch';
          }

          const segmentIds = (args.segment_ids || [])
            .map(n => Number(n))
            .filter(n => Number.isInteger(n) && n > 0);
          let maxTokens = args.max_total_tokens;
          const previewFirst = args.preview_first !== false;

          if (segmentIds.length === 0) {
            return 'Error: segment_ids must be a non-empty array of positive integers';
          }

          // Adaptive budget: scale by current context pressure
          if (maxTokens === undefined) {
            const pressure = globalThis._ctxPressure || 0.3;
            if (pressure < 0.4) maxTokens = 3000;
            else if (pressure < 0.7) maxTokens = 2000;
            else maxTokens = 1000;
          }
          const maxChars = Math.max(maxTokens * 4, 500);

          // Record fetch for per-turn injection stats (turn-scoped global)
          if (!globalThis._injectionStats) globalThis._injectionStats = {};
          if (!Array.isArray(globalThis._injectionStats.segment_ids_fetched)) {
            globalThis._injectionStats.segment_ids_fetched = [];
          }
          globalThis._injectionStats.segment_ids_fetched.push(...segmentIds);

          try {
            const db = this.#convStore.db;
            const placeholders = segmentIds.map(() => '?').join(',');
            // Defense-in-depth multi-user filter: when meta.speakerId is set,
            // restrict to segments owned by this speaker or legacy NULL rows.
            // Permissive mode (no OWNER_USER_ID) leaves speakerId empty → no filter.
            const speakerId = meta && meta.speakerId ? String(meta.speakerId) : '';
            const segSql = speakerId
              ? `SELECT id, start_msg_id, end_msg_id, summary, msg_count, created_at, speaker_name
                 FROM topic_segments
                 WHERE id IN (${placeholders})
                   AND (speaker_id = ? OR speaker_id IS NULL)`
              : `SELECT id, start_msg_id, end_msg_id, summary, msg_count, created_at, speaker_name
                 FROM topic_segments WHERE id IN (${placeholders})`;
            const segParams = speakerId ? [...segmentIds, speakerId] : segmentIds;
            const segs = db.prepare(segSql).all(...segParams);

            if (segs.length === 0) {
              return `No segments found for IDs: ${segmentIds.join(', ')}`;
            }

            if (previewFirst) {
              const lines = segs.map(s => {
                const preview = String(s.summary || '').slice(0, 80).replace(/\n+/g, ' ');
                return `[seg${s.id}] ${s.msg_count || 0}msgs · ${(s.created_at || '').slice(0, 16).replace('T', ' ')} · ${preview}`;
              });
              return `Segment previews (call again with preview_first=false to get verbatim):\n${lines.join('\n')}`;
            }

            // Full verbatim fetch — pull messages by id-range per segment
            const msgStmt = db.prepare(
              `SELECT id, timestamp, role, content, participant
               FROM messages
               WHERE id BETWEEN ? AND ?
               ORDER BY id ASC`
            );
            const blocks = [];
            let totalChars = 0;
            for (const s of segs) {
              const msgs = msgStmt.all(s.start_msg_id, s.end_msg_id);
              const header = `─── [seg${s.id} · ${(s.created_at || '').slice(0, 16).replace('T', ' ')} · ${msgs.length}msgs] ───`;
              const body = [];
              for (const m of msgs) {
                const ts = (m.timestamp || '').slice(11, 16);
                const who = m.role === 'user' ? 'User' : (m.role === 'assistant' ? 'Agent' : m.role);
                const line = `[${ts}] ${who}: ${m.content || ''}`;
                if (totalChars + line.length > maxChars) {
                  body.push('[...truncated for token budget]');
                  totalChars = maxChars;
                  break;
                }
                body.push(line);
                totalChars += line.length + 1;
              }
              blocks.push(header + '\n' + body.join('\n'));
              if (totalChars >= maxChars) break;
            }
            return blocks.join('\n\n');
          } catch (err) {
            return `Fetch error: ${err.message}`;
          }
        },
      });
    }
  }

  // ─── Model Management Tools ───

  /**
   * Register model switching tool. Called from main.js with reference to LLMRouter.
   * @param {import('./llm-router.js').LLMRouter} llmRouter
   */
  registerModelTools(llmRouter) {
    // Allowed models are derived from the active LLM config (primary/compact/fallback
    // tiers configured by the user during onboarding). The engine is provider-neutral —
    // any model identifier the configured provider accepts may be set here.
    const allowedModels = () => {
      const cfg = llmRouter?.config || {};
      const set = new Set();
      if (cfg.primaryModel) set.add(cfg.primaryModel);
      if (cfg.compactModel) set.add(cfg.compactModel);
      if (cfg.fallbackModel) set.add(cfg.fallbackModel);
      return [...set];
    };

    this.register({
      name: 'switch_model',
      deferLoading: this.#shouldDeferTool('switch_model'),
      keywords: ['model switch', 'change model', 'tier'],
      description: 'Switch the primary LLM model for subsequent calls. Use for cost/speed optimization: pick a stronger tier for deep reasoning, a balanced tier for normal tasks, or a faster/cheaper tier for lightweight operations. Returns the new active model.',
      parameters: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            description: 'Model identifier to switch to. Must match one of the configured primary/compact/fallback tiers for the active provider.',
          },
          reason: {
            type: 'string',
            description: 'Why switching (logged for debugging)',
          },
        },
        required: ['model'],
      },
      parallel: false,
      execute: async (args) => {
        const { model, reason } = args;
        const allowed = allowedModels();
        if (!allowed.includes(model)) {
          return `Error: Unknown model "${model}". Allowed: ${allowed.join(', ') || '(none configured)'}`;
        }
        const previous = llmRouter.config.primaryModel;
        llmRouter.config.primaryModel = model;
        const msg = `Model switched: ${previous} → ${model}${reason ? ` (reason: ${reason})` : ''}`;
        this.emit('model_switch', { previous, current: model, reason });
        return msg;
      },
    });

    this.register({
      name: 'get_model_info',
      deferLoading: this.#shouldDeferTool('get_model_info'),
      keywords: ['model info', 'current model', 'available models'],
      description: 'Get current model configuration and available models.',
      parameters: { type: 'object', properties: {} },
      parallel: true,
      execute: async () => {
        return JSON.stringify({
          primary: llmRouter.config.primaryModel,
          fallback: llmRouter.config.fallbackModel || 'none',
          compact: llmRouter.config.compactModel || 'none',
          available: allowedModels(),
          authMode: llmRouter.config.authMode,
        }, null, 2);
      },
    });
  }

  // ─── Node ID helpers (constellation_remember) ───

  #sanitizeSlug(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    s = s.replace(/^-+|-+$/g, '');
    if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, '');
    return s;
  }

  #extractSlugFromContent(content) {
    if (typeof content !== 'string' || !content) return '';
    const heading = content.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
    if (heading && heading[1]) return heading[1];
    const firstLine = content.split('\n').map(l => l.trim()).find(Boolean);
    return firstLine || '';
  }

  #generateToolNodeId(slugRaw, subkindRaw) {
    const subkind = this.#sanitizeSlug(subkindRaw) || 'note';
    let slug = this.#sanitizeSlug(slugRaw);
    if (!slug) slug = `entry-${Date.now().toString(36).slice(-6)}`;
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const base = `tool-${subkind}-${slug}-${mmdd}-${hhmm}`;

    let existsStmt = null;
    try { existsStmt = this.#engine?.db?.prepare?.('SELECT 1 FROM nodes WHERE id = ?'); } catch { existsStmt = null; }
    const inUse = (id) => {
      if (!existsStmt) return false;
      try { return !!existsStmt.get(id); } catch { return false; }
    };

    if (!inUse(base)) return base;
    for (let i = 0; i < 5; i++) {
      const suffix = Math.random().toString(16).slice(2, 6).padStart(4, '0');
      const candidate = `${base}-${suffix}`;
      if (!inUse(candidate)) return candidate;
    }
    return `${base}-${Date.now().toString(36).slice(-6)}`;
  }

  // ─── Path Safety ───

  /**
   * Resolve a path relative to cwd
   * @param {string} p
   * @returns {string}
   */
  #resolvePath(p) {
    return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  }

  /**
   * Validate path is within allowed directories
   * @param {string} filePath
   * @throws {Error}
   */
  #validatePath(filePath) {
    if (!this.#config.allowedPaths) return; // No restriction
    const resolved = resolve(filePath);
    const allowed = this.#config.allowedPaths.some(dir => resolved.startsWith(dir));
    if (!allowed) {
      throw new Error(`Path not allowed: ${filePath}. Allowed: ${this.#config.allowedPaths.join(', ')}`);
    }
  }

  /**
   * Validate command against allowlist
   * @param {string} cmd
   * @throws {Error}
   */
  #validateCommand(cmd) {
    if (!this.#config.execAllowlist) return; // No restriction — full access
    const firstWord = cmd.split(/[\s;|&]/)[0];
    const allowed = this.#config.execAllowlist.some(prefix =>
      firstWord === prefix || firstWord.endsWith('/' + prefix)
    );
    if (!allowed) {
      throw new Error(`Command not allowed: "${firstWord}". Allowed: ${this.#config.execAllowlist.join(', ')}`);
    }
  }
}

export default ToolManager;
