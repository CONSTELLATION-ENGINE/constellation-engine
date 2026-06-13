---
name: workflow-context-gate
description: Load the right operational context before high-risk or repeatable workflows such as releases, hotfixes, migrations, deploys, repository maintenance, or external publication. Use when a task has an established checklist, ledger, safety boundary, or post-action verification step.
keywords: [workflow, context, checklist, preflight, release, hotfix, deploy, migration, safety]
user-invocable: true
disable-model-invocation: false
requires:
  env: []
  bins: []
  files: []
---

# Workflow Context Gate

Use this skill before acting on workflows where the agent should carry a
specific checklist, memo, or operating discipline for the duration of the task.

The goal is focused context, not prompt bloat: keep broad identity and style in
the preamble, and load workflow-specific rules only when the task needs them.

## When to Use

Invoke this skill when the task involves one or more of these signals:

- release, version bump, packaging, publishing, or updater assets
- hotfix triage, bugfix batching, changelog ledger updates
- database migrations, schema changes, backfills, or data repair
- website deploys or public download links
- GitHub repository maintenance, pull requests, tags, or CI repair
- external-visible actions such as posting, emailing, or uploading
- destructive or hard-to-rollback operations

## Preflight

1. Name the workflow in one phrase.
2. Find the relevant checklist, memo, or registry entry.
3. Read only the files needed for this workflow.
4. State the action boundary: what will be changed, what will not be changed.
5. Run the workflow-specific preflight checks before editing or publishing.

If no checklist exists, create a short local checklist in the working notes
before acting. Do not treat an absent checklist as permission to improvise on a
high-risk task.

## During the Workflow

- Keep the loaded context narrow.
- Prefer reversible steps first.
- Verify before declaring completion.
- Do not skip safety checks to make a release, migration, or deploy pass.
- Ask for explicit authorization before any external-visible action unless the
  user already authorized that exact action in the current turn.

## After Action

Before closing the task, decide whether the action created a durable obligation:

- `CHANGELOG.md` or release notes update
- checklist or runbook update
- migration note or rollback instruction
- public download link verification
- issue, PR, or tag status update
- memory capture for future similar work

If the task fixed a reusable workflow hazard, update the checklist rather than
leaving the lesson only in chat history.

## Registry Pattern

Projects can keep an editable registry file such as
`identity/WORKFLOW-CONTEXT-GATES.example.json`:

```json
{
  "release": {
    "triggers": ["release", "tag", "package", "publish"],
    "required_context": ["RELEASE-CHECKLIST.md"],
    "preflight": ["confirm scope", "promote changelog", "build all platforms"],
    "postflight": ["verify remote assets", "verify website download links"]
  }
}
```

The registry is guidance for the agent. It does not need to be a hard runtime
gate to be useful.
