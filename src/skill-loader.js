// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * skill-loader.js — External skills interface (Phase 1, Markdown-only)
 *
 * Scans skill directories and registers each qualifying SKILL.md as a tool
 * via ToolManager. The model invokes a skill the same way it invokes any
 * other tool; on call we return the SKILL.md body as the tool_result
 * (progressive disclosure — the small description sells the skill, the body
 * is fetched on demand).
 *
 * Phase 1 scope:
 *   - Pure SKILL.md only (no scripts/ execution)
 *   - YAML frontmatter parsed inline (name, description, keywords,
 *     user-invocable, disable-model-invocation, requires)
 *   - Pre-flight `requires` checks (env vars, binaries on PATH, files)
 *   - Two scan roots:
 *       1. <homedir>/.constellation/skills/   (user-installed, takes priority)
 *       2. <projectRoot>/skills/              (bundled with engine)
 *
 * Tool naming: skill_<sanitized-skill-name> (avoids collisions with built-ins).
 *
 * @module skill-loader
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Minimal YAML frontmatter parser with indent-based nesting. Supports:
 *   key: value                          (scalar)
 *   key: [a, b, c]                      (inline list)
 *   key:                                (block — children indented further)
 *     - item                            (list child)
 *     subkey: val                       (map child, may itself be a block)
 *
 * Not a full YAML parser. Designed for SKILL.md frontmatter shape.
 */
function coerceScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => coerceScalar(s)).filter(s => s !== '');
  }
  return v;
}

function parseFrontmatter(text) {
  const allLines = text.split(/\r?\n/);
  const lines = [];
  for (const ln of allLines) {
    if (!ln.trim() || ln.trim().startsWith('#')) continue;
    lines.push(ln);
  }
  if (lines.length === 0) return {};

  const indentOf = (ln) => ln.match(/^(\s*)/)[1].length;

  function parseBlock(startIdx, baseIndent) {
    const map = {};
    const list = [];
    let i = startIdx;
    while (i < lines.length) {
      const line = lines[i];
      const indent = indentOf(line);
      if (indent < baseIndent) break;
      if (indent > baseIndent) { i++; continue; } // defensive — shouldn't happen
      const body = line.slice(indent);

      if (body.startsWith('- ')) {
        list.push(coerceScalar(body.slice(2)));
        i++;
        continue;
      }

      const km = body.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      if (!km) { i++; continue; }
      const key = km[1];
      const val = km[2];

      if (val.trim() !== '') {
        map[key] = coerceScalar(val);
        i++;
        continue;
      }

      // Empty value — peek next line for deeper indent (nested block)
      if (i + 1 < lines.length && indentOf(lines[i + 1]) > baseIndent) {
        const childIndent = indentOf(lines[i + 1]);
        const sub = parseBlock(i + 1, childIndent);
        map[key] = sub.value;
        i = sub.nextIdx;
      } else {
        map[key] = '';
        i++;
      }
    }
    const value = list.length > 0 ? list : map;
    return { value, nextIdx: i };
  }

  return parseBlock(0, indentOf(lines[0])).value;
}

/**
 * Run pre-flight `requires` checks. Returns { ok, reason }.
 *   requires:
 *     env:   [ENGINE_OWNER_SCOPE, OPENAI_API_KEY]
 *     bins:  [git, jq]
 *     files: [./config.json]
 */
async function checkRequires(requires, skillDir) {
  if (!requires || typeof requires !== 'object') return { ok: true };

  const env = Array.isArray(requires.env) ? requires.env : [];
  for (const name of env) {
    if (!process.env[name]) return { ok: false, reason: `missing env ${name}` };
  }

  const bins = Array.isArray(requires.bins) ? requires.bins : [];
  for (const bin of bins) {
    try {
      await execFileAsync('which', [bin], { timeout: 2000 });
    } catch {
      return { ok: false, reason: `missing binary ${bin} on PATH` };
    }
  }

  const files = Array.isArray(requires.files) ? requires.files : [];
  for (const f of files) {
    const abs = f.startsWith('/') ? f : resolve(skillDir, f);
    if (!existsSync(abs)) return { ok: false, reason: `missing file ${f}` };
  }

  return { ok: true };
}

