# MemPalace

AI memory system — store everything verbatim, make it findable through structure.

### Benchmark Results (Node.js Port — 2026-04-08)

| Benchmark | Questions | Recall@5 | Recall@10 | Time |
|-----------|-----------|----------|-----------|------|
| **LongMemEval** (Microsoft) | 500 | **96.0%** | **98.4%** | 36 min |
| **LoCoMo** (Snap Research) | 1,986 | — | **100%** | 3.6 min |
| **ConvoMem** (Salesforce) | 500 | — | **92.0%** | 16 min |

**LongMemEval Per-Category Breakdown:**

| Category | R@10 | Questions |
|----------|------|-----------|
| knowledge-update | 100% | 78 |
| multi-session | 100% | 133 |
| temporal-reasoning | 98.5% | 133 |
| single-session-preference | 96.7% | 30 |
| single-session-assistant | 96.4% | 56 |
| single-session-user | 95.7% | 70 |

Fully local, no API key required, $0 cost. Benchmark runners in `benchmarks/`.

---

## Install

```bash
npm install mempalace
```

Requires Node.js >= 20.

## Quick Start

```bash
# Initialize a palace from a project folder
mempalace init ~/projects/my_app

# Mine files into memory
mempalace mine ~/projects/my_app

# Search your memories
mempalace search "why did we choose this approach"

# Import AI conversations
mempalace mine ~/claude-sessions/ --mode convos
```

## Usage as Library

```js
import { searchMemories, getConfig, VectorStore } from 'mempalace';

const config = getConfig();
const results = await searchMemories('authentication flow', { topK: 5 });
```

## MCP Server

MemPalace ships with an MCP server for Claude Desktop and other MCP clients:

```bash
npm run start:mcp
```

See [examples/mcp_setup.md](examples/mcp_setup.md) for configuration details.

## Project Structure

```
src/            — core modules
hooks/          — Claude Code auto-save hooks
examples/       — usage examples and setup guides
benchmarks/     — benchmark runners and results
assets/         — logo and brand
tests/          — test suite
```

## Docker

Qdrant vector database runs as a Docker service:

```bash
docker compose up -d qdrant
```

## Running Benchmarks

```bash
# LongMemEval (500 questions, ~36 min)
curl -fsSL -o /tmp/longmemeval.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
node benchmarks/longmemevalBench.js /tmp/longmemeval.json

# LoCoMo (1986 questions, ~4 min)
git clone https://github.com/snap-research/locomo.git /tmp/locomo
node benchmarks/locomoBench.js /tmp/locomo/data/locomo10.json

# ConvoMem (auto-downloads from HuggingFace, ~16 min)
node benchmarks/convomemBench.js --category all --limit 100

# Quick test (5 questions)
node benchmarks/longmemevalBench.js /tmp/longmemeval.json --limit 5
```

## Development

```bash
git clone <repo-url>
cd mempalace
npm install
docker compose up -d qdrant
npm test
```

## Credits

This project is a Node.js port of [MemPalace](https://github.com/igorls/mempalace) originally created by [milla-jovovich](https://github.com/milla-jovovich) and [igorls](https://github.com/igorls). The original Python implementation achieved 96.6% R@5 on LongMemEval — the highest published score for any AI memory system without API keys.

**Key changes in this port:**
- Python → Node.js (ESM)
- ChromaDB (embedded) → Qdrant (Docker service)
- Built-in embedding → @huggingface/transformers (same all-MiniLM-L6-v2 model)
- argparse → Commander.js
- pytest → Vitest

All credit for the architecture, algorithms, AAAK dialect, and benchmark methodology belongs to the original authors.

## License

MIT — see [LICENSE](LICENSE).
