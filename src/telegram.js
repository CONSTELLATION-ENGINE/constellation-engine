// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module telegram
 * @description Telegram bot interface for Constellation Engine.
 * 
 * Uses grammY for long polling (no webhook needed in WSL).
 * 
 * Features:
 * - Auth guard: only Founder's Telegram ID allowed
 * - HTML message formatting with automatic Markdown→HTML conversion
 * - Smart message splitting at 4096 char Telegram limit
 * - Parse error fallback: HTML → plain text auto-degradation
 * - Flood wait handling with exponential backoff
 * - Rate limiting per user
 * - Inline keyboard support for interactive elements
 * - Typing indicator during LLM processing
 * - Layered Telegram delivery: natural multi-message grouping instead of giant hard-split blobs
 * - Error messages surfaced to user, never swallowed
 * 
 * Design decisions:
 * - grammY middleware onion model: auth → rateLimit → typing → runtime
 * - Long polling chosen over webhook (WSL has no public IP)
 * - Message splitting preserves code blocks and formatting
 * - All HTML is escaped before sending, then format tags re-applied
 * - Retry logic handles 429 (flood wait) with Telegram-specified delay
 */

import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { EventEmitter } from 'node:events';
import liveBus from './live-bus.cjs';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';
import { computeArousal, roundArousal } from './arousal-detector.js';

const MIMIR_URL = process.env.MIMIR_URL || 'http://127.0.0.1:18810';

// Native http.request POST to the mimir daemon. Replaces `execFile('curl', ...)`
// which fails on Windows when curl isn't on PATH (frequent OSS bare-install).
// Fire-and-forget: never throws; resolves with parsed JSON body on 2xx or null
// otherwise. `timeoutMs` covers both connect + body.
function _postMimirJson(path, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(path, MIMIR_URL); } catch { return resolve(null); }
    const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        } else resolve(null);
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── WSL2 IPv6 Fix ──────────────────────────────────────────────────────────
// Node's built-in fetch (undici) hangs on IPv6 routes in WSL2.
// grammY uses its own fetch internally, so we override at the API transformer level.

/**
 * Simple IPv4-only fetch using Node's https module.
 * @param {string} url
 * @param {object} init
 * @returns {Promise<{ok: boolean, status: number, json: Function, text: Function}>}
 */
function ipv4Fetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = init.headers || {};
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers: typeof headers.entries === 'function'
        ? Object.fromEntries(headers.entries())
        : headers,
      family: 4,
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: () => Promise.resolve(JSON.parse(body)),
          text: () => Promise.resolve(body),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
    if (init.body) req.write(typeof init.body === 'string' ? init.body : JSON.stringify(init.body));
    req.end();
  });
}

/**
 * Install IPv4 API transformer on a grammY Bot instance.
 * Includes retry logic for transient Telegram API errors (timeouts, 5xx).
 * @param {Bot} bot
 * @param {string} token
 */
