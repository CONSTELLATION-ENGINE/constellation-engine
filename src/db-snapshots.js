// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @module db-snapshots
 * @description Lightweight DB snapshot manager for rollback support.
 *
 * Creates consistent SQLite snapshots using better-sqlite3's .backup() API.
 * Snapshots stored in PROJECT_ROOT/snapshots/ with a JSON manifest.
 *
 * Usage:
 *   const mgr = new DbSnapshotManager(projectRoot, { main: db, conversations: convDb });
 *   const snap = await mgr.createSnapshot('pre-cron:daily-diary');
 *   mgr.listSnapshots();
 *   await mgr.restoreSnapshot(snap.id);
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { log } from './logger.js';

const MAX_SNAPSHOTS = 10;
const MAX_TOTAL_MB = 8192; // 8 GB cap

export class DbSnapshotManager {
  /** @type {string} */
  #snapshotDir;
  /** @type {string} */
  #manifestPath;
  /** @type {Record<string, import('better-sqlite3').Database>} */
  #databases;
  /** @type {Record<string, string>} db key → file path */
  #dbPaths;

  /**
   * @param {string} projectRoot
   * @param {Record<string, import('better-sqlite3').Database>} databases - { main: db, conversations: convDb }
   * @param {Record<string, string>} dbPaths - { main: './constellation.db', conversations: './conversations.db' }
   */
  constructor(projectRoot, databases, dbPaths) {
    this.#snapshotDir = join(projectRoot, 'snapshots');
    this.#manifestPath = join(this.#snapshotDir, 'manifest.json');
    this.#databases = databases;
    this.#dbPaths = dbPaths;
    mkdirSync(this.#snapshotDir, { recursive: true });
    this._ensureManifest();
  }

  /**
   * Register an additional database after construction.
   * @param {string} key
   * @param {import('better-sqlite3').Database} db
   * @param {string} dbPath
   */
  _registerDb(key, db, dbPath) {
    this.#databases[key] = db;
    this.#dbPaths[key] = dbPath;
  }

  _ensureManifest() {
    if (!existsSync(this.#manifestPath)) {
      writeFileSync(this.#manifestPath, JSON.stringify({ snapshots: [] }, null, 2));
    }
  }

  /** @returns {{ snapshots: Array<{ id: string, ts: string, reason: string, files: Record<string, string>, sizeMB: number }> }} */
  _readManifest() {
    try {
      return JSON.parse(readFileSync(this.#manifestPath, 'utf-8'));
    } catch {
      return { snapshots: [] };
    }
  }

  _writeManifest(manifest) {
    writeFileSync(this.#manifestPath, JSON.stringify(manifest, null, 2));
  }

  /**
   * Create a snapshot of all registered databases.
   * @param {string} [reason='manual'] - Why this snapshot was created
   * @returns {Promise<{ id: string, ts: string, reason: string, files: Record<string, string>, sizeMB: number }>}
   */
  async createSnapshot(reason = 'manual') {
    const ts = new Date().toISOString();
    const id = ts.replace(/[:.]/g, '-').slice(0, 19);
    const files = {};
    let totalSize = 0;

    for (const key of Object.keys(this.#dbPaths)) {
      const dbPath = this.#dbPaths[key];
      if (!dbPath || !existsSync(dbPath)) continue;
      const db = this.#databases[key];
      const filename = `${key}_${id}.db`;
      const destPath = join(this.#snapshotDir, filename);
      try {
        if (db) {
          // Use better-sqlite3 .backup() for hot consistent snapshot
          await db.backup(destPath);
        } else {
          // No DB handle (private) — file copy
          copyFileSync(dbPath, destPath);
        }
        const size = statSync(destPath).size;
        totalSize += size;
        files[key] = filename;
      } catch (e) {
        // Fallback: file copy after checkpoint
        log.warn('snapshot', `backup() failed for ${key}, falling back to file copy`, { err: e.message });
        try {
          if (db) db.pragma('wal_checkpoint(TRUNCATE)');
          copyFileSync(dbPath, destPath);
          const size = statSync(destPath).size;
          totalSize += size;
          files[key] = filename;
        } catch (e2) {
          log.error('snapshot', `Snapshot failed for ${key}`, { err: e2.message });
        }
      }
    }

    const sizeMB = Math.round(totalSize / 1024 / 1024 * 10) / 10;
    const entry = { id, ts, reason, files, sizeMB };

    const manifest = this._readManifest();
    manifest.snapshots.push(entry);
    this._writeManifest(manifest);

    log.info('snapshot', `Created snapshot: ${id}`, { reason, sizeMB });

    // Auto-prune
    this._prune();

    return entry;
  }

  /**
   * List available snapshots (newest first).
   * @param {number} [limit=20]
   * @returns {Array<{ id: string, ts: string, reason: string, sizeMB: number }>}
   */
  listSnapshots(limit = 20) {
    const manifest = this._readManifest();
    return manifest.snapshots.slice(-limit).reverse();
  }

  /**
   * Restore a snapshot by ID.
   * WARNING: This closes DB connections. The engine MUST be restarted after.
   * @param {string} snapshotId
   * @returns {Promise<{ restored: string[], safetySnapshotId: string }>}
   */
  async restoreSnapshot(snapshotId) {
    const manifest = this._readManifest();
    const snap = manifest.snapshots.find(s => s.id === snapshotId);
    if (!snap) throw new Error(`Snapshot not found: ${snapshotId}`);

    // Safety snapshot before restore
    const safety = await this.createSnapshot(`pre-restore:${snapshotId}`);
    log.info('snapshot', `Safety snapshot created: ${safety.id}`);

    const restored = [];

    for (const [key, filename] of Object.entries(snap.files)) {
      const srcPath = join(this.#snapshotDir, filename);
      if (!existsSync(srcPath)) {
        log.error('snapshot', `Snapshot file missing: ${filename}`);
        continue;
      }

      const destPath = this.#dbPaths[key];
      const db = this.#databases[key];

      // Close the DB connection
      try { db?.close(); } catch {}

      // Also remove WAL/SHM files
      try { unlinkSync(destPath + '-wal'); } catch {}
      try { unlinkSync(destPath + '-shm'); } catch {}

      // Copy snapshot over live DB
      copyFileSync(srcPath, destPath);
      restored.push(key);
      log.info('snapshot', `Restored ${key} from ${filename}`);
    }

    return { restored, safetySnapshotId: safety.id };
  }

  /** Remove old snapshots beyond MAX_SNAPSHOTS or MAX_TOTAL_MB. */
  _prune() {
    const manifest = this._readManifest();
    let removed = 0;

    // Remove beyond count limit
    while (manifest.snapshots.length > MAX_SNAPSHOTS) {
      const oldest = manifest.snapshots.shift();
      this._deleteSnapshotFiles(oldest);
      removed++;
    }

    // Remove beyond size limit
    let totalMB = manifest.snapshots.reduce((sum, s) => sum + (s.sizeMB || 0), 0);
    while (totalMB > MAX_TOTAL_MB && manifest.snapshots.length > 1) {
      const oldest = manifest.snapshots.shift();
      totalMB -= oldest.sizeMB || 0;
      this._deleteSnapshotFiles(oldest);
      removed++;
    }

    if (removed > 0) {
      this._writeManifest(manifest);
      log.info('snapshot', `Pruned ${removed} old snapshots`);
    }
  }

  _deleteSnapshotFiles(snap) {
    if (!snap?.files) return;
    for (const filename of Object.values(snap.files)) {
      try { unlinkSync(join(this.#snapshotDir, filename)); } catch {}
    }
  }

  /**
   * Get snapshot directory path (for external tools like rollback.sh).
   */
  get snapshotDir() { return this.#snapshotDir; }
}
