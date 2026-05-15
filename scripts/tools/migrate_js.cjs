// migrate_js.cjs — Wizard Stage 10 file walker. JS port of migrate_memory.py
// envelope/walker logic (Python script kept in repo as documentation; JS is
// the runtime path because OSS bundles no Python). Used by dashboard.js
// /api/wizard/import/preview|run.
//
// Module exports:
//   walkFolder(rootPath, route)  → { envelopes, skipped, quarantined,
//                                     truncated_at_cap, total_bytes }
//   buildEnvelope(path, text, root)
//   FRONTMATTER_RE, SECRETS_PATTERNS, MAX_FILES_A, MAX_FILES_B_SOFT,
//   MAX_FILES_B_HARD, MAX_FILE_BYTES, MAX_BATCH_BYTES, MAX_L2_CHARS

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES_A = 1000;
const MAX_FILES_B_SOFT = 200;
const MAX_FILES_B_HARD = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 50 * 1024 * 1024;
const MAX_L2_CHARS = 8000;
const SKIP_NAME_TOKENS = new Set(['INBOX', 'QUEUE', '.PROCESSED', '.TMP']);
const ALLOWED_EXT = new Set(['.md', '.txt']);
// P36: walkFiles (explicit-file path) additionally accepts .docx via mammoth.
const ALLOWED_EXT_FILES = new Set(['.md', '.txt', '.docx']);
// P37 G3: whitelist of node_types accepted from frontmatter (mirrors
// engine.cjs _classifyNodeType branches). Unknown values fall back to the
// path-inferred heuristic so LLM/user typos can't pollute the schema.
const VALID_NODE_TYPES = new Set([
  'knowledge', 'identity', 'milestone', 'principle', 'social-rule',
  'language-template', 'conversation-insight', 'decision', 'experiment',
  'engineering', 'relationship', 'action', 'reading-note', 'diary',
  'introspection',
]);
// P37 G4: tag clamping. Each tag ≤32 chars, max 10 tags per node.
const MAX_TAG_LEN = 32;
const MAX_TAGS_PER_NODE = 10;
// P37 G6: encoding fallback kill-switch (default ON, `!== '0'`).
const ENCODING_FALLBACK_ON = String(process.env.ENGINE_IMPORT_ENCODING_FALLBACK || '').trim() !== '0';
// Lazy-load iconv-lite — only required when a non-UTF-8 file is detected.
let _iconvLite = null;
function _loadIconv() {
  if (_iconvLite) return _iconvLite;
  try { _iconvLite = require('iconv-lite'); }
  catch { _iconvLite = false; }
  return _iconvLite;
}
function _decodeWithFallback(buf) {
  const utf8 = buf.toString('utf8');
  // Replacement char count — a file with many U+FFFD chars almost certainly
  // wasn't UTF-8. Conservative threshold: 5+ replacements OR ratio > 0.5%.
  let replCount = 0;
  for (let i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xFFFD) replCount++;
  const ratio = utf8.length ? replCount / utf8.length : 0;
  if (replCount < 5 && ratio < 0.005) return { text: utf8, encoding: 'utf8' };
  if (!ENCODING_FALLBACK_ON) return { text: utf8, encoding: 'utf8' };
  const iconv = _loadIconv();
  if (!iconv || typeof iconv.decode !== 'function') return { text: utf8, encoding: 'utf8' };
  // Try common CJK encodings in order. The decoded text with the fewest
  // replacement chars wins (best-effort transcode).
  let best = { text: utf8, encoding: 'utf8', score: replCount };
  for (const enc of ['gbk', 'big5', 'shift_jis', 'euc-kr']) {
    let decoded;
    try { decoded = iconv.decode(buf, enc); }
    catch { continue; }
    let score = 0;
    for (let i = 0; i < decoded.length; i++) if (decoded.charCodeAt(i) === 0xFFFD) score++;
    if (score < best.score) best = { text: decoded, encoding: enc, score };
  }
  return best;
}

const SECRETS_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|OPENSSH|DSA|EC) PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /AIza[0-9A-Za-z\-_]{35}/,
];
// P1-c: catches `.env` renamed to `notes.txt`
const SECRET_KV_HEURISTIC = /^[A-Z_]{4,}=\S+/m;

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
const DATE_IN_PATH_RE = /(\d{4})-(\d{2})-(\d{2})/;

