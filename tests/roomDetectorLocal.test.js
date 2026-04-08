/**
 * roomDetectorLocal.test.js — Tests for local room detection from folder/file patterns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import yaml from 'js-yaml';
import {
  FOLDER_ROOM_MAP,
  detectRoomsFromFolders,
  detectRoomsFromFiles,
  detectRoomsLocal,
  saveConfig,
} from '../src/roomDetectorLocal.js';

// Helper: create a temp directory with given structure
function createTempProject(structure) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-test-'));
  for (const item of structure) {
    const fullPath = path.join(tmpDir, item);
    if (item.endsWith('/')) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, '// stub');
    }
  }
  return tmpDir;
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ==================== FOLDER_ROOM_MAP ====================

describe('FOLDER_ROOM_MAP', () => {
  it('contains at least 70 patterns', () => {
    expect(Object.keys(FOLDER_ROOM_MAP).length).toBeGreaterThanOrEqual(70);
  });

  it('maps frontend-related folders to "frontend"', () => {
    for (const key of ['frontend', 'front-end', 'front_end', 'client', 'ui', 'components', 'pages']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('frontend');
    }
  });

  it('maps backend-related folders to "backend"', () => {
    for (const key of ['backend', 'server', 'api', 'routes', 'controllers', 'models', 'database', 'db']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('backend');
    }
  });

  it('maps documentation folders to "documentation"', () => {
    for (const key of ['docs', 'doc', 'documentation', 'wiki', 'readme', 'notes']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('documentation');
    }
  });

  it('maps test folders to "testing"', () => {
    for (const key of ['tests', 'test', 'testing', 'qa']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('testing');
    }
  });

  it('maps cost-related folders to "costs"', () => {
    for (const key of ['costs', 'cost', 'budget', 'finance', 'invoices', 'accounting']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('costs');
    }
  });

  it('maps meeting-related folders to "meetings"', () => {
    for (const key of ['meetings', 'meeting', 'calls', 'meeting_notes', 'standup', 'minutes']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('meetings');
    }
  });

  it('maps design folders to "design"', () => {
    for (const key of ['design', 'designs', 'mockups', 'wireframes', 'assets', 'storyboard']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('design');
    }
  });

  it('maps config/infra folders to "configuration"', () => {
    for (const key of ['config', 'configs', 'settings', 'infrastructure', 'infra', 'deploy']) {
      expect(FOLDER_ROOM_MAP[key]).toBe('configuration');
    }
  });
});

// ==================== detectRoomsFromFolders ====================

describe('detectRoomsFromFolders', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanupDir(tmpDir);
  });

  it('detects frontend and backend rooms from folder names', () => {
    tmpDir = createTempProject(['frontend/', 'backend/', 'README.md']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('frontend');
    expect(names).toContain('backend');
  });

  it('normalizes folder names (dash to underscore, lowercase)', () => {
    tmpDir = createTempProject(['front-end/', 'back-end/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('frontend');
    expect(names).toContain('backend');
  });

  it('always includes "general" as fallback', () => {
    tmpDir = createTempProject(['some_random_dir/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('general');
  });

  it('does not duplicate "general" if already present', () => {
    tmpDir = createTempProject(['unknown_folder/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const generalCount = rooms.filter((r) => r.name === 'general').length;
    expect(generalCount).toBe(1);
  });

  it('skips .git, node_modules, __pycache__ and similar dirs', () => {
    tmpDir = createTempProject(['.git/', 'node_modules/', '__pycache__/', '.venv/', 'src/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    // None of the skip dirs should create rooms
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('__pycache__');
    expect(names).not.toContain('.venv');
  });

  it('detects rooms from nested directories (one level deep)', () => {
    tmpDir = createTempProject(['project/frontend/', 'project/backend/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('frontend');
    expect(names).toContain('backend');
  });

  it('adds unrecognized folders as custom rooms if name is valid', () => {
    tmpDir = createTempProject(['analytics/', 'marketing/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('analytics');
    expect(names).toContain('marketing');
  });

  it('skips folders with short names (2 chars or less)', () => {
    tmpDir = createTempProject(['ab/', 'x/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).not.toContain('ab');
    expect(names).not.toContain('x');
  });

  it('skips folders starting with non-alpha characters', () => {
    tmpDir = createTempProject(['123data/', '_private/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).not.toContain('123data');
    expect(names).not.toContain('_private');
  });

  it('returns room objects with name, description, keywords', () => {
    tmpDir = createTempProject(['docs/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const docRoom = rooms.find((r) => r.name === 'documentation');
    expect(docRoom).toBeDefined();
    expect(docRoom.description).toContain('docs');
    expect(docRoom.keywords).toContain('documentation');
    expect(docRoom.keywords).toContain('docs');
  });

  it('does not create duplicate room names from top-level and nested', () => {
    tmpDir = createTempProject(['docs/', 'project/doc/']);
    const rooms = detectRoomsFromFolders(tmpDir);
    const docRooms = rooms.filter((r) => r.name === 'documentation');
    expect(docRooms.length).toBe(1);
  });
});

// ==================== detectRoomsFromFiles ====================

describe('detectRoomsFromFiles', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanupDir(tmpDir);
  });

  it('detects rooms from recurring filename patterns (threshold >= 2)', () => {
    tmpDir = createTempProject([
      'test_auth.py',
      'test_user.py',
      'test_api.py',
      'deploy_script.sh',
    ]);
    const rooms = detectRoomsFromFiles(tmpDir);
    const names = rooms.map((r) => r.name);
    expect(names).toContain('testing');
  });

  it('returns only "general" when no patterns match enough', () => {
    tmpDir = createTempProject(['file1.txt', 'file2.txt']);
    const rooms = detectRoomsFromFiles(tmpDir);
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe('general');
  });

  it('limits results to max 6 rooms', () => {
    // Create many files with different pattern keywords
    const files = [];
    const keywords = ['test', 'doc', 'design', 'config', 'meeting', 'cost', 'research', 'plan'];
    for (const kw of keywords) {
      files.push(`${kw}_file1.txt`);
      files.push(`${kw}_file2.txt`);
      files.push(`${kw}_file3.txt`);
    }
    tmpDir = createTempProject(files);
    const rooms = detectRoomsFromFiles(tmpDir);
    expect(rooms.length).toBeLessThanOrEqual(6);
  });

  it('sorts rooms by match count (descending)', () => {
    tmpDir = createTempProject([
      'test_a.py', 'test_b.py', 'test_c.py', 'test_d.py',
      'doc_a.md', 'doc_b.md',
    ]);
    const rooms = detectRoomsFromFiles(tmpDir);
    const names = rooms.map((r) => r.name);
    // testing should come before documentation (more matches)
    if (names.includes('testing') && names.includes('documentation')) {
      expect(names.indexOf('testing')).toBeLessThan(names.indexOf('documentation'));
    }
  });

  it('skips .git and node_modules directories', () => {
    tmpDir = createTempProject([
      'node_modules/test_a.js',
      'node_modules/test_b.js',
      'node_modules/test_c.js',
      '.git/config',
      'src/app.js',
    ]);
    const rooms = detectRoomsFromFiles(tmpDir);
    const names = rooms.map((r) => r.name);
    // node_modules files should be skipped, so testing shouldn't appear
    expect(names).not.toContain('testing');
  });
});

// ==================== detectRoomsLocal ====================

describe('detectRoomsLocal', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanupDir(tmpDir);
  });

  it('uses folder-based detection when folders match patterns', () => {
    tmpDir = createTempProject(['frontend/', 'backend/', 'docs/', 'app.js']);
    const result = detectRoomsLocal(tmpDir);
    expect(result.source).toBe('folder structure');
    expect(result.rooms.map((r) => r.name)).toContain('frontend');
    expect(result.rooms.map((r) => r.name)).toContain('backend');
    expect(result.rooms.map((r) => r.name)).toContain('documentation');
  });

  it('falls back to file-based detection when no folder patterns match', () => {
    tmpDir = createTempProject([
      'test_auth.py', 'test_user.py', 'test_api.py',
    ]);
    const result = detectRoomsLocal(tmpDir);
    expect(result.source).toBe('filename patterns');
  });

  it('falls back to filename patterns when no folder structure found', () => {
    tmpDir = createTempProject(['a.txt']);
    const result = detectRoomsLocal(tmpDir);
    // With no matching folders, falls to file-based which returns "general"
    expect(result.rooms.length).toBeGreaterThanOrEqual(1);
    expect(result.rooms[0].name).toBe('general');
  });

  it('returns wing name derived from directory name', () => {
    tmpDir = createTempProject(['frontend/']);
    const result = detectRoomsLocal(tmpDir);
    // wing name is derived from directory basename
    expect(typeof result.wing).toBe('string');
    expect(result.wing.length).toBeGreaterThan(0);
  });

  it('throws on non-existent directory', () => {
    expect(() => detectRoomsLocal('/tmp/nonexistent_dir_xyz_12345')).toThrow();
  });
});

// ==================== saveConfig ====================

describe('saveConfig', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) cleanupDir(tmpDir);
  });

  it('writes mempalace.yaml with wing and rooms', () => {
    tmpDir = createTempProject([]);
    const rooms = [
      { name: 'frontend', description: 'Frontend files', keywords: ['frontend', 'ui'] },
      { name: 'backend', description: 'Backend files', keywords: ['backend', 'api'] },
    ];
    saveConfig(tmpDir, 'my_project', rooms);

    const configPath = path.join(tmpDir, 'mempalace.yaml');
    expect(fs.existsSync(configPath)).toBe(true);

    const content = yaml.load(fs.readFileSync(configPath, 'utf8'));
    expect(content.wing).toBe('my_project');
    expect(content.rooms).toHaveLength(2);
    expect(content.rooms[0].name).toBe('frontend');
    expect(content.rooms[0].description).toBe('Frontend files');
    expect(content.rooms[0].keywords).toEqual(['frontend', 'ui']);
  });

  it('uses room name as keyword fallback if keywords missing', () => {
    tmpDir = createTempProject([]);
    const rooms = [{ name: 'general', description: 'All files' }];
    saveConfig(tmpDir, 'test_proj', rooms);

    const content = yaml.load(fs.readFileSync(path.join(tmpDir, 'mempalace.yaml'), 'utf8'));
    expect(content.rooms[0].keywords).toEqual(['general']);
  });
});
