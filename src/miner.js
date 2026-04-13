/**
 * miner.js — Files everything into the palace.
 *
 * Reads mempalace.yaml from the project directory to know the wing + rooms.
 * Routes each file to the right room based on content.
 * Stores verbatim chunks as drawers. No summaries. Ever.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import yaml from 'js-yaml';

// =============================================================================
// CONSTANTS
// =============================================================================

export const READABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.jsx', '.tsx',
  '.json', '.yaml', '.yml', '.html', '.css', '.java',
  '.go', '.rs', '.rb', '.sh', '.csv', '.sql', '.toml',
]);

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage', '.mempalace',
  '.ruff_cache', '.mypy_cache', '.pytest_cache', '.cache',
  '.tox', '.nox', '.idea', '.vscode', '.ipynb_checkpoints',
  '.eggs', 'htmlcov', 'target',
]);

export const SKIP_FILENAMES = new Set([
  'mempalace.yaml', 'mempalace.yml', 'mempal.yaml', 'mempal.yml',
  '.gitignore', 'package-lock.json',
]);

export const CHUNK_SIZE = 800;
export const CHUNK_OVERLAP = 100;
export const MIN_CHUNK_SIZE = 50;

// =============================================================================
// GITIGNORE MATCHING
// =============================================================================

/**
 * fnmatch-style pattern matching (compatible with Python fnmatch).
 * Converts glob patterns to regex: supports *, ?, [seq].
 */
