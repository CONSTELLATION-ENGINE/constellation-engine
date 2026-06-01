/**
 * Anamnesis-style second-pass memory rescue.
 *
 * This is deliberately a rescue layer, not the primary IR path:
 * - cheap deterministic gate first
 * - cheap lexical/entity candidate generation second
 * - LLM only judges bounded candidates when the gate is strong enough
 */

const DEFAULT_STOP = new Set([
  'about', 'after', 'again', 'before', 'could', 'should', 'there', 'their',
  'thing', 'things', 'what', 'when', 'where', 'which', 'would', 'with',
  'hello', 'hi', 'hey', 'thanks', 'thank', 'please',
]);

function lower(v) {
  return String(v || '').toLowerCase();
}

function compact(v, max = 420) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function parseTags(tags) {
  if (!tags) return '';
  if (Array.isArray(tags)) return tags.join(' ');
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.join(' ') : String(tags);
  } catch {
    return String(tags);
  }
}

const INTENT_PHRASE_PATTERNS = [
  /do you remember/ig,
  /previously/ig,
  /earlier/ig,
  /last\s+(time|week|month|year)/ig,
  /manual\s+(deep\s+)?recall/ig,
  /low relevance/ig,
  /memory recall/ig,
];

function uniqueTerms(items, limit = 14) {
  const seen = new Set();
  const out = [];
  for (const term of items) {
    const clean = String(term || '').trim().replace(/\s+/g, ' ');
    const key = lower(clean);
    if (!clean || seen.has(key) || DEFAULT_STOP.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

export function extractMemoryRescueTermBundle(query) {
  const text = String(query || '');
  const codeLike = [...text.matchAll(/`([^`]{2,80})`/g)].map(m => m[1]);
  const proper = text.match(/\b[A-Z][A-Za-z0-9_.-]{2,}(?:\s+[A-Z][A-Za-z0-9_.-]{2,}){0,2}\b/g) || [];
  const technical = text.match(/\b[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+\b/g) || [];
  const acronyms = text.match(/\b[A-Z]{2,}[A-Za-z0-9-]*\b/g) || [];
  const entities = uniqueTerms([...codeLike, ...proper, ...technical, ...acronyms], 12);
  const intentPhrases = uniqueTerms(
    INTENT_PHRASE_PATTERNS.flatMap(pattern => [...text.matchAll(pattern)].map(m => m[0])),
    8
  );
  const words = text
    .replace(/[^\w\u4e00-\u9fff.-]+/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(s => {
      if (s.length < 4 || DEFAULT_STOP.has(lower(s)) || /^\d+$/.test(s)) return false;
      const cjkCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
      const hasAscii = /[A-Za-z0-9_.-]/.test(s);
      // Long Chinese chunks are usually recall-intent prose from the user's
      // sentence, not stable search entities. Keep them out of candidate
      // lookup/log terms so stdout stays readable and search remains precise.
      if (!hasAscii && cjkCount > 8) return false;
      return true;
    });
  const searchTerms = uniqueTerms([...entities, ...words], 14);
  return { terms: searchTerms, searchTerms, entities, intentPhrases };
}

export function extractMemoryRescueTerms(query) {
  return extractMemoryRescueTermBundle(query).terms;
}

export function scoreMemoryRescueTrigger({
  query,
  episodicStats = null,
  poolFallback = false,
  poolDynamicCount = null,
  topPoolIds = [],
} = {}) {
  const q = String(query || '').trim();
  const qLower = lower(q);
  const termBundle = extractMemoryRescueTermBundle(q);
  const terms = termBundle.searchTerms;
  const reasons = [];
  let score = 0;

  if (q.length < 10) {
    return { shouldRun: false, score: 0, reasons: ['query_too_short'], terms };
  }

  const recallIntent = /remember|recall|previously|earlier|last\s+(time|week|month|year)|what did we|do you remember|manual\s+(deep\s+)?recall|memory recall/i.test(q);
  if (recallIntent) { score += 2.5; reasons.push('recall_intent'); }

  const projectStateIntent = /state|status|progress|decision|experiment|verify|bug|hotfix|release|deploy|disabled|enabled|scheduler|gate|cron|runtime|prototype|planning|artifact/i.test(q);
  if (projectStateIntent) { score += 1.2; reasons.push('project_state'); }

  const entityTerms = terms.filter(t => /[A-Z][A-Za-z0-9_.-]{2,}|[-_.]/.test(t));
  if (entityTerms.length > 0) {
    score += Math.min(2.2, 0.9 + entityTerms.length * 0.35);
    reasons.push('named_or_technical_entity');
  }

  const topRerank = Number(episodicStats?.top_rerank);
  const episodicChars = Number(episodicStats?.chars || 0);
  const episodicSegments = Number(episodicStats?.segments || 0);
  if (episodicStats && (episodicSegments === 0 || episodicChars < 500 || (Number.isFinite(topRerank) && topRerank < 0.8))) {
    score += 1.4;
    reasons.push('episodic_low_confidence');
  }

  if (poolFallback) { score += 2.0; reasons.push('pool_fallback'); }
  else if (Number.isFinite(Number(poolDynamicCount)) && Number(poolDynamicCount) <= 3) {
    score += 0.8;
    reasons.push('pool_low_dynamic');
  }

  const topText = lower((topPoolIds || []).join(' '));
  const topHits = terms.filter(t => topText.includes(lower(t))).length;
  if (terms.length >= 2 && topPoolIds.length > 0 && topHits === 0) {
    score += 0.8;
    reasons.push('pool_entity_mismatch');
  }

  // Avoid spending LLM calls on simple acknowledgements or purely generative requests.
  const simpleAck = /^(ok|yes|go|continue|thanks|thank you)[\s。,.!?、]*$/i.test(q);
  if (simpleAck) {
    score -= 4;
    reasons.push('simple_ack_suppressed');
  }
  const simpleGreetingOrIdentity = /^(hello|hi|hey)[\s,，。.!?]*(who are you|introduce yourself)?[\s。,.!?、]*$/i.test(q)
    || /^(hello|hi|hey)[\s,，。.!?]*(who are you)\??$/i.test(q);
  if (simpleGreetingOrIdentity) {
    score -= 4;
    reasons.push('simple_greeting_suppressed');
  }

  const shouldRun = score >= 3.2;
  return {
    shouldRun,
    score: Number(score.toFixed(2)),
    reasons,
    terms,
    entityTerms,
    entities: termBundle.entities,
    intentPhrases: termBundle.intentPhrases,
  };
}

export function starMemoryRescueCandidates(db, {
  query,
  terms = extractMemoryRescueTerms(query),
  ownerSql = '',
  ownerParams = [],
  limit = 18,
} = {}) {
  if (!db || !Array.isArray(terms) || terms.length === 0) return [];
  const focalDirectTerms = terms
    .filter(t => /[A-Z]/.test(t) && !/^(KC|Great|Transformation|Gate|Social|Radar)$/i.test(t))
    .slice(0, 8);
  const directTerms = (focalDirectTerms.length > 0 ? focalDirectTerms : terms).slice(0, 8);
  const broadTerms = terms.slice(0, 10);
  const directWhere = directTerms.map(() => '(lower(id) LIKE ? OR lower(l0) LIKE ?)').join(' OR ');
  const broadWhere = broadTerms.map(() => "(lower(id) LIKE ? OR lower(l0) LIKE ? OR lower(l1) LIKE ? OR lower(l2) LIKE ? OR lower(coalesce(tags, '')) LIKE ?)").join(' OR ');
  const rows = [];
  const seen = new Set();

  if (directWhere) {
    const params = directTerms.flatMap(t => [`%${lower(t)}%`, `%${lower(t)}%`]);
    const direct = db.prepare(`
      SELECT id, node_type, subkind, created_at, updated_at, access_count, conn_count, l0, l1, l2, tags
      FROM nodes
      WHERE state='active' AND deprecated_at IS NULL AND (${directWhere})${ownerSql}
      LIMIT 80
    `).all(...params, ...ownerParams);
    for (const row of direct) {
      if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
  }

  if (broadWhere) {
    const params = broadTerms.flatMap(t => {
      const p = `%${lower(t)}%`;
      return [p, p, p, p, p];
    });
    const broad = db.prepare(`
      SELECT id, node_type, subkind, created_at, updated_at, access_count, conn_count, l0, l1, l2, tags
      FROM nodes
      WHERE state='active' AND deprecated_at IS NULL AND (${broadWhere})${ownerSql}
      LIMIT 100
    `).all(...params, ...ownerParams);
    for (const row of broad) {
      if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
    }
  }

  return rows.map(row => {
    const idL0 = lower(`${row.id} ${row.l0}`);
    const body = lower(`${row.l1} ${row.l2} ${parseTags(row.tags)}`);
    const strongTerms = terms.filter(t =>
      /[A-Z]/.test(t)
      && !/^(KC|Great|Transformation|Gate|Social|Radar)$/i.test(t)
    );
    const focalTerms = strongTerms.length > 0 ? strongTerms : directTerms;
    const directHits = focalTerms.filter(t => idL0.includes(lower(t)));
    const strongBodyHits = strongTerms.filter(t => body.includes(lower(t)) || idL0.includes(lower(t)));
    const bodyHits = broadTerms.filter(t => body.includes(lower(t)));
    const score =
      directHits.length * 40
      + strongBodyHits.length * 32
      + bodyHits.length * 6
      + Math.min(5, Number(row.conn_count || 0) / 30)
      + Math.min(3, Number(row.access_count || 0) / 80);
    return { ...row, source: 'star', score, hits: [...directHits, ...strongBodyHits, ...bodyHits] };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function conversationMemoryRescueCandidates(convDb, {
  query,
  terms = extractMemoryRescueTerms(query),
  sessionId = null,
  sessionIdLike = null,
  limit = 10,
} = {}) {
  if (!convDb || !Array.isArray(terms) || terms.length === 0) return [];
  const selectedTerms = terms.slice(0, 10);
  const where = selectedTerms.map(() => 'lower(content) LIKE ?').join(' OR ');
  const params = selectedTerms.map(t => `%${lower(t)}%`);
  let scopeSql = '';
  const scopeParams = [];
  if (sessionIdLike) {
    scopeSql = ' AND session_id LIKE ?';
    scopeParams.push(sessionIdLike);
  } else if (sessionId) {
    scopeSql = ' AND session_id = ?';
    scopeParams.push(sessionId);
  }
  const rows = convDb.prepare(`
    SELECT id, timestamp, role, session_id, content
    FROM messages
    WHERE (${where})${scopeSql}
      AND role IN ('user','assistant')
      AND coalesce(participant, '') != 'self'
    ORDER BY id DESC
    LIMIT 80
  `).all(...params, ...scopeParams);

  return rows.map(row => {
    const text = lower(row.content);
    const hits = selectedTerms.filter(t => text.includes(lower(t)));
    const ageDays = row.timestamp ? Math.max(0, (Date.now() - new Date(row.timestamp).getTime()) / 86400000) : 365;
    const recency = Math.max(0, 5 - ageDays);
    const score = hits.length * 8 + recency;
    return { ...row, source: 'conversation', score, hits };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildJudgePrompt({ query, trigger, episodicStats, starRows, convRows }) {
  const starItems = starRows.slice(0, 14).map((row, i) => ({
    key: `S${i + 1}`,
    id: row.id,
    type: row.node_type,
    score: Number(row.score || 0).toFixed(2),
    l0: compact(row.l0, 220),
    l1: compact(row.l1, 420),
  }));
  const convItems = convRows.slice(0, 10).map((row, i) => ({
    key: `C${i + 1}`,
    id: `msg${row.id}`,
    timestamp: row.timestamp,
    role: row.role,
    session_id: row.session_id,
    score: Number(row.score || 0).toFixed(2),
    excerpt: compact(row.content, 620),
  }));
  return `You are the Anamnesis memory rescue judge inside Constellation Engine.

The first-pass IR has already run. Your job is NOT to answer the user.
Your job is to select only memory candidates that are directly useful for the current turn.

Current user query:
${query}

Trigger diagnostics:
${JSON.stringify(trigger, null, 2)}

First-pass episodic stats:
${JSON.stringify(episodicStats || {}, null, 2)}

Star Map rescue candidates:
${JSON.stringify(starItems, null, 2)}

Conversation rescue candidates:
${JSON.stringify(convItems, null, 2)}

Rules:
- Prefer direct matches over adjacent background.
- If a candidate only shares generic words, mark it noise.
- Only select candidates with relevance >= 0.55.
- Put low-relevance or merely adjacent candidates in noise_keys instead of selected.
- Pick at most 8 total.
- Include enough reason to explain why the memory matters.
- If nothing is directly useful, select [].

Return ONLY compact JSON:
{
  "quality": "excellent|good|mixed|poor",
  "selected": [{"key":"S1","id":"...","relevance":0.0,"why":"short"}],
  "noise_keys": ["S2"],
  "missing_likely": true,
  "second_pass_query": "short query or empty",
  "summary": "one sentence"
}`;
}

function parseJudge(raw) {
  const text = String(raw || '').trim();
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0] || text;
  return JSON.parse(jsonText);
}

export async function runMemoryRescueJudge({ llm, query, trigger, episodicStats, starRows, convRows, timeoutMs = 60000 }) {
  if (!llm || typeof llm.chat !== 'function') return { ok: false, skipped: 'no_llm' };
  const prompt = buildJudgePrompt({ query, trigger, episodicStats, starRows, convRows });
  try {
    const resp = await Promise.race([
      llm.chat([{ role: 'user', content: prompt }], {
        _role: 'anamnesis',
        temperature: 0.1,
        maxTokens: 1200,
        _trigger: 'memory_rescue',
        _sessionId: 'memory_rescue',
        _skipRateLimit: true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`memory rescue judge timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const raw = typeof resp === 'string' ? resp : (resp?.content || resp?.text || '');
    const parsed = parseJudge(raw);
    return { ok: true, parsed, raw };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export function renderMemoryRescueSection({ judge, starRows, convRows, maxChars = 7000, minRelevance = 0.55 }) {
  const parsed = judge?.parsed || {};
  const rawSelected = Array.isArray(parsed.selected) ? parsed.selected : [];
  const selected = rawSelected
    .filter(item => {
      const rel = Number(item?.relevance);
      return Number.isFinite(rel) && rel >= minRelevance;
    })
    .sort((a, b) => Number(b.relevance) - Number(a.relevance))
    .slice(0, 8);
  if (selected.length === 0) return { text: '', selectedCount: 0 };
  const byKey = new Map();
  starRows.forEach((row, i) => byKey.set(`S${i + 1}`, row));
  convRows.forEach((row, i) => byKey.set(`C${i + 1}`, row));

  const lines = [
    `## 🧠 Anamnesis Memory Rescue (${selected.length} selected)`,
    `Second-pass memory rescue ran because first-pass recall looked incomplete. Treat these as high-relevance candidates, but still ground claims in their content.`,
  ];
  if (parsed.summary) lines.push(`Judge summary: ${compact(parsed.summary, 240)}`);
  if (parsed.second_pass_query) lines.push(`Suggested follow-up query: ${compact(parsed.second_pass_query, 180)}`);
  lines.push('');

  for (const item of selected) {
    const row = byKey.get(item.key);
    if (!row) continue;
    const rel = Number.isFinite(Number(item.relevance)) ? Number(item.relevance).toFixed(2) : '?';
    if (row.source === 'star') {
      lines.push(`- [Star:${row.id}] rel=${rel} — ${compact(item.why, 180)}`);
      lines.push(`  L0: ${compact(row.l0, 220)}`);
      if (row.l1) lines.push(`  L1: ${compact(row.l1, 480)}`);
    } else {
      lines.push(`- [Conversation:msg${row.id} ${row.timestamp || ''}] rel=${rel} — ${compact(item.why, 180)}`);
      lines.push(`  ${compact(row.content, 620)}`);
    }
  }

  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[...memory rescue truncated]`;
  return { text, selectedCount: selected.length, quality: parsed.quality || 'unknown' };
}
