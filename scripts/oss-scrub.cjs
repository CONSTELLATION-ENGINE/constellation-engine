#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// OSS Scrub Transform — applies rules.json scrub patterns to source tree

const fs = require('fs');
const path = require('path');

// Built-in recursive walk — avoids extra dependency on 'glob' package.
// Requires Node >= 20 for { recursive: true } on readdirSync.
function listFiles(rootDir, ignoreRe) {
  return fs.readdirSync(rootDir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => {
      const parent = d.parentPath || d.path || rootDir;
      const rel = path.relative(rootDir, path.join(parent, d.name));
      return rel.split(path.sep).join('/');
    })
    .filter(rel => !ignoreRe.test(rel));
}

const RULES_FILE = path.join(__dirname, 'oss-scrub-rules.json');
const SOURCE_DIR = process.argv[2] || '.';

let rules;
try {
  const rulesText = fs.readFileSync(RULES_FILE, 'utf8');
  rules = JSON.parse(rulesText);
} catch (err) {
  console.error(`Failed to load scrub rules from ${RULES_FILE}:`, err.message);
  process.exit(1);
}

function globToRegex(glob) {
  // Two-pass conversion: tokenize glob specials, escape regex metas, restitute.
  // Uses sentinel codepoints (U+E000..U+E007 Private Use Area) that won't appear in paths.
  let s = glob;

  // Pass 1: brace expansion {a,b,c} -> alternation tokens
  s = s.replace(/\{([^{}]+)\}/g, (_, group) =>
    '\uE000' + group.split(',').map(p => p.trim()).join('\uE001') + '\uE002');

  // Pass 2: glob wildcards -> placeholder tokens (longest-first)
  s = s
    .replace(/\*\*\//g, '\uE003')   // **/  -> zero-or-more path segments
    .replace(/\*\*/g,   '\uE004')   // **   -> any chars including /
    .replace(/\*/g,     '\uE005')   // *    -> any non-/ chars
    .replace(/\?/g,     '\uE006');  // ?    -> single non-/ char

  // Pass 3: escape regex special chars in literal portions
  s = s.replace(/[.+^$\\(){}\[\]|]/g, '\\$&');

  // Pass 4: substitute placeholders back to regex
  s = s
    .replace(/\uE000/g, '(?:')
    .replace(/\uE001/g, '|')
    .replace(/\uE002/g, ')')
    .replace(/\uE003/g, '(?:.*/)?')
    .replace(/\uE004/g, '.*')
    .replace(/\uE005/g, '[^/]*')
    .replace(/\uE006/g, '[^/]');

  return s;
}

function matchesScope(filePath, scopes) {
  return scopes.some(scope => {
    const regex = new RegExp(`^${globToRegex(scope)}$`);
    return regex.test(filePath);
  });
}

function applyRules(content, filePath) {
  let modified = content;
  let violations = [];

  // Pass 1: apply all replacements
  for (const rule of rules.rules || []) {
    if (!matchesScope(filePath, rule.scope)) continue;
    const regex = new RegExp(rule.pattern, 'g');
    modified = modified.replace(regex, rule.replace);
  }

  // Pass 2: verify no `severity:block` pattern still survives.
  // (A surviving block pattern means the rule was mis-configured or a longer
  // rule consumed part of it before the block rule ran.)
  for (const rule of rules.rules || []) {
    if (rule.severity !== 'block') continue;
    if (!matchesScope(filePath, rule.scope)) continue;
    const regex = new RegExp(rule.pattern, 'g');
    if (regex.test(modified)) {
      violations.push(`[BLOCK] ${rule.id}: ${rule.reason}`);
    }
  }

  return { modified, violations };
}

// AGPL header rendering — OSS-folder copies only, never back-edit main.
// Idempotent: re-running on a stamped file is a no-op.
const HEADERABLE_EXT_RE = /\.(?:js|cjs|mjs|py|sh|sql)$/;
const AGPL_PRESENT_RE = /SPDX-License-Identifier:\s*AGPL-3\.0-or-later/;
const SHEBANG_RE = /^#!/;

function commentPrefixFor(filePath) {
  if (/\.(?:js|cjs|mjs)$/.test(filePath)) return '// ';
  if (/\.(?:py|sh)$/.test(filePath)) return '# ';
  if (/\.sql$/.test(filePath)) return '-- ';
  return null;
}

function applyHeader(content, filePath) {
  if (!HEADERABLE_EXT_RE.test(filePath)) return content;
  if (AGPL_PRESENT_RE.test(content)) return content;

  const prefix = commentPrefixFor(filePath);
  if (!prefix) return content;

  const headerLine = `${prefix}SPDX-License-Identifier: AGPL-3.0-or-later\n`;

  // Strip optional UTF-8 BOM so it can be re-emitted at the very front
  // (otherwise inserting before the BOM corrupts shebang execution and
  // a header inserted after a shebang would land between BOM and #!).
  let bom = '';
  let body = content;
  if (body.charCodeAt(0) === 0xFEFF) {
    bom = '\uFEFF';
    body = body.slice(1);
  }

  // Shebang-aware: keep #! on line 1 (after any BOM).
  const firstNewline = body.indexOf('\n');
  if (firstNewline !== -1 && SHEBANG_RE.test(body.slice(0, firstNewline))) {
    return bom + body.slice(0, firstNewline + 1) + headerLine + body.slice(firstNewline + 1);
  }
  return bom + headerLine + body;
}

function checkAssertions(content, filePath) {
  const failures = [];

  for (const assertion of rules.positive_assertions || []) {
    if (!matchesScope(filePath, assertion.scope)) continue;

    const regex = new RegExp(assertion.pattern);
    if (!regex.test(content)) {
      failures.push(`[ASSERT] ${assertion.id}: missing required pattern in ${filePath}`);
    }
  }

  return failures;
}

// Walk source tree (skip vendor / runtime / VCS dirs)
// Match vendor/runtime dirs at any depth (e.g. electron/node_modules), not just top-level.
// Also excludes the rules file itself (self-reference would re-trigger sentinel rules).
const IGNORE_RE = /(?:^|\/)(?:node_modules|\.git|venv|data|logs|tmp|temp|dist|build|coverage)\/|(?:^|\/)[^\/]+\.(?:db|db-shm|db-wal|log)$|\.bak$|\.backup$|^scripts\/oss-scrub-rules\.json$/;
const files = listFiles(SOURCE_DIR, IGNORE_RE);

// Binary extensions — read+write as utf8 silently corrupts these (U+FFFD substitution).
// Skipped entirely: scrub patterns wouldn't match binary bytes anyway, and a write back
// after the `modified !== content` guard would only happen if a future rule accidentally
// matched random bytes — better to never read them as utf8 in the first place.
const BINARY_EXT_RE = /\.(?:png|jpg|jpeg|gif|ico|webp|woff2?|ttf|otf|eot|zip|pdf|mp[34]|wasm|wav|ogg|tar|gz|bz2|xz|7z)$/i;

let totalViolations = [];
let totalAssertions = [];

for (const file of files) {
  if (BINARY_EXT_RE.test(file)) continue;

  const filePath = path.join(SOURCE_DIR, file);

  try {
    let content = fs.readFileSync(filePath, 'utf8');
    const { modified: scrubbed, violations } = applyRules(content, file);
    const modified = applyHeader(scrubbed, file);

    if (violations.length > 0) {
      totalViolations.push(...violations.map(v => `${file}: ${v}`));
    }

    const assertions = checkAssertions(modified, file);
    totalAssertions.push(...assertions);

    if (modified !== content) {
      console.log(`[SCRUB] ${file}`);
      fs.writeFileSync(filePath, modified, 'utf8');
    }
  } catch (err) {
    if (err.code !== 'EISDIR') {
      console.warn(`[SKIP] ${file}: ${err.message}`);
    }
  }
}

if (totalViolations.length > 0) {
  console.error('\n❌ Scrub rule violations:');
  totalViolations.forEach(v => console.error(`  ${v}`));
  process.exit(1);
}

if (totalAssertions.length > 0) {
  console.error('\n❌ Assertion failures:');
  totalAssertions.forEach(a => console.error(`  ${a}`));
  process.exit(1);
}

console.log(`✓ Scrub complete. Processed ${files.length} files.`);