function fingerprint(text) {
  return crypto.createHash('sha256')
    .update(String(text || '').trim().toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function slugify(name) {
  const s = String(name || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s || 'untitled';
}

function proposedId(filePath, root) {
  const rel = path.relative(root, filePath);
  const noExt = rel.replace(/\.(md|txt)$/i, '');
  const parts = noExt.split(/[\\/]+/).filter(Boolean).map(slugify);
  const id = parts.join('-') || slugify(path.basename(filePath, path.extname(filePath)));
  return id.slice(0, 128);
}

function shouldSkipPath(filePath, root) {
  let rel;
  try { rel = path.relative(root, filePath); }
  catch { rel = path.basename(filePath); }
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('.')) return true;
    const stem = part.replace(/\.[^.]+$/, '').toUpperCase();
    if (SKIP_NAME_TOKENS.has(stem)) return true;
  }
  return false;
}

function isBinaryBuffer(buf) {
  const sniff = buf.slice(0, Math.min(8192, buf.length));
  for (let i = 0; i < sniff.length; i++) if (sniff[i] === 0) return true;
  return false;
}

function scanSecrets(text, headBytes) {
  const hits = [];
  for (const pat of SECRETS_PATTERNS) {
    if (pat.test(text)) hits.push(pat.source);
  }
  // P1-c content-sniff: catches .env renamed to .txt even without other patterns
  if (headBytes && SECRET_KV_HEURISTIC.test(headBytes)) hits.push('kv_assignment_heuristic');
  return hits;
}

function parseFrontmatter(text) {
  if (!text) return { fm: null, body: text };
  const stripped = text.replace(/^\uFEFF/, '');
  const m = FRONTMATTER_RE.exec(stripped);
  if (!m) return { fm: null, body: text };
  const raw = m[1];
  const body = stripped.slice(m[0].length);
  const fm = {};
  try {
    for (const line of raw.split(/\r?\n/)) {
      const s = line.replace(/\s+$/, '');
      const trimmed = s.replace(/^\s+/, '');
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!s.includes(':')) return { fm: null, body: text };
      const idx = s.indexOf(':');
      const key = s.slice(0, idx).trim();
      let value = s.slice(idx + 1).trim();
      if (!key) return { fm: null, body: text };
      if (value === '|' || value === '>') return { fm: null, body: text };
      if (value.startsWith('[') && !value.endsWith(']')) return { fm: null, body: text };
      if (value.startsWith('[') && value.endsWith(']')) {
        const items = [];
        for (let it of value.slice(1, -1).split(',')) {
          it = it.trim();
          if ((it.startsWith('"') && it.endsWith('"')) || (it.startsWith("'") && it.endsWith("'"))) {
            it = it.slice(1, -1);
          }
          if (it) items.push(it);
        }
        fm[key] = items;
      } else {
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        fm[key] = value;
      }
    }
    return { fm, body };
  } catch {
    return { fm: null, body: text };
  }
}

function inferKindFromPath(filePath, root) {
  let rel;
  try { rel = path.relative(root, filePath); }
  catch { rel = path.basename(filePath); }
  const parts = rel.split(/[\\/]+/).filter(Boolean).map(p => p.toLowerCase());
  const stemUpper = path.basename(filePath, path.extname(filePath)).toUpperCase();
  const has = (...needles) => parts.some(p => needles.includes(p));

  if (has('identity', 'soul-core', 'soul') || stemUpper.startsWith('SOUL') || stemUpper.startsWith('IDENTITY')) {
    return { node_type: 'identity', subkind: null, kind_tags: ['identity'] };
  }
  if (has('milestones', 'milestone') || stemUpper.startsWith('MILESTONE')) {
    return { node_type: 'milestone', subkind: null, kind_tags: ['milestone'] };
  }
  if (has('principles', 'principle') || stemUpper.startsWith('PRINCIPLE')) {
    return { node_type: 'principle', subkind: null, kind_tags: ['principle'] };
  }
  if (has('diary', 'journal', 'journals')) {
    return { node_type: 'knowledge', subkind: 'diary', kind_tags: ['diary'] };
  }
  if (has('relationships', 'relationship', 'people')) {
    return { node_type: 'knowledge', subkind: 'relationship', kind_tags: ['relationship'] };
  }
  if (has('reading', 'notes', 'reading-notes')) {
    return { node_type: 'knowledge', subkind: 'reading-note', kind_tags: ['reading-note'] };
  }
  return { node_type: 'knowledge', subkind: null, kind_tags: [] };
}

