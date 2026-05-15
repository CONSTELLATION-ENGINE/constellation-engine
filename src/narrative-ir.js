// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module narrative-ir
 * @description Type-aware node rendering for the IR compilation pipeline.
 *
 * Provides _renderNode(node, precision) — the core function that converts a
 * star-map node row into context-optimized text based on node_type × precision.
 *
 * Precision levels:
 *   - 'minimal'  → L0 one-liner only (activation < 0.3)
 *   - 'medium'   → type-specific compact template (0.3–0.7)
 *   - 'full'     → complete body rendering (> 0.7 or identity/milestone)
 *
 * Legacy fallback: nodes without a JSON `format` field in L2 render as L0/L1.
 */

// ─── Precision Selection ────────────────────────────────────────────────────

const ALWAYS_FULL_TYPES = new Set(['identity', 'milestone']);

/**
 * Determine rendering precision from activation value and node type.
 * @param {number} activation - SA activation value (0–1)
 * @param {string} nodeType - node_type field
 * @returns {'minimal'|'medium'|'full'}
 */
export function selectPrecision(activation, nodeType) {
  if (ALWAYS_FULL_TYPES.has(nodeType)) return 'full';
  if (activation > 0.7) return 'full';
  if (activation >= 0.3) return 'medium';
  return 'minimal';
}

// ─── Body Parsing ───────────────────────────────────────────────────────────

/**
 * Try to parse L2 as JSON body. Returns null if legacy plain text.
 * @param {string} l2 - Raw L2 content
 * @returns {Object|null}
 */
function parseBody(l2) {
  if (!l2 || typeof l2 !== 'string') return null;
  const trimmed = l2.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && obj.format) return obj;
    return null;
  } catch {
    return null;
  }
}

// ─── Medium Precision Templates ─────────────────────────────────────────────

const MEDIUM_TEMPLATES = {
  engineering(b) {
    const status = b.status ? ` [${b.status.toUpperCase()}]` : '';
    return `🔧 ${b.problem || '?'} → ${b.root_cause || '?'} → ${b.solution || '?'}${status}`;
  },
  experiment(b) {
    const status = b.status ? `[${b.status.toUpperCase()}] ` : '';
    const conf = b.metrics?.accuracy ? ` (${b.metrics.accuracy})` : '';
    return `${status}${b.hypothesis || '?'} → ${b.conclusion || '?'}${conf}`;
  },
  declarative(b) {
    return b.summary || b.detail?.slice(0, 120) || '?';
  },
  observation(b) {
    const src = b.source || '?';
    const date = b.observed_at || '';
    const shelf = b.shelf_life ? ` (shelf: ${b.shelf_life})` : '';
    return `[${src} ${date}] ${b.content || '?'}${shelf}`;
  },
  relationship(b) {
    const trust = b.trust_level != null ? ` | trust: ${b.trust_level}` : '';
    const style = b.communication_style ? ` | style: ${b.communication_style}` : '';
    return `👤 ${b.name || '?'} | ${b.relation || '?'}${trust}${style}`;
  },
  interaction(b) {
    const date = b.timestamp ? b.timestamp.slice(0, 10) : '?';
    const summary = b.content ? b.content.slice(0, 100) : b.context || '?';
    return `  └─ [${date}] ${summary}`;
  },
  principle(b) {
    return `⚖️ ${b.rule || '?'}: ${b.rationale || ''}`;
  },
  decision(b) {
    const date = b.context ? ` [${b.context.slice(0, 30)}]` : '';
    return `📌 ${b.choice || '?'} because ${b.rationale || '?'}${date}`;
  },
  introspection(b) {
    const trigger = b.trigger ? ` (triggered by: ${b.trigger})` : '';
    return `🪞 ${b.observation || b.analysis || '?'}${trigger}`;
  },
  diary(b) {
    const date = b.date || '?';
    const mood = b.mood ? ` ${b.mood}` : '';
    const topics = Array.isArray(b.sections)
      ? b.sections.map(s => s.topic).join(', ')
      : '';
    return `[${date}]${mood} ${topics || b.key_events?.join(', ') || '?'}`;
  },
  'conversation-insight'(b) {
    const ctx = b.conversation_context ? ` (from: ${b.conversation_context})` : '';
    return `💡 ${b.insight || '?'}${ctx}`;
  },
  action(b) {
    const status = b.status ? ` [${b.status.toUpperCase()}]` : '';
    return `▶ ${b.action || b.description || '?'} → ${b.outcome || '?'}${status}`;
  },
};

// ─── Full Precision Rendering ───────────────────────────────────────────────

function renderFull(l0, body) {
  if (!body) return l0; // legacy fallback
  const lines = [l0];
  const skip = new Set(['format']);
  for (const [k, v] of Object.entries(body)) {
    if (skip.has(k)) continue;
    if (v == null || v === '') continue;
    if (typeof v === 'string') {
      lines.push(`  ${k}: ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === 'object') {
      lines.push(`  ${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`  ${k}: ${v}`);
    }
  }
  return lines.join('\n');
}

// ─── Main Render Function ───────────────────────────────────────────────────

/**
 * Render a node at the given precision level.
 *
 * @param {Object} node - DB row with at minimum { id, l0, l1, l2, node_type }
 * @param {'minimal'|'medium'|'full'} precision
 * @returns {string} Rendered text for IR injection
 */
export function renderNode(node, precision) {
  const { l0, l1, l2, node_type } = node;

  // ── Minimal: L0 only, always ──
  if (precision === 'minimal') {
    return l0 || node.id;
  }

  // ── Parse body (JSON in L2) ──
  const body = parseBody(l2);

  // ── Legacy fallback: no JSON body → old L0/L1 rendering ──
  if (!body) {
    if (precision === 'full') {
      // Full legacy: L0 + L1 (+ L2 if short enough)
      const parts = [l0];
      if (l1 && l1 !== l0) parts.push(l1);
      if (l2 && l2 !== l1 && l2.length < 500) parts.push(l2);
      return parts.join('\n');
    }
    // Medium legacy: L0 + L1
    const parts = [l0];
    if (l1 && l1 !== l0) parts.push(l1.slice(0, 200));
    return parts.join('\n');
  }

  // ── Full precision with JSON body ──
  if (precision === 'full') {
    return renderFull(l0, body);
  }

  // ── Medium precision: type-specific template ──
  const templateFn = MEDIUM_TEMPLATES[body.format];
  if (templateFn) {
    return templateFn(body);
  }

  // Unknown format → fallback to summary or L0
  return body.summary || body.content || l0 || node.id;
}

