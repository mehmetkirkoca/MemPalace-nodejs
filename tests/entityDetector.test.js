import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractCandidates,
  scoreEntity,
  classifyEntity,
  detectEntities,
  scanForDetection,
  STOPWORDS,
} from '../src/entityDetector.js';

let testDir;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-test-'));
});

afterAll(() => {
  if (testDir) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

describe('extractCandidates', () => {
  it('extracts capitalized words that appear 3+ times', () => {
    const text = 'Alice went to the store. Alice said hello. Alice laughed. Bob is here.';
    const candidates = extractCandidates(text);
    expect(candidates).toHaveProperty('Alice');
    expect(candidates.Alice).toBe(3);
    // Bob appears only once — should not be a candidate
    expect(candidates).not.toHaveProperty('Bob');
  });

  it('extracts multi-word names', () => {
    const text = [
      'Claude Code is great.',
      'I love Claude Code so much.',
      'Claude Code works well.',
    ].join(' ');
    const candidates = extractCandidates(text);
    expect(candidates).toHaveProperty('Claude Code');
  });

  it('filters out stopwords', () => {
    // "The" many times — should not be a candidate
    const text = 'The The The The The something. Step Step Step Step.';
    const candidates = extractCandidates(text);
    expect(candidates).not.toHaveProperty('The');
    expect(candidates).not.toHaveProperty('Step');
  });

  it('filters out single-character words', () => {
    const text = 'I I I I I said something A A A A';
    const candidates = extractCandidates(text);
    expect(candidates).not.toHaveProperty('I');
    expect(candidates).not.toHaveProperty('A');
  });
});

describe('scoreEntity', () => {
  it('gives person score for person-like text', () => {
    const text = [
      'Alice said hello to everyone.',
      'Alice told me about her day.',
      'She was happy. Alice laughed loudly.',
      'Hey Alice, how are you?',
      'Alice felt great about it.',
    ].join('\n');
    const lines = text.split('\n');

    const scores = scoreEntity('Alice', text, lines);
    expect(scores.person_score).toBeGreaterThan(0);
    expect(scores.person_signals.length).toBeGreaterThan(0);
  });

  it('gives project score for project-like text', () => {
    const text = [
      'We are building MemPal for the team.',
      'They shipped MemPal last week.',
      'Install MemPal with pip install MemPal.',
      'The MemPal architecture is solid.',
      'MemPal v2 is coming soon.',
    ].join('\n');
    const lines = text.split('\n');

    const scores = scoreEntity('MemPal', text, lines);
    expect(scores.project_score).toBeGreaterThan(0);
    expect(scores.project_signals.length).toBeGreaterThan(0);
  });

  it('produces person signal from dialogue pattern', () => {
    const text = [
      '> Alice: I think this is great',
      '> Alice: Let me check',
      'Alice: sure thing',
    ].join('\n');
    const lines = text.split('\n');

    const scores = scoreEntity('Alice', text, lines);
    expect(scores.person_score).toBeGreaterThan(0);
    expect(scores.person_signals.some(s => s.includes('dialogue'))).toBe(true);
  });

  it('produces person signal from pronoun proximity', () => {
    const text = [
      'Alice went to the store.',
      'She bought some groceries.',
      'Then she came back home.',
      'Alice was tired after that.',
      'He said hello to Alice.',
    ].join('\n');
    const lines = text.split('\n');

    const scores = scoreEntity('Alice', text, lines);
    expect(scores.person_signals.some(s => s.includes('pronoun'))).toBe(true);
  });
});

describe('classifyEntity', () => {
  it('returns person type when person score is high', () => {
    const scores = {
      person_score: 12,
      project_score: 0,
      person_signals: ['dialogue marker (2x)', "'Alice ...' action (3x)"],
      project_signals: [],
    };
    const result = classifyEntity('Alice', 10, scores);
    expect(result.type).toBe('person');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.name).toBe('Alice');
  });

  it('returns project type when project score is high', () => {
    const scores = {
      person_score: 0,
      project_score: 10,
      person_signals: [],
      project_signals: ['project verb (3x)', 'versioned/hyphenated (2x)'],
    };
    const result = classifyEntity('MemPal', 8, scores);
    expect(result.type).toBe('project');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('returns uncertain when no signals present', () => {
    const scores = {
      person_score: 0,
      project_score: 0,
      person_signals: [],
      project_signals: [],
    };
    const result = classifyEntity('Unknown', 5, scores);
    expect(result.type).toBe('uncertain');
  });

  it('returns uncertain when signals are mixed', () => {
    const scores = {
      person_score: 5,
      project_score: 5,
      person_signals: ["'X ...' action (2x)"],
      project_signals: ['project verb (2x)'],
    };
    const result = classifyEntity('Hybrid', 10, scores);
    expect(result.type).toBe('uncertain');
  });

  it('returns uncertain when only pronoun signals match (downgrade)', () => {
    const scores = {
      person_score: 6,
      project_score: 0,
      person_signals: ['pronoun nearby (3x)'],
      project_signals: [],
    };
    const result = classifyEntity('Maybe', 5, scores);
    expect(result.type).toBe('uncertain');
    expect(result.confidence).toBe(0.4);
  });
});

describe('STOPWORDS', () => {
  it('contains basic stopwords', () => {
    expect(STOPWORDS.has('the')).toBe(true);
    expect(STOPWORDS.has('and')).toBe(true);
    expect(STOPWORDS.has('step')).toBe(true);
    expect(STOPWORDS.has('click')).toBe(true);
  });

  it('does not include potential entity names', () => {
    expect(STOPWORDS.has('alice')).toBe(false);
    expect(STOPWORDS.has('mempal')).toBe(false);
  });
});

describe('detectEntities', () => {
  it('detects entities from files', () => {
    // Person text
    const personFile = path.join(testDir, 'person.md');
    fs.writeFileSync(personFile, [
      'Alice said hello to everyone.',
      'Alice told me about her project.',
      'She was happy. Alice laughed loudly.',
      'Hey Alice, how are you?',
      'Alice felt great about it.',
      'Alice asked a question.',
      '> Alice: I agree with that.',
      'Alice thinks this is good.',
    ].join('\n'));

    // Project text
    const projectFile = path.join(testDir, 'project.md');
    fs.writeFileSync(projectFile, [
      'We are building MemPal for the team.',
      'They shipped MemPal last week.',
      'Deploy MemPal on the server.',
      'The MemPal architecture is solid.',
      'MemPal v2 is coming soon.',
      'Install MemPal with npm.',
      'The MemPal pipeline works.',
    ].join('\n'));

    const result = detectEntities([personFile, projectFile]);

    expect(result).toHaveProperty('people');
    expect(result).toHaveProperty('projects');
    expect(result).toHaveProperty('uncertain');
    expect(Array.isArray(result.people)).toBe(true);
    expect(Array.isArray(result.projects)).toBe(true);
  });

  it('returns empty result for empty file list', () => {
    const result = detectEntities([]);
    expect(result).toEqual({ people: [], projects: [], uncertain: [] });
  });
});

describe('scanForDetection', () => {
  it('collects prose files', () => {
    const scanDir = path.join(testDir, 'scantest');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'notes.md'), '# Notes');
    fs.writeFileSync(path.join(scanDir, 'readme.txt'), 'Hello');
    fs.writeFileSync(path.join(scanDir, 'code.py'), 'print("hi")');

    const files = scanForDetection(scanDir);
    expect(files.length).toBeGreaterThan(0);
    // prose files take priority
    const extensions = files.map(f => path.extname(f));
    expect(extensions).toContain('.md');
    expect(extensions).toContain('.txt');
  });

  it('skip dizinlerini atlar', () => {
    const scanDir = path.join(testDir, 'skiptest');
    const gitDir = path.join(scanDir, '.git');
    const nodeDir = path.join(scanDir, 'node_modules');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.mkdirSync(nodeDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config.txt'), 'git stuff');
    fs.writeFileSync(path.join(nodeDir, 'pkg.md'), 'package');
    fs.writeFileSync(path.join(scanDir, 'real.md'), 'content');

    const files = scanForDetection(scanDir);
    const filenames = files.map(f => path.basename(f));
    expect(filenames).toContain('real.md');
    expect(filenames).not.toContain('config.txt');
    expect(filenames).not.toContain('pkg.md');
  });

  it('maxFiles limiti uygular', () => {
    const scanDir = path.join(testDir, 'limittest');
    fs.mkdirSync(scanDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(scanDir, `file${i}.md`), `Content ${i}`);
    }
    const files = scanForDetection(scanDir, 5);
    expect(files.length).toBeLessThanOrEqual(5);
  });
});
