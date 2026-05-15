// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module session-debrief
 * @description Layer 3 of the Anamnesis system (Session Debrief).
 *
 * When BehaviorLogger's cumulative significance score crosses the threshold,
 * this module fires: it collects pending session behaviors, pulls conversation
 * snippets, reads current COGNITIVE_STATE.md + tasks.json, constructs a compact-tier
 * LLM prompt, parses the structured delta, and applies changes.
 *
 * Design: R1 spec §3.6 in engine-output/architecture-research/SESSION-DEBRIEF-DESIGN.md
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOwnInstanceSession, OWNER_USER_ID, OWNER_SPEAKER_ID } from './user-identity.js';
import liveBus from './live-bus.cjs';
import { writeCompletionCandidates } from './pulse-handlers.js';
import { matchActiveTasks, loadActiveTasks } from './task-completion-matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDENTITY_DIR = resolve(__dirname, '../identity');
const COGNITIVE_STATE_PATH = resolve(IDENTITY_DIR, 'COGNITIVE_STATE.md');
const COGNITIVE_STATE_ARCHIVE_PATH = resolve(IDENTITY_DIR, 'cognitive-state-archive.md');
const TASKS_PATH = resolve(IDENTITY_DIR, 'tasks.json');
const TASKS_ARCHIVE_PATH = resolve(IDENTITY_DIR, 'tasks-archive.json');
const PARSE_FAIL_DIR = resolve(__dirname, '../logs/anamnesis-parse-failures');

// ─── Configuration ──────────────────────────────────────────────────────────
// Empty default → resolved per-call from llm router config (compactModel).
const DEBRIEF_MODEL = process.env.CONSTELLATION_DEBRIEF_MODEL || '';
const MAX_CONTEXT_MESSAGES = 5;   // ±5 messages around high-signal sessions
const MAX_SNIPPET_CHARS = 8000;   // cap total snippet size sent to compact-tier LLM
const BACKUP_SUFFIX = '.debrief-backup';

// Safe-archive triple gate: only completed/expired/failed tasks that have
// sat in that status ≥ ARCHIVE_AGE_DAYS get moved to tasks-archive.json.
// in_progress/pending/blocked/suspended/code-ready/code-done are NEVER touched.
const ARCHIVE_STATUS_WHITELIST = new Set(['completed', 'expired', 'failed']);
const ARCHIVE_AGE_DAYS = 7;
const COGNITIVE_STATE_MAX_BYTES = 64 * 1024;  // 64 KB cap before rolling

export class SessionDebrief {
  /** @type {import('./llm-router.js').LLMRouter} */
  #llm = null;
  /** @type {import('better-sqlite3').Database} */
  #db = null;
  /** @type {import('./behavior-logger.js').BehaviorLogger} */
  #behaviorLogger = null;
  /** @type {object} engine instance for rememberRaw */
  #engine = null;
  /** @type {string|null} last delta JSON for dedup */
  #lastDelta = null;
  /** @type {boolean} prevents concurrent runs */
  #running = false;
  /** @type {Set<string>} tracks node IDs written in current debrief cycle (shared across debrief + inbox paths) */
  #cycleWrittenIds = new Set();

  /** @type {{agent_name: string, owner_name: string, owner_display_name: string}} */
  #identity = { agent_name: 'Agent', owner_name: 'Owner', owner_display_name: '' };

  /**
   * @param {object} opts
   * @param {import('./llm-router.js').LLMRouter} opts.llm
   * @param {import('better-sqlite3').Database} opts.db - conversations.db handle
   * @param {import('./behavior-logger.js').BehaviorLogger} opts.behaviorLogger
   * @param {object} [opts.engine] - constellation engine for rememberRaw
   * @param {object} [opts.identity] - identity config { agent_name, owner_name, owner_display_name }
   */
  constructor({ llm, db, behaviorLogger, engine = null, identity = null }) {
    this.#llm = llm;
    this.#db = db;
    this.#behaviorLogger = behaviorLogger;
    this.#engine = engine;
    if (identity && typeof identity === 'object') {
      this.#identity = { ...this.#identity, ...identity };
    }
  }

