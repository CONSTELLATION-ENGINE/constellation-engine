// SPDX-License-Identifier: AGPL-3.0-or-later
// Lazy in-process BGE-M3 (1024d) via @xenova/transformers ONNX runtime.
// First call cold-loads the model (~30s, downloads to local cache); subsequent
// calls are ~24ms/sentence on CPU. Mean-pooled + L2-normalized to match the
// Python sentence-transformers default that the existing star map was trained on.

import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = true;
env.allowRemoteModels = true;

let _extractorPromise = null;
let _ready = false;

const MODEL_ID = 'Xenova/bge-m3';
const DIM = 1024;

export const EMBED_DIM = DIM;

export function isReady() { return _ready; }

export async function loadEmbedder() {
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = pipeline('feature-extraction', MODEL_ID, { quantized: true })
    .then(ex => { _ready = true; return ex; })
    .catch(err => { _extractorPromise = null; throw err; });
  return _extractorPromise;
}

// Encode one or more strings → array of Float32Array(1024).
// Always mean-pool + L2-normalize so vec0 cosine search behaves identically
// to the Python pipeline that wrote the existing embeddings.
export async function embed(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];
  const extractor = await loadEmbedder();
  const out = [];
  for (const t of arr) {
    const tensor = await extractor(String(t || '').slice(0, 8000), { pooling: 'mean', normalize: true });
    out.push(Array.from(tensor.data));
  }
  return out;
}

// Cheap blob form for vec0 MATCH queries.
export function toBlob(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
