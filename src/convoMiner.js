/**
 * convoMiner.js — Mine conversations into the palace.
 *
 * Ingests chat exports (Claude Code, ChatGPT, Slack, plain text transcripts).
 * Normalizes format, chunks by exchange pair (Q+A = one unit), files to palace.
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { normalize } from './normalize.js';
import { VectorStore } from './vectorStore.js';
import { extractMemories } from './generalExtractor.js';
import { getConfig } from './config.js';

// File types that might contain conversations
const CONVO_EXTENSIONS = new Set(['.txt', '.md', '.json', '.jsonl']);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'env', 'dist', 'build', '.next', '.mempalace', 'tool-results', 'memory',
]);

const MIN_CHUNK_SIZE = 30;

// =============================================================================
// CHUNKING — exchange pairs for conversations
// =============================================================================

/**
 * Chunk by exchange pair: one > turn + AI response = one unit.
 * Falls back to paragraph chunking if no > markers.
 */
export function chunkExchanges(content) {
  const lines = content.split('\n');
  const quoteLines = lines.filter(line => line.trim().startsWith('>')).length;

  if (quoteLines >= 3) {
    return _chunkByExchange(lines);
  }
  return _chunkByParagraph(content);
}

function _chunkByExchange(lines) {
  const chunks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('>')) {
      const userTurn = line.trim();
      i++;

      const aiLines = [];
      while (i < lines.length) {
        const nextLine = lines[i];
        if (nextLine.trim().startsWith('>') || nextLine.trim().startsWith('---')) {
          break;
        }
        if (nextLine.trim()) {
          aiLines.push(nextLine.trim());
        }
        i++;
      }

      const aiResponse = aiLines.slice(0, 8).join(' ');
      const chunkContent = aiResponse ? `${userTurn}\n${aiResponse}` : userTurn;

      if (chunkContent.trim().length > MIN_CHUNK_SIZE) {
        chunks.push({
          content: chunkContent,
          chunkIndex: chunks.length,
        });
      }
    } else {
      i++;
    }
  }

  return chunks;
}

function _chunkByParagraph(content) {
  const chunks = [];
  const paragraphs = content.split('\n\n').map(p => p.trim()).filter(Boolean);

  // If no paragraph breaks and long content, chunk by line groups
  if (paragraphs.length <= 1 && content.split('\n').length > 20) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim();
      if (group.length > MIN_CHUNK_SIZE) {
        chunks.push({ content: group, chunkIndex: chunks.length });
      }
    }
    return chunks;
  }

  for (const para of paragraphs) {
    if (para.length > MIN_CHUNK_SIZE) {
      chunks.push({ content: para, chunkIndex: chunks.length });
    }
  }

  return chunks;
}

// =============================================================================
// ROOM DETECTION — topic-based for conversations
// =============================================================================

const TOPIC_KEYWORDS = {
  technical: [
    'code', 'python', 'function', 'bug', 'error', 'api',
    'database', 'server', 'deploy', 'git', 'test', 'debug', 'refactor',
  ],
  architecture: [
    'architecture', 'design', 'pattern', 'structure', 'schema',
    'interface', 'module', 'component', 'service', 'layer',
  ],
  planning: [
    'plan', 'roadmap', 'milestone', 'deadline', 'priority',
    'sprint', 'backlog', 'scope', 'requirement', 'spec',
  ],
  decisions: [
    'decided', 'chose', 'picked', 'switched', 'migrated',
    'replaced', 'trade-off', 'alternative', 'option', 'approach',
  ],
  problems: [
    'problem', 'issue', 'broken', 'failed', 'crash',
    'stuck', 'workaround', 'fix', 'solved', 'resolved',
  ],
};

/**
 * Score conversation content against topic keywords.
 */
export function detectConvoRoom(content) {
  const contentLower = content.slice(0, 3000).toLowerCase();
  const scores = {};

  for (const [room, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const score = keywords.filter(kw => contentLower.includes(kw)).length;
    if (score > 0) {
      scores[room] = score;
    }
  }

  if (Object.keys(scores).length > 0) {
    return Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a)[0];
  }
  return 'general';
}

// =============================================================================
// SCAN FOR CONVERSATION FILES
// =============================================================================

