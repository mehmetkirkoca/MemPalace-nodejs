# MemPalace

<p align="center">
  <img src="assets/brain.png" alt="MemPalace" width="300" />
</p>

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

---

## Getting Started

### 1. Start the services

```bash
docker compose up -d
```

Starts MemPalace, Qdrant (vector store), and Neo4j (graph database). That's it.

### 2. Connect Claude Code

```bash
claude mcp add --transport http mempalace http://localhost:3100/mcp
```

Or open this repo in Claude Code — the included `.mcp.json` auto-prompts for approval.

### 3. Start a conversation

Claude will now remember things across sessions. Zero extra configuration — the MCP server ships with a built-in memory protocol that activates automatically:

- On illuminate, Claude auto-selects the right memory palace and loads top memories
- Before answering factual questions, Claude queries memory instead of guessing
- When you share new information, Claude routes it to the right palace/wing/hall/room/closet automatically
- At session end, Claude writes to its own diary

You can also tell Claude explicitly:

> "Remember that we decided to use Qdrant over ChromaDB because it supports Docker natively."

MemPalace figures out where to store it.

---

## How Memory is Organized

A 5-layer hierarchy — modeled after the real memory palace technique:

```
Palace  →  Wing  →  Hall  →  Room  →  Closet  →  Drawer
──────     ────      ────     ────      ──────      ──────
code       Backend   PHP      Laravel   Overview    individual memory
research   Health    Diet     Vitamins  Vitamin D   (verbatim text)
personal   Work      Sprint   Auth      Decisions
```

| Layer | What it is |
|-------|------------|
| **Palace** | A separate memory space for a domain (code, research, personal) |
| **Wing** | Broad domain within a palace (e.g. `Backend`, `Health`, `Personal`) |
| **Hall** | Sub-domain (e.g. `PHP`, `Nutrition`, `Sprint`) |
| **Room** | Specific topic (e.g. `Laravel`, `Vitamins`, `Auth`) |
| **Closet** | Fine-grained sub-topic (e.g. `Overview`, `Routing`, `Caching`) |
| **Drawer** | One verbatim memory (text + metadata + embedding) |

**Content is never summarized.** Every drawer stores the original words. The search model finds the right drawer — no information is thrown away.

### Saving Content

`mempalace_save` requires explicit categorization — call `mempalace_get_taxonomy` first to see the existing hierarchy, then pass the correct wing/hall/room/closet:

```
mempalace_save({
  palace: "programming_palace",
  wing: "Backend",
  hall: "PHP",
  room: "Laravel",
  closet: "Overview",
  content: "Laravel is a backend framework..."
})
```

New palaces are auto-registered in the palace registry on first save — no separate setup needed.

Deduplication runs automatically before storing (cosine similarity ≥ 0.9 triggers a duplicate warning).

### Cross-Palace Tunnels

The same room slug appearing in two or more palaces creates a **tunnel** — a cross-domain connection. `mempalace_find_tunnels` reveals these bridges; `mempalace_traverse` walks them.

This mirrors the Default Mode Network in the human brain — the system that connects knowledge across domains.

---

## Memory Layers (L0–L3)

| Layer | Tool | What it loads | When |
|-------|------|---------------|------|
| **L0** Identity | `mempalace_illuminate` | Who you are, rules, preferences | Every session start |
| **L1** Essential | `mempalace_illuminate` | Top 15 highest-importance memories | Every session start |
| **L2** On-demand | `mempalace_recall` | All drawers in a specific room | When a topic comes up |
| **L3** Semantic | `mempalace_search` | Nearest matches by meaning | When searching |

---

## MCP Tools

22 tools available to Claude once connected:

| Category | Tools |
|----------|-------|
| **Session** | `mempalace_illuminate`, `mempalace_recall` |
| **Setup** | `mempalace_setup`, `mempalace_palace_create`, `mempalace_list_identities` |
| **Storage** | `mempalace_save`, `mempalace_delete_drawer` |
| **Search** | `mempalace_search`, `mempalace_status` |
| **Browse** | `mempalace_list_rooms`, `mempalace_list_wings`, `mempalace_get_taxonomy` |
| **Knowledge Graph** | `mempalace_kg_add`, `mempalace_kg_query`, `mempalace_kg_invalidate`, `mempalace_kg_timeline`, `mempalace_kg_stats` |
| **Graph Navigation** | `mempalace_traverse`, `mempalace_find_tunnels`, `mempalace_graph_stats` |
| **Diary** | `mempalace_diary_write`, `mempalace_diary_read` |

---

## Multi-Palace Setup

Each palace is a separate Qdrant collection with its own routing config. When searching without specifying a palace, MemPalace auto-selects the best match using cosine similarity against each palace's scope vector.

Create a palace with a scope description to improve search routing:

```
mempalace_palace_create({
  name: "code_palace",
  scope: "Programming, software architecture, debugging, code decisions, technical documentation",
  description: "All code and engineering knowledge"
})
```

Default palace (`personality_memory_palace`) stores personal identity, preferences, and general notes — used as fallback when no other palace matches.

Palaces are auto-registered in the palace registry on first `mempalace_save`, so you don't need to call `mempalace_palace_create` before saving. Use `mempalace_palace_create` when you want to pre-configure routing keywords, `l0_body`, or `wing_focus`.

---

## Knowledge Graph

Beyond vector search, MemPalace maintains a temporal knowledge graph in Neo4j:

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
git clone <repo-url>
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
| **Neo4j** | Graph DB — taxonomy, topology, tunnels, and temporal knowledge graph |
| **all-MiniLM-L6-v2** | Local embedding model (384-dim, L2-normalized) — zero API calls |

---

## Credits

Node.js port of the original [MemPalace](https://github.com/aya-thekeeper/mempal) by [bensig](https://github.com/bensig) and [milla-jovovich](https://github.com/milla-jovovich). Core architecture and verbatim-first storage belong to the original authors.

## License

MIT — see [LICENSE](LICENSE).
