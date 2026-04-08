# MemPalace

AI memory system — store everything verbatim, make it findable through structure.

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
assets/         — logo and brand
tests/          — test suite
```

## Development

```bash
git clone <repo-url>
cd mempalace
npm install
npm test
```

## License

MIT — see [LICENSE](LICENSE).
