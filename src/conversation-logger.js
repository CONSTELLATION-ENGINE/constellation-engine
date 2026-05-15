// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module conversation-logger
 * @description Logs all conversations to daily markdown files + provides API for dashboard.
 * 
 * Replaces the old Python scribe daemon. Hooks into AgentRuntime events
 * to capture messages in real-time.
 * 
 * Log files: data/logs/YYYY-MM-DD.md
 * Format: timestamp + role + content, human-readable
 */

import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { appendFile, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '../data/logs');

// Ensure log directory exists
mkdirSync(LOG_DIR, { recursive: true });

/**
 * Get today's date string in NZDT.
 * @returns {string} YYYY-MM-DD
 */
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/**
 * Get current time string in NZDT.
 * @returns {string} HH:MM:SS
 */
function nowTime() {
  return new Date().toLocaleTimeString('en-GB', { 
    timeZone: 'UTC', 
    hour: '2-digit', minute: '2-digit', second: '2-digit' 
  });
}

/**
 * Get the log file path for a given date.
 * @param {string} [date] - YYYY-MM-DD, defaults to today
 * @returns {string}
 */
function logPath(date) {
  return join(LOG_DIR, `${date || todayStr()}.md`);
}

/**
 * Append a message to today's log file.
 * @param {string} role - 'user' | 'assistant' | 'system' | 'tool'
 * @param {string} content - Message content
 * @param {Object} [meta] - Optional metadata (sessionId, model, tokens)
 */
/**
 * Noise filter: skip low-value messages that clutter the log.
 */
const NOISE_PATTERNS = [
  /^HEARTBEAT_OK$/i,
  /^NO_REPLY$/i,
  /^\s*$/,
  /^Tools used:\s*$/,
  /^Read HEARTBEAT\.md/i,
  /^⏰\s*heartbeat/i,
];

function isNoise(role, content) {
  if (!content || content.trim().length === 0) return true;
  // Tool results under 20 chars are usually just "ok" / "done"
  if (role === 'tool' && content.trim().length < 20) return true;
  for (const pat of NOISE_PATTERNS) {
    if (pat.test(content.trim())) return true;
  }
  return false;
}

export function logMessage(role, content, meta = {}) {
  // Filter noise
  if (isNoise(role, content)) return;

  const date = todayStr();
  const time = nowTime();
  const fp = logPath(date);

  const roleEmoji = {
    user: '👤',
    assistant: '⚔️',
    system: '⚙️',
    tool: '🔧',
  }[role] || '📝';

  let entry = `### ${roleEmoji} [${time}] ${role}\n\n`;
  
  // Truncate very long tool outputs
  const maxLen = role === 'tool' ? 500 : 10000;
  const trimmed = content && content.length > maxLen 
    ? content.slice(0, maxLen) + `\n\n*(...truncated, ${content.length} chars total)*`
    : content;
  
  entry += (trimmed || '*(empty)*') + '\n\n';
  
  // Add metadata line if present
  if (meta.model || meta.tokens) {
    const parts = [];
    if (meta.model) parts.push(`model: ${meta.model}`);
    if (meta.tokens) parts.push(`tokens: ${meta.tokens}`);
    if (meta.sessionId) parts.push(`session: ${meta.sessionId}`);
    entry += `> ${parts.join(' | ')}\n\n`;
  }

  entry += '---\n\n';

  // Async write — fire and forget, errors logged but don't block caller
  (async () => {
    try {
      const HEADER = `# Conversation Log — ${date}\n\n`;
      let targetFp = fp;

      // #40: File size limit — split into YYYY-MM-DD-1.md, -2.md etc. when over 2MB
      const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2MB
      if (existsSync(targetFp)) {
        try {
          const { stat: fsStat } = await import('node:fs/promises');
          const st = await fsStat(targetFp);
          if (st.size > MAX_LOG_SIZE) {
            let n = 1;
            while (existsSync(join(LOG_DIR, `${date}-${n}.md`))) n++;
            targetFp = join(LOG_DIR, `${date}-${n}.md`);
            await writeFile(targetFp, HEADER + entry, 'utf-8');
            return;
          }
        } catch { /* stat failed, continue with normal write */ }
      }

      if (!existsSync(targetFp)) {
        await writeFile(targetFp, HEADER + entry, 'utf-8');
      } else {
        const existing = await readFile(targetFp, 'utf-8');
        // Insert after header line (reverse-chronological)
        const headerEnd = existing.indexOf('\n\n');
        if (headerEnd !== -1) {
          const header = existing.slice(0, headerEnd + 2);
          const body = existing.slice(headerEnd + 2);
          await writeFile(targetFp, header + entry + body, 'utf-8');
        } else {
          await writeFile(targetFp, HEADER + entry + existing, 'utf-8');
        }
      }
    } catch (err) {
      console.error(`  ⚠ ConversationLogger: ${err.message}`);
    }
  })();
}

