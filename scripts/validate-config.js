#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Validate the effective OSS configuration without requiring provider secrets.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${path} is not valid JSON: ${err.message}`);
    return null;
  }
}

const config = loadConfig();
const example = parseJsonFile(resolve(ROOT, 'config.example.json'));

assert(config && typeof config === 'object', 'loadConfig() did not return an object');
assert(config.engine?.dbPath, 'engine.dbPath is required');
assert(config.engine?.modelId, 'engine.modelId is required');
assert(Array.isArray(config.runtime?.fixedFiles), 'runtime.fixedFiles must be an array');
assert(config.runtime.fixedFiles.includes('identity/SYSTEM_PREAMBLE.md'), 'runtime.fixedFiles must include identity/SYSTEM_PREAMBLE.md');
assert(config.runtime.fixedFiles.includes('identity/COMMUNICATION_STYLE.md'), 'runtime.fixedFiles must include identity/COMMUNICATION_STYLE.md');

assert(config.engine?.ir?.raw_context?.mode === 'recovery_only', 'raw_context.mode must default to recovery_only');
assert(config.engine?.ir?.raw_context?.expanded_max_turns === 40, 'raw_context.expanded_max_turns must default to 40');
assert(config.engine?.ir?.compaction_summary?.inject === false, 'compaction_summary.inject must default to false');

if (example) {
  assert(example.llm && typeof example.llm === 'object', 'config.example.json must contain llm');
  assert(example.engine?.ir?.raw_context?.mode === 'recovery_only', 'config.example.json raw_context.mode must be recovery_only');
  assert(example.engine?.ir?.compaction_summary?.inject === false, 'config.example.json compaction_summary.inject must be false');
}

if (process.exitCode) process.exit(process.exitCode);

console.log('✓ Config validation passed');
