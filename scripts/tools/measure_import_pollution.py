#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""measure_import_pollution.py — How much of the SA pool is the import?

Static analyzer. Reads constellation.db and reports the share of pool
weight that imported nodes currently hold, with the daemon's
soft-suppression (×0.40 until access_count ≥ 5) baked in.

Use this to decide if a migration batch is the right size for the
existing graph (rule of thumb: keep mean imported share < 30%, max < 50%
in the first 48 h of operation).

Usage:
    python3 scripts/tools/measure_import_pollution.py --db constellation.db
    python3 scripts/tools/measure_import_pollution.py --db constellation.db --batch imp-20260429T114609Z
"""
from __future__ import annotations
import argparse, sqlite3, sys, json
from pathlib import Path

SUPPRESS_MULTIPLIER = 0.40
PROMOTE_THRESHOLD = 5


def column_exists(conn: sqlite3.Connection, table: str, col: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == col for r in rows)


def fetch_pool_view(conn: sqlite3.Connection):
    has_bitemporal = column_exists(conn, 'nodes', 'valid_to')
    bt_clause = "AND (valid_to IS NULL OR valid_to > strftime('%s','now')*1000)" \
        if has_bitemporal else ''
    sql = f"""
        SELECT id, weight, access_count, conn_count,
               COALESCE(imported_batch_id, '') AS batch
        FROM nodes
        WHERE state='active' {bt_clause}
    """
    return conn.execute(sql).fetchall()


def effective_weight(weight, access_count, batch):
    base = (weight or 0.0)
    if batch and (access_count or 0) < PROMOTE_THRESHOLD:
        return base * SUPPRESS_MULTIPLIER
    return base


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--db', required=True)
    p.add_argument('--batch', help='Restrict imported analysis to one batch_id')
    p.add_argument('--json', action='store_true', help='Machine-readable output')
    args = p.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: db not found: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    if not column_exists(conn, 'nodes', 'imported_batch_id'):
        print("ERROR: nodes table missing imported_batch_id column. "
              "Run migrate_memory.py once (it adds the column idempotently).",
              file=sys.stderr)
        return 2

    rows = fetch_pool_view(conn)
    total_n = len(rows)
    if total_n == 0:
        print("(no active nodes — nothing to measure)")
        return 0

    organic_w, imported_w_raw, imported_w_eff = 0.0, 0.0, 0.0
    organic_n, imported_n, suppressed_n, promoted_n = 0, 0, 0, 0
    for nid, weight, access_count, conn_count, batch in rows:
        if args.batch and batch and batch != args.batch:
            continue
        is_imported = bool(batch) and (not args.batch or batch == args.batch)
        ew = effective_weight(weight, access_count, batch if is_imported else '')
        if is_imported:
            imported_n += 1
            imported_w_raw += (weight or 0.0)
            imported_w_eff += ew
            if (access_count or 0) >= PROMOTE_THRESHOLD:
                promoted_n += 1
            else:
                suppressed_n += 1
        else:
            organic_n += 1
            organic_w += ew

    total_eff = organic_w + imported_w_eff
    share_eff = (imported_w_eff / total_eff) if total_eff > 0 else 0.0
    share_raw = (imported_w_raw / (organic_w + imported_w_raw)) \
        if (organic_w + imported_w_raw) > 0 else 0.0

    report = {
        "total_active_nodes": total_n,
        "organic": {"count": organic_n, "weight": round(organic_w, 3)},
        "imported": {
            "count": imported_n,
            "suppressed": suppressed_n,
            "promoted": promoted_n,
            "weight_raw": round(imported_w_raw, 3),
            "weight_effective": round(imported_w_eff, 3),
        },
        "share_of_pool": {
            "raw_pct": round(share_raw * 100, 2),
            "effective_pct_with_suppression": round(share_eff * 100, 2),
        },
        "thresholds": {
            "warn_mean_pct": 30.0,
            "warn_max_pct": 50.0,
            "promote_at_access": PROMOTE_THRESHOLD,
            "suppress_multiplier": SUPPRESS_MULTIPLIER,
        },
    }
    if args.batch:
        report["batch_id"] = args.batch

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        r = report
        print(f"Active nodes:       {r['total_active_nodes']}")
        print(f"  organic:          {r['organic']['count']:5d}  weight={r['organic']['weight']}")
        print(f"  imported:         {r['imported']['count']:5d}  "
              f"weight_eff={r['imported']['weight_effective']} "
              f"raw={r['imported']['weight_raw']}")
        print(f"    suppressed:     {r['imported']['suppressed']:5d}  (access<{PROMOTE_THRESHOLD}, ×{SUPPRESS_MULTIPLIER})")
        print(f"    promoted:       {r['imported']['promoted']:5d}  (access≥{PROMOTE_THRESHOLD}, full weight)")
        print(f"")
        print(f"Pool share by imports (effective): {r['share_of_pool']['effective_pct_with_suppression']:.2f}%")
        print(f"Pool share by imports (raw):       {r['share_of_pool']['raw_pct']:.2f}%")
        print(f"")
        eff = r['share_of_pool']['effective_pct_with_suppression']
        if eff > r['thresholds']['warn_max_pct']:
            print(f"⚠️  EXCEEDS max threshold ({r['thresholds']['warn_max_pct']}%) — consider rolling back batch.")
        elif eff > r['thresholds']['warn_mean_pct']:
            print(f"⚠️  Above mean target ({r['thresholds']['warn_mean_pct']}%) — monitor.")
        else:
            print("✓ Within targets.")

    return 0


if __name__ == '__main__':
    sys.exit(main())
