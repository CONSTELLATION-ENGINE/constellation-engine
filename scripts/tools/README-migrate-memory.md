# `migrate_memory.py` — Bring Your Existing Agent Memory Into Constellation Engine

If you've been keeping notes, diaries, or knowledge files for another AI agent
(ChatGPT exports, Obsidian vaults, plain Markdown notes, etc.), this tool
migrates that corpus into your fresh `constellation.db` so the engine can
recall and link to it from day one.

The tool is **deliberately format-light**: it accepts `.md` and `.txt`
(95 %+ of agent memory exports) and ignores everything else. It does **not**
touch `conversation.db` — your conversation history accumulates organically
once the engine is running.

---

## What it does

1. **Walks** the input directory, skipping binaries, dotfiles, and
   secret-bearing files (configurable: quarantine or abort).
2. **Parses** each file: optional YAML frontmatter, body, slugified ID,
   `event_at` extraction (frontmatter > filename `YYYY-MM-DD` > content).
3. **Routes** by path heuristics (diary/identity/milestone/principle/
   reading-note/relationship); falls back to `knowledge`.
4. **Embeds** with **BGE-M3 (1024-d)** — the same space the live engine
   uses, so imported nodes can fuse seamlessly with later writes.
5. **Auto-edges** by KNN cosine: floor 0.40, hub bias 1.2×, top-5,
   bidirectional, reverse 0.8× — mirrors `engine.cjs._suggestEdges`.
6. **Soft-suppresses** imported nodes in the SA pool at **0.40× weight**
   until the node has been accessed ≥ 5 times — prevents the import from
   drowning out organic activity. (Daemon flag: `MIMIR_IMPORT_SUPPRESS=1`,
   on by default.)
7. **Tags** every node with `imported_batch_id` so the entire batch is
   atomically rollback-able.

---

## Quick start

```bash
# 1. Dry-run (default — no writes, just a report)
python3 scripts/tools/migrate_memory.py \
    --db ./constellation.db \
    --input ~/agent-memory-export

# 2. Actually import
python3 scripts/tools/migrate_memory.py \
    --db ./constellation.db \
    --input ~/agent-memory-export \
    --execute

# 3. List batches
python3 scripts/tools/migrate_memory.py \
    --db ./constellation.db \
    --list-batches

# 4. Roll back a batch (deletes nodes + edges + embeddings + FTS rows)
python3 scripts/tools/migrate_memory.py \
    --db ./constellation.db \
    --rollback-batch imp-20260429T114609Z
```

The first run downloads the BGE-M3 model (~2 GB) into your HuggingFace cache.

---

## CLI flags

| Flag | Default | Notes |
|------|---------|-------|
| `--db PATH` | (required) | Path to `constellation.db` |
| `--input DIR` | (required for migrate) | Corpus directory |
| `--execute` | off | Without this flag the tool only reports |
| `--rollback-batch ID` | — | Cascade-deletes a batch |
| `--list-batches` | — | Tabulates `imported_batch_id` counts |
| `--polish ID` | — | (Phase 6 stub) optional LLM L1/L2 cleanup |
| `--batch-id ID` | auto | Override the generated `imp-...Z` ID |
| `--max-files N` | 2000 | Hard ceiling per run |
| `--max-file-size MB` | 2 | Per-file cap |
| `--max-l2-chars N` | 8000 | Truncate body to this many chars |
| `--collision-policy abort` | abort | What to do if a node ID already exists |
| `--secrets-policy quarantine\|abort` | quarantine | Files matching the secret regexes are moved aside |
| `--report-dir PATH` | `reports` | Where dry-run + batch reports land |

Set `MIGRATE_TOOL_ENABLED=0` to disable the tool entirely (kill switch).

---

## What you get out

After `--execute`:

```
DONE: inserted=15 failed=0 edges=54 batch_id=imp-20260429T114609Z
note: imported nodes are soft-suppressed in Mímir SA pool (×0.40)
      until accessed ≥4 times.
```

A JSON report lands in `reports/<batch_id>/summary.json`.

---

## Quality bar (Phase 7 fixture results)

Tested on 15 mixed Markdown files (diary + reading notes):

- `event_at` coverage: **100 %**
- Edges: 54 `associative`, strength 0.292 – 0.660 (median 0.46)
- Self-loops / duplicates: **0**
- L2 length: median 2 687 chars, max 5 574 (under cap)
- All nodes correctly stamped with `owner_id='self'` and
  `imported_batch_id`

---

## How it integrates with the engine

| Layer | Behavior on imported nodes |
|-------|---------------------------|
| FTS5 (`nodes_fts`) | Indexed on insert |
| `embeddings` (BGE-M3) | Inserted in same 1024-d space as engine writes |
| `vec0` virtual table | Populated, so KNN works for both old and new |
| Mímir SA pool | Activation × 0.40 until `access_count ≥ 5` (soft) |
| Anamnesis | Treated normally — emotional resonance applies if relevant |

---

## Pool pollution check

After importing, run the companion analyzer to see how much pool weight
your imports currently command:

```bash
python3 scripts/tools/measure_import_pollution.py --db ./constellation.db
# or scope to one batch:
python3 scripts/tools/measure_import_pollution.py \
    --db ./constellation.db \
    --batch imp-20260429T114609Z
```

Targets: effective pool share **< 30 % mean / < 50 % max** in the first
48 hours after import. Above those thresholds, consider rolling back and
splitting the corpus into smaller batches.

---

## Safety

- Default mode is **dry-run** — no writes happen without `--execute`.
- Every run is wrapped in a transaction; failures roll back atomically.
- Secrets scanner blocks files matching common API-key / token / private-key
  patterns; matched files are moved to `<input>/.migrate-quarantine/`.
- Binary sniff (NUL byte) skips images / archives / executables.
- The kill switch `MIGRATE_TOOL_ENABLED=0` neutralizes the tool without
  removing the file.

---

## What we deliberately do *not* do

- **No conversation.db injection.** Conversation history is owned by
  the engine; importing fake turns would corrupt the timeline.
- **No source-specific adapters.** Every agent platform has its own
  export format; we standardize on plain Markdown / text and let user
  pre-flatten if needed.
- **No automatic LLM polish in Tier A.** The default path is fully local.
  `--polish` is opt-in (Phase 6, stub today).

---

## Limitations

- BGE-M3 is ~2 GB. First run is slow on cold caches.
- If the engine schema lacks `imported_batch_id`, the tool adds it via
  idempotent `ALTER TABLE` (Phase 0).
- Subkind routing depends on path components; flat exports default to
  `knowledge`.
