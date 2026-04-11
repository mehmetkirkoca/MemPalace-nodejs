# Node.js Port vs. Original Python Repo — Feature Comparison

Original repo: [milla-jovovich/mempalace](https://github.com/milla-jovovich/mempalace)
This port: [mehmetkirkoca/MemPalace-nodejs](https://github.com/mehmetkirkoca/MemPalace-nodejs)

---

## Intentionally Removed

| Feature | Reason |
|---------|--------|
| AAAK compression dialect | Regressed recall from 96.6% → 84.2%; verbatim-first storage is superior |
| ChromaDB | Replaced with Qdrant — Docker-native, no Python runtime dependency |

---

## Missing Features

### Mining Pipeline
The original has three distinct mining modes:
- `mine_project` — code and documentation files
- `mine_conversations` — parses Claude conversation export JSON, auto-classifies entries
- `mine_general` — general auto-classification with hall detection via `generalExtractor.py`

This port has a basic `mine` CLI command but does not auto-detect hall type and lacks `generalExtractor.js`.

### Specialist Agent Configs (`.agents/plugins/`)
Each agent gets its own config file defining focus areas, AAAK diary format, and room scope. This port has a single shared `diary_write` / `diary_read` with no per-agent configuration.

### Contradiction Detection
The original includes a utility that scans the knowledge graph for conflicting facts. This port only supports manual invalidation via `mempalace_kg_invalidate`.

### Layered Memory Stack (L0–L3)
The original uses a four-layer recall hierarchy:
- **L0** — identity (always loaded)
- **L1** — critical facts (loaded at session start)
- **L2** — room-based recall (loaded on navigation)
- **L3** — semantic search (on demand)

This port has no layered structure — all retrieval goes through flat semantic search.

### Agent Plugin Integrations
`.claude-plugin` and `.codex-plugin` directories support Claude marketplace and Codex integration. This port only provides `.mcp.json` for Claude Code via HTTP transport.

### CI/CD & Pre-commit Hooks
The original has `.github/` workflows and `.pre-commit-config.yaml`. This port has neither.

### `mempalace.yaml` Enforcement in `add_drawer`
The original config file guides both categorization and storage. In this port, `mempalace.yaml` is only read by `mempalace_guide` — `add_drawer` does not enforce it.

---

## Added in This Port (not in original)

| Feature | Description |
|---------|-------------|
| `mempalace_guide` tool | 3-strategy auto-categorization (content-type patterns, taxonomy match, yaml lookup) before filing |
| Qdrant backend | Replaces ChromaDB with a production-grade vector DB that runs natively in Docker |
| HTTP MCP transport | StreamableHTTP on port 3100, compatible with Claude Code `--transport http` |

---

## Suggested Implementation Priority

1. **`mine_conversations`** — bulk import from Claude conversation exports (practical for existing users)
2. **L1 critical facts** — auto-load key facts at session start, improving cold-start quality
3. **`mempalace.yaml` enforcement in `add_drawer`** — ensure stored memories follow project config
