import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VectorStore } from '../src/vectorStore.js';

const testCollection = 'test_mempalace_' + Date.now();

describe('VectorStore', () => {
  let store;

  beforeAll(async () => {
    store = new VectorStore({
      qdrantUrl: 'http://localhost:6333',
      collectionName: testCollection,
    });
    await store.init();
  }, 60000);

  afterAll(async () => {
    if (store) {
      await store.deleteCollection();
    }
  }, 60000);

  it('should add documents with metadata', async () => {
    await store.add({
      ids: ['drawer_1', 'drawer_2', 'drawer_3'],
      documents: [
        'İstanbul büyük bir şehirdir',
        'Ankara Türkiye\'nin başkentidir',
        'Python programlama dili çok popülerdir',
      ],
      metadatas: [
        { wing: 'geography', room: 'cities' },
        { wing: 'geography', room: 'capitals' },
        { wing: 'technology', room: 'programming' },
      ],
    });

    const cnt = await store.count();
    expect(cnt).toBe(3);
  }, 60000);

  it('should search by text similarity', async () => {
    const results = await store.query({
      queryTexts: ['şehir ve coğrafya'],
      nResults: 2,
    });

    expect(results).toBeDefined();
    expect(results.ids).toBeDefined();
    expect(results.ids[0].length).toBeLessThanOrEqual(2);
    // geography-related docs should rank higher
    expect(results.documents[0][0]).toMatch(/İstanbul|Ankara/);
  }, 60000);

  it('should filter by wing', async () => {
    const results = await store.query({
      queryTexts: ['bilgi'],
      nResults: 10,
      where: { wing: 'geography' },
    });

    expect(results.ids[0].length).toBeLessThanOrEqual(2);
    results.metadatas[0].forEach((m) => {
      expect(m.wing).toBe('geography');
    });
  }, 60000);

  it('should filter with $and', async () => {
    const results = await store.query({
      queryTexts: ['bilgi'],
      nResults: 10,
      where: { $and: [{ wing: 'geography' }, { room: 'capitals' }] },
    });

    expect(results.ids[0].length).toBe(1);
    expect(results.metadatas[0][0].room).toBe('capitals');
  }, 60000);

  it('should filter with $or', async () => {
    const results = await store.query({
      queryTexts: ['bilgi'],
      nResults: 10,
      where: { $or: [{ wing: 'geography' }, { wing: 'technology' }] },
    });

    expect(results.ids[0].length).toBe(3);
  }, 60000);

  it('should get by filter (scroll)', async () => {
    const results = await store.get({
      where: { wing: 'geography' },
      limit: 10,
    });

    expect(results.ids.length).toBe(2);
    results.metadatas.forEach((m) => {
      expect(m.wing).toBe('geography');
    });
  }, 60000);

  it('should delete by id', async () => {
    await store.delete({ ids: ['drawer_3'] });

    const cnt = await store.count();
    expect(cnt).toBe(2);
  }, 60000);

  it('should check duplicate', async () => {
    const isDup = await store.checkDuplicate('İstanbul büyük bir şehirdir', 0.9);
    expect(isDup).toBe(true);

    const isNotDup = await store.checkDuplicate('Kuantum fiziği çok karmaşıktır', 0.9);
    expect(isNotDup).toBe(false);
  }, 60000);
});
