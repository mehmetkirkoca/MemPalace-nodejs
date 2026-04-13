/**
 * kuzuGraph.js — MemPalace topology layer (Kuzu embedded graph DB)
 * =================================================================
 *
 * Kuzu provides an embedded graph DB with Cypher queries.
 * Zero extra service — runs in-process.
 *
 * Layer responsibilities:
 *   Qdrant  → Semantic: content + embeddings + cosine search
 *   Kuzu    → Topology: palace/room/hall/drawer connections + tunnels
 *   SQLite  → Temporal: entity triples, valid_from/to
 *
 * Hierarchy: palace → room → hall → drawer  (wing removed)
 *
 * Cross-palace tunnel: same room slug in 2+ palaces = tunnel (detected via Cypher query, no stored edge needed).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _kuzu;
try {
  _kuzu = require('kuzu');
} catch {
  // kuzu not installed — graceful fallback (dev environments without native build)
  _kuzu = null;
}

const { Database, Connection } = _kuzu || {};

export class KuzuGraph {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.conn = null;
    this._ready = null;
  }

  /**
   * Lazy init — creates schema on first call. Idempotent.
   */
  async init() {
    if (this._ready) return this._ready;
    this._ready = this._doInit();
    return this._ready;
  }

  async _doInit() {
    if (!Database || !Connection) {
      console.warn('[KuzuGraph] kuzu package not installed — graph features disabled');
      return;
    }

    this.db = new Database(this.dbPath);
    this.conn = new Connection(this.db);

    // Node tables — use try/catch as Kuzu has no IF NOT EXISTS
    const nodeSchemas = [
      `CREATE NODE TABLE Palace(
        name STRING,
        description STRING,
        scope STRING,
        is_default BOOLEAN,
        PRIMARY KEY (name)
      )`,
      `CREATE NODE TABLE Room(
        slug STRING,
        drawer_count INT64,
        PRIMARY KEY (slug)
      )`,
      `CREATE NODE TABLE Hall(
        id STRING,
        PRIMARY KEY (id)
      )`,
      `CREATE NODE TABLE Drawer(
        id STRING,
        importance INT64,
        filed_at STRING,
        PRIMARY KEY (id)
      )`,
    ];

    // Edge tables
    const edgeSchemas = [
      `CREATE REL TABLE HAS_ROOM(FROM Palace TO Room, MANY_MANY)`,
      `CREATE REL TABLE IN_HALL(FROM Room TO Hall, MANY_MANY)`,
      `CREATE REL TABLE HAS_DRAWER(FROM Room TO Drawer, MANY_MANY)`,
    ];

    for (const sql of [...nodeSchemas, ...edgeSchemas]) {
      try {
        await this.conn.query(sql);
      } catch (e) {
        // "already exists" — expected on subsequent inits
        if (!e.message?.includes('already exists') && !e.message?.includes('Already Exists')) {
          console.warn('[KuzuGraph] schema warning:', e.message);
        }
      }
    }

    // Seed the 5 fixed hall nodes
    const halls = ['hall_facts', 'hall_events', 'hall_preferences', 'hall_discoveries', 'hall_advice'];
    for (const h of halls) {
      await this._mergeHall(h);
    }
  }

  /**
   * Upsert a palace node.
   * @param {{ name, description, scope, is_default }} palace
   */
  async mergePalace(palace) {
    await this.init();
    if (!this.conn) return;

    const { name, description = '', scope = '', is_default = false } = palace;

    const existing = await this.conn.query(
      `MATCH (p:Palace {name: '${_esc(name)}'}) RETURN p.name`
    );
    const rows = await existing.getAll();
    if (rows.length === 0) {
      await this.conn.query(
        `CREATE (:Palace {name: '${_esc(name)}', description: '${_esc(description)}', scope: '${_esc(scope)}', is_default: ${is_default}})`
      );
    } else {
      await this.conn.query(
        `MATCH (p:Palace {name: '${_esc(name)}'}) SET p.description = '${_esc(description)}', p.scope = '${_esc(scope)}', p.is_default = ${is_default}`
      );
    }
  }

  /**
   * Upsert a room node + Palace→Room edge + Room→Hall edge.
   * @param {string} palaceName
   * @param {string} roomSlug
   * @param {string} hallId  — e.g. 'hall_facts'
   */
  async mergeRoom(palaceName, roomSlug, hallId) {
    await this.init();
    if (!this.conn) return;

    // Room node
    const existing = await this.conn.query(
      `MATCH (r:Room {slug: '${_esc(roomSlug)}'}) RETURN r.slug`
    );
    if ((await existing.getAll()).length === 0) {
      await this.conn.query(
        `CREATE (:Room {slug: '${_esc(roomSlug)}', drawer_count: 0})`
      );
    }

    // Palace → Room edge
    const palaceEdge = await this.conn.query(
      `MATCH (p:Palace {name: '${_esc(palaceName)}'})-[:HAS_ROOM]->(r:Room {slug: '${_esc(roomSlug)}'}) RETURN r.slug`
    );
    if ((await palaceEdge.getAll()).length === 0) {
      await this.conn.query(
        `MATCH (p:Palace {name: '${_esc(palaceName)}'}), (r:Room {slug: '${_esc(roomSlug)}'}) CREATE (p)-[:HAS_ROOM]->(r)`
      );
    }

    // Room → Hall edge
    if (hallId) {
      await this._mergeHall(hallId);
      const hallEdge = await this.conn.query(
        `MATCH (r:Room {slug: '${_esc(roomSlug)}'})-[:IN_HALL]->(h:Hall {id: '${_esc(hallId)}'}) RETURN h.id`
      );
      if ((await hallEdge.getAll()).length === 0) {
        await this.conn.query(
          `MATCH (r:Room {slug: '${_esc(roomSlug)}'}), (h:Hall {id: '${_esc(hallId)}'}) CREATE (r)-[:IN_HALL]->(h)`
        );
      }
    }
  }

  /**
   * Upsert a drawer node + Room→Drawer edge + increment drawer_count.
   * @param {string} palaceName
   * @param {string} roomSlug
   * @param {string} hallId
   * @param {string} drawerId  — Qdrant point ID
   * @param {number} importance
   */
  async mergeDrawer(palaceName, roomSlug, hallId, drawerId, importance = 3) {
    await this.init();
    if (!this.conn) return;

    // Ensure room + connections exist first
    await this.mergeRoom(palaceName, roomSlug, hallId);

    const filedAt = new Date().toISOString();

    // Drawer node
    const existing = await this.conn.query(
      `MATCH (d:Drawer {id: '${_esc(drawerId)}'}) RETURN d.id`
    );
    if ((await existing.getAll()).length === 0) {
      await this.conn.query(
        `CREATE (:Drawer {id: '${_esc(drawerId)}', importance: ${importance}, filed_at: '${filedAt}'})`
      );
    }

    // Room → Drawer edge
    const edge = await this.conn.query(
      `MATCH (r:Room {slug: '${_esc(roomSlug)}'})-[:HAS_DRAWER]->(d:Drawer {id: '${_esc(drawerId)}'}) RETURN d.id`
    );
    if ((await edge.getAll()).length === 0) {
      await this.conn.query(
        `MATCH (r:Room {slug: '${_esc(roomSlug)}'}), (d:Drawer {id: '${_esc(drawerId)}'}) CREATE (r)-[:HAS_DRAWER]->(d)`
      );
      await this.conn.query(
        `MATCH (r:Room {slug: '${_esc(roomSlug)}'}) SET r.drawer_count = r.drawer_count + 1`
      );
    }
  }

  /**
   * Remove a drawer from the graph.
   * @param {string} drawerId
   */
  async deleteDrawer(drawerId) {
    await this.init();
    if (!this.conn) return;

    try {
      await this.conn.query(
        `MATCH (d:Drawer {id: '${_esc(drawerId)}'}) DETACH DELETE d`
      );
    } catch {
      // Not found — silently ignore
    }
  }

  /**
   * Cross-palace tunnels: same room slug in 2+ palaces = tunnel.
   * @param {string|null} palaceA  — null returns all tunnels
   * @param {string|null} palaceB
   * @returns {Array<{ tunnel: string, palace_a: string, palace_b: string }>}
   */
  async findTunnels(palaceA = null, palaceB = null) {
    await this.init();
    if (!this.conn) return [];

    let query;
    if (palaceA && palaceB) {
      query = `
        MATCH (p1:Palace {name: '${_esc(palaceA)}'})-[:HAS_ROOM]->(r:Room)<-[:HAS_ROOM]-(p2:Palace {name: '${_esc(palaceB)}'})
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel
      `;
    } else if (palaceA) {
      query = `
        MATCH (p1:Palace {name: '${_esc(palaceA)}'})-[:HAS_ROOM]->(r:Room)<-[:HAS_ROOM]-(p2:Palace)
        WHERE p1.name <> p2.name
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel
      `;
    } else {
      query = `
        MATCH (p1:Palace)-[:HAS_ROOM]->(r:Room)<-[:HAS_ROOM]-(p2:Palace)
        WHERE p1.name < p2.name
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel
      `;
    }

    const result = await this.conn.query(query);
    return await result.getAll();
  }

  /**
   * BFS traversal from a starting room. Follows same-palace neighbors and cross-palace tunnels.
   * @param {string} startRoom
   * @param {number} maxHops
   * @returns {Array<{ slug: string, distance: number, palace: string, via_tunnel?: boolean }>}
   */
  async traverse(startRoom, maxHops = 3) {
    await this.init();
    if (!this.conn) return [];

    const palacesResult = await this.conn.query(
      `MATCH (p:Palace)-[:HAS_ROOM]->(r:Room {slug: '${_esc(startRoom)}'}) RETURN p.name AS palace`
    );
    const palaceRows = await palacesResult.getAll();
    if (palaceRows.length === 0) return [];

    const visited = new Set([startRoom]);
    const frontier = [startRoom];
    const results = [];

    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const nextFrontier = [];

      for (const currentSlug of frontier) {
        // Same-palace neighbors
        const neighborResult = await this.conn.query(
          `MATCH (p:Palace)-[:HAS_ROOM]->(r1:Room {slug: '${_esc(currentSlug)}'})
           MATCH (p)-[:HAS_ROOM]->(r2:Room)
           WHERE r2.slug <> '${_esc(currentSlug)}'
           RETURN DISTINCT r2.slug AS slug, p.name AS palace`
        );
        const neighbors = await neighborResult.getAll();
        for (const { slug, palace } of neighbors) {
          if (!visited.has(slug)) {
            visited.add(slug);
            nextFrontier.push(slug);
            results.push({ slug, distance: hop, palace });
          }
        }

        // Cross-palace tunnel neighbors
        const tunnelResult = await this.conn.query(
          `MATCH (p1:Palace)-[:HAS_ROOM]->(r:Room {slug: '${_esc(currentSlug)}'})<-[:HAS_ROOM]-(p2:Palace)
           WHERE p1.name <> p2.name
           MATCH (p2)-[:HAS_ROOM]->(r2:Room)
           WHERE r2.slug <> '${_esc(currentSlug)}'
           RETURN DISTINCT r2.slug AS slug, p2.name AS palace`
        );
        const tunnelNeighbors = await tunnelResult.getAll();
        for (const { slug, palace } of tunnelNeighbors) {
          if (!visited.has(slug)) {
            visited.add(slug);
            nextFrontier.push(slug);
            results.push({ slug, distance: hop, palace, via_tunnel: true });
          }
        }
      }

      frontier.length = 0;
      frontier.push(...nextFrontier);
    }

    return results;
  }

  /**
   * Overall graph statistics.
   * @returns {{ palaces: number, rooms: number, drawers: number, tunnels: number, rooms_per_palace: Object }}
   */
  async graphStats() {
    await this.init();
    if (!this.conn) return { palaces: 0, rooms: 0, drawers: 0, tunnels: 0, rooms_per_palace: {} };

    const [palacesRes, roomsRes, drawersRes, tunnelsRes, perPalaceRes] = await Promise.all([
      this.conn.query('MATCH (p:Palace) RETURN count(p) AS cnt'),
      this.conn.query('MATCH (r:Room) RETURN count(r) AS cnt'),
      this.conn.query('MATCH (d:Drawer) RETURN count(d) AS cnt'),
      this.conn.query(`
        MATCH (p1:Palace)-[:HAS_ROOM]->(r:Room)<-[:HAS_ROOM]-(p2:Palace)
        WHERE p1.name < p2.name
        RETURN count(DISTINCT r.slug) AS cnt
      `),
      this.conn.query(`
        MATCH (p:Palace)-[:HAS_ROOM]->(r:Room)
        RETURN p.name AS palace, count(r) AS room_count
        ORDER BY room_count DESC
      `),
    ]);

    const palaces = (await palacesRes.getAll())[0]?.cnt || 0;
    const rooms = (await roomsRes.getAll())[0]?.cnt || 0;
    const drawers = (await drawersRes.getAll())[0]?.cnt || 0;
    const tunnels = (await tunnelsRes.getAll())[0]?.cnt || 0;
    const perPalace = await perPalaceRes.getAll();

    const rooms_per_palace = Object.fromEntries(
      perPalace.map(r => [r.palace, r.room_count])
    );

    return { palaces, rooms, drawers, tunnels, rooms_per_palace };
  }

  // --- private ---

  async _mergeHall(hallId) {
    const existing = await this.conn.query(
      `MATCH (h:Hall {id: '${_esc(hallId)}'}) RETURN h.id`
    );
    if ((await existing.getAll()).length === 0) {
      await this.conn.query(
        `CREATE (:Hall {id: '${_esc(hallId)}'})`
      );
    }
  }
}

/**
 * Escape single quotes and backslashes for Kuzu string literals.
 * @param {string} str
 * @returns {string}
 */
function _esc(str) {
  if (str == null) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
