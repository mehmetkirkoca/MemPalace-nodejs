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

### Benchmark Results

| Benchmark | Recall@10 | Questions |
|-----------|-----------|-----------|
| **LongMemEval** (Microsoft) | **98.4%** | 500 |
| **LoCoMo** (Snap Research) | **100%** | 1,986 |
| **ConvoMem** (Salesforce) | **92.0%** | 500 |

Highest published recall score for a fully local AI memory system.

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

Claude will now remember things across sessions. On each wake-up it loads your memory palace and queries it before responding. You can also tell it explicitly:

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

20 tools available to Claude once connected:

| What you can do | Tools |
|-----------------|-------|
| Search memories | `mempalace_search`, `mempalace_status` |
| Store & remove | `mempalace_add_drawer`, `mempalace_delete_drawer` |
| Smart filing | `mempalace_guide`, `mempalace_check_duplicate` |
| Knowledge graph | `mempalace_kg_add`, `mempalace_kg_query`, `mempalace_kg_timeline` |
| Browse structure | `mempalace_list_wings`, `mempalace_list_rooms`, `mempalace_get_taxonomy` |
| Agent diary | `mempalace_diary_write`, `mempalace_diary_read` |
| Navigation | `mempalace_traverse`, `mempalace_find_tunnels` |

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

Node.js port of [MemPalace](https://github.com/milla-jovovich/mempalace), originally created by [bensig](https://github.com/bensig) and [milla-jovovich](https://github.com/milla-jovovich). All credit for the core architecture, AAAK memory dialect, and benchmark methodology belongs to the original authors.

## License

MIT — see [LICENSE](LICENSE).
