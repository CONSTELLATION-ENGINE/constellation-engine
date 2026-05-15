#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * cli.js — Interactive CLI for testing Constellation Engine without Telegram
 * 
 * Usage: 
 *   node src/cli.js [config-path]        # Normal mode (needs API key)
 *   node src/cli.js --mock [config-path]  # Mock LLM mode (no API key needed)
 *   node src/cli.js --e2e                 # Run automated e2e smoke test
 */

import { createInterface } from 'node:readline';

/**
 * Create a mock LLM router that echoes back with constellation context.
 * Used for testing the full pipeline without an API key.
 */
async function createMockLLM() {
  const { EventEmitter } = await import('node:events');
  const emitter = new EventEmitter();
  
  return Object.assign(emitter, {
    async chat(messages, options = {}) {
      const systemContent = messages.find(m => m.role === 'system')?.content || '';
      const user = messages.filter(m => m.role === 'user').pop()?.content || '';
      const hasConstellation = systemContent.includes('Constellation');
      const hasSOUL = systemContent.includes('soul-core');
      
      // Simulate tool use for certain queries
      if (user.includes('/tools') || user.includes('query star map')) {
        return {
          content: null,
          toolCalls: [{
            id: `mock-tc-${Date.now()}`,
            name: 'constellation_stats',
            input: {},
          }],
          usage: { inputTokens: 100, outputTokens: 50 },
          model: 'mock-model',
          finishReason: 'tool_use',
        };
      }

      const response = [
        `[Mock LLM] received message: "${user.slice(0, 80)}"`,
        ``,
        `System prompt status:`,
        `  - SOUL/Identity: ${hasSOUL ? '✅' : '❌'}`,
        `  - Constellation: ${hasConstellation ? '✅' : '❌'}`,
        `  - System prompt: ${systemContent.length} chars (~${Math.ceil(systemContent.length / 3.5)} tokens)`,
        `  - Messages: ${messages.length} total`,
        `  - Model requested: ${options.model || 'default'}`,
      ].join('\n');

      return {
        content: response,
        toolCalls: null,
        usage: { inputTokens: Math.ceil(systemContent.length / 3.5), outputTokens: response.length / 3.5 },
        model: 'mock-model',
        finishReason: 'stop',
      };
    },
    async summarize(text) {
      return `[Mock Summary] ${text.slice(0, 200)}...`;
    },
    estimateTokens(input) {
      const text = typeof input === 'string' ? input : JSON.stringify(input);
      return Math.ceil(text.length / 3.5);
    },
    async healthCheck() {
      return { ok: true, model: 'mock-model' };
    },
  });
}

/**
 * Boot with mock LLM (bypasses API key requirement).
 */
async function bootMock(configPath) {
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { loadConfig, DEFAULTS } = await import('./config.js');
  const { SessionManager } = await import('./session.js');
  const { ToolManager } = await import('./tool-manager.js');
  const { AgentRuntime } = await import('./agent-runtime.js');

  const __dirname = dirname(fileURLToPath(import.meta.url));

  console.log('⚔️  Constellation CLI — MOCK LLM mode (no API key needed)\n');

  // Load config but skip API key validation
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    if (e.message.includes('apiKey')) {
      // Manually build config with defaults
      const { readFileSync } = await import('node:fs');
      const raw = JSON.parse(readFileSync(resolve(__dirname, '../config.json'), 'utf-8'));
      config = { ...DEFAULTS };
      for (const key of Object.keys(raw)) {
        if (typeof raw[key] === 'object' && !Array.isArray(raw[key])) {
          config[key] = { ...DEFAULTS[key], ...raw[key] };
        } else {
          config[key] = raw[key];
        }
      }
      config.llm.apiKey = 'mock-key';
    } else {
      throw e;
    }
  }

  // Open DB
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(config.engine.dbPath);
  db.pragma('journal_mode = WAL');

  // Engine
  const enginePath = resolve(__dirname, '../engine.cjs');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { ConstellationEngine } = require(enginePath);
  const engine = new ConstellationEngine(config.engine.dbPath);

  const nodeCount = engine.stats?.()?.active ?? '?';
  console.log(`  Engine: ${nodeCount} nodes`);

  // Sessions
  const sessions = new SessionManager(db);

  // Mock LLM
  const llm = await createMockLLM();
  console.log('  LLM: mock (no API calls)');

  // Tools
  const tools = new ToolManager(engine, config.tools);
  console.log(`  Tools: ${tools.size} registered`);

  // Runtime
  const runtime = new AgentRuntime({
    engine,
    sessionManager: sessions,
    llm,
    tools,
    config: config.runtime,
  });

  console.log('  Runtime: ready\n');

  return {
    config, db, engine, sessions, llm, tools, runtime,
    async shutdown() {
      try { db.close(); } catch {}
      console.log('⚔️  Goodbye.');
    },
  };
}

