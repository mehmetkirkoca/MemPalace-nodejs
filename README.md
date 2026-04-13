# MemPalace

Persistent, searchable memory for the AI assistants you already use. MemPalace gives Claude, Cursor, or any MCP-compatible AI a long-term memory that persists across sessions — without summarizing, without losing context, without changing how you work.

Think of it as external long-term memory: your AI keeps working exactly the same way, but now it remembers.

---

## Why MemPalace?

Most AI assistants forget everything when a conversation ends. MemPalace fixes that by giving Claude (or any MCP-compatible AI) a persistent, searchable memory — stored on your machine, organized semantically.

- **Remembers decisions** — "why did we choose this architecture?"
- **Tracks preferences** — "always respond in English, concise"
- **Logs milestones** — "the auth bug was finally fixed on 2026-04-03"
- **Connects facts** — knowledge graph links people, projects, and events
- **Cross-domain tunnels** — finds unexpected connections between different memory palaces

### Benchmark Results

| Benchmark | R@5 | R@10 | NDCG@10 | Questions |
|-----------|-----|------|---------|-----------|
| **LongMemEval** (Microsoft) | **96.0%** | **98.4%** | **89.1%** | 500 |

Retrieval runs fully locally (no extra API calls for search). Verified 2026-04-11.

**MemPalace achieves the highest published LongMemEval score among systems that do not use an LLM for retrieval or reranking.**

---

## Getting Started

### 1. Start the services

```bash
docker compose up -d
```

Starts MemPalace and its vector database. That's it.

### 2. Connect Claude Code

```bash
claude mcp add --transport http mempalace http://localhost:3100/mcp
```

Or open this repo in Claude Code — the included `.mcp.json` auto-prompts for approval.

### 3. Start a conversation

Claude will now remember things across sessions. Zero extra configuration — the MCP server ships with a built-in memory protocol that activates automatically:

- On wake-up, Claude auto-selects the right memory palace and loads top memories
- Before answering factual questions, Claude queries memory instead of guessing
- When you share new information, Claude routes it to the right palace/room/hall automatically
- At session end, Claude writes to its own diary

You can also tell Claude explicitly:

> "Remember that we decided to use Qdrant over ChromaDB because it supports Docker natively."

MemPalace figures out where to store it.

---

## How Memory is Organized

A 4-layer hierarchy — modeled after the real memory palace technique:

```
Palace  →  Room  →  Hall  →  Drawer
──────     ─────    ────      ──────
code       docker   facts     individual memory
research   health   events    (verbatim text)
personal   sprint   discover.
```

| Layer | What it is |
|-------|------------|
| **Palace** | A separate memory space for a domain (code, research, personal) |
| **Room** | A named topic within a palace (e.g. `docker-setup`, `auth-flow`) |
| **Hall** | Memory type — facts, events, preferences, discoveries, advice |
| **Drawer** | One verbatim memory (text + metadata + embedding) |

**Content is never summarized.** Every drawer stores the original words. The search model finds the right drawer — no information is thrown away.

### Embedding-Based Auto-Routing

`mempalace_save` needs no wing, room, or hall from you. It:

1. Embeds the content with `all-MiniLM-L6-v2`
2. Selects the palace via cosine similarity against each palace's `scope` vector
3. Selects the hall via cosine similarity against 5 pre-embedded hall descriptions
4. Derives the room slug from content keywords
5. Deduplicates before storing

If content doesn't match any existing palace well (similarity < 0.35), it suggests creating a new one.

### Cross-Palace Tunnels

The same room slug appearing in two or more palaces creates a **tunnel** — a cross-domain connection. `mempalace_find_tunnels` reveals these bridges; `mempalace_traverse` walks them.

This mirrors the Default Mode Network in the human brain — the system that connects knowledge across domains.

---

## Memory Layers (L0–L3)

| Layer | Tool | What it loads | When |
|-------|------|---------------|------|
| **L0** Identity | `mempalace_wake_up` | Who you are, rules, preferences | Every session start |
| **L1** Essential | `mempalace_wake_up` | Top 15 highest-importance memories | Every session start |
| **L2** On-demand | `mempalace_recall` | All drawers in a specific room | When a topic comes up |
| **L3** Semantic | `mempalace_search` | Nearest matches by meaning | When searching |

---

## MCP Tools

22 tools available to Claude once connected:

| Category | Tools |
|----------|-------|
| **Session** | `mempalace_wake_up`, `mempalace_recall` |
| **Setup** | `mempalace_setup`, `mempalace_palace_create`, `mempalace_list_identities` |
| **Storage** | `mempalace_save`, `mempalace_delete_drawer` |
| **Search** | `mempalace_search`, `mempalace_status` |
| **Browse** | `mempalace_list_rooms`, `mempalace_list_wings`, `mempalace_get_taxonomy` |
| **Knowledge Graph** | `mempalace_kg_add`, `mempalace_kg_query`, `mempalace_kg_invalidate`, `mempalace_kg_timeline`, `mempalace_kg_stats` |
| **Graph Navigation** | `mempalace_traverse`, `mempalace_find_tunnels`, `mempalace_graph_stats` |
| **Diary** | `mempalace_diary_write`, `mempalace_diary_read` |

---

## Multi-Palace Setup

Each palace is a separate Qdrant collection with its own routing config. The right palace is auto-selected based on content embeddings.

Create a palace with a scope description — MemPalace embeds it and uses cosine similarity to route content automatically:

```
mempalace_palace_create({
  name: "code_palace",
  scope: "Programming, software architecture, debugging, code decisions, technical documentation",
  description: "All code and engineering knowledge"
})
```

Default palace (`personality_memory_palace`) stores personal identity, preferences, and general notes — used as fallback when no other palace matches.

---

## Knowledge Graph

Beyond vector search, MemPalace maintains a temporal knowledge graph (SQLite):

```
mempalace_kg_add({ subject: "Alice", predicate: "works_on", object: "AuthService" })
mempalace_kg_query({ entity: "Alice" })
mempalace_kg_invalidate({ subject: "Alice", predicate: "works_on", object: "AuthService" })
```

Facts have a time window (`valid_from` / `valid_to`). `mempalace_kg_timeline` gives a chronological view of how things changed.

---

## CLI Usage

Mine an existing project folder into memory:

```bash
docker compose run --rm mempalace-cli bin/mempalace.js mine ~/projects/my_app
docker compose run --rm mempalace-cli bin/mempalace.js search "authentication flow"
docker compose run --rm mempalace-cli bin/mempalace.js status
```

---

## Development

```bash
git clone https://github.com/your-org/mempalace.git
cd mempalace
npm install
docker compose up -d
npm test
```

Live-reload during development:

```bash
docker compose --profile dev up
```

---

## Architecture

| Component | Role |
|-----------|------|
| **Qdrant** | Vector store — semantic search, embeddings, cosine similarity |
| **Kuzu** | Graph DB (embedded) — palace/room/hall topology, cross-palace tunnels |
| **SQLite** | Temporal knowledge graph — entity facts with time windows |
| **all-MiniLM-L6-v2** | Local embedding model (384-dim, L2-normalized) — zero API calls |

---

## Benchmarks

Full reproduction guide and raw result files: [`benchmarks/`](benchmarks/)

---

## Credits

Node.js port of the original [MemPalace](https://github.com/aya-thekeeper/mempal) by [bensig](https://github.com/bensig) and [milla-jovovich](https://github.com/milla-jovovich). Core architecture, verbatim-first storage, and benchmark methodology belong to the original authors.

## License

MIT — see [LICENSE](LICENSE).
