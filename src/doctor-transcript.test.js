// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { diagnose, repair, handleDoctorCommand, createDoctorRoutes, SnapshotManager } from './doctor.js';
import { TranscriptIntegrityManager } from './transcript-integrity.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT DEFAULT 'active'
    );
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
    CREATE TABLE cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      timezone TEXT DEFAULT 'UTC',
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE turn_journal (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      stage TEXT NOT NULL DEFAULT 'received_user',
      trigger TEXT,
      event_key TEXT,
      user_message TEXT,
      options_json TEXT,
      user_message_id INTEGER,
      final_message_id INTEGER,
      tool_rounds INTEGER DEFAULT 0,
      tools_used_json TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE pending_tool_runs (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input_json TEXT,
      assistant_message_id INTEGER,
      tool_batch_id TEXT,
      tool_round INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      result_message_id INTEGER,
      result_preview TEXT,
      error_code TEXT,
      error TEXT,
      latency_ms INTEGER,
      result_bytes INTEGER
    );
  `);
  db.prepare(`INSERT INTO nodes (state) VALUES ('active')`).run();
  return db;
}

function insertSession(db, sessionId) {
  db.prepare(`INSERT INTO sessions (id, user_id) VALUES (?, ?)` ).run(sessionId, sessionId);
}

function insertMessage(db, sessionId, role, { content = '', toolCalls = null, toolCallId = null } = {}) {
  db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, token_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null, toolCallId, Math.ceil(String(content).length / 3.5));
}

function createConfig() {
  return {
    engine: { dbPath: ':memory:' },
    runtime: { fixedFiles: [] },
    llm: { authMode: 'none' },
    dashboard: { port: 18800 },
  };
}

test('diagnose reports transcript integrity issues', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'doctor-scan');
  insertMessage(db, 'doctor-scan', 'assistant', {
    toolCalls: [{ id: 'tool-1', name: 'file_read', input: { path: 'a' } }],
  });
  insertMessage(db, 'doctor-scan', 'user', { content: 'oops, no tool result followed' });

  const results = await diagnose(db, createConfig(), new SnapshotManager(db), { transcriptIntegrity });
  const transcript = results.find(r => r.name === 'Transcript Integrity');
  assert.ok(transcript);
  assert.equal(transcript.status, '⚠️');
  assert.match(transcript.detail, /issues/i);
});

test('doctor repair runs transcript repair and verifies clean', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'doctor-repair');
  insertMessage(db, 'doctor-repair', 'assistant', {
    content: 'Checking',
    toolCalls: [{ id: 'tool-1', name: 'constellation_stats', input: {} }],
  });
  insertMessage(db, 'doctor-repair', 'tool', { content: '{"active":1}' });

  const issues = await diagnose(db, createConfig(), new SnapshotManager(db), { transcriptIntegrity });
  const repairs = await repair(db, createConfig(), issues, new SnapshotManager(db), { transcriptIntegrity });
  const transcriptRepair = repairs.find(r => r.name === 'Transcript Integrity');
  assert.ok(transcriptRepair);
  assert.equal(transcriptRepair.status, '✅');
  assert.match(transcriptRepair.detail, /verify clean/i);

  const verify = transcriptIntegrity.verify({ sessionId: 'doctor-repair' });
  assert.equal(verify.sessions[0].ok, true);
});

test('handleDoctorCommand supports transcript subcommands', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'doctor-cmd');
  insertMessage(db, 'doctor-cmd', 'assistant', {
    toolCalls: [{ id: 'tool-1', name: 'file_read', input: { path: 'x' } }],
  });
  insertMessage(db, 'doctor-cmd', 'tool', { content: 'result without id' });

  const deps = { db, config: createConfig(), snapshotManager: new SnapshotManager(db), transcriptIntegrity };
  const scanText = await handleDoctorCommand(deps, 'transcript scan doctor-cmd');
  assert.match(scanText, /Transcript Scan/);
  assert.match(scanText, /doctor-cmd/);

  const repairText = await handleDoctorCommand(deps, 'transcript repair safe doctor-cmd');
  assert.match(repairText, /Transcript Repair/);
  assert.match(repairText, /0 \u2192 0|1 \u2192 0|2 \u2192 0/);

  const verifyText = await handleDoctorCommand(deps, 'transcript verify doctor-cmd');
  assert.match(verifyText, /Transcript Verify/);
  assert.match(verifyText, /Failed: 0/);
});

test('doctor transcript routes expose scan, repair, and verify', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'doctor-route');
  insertMessage(db, 'doctor-route', 'assistant', {
    toolCalls: [{ id: 'tool-1', name: 'file_read', input: { path: 'x' } }],
  });
  insertMessage(db, 'doctor-route', 'tool', { content: 'result without id' });

  const handler = createDoctorRoutes({ db, config: createConfig(), snapshotManager: new SnapshotManager(db), transcriptIntegrity });
  let payload = null;
  const json = (_res, body) => { payload = body; };
  const readBody = async () => JSON.stringify({ sessionId: 'doctor-route', mode: 'safe' });

  const handledScan = await handler({ url: '/api/doctor/transcript?action=scan&sessionId=doctor-route', headers: { host: 'localhost' } }, {}, '/api/doctor/transcript', 'GET', readBody, json);
  assert.equal(handledScan, true);
  assert.equal(payload.issueCount >= 1, true);

  const handledRepair = await handler({ url: '/api/doctor/transcript/repair', headers: { host: 'localhost' } }, {}, '/api/doctor/transcript/repair', 'POST', readBody, json);
  assert.equal(handledRepair, true);
  assert.equal(payload.repairedSessions, 1);

  const handledVerify = await handler({ url: '/api/doctor/transcript?action=verify&sessionId=doctor-route', headers: { host: 'localhost' } }, {}, '/api/doctor/transcript', 'GET', readBody, json);
  assert.equal(handledVerify, true);
  assert.equal(payload.failedSessions, 0);
});


test('diagnose and repair include runtime journal recovery', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'runtime-doctor');
  db.prepare(`INSERT INTO turn_journal (id, session_id, status, stage, updated_at) VALUES (?, ?, 'started', 'tools_pending', datetime('now', '-40 minutes'))`).run('turn-1', 'runtime-doctor');
  db.prepare(`INSERT INTO pending_tool_runs (id, turn_id, session_id, tool_call_id, tool_name, status, started_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now', '-40 minutes'))`).run('ptr-1', 'turn-1', 'runtime-doctor', 'call-1', 'memory_search');

  const issues = await diagnose(db, createConfig(), new SnapshotManager(db), { transcriptIntegrity });
  assert.equal(issues.find(r => r.name === 'Pending Tool Runs').status, '⚠️');
  assert.equal(issues.find(r => r.name === 'Turn Journal').status, '⚠️');

  const repairs = await repair(db, createConfig(), issues, new SnapshotManager(db), { transcriptIntegrity });
  const runtimeRepair = repairs.find(r => r.name === 'Runtime Journal Recovery');
  assert.ok(runtimeRepair);
  assert.match(runtimeRepair.detail, /pending runs aborted/i);

  const pending = db.prepare(`SELECT status, error_code FROM pending_tool_runs WHERE id = 'ptr-1'`).get();
  assert.equal(pending.status, 'aborted');
  assert.equal(pending.error_code, 'doctor_recovered');
  const turn = db.prepare(`SELECT status, stage FROM turn_journal WHERE id = 'turn-1'`).get();
  assert.equal(turn.status, 'failed');
  assert.equal(turn.stage, 'doctor_recovered');
});

