// SPDX-License-Identifier: AGPL-3.0-or-later
// LLM-as-retriever: precision-rerank a coarse BGE+SA candidate pool by asking
// the fast-tier model to pick the truly relevant nodes for the user's query.
// Replaces the old cross-encoder path with a single small-model call.
//
// Returns: { picks: [node_id...], coverage: 'sufficient'|'thin'|'irrelevant',
//           reason, latency_ms, fallback_reason }
//
// Kill-switch: MIMIR_LLM_RETRIEVER=0 falls back to BGE top-K immediately.
// Endpoint hit via OPENAI_BASE_URL or LLM_PROXY_URL; model from FAST_TIER_MODEL.

const KILL = String(process.env.MIMIR_LLM_RETRIEVER || '').trim() === '0';

const PROXY_URL = process.env.LLM_PROXY_URL
  || process.env.OPENAI_BASE_URL
  || 'http://127.0.0.1:3456/v1';

const FAST_MODEL = process.env.FAST_TIER_MODEL
  || process.env.OSS_FAST_MODEL
  || 'claude-haiku-4-5-20251001';

const TIMEOUT_MS = parseInt(process.env.MIMIR_LLM_RETRIEVER_TIMEOUT_MS || '10000', 10);

const PROMPT = (query, candidatesJson, topK) => `You are a retrieval re-ranker for a topology-based memory system.

A user just asked a question. Below are ${topK * 5} candidate memory nodes returned by coarse retrieval (BGE-M3 embeddings + spreading activation).

Your job:
1. Pick at most ${topK} nodes that are TRULY useful for answering this question (return their ids).
2. Judge overall pool quality: sufficient / thin / irrelevant.
3. Briefly explain your selection (<= 50 chars).

Strict rules:
- "Useful" means it would actually help answer THIS query, not "topically near".
- Drop any node whose connection to the query is only superficial keyword overlap.
- Prefer 5 highly relevant picks + coverage=thin over filling to ${topK} with weak matches.

Output strictly as JSON, no markdown fences:
{"picks": ["id1", "id2", ...], "coverage": "sufficient", "reason": "..."}

Query:
${query}

Candidates:
${candidatesJson}
`;

function _extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function _callLlm(prompt, signal) {
  const url = PROXY_URL.replace(/\/+$/, '') + '/chat/completions';
  const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || 'local';
  const body = {
    model: FAST_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 400,
  };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '';
}

// candidates: [{ id, l0, l1, channel?, score? }]
// returns { picks, coverage, reason, latency_ms, fallback_reason }
export async function llmRerank({ query, candidates = [], topK = 15 } = {}) {
  const t0 = Date.now();
  if (KILL) {
    return _fallback(candidates, topK, 'kill-switch');
  }
  if (!query || candidates.length === 0) {
    return _fallback(candidates, topK, 'empty-input');
  }

  // Trim to top 5*K to keep prompt size sane.
  const slim = candidates.slice(0, topK * 5).map(c => ({
    id: c.id,
    l0: String(c.l0 || '').slice(0, 200),
    ...(c.channel ? { channel: c.channel } : {}),
  }));

  const prompt = PROMPT(query, JSON.stringify(slim, null, 0), topK);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const text = await _callLlm(prompt, ctrl.signal);
    clearTimeout(timer);
    const parsed = _extractJson(text);
    if (!parsed || !Array.isArray(parsed.picks)) {
      return _fallback(candidates, topK, 'parse-fail');
    }
    const valid = new Set(slim.map(c => c.id));
    const picks = parsed.picks.filter(p => valid.has(p)).slice(0, topK);
    const coverage = ['sufficient', 'thin', 'irrelevant'].includes(parsed.coverage)
      ? parsed.coverage
      : 'thin';
    return {
      ok: true,
      picks,
      coverage,
      reason: String(parsed.reason || '').slice(0, 200),
      latency_ms: Date.now() - t0,
      fallback_reason: '',
    };
  } catch (e) {
    clearTimeout(timer);
    return _fallback(candidates, topK, e.message || 'llm-error');
  }
}

function _fallback(candidates, topK, reason) {
  return {
    ok: true,
    picks: candidates.slice(0, topK).map(c => c.id),
    coverage: candidates.length >= topK ? 'sufficient' : 'thin',
    reason: 'BGE fallback',
    latency_ms: 0,
    fallback_reason: reason,
  };
}
