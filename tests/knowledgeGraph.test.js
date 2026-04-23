import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph } from '../src/knowledgeGraph.js';

describe('KnowledgeGraph', () => {
  let kg;

  beforeEach(async () => {
    kg = new KnowledgeGraph(`test_kg_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    await kg.clear();
  });

  afterEach(async () => {
    await kg.clear();
    await kg.close();
  });

  it('should normalize entity names via _entityId', () => {
    expect(kg._entityId('Max')).toBe('max');
    expect(kg._entityId('Alice Smith')).toBe('alice_smith');
    expect(kg._entityId("O'Brien")).toBe('obrien');
    expect(kg._entityId('Mary Jane Watson')).toBe('mary_jane_watson');
  });

  it('should add and query an entity', async () => {
    const eid = await kg.addEntity('Max', 'person', { age: 10 });
    expect(eid).toBe('max');

    const entity = await kg.getEntity('Max');
    expect(entity).not.toBeNull();
    expect(entity.name).toBe('Max');
    expect(entity.type).toBe('person');
    expect(JSON.parse(entity.properties)).toEqual({ age: 10 });
  });

  it('should add and query a triple', async () => {
    await kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });

    const results = await kg.queryEntity('Max');
    expect(results.length).toBe(1);
    expect(results[0].predicate).toBe('child_of');
    expect(results[0].object).toBe('Alice');
    expect(results[0].validFrom).toBe('2015-04-01');
    expect(results[0].activeNow).toBe(true);
    expect(results[0].activeAsOf).toBe(true);
  });

  it('should invalidate a triple', async () => {
    await kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    await kg.invalidate('Max', 'does', 'swimming', '2026-02-15');

    const results = await kg.queryEntity('Max');
    expect(results.length).toBe(1);
    expect(results[0].validTo).toBe('2026-02-15');
    expect(results[0].activeNow).toBe(false);
    expect(results[0].activeAsOf).toBe(false);
  });

  it('should filter by temporal asOf parameter', async () => {
    await kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    await kg.addTriple('Max', 'loves', 'chess', { validFrom: '2025-06-01' });
    await kg.invalidate('Max', 'does', 'swimming', '2025-03-01');

    const feb = await kg.queryEntity('Max', { asOf: '2025-02-01' });
    expect(feb.length).toBe(1);
    expect(feb[0].predicate).toBe('does');

    const jul = await kg.queryEntity('Max', { asOf: '2025-07-01' });
    expect(jul.length).toBe(1);
    expect(jul[0].predicate).toBe('loves');
  });

  it('should return timeline in chronological order', async () => {
    await kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });
    await kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    await kg.addTriple('Max', 'loves', 'chess', { validFrom: '2025-06-01' });

    const tl = await kg.timeline('Max');
    expect(tl.length).toBe(3);
    expect(tl[0].validFrom).toBe('2015-04-01');
    expect(tl[1].validFrom).toBe('2025-01-01');
    expect(tl[2].validFrom).toBe('2025-06-01');
  });

  it('should return stats', async () => {
    await kg.addTriple('Max', 'child_of', 'Alice', { validFrom: '2015-04-01' });
    await kg.addTriple('Max', 'does', 'swimming', { validFrom: '2025-01-01' });
    await kg.invalidate('Max', 'does', 'swimming', '2026-02-15');

    const s = await kg.stats();
    expect(s.entities).toBe(3);
    expect(s.triples).toBe(2);
    expect(s.currentFacts).toBe(1);
    expect(s.expiredFacts).toBe(1);
    expect(s.relationshipTypes).toContain('child_of');
    expect(s.relationshipTypes).toContain('does');
  });

  it('should auto-create entities when adding a triple', async () => {
    await kg.addTriple('Max', 'child_of', 'Alice');

    const max = await kg.getEntity('Max');
    const alice = await kg.getEntity('Alice');
    expect(max).not.toBeNull();
    expect(alice).not.toBeNull();
    expect(max.name).toBe('Max');
    expect(alice.name).toBe('Alice');
  });

  it('should support direction parameter in queryEntity', async () => {
    await kg.addTriple('Max', 'child_of', 'Alice');
    await kg.addTriple('Max', 'loves', 'chess');

    const outgoing = await kg.queryEntity('Max', { direction: 'outgoing' });
    expect(outgoing.length).toBe(2);
    expect(outgoing.every((r) => r.direction === 'outgoing')).toBe(true);

    const incoming = await kg.queryEntity('Alice', { direction: 'incoming' });
    expect(incoming.length).toBe(1);
    expect(incoming[0].direction).toBe('incoming');
    expect(incoming[0].subject).toBe('Max');

    const both = await kg.queryEntity('Alice', { direction: 'both' });
    expect(both.length).toBeGreaterThanOrEqual(1);
  });

  it('should return existing triple ID for duplicates', async () => {
    const id1 = await kg.addTriple('Max', 'child_of', 'Alice');
    const id2 = await kg.addTriple('Max', 'child_of', 'Alice');
    expect(id1).toBe(id2);
  });
});
