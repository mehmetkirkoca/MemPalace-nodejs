/**
 * roomDetectorLocal.js — Local setup, no API required.
 *
 * Two ways to define rooms without calling any AI:
 *   1. Auto-detect from folder structure (zero config)
 *   2. Define manually in mempalace.yaml
 *
 * No internet. No API key. Your files stay on your machine.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// Common room patterns — detected from folder names and filenames
// Format: {folder_keyword: room_name}
const FOLDER_ROOM_MAP = {
  frontend: 'frontend',
  'front-end': 'frontend',
  front_end: 'frontend',
  client: 'frontend',
  ui: 'frontend',
  views: 'frontend',
  components: 'frontend',
  pages: 'frontend',
  backend: 'backend',
  'back-end': 'backend',
  back_end: 'backend',
  server: 'backend',
  api: 'backend',
  routes: 'backend',
  services: 'backend',
  controllers: 'backend',
  models: 'backend',
  database: 'backend',
  db: 'backend',
  docs: 'documentation',
  doc: 'documentation',
  documentation: 'documentation',
  wiki: 'documentation',
  readme: 'documentation',
  notes: 'documentation',
  design: 'design',
  designs: 'design',
  mockups: 'design',
  wireframes: 'design',
  assets: 'design',
  storyboard: 'design',
  costs: 'costs',
  cost: 'costs',
  budget: 'costs',
  finance: 'costs',
  financial: 'costs',
  pricing: 'costs',
  invoices: 'costs',
  accounting: 'costs',
  meetings: 'meetings',
  meeting: 'meetings',
  calls: 'meetings',
  meeting_notes: 'meetings',
  standup: 'meetings',
  minutes: 'meetings',
  team: 'team',
  staff: 'team',
  hr: 'team',
  hiring: 'team',
  employees: 'team',
  people: 'team',
  research: 'research',
  references: 'research',
  reading: 'research',
  papers: 'research',
  planning: 'planning',
  roadmap: 'planning',
  strategy: 'planning',
  specs: 'planning',
  requirements: 'planning',
  tests: 'testing',
  test: 'testing',
  testing: 'testing',
  qa: 'testing',
  scripts: 'scripts',
  tools: 'scripts',
  utils: 'scripts',
  config: 'configuration',
  configs: 'configuration',
  settings: 'configuration',
  infrastructure: 'configuration',
  infra: 'configuration',
  deploy: 'configuration',
};

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'dist',
  'build',
  '.next',
  'coverage',
]);

/**
 * Walk the project folder structure.
 * Find top-level subdirectories that match known room patterns.
 * Returns list of room dicts.
 */
function detectRoomsFromFolders(projectDir) {
  const projectPath = path.resolve(projectDir);
  const foundRooms = {};

  // Check top-level directories first (most reliable signal)
  const topItems = fs.readdirSync(projectPath, { withFileTypes: true });
  for (const item of topItems) {
    if (!item.isDirectory() || SKIP_DIRS.has(item.name)) continue;

    const nameLower = item.name.toLowerCase().replace(/-/g, '_');
    if (nameLower in FOLDER_ROOM_MAP) {
      const roomName = FOLDER_ROOM_MAP[nameLower];
      if (!(roomName in foundRooms)) {
        foundRooms[roomName] = item.name;
      }
    } else if (item.name.length > 2 && /^[a-zA-Z]/.test(item.name)) {
      // Folder name is a good room name directly
      const clean = item.name.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
      if (!(clean in foundRooms)) {
        foundRooms[clean] = item.name;
      }
    }
  }

  // Walk one level deeper for nested patterns
  for (const item of topItems) {
    if (!item.isDirectory() || SKIP_DIRS.has(item.name)) continue;

    let subItems;
    try {
      subItems = fs.readdirSync(path.join(projectPath, item.name), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subitem of subItems) {
      if (!subitem.isDirectory() || SKIP_DIRS.has(subitem.name)) continue;

      const nameLower = subitem.name.toLowerCase().replace(/-/g, '_');
      if (nameLower in FOLDER_ROOM_MAP) {
        const roomName = FOLDER_ROOM_MAP[nameLower];
        if (!(roomName in foundRooms)) {
          foundRooms[roomName] = subitem.name;
        }
      }
    }
  }

  // Build room list
  const rooms = [];
  for (const [roomName, original] of Object.entries(foundRooms)) {
    rooms.push({
      name: roomName,
      description: `Files from ${original}/`,
      keywords: [roomName, original.toLowerCase()],
    });
  }

  // Always add "general" as fallback
  if (!rooms.some((r) => r.name === 'general')) {
    rooms.push({
      name: 'general',
      description: "Files that don't fit other rooms",
      keywords: [],
    });
  }

  return rooms;
}

/**
 * Fallback: if folder structure gives no signal,
 * detect rooms from recurring filename patterns.
 */
function detectRoomsFromFiles(projectDir) {
  const projectPath = path.resolve(projectDir);
  const keywordCounts = {};

  const SKIP_DIRS_FILE = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build']);

  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS_FILE.has(entry.name)) {
          walkDir(fullPath);
        }
      } else {
        const nameLower = entry.name.toLowerCase().replace(/-/g, '_').replace(/ /g, '_');
        for (const [keyword, room] of Object.entries(FOLDER_ROOM_MAP)) {
          if (nameLower.includes(keyword)) {
            keywordCounts[room] = (keywordCounts[room] || 0) + 1;
          }
        }
      }
    }
  }

  walkDir(projectPath);

  // Return rooms that appear more than twice, sorted by count desc
  const sorted = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count >= 2);

  const rooms = [];
  for (const [room] of sorted) {
    rooms.push({
      name: room,
      description: `Files related to ${room}`,
      keywords: [room],
    });
    if (rooms.length >= 6) break;
  }

  if (rooms.length === 0) {
    rooms.push({ name: 'general', description: 'All project files', keywords: [] });
  }

  return rooms;
}

/**
 * Main entry point for local room detection.
 * Returns { wing, rooms, source } instead of doing interactive I/O.
 */
function detectRoomsLocal(projectDir) {
  const projectPath = path.resolve(projectDir);

  if (!fs.existsSync(projectPath)) {
    throw new Error(`Directory not found: ${projectDir}`);
  }

  const wing = path.basename(projectPath).toLowerCase().replace(/ /g, '_').replace(/-/g, '_');

  // Try folder structure first
  let rooms = detectRoomsFromFolders(projectDir);
  let source = 'folder structure';

  // If only "general" found, try filename patterns
  if (rooms.length <= 1) {
    rooms = detectRoomsFromFiles(projectDir);
    source = 'filename patterns';
  }

  // If still nothing, just use general
  if (rooms.length === 0) {
    rooms = [{ name: 'general', description: 'All project files', keywords: [] }];
    source = 'fallback (flat project)';
  }

  return { wing, rooms, source };
}

/**
 * Save room config to mempalace.yaml.
 */
function saveConfig(projectDir, wingName, rooms) {
  const config = {
    wing: wingName,
    rooms: rooms.map((r) => ({
      name: r.name,
      description: r.description,
      keywords: r.keywords || [r.name],
    })),
  };

  const configPath = path.join(path.resolve(projectDir), 'mempalace.yaml');
  fs.writeFileSync(configPath, yaml.dump(config, { flowLevel: -1, sortKeys: false }));
}

export {
  FOLDER_ROOM_MAP,
  detectRoomsFromFolders,
  detectRoomsFromFiles,
  detectRoomsLocal,
  saveConfig,
};
