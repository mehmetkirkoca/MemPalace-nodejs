# MemPalace

Give your AI a long-term memory. MemPalace stores everything you tell it, organizes it automatically, and makes it findable — across sessions, projects, and time.

No API key required. Runs entirely on your machine.

---

## Why MemPalace?

Most AI assistants forget everything the moment a conversation ends. MemPalace fixes that by giving Claude (or any MCP-compatible AI) a persistent, searchable memory palace — stored locally, organized semantically.

- **Remembers decisions** — "why did we choose this architecture?"
- **Tracks preferences** — "I always use tabs, not spaces"
- **Logs milestones** — "the auth bug was finally fixed on 2026-04-03"
- **Connects facts** — knowledge graph links people, projects, and events

### Benchmark Results (Node.js Port — Qdrant + all-MiniLM-L6-v2)

| Benchmark | R@5 | R@10 | NDCG@10 | Questions |
|-----------|-----|------|---------|-----------|
| **LongMemEval** (Microsoft) | **96.0%** | **98.4%** | **89.1%** | 500 |

Per question-type breakdown (R@10):

| Type | Recall@10 |
|------|-----------|
| knowledge-update | 100% |
| multi-session | 100% |
| temporal-reasoning | 98.5% |
| single-session-preference | 96.7% |
| single-session-assistant | 96.4% |
| single-session-user | 95.7% |

Verified 2026-04-11. No API key. Fully local. No GPU required.

---

## Getting Started

### 1. Start the services

```bash
docker compose up -d
```

This starts MemPalace and its vector database. That's it.

### 2. Connect Claude Code

```bash
claude mcp add --transport http mempalace http://localhost:3100/mcp
```

Or just open this repo in Claude Code — the included `.mcp.json` will prompt for approval automatically.

### 3. Start a conversation

Claude will now remember things across sessions. **Zero configuration required** — the MCP server ships with a built-in memory protocol that activates automatically on connection:

- On wake-up, Claude loads the palace overview
- Before responding to factual questions, Claude queries memory first instead of guessing
- When you share new information, Claude files it into the right wing/room
- At session end, Claude can write to its own diary

This works **without any CLAUDE.md, system prompt edits, or extra user instructions** — the protocol is delivered via the MCP `initialize` response and shown to the model as part of its session context.

You can also tell Claude explicitly:

> "Remember that we decided to use Qdrant over ChromaDB because it supports Docker natively."

MemPalace will figure out where to store it.

---

## How Memory is Organized

Everything is stored in a three-level hierarchy:

```
Wing  →  Room  →  Hall
────     ─────    ────
code     docker   facts
user     health   events
team     sprint   preferences
```

- **Wings** are broad domains (code, personal, team, hardware, AI research)
- **Rooms** are named topics within a wing (e.g. `docker-setup`, `gpu-pricing`)
- **Halls** are memory types (facts, events, discoveries, preferences, advice)

### Smart Filing with `mempalace_guide`

Not sure where something belongs? Ask the guide tool before storing:

```
mempalace_guide("we decided to drop ChromaDB and use Qdrant")
→ wing: wing_code | room: qdrant-chromadb | hall: hall_facts | importance: 3
```

It runs three checks: content-type detection, existing room matching, and your project config.

---

## MCP Tools

23 tools available to Claude once connected:

| What you can do | Tools |
|-----------------|-------|
| **Session start** | `mempalace_wake_up`, `mempalace_recall` |
| **Setup & identity** | `mempalace_setup`, `mempalace_list_identities` |
| Search memories | `mempalace_search`, `mempalace_status` |
| Store & remove | `mempalace_add_drawer`, `mempalace_delete_drawer` |
| Smart filing | `mempalace_guide`, `mempalace_check_duplicate` |
| Knowledge graph | `mempalace_kg_add`, `mempalace_kg_query`, `mempalace_kg_timeline` |
| Browse structure | `mempalace_list_wings`, `mempalace_list_rooms`, `mempalace_get_taxonomy` |
| Agent diary | `mempalace_diary_write`, `mempalace_diary_read` |
| Navigation | `mempalace_traverse`, `mempalace_find_tunnels` |

### Memory Layers (L0–L3)

MemPalace implements a layered memory architecture that loads context efficiently without filling the context window:

| Layer | Tool | What it loads | When |
|-------|------|---------------|------|
| **L0** Identity | `mempalace_wake_up` | Who you are, your rules & preferences | Every session start |
| **L1** Essential | `mempalace_wake_up` | Top 15 highest-importance memories | Every session start |
| **L2** On-demand | `mempalace_recall` | All drawers in a specific room | When a topic comes up |
| **L3** Semantic | `mempalace_search` | Nearest matches by meaning | When searching |

### Multi-Identity / Agent Modes

Each identity can have its own memory palace (Qdrant collection):

```
identities/
├── default.txt    ← personality_memory_palace (fallback)
├── code.txt       ← code_drawers (auto-selected for dev topics)
└── research.txt   ← research_drawers (auto-selected for AI topics)
```

Claude auto-selects the right identity from the conversation context. Run once to set up your personality palace:

```
mempalace_setup({ name: "...", preferences: [...], rules: [...] })
```

---

## Using the CLI

Mine an existing project folder into memory:

```bash
docker compose run --rm mempalace-cli bin/mempalace.js mine ~/projects/my_app
docker compose run --rm mempalace-cli bin/mempalace.js search "authentication flow"
docker compose run --rm mempalace-cli bin/mempalace.js status
```

---

## Development

```bash
git clone https://github.com/mehmetkirkoca/MemPalace-nodejs.git
cd MemPalace-nodejs
npm install
docker compose up -d
npm test
```

For live-reload during development:

```bash
docker compose --profile dev up
```

---

## Credits

Node.js port of [MemPalace](https://github.com/milla-jovovich/mempalace), originally created by [bensig](https://github.com/bensig) and [milla-jovovich](https://github.com/milla-jovovich). All credit for the core architecture and benchmark methodology belongs to the original authors. This port removes the experimental AAAK compression dialect since it regressed search recall (84.2% vs 96.6% in raw mode); the verbatim-first storage and knowledge graph remain unchanged.

## License

MIT — see [LICENSE](LICENSE).