/**
 * Discover skill directories under a root. Each direct subdirectory containing
 * a SKILL.md is considered one skill.
 */
async function discoverSkillDirs(root) {
  if (!existsSync(root)) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, 'SKILL.md'))) out.push(dir);
  }
  return out;
}

/**
 * Load a single skill from its directory. Returns { ok, skill, reason }.
 */
async function loadSkill(skillDir) {
  const path = join(skillDir, 'SKILL.md');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return { ok: false, reason: `read failed: ${err.message}` };
  }

  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { ok: false, reason: 'no YAML frontmatter found' };

  let meta;
  try {
    meta = parseFrontmatter(m[1]);
  } catch (err) {
    return { ok: false, reason: `frontmatter parse failed: ${err.message}` };
  }
  const body = m[2] || '';

  if (!meta.name || typeof meta.name !== 'string') {
    return { ok: false, reason: 'frontmatter missing `name`' };
  }
  if (!NAME_RE.test(meta.name)) {
    return { ok: false, reason: `invalid name "${meta.name}" (lowercase, [a-z0-9_-], <=48 chars)` };
  }
  if (!meta.description || typeof meta.description !== 'string') {
    return { ok: false, reason: 'frontmatter missing `description`' };
  }

  const requiresCheck = await checkRequires(meta.requires, skillDir);
  if (!requiresCheck.ok) return { ok: false, reason: `requires unmet — ${requiresCheck.reason}` };

  return {
    ok: true,
    skill: {
      name: meta.name,
      description: meta.description.trim(),
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      user: meta['user-invocable'] !== false,
      modelInvocable: meta['disable-model-invocation'] !== true,
      body: body.trimStart(),
      dir: skillDir,
    },
  };
}

/**
 * Public entry point. Scans skill roots, registers qualifying skills as
 * tools on the given ToolManager.
 *
 * @param {Object} toolManager - ToolManager instance
 * @param {Object} [opts]
 * @param {string} [opts.projectRoot] - engine repo root (default: cwd)
 * @param {string[]} [opts.extraRoots] - additional scan roots
 * @returns {Promise<{loaded:Array, skipped:Array}>}
 */
export async function loadSkills(toolManager, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const roots = [
    join(homedir(), '.constellation', 'skills'),
    join(projectRoot, 'skills'),
    ...(opts.extraRoots || []),
  ];

  const loaded = [];
  const skipped = [];
  const seen = new Set();

  for (const root of roots) {
    const dirs = await discoverSkillDirs(root);
    for (const dir of dirs) {
      const result = await loadSkill(dir);
      if (!result.ok) {
        skipped.push({ dir, reason: result.reason });
        continue;
      }
      const skill = result.skill;
      if (seen.has(skill.name)) {
        skipped.push({ dir, reason: `duplicate name "${skill.name}" (already loaded from earlier root)` });
        continue;
      }
      if (!skill.modelInvocable) {
        skipped.push({ dir, reason: `model invocation disabled` });
        continue;
      }
      seen.add(skill.name);

      const toolName = `skill_${skill.name.replace(/-/g, '_')}`;
      try {
        toolManager.register({
          name: toolName,
          description: skill.description,
          parameters: { type: 'object', properties: {} },
          parallel: true,
          deferLoading: true,
          cacheSafe: true,
          keywords: ['skill', skill.name, ...skill.keywords],
          execute: async () => skill.body,
        });
        loaded.push({ name: toolName, dir, source: skill.name });
      } catch (err) {
        skipped.push({ dir, reason: `register failed: ${err.message}` });
      }
    }
  }

  return { loaded, skipped };
}