/**
 * Run automated e2e smoke test.
 */
async function runE2ETest() {
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  console.log('⚔️  Constellation E2E Smoke Test\n');
  console.log('─'.repeat(50));

  const ctx = await bootMock();
  const { runtime, sessions, engine } = ctx;
  const SID = 'e2e-test';

  const tests = [];
  let passed = 0;

  async function test(name, fn) {
    try {
      await fn();
      tests.push({ name, ok: true });
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      tests.push({ name, ok: false, error: e.message });
      console.log(`  ❌ ${name}: ${e.message}`);
    }
  }

  // Test 1: Basic turn
  await test('Basic conversation turn', async () => {
    const result = await runtime.turn(SID, 'Hello');
    if (!result.response) throw new Error('No response');
    if (!result.response.includes('Mock LLM')) throw new Error('Response not from mock');
  });

  // Test 2: System prompt contains identity
  await test('System prompt includes SOUL/Identity', async () => {
    const result = await runtime.turn(SID, 'Tell me who you are');
    if (!result.response.includes('SOUL/Identity: ✅')) throw new Error('SOUL not in system prompt');
  });

  // Test 3: Constellation renders
  await test('Constellation renders in system prompt', async () => {
    const result = await runtime.turn(SID, 'KC monetary theory');
    if (!result.response.includes('Constellation: ✅')) throw new Error('Constellation not rendered');
  });

  // Test 4: Tool execution
  await test('Tool execution (constellation_stats)', async () => {
    const result = await runtime.turn(SID, '/tools query star map');
    if (result.toolRounds < 1) throw new Error('No tool rounds');
    if (!result.toolsUsed.includes('constellation_stats')) throw new Error('constellation_stats not used');
  });

  // Test 5: Session persistence
  await test('Session message persistence', async () => {
    const msgs = sessions.getActiveMessages(SID);
    if (msgs.length < 2) throw new Error(`Only ${msgs.length} messages, expected >=2`);
  });

  // Test 6: Engine query via tool
  await test('Direct tool execution', async () => {
    const result = await ctx.tools.execute('constellation_stats', {});
    const stats = JSON.parse(result);
    if (typeof stats.active !== 'number') throw new Error('Stats payload missing active count');
  });

  // Test 7: File read tool
  await test('File read tool (SYSTEM_PREAMBLE.md)', async () => {
    const result = await ctx.tools.execute('file_read', { path: resolve(__dirname, '../identity/SYSTEM_PREAMBLE.md') });
    if (!result.includes('soul-core')) throw new Error('SYSTEM_PREAMBLE.md content missing');
  });

  // Test 8: constellation_remember writes to DB
  await test('constellation_remember writes node', async () => {
    const beforeStats = JSON.parse(await ctx.tools.execute('constellation_stats', {}));
    const result = await ctx.tools.execute('constellation_remember', {
      content: `E2E test node — ${Date.now()} — this is a test write from the e2e suite.`,
      tags: ['test', 'e2e'],
    });
    if (!/Remembered|Dedup/i.test(result)) throw new Error('Remember failed: ' + result);
    const afterStats = JSON.parse(await ctx.tools.execute('constellation_stats', {}));
    if (typeof afterStats.active !== 'number') throw new Error('Stats payload missing active count after remember');
    if (afterStats.active < beforeStats.active) throw new Error('Node count regressed');
  });

  console.log('\n' + '─'.repeat(50));
  console.log(`\n⚔️  Results: ${passed}/${tests.length} passed`);

  if (passed === tests.length) {
    console.log('🎉 All E2E tests passed!\n');
  } else {
    console.log('⚠️  Some tests failed.\n');
    for (const t of tests.filter(t => !t.ok)) {
      console.log(`   ❌ ${t.name}: ${t.error}`);
    }
  }

  await ctx.shutdown();
  process.exit(passed === tests.length ? 0 : 1);
}

