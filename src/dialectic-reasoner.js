// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * dialectic-reasoner.js — formal-logic reasoning layer (Honcho-style reasoning memory)
 *
 * Performs deductive/inductive/abductive reasoning over star-map nodes and writes
 * the conclusions back as new nodes. Conclusion nodes automatically receive the
 * usual diameter decay + Hebbian reinforcement + topology edges.
 *
 * Does not modify engine.js. Writes via rememberRaw/remember.
 *
 * Usage:
 *   const { DialecticReasoner } = require('./dialectic-reasoner');
 *   const reasoner = new DialecticReasoner(constellation, { llmCall });
 *
 *   // Derive conclusions from the most recently injected nodes
 *   const results = await reasoner.reason({ recentNodeIds: [...] });
 *
 *   // Detect conflicts
 *   const conflicts = reasoner.detectConflicts(nodeId);
 *
 * @module dialectic-reasoner
 */

const REASONING_PROMPT = `You are a formal reasoning engine for a memory constellation system.

Given a set of memory nodes (premises), perform structured reasoning to derive NEW conclusions that are NOT explicitly stated in any single node.

## Reasoning Types
1. **Deductive**: If A and B are true, what necessarily follows?
2. **Inductive**: What pattern emerges across multiple nodes?
3. **Abductive**: What is the simplest explanation for observed behaviors/events?

## Rules
- Each conclusion MUST cite at least 2 premise node IDs
- Confidence: 0.0-1.0 (only output conclusions with confidence >= 0.6)
- Do NOT repeat what's already stated — only derive NEW insights
- Do NOT hallucinate — every conclusion must logically follow from premises
- Keep conclusions concise (1-3 sentences)

## Output Format (strict JSON array)
[
  {
    "type": "deductive" | "inductive" | "abductive",
    "conclusion": "The derived insight in natural language",
    "premises": ["node-id-1", "node-id-2"],
    "confidence": 0.85,
    "tags": ["relevant", "tags"]
  }
]

If no valid conclusions can be drawn, return: []`;

const CONFLICT_DETECTION_PROMPT = `You are checking for logical conflicts between a new conclusion and existing conclusions in a memory system.

New conclusion:
{new_conclusion}

Existing conclusions:
{existing_conclusions}

For each existing conclusion that CONFLICTS with the new one, output:
[
  {
    "conflicting_id": "node-id",
    "conflict_type": "contradiction" | "superseded" | "refined",
    "explanation": "Brief explanation of the conflict",
    "resolution": "keep_new" | "keep_old" | "merge"
  }
]

If no conflicts, return: []`;

const DEFAULT_OPTIONS = {
  /** Maximum number of premise nodes loaded per reasoning round */
  maxPremises: 15,
  /** Maximum number of conclusions to emit */
  maxConclusions: 5,
  /** Minimum confidence threshold */
  minConfidence: 0.6,
  /** Default weight assigned to conclusion nodes */
  conclusionWeight: 1.1,
  /** Maximum number of existing inference nodes loaded for conflict detection */
  maxExistingInferences: 20,
};

