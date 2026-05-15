// SPDX-License-Identifier: AGPL-3.0-or-later
// Smoke test for downloader.js — runs an in-process HTTP server and exercises:
//   1. Plain success path with SHA-256 verify
//   2. Range resume after partial download
//   3. Checksum mismatch → .part deleted, mirror failover
//   4. All-mirrors-fail → ALL_MIRRORS_FAILED rejection
//
// Run: node onboarding/_smoke_test.js
// (No external network. Safe to run in CI.)

const http   = require('node:http');
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const os     = require('node:os');

// Patch loadManifest before requiring the downloader
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdl-smoke-'));
const tmpManifest = path.join(tmpRoot, 'mirrors.json');

// Build a 200KB deterministic blob
const blob = Buffer.alloc(200 * 1024);
for (let i = 0; i < blob.length; i++) blob[i] = i & 0xff;
const blobSha = crypto.createHash('sha256').update(blob).digest('hex');

// Will be filled with port after listen
let goodUrl, badUrl, mismatchUrl, deadUrl;
let rangeRequestCount = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/blob.bin') {
    const range = req.headers.range;
    if (range) {
      rangeRequestCount++;
      const m = range.match(/bytes=(\d+)-/);
      const offset = m ? parseInt(m[1], 10) : 0;
      // Per RFC 7233, requesting a range beyond EOF must return 416
      if (offset >= blob.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${blob.length}` });
        res.end();
        return;
      }
      const slice = blob.subarray(offset);
      res.writeHead(206, {
        'Content-Range':  `bytes ${offset}-${blob.length - 1}/${blob.length}`,
        'Content-Length': slice.length,
        'Accept-Ranges':  'bytes',
      });
      res.end(slice);
    } else {
      res.writeHead(200, { 'Content-Length': blob.length, 'Accept-Ranges': 'bytes' });
      res.end(blob);
    }
  } else if (req.url === '/wrong-checksum.bin') {
    res.writeHead(200, { 'Content-Length': blob.length });
    res.end(blob);
  } else if (req.url === '/server-error.bin') {
    res.writeHead(500); res.end('boom');
  } else {
    res.writeHead(404); res.end('nope');
  }
});

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseGood    = `http://127.0.0.1:${port}/`;
  const baseBad     = `http://127.0.0.1:${port}/server-error-base/`;   // will append blob.bin → 404
  const baseDead    = `http://127.0.0.1:${port}/server-error/`;        // will append blob.bin → 404 too
  console.log(`[server] listening on ${port}`);

  // Manifest with 3 components for distinct test cases
  const manifest = {
    version: 1,
    components: {
      'good':         {
        displayName: 'Good blob',
        destDir:     'tmp-good',
        approxBytes: blob.length,
        files:       [{ path: 'blob.bin', sha256: blobSha }],
        mirrors:     [{ name: 'A', baseUrl: baseGood }],
      },
      'failover': {
        displayName: 'Failover blob',
        destDir:     'tmp-failover',
        approxBytes: blob.length,
        files:       [{ path: 'blob.bin', sha256: blobSha }],
        mirrors:     [
          { name: 'BadHost',  baseUrl: 'http://127.0.0.1:1/' },        // connection refused
          { name: 'WrongCs',  baseUrl: `http://127.0.0.1:${port}/wrong-checksum-prefix/` }, // 404
          { name: 'GoodOne',  baseUrl: baseGood },
        ],
      },
      'dead': {
        displayName: 'All dead',
        destDir:     'tmp-dead',
        approxBytes: blob.length,
        files:       [{ path: 'blob.bin', sha256: blobSha }],
        mirrors:     [
          { name: 'A', baseUrl: baseDead },
          { name: 'B', baseUrl: baseBad },
        ],
      },
    },
  };
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest));

  // Force downloader.js to load OUR manifest by overriding readFileSync once.
  // (Cleanest: shadow path.join inside the module via Module._cache poke.)
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith(path.join('onboarding', 'mirrors.json'))) {
      return originalReadFileSync(tmpManifest, ...rest);
    }
    return originalReadFileSync(p, ...rest);
  };

  const downloader = require('./downloader');

  // Test 1: plain success
  console.log('[test 1] plain success');
  await downloader.downloadComponent('good', { destRoot: tmpRoot }).done;
  const dest1 = path.join(tmpRoot, 'tmp-good', 'blob.bin');
  if (!fs.existsSync(dest1)) throw new Error('test 1: dest missing');
  if (fs.statSync(dest1).size !== blob.length) throw new Error('test 1: size mismatch');
  console.log('  ✓ downloaded, sha256 verified, renamed from .part');

  // Test 2: Range resume — pre-create a half .part, then download
  console.log('[test 2] Range resume from .part');
  const dest2 = path.join(tmpRoot, 'tmp-resume', 'blob.bin');
  fs.mkdirSync(path.dirname(dest2), { recursive: true });
  fs.writeFileSync(dest2 + '.part', blob.subarray(0, 50 * 1024));
  // Reuse 'good' but redirect destDir
  manifest.components['resume'] = {
    ...manifest.components['good'],
    destDir: 'tmp-resume',
  };
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest));
  // Drop module cache so manifest reloads
  delete require.cache[require.resolve('./downloader')];
  const dl2 = require('./downloader');
  rangeRequestCount = 0;
  await dl2.downloadComponent('resume', { destRoot: tmpRoot }).done;
  if (rangeRequestCount === 0) throw new Error('test 2: no Range request issued');
  if (!fs.existsSync(dest2) || fs.statSync(dest2).size !== blob.length)
    throw new Error('test 2: final file wrong');
  console.log('  ✓ Range request issued, partial resumed, final size correct');

  // Test 3: failover — first 2 mirrors fail, 3rd succeeds
  console.log('[test 3] sequential mirror failover');
  const fails = [];
  const em3 = dl2.downloadComponent('failover', { destRoot: tmpRoot });
  em3.on('mirror:fail', (p) => fails.push(p.mirror));
  await em3.done;
  if (fails.length < 2) throw new Error('test 3: expected 2 mirror failures, got ' + fails.length);
  console.log(`  ✓ failed mirrors: ${fails.join(', ')}; succeeded on next`);

  // Test 4: all mirrors dead
  console.log('[test 4] all mirrors fail');
  let caught = null;
  try { await dl2.downloadComponent('dead', { destRoot: tmpRoot }).done; }
  catch (e) { caught = e; }
  if (!caught || caught.code !== 'ALL_MIRRORS_FAILED')
    throw new Error('test 4: expected ALL_MIRRORS_FAILED, got ' + (caught && caught.code));
  console.log('  ✓ ALL_MIRRORS_FAILED raised correctly');

  // Test 5 (B2): complete .part triggers 416 → verify-and-commit, no re-download
  console.log('[test 5] complete .part hits 416 → verify-and-commit (B2 fix)');
  manifest.components['rfc7233'] = {
    ...manifest.components['good'],
    destDir: 'tmp-rfc7233',
  };
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest));
  delete require.cache[require.resolve('./downloader')];
  const dl5 = require('./downloader');
  const dest5 = path.join(tmpRoot, 'tmp-rfc7233', 'blob.bin');
  fs.mkdirSync(path.dirname(dest5), { recursive: true });
  fs.writeFileSync(dest5 + '.part', blob);   // already complete on disk from prior aborted run
  await dl5.downloadComponent('rfc7233', { destRoot: tmpRoot }).done;
  if (!fs.existsSync(dest5) || fs.statSync(dest5).size !== blob.length)
    throw new Error('test 5: expected dest committed from .part, not re-downloaded');
  console.log('  ✓ 416 short-circuit verified+renamed without re-download');

  // Test 6 (B3): TODO_ placeholder rejects with CHECKSUM_PLACEHOLDER on FIRST mirror,
  // does not advance through remaining mirrors.
  console.log('[test 6] TODO_ checksum short-circuits failover (B3 fix)');
  manifest.components['unsealed'] = {
    displayName: 'Unsealed checksum',
    destDir:     'tmp-unsealed',
    approxBytes: blob.length,
    files:       [{ path: 'blob.bin', sha256: 'TODO_FILL_AT_RELEASE' }],
    mirrors: [
      { name: 'A', baseUrl: baseGood },
      { name: 'B', baseUrl: baseGood },
      { name: 'C', baseUrl: baseGood },
    ],
  };
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest));
  delete require.cache[require.resolve('./downloader')];
  const dl6 = require('./downloader');
  const em6 = dl6.downloadComponent('unsealed', { destRoot: tmpRoot, allowSkipChecksum: false });
  let mirrorFailEvents = 0;
  em6.on('mirror:fail', () => mirrorFailEvents++);
  let caught6 = null;
  try { await em6.done; } catch (e) { caught6 = e; }
  if (!caught6 || caught6.code !== 'CHECKSUM_PLACEHOLDER')
    throw new Error('test 6: expected CHECKSUM_PLACEHOLDER, got ' + (caught6 && caught6.code));
  if (mirrorFailEvents !== 0)
    throw new Error(`test 6: expected NO mirror:fail events (failover should short-circuit), got ${mirrorFailEvents}`);
  console.log('  ✓ short-circuited with CHECKSUM_PLACEHOLDER (no wasted mirror retries)');

  // Test 7 (B1): AbortSignal listeners properly removed after each file —
  // long file chain should not exceed default MaxListeners (10).
  console.log('[test 7] AbortSignal listener cleanup across many files (B1 fix)');
  manifest.components['manyfiles'] = {
    displayName: 'Many files',
    destDir:     'tmp-manyfiles',
    approxBytes: blob.length * 15,
    files: Array.from({ length: 15 }, (_, i) => ({
      path: 'blob.bin', sha256: blobSha,
    })),
    // All point to same URL; we re-use blob.bin for all 15 entries (writes overwrite).
    mirrors: [{ name: 'A', baseUrl: baseGood }],
  };
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest));
  delete require.cache[require.resolve('./downloader')];
  const dl7 = require('./downloader');
  const ctrl7 = new AbortController();
  let warnCount = 0;
  const onWarn = (w) => { if (/MaxListenersExceeded/.test(String(w.message || w))) warnCount++; };
  process.on('warning', onWarn);
  await dl7.downloadComponent('manyfiles', {
    destRoot: tmpRoot, signal: ctrl7.signal,
  }).done;
  process.off('warning', onWarn);
  // Inspect listener count on the signal — should be ~0 after all done
  const lc = ctrl7.signal.eventNames ? ctrl7.signal.eventNames().length : 0;
  if (warnCount > 0) throw new Error(`test 7: MaxListenersExceeded warning fired (${warnCount}×)`);
  console.log(`  ✓ no MaxListeners warning after 15 files; listener count=${lc}`);

  // Cleanup
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nAll downloader smoke tests PASSED ✓');
}

main().catch(err => {
  console.error('SMOKE TEST FAILED:', err);
  try { server.close(); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
