import { describe, it, expect, vi } from 'vitest';
import { buildWhereFilter, search, searchMemories } from '../src/searcher.js';

describe('buildWhereFilter', () => {
  it('should return empty object when no wing or room', () => {
    expect(buildWhereFilter({})).toEqual({});
  });

  it('should return wing filter only', () => {
    expect(buildWhereFilter({ wing: 'emotions' })).toEqual({ wing: 'emotions' });
  });

  it('should return room filter only', () => {
    expect(buildWhereFilter({ room: 'cities' })).toEqual({ room: 'cities' });
  });

  it('should return $and filter for wing + room', () => {
    expect(buildWhereFilter({ wing: 'emotions', room: 'cities' })).toEqual({
      $and: [{ wing: 'emotions' }, { room: 'cities' }],
    });
  });
});

describe('searchMemories', () => {
  it('should return correct structure with results', async () => {
    const mockStore = {
      query: vi.fn().mockResolvedValue({
        ids: [['id1', 'id2']],
        documents: [['doc text 1', 'doc text 2']],
        metadatas: [[
          { wing: 'tech', room: 'code', source_file: '/path/to/file.md' },
          { wing: 'tech', room: 'debug', source_file: '/other/file.txt' },
        ]],
        distances: [[0.85, 0.72]],
      }),
    };

    const result = await searchMemories('test query', mockStore, { nResults: 5 });

    expect(result).toHaveProperty('query', 'test query');
    expect(result).toHaveProperty('filters');
    expect(result).toHaveProperty('results');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      text: 'doc text 1',
      wing: 'tech',
      room: 'code',
      source_file: 'file.md',
      similarity: 0.15,
    });
  });

  it('should apply wing filter', async () => {
    const mockStore = {
      query: vi.fn().mockResolvedValue({
        ids: [[]],
        documents: [[]],
        metadatas: [[]],
        distances: [[]],
      }),
    };

    await searchMemories('test', mockStore, { wing: 'emotions' });

    expect(mockStore.query).toHaveBeenCalledWith({
      queryTexts: ['test'],
      nResults: 5,
      where: { wing: 'emotions' },
    });
  });

  it('should apply combined wing+room filter', async () => {
    const mockStore = {
      query: vi.fn().mockResolvedValue({
        ids: [[]],
        documents: [[]],
        metadatas: [[]],
        distances: [[]],
      }),
    };

    await searchMemories('test', mockStore, { wing: 'tech', room: 'code' });

    expect(mockStore.query).toHaveBeenCalledWith({
      queryTexts: ['test'],
      nResults: 5,
      where: { $and: [{ wing: 'tech' }, { room: 'code' }] },
    });
  });

  it('should return error object when store query fails', async () => {
    const mockStore = {
      query: vi.fn().mockRejectedValue(new Error('connection failed')),
    };

    const result = await searchMemories('test', mockStore);
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('connection failed');
  });
});

describe('search', () => {
  it('should print results to console', async () => {
    const mockStore = {
      query: vi.fn().mockResolvedValue({
        ids: [['id1']],
        documents: [['some verbatim text']],
        metadatas: [[{ wing: 'tech', room: 'code', source_file: '/a/b.md' }]],
        distances: [[0.8]],
      }),
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await search('test query', mockStore, { nResults: 3 });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('test query');
    expect(output).toContain('tech');
    expect(output).toContain('code');

    consoleSpy.mockRestore();
  });

  it('should print no results message when empty', async () => {
    const mockStore = {
      query: vi.fn().mockResolvedValue({
        ids: [[]],
        documents: [[]],
        metadatas: [[]],
        distances: [[]],
      }),
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await search('nonexistent', mockStore);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No results found');

    consoleSpy.mockRestore();
  });
});
