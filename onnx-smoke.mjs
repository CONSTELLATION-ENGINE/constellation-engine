import { pipeline, env } from '@xenova/transformers';
env.allowLocalModels = false;
env.useBrowserCache = false;
console.log('[smoke] start', new Date().toISOString());
const t0 = Date.now();
try {
  const extractor = await pipeline('feature-extraction', 'Xenova/bge-m3', { quantized: true });
  console.log(`[smoke] pipeline loaded in ${Date.now()-t0}ms`);
  const t1 = Date.now();
  const out = await extractor('hello world', { pooling: 'mean', normalize: true });
  console.log(`[smoke] encoded in ${Date.now()-t1}ms, dims=${JSON.stringify(out.dims)}, len=${out.data.length}`);
  console.log('[smoke] OK first8=', Array.from(out.data.slice(0,8)).map(x=>x.toFixed(4)).join(','));
} catch(e) {
  console.error('[smoke] FAIL:', e.message);
  console.error(e.stack?.split('\n').slice(0,8).join('\n'));
}