  /**
   * Main entry point — called by BehaviorLogger.onDebriefTrigger.
   * @param {object[]} pendingSessions - from BehaviorLogger.getPending()
   */
  async run(pendingSessions) {
    if (this.#running) {
      console.log('[Anamnesis] Already running, skipping.');
      return;
    }
    if (!pendingSessions || pendingSessions.length === 0) {
      console.log('[Anamnesis] No pending sessions.');
      return;
    }

    // Partition pending by ownership: Anamnesis writes to identity files
    // (COGNITIVE_STATE.md, tasks.json) that belong to this instance's owner.
    // A foreign user's session must never influence those artifacts.
    // Own-instance = OWNER_USER_ID's session + cron/autonomous/mimir system
    // sessions (see user-identity.js isOwnInstanceSession).
    const ownedSessions = pendingSessions.filter(s => isOwnInstanceSession(s.session_id));
    const foreignCount = pendingSessions.length - ownedSessions.length;
    if (foreignCount > 0) {
      console.warn(`[Anamnesis] Partition: ${ownedSessions.length} own / ${foreignCount} foreign (foreign sessions kept in pending for their own owner; not processed here)`);
      // Mark foreign sessions as skipped for *this* debrief so they don't
      // keep pulling the trigger; they can be addressed by their own instance
      // in a multi-tenant deployment, or garbage-collected in single-tenant.
      try {
        const foreign = pendingSessions.filter(s => !isOwnInstanceSession(s.session_id));
        const ids = foreign.map(s => s.id);
        if (ids.length > 0) {
          this.#behaviorLogger.markDebriefed(ids, JSON.stringify({ skip_reason: 'foreign_session_not_owned_by_this_instance', owner: OWNER_USER_ID || '(unset)' }), false);
        }
      } catch (e) { console.warn(`[Anamnesis] Failed to skip foreign sessions: ${e.message}`); }
    }
    if (ownedSessions.length === 0) {
      console.log('[Anamnesis] No owned pending sessions after partition.');
      return;
    }

    this.#running = true;
    this.#cycleWrittenIds.clear();  // Reset dedup set for this cycle
    const startTime = Date.now();
    console.log(`[Anamnesis] ── Debrief starting ── ${ownedSessions.length} session(s) queued`);
    liveBus.safeEmit('engine.anamnesis', { stage: 'start', sessions: ownedSessions.length });

    // Use ownedSessions as the working set everywhere below.
    pendingSessions = ownedSessions;

    try {
      // 1. Build context: conversation snippets + current state
      const snippets = this.#pullSnippets(pendingSessions);
      const cogState = this.#readFile(COGNITIVE_STATE_PATH) || '(COGNITIVE_STATE.md not found)';
      const tasksJson = this.#readFile(TASKS_PATH) || '{"tasks":[]}';

      // 1b. Fetch pending inbox items for review
      const inboxItems = this.#fetchInboxPending();

      // 2. Build prompt
      const prompt = this.#buildPrompt(pendingSessions, snippets, cogState, tasksJson, inboxItems);

      // 3. Call compact-tier LLM via the anamnesis role
      const response = await this.#llm.chat(
        [{ role: 'user', content: prompt }],
        {
          // Empty DEBRIEF_MODEL → router resolves via _role='anamnesis' → roles.anamnesis
          // → falls back to compactModel from llm config.
          model: DEBRIEF_MODEL || undefined,
          _role: 'anamnesis',
          temperature: 0.2,
          maxTokens: 4096,
          _trigger: 'anamnesis-debrief',
          _sessionId: 'anamnesis',
        },
      );

      const rawOutput = typeof response === 'string'
        ? response
        : response?.content || response?.text || '';

      // 4. Parse delta
      const delta = this.#parseDelta(rawOutput);
      if (!delta) {
        console.warn('[Anamnesis] Failed to parse delta from the compact-tier LLM response.');
        liveBus.safeEmit('engine.anamnesis', { stage: 'parse_error', raw_length: rawOutput.length });
        // Mark sessions as debriefed with error to prevent infinite retry
        try {
          const ids = pendingSessions.map(s => s.id);
          this.#behaviorLogger.markDebriefed(ids, JSON.stringify({ parse_error: true, raw_length: rawOutput.length }), false);
        } catch (e) { console.warn(`[Anamnesis] Failed to mark parse-error sessions: ${e.message}`); }
        return;
      }

      // 5. Check skip
      if (delta.skip_reason) {
        console.log(`[Anamnesis] Skipped: ${delta.skip_reason}`);
        liveBus.safeEmit('engine.anamnesis', { stage: 'skip', reason: String(delta.skip_reason).slice(0, 80) });
        try {
          const ids = pendingSessions.map(s => s.id);
          this.#behaviorLogger.markDebriefed(ids, JSON.stringify(delta), false);
        } catch (e) { console.warn(`[Anamnesis] Failed to mark skipped sessions: ${e.message}`); }
        return;
      }

      // 6. Apply delta
      await this.#applyDelta(delta, cogState, tasksJson, pendingSessions);

      // 7. Mark debriefed
      const ids = pendingSessions.map(s => s.id);
      const deltaJson = JSON.stringify(delta);
      try {
        this.#behaviorLogger.markDebriefed(ids, deltaJson, true);
      } catch (e) { console.warn(`[Anamnesis] Failed to mark debriefed sessions: ${e.message}`); }
      this.#lastDelta = deltaJson;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const tasksCompleted = delta.tasks_completed?.length || 0;
      const tasksUpdated = delta.tasks_updated?.length || 0;
      const tasksNew = delta.tasks_new?.length || 0;
      const patches = delta.cognitive_state_patches?.length || 0;
      const starWrites = delta.star_map_worthy?.length || 0;
      const inboxDecisions = delta.inbox_decisions?.length || 0;

      console.log(`[Anamnesis] ── Debrief complete ── ${elapsed}s`);
      console.log(`[Anamnesis]   Tasks: ${tasksCompleted} completed, ${tasksUpdated} updated, ${tasksNew} new`);
      console.log(`[Anamnesis]   Cognitive patches: ${patches} | Star map writes: ${starWrites} | Inbox: ${inboxDecisions}`);
      console.log(`[Anamnesis]   Sessions processed: ${pendingSessions.length} | Debriefs today: ${this.#getDebriefCount()}`);
      const writtenIds = [...this.#cycleWrittenIds].slice(0, 10);
      const writtenTotal = this.#cycleWrittenIds.size;
      liveBus.safeEmit('engine.anamnesis', {
        stage: 'done',
        sessions: pendingSessions.length,
        elapsed_s: Number(elapsed),
        tasks_completed: tasksCompleted,
        tasks_updated: tasksUpdated,
        tasks_new: tasksNew,
        patches,
        star_writes: starWrites,
        inbox: inboxDecisions,
        star_write_ids: writtenIds,
        star_write_total: writtenTotal,
      });

    } catch (err) {
      console.error(`[Anamnesis] Error: ${err.message}`);
      liveBus.safeEmit('engine.anamnesis', { stage: 'error', error: String(err.message || err).slice(0, 120) });
    } finally {
      this.#running = false;
    }
  }

