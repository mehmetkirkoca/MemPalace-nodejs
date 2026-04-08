import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KnowledgeGraph } from '../src/knowledgeGraph.js';

describe('KnowledgeGraph', () => {
  let kg;
  let dbPath;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
    dbPath = path.join(tmpDir, 'test_kg.sqlite3');
    kg = new KnowledgeGraph(dbPath);
  });

  afterEach(() => {
    kg.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      fs.rmdirSync(path.dirname(dbPath));
    }
  });

  // 1. _entityId normalization
  it('should normalize entity names via _entityId', () => {
    expect(kg._entityId('Max')).toBe('max');
    expect(kg._entityId('Alice Smith')).toBe('alice_smith');
    expect(kg._entityId("O'Brien")).toBe('obrien');
    expect(kg._entityId("Mary Jane Watson")).toBe('mary_jane_watson');
  });

  // 2. add and query entity
  it('should add and query an entity', () => {
    const eid = kg.addEntity('Max', 'person', { age: 10 });
    expect(eid).toBe('max');

    const entity = kg.getEntity('Max');
    expect(entity).not.toBeNull();
    expect(entity.name).toBe('Max');
    expect(entity.type).toBe('person');
    expect(JSON.parse(entity.properties)).toEqual({ age: 10 });
  });

  // 3. add and query triple
  it('should add and query a triple', () => {
    kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });

    const results = kg.queryEntity('Max');
    expect(results.length).toBe(1);
    expect(results[0].predicate).toBe('child_of');
    expect(results[0].object).toBe('Alice');
    expect(results[0].validFrom).toBe('2015-04-01');
    expect(results[0].current).toBe(true);
  });

  // 4. invalidate triple
  it('should invalidate a triple', () => {
    kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    kg.invalidate('Max', 'does', 'swimming', '2026-02-15');

    const results = kg.queryEntity('Max');
    expect(results.length).toBe(1);
    expect(results[0].validTo).toBe('2026-02-15');
    expect(results[0].current).toBe(false);
  });

  // 5. query with temporal filter (asOf)
  it('should filter by temporal asOf parameter', () => {
    kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    kg.addTriple('Max', 'loves', 'chess', { validFrom: '2025-06-01' });
    kg.invalidate('Max', 'does', 'swimming', '2025-03-01');

    // Query as of 2025-02-01: swimming still valid, chess not yet
    const feb = kg.queryEntity('Max', { asOf: '2025-02-01' });
    expect(feb.length).toBe(1);
    expect(feb[0].predicate).toBe('does');

    // Query as of 2025-07-01: swimming expired, chess valid
    const jul = kg.queryEntity('Max', { asOf: '2025-07-01' });
    expect(jul.length).toBe(1);
    expect(jul[0].predicate).toBe('loves');
  });

  // 6. return timeline
  it('should return timeline in chronological order', () => {
    kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });
    kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    kg.addTriple('Max', 'loves', 'chess', { validFrom: '2025-06-01' });

    const tl = kg.timeline('Max');
    expect(tl.length).toBe(3);
    expect(tl[0].validFrom).toBe('2015-04-01');
    expect(tl[1].validFrom).toBe('2025-01-01');
    expect(tl[2].validFrom).toBe('2025-06-01');
  });

  // 7. return stats
  it('should return stats', () => {
    kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });
    kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    kg.invalidate('Max', 'does', 'swimming', '2026-02-15');

    const s = kg.stats();
    expect(s.entities).toBe(3); // max, alice, swimming
    expect(s.triples).toBe(2);
    expect(s.currentFacts).toBe(1);
    expect(s.expiredFacts).toBe(1);
    expect(s.relationshipTypes).toContain('child_of');
    expect(s.relationshipTypes).toContain('does');
  });

  // 8. auto-create entities on addTriple
  it('should auto-create entities when adding a triple', () => {
    kg.addTriple('Max', 'child_of', 'Alice');

    const max = kg.getEntity('Max');
    const alice = kg.getEntity('Alice');
    expect(max).not.toBeNull();
    expect(alice).not.toBeNull();
    expect(max.name).toBe('Max');
    expect(alice.name).toBe('Alice');
  });

  // 9. query with direction (outgoing/incoming)
  it('should support direction parameter in queryEntity', () => {
    kg.addTriple('Max', 'child_of', 'Alice');
    kg.addTriple('Max', 'loves', 'chess');

    // Outgoing from Max
    const outgoing = kg.queryEntity('Max', { direction: 'outgoing' });
    expect(outgoing.length).toBe(2);
    expect(outgoing.every(r => r.direction === 'outgoing')).toBe(true);

    // Incoming to Alice
    const incoming = kg.queryEntity('Alice', { direction: 'incoming' });
    expect(incoming.length).toBe(1);
    expect(incoming[0].direction).toBe('incoming');
    expect(incoming[0].subject).toBe('Max');

    // Both for Alice
    const both = kg.queryEntity('Alice', { direction: 'both' });
    expect(both.length).toBeGreaterThanOrEqual(1);
  });

  // Duplicate triple should return existing ID
  it('should return existing triple ID for duplicates', () => {
    const id1 = kg.addTriple('Max', 'child_of', 'Alice');
    const id2 = kg.addTriple('Max', 'child_of', 'Alice');
    expect(id1).toBe(id2);
  });
});
