# Prior Art

This document is a defensive disclosure of public prior art that informed
Constellation Engine's memory subsystem. Posting it publicly serves two
purposes: (1) acknowledging the lineage of ideas we built on, and (2)
strengthening the prior-art record so the implementation patterns described
below remain freely available to the open-source community.

The AGPL-3.0 license (see [LICENSE](LICENSE)) grants a patent license only
from this project's contributors. Nothing in this document grants any patent
license from third parties. Where techniques originate from companies whose
patent posture is unclear, we have intentionally diverged from the original
naming and surface conventions; see *Adoption Notes* below.

## Mechanisms borrowed from public research

| Engine module | Mechanism | Primary prior art |
|---------------|-----------|-------------------|
| `src/mimir-resolver.js` | LLM verdict on top-k neighbors deciding write disposition | Mem0 (4-verb resolver pattern) |
| `schema.sql` (`valid_from` / `valid_to` / `superseded_by`) | Bi-temporal edges; never delete, only invalidate | SQL:2011 temporal tables; Snodgrass 1999; Zep / Graphiti |
| `node_type='self_act'` (subkinds `outreach`, `external_fetch_summary`, `anamnesis_summary`, `curiosity_probe`, `diary`) | Agent's own actions are written back as first-class graph nodes (no separate utterance table) | A-MEM (Xu et al. 2024); Generative Agents (Park et al. 2023) |
| `src/mimir-precommit-critic.js` | Pre-action LLM critique gate before output is committed | CRAG (Yan et al.); Self-Refine (Madaan et al. 2023); Constitutional AI |
| `src/mimir-reconsolidation-queue.js` | Write-triggered KNN-neighbor refresh (no batch reflection cron) | A-MEM neighbor reconsolidation |
| Tool/IR routing layer | Tiered LLM cognition with summary buffers and tool surfaces | MemGPT (Packer et al. 2023) |
| Anamnesis judge / debrief promotion | LLM-as-judge for promotion of episodic → semantic memory | LLM-as-Judge (Zheng et al. 2023) |

## Bibliography

1. **Packer et al. 2023.** MemGPT: Towards LLMs as Operating Systems. arXiv:2310.08560.
2. **Park et al. 2023.** Generative Agents: Interactive Simulacra of Human Behavior. arXiv:2304.03442.
3. **Snodgrass 1999.** *Developing Time-Oriented Database Applications in SQL*. Morgan Kaufmann.
4. **ISO/IEC 9075:2011** ("SQL:2011"). System-versioned and application-time-period tables.
5. **Madaan et al. 2023.** Self-Refine: Iterative Refinement with Self-Feedback.
6. **Anthropic 2022.** Constitutional AI: Harmlessness from AI Feedback.
7. **Zheng et al. 2023.** Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.
8. **Xu et al. 2024.** A-MEM: Agentic Memory for LLM Agents.
9. **Yan et al.** Corrective Retrieval-Augmented Generation. arXiv:2401.15884.

## Adoption notes

The patent landscape around two of the systems above (Mem0 — YC-backed
startup; Zep / Graphiti — Zep Software Inc.) was sufficiently uncertain at
the time of design that we chose surface-level divergence as a precaution:

- **Resolver verbs:** Constellation uses `INSERT / REVISE / CONSOLIDATE / SKIP`.
  Mem0's published surface is `ADD / UPDATE / MERGE / NOOP`. The underlying
  pattern (LLM verdict on top-k neighbors at write time) is well-established
  in the literature; the four specific verbs are not.
- **Bi-temporal column names:** Constellation uses the SQL:2011 standard
  vocabulary (`valid_from`, `valid_to`, `superseded_by`). Zep / Graphiti uses
  the project-specific tuple `(valid_from, invalid_at, t_created, t_expired)`.
  Standard vocabulary predates Zep by more than a decade.
- **Critic gate naming:** "Pre-commit critic gate" / "output validator" is
  used throughout the codebase rather than the brand term "Corrective RAG /
  CRAG", which is academic but sits in a crowded patent space around RAG
  critic patterns generally.

Mechanisms drawn from purely academic systems (A-MEM, CRAG, Self-Refine,
LLM-as-Judge, Constitutional AI, MemGPT, Generative Agents) are cited
directly without renaming, since the literature is itself the prior art.

## Clean-room statement

The implementation in this repository was developed by reading the public
papers, blog posts, and API documentation cited above. No source code from
`mem0ai/mem0`, `getzep/graphiti`, or comparable upstream projects was
consulted while writing or refactoring the modules listed in the table above.
Contributors who may have reviewed those upstream codebases for unrelated
purposes should disclose this in their pull request and limit changes to
modules that do not implement these mechanisms.

## Defensive posting

Publishing this list before the open-source release is itself a defensive
move: any later patent claim against the patterns enumerated here would have
to overcome the public availability of (a) the cited prior-art papers and
(b) this implementation, both timestamped before any such claim could
plausibly be filed.