function extractEventAt(filePath, root, fm) {
  if (fm) {
    for (const key of ['event_at', 'date']) {
      const v = fm[key];
      if (v) {
        const s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
        if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return s;
      }
    }
  }
  let rel;
  try { rel = path.relative(root, filePath); }
  catch { rel = path.basename(filePath); }
  for (const part of rel.split(/[\\/]+/)) {
    const m = DATE_IN_PATH_RE.exec(part);
    if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
  }
  return null;
}

function buildEnvelope(filePath, text, root) {
  const { fm, body: bodyText } = parseFrontmatter(text);
  const heuristic = inferKindFromPath(filePath, root);
  let nodeType = heuristic.node_type;
  let subkind = heuristic.subkind;
  if (fm) {
    // P37 G3: only accept node_type values in the whitelist. Unknown values
    // fall back to the path-inferred heuristic.
    if (typeof fm.node_type === 'string' && VALID_NODE_TYPES.has(fm.node_type)) {
      nodeType = fm.node_type;
    }
    if (typeof fm.subkind === 'string') subkind = fm.subkind.slice(0, 64);
  }

  const id = proposedId(filePath, root);
  const trimmedBody = (bodyText || '').trim();
  const headLines = trimmedBody.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const defaultHead = (headLines[0] || path.basename(filePath, path.extname(filePath))).slice(0, 120);
  let l2 = trimmedBody;
  if (l2.length > MAX_L2_CHARS) l2 = l2.slice(0, MAX_L2_CHARS) + '\n\n[…truncated]';
  let l0 = defaultHead;
  let l1 = defaultHead;
  if (fm) {
    if (typeof fm.l0 === 'string') l0 = fm.l0.slice(0, 120);
    if (typeof fm.l1 === 'string') l1 = fm.l1.slice(0, 400);
    if (typeof fm.l2 === 'string') l2 = fm.l2.slice(0, MAX_L2_CHARS);
  }

  const seen = new Set();
  const tags = [];
  // P37 G4: clamp tag length to MAX_TAG_LEN and total tag count to
  // MAX_TAGS_PER_NODE. Heuristic + identity tags get priority — user
  // frontmatter tags fill the remainder.
  const add = t => {
    if (typeof t !== 'string') return;
    const trimmed = t.trim().slice(0, MAX_TAG_LEN);
    if (!trimmed || seen.has(trimmed)) return;
    if (tags.length >= MAX_TAGS_PER_NODE) return;
    seen.add(trimmed);
    tags.push(trimmed);
  };
  for (const t of heuristic.kind_tags) add(t);
  add('imported');
  add(`fp:${fingerprint(bodyText)}`);
  if (fm && Array.isArray(fm.tags)) for (const t of fm.tags) add(t);

  let tone = 'analytical';
  let source = 'imported';
  if (fm) {
    if (typeof fm.tone === 'string') tone = fm.tone;
    if (typeof fm.source === 'string') source = fm.source;
  }

  return {
    id,
    l0,
    l1,
    l2,
    tags,
    tone,
    source,
    node_type: nodeType,
    subkind,
    event_at: extractEventAt(filePath, root, fm),
    rawText: trimmedBody,
    relPath: path.relative(root, filePath),
    // P37 G5: full-content hash for cross-batch dedup (the fp: tag uses only
    // a 16-char prefix; this is the full SHA-256 hex used by the dedup pre-write
    // check in /api/wizard/import/run).
    import_content_hash: crypto.createHash('sha256')
      .update(String(bodyText || '').trim().toLowerCase(), 'utf8')
      .digest('hex'),
  };
}

/**
 * walkFolder — short-circuiting walker. Returns once the cap or batch-bytes
 * limit is hit; does not scan the rest of the tree (P1 — Q9 fix).
 */
