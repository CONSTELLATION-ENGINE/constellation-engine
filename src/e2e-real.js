#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * e2e-real.js — Real LLM end-to-end test (requires ANTHROPIC_API_KEY)
 * 
 * Tests the full pipeline: user input → constellation render → LLM → tools → response
 * 
 * Usage: ANTHROPIC_API_KEY=sk-... node src/e2e-real.js
 */

import { boot } from './main.js';

const TESTS = [
  {
    name: 'Basic identity query',
    input: 'Who are you? Short answer.',
    validate: (r) => {
      if (!r.response) throw new Error('No response');
      // Identity check: response must be non-trivial (real LLM, not stub).
      if (r.response.trim().length < 5) throw new Error(`Identity response too short: ${r.response}`);
    },
  },
  {
    name: 'Constellation-aware query',
    input: 'What does the constellation engine do? One sentence.',
    validate: (r) => {
      if (!r.response) throw new Error('No response');
      if (r.response.length < 10) throw new Error('Response too short');
    },
  },
  {
    name: 'Tool use (constellation stats)',
    input: 'Check how many nodes are in the star map. Use the constellation_stats tool.',
    validate: (r) => {
      if (!r.response) throw new Error('No response');
      // Should have used tool or mentioned node count
      if (r.toolRounds > 0 || /\d{2,}/.test(r.response)) return; // OK
      throw new Error('Expected tool use or node count in response');
    },
  },
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠️  ANTHROPIC_API_KEY not set. Skipping real LLM test.');
    console.log('   Run with: ANTHROPIC_API_KEY=sk-... node src/e2e-real.js');
    process.exit(0);
  }

  console.log('⚔️  Constellation Real LLM E2E Test\n');
  console.log('─'.repeat(50));

  let ctx;
  try {
    ctx = await boot();
  } catch (e) {
    console.error('Boot failed:', e.message);
    process.exit(1);
  }

  const SID = 'e2e-real-test';
  let passed = 0;

  for (const test of TESTS) {
    console.log(`\n  🧪 ${test.name}`);
    console.log(`     Input: "${test.input}"`);
    
    try {
      const result = await ctx.runtime.turn(SID, test.input);
      console.log(`     Response: ${result.response.slice(0, 150)}...`);
      console.log(`     Tools: ${result.toolsUsed.length ? result.toolsUsed.join(', ') : 'none'}`);
      console.log(`     Tokens: ${result.usage.inputTokens}in/${result.usage.outputTokens}out`);
      
      test.validate(result);
      console.log(`  ✅ ${test.name}`);
      passed++;
    } catch (e) {
      console.log(`  ❌ ${test.name}: ${e.message}`);
    }
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`\n⚔️  Results: ${passed}/${TESTS.length} passed`);

  await ctx.shutdown();
  process.exit(passed === TESTS.length ? 0 : 1);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