class DialecticReasoner {
  /**
   * @param {import('./engine').ConstellationEngine} constellation
   * @param {object} opts
   * @param {function} opts.llmCall — async (prompt, systemPrompt) => string
   *   The LLM-invocation function. Injected by the caller so the module stays
   *   decoupled from any specific LLM provider. If omitted, falls back to the
   *   constellation's internal _llmCall (when present).
   */
  constructor(constellation, opts = {}) {
    this.engine = constellation;
    this.llmCall = opts.llmCall || null;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Fetch recent nodes to use as reasoning premises.
   * @param {string[]} [recentNodeIds] — explicit list of node IDs
   * @param {number} [limit] — when no IDs are provided, take the most recent N
   * @returns {Array<{ id: string, l0: string, l1: string, l2: string, tags: string }>}
   */
  _getPremises(recentNodeIds = null, limit = null) {
    const max = limit || this.opts.maxPremises;
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();

    if (recentNodeIds && recentNodeIds.length > 0) {
      const placeholders = recentNodeIds.map(() => '?').join(',');
      return this.engine.db.prepare(
        `SELECT id, l0, l1, l2, tags FROM nodes
         WHERE id IN (${placeholders}) AND state = 'active'${_ownSql}
         LIMIT ?`
      ).all(...recentNodeIds, ..._ownP, max);
    }

    // Default: take the most recently written active nodes (exclude existing
    // inference nodes to avoid self-reference).
    return this.engine.db.prepare(
      `SELECT id, l0, l1, l2, tags FROM nodes
       WHERE state = 'active' AND source != 'inference'${_ownSql}
       ORDER BY created_at DESC LIMIT ?`
    ).all(..._ownP, max);
  }

  /**
   * Fetch existing inference conclusion nodes (used for conflict detection).
   * @returns {Array<{ id: string, l1: string, l2: string }>}
   */
  _getExistingInferences() {
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
    return this.engine.db.prepare(
      `SELECT id, l1, l2 FROM nodes
       WHERE source = 'inference' AND state = 'active'${_ownSql}
       ORDER BY created_at DESC LIMIT ?`
    ).all(..._ownP, this.opts.maxExistingInferences);
  }

  /**
   * Build the reasoning prompt.
   * @param {Array<object>} premises
   * @returns {string}
   */
  _buildReasoningPrompt(premises) {
    const premiseText = premises.map(p => {
      const tags = p.tags ? JSON.parse(p.tags).join(', ') : '';
      return `[${p.id}] (tags: ${tags})\n${p.l1}\n${p.l2}`;
    }).join('\n\n---\n\n');

    return `## Premise Nodes (${premises.length} total)\n\n${premiseText}\n\n## Task\nDerive up to ${this.opts.maxConclusions} NEW conclusions from these premises. Remember: only conclusions with confidence >= ${this.opts.minConfidence}.`;
  }

  /**
   * Parse the JSON returned by the LLM.
   * @param {string} response
   * @returns {Array<object>}
   */
  _parseResponse(response) {
    try {
      // Extract the JSON array (may be wrapped in markdown code fences).
      const match = response.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(c =>
        c.conclusion &&
        c.premises && Array.isArray(c.premises) && c.premises.length >= 2 &&
        typeof c.confidence === 'number' && c.confidence >= this.opts.minConfidence
      );
    } catch {
      return [];
    }
  }

  /**
   * Invoke the LLM.
   * @param {string} userPrompt
   * @param {string} systemPrompt
   * @returns {Promise<string>}
   */
  async _callLLM(userPrompt, systemPrompt) {
    if (this.llmCall) {
      return this.llmCall(userPrompt, systemPrompt);
    }

    // Fallback: try the engine's internal LLM call.
    if (this.engine._llmCall) {
      return this.engine._llmCall(userPrompt, systemPrompt);
    }

    throw new Error('No LLM call function provided. Pass { llmCall } to constructor or set engine._llmCall.');
  }

  /**
   * Main reasoning entry point.
   * @param {object} [opts]
   * @param {string[]} [opts.recentNodeIds] — explicit premise nodes
   * @param {number} [opts.maxConclusions] — overrides the default max-conclusion count
   * @returns {Promise<{ conclusions: Array<{ nodeId: string, type: string, conclusion: string, confidence: number, premises: string[] }>, skipped: number }>}
   */
  async reason({ recentNodeIds = null, maxConclusions = null } = {}) {
    const premises = this._getPremises(recentNodeIds);

    if (premises.length < 3) {
      return { conclusions: [], skipped: 0, reason: 'too few premises' };
    }

    const userPrompt = this._buildReasoningPrompt(premises);
    const response = await this._callLLM(userPrompt, REASONING_PROMPT);
    const rawConclusions = this._parseResponse(response);

    const max = maxConclusions || this.opts.maxConclusions;
    const accepted = rawConclusions.slice(0, max);
    const skipped = rawConclusions.length - accepted.length;

    const results = [];

    const { sql: _ownSqlV, params: _ownPV } = this.engine._ownerSqlClause();
    const validateStmt = this.engine.db.prepare(
      `SELECT 1 FROM nodes WHERE id = ? AND state = 'active'${_ownSqlV}`
    );
    for (const c of accepted) {
      // Verify premise nodes exist (scoped to current owner).
      const validPremises = c.premises.filter(pid =>
        validateStmt.get(pid, ..._ownPV)
      );

      if (validPremises.length < 2) continue;

      // Build the inference-node text.
      const inferenceText = [
        `[INFERENCE:${c.type.toUpperCase()}] ${c.conclusion}`,
        ``,
        `Confidence: ${c.confidence}`,
        `Premises: ${validPremises.join(', ')}`,
        `Reasoning type: ${c.type}`,
      ].join('\n');

      // Write to the star map.
      try {
        const nodeId = await this.engine.rememberRaw(inferenceText, {
          id: `inf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          source: 'inference',
        });

        results.push({
          nodeId,
          type: c.type,
          conclusion: c.conclusion,
          confidence: c.confidence,
          premises: validPremises,
        });
      } catch (err) {
        // Write failure does not abort the rest of the batch.
        console.error(`Failed to write inference node: ${err.message}`);
      }
    }

    return { conclusions: results, skipped };
  }

  /**
   * Detect conflicts between a new conclusion and existing inferences.
   * @param {string} newNodeId — node ID of the new conclusion
   * @returns {Promise<Array<{ conflictingId: string, conflictType: string, explanation: string, resolution: string }>>}
   */
  async detectConflicts(newNodeId) {
    const { sql: _ownSqlN, params: _ownPN } = this.engine._ownerSqlClause();
    const newNode = this.engine.db.prepare(
      `SELECT l1, l2 FROM nodes WHERE id = ? AND state = 'active'${_ownSqlN}`
    ).get(newNodeId, ..._ownPN);

    if (!newNode) return [];

    const existing = this._getExistingInferences()
      .filter(n => n.id !== newNodeId);

    if (existing.length === 0) return [];

    const existingText = existing.map(n => `[${n.id}] ${n.l1}`).join('\n');
    const prompt = CONFLICT_DETECTION_PROMPT
      .replace('{new_conclusion}', `[${newNodeId}] ${newNode.l1}\n${newNode.l2}`)
      .replace('{existing_conclusions}', existingText);

    const response = await this._callLLM(prompt, 'You are a logical conflict detector. Output strict JSON.');
    const conflicts = this._parseResponse(response);

    // Handle "superseded" conflicts automatically.
    // Master plan §10 defense-in-depth: skip superseded_by when the dialectic
    // would clobber a user-authored node. The new node still exists and the
    // conflict surfaces via topology.
    const newNodeRow = this.engine.db.prepare("SELECT source FROM nodes WHERE id = ?").get(newNodeId);
    const supersederSource = newNodeRow?.source || 'inference';
    for (const conflict of conflicts) {
      if (conflict.resolution === 'keep_new' && conflict.conflicting_id) {
        if (!this.engine._isSupersedeAllowed(supersederSource, conflict.conflicting_id)) {
          console.log(`[Dialectic] Skipping superseded_by ${conflict.conflicting_id}: user-authored, superseder=${supersederSource}`);
          continue;
        }
        // Add a superseded_by edge from the old node.
        try {
          this.engine.db.prepare(`
            INSERT OR IGNORE INTO edges (source, target, edge_type, strength, state, created_at, owner_id)
            VALUES (?, ?, 'superseded_by', 0.8, 'active', ?,
              COALESCE((SELECT owner_id FROM nodes WHERE id = ?), ?))
          `).run(conflict.conflicting_id, newNodeId, new Date().toISOString(),
                  conflict.conflicting_id, this.engine._resolveOwnerStamp());
        } catch {
          // Edge-write failure does not abort the loop.
        }
      }
    }

    return conflicts;
  }

  /**
   * Get reasoning statistics.
   * @returns {{ total: number, byType: object, avgConfidence: number }}
   */
  stats() {
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
    const all = this.engine.db.prepare(
      `SELECT l0, weight FROM nodes WHERE source = 'inference' AND state = 'active'${_ownSql}`
    ).all(..._ownP);

    const byType = { deductive: 0, inductive: 0, abductive: 0, unknown: 0 };
    for (const n of all) {
      if (n.l0.includes('DEDUCTIVE')) byType.deductive++;
      else if (n.l0.includes('INDUCTIVE')) byType.inductive++;
      else if (n.l0.includes('ABDUCTIVE')) byType.abductive++;
      else byType.unknown++;
    }

    return {
      total: all.length,
      byType,
      avgWeight: all.length > 0 ? all.reduce((s, n) => s + n.weight, 0) / all.length : 0,
    };
  }

  /**
   * List all inference conclusions.
   * @param {number} [limit=20]
   * @returns {Array<{ id: string, l0: string, l1: string, weight: number, created_at: string }>}
   */
  listInferences(limit = 20) {
    const { sql: _ownSql, params: _ownP } = this.engine._ownerSqlClause();
    return this.engine.db.prepare(
      `SELECT id, l0, l1, weight, created_at FROM nodes
       WHERE source = 'inference' AND state = 'active'${_ownSql}
       ORDER BY created_at DESC LIMIT ?`
    ).all(..._ownP, limit);
  }
}

export { DialecticReasoner };
