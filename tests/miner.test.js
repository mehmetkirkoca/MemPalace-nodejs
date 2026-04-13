import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  CHUNK_SIZE,
  CHUNK_OVERLAP,
  MIN_CHUNK_SIZE,
  SKIP_DIRS,
  READABLE_EXTENSIONS,
  GitignoreMatcher,
  chunkText,
  detectRoom,
  loadConfig,
} from '../src/miner.js';

describe('chunkText', () => {
  it('should split at paragraph boundaries', () => {
    const para1 = 'A'.repeat(300);
    const para2 = 'B'.repeat(300);
    const content = `${para1}\n\n${para2}`;

    const chunks = chunkText(content, 'test.js');
    // Total ~602 chars, below CHUNK_SIZE=800 — should be a single chunk
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('A');
    expect(chunks[0].content).toContain('B');
  });

  it('should split long content into multiple chunks respecting CHUNK_SIZE', () => {
    // Her paragraf ~200 karakter, toplam 5 paragraf = 1000+ karakter
    const paragraphs = [];
    for (let i = 0; i < 10; i++) {
      paragraphs.push(`Paragraph ${i}: ${'X'.repeat(150)}`);
    }
    const content = paragraphs.join('\n\n');

    const chunks = chunkText(content, 'test.js');
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should not exceed CHUNK_SIZE (small tolerance for boundary search)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_SIZE + 10);
    }
  });

  it('should assign sequential chunk_index values', () => {
    const content = Array(10).fill('X'.repeat(200)).join('\n\n');
    const chunks = chunkText(content, 'test.js');

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it('should skip chunks smaller than MIN_CHUNK_SIZE', () => {
    const content = 'Hi'; // 2 karakter < MIN_CHUNK_SIZE
    const chunks = chunkText(content, 'test.js');
    expect(chunks.length).toBe(0);
  });

  it('should return empty array for empty content', () => {
    expect(chunkText('', 'test.js')).toEqual([]);
    expect(chunkText('   ', 'test.js')).toEqual([]);
  });

  it('should try line boundary before hard break', () => {
    // Content exceeding CHUNK_SIZE, split at line boundaries
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`Line ${i}: ${'Y'.repeat(60)}`);
    }
    const content = lines.join('\n');
    const chunks = chunkText(content, 'test.js');
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('GitignoreMatcher', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-gitignore-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should match simple patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.log\nbuild/\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    expect(matcher).not.toBeNull();
    expect(matcher.matches(path.join(tmpDir, 'error.log'), false)).toBe(true);
    expect(matcher.matches(path.join(tmpDir, 'app.js'), false)).toBe(null);
  });

  it('should match directory-only patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'build/\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    // Dizin olarak match etmeli
    expect(matcher.matches(path.join(tmpDir, 'build'), true)).toBe(true);
    // Should NOT match as file (dir_only pattern)
    expect(matcher.matches(path.join(tmpDir, 'build'), false)).toBe(null);
  });

  it('should handle negation patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.log\n!important.log\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    expect(matcher.matches(path.join(tmpDir, 'error.log'), false)).toBe(true);
    expect(matcher.matches(path.join(tmpDir, 'important.log'), false)).toBe(false);
  });

  it('should return null when no .gitignore exists', () => {
    const matcher = GitignoreMatcher.fromDir(tmpDir);
    expect(matcher).toBeNull();
  });

  it('should handle anchored patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '/dist\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    expect(matcher.matches(path.join(tmpDir, 'dist'), false)).toBe(true);
    // Should NOT match dist in subdirectory (anchored pattern)
    expect(matcher.matches(path.join(tmpDir, 'src', 'dist'), false)).toBe(null);
  });

  it('should handle ** glob patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'logs/**/*.log\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    expect(matcher.matches(path.join(tmpDir, 'logs', 'app.log'), false)).toBe(true);
    expect(matcher.matches(path.join(tmpDir, 'logs', 'sub', 'app.log'), false)).toBe(true);
  });

  it('should skip comment and empty lines', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '# comment\n\n*.log\n');
    const matcher = GitignoreMatcher.fromDir(tmpDir);

    expect(matcher).not.toBeNull();
    expect(matcher.matches(path.join(tmpDir, 'error.log'), false)).toBe(true);
  });
});

describe('detectRoom', () => {
  const rooms = [
    { name: 'frontend', keywords: ['react', 'component', 'ui'] },
    { name: 'backend', keywords: ['api', 'server', 'express'] },
    { name: 'database', keywords: ['sql', 'migration', 'schema'] },
  ];

  it('should route by folder path match', () => {
    const projectPath = '/project';
    const result = detectRoom('/project/frontend/App.js', 'some content', rooms, projectPath);
    expect(result).toBe('frontend');
  });

  it('should route by filename match', () => {
    const projectPath = '/project';
    const result = detectRoom('/project/src/database.js', 'some content', rooms, projectPath);
    expect(result).toBe('database');
  });

  it('should route by content keywords', () => {
    const projectPath = '/project';
    const content = 'This file uses express to create an api server endpoint';
    const result = detectRoom('/project/src/app.js', content, rooms, projectPath);
    expect(result).toBe('backend');
  });

  it('should fallback to general when no match', () => {
    const projectPath = '/project';
    const result = detectRoom('/project/src/utils.js', 'helper functions', rooms, projectPath);
    expect(result).toBe('general');
  });

  it('should prioritize folder path over content keywords', () => {
    const projectPath = '/project';
    // File is in frontend folder but content contains backend keywords
    const content = 'api server express endpoint controller';
    const result = detectRoom('/project/frontend/helper.js', content, rooms, projectPath);
    expect(result).toBe('frontend');
  });
});

describe('loadConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-config-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should read mempalace.yaml', () => {
    const yamlContent = `wing: test-project\nrooms:\n  - name: frontend\n    keywords: [react]\n  - name: backend\n    keywords: [api]\n`;
    fs.writeFileSync(path.join(tmpDir, 'mempalace.yaml'), yamlContent);

    const config = loadConfig(tmpDir);
    expect(config.wing).toBe('test-project');
    expect(config.rooms).toHaveLength(2);
    expect(config.rooms[0].name).toBe('frontend');
  });

  it('should fallback to mempal.yaml', () => {
    const yamlContent = `wing: legacy-project\nrooms:\n  - name: general\n`;
    fs.writeFileSync(path.join(tmpDir, 'mempal.yaml'), yamlContent);

    const config = loadConfig(tmpDir);
    expect(config.wing).toBe('legacy-project');
  });

  it('should throw when no config file exists', () => {
    expect(() => loadConfig(tmpDir)).toThrow();
  });
});

describe('Constants', () => {
  it('should have correct chunk constants', () => {
    expect(CHUNK_SIZE).toBe(800);
    expect(CHUNK_OVERLAP).toBe(100);
    expect(MIN_CHUNK_SIZE).toBe(50);
  });

  it('should include essential SKIP_DIRS', () => {
    expect(SKIP_DIRS.has('.git')).toBe(true);
    expect(SKIP_DIRS.has('node_modules')).toBe(true);
    expect(SKIP_DIRS.has('__pycache__')).toBe(true);
    expect(SKIP_DIRS.has('.next')).toBe(true);
    expect(SKIP_DIRS.has('dist')).toBe(true);
    expect(SKIP_DIRS.has('build')).toBe(true);
    expect(SKIP_DIRS.has('.cache')).toBe(true);
    expect(SKIP_DIRS.has('.venv')).toBe(true);
  });
});
