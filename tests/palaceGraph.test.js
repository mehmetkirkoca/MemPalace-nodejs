import { describe, it, expect, vi } from 'vitest';
import { buildGraph, traverse, findTunnels, graphStats } from '../src/palaceGraph.js';

/**
 * Helper: mock bir VectorStore oluşturur.
 * metadatas dizisi verilir, count ve get mock'lanır.
 */
function mockStore(metadatas) {
  return {
    count: vi.fn().mockResolvedValue(metadatas.length),
    get: vi.fn().mockResolvedValue({
      ids: metadatas.map((_, i) => `id-${i}`),
      metadatas,
    }),
  };
}

// -- Ortak test verisi --
const sampleMetadatas = [
  { room: 'chromadb-setup', wing: 'wing_code', hall: 'databases', date: '2025-01-01' },
  { room: 'chromadb-setup', wing: 'wing_myproject', hall: 'databases', date: '2025-01-02' },
  { room: 'riley-college-apps', wing: 'wing_myproject', hall: 'education', date: '2025-02-01' },
  { room: 'gpu-architecture', wing: 'wing_hardware', hall: 'gpus', date: '2025-03-01' },
  { room: 'gpu-architecture', wing: 'wing_code', hall: 'gpus', date: '2025-03-02' },
  { room: 'gpu-architecture', wing: 'wing_hardware', hall: 'performance', date: '2025-03-03' },
  { room: 'general', wing: 'wing_code', hall: 'misc', date: '2025-01-01' }, // general filtrelenmeli
  { room: '', wing: 'wing_code', hall: 'misc', date: '2025-01-01' }, // boş room filtrelenmeli
  { room: 'solo-room', wing: 'wing_code', hall: '', date: '' }, // hall ve date boş
];

describe('buildGraph', () => {
  it('metadata verilerinden doğru node yapısı oluşturur', async () => {
    const store = mockStore(sampleMetadatas);
    const { nodes, edges } = await buildGraph(store);

    // "general" ve boş room filtrelenmeli
    expect(nodes).not.toHaveProperty('general');
    expect(Object.keys(nodes)).not.toContain('');

    // chromadb-setup: 2 wing, 1 hall, 2 kayıt
    expect(nodes['chromadb-setup']).toEqual({
      wings: ['wing_code', 'wing_myproject'],
      halls: ['databases'],
      count: 2,
      dates: ['2025-01-01', '2025-01-02'],
    });

    // gpu-architecture: 2 wing, 2 hall, 3 kayıt
    expect(nodes['gpu-architecture'].wings).toEqual(['wing_code', 'wing_hardware']);
    expect(nodes['gpu-architecture'].halls).toEqual(['gpus', 'performance']);
    expect(nodes['gpu-architecture'].count).toBe(3);

    // solo-room: hall ve date boş
    expect(nodes['solo-room'].halls).toEqual([]);
    expect(nodes['solo-room'].dates).toEqual([]);
  });

  it('birden fazla wing paylaşan room lardan edge oluşturur', async () => {
    const store = mockStore(sampleMetadatas);
    const { edges } = await buildGraph(store);

    // chromadb-setup: wing_code & wing_myproject, hall=databases -> 1 edge
    const chromaEdges = edges.filter((e) => e.room === 'chromadb-setup');
    expect(chromaEdges.length).toBe(1);
    expect(chromaEdges[0]).toMatchObject({
      room: 'chromadb-setup',
      wing_a: 'wing_code',
      wing_b: 'wing_myproject',
      hall: 'databases',
    });

    // gpu-architecture: wing_code & wing_hardware, 2 hall -> 2 edge
    const gpuEdges = edges.filter((e) => e.room === 'gpu-architecture');
    expect(gpuEdges.length).toBe(2);

    // riley-college-apps: tek wing -> edge yok
    const rileyEdges = edges.filter((e) => e.room === 'riley-college-apps');
    expect(rileyEdges.length).toBe(0);
  });

  it('boş store ile boş sonuç döner', async () => {
    const store = mockStore([]);
    const { nodes, edges } = await buildGraph(store);

    expect(nodes).toEqual({});
    expect(edges).toEqual([]);
  });
});

