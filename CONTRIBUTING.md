# Contributing to MemPalace

Thanks for wanting to help. MemPalace is open source and we welcome contributions of all sizes — from typo fixes to new features.

## Getting Started

```bash
git clone https://github.com/milla-jovovich/mempalace.git
cd mempalace
npm install
```

## Running Tests

```bash
npm test
```

All tests must pass before submitting a PR. Tests should run without API keys or network access.

## Project Structure

```
src/                ← core modules
hooks/              ← Claude Code auto-save hooks
examples/           ← usage examples
tests/              ← test suite
assets/             ← logo + brand
```

## PR Guidelines

1. Fork the repo and create a feature branch: `git checkout -b feat/my-thing`
2. Write your code
3. Add or update tests if applicable
4. Run `npm test` — everything must pass
5. Commit with a clear message following [conventional commits](https://www.conventionalcommits.org/):
   - `feat: add Notion export format`
   - `fix: handle empty transcript files`
   - `docs: update MCP tool descriptions`
   - `bench: add LoCoMo turn-level metrics`
6. Push to your fork and open a PR against `main`

## Code Style

- **Naming**: `camelCase` for functions/variables, `PascalCase` for classes
- **JSDoc**: on all modules and public functions
- **ES Modules**: use `import`/`export` syntax (no CommonJS)
- **Dependencies**: minimize. Don't add new deps without discussion.

## Good First Issues

Check the [Issues](https://github.com/milla-jovovich/mempalace/issues) tab. Great starting points:

- **New chat formats**: Add import support for Cursor, Copilot, or other AI tool exports
- **Room detection**: Improve pattern matching in `roomDetectorLocal.js`
- **Tests**: Increase coverage — especially for `knowledgeGraph.js` and `palaceGraph.js`
- **Entity detection**: Better name disambiguation in `entityDetector.js`
- **Docs**: Improve examples, add tutorials

## Architecture Decisions

If you're planning a significant change, open an issue first to discuss the approach. Key principles:

- **Verbatim first**: Never summarize user content. Store exact words.
- **Local first**: Everything runs on the user's machine. No cloud dependencies.
- **Zero API by default**: Core features must work without any API key.
- **Palace structure matters**: Wings, halls, and rooms aren't cosmetic — they drive a 34% retrieval improvement. Respect the hierarchy.

## Community

- **Discord**: [Join us](https://discord.com/invite/ycTQQCu6kn)
- **Issues**: Bug reports and feature requests welcome
- **Discussions**: For questions and ideas

## License

MIT — your contributions will be released under the same license.
