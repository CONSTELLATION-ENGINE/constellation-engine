# Identity Template Setup Guide

This folder contains the baseline identity files that Constellation Engine injects into every turn. Two files are auto-loaded (`SYSTEM_PREAMBLE.md` + `COMMUNICATION_STYLE.md`); everything else is on-demand.

The `*.template.md` files here are **starting points**, not final versions. The first-run wizard renders them into their `*.md` siblings and fills the placeholders. You can also do it manually — fill in the placeholders, adapt the tone to your project, and delete sections you don't need.

Four files ship in this folder:

| File | Purpose | Auto-injected? |
|---|---|---|
| `SYSTEM_PREAMBLE.template.md` | Operational scaffolding — how the agent should operate. Render to `SYSTEM_PREAMBLE.md`. | Yes (after rendering). |
| `COMMUNICATION_STYLE.template.md` | Tone and structure guidance. Render to `COMMUNICATION_STYLE.md`. | Yes (after rendering). |
| `ENGINE-GUIDE.md` | Concise reference for the star map, attention pool, tools, and tunables. Written for the agent to read on demand. | No — referenced in `SYSTEM_PREAMBLE §7` as an on-demand index entry. |
| `SETUP.md` | This file. | No. |

---

## Quick Start

1. Copy each template onto its `.md` sibling at the same path:
   ```bash
   cp SYSTEM_PREAMBLE.template.md SYSTEM_PREAMBLE.md
   cp COMMUNICATION_STYLE.template.md COMMUNICATION_STYLE.md
   ```
   (The first-run wizard does this for you. Use the manual path only if you're bypassing the wizard.)
2. Open `SYSTEM_PREAMBLE.md` and `COMMUNICATION_STYLE.md` and replace the `{{placeholders}}` (see list below). `ENGINE-GUIDE.md` has no placeholders — it only needs edits if you modify engine behavior.
3. Create your **soul-core** star map node — this is where your agent's actual identity lives. The preamble only points to it. See "Creating soul-core" below.
4. Verify `config.json` → `runtime.fixedFiles` includes only the two auto-loaded files:
   ```json
   "fixedFiles": [
     "identity/SYSTEM_PREAMBLE.md",
     "identity/COMMUNICATION_STYLE.md"
   ]
   ```
   Do **not** add `ENGINE-GUIDE.md` here — it is read on demand via `SYSTEM_PREAMBLE §7`, not auto-injected.
5. Restart the engine. The first turn should reflect your placeholders.

---

## Placeholder Reference

All placeholders use `{{UPPER_SNAKE}}` syntax and must be replaced with literal values before running — the engine does not template-substitute them.

| Placeholder | Where | Fill with |
|---|---|---|
| `{{AGENT_NAME}}` | SYSTEM_PREAMBLE §1 | What your agent calls itself (e.g., `Aria`, `Orion`, `Nova`). Must match the name in the soul-core node. |
| `{{DEFAULT_LANGUAGE}}` | SYSTEM_PREAMBLE §1, §9 | The user's preferred conversation language (e.g., `English`, `Spanish`, `Japanese`). |
| `{{PROJECT_ROOT}}` | SYSTEM_PREAMBLE §3 | Absolute path to your Constellation Engine checkout (e.g., `/home/user/constellation-engine/`). |
| `{{CHANNELS}}` | SYSTEM_PREAMBLE §3 | Where you talk to the agent (e.g., `Telegram (@YourBot)`, `Dashboard at http://localhost:18800`, `CLI`). List all active channels. |

Search for `{{` in both files to catch any you miss.

---

## Section-by-Section Guide

### SYSTEM_PREAMBLE.md

**§1 Identity** — Keep the soul-core pointer structure. The preamble should **not** contain personality, values, or backstory — those go in the soul-core star map node. If you find yourself writing "My values are..." here, stop and put it in a node instead.

**§2 Operating Principles** — These are load-bearing. Each sub-section (Honesty Floor, Star Map Discipline, Attention Pool Usage, Safety Guardrails, Engineering Rigor, Anti-Loop) encodes a defense against a common failure mode we've hit in production:

- **Honesty Floor** — LLMs drift toward confident fabrication. This section pushes back.
- **Star Map Discipline** — without it, the agent writes noise or duplicates existing knowledge.
- **Attention Pool Usage** — without it, the agent parrots pool content even when it's off-topic.
- **Safety Guardrails** — without it, destructive actions slip through.
- **Engineering Rigor** — without it, the agent batches changes and loses track of which one broke things.
- **Anti-Loop** — without it, the agent re-raises resolved issues from compaction summaries.

**Keep all six** unless your use case genuinely doesn't involve code (e.g., a pure writing assistant — you can drop §2.5 Engineering Rigor). Do **not** drop §2.1 Honesty Floor.

**§3 Runtime Environment** — project-specific. Replace placeholders. Add or remove bullets to match your deployment.

**§4 Tools** — this is the tool surface the engine exposes. If you disable a tool in `config.json`, remove it here; if you add a custom tool, add it here. Agents behave better when the tool list is accurate.

**§5 Session Start Protocol** — adapt to your state-file choices (e.g., if you don't use `COGNITIVE_STATE.md`, point to whatever your session-state file is, or delete the section).

**§6 DEBRIEF Hints** — **must stay** if you use Anamnesis (the debrief cron that distills turns into star map nodes). This is the input protocol. Do not rename the fields. You can prune the `nt` enum if some types don't apply to your domain.

**§7 On-Demand Index** — a map from names to files. Keep the structure; replace the contents with your actual files. This is where you point the agent at:
- Long-running project state documents
- Mechanism / architecture references
- Task / cron manuals

**§8 Output Locations** — conventions for generated files. Keep a predictable root so downstream crons can find artifacts.

**§9 Language** — terminal reinforcement of the default language. Redundant with §1 by design; some agents will drop the first cue but keep the last.

### COMMUNICATION_STYLE.md

Shorter and more personal. The template is English; translate the whole thing if your default language is different — the style rules have to be in the language the agent is actually using, or they don't land.

Safe to delete:
- **Cron task reports** — only relevant if you run scheduled cron agents.
- **Emotional register** — if your use case is purely transactional (e.g., a code assistant), you can drop this.

Must keep:
- **Structure** (conclusion-first)
- **Reasoning chain** (don't narrate tool calls)
- **Voice** (express judgment, not just compliance)
- **Pushback boundary** (without this, agents drift into sycophancy)

### ENGINE-GUIDE.md

A concise reference for the agent covering what the engine does, what it sees each turn, available tools, background mechanisms, and tunable parameters. Written **for the agent to read on demand**, not for end-user.

The guide is **not** auto-injected — it is listed in `SYSTEM_PREAMBLE §7` as an on-demand index entry. The agent reads it when it needs to reason about engine behavior (tuning, debugging, extending).

**When to edit it:**
- You change a parameter default → update §9.
- You add or remove a background mechanism (cron, daemon, pipeline) → update §7.
- You add, remove, or change a tool → update §5.
- You fork the engine and diverge from upstream semantics → rewrite affected sections.

**When not to edit it:**
- For user-specific configuration (paths, tokens, channels) → those go in `SYSTEM_PREAMBLE §3`.
- For project-specific lessons or decisions → those go in star map nodes, not here.

The guide is structured so the agent can skim section headings and jump to the one it needs. Keep that property when editing — don't merge sections, don't bury important info in prose walls.

---

## Creating `soul-core`

The preamble treats `soul-core` as the authoritative identity source. You need to actually create it:

```bash
# From a Node.js REPL in the project root, or via the Dashboard's "Create Node" UI:
constellation_remember({
  id: 'soul-core',
  node_type: 'identity',
  l0: 'The gravitational center of this mind — who I am, who I serve, what I believe.',
  l1: 'I am {{AGENT_NAME}}, an agent running inside Constellation Engine...',
  l2: '<full identity: role, values, origin story, how you relate to the user, what you refuse to do, what you care about>',
  tags: ['identity', 'soul-core', 'permanent']
});
```

Put everything distinguishing about your agent in `l2`. The node will be:
- Pinned permanently in the attention pool (never decays, never competes)
- Protected from consolidation (never fused, never superseded)
- Injected in every turn regardless of topic

Treat it as the agent's constitution. Revise deliberately, not casually.

---

## What Goes Where

| Content | Goes in |
|---|---|
| "You are X, built by Y" | soul-core node |
| Personality, values, backstory, relationships | soul-core node (long form in `l2`) |
| How to respond / what tools to use | SYSTEM_PREAMBLE.md |
| How to talk (tone, length, structure) | COMMUNICATION_STYLE.md |
| Current project state, active tasks | COGNITIVE_STATE.md + tasks.json (on-demand) |
| Domain knowledge, prior decisions, lessons learned | star map nodes (via `constellation_remember`) |
| Specific facts you want remembered across sessions | DEBRIEF hints → Anamnesis → star map |

**Rule of thumb**: if it's immutable identity, it goes in soul-core. If it's operational guidance, it goes in the preamble. If it's knowledge, it goes in the star map. If it's current state, it goes in COGNITIVE_STATE. If it's style, it goes in COMMUNICATION_STYLE.

---

## Common Pitfalls

1. **Putting personality in SYSTEM_PREAMBLE** — bloats the preamble and dilutes operational signals. Personality goes in soul-core.
2. **Listing every tool, mechanism, and file path in the preamble** — the agent doesn't need to memorize file maps. Use §7 On-Demand Index to point at authoritative references instead.
3. **Leaving `{{placeholders}}` unfilled** — the agent will repeat them literally in responses.
4. **Removing §2.1 Honesty Floor** — without it, agents confidently fabricate. Don't.
5. **Adding "always do X" rules for every past mistake** — the preamble grows without bound. Write a lesson as a star map node; the attention pool will surface it when relevant.

---

## Keeping the Preamble Lean

The preamble is injected on **every** turn. Every line costs tokens forever. Periodic discipline:

- If a rule only fires once a month, it's a star map node, not a preamble line.
- If two sections overlap, merge them.
- If a reference list drifts out of date, replace it with a pointer to an on-demand index.
- Target: under 200 lines. This template is ~150.

When in doubt, trust the star map. The preamble is scaffolding; the star map is the mind.
