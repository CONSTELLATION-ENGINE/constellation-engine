// SPDX-License-Identifier: AGPL-3.0-or-later
// Smoke test for mimir-js: fires each of the 22 engine call patterns
// (per agent-runtime.js / dashboard.js / cron.js / telegram.js / main.js)
// and asserts the response shape matches what the engine consumes.
//
// Usage:  CONSTELLATION_DB=/path/to.db node scripts/mimir-js/smoke.cjs
//   (assumes mimir-js is already running on $MIMIR_PORT or 28810)

const http = require('node:http');

const PORT = parseInt(process.env.MIMIR_PORT || '28810', 10);
const HOST = process.env.MIMIR_HOST || '127.0.0.1';

let pass = 0, fail = 0;

function call(method, path, body) {
  return new Promise((resolve) => {
    const opts = {
      host: HOST, port: PORT, path, method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 60_000,
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf, parseErr: true }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

(async () => {
  console.log(`smoke test → http://${HOST}:${PORT}\n`);

  // /status — used by main.js, dashboard.js, telegram.js
  let r = await call('GET', '/status');
  assert('/status returns ok',         r.status === 200 && r.body?.ok === true);
  assert('/status has top_activations', Array.isArray(r.body?.top_activations));
  assert('/status has active_count',    typeof r.body?.active_count === 'number');

  // /pool — agent-runtime
  r = await call('GET', '/pool');
  assert('/pool returns ok',                    r.status === 200 && r.body?.ok === true);
  assert('/pool has nodes array',               Array.isArray(r.body?.nodes));
  assert('/pool has llm_inject_limit',          typeof r.body?.llm_inject_limit === 'number');
  if (r.body?.nodes?.length > 0) {
    const n = r.body.nodes[0];
    assert('/pool node has id (not node_id)',    typeof n.id === 'string');
    assert('/pool node has score',               typeof n.score === 'number');
    assert('/pool node has activation',          typeof n.activation === 'number');
    assert('/pool node has delta',               typeof n.delta === 'number');
    assert('/pool node has permanent flag',      typeof n.permanent === 'boolean');
    assert('/pool node has zone',                typeof n.zone === 'number');
    assert('/pool node has bridge',              typeof n.bridge === 'number');
    assert('/pool node has sa_channel',          typeof n.sa_channel === 'string');
  }

  // /embed — engine-side rerank
  r = await call('POST', '/embed', { texts: ['hello world'] });
  assert('/embed returns ok',           r.status === 200 && r.body?.ok === true);
  assert('/embed has dim=1024',         r.body?.dim === 1024);
  assert('/embed returns vector',       Array.isArray(r.body?.embeddings) && r.body.embeddings[0]?.length === 1024);

  // /rerank — agent-runtime
  r = await call('POST', '/rerank', { query: 'hello', documents: ['hello world', 'goodbye'] });
  assert('/rerank returns ok',          r.status === 200 && r.body?.ok === true);
  assert('/rerank ranked array',        Array.isArray(r.body?.ranked) && r.body.ranked.length === 2);

  // /episodic_query — agent-runtime reads .segments / .episodic_context / .pool_size
  r = await call('POST', '/episodic_query', { query: 'memory', limit: 5 });
  assert('/episodic_query ok',                r.status === 200 && r.body?.ok === true);
  assert('/episodic_query has segments',      Array.isArray(r.body?.segments));
  assert('/episodic_query has pool_size',     typeof r.body?.pool_size === 'number');
  assert('/episodic_query has episodic_context', 'episodic_context' in (r.body || {}));

  // /retrieve_conversations — agent-runtime; engine filters by .score > 0.3
  r = await call('POST', '/retrieve_conversations', { query: 'hello', limit: 3 });
  assert('/retrieve_conversations ok',  r.status === 200 && r.body?.ok === true);
  assert('/retrieve_conversations results', Array.isArray(r.body?.results));
  if (r.body?.results?.length > 0) {
    const row = r.body.results[0];
    assert('retrieve row has .score field',   typeof row.score === 'number');
    assert('retrieve row has .session_id',    typeof row.session_id === 'string' || row.session_id === null);
    assert('retrieve row has .role',          typeof row.role === 'string');
    assert('retrieve row has .content',       typeof row.content === 'string');
  }

  // /digest — agent-runtime
  r = await call('GET', '/digest?limit=5');
  assert('/digest ok',                  r.status === 200 && r.body?.ok === true);
  assert('/digest has count',           typeof r.body?.count === 'number');
  assert('/digest has sessions array',  Array.isArray(r.body?.sessions));

  // /diary_search — telegram, dashboard
  r = await call('POST', '/diary_search', { query: 'today', limit: 3 });
  assert('/diary_search ok',            r.status === 200 && r.body?.ok === true);
  assert('/diary_search results',       Array.isArray(r.body?.results));

  // /diary/append + /diary/recent — engine cron daily reflection
  const stamp = `smoke-${Date.now()}`;
  r = await call('POST', '/diary/append', { kind: 'reflection', text: `smoke entry ${stamp}` });
  assert('/diary/append ok',            r.status === 200 && r.body?.ok === true);
  assert('/diary/append returned id',   typeof r.body?.id === 'number' || r.body?.killed === true);

  r = await call('POST', '/diary/recent', { hours: 1, limit: 5 });
  assert('/diary/recent ok',            r.status === 200 && r.body?.ok === true);
  assert('/diary/recent results',       Array.isArray(r.body?.results));

  r = await call('POST', '/diary/reflect', { hours_back: 24 });
  assert('/diary/reflect ok',           r.status === 200 && r.body?.ok === true);
  assert('/diary/reflect has nodes',    Array.isArray(r.body?.recent_nodes));
  assert('/diary/reflect has prior',    Array.isArray(r.body?.prior_entries));

  // /library_fetch — agent-runtime
  r = await call('GET', '/library_fetch?limit=5');
  assert('/library_fetch ok',           r.status === 200 && r.body?.ok === true);
  assert('/library_fetch items',        Array.isArray(r.body?.items));

  // /compile, /compile_skeleton — agent-runtime treats null as deferred
  r = await call('POST', '/compile', { query: 'test' });
  assert('/compile responds 200',       r.status === 200);
  r = await call('POST', '/compile_skeleton', { max_sentences: 5 });
  assert('/compile_skeleton responds 200', r.status === 200);

  // /reason/* — agent-runtime
  for (const p of ['/reason/paths', '/reason/analogy', '/reason/abduction', '/reason/deduction']) {
    r = await call('POST', p, {});
    assert(`${p} responds 200`,         r.status === 200);
  }

  // /signal, /turn_signal — sleipnir, telegram
  r = await call('POST', '/signal', { kind: 'task_touch', target: 'test' });
  assert('/signal ok',                  r.status === 200);
  r = await call('POST', '/turn_signal', { user_message: 'hi' });
  assert('/turn_signal ok',             r.status === 200);

  // /episodic_ingest — main.js
  r = await call('POST', '/episodic_ingest', { msg_id: 1, role: 'user', content: 'hi', session_id: 's1', timestamp: new Date().toISOString() });
  assert('/episodic_ingest ok',         r.status === 200);

  // /session_end — telegram, dashboard
  r = await call('POST', '/session_end', { session_id: 's1' });
  assert('/session_end ok',             r.status === 200);

  // /outreach_response_seen — telegram
  r = await call('POST', '/outreach_response_seen', { user_id: 'self' });
  assert('/outreach_response_seen ok',  r.status === 200);

  // /config — telegram, dashboard
  r = await call('GET', '/config');
  assert('/config GET ok',              r.status === 200 && r.body?.ok === true);
  r = await call('POST', '/config', { autonomy_curiosity: false });
  assert('/config POST ok',             r.status === 200);

  // /state — agent-runtime, dashboard
  r = await call('GET', '/state');
  assert('/state ok',                   r.status === 200 && r.body?.ok === true);

  // /segments_by_anchors — agent-runtime
  r = await call('POST', '/segments_by_anchors', { anchors: ['a', 'b'] });
  assert('/segments_by_anchors ok',     r.status === 200);

  // /activations — observability
  r = await call('GET', '/activations');
  assert('/activations ok',             r.status === 200);

  // /inject — observability
  r = await call('POST', '/inject', { node_id: 'M-test' });
  assert('/inject ok',                  r.status === 200);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
