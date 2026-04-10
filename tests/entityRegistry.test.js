/**
 * entityRegistry.test.js — Tests for EntityRegistry module.
 *
 * Covers: seed, lookup, ambiguous word disambiguation,
 * extractPeopleFromQuery, learnFromText, save/load persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EntityRegistry, initEntityDetector } from '../src/entityRegistry.js';
import * as entityDetector from '../src/entityDetector.js';

// Use a temp directory for tests
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-registry-test-'));
  initEntityDetector(entityDetector);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Load / Save ──────────────────────────────────────────────────────────────

describe('EntityRegistry — load/save', () => {
  it('creates empty registry when no file exists', () => {
    const reg = EntityRegistry.load(tmpDir);
    expect(reg.mode).toBe('personal');
    expect(reg.people).toEqual({});
    expect(reg.projects).toEqual([]);
    expect(reg.ambiguousFlags).toEqual([]);
  });

  it('saves and loads round-trip', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('work', [
      { name: 'Alice', relationship: 'colleague', context: 'work' },
    ], ['Acme']);
    // Load again from disk
    const reg2 = EntityRegistry.load(tmpDir);
    expect(reg2.mode).toBe('work');
    expect(reg2.people).toHaveProperty('Alice');
    expect(reg2.projects).toEqual(['Acme']);
  });

  it('handles corrupt JSON gracefully', () => {
    const filePath = path.join(tmpDir, 'entity_registry.json');
    fs.writeFileSync(filePath, '{broken json!!!');
    const reg = EntityRegistry.load(tmpDir);
    expect(reg.mode).toBe('personal');
    expect(reg.people).toEqual({});
  });
});

// ── Seed ─────────────────────────────────────────────────────────────────────

describe('EntityRegistry — seed', () => {
  it('seeds people and projects from onboarding', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Riley', relationship: 'daughter', context: 'personal' },
      { name: 'Max', relationship: 'son', context: 'personal' },
    ], ['MemPalace', 'Acme']);

    expect(reg.mode).toBe('personal');
    expect(reg.people.Riley.source).toBe('onboarding');
    expect(reg.people.Riley.relationship).toBe('daughter');
    expect(reg.people.Riley.confidence).toBe(1.0);
    expect(reg.projects).toEqual(['MemPalace', 'Acme']);
  });

  it('flags ambiguous names', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Grace', relationship: 'friend' },
      { name: 'Alice', relationship: 'friend' },
    ], []);

    // 'grace' is in COMMON_ENGLISH_WORDS
    expect(reg.ambiguousFlags).toContain('grace');
    // 'alice' is not
    expect(reg.ambiguousFlags).not.toContain('alice');
  });

  it('skips empty names', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: '', relationship: '' },
      { name: '  ', relationship: '' },
      { name: 'Alice', relationship: 'friend' },
    ], []);
    expect(Object.keys(reg.people)).toEqual(['Alice']);
  });

  it('registers aliases', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Maxwell', relationship: 'friend', context: 'personal' },
    ], [], { Max: 'Maxwell' });

    expect(reg.people.Maxwell).toBeDefined();
    expect(reg.people.Max).toBeDefined();
    expect(reg.people.Max.canonical).toBe('Maxwell');
    expect(reg.people.Max.aliases).toContain('Maxwell');
  });
});

// ── Lookup ───────────────────────────────────────────────────────────────────

describe('EntityRegistry — lookup', () => {
  let reg;

  beforeEach(() => {
    reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Riley', relationship: 'daughter', context: 'personal' },
      { name: 'Grace', relationship: 'friend', context: 'personal' },
    ], ['MemPalace']);
  });

  it('finds a known person', () => {
    const result = reg.lookup('Riley');
    expect(result.type).toBe('person');
    expect(result.confidence).toBe(1.0);
    expect(result.source).toBe('onboarding');
    expect(result.name).toBe('Riley');
    expect(result.needsDisambiguation).toBe(false);
  });

  it('finds a known person case-insensitively', () => {
    const result = reg.lookup('riley');
    expect(result.type).toBe('person');
    expect(result.name).toBe('Riley');
  });

  it('finds a project', () => {
    const result = reg.lookup('mempalace');
    expect(result.type).toBe('project');
    expect(result.confidence).toBe(1.0);
  });

  it('returns unknown for unregistered word', () => {
    const result = reg.lookup('Xylophone');
    expect(result.type).toBe('unknown');
    expect(result.confidence).toBe(0.0);
  });

  it('disambiguates ambiguous word with person context', () => {
    const result = reg.lookup('Grace', 'I went with Grace today');
    expect(result.type).toBe('person');
    expect(result.disambiguatedBy).toBe('context_patterns');
  });

  it('disambiguates ambiguous word with concept context', () => {
    const result = reg.lookup('Grace', 'the grace of the situation');
    expect(result.type).toBe('concept');
    expect(result.disambiguatedBy).toBe('context_patterns');
  });

  it('falls back to person for ambiguous word without context', () => {
    const result = reg.lookup('Grace');
    expect(result.type).toBe('person');
    // Without context, returns the registered person data
  });

  it('finds person via alias', () => {
    reg.seed('personal', [
      { name: 'Maxwell', relationship: 'friend', context: 'personal' },
    ], [], { Max: 'Maxwell' });
    const result = reg.lookup('Max');
    expect(result.type).toBe('person');
  });
});


// ── extractPeopleFromQuery ──────────────────────────────────────────────────

describe('EntityRegistry — extractPeopleFromQuery', () => {
  let reg;

  beforeEach(() => {
    reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Riley', relationship: 'daughter', context: 'personal' },
      { name: 'Alice', relationship: 'friend', context: 'personal' },
      { name: 'Grace', relationship: 'friend', context: 'personal' },
    ], []);
  });

  it('extracts known people from query text', () => {
    const found = reg.extractPeopleFromQuery('What did Riley and Alice do yesterday?');
    expect(found).toContain('Riley');
    expect(found).toContain('Alice');
  });

  it('does not extract unknown names', () => {
    const found = reg.extractPeopleFromQuery('What did Xavier say?');
    expect(found).toEqual([]);
  });

  it('skips ambiguous words without person context', () => {
    const found = reg.extractPeopleFromQuery('the grace of simplicity');
    expect(found).not.toContain('Grace');
  });

  it('includes ambiguous words with person context', () => {
    const found = reg.extractPeopleFromQuery('I saw Grace and she smiled');
    expect(found).toContain('Grace');
  });

  it('does not return duplicates', () => {
    const found = reg.extractPeopleFromQuery('Riley told Riley\'s friend');
    expect(found.filter(n => n === 'Riley')).toHaveLength(1);
  });
});

// ── extractUnknownCandidates ────────────────────────────────────────────────

describe('EntityRegistry — extractUnknownCandidates', () => {
  it('finds capitalized words not in registry', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [{ name: 'Alice', relationship: 'friend' }], []);
    const unknown = reg.extractUnknownCandidates('Alice met Zara at the Cairo hotel');
    expect(unknown).toContain('Zara');
    expect(unknown).toContain('Cairo');
    expect(unknown).not.toContain('Alice');
  });

  it('skips common English words', () => {
    const reg = EntityRegistry.load(tmpDir);
    const unknown = reg.extractUnknownCandidates('Grace and Hope are virtues');
    // grace and hope are in COMMON_ENGLISH_WORDS, should be skipped
    expect(unknown).not.toContain('Grace');
    expect(unknown).not.toContain('Hope');
  });
});

// ── learnFromText ───────────────────────────────────────────────────────────

describe('EntityRegistry — learnFromText', () => {
  it('discovers new person candidates from text', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [], []);

    const text = [
      '> Gandalf: You shall not pass!',
      'Gandalf said hello to everyone.',
      'He was very serious about it.',
      'Gandalf told the group to be careful.',
      'She agreed with him.',
      'Gandalf asked about the ring.',
      'Later, Gandalf decided to leave.',
      'Hey Gandalf, where are you going?',
      'Gandalf laughed at the joke.',
      'Gandalf smiled warmly.',
      'Thanks Gandalf for everything.',
      'Gandalf wrote a letter.',
      'Gandalf replied quickly.',
    ].join('\n');

    const candidates = reg.learnFromText(text, 0.4);
    // Gandalf should be discovered as a person
    const gandalf = candidates.find(c => c.name === 'Gandalf');
    expect(gandalf).toBeDefined();
    expect(gandalf.type).toBe('person');
    expect(reg.people.Gandalf).toBeDefined();
    expect(reg.people.Gandalf.source).toBe('learned');
  });

  it('skips already known people', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Alice', relationship: 'friend' },
    ], []);

    const text = 'Alice said hello. Alice told Bob.';
    const candidates = reg.learnFromText(text, 0.5);
    const alice = candidates.find(c => c.name === 'Alice');
    expect(alice).toBeUndefined();
  });
});

// ── summary ─────────────────────────────────────────────────────────────────

describe('EntityRegistry — summary', () => {
  it('returns formatted summary', () => {
    const reg = EntityRegistry.load(tmpDir);
    reg.seed('personal', [
      { name: 'Riley', relationship: 'daughter' },
    ], ['MemPalace']);

    const s = reg.summary();
    expect(s).toContain('Mode: personal');
    expect(s).toContain('Riley');
    expect(s).toContain('MemPalace');
  });
});
