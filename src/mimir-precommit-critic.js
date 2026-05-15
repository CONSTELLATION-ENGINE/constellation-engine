// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Pre-commit Critic — Wave 3 Phase 7 (v2 plan §4 Layer 4).
//
// Synchronous LLM gate that runs RIGHT BEFORE an outbound action commits
// (outreach Telegram send / external_fetch summary write / curiosity_probe
// node write). Asks a fast worker LLM "is this action well-formed, on-spec,
// and worth taking right now?" — returns ALLOW or BLOCK with reason.
//
// Default ON — kill switch via env MIMIR_PREACTION_CRITIQUE=0. Even when ON,
// fail-open: any LLM/parse failure → ALLOW (we never let critic infra
// hiccups silently suppress legitimate actions).
//
// Scope (per plan §8 Phase 7): outreach, external_fetch, curiosity_probe.
// share/question/observation from Wave 1 v2 free mode are NOT in scope —
// the LLM that picked them already deliberated; double-criticing would be
// noise. Outreach/fetch/probe come from v1 hardcoded triggers (or v2 free
// mode's POST→outreach path) where deliberation was lighter.
//
// API:
//   const critic = new MimirPrecommitCritic({ llm });
//   const verdict = await critic.assess({ kind, text, context });
//   if (verdict.allow === false) skip;

// Default ON: critic is a silent compact-tier gate over outreach/external_fetch/
// curiosity_probe; fail-open on errors. Set MIMIR_PREACTION_CRITIQUE=0 to
// disable globally (kill switch).
const ENABLED = (process.env.MIMIR_PREACTION_CRITIQUE ?? '1') !== '0'
              && (process.env.MIMIR_PREACTION_CRITIQUE ?? '1') !== 'false';
const CRITIC_TIMEOUT_MS = 5000;
// Empty default → router resolves via _role='worker' → roles.worker → compactModel.
const CRITIC_MODEL      = process.env.CONSTELLATION_CRITIC_MODEL || '';
const VALID_KINDS = new Set(['outreach', 'external_fetch', 'curiosity_probe']);

export class MimirPrecommitCritic {
  #llm;

  constructor({ llm } = {}) {
    if (!llm || typeof llm.chat !== 'function') {
      throw new Error('MimirPrecommitCritic: llm.chat required');
    }
    this.#llm = llm;
  }

  isEnabled() { return ENABLED; }

  // Returns { allow: bool, reason: string, latencyMs: number, skipped?: string }.
  // Fail-open: any error → allow:true.
  async assess({ kind, text, context = '' } = {}) {
    const t0 = Date.now();
    if (!ENABLED) {
      return { allow: true, reason: 'critic_disabled', latencyMs: 0, skipped: 'disabled' };
    }
    if (!kind || !VALID_KINDS.has(kind)) {
      return { allow: true, reason: 'kind_out_of_scope', latencyMs: 0, skipped: 'oos' };
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
      return { allow: true, reason: 'empty_text', latencyMs: 0, skipped: 'empty' };
    }

    const prompt = this.#buildPrompt(kind, text, context);
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), CRITIC_TIMEOUT_MS);
    let resp;
    try {
      resp = await this.#llm.chat({
        model: CRITIC_MODEL || undefined,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        signal: ctl.signal,
        _role: 'worker',
        _noFallback: true,
      });
    } catch (e) {
      clearTimeout(tid);
      // Fail-open on any LLM/network/timeout error.
      return {
        allow: true,
        reason: `llm_error:${(e.message || '').slice(0, 80)}`,
        latencyMs: Date.now() - t0,
        skipped: 'llm_error',
      };
    }
    clearTimeout(tid);

    const parsed = this.#parse(resp);
    const latencyMs = Date.now() - t0;
    if (!parsed) {
      // Fail-open on parse failure (matches resolver pattern).
      return { allow: true, reason: 'parse_failure', latencyMs, skipped: 'parse_failure' };
    }
    return {
      allow: parsed.allow !== false, // default allow if field missing
      reason: String(parsed.reason || '').slice(0, 200),
      latencyMs,
    };
  }

  #buildPrompt(kind, text, context) {
    const kindHint = {
      outreach:        'A Telegram message about to be sent to the user.',
      external_fetch:  'An external URL summary about to be written to the star map.',
      curiosity_probe: 'An autonomous probe-node about to be written to the star map.',
    }[kind] || kind;
    return [
      'You are Mímir\'s pre-commit critic. One short message will be committed unless you block it.',
      '',
      `KIND: ${kind} — ${kindHint}`,
      'CANDIDATE:',
      `  ${String(text).slice(0, 400)}`,
      '',
      context ? `CONTEXT:\n  ${String(context).slice(0, 400)}\n` : '',
      'Output ONLY valid JSON:',
      '{"allow":true|false,"reason":"<short, ≤120 chars>"}',
      '',
      'Block (allow=false) ONLY if the candidate is:',
      '- duplicating an action visible in CONTEXT',
      '- malformed (truncated, includes raw IDs/URLs that should have been resolved)',
      '- low-signal filler (e.g. "thinking about things")',
      '- off-policy (e.g. attempting to send PII or reach an out-of-scope domain)',
      'Otherwise allow=true. When in doubt, allow.',
    ].filter(Boolean).join('\n');
  }

  #parse(resp) {
    if (!resp) return null;
    let raw = String(typeof resp === 'string' ? resp : (resp.content || resp.text || '')).trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try { return JSON.parse(m[0]); } catch { return null; }
    }
  }
}
