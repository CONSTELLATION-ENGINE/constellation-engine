# Constellation Engine — Permissions Policy

**Version:** 1.0
**Last updated:** 2026-05-03
**Applies to:** OSS launcher + bundled engine (this repository)

This document is the authoritative description of what Constellation Engine reads, writes, and sends. The permission disclosure shown during first-run onboarding is a summary of this file. If you want the full picture, read on.

---

## 1. What Constellation Engine is

Constellation Engine is an autonomous agent. The user supplies an LLM provider (Anthropic, OpenAI, Ollama, etc.); the engine drives that LLM through tool-using turns to read its own memory, write new entries, run periodic background work, and chat with the user. Because the LLM authors tool calls the engine then executes, "permissions" are best understood as **what the engine is capable of, not what each individual call asks for**. Per-call consent prompts would make autonomous behavior impossible. So the policy below is upfront and complete.

---

## 2. What the engine reads

| Path | Why |
|------|-----|
| `<engine root>/data/conversations.db` | Chat history + onboarding state. SQLite. |
| `<engine root>/data/constellation.db` | The "star map" — the agent's persistent memory store. |
| `<engine root>/data/ratatoskr.db`, `mimir_*.db` | Internal mechanism state (anchors, pulses, autonomy timers). |
| `<engine root>/.env` | API keys + provider URLs you configured during onboarding. |
| `<engine root>/tasks.json` | The agent's TODO list (engine-side). |
| `<engine root>/identity/*.json` | Owner profile, soul-core handle, language preferences. |
| `<engine root>/data/logs/*.log` | Diagnostic logs — only written by the engine, also read for self-inspection. |
| `<engine root>/models/*.bin`, `*.gguf`, `*.safetensors` | Embedding + reranker model weights downloaded during Stage 2. |

**Strict rule:** No path **outside** the engine root is read. No `~/Documents`, no `C:\Users\X\Desktop`, no system config. The launcher process resolves `<engine root>` to a writable user-data directory at first launch (Windows: `%APPDATA%\constellation-launcher\engine`; Linux: `~/.config/constellation-launcher/engine`; macOS: `~/Library/Application Support/constellation-launcher/engine`).

---

## 3. What the engine writes

Same paths as §2, plus:

| Path | Why |
|------|-----|
| `<engine root>/data/*.db-wal`, `*.db-shm` | SQLite WAL — automatic. |
| `<engine root>/data/.first-run-complete` | One-shot sentinel; marks onboarding done. |
| `<engine root>/data/.permission-acknowledged` | Records you read this disclosure. |
| `<engine root>/data/.config-inconsistent` | Surfaces only if config got out of sync (recoverable). |
| `<engine root>/data/save/*.json` | Periodic checkpoints of the in-memory star map. |
| `<engine root>/data/logs/*.log` | Rolling activity logs (rotated by size). |
| `<engine root>/data/.engine.pid` | Process ID file used by the launcher to manage lifecycle. |

**Strict rule:** No write outside the engine root. The engine's `tool_executor` rejects file paths that escape the configured root.

---

## 4. What goes over the network

**Always allowed (you configured these):**
- HTTPS to your chosen LLM provider(s). The launcher's onboarding wizard collects the URL and stores it in `.env` (chmod 0600). At runtime each LLM call goes to that URL — no other.
- HTTPS to model mirrors listed in `electron/onboarding/mirrors.json`. These are HuggingFace, GitHub Releases, and similar — used only during Stage 2 component download. Each mirror's URL is visible in that file.

**Never allowed (default):**
- No telemetry. We do not send analytics, crash reports, or usage data anywhere. There is no "phone home."
- No automatic updates. New versions require you to run a new installer; the engine never replaces its own binaries.
- No outbound to anywhere not in the categories above.

**Tools the LLM might author that touch the network:**
- `web_fetch` — fetches a URL the LLM names. The engine does **not** restrict the URL beyond requiring HTTPS for tracked components. If you don't want the agent to fetch arbitrary URLs, disable web tools in Settings → Tools (post-v1; v1 ships with web tools enabled).
- `outreach_*` — Mímir's optional outreach actions (email/Telegram). These are **OFF by default in v1**. Turning them on requires explicit opt-in via Settings.

---

## 5. Subprocesses

The launcher spawns:
- `node src/main.js` — the engine itself. Mímir's autonomous-loop runs in-process.

The engine is a child of the launcher process. It inherits your environment. It terminates when the launcher quits (graceful: WAL checkpoint + Mímir save first, then SIGKILL escalation after 8 s grace).

**Strict rule:** No system services are installed. No firewall rules touched. No registry edits on Windows. No launchd / systemd / cron jobs created outside the engine's own internal scheduler.

---

## 6. What stays local

Everything not listed in §4 stays on your machine. That includes:
- All chat history, ever.
- All star-map nodes (the agent's memory).
- All API keys.
- All identity / soul-core data.
- All logs.

Backups are your responsibility. The engine writes to `<engine root>/data/save/` periodically but does not upload them anywhere.

---

## 7. What you control

- **Kill switch:** Closing the launcher window terminates the engine within 8 s.
- **Scope:** Settings → Permissions (post-v1) lets you grant additional read paths. v1 ships with engine-root scope only.
- **Provider keys:** Editable any time via Settings → LLM Roles, or by hand in `.env`.
- **Tool toggles:** Settings → Tools lists every tool the LLM is allowed to call; you can disable any of them.
- **Outreach off-switch:** Mímir autonomy modes are environment-gated; setting `MIMIR_AUTONOMY_KILL=1` halts all autonomous LLM calls.

---

## 8. Versioning

Each version of this document has a `version` field at the top. The launcher records which version you acknowledged in `data/.permission-acknowledged`. If a future version expands what the engine is allowed to do, the launcher will surface the disclosure again at next launch — you'll see what changed and accept or quit. v1.0 covers the engine-root scope described above; that's the baseline that does not require re-acknowledgement across patch updates.

---

## 9. AGPL note

The engine is licensed AGPL-3.0-or-later. The source is in this repository. You can audit, fork, modify, and run it under whatever sandboxing or system-level controls you prefer — no special permission from the project required.

---

## 10. Reporting

If you find behavior that contradicts this document, that's a bug. File an issue at the project repository. The disclosure exists so we are accountable to it.
