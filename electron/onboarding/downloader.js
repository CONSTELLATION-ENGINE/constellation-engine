// SPDX-License-Identifier: AGPL-3.0-or-later
// Constellation Engine — Stage 2 component downloader.
//
// Sequential mirror failover per Planning MD §22.7:
//   HuggingFace → HF mirror → ModelScope (per-file).
//   On HTTP error or SHA-256 mismatch: delete .part, advance mirror.
//   All mirrors fail → reject ALL_MIRRORS_FAILED (UI surfaces manual download).
//
// Per-file resume via HTTP Range against `<dest>.part`. If the server
// answers 200 instead of 206, the .part is truncated and the file restarts.
// SHA-256 'TODO_FILL_AT_RELEASE' values are honored only when the env knob
// CONSTELLATION_SKIP_CHECKSUM=1 is set; release lint must reject them in prod.

const fs       = require('node:fs');
const path     = require('node:path');
const https    = require('node:https');
const http     = require('node:http');
const crypto   = require('node:crypto');
const { URL }  = require('node:url');
const { EventEmitter } = require('node:events');

const MAX_REDIRECTS = 5;
const PROGRESS_THROTTLE_MS = 250;
const RECONNECT_BACKOFF_MS = [500, 2000, 5000];     // 3 attempts per mirror

let manifestCache = null;

function loadManifest() {
  if (manifestCache) return manifestCache;
  const raw = fs.readFileSync(path.join(__dirname, 'mirrors.json'), 'utf-8');
  manifestCache = JSON.parse(raw);
  return manifestCache;
}

function getComponent(componentId) {
  const m = loadManifest();
  const c = m.components[componentId];
  if (!c) throw new Error(`unknown component: ${componentId}`);
  return c;
}

// ─── File-list resolution (handles `platforms` for sqlite-vec) ─────────
function resolveFiles(component) {
  let files;
  if (component.files) files = component.files;
  else if (component.platforms) {
    const key = `${process.platform}-${process.arch}`;
    const p = component.platforms[key];
    if (!p) {
      const supported = Object.keys(component.platforms).join(', ');
      throw new Error(`platform ${key} not in mirror manifest (supported: ${supported})`);
    }
    files = p.files;
  } else {
    throw new Error('component has neither files nor platforms');
  }
  // Defense in depth: reject any file path that could escape destDir.
  for (const f of files) {
    if (!f || typeof f.path !== 'string') throw new Error('file entry missing path');
    if (f.path.includes('..') || path.isAbsolute(f.path) || f.path.startsWith('/') || f.path.startsWith('\\')) {
      throw new Error(`rejected unsafe file path in manifest: ${f.path}`);
    }
  }
  return files;
}

// ─── HEAD-less streaming GET with Range resume ─────────────────────────
function followingGet(rawUrl, headers, redirectsLeft, onResponse, onError) {
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { return onError(e); }

  const lib = parsed.protocol === 'http:' ? http : https;
  const req = lib.get({
    hostname: parsed.hostname,
    port:     parsed.port || undefined,
    path:     parsed.pathname + parsed.search,
    headers:  { 'User-Agent': 'constellation-onboarding/1', ...headers },
    timeout:  30_000,
  }, (res) => {
    const sc = res.statusCode || 0;
    if (sc >= 300 && sc < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) return onError(new Error('too many redirects'));
      const next = new URL(res.headers.location, rawUrl).toString();
      return followingGet(next, headers, redirectsLeft - 1, onResponse, onError);
    }
    onResponse(res, req);
  });

  req.on('timeout', () => { req.destroy(new Error('request timeout')); });
  req.on('error',   onError);
  return req;
}

