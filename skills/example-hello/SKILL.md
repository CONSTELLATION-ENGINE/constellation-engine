---
name: example-hello
description: Reference example showing the SKILL.md format. Returns a short greeting and a description of how external skills work in this engine. Useful as a smoke test to verify that the skill loader picked up the bundled skills directory.
keywords: [example, hello, demo, skill-template]
user-invocable: true
disable-model-invocation: false
requires:
  env: []
  bins: []
  files: []
---

# Example Skill — Hello

Hello from the bundled `example-hello` skill.

## What just happened

You (or the model) invoked the tool named `skill_example_hello`. The engine
loaded the YAML frontmatter at the top of this `SKILL.md` and registered a
matching tool. When the tool was called, the engine read this Markdown body
and returned it as the tool result.

## How to add your own skill

1. Create a directory under either:
   - `~/.constellation/skills/<your-skill-name>/`  (per-user)
   - `<engine-root>/skills/<your-skill-name>/`     (bundled with the repo)
2. Add a `SKILL.md` with frontmatter:
   - `name`: lowercase, `[a-z0-9_-]`, max 48 chars
   - `description`: one-paragraph summary the model uses to decide when to
     invoke the skill (the body is only fetched once invoked — progressive
     disclosure)
   - `keywords` (optional): help `tool_search` surface the skill
   - `requires` (optional): pre-flight gates (`env`, `bins`, `files`); skills
     whose requirements are unmet are skipped at boot
3. Restart the engine. The skill will appear as `skill_<your_skill_name>`.

## Notes

- Phase 1 ships Markdown-only skills. Bundled scripts and progressive file
  reads are planned for a later phase.
- User skills override bundled skills with the same `name`.