function fnmatchMatch(name, pattern) {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        regex += '\\[';
      } else {
        const inside = pattern.slice(i + 1, end);
        regex += `[${inside}]`;
        i = end;
      }
    } else if ('.+^${}()|\\'.includes(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  regex += '$';
  return new RegExp(regex).test(name);
}

export class GitignoreMatcher {
  /**
   * @param {string} baseDir
   * @param {Array} rules
   */
  constructor(baseDir, rules) {
    this.baseDir = baseDir;
    this.rules = rules;
  }

  /**
   * Parse .gitignore from a directory.
   * @param {string} dirPath
   * @returns {GitignoreMatcher|null}
   */
  static fromDir(dirPath) {
    const gitignorePath = path.join(dirPath, '.gitignore');

    if (!fs.existsSync(gitignorePath) || !fs.statSync(gitignorePath).isFile()) {
      return null;
    }

    let lines;
    try {
      lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
    } catch {
      return null;
    }

    const rules = [];
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.startsWith('\\#') || line.startsWith('\\!')) {
        line = line.slice(1);
      } else if (line.startsWith('#')) {
        continue;
      }

      const negated = line.startsWith('!');
      if (negated) {
        line = line.slice(1);
      }

      const anchored = line.startsWith('/');
      if (anchored) {
        line = line.replace(/^\/+/, '');
      }

      const dirOnly = line.endsWith('/');
      if (dirOnly) {
        line = line.replace(/\/+$/, '');
      }

      if (!line) continue;

      rules.push({ pattern: line, anchored, dirOnly, negated });
    }

    if (rules.length === 0) return null;
    return new GitignoreMatcher(dirPath, rules);
  }

  /**
   * Check if a path matches the gitignore rules.
   * @param {string} filePath - Absolute path
   * @param {boolean} [isDir] - Whether the path is a directory
   * @returns {boolean|null} true=ignored, false=negated, null=no match
   */
  matches(filePath, isDir) {
    const relative = path.relative(this.baseDir, filePath).split(path.sep).join('/');
    if (!relative || relative.startsWith('..')) return null;

    if (isDir === undefined || isDir === null) {
      try {
        isDir = fs.statSync(filePath).isDirectory();
      } catch {
        isDir = false;
      }
    }

    let ignored = null;
    for (const rule of this.rules) {
      if (this._ruleMatches(rule, relative, isDir)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }

  _ruleMatches(rule, relative, isDir) {
    const { pattern, anchored, dirOnly } = rule;
    const parts = relative.split('/');
    const patternParts = pattern.split('/');

    if (dirOnly) {
      const targetParts = isDir ? parts : parts.slice(0, -1);
      if (targetParts.length === 0) return false;
      if (anchored || patternParts.length > 1) {
        return this._matchFromRoot(targetParts, patternParts);
      }
      return targetParts.some((part) => fnmatchMatch(part, pattern));
    }

    if (anchored || patternParts.length > 1) {
      return this._matchFromRoot(parts, patternParts);
    }

    return parts.some((part) => fnmatchMatch(part, pattern));
  }

  _matchFromRoot(targetParts, patternParts) {
    const matches = (pathIndex, patternIndex) => {
      if (patternIndex === patternParts.length) return true;
      if (pathIndex === targetParts.length) {
        return patternParts.slice(patternIndex).every((p) => p === '**');
      }

      const patternPart = patternParts[patternIndex];
      if (patternPart === '**') {
        return matches(pathIndex, patternIndex + 1) || matches(pathIndex + 1, patternIndex);
      }

      if (!fnmatchMatch(targetParts[pathIndex], patternPart)) return false;
      return matches(pathIndex + 1, patternIndex + 1);
    };

    return matches(0, 0);
  }
}

// =============================================================================
// GITIGNORE HELPERS
// =============================================================================

const _matcherCache = new Map();

export function loadGitignoreMatcher(dirPath) {
  if (!_matcherCache.has(dirPath)) {
    _matcherCache.set(dirPath, GitignoreMatcher.fromDir(dirPath));
  }
  return _matcherCache.get(dirPath);
}

export function clearMatcherCache() {
  _matcherCache.clear();
}

export function isGitignored(filePath, matchers, isDir = false) {
  let ignored = false;
  for (const matcher of matchers) {
    const decision = matcher.matches(filePath, isDir);
    if (decision !== null && decision !== undefined) {
      ignored = decision;
    }
  }
  return ignored;
}

export function shouldSkipDir(dirname) {
  return SKIP_DIRS.has(dirname) || dirname.endsWith('.egg-info');
}

export function normalizeIncludePaths(includeIgnored) {
  const normalized = new Set();
  for (const rawPath of includeIgnored || []) {
    const candidate = String(rawPath).trim().replace(/^\/+|\/+$/g, '');
    if (candidate) {
      normalized.add(candidate.split(path.sep).join('/'));
    }
  }
  return normalized;
}

export function isExactForceInclude(filePath, projectPath, includePaths) {
  if (!includePaths || includePaths.size === 0) return false;
  try {
    const relative = path.relative(projectPath, filePath).split(path.sep).join('/').replace(/^\/+|\/+$/, '');
    return includePaths.has(relative);
  } catch {
    return false;
  }
}

export function isForceIncluded(filePath, projectPath, includePaths) {
  if (!includePaths || includePaths.size === 0) return false;
  try {
    const relative = path.relative(projectPath, filePath).split(path.sep).join('/').replace(/^\/+|\/+$/, '');
    if (!relative) return false;

    for (const includePath of includePaths) {
      if (relative === includePath) return true;
      if (relative.startsWith(`${includePath}/`)) return true;
      if (includePath.startsWith(`${relative}/`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// =============================================================================
// CONFIG
// =============================================================================

/**
 * Load mempalace.yaml from project directory (falls back to mempal.yaml).
 * @param {string} projectDir
 * @returns {object}
 */
export function loadConfig(projectDir) {
  const resolvedDir = path.resolve(projectDir);
  let configPath = path.join(resolvedDir, 'mempalace.yaml');

  if (!fs.existsSync(configPath)) {
    const legacyPath = path.join(resolvedDir, 'mempal.yaml');
    if (fs.existsSync(legacyPath)) {
      configPath = legacyPath;
    } else {
      throw new Error(`No mempalace.yaml found in ${projectDir}. Run: mempalace init ${projectDir}`);
    }
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  return yaml.load(content);
}

// =============================================================================
// FILE ROUTING
// =============================================================================

/**
 * Route a file to the right room.
 * Priority: 1. Folder path  2. Filename  3. Content keywords  4. "general"
 *
 * @param {string} filepath
 * @param {string} content
 * @param {Array} rooms
 * @param {string} projectPath
 * @returns {string}
 */
export function detectRoom(filepath, content, rooms, projectPath) {
  const relative = path.relative(projectPath, filepath).toLowerCase();
  const filename = path.parse(filepath).name.toLowerCase();
  const contentLower = content.slice(0, 2000).toLowerCase();

  // Priority 1: folder path matches room name or keywords
  const pathParts = relative.replace(/\\/g, '/').split('/');
  for (const part of pathParts.slice(0, -1)) {
    for (const room of rooms) {
      const candidates = [room.name.toLowerCase(), ...(room.keywords || []).map((k) => k.toLowerCase())];
      if (candidates.some((c) => part === c || c.includes(part) || part.includes(c))) {
        return room.name;
      }
    }
  }

  // Priority 2: filename matches room name
  for (const room of rooms) {
    if (room.name.toLowerCase().includes(filename) || filename.includes(room.name.toLowerCase())) {
      return room.name;
    }
  }

  // Priority 3: keyword scoring
  const scores = {};
  for (const room of rooms) {
    const keywords = [...(room.keywords || []), room.name];
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      let idx = 0;
      while ((idx = contentLower.indexOf(kwLower, idx)) !== -1) {
        score++;
        idx += kwLower.length;
      }
    }
    if (score > 0) {
      scores[room.name] = score;
    }
  }

  const entries = Object.entries(scores);
  if (entries.length > 0) {
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  return 'general';
}

// =============================================================================
// CHUNKING
// =============================================================================

/**
 * Split content into drawer-sized chunks.
 * Tries to split on paragraph/line boundaries.
 *
 * @param {string} content
 * @param {string} sourceFile
 * @returns {Array<{content: string, chunk_index: number}>}
 */
export function chunkText(content, sourceFile) {
  content = content.trim();
  if (!content) return [];

  const chunks = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < content.length) {
    let end = Math.min(start + CHUNK_SIZE, content.length);

    // Try paragraph boundary, then line boundary
    if (end < content.length) {
      const paragraphPos = content.lastIndexOf('\n\n', end);
      if (paragraphPos > start + CHUNK_SIZE / 2) {
        end = paragraphPos;
      } else {
        const linePos = content.lastIndexOf('\n', end);
        if (linePos > start + CHUNK_SIZE / 2) {
          end = linePos;
        }
      }
    }

    const chunk = content.slice(start, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) {
      chunks.push({ content: chunk, chunk_index: chunkIndex });
      chunkIndex++;
    }

    start = end < content.length ? end - CHUNK_OVERLAP : end;
  }

  return chunks;
}

// =============================================================================
// SCAN PROJECT
// =============================================================================

/**
 * Recursively scan project directory for readable files.
 *
 * @param {string} projectDir
 * @param {object} [options]
 * @param {boolean} [options.respectGitignore=true]
 * @param {Array} [options.includeIgnored]
 * @returns {string[]}
 */
export function scanProject(projectDir, options = {}) {
  const { respectGitignore = true, includeIgnored = null } = options;
  const projectPath = path.resolve(projectDir);
  const files = [];
  const matcherCache = {};
  const includePaths = normalizeIncludePaths(includeIgnored);

  function walk(dir, activeMatchers) {
    let matchers = [...activeMatchers];

    if (respectGitignore) {
      // Filter matchers — only keep those whose base is ancestor of current dir
      matchers = matchers.filter(
        (m) => dir === m.baseDir || dir.startsWith(m.baseDir + path.sep),
      );
      if (!matcherCache[dir]) {
        matcherCache[dir] = GitignoreMatcher.fromDir(dir);
      }
      const currentMatcher = matcherCache[dir];
      if (currentMatcher) {
        matchers.push(currentMatcher);
      }
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = [];
    const fileEntries = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(entry.name);
      } else if (entry.isFile()) {
        fileEntries.push(entry.name);
      }
    }

    // Filter directories
    let filteredDirs = dirs.filter(
      (d) => isForceIncluded(path.join(dir, d), projectPath, includePaths) || !shouldSkipDir(d),
    );
    if (respectGitignore && matchers.length > 0) {
      filteredDirs = filteredDirs.filter(
        (d) =>
          isForceIncluded(path.join(dir, d), projectPath, includePaths) ||
          !isGitignored(path.join(dir, d), matchers, true),
      );
    }

    // Process files
    for (const filename of fileEntries) {
      const filepath = path.join(dir, filename);
      const forceInclude = isForceIncluded(filepath, projectPath, includePaths);
      const exactForce = isExactForceInclude(filepath, projectPath, includePaths);

      if (!forceInclude && SKIP_FILENAMES.has(filename)) continue;

      const ext = path.extname(filename).toLowerCase();
      if (!READABLE_EXTENSIONS.has(ext) && !exactForce) continue;

      if (respectGitignore && matchers.length > 0 && !forceInclude) {
        if (isGitignored(filepath, matchers, false)) continue;
      }

      files.push(filepath);
    }

    // Recurse into subdirectories
    for (const d of filteredDirs) {
      walk(path.join(dir, d), matchers);
    }
  }

  walk(projectPath, []);
  return files;
}

// =============================================================================
// PROCESS FILE
// =============================================================================

/**
 * Read, chunk, route, and file one file.
 *
 * @param {string} filepath
 * @param {string} projectPath
 * @param {object} vectorStore
 * @param {string} wing
 * @param {Array} rooms
 * @param {string} agent
 * @param {boolean} dryRun
 * @returns {Promise<number>} drawer count
 */
export async function processFile(filepath, projectPath, vectorStore, wing, rooms, agent, dryRun) {
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf-8');
  } catch {
    return 0;
  }

  content = content.trim();
  if (content.length < MIN_CHUNK_SIZE) return 0;

  const room = detectRoom(filepath, content, rooms, projectPath);
  const chunks = chunkText(content, filepath);

  if (dryRun) {
    console.log(`    [DRY RUN] ${path.basename(filepath)} → room:${room} (${chunks.length} drawers)`);
    return chunks.length;
  }

  let drawersAdded = 0;
  for (const chunk of chunks) {
    const drawerId = `drawer_${wing}_${room}_${createHash('md5').update(filepath + String(chunk.chunk_index)).digest('hex').slice(0, 16)}`;
    try {
      await vectorStore.add({
        id: drawerId,
        content: chunk.content,
        metadata: {
          wing,
          room,
          source_file: filepath,
          chunk_index: chunk.chunk_index,
          added_by: agent,
          filed_at: new Date().toISOString(),
        },
      });
      drawersAdded++;
    } catch (e) {
      const msg = String(e).toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        continue;
      }
      throw e;
    }
  }

  return drawersAdded;
}

// =============================================================================
// MINE
// =============================================================================

/**
 * Mine a project directory into the palace.
 *
 * @param {string} projectDir
 * @param {object} vectorStore
 * @param {object} [options]
 * @param {string} [options.wingOverride]
 * @param {string} [options.agent='mempalace']
 * @param {number} [options.limit=0]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.respectGitignore=true]
 * @param {Array} [options.includeIgnored]
 * @returns {Promise<object>}
 */
export async function mine(projectDir, vectorStore, options = {}) {
  const {
    wingOverride,
    agent = 'mempalace',
    limit = 0,
    dryRun = false,
    respectGitignore = true,
    includeIgnored = null,
  } = options;

  const projectPath = path.resolve(projectDir);
  const config = loadConfig(projectDir);

  const wing = wingOverride || config.wing;
  const rooms = config.rooms || [{ name: 'general', description: 'All project files' }];

  let files = scanProject(projectDir, { respectGitignore, includeIgnored });
  if (limit > 0) {
    files = files.slice(0, limit);
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log('  MemPalace Mine');
  console.log(`${'='.repeat(55)}`);
  console.log(`  Wing:    ${wing}`);
  console.log(`  Rooms:   ${rooms.map((r) => r.name).join(', ')}`);
  console.log(`  Files:   ${files.length}`);
  if (dryRun) console.log('  DRY RUN — nothing will be filed');
  if (!respectGitignore) console.log('  .gitignore: DISABLED');
  if (includeIgnored) {
    console.log(`  Include: ${[...normalizeIncludePaths(includeIgnored)].sort().join(', ')}`);
  }
  console.log(`${'─'.repeat(55)}\n`);

  let totalDrawers = 0;
  let filesSkipped = 0;
  const roomCounts = {};

  for (let i = 0; i < files.length; i++) {
    const filepath = files[i];
    const drawers = await processFile(filepath, projectPath, vectorStore, wing, rooms, agent, dryRun);

    if (drawers === 0 && !dryRun) {
      filesSkipped++;
    } else {
      totalDrawers += drawers;
      const room = detectRoom(filepath, '', rooms, projectPath);
      roomCounts[room] = (roomCounts[room] || 0) + 1;
      if (!dryRun) {
        const name = path.basename(filepath).slice(0, 50).padEnd(50);
        console.log(`  ✓ [${String(i + 1).padStart(4)}/${files.length}] ${name} +${drawers}`);
      }
    }
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log('  Done.');
  console.log(`  Files processed: ${files.length - filesSkipped}`);
  console.log(`  Files skipped (already filed): ${filesSkipped}`);
  console.log(`  Drawers filed: ${totalDrawers}`);
  console.log('\n  By room:');
  const sortedRooms = Object.entries(roomCounts).sort((a, b) => b[1] - a[1]);
  for (const [room, count] of sortedRooms) {
    console.log(`    ${room.padEnd(20)} ${count} files`);
  }
  console.log(`\n  Next: mempalace search "what you're looking for"`);
  console.log(`${'='.repeat(55)}\n`);

  return { totalDrawers, filesProcessed: files.length - filesSkipped, filesSkipped, roomCounts };
}

// =============================================================================
// STATUS
// =============================================================================

/**
 * Show what's been filed in the palace.
 * @param {object} vectorStore
 * @returns {Promise<object>}
 */
export async function status(vectorStore) {
  try {
    const results = await vectorStore.get({ limit: 10000, include: ['metadatas'] });
    const metas = results.metadatas || [];

    const wingRooms = {};
    for (const m of metas) {
      const w = m.wing || '?';
      const r = m.room || '?';
      if (!wingRooms[w]) wingRooms[w] = {};
      wingRooms[w][r] = (wingRooms[w][r] || 0) + 1;
    }

    console.log(`\n${'='.repeat(55)}`);
    console.log(`  MemPalace Status — ${metas.length} drawers`);
    console.log(`${'='.repeat(55)}\n`);
    for (const wing of Object.keys(wingRooms).sort()) {
      console.log(`  WING: ${wing}`);
      const rooms = Object.entries(wingRooms[wing]).sort((a, b) => b[1] - a[1]);
      for (const [room, count] of rooms) {
        console.log(`    ROOM: ${room.padEnd(20)} ${String(count).padStart(5)} drawers`);
      }
      console.log();
    }
    console.log(`${'='.repeat(55)}\n`);

    return { totalDrawers: metas.length, wingRooms };
  } catch {
    console.log('\n  No palace found.');
    console.log('  Run: mempalace init <dir> then mempalace mine <dir>');
    return { totalDrawers: 0, wingRooms: {} };
  }
}
