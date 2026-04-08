import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  findSessionBoundaries,
  extractTimestamp,
  extractPeople,
  extractSubject,
  splitMegaFile,
} from '../src/splitMegaFiles.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-mega-test-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name, content) {
  const fp = path.join(tmpDir, name);
  fs.writeFileSync(fp, content, 'utf-8');
  return fp;
}

// --- findSessionBoundaries ---

describe('findSessionBoundaries', () => {
  it('should find session boundaries at Claude Code v headers', () => {
    const lines = [
      'some preamble\n',
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      'content here\n',
      'more content\n',
      'Claude Code v1.0.1\n',
      '⏺ 10:00 AM Monday, March 30, 2026\n',
      'second session\n',
    ];
    const boundaries = findSessionBoundaries(lines);
    expect(boundaries).toEqual([1, 5]);
  });

  it('should exclude context restores with Ctrl+E', () => {
    const lines = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      'real session content\n',
      'more real content\n',
      'even more content\n',
      'still going\n',
      'and more\n',
      'Claude Code v1.0.0\n',
      'some line\n',
      'Ctrl+E to show 5 previous messages\n',
      'more content\n',
    ];
    const boundaries = findSessionBoundaries(lines);
    expect(boundaries).toEqual([0]);
  });

  it('should exclude context restores with "previous messages"', () => {
    const lines = [
      'Claude Code v1.0.0\n',
      'session content\n',
      'more content\n',
      'even more\n',
      'still more\n',
      'and more\n',
      'extra line\n',
      'Claude Code v1.0.0\n',
      'blah\n',
      'show 10 previous messages\n',
      'content\n',
    ];
    const boundaries = findSessionBoundaries(lines);
    expect(boundaries).toEqual([0]);
  });

  it('should return empty array when no headers found', () => {
    const lines = ['just some text\n', 'no headers here\n'];
    expect(findSessionBoundaries(lines)).toEqual([]);
  });
});

// --- extractTimestamp ---

describe('extractTimestamp', () => {
  it('should parse ⏺ timestamp format', () => {
    const lines = [
      'Claude Code v1.0.0\n',
      '⏺ 9:30 AM Monday, March 30, 2026\n',
      'content\n',
    ];
    const [human, iso] = extractTimestamp(lines);
    expect(iso).toBe('2026-03-30');
    expect(human).toBe('2026-03-30_930AM');
  });

  it('should parse PM timestamps', () => {
    const lines = [
      '⏺ 11:45 PM Wednesday, December 5, 2025\n',
    ];
    const [human, iso] = extractTimestamp(lines);
    expect(iso).toBe('2025-12-05');
    expect(human).toBe('2025-12-05_1145PM');
  });

  it('should return nulls when no timestamp found', () => {
    const lines = ['no timestamp here\n', 'nothing at all\n'];
    const [human, iso] = extractTimestamp(lines);
    expect(human).toBeNull();
    expect(iso).toBeNull();
  });

  it('should only search first 50 lines', () => {
    const lines = Array(60).fill('filler line\n');
    lines[55] = '⏺ 9:00 AM Monday, March 30, 2026\n';
    const [human, iso] = extractTimestamp(lines);
    expect(human).toBeNull();
    expect(iso).toBeNull();
  });
});

// --- extractPeople ---

describe('extractPeople', () => {
  it('should detect known people by name', () => {
    const lines = [
      'Ben said hello\n',
      'Alice replied\n',
    ];
    const people = extractPeople(lines, ['Alice', 'Ben', 'Max']);
    expect(people).toEqual(['Alice', 'Ben']);
  });

  it('should return sorted list', () => {
    const lines = ['Max and Alice were talking\n'];
    const people = extractPeople(lines, ['Alice', 'Ben', 'Max']);
    expect(people).toEqual(['Alice', 'Max']);
  });

  it('should return empty array when no people found', () => {
    const lines = ['just some random text\n'];
    const people = extractPeople(lines, ['Alice', 'Ben']);
    expect(people).toEqual([]);
  });

  it('should detect people from /Users/ path with username map', () => {
    const lines = [
      'Working directory: /Users/jdoe/projects\n',
    ];
    const people = extractPeople(lines, ['Alice'], { jdoe: 'John' });
    expect(people).toContain('John');
  });
});

// --- extractSubject ---