describe('traverse', () => {
  it('başlangıç room undan BFS ile bağlı room ları bulur', async () => {
    const store = mockStore(sampleMetadatas);
    const results = await traverse('chromadb-setup', store);

    // hop 0: chromadb-setup kendisi
    expect(results[0]).toMatchObject({ room: 'chromadb-setup', hop: 0 });

    // chromadb-setup -> wing_code & wing_myproject paylaşıyor
    // Bu wing lerdeki diğer room lar: riley-college-apps (wing_myproject), gpu-architecture (wing_code), solo-room (wing_code)
    const roomNames = results.map((r) => r.room);
    expect(roomNames).toContain('riley-college-apps');
    expect(roomNames).toContain('gpu-architecture');
    expect(roomNames).toContain('solo-room');
  });

  it('maxHops=1 ile sadece direkt komşuları döner', async () => {
    const store = mockStore(sampleMetadatas);
    const results = await traverse('riley-college-apps', store, 1);

    // riley sadece wing_myproject'te -> chromadb-setup da wing_myproject'te
    // maxHops=1 olduğu için hop=1 komşuları gelir ama hop=2 gelmez
    for (const r of results) {
      expect(r.hop).toBeLessThanOrEqual(1);
    }
  });

  it('bulunamayan room için hata ve öneri döner', async () => {
    const store = mockStore(sampleMetadatas);
    const result = await traverse('nonexistent-room', store);

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('nonexistent-room');
    expect(result).toHaveProperty('suggestions');
  });

  it('fuzzy match önerileri döner', async () => {
    const store = mockStore(sampleMetadatas);
    const result = await traverse('chromadb', store);

    expect(result.suggestions).toContain('chromadb-setup');
  });
});

describe('findTunnels', () => {
  it('birden fazla wing de bulunan room ları bulur', async () => {
    const store = mockStore(sampleMetadatas);
    const tunnels = await findTunnels(store);

    const tunnelRooms = tunnels.map((t) => t.room);
    expect(tunnelRooms).toContain('chromadb-setup');
    expect(tunnelRooms).toContain('gpu-architecture');
    expect(tunnelRooms).not.toContain('riley-college-apps');
    expect(tunnelRooms).not.toContain('solo-room');
  });

  it('belirli iki wing arasındaki tunnel ları filtreler', async () => {
    const store = mockStore(sampleMetadatas);
    const tunnels = await findTunnels(store, 'wing_code', 'wing_hardware');

    const tunnelRooms = tunnels.map((t) => t.room);
    expect(tunnelRooms).toContain('gpu-architecture');
    expect(tunnelRooms).not.toContain('chromadb-setup'); // chromadb wing_hardware'da değil
  });

  it('tek wing filtresi ile çalışır', async () => {
    const store = mockStore(sampleMetadatas);
    const tunnels = await findTunnels(store, 'wing_myproject');

    const tunnelRooms = tunnels.map((t) => t.room);
    expect(tunnelRooms).toContain('chromadb-setup');
  });

  it('count a göre sıralı döner', async () => {
    const store = mockStore(sampleMetadatas);
    const tunnels = await findTunnels(store);

    // gpu-architecture 3 kayıt, chromadb-setup 2 kayıt
    expect(tunnels[0].room).toBe('gpu-architecture');
    expect(tunnels[1].room).toBe('chromadb-setup');
  });
});

describe('graphStats', () => {
  it('doğru istatistikleri döner', async () => {
    const store = mockStore(sampleMetadatas);
    const stats = await graphStats(store);

    // 4 room: chromadb-setup, riley-college-apps, gpu-architecture, solo-room
    expect(stats.total_rooms).toBe(4);

    // 2 tunnel room: chromadb-setup (2 wing), gpu-architecture (2 wing)
    expect(stats.tunnel_rooms).toBe(2);

    // Edges: chromadb 1 + gpu 2 = 3
    expect(stats.total_edges).toBe(3);

    // rooms_per_wing
    expect(stats.rooms_per_wing).toHaveProperty('wing_code');
    expect(stats.rooms_per_wing['wing_code']).toBe(3); // chromadb, gpu, solo-room

    // top_tunnels sadece multi-wing room lar
    expect(stats.top_tunnels.length).toBe(2);
  });
});
