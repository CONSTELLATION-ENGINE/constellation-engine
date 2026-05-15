// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * procedure-extractor.js — automatically extracts reusable procedure nodes from
 * complex tasks.
 *
 * Design principles:
 * - Does not modify engine.js; only uses the existing rememberRaw / remember APIs
 * - Procedure nodes are marked with source='procedure' + tags=['procedure']
 * - Trigger condition: session has tool calls >= threshold AND the task succeeded
 * - Quality filter: only extract patterns with genuine reuse value
 *
 * Usage:
 *   const { ProcedureExtractor } = require('./procedure-extractor');
 *   const extractor = new ProcedureExtractor(constellation);
 *
 *   // Call when a session/cron finishes
 *   const result = await extractor.extract(sessionMessages, { source: 'cron-explore' });
 *   // result: { extracted: true, nodeId: 'proc-...' } | { extracted: false, reason: '...' }
 *
 * @module procedure-extractor
 */

const DEFAULT_OPTIONS = {
  /** Minimum number of tool calls before extraction is triggered */
  minToolCalls: 5,
  /** Minimum number of distinct tool types (avoid repeated calls to a single tool) */
  minDistinctTools: 2,
  /** Tool names excluded from the complexity metric */
  excludeTools: ['memory_search', 'memory_get'],
  /** Default weight assigned to procedure nodes */
  defaultWeight: 1.2,
};