describe('extractSubject', () => {
  it('should extract first meaningful user prompt', () => {
    const lines = [
      'Claude Code v1.0.0\n',
      '> cd /some/dir\n',
      '> ls -la\n',
      '> Fix the login page validation\n',
      'response\n',
    ];
    const subject = extractSubject(lines);
    expect(subject).toBe('Fix-the-login-page-validation');
  });

  it('should skip shell commands', () => {
    const lines = [
      '> git status\n',
      '> python script.py\n',
      '> bash run.sh\n',
      '> Tell me about the project\n',
    ];
    const subject = extractSubject(lines);
    expect(subject).toBe('Tell-me-about-the-project');
  });

  it('should skip short prompts (<=5 chars)', () => {
    const lines = [
      '> yes\n',
      '> ok\n',
      '> Explain how the auth system works\n',
    ];
    const subject = extractSubject(lines);
    expect(subject).toBe('Explain-how-the-auth-system-works');
  });

  it('should return "session" when no suitable prompt found', () => {
    const lines = [
      '> cd /home\n',
      '> ls\n',
      'no user prompts\n',
    ];
    const subject = extractSubject(lines);
    expect(subject).toBe('session');
  });

  it('should truncate long subjects to 60 chars', () => {
    const longPrompt = '> ' + 'A'.repeat(100) + '\n';
    const subject = extractSubject([longPrompt]);
    expect(subject.length).toBeLessThanOrEqual(60);
  });

  it('should remove special characters for filename safety', () => {
    const lines = ['> Fix the bug: "cannot read property" of null!\n'];
    const subject = extractSubject(lines);
    expect(subject).not.toMatch(/[":!]/);
  });
});

// --- splitMegaFile (integration) ---

describe('splitMegaFile', () => {
  it('should split a file with multiple sessions', () => {
    const content = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      '> Fix the login bug\n',
      ...Array(20).fill('session 1 content\n'),
      'Claude Code v1.0.1\n',
      '⏺ 2:30 PM Monday, March 30, 2026\n',
      '> Add user profile page\n',
      ...Array(20).fill('session 2 content\n'),
    ].join('');

    const fp = writeTmp('test_transcript.txt', content);
    const outputDir = fs.mkdtempSync(path.join(tmpDir, 'output-'));
    const written = splitMegaFile(fp, outputDir);

    expect(written.length).toBe(2);
    expect(written.every(p => fs.existsSync(p))).toBe(true);

    // Verify output file names contain expected parts
    const names = written.map(p => path.basename(p));
    expect(names[0]).toContain('2026-03-30');
    expect(names[1]).toContain('2026-03-30');
  });

  it('should not split files with fewer than 2 sessions', () => {
    const content = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      ...Array(20).fill('only one session\n'),
    ].join('');

    const fp = writeTmp('single_session.txt', content);
    const outputDir = fs.mkdtempSync(path.join(tmpDir, 'output2-'));
    const written = splitMegaFile(fp, outputDir);

    expect(written).toEqual([]);
  });

  it('should rename original to .mega_backup', () => {
    const content = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      '> First task\n',
      ...Array(20).fill('content\n'),
      'Claude Code v1.0.1\n',
      '⏺ 3:00 PM Monday, March 30, 2026\n',
      '> Second task\n',
      ...Array(20).fill('content\n'),
    ].join('');

    const fp = writeTmp('to_backup.txt', content);
    const outputDir = fs.mkdtempSync(path.join(tmpDir, 'output3-'));
    splitMegaFile(fp, outputDir);

    const backupPath = fp.replace('.txt', '.mega_backup');
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.existsSync(fp)).toBe(false);
  });

  it('should skip tiny fragments (<10 lines)', () => {
    const content = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      '> Real session\n',
      ...Array(20).fill('content\n'),
      'Claude Code v1.0.1\n',
      '⏺ 10:00 AM Monday, March 30, 2026\n',
      'tiny\n',
      'fragment\n',
      'Claude Code v1.0.2\n',
      '⏺ 11:00 AM Monday, March 30, 2026\n',
      '> Another real session\n',
      ...Array(20).fill('more content\n'),
    ].join('');

    const fp = writeTmp('with_tiny.txt', content);
    const outputDir = fs.mkdtempSync(path.join(tmpDir, 'output4-'));
    const written = splitMegaFile(fp, outputDir);

    // The tiny middle fragment (4 lines) should be skipped
    expect(written.length).toBe(2);
  });

  it('should use outputDir as same dir as source when not specified', () => {
    const subDir = fs.mkdtempSync(path.join(tmpDir, 'samedir-'));
    const content = [
      'Claude Code v1.0.0\n',
      '⏺ 9:00 AM Monday, March 30, 2026\n',
      '> Task one\n',
      ...Array(20).fill('content\n'),
      'Claude Code v1.0.1\n',
      '⏺ 2:00 PM Monday, March 30, 2026\n',
      '> Task two\n',
      ...Array(20).fill('content\n'),
    ].join('');

    const fp = path.join(subDir, 'mega.txt');
    fs.writeFileSync(fp, content, 'utf-8');
    const written = splitMegaFile(fp);

    // Output should be in same dir as source
    expect(written.every(p => path.dirname(p) === subDir)).toBe(true);
  });
});