/**
 * Interactive CLI session.
 */
async function interactive(ctx) {
  const { runtime, sessions, engine } = ctx;
  const SESSION_ID = 'cli-interactive';

  console.log(`Engine: ${engine.stats().active} nodes`);
  console.log(`Session: ${SESSION_ID}`);
  console.log('Commands: /stats /session /quit');
  console.log('Type your message (Ctrl+C to quit)\n');

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '👤 You: ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === '/quit' || input === '/exit') {
      rl.close();
      return;
    }

    if (input === '/stats') {
      const s = engine.stats();
      console.log(`\n📊 Engine: ${s.active} active, ${s.dormant} dormant, ${s.edges} edges`);
      try {
        const rs = runtime.getStats(SESSION_ID);
        console.log(`   Runtime: ${JSON.stringify(rs)}`);
      } catch {}
      rl.prompt();
      return;
    }

    if (input === '/session') {
      try {
        const msgs = sessions.getActiveMessages(SESSION_ID);
        console.log(`\n📋 Session messages: ${msgs.length}`);
        for (const m of msgs.slice(-5)) {
          const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          console.log(`   [${m.role}] ${text.slice(0, 100)}...`);
        }
      } catch (e) {
        console.log(`\n📋 Session: ${e.message}`);
      }
      rl.prompt();
      return;
    }

    try {
      process.stdout.write('\n🌌 Engine: thinking...');
      
      const result = await runtime.turn(SESSION_ID, input);
      
      // Clear "thinking" line
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      
      console.log(`🌌 Engine: ${result.response}\n`);
      
      if (result.toolsUsed?.length) {
        console.log(`   [tools: ${result.toolsUsed.join(', ')}]\n`);
      }
      if (result.compacted) {
        console.log('   [session compacted]\n');
      }
    } catch (err) {
      process.stdout.write('\r' + ' '.repeat(40) + '\r');
      console.error(`\n❌ Error: ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    console.log('\nShutting down...');
    await ctx.shutdown();
  });
}

async function openTranscriptCtx(configPath) {
  const { resolve } = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const { loadConfig } = await import('./config.js');
  const { TranscriptIntegrityManager } = await import('./transcript-integrity.js');

  const config = loadConfig(configPath);
  const db = new Database(config.engine.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const transcript = new TranscriptIntegrityManager(db);

  return {
    config,
    db,
    transcript,
    async shutdown() {
      try { db.close(); } catch {}
    },
  };
}

function parseTranscriptArgs(args) {
  const out = {
    command: args[1] || 'scan',
    sessionId: undefined,
    provider: 'anthropic',
    mode: 'safe',
    dryRun: false,
    json: false,
    limit: undefined,
    configPath: undefined,
  };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') out.sessionId = args[++i];
    else if (arg === '--provider') out.provider = args[++i] || 'anthropic';
    else if (arg === '--mode') out.mode = args[++i] || 'safe';
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--limit') out.limit = Number(args[++i]) || undefined;
    else if (!arg.startsWith('--') && !out.configPath) out.configPath = arg;
  }
  return out;
}

function printTranscriptReport(title, report) {
  console.log(`🧬 ${title}`);
  if (report.runId) console.log(`   run: ${report.runId}`);
  if (report.provider) console.log(`   provider: ${report.provider}`);
  if (typeof report.sessionsScanned === 'number') console.log(`   sessions: ${report.sessionsScanned}`);
  if (typeof report.issueCount === 'number') console.log(`   issues: ${report.issueCount}`);
  if (typeof report.repairedActions === 'number') console.log(`   repairs: ${report.repairedActions}`);
  if (report.byType && Object.keys(report.byType).length) {
    console.log('   by type:');
    for (const [k, v] of Object.entries(report.byType)) {
      console.log(`     - ${k}: ${v}`);
    }
  }
  if (Array.isArray(report.sessions)) {
    for (const s of report.sessions.slice(0, 20)) {
      const summary = [];
      if (typeof s.issueCount === 'number') summary.push(`issues=${s.issueCount}`);
      if (typeof s.beforeIssueCount === 'number') summary.push(`before=${s.beforeIssueCount}`);
      if (typeof s.afterIssueCount === 'number') summary.push(`after=${s.afterIssueCount}`);
      if (Array.isArray(s.actions)) summary.push(`actions=${s.actions.length}`);
      if (s.ok === true) summary.push('verify=ok');
      if (s.ok === false) summary.push(`verify=${s.issueCount}`);
      console.log(`   • ${s.sessionId} ${summary.length ? '(' + summary.join(', ') + ')' : ''}`);
      if (Array.isArray(s.issues) && s.issues.length) {
        for (const issue of s.issues.slice(0, 10)) {
          console.log(`       - ${issue.issueType} [${issue.severity}] msg=${(issue.messageIds || []).join(',')}`);
        }
      }
    }
  }
}

async function runTranscriptCommand(args) {
  const parsed = parseTranscriptArgs(args);
  const ctx = await openTranscriptCtx(parsed.configPath);
  try {
    let report;
    if (parsed.command === 'scan') {
      report = ctx.transcript.scan({ sessionId: parsed.sessionId, provider: parsed.provider, limit: parsed.limit });
      if (parsed.json) console.log(JSON.stringify(report, null, 2));
      else printTranscriptReport('Transcript scan', report);
      return;
    }
    if (parsed.command === 'repair') {
      report = ctx.transcript.repair({ sessionId: parsed.sessionId, provider: parsed.provider, mode: parsed.mode, dryRun: parsed.dryRun, limit: parsed.limit });
      if (parsed.json) console.log(JSON.stringify(report, null, 2));
      else printTranscriptReport(`Transcript repair (${parsed.mode}${parsed.dryRun ? ', dry-run' : ''})`, report);
      return;
    }
    if (parsed.command === 'verify') {
      report = ctx.transcript.verify({ sessionId: parsed.sessionId, provider: parsed.provider, limit: parsed.limit });
      if (parsed.json) console.log(JSON.stringify(report, null, 2));
      else printTranscriptReport('Transcript verify', report);
      return;
    }
    console.error(`Unknown transcript command: ${parsed.command}`);
    process.exitCode = 1;
  } finally {
    await ctx.shutdown();
  }
}

// ─── Entry Point ───

async function main() {
  const args = process.argv.slice(2);
  
  // transcript scanner / repair CLI
  if (args[0] === 'transcript') {
    return runTranscriptCommand(args);
  }

  // --e2e: automated smoke test
  if (args.includes('--e2e')) {
    return runE2ETest();
  }

  // --mock: interactive with mock LLM
  const useMock = args.includes('--mock');
  const configPath = args.find(a => !a.startsWith('--')) || undefined;

  let ctx;
  if (useMock) {
    ctx = await bootMock(configPath);
  } else {
    const { boot } = await import('./main.js');
    console.log('⚔️  Constellation CLI — interactive mode\n');
    // CLI mode: disable Telegram, Dashboard, Cron to avoid port conflicts with running main.js
    ctx = await boot(configPath, { cliMode: true });
  }

  if (!ctx) {
    console.error('Boot failed.');
    process.exit(1);
  }

  await interactive(ctx);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