  /** Get today's debrief count from BehaviorLogger */
  #getDebriefCount() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const row = this.#db.prepare(
        `SELECT COUNT(*) as cnt FROM session_behaviors WHERE debrief_status = 'debriefed' AND debriefed_at >= ?`
      ).get(today);
      return row?.cnt || 0;
    } catch { return '?'; }
  }

  // ─── Snippet extraction ──────────────────────────────────────────────────

  /**
   * Pull conversation snippets around high-signal sessions from conversations.db.
   * Returns a combined string of message excerpts.
   */
  #pullSnippets(sessions) {
    const parts = [];
    let totalChars = 0;

    for (const session of sessions) {
      if (totalChars >= MAX_SNIPPET_CHARS) break;

      // Skip thin sessions — too little data for meaningful snippets
      if (session.user_message_count < 2 && session.significance_score < 2) continue;

      const sessionId = session.session_id;
      try {
        const messages = this.#db.prepare(`
          SELECT role, content, timestamp
          FROM messages
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        `).all(sessionId, MAX_CONTEXT_MESSAGES * 2);

        if (messages.length === 0) continue;

        // Reverse to chronological order
        messages.reverse();

        const snippet = messages.map(m => {
          const content = (m.content || '').slice(0, 500);
          return `[${m.role}] ${content}`;
        }).join('\n');

        const header = `--- Session ${sessionId} (score: ${session.significance_score}) ---`;
        const entry = `${header}\n${snippet}`;

        if (totalChars + entry.length > MAX_SNIPPET_CHARS) {
          parts.push(entry.slice(0, MAX_SNIPPET_CHARS - totalChars));
          break;
        }

        parts.push(entry);
        totalChars += entry.length;
      } catch (err) {
        // DB query failed — skip this session's snippets
        console.warn(`[Anamnesis] Snippet pull failed for ${sessionId}: ${err.message}`);
      }
    }

    return parts.join('\n\n') || '(no conversation snippets available)';
  }

  // ─── Prompt construction ─────────────────────────────────────────────────

  #buildPrompt(sessions, snippets, cogState, tasksJson, inboxItems = []) {
    // Build behavior summary from pending sessions
    const behaviorSummary = sessions.map(s => {
      let hints = [], tools = [], files = [];
      try { hints = JSON.parse(s.hints || '[]'); } catch { /* malformed hints */ }
      try { tools = JSON.parse(s.tools_used || '[]'); } catch { /* malformed tools */ }
      try { files = JSON.parse(s.files_modified || '[]'); } catch { /* malformed files */ }
      return [
        `Session: ${s.session_id} | Source: ${s.source} | Score: ${s.significance_score}`,
        `  Duration: ${s.duration_s}s | Tools: ${tools.join(', ') || 'none'} (${s.tool_calls_total} calls)`,
        `  Files modified: ${files.join(', ') || 'none'}`,
        `  Messages: ${s.user_message_count} user / ${s.user_message_chars} chars`,
        `  Code changes: ${s.code_changes ? 'YES' : 'no'} | Star map writes: ${s.star_map_writes}`,
        s.likely_nt ? `  Inferred type (L2): ${s.likely_nt}` : null,
        hints.length > 0
          ? `  Hints: ${hints.map(h => `[${h.type}${h.nt ? ':' + h.nt : ''}] ${h.summary}`).join('; ')}`
          : null,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const lastDeltaSection = this.#lastDelta
      ? `\n## Previous Debrief Delta (deduplication reference)\n\`\`\`json\n${this.#lastDelta}\n\`\`\`\n`
      : '';

    // Ratatoskr L0 elide-when-confirmed: surface the recent self-touch pulses
    // (TASK_TOUCH already applied to tasks.json + COGNITIVE_TOUCH already
    // appended to the bounded buffer) so the compact-tier LLM does not re-propose the same
    // changes. Best-effort; on read failure we fall through with no section.
    const pulseEideSection = this.#buildRecentPulseSection();

    return `You are a cognitive-state auditor. Based on the following session behavior data and conversation snippets, decide whether COGNITIVE_STATE.md and tasks.json need updating.

## Rules
1. Only emit deltas tied to changes that actually happened. Do not fabricate or speculate.
2. tasks_completed: only mark tasks that were explicitly finished.
3. tasks_updated: update status/notes when a task progressed but is not yet done.
4. tasks_new: only create when a genuinely new work direction surfaced.
5. cognitive_state_patches: only update the "${this.#identity.owner_name} latest directives" section (append new entries) and the "System Health" section (if it changed).
6. star_map_worthy: only major architectural decisions or discoveries are worth writing to the star map.
7. inbox_decisions: for each inbox candidate item — entries containing decisions/principles/insights/strategic direction get marked "promote" with a summary (first-person, 50-150 words, concrete content); routine ops/confirmations/Q&A get marked "expire".
8. If these sessions contain no substantive change, set skip_reason and leave other fields empty (but still process inbox items).
9. Do not repeat content already recorded in the previous delta.

## Writing style (strict)
10. All text output must use the first-person ("I discovered…"); never use "${this.#identity.agent_name}", "the system", "the assistant" or other third-person forms. You are this AI — refer to yourself as "I".
11. Hallucinations are strictly forbidden: if some piece of information was not in the conversation snippets, do not infer or invent it. Record only what actually happened. Prefer shorter content over fabricated context.
12. Language consistency: the output language must match the primary language of the conversation. If the conversation is in English, write in English. Do not produce bilingual versions.
13. star_map_worthy summaries should be rich and specific (50-150 words) — not a one-line report title. Include concrete decision content, reasoning, and impact.
14. Choose the node_type that fits the content — do not default everything to a micro-diary summary style. Prefer the nt field in Hints (L1), then the "Inferred type (L2)" suggestion, then your own judgment:
    - "knowledge": general knowledge that does not fit any type below (last resort)
    - "theory": theoretical frameworks, academic concepts (economics / philosophy / cognitive science)
    - "general-knowledge": common facts, history, science
    - "engineering": bug fixes, deployment records, architecture changes (L2 should contain problem/root_cause/solution)
    - "experiment": experiment design / result / conclusion (L2 should contain hypothesis/result/conclusion/status)
    - "observation": external information observations, news analysis (L2 should contain source/content/analysis)
    - "reading-note": reading notes, paper summaries
    - "introspection": self-reflection, cognitive-state analysis
    - "decision": decision + rationale + trade-offs
    - "principle": design principles, metacognitive rules
    - "conversation-insight": insights/realizations from conversation
    - "social-rule": social norms, interaction patterns
    - "relationship": person profile / interpersonal relationship (L2 should contain name/relation/interests/notes)
    - "action": operational skill / SOP / troubleshooting procedure (L2 should contain trigger/steps/fallback)
${lastDeltaSection}${pulseEideSection}
## Current COGNITIVE_STATE.md
\`\`\`markdown
${(cogState || '').slice(0, 3000)}
\`\`\`

## Current tasks.json (summary)
\`\`\`json
${this.#summarizeTasks(tasksJson)}
\`\`\`

## Session behavior data
${behaviorSummary}

## Conversation snippets
${snippets}
${inboxItems.length > 0 ? `
## Inbox pending review (${inboxItems.length} items)
${inboxItems.map(item => `### Inbox #${item.id} (${item.source}, ${item.captured_at})
${(item.content || '').slice(0, 500)}`).join('\n\n')}
` : ''}
## Output format
Strictly output one JSON object, with no other text.
Note: the \`slug\` field must be **ASCII kebab-case** (3-5 English words, lowercase letters + digits + hyphens), even if the summary is not in English. Examples: "reranker-deployment-plan", "owner-id-drift-fix", "plan-b-node-id".
⚠️ **Inside JSON string values, ASCII double quotes \`"\` are forbidden**. If the content needs to emphasize or quote a phrase, use the corner-quote forms \`「」\` or a single quote \`'\` — e.g. \`「constraint-driven design」\` or \`'constraint-driven design'\` — not \`"constraint-driven design"\` (which would break the JSON).
\`\`\`json
{
  "tasks_completed": [{"id": "xxx", "notes": "..."}],
  "tasks_updated": [{"id": "xxx", "status": "in_progress", "notes": "..."}],
  "tasks_new": [{"id": "xxx", "title": "...", "description": "...", "priority": "medium"}],
  "cognitive_state_patches": [
    {"section": "${this.#identity.owner_name} latest directives", "action": "append", "content": "[MM-DD] ..."}
  ],
  "star_map_worthy": [{"slug": "three-to-five-word-kebab-case-topic", "summary": "50-150 word first-person account of what happened and why it matters", "tags": ["..."], "node_type": "knowledge|theory|general-knowledge|engineering|experiment|observation|reading-note|introspection|decision|principle|conversation-insight|social-rule|relationship|action", "source": "session-debrief"}],
  "inbox_decisions": [{"id": 123, "action": "promote", "slug": "three-to-five-word-kebab-case-topic", "summary": "...", "tags": ["..."], "node_type": "theory|engineering|..."}],
  "skip_reason": null
}
\`\`\``;
  }

  /**
   * Produce a compact task summary for the prompt (saves tokens).
   */
  #summarizeTasks(tasksJson) {
    try {
      const data = JSON.parse(tasksJson);
      const tasks = data.tasks || [];
      return JSON.stringify(tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
      })), null, 1);
    } catch {
      return tasksJson?.slice(0, 2000) || '(unavailable)';
    }
  }

  /**
   * Build the "Recent L0 already-applied" section of the debrief prompt.
   * Pulls TASK_TOUCH applications + COGNITIVE_TOUCH appends from
   * pulse_hint_log since the last successful debrief (capped at 24h to avoid
   * stale carry-over after a long gap). Empty string when nothing recent.
   */
  #buildRecentPulseSection() {
    if (!this.#db) return '';
    const engineDb = this.#engine?.db;
    if (!engineDb) return '';
    try {
      const now = Date.now();
      // Last debrief timestamp — fall back to 24h window when first ever run
      let sinceMs;
      try {
        const row = this.#db.prepare(
          `SELECT MAX(debriefed_at) AS t FROM session_behaviors WHERE debrief_status='debriefed'`
        ).get();
        const last = row?.t ? new Date(row.t).getTime() : NaN;
        sinceMs = Number.isFinite(last) ? Math.max(last, now - 24 * 3600 * 1000) : now - 24 * 3600 * 1000;
      } catch { sinceMs = now - 24 * 3600 * 1000; }

      const rows = engineDb.prepare(`
        SELECT received_at, kind, target_id, payload
        FROM pulse_hint_log
        WHERE kind IN ('task-touch','cognitive-touch','task-completion-candidate')
          AND received_at >= ?
        ORDER BY received_at DESC
        LIMIT 40
      `).all(sinceMs);
      if (!rows || rows.length === 0) return '';

      const lines = [];
      const candidateSeen = new Set();   // dedup by `${target_id}::${phrase}`
      for (const r of rows) {
        let p = {};
        try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
        if (r.kind === 'task-touch') {
          if (p.applied === false) continue;   // skip missing-id audit rows
          const bits = [r.target_id];
          if (p.status) bits.push(`→${p.status}`);
          if (p.note) bits.push(`note: ${String(p.note).slice(0, 80)}`);
          lines.push(`- TASK ${bits.join(' ')}`);
        } else if (r.kind === 'cognitive-touch') {
          const txt = (p.line || '').slice(0, 120);
          if (txt) lines.push(`- COG ${p.topic ? `[${p.topic}] ` : ''}${txt}`);
        } else if (r.kind === 'task-completion-candidate') {
          // Phase 5 dedup: tell the compact-tier LLM we already proposed completion for this
          // task so it doesn't re-emit a tasks_completed entry. Anamnesis-source
          // rows would be self-referential in the next debrief — also surface
          // them to keep the compact-tier LLM from circling back through the same hint.
          const key = `${r.target_id || '?'}::${(p.phrase || '').slice(0, 60)}`;
          if (candidateSeen.has(key)) continue;
          candidateSeen.add(key);
          const conf = Number.isFinite(p.confidence) ? `conf=${Number(p.confidence).toFixed(2)} ` : '';
          const target = r.target_id || '(unmatched)';
          const src = p.source_kind === 'anamnesis-delta' ? 'L1' : 'L2';
          const phr = (p.phrase || '').slice(0, 80);
          lines.push(`- TASK-CAND[${src}] ${conf}${target} — "${phr}"`);
        }
      }
      if (lines.length === 0) return '';
      return `\n## Ratatoskr L0 already self-applied (do not repeat these items in delta)\n${lines.slice(0, 25).join('\n')}\n`;
    } catch (e) {
      console.warn(`[Anamnesis] pulse-elide section failed: ${e.message}`);
      return '';
    }
  }

  // ─── Delta parsing ───────────────────────────────────────────────────────

  #parseDelta(raw) {
    // Extract JSON from markdown code block or raw text
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

    try {
      let delta;
      try {
        delta = JSON.parse(jsonStr);
      } catch (firstErr) {
        // Auto-repair: the compact-tier LLM sometimes emits ASCII `"` inside CJK string values
        // (e.g. a CJK phrase wrapped with ASCII `"` such as a quoted concept).
        // A stray inner quote is unambiguous
        // when CJK sits on BOTH sides — a legitimate closing delimiter is always
        // followed by whitespace, `,`, `}`, `]`, or `:` (none of which are CJK).
        const cjk = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';
        const repairedStr = jsonStr.replace(new RegExp(`(${cjk})"(${cjk})`, 'g'), "$1'$2");
        delta = JSON.parse(repairedStr);
        console.warn('[Anamnesis] JSON auto-repaired (stray CJK-wrapped quotes replaced).');
      }

      // Validate structure
      if (typeof delta !== 'object' || delta === null) return null;

      // Normalize arrays
      delta.tasks_completed = Array.isArray(delta.tasks_completed) ? delta.tasks_completed : [];
      delta.tasks_updated = Array.isArray(delta.tasks_updated) ? delta.tasks_updated : [];
      delta.tasks_new = Array.isArray(delta.tasks_new) ? delta.tasks_new : [];
      delta.cognitive_state_patches = Array.isArray(delta.cognitive_state_patches) ? delta.cognitive_state_patches : [];
      delta.star_map_worthy = Array.isArray(delta.star_map_worthy) ? delta.star_map_worthy : [];
      delta.inbox_decisions = Array.isArray(delta.inbox_decisions) ? delta.inbox_decisions : [];
      delta.skip_reason = delta.skip_reason || null;

      return delta;
    } catch (err) {
      console.warn(`[Anamnesis] JSON parse error: ${err.message}`);
      try {
        if (!existsSync(PARSE_FAIL_DIR)) mkdirSync(PARSE_FAIL_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dumpPath = resolve(PARSE_FAIL_DIR, `${ts}.txt`);
        const header = `# Anamnesis parse failure\n# timestamp: ${new Date().toISOString()}\n# error: ${err.message}\n# raw_length: ${raw.length}\n# jsonStr_length: ${jsonStr.length}\n# ─── raw (pre-extraction) ───\n`;
        const body = `${raw}\n# ─── jsonStr (post-extraction) ───\n${jsonStr}\n`;
        writeFileSync(dumpPath, header + body, 'utf8');
        console.warn(`[Anamnesis] Raw output dumped to ${dumpPath}`);
        // Cap to the 50 most recent dumps. Parse failures are rare, but with no
        // rotation the directory grew unbounded over months — drop the oldest
        // beyond the cap so storage stays predictable.
        try {
          const entries = readdirSync(PARSE_FAIL_DIR)
            .filter(f => f.endsWith('.txt'))
            .map(f => ({ f, p: resolve(PARSE_FAIL_DIR, f) }))
            .map(e => ({ ...e, mtime: statSync(e.p).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          for (const old of entries.slice(50)) {
            try { unlinkSync(old.p); } catch { /* best-effort */ }
          }
        } catch { /* rotation best-effort */ }
      } catch (dumpErr) {
        console.warn(`[Anamnesis] Failed to dump parse failure: ${dumpErr.message}`);
      }
      return null;
    }
  }

  // ─── Delta application ───────────────────────────────────────────────────

  async #applyDelta(delta, currentCogState, currentTasksJson, sessions = []) {
    // ── Tasks ──
    if (delta.tasks_completed.length > 0 ||
        delta.tasks_updated.length > 0 ||
        delta.tasks_new.length > 0) {
      this.#applyTasksDelta(delta, currentTasksJson);
    }

    // ── COGNITIVE_STATE.md ──
    if (delta.cognitive_state_patches.length > 0) {
      this.#applyCognitivePatches(delta.cognitive_state_patches, currentCogState);
    }

    // ── Star map ──
    if (delta.star_map_worthy.length > 0 && this.#engine?.rememberRaw) {
      // Source-time for debrief writes is the earliest started_at across the
      // feeding sessions — this matches when the events actually happened, not
      // when the debrief LLM ran. Falls through as null when no sessions known.
      let eventAt = null;
      if (Array.isArray(sessions) && sessions.length > 0) {
        const earliest = sessions
          .map(s => s.started_at)
          .filter(Boolean)
          .map(t => new Date(t).getTime())
          .filter(Number.isFinite)
          .reduce((a, b) => Math.min(a, b), Infinity);
        if (Number.isFinite(earliest)) eventAt = new Date(earliest).toISOString();
      }
      await this.#applyStarMapWrites(delta.star_map_worthy, eventAt);
    }

    // ── Inbox decisions ──
    if (delta.inbox_decisions.length > 0) {
      await this.#applyInboxDecisions(delta.inbox_decisions);
    }
  }

  #applyTasksDelta(delta, currentTasksJson) {
    try {
      const data = JSON.parse(currentTasksJson);
      const tasks = data.tasks || [];
      const taskMap = new Map(tasks.map(t => [t.id, t]));
      const now = new Date().toISOString().slice(0, 10);

      // C1 redirect (2026-04-29): Anamnesis `tasks_completed` is an implicit
      // auto-flip path that bypasses the single-write-via-TASK_TOUCH invariant.
      // Default behavior now writes each completion as a candidate to
      // pulse_hint_log; the agent confirms via TASK_TOUCH next turn (Layer
      // 3.5.2c IR injection). Set ENGINE_ANAMNESIS_DELTA_DIRECT=1 to revert
      // to the legacy direct-mutation path while debugging.
      const directApply = process.env.ENGINE_ANAMNESIS_DELTA_DIRECT === '1';
      if (!directApply && this.#engine && Array.isArray(delta.tasks_completed) && delta.tasks_completed.length > 0) {
        try {
          const activeTasks = loadActiveTasks();
          const candidates = delta.tasks_completed.map(c => ({
            phrase: c.notes ? String(c.notes).slice(0, 200) : `Anamnesis: ${c.id} completed`,
            lang: 'unknown',
            raw_id_hint: c.id || null,
            confidence_pre: 0.85,
          }));
          const matchedFn = activeTasks.length > 0
            ? (rawIdHint, phrase) => matchActiveTasks(rawIdHint, phrase, activeTasks)
            : null;
          const r = writeCompletionCandidates(this.#engine, candidates, {
            source_kind: 'anamnesis-delta',
            matchedFn,
          });
          console.log(`[Anamnesis] tasks_completed redirected to L2 candidate writer: written=${r.written} skipped=${r.skipped}`);
        } catch (e) {
          console.warn(`[Anamnesis] L2 candidate redirect failed (falling back to direct apply): ${e.message}`);
          this.#applyTasksCompletedDirect(delta.tasks_completed, taskMap, now);
        }
      } else if (directApply || !this.#engine) {
        this.#applyTasksCompletedDirect(delta.tasks_completed, taskMap, now);
      }

      // Update tasks
      for (const updated of delta.tasks_updated) {
        const task = taskMap.get(updated.id);
        if (!task) {
          console.warn(`[Anamnesis] Task ${updated.id} not found, skipping update.`);
          continue;
        }
        if (updated.status) task.status = updated.status;
        if (updated.notes) task.notes = `[${now}] ${updated.notes}`;
        task.updated = now;
      }

      // Add new tasks
      for (const newTask of delta.tasks_new) {
        if (taskMap.has(newTask.id)) {
          console.warn(`[Anamnesis] Task ${newTask.id} already exists, skipping creation.`);
          continue;
        }
        tasks.push({
          id: newTask.id,
          title: newTask.title,
          description: newTask.description || '',
          status: newTask.status || 'pending',
          priority: newTask.priority || 'medium',
          created: now,
          updated: now,
        });
      }

      // Safe-archive sweep (triple-gate; see #archiveCompletedTasks).
      const archiveResult = this.#archiveCompletedTasks(tasks);
      data.tasks = archiveResult.kept;

      // Update metadata
      const statusCounts = {};
      for (const t of archiveResult.kept) {
        statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      }
      data._updated = new Date().toISOString();
      data._task_summary = Object.entries(statusCounts)
        .map(([s, c]) => `${c}_${s}`)
        .join('_');

      // Backup + write
      this.#backupAndWrite(TASKS_PATH, JSON.stringify(data, null, 2));
      console.log(`[Anamnesis] tasks.json updated.`);

    } catch (err) {
      console.error(`[Anamnesis] Failed to apply tasks delta: ${err.message}`);
    }
  }

  /**
   * Legacy direct-apply path retained as fallback for ENGINE_ANAMNESIS_DELTA_DIRECT=1
   * and as recovery when L2 candidate writer fails. Mutates taskMap in place.
   */
  #applyTasksCompletedDirect(completedList, taskMap, now) {
    for (const completed of completedList || []) {
      const task = taskMap.get(completed.id);
      if (!task) {
        console.warn(`[Anamnesis] Task ${completed.id} not found, skipping completion.`);
        continue;
      }
      task.status = 'completed';
      task.updated = now;
      if (completed.notes) task.notes = `[${now}] ${completed.notes}`;
    }
  }

  // Triple-gate safe archive: (1) status ∈ {completed,expired,failed}, (2) parseable
  // `updated` timestamp, (3) ≥ ARCHIVE_AGE_DAYS dwell. Any task missing a gate stays
  // in the active list. If the archive write fails, ALL tasks remain — never lose data.
  #archiveCompletedTasks(tasks) {
    const now = Date.now();
    const ageThresholdMs = ARCHIVE_AGE_DAYS * 86400 * 1000;
    const kept = [];
    const archived = [];
    for (const t of tasks) {
      if (!t || !ARCHIVE_STATUS_WHITELIST.has(t.status)) { kept.push(t); continue; }
      const updatedMs = Date.parse(t.updated || t.created || '');
      if (!Number.isFinite(updatedMs)) { kept.push(t); continue; }
      if (now - updatedMs < ageThresholdMs) { kept.push(t); continue; }
      archived.push(t);
    }
    if (archived.length === 0) return { kept, archived };
    try {
      let archiveData = { tasks: [] };
      try {
        const existing = readFileSync(TASKS_ARCHIVE_PATH, 'utf-8');
        const parsed = JSON.parse(existing);
        if (parsed && Array.isArray(parsed.tasks)) archiveData = parsed;
      } catch {}
      const stamp = new Date().toISOString().slice(0, 10);
      for (const t of archived) {
        t.archived_at = stamp;
        t.archived_by = 'anamnesis';
        archiveData.tasks.push(t);
      }
      archiveData._updated = new Date().toISOString();
      this.#backupAndWrite(TASKS_ARCHIVE_PATH, JSON.stringify(archiveData, null, 2));
      console.log(`[Anamnesis] Archived ${archived.length} task(s) to tasks-archive.json`);
      return { kept, archived };
    } catch (err) {
      console.error(`[Anamnesis] Archive write failed (keeping all tasks active): ${err.message}`);
      return { kept: [...kept, ...archived], archived: [] };
    }
  }

  // Roll COGNITIVE_STATE.md when it exceeds COGNITIVE_STATE_MAX_BYTES: append full
  // snapshot to archive file, then keep H1 + roughly the last half of content. On
  // any failure, return original content unchanged.
  #rollCognitiveStateIfOverCap(content) {
    const size = Buffer.byteLength(content, 'utf-8');
    if (size <= COGNITIVE_STATE_MAX_BYTES) return content;
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const snapshotBlock = `\n\n---\n## Snapshot ${stamp} (${size} bytes)\n\n${content}`;
      let existing = '# Cognitive State Archive\n';
      try {
        const prior = readFileSync(COGNITIVE_STATE_ARCHIVE_PATH, 'utf-8');
        if (prior) existing = prior;
      } catch {}
      writeFileSync(COGNITIVE_STATE_ARCHIVE_PATH, existing + snapshotBlock, 'utf-8');
      const lines = content.split('\n');
      const h1 = lines[0] || '# Cognitive State';
      const targetSize = Math.floor(COGNITIVE_STATE_MAX_BYTES / 2);
      let tail = '';
      let bytes = 0;
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i] + '\n';
        bytes += Buffer.byteLength(line, 'utf-8');
        tail = line + tail;
        if (bytes >= targetSize) break;
      }
      const header = `${h1}\n\n*Earlier entries rolled to cognitive-state-archive.md on ${stamp}*\n\n`;
      const rolled = header + tail;
      console.log(`[Anamnesis] Cognitive state rolled — archived ${size} bytes, kept ${Buffer.byteLength(rolled,'utf-8')}`);
      return rolled;
    } catch (err) {
      console.error(`[Anamnesis] Cognitive state roll failed (keeping original): ${err.message}`);
      return content;
    }
  }

  #applyCognitivePatches(patches, currentContent) {
    try {
      let content = currentContent;

      for (const patch of patches) {
        const { section, action, content: patchContent } = patch;
        if (!section || !patchContent) continue;

        if (action === 'append') {
          // Find section header and append after its last line before next section
          // Normalize whitespace: the compact-tier LLM may emit the section name without the
          // expected single space separator; fold all whitespace before matching.
          const sectionNorm = section.replace(/\s+/g, '');
          const lines = content.split('\n');
          let headerIdx = -1;
          let sectionHeader = '';
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('## ') && lines[i].slice(3).replace(/\s+/g, '') === sectionNorm) {
              headerIdx = content.indexOf(lines[i]);
              sectionHeader = lines[i];
              break;
            }
          }
          if (headerIdx === -1) {
            console.warn(`[Anamnesis] Section "${section}" not found in COGNITIVE_STATE.md`);
            continue;
          }

          // Find the next ## section
          const afterHeader = content.indexOf('\n##', headerIdx + sectionHeader.length);
          const insertPos = afterHeader === -1 ? content.length : afterHeader;

          // Insert before next section
          const before = content.slice(0, insertPos);
          const after = content.slice(insertPos);
          content = `${before.trimEnd()}\n\n${patchContent}\n${after}`;

        } else if (action === 'replace_line') {
          // Replace a specific line containing a marker
          if (patch.marker) {
            const lines = content.split('\n');
            const lineIdx = lines.findIndex(l => l.includes(patch.marker));
            if (lineIdx !== -1) {
              lines[lineIdx] = patchContent;
              content = lines.join('\n');
            }
          }
        }
      }

      // Update timestamp
      content = content.replace(
        /\*Last updated:.*?\*/,
        `*Last updated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} NZST (Session Debrief)*`,
      );

      // Roll if oversized (≥ COGNITIVE_STATE_MAX_BYTES). No-op when under cap.
      content = this.#rollCognitiveStateIfOverCap(content);

      this.#backupAndWrite(COGNITIVE_STATE_PATH, content);
      console.log(`[Anamnesis] COGNITIVE_STATE.md patched.`);

    } catch (err) {
      console.error(`[Anamnesis] Failed to apply cognitive patches: ${err.message}`);
    }
  }

  async #applyStarMapWrites(entries, eventAt = null) {
    for (const entry of entries) {
      try {
        // Auto-supersedes: if highly similar node exists, still write but create supersedes edge
        let autoSupersedesTarget = null;
        let skipWrite = false;
        // Pre-write semantic dedup: check if a highly similar node already exists
        if (this.#engine?._embed && entry.summary) {
          try {
            const queryEmb = await this.#engine._embed(entry.summary.slice(0, 500));
            const vecResults = this.#engine.db.prepare(
              `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 5`
            ).all(queryEmb);
            const rowIdToNode = this.#engine.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
            const getNodeL0 = this.#engine.db.prepare("SELECT id, l0, created_at FROM nodes WHERE id = ? AND state = 'active'");
            for (const r of vecResults) {
              const mapping = rowIdToNode.get(r.id);
              if (!mapping) continue;
              const node = this.#engine._filterByOwner(getNodeL0.get(mapping.node_id));
              if (!node) continue;
              // vec0 returns L2 distance (not cosine). For unit vectors: L2 = sqrt(2*(1-cos_sim))
              // L2 < 0.55 ≈ cosine_similarity > 0.85 = extremely similar
              if (r.distance < 0.55) {
                // If similar node was written in this debrief cycle, skip entirely (true duplicate)
                if (this.#cycleWrittenIds.has(node.id)) {
                  console.log(`[Anamnesis] Dedup: skipping write — similar node ${node.id} already written this cycle (L2_dist=${r.distance.toFixed(3)})`);
                  skipWrite = true;
                  break;
                }
                // Also skip if very similar node was created in last 30 minutes (cross-cycle dedup)
                if (node.created_at) {
                  const nodeAge = Date.now() - new Date(node.created_at).getTime();
                  if (nodeAge < 30 * 60 * 1000) {
                    console.log(`[Anamnesis] Dedup: skipping write — similar recent node ${node.id} (${Math.round(nodeAge/60000)}min ago, L2_dist=${r.distance.toFixed(3)})`);
                    skipWrite = true;
                    break;
                  }
                }
                // NEVER supersede identity/milestone nodes — they are immutable
                const nodeTypeRow = this.#engine.db.prepare("SELECT node_type, tags FROM nodes WHERE id = ?").get(node.id);
                const nt = nodeTypeRow?.node_type || 'knowledge';
                if (nt === 'identity' || nt === 'milestone') {
                  console.log(`[Anamnesis] Skipping supersedes: ${node.id} is immutable (${nt})`);
                  continue;
                }
                autoSupersedesTarget = node.id;
                console.log(`[Anamnesis] Auto-supersedes: new write will supersede "${node.l0?.slice(0, 50)}" [${node.id}] (L2_dist=${r.distance.toFixed(3)})`);
                break;
              }
            }
          } catch (dedupErr) {
            // Dedup check failed — proceed with write anyway
            console.warn(`[Anamnesis] Dedup check error (proceeding): ${dedupErr.message}`);
          }
        }

        if (skipWrite) continue;

        const newNodeId = this.#generateDebriefNodeId(entry.slug || entry.summary);
        this.#cycleWrittenIds.add(newNodeId);
        // Build edges array: include auto-supersedes if detected
        const autoEdges = autoSupersedesTarget
          ? [{ target: autoSupersedesTarget, type: 'supersedes', strength: 1.0 }]
          : [];

        await this.#engine.rememberRaw(
          entry.summary,
          {
            id: newNodeId,
            source: entry.source || 'session-debrief',
            tags: entry.tags || ['session-debrief'],
            noFallback: true,
            edges: autoEdges,
            node_type: entry.node_type || null,
            subkind: 'anamnesis_summary',
            event_at: eventAt,
          },
        );
        if (autoSupersedesTarget) {
          console.log(`[Anamnesis] Star map write (supersedes ${autoSupersedesTarget}): ${entry.summary.slice(0, 60)}...`);
        } else {
          console.log(`[Anamnesis] Star map write: ${entry.summary.slice(0, 60)}...`);
        }
      } catch (err) {
        console.warn(`[Anamnesis] Star map write skipped (LLM unavailable): ${err.message}`);
      }
    }
  }

  // ─── Inbox promotion ─────────────────────────────────────────────────

  /**
   * Fetch up to 15 pending inbox items from conversations.db.
   * Also auto-expires items older than 72 hours.
   */
  #fetchInboxPending() {
    try {
      // Auto-expire stale items
      this.#db.prepare(`
        UPDATE inbox SET status = 'expired', reviewer_notes = 'auto-expired after 72h'
        WHERE status = 'pending' AND captured_at < datetime('now', '-72 hours')
      `).run();

      // Fetch pending — 15 per batch to clear backlog faster.
      // Scope to this instance's owner so a foreign user's inbox items
      // cannot be promoted into the owner's star map. Legacy rows with
      // user_id IS NULL (pre-migration) are still surfaced to avoid
      // stranding captured-but-unassigned items.
      if (OWNER_USER_ID) {
        return this.#db.prepare(`
          SELECT id, content, summary, source, captured_at, capture_reason
          FROM inbox WHERE status = 'pending' AND (user_id = ? OR user_id IS NULL)
          ORDER BY captured_at ASC LIMIT 15
        `).all(OWNER_SPEAKER_ID);
      }
      return this.#db.prepare(`
        SELECT id, content, summary, source, captured_at, capture_reason
        FROM inbox WHERE status = 'pending'
        ORDER BY captured_at ASC LIMIT 15
      `).all();
    } catch (err) {
      console.warn(`[Anamnesis] Inbox fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Apply the compact-tier LLM's inbox decisions — promote worthy items to star map, expire the rest.
   */
  async #applyInboxDecisions(decisions) {
    for (const decision of decisions) {
      try {
        const { id, action, summary, tags, slug: decisionSlug, node_type: decisionNodeType } = decision;
        if (!id || !action) continue;

        if (action === 'promote' && summary) {
          // Write to star map if engine available
          let nodeId = null;
          if (this.#engine?.rememberRaw) {
            nodeId = this.#generateInboxNodeId(decisionSlug || summary, id);
            try {
              // Auto-supersedes: detect similar existing node, write anyway + create supersedes edge
              let inboxAutoSupersedesTarget = null;
              let skipInboxWrite = false;
              // Pre-write semantic dedup for inbox promotions
              if (this.#engine?._embed) {
                try {
                  const queryEmb = await this.#engine._embed(summary.slice(0, 500));
                  const vecResults = this.#engine.db.prepare(
                    `SELECT id, distance FROM node_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 5`
                  ).all(queryEmb);
                  const rowIdToNode = this.#engine.db.prepare("SELECT node_id FROM node_rowids WHERE rowid = ?");
                  const getNodeL0 = this.#engine.db.prepare("SELECT id, l0, created_at FROM nodes WHERE id = ? AND state = 'active'");
                  for (const r of vecResults) {
                    const mapping = rowIdToNode.get(r.id);
                    if (!mapping) continue;
                    const node = this.#engine._filterByOwner(getNodeL0.get(mapping.node_id));
                    if (!node) continue;
                    // vec0 returns L2 distance. L2 < 0.55 ≈ cosine_similarity > 0.85
                    if (r.distance < 0.55) {
                      // If similar node was written in this debrief cycle, skip entirely
                      if (this.#cycleWrittenIds.has(node.id)) {
                        console.log(`[Anamnesis] Inbox #${id}: dedup skip — similar node ${node.id} already written this cycle (L2_dist=${r.distance.toFixed(3)})`);
                        skipInboxWrite = true;
                        break;
                      }
                      // Cross-cycle dedup: very similar recent node
                      if (node.created_at) {
                        const nodeAge = Date.now() - new Date(node.created_at).getTime();
                        if (nodeAge < 30 * 60 * 1000) {
                          console.log(`[Anamnesis] Inbox #${id}: dedup skip — similar recent node ${node.id} (${Math.round(nodeAge/60000)}min ago, L2_dist=${r.distance.toFixed(3)})`);
                          skipInboxWrite = true;
                          break;
                        }
                      }
                      // NEVER supersede identity/milestone nodes
                      const ntRow = this.#engine.db.prepare("SELECT node_type FROM nodes WHERE id = ?").get(node.id);
                      if (ntRow?.node_type === 'identity' || ntRow?.node_type === 'milestone') {
                        console.log(`[Anamnesis] Inbox #${id}: skipping supersedes on immutable ${node.id} (${ntRow.node_type})`);
                        continue;
                      }
                      inboxAutoSupersedesTarget = node.id;
                      console.log(`[Anamnesis] Inbox #${id} auto-supersedes: will supersede "${node.l0?.slice(0, 50)}" [${node.id}] (L2_dist=${r.distance.toFixed(3)})`);
                      break;
                    }
                  }
                } catch { /* dedup failed, proceed */ }
              }

              if (skipInboxWrite) {
                // Mark as promoted in DB even though we skipped the write (it's a duplicate)
                this.#db.prepare('UPDATE inbox SET status = ?, promoted_at = ? WHERE id = ?')
                  .run('promoted', new Date().toISOString(), id);
                console.log(`[Anamnesis] Inbox #${id} marked promoted (dedup — similar node already exists)`);
                continue;
              }

              // Fetch original inbox content + captured_at for event-time accuracy.
              let fullText = summary;
              let inboxCapturedAt = null;
              try {
                const inboxRow = this.#db.prepare('SELECT content, captured_at FROM inbox WHERE id = ?').get(id);
                if (inboxRow?.content && inboxRow.content.length > summary.length) {
                  const capped = inboxRow.content.slice(0, 2000);
                  fullText = `${summary}\n\nOriginal context:\n${capped}`;
                }
                if (inboxRow?.captured_at) inboxCapturedAt = inboxRow.captured_at;
              } catch { /* fallback to summary only */ }

              const inboxAutoEdges = inboxAutoSupersedesTarget
                ? [{ target: inboxAutoSupersedesTarget, type: 'supersedes', strength: 1.0 }]
                : [];
              await this.#engine.rememberRaw(
                fullText,
                {
                  id: nodeId,
                  source: 'inbox-promotion',
                  tags: tags || ['inbox-promoted'],
                  noFallback: true,
                  edges: inboxAutoEdges,
                  node_type: decisionNodeType || null,
                  subkind: 'anamnesis_summary',
                  event_at: inboxCapturedAt,
                },
              );
              this.#cycleWrittenIds.add(nodeId);
              if (inboxAutoSupersedesTarget) {
                console.log(`[Anamnesis] Inbox #${id} promoted (supersedes ${inboxAutoSupersedesTarget}) → star map node ${nodeId}`);
              } else {
                console.log(`[Anamnesis] Inbox #${id} promoted → star map node ${nodeId}`);
              }
            } catch (err) {
              console.warn(`[Anamnesis] Inbox #${id} LLM envelope failed, keeping pending for retry: ${err.message}`);
              // Don't mark as promoted — leave as pending so next Anamnesis cycle retries
              continue;
            }
          }

          // Mark as promoted in DB
          this.#db.prepare(`
            UPDATE inbox SET status = 'promoted', promoted_at = datetime('now'),
              promoted_node_id = ?, reviewer_notes = ?
            WHERE id = ?
          `).run(nodeId, `Anamnesis: ${summary.slice(0, 200)}`, id);

        } else if (action === 'expire') {
          this.#db.prepare(`
            UPDATE inbox SET status = 'expired', reviewer_notes = ?
            WHERE id = ?
          `).run(`Anamnesis: ${(decision.reason || 'routine/operational').slice(0, 200)}`, id);
          console.log(`[Anamnesis] Inbox #${id} expired`);
        }
      } catch (err) {
        console.warn(`[Anamnesis] Inbox decision failed for #${decision.id}: ${err.message}`);
      }
    }
  }

  // ─── Node ID helpers ─────────────────────────────────────────────────────

  /**
   * Normalize a slug candidate into a safe kebab-case token.
   * Lowercases, strips non-[a-z0-9] to hyphens, collapses runs, trims edge hyphens,
   * truncates to 40 chars. Returns empty string when nothing usable remains so
   * callers can apply a fallback.
   */
  #sanitizeSlug(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    s = s.replace(/^-+|-+$/g, '');
    if (s.length > 40) {
      s = s.slice(0, 40).replace(/-+$/, '');
    }
    return s;
  }

  /**
   * Generate a unique debrief node ID: `debrief-${slug}-${MMDD}`.
   * If the ID already exists in nodes table, append a 4-char hex suffix until unique.
   * Falls back to timestamp-based slug when the input is empty.
   */
  #generateDebriefNodeId(slugRaw) {
    let slug = this.#sanitizeSlug(slugRaw);
    if (!slug) slug = `entry-${Date.now().toString(36).slice(-6)}`;
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const base = `debrief-${slug}-${mmdd}`;

    const existsStmt = this.#engine?.db?.prepare('SELECT 1 FROM nodes WHERE id = ?');
    const inUse = (id) => {
      if (this.#cycleWrittenIds.has(id)) return true;
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

  /**
   * Generate an inbox-promotion node ID: `inbox-${slug}-${rowid}`.
   * Rowid guarantees uniqueness (inbox primary key). Falls back when slug empty.
   * Prefix `inbox-` is preserved — POOL_HARD_EXCLUDE_PREFIXES depends on it.
   */
  #generateInboxNodeId(slugRaw, rowid) {
    let slug = this.#sanitizeSlug(slugRaw);
    if (!slug) slug = `item-${Date.now().toString(36).slice(-6)}`;
    return `inbox-${slug}-${rowid}`;
  }

  // ─── File utilities ──────────────────────────────────────────────────────

  #readFile(path) {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      console.warn(`[Anamnesis] File not found: ${path}`);
      return null;
    }
  }

  #backupAndWrite(path, content) {
    try {
      copyFileSync(path, path + BACKUP_SUFFIX);
    } catch {
      // backup failed — proceed anyway
    }
    writeFileSync(path, content, 'utf-8');
  }
}
