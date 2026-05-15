// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TranscriptIntegrityManager } from './transcript-integrity.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      is_temp INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      token_count INTEGER DEFAULT 0,
      compacted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertMessage(db, sessionId, role, { content = '', toolCalls = null, toolCallId = null } = {}) {
  db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, token_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId, Math.ceil(String(content).length / 3.5));
}

test('scan flags orphan and dangling tool transcript problems', () => {
  const db = createDb();
  const mgr = new TranscriptIntegrityManager(db);
  const sid = 'scan-1';

  insertMessage(db, sid, 'assistant', {
    content: '',
    toolCalls: [{ id: 'tool-1', name: 'file_read', input: { path: 'a' } }],
  });
  insertMessage(db, sid, 'user', { content: 'hello again' });
  insertMessage(db, sid, 'tool', { content: 'late result', toolCallId: 'tool-1' });

  const report = mgr.scan({ sessionId: sid, persist: false });
  const types = report.sessions[0].issues.map(i => i.issueType);

  assert.ok(types.includes('dangling_tool_use'));
  assert.ok(types.includes('orphan_tool_result'));
});

test('repair fills missing tool_call_id when inference is unambiguous', () => {
  const db = createDb();
  const mgr = new TranscriptIntegrityManager(db);
  const sid = 'repair-1';

  insertMessage(db, sid, 'assistant', {
    content: 'Let me check.',
    toolCalls: [{ id: 'tool-1', name: 'constellation_stats', input: {} }],
  });
  insertMessage(db, sid, 'tool', { content: '{"active": 1}' });

  const before = mgr.scan({ sessionId: sid, persist: false });
  assert.ok(before.issueCount >= 1);

  const result = mgr.repair({ sessionId: sid, mode: 'safe' });
  assert.equal(result.repairedSessions, 1);

  const row = db.prepare('SELECT tool_call_id FROM messages WHERE role = ?').get('tool');
  assert.equal(row.tool_call_id, 'tool-1');

  const verify = mgr.verify({ sessionId: sid });
  assert.equal(verify.sessions[0].ok, true);
});

test('repair quarantines orphan tool rows and strips dead assistant tool_calls', () => {
  const db = createDb();
  const mgr = new TranscriptIntegrityManager(db);
  const sid = 'repair-2';

  insertMessage(db, sid, 'assistant', {
    content: '',
    toolCalls: [
      { id: 'tool-a', name: 'file_read', input: { path: 'a' } },
      { id: 'tool-b', name: 'file_read', input: { path: 'b' } },
    ],
  });
  insertMessage(db, sid, 'tool', { content: 'bad result', toolCallId: 'ghost-tool' });

  const result = mgr.repair({ sessionId: sid, mode: 'safe' });
  assert.equal(result.repairedSessions, 1);

  const remaining = db.prepare('SELECT role, content, tool_calls FROM messages WHERE session_id = ? ORDER BY id').all(sid);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].role, 'assistant');
  assert.equal(remaining[0].tool_calls, null);
  assert.match(String(remaining[0].content), /transcript repair/i);

  const quarantine = db.prepare('SELECT COUNT(*) as c FROM messages_quarantine WHERE session_id = ?').get(sid);
  assert.equal(quarantine.c, 1);

  const verify = mgr.verify({ sessionId: sid });
  assert.equal(verify.sessions[0].ok, true);
});
