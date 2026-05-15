// SPDX-License-Identifier: AGPL-3.0-or-later
// Lazy in-process cross-encoder rerank via @xenova/transformers.
// Pairs (query, doc) → relevance score. Tries a multilingual reranker first
// (Chinese/English parity with the Python daemon's mxbai-rerank-base-v2),
// falls back to ms-marco MiniLM (English-only, small), then BGE cosine.

import { pipeline, env as xenovaEnv } from '@xenova/transformers';
import { embed } from './embed.js';

let _xePromise = null;
let _xeFailed = false;

// Override with MIMIR_RERANK_MODEL env if a user wants a different ONNX model.
// Default is multilingual BGE reranker — closest available Xenova-published
// equivalent to the Python mxbai-rerank-base-v2 (both multilingual, CPU-OK).
const RERANK_MODEL_PRIMARY = process.env.MIMIR_RERANK_MODEL || 'Xenova/bge-reranker-base';
const RERANK_MODEL_FALLBACK = 'Xenova/ms-marco-MiniLM-L-6-v2';

async function _tryLoad(modelId) {
  return pipeline('text-classification', modelId, { quantized: true });
}

async function loadCrossEncoder() {
  if (_xeFailed) return null;
  if (_xePromise) return _xePromise;
  _xePromise = (async () => {
    try {
      const xe = await _tryLoad(RERANK_MODEL_PRIMARY);
      console.log(`[mimir-js rerank] loaded ${RERANK_MODEL_PRIMARY}`);
      return xe;
    } catch (e1) {
      console.warn(`[mimir-js rerank] ${RERANK_MODEL_PRIMARY} unavailable (${e1.message}) — trying fallback`);
      try {
        const xe = await _tryLoad(RERANK_MODEL_FALLBACK);
        console.log(`[mimir-js rerank] loaded fallback ${RERANK_MODEL_FALLBACK}`);
        return xe;
      } catch (e2) {
        console.warn(`[mimir-js rerank] fallback failed too (${e2.message}) — degrading to BGE cosine`);
        _xeFailed = true;
        _xePromise = null;
        return null;
      }
    }
  })();
  return _xePromise;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Rerank: input { query: string, docs: string[] } → [{ index, score }] desc by score.
export async function rerank(query, docs) {
  if (!query || !Array.isArray(docs) || docs.length === 0) return [];
  const xe = await loadCrossEncoder();
  if (xe) {
    const out = [];
    for (let i = 0; i < docs.length; i++) {
      try {
        const r = await xe({ text: query, text_pair: String(docs[i] || '').slice(0, 4000) });
        // text-classification returns [{label, score}] — we want the relevance score directly.
        const score = Array.isArray(r) ? (r[0]?.score ?? 0) : (r?.score ?? 0);
        out.push({ index: i, score });
      } catch {
        out.push({ index: i, score: 0 });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  // Fallback: BGE cosine over embeddings (already L2-normalized → dot = cosine).
  const vecs = await embed([query, ...docs]);
  const qv = vecs[0];
  const out = [];
  for (let i = 0; i < docs.length; i++) {
    out.push({ index: i, score: dot(qv, vecs[i + 1]) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
