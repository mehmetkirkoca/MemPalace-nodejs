/**
 * palaceGraph.js — MemPalace graph traversal layer
 * =================================================
 *
 * VectorStore metadata'sından navigasyon grafiği oluşturur:
 *   - Nodes = room'lar (isimlendirilmiş fikirler)
 *   - Edges = wing'ler arası paylaşılan room'lar (tunnel'lar)
 *
 * Harici graph DB gerektirmez — VectorStore metadata'sından inşa edilir.
 */

/**
 * VectorStore metadata'sından palace grafiğini oluşturur.
 *
 * @param {object} store - VectorStore instance (count, get metodları)
 * @returns {{ nodes: object, edges: Array }} nodes ve edges
 */
export async function buildGraph(store) {
  const total = await store.count();
  if (total === 0) return { nodes: {}, edges: [] };

  const roomData = new Map();

  let offset = 0;
  while (offset < total) {
    const batch = await store.get({ limit: 1000, offset });
    for (const meta of batch.metadatas) {
      const room = meta.room || '';
      const wing = meta.wing || '';
      const hall = meta.hall || '';
      const date = meta.date || '';

      if (!room || room === 'general' || !wing) continue;

      if (!roomData.has(room)) {
        roomData.set(room, { wings: new Set(), halls: new Set(), count: 0, dates: new Set() });
      }

      const data = roomData.get(room);
      data.wings.add(wing);
      if (hall) data.halls.add(hall);
      if (date) data.dates.add(date);
      data.count += 1;
    }

    if (!batch.ids || batch.ids.length === 0) break;
    offset += batch.ids.length;
  }

  // Edge'leri oluştur: birden fazla wing'de bulunan room'lar
  const edges = [];
  for (const [room, data] of roomData) {
    const wings = [...data.wings].sort();
    if (wings.length >= 2) {
      for (let i = 0; i < wings.length; i++) {
        for (let j = i + 1; j < wings.length; j++) {
          for (const hall of data.halls) {
            edges.push({
              room,
              wing_a: wings[i],
              wing_b: wings[j],
              hall,
              count: data.count,
            });
          }
        }
      }
    }
  }

  // Set'leri array'e çevir (JSON uyumluluğu)
  const nodes = {};
  for (const [room, data] of roomData) {
    const sortedDates = [...data.dates].sort();
    nodes[room] = {
      wings: [...data.wings].sort(),
      halls: [...data.halls].sort(),
      count: data.count,
      dates: sortedDates.slice(-5),
    };
  }

  return { nodes, edges };
}

/**
 * Başlangıç room'undan BFS ile bağlı room'ları bulur.
 *
 * @param {string} startRoom - Başlangıç room adı
 * @param {object} store - VectorStore instance
 * @param {number} [maxHops=2] - Maksimum hop sayısı
 * @returns {Array|object} Bağlı room listesi veya hata objesi
 */
export async function traverse(startRoom, store, maxHops = 2) {
  const { nodes } = await buildGraph(store);

  if (!(startRoom in nodes)) {
    return {
      error: `Room '${startRoom}' not found`,
      suggestions: _fuzzyMatch(startRoom, nodes),
    };
  }

  const start = nodes[startRoom];
  const visited = new Set([startRoom]);
  const results = [
    {
      room: startRoom,
      wings: start.wings,
      halls: start.halls,
      count: start.count,
      hop: 0,
    },
  ];

  // BFS traversal
  const frontier = [[startRoom, 0]];
  while (frontier.length > 0) {
    const [currentRoom, depth] = frontier.shift();
    if (depth >= maxHops) continue;

    const current = nodes[currentRoom] || {};
    const currentWings = new Set(current.wings || []);

    // Mevcut room ile wing paylaşan tüm room'ları bul
    for (const [room, data] of Object.entries(nodes)) {
      if (visited.has(room)) continue;

      const sharedWings = data.wings.filter((w) => currentWings.has(w));
      if (sharedWings.length > 0) {
        visited.add(room);
        results.push({
          room,
          wings: data.wings,
          halls: data.halls,
          count: data.count,
          hop: depth + 1,
          connected_via: sharedWings.sort(),
        });
        if (depth + 1 < maxHops) {
          frontier.push([room, depth + 1]);
        }
      }
    }
  }

  // Hop mesafesine göre, sonra count'a göre sırala
  results.sort((a, b) => a.hop - b.hop || b.count - a.count);
  return results.slice(0, 50);
}

/**
 * İki wing arasındaki tunnel room'larını bulur.
 *
 * @param {object} store - VectorStore instance
 * @param {string} [wingA] - İlk wing filtresi
 * @param {string} [wingB] - İkinci wing filtresi
 * @returns {Array} Tunnel room listesi
 */
export async function findTunnels(store, wingA = null, wingB = null) {
  const { nodes } = await buildGraph(store);

  const tunnels = [];
  for (const [room, data] of Object.entries(nodes)) {
    if (data.wings.length < 2) continue;

    if (wingA && !data.wings.includes(wingA)) continue;
    if (wingB && !data.wings.includes(wingB)) continue;

    tunnels.push({
      room,
      wings: data.wings,
      halls: data.halls,
      count: data.count,
      recent: data.dates.length > 0 ? data.dates[data.dates.length - 1] : '',
    });
  }

  tunnels.sort((a, b) => b.count - a.count);
  return tunnels.slice(0, 50);
}

/**
 * Palace grafiği hakkında özet istatistikler.
 *
 * @param {object} store - VectorStore instance
 * @returns {object} İstatistik objesi
 */
export async function graphStats(store) {
  const { nodes, edges } = await buildGraph(store);

  const tunnelRooms = Object.values(nodes).filter((n) => n.wings.length >= 2).length;

  const wingCounts = {};
  for (const data of Object.values(nodes)) {
    for (const w of data.wings) {
      wingCounts[w] = (wingCounts[w] || 0) + 1;
    }
  }

  // Wing count'larını azalan sırala
  const sortedWingCounts = Object.fromEntries(
    Object.entries(wingCounts).sort((a, b) => b[1] - a[1]),
  );

  // Multi-wing room'ları wing sayısına göre sırala
  const topTunnels = Object.entries(nodes)
    .filter(([, d]) => d.wings.length >= 2)
    .sort((a, b) => b[1].wings.length - a[1].wings.length)
    .slice(0, 10)
    .map(([r, d]) => ({ room: r, wings: d.wings, count: d.count }));

  return {
    total_rooms: Object.keys(nodes).length,
    tunnel_rooms: tunnelRooms,
    total_edges: edges.length,
    rooms_per_wing: sortedWingCounts,
    top_tunnels: topTunnels,
  };
}

/**
 * Yaklaşık eşleşme ile room önerileri bulur.
 *
 * @param {string} query - Arama terimi
 * @param {object} nodes - Node objesi
 * @param {number} [n=5] - Maksimum öneri sayısı
 * @returns {Array<string>} Önerilen room isimleri
 */
function _fuzzyMatch(query, nodes, n = 5) {
  const queryLower = query.toLowerCase();
  const scored = [];

  for (const room of Object.keys(nodes)) {
    if (queryLower === room) continue; // exact match zaten bulunamadı
    if (room.includes(queryLower)) {
      scored.push([room, 1.0]);
    } else {
      const words = queryLower.split('-');
      if (words.some((word) => room.includes(word))) {
        scored.push([room, 0.5]);
      }
    }
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, n).map(([r]) => r);
}