function installIpv4Transformer(bot, token) {
  const baseUrl = `https://api.telegram.org/bot${token}/`;
  bot.api.config.use(async (prev, method, payload, signal) => {
    const url = baseUrl + method;
    const MAX_RETRIES = 2;
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await ipv4Fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (err) {
        lastError = err;
        // Only retry on timeout or network errors, not on 4xx
        if (attempt < MAX_RETRIES && /timeout|ECONNRESET|ENOTFOUND|socket hang up/i.test(err.message)) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
    }

    // If all retries failed, return a Telegram-compatible error instead of throwing
    // This prevents unhandled rejections from crashing the bot
    // Only warn for non-cleanup methods (deleteWebhook failures during startup are harmless)
    if (method !== 'deleteWebhook') {
      console.warn(`[Telegram] API call ${method} failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
    }
    return { ok: false, error_code: 0, description: `Network error: ${lastError?.message || 'unknown'}` };
  });
}

// ─── Media Download ─────────────────────────────────────────────────────────

const _projectRoot = pathResolve(new URL('.', import.meta.url).pathname, '..');
const MEDIA_TMP_DIR = join(_projectRoot, 'engine-inbox', 'uploads', 'images');

/**
 * Download a Telegram file to local disk via Bot API getFile + HTTPS download.
 * @param {Bot} bot - grammY Bot instance
 * @param {string} fileId - Telegram file_id
 * @param {string} ext - file extension (e.g. 'jpg', 'ogg')
 * @returns {Promise<string>} local file path
 */
async function downloadTelegramFile(bot, fileId, ext = 'jpg') {
  if (!existsSync(MEDIA_TMP_DIR)) mkdirSync(MEDIA_TMP_DIR, { recursive: true });

  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error('Telegram returned no file_path');

  const token = bot.token;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

  const buffer = await new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'GET',
      family: 4,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Download timeout')));
    req.end();
  });

  const localName = `tg_${Date.now()}_${fileId.slice(-8)}.${ext}`;
  const localPath = join(MEDIA_TMP_DIR, localName);
  writeFileSync(localPath, buffer);
  return localPath;
}

/**
 * Clean up media files older than maxAgeMs.
 * Called periodically to prevent /tmp from filling up.
 */
function cleanupOldMedia(maxAgeMs = 2592000000) { // 30 days default (uploads are now persistent)
  if (!existsSync(MEDIA_TMP_DIR)) return;
  try {
    const now = Date.now();
    for (const f of readdirSync(MEDIA_TMP_DIR)) {
      const p = join(MEDIA_TMP_DIR, f);
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore */ }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;
const MAX_CHUNKS = 12;
const MAX_TOTAL_CHARS = 50000;
const TYPING_INTERVAL_MS = 4000; // Telegram typing indicator lasts ~5s
const RATE_LIMIT_WINDOW_MS = 2000; // Min ms between messages from same user
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

// ─── HTML Formatting ────────────────────────────────────────────────────────

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert basic Markdown formatting to Telegram-safe HTML.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, [links](url)
 * 
 * Strategy: escape all HTML first, then apply formatting conversions.
 * This prevents injection while preserving intended formatting.
 * 
 * @param {string} text - Raw text (may contain markdown)
 * @returns {string} Telegram-compatible HTML
 */
function markdownToHtml(text) {
  if (!text) return '';

  // First, extract and protect code blocks (``` ... ```)
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\x00CODEBLOCK_${idx}\x00`;
  });

  // Extract inline code (` ... `)
  const inlineCodes = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE_${idx}\x00`;
  });

  // Now escape remaining HTML
  processed = escapeHtml(processed);

  // Apply markdown formatting conversions
  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  processed = processed.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks and inline code
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }
  for (let i = 0; i < inlineCodes.length; i++) {
    processed = processed.replace(`\x00INLINE_${i}\x00`, inlineCodes[i]);
  }

  return processed;
}

/**
 * Split a long message into chunks that respect Telegram's 4096 char limit.
 * 
 * Splitting priorities (in order):
 * 1. At double newlines (paragraph boundaries)
 * 2. At single newlines
 * 3. At sentence boundaries (. ! ?)
 * 4. At word boundaries (spaces)
 * 5. Hard cut at limit (last resort)
 * 
 * Code blocks are never split mid-block when possible.
 * 
 * @param {string} text - Full message text
 * @param {number} [maxLen=TELEGRAM_MAX_LENGTH] - Max chars per chunk
 * @returns {string[]} Array of chunks
 */
function splitMessage(text, maxLen = TELEGRAM_MAX_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0 && chunks.length < MAX_CHUNKS) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Don't exceed total character budget
    if (chunks.reduce((s, c) => s + c.length, 0) > MAX_TOTAL_CHARS) {
      chunks.push(remaining.slice(0, maxLen - 20) + '\n\n[...truncated]');
      break;
    }

    const slice = remaining.slice(0, maxLen);

    // Try split points in priority order
    let splitAt = -1;

    // 1. Double newline (paragraph)
    const doubleNl = slice.lastIndexOf('\n\n');
    if (doubleNl > maxLen * 0.3) {
      splitAt = doubleNl + 2;
    }

    // 2. Single newline
    if (splitAt === -1) {
      const singleNl = slice.lastIndexOf('\n');
      if (singleNl > maxLen * 0.3) {
        splitAt = singleNl + 1;
      }
    }

    // 3. Sentence boundary
    if (splitAt === -1) {
      const sentenceEnd = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('! '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('。'),
        slice.lastIndexOf('！'),
        slice.lastIndexOf('？')
      );
      if (sentenceEnd > maxLen * 0.3) {
        splitAt = sentenceEnd + (slice[sentenceEnd + 1] === ' ' ? 2 : 1);
      }
    }

    // 4. Word boundary
    if (splitAt === -1) {
      const space = slice.lastIndexOf(' ');
      if (space > maxLen * 0.3) {
        splitAt = space + 1;
      }
    }

    // 5. Hard cut
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}


function splitSemanticBlocks(text) {
  if (!text) return [];
  const normalized = String(text).replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = [];
  let current = [];
  let inFence = false;

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      current.push(line);
      continue;
    }

    if (!inFence && trimmed === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim());
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join('\n').trim());
  }
  return blocks.filter(Boolean);
}

function isListLikeBlock(block) {
  return /^(?:[-*•]\s|\d+[.)]\s|[•◦▪️▫️]\s)/m.test(block || '');
}

function isCodeBlock(block) {
  return /^```[\s\S]*```$/.test((block || '').trim());
}

function coalesceLayeredBlocks(blocks, maxLen, targetLen) {
  if (!blocks.length) return [];
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;
    const next = blocks[i + 1]?.trim() || '';
    const separator = current ? '\n\n' : '';
    const candidate = current ? current + separator + block : block;

    const shortIntroBeforeStructured = (
      current &&
      current.length <= 220 &&
      !isListLikeBlock(current) &&
      !isCodeBlock(current) &&
      (isListLikeBlock(block) || isCodeBlock(block))
    );

    if (shortIntroBeforeStructured) {
      pushCurrent();
      current = block;
      continue;
    }

    if (candidate.length > maxLen) {
      if (current) pushCurrent();
      if (block.length > maxLen) {
        for (const piece of splitMessage(block, maxLen)) {
          if (piece.length >= targetLen * 0.75 || isCodeBlock(piece) || isListLikeBlock(piece)) {
            chunks.push(piece.trim());
          } else {
            current = current ? `${current}\n\n${piece}` : piece;
          }
        }
      } else {
        current = block;
      }
      continue;
    }

    if (!current) {
      current = block;
      continue;
    }

    const currentLooksComplete = /[。！？.!?：:]$/.test(current) || isListLikeBlock(current) || isCodeBlock(current);
    const blockLooksStandalone = block.length <= 220 || isListLikeBlock(block) || isCodeBlock(block);
    const shouldBreakForRhythm = current.length >= targetLen && currentLooksComplete && blockLooksStandalone;

    if (shouldBreakForRhythm) {
      pushCurrent();
      current = block;
      continue;
    }

    current = candidate;

    const nextIsStructured = isListLikeBlock(next) || isCodeBlock(next);
    if (current.length >= targetLen && (!next || nextIsStructured || blockLooksStandalone)) {
      pushCurrent();
    }
  }

  if (current) pushCurrent();
  return chunks;
}

function formatResponseChunks(text, options = {}) {
  const maxLen = Math.max(400, Number(options.maxLen) || TELEGRAM_MAX_LENGTH);
  const style = options.style || 'layered';
  const targetLen = Math.min(maxLen - 200, Math.max(280, Number(options.targetLen) || 900));
  const raw = String(text || '').trim();
  if (!raw) return [];

  if (style === 'single') {
    return splitMessage(markdownToHtml(raw), maxLen);
  }

  const blocks = splitSemanticBlocks(raw);
  const grouped = coalesceLayeredBlocks(blocks, maxLen, targetLen);
  const htmlChunks = [];

  for (const chunk of grouped) {
    const html = markdownToHtml(chunk);
    if (html.length <= maxLen) {
      htmlChunks.push(html);
      continue;
    }
    htmlChunks.push(...splitMessage(html, maxLen));
  }

  return htmlChunks.length > 0 ? htmlChunks : splitMessage(markdownToHtml(raw), maxLen);
}

// ─── TelegramBot Class ─────────────────────────────────────────────────────

/**
 * @typedef {Object} TelegramConfig
 * @property {string} token - Bot API token
 * @property {string} allowedUserId - Founder's Telegram user ID (string)
 * @property {number} [maxMessageLength=4096] - Max message length before splitting
 */

export class TelegramBot extends EventEmitter {
  /** @type {Bot} */
  #bot;
  /** @type {import('./agent-runtime.js').AgentRuntime} */
  #runtime;
  /** @type {TelegramConfig} */
  #config;
  /** @type {string} */
  #chatId;
  /** @type {import('./session.js').SessionManager|null} */
  #sessionManager = null;
  /** @type {Map<string, number>} userId → last message timestamp */
  #rateLimitMap = new Map();
  /** @type {boolean} */
  #running = false;
  /** @type {Map<string, NodeJS.Timeout>} sessionId → typing interval */
  #typingIntervals = new Map();
  /** @type {Map<string, number>} */
  #processedUpdateCache = new Map();
  /** @type {Map<string, Promise<void>>} per-session turn queue to prevent concurrent processing */
  #sessionTurnQueue = new Map();
  /** @type {Map<string, {controller: AbortController, turnPromise: Promise, pendingMessages: Array, debounceTimer: NodeJS.Timeout|null, originalMessage: string, ctx: any, startTime: number}>} */
  #activeTurns = new Map();
  #cleanupInterval = null;
  static #CANCEL_PATTERNS = ['stop', 'cancel', 'nvm', 'never mind', 'nevermind'];

  /**
   * @param {TelegramConfig} config
   * @param {import('./agent-runtime.js').AgentRuntime} runtime
   * @param {import('./session.js').SessionManager|null} [sessionManager=null]
   */
  constructor(config, runtime, sessionManager = null) {
    super();
    if (!config.token) throw new Error('Telegram bot token is required');
    if (!config.allowedUserId) throw new Error('allowedUserId is required');

    this.#config = {
      maxMessageLength: TELEGRAM_MAX_LENGTH,
      toolProgressMode: 'silent',
      responseStyle: 'layered',
      layeredChunkTarget: 900,
      interChunkDelayMs: 180,
      ...config,
    };
    this.#runtime = runtime;
    this.#sessionManager = sessionManager;
    try { this.#sessionManager?.pruneInboundEvents('-7 days'); } catch {}
    this.#chatId = config.allowedUserId; // For private chats, chatId === userId
    this.#bot = new Bot(config.token);
    installIpv4Transformer(this.#bot, config.token);

    this.#setupMiddleware();
    this.#setupHandlers();
    this.#setupErrorHandling();

    // Start periodic cleanup of stale turns (every 5 minutes)
    this.#cleanupInterval = setInterval(() => {
      const now = Date.now();
      // Orphan cleanup must exceed the configured session timeout (Layer 3) by 5 min.
      const sessionTimeoutMs = this.#runtime?.getRuntimeLimits?.()?.sessionTimeoutMs ?? 14_400_000;
      const maxTurnAge = sessionTimeoutMs + 5 * 60 * 1000;
      let cleaned = 0;

      // Clean up activeTurns older than Layer-3 timeout + 5min (orphan safety net, NOT the primary timeout)
      for (const [sessionId, turn] of this.#activeTurns) {
        if (turn.startTime && (now - turn.startTime) > maxTurnAge) {
          try { turn.controller?.abort('orphan_cleanup'); } catch {}
          this.#activeTurns.delete(sessionId);
          cleaned++;
          console.log(`  [Telegram] Orphan cleanup: removed stale turn ${sessionId} (age > 95min)`);

        }
      }

      // Clean up sessionTurnQueue orphaned promises
      for (const [sessionId, promise] of this.#sessionTurnQueue) {
        if (promise && promise.constructor.name === 'Promise' && !promise.finally) {
          // Dead promise detected, remove it
          this.#sessionTurnQueue.delete(sessionId);
          cleaned++;
        }
      }

      if (cleaned > 0 && global.TIMING_LOGS) {
        console.log(`[Telegram] Cleanup: removed ${cleaned} stale turns`);
      }
    }, 5 * 60 * 1000); // 5 minute interval
  }

  /**
   * User-facing message when the LLM endpoint is unreachable.
   * Tailored to local proxy vs remote provider so OSS user see relevant advice.
   */
  #formatLlmUnreachableMessage() {
    const healthUrl = this.#getProxyHealthUrl();
    if (healthUrl) {
      return (
        '⚠️ LLM connection failed (proxy not responding)\n\n' +
        'Possible causes:\n' +
        '• Local proxy process crashed — restart the affected port\n' +
        '• Upstream OAuth/credentials expired, or a subprocess hung\n' +
        '• Check the proxy logs, or run start.sh to restart\n\n' +
        'Try sending again shortly, or restart the proxy manually and retry.'
      );
    }
    return (
      '⚠️ LLM connection failed (remote provider not responding)\n\n' +
      'Possible causes:\n' +
      '• Network unreachable / DNS resolution failed\n' +
      '• Provider API temporarily unavailable or rate-limited\n' +
      '• API key invalid or quota exhausted\n\n' +
      'Try sending again shortly.'
    );
  }

  /**
   * Derive a proxy /health URL from the configured LLM baseUrl.
   * Returns null when baseUrl is remote (no local proxy to ping) so callers can skip cleanly.
   */
  #getProxyHealthUrl() {
    const baseUrl = this.#runtime?.llm?.config?.baseUrl;
    if (!baseUrl) return null;
    try {
      const u = new URL(baseUrl);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
      return `${u.protocol}//${u.host}/health`;
    } catch {
      return null;
    }
  }

  // ─── Middleware Chain ───────────────────────────────────────────────

  #setupMiddleware() {
    // 1. Auth guard — only allow Founder
    this.#bot.use(async (ctx, next) => {
      const userId = String(ctx.from?.id || '');
      if (userId !== this.#config.allowedUserId) {
        this.emit('unauthorized', { userId, user: ctx.from?.user });
        // Silent reject — don't reveal bot exists to strangers
        return;
      }
      await next();
    });

    // 2. Rate limit — prevent accidental flood from rapid messages
    this.#bot.use(async (ctx, next) => {
      const userId = String(ctx.from?.id || '');
      const now = Date.now();
      const lastMsg = this.#rateLimitMap.get(userId) || 0;

      if (now - lastMsg < RATE_LIMIT_WINDOW_MS) {
        // Still process, but queue — grammY handles sequentially per chat
      }
      this.#rateLimitMap.set(userId, now);
      await next();
    });
  }

  // ─── Message Handlers ─────────────────────────────────────────────

  /** @type {import('./db-snapshots.js').DbSnapshotManager|null} */
  #dbSnapshots = null;

  /** @param {import('./db-snapshots.js').DbSnapshotManager|null} mgr */
  setDbSnapshots(mgr) {
    this.#dbSnapshots = mgr;
  }

  /** @type {import('./behavior-logger.js').BehaviorLogger|null} */
  #behaviorLogger = null;

  /** @param {import('./behavior-logger.js').BehaviorLogger|null} logger */
  setBehaviorLogger(logger) {
    this.#behaviorLogger = logger;
  }

  #setupHandlers() {
    // /mimir command handler — toggle autonomous exploration on/off
    this.#bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text?.trim();
      if (!text?.startsWith('/mimir')) return next();

      this.#chatId = String(ctx.chat.id);
      try {
        const sub = text.replace(/^\/mimir\s*/, '').trim().toLowerCase();
        const mimirParsed = new URL(MIMIR_URL);
        const { request: httpReq } = await import('http');

        const mimirFetch = (method, body) => new Promise((resolve, reject) => {
          const opts = { hostname: mimirParsed.hostname, port: parseInt(mimirParsed.port || '18810', 10), path: '/config', method,
            headers: { 'Content-Type': 'application/json' } };
          const req = httpReq(opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              let parsed = {};
              try { parsed = JSON.parse(data); } catch { /* leave empty */ }
              parsed.__status = res.statusCode || 0;
              resolve(parsed);
            });
          });
          req.on('error', reject);
          if (body) req.write(JSON.stringify(body));
          req.end();
        });
        const isOk = (r) => r && r.__status >= 200 && r.__status < 300 && !r.error;
        const errMsg = (r) => r?.error || (r?.__status ? `HTTP ${r.__status}` : 'unknown error');

        // v3 actions — picker chooses one per wakeup; toggles are per-action.
        const V3_ACTIONS = ['reflection', 'curation', 'tension', 'profile', 'fetch', 'outreach'];

        const fmtAutonomy = (a) => {
          if (!a) return '  (autonomy block missing — daemon may not be upgraded)';
          const enabledV3 = Array.isArray(a.v3_enabled_actions) && a.v3_enabled_actions.length
            ? a.v3_enabled_actions.join(', ')
            : '(none)';
          const cap = a.v3_outreach_daily_cap;
          const capStr = cap === 0 ? '∞' : (cap ?? '?');
          const counts = Object.entries(a.today_counts || {})
            .map(([m, n]) => `${m}=${n}`).join(' ');
          return [
            `  α: ${(a.alpha ?? 1).toFixed(3)}   Quiet: ${a.quiet_hours_now ? '🌙 quiet' : '☀️ active'} (tz=${a.quiet_tz || 'system'})`,
            `  Actions: ${enabledV3}`,
            `  Outreach cap: ${capStr}/day   Kill: master=${a.kill_switch ? '🛑' : '—'}  actions=${a.v3_kill_switch ? '🛑' : '—'}  outreach=${a.outreach_kill ? '🛑' : '—'}`,
            `  Today:    ${counts || '(none)'}`,
          ].join('\n');
        };

        const printStatus = async () => {
          const cfg = await mimirFetch('GET');
          const lines = [
            '🧠 Mímir status',
            '',
            '— Master switches —',
            `  Curiosity (master): ${cfg.curiosity_enabled ? '✅' : '❌'}   Rumination: ${cfg.rumination_enabled ? '✅' : '❌'}`,
            '',
            '— Autonomy (1 trigger × 6 actions) —',
            fmtAutonomy(cfg.autonomy),
            '',
            'Commands:',
            '  /mimir auto on|off          Master switch (curiosity/rumination; defaults OFF after restart)',
            '  /mimir status               Current status',
            '  /mimir action <name> on|off Single action: ' + V3_ACTIONS.join('/'),
            '  /mimir cap <N>              Outreach daily cap (0=∞)',
            '  /mimir kill                 Emergency stop for all autonomy actions',
            '  /mimir outreach kill|clear  Global outreach emergency lock',
          ];
          await ctx.reply(lines.join('\n'));
        };

        // —— Dispatch ——
        if (!sub || sub === 'status') {
          await printStatus();
        } else if (sub === 'auto on' || sub === 'auto off') {
          // Master switch: curiosity (rumination kept on by default — flip via dashboard).
          const enable = sub === 'auto on';
          const r = await mimirFetch('POST', { curiosity_enabled: enable });
          if (!isOk(r)) await ctx.reply(`❌ auto ${enable ? 'on' : 'off'} failed: ${errMsg(r)}`);
          else await ctx.reply(enable
            ? '✅ Mímir master switch enabled (curiosity ON)'
            : '⏸️ Mímir master switch disabled (curiosity OFF)');
        } else if (sub === 'on' || sub === 'off') {
          // Renamed — non-destructive notice.
          await ctx.reply('ℹ️ /mimir on|off has been renamed to /mimir auto on|off');
        } else if (sub === 'kill') {
          // v3 kill: clear enabled_actions + master OFF.
          const r1 = await mimirFetch('POST', { curiosity_enabled: false });
          const r2 = await mimirFetch('POST', { autonomy_v3_enabled_actions: [] });
          const ok = isOk(r1) && isOk(r2);
          if (!ok) await ctx.reply(`❌ kill partially failed: ${errMsg(r1)} / ${errMsg(r2)}`);
          else await ctx.reply('🛑 Autonomy fully stopped (master OFF + 6 actions cleared).\nUse /mimir auto on + /mimir action <name> on to restart individually.');
        } else if (sub.startsWith('action')) {
          // /mimir action <name> on|off
          const parts = sub.replace(/^action\s*/, '').trim().split(/\s+/);
          const [name, op] = parts;
          if (!V3_ACTIONS.includes(name) || !['on', 'off'].includes(op)) {
            await ctx.reply(`❌ Usage: /mimir action <${V3_ACTIONS.join('|')}> on|off`);
          } else {
            const r = await mimirFetch('POST', {
              autonomy_v3_action_toggle: { action: name, on: op === 'on' },
            });
            if (!isOk(r)) await ctx.reply(`❌ action ${name} ${op} failed: ${errMsg(r)}`);
            else await ctx.reply(`✅ action ${name} = ${op}\n` + (r.changed?.join('\n') || ''));
          }
        } else if (sub.startsWith('cap')) {
          const arg = sub.replace(/^cap\s*/, '').trim();
          const n = parseInt(arg, 10);
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            await ctx.reply('❌ Usage: /mimir cap <N>  (0=∞, max 100)');
          } else {
            const r = await mimirFetch('POST', { autonomy_v3_outreach_daily_cap: n });
            if (!isOk(r)) await ctx.reply(`❌ cap ${n} failed: ${errMsg(r)}`);
            else await ctx.reply(`✅ outreach cap = ${n === 0 ? '∞' : n}/day\n` + (r.changed?.join('\n') || ''));
          }
        } else if (sub.startsWith('outreach')) {
          const arg = sub.replace(/^outreach\s*/, '').trim();
          if (arg === 'kill') {
            const r = await mimirFetch('POST', { autonomy_outreach_kill: true });
            if (!isOk(r)) await ctx.reply(`❌ outreach kill failed: ${errMsg(r)}`);
            else await ctx.reply('🛑 Outreach global lock enabled (no sends even if actions are on).');
          } else if (arg === 'clear') {
            const r = await mimirFetch('POST', { autonomy_outreach_kill: false });
            if (!isOk(r)) await ctx.reply(`❌ outreach clear failed: ${errMsg(r)}`);
            else await ctx.reply('✅ Outreach global lock cleared.');
          } else {
            await ctx.reply('Usage: /mimir outreach kill | clear');
          }
        } else {
          await printStatus();
        }
      } catch (e) {
        await ctx.reply(`❌ Mímir communication failed: ${e.message}`);
      }
    });

    // /timing command handler — toggle timing/debug logs
    this.#bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text?.trim();
      if (!text?.startsWith('/timing')) return next();

      this.#chatId = String(ctx.chat.id);
      const sub = text.replace(/^\/timing\s*/, '').trim().toLowerCase();

      if (sub === 'on') {
        global.TIMING_LOGS = true;
        await ctx.reply('✅ Timing logs enabled ([buildSP] [TTFT] [Timing] [_embed] [BFS])');
      } else if (sub === 'off') {
        global.TIMING_LOGS = false;
        await ctx.reply('⏸️ Timing logs disabled');
      } else {
        await ctx.reply(
          `🔍 Timing logs: ${global.TIMING_LOGS ? '✅ ON' : '❌ OFF'}\n\nCommands: /timing on | /timing off`
        );
      }
    });

    // /restart command handler — graceful engine restart
    this.#bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text?.trim();
      if (!text?.startsWith('/restart')) return next();

      this.#chatId = String(ctx.chat.id);
      const reason = text.replace(/^\/restart\s*/, '').trim() || 'manual';
      await ctx.reply(`🔄 Engine restarting... (reason: ${reason})\nstart.sh will spawn a new instance automatically.`);

      // Write restart reason for start.sh to read
      const { writeFileSync } = await import('fs');
      const { resolve } = await import('path');
      const projectDir = resolve(new URL('.', import.meta.url).pathname, '..');
      try {
        writeFileSync(resolve(projectDir, '.restart-requested'), '1');
        writeFileSync(resolve(projectDir, '.restart-reason'), reason);
      } catch {}

      // Notify Mímir about any active sessions being interrupted
      for (const [sid, turn] of this.#activeTurns.entries()) {
        try {
          turn.controller.abort('engine_restart');
          this.#notifyMimirSessionEnd(sid, 'error', `Engine restart: ${reason}`, {});
        } catch {}
      }

      // Give Telegram time to deliver the message, then exit
      setTimeout(() => process.exit(0), 2000);
    });

    // /rollback command handler — DB snapshot rollback
    this.#bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text?.trim();
      if (!text?.startsWith('/rollback')) return next();

      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;
      if (!this.#claimTelegramUpdate(ctx, 'rollback', sessionId, text)) return;
      this.#startTyping(ctx);

      try {
        if (!this.#dbSnapshots) {
          this.#stopTyping(sessionId);
          await ctx.reply('⚠️ DbSnapshotManager not initialized.');
          return;
        }

        const sub = text.replace(/^\/rollback\s*/, '').trim();

        if (!sub || sub === 'help') {
          this.#stopTyping(sessionId);
          await ctx.reply(
            '📸 DB Rollback commands:\n\n' +
            '/rollback list — list available snapshots\n' +
            '/rollback latest — roll back to the latest snapshot\n' +
            '/rollback <id> — roll back to the specified snapshot\n' +
            '/rollback snap [reason] — manually create a snapshot'
          );
          return;
        }

        if (sub === 'list') {
          const snaps = this.#dbSnapshots.listSnapshots(10);
          if (snaps.length === 0) {
            this.#stopTyping(sessionId);
            await ctx.reply('📸 No snapshots available.');
            return;
          }
          const lines = snaps.map((s, i) =>
            `${i + 1}. <code>${s.id}</code> | ${s.sizeMB}MB | ${s.reason}`
          );
          this.#stopTyping(sessionId);
          await ctx.reply('📸 Available snapshots:\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
          return;
        }

        if (sub.startsWith('snap')) {
          const reason = sub.replace(/^snap\s*/, '').trim() || 'manual';
          const snap = await this.#dbSnapshots.createSnapshot(reason);
          this.#stopTyping(sessionId);
          await ctx.reply(`📸 Snapshot created: ${snap.id} (${snap.sizeMB}MB) — ${reason}`);
          return;
        }

        // Restore: /rollback latest OR /rollback <id>
        let targetId;
        if (sub === 'latest') {
          const snaps = this.#dbSnapshots.listSnapshots(1);
          if (snaps.length === 0) {
            this.#stopTyping(sessionId);
            await ctx.reply('⚠️ No snapshots available.');
            return;
          }
          targetId = snaps[0].id;
        } else {
          targetId = sub;
        }

        await ctx.reply(`⏳ Rolling back to snapshot ${targetId}...\nThe engine will restart once the rollback completes.`);
        const result = await this.#dbSnapshots.restoreSnapshot(targetId);
        this.#stopTyping(sessionId);
        await ctx.reply(
          `✅ Rollback complete!\n` +
          `Restored: ${result.restored.join(', ')}\n` +
          `Safety snapshot: ${result.safetySnapshotId}\n\n` +
          `🔄 Engine will restart in 3 seconds...`
        );
        // Write restart reason for start.sh
        const { writeFileSync: wfs } = await import('fs');
        const { resolve: rslv } = await import('path');
        const projDir = rslv(new URL('.', import.meta.url).pathname, '..');
        try {
          wfs(rslv(projDir, '.restart-requested'), '1');
          wfs(rslv(projDir, '.restart-reason'), `rollback:${targetId}`);
        } catch {}
        // Give Telegram time to deliver the message, then exit for restart
        setTimeout(() => process.exit(0), 3000);
      } catch (e) {
        this.#stopTyping(sessionId);
        await ctx.reply(`❌ Rollback error: ${e.message}`);
      }
    });

    // /engine command handler — toggle IR layers (episodic / deep / anchor / raw)
    // and inspect current model tier. Toggles take effect on the next turn.
    this.#bot.on('message:text', async (ctx, next) => {
      const text = ctx.message.text?.trim();
      if (!text?.startsWith('/engine')) return next();
      this.#chatId = String(ctx.chat.id);

      try {
        const sub = text.replace(/^\/engine\s*/, '').trim();
        const parts = sub.split(/\s+/).filter(Boolean);
        const cmd = (parts[0] || '').toLowerCase();
        const arg = (parts[1] || '').toLowerCase();

        const cur = this.#runtime?.getIrConfig?.() || {};
        const flag = (v) => v === false ? '❌ off' : '✅ on';

        const renderStatus = () => {
          const ep = cur.episodic || {};
          const dr = cur.deep_recall || {};
          const pa = cur.pool_anchor || {};
          const rc = cur.raw_context || {};
          const tier = process.env.ENGINE_MODEL_TIER || 'auto';
          return [
            '🧠 Engine IR layer status:',
            `  episodic   : ${flag(ep.enabled)}  (rerank_min=${ep.rerank_min ?? '?'}, top_k=${ep.top_k ?? '?'})`,
            `  deep_recall: ${flag(dr.enabled)}  (cutoff=${dr.cutoff_days ?? '?'}d)`,
            `  pool_anchor: ${flag(pa.enabled)}`,
            `  raw_context: ${flag(rc.enabled)}  (${rc.min_turns ?? '?'}–${rc.max_turns ?? '?'} turns)`,
            '',
            `  model tier : ${tier}  (env ENGINE_MODEL_TIER, restart to switch)`,
            '',
            'Commands:',
            '  /engine episodic on|off',
            '  /engine deep on|off',
            '  /engine anchor on|off',
            '  /engine raw on|off',
            '  /engine reset    — reload from config.json',
          ].join('\n');
        };

        if (!cmd || cmd === 'status') {
          await ctx.reply(renderStatus());
          return;
        }

        if (cmd === 'help') {
          await ctx.reply(renderStatus());
          return;
        }

        if (cmd === 'reset') {
          // Reload from disk so toggles revert to declared config
          try {
            const { resolve: rslv } = await import('path');
            const { readFileSync: rfs } = await import('fs');
            const projDir = rslv(new URL('.', import.meta.url).pathname, '..');
            const cfgPath = rslv(projDir, 'config.json');
            const fresh = JSON.parse(rfs(cfgPath, 'utf-8'));
            const ir = fresh?.engine?.ir || {};
            this.#runtime?.setIrConfig?.(ir);
            await ctx.reply('🔄 IR config reloaded from config.json.\n\n' + renderStatus());
          } catch (e) {
            await ctx.reply(`❌ Reset failed: ${e.message}`);
          }
          return;
        }

        const layerMap = {
          episodic: 'episodic',
          ep: 'episodic',
          deep: 'deep_recall',
          deep_recall: 'deep_recall',
          anchor: 'pool_anchor',
          pool_anchor: 'pool_anchor',
          raw: 'raw_context',
          raw_context: 'raw_context',
        };
        const layer = layerMap[cmd];
        if (layer && (arg === 'on' || arg === 'off')) {
          if (!this.#runtime?.setIrConfig) {
            await ctx.reply('⚠️ Runtime not available.');
            return;
          }
          this.#runtime.setIrConfig({ [layer]: { enabled: arg === 'on' } });
          await ctx.reply(`${arg === 'on' ? '✅' : '⏸️'} ${layer} → ${arg}\n(In-process only; config.json is not modified. Reverts to disk value after restart. Use /engine reset to sync manually.)`);
          return;
        }

        await ctx.reply('❓ Unknown command.\n\n' + renderStatus());
      } catch (e) {
        await ctx.reply(`❌ /engine error: ${e.message}`);
      }
    });

    // Text messages — fire-and-forget so grammY can deliver subsequent messages for interrupt detection
    this.#bot.on('message:text', (ctx) => {
      const text = ctx.message.text;
      if (!text?.trim()) return;

      // Store chatId for proactive sends
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;
      if (!this.#claimTelegramUpdate(ctx, 'text', sessionId, text)) return;

      this.#handleUserMessage(ctx, text).catch(err =>
        this.emit('error', { error: err, context: 'text_handler', sessionId }));
    });

    // Photo with caption — download and pass to vision
    this.#bot.on('message:photo', async (ctx) => {
      const caption = ctx.message.caption || '';
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;

      // Pick highest resolution photo (last in array)
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];

      let localPath;
      try {
        localPath = await downloadTelegramFile(this.#bot, best.file_id, 'jpg');
      } catch (err) {
        this.emit('warning', { message: `Photo download failed: ${err.message}` });
        if (caption.trim()) {
          // Fallback: process caption only
          if (!this.#claimTelegramUpdate(ctx, 'photo', sessionId, `[📷 Photo] ${caption}`)) return;
          this.#handleUserMessage(ctx, `[📷 Photo — download failed] ${caption}`).catch(err =>
            this.emit('error', { error: err, context: 'photo_handler', sessionId }));
        } else {
          await ctx.reply('📷 Photo download failed, please retry.');
        }
        return;
      }

      const userText = caption.trim()
        ? `[📷 Photo saved to ${localPath} — please use the Read tool to view it]\n${caption}`
        : `[📷 Photo saved to ${localPath} — please use the Read tool to view it]`;
      if (!this.#claimTelegramUpdate(ctx, 'photo', sessionId, `[📷 Photo] ${caption}`)) return;
      this.#handleUserMessage(ctx, userText).catch(err =>
        this.emit('error', { error: err, context: 'photo_handler', sessionId }));
    });

    // Document/file — download and reference
    this.#bot.on('message:document', async (ctx) => {
      const caption = ctx.message.caption || '';
      const doc = ctx.message.document;
      const fileName = doc?.file_name || 'unknown';
      const mimeType = doc?.mime_type || '';
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;

      // Try to download the document
      const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
      let localPath;
      try {
        localPath = await downloadTelegramFile(this.#bot, doc.file_id, ext);
      } catch (err) {
        this.emit('warning', { message: `Document download failed: ${err.message}` });
        if (!this.#claimTelegramUpdate(ctx, 'document', sessionId, `[📎 File: ${fileName}] ${caption}`)) return;
        this.#handleUserMessage(ctx, `[📎 File: ${fileName} — download failed] ${caption}`).catch(err =>
          this.emit('error', { error: err, context: 'document_handler', sessionId }));
        return;
      }

      const isImage = mimeType.startsWith('image/');
      const readInstruction = isImage
        ? `[📎 Image file "${fileName}" saved to ${localPath} — please use the Read tool to view it]`
        : `[📎 File "${fileName}" saved to ${localPath} — please use the Read tool to read it]`;
      const userText = caption.trim() ? `${readInstruction}\n${caption}` : readInstruction;
      if (!this.#claimTelegramUpdate(ctx, 'document', sessionId, `[📎 File: ${fileName}] ${caption}`)) return;
      this.#handleUserMessage(ctx, userText).catch(err =>
        this.emit('error', { error: err, context: 'document_handler', sessionId }));
    });

    // Voice message — download audio for future STT
    this.#bot.on('message:voice', async (ctx) => {
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;
      const voice = ctx.message.voice;

      let localPath;
      try {
        localPath = await downloadTelegramFile(this.#bot, voice.file_id, 'ogg');
      } catch (err) {
        this.emit('warning', { message: `Voice download failed: ${err.message}` });
        await ctx.reply('🎙️ Voice download failed, please retry or send a text message.');
        return;
      }

      // Duration info for context
      const duration = voice.duration || 0;
      const userText = `[🎙️ Voice message (${duration}s) saved to ${localPath} — audio transcription not yet available. Please ask the user to resend as text if needed.]`;
      if (!this.#claimTelegramUpdate(ctx, 'voice', sessionId, `[🎙️ Voice ${duration}s]`)) return;
      this.#handleUserMessage(ctx, userText).catch(err =>
        this.emit('error', { error: err, context: 'voice_handler', sessionId }));
    });

    // Video message
    this.#bot.on('message:video', async (ctx) => {
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;
      const caption = ctx.message.caption || '';
      const video = ctx.message.video;
      const duration = video?.duration || 0;

      // Download video thumbnail if available for visual context
      let thumbPath;
      if (video?.thumbnail) {
        try {
          thumbPath = await downloadTelegramFile(this.#bot, video.thumbnail.file_id, 'jpg');
        } catch { /* ignore thumbnail failure */ }
      }

      const thumbNote = thumbPath
        ? ` Video thumbnail saved to ${thumbPath} — please use the Read tool to view it.`
        : '';
      const userText = caption.trim()
        ? `[🎬 Video (${duration}s) received.${thumbNote}]\n${caption}`
        : `[🎬 Video (${duration}s) received.${thumbNote}]`;
      if (!this.#claimTelegramUpdate(ctx, 'video', sessionId, `[🎬 Video ${duration}s] ${caption}`)) return;
      this.#handleUserMessage(ctx, userText).catch(err =>
        this.emit('error', { error: err, context: 'video_handler', sessionId }));
    });

    // Video note (round video messages)
    this.#bot.on('message:video_note', async (ctx) => {
      this.#chatId = String(ctx.chat.id);
      const sessionId = `tg:${ctx.from.id}`;
      const vn = ctx.message.video_note;
      const duration = vn?.duration || 0;

      let thumbPath;
      if (vn?.thumbnail) {
        try {
          thumbPath = await downloadTelegramFile(this.#bot, vn.thumbnail.file_id, 'jpg');
        } catch { /* ignore */ }
      }

      const thumbNote = thumbPath
        ? ` Thumbnail saved to ${thumbPath} — please use the Read tool to view it.`
        : '';
      const userText = `[🎬 Video note (${duration}s) received.${thumbNote}]`;
      if (!this.#claimTelegramUpdate(ctx, 'video_note', sessionId, `[🎬 VideoNote ${duration}s]`)) return;
      this.#handleUserMessage(ctx, userText).catch(err =>
        this.emit('error', { error: err, context: 'video_note_handler', sessionId }));
    });

    // Callback queries (inline button responses)
    this.#bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      await ctx.answerCallbackQuery();
      this.#chatId = String(ctx.chat?.id || this.#chatId);
      const sessionId = `tg:${ctx.from.id}`;
      if (!this.#claimTelegramUpdate(ctx, 'callback', sessionId, data)) return;
      this.#handleUserMessage(ctx, data).catch(err =>
        this.emit('error', { error: err, context: 'callback_handler', sessionId }));
    });
  }

  #claimTelegramUpdate(ctx, eventType, sessionId, payloadPreview = '') {
    const updateId = ctx.update?.update_id;
    if (updateId == null) return true;
    const cacheKey = `${eventType}:${updateId}`;
    const seenAt = this.#processedUpdateCache.get(cacheKey);
    if (seenAt && (Date.now() - seenAt) < 6 * 60 * 60 * 1000) {
      this.emit('duplicate_update', { updateId, eventType, sessionId, source: 'memory-cache' });
      return false;
    }

    const hash = createHash('sha1').update(String(payloadPreview || '')).digest('hex');
    const claimed = this.#sessionManager
      ? this.#sessionManager.claimInboundEvent('telegram', String(updateId), {
          sessionId,
          eventType,
          payloadHash: hash,
          payloadPreview: String(payloadPreview || '').slice(0, 240),
        })
      : true;

    if (!claimed) {
      this.#processedUpdateCache.set(cacheKey, Date.now());
      this.emit('duplicate_update', { updateId, eventType, sessionId, source: 'sqlite' });
      return false;
    }

    this.#processedUpdateCache.set(cacheKey, Date.now());
    // Aggressive cleanup: remove entries older than 6 hours, limit to 2000 entries
    if (this.#processedUpdateCache.size > 2000) {
      const cutoff = Date.now() - (6 * 60 * 60 * 1000);
      let removed = 0;
      for (const [key, ts] of this.#processedUpdateCache) {
        if (ts < cutoff) {
          this.#processedUpdateCache.delete(key);
          removed++;
        }
      }
      // If still over 2000, remove oldest 20% by timestamp
      if (this.#processedUpdateCache.size > 2000) {
        const entries = Array.from(this.#processedUpdateCache.entries());
        entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
        const toRemove = Math.floor(entries.length * 0.2); // Remove oldest 20%
        for (let i = 0; i < toRemove; i++) {
          this.#processedUpdateCache.delete(entries[i][0]);
        }
      }
    }
    return true;
  }

  // ─── Core Message Processing ──────────────────────────────────────

  /**
   * Process a user message through the agent runtime.
   * @param {import('grammy').Context} ctx - grammY context
   * @param {string} text - User message text
   */
  async #handleUserMessage(ctx, text) {
    const sessionId = `tg:${ctx.from.id}`;
    const interruptEnabled = this.#config.interruptEnabled !== false;
    const debounceMs = this.#config.interruptDebounceMs || 500;

    // ─── Mímir Signal (fire-and-forget, BEFORE interrupt check) ────────────────
    // Every message must reach Mímir regardless of whether it's processed or queued
    this.#signalMimir(text, sessionId).catch(e => console.error('  [Mímir] signalMimir rejected:', e?.message || e));

    // ─── Mímir Outreach Response Correlator (Step 7 prerequisite) ──────────────
    // Every founder inbound is a candidate "response" to a recent outreach.
    // Daemon resolves against the most-recent sent-but-unanswered audit row
    // within a 6h window. Critical for the anti-loop detector — without this,
    // user_response_at stays NULL forever and 3 outreaches → permanent disable.
    this.#notifyMimirOutreachResponse().catch(() => {});

    // ─── Interrupt detection: check if there's an active turn for this session ───
    // Don't interrupt auto-resume — queue the message instead
    if (this._resumeInProgress) {
      console.log(`  [Auto-resume] Message queued during resume: "${(text || '').slice(0, 50)}"`);
      // Queue message — it will be processed after resume completes
      const activeTurn = this.#activeTurns.get(sessionId);
      if (activeTurn) {
        activeTurn.pendingMessages.push({ ctx, text });
      }
      return;
    }
    const activeTurn = this.#activeTurns.get(sessionId);
    if (activeTurn && interruptEnabled) {
      const trimmed = (text || '').trim().toLowerCase();
      console.log(`  🔴 Interrupt detected: "${trimmed.slice(0, 50)}" while processing "${(activeTurn.originalMessage || '').slice(0, 50)}"`);

      // Cancel detection: short message matching cancel patterns
      if (trimmed.length < 30 && TelegramBot.#CANCEL_PATTERNS.some(p => trimmed.includes(p))) {
        console.log(`  🔴 Cancel pattern matched — aborting current turn`);
        // Clear any pending debounce
        if (activeTurn.debounceTimer) clearTimeout(activeTurn.debounceTimer);
        // Abort current turn
        activeTurn.controller.abort('interrupted_by_user');
        try { await activeTurn.turnPromise; } catch {}
        this.#activeTurns.delete(sessionId);
        // Reply with confirmation
        try { await ctx.reply('OK, cancelled.'); } catch {}
        return;
      }

      // Non-cancel interrupt: queue message and debounce
      activeTurn.pendingMessages.push({ ctx, text });
      // Reset debounce timer
      if (activeTurn.debounceTimer) clearTimeout(activeTurn.debounceTimer);
      activeTurn.debounceTimer = setTimeout(async () => {
        try {
          // Abort current turn
          activeTurn.controller.abort('interrupted_by_user');
          try { await activeTurn.turnPromise; } catch {}
          this.#activeTurns.delete(sessionId);

          // Store all pending messages into session history as individual user turns (ZeroClaw pattern)
          const pending = activeTurn.pendingMessages;
          if (this.#sessionManager && pending.length > 0) {
            // Store all but the last as history-only user messages
            for (let i = 0; i < pending.length - 1; i++) {
              this.#sessionManager.addMessage(sessionId, { role: 'user', content: pending[i].text });
            }
          }

          // Process the LAST pending message as a new turn
          const lastMsg = pending[pending.length - 1];
          this.#handleUserMessage(lastMsg.ctx, lastMsg.text).catch(err =>
            this.emit('error', { error: err, context: 'interrupt_reprocess', sessionId }));
        } catch (err) {
          this.emit('error', { sessionId, error: err, context: 'interrupt_debounce' });
        }
      }, debounceMs);
      return;
    }

    // ─── Normal flow: no active turn or interrupts disabled ───
    const previous = this.#sessionTurnQueue.get(sessionId) || Promise.resolve();
    const current = previous.catch(e => console.warn('[Telegram] Previous turn error (continuing):', e?.message?.slice(0, 200))).then(() => this.#handleUserMessageInner(ctx, text, sessionId));
    this.#sessionTurnQueue.set(sessionId, current);
    current.finally(() => {
      if (this.#sessionTurnQueue.get(sessionId) === current) {
        this.#sessionTurnQueue.delete(sessionId);
      }
    });
    return current;
  }

  async #handleUserMessageInner(ctx, text, sessionId, _retryCount = 0, _opts = {}) {
    const startTime = Date.now();

    // Pre-turn proxy health check — detect dead local proxy before committing to a full turn.
    // Skipped automatically when baseUrl is a remote provider (no local proxy to ping).
    const _proxyHealthUrl = this.#getProxyHealthUrl();
    if (_proxyHealthUrl) {
      try {
        await fetch(_proxyHealthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
      } catch (proxyErr) {
        console.warn(`[Telegram] Pre-turn proxy ping failed: ${proxyErr.message?.slice(0, 100)}, waiting 5s for recovery...`);
        await new Promise(r => setTimeout(r, 5000));
        // Second attempt after wait
        try {
          await fetch(_proxyHealthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
        } catch {
          console.warn('[Telegram] Pre-turn proxy ping still failed after 5s wait, proceeding anyway (network retry will handle it)');
        }
      }
    }

    // Start typing indicator
    this.#startTyping(ctx);

    // (Mímir signal already sent in #handleUserMessage before interrupt check)

    // Variables that need to be accessible in both try and catch blocks
    const progressMode = this.#config.toolProgressMode || 'silent';
    let statusMsgId = null;
    let slowStatusTimer = null;
    let draftEditTimer = null;
    let draftMsgId = null;
    let draftBuffer = '';
    let onTextDelta = null;
    let sessionTimeout = null;
    let turnController = null;

    try {
      this.emit('message_in', {
        userId: String(ctx.from.id),
        text: text.slice(0, 200), // Truncate for logging
        sessionId,
      });

      // ─── Progress UX ───────────────────────────────────────────────
      let statusLines = [];
      let lastStatusUpdate = 0;
      const STATUS_DEBOUNCE = 1500;

      const updateStatus = async (force = false) => {
        if (progressMode !== 'verbose') return;
        if (!force && Date.now() - lastStatusUpdate < STATUS_DEBOUNCE) return;
        if (statusLines.length === 0) return;
        const statusText = '🔄 ' + statusLines.slice(-8).join('\n');
        try {
          if (!statusMsgId) {
            const msg = await ctx.reply(statusText, { parse_mode: undefined });
            statusMsgId = msg.message_id;
          } else {
            await ctx.api.editMessageText(ctx.chat.id, statusMsgId, statusText);
          }
          lastStatusUpdate = Date.now();
        } catch { /* ignore */ }
      };

      const showCompactStatus = async () => {
        if (progressMode !== 'compact' || statusMsgId) return;
        try {
          const msg = await ctx.reply('🔄 Processing, please wait…', { parse_mode: undefined });
          statusMsgId = msg.message_id;
        } catch { /* ignore */ }
      };

      const onToolCall = ({ name, sessionId: sid }) => {
        if (progressMode !== 'verbose' || sid !== sessionId) return;
        statusLines.push(`🔧 ${name}...`);
        updateStatus();
      };
      const onToolResult = ({ name, sessionId: sid, result: rawResult }) => {
        if (progressMode !== 'verbose' || sid !== sessionId) return;
        const preview = typeof rawResult === 'string' ? rawResult.slice(0, 60) : '';
        statusLines.push(`✅ ${name}${preview ? ': ' + preview.replace(/\n/g, ' ') : ''}`);
        updateStatus();
      };
      const onChunk = ({ sessionId: sid, hasToolCalls }) => {
        if (progressMode !== 'verbose' || sid !== sessionId) return;
        if (hasToolCalls) {
          statusLines.push('💭 thinking → tools...');
          updateStatus();
        }
      };

      if (progressMode === 'verbose') {
        this.#runtime.on('toolCall', onToolCall);
        this.#runtime.on('toolResult', onToolResult);
        this.#runtime.on('llmChunk', onChunk);
      } else if (progressMode === 'compact') {
        slowStatusTimer = setTimeout(() => { showCompactStatus().catch(() => {}); }, 7000);
      }

      // ─── Draft Streaming Setup ───────────────────────────────────────
      // Subscribe to textDelta events for real-time Telegram message updates.
      // The LLM streams tokens → agent-runtime emits textDelta → we edit a Telegram message.
      // (draftMsgId, draftBuffer, draftEditTimer declared before try block for catch access)
      let draftLastEditAt = 0;         // timestamp of last editMessageText call
      let draftFinalized = false;      // true after final edit
      let draftFinalizedMsgIds = [];   // all message_ids we've sent (for cleanup on error)
      let draftLastEditContent = '';   // track last sent content to avoid "message not modified" error
      let draftEditInFlight = false;   // prevent concurrent edit calls
      const DRAFT_EDIT_INTERVAL_MS = 400;  // min ms between edits (Telegram rate limit friendly)
      const DRAFT_MIN_CHARS = 30;          // don't send the very first edit until we have some content
      const DRAFT_MAX_CHARS = 3800;        // start a new message before hitting 4096 limit (leave room for HTML)

      const flushDraft = async () => {
        if (draftFinalized || !draftBuffer.trim() || draftEditInFlight) return;
        // Strip complete DEBRIEF hints and any trailing partial hint marker from streaming buffer
        let displayBuffer = draftBuffer.trimEnd()
          .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')  // complete hints
          .replace(/<!--\s*DEBRIEF:[^>]*$/s, '')                // partial hint at end of stream
          .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '')   // Ratatoskr L0 (complete)
          .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]*$/s, '');     // Ratatoskr L0 (partial at stream end)
        if (!displayBuffer.trim()) return;
        const html = markdownToHtml(displayBuffer);
        const truncated = html.slice(0, TELEGRAM_MAX_LENGTH - 20);
        const withCursor = truncated + ' ▍';

        // Avoid "message is not modified" error from Telegram
        if (draftMsgId && withCursor === draftLastEditContent) return;

        draftEditInFlight = true;
        try {
          if (!draftMsgId) {
            // First message — send new
            const msg = await ctx.reply(withCursor, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            draftMsgId = msg.message_id;
            draftFinalizedMsgIds.push(draftMsgId);
            // Race guard: if turn finished while ctx.reply() was in-flight,
            // the cleanup at line ~1557 missed this message. Delete it now.
            if (draftFinalized) {
              ctx.api.deleteMessage(ctx.chat.id, draftMsgId).catch(() => {});
              return;
            }
          } else {
            // Update existing draft
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, withCursor, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          }
          draftLastEditContent = withCursor;
          draftLastEditAt = Date.now();
        } catch (err) {
          // "message is not modified" — harmless, ignore
          if (err?.error_code === 400 && err?.description?.includes('not modified')) {
            // no-op
          }
          // HTML parse error — fall back to plain text
          else if (err?.error_code === 400 && err?.description?.includes('parse')) {
            try {
              // Strip pulse markers before fallback send — same chain as flushDraft above.
              // Without this, raw DEBRIEF/TOUCH HTML comments leak verbatim to the user
              // whenever markdownToHtml output trips Telegram's HTML parser.
              const plain = draftBuffer.trimEnd()
                .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')
                .replace(/<!--\s*DEBRIEF:[^>]*$/s, '')
                .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '')
                .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]*$/s, '');
              if (!plain.trim()) return;
              const plainWithCursor = plain.slice(0, TELEGRAM_MAX_LENGTH - 20) + ' ▍';
              if (!draftMsgId) {
                const msg = await ctx.reply(plainWithCursor);
                draftMsgId = msg.message_id;
                draftFinalizedMsgIds.push(draftMsgId);
                if (draftFinalized) {
                  ctx.api.deleteMessage(ctx.chat.id, draftMsgId).catch(() => {});
                  return;
                }
              } else {
                await ctx.api.editMessageText(ctx.chat.id, draftMsgId, plainWithCursor);
              }
              draftLastEditContent = plainWithCursor;
              draftLastEditAt = Date.now();
            } catch { /* give up on this edit */ }
          }
          // 429 or other errors — skip this edit, next one will catch up
        } finally {
          draftEditInFlight = false;
        }
      };

      const scheduleDraftFlush = () => {
        if (draftFinalized) return;
        if (draftEditTimer) return; // already scheduled
        const elapsed = Date.now() - draftLastEditAt;
        const delay = Math.max(0, DRAFT_EDIT_INTERVAL_MS - elapsed);
        draftEditTimer = setTimeout(() => {
          draftEditTimer = null;
          flushDraft().catch(() => {});
        }, delay);
      };

      // When tool calls happen, suppress draft streaming for the next LLM round.
      // Only the FINAL round (no tool_calls) gets shown to the user.
      // During tool work the user sees a typing indicator, then the final answer streams in.
      let draftSuppressed = false;

      const onToolCallDraft = ({ sessionId: sid }) => {
        if (sid !== sessionId || draftFinalized) return;
        draftSuppressed = true;
        // Delete any visible draft from the interrupted round
        if (draftMsgId) {
          ctx.api.deleteMessage(ctx.chat.id, draftMsgId).catch(() => {});
          const idx = draftFinalizedMsgIds.indexOf(draftMsgId);
          if (idx >= 0) draftFinalizedMsgIds.splice(idx, 1);
          draftMsgId = null;
        }
        draftBuffer = '';
        draftLastEditContent = '';
      };
      this.#runtime.on('toolCall', onToolCallDraft);

      // When a new LLM round starts WITHOUT tool calls, it's the final answer.
      // The llmChunk event tells us whether this round has tool calls.
      const onLlmChunk = ({ sessionId: sid, hasToolCalls }) => {
        if (sid !== sessionId || draftFinalized) return;
        if (!hasToolCalls) {
          // This is the final round — un-suppress draft streaming
          draftSuppressed = false;
        }
      };
      this.#runtime.on('llmChunk', onLlmChunk);

      onTextDelta = ({ sessionId: sid, text: deltaText }) => {
        if (sid !== sessionId || draftFinalized) return;

        // During tool rounds, accumulate silently but don't show to user
        if (draftSuppressed) return;

        draftBuffer += deltaText;

        // If buffer is getting close to Telegram limit, finalize current message and start new one
        if (draftBuffer.length > DRAFT_MAX_CHARS && draftMsgId) {
          // Synchronously mark: we need to split
          const splitPoint = draftBuffer.lastIndexOf('\n', DRAFT_MAX_CHARS);
          let cutAt = splitPoint > DRAFT_MAX_CHARS * 0.5 ? splitPoint : DRAFT_MAX_CHARS;
          // Don't cut inside a pulse marker — if we do, the trailing fragment
          // (e.g. `} -->`) starts the next message with no `<!--` opener and
          // leaks past every strip regex (which all anchor on `<!--`).
          // Pull the cut back to before the unterminated marker opener.
          const head = draftBuffer.slice(0, cutAt);
          const lastOpen = Math.max(head.lastIndexOf('<!--'), -1);
          if (lastOpen >= 0 && head.indexOf('-->', lastOpen) === -1) {
            cutAt = lastOpen;
          }
          const firstPart = draftBuffer.slice(0, cutAt);
          draftBuffer = draftBuffer.slice(cutAt);

          // Finalize current message (remove cursor), start new one.
          // Includes partial-marker strips: a marker can be split across the cut point,
          // leaving an unterminated `<!-- DEBRIEF: {...` at the tail of firstPart.
          const cleanFirst = firstPart.trimEnd()
            .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')
            .replace(/<!--\s*DEBRIEF:[^>]*$/s, '')
            .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '')
            .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]*$/s, '');
          const html = markdownToHtml(cleanFirst);
          ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML' }).catch(() => {});
          draftMsgId = null; // next flush will create a new message
          draftLastEditAt = Date.now();
          draftLastEditContent = '';
        }

        // Only start streaming to Telegram after we have enough content
        if (draftBuffer.length >= DRAFT_MIN_CHARS) {
          scheduleDraftFlush();
        }
      };

      this.#runtime.on('textDelta', onTextDelta);

      // Create AbortController for interrupt support + session timeout (hard safety net Layer 3).
      // Limit is hot-adjustable from Dashboard Settings via runtime.getRuntimeLimits().
      turnController = new AbortController();
      const sessionTimeoutMs = this.#runtime.getRuntimeLimits?.()?.sessionTimeoutMs ?? 14_400_000;
      sessionTimeout = setTimeout(async () => {
        const mins = Math.round(sessionTimeoutMs / 60000);
        console.log(`  [Telegram] Session ${sessionId} timeout (${mins}min hard safety net Layer 3)`);

        // Graceful: flush draft buffer to Telegram BEFORE aborting
        if (draftBuffer.trim() && !draftFinalized) {
          try {
            if (draftEditTimer) { clearTimeout(draftEditTimer); draftEditTimer = null; }
            const cleanBuf = draftBuffer.trimEnd()
              .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')
              .replace(/<!--\s*DEBRIEF:[^>]*$/s, '')
              .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '')
              .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]*$/s, '');
            const html = markdownToHtml(cleanBuf);
            const truncated = html.slice(0, TELEGRAM_MAX_LENGTH);
            if (draftMsgId) {
              await ctx.api.editMessageText(ctx.chat.id, draftMsgId, truncated, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            } else {
              const msg = await ctx.reply(truncated, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
              draftMsgId = msg.message_id;
              draftFinalizedMsgIds.push(draftMsgId);
            }
          } catch (flushErr) {
            console.error(`  [Telegram] Draft flush before abort failed: ${flushErr.message}`);
          }
        }

        turnController.abort('session_timeout');
      }, sessionTimeoutMs); // hard safety net (Layer 3); token budget is primary defense
      const turnPromise = this.#runtime.turn(sessionId, text, {
        source: 'telegram',
        trigger: _opts.trigger || 'telegram_message',
        eventKey: `telegram:${ctx.update.update_id}`,
        stream: true,
        signal: turnController.signal,
        sessionTokensUsed: _opts.sessionTokensUsed || 0,
      });

      // Register active turn so new messages can interrupt it
      this.#activeTurns.set(sessionId, {
        controller: turnController,
        turnPromise,
        pendingMessages: [],
        debounceTimer: null,
        originalMessage: text,
        ctx,
        startTime: Date.now(),
      });

      // Run through agent runtime WITH streaming enabled
      const result = await turnPromise;
      clearTimeout(sessionTimeout);

      // Clean up active turn tracking
      this.#activeTurns.delete(sessionId);

      // Unsubscribe from textDelta and toolCall draft handler
      this.#runtime.off('textDelta', onTextDelta);
      this.#runtime.off('toolCall', onToolCallDraft);
      this.#runtime.off('llmChunk', onLlmChunk);

      if (progressMode === 'verbose') {
        this.#runtime.off('toolCall', onToolCall);
        this.#runtime.off('toolResult', onToolResult);
        this.#runtime.off('llmChunk', onChunk);
      }
      if (slowStatusTimer) { clearTimeout(slowStatusTimer); slowStatusTimer = null; }
      if (draftEditTimer) { clearTimeout(draftEditTimer); draftEditTimer = null; }

      // Delete status message if it exists
      if (statusMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat.id, statusMsgId); } catch {}
      }

      // Stop typing
      this.#stopTyping(sessionId);

      // ─── Check for timeout auto-retry ───
      // Check both result.stopReason AND the AbortController signal directly
      // (signal check is fallback in case agent-runtime catches the error internally)
      // IMPORTANT: Only retry on session_timeout or max_tokens, NOT on user-initiated cancel/interrupt
      const wasNetworkError = result.stopReason === 'network_error';
      const wasDbLocked = result.stopReason === 'db_locked';
      const wasAborted = (result.stopReason === 'aborted' || turnController.signal.aborted) && !wasNetworkError && !wasDbLocked;
      const wasMaxTokens = result.stopReason === 'max_tokens';
      // Detect truncated response: ANY null/undefined stopReason is abnormal — always retry
      const wasTruncated = !result.stopReason;
      const wasUserCancel = turnController.signal.reason === 'interrupted_by_user';
      const wasTimeout = (wasAborted || wasMaxTokens || wasTruncated) && !wasUserCancel;
      // Always log turn completion for timeout diagnosis
      console.log(`  [Telegram] Turn completed: stopReason=${result.stopReason}, signal.aborted=${turnController.signal.aborted}, signal.reason=${turnController.signal.reason}, responseLen=${result.response?.length || 0}, retryCount=${_retryCount}`);
      liveBus.safeEmit('channel.turn', { channel: 'telegram', stopReason: result.stopReason || 'unknown', responseLen: result.response?.length || 0, aborted: turnController.signal.aborted || false, retries: _retryCount });
      const MAX_AUTO_RETRIES = 1; // Smart Timeout R2: only retry for max_tokens truncation

      // Debug logging for auto-retry diagnosis — log ALL abnormal conditions including null stopReason
      if (result.stopReason !== 'completed' || turnController.signal.aborted) {
        console.log(`  [Telegram] Auto-retry check: stopReason=${result.stopReason}, wasTruncated=${wasTruncated}, wasAborted=${wasAborted}, wasMaxTokens=${wasMaxTokens}, wasTimeout=${wasTimeout}, signal.aborted=${turnController.signal.aborted}, signal.reason=${turnController.signal.reason}, retryCount=${_retryCount}`);
      }

      // Retry decision matrix: only retry on max_tokens truncation
      // NO_RETRY: session_token_budget_exceeded, stall_detected, session_timeout, turn_token_budget_exceeded, max_tool_rounds, completed
      // RETRY_ONCE: max_tokens (LLM output truncation — normal behavior)
      const shouldRetry = wasMaxTokens && _retryCount < MAX_AUTO_RETRIES;

      if (shouldRetry) {
        // AUTO-RETRY: finalize draft (keep visible for user), notify, and continue
        draftFinalized = true;
        // Finalize draft message (remove cursor) — keep visible so user sees partial progress
        if (draftMsgId && draftBuffer.trim()) {
          try {
            const html = markdownToHtml(draftBuffer.trimEnd());
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch {}
        }

        // Kill orphan claude processes
        try { const { exec: killExec } = await import('node:child_process'); killExec("pkill -f 'claude.*--output-format' 2>/dev/null || true", { timeout: 5000 }); } catch {}

        const retryNum = _retryCount + 1;
        console.log(`  [Telegram] Auto-retry ${retryNum}/${MAX_AUTO_RETRIES} for session ${sessionId} (reason: max_tokens)`);
        const retryMsg = `✂️ Reply was truncated; auto-continuing... (${retryNum}/${MAX_AUTO_RETRIES})`;
        try { await ctx.reply(retryMsg); } catch {}

        // Build continuation message — session history already has partial response
        const checkpoint = '[System auto-continuation: the previous reply was cut off by the token limit. Please continue and complete the unfinished reply.]';

        // Notify Mímir about retry (fire-and-forget)
        this.#notifyMimirSessionEnd(sessionId, 'max_tokens_retrying', (result.response || '').slice(0, 300), {
          originalMessage: text,
          lastResponse: result.response || '',
        });

        // Clean up this turn's resources before recursing
        clearTimeout(sessionTimeout);
        this.#runtime.off('textDelta', onTextDelta);
        this.#runtime.off('toolCall', onToolCallDraft);
        this.#runtime.off('llmChunk', onLlmChunk);
        if (progressMode === 'verbose') {
          this.#runtime.off('toolCall', onToolCall);
          this.#runtime.off('toolResult', onToolResult);
          this.#runtime.off('llmChunk', onChunk);
        }

        // Recurse with incremented retry count — pass cumulative token usage
        const cumulativeTokens = (_opts.sessionTokensUsed || 0) + (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);
        return this.#handleUserMessageInner(ctx, checkpoint, sessionId, retryNum, { ..._opts, sessionTokensUsed: cumulativeTokens });
      }

      // ─── DB locked: SQLite contention — auto-retry silently (up to 2 times) ───
      if (wasDbLocked && _retryCount < 3) {
        draftFinalized = true;
        if (draftMsgId && draftBuffer.trim()) {
          try {
            const html = markdownToHtml(draftBuffer.trimEnd());
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch {}
        }
        const delay = 2000 * (_retryCount + 1); // 2s, 4s, 6s
        console.log(`  [Telegram] DB locked, auto-retry ${_retryCount + 1}/3 after ${delay}ms delay`);
        await new Promise(r => setTimeout(r, delay));
        clearTimeout(sessionTimeout);
        this.#runtime.off('textDelta', onTextDelta);
        this.#runtime.off('toolCall', onToolCallDraft);
        this.#runtime.off('llmChunk', onLlmChunk);
        if (progressMode === 'verbose') {
          this.#runtime.off('toolCall', onToolCall);
          this.#runtime.off('toolResult', onToolResult);
          this.#runtime.off('llmChunk', onChunk);
        }
        const checkpoint = draftBuffer.trim()
          ? '[System auto-continuation: database lock contention has cleared, please continue processing.]'
          : text;  // Re-process original message if no draft yet
        return this.#handleUserMessageInner(ctx, checkpoint, sessionId, _retryCount + 1, _opts);
      }
      if (wasDbLocked) {
        // Max retries exhausted — inform user
        draftFinalized = true;
        if (draftMsgId && draftBuffer.trim()) {
          try {
            const html = markdownToHtml(draftBuffer.trimEnd());
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch {}
        }
        try { await ctx.reply('⚠️ Database is temporarily busy, please retry shortly.'); } catch {}
        clearTimeout(sessionTimeout);
        this.#runtime.off('textDelta', onTextDelta);
        this.#runtime.off('toolCall', onToolCallDraft);
        this.#runtime.off('llmChunk', onLlmChunk);
        if (progressMode === 'verbose') {
          this.#runtime.off('toolCall', onToolCall);
          this.#runtime.off('toolResult', onToolResult);
          this.#runtime.off('llmChunk', onChunk);
        }
        // Clean up dead session state so next message starts fresh
        this.#activeTurns.delete(sessionId);
        return;
      }

      // ─── Network error: proxy/LLM down — no auto-retry, ask user to restart/retry manually ───
      if (wasNetworkError) {
        draftFinalized = true;
        if (draftMsgId && draftBuffer.trim()) {
          try {
            const html = markdownToHtml(draftBuffer.trimEnd());
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch {}
        }
        console.log(`  [Telegram] Network error (normal path), no auto-retry — notifying user`);
        try {
          await ctx.reply(this.#formatLlmUnreachableMessage());
        } catch {}
        clearTimeout(sessionTimeout);
        this.#runtime.off('textDelta', onTextDelta);
        this.#runtime.off('toolCall', onToolCallDraft);
        this.#runtime.off('llmChunk', onLlmChunk);
        if (progressMode === 'verbose') {
          this.#runtime.off('toolCall', onToolCall);
          this.#runtime.off('toolResult', onToolResult);
          this.#runtime.off('llmChunk', onChunk);
        }
        this.#activeTurns.delete(sessionId);
        return;
      }

      // ─── Normal finalize: replace draft preview with properly formatted response ───
      draftFinalized = true;
      // Wait for any in-flight draft edit to complete before deleting messages
      // Without this, delete and edit race on Telegram servers causing "swallow then reappear"
      if (draftEditInFlight) {
        const waitStart = Date.now();
        while (draftEditInFlight && Date.now() - waitStart < 3000) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      for (const msgId of draftFinalizedMsgIds) {
        try { await ctx.api.deleteMessage(ctx.chat.id, msgId); } catch {}
      }
      if (draftMsgId && !draftFinalizedMsgIds.includes(draftMsgId)) {
        try { await ctx.api.deleteMessage(ctx.chat.id, draftMsgId); } catch {}
      }

      if (result.response) {
        await this.#sendResponse(ctx, result.response);
      }

      this.emit('message_out', {
        sessionId,
        text: (result.response || '')
          .replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '')
          .replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '')
          .slice(0, 2000),
        responseLength: result.response?.length || 0,
        toolRounds: result.toolRounds,
        compacted: result.compacted,
        duration: Date.now() - startTime,
        usage: result.usage,
      });

      // Notify Mímir: check if session was aborted (timeout) or truly completed
      const sessionStatus = wasTimeout ? 'timeout' : 'completed';
      if (sessionStatus === 'timeout') {
        try { const { exec: killExec } = await import('node:child_process'); killExec("pkill -f 'claude.*--output-format' 2>/dev/null || true", { timeout: 5000 }); } catch {}
      }
      this.#notifyMimirSessionEnd(sessionId, sessionStatus, (result.response || '').slice(0, 300), {
        originalMessage: text,
        lastResponse: result.response || '',
      });

    } catch (err) {
      clearTimeout(sessionTimeout);
      this.#activeTurns.delete(sessionId);
      this.#stopTyping(sessionId);

      // Network errors (ECONNREFUSED etc.) — no auto-retry, ask user to restart/retry manually
      const isNetworkError = err.message?.includes('ECONNREFUSED') || err.message?.includes('ECONNRESET') || err.message?.includes('ENOTFOUND') || err.message?.includes('ECONNABORTED') || err.message?.includes('EPIPE') || err.message?.includes('ETIMEDOUT') || err.message?.includes('502') || err.message?.includes('503') || err.message?.includes('504');
      if (isNetworkError) {
        console.log(`  [Telegram] Network error (${err.message?.slice(0, 80)}), no auto-retry — notifying user`);
        try {
          await ctx.reply(this.#formatLlmUnreachableMessage());
        } catch {}
        try { this.#behaviorLogger?.finalizeSession(sessionId, 'error'); } catch {}
        this.#activeTurns.delete(sessionId);
        return;
      }
      // ─── DB locked in catch path: silent retry (up to 3 times with escalating delays) ───
      const isDbLockedCatch = err.message?.includes('database is locked') || err.message?.includes('SQLITE_BUSY');
      if (isDbLockedCatch && _retryCount < 3) {
        const delay = 2000 * (_retryCount + 1); // 2s, 4s, 6s — gives Mímir batch operations time to finish
        console.log(`  [Telegram] DB locked (catch path), auto-retry ${_retryCount + 1}/3 after ${delay}ms delay`);
        await new Promise(r => setTimeout(r, delay));
        return this.#handleUserMessageInner(ctx, text, sessionId, _retryCount + 1, _opts);
      }

      // Only retry on session_timeout, NOT on user-initiated cancel/interrupt
      const wasAbortedCatch = err.message?.includes('abort') || err.message?.includes('timeout') || turnController?.signal.aborted;
      const wasUserCancelCatch = turnController?.signal.reason === 'interrupted_by_user';
      const isTimeout = wasAbortedCatch && !wasUserCancelCatch;

      // Debug logging for auto-retry diagnosis (catch path)
      console.log(`  [Telegram] Catch path: err.message="${err.message?.slice(0, 200)}", err.name="${err.name}", signal.aborted=${turnController?.signal.aborted}, signal.reason=${turnController?.signal.reason}, isTimeout=${isTimeout}, retryCount=${_retryCount}`);

      // Kill orphan claude processes on timeout
      if (isTimeout) {
        try { const { exec: killExec } = await import('node:child_process'); killExec("pkill -f 'claude.*--output-format' 2>/dev/null || true", { timeout: 5000 }); } catch {}
      }

      // Clean up streaming state
      if (typeof draftEditTimer !== 'undefined' && draftEditTimer) { clearTimeout(draftEditTimer); }
      if (typeof onTextDelta === 'function') { this.#runtime.off('textDelta', onTextDelta); }
      if (typeof onToolCallDraft === 'function') { this.#runtime.off('toolCall', onToolCallDraft); }
      if (typeof onLlmChunk === 'function') { this.#runtime.off('llmChunk', onLlmChunk); }

      // Clean up status message on error
      if (statusMsgId) {
        try { await ctx.api.deleteMessage(ctx.chat.id, statusMsgId); } catch {}
      }

      if (progressMode === 'verbose') {
        this.#runtime.off('toolCall', onToolCall);
        this.#runtime.off('toolResult', onToolResult);
        this.#runtime.off('llmChunk', onChunk);
      }
      if (slowStatusTimer) { clearTimeout(slowStatusTimer); slowStatusTimer = null; }

      // AUTO-RETRY on timeout (catch path) — Smart Timeout R2: reduced to 1, only for legitimate timeouts
      const MAX_AUTO_RETRIES = 1;
      if (isTimeout && _retryCount < MAX_AUTO_RETRIES) {
        // Finalize draft message (remove cursor) — keep visible so user sees partial progress
        if (typeof draftMsgId !== 'undefined' && draftMsgId && typeof draftBuffer !== 'undefined' && draftBuffer.trim()) {
          try {
            const html = markdownToHtml(draftBuffer.trimEnd());
            await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          } catch {}
        }

        const retryNum = _retryCount + 1;
        console.log(`  [Telegram] Auto-retry ${retryNum}/${MAX_AUTO_RETRIES} for session ${sessionId} (from catch)`);
        try { await ctx.reply(`⏱ Timed out; auto-continuing... (${retryNum}/${MAX_AUTO_RETRIES})`); } catch {}

        const checkpoint = (typeof draftBuffer !== 'undefined' && draftBuffer)
          ? '[System auto-continuation: the previous turn timed out. Please continue and complete the unfinished task.]'
          : '[System auto-continuation: the previous turn timed out without producing a reply. Please re-process the user message above.]';

        this.#notifyMimirSessionEnd(sessionId, 'timeout_retrying', err.message?.slice(0, 300) || 'unknown', {
          originalMessage: text,
          lastResponse: typeof draftBuffer !== 'undefined' ? draftBuffer : '',
        });

        // Catch path: no result.usage available, pass existing cumulative (best effort)
        return this.#handleUserMessageInner(ctx, checkpoint, sessionId, retryNum, { ..._opts });
      }

      // Non-timeout error or max retries reached
      // If draft was in progress, remove the cursor from it
      if (typeof draftMsgId !== 'undefined' && draftMsgId && typeof draftBuffer !== 'undefined' && draftBuffer.trim()) {
        try {
          const html = markdownToHtml(draftBuffer.trimEnd());
          await ctx.api.editMessageText(ctx.chat.id, draftMsgId, html.slice(0, TELEGRAM_MAX_LENGTH), { parse_mode: 'HTML' });
        } catch {}
      }

      // Surface error to user
      const errorMsg = `⚠️ Processing error: ${err.message?.slice(0, 200) || 'Unknown error'}`;
      try {
        await ctx.reply(errorMsg);
      } catch (sendErr) {
        this.emit('error', { original: err, sendError: sendErr });
      }

      this.emit('error', { sessionId, error: err });

      // Notify Mímir: session ended with error/timeout
      const errType = isTimeout ? 'timeout' : 'error';
      this.#notifyMimirSessionEnd(sessionId, errType, err.message?.slice(0, 300) || 'unknown', {
        originalMessage: text,
        lastResponse: typeof draftBuffer !== 'undefined' ? draftBuffer : '',
      });
    }
  }

  // ─── Response Sending ─────────────────────────────────────────────

  /**
   * Send a response with HTML formatting, splitting if needed.
   * Falls back to plain text if HTML parsing fails.
   * @param {import('grammy').Context} ctx
   * @param {string} text
   */
  async #sendResponse(ctx, text) {
    // Strip DEBRIEF_HINT markers before sending to user (Layer 2 of Session Debrief)
    if (text.includes('DEBRIEF:')) {
      text = text.replace(/<!--\s*DEBRIEF:\s*\{[^}]+\}\s*-->/g, '').trim();
    }
    // Strip Ratatoskr L0 self-touch markers (anchor / task / cognitive — engine-only)
    if (text.includes('TOUCH:')) {
      text = text.replace(/<!--\s*(?:ANCHOR|TASK|COGNITIVE)_TOUCH:[\s\S]+?-->/g, '').trim();
    }
    const chunks = formatResponseChunks(text, {
      maxLen: this.#config.maxMessageLength,
      style: this.#config.responseStyle,
      targetLen: this.#config.layeredChunkTarget,
    });

    for (let i = 0; i < chunks.length; i++) {
      await this.#sendWithRetry(ctx, chunks[i], {
        parse_mode: 'HTML',
        // Disable link preview for all but last chunk
        link_preview_options: i < chunks.length - 1 ? { is_disabled: true } : undefined,
      });
      if (i < chunks.length - 1 && this.#config.interChunkDelayMs > 0) {
        await sleep(this.#config.interChunkDelayMs);
      }
    }
  }

  /**
   * Send a message with retry logic for flood control.
   * Falls back to plain text if HTML parse fails.
   * @param {import('grammy').Context} ctx
   * @param {string} text
   * @param {Object} options - sendMessage options
   */
  async #sendWithRetry(ctx, text, options = {}) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        await ctx.reply(text, options);
        return;
      } catch (err) {
        if (err instanceof GrammyError) {
          // Flood control — Telegram tells us how long to wait
          if (err.error_code === 429) {
            const retryAfter = err.parameters?.retry_after || (attempt + 1) * 5;
            this.emit('flood_wait', { retryAfter, attempt });
            await sleep(retryAfter * 1000);
            continue;
          }

          // HTML parse error — fall back to plain text
          if (err.error_code === 400 && err.description?.includes('parse')) {
            this.emit('parse_fallback', { text: text.slice(0, 100) });
            try {
              // Strip all HTML tags for plain text fallback
              const plainText = text.replace(/<[^>]+>/g, '');
              await ctx.reply(plainText);
              return;
            } catch (plainErr) {
              // If even plain text fails, give up on this chunk
              this.emit('error', { message: 'Plain text fallback failed', error: plainErr });
              return;
            }
          }
        }

        // Last attempt — throw
        if (attempt === MAX_RETRIES) throw err;

        // Exponential backoff for other errors
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
        await sleep(delay);
      }
    }
  }

  // ─── Proactive Sending (for cron delivery) ────────────────────────

  /**
   * Send a message proactively (not in response to user message).
   * Used by cron scheduler for task delivery.
   * @param {string} text - Message text (plain or markdown)
   * @param {Object} [options]
   * @param {'HTML'|'MarkdownV2'} [options.parseMode='HTML']
   * @param {number} [options.replyToMessageId]
   */
  async send(text, options = {}) {
    if (!this.#chatId) {
      throw new Error('No chatId available. Bot must receive at least one message first.');
    }

    // Strip engine-internal pulse markers before any user-visible send.
    // Cron / Mímir agent turns can carry these through sendLong() → send().
    if (typeof text === 'string' && (text.includes('TOUCH:') || text.includes('DEBRIEF:'))) {
      text = text
        .replace(/<!--\s*(?:ANCHOR_TOUCH|TASK_TOUCH|COGNITIVE_TOUCH|DEBRIEF)\s*:[\s\S]*?-->\s*/g, '')
        .replace(/<!--\s*(?:ANCHOR_TOUCH|TASK_TOUCH|COGNITIVE_TOUCH|DEBRIEF)\s*:[\s\S]*$/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    const chunks = options.parseMode === 'MarkdownV2'
      ? splitMessage(text, this.#config.maxMessageLength)
      : formatResponseChunks(text, {
          maxLen: this.#config.maxMessageLength,
          style: this.#config.responseStyle,
          targetLen: this.#config.layeredChunkTarget,
        });

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await this.#bot.api.sendMessage(this.#chatId, chunk, {
            parse_mode: options.parseMode || 'HTML',
            reply_to_message_id: options.replyToMessageId,
            link_preview_options: chunkIndex < chunks.length - 1 ? { is_disabled: true } : undefined,
          });
          if (chunkIndex < chunks.length - 1 && this.#config.interChunkDelayMs > 0) {
            await sleep(this.#config.interChunkDelayMs);
          }
          break;
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 429) {
            const retryAfter = err.parameters?.retry_after || (attempt + 1) * 5;
            await sleep(retryAfter * 1000);
            continue;
          }

          // HTML parse error — plain text fallback
          if (err instanceof GrammyError && err.error_code === 400 && err.description?.includes('parse')) {
            try {
              await this.#bot.api.sendMessage(this.#chatId, chunk.replace(/<[^>]+>/g, ''));
              break;
            } catch {
              // Give up on this chunk
              break;
            }
          }

          if (attempt === MAX_RETRIES) throw err;
          await sleep(BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
        }
      }
    }
  }

  /**
   * Send a long message with automatic splitting.
   * Convenience wrapper around send().
   * @param {string|number} chatIdOrText - Chat ID (ignored, kept for backward compat) or text
   * @param {string} [text] - Message text (if first arg is chatId)
   */
  async sendLong(chatIdOrText, text) {
    // Support both sendLong(text) and sendLong(chatId, text) calling conventions
    const msg = text !== undefined ? text : chatIdOrText;
    await this.send(String(msg));
  }

  /**
   * Send a message with inline keyboard buttons.
   * @param {string} text - Message text
   * @param {Array<Array<{text: string, data: string}>>} buttons - Button rows
   */
  async sendWithButtons(text, buttons) {
    if (!this.#chatId) {
      throw new Error('No chatId available.');
    }

    const keyboard = new InlineKeyboard();
    for (const row of buttons) {
      for (const btn of row) {
        keyboard.text(btn.text, btn.data);
      }
      keyboard.row();
    }

    const html = markdownToHtml(text);
    await this.#bot.api.sendMessage(this.#chatId, html, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  }

  // ─── Typing Indicator ─────────────────────────────────────────────

  /**
   * Start sending typing indicator periodically.
   * @param {import('grammy').Context} ctx
   */
  #startTyping(ctx) {
    const sessionId = `tg:${ctx.from.id}`;
    this.#stopTyping(sessionId); // Clear any existing

    // Send immediately
    ctx.replyWithChatAction('typing').catch(() => {});

    // Then every TYPING_INTERVAL_MS
    const interval = setInterval(() => {
      ctx.replyWithChatAction('typing').catch(() => {});
    }, TYPING_INTERVAL_MS);

    this.#typingIntervals.set(sessionId, interval);
  }

  /**
   * Stop typing indicator for a session.
   * @param {string} sessionId
   */
  #stopTyping(sessionId) {
    const interval = this.#typingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.#typingIntervals.delete(sessionId);
    }
  }

  // ─── Error Handling ───────────────────────────────────────────────

  #setupErrorHandling() {
    this.#bot.catch((err) => {
      const ctx = err.ctx;
      const e = err.error;

      if (e instanceof GrammyError) {
        this.emit('error', { type: 'grammy', error: e, description: e.description });
      } else if (e instanceof HttpError) {
        this.emit('error', { type: 'http', error: e });
      } else {
        this.emit('error', { type: 'unknown', error: e });
      }
    });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start the bot with long polling.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#running) return;

    // Validate token by getting bot info
    const me = await this.#bot.api.getMe();
    this.emit('started', { user: me.user, id: me.id });

    this.#running = true;
    // Periodic cleanup of old media files (every 30 min)
    this._mediaCleanupTimer = setInterval(() => cleanupOldMedia(), 1800000);
    // Start polling with 409 conflict retry
    this.#startPollingWithRetry();

    // Send restart notification if engine was auto-restarted
    this.#sendRestartNotification().catch(() => {});
  }

  /**
   * Check if engine was auto-restarted and notify Founder via Telegram.
   */
  async #sendRestartNotification() {
    const { existsSync, readFileSync, unlinkSync } = await import('fs');
    const { resolve } = await import('path');
    const projectDir = resolve(new URL('.', import.meta.url).pathname, '..');
    const reasonFile = resolve(projectDir, '.restart-reason');
    const flagFile = resolve(projectDir, '.restart-requested');

    // Check if this is a restart (flag file exists from previous instance)
    let reason = null;
    if (existsSync(reasonFile)) {
      try { reason = readFileSync(reasonFile, 'utf8').trim(); } catch {}
      try { unlinkSync(reasonFile); } catch {}
    }
    if (existsSync(flagFile)) {
      try { unlinkSync(flagFile); } catch {}
    }

    if (!this.#chatId) return;

    // Single consolidated boot notification after delay (let tunnel + Mímir initialize)
    // Wait up to 20 seconds for tunnel URL to become available
    const waitForTunnel = async () => {
      for (let i = 0; i < 10; i++) {
        if (this.tunnelUrl) return this.tunnelUrl;
        await new Promise(r => setTimeout(r, 2000));
      }
      return null;
    };
    (async () => {
      try {
        const tunnelUrl = await waitForTunnel();
        const lines = ['🌌 Constellation Engine Online'];
        if (reason) lines.push(`🔄 Restart reason: ${reason}`);

        if (tunnelUrl) {
          lines.push(`\n🔗 Dashboard: <a href="${tunnelUrl}">${tunnelUrl}</a>`);
          lines.push(`🏠 Local: <a href="http://localhost:18800/">http://localhost:18800/</a>`);
        }

        // Mímir status
        try {
          const resp = await fetch(`${MIMIR_URL}/status`);
          const data = await resp.json();
          lines.push(`🧠 Mímir: ${data.active_nodes || 0} active nodes, tick ${data.tick_count || 0}`);
        } catch {
          lines.push('⚠️ Mímir: not responding');
        }

        await this.#bot.api.sendMessage(this.#chatId, lines.join('\n'), { parse_mode: 'HTML' });

        // Check for interrupted conversation and auto-resume
        // Always check, not just on /restart — crash/timeout restarts also need resumption
        {
          try {
            console.log('  [Auto-resume] Checking for interrupted turns...');
            const Database = (await import('better-sqlite3')).default;
            const dbPath = resolve(projectDir, 'constellation.db');
            const db = new Database(dbPath, { readonly: true });

            // Find interrupted turns: started/interrupted but never properly completed
            // Time-bound: only last 20 minutes (ancient entries are stale, not real interruptions)
            // Trigger filter: exclude mimir_autonomous and restart_resume (prevents loops)
            // Supersession filter: if a newer turn in the same session already reached a terminal
            //   state (completed/failed/interrupted/stale), the older 'started' turn was abandoned
            //   and must NOT be resurrected — resurrecting it would replay a message the user has
            //   since moved past.
            // Scope to THIS bot's owner only — multi-bot installations share
            // turn_journal so 'tg:%' would resurrect another bot's interrupted
            // turn under our credentials. allowedUserId is this bot's owner.
            const ownerSessionPrefix = `tg:${this.#config.allowedUserId}%`;
            const interruptedTurn = db.prepare(
              `SELECT id, session_id, user_message, trigger FROM turn_journal t1
               WHERE status IN ('started', 'interrupted') AND user_message IS NOT NULL
               AND session_id LIKE ?
               AND trigger NOT IN ('mimir_autonomous', 'restart_resume')
               AND COALESCE(updated_at, created_at) > datetime('now', '-20 minutes')
               AND NOT EXISTS (
                 SELECT 1 FROM turn_journal t2
                 WHERE t2.session_id = t1.session_id
                   AND t2.id != t1.id
                   AND t2.status IN ('completed', 'failed', 'interrupted', 'stale')
                   AND t2.created_at > t1.created_at
               )
               ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`
            ).get(ownerSessionPrefix);

            // Check if a restart_resume already ran recently (dedup guard — any status)
            const recentResume = db.prepare(
              `SELECT id FROM turn_journal
               WHERE trigger='restart_resume'
               AND created_at > datetime('now', '-3 minutes')
               LIMIT 1`
            ).get();

            if (recentResume) {
              console.log('  [Auto-resume] Skipped — recent restart_resume already exists (dedup)');
            }

            // Fallback: check if last message in conversations.db was from user with no reply
            // Skip if we already resumed recently (prevents infinite resume loop)
            let lastMsg = null;
            if (!interruptedTurn && !recentResume) {
              try {
                const convDbPath = resolve(projectDir, 'conversations.db');
                const convDb = new Database(convDbPath, { readonly: true });
                lastMsg = convDb.prepare(
                  `SELECT role, content, session_id FROM messages
                   WHERE content NOT LIKE '%Mímir autonomous wakeup%'
                   AND content NOT LIKE '%Turn aborted%'
                   AND session_id LIKE ?
                   ORDER BY id DESC LIMIT 1`
                ).get(ownerSessionPrefix);
                convDb.close();
              } catch (convErr) {
                console.warn(`  [Auto-resume] Fallback conversations.db check failed: ${convErr.message}`);
              }
            }

            db.close();

            // Always clean up ancient interrupted/started turns on boot (>1 hour old)
            {
              let dbCleanup;
              try {
                dbCleanup = new Database(dbPath);
                const cleaned = dbCleanup.prepare(
                  `UPDATE turn_journal SET status='stale', error='cleanup_on_boot', finished_at=datetime('now'), updated_at=datetime('now')
                   WHERE status IN ('started', 'interrupted') AND created_at < datetime('now', '-1 hour')`
                ).run();
                if (cleaned.changes > 0) console.log(`  🧹 Cleaned ${cleaned.changes} stale turn_journal entries (not resumed)`);
              } catch {} finally { try { dbCleanup?.close(); } catch {} }
            }

            const resumeUserMessage = interruptedTurn?.user_message
              || (lastMsg?.role === 'user' ? lastMsg.content : null);
            const resumeSessionId = interruptedTurn?.session_id || lastMsg?.session_id;

            console.log(`  [Auto-resume] interruptedTurn=${interruptedTurn?.id || 'none'}, lastMsg=${lastMsg?.role || 'none'}, recentResume=${!!recentResume}, sessionId=${resumeSessionId || 'none'}`);

            if (resumeUserMessage && resumeSessionId && !recentResume) {
              const preview = resumeUserMessage.slice(0, 100);
              console.log(`  [Auto-resume] Resuming: "${preview}"`);
              await this.#bot.api.sendMessage(this.#chatId,
                `🔄 Detected an unanswered message from before the restart; auto-continuing...\n> ${preview}${resumeUserMessage.length > 100 ? '...' : ''}`
              );

              // Mark the interrupted turn as failed so it does not get picked up again
              if (interruptedTurn) {
                let dbWrite;
                try {
                  dbWrite = new Database(dbPath);
                  dbWrite.prepare(
                    `UPDATE turn_journal SET status='failed', error='engine_restart', finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
                  ).run(interruptedTurn.id);
                } catch {} finally { try { dbWrite?.close(); } catch {} }
              }

              // Set flag to prevent incoming messages from interrupting the resume
              this._resumeInProgress = true;

              // Send a continuation message instead of replaying the exact user message
              // This prevents loops (e.g., if the user message was "restart the engine")
              const continuationMessage = `[System auto-continuation] The engine just finished restarting. The message you were replying to before the restart was:\n"${resumeUserMessage}"\nPlease continue replying to it.`;

              // Wait 10s for all services (proxy, Mímir, DB) to fully stabilize
              setTimeout(async () => {
                try {
                  // Pre-resume proxy health check.
                  // If baseUrl is remote (no local proxy), skip the wait entirely — provider will be reachable.
                  const _resumeHealthUrl = this.#getProxyHealthUrl();
                  let proxyReady = !_resumeHealthUrl;
                  if (_resumeHealthUrl) {
                    for (let attempt = 0; attempt < 3; attempt++) {
                      try {
                        await fetch(_resumeHealthUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
                        proxyReady = true;
                        break;
                      } catch {
                        console.warn(`  [Auto-resume] Proxy not ready (attempt ${attempt + 1}/3), waiting 5s...`);
                        await new Promise(r => setTimeout(r, 5000));
                      }
                    }
                  }
                  if (!proxyReady) {
                    console.error('  [Auto-resume] Proxy not ready after 3 attempts, skipping resume');
                    await this.#bot.api.sendMessage(this.#chatId,
                      `⚠️ Proxy not ready; auto-continuation skipped. Please resend your message.`
                    ).catch(() => {});
                    this._resumeInProgress = false;
                    return;
                  }

                  console.log('  [Auto-resume] Proxy ready, routing through normal message handler with typing + streaming...');

                  // Build a synthetic ctx so auto-resume gets the same typing indicators,
                  // draft streaming, and auto-retry logic as normal user messages.
                  const chatId = Number(this.#chatId);
                  const userId = chatId; // private chat: chatId === userId
                  const botApi = this.#bot.api;
                  const syntheticCtx = {
                    from: { id: userId },
                    chat: { id: chatId },
                    update: { update_id: Date.now() }, // unique-ish key for eventKey dedup
                    reply: (text, opts) => botApi.sendMessage(chatId, text, opts),
                    replyWithChatAction: (action) => botApi.sendChatAction(chatId, action),
                    api: botApi,
                  };

                  try {
                    await this.#handleUserMessageInner(syntheticCtx, continuationMessage, resumeSessionId, 0, { trigger: 'restart_resume' });
                  } catch (resumeErr) {
                    console.error(`  ❌ Auto-resume failed: ${resumeErr.message}`);
                    await botApi.sendMessage(chatId,
                      `⚠️ Auto-continuation failed: ${resumeErr.message}\nPlease resend your message.`
                    ).catch(() => {});
                  } finally {
                    this._resumeInProgress = false;
                  }
                } catch (outerErr) {
                  console.error(`  ❌ Auto-resume outer error: ${outerErr.message}`);
                  this._resumeInProgress = false;
                }
              }, 10000);
            } else {
              console.log('  [Auto-resume] No interrupted turn found or dedup blocked — skipping');
            }
          } catch (e) {
            console.error(`  [Auto-resume] Check failed: ${e.message}`);
          }
        }
      } catch {}
    })();
  }

  /**
   * Start grammY polling with exponential backoff retry on 409 Conflict.
   * 409 occurs when another bot instance is polling the same token.
   */
  #startPollingWithRetry(attempt = 0) {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2s

    // On first attempt, clear any stale Telegram polling session
    if (attempt === 0) {
      this.#bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      // Overwrite any stale server-side command descriptions left by previous bot owners
      this.#bot.api.setMyCommands([
        { command: 'mimir', description: 'Mímir autonomy controls and status' },
        { command: 'timing', description: 'Show last turn timing breakdown' },
        { command: 'restart', description: 'Graceful engine restart' },
        { command: 'rollback', description: 'Roll back to a previous engine snapshot' },
        { command: 'engine', description: 'Engine status and diagnostics' },
      ]).catch(() => {});
    }

    this.#bot.start({
      onStart: (botInfo) => {
        this.emit('polling', { user: botInfo.user });
      },
      drop_pending_updates: true,
    }).catch((err) => {
      const is409 = err?.error_code === 409
        || err?.message?.includes('409')
        || err?.description?.includes('terminated by other getUpdates');

      if (is409 && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt);
        this.emit('error', {
          type: 'polling-conflict',
          error: err,
          description: `409 Conflict – retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
        });
        setTimeout(() => this.#startPollingWithRetry(attempt + 1), delay);
      } else if (is409) {
        this.emit('error', {
          type: 'polling-conflict-fatal',
          error: err,
          description: `409 Conflict – exhausted ${MAX_RETRIES} retries, giving up`,
        });
        this.#running = false;
      } else {
        // Non-409 error, propagate normally
        this.emit('error', { type: 'polling-start', error: err });
        this.#running = false;
      }
    });
  }

  /**
   * Stop the bot gracefully.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.#running) return;

    // Abort all active turns so turn_journal gets finalized
    for (const [sid, turn] of this.#activeTurns.entries()) {
      try {
        turn.controller.abort('engine_shutdown');
      } catch {}
    }
    // Brief wait for abort handlers to run and finishTurn to be called
    if (this.#activeTurns.size > 0) {
      await new Promise(r => setTimeout(r, 500));
    }

    // Clear media cleanup timer
    if (this._mediaCleanupTimer) {
      clearInterval(this._mediaCleanupTimer);
      this._mediaCleanupTimer = null;
    }

    // Clear all typing intervals
    for (const [sessionId] of this.#typingIntervals) {
      this.#stopTyping(sessionId);
    }

    // Clear cleanup interval
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
    }

    // Clear all caches
    this.#processedUpdateCache.clear();
    this.#sessionTurnQueue.clear();
    this.#activeTurns.clear();
    this.#typingIntervals.clear();

    await this.#bot.stop();
    this.#running = false;
    this.emit('stopped');
  }

  /**
   * Check if bot is currently running.
   * @returns {boolean}
   */
  get isRunning() {
    return this.#running;
  }

  /**
   * Get the underlying grammY Bot instance (for advanced use).
   * @returns {Bot}
   */
  get bot() {
    return this.#bot;
  }

  /**
   * Get the current chat ID (set after first message received).
   * @returns {string|null}
   */
  get chatId() {
    return this.#chatId || null;
  }

  /**
   * Public sendMessage — delegates to grammY bot.api.sendMessage.
   * Used by dashboard for Mímir wakeup notifications.
   * @param {string} chatId
   * @param {string} text
   * @param {object} [options]
   */
  async sendMessage(chatId, text, options) {
    return this.#bot.api.sendMessage(chatId, text, options);
  }

  // ─── Mímir Integration ───────────────────────────────────────────────────

  /**
   * Send a signal to the Mímir daemon (fire-and-forget).
   * Mímir builds continuous activation state from all incoming messages.
   * Never blocks message processing — if Mímir is down, silently continues.
   * @param {string} text - Message text
   * @param {string} source - Source identifier (session ID)
   */
  // Dedup guard: prevent same text from being signaled within 5s window (interrupt re-processing)
  #lastMimirSignalHash = '';
  #lastMimirSignalTime = 0;

  async #signalMimir(text, source) {
    // Fire-and-forget: spawn curl subprocess to avoid Node.js event loop blocking issues.
    // http.request hangs when the event loop is busy with LLM streaming in WSL2.
    const trimmed = (text || '').slice(0, 500);

    // Dedup based on the FULL original text, not individual segments
    const hash = `${source}:${trimmed}`;
    const now = Date.now();
    if (hash === this.#lastMimirSignalHash && (now - this.#lastMimirSignalTime) < 5000) {
      return; // Skip duplicate signal within 5s window
    }
    this.#lastMimirSignalHash = hash;
    this.#lastMimirSignalTime = now;

    // Step 8 — Arousal α: detect from full untrimmed text (caps/length live in
    // the original) so a long expressive message still spikes α even though
    // /signal only carries the first 500 chars.
    const alpha = roundArousal(computeArousal(text || ''));

    // Send as single request — daemon handles its own segmentation.
    // Previous approach (splitting into 4-5 separate HTTP requests with 100ms gaps)
    // caused daemon overload: executor(2 workers) + 10s curl timeout = burst failures.
    await this.#sendMimirSignal({ text: trimmed, source, alpha });
  }

  /**
   * Send a single signal payload to Mímir via curl subprocess.
   * @param {object} payload - Signal payload (text, source, and optional segment info)
   */
  async #sendMimirSignal(payload, attempt = 1) {
    const data = await _postMimirJson('/signal', payload, { timeoutMs: 35000 });
    if (!data) {
      if (attempt < 2) {
        setTimeout(() => this.#sendMimirSignal(payload, attempt + 1), 1500);
      } else {
        console.error('  [Mímir] signal error (after retry)');
      }
      return;
    }
    if (data.decision && data.decision !== 'tick') {
      console.log(`  [Mímir] ${data.decision} (active=${data.active_nodes}, max=${data.max_activation?.toFixed(3)})`);
    }
    this.#lastMimirState = data;
  }

  /**
   * Notify the Mímir daemon that the founder just sent an inbound message —
   * the daemon resolves this against any unanswered outreach audit row within
   * its correlation window. Fire-and-forget; failures never block the chat path.
   * (Step 7 prerequisite — without this, anti-loop detector trips on first send.)
   */
  async #notifyMimirOutreachResponse() {
    // fire-and-forget; daemon may be down or endpoint absent on old builds
    _postMimirJson('/outreach_response_seen', { owner_id: 'self' }, { timeoutMs: 5000 });
  }

  /**
   * Notify Mímir that a session/turn has ended (fire-and-forget).
   * Mímir uses this to detect incomplete tasks and trigger autonomous wakeup.
   * @param {string} sessionId
   * @param {string} status - 'completed' | 'timeout' | 'error'
   * @param {string} [summary]
   * @param {{ originalMessage?: string, lastResponse?: string }} [context]
   */
  #notifyMimirSessionEnd(sessionId, status, summary = '', context = {}) {
    // Finalize behavior session (Layer 1 of Session Debrief)
    try { this.#behaviorLogger?.finalizeSession(sessionId, status); } catch {}

    const payload = {
      session_id: sessionId,
      status, // 'completed', 'timeout', 'error'
      summary: summary.slice(0, 500),
      original_message: (context.originalMessage || '').slice(0, 500),
      last_response: (context.lastResponse || '').slice(0, 1000),
      timestamp: Date.now(),
    };
    // fire-and-forget
    _postMimirJson('/session_end', payload, { timeoutMs: 5000 });
  }

  /** @type {Object|null} Latest Mímir routing state */
  #lastMimirState = null;

  /**
   * Get the latest Mímir activation state (for use by other components).
   * @returns {Object|null}
   */
  get mimirState() {
    return this.#lastMimirState;
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { markdownToHtml, splitMessage, escapeHtml };
export default TelegramBot;
