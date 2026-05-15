// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SubAgentManager } from './sub-agent.js';
import { TaskManager } from './task-manager.js';
import { handleDoctorCommand } from './doctor.js';

function makeFakeDb() {
  return {
    prepare(sql) {
      if (sql.includes('INSERT INTO api_calls')) {
        return { run() {} };
      }
      return {
        get() { return null; },
        all() { return []; },
        run() { return { changes: 0 }; },
      };
    },
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('background subagent queue runs asynchronously and persists results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-bg-'));
  const dbPath = join(dir, 'tasks.db');
  let calls = 0;
  const llm = {
    async chat() {
      calls += 1;
      await sleep(25);
      return {
        content: 'background-result-ok',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: 'bg-model',
      };
    },
  };

  const taskManager = new TaskManager(dbPath);
  const manager = new SubAgentManager({
    engine: {},
    llm,
    db: makeFakeDb(),
    taskManager,
    config: { enableBackgroundWorker: true, backgroundPollMs: 20, backgroundLeaseMs: 2000 },
  });

  try {
    const queued = manager.scheduleBackgroundTask('Summarize this in background', 'ctx', { kind: 'generic', sessionId: 'tg:1' });
    assert.match(queued.taskId, /^task-/);

    let task = null;
    for (let i = 0; i < 80; i++) {
      task = taskManager.getTask(queued.taskId);
      if (task?.status === 'done') break;
      await sleep(25);
    }

    assert.equal(calls > 0, true);
    assert.equal(task?.status, 'done');
    assert.match(task?.result?.result || '', /background-result-ok/);
  } finally {
    manager.close();
    taskManager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor tasks recover requeues stale running background tasks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-tasks-'));
  const dbPath = join(dir, 'doctor.db');
  const taskManager = new TaskManager(dbPath);
  const rawDb = new Database(dbPath);

  try {
    const taskId = taskManager.createTask({
      title: 'stale background task',
      taskType: 'subagent_patch',
      sessionId: 'tg:42',
      payload: { task: 'fix bug' },
      maxRetries: 3,
    });
    taskManager.startTask(taskId, { workerId: 'worker-x', leaseMs: 1000 });
    rawDb.prepare(`UPDATE tasks SET started_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', taskId);

    const reply = await handleDoctorCommand({
      db: rawDb,
      config: { dashboard: {}, llm: {}, runtime: {}, cron: {}, relay: {} },
      snapshotManager: { rollback() { return { success: false, detail: 'noop' }; } },
      transcriptIntegrity: null,
      taskManager,
    }, 'tasks recover tg:42');

    assert.match(reply, /Recovered 1 task/);
    const task = taskManager.getTask(taskId);
    assert.equal(task?.status, 'pending');
    assert.match(task?.error || '', /Doctor recovered stale running task/);
  } finally {
    rawDb.close();
    taskManager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
