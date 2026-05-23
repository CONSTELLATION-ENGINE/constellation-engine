#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.CONSTELLATION_DB || path.join(ROOT, 'constellation.db');
const MIMIR_PORT = process.env.MIMIR_PORT || 18810;
const MIMIR_URL = process.env.MIMIR_URL || `http://127.0.0.1:${MIMIR_PORT}`;
const DEFAULT_TYPES = [
  'theory',
  'engineering',
  'language-template',
  'reading-note',
  'observation',
  'knowledge',
  'general-knowledge',
];

const args = process.argv.slice(2);
const flags = new Set(args);
const apply = flags.has('--apply');
const allTypes = flags.has('--all-types');
const includeProtected = flags.has('--include-protected');
const limit = Number((args.find(a => a.startsWith('--limit=')) || '--limit=100').slice('--limit='.length)) || 100;
const batchSize = Math.max(1, Math.min(128, Number((args.find(a => a.startsWith('--batch-size=')) || '--batch-size=24').slice('--batch-size='.length)) || 24));
const typesArg = args.find(a => a.startsWith('--types='));
const types = allTypes
  ? []
  : (typesArg ? typesArg.slice('--types='.length).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_TYPES);

const PROTECTED_TYPES = new Set([
  'identity',
  'milestone',
  'principle',
  'diary',
  'experiment',
  'relationship',
]);

function usage() {
  console.log(`Usage:
  node scripts/backfill-star-embeddings.cjs [--apply] [--limit=N] [--batch-size=N]
    [--types=theory,engineering] [--all-types] [--include-protected]

Defaults:
  dry-run only, limit=100, batch-size=24,
  types=${DEFAULT_TYPES.join(',')}

Notes:
  - Writes only node_rowids/node_embeddings.
  - Uses the same embedding text as engine.remember(): semantic_anchor when set, otherwise l0 + l1.
  - Does not suggest/create edges.
`);
}

if (flags.has('--help') || flags.has('-h')) {
  usage();
  process.exit(0);
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function buildEmbeddingText(node = {}) {
  const anchor = typeof node.semantic_anchor === 'string' ? node.semantic_anchor.trim() : '';
  if (anchor) return anchor;
  return `${node.l0 || ''} ${node.l1 || ''}`.trim();
}

function embeddingToBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (Array.isArray(value)) return Buffer.from(Float32Array.from(value).buffer);
  throw new Error('unsupported embedding payload');
}

async function embedBatch(texts) {
  const resp = await fetch(`${MIMIR_URL}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`/embed HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }
  const data = await resp.json();
  const payload = Array.isArray(data.embeddings_b64) ? data.embeddings_b64 : data.embeddings;
  if (!data.ok || !Array.isArray(payload)) {
    throw new Error(`/embed returned invalid payload: ${JSON.stringify(data).slice(0, 500)}`);
  }
  if (payload.length !== texts.length) {
    throw new Error(`/embed returned ${payload.length} embeddings for ${texts.length} texts`);
  }
  return payload.map(embeddingToBuffer);
}

function selectCandidates(db) {
  const params = [];
  let typeFilter = '';
  if (types.length > 0) {
    typeFilter = `AND COALESCE(n.node_type, 'unknown') IN (${placeholders(types)})`;
    params.push(...types);
  }
  let protectedFilter = '';
  if (!includeProtected) {
    const protectedTypes = [...PROTECTED_TYPES];
    protectedFilter = `AND COALESCE(n.node_type, 'unknown') NOT IN (${placeholders(protectedTypes)})`;
    params.push(...protectedTypes);
  }
  params.push(limit);

  return db.prepare(`
    SELECT n.id, n.l0, n.l1, n.semantic_anchor, n.node_type, n.subkind, n.source, n.created_at,
           nr.rowid AS mapped_rowid
      FROM nodes n
      LEFT JOIN node_rowids nr ON nr.node_id = n.id
      LEFT JOIN node_embeddings ne ON ne.id = nr.rowid
     WHERE n.state = 'active'
       AND ne.id IS NULL
       ${typeFilter}
       ${protectedFilter}
     ORDER BY
       CASE COALESCE(n.node_type, 'unknown')
         WHEN 'theory' THEN 0
         WHEN 'engineering' THEN 1
         WHEN 'language-template' THEN 2
         WHEN 'reading-note' THEN 3
         WHEN 'observation' THEN 4
         WHEN 'knowledge' THEN 5
         ELSE 9
       END,
       n.created_at DESC
     LIMIT ?
  `).all(...params);
}

function summarizeRemaining(db) {
  return db.prepare(`
    SELECT COALESCE(n.node_type, 'unknown') AS node_type,
           COUNT(*) AS missing
      FROM nodes n
      LEFT JOIN node_rowids nr ON nr.node_id = n.id
      LEFT JOIN node_embeddings ne ON ne.id = nr.rowid
     WHERE n.state = 'active'
       AND ne.id IS NULL
     GROUP BY node_type
     ORDER BY missing DESC
     LIMIT 20
  `).all();
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`DB not found: ${DB_PATH}`);
  const db = new Database(DB_PATH, { fileMustExist: true });
  sqliteVec.load(db);

  const candidates = selectCandidates(db);
  console.log(JSON.stringify({
    db: DB_PATH,
    mode: apply ? 'apply' : 'dry-run',
    mimir_url: MIMIR_URL,
    selected_types: allTypes ? ['*'] : types,
    include_protected: includeProtected,
    limit,
    batch_size: batchSize,
    candidate_count: candidates.length,
    first_candidates: candidates.slice(0, 12).map(r => ({
      id: r.id,
      node_type: r.node_type,
      source: r.source,
      l0: r.l0,
    })),
    remaining_missing_by_type_before: summarizeRemaining(db),
  }, null, 2));
  if (!apply) {
    db.close();
    return;
  }

  const upsertRowid = db.prepare('INSERT OR IGNORE INTO node_rowids (node_id) VALUES (?)');
  const getRowid = db.prepare('SELECT rowid FROM node_rowids WHERE node_id = ?');
  const deleteVec = db.prepare('DELETE FROM node_embeddings WHERE id = ?');
  const insertVec = db.prepare('INSERT INTO node_embeddings (id, embedding) VALUES (?, ?)');
  const writeBatch = db.transaction((rows, embeddings) => {
    for (let i = 0; i < rows.length; i += 1) {
      const node = rows[i];
      upsertRowid.run(node.id);
      const rowid = getRowid.get(node.id)?.rowid;
      if (!rowid) throw new Error(`failed to map rowid for ${node.id}`);
      deleteVec.run(rowid);
      insertVec.run(BigInt(rowid), embeddings[i]);
    }
  });

  let written = 0;
  const started = Date.now();
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch.map(buildEmbeddingText));
    writeBatch(batch, embeddings);
    written += batch.length;
    console.log(`[backfill-star-embeddings] wrote ${written}/${candidates.length}`);
  }

  console.log(JSON.stringify({
    written,
    elapsed_ms: Date.now() - started,
    remaining_missing_by_type_after: summarizeRemaining(db),
  }, null, 2));
  db.close();
}

main().catch((err) => {
  console.error(`[backfill-star-embeddings] ${err.stack || err.message}`);
  process.exit(1);
});