test('doctor runtime routes and commands expose scan and recover', async () => {
  const db = createDb();
  const transcriptIntegrity = new TranscriptIntegrityManager(db);
  insertSession(db, 'runtime-route');
  db.prepare(`INSERT INTO turn_journal (id, session_id, status, stage, updated_at) VALUES (?, ?, 'started', 'llm_requested', datetime('now', '-35 minutes'))`).run('turn-2', 'runtime-route');
  db.prepare(`INSERT INTO pending_tool_runs (id, turn_id, session_id, tool_call_id, tool_name, status, started_at) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now', '-35 minutes'))`).run('ptr-2', 'turn-2', 'runtime-route', 'call-2', 'constellation_query');

  const handler = createDoctorRoutes({ db, config: createConfig(), snapshotManager: new SnapshotManager(db), transcriptIntegrity });
  let payload = null;
  const json = (_res, body) => { payload = body; };
  const readBody = async () => JSON.stringify({ sessionId: 'runtime-route' });

  const handledScan = await handler({ url: '/api/doctor/runtime?sessionId=runtime-route', headers: { host: 'localhost' } }, {}, '/api/doctor/runtime', 'GET', readBody, json);
  assert.equal(handledScan, true);
  assert.equal(payload.stalePendingCount, 1);

  const handledRecover = await handler({ url: '/api/doctor/runtime/recover', headers: { host: 'localhost' } }, {}, '/api/doctor/runtime/recover', 'POST', readBody, json);
  assert.equal(handledRecover, true);
  assert.equal(payload.recoveredPending, 1);

  const deps = { db, config: createConfig(), snapshotManager: new SnapshotManager(db), transcriptIntegrity };
  const scanText = await handleDoctorCommand(deps, 'runtime scan runtime-route');
  assert.match(scanText, /Runtime Journal/);
  const recoverText = await handleDoctorCommand(deps, 'runtime recover runtime-route');
  assert.match(recoverText, /Runtime Recovery/);
});