/**
 * Hook into AgentRuntime to auto-log all messages.
 * @param {import('./agent-runtime.js').AgentRuntime} runtime
 */
/**
 * Prune log files older than keepDays.
 * @param {number} [keepDays=30]
 */
export function pruneOldLogs(keepDays = 30) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.md'));
    let pruned = 0;
    for (const f of files) {
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      if (dateMatch && dateMatch[1] < cutoffStr) {
        try { unlinkSync(join(LOG_DIR, f)); pruned++; } catch {}
      }
    }
    if (pruned > 0) console.log(`         → Pruned ${pruned} old log files (older than ${keepDays} days)`);
  } catch (err) {
    console.warn(`         ⚠ Log pruning failed: ${err.message}`);
  }
}

// In-process replacement for the legacy bash rotate-logs.sh on Win/Mac OSS
// installs (no cron/bash). Targets per-day observability JSONL that the
// engine writes but never rotates: compiler-training and ir-pool.
export function pruneObservabilityLogs(keepDays = 60) {
  const PROJECT_ROOT = resolve(__dirname, '..');
  const targets = [
    { dir: join(PROJECT_ROOT, 'data', 'compiler-training'), prefix: 'training-', ext: '.jsonl' },
    { dir: join(PROJECT_ROOT, 'data', 'logs', 'ir-pool'), prefix: '', ext: '.jsonl' },
  ];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let totalPruned = 0;
  for (const { dir, prefix, ext } of targets) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(ext) || (prefix && !f.startsWith(prefix))) continue;
        const dateMatch = f.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          try { unlinkSync(join(dir, f)); totalPruned++; } catch {}
        }
      }
    } catch {}
  }
  if (totalPruned > 0) {
    console.log(`         → Pruned ${totalPruned} observability files (older than ${keepDays} days)`);
  }
}

export function hookRuntime(runtime) {
  // Prune old logs on startup
  try { pruneOldLogs(30); } catch {}
  try { pruneObservabilityLogs(60); } catch {}
  // Log complete turns (user + assistant + metadata)
  runtime.on('turn', ({ sessionId, userMessage, response, model, tokensUsed, toolsUsed, duration }) => {
    // Log user message
    logMessage('user', userMessage || '', { sessionId });
    
    // Log tool calls if any
    if (toolsUsed && toolsUsed.length > 0) {
      const toolSummary = toolsUsed.map(t => typeof t === 'string' ? t : t.name || t).join(', ');
      logMessage('tool', `Tools used: ${toolSummary}`, { sessionId });
    }

    // Log assistant response
    logMessage('assistant', (response || '')
      .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')
      .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, ''), {
      sessionId, 
      model,
      tokens: tokensUsed,
    });
  });

  // Log compaction events
  runtime.on('compaction', ({ sessionId, messagesCompacted, summaryLength }) => {
    logMessage('system', `Compaction: ${messagesCompacted} messages → ${summaryLength} char summary`, { sessionId });
  });

  // Log errors
  runtime.on('error', ({ sessionId, error }) => {
    logMessage('system', `Error: ${error?.message || error}`, { sessionId });
  });

  console.log('         → ConversationLogger hooked');
}

/**
 * Get recent messages for dashboard display.
 * @param {number} [limit=50] - Max messages to return
 * @param {string} [date] - YYYY-MM-DD, defaults to today
 * @returns {string} Raw markdown content
 */
export function getRecentLog(limit = 50, date) {
  const fp = logPath(date);
  if (!existsSync(fp)) return '';
  
  try {
    const content = readFileSync(fp, 'utf-8');
    // Return last N entries (split by ---)
    const entries = content.split('---').filter(e => e.trim());
    return entries.slice(-limit).join('---\n') + '---';
  } catch {
    return '';
  }
}

/**
 * List available log dates.
 * @returns {string[]} Array of YYYY-MM-DD strings
 */
export function listLogDates() {
  try {
    return readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