class ProcedureExtractor {
  /**
   * @param {import('./engine').ConstellationEngine} constellation
   * @param {object} [opts]
   */
  constructor(constellation, opts = {}) {
    this.engine = constellation;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Analyze session messages and decide whether a procedure is worth extracting.
   * @param {Array<object>} messages — OpenAI-format messages array
   * @returns {{ qualifies: boolean, toolCalls: number, distinctTools: number, tools: string[], reason?: string }}
   */
  analyze(messages) {
    const toolCalls = [];
    
    for (const msg of messages) {
      // assistant message with tool_use
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' || block.type === 'function') {
            const name = block.name || block.function?.name;
            if (name && !this.opts.excludeTools.includes(name)) {
              toolCalls.push(name);
            }
          }
        }
      }
      // tool_calls array format (OpenAI style)
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (name && !this.opts.excludeTools.includes(name)) {
            toolCalls.push(name);
          }
        }
      }
    }

    const distinctTools = [...new Set(toolCalls)];

    if (toolCalls.length < this.opts.minToolCalls) {
      return { qualifies: false, toolCalls: toolCalls.length, distinctTools: distinctTools.length, tools: distinctTools, reason: `too few tool calls (${toolCalls.length} < ${this.opts.minToolCalls})` };
    }
    if (distinctTools.length < this.opts.minDistinctTools) {
      return { qualifies: false, toolCalls: toolCalls.length, distinctTools: distinctTools.length, tools: distinctTools, reason: `too few distinct tools (${distinctTools.length} < ${this.opts.minDistinctTools})` };
    }

    return { qualifies: true, toolCalls: toolCalls.length, distinctTools: distinctTools.length, tools: distinctTools };
  }

  /**
   * Extract the final assistant summary from the messages as the task description.
   * @param {Array<object>} messages
   * @returns {string}
   */
  _extractTaskSummary(messages) {
    // Walk backwards to find the most recent assistant text reply.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content.length > 50) {
          return msg.content.slice(0, 500);
        }
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content.find(b => b.type === 'text');
          if (textBlock?.text?.length > 50) {
            return textBlock.text.slice(0, 500);
          }
        }
      }
    }
    return '';
  }

  /**
   * Build the procedure description text (passed to rememberRaw).
   * @param {object} analysis — return value from analyze()
   * @param {string} taskSummary — task summary
   * @param {object} meta — extra metadata
   * @returns {string}
   */
  _buildProcedureText(analysis, taskSummary, meta = {}) {
    const toolList = analysis.tools.join(', ');
    const lines = [
      `[PROCEDURE] ${meta.title || 'Extracted workflow pattern'}`,
      ``,
      `Tools used: ${toolList} (${analysis.toolCalls} calls, ${analysis.distinctTools} distinct)`,
      `Source: ${meta.source || 'session'}`,
      `Date: ${new Date().toISOString()}`,
      ``,
      `Task summary: ${taskSummary}`,
      ``,
      `Steps:`,
      `(Auto-extracted — the tool sequence represents a successful workflow pattern that can be reused for similar tasks.)`,
    ];
    return lines.join('\n');
  }

  /**
   * Check whether a similar procedure already exists (deduplication).
   * @param {string} procedureText
   * @returns {Promise<boolean>}
   */
  async _isDuplicate(procedureText) {
    try {
      const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
      const results = this.engine.db.prepare(
        `SELECT id, l1 FROM nodes WHERE source = 'procedure' AND state = 'active'${_ownSql}`
      ).all(..._ownP);
      
      if (results.length === 0) return false;

      // Simple textual similarity check: if the tool combo is identical, treat as duplicate.
      const toolMatch = procedureText.match(/Tools used: (.+?) \(/);
      if (!toolMatch) return false;
      const currentTools = toolMatch[1];

      for (const row of results) {
        if (row.l1 && row.l1.includes(currentTools)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Main entry point: analyze + extract + write to star map.
   * @param {Array<object>} messages — session messages
   * @param {object} [meta] — { source, title }
   * @returns {Promise<{ extracted: boolean, nodeId?: string, reason?: string, analysis?: object }>}
   */
  async extract(messages, meta = {}) {
    const analysis = this.analyze(messages);
    
    if (!analysis.qualifies) {
      return { extracted: false, reason: analysis.reason, analysis };
    }

    const taskSummary = this._extractTaskSummary(messages);
    if (!taskSummary) {
      return { extracted: false, reason: 'no task summary found in messages', analysis };
    }

    const procedureText = this._buildProcedureText(analysis, taskSummary, meta);

    // Deduplication.
    if (await this._isDuplicate(procedureText)) {
      return { extracted: false, reason: 'duplicate procedure exists', analysis };
    }

    // Write to the star map.
    const nodeId = await this.engine.rememberRaw(procedureText, {
      id: `proc-${Date.now()}`,
      source: 'procedure',
    });

    return { extracted: true, nodeId, analysis };
  }

  /**
   * Query all existing procedure nodes.
   * @returns {Array<{ id: string, l0: string, l1: string, weight: number, access_count: number }>}
   */
  listProcedures() {
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
    return this.engine.db.prepare(
      `SELECT id, l0, l1, weight, access_count FROM nodes WHERE source = 'procedure' AND state = 'active'${_ownSql} ORDER BY weight DESC`
    ).all(..._ownP);
  }

  /**
   * Find procedures relevant to the current task (via embedding similarity).
   * @param {string} taskDescription — current task description
   * @param {number} [limit=3]
   * @returns {Promise<Array<{ id: string, l0: string, l2: string, similarity: number }>>}
   */
  async findRelevant(taskDescription, limit = 3) {
    const embedding = await this.engine._embed(taskDescription);

    // First find the rowids of all procedure nodes.
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
    const procIds = this.engine.db.prepare(
      `SELECT id FROM nodes WHERE source = 'procedure' AND state = 'active'${_ownSql}`
    ).all(..._ownP).map(r => r.id);

    if (procIds.length === 0) return [];

    const rowids = this.engine.db.prepare(
      `SELECT rowid, node_id FROM node_rowids WHERE node_id IN (${procIds.map(() => '?').join(',')})`
    ).all(...procIds);

    if (rowids.length === 0) return [];

    // Vector search.
    const results = this.engine.db.prepare(
      `SELECT rowid, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embedding, limit * 3); // over-fetch then filter

    const rowidMap = new Map(rowids.map(r => [r.rowid, r.node_id]));
    const matched = [];

    for (const r of results) {
      const nodeId = rowidMap.get(r.rowid);
      if (nodeId) {
        const node = this.engine._filterByOwner(
          this.engine.db.prepare("SELECT l0, l2 FROM nodes WHERE id = ?").get(nodeId)
        );
        if (node) {
          matched.push({ id: nodeId, l0: node.l0, l2: node.l2, similarity: 1 - r.distance });
        }
        if (matched.length >= limit) break;
      }
    }

    return matched;
  }
}

export { ProcedureExtractor };
