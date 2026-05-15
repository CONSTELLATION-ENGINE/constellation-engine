// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider registry — id → adapter lookup. Phase B router will call resolve(id).
// Adapters self-register on import; consumer just calls loadBuiltins() once.

const adapters = new Map();

export function register(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('register: adapter must be an object');
  if (!adapter.id) throw new Error('register: adapter.id is required');
  if (!adapter.wireFormat) throw new Error(`register(${adapter.id}): wireFormat is required`);
  if (typeof adapter.doGenerate !== 'function') {
    throw new Error(`register(${adapter.id}): doGenerate must be a function`);
  }
  adapters.set(adapter.id, adapter);
  return adapter;
}

export function resolve(id) {
  if (!id) return null;
  return adapters.get(id) || null;
}

export function list() {
  return Array.from(adapters.values()).map((a) => ({
    id: a.id,
    wireFormat: a.wireFormat,
    capabilities: a.capabilities || {},
    knownModels: a.knownModels || null,
    setupGuide: a.setupGuide || null,
    hasListModels: typeof a.listModels === 'function',
  }));
}

export function getKnownModels(id) {
  const a = adapters.get(id);
  return a?.knownModels || null;
}

export function getSetupGuide(id) {
  const a = adapters.get(id);
  return a?.setupGuide || null;
}

export async function fetchLiveModels(id, opts = {}) {
  const a = adapters.get(id);
  if (!a || typeof a.listModels !== 'function') return null;
  return a.listModels(opts);
}

let loadingPromise = null;

export function loadBuiltins() {
  // Force-load all bundled adapters so callers can resolve by id immediately.
  // Each module calls register() at top-level evaluation time. Cache the
  // in-flight promise so concurrent callers share one Promise.all.
  if (!loadingPromise) {
    loadingPromise = Promise.all([
      import('./anthropic.js'),
      import('./openai.js'),
      import('./gemini.js'),
      import('./ollama.js'),
      import('./openrouter.js'),
      import('./lmstudio.js'),
      import('./vllm.js'),
      import('./custom.js'),
    ]).then(() => list());
  }
  return loadingPromise;
}
