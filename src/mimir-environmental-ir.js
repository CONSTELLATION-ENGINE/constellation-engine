// SPDX-License-Identifier: AGPL-3.0-or-later
// Mímir Environmental IR Compiler — Wave 1 Phase 2 (v2 plan §2.3).
//
// Compiles 5 layers of "what's happening right now" material into a single
// rendered text block suitable for free-mode prompt injection. Each layer is
// fault-tolerant: failure in one layer never blocks the others.
//
// Layers (per plan §2.3):
//   L1 — Fresh-node feed: recent self_act / external_fetch / diary nodes,
//        weighted by 1/(age_days+1). No hard time window.
//   L2 — Topology mood: active zones / coactivation / cold-zones, fetched
//        from mimir daemon /status endpoint.
//   L3 — Conversation context: most-recent-N session topics + open threads.
//   L4 — Identity baseline: soul-core / identity-tagged L0 anchor.
//   L5 — Anti-amnesia: self_act nodes written in last 24h (in-scope subkinds).
//
// Output: { layers: { l1, l2, l3, l4, l5 }, text: string, ts: epoch_ms }.
// Caller embeds `text` into the free-mode prompt; structured `layers` is
// available for debug / dashboard display.

const DEFAULT_MIMIR_URL = process.env.MIMIR_URL || 'http://127.0.0.1:18810';

// Layer-1 sizing
const L1_DEFAULT_LIMIT = 12;
const L1_MAX_AGE_DAYS  = 14; // beyond this, weight ~0 — skip query overhead
// Layer-3 sizing
const L3_DEFAULT_DAYS  = 7;
const L3_DEFAULT_LIMIT = 8;
// Layer-5 sizing — anti-amnesia window
const L5_WINDOW_HOURS  = 24;
const L5_DEFAULT_LIMIT = 10;
// In-scope subkinds for L5 (matches resolver scope plus user-facing actions)
const L5_SUBKINDS = new Set([
  'outreach', 'diary', 'external_fetch_summary', 'curiosity_probe',
  'share', 'question', 'observation',
]);

export class MimirEnvironmentalIR {
  #engine;
  #conversationsDb;
  #mimirUrl;

  constructor({ engine, conversationsDb, mimirUrl } = {}) {
    if (!engine || !engine.db) throw new Error('MimirEnvironmentalIR: engine.db required');
    this.#engine = engine;
    this.#conversationsDb = conversationsDb || null;
    this.#mimirUrl = (mimirUrl || DEFAULT_MIMIR_URL).replace(/\/$/, '');
  }

  // Entry point: compile all five layers + render to text.
  async compile({ ownerId = 'self', l1Limit = L1_DEFAULT_LIMIT,
                  l3Days = L3_DEFAULT_DAYS, l3Limit = L3_DEFAULT_LIMIT,
                  l5Limit = L5_DEFAULT_LIMIT } = {}) {
    const ts = Date.now();
    const [l1, l2, l3, l4, l5] = await Promise.all([
      this.#safe(() => this.#compileL1(ownerId, l1Limit), 'l1'),
      this.#safe(() => this.#compileL2(), 'l2'),
      this.#safe(() => this.#compileL3(l3Days, l3Limit), 'l3'),
      this.#safe(() => this.#compileL4(ownerId), 'l4'),
      this.#safe(() => this.#compileL5(ownerId, l5Limit), 'l5'),
    ]);
    const layers = { l1, l2, l3, l4, l5 };
    const text = this.#render(layers);
    return { layers, text, ts };
  }