function scanConvos(convoDir) {
  const convoPath = path.resolve(convoDir);
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name));
        }
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.meta.json')) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (CONVO_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }

  walk(convoPath);
  return files;
}

// =============================================================================
// MINE CONVERSATIONS
// =============================================================================

/**
 * Mine a directory of conversation files into the palace.
 *
 * @param {string} convoDir - Directory containing conversation files
 * @param {string} wing - Wing name for the palace
 * @param {object} options
 * @param {number} [options.limit=0] - Max files to process (0 = all)
 * @param {boolean} [options.dryRun=false] - If true, don't store anything
 * @param {string} [options.extractMode='exchange'] - 'exchange' or 'general'
 * @param {string} [options.agent='mempalace'] - Agent name for metadata
 */
export async function mineConvos(convoDir, wing, options = {}) {
  const {
    limit = 0,
    dryRun = false,
    extractMode = 'exchange',
    agent = 'mempalace',
  } = options;

  const convoPath = path.resolve(convoDir);
  const effectiveWing = wing || path.basename(convoPath).toLowerCase().replace(/[\s-]/g, '_');

  let files = scanConvos(convoDir);
  if (limit > 0) {
    files = files.slice(0, limit);
  }

  const config = getConfig();
  const store = dryRun ? null : new VectorStore(config);

  if (store) {
    await store.ensureCollection();
  }

  const results = {
    filesProcessed: 0,
    filesSkipped: 0,
    drawersAdded: 0,
    roomCounts: {},
  };

  for (const filepath of files) {
    const sourceFile = filepath;

    // Skip if already filed
    if (!dryRun && store) {
      try {
        const existing = await store.search(sourceFile, { limit: 1, filter: { source_file: sourceFile } });
        if (existing && existing.length > 0) {
          results.filesSkipped++;
          continue;
        }
      } catch {
        // Continue if check fails
      }
    }

    // Normalize format
    let content;
    try {
      content = normalize(filepath);
    } catch {
      continue;
    }

    if (!content || content.trim().length < MIN_CHUNK_SIZE) {
      continue;
    }

    // Chunk
    let chunks;
    if (extractMode === 'general') {
      chunks = extractMemories(content);
    } else {
      chunks = chunkExchanges(content);
    }

    if (!chunks || chunks.length === 0) {
      continue;
    }

    // Detect room
    const room = extractMode !== 'general' ? detectConvoRoom(content) : null;

    results.filesProcessed++;

    if (dryRun) {
      results.drawersAdded += chunks.length;
      if (extractMode === 'general') {
        for (const c of chunks) {
          const memType = c.memoryType || 'general';
          results.roomCounts[memType] = (results.roomCounts[memType] || 0) + 1;
        }
      } else {
        results.roomCounts[room] = (results.roomCounts[room] || 0) + 1;
      }
      continue;
    }

    // File each chunk
    let drawersAdded = 0;
    if (extractMode !== 'general') {
      results.roomCounts[room] = (results.roomCounts[room] || 0) + 1;
    }

    for (const chunk of chunks) {
      const chunkRoom = extractMode === 'general'
        ? (chunk.memoryType || room || 'general')
        : room;

      if (extractMode === 'general') {
        results.roomCounts[chunkRoom] = (results.roomCounts[chunkRoom] || 0) + 1;
      }

      const hash = crypto.createHash('md5')
        .update(sourceFile + String(chunk.chunkIndex))
        .digest('hex')
        .slice(0, 16);
      const drawerId = `drawer_${effectiveWing}_${chunkRoom}_${hash}`;

      try {
        await store.add({
          id: drawerId,
          content: chunk.content,
          metadata: {
            wing: effectiveWing,
            room: chunkRoom,
            source_file: sourceFile,
            chunk_index: chunk.chunkIndex,
            added_by: agent,
            filed_at: new Date().toISOString(),
            ingest_mode: 'convos',
            extract_mode: extractMode,
          },
        });
        drawersAdded++;
      } catch (err) {
        if (!String(err).toLowerCase().includes('already exists')) {
          throw err;
        }
      }
    }

    results.drawersAdded += drawersAdded;
  }

  return results;
}

export { TOPIC_KEYWORDS, CONVO_EXTENSIONS, SKIP_DIRS, MIN_CHUNK_SIZE, scanConvos };
