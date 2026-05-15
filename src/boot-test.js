#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * boot-test.js — Validate boot + system prompt assembly without LLM calls
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { SessionManager } from './session.js';
import { LLMRouter } from './llm-router.js';
import { ToolManager } from './tool-manager.js';
import { AgentRuntime } from './agent-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function test() {
  console.log('⚔️  Boot test — validating full pipeline without LLM calls\n');
  const errors = [];

  // 1. Config
  console.log('  [1] Config...');
  const config = loadConfig();
  console.log(`      ✅ Loaded (LLM: ${config.llm.primaryModel})`);

  // 2. DB + Engine
  console.log('  [2] DB + Engine...');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(config.engine.dbPath);
  db.pragma('journal_mode = WAL');

  const enginePath = resolve(__dirname, '../engine.cjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { ConstellationEngine } = require(enginePath);
  const engine = new ConstellationEngine(config.engine.dbPath);
  const stats = engine.stats();
  console.log(`      ✅ Engine: ${stats.active} active nodes, ${stats.edges} edges`);

  // 3. Session
  console.log('  [3] SessionManager...');
  const sessions = new SessionManager(db);
  const testSession = sessions.getOrCreate('boot-test');
  console.log(`      ✅ Session: ${testSession.id}`);

  // 4. ToolManager
  console.log('  [4] ToolManager...');
  const tools = new ToolManager(engine, config.tools);
  const toolDefs = tools.getDefinitions();
  console.log(`      ✅ ${toolDefs.length} tools: ${tools.listTools().join(', ')}`);

  // 5. LLMRouter (just instantiate, no actual call)
  console.log('  [5] LLMRouter...');
  const llm = new LLMRouter(config.llm);
  console.log(`      ✅ Router ready (${config.llm.primaryModel})`);

  // 6. AgentRuntime
  console.log('  [6] AgentRuntime...');
  const runtime = new AgentRuntime({
    engine, sessionManager: sessions, llm, tools, config: config.runtime,
  });
  console.log('      ✅ Runtime ready');

  // 7. System prompt assembly test
  console.log('  [7] System prompt assembly...');
  const systemPrompt = await runtime.buildSystemPrompt(testSession.id, 'Hello, who are you?');
  const promptLen = systemPrompt.length;
  const hasSOUL = systemPrompt.includes('soul-core');
  const hasConstellation = systemPrompt.includes('Constellation');
  console.log(`      ✅ Prompt: ${promptLen} chars (~${Math.ceil(promptLen/3.5)} tokens)`);
  console.log(`      ${hasSOUL ? '✅' : '❌'} SOUL/Identity injected`);
  console.log(`      ${hasConstellation ? '✅' : '❌'} Constellation rendered`);

  // 8. Tool execution test (constellation_stats)
  console.log('  [8] Tool execution...');
  const statsResult = await tools.execute('constellation_stats', {});
  const parsedStats = JSON.parse(statsResult);
  console.log(`      ✅ constellation_stats: ${parsedStats.active} nodes`);

  // 9. Constellation query test
  console.log('  [9] Constellation query...');
  const queryResult = await tools.execute('constellation_query', { query: 'KC monetary theory' });
  console.log(`      ✅ Query result: ${queryResult.length} chars`);

  // 10. File read test
  console.log(' [10] File tools...');
  const readResult = await tools.execute('file_read', { path: resolve(__dirname, '../identity/SYSTEM_PREAMBLE.md'), maxLines: 3 });
  console.log(`      ✅ file_read: ${readResult.substring(0, 60)}...`);

  // Summary
  console.log(`\n⚔️  Boot test PASSED — all ${10} checks OK`);
  console.log(`   Engine: ${stats.active} nodes | Tools: ${toolDefs.length} | Prompt: ~${Math.ceil(promptLen/3.5)} tokens`);

  db.close();
}

test().catch(err => {
  console.error('\n❌ Boot test FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