function walkFolder(rootPath, route /* 'A'|'B' */) {
  const realRoot = fs.realpathSync(rootPath);
  const cap = route === 'B' ? MAX_FILES_B_HARD : MAX_FILES_A;
  const envelopes = [];
  const skipped = [];
  const quarantined = [];
  let cumulativeBytes = 0;
  let truncatedAtCap = false;

  function pushSkip(filePath, reason, extra = {}) {
    skipped.push({ path: filePath, reason, ...extra });
  }

  function visit(dir) {
    if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
      truncatedAtCap = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      pushSkip(dir, 'unreadable_dir', { error: e.message });
      return;
    }
    for (const entry of entries) {
      if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
        truncatedAtCap = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.')) {
        pushSkip(full, 'dot_entry');
        continue;
      }
      if (entry.isSymbolicLink()) {
        // P1-b: only follow if target stays inside realRoot
        let real;
        try { real = fs.realpathSync(full); }
        catch { pushSkip(full, 'broken_symlink'); continue; }
        if (!real.startsWith(realRoot + path.sep) && real !== realRoot) {
          pushSkip(full, 'path_traversal');
          continue;
        }
        let st;
        try { st = fs.statSync(real); }
        catch { pushSkip(full, 'unreadable'); continue; }
        if (st.isDirectory()) { visit(real); continue; }
        if (!st.isFile()) { pushSkip(full, 'not_a_file'); continue; }
        processFile(real);
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (entry.isFile()) processFile(full);
      else pushSkip(full, 'not_a_file');
    }
  }

  function processFile(filePath) {
    if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
      truncatedAtCap = true;
      return;
    }
    if (shouldSkipPath(filePath, realRoot)) {
      pushSkip(filePath, 'skip_token');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      pushSkip(filePath, 'extension_not_allowed', { ext });
      return;
    }
    let realFile;
    try { realFile = fs.realpathSync(filePath); }
    catch { pushSkip(filePath, 'unreadable'); return; }
    // P1-b: strict prefix check — symlink target must remain in tree
    if (!realFile.startsWith(realRoot + path.sep) && realFile !== realRoot) {
      pushSkip(filePath, 'path_traversal');
      return;
    }
    let stat;
    try { stat = fs.statSync(realFile); }
    catch { pushSkip(filePath, 'unreadable'); return; }
    if (stat.size > MAX_FILE_BYTES) {
      pushSkip(filePath, 'oversize', { size: stat.size });
      return;
    }
    let buf;
    try { buf = fs.readFileSync(realFile); }
    catch { pushSkip(filePath, 'unreadable'); return; }
    if (isBinaryBuffer(buf)) {
      pushSkip(filePath, 'binary');
      return;
    }
    // P37 G6: encoding fallback. UTF-8 first, then CJK encodings if the
    // UTF-8 decode produces a high replacement-char count (legacy GBK / Big5
    // / Shift_JIS / EUC-KR notes).
    const decoded = _decodeWithFallback(buf);
    const text = decoded.text.replace(/^\uFEFF/, '');
    const head = buf.slice(0, Math.min(256, buf.length)).toString('utf8');
    const hits = scanSecrets(text, head);
    if (hits.length) {
      quarantined.push({ path: filePath, patterns: hits });
      return;
    }
    let envelope;
    try { envelope = buildEnvelope(filePath, text, realRoot); }
    catch (e) { pushSkip(filePath, 'envelope_error', { error: e.message }); return; }
    envelopes.push(envelope);
    cumulativeBytes += stat.size;
    if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
      truncatedAtCap = true;
    }
  }

  visit(realRoot);

  return { envelopes, skipped, quarantined, truncated_at_cap: truncatedAtCap, total_bytes: cumulativeBytes };
}

