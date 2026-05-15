// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module sub-agent
 * @description Sub-Agent Manager — a "virtual memory" mechanism.
 *
 * The main brain only sees the star-map L0 overview (~8K tokens). When it
 * needs to dive deeper it calls constellation_dive, which spawns a lightweight
 * sub-agent that reads the full L2 content and returns a compressed
 * conclusion (~2K tokens).
 *
 * Three tools:
 *   constellation_dive        — dive into a single node
 *   constellation_search_dive — search + dive
 *   run_background_task       — background task (non-blocking)
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, dirname } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCLUSION_TOKENS = 2000;
const DEFAULT_MAX_SEARCH_NODES = 3;
const DEFAULT_TEMPERATURE = 0.3;
const TECHNICAL_TEMPERATURE = 0.15;
const DEFAULT_MAX_TECHNICAL_FILES = 6;
const DEFAULT_MAX_TECHNICAL_CONTEXT_BYTES = 24000;
const DEFAULT_BACKGROUND_LEASE_MS = 120000;
const DEFAULT_BACKGROUND_POLL_MS = 2000;
const DEFAULT_SYMBOL_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const TECH_FILE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.sql', '.sh', '.yaml', '.yml', '.py', '.log', '.txt']);

// ─── SubAgentManager ────────────────────────────────────────────────────────

export class SubAgentManager extends EventEmitter {
  /** @type {import('./llm-router.js').LLMRouter} */
  #llm;

  /** @type {Object} ConstellationEngine instance */
  #engine;

  /** @type {import('better-sqlite3').Database} */
  #db;

  /** @type {Object} */
  #config;

  /** @type {import('./task-manager.js').TaskManager|null} */
  #taskManager;

  #workerId;
  #workerTimer = null;
  #workerBusy = false;

  /** @type {Map<string, { id: string, task: string, startedAt: number, promise: Promise }>} */
  #activeTasks = new Map();

  /** @type {import('better-sqlite3').Statement|null} */
  #insertApiCall;

  /**
   * @param {Object} opts
   * @param {Object} opts.engine - ConstellationEngine instance
   * @param {import('./llm-router.js').LLMRouter} opts.llm - LLM router
   * @param {import('better-sqlite3').Database} opts.db - SQLite database
   * @param {Object} [opts.config] - Sub-agent configuration
   * @param {string} [opts.config.model] - Model override (defaults to compactModel)
   * @param {number} [opts.config.maxConclusionTokens] - Max tokens for conclusion
   * @param {number} [opts.config.maxSearchNodes] - Max nodes for search_dive
   * @param {import('./task-manager.js').TaskManager|null} [opts.taskManager]
   */
  constructor({ engine, llm, db, taskManager = null, config = {} }) {
    super();
    this.#engine = engine;
    this.#llm = llm;
    this.#db = db;
    this.#taskManager = taskManager;
    this.#config = {
      model: config.model || undefined, // falls back to compactModel via LLM
      technicalModel: config.technicalModel || config.model || undefined,
      patchModel: config.patchModel || config.technicalModel || config.model || undefined,
      projectRoot: resolve(config.projectRoot || process.cwd()),
      maxConclusionTokens: config.maxConclusionTokens || DEFAULT_MAX_CONCLUSION_TOKENS,
      maxSearchNodes: config.maxSearchNodes || DEFAULT_MAX_SEARCH_NODES,
      maxTechnicalFiles: config.maxTechnicalFiles || DEFAULT_MAX_TECHNICAL_FILES,
      maxTechnicalContextBytes: config.maxTechnicalContextBytes || DEFAULT_MAX_TECHNICAL_CONTEXT_BYTES,
      backgroundPollMs: config.backgroundPollMs || DEFAULT_BACKGROUND_POLL_MS,
      backgroundLeaseMs: config.backgroundLeaseMs || DEFAULT_BACKGROUND_LEASE_MS,
      symbolCacheMaxAgeMs: config.symbolCacheMaxAgeMs || DEFAULT_SYMBOL_CACHE_MAX_AGE_MS,
      enableBackgroundWorker: config.enableBackgroundWorker !== false,
    };
    this.#workerId = `subagent-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

