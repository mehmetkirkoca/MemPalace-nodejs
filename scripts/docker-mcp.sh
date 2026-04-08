#!/usr/bin/env bash
# MCP Server wrapper for Claude Desktop
# Usage: Point Claude Desktop's config to this script
#
# claude_desktop_config.json:
# {
#   "mcpServers": {
#     "mempalace": {
#       "command": "/path/to/memoryPlace/scripts/docker-mcp.sh"
#     }
#   }
# }

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="$(basename "$SCRIPT_DIR" | tr '[:upper:]' '[:lower:]')"

docker run --rm -i \
  --network "${PROJECT_NAME}_default" \
  -e QDRANT_URL=http://qdrant:6333 \
  -v "${PROJECT_NAME}_mempalace_data:/root/.mempalace" \
  -v "${PROJECT_NAME}_mempalace_hf_cache:/root/.cache/huggingface" \
  mempalace:latest \
  node src/mcpServer.js
