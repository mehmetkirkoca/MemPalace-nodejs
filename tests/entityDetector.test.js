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
  it('büyük harfle başlayan kelimeleri bulur (3+ tekrar)', () => {
    const text = 'Alice went to the store. Alice said hello. Alice laughed. Bob is here.';
    const candidates = extractCandidates(text);
    expect(candidates).toHaveProperty('Alice');
    expect(candidates.Alice).toBe(3);
    // Bob sadece 1 kez geçiyor, aday olmamalı
    expect(candidates).not.toHaveProperty('Bob');
  });

  it('çok kelimeli isimleri bulur', () => {
    const text = [
      'Claude Code is great.',
      'I love Claude Code so much.',
      'Claude Code works well.',
    ].join(' ');
    const candidates = extractCandidates(text);
    expect(candidates).toHaveProperty('Claude Code');
  });

  it('stopwords filtrelenir', () => {
    // "The" birçok kez geçse bile aday olmamalı
    const text = 'The The The The The something. Step Step Step Step.';
    const candidates = extractCandidates(text);
    expect(candidates).not.toHaveProperty('The');
    expect(candidates).not.toHaveProperty('Step');
  });

  it('tek karakterli kelimeleri filtreler', () => {
    const text = 'I I I I I said something A A A A';
    const candidates = extractCandidates(text);
    expect(candidates).not.toHaveProperty('I');
    expect(candidates).not.toHaveProperty('A');
  });
});

describe('scoreEntity', () => {
  it('kişi metni için person score verir', () => {
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

  it('proje metni için project score verir', () => {
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

  it('dialogue pattern kişi sinyali üretir', () => {
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

  it('pronoun proximity sinyali üretir', () => {
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
  it('yüksek person score ile person döner', () => {
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

  it('yüksek project score ile project döner', () => {
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

  it('sinyal yoksa uncertain döner', () => {
    const scores = {
      person_score: 0,
      project_score: 0,
      person_signals: [],
      project_signals: [],
    };
    const result = classifyEntity('Unknown', 5, scores);
    expect(result.type).toBe('uncertain');
  });

  it('karışık sinyallerde uncertain döner', () => {
    const scores = {
      person_score: 5,
      project_score: 5,
      person_signals: ["'X ...' action (2x)"],
      project_signals: ['project verb (2x)'],
    };
    const result = classifyEntity('Hybrid', 10, scores);
    expect(result.type).toBe('uncertain');
  });

  it('sadece pronoun match olursa uncertain döner (downgrade)', () => {
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
  it('temel stopwords içerir', () => {
    expect(STOPWORDS.has('the')).toBe(true);
    expect(STOPWORDS.has('and')).toBe(true);
    expect(STOPWORDS.has('step')).toBe(true);
    expect(STOPWORDS.has('click')).toBe(true);
  });

  it('entity olabilecek kelimeleri içermez', () => {
    expect(STOPWORDS.has('alice')).toBe(false);
    expect(STOPWORDS.has('mempal')).toBe(false);
  });
});

describe('detectEntities', () => {
  it('dosyalardan entity tespit eder', () => {
    // Person metni
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

    // Project metni
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

  it('boş dosya listesiyle boş sonuç döner', () => {
    const result = detectEntities([]);
    expect(result).toEqual({ people: [], projects: [], uncertain: [] });
  });
});

describe('scanForDetection', () => {
  it('prose dosyalarını toplar', () => {
    const scanDir = path.join(testDir, 'scantest');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'notes.md'), '# Notes');
    fs.writeFileSync(path.join(scanDir, 'readme.txt'), 'Hello');
    fs.writeFileSync(path.join(scanDir, 'code.py'), 'print("hi")');

    const files = scanForDetection(scanDir);
    expect(files.length).toBeGreaterThan(0);
    // prose dosyaları öncelikli
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