    // Prepare api_calls insert
    try {
      this.#insertApiCall = this.#db.prepare(`
        INSERT INTO api_calls (model, input_tokens, output_tokens, cache_read, cache_write, cost_usd, duration_ms, trigger, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    } catch { this.#insertApiCall = null; }

    this.#initCodeGraphCache();

    if (this.#taskManager && this.#config.enableBackgroundWorker) {
      this.#startBackgroundWorker();
    }
  }

  // ─── Core: Dive into a single node ────────────────────────────────────────

  /**
   * Dive into a star-map node: read its full L2 content + L1 summaries of
   * connected nodes, ask the LLM to answer a specific question, and return a
   * compressed conclusion.
   *
   * @param {string} nodeId - target node ID
   * @param {string} question - the specific question to answer
   * @param {Object} [options]
   * @param {string} [options.model] - Model override
   * @param {number} [options.maxTokens] - Max conclusion tokens
   * @returns {Promise<{ conclusion: string, nodeId: string, connectedNodes: number, usage: Object }>}
   */
  async dive(nodeId, question, options = {}) {
    const startMs = Date.now();
    const model = options.model || this.#config.model;

    // 1. Get target node L2 full text
    const targetNode = this.#getNode(nodeId);
    if (!targetNode) {
      return { conclusion: `Node "${nodeId}" not found in constellation.`, nodeId, connectedNodes: 0, usage: {} };
    }

    // 2. Get connected nodes L1 summaries
    const connectedNodes = this.#getConnectedNodes(nodeId);
    const connectedContext = connectedNodes
      .map(n => `[${n.id}] ${n.l1 || n.l0 || '(no summary)'}`)
      .join('\n');

    // 3. Build sub-agent system prompt
    const systemPrompt = [
      'You are a focused research sub-agent for the Constellation memory system.',
      'Your job: read the provided node content and connected context, then answer the question concisely.',
      'Rules:',
      '- Answer in ~500-800 words maximum',
      '- Be specific and quote relevant details',
      '- Use the same language as the question',
      '- If the content doesn\'t answer the question, say so clearly',
      '- Include node IDs when referencing specific nodes',
    ].join('\n');

    const userPrompt = [
      `## Target Node: ${nodeId}`,
      '### Tags: ' + (this.#parseTags(targetNode.tags).join(', ') || '(none)'),
      '### Full Content (L2):',
      targetNode.l2 || targetNode.l1 || targetNode.l0 || '(empty)',
      '',
      connectedNodes.length > 0 ? `## Connected Nodes (${connectedNodes.length}):` : '',
      connectedContext,
      '',
      `## Question:`,
      question,
    ].join('\n');

    // 4. Call LLM (compact model)
    const maxTokens = options.maxTokens || this.#config.maxConclusionTokens;
    const response = await this.#llm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model,
        temperature: DEFAULT_TEMPERATURE,
        maxTokens,
        _trigger: 'sub-agent-dive',
        _sessionId: 'sub-agent',
        _role: 'worker',
      }
    );

    // 5. Track API call
    const durationMs = Date.now() - startMs;
    this.#trackCall(response, 'sub-agent-dive', durationMs);

    this.emit('dive', { nodeId, question, durationMs, tokens: response.usage?.totalTokens });

    return {
      conclusion: response.content || '(no conclusion)',
      nodeId,
      connectedNodes: connectedNodes.length,
      usage: response.usage || {},
    };
  }

  // ─── Batch dive ───────────────────────────────────────────────────────────

  /**
   * Dive into multiple nodes in batch to answer the same question.
   *
   * @param {string[]} nodeIds - list of target node IDs
   * @param {string} question - the specific question to answer
   * @param {Object} [options]
   * @returns {Promise<{ conclusions: Array<{ nodeId: string, conclusion: string }>, totalUsage: Object }>}
   */
  async diveMultiple(nodeIds, question, options = {}) {
    const maxConcurrent = options.maxConcurrent || 3;
    const results = [];
    let totalPrompt = 0, totalCompletion = 0;

    // Process in batches of maxConcurrent for parallelism
    for (let i = 0; i < nodeIds.length; i += maxConcurrent) {
      const batch = nodeIds.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(async (nodeId) => {
          const result = await this.dive(nodeId, question, options);
          return { nodeId, conclusion: result.conclusion, usage: result.usage };
        })
      );
      for (const r of batchResults) {
        results.push({ nodeId: r.nodeId, conclusion: r.conclusion });
        totalPrompt += r.usage?.promptTokens || 0;
        totalCompletion += r.usage?.completionTokens || 0;
      }
    }