// P36: walkFilesAsync — explicit-file companion to walkFolder. Used when the
// user drag-drops or multi-selects files rather than picking a folder. The
// envelopes/skipped/quarantined shape mirrors walkFolder so dashboard.js can
// branch on the input alone. `.docx` files are decoded with mammoth (raw text
// extraction); `.md`/`.txt` go through the same heuristic path as walkFolder.
//
// `rootPath` is used as the relative-path base for proposedId() so the
// engine-inbox copy directory yields stable, deterministic node IDs across
// re-imports. If absent, falls back to common-parent of the file set.
async function walkFilesAsync(filePaths, route, rootPath) {
  const cap = route === 'B' ? MAX_FILES_B_HARD : MAX_FILES_A;
  const envelopes = [];
  const skipped = [];
  const quarantined = [];
  let cumulativeBytes = 0;
  let truncatedAtCap = false;

  let root = rootPath;
  if (!root) {
    if (filePaths.length === 1) root = path.dirname(filePaths[0]);
    else {
      const dirs = filePaths.map((p) => path.dirname(p).split(path.sep));
      const minLen = Math.min(...dirs.map((d) => d.length));
      const common = [];
      for (let i = 0; i < minLen; i++) {
        const tok = dirs[0][i];
        if (dirs.every((d) => d[i] === tok)) common.push(tok);
        else break;
      }
      root = common.join(path.sep) || path.dirname(filePaths[0]);
    }
  }
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch { realRoot = root; }

  let mammothModule = null;
  function _loadMammoth() {
    if (mammothModule !== null) return mammothModule;
    try { mammothModule = require('mammoth'); }
    catch { mammothModule = false; }
    return mammothModule;
  }

  for (const filePath of filePaths) {
    if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
      truncatedAtCap = true;
      break;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_EXT_FILES.has(ext)) {
      skipped.push({ path: filePath, reason: 'extension_not_allowed', ext });
      continue;
    }
    let realFile;
    try { realFile = fs.realpathSync(filePath); }
    catch { skipped.push({ path: filePath, reason: 'unreadable' }); continue; }
    let stat;
    try { stat = fs.statSync(realFile); }
    catch { skipped.push({ path: filePath, reason: 'unreadable' }); continue; }
    if (!stat.isFile()) { skipped.push({ path: filePath, reason: 'not_a_file' }); continue; }
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push({ path: filePath, reason: 'oversize', size: stat.size });
      continue;
    }
    let buf;
    try { buf = fs.readFileSync(realFile); }
    catch { skipped.push({ path: filePath, reason: 'unreadable' }); continue; }

    let text, head;
    if (ext === '.docx') {
      const mammoth = _loadMammoth();
      if (!mammoth || typeof mammoth.extractRawText !== 'function') {
        skipped.push({ path: filePath, reason: 'docx_unavailable' });
        continue;
      }
      try {
        const r = await mammoth.extractRawText({ buffer: buf });
        text = String(r?.value || '').replace(/^\uFEFF/, '');
        head = text.slice(0, 256);
      } catch (e) {
        skipped.push({ path: filePath, reason: 'docx_extract_failed', error: e.message });
        continue;
      }
    } else {
      if (isBinaryBuffer(buf)) {
        skipped.push({ path: filePath, reason: 'binary' });
        continue;
      }
      const decoded = _decodeWithFallback(buf);
      text = decoded.text.replace(/^\uFEFF/, '');
      head = buf.slice(0, Math.min(256, buf.length)).toString('utf8');
    }

    const hits = scanSecrets(text, head);
    if (hits.length) {
      quarantined.push({ path: filePath, patterns: hits });
      continue;
    }
    let envelope;
    try { envelope = buildEnvelope(filePath, text, realRoot); }
    catch (e) { skipped.push({ path: filePath, reason: 'envelope_error', error: e.message }); continue; }
    envelopes.push(envelope);
    cumulativeBytes += stat.size;
    if (envelopes.length >= cap || cumulativeBytes >= MAX_BATCH_BYTES) {
      truncatedAtCap = true;
    }
  }
  return { envelopes, skipped, quarantined, truncated_at_cap: truncatedAtCap, total_bytes: cumulativeBytes };
}

module.exports = {
  walkFolder,
  walkFilesAsync,
  buildEnvelope,
  parseFrontmatter,
  inferKindFromPath,
  extractEventAt,
  proposedId,
  fingerprint,
  scanSecrets,
  shouldSkipPath,
  FRONTMATTER_RE,
  SECRETS_PATTERNS,
  MAX_FILES_A,
  MAX_FILES_B_SOFT,
  MAX_FILES_B_HARD,
  MAX_FILE_BYTES,
  MAX_BATCH_BYTES,
  MAX_L2_CHARS,
  VALID_NODE_TYPES,
  MAX_TAG_LEN,
  MAX_TAGS_PER_NODE,
  ALLOWED_EXT_FILES,
};
