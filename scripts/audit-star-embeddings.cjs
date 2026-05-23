#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.CONSTELLATION_DB || path.join(ROOT, 'constellation.db');
const OUT_DIR = path.join(ROOT, 'engine-output', 'benchmarks');

const args = new Set(process.argv.slice(2));
const write = args.has('--write');
const full = args.has('--full');
const sampleLimit = Number((process.argv.find(a => a.startsWith('--sample=')) || '--sample=8').slice('--sample='.length)) || 8;
const groupLimit = Number((process.argv.find(a => a.startsWith('--group-limit=')) || '--group-limit=25').slice('--group-limit='.length)) || 25;

function pct(n, d) {
  if (!d) return 0;
  return Number(((n / d) * 100).toFixed(2));
}

function rowsBy(db, groupExpr) {
  const rows = db.prepare(`
    WITH active AS (
      SELECT n.id, n.node_type, n.subkind, n.source,
             CASE WHEN nr.rowid IS NOT NULL THEN 1 ELSE 0 END AS has_rowid,
             CASE WHEN ne.id IS NOT NULL THEN 1 ELSE 0 END AS has_vec
        FROM nodes n
        LEFT JOIN node_rowids nr ON nr.node_id = n.id
        LEFT JOIN node_embeddings ne ON ne.id = nr.rowid
       WHERE n.state = 'active'
    )
    SELECT ${groupExpr} AS bucket,
           COUNT(*) AS total,
           SUM(has_rowid) AS with_rowid,
           SUM(has_vec) AS with_vec,
           SUM(CASE WHEN has_rowid = 0 THEN 1 ELSE 0 END) AS missing_rowid,
           SUM(CASE WHEN has_rowid = 1 AND has_vec = 0 THEN 1 ELSE 0 END) AS missing_vec
      FROM active
     GROUP BY bucket
     ORDER BY missing_vec DESC, missing_rowid DESC, total DESC
  `).all();
  return full ? rows : rows.slice(0, groupLimit);
}

function main() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  sqliteVec.load(db);

  const activeTotal = db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE state = 'active'").get().c;
  const rowidCount = db.prepare(`
    SELECT COUNT(*) AS c
      FROM nodes n
      JOIN node_rowids nr ON nr.node_id = n.id
     WHERE n.state = 'active'
  `).get().c;
  const vecCount = db.prepare(`
    SELECT COUNT(*) AS c
      FROM nodes n
      JOIN node_rowids nr ON nr.node_id = n.id
      JOIN node_embeddings ne ON ne.id = nr.rowid
     WHERE n.state = 'active'
  `).get().c;
  const orphanRowids = db.prepare(`
    SELECT COUNT(*) AS c
      FROM node_rowids nr
      LEFT JOIN nodes n ON n.id = nr.node_id
     WHERE n.id IS NULL
  `).get().c;
  const orphanVecRows = db.prepare(`
    SELECT COUNT(*) AS c
      FROM node_embeddings ne
      LEFT JOIN node_rowids nr ON nr.rowid = ne.id
     WHERE nr.rowid IS NULL
  `).get().c;

  const missingSamples = db.prepare(`
    SELECT n.id, n.node_type, n.subkind, n.source, n.created_at, n.l0,
           CASE WHEN nr.rowid IS NULL THEN 'missing_rowid' ELSE 'missing_vec' END AS gap
      FROM nodes n
      LEFT JOIN node_rowids nr ON nr.node_id = n.id
      LEFT JOIN node_embeddings ne ON ne.id = nr.rowid
     WHERE n.state = 'active'
       AND (nr.rowid IS NULL OR ne.id IS NULL)
     ORDER BY n.created_at DESC
     LIMIT ?
  `).all(sampleLimit);

  const summary = {
    generated_at: new Date().toISOString(),
    db: DB_PATH,
    group_output: full ? 'full' : `top_${groupLimit}`,
    active_nodes: activeTotal,
    active_with_rowid: rowidCount,
    active_with_vec0: vecCount,
    missing_rowid: activeTotal - rowidCount,
    missing_vec0_after_rowid: rowidCount - vecCount,
    coverage_pct: pct(vecCount, activeTotal),
    orphan_rowids: orphanRowids,
    orphan_vec0_rows: orphanVecRows,
    by_node_type: rowsBy(db, "COALESCE(node_type, 'unknown')"),
    by_source: rowsBy(db, "COALESCE(source, 'unknown')"),
    by_subkind: rowsBy(db, "COALESCE(subkind, '(none)')"),
    missing_samples: missingSamples,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (write) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const outPath = path.join(OUT_DIR, `star-embedding-coverage-${stamp}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\n[audit-star-embeddings] wrote ${outPath}`);
  }

  db.close();
}

main();