    return {
      conclusions: results,
      totalUsage: {
        promptTokens: totalPrompt,
        completionTokens: totalCompletion,
        totalTokens: totalPrompt + totalCompletion,
      },
    };
  }

  // ─── Search + Dive ────────────────────────────────────────────────────────

  /**
   * Search the star map for nodes matching a keyword, then dive into them
   * to gather full information.
   *
   * @param {string} query - search keywords
   * @param {string} question - the specific question to answer
   * @param {Object} [options]
   * @param {number} [options.maxNodes] - maximum number of nodes to dive into
   * @returns {Promise<{ conclusions: Array<{ nodeId: string, conclusion: string }>, searchHits: number, totalUsage: Object }>}
   */
  async searchDive(query, question, options = {}) {
    const maxNodes = options.maxNodes || this.#config.maxSearchNodes;

    // Use FTS5 search if available, fall back to tag search
    const nodeIds = this.#searchNodes(query, maxNodes);

    if (nodeIds.length === 0) {
      return {
        conclusions: [],
        searchHits: 0,
        totalUsage: {},
      };
    }

    const result = await this.diveMultiple(nodeIds, question, options);
    return {
      ...result,
      searchHits: nodeIds.length,
    };
  }

  // ─── Generic background task ──────────────────────────────────────────────

  /**
   * Generic sub-task — not limited to the star map. Spawns a temporary
   * session, executes the task, and returns the result.
   *
   * @param {string} task - task description
   * @param {string} [context=''] - extra context
   * @param {Object} [options]
   * @param {string} [options.model] - Model override
   * @param {number} [options.maxTokens] - Max response tokens
   * @param {function(string): void} [options.onComplete] - Callback when done
   * @returns {Promise<{ taskId: string, result: string, usage: Object }>}
   */
  async runTask(task, context = '', options = {}) {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const startMs = Date.now();

    const systemPrompt = [
      'You are a focused sub-agent executing a specific task.',
      'Complete the task concisely and return the result.',
      context ? `\nContext:\n${context}` : '',
    ].join('\n');

    const promise = (async () => {
      try {
        const response = await this.#llm.chat(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task },
          ],
          {
            model: options.model || this.#config.model,
            temperature: DEFAULT_TEMPERATURE,
            maxTokens: options.maxTokens || this.#config.maxConclusionTokens,
            _trigger: 'sub-agent-task',
            _sessionId: 'sub-agent',
            _role: 'worker',
          }
        );

        const durationMs = Date.now() - startMs;
        this.#trackCall(response, 'sub-agent-task', durationMs);

        const result = response.content || '(no result)';
        this.#activeTasks.delete(taskId);
        this.emit('taskComplete', { taskId, task, durationMs });

        if (options.onComplete) options.onComplete(result);

        return { taskId, result, usage: response.usage || {} };
      } catch (err) {
        this.#activeTasks.delete(taskId);
        this.emit('taskError', { taskId, task, error: err.message });
        throw err;
      }
    })();

    this.#activeTasks.set(taskId, { id: taskId, task, startedAt: startMs, promise });
    return promise;
  }


  // ─── Technical sub-agent ───────────────────────────────────────────────────

  /**
   * Technical sub-agent dedicated to code / debug / architecture diagnostics.
   * No persona files are injected — it only receives the raw technical task,
   * error logs, and a curated code context.
   *
   * @param {string} task
   * @param {Object} [options]
   * @param {string[]} [options.files] - Preferred files to inspect first
   * @param {string} [options.query] - Search hint for codebase retrieval
   * @param {number} [options.maxFiles]
   * @param {number} [options.maxTokens]
   * @param {boolean} [options.includeWorkspace=true]
   * @param {boolean} [options.includeLogs=true]
   * @param {string} [options.context]
   * @returns {Promise<{ result: string, usage: Object, matchedFiles: string[] }>}
   */
  async runTechnicalTask(task, options = {}) {
    const startMs = Date.now();
    const model = options.model || this.#config.technicalModel || this.#config.model;
    const retrieval = await this.#collectTechnicalContext(task, options);
    const systemPrompt = [
      'You are a senior software debugging and architecture sub-agent.',
      'Stay purely technical. No persona, no roleplay, no social filler, no memory narration.',
      'Reason from concrete evidence in the supplied files, logs, and snippets.',
      'Prioritize: 1) precise observations, 2) likely root cause, 3) minimal safe fix, 4) follow-up checks.',
      'If evidence is incomplete, say exactly what is missing instead of guessing.',
      'Use the same language as the task unless code or logs strongly suggest otherwise.',
      'Output compact sections: Findings, Root Cause, Fix, Verification, Risks.',
      'Use Symbol Index, Import Graph, Call Sites, and Verification Harness when the supplied context supports them.',
    ].join('\n');

    const userPrompt = [
      '## Task',
      task,
      options.context ? `\n## Extra Context\n${options.context}` : '',
      retrieval.promptContext,
      retrieval.codeIntel ? `\n## Code Intelligence\n${retrieval.codeIntel}` : '',
      retrieval.matchedFiles.length ? `\n## Matched Files\n${retrieval.matchedFiles.join('\n')}` : '\n## Matched Files\n(none)',
    ].filter(Boolean).join('\n');

    const response = await this.#llm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model,
        temperature: TECHNICAL_TEMPERATURE,
        maxTokens: options.maxTokens || Math.max(this.#config.maxConclusionTokens, 2600),
        _trigger: 'sub-agent-technical',
        _sessionId: 'sub-agent',
        _role: 'worker',
      }
    );

    const durationMs = Date.now() - startMs;
    this.#trackCall(response, 'sub-agent-technical', durationMs);
    this.emit('technicalTask', {
      task: task.slice(0, 160),
      durationMs,
      matchedFiles: retrieval.matchedFiles,
      tokens: response.usage?.totalTokens,
    });

    return {
      result: response.content || '(no result)',
      usage: response.usage || {},
      matchedFiles: retrieval.matchedFiles,
    };
  }

  /**
   * Technical patch sub-agent: produces an implementation-oriented patch plan.
   * @param {string} task
   * @param {Object} [options]
   * @returns {Promise<{ result: string, usage: Object, matchedFiles: string[] }>}
   */
  async runTechnicalPatchTask(task, options = {}) {
    const startMs = Date.now();
    const model = options.model || this.#config.patchModel || this.#config.technicalModel || this.#config.model;
    const retrieval = await this.#collectTechnicalContext(task, options);
    const systemPrompt = [
      'You are a senior software patch agent.',
      'Stay purely technical. No persona, no roleplay, no motivational filler.',
      'Use concrete file evidence from the supplied snippets/logs only.',
      'Produce the smallest safe change that addresses the stated problem.',
      'When patching is uncertain, explain why and give the least risky next step.',
      'Output sections in this exact order: Findings, Root Cause, Patch Plan, Patch Sketch, Verification, Rollback, Risks.',
      'In Patch Sketch, prefer unified diff style or precise before/after edits when possible.',
      'Use the same language as the task unless code/logs strongly suggest otherwise.',
      'Use Symbol Index, Import Graph, Call Sites, and Verification Harness to justify the patch plan whenever available.',
    ].join('\n');

    const userPrompt = [
      '## Task',
      task,
      options.context ? `\n## Extra Context\n${options.context}` : '',
      retrieval.promptContext,
      retrieval.codeIntel ? `\n## Code Intelligence\n${retrieval.codeIntel}` : '',
      retrieval.matchedFiles.length ? `\n## Candidate Files\n${retrieval.matchedFiles.join('\n')}` : '\n## Candidate Files\n(none)',
    ].filter(Boolean).join('\n');

    const response = await this.#llm.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        model,
        temperature: Math.min(TECHNICAL_TEMPERATURE, 0.12),
        maxTokens: options.maxTokens || Math.max(this.#config.maxConclusionTokens, 3200),
        _trigger: 'sub-agent-technical-patch',
        _sessionId: 'sub-agent',
        _role: 'worker',
      }
    );

    const durationMs = Date.now() - startMs;
    this.#trackCall(response, 'sub-agent-technical-patch', durationMs);
    this.emit('technicalPatchTask', {
      task: task.slice(0, 160),
      durationMs,
      matchedFiles: retrieval.matchedFiles,
      tokens: response.usage?.totalTokens,
    });

    return {
      result: response.content || '(no patch result)',
      usage: response.usage || {},
      matchedFiles: retrieval.matchedFiles,
    };
  }

  /**
   * Queue an asynchronous background sub-agent task.
   * @param {string} task
   * @param {string} [context='']
   * @param {Object} [options]
   * @returns {{ taskId: string, status: string }}
   */
  scheduleBackgroundTask(task, context = '', options = {}) {
    if (!this.#taskManager) {
      throw new Error('Background task queue is not available');
    }
    const kind = options.kind || 'generic';
    const taskType = kind === 'technical'
      ? 'subagent_technical'
      : kind === 'patch'
        ? 'subagent_patch'
        : 'subagent_generic';
    const payload = {
      task,
      context,
      files: options.files || [],
      query: options.query || '',
      maxFiles: options.maxFiles || null,
      includeWorkspace: options.includeWorkspace !== false,
      includeLogs: options.includeLogs !== false,
      maxTokens: options.maxTokens || null,
      notifySessionId: options.notifySessionId || null,
      requestedBy: options.requestedBy || null,
      meta: options.meta || null,
    };
    const title = options.title || `${taskType}:${String(task).slice(0, 80)}`;
    const taskId = this.#taskManager.createTask({
      title,
      context: context ? { text: context } : null,
      payload,
      taskType,
      sessionId: options.notifySessionId || options.sessionId || null,
      maxRetries: options.maxRetries || 2,
      priority: options.priority || 0,
      source: options.source || 'subagent',
    });
    this.emit('backgroundTaskQueued', { taskId, taskType, title, sessionId: options.notifySessionId || options.sessionId || null });
    this.emit('_backgroundTaskQueued'); // Trigger worker to process immediately instead of waiting for poll
    return { taskId, status: 'pending' };
  }

  getBackgroundTask(taskId) {
    if (!this.#taskManager) return null;
    return this.#taskManager.getTask(taskId);
  }

  listBackgroundTasks(options = {}) {
    if (!this.#taskManager) return [];
    return this.#taskManager.listTasks(options);
  }


  // ─── Active task management ───────────────────────────────────────────────

  /**
   * List active sub-agent tasks.
   * @returns {Array<{ id: string, task: string, runningMs: number }>}
   */
  listActive() {
    const now = Date.now();
    return [...this.#activeTasks.values()].map(t => ({
      id: t.id,
      task: t.task,
      runningMs: now - t.startedAt,
    }));
  }

  close() {
    if (this.#workerTimer) clearInterval(this.#workerTimer);
    this.#workerTimer = null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Get a single node by ID from the database.
   * @param {string} nodeId
   * @returns {{ id: string, l0: string, l1: string, l2: string, tags: string } | null}
   */
  #getNode(nodeId) {
    try {
      const { sql: _ownSql, params: _ownP } = this.#engine._ownerSqlClause();
      return this.#db.prepare(
        `SELECT id, l0, l1, l2, tags FROM nodes WHERE id = ? AND state = 'active'${_ownSql}`
      ).get(nodeId, ..._ownP) || null;
    } catch { return null; }
  }

  /**
   * Get all nodes connected to the given node (via edges).
   * @param {string} nodeId
   * @returns {Array<{ id: string, l0: string, l1: string }>}
   */
  #getConnectedNodes(nodeId) {
    try {
      const { sql: _ownSqlN, params: _ownPN } = this.#engine._ownerSqlClause('n');
      const _btSqlE = (typeof this.#engine._bitemporalSqlClause === 'function')
        ? this.#engine._bitemporalSqlClause('e').sql
        : '';
      const rows = this.#db.prepare(`
        SELECT DISTINCT n.id, n.l0, n.l1
        FROM edges e
        JOIN nodes n ON (n.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END)
        WHERE (e.src = ? OR e.dst = ?) AND e.state = 'active'${_btSqlE} AND n.state = 'active'${_ownSqlN}
        LIMIT 20
      `).all(nodeId, nodeId, nodeId, ..._ownPN);
      return rows;
    } catch { return []; }
  }

  /**
   * Search nodes by query using FTS5 or fallback tag/l0 matching.
   * @param {string} query
   * @param {number} limit
   * @returns {string[]} node IDs
   */
  #searchNodes(query, limit) {
    const q = String(query || '').trim();
    if (!q) return [];
    const { sql: _ownSql, params: _ownP } = this.#engine._ownerSqlClause();
    const { sql: _ownSqlN, params: _ownPN } = this.#engine._ownerSqlClause('n');
    try {
      const exact = this.#db.prepare(`SELECT id FROM nodes WHERE state='active' AND lower(id)=lower(?)${_ownSql} LIMIT ?`).all(q, ..._ownP, limit);
      if (exact.length > 0) return exact.map(r => r.id);
      const byTag = this.#db.prepare(`SELECT DISTINCT n.id FROM nodes n, json_each(n.tags) WHERE n.state='active' AND lower(json_each.value)=lower(?)${_ownSqlN} LIMIT ?`).all(q, ..._ownPN, limit);
      if (byTag.length > 0) return byTag.map(r => r.id);
    } catch {}

    // Try FTS5 next (trigram tokenizer requires query >= 3 chars)
    if (q.length >= 3) {
      try {
        // FTS has no owner_id column — filter via JOIN to nodes
        const rows = this.#db.prepare(`
          SELECT f.node_id FROM nodes_fts f JOIN nodes n ON n.id = f.node_id
          WHERE nodes_fts MATCH ? AND n.state='active'${_ownSqlN} LIMIT ?
        `).all(q, ..._ownPN, limit);
        if (rows.length > 0) return rows.map(r => r.node_id);
      } catch { /* FTS5 not available */ }
    }

    // Fallback: LIKE search on l0 + tags
    try {
      const qTrunc = q.length > 200 ? q.slice(0, 200) : q;  // SQLite LIKE pattern length limit
      const pattern = `%${qTrunc}%`;
      const rows = this.#db.prepare(`
        SELECT id FROM nodes
        WHERE state = 'active' AND (l0 LIKE ? OR tags LIKE ? OR l1 LIKE ?)${_ownSql}
        LIMIT ?
      `).all(pattern, pattern, pattern, ..._ownP, limit);
      return rows.map(r => r.id);
    } catch { return []; }
  }


  #parseTags(tags) {
    if (Array.isArray(tags)) return tags;
    if (!tags) return [];
    try { return JSON.parse(tags); } catch { return [String(tags)]; }
  }

  #tokenizeQuery(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_./-]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 16);
  }

  async #collectTechnicalContext(task, options = {}) {
    const maxFiles = options.maxFiles || this.#config.maxTechnicalFiles;
    const maxBytes = options.maxContextBytes || this.#config.maxTechnicalContextBytes;
    const query = [options.query, task].filter(Boolean).join(' ');
    const tokens = this.#tokenizeQuery(query);
    const preferredFiles = Array.isArray(options.files) ? options.files : [];
    const candidates = await this.#searchProjectFiles(tokens, {
      preferredFiles,
      maxFiles,
      includeWorkspace: options.includeWorkspace !== false,
      includeLogs: options.includeLogs !== false,
    });

    let used = 0;
    const blocks = [];
    const matchedFiles = [];
    for (const item of candidates) {
      const block = `### ${item.path}${typeof item.score === 'number' ? ` (score ${item.score})` : ''}
${item.snippet}`;
      const bytes = Buffer.byteLength(block);
      if (blocks.length > 0 && used + bytes > maxBytes) break;
      used += bytes;
      blocks.push(block);
      matchedFiles.push(item.path);
    }

    const promptContext = blocks.length
      ? `\n## Technical Context\n${blocks.join('\n\n')}`
      : '\n## Technical Context\n(no matching files or logs found)';

    const codeIntel = await this.#buildCodeIntelligence(matchedFiles, tokens, { maxBytes: Math.max(2400, Math.floor(maxBytes * 0.6)) });
    return { promptContext, matchedFiles, codeIntel };
  }

  async #buildCodeIntelligence(matchedFiles, _tokens, { maxBytes = 12000 } = {}) {
    await this.#warmCodeGraphCache(matchedFiles);

    const symbolRows = [];
    const importRows = [];
    const symbolNames = new Set();
    const moduleNames = new Set();

    for (const relPath of matchedFiles.slice(0, Math.max(1, this.#config.maxTechnicalFiles))) {
      try {
        const symbols = this.#db.prepare(`
          SELECT symbol_name, symbol_kind, line
          FROM code_symbol_entries
          WHERE path = ?
          ORDER BY line ASC
          LIMIT 24
        `).all(relPath);
        for (const row of symbols) {
          symbolRows.push(`- ${row.symbol_kind} \`${row.symbol_name}\` @ ${relPath}:${row.line}`);
          symbolNames.add(row.symbol_name);
        }

        const imports = this.#db.prepare(`
          SELECT source, line
          FROM code_import_entries
          WHERE path = ?
          ORDER BY line ASC
          LIMIT 20
        `).all(relPath);
        for (const row of imports) {
          importRows.push(`- ${relPath} -> ${row.source} (line ${row.line})`);
          if (String(row.source || '').startsWith('.')) {
            moduleNames.add(this.#normalizeModuleSource(relPath, row.source));
          }
        }
      } catch {}
    }

    const reverseImports = [];
    if (matchedFiles.length > 0) {
      const relSet = new Set(matchedFiles);
      const interestingModules = new Set([...moduleNames, ...matchedFiles]);
      for (const mod of interestingModules) {
        try {
          const rows = this.#db.prepare(`
            SELECT path, source, line
            FROM code_import_entries
            WHERE source = ?
            ORDER BY path ASC, line ASC
            LIMIT 16
          `).all(mod);
          for (const row of rows) {
            if (!relSet.has(row.path)) {
              reverseImports.push(`- ${row.path} imports ${row.source} @ line ${row.line}`);
            }
          }
        } catch {}
      }
    }

    const crossRefs = [];
    for (const name of [...symbolNames].slice(0, 12)) {
      try {
        const defs = this.#db.prepare(`
          SELECT path, line, symbol_kind
          FROM code_symbol_entries
          WHERE symbol_name = ?
          ORDER BY path ASC, line ASC
          LIMIT 10
        `).all(name);
        if (defs.length > 1) {
          crossRefs.push(`- \`${name}\` defined in ${defs.map(d => `${d.path}:${d.line}`).join(', ')}`);
        }
      } catch {}
    }

    const callSites = await this.#findCallSites([...symbolNames], { maxFiles: matchedFiles.length + 8, maxHits: 12 });
    const verification = this.#buildVerificationHarness(matchedFiles);

    const sections = [];
    if (symbolRows.length) sections.push(`### Symbol Graph
${symbolRows.slice(0, 40).join('\n')}`);
    if (importRows.length || reverseImports.length) {
      const rows = [...importRows.slice(0, 24), ...reverseImports.slice(0, 18)];
      sections.push(`### Import Graph
${rows.join('\n')}`);
    }
    if (crossRefs.length) sections.push(`### Cross References
${crossRefs.slice(0, 18).join('\n')}`);
    if (callSites.length) sections.push(`### Call Sites
${callSites.slice(0, 18).join('\n')}`);
    if (verification) sections.push(`### Verification Harness
${verification}`);

    let out = sections.join('\n\n');
    if (out.length > maxBytes) out = `${out.slice(0, maxBytes)}
... [code intelligence truncated]`;
    return out;
  }

  async #warmCodeGraphCache(matchedFiles) {
    for (const relPath of matchedFiles.slice(0, Math.max(1, this.#config.maxTechnicalFiles + 6))) {
      try {
        const abs = this.#safeProjectPath(relPath);
        if (!abs) continue;
        await this.#ensureCodeCacheForFile(abs, relPath);
      } catch {}
    }
  }

  #initCodeGraphCache() {
    try {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS code_file_cache (
          path TEXT PRIMARY KEY,
          mtime_ms INTEGER,
          size_bytes INTEGER,
          refreshed_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS code_symbol_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          symbol_name TEXT NOT NULL,
          symbol_kind TEXT NOT NULL,
          line INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS code_import_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          path TEXT NOT NULL,
          source TEXT NOT NULL,
          line INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_code_symbol_entries_path ON code_symbol_entries(path);
        CREATE INDEX IF NOT EXISTS idx_code_symbol_entries_name ON code_symbol_entries(symbol_name);
        CREATE INDEX IF NOT EXISTS idx_code_import_entries_path ON code_import_entries(path);
        CREATE INDEX IF NOT EXISTS idx_code_import_entries_source ON code_import_entries(source);
      `);
    } catch {}
  }

  async #ensureCodeCacheForFile(absPath, relPath) {
    try {
      const info = await stat(absPath);
      const existing = this.#db.prepare(`SELECT mtime_ms, size_bytes, refreshed_at FROM code_file_cache WHERE path = ?`).get(relPath);
      const refreshedAt = existing?.refreshed_at ? Date.parse(existing.refreshed_at.replace(' ', 'T') + 'Z') : 0;
      const freshEnough = refreshedAt && (Date.now() - refreshedAt) < this.#config.symbolCacheMaxAgeMs;
      if (existing && Number(existing.mtime_ms) === Number(info.mtimeMs) && Number(existing.size_bytes) === Number(info.size) && freshEnough) {
        return;
      }
      const content = await readFile(absPath, 'utf-8');
      const facts = this.#extractCodeFacts(content, relPath);
      const tx = this.#db.transaction(() => {
        this.#db.prepare(`DELETE FROM code_symbol_entries WHERE path = ?`).run(relPath);
        this.#db.prepare(`DELETE FROM code_import_entries WHERE path = ?`).run(relPath);
        const insertSymbol = this.#db.prepare(`INSERT INTO code_symbol_entries (path, symbol_name, symbol_kind, line) VALUES (?, ?, ?, ?)`);
        const insertImport = this.#db.prepare(`INSERT INTO code_import_entries (path, source, line) VALUES (?, ?, ?)`);
        for (const row of facts.symbols) insertSymbol.run(relPath, row.name, row.kind, row.line);
        for (const row of facts.imports) insertImport.run(relPath, this.#normalizeModuleSource(relPath, row.source), row.line);
        this.#db.prepare(`
          INSERT INTO code_file_cache (path, mtime_ms, size_bytes, refreshed_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size_bytes=excluded.size_bytes, refreshed_at=CURRENT_TIMESTAMP
        `).run(relPath, Math.round(info.mtimeMs), info.size);
      });
      tx();
    } catch {}
  }

  #normalizeModuleSource(relPath, source) {
    const src = String(source || '').trim();
    if (!src) return src;
    if (!src.startsWith('.')) return src;
    const baseDir = dirname(relPath);
    const normalized = relative(this.#config.projectRoot, resolve(this.#config.projectRoot, baseDir, src)).replace(/\\/g, '/');
    return normalized;
  }

  #extractCodeFacts(content, relPath) {
    const symbols = [];
    const imports = [];
    const lines = String(content || '').split('\\n');
    const patterns = [
      { kind: 'export function', re: /^\s*export\s+function\s+([A-Za-z_$][\w$]*)\s*\(/ },
      { kind: 'function', re: /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/ },
      { kind: 'class', re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
      { kind: 'const fn', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
      { kind: 'arrow fn', re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[^=]*=>/ },
    ];
    lines.forEach((line, idx) => {
      for (const p of patterns) {
        const m = line.match(p.re);
        if (m) symbols.push({ kind: p.kind, name: m[1], path: relPath, line: idx + 1 });
      }
      const im = line.match(/^\s*import\s+.+?from\s+['\"](.+?)['\"]/);
      if (im) imports.push({ path: relPath, source: im[1], line: idx + 1 });
      const req = line.match(/require\(['\"](.+?)['\"]\)/);
      if (req) imports.push({ path: relPath, source: req[1], line: idx + 1 });
    });
    return { symbols, imports };
  }

  async #findCallSites(symbolNames, { maxFiles = 12, maxHits = 12 } = {}) {
    if (!symbolNames || symbolNames.length === 0) return [];
    const names = symbolNames.filter(Boolean).slice(0, 16);
    const dirs = [resolve(this.#config.projectRoot, 'src')];
    const hits = [];
    for (const dir of dirs) {
      await this.#walkProjectFiles(dir, async (absPath) => {
        if (hits.length >= maxHits || maxFiles <= 0) return false;
        maxFiles -= 1;
        try {
          const content = await readFile(absPath, 'utf-8');
          const rel = relative(this.#config.projectRoot, absPath).replace(/\\/g, '/');
          const lines = content.split('\\n');
          for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
            const line = lines[i];
            for (const name of names) {
              if (line.includes(`${name}(`) || line.includes(`${name} (`)) {
                hits.push(`- \`${name}\` @ ${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
                break;
              }
            }
          }
        } catch {}
        return true;
      });
    }
    return hits;
  }

  #buildVerificationHarness(matchedFiles) {
    const lines = [];
    const jsFiles = matchedFiles.filter(f => /\.(?:js|mjs|cjs)$/i.test(f));
    for (const rel of jsFiles.slice(0, 6)) {
      lines.push(`- node --check ${rel}`);
    }
    if (matchedFiles.length) {
      const base = matchedFiles[0].split('/').pop()?.replace(/\.[^.]+$/, '') || 'target';
      lines.push(`- npm test -- --test-name-pattern='${base}'`);
    }
    lines.push('- node src/cli.js --e2e');
    return lines.join('\\n');
  }

  async #searchProjectFiles(tokens, { preferredFiles = [], maxFiles = DEFAULT_MAX_TECHNICAL_FILES, includeWorkspace = true, includeLogs = true } = {}) {
    const projectRoot = this.#config.projectRoot;
    const seen = new Set();
    const out = [];

    const addFile = async (absPath, scoreBoost = 0) => {
      const normalized = this.#safeProjectPath(absPath);
      if (!normalized || seen.has(normalized)) return;
      const score = await this.#scoreFile(normalized, tokens, scoreBoost);
      if (!score) return;
      seen.add(normalized);
      out.push(score);
    };

    for (const file of preferredFiles) {
      await addFile(this.#safeProjectPath(file), 120);
    }

    const dirs = [resolve(projectRoot, 'src')];
    if (includeWorkspace) dirs.push(resolve(projectRoot, 'workspace'));
    if (includeLogs) dirs.push(resolve(projectRoot, 'logs'), resolve(projectRoot, 'engine-output', 'tech-log'));

    for (const dir of dirs) {
      await this.#walkProjectFiles(dir, async (absPath) => {
        if (out.length >= maxFiles * 4) return false;
        await addFile(absPath, 0);
        return true;
      });
    }

    return out
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxFiles);
  }

  async #walkProjectFiles(dir, onFile, depth = 0) {
    if (!dir || depth > 4) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          await this.#walkProjectFiles(full, onFile, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!TECH_FILE_EXTS.has(ext)) continue;
          const keepGoing = await onFile(full);
          if (keepGoing === false) return;
        }
      }
    } catch {}
  }

  #safeProjectPath(pathLike) {
    if (!pathLike) return null;
    const projectRoot = this.#config.projectRoot;
    const abs = resolve(projectRoot, pathLike);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith('..') || rel.includes('../') || rel.includes('..\\')) return null;
    return abs;
  }

  async #scoreFile(absPath, tokens, scoreBoost = 0) {
    try {
      const info = await stat(absPath);
      if (!info.isFile() || info.size > 300_000) return null;
      const content = await readFile(absPath, 'utf-8');
      const pathText = relative(this.#config.projectRoot, absPath).replace(/\\/g, '/');
      const lowerPath = pathText.toLowerCase();
      const lower = content.toLowerCase();
      let score = scoreBoost;
      for (const token of tokens) {
        if (lowerPath.includes(token)) score += 24;
        if (lower.includes(token)) score += 8;
      }
      if (score <= 0) return null;
      return {
        path: pathText,
        score,
        snippet: this.#extractSnippet(content, tokens),
      };
    } catch {
      return null;
    }
  }

  #extractSnippet(content, tokens, radius = 10, maxChars = 2600) {
    const lines = String(content || '').split('\n');
    let hit = 0;
    if (tokens.length > 0) {
      const lowerTokens = tokens.map(t => t.toLowerCase());
      hit = lines.findIndex(line => lowerTokens.some(t => line.toLowerCase().includes(t)));
      if (hit < 0) hit = 0;
    }
    const start = Math.max(0, hit - radius);
    const end = Math.min(lines.length, hit + radius + 1);
    let snippet = lines.slice(start, end).map((line, idx) => `${start + idx + 1}: ${line}`).join('\n');
    if (snippet.length > maxChars) snippet = snippet.slice(0, maxChars) + '\n... [snippet truncated]';
    return snippet;
  }


  #startBackgroundWorker() {
    if (this.#workerTimer || !this.#taskManager) return;
    // Event-driven: immediate processing when a task is queued
    this.on('_backgroundTaskQueued', () => {
      this.#workerLoop().catch(err => {
        this.emit('backgroundTaskError', { error: err.message });
      });
    });
    // Fallback poll every 30s to catch missed events or stale tasks
    this.#workerTimer = setInterval(() => {
      this.#workerLoop().catch(err => {
        this.emit('backgroundTaskError', { error: err.message });
      });
    }, 30_000);
    this.#workerTimer.unref?.();
  }

  async #workerLoop() {
    if (this.#workerBusy || !this.#taskManager) return;
    this.#workerBusy = true;
    try {
      for (let i = 0; i < 3; i++) {
        const task = this.#taskManager.claimNextTask({
          taskTypes: ['subagent_generic', 'subagent_technical', 'subagent_patch'],
          workerId: this.#workerId,
          leaseMs: this.#config.backgroundLeaseMs,
        });
        if (!task) break;
        await this.#processQueuedTask(task);
      }
    } finally {
      this.#workerBusy = false;
    }
  }

  async #processQueuedTask(task) {
    const payload = task.payload || {};
    const heartbeat = setInterval(() => {
      try {
        this.#taskManager?.heartbeatTask(task.id, { workerId: this.#workerId, leaseMs: this.#config.backgroundLeaseMs });
      } catch {}
    }, Math.max(10_000, Math.floor(this.#config.backgroundLeaseMs / 3)));
    heartbeat.unref?.();
    this.emit('backgroundTaskStart', { taskId: task.id, taskType: task.taskType, sessionId: task.sessionId });
    try {
      let result;
      if (task.taskType === 'subagent_technical') {
        result = await this.runTechnicalTask(payload.task || task.title, payload);
      } else if (task.taskType === 'subagent_patch') {
        result = await this.runTechnicalPatchTask(payload.task || task.title, payload);
      } else {
        result = await this.runTask(payload.task || task.title, payload.context || '', payload);
      }
      const normalized = {
        kind: task.taskType,
        result: result.result || result.conclusion || '',
        usage: result.usage || {},
        matchedFiles: result.matchedFiles || [],
      };
      this.#taskManager.completeTask(task.id, normalized, { resultPreview: normalized.result.slice(0, 800) });
      const finished = this.#taskManager.getTask(task.id);
      this.emit('backgroundTaskComplete', {
        taskId: task.id,
        taskType: task.taskType,
        sessionId: task.sessionId || payload.notifySessionId || null,
        result: normalized.result,
        matchedFiles: normalized.matchedFiles,
        task: finished,
      });
    } catch (err) {
      this.#taskManager.failTask(task.id, err.message, { permanent: false });
      this.emit('backgroundTaskError', {
        taskId: task.id,
        taskType: task.taskType,
        sessionId: task.sessionId || payload.notifySessionId || null,
        error: err.message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * No-op. llm-router's #trackApiCall already records every chat() call.
   * Kept as a method to avoid disturbing the 4 call sites; will be removed
   * in a future cleanup pass.
   */
  #trackCall(_response, _trigger, _durationMs) { /* no-op: avoid double-count with llm-router */ }
}

export default SubAgentManager;
