# Security Policy

We take security issues seriously and appreciate your help in keeping users safe. This document describes how to report vulnerabilities and what to expect from us.

## Reporting a Vulnerability

**Do not** open a public GitHub issue for security problems. Instead, use one of the private channels below:

- **GitHub Private Vulnerability Reporting**: open a report via the [Security tab](https://github.com/devinrory-collab/constellation-engine/security/advisories/new) on this repository. This is the preferred channel.

When reporting, please include:

- A clear description of the vulnerability and its potential impact
- Steps to reproduce, ideally with a minimal example
- Affected versions (or `git rev-parse HEAD` if you tested an unreleased commit)
- Your assessment of severity (informational, low, medium, high, critical)
- Any proposed mitigation or fix

## What to Expect

| Stage | Target |
|---|---|
| Initial acknowledgement | Within 5 business days |
| Triage and severity assessment | Within 14 business days |
| Fix or mitigation in `main` | Depends on severity — critical issues prioritized |
| Public disclosure | After a fix ships, coordinated with the reporter |

We follow a coordinated-disclosure model. If you wish to publish a write-up after the fix lands, we are happy to credit you and link to your post.

## Scope

In scope:

- The engine and dashboard code in this repository (`src/`, `engine.cjs`)
- The Electron desktop launcher (`electron/`)
- Migration scripts and bootstrap SQL (`scripts/migrations/`, `migrations/`)
- LLM adapters and tool implementations
- Bundled assets that ship in releases

Out of scope:

- Vulnerabilities in upstream dependencies (please report to the upstream project; we will track and pull fixes)
- Issues that require physical access to a user's machine
- Brute-force or rate-limit issues against locally-bound endpoints (the engine binds to `127.0.0.1` by default; exposing it to a network is the operator's responsibility)
- Social-engineering or phishing scenarios that target end users without an underlying engine flaw

## Hardening Recommendations for Operators

If you run the engine on a multi-user machine or expose its dashboard beyond `127.0.0.1`:

- Front the dashboard with a reverse proxy that handles authentication and TLS
- Treat `data/` as sensitive — the SQLite databases contain memory contents and may include personal information
- Review allowlists in `config/config.json` before enabling autonomy phases that fetch external resources

## Security-Relevant Configuration

The engine ships with safe defaults. Notable knobs:

- Autonomy is disabled by default; enabling it grants the engine permission to write self-directed memory entries and (optionally) fetch external resources
- External fetch is gated by an explicit allowlist in config
- Tool execution uses the host's user permissions — sandbox the process if you treat agent output as untrusted

Thanks for helping keep Constellation Engine users safe.
