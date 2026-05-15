# Contributing to Constellation Engine

Thanks for your interest in improving the engine. This guide covers the development workflow, code standards, and how to submit changes.

## Getting Started

1. **Fork and clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/constellation-engine-oss.git
   cd constellation-engine-oss
   npm install
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b fix/short-description
   ```

3. **Configure your environment**
   ```bash
   cp config.example.json config/config.json
   # Edit config/config.json to set your provider keys, then:
   npm start
   ```

   The engine will run schema migrations on first boot and create `data/`, `engine-output/`, and `config/` as needed.

## Code Standards

### Style

- **JavaScript**: Node.js CommonJS + async/await
- **Indentation**: 2 spaces
- **Naming**: `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants, `snake_case` for SQL
- **Imports**: no circular dependencies; prefer explicit imports

### SQL and Migrations

- **Schema changes**: add a new file in `scripts/migrations/NNNN-description.sql`
- **Idempotency**: `CREATE` must use `IF NOT EXISTS`; `ALTER` must check existence
- **Naming**: tables are `snake_case_plural`, columns are `snake_case`
- **No raw IDs**: use `node_id` slugs or auto-generated primary keys; never embed UUIDs in code

Bootstrap schema for fresh installs lives in `migrations/oss-bootstrap.sql`. Incremental migrations applied on every boot live in `scripts/migrations/`.

Example incremental migration:
```sql
-- 0042-add-session-ttl.sql
ALTER TABLE sessions ADD COLUMN ttl_seconds INTEGER DEFAULT 3600;
CREATE INDEX IF NOT EXISTS idx_sessions_ttl ON sessions(ttl_seconds);
```

### Testing

Run the suite with:
```bash
npm test
```

Test files live next to source as `*.test.js` and run via Node's built-in test runner.

Write tests for:
- New API endpoints
- Adapter implementations
- Memory graph operations
- Critical utility functions

### Pre-publish Checks

Before opening a PR that touches packaging or release artifacts:
```bash
npm run prepublish-check
```

This runs `scripts/oss-sync.sh --check` to verify license headers, path leaks, and other release invariants.

## Submitting a Pull Request

1. **Keep commits focused** — one logical change per commit
2. **Write clear commit messages**
   ```
   Add session TTL column to conversations table

   - Idempotent migration (IF NOT EXISTS)
   - Index on ttl_seconds for efficient cleanup
   - Update conversation-layer auto-purge to check TTL
   ```
3. **Test your changes**
   - `npm test`
   - `npm run prepublish-check` if release-relevant
   - Boot the engine on a fresh `data/` directory to confirm migrations apply cleanly
4. **Push and open the PR**
   ```bash
   git push origin fix/short-description
   ```
   Explain in the description: what problem you are solving, how the solution works, any migrations or breaking changes, and manual testing steps.
5. **Respond to review feedback** — we will read and request changes as needed

## Architecture Notes

### Memory Graph

The core data structure is a directed graph of **nodes** and **edges**:

- **Nodes** represent concepts, debriefs, identity snapshots, and external fetches
- **Edges** represent relationships: causality, semantic similarity, temporal succession
- **Bi-temporal columns** (`valid_from`, `valid_to`) track historical versions
- Queries use multi-pass semantic routing (embeddings + keyword fallback)

Avoid:
- Mutating `node_type` after creation (use versioning instead)
- Updating `valid_from` or `valid_to` after insertion (use `superseded_by`)
- Cycles between non-temporal edge kinds

### Autonomy

The engine ships with autonomy disabled by default. Behavior is gated by environment variables and runtime config; new self-directed actions must default to OFF, log every action with context, and never auto-execute external shell commands.

When adding autonomy features:
1. Default OFF
2. Gate writes behind a kill-switch the user can flip from the dashboard
3. Log every self-directed action to the engine output
4. Never auto-execute external commands without explicit user authorization

### Adding an LLM Adapter

Create a new file `src/llm-adapters/my-provider.js`:

```javascript
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = {
  name: 'my-provider',

  async complete({ prompt, context, config }) {
    // Implementation must return { text, usage: { input_tokens, output_tokens } }
  },

  async embed({ text, config }) {
    // Return array of floats (embedding vector)
  }
};
```

Register it in `config.example.json` under `llm.providers`.

## Debugging

- **Engine logs**: `engine-output/` (rotated JSONL files)
- **Dashboard dev tools**: open the Settings page in your browser, press F12
- **Memory graph inspection**: dashboard "Graph" tab or any SQLite browser pointed at `data/star-map.db`

## Reporting Issues

Found a bug? Please include:
- Exact steps to reproduce
- Expected vs. actual behavior
- Environment (Node.js version, OS, provider config)
- Relevant entries from `engine-output/` and the browser console
- A minimal reproducible example if possible

## Questions?

- Check [existing issues](https://github.com/devinrory-collab/constellation-engine/issues) first
- Open a [discussion](https://github.com/devinrory-collab/constellation-engine/discussions) for design questions

Thanks for contributing.