// ─── Single-file download with resume + checksum ───────────────────────
async function downloadFile({ url, destPath, sha256, signal, allowSkipChecksum, onChunk }) {
  const partPath = destPath + '.part';
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Existing .part → resume offset
  let offset = 0;
  try { offset = fs.statSync(partPath).size; } catch {}

  // If file fully present + skip-checksum, treat as done (idempotent restarts)
  if (allowSkipChecksum) {
    try {
      if (fs.existsSync(destPath)) return { skipped: true, reason: 'exists' };
    } catch {}
  }

  const headers = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  return await new Promise((resolve, reject) => {
    let aborted = false;
    let settled = false;
    let lastChunkAt = Date.now();
    let stallTimer = null;
    const settle = (fn, val) => { if (settled) return; settled = true; cleanup(); fn(val); };
    const onAbort = () => {
      aborted = true;
      try { req && req.destroy(new Error('aborted')); } catch {}
      settle(reject, Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    };
    const cleanup = () => {
      if (signal) try { signal.removeEventListener('abort', onAbort); } catch {}
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);   // removed in cleanup() — { once:true } would still leak across retries
    }

    // Verify the .part as-is (used by both happy path and 416 short-circuit)
    const verifyAndCommit = async (finalSize, totalBytes) => {
      if (totalBytes && finalSize !== totalBytes) {
        // Disk-fail-class errors must surface; ENOSPC is also caught upstream
        return settle(reject, Object.assign(
          new Error(`size mismatch: expected ${totalBytes}, got ${finalSize}`),
          { code: 'SIZE_MISMATCH' }));
      }
      const isPlaceholder = !sha256 || /^TODO_/.test(sha256);
      if (isPlaceholder && !allowSkipChecksum) {
        // Distinct code so caller can short-circuit failover
        return settle(reject, Object.assign(
          new Error(`SHA-256 placeholder for ${path.basename(destPath)} — release manifest unsealed`),
          { code: 'CHECKSUM_PLACEHOLDER' }));
      }
      if (!isPlaceholder) {
        try {
          const actual = await sha256OfFile(partPath);
          if (actual !== sha256.toLowerCase()) {
            try { fs.unlinkSync(partPath); } catch {}
            return settle(reject, Object.assign(
              new Error(`SHA-256 mismatch (expected ${sha256.slice(0,12)}…, got ${actual.slice(0,12)}…)`),
              { code: 'CHECKSUM_FAIL' }));
          }
        } catch (e) { return settle(reject, e); }
      } else {
        // skip-checksum mode: emit a WARN so it's never silent
        process.stderr.write(`[downloader] WARN: checksum skipped for ${destPath} (CONSTELLATION_SKIP_CHECKSUM=1)\n`);
      }
      try { fs.renameSync(partPath, destPath); }
      catch (e) { return settle(reject, e); }
      settle(resolve, { ok: true, bytes: finalSize });
    };

    const req = followingGet(url, headers, MAX_REDIRECTS, async (res) => {
      const sc = res.statusCode || 0;

      // 416 Range Not Satisfiable → likely .part is already complete from a prior run
      if (sc === 416 && offset > 0) {
        res.resume();
        try {
          const sz = fs.statSync(partPath).size;
          // Use existing .part as the final body and verify
          return verifyAndCommit(sz, sz);
        } catch (e) {
          try { fs.unlinkSync(partPath); } catch {}
          return settle(reject, Object.assign(
            new Error(`416 with stale .part: ${e.message}`), { code: 'PART_STALE' }));
        }
      }

      // Server doesn't honor Range — discard .part and restart this file.
      if (offset > 0 && sc === 200) {
        try { fs.unlinkSync(partPath); } catch {}
        offset = 0;
      } else if (offset > 0 && sc !== 206) {
        res.resume();
        return settle(reject, new Error(`expected 206 got ${sc}`));
      } else if (offset === 0 && sc !== 200) {
        res.resume();
        return settle(reject, new Error(`HTTP ${sc} for ${url}`));
      }

      // Total bytes for this transfer (from Content-Range when 206, else Content-Length)
      let totalBytes = 0;
      if (sc === 206) {
        const cr = res.headers['content-range'] || '';      // e.g. bytes 1024-12345/12346
        const m = cr.match(/\/(\d+)$/);
        if (m) totalBytes = parseInt(m[1], 10);
        // Defense: validate the 206's start matches our requested offset; some
        // CDNs redirect to a pre-signed URL that drops Range and replies 206
        // from byte 0 → appending would silently corrupt.
        const startMatch = cr.match(/bytes\s+(\d+)-/);
        if (startMatch && parseInt(startMatch[1], 10) !== offset) {
          res.resume();
          return settle(reject, new Error(`Content-Range start ${startMatch[1]} != offset ${offset}`));
        }
      } else {
        totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      }

      const sink = fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' });
      let received = offset;

      // Stall watchdog: if no bytes arrive for 30s, kill the request.
      stallTimer = setInterval(() => {
        if (Date.now() - lastChunkAt > 30_000) {
          try { req.destroy(new Error('stalled')); } catch {}
        }
      }, 5_000);

      res.on('data', (chunk) => {
        received += chunk.length;
        lastChunkAt = Date.now();
        if (onChunk) onChunk({ received, total: totalBytes });
      });

      res.pipe(sink);

      sink.on('error', (err) => { try { req.destroy(); } catch {} ; settle(reject, err); });
      res.on('error',  (err) => { try { sink.destroy(); } catch {} ; settle(reject, err); });

      sink.on('finish', async () => {
        if (aborted) return;
        let finalSize = 0;
        try { finalSize = fs.statSync(partPath).size; }
        catch (e) { return settle(reject, e); }
        await verifyAndCommit(finalSize, totalBytes);
      });
    }, (err) => settle(reject, err));
  });
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath, { highWaterMark: 5 * 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ─── Component-level orchestration: sequential mirror failover ─────────
function downloadComponent(componentId, { destRoot, signal, allowSkipChecksum, mirrorOverride } = {}) {
  const emitter = new EventEmitter();
  const manifest = loadManifest();
  const component = getComponent(componentId);
  const files = resolveFiles(component);
  const mirrors = component.mirrors;
  const root = destRoot || process.cwd();
  const allowSkip = allowSkipChecksum != null
    ? allowSkipChecksum
    : process.env.CONSTELLATION_SKIP_CHECKSUM === '1';

  // Promise the caller can await; events stream over the emitter
  emitter.done = (async () => {
    const startedAt = Date.now();
    let mirrorIdx = mirrorOverride != null
      ? Math.max(0, Math.min(mirrors.length - 1, mirrorOverride))
      : 0;
    let bytesAcrossFiles = 0;
    const totalApprox = component.approxBytes || 0;

    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      const destPath = path.join(root, component.destDir, f.path);

      // Idempotent: skip if already present and verified (or skip-checksum mode)
      if (fs.existsSync(destPath)) {
        const isPlaceholder = !f.sha256 || /^TODO_/.test(f.sha256);
        if (isPlaceholder || allowSkip) {
          bytesAcrossFiles += fileSizeOrZero(destPath);
          emitter.emit('file:done', { component: componentId, file: f.path, skipped: true });
          continue;
        }
        const actual = await sha256OfFile(destPath);
        if (actual === f.sha256.toLowerCase()) {
          bytesAcrossFiles += fileSizeOrZero(destPath);
          emitter.emit('file:done', { component: componentId, file: f.path, skipped: true });
          continue;
        }
        // Stale/corrupt — delete and re-download
        try { fs.unlinkSync(destPath); } catch {}
      }

      let lastErr = null;
      let success = false;

      for (let attempt = 0; attempt < mirrors.length; attempt++) {
        const idx = (mirrorIdx + attempt) % mirrors.length;
        const mirror = mirrors[idx];
        const url = mirror.baseUrl + f.path;

        emitter.emit('file:start', {
          component: componentId, file: f.path, mirror: mirror.name,
          fileIndex: fi, fileCount: files.length,
        });

        let lastEmit = 0;
        let lastReceived = 0;
        let lastSpeedAt = Date.now();
        const onChunk = ({ received, total }) => {
          const now = Date.now();
          if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
          const dt = (now - lastSpeedAt) / 1000;
          const dBytes = received - lastReceived;
          const speed = dt > 0 ? dBytes / dt : 0;       // bytes/s
          const remaining = total > received ? (total - received) : 0;
          const eta = speed > 0 ? remaining / speed : 0;
          emitter.emit('progress', {
            component: componentId,
            file: f.path,
            mirror: mirror.name,
            received,
            total,
            speed,
            eta,
            componentReceived: bytesAcrossFiles + received,
            componentTotal: totalApprox,
          });
          lastEmit = now;
          lastReceived = received;
          lastSpeedAt = now;
        };

        try {
          const r = await downloadFile({
            url, destPath, sha256: f.sha256, signal,
            allowSkipChecksum: allowSkip, onChunk,
          });
          bytesAcrossFiles += (r.bytes || 0);
          emitter.emit('file:done', {
            component: componentId, file: f.path, mirror: mirror.name, skipped: !!r.skipped,
          });
          mirrorIdx = idx;       // sticky preference
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          if (err && err.code === 'ABORTED') {
            emitter.emit('aborted', { component: componentId });
            throw err;
          }
          // Manifest / disk-class errors must NOT advance mirrors — failover
          // would just burn 3 attempts on the same root cause and surface as
          // a network error to the user.
          if (err && (err.code === 'CHECKSUM_PLACEHOLDER'
                   || (err.cause && err.cause.code === 'ENOSPC')
                   || /ENOSPC|EROFS|EACCES|EPERM/.test(String(err.code || err.message)))) {
            emitter.emit('component:fail', {
              component: componentId, error: err.message, code: err.code,
            });
            throw err;
          }
          emitter.emit('mirror:fail', {
            component: componentId, file: f.path, mirror: mirror.name,
            error: err.message, code: err.code,
          });
          // Always nuke .part on failure so the next mirror starts clean
          try { fs.unlinkSync(destPath + '.part'); } catch {}
        }
      }

      if (!success) {
        const e = Object.assign(
          new Error(`all mirrors failed for ${componentId}/${f.path}: ${lastErr && lastErr.message}`),
          { code: 'ALL_MIRRORS_FAILED', component: componentId, file: f.path });
        emitter.emit('component:fail', { component: componentId, error: e.message });
        throw e;
      }
    }

    const durationMs = Date.now() - startedAt;
    emitter.emit('component:done', { component: componentId, durationMs, bytes: bytesAcrossFiles });
    return { ok: true, durationMs, bytes: bytesAcrossFiles };
  })();

  return emitter;
}

function fileSizeOrZero(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// ─── Helpers exposed to wizard / IPC layer ─────────────────────────────
function listComponents() {
  const m = loadManifest();
  return Object.entries(m.components).map(([id, c]) => ({
    id,
    displayName: c.displayName,
    approxBytes: c.approxBytes || 0,
    mirrors: c.mirrors.map(x => x.name),
  }));
}

function isComponentInstalled(componentId, destRoot) {
  const root = destRoot || process.cwd();
  try {
    const c = getComponent(componentId);
    const files = resolveFiles(c);
    return files.every(f => fs.existsSync(path.join(root, c.destDir, f.path)));
  } catch { return false; }
}

module.exports = {
  loadManifest,
  listComponents,
  isComponentInstalled,
  downloadComponent,
  // exported for tests
  _internal: { sha256OfFile, downloadFile, resolveFiles },
};