  async #safe(fn, label) {
    try {
      const v = await fn();
      return v ?? { ok: true, items: [] };
    } catch (e) {
      return { ok: false, error: String(e.message || e), label };
    }
  }

  // ── L1: Fresh-node feed ──────────────────────────────────────────────────
  // Strategy: recent self_act + external_fetch_summary + diary, weighted by
  // 1/(age_days+1). No hard window — let weight do the truncation.
  #compileL1(ownerId, limit) {
    const cutoffMs = Date.now() - L1_MAX_AGE_DAYS * 86400_000;
    const rows = this.#engine.db.prepare(`
      SELECT id, l0, l1, node_type, subkind, event_at, created_at, weight
      FROM nodes
      WHERE state = 'active'
        AND (
          node_type = 'self_act'
          OR subkind IN ('external_fetch_summary', 'anamnesis_summary')
        )
        AND COALESCE(event_at, created_at) >= datetime(?, 'unixepoch', 'subsec')
        AND ${this.#ownerClause(ownerId)}
      ORDER BY COALESCE(event_at, created_at) DESC
      LIMIT ?
    `).all(cutoffMs / 1000, limit * 3);

    const now = Date.now();
    const items = rows.map(r => {
      const tsMs = this.#parseTs(r.event_at) || this.#parseTs(r.created_at) || now;
      const ageDays = Math.max(0, (now - tsMs) / 86400_000);
      const freshness = 1 / (ageDays + 1);
      return {
        id: r.id, l0: r.l0, l1: r.l1,
        subkind: r.subkind, node_type: r.node_type,
        ageDays: Number(ageDays.toFixed(2)),
        freshness: Number(freshness.toFixed(3)),
      };
    });
    items.sort((a, b) => b.freshness - a.freshness);
    return { ok: true, items: items.slice(0, limit) };
  }

  // ── L2: Topology mood ────────────────────────────────────────────────────
  // Pulled from mimir daemon /status — already runs the spreading-activation
  // tick + tracks zones. Best-effort: timeout 1500ms, returns empty on fail.
  async #compileL2() {
    const url = `${this.#mimirUrl}/status`;
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), 1500);
    try {
      const resp = await fetch(url, { signal: ctl.signal });
      if (!resp.ok) return { ok: false, error: `status_http_${resp.status}` };
      const j = await resp.json();
      return {
        ok: true,
        p_global: j.P_global ?? j.p_global ?? null,
        active_zones: Array.isArray(j.active_zones) ? j.active_zones.slice(0, 8) : [],
        coactivations: Array.isArray(j.cross_zone_coact) ? j.cross_zone_coact.slice(0, 5) : [],
        cold_zones:    Array.isArray(j.cold_zones) ? j.cold_zones.slice(0, 5) : [],
      };
    } finally {
      clearTimeout(tid);
    }
  }

  // ── L3: Conversation context ─────────────────────────────────────────────
  // Recent conversation sessions. session_behaviors has one row per turn,
  // debriefed by anamnesis cron. We aggregate by session_id and sample
  // hints (Layer-2 debrief tags) as topic-like signals — schema has no
  // 'topics' column, so hints + significance is the best proxy.
  #compileL3(days, limit) {
    if (!this.#conversationsDb) return { ok: true, items: [], note: 'conversationsDb unavailable' };
    const cutoffIso = new Date(Date.now() - days * 86400_000).toISOString();
    let items = [];
    try {
      const rows = this.#conversationsDb.prepare(`
        SELECT session_id,
               MIN(started_at) as first_ts,
               MAX(started_at) as last_ts,
               COUNT(*) as turns,
               SUM(COALESCE(duration_s, 0)) as total_duration_s,
               MAX(COALESCE(significance_score, 0)) as max_sig,
               GROUP_CONCAT(hints, '|') as hints_csv
        FROM session_behaviors
        WHERE started_at >= ?
        GROUP BY session_id
        ORDER BY last_ts DESC
        LIMIT ?
      `).all(cutoffIso, limit);
      items = rows.map(r => ({
        session_id: r.session_id,
        first_ts: r.first_ts,
        last_ts: r.last_ts,
        turns: r.turns,
        duration_min: r.total_duration_s ? Math.round(r.total_duration_s / 60) : 0,
        significance: Number((r.max_sig || 0).toFixed(2)),
        topics: this.#extractHintTokens(r.hints_csv).slice(0, 6),
      }));
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: true, items };
  }

  // ── L4: Identity baseline ────────────────────────────────────────────────
  // Pulls a single L0 anchor from identity-tagged nodes (soul-core).
  #compileL4(ownerId) {
    const rows = this.#engine.db.prepare(`
      SELECT id, l0, l1, weight
      FROM nodes
      WHERE state = 'active'
        AND node_type = 'identity'
        AND ${this.#ownerClause(ownerId)}
      ORDER BY weight DESC, accessed_at DESC
      LIMIT 5
    `).all();
    return {
      ok: true,
      items: rows.map(r => ({ id: r.id, l0: r.l0, l1: r.l1, weight: r.weight })),
    };
  }

  // ── L5: Anti-amnesia (recent self_act in scope) ──────────────────────────
  #compileL5(ownerId, limit) {
    const cutoffMs = Date.now() - L5_WINDOW_HOURS * 3600_000;
    const subkindList = [...L5_SUBKINDS].map(s => `'${s}'`).join(',');
    const rows = this.#engine.db.prepare(`
      SELECT id, l0, l1, subkind, node_type, event_at, created_at
      FROM nodes
      WHERE state = 'active'
        AND node_type = 'self_act'
        AND subkind IN (${subkindList})
        AND COALESCE(event_at, created_at) >= datetime(?, 'unixepoch', 'subsec')
        AND ${this.#ownerClause(ownerId)}
      ORDER BY COALESCE(event_at, created_at) DESC
      LIMIT ?
    `).all(cutoffMs / 1000, limit);
    const now = Date.now();
    const items = rows.map(r => {
      const tsMs = this.#parseTs(r.event_at) || this.#parseTs(r.created_at) || now;
      return {
        id: r.id, l0: r.l0, l1: r.l1, subkind: r.subkind,
        ageHours: Number(((now - tsMs) / 3600_000).toFixed(1)),
      };
    });
    return { ok: true, items, windowHours: L5_WINDOW_HOURS };
  }

  // ── Render to text block ─────────────────────────────────────────────────
  #render(layers) {
    const parts = [];

    // L4 first — identity is the frame.
    if (layers.l4?.ok && layers.l4.items?.length) {
      parts.push('=== IDENTITY BASELINE ===');
      for (const it of layers.l4.items) {
        parts.push(`• ${this.#trim(it.l0, 120)}`);
      }
      parts.push('');
    }

    // L2 mood
    if (layers.l2?.ok) {
      parts.push('=== CURRENT TOPOLOGY ===');
      const p = layers.l2.p_global;
      if (p != null) parts.push(`pressure: P_global=${Number(p).toFixed(3)}`);
      if (layers.l2.active_zones?.length) {
        parts.push(`active zones: ${layers.l2.active_zones.map(z => z.name || z.id || z).join(', ')}`);
      }
      if (layers.l2.coactivations?.length) {
        parts.push(`cross-zone bursts: ${layers.l2.coactivations.length}`);
      }
      if (layers.l2.cold_zones?.length) {
        parts.push(`cold-zone signals: ${layers.l2.cold_zones.length}`);
      }
      parts.push('');
    }

    // L1 fresh feed
    if (layers.l1?.ok && layers.l1.items?.length) {
      parts.push('=== FRESH MATERIAL (weighted by recency) ===');
      for (const it of layers.l1.items) {
        const tag = it.subkind ? `[${it.subkind}]` : `[${it.node_type || 'node'}]`;
        parts.push(`• ${tag} ${this.#trim(it.l0, 110)} (${it.ageDays}d, w=${it.freshness})`);
      }
      parts.push('');
    }

    // L3 conversation context
    if (layers.l3?.ok && layers.l3.items?.length) {
      parts.push('=== RECENT CONVERSATIONS ===');
      for (const it of layers.l3.items) {
        const topics = (it.topics || []).slice(0, 4).join(' · ');
        const dur = it.duration_min ? `${it.duration_min}min` : '';
        parts.push(`• ${it.turns} turns ${dur} · ${topics || '(no hints)'}`);
      }
      parts.push('');
    }

    // L5 anti-amnesia — last so the LLM reads it just before deciding to act
    if (layers.l5?.ok && layers.l5.items?.length) {
      parts.push(`=== WHAT YOU ALREADY DID (last ${layers.l5.windowHours}h) ===`);
      for (const it of layers.l5.items) {
        parts.push(`• [${it.subkind}] ${this.#trim(it.l0, 110)} (${it.ageHours}h ago)`);
      }
      parts.push('');
    } else if (layers.l5?.ok) {
      parts.push(`=== WHAT YOU ALREADY DID (last ${L5_WINDOW_HOURS}h) ===`);
      parts.push('• (nothing in scope)');
      parts.push('');
    }

    return parts.join('\n').trimEnd();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  #ownerClause(ownerId) {
    // Embed-safe: ownerId is internally-controlled ('self' or similar) but
    // we still parameterise via prepare bind below. Here we return a literal
    // clause that prepares against '?' — but to avoid plumbing two binders
    // per query, we inline-quote the trusted symbol.
    const safe = String(ownerId || 'self').replace(/[^a-zA-Z0-9_:.-]/g, '');
    return `(owner_id = '${safe}' OR owner_id IS NULL)`;
  }

  #parseTs(s) {
    if (!s) return null;
    if (typeof s === 'number') return s > 1e12 ? s : s * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  // hints column stores JSON arrays per turn; GROUP_CONCAT joins with '|'.
  // Parse each as JSON and dedupe the union of string values.
  #extractHintTokens(hintsCsv) {
    if (!hintsCsv) return [];
    const seen = new Set();
    const out = [];
    for (const chunk of hintsCsv.split('|')) {
      const t = chunk.trim();
      if (!t || t === '[]') continue;
      let arr;
      try { arr = JSON.parse(t); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      for (const v of arr) {
        const s = (typeof v === 'string') ? v.trim()
                : (v && typeof v.tag === 'string') ? v.tag.trim()
                : '';
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  #trim(s, n) {
    if (typeof s !== 'string') return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
  }
}
