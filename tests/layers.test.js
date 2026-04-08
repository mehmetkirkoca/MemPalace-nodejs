import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Layer0, Layer1, Layer2, Layer3, MemoryStack } from '../src/layers.js';

// ---------------------------------------------------------------------------
// Layer 0 — Identity
// ---------------------------------------------------------------------------

describe('Layer0', () => {
  it('returns default text when identity file does not exist', () => {
    const l0 = new Layer0('/tmp/__nonexistent_identity__.txt');
    const text = l0.render();
    expect(text).toContain('No identity configured');
    expect(text).toContain('L0');
  });

  it('reads identity from file', () => {
    const tmpFile = path.join(os.tmpdir(), `mempalace_test_identity_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, '  I am Atlas, a personal AI assistant.  ');
    try {
      const l0 = new Layer0(tmpFile);
      expect(l0.render()).toBe('I am Atlas, a personal AI assistant.');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('caches identity text after first render', () => {
    const tmpFile = path.join(os.tmpdir(), `mempalace_test_identity_cache_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'Original');
    try {
      const l0 = new Layer0(tmpFile);
      expect(l0.render()).toBe('Original');
      fs.writeFileSync(tmpFile, 'Changed');
      expect(l0.render()).toBe('Original'); // cached
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('estimates tokens as length/4', () => {
    const tmpFile = path.join(os.tmpdir(), `mempalace_test_identity_tokens_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'A'.repeat(400));
    try {
      const l0 = new Layer0(tmpFile);
      expect(l0.tokenEstimate()).toBe(100);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// Mock VectorStore
// ---------------------------------------------------------------------------

function createMockStore({ getDocs = [], getMetas = [], queryDocs = [], queryMetas = [], queryDists = [], count = 0 } = {}) {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({
      ids: getDocs.map((_, i) => `id_${i}`),
      documents: getDocs,
      metadatas: getMetas,
    }),
    query: vi.fn().mockResolvedValue({
      ids: [queryDocs.map((_, i) => `id_${i}`)],
      documents: [queryDocs],
      metadatas: [queryMetas],
      distances: [queryDists],
    }),
    count: vi.fn().mockResolvedValue(count),
  };
}

// ---------------------------------------------------------------------------
// Layer 1 — Essential Story
// ---------------------------------------------------------------------------

describe('Layer1', () => {
  it('returns fallback when no store provided', async () => {
    const l1 = new Layer1();
    const text = await l1.generate();
    expect(text).toContain('No palace found');
  });

  it('returns no memories message when store is empty', async () => {
    const store = createMockStore();
    const l1 = new Layer1({ store });
    const text = await l1.generate();
    expect(text).toContain('No memories yet');
  });

  it('generates essential story from drawers', async () => {
    const docs = ['Memory about love', 'Memory about code', 'Memory about family'];
    const metas = [
      { room: 'emotions', importance: 5, source_file: '/data/journal.txt' },
      { room: 'technical', importance: 2, source_file: '/data/code.py' },
      { room: 'family', importance: 4, source_file: '' },
    ];
    const store = createMockStore({ getDocs: docs, getMetas: metas });
    const l1 = new Layer1({ store });
    const text = await l1.generate();

    expect(text).toContain('ESSENTIAL STORY');
    expect(text).toContain('[emotions]');
    expect(text).toContain('Memory about love');
    expect(text).toContain('(journal.txt)');
  });

  it('sorts by importance descending', async () => {
    const docs = ['Low importance', 'High importance'];
    const metas = [
      { room: 'a', importance: 1 },
      { room: 'a', importance: 10 },
    ];
    const store = createMockStore({ getDocs: docs, getMetas: metas });
    const l1 = new Layer1({ store });
    const text = await l1.generate();

    const highIdx = text.indexOf('High importance');
    const lowIdx = text.indexOf('Low importance');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('truncates long snippets to 200 chars', async () => {
    const longDoc = 'X'.repeat(300);
    const store = createMockStore({
      getDocs: [longDoc],
      getMetas: [{ room: 'general' }],
    });
    const l1 = new Layer1({ store });
    const text = await l1.generate();
    expect(text).toContain('...');
    // The snippet should be at most 200 chars
    const lines = text.split('\n');
    const snippetLine = lines.find((l) => l.includes('XXX'));
    // 197 X's + '...' = 200 chars in the snippet part
    expect(snippetLine.includes('X'.repeat(198))).toBe(false);
  });

  it('respects MAX_CHARS limit', async () => {
    // Each snippet will be truncated to 200 chars, plus prefix "  - " = ~204 chars each
    // 15 entries * 204 = 3060 which is close. Use 200-char docs to hit the limit.
    const docs = Array.from({ length: 15 }, (_, i) => 'M'.repeat(250) + ` memory ${i}`);
    const metas = docs.map(() => ({ room: `room_${Math.random().toString(36).slice(2, 5)}`, importance: 5 }));
    const store = createMockStore({ getDocs: docs, getMetas: metas });
    const l1 = new Layer1({ store });
    const text = await l1.generate();

    expect(text).toContain('more in L3 search');
  });

  it('filters by wing when set', async () => {
    const store = createMockStore({ getDocs: ['hello'], getMetas: [{ room: 'r' }] });
    const l1 = new Layer1({ store, wing: 'my_app' });
    await l1.generate();

    expect(store.get).toHaveBeenCalledWith(
      expect.objectContaining({ where: { wing: 'my_app' } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — On-Demand
// ---------------------------------------------------------------------------

describe('Layer2', () => {
  it('returns fallback when no store provided', async () => {
    const l2 = new Layer2();
    const text = await l2.retrieve({ wing: 'test' });
    expect(text).toBe('No palace found.');
  });

  it('returns no drawers message when empty', async () => {
    const store = createMockStore();
    const l2 = new Layer2({ store });
    const text = await l2.retrieve({ wing: 'test' });
    expect(text).toContain('No drawers found');
    expect(text).toContain('wing=test');
  });

  it('retrieves drawers with wing filter', async () => {
    const docs = ['Doc 1', 'Doc 2'];
    const metas = [
      { room: 'room_a', source_file: '/data/a.txt' },
      { room: 'room_b', source_file: '' },
    ];
    const store = createMockStore({ getDocs: docs, getMetas: metas });
    const l2 = new Layer2({ store });
    const text = await l2.retrieve({ wing: 'emotions' });

    expect(text).toContain('ON-DEMAND');
    expect(text).toContain('2 drawers');
    expect(text).toContain('[room_a]');
    expect(text).toContain('Doc 1');
  });

  it('builds correct where filter for wing + room', async () => {
    const store = createMockStore();
    const l2 = new Layer2({ store });
    await l2.retrieve({ wing: 'w', room: 'r' });

    expect(store.get).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { $and: [{ wing: 'w' }, { room: 'r' }] },
      }),
    );
  });

  it('handles retrieval error gracefully', async () => {
    const store = createMockStore();
    store.get.mockRejectedValue(new Error('connection lost'));
    const l2 = new Layer2({ store });
    const text = await l2.retrieve({ wing: 'w' });
    expect(text).toContain('Retrieval error');
    expect(text).toContain('connection lost');
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Deep Search
// ---------------------------------------------------------------------------

describe('Layer3', () => {
  it('returns fallback when no store provided', async () => {
    const l3 = new Layer3();
    const text = await l3.search('test query');
    expect(text).toBe('No palace found.');
  });

  it('returns no results message when empty', async () => {
    const store = createMockStore();
    const l3 = new Layer3({ store });
    const text = await l3.search('test query');
    expect(text).toBe('No results found.');
  });

  it('returns formatted search results', async () => {
    const docs = ['Found memory about pricing'];
    const metas = [{ wing: 'technical', room: 'billing', source_file: '/data/pricing.txt' }];
    const dists = [0.2];
    const store = createMockStore({ queryDocs: docs, queryMetas: metas, queryDists: dists });
    const l3 = new Layer3({ store });
    const text = await l3.search('pricing');

    expect(text).toContain('SEARCH RESULTS for "pricing"');
    expect(text).toContain('technical/billing');
    expect(text).toContain('sim=0.8');
    expect(text).toContain('Found memory about pricing');
    expect(text).toContain('src: pricing.txt');
  });

  it('searchRaw returns array of hit objects', async () => {
    const docs = ['Doc 1'];
    const metas = [{ wing: 'w', room: 'r', source_file: '/x/y.txt' }];
    const dists = [0.1];
    const store = createMockStore({ queryDocs: docs, queryMetas: metas, queryDists: dists });
    const l3 = new Layer3({ store });
    const hits = await l3.searchRaw('test');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      text: 'Doc 1',
      wing: 'w',
      room: 'r',
      source_file: 'y.txt',
      similarity: 0.9,
    });
    expect(hits[0].metadata).toBeDefined();
  });

  it('searchRaw returns empty array on error', async () => {
    const store = createMockStore();
    store.query.mockRejectedValue(new Error('fail'));
    const l3 = new Layer3({ store });
    const hits = await l3.searchRaw('test');
    expect(hits).toEqual([]);
  });

  it('handles search error gracefully', async () => {
    const store = createMockStore();
    store.query.mockRejectedValue(new Error('timeout'));
    const l3 = new Layer3({ store });
    const text = await l3.search('test');
    expect(text).toContain('Search error');
    expect(text).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// MemoryStack — unified interface
// ---------------------------------------------------------------------------

describe('MemoryStack', () => {
  it('wakeUp combines L0 + L1', async () => {
    const tmpFile = path.join(os.tmpdir(), `mempalace_test_stack_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, 'I am Atlas.');
    try {
      const store = createMockStore({
        getDocs: ['Important memory'],
        getMetas: [{ room: 'core', importance: 5 }],
      });
      const stack = new MemoryStack({ identityPath: tmpFile, store });
      const text = await stack.wakeUp();

      expect(text).toContain('I am Atlas.');
      expect(text).toContain('ESSENTIAL STORY');
      expect(text).toContain('Important memory');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('recall delegates to L2', async () => {
    const store = createMockStore({
      getDocs: ['Drawer content'],
      getMetas: [{ room: 'billing', source_file: '' }],
    });
    const stack = new MemoryStack({
      identityPath: '/tmp/__nonexistent__.txt',
      store,
    });
    const text = await stack.recall({ wing: 'technical' });

    expect(text).toContain('ON-DEMAND');
    expect(text).toContain('Drawer content');
  });

  it('search delegates to L3', async () => {
    const store = createMockStore({
      queryDocs: ['Pricing doc'],
      queryMetas: [{ wing: 'w', room: 'r', source_file: '' }],
      queryDists: [0.15],
    });
    const stack = new MemoryStack({
      identityPath: '/tmp/__nonexistent__.txt',
      store,
    });
    const text = await stack.search('pricing');

    expect(text).toContain('SEARCH RESULTS');
    expect(text).toContain('Pricing doc');
  });

  it('status returns layer info and drawer count', async () => {
    const store = createMockStore({ count: 42 });
    const stack = new MemoryStack({
      identityPath: '/tmp/__nonexistent__.txt',
      store,
    });
    const s = await stack.status();

    expect(s.L0_identity).toBeDefined();
    expect(s.L0_identity.exists).toBe(false);
    expect(s.total_drawers).toBe(42);
    expect(s.L1_essential).toBeDefined();
    expect(s.L2_on_demand).toBeDefined();
    expect(s.L3_deep_search).toBeDefined();
  });

  it('status returns 0 drawers on error', async () => {
    const store = createMockStore();
    store.count.mockRejectedValue(new Error('fail'));
    const stack = new MemoryStack({
      identityPath: '/tmp/__nonexistent__.txt',
      store,
    });
    const s = await stack.status();
    expect(s.total_drawers).toBe(0);
  });
});
