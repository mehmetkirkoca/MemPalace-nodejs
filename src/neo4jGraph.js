/**
 * neo4jGraph.js — MemPalace topology layer (Neo4j)
 * =================================================
 *
 * Replaces kuzuGraph.js. Same public API.
 * Uses the module-level driver from neo4jClusterStore.js.
 *
 * Layer responsibilities:
 *   Qdrant    → Semantic : content + embeddings + cosine search
 *   Neo4j     → Taxonomy : Wing → Hall → Room → Closet (neo4jClusterStore)
 *   Neo4j     → Topology : Palace → Room → Drawer, tunnels, traversal (this file)
 *   Neo4j     → Temporal : entity triples, valid_from/to (knowledgeGraph)
 *
 * Schema (topology nodes):
 *   (:Palace  {name, description, scope, is_default})
 *   (:TRoom   {slug, palace, drawer_count})     — "TRoom" avoids label clash with taxonomy :Room
 *   (:TDrawer {id, palace, importance, filed_at})
 *
 * Relationships:
 *   (:Palace)-[:HAS_TROOM]->(:TRoom)
 *   (:TRoom)-[:HAS_TDRAWER]->(:TDrawer)
 */

import neo4j from 'neo4j-driver';
import { getConfig } from './config.js';

// Shared driver (same instance as neo4jClusterStore)
let _driver = null;

function getDriver() {
  if (!_driver) {
    const cfg = getConfig();
    _driver = neo4j.driver(
      cfg.neo4jUri,
      neo4j.auth.basic(cfg.neo4jUser, cfg.neo4jPassword),
    );
  }
  return _driver;
}

async function run(cypher, params = {}) {
  const session = getDriver().session();
  try {
    return await session.run(cypher, params);
  } finally {
    await session.close();
  }
}

async function write(cypher, params = {}) {
  const session = getDriver().session();
  try {
    return await session.executeWrite((tx) => tx.run(cypher, params));
  } finally {
    await session.close();
  }
}

// ── Constraints (idempotent) ──────────────────────────────────────────────────

let _constraintsEnsured = false;

async function ensureConstraints() {
  if (_constraintsEnsured) return;
  _constraintsEnsured = true;
  const session = getDriver().session();
  try {
    await session.run(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:Palace)  REQUIRE n.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:TDrawer) REQUIRE n.id   IS UNIQUE`);
    // TRoom uniqueness enforced via MERGE on (slug, palace) — no composite unique constraint needed
  } finally {
    await session.close();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export class Neo4jGraph {
  async mergePalace({ name, description = '', scope = '', is_default = false }) {
    await ensureConstraints();
    await write(
      `MERGE (p:Palace {name: $name})
       ON CREATE SET p.description = $description, p.scope = $scope, p.is_default = $is_default
       ON MATCH  SET p.description = $description, p.scope = $scope, p.is_default = $is_default`,
      { name, description, scope, is_default },
    );
  }

  async mergeDrawer(palaceName, roomSlug, _hallId, drawerId, importance = 3) {
    await ensureConstraints();
    const filedAt = new Date().toISOString();

    await write(
      `MERGE (p:Palace {name: $palace})
       ON CREATE SET p.description = '', p.scope = '', p.is_default = false
       MERGE (r:TRoom {slug: $slug, palace: $palace})
       ON CREATE SET r.drawer_count = 0
       MERGE (d:TDrawer {id: $drawerId})
       ON CREATE SET d.palace = $palace, d.importance = $importance, d.filed_at = $filedAt
       MERGE (p)-[:HAS_TROOM]->(r)
       MERGE (r)-[:HAS_TDRAWER]->(d)
       ON CREATE SET r.drawer_count = r.drawer_count + 1`,
      { palace: palaceName, slug: roomSlug, drawerId, importance, filedAt },
    );
  }

  async deleteDrawer(drawerId) {
    await ensureConstraints();
    // Decrement drawer_count on parent room(s) before detaching
    await write(
      `MATCH (r:TRoom)-[:HAS_TDRAWER]->(d:TDrawer {id: $drawerId})
       SET r.drawer_count = r.drawer_count - 1`,
      { drawerId },
    );
    await write(
      `MATCH (d:TDrawer {id: $drawerId}) DETACH DELETE d`,
      { drawerId },
    );
  }

  async findTunnels(palaceA = null, palaceB = null) {
    await ensureConstraints();
    let cypher, params = {};

    if (palaceA && palaceB) {
      cypher = `
        MATCH (p1:Palace {name: $pa})-[:HAS_TROOM]->(r:TRoom)<-[:HAS_TROOM]-(p2:Palace {name: $pb})
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel`;
      params = { pa: palaceA, pb: palaceB };
    } else if (palaceA) {
      cypher = `
        MATCH (p1:Palace {name: $pa})-[:HAS_TROOM]->(r:TRoom)<-[:HAS_TROOM]-(p2:Palace)
        WHERE p1.name <> p2.name
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel`;
      params = { pa: palaceA };
    } else {
      cypher = `
        MATCH (p1:Palace)-[:HAS_TROOM]->(r:TRoom)<-[:HAS_TROOM]-(p2:Palace)
        WHERE p1.name < p2.name
        RETURN r.slug AS tunnel, p1.name AS palace_a, p2.name AS palace_b
        ORDER BY tunnel`;
    }

    const result = await run(cypher, params);
    return result.records.map((r) => ({
      tunnel:   r.get('tunnel'),
      palace_a: r.get('palace_a'),
      palace_b: r.get('palace_b'),
    }));
  }

  async traverse(startRoom, maxHops = 3) {
    await ensureConstraints();

    // Find which palace(s) this room belongs to
    const palaceRes = await run(
      `MATCH (p:Palace)-[:HAS_TROOM]->(r:TRoom {slug: $slug}) RETURN p.name AS palace`,
      { slug: startRoom },
    );
    if (!palaceRes.records.length) return [];

    const visited = new Set([startRoom]);
    let frontier = [startRoom];
    const results = [];

    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const nextFrontier = [];

      for (const currentSlug of frontier) {
        // Same-palace neighbors
        const nbRes = await run(
          `MATCH (p:Palace)-[:HAS_TROOM]->(r1:TRoom {slug: $slug})
           MATCH (p)-[:HAS_TROOM]->(r2:TRoom)
           WHERE r2.slug <> $slug
           RETURN DISTINCT r2.slug AS slug, p.name AS palace`,
          { slug: currentSlug },
        );
        for (const rec of nbRes.records) {
          const slug = rec.get('slug'), palace = rec.get('palace');
          if (!visited.has(slug)) {
            visited.add(slug);
            nextFrontier.push(slug);
            results.push({ slug, distance: hop, palace });
          }
        }

        // Cross-palace tunnel neighbors
        const tunRes = await run(
          `MATCH (p1:Palace)-[:HAS_TROOM]->(r:TRoom {slug: $slug})<-[:HAS_TROOM]-(p2:Palace)
           WHERE p1.name <> p2.name
           MATCH (p2)-[:HAS_TROOM]->(r2:TRoom)
           WHERE r2.slug <> $slug
           RETURN DISTINCT r2.slug AS slug, p2.name AS palace`,
          { slug: currentSlug },
        );
        for (const rec of tunRes.records) {
          const slug = rec.get('slug'), palace = rec.get('palace');
          if (!visited.has(slug)) {
            visited.add(slug);
            nextFrontier.push(slug);
            results.push({ slug, distance: hop, palace, via_tunnel: true });
          }
        }
      }

      frontier = nextFrontier;
    }

    return results;
  }

  async graphStats() {
    await ensureConstraints();
    const [palRes, roomRes, drawRes, tunRes, perRes] = await Promise.all([
      run('MATCH (p:Palace) RETURN count(p) AS cnt'),
      run('MATCH (r:TRoom)  RETURN count(r) AS cnt'),
      run('MATCH (d:TDrawer) RETURN count(d) AS cnt'),
      run(`MATCH (p1:Palace)-[:HAS_TROOM]->(r:TRoom)<-[:HAS_TROOM]-(p2:Palace)
           WHERE p1.name < p2.name
           RETURN count(DISTINCT r.slug) AS cnt`),
      run(`MATCH (p:Palace)-[:HAS_TROOM]->(r:TRoom)
           RETURN p.name AS palace, count(r) AS room_count
           ORDER BY room_count DESC`),
    ]);

    const int = (res) => neo4j.integer.toNumber(res.records[0]?.get('cnt') ?? 0);

    const rooms_per_palace = Object.fromEntries(
      perRes.records.map((r) => [
        r.get('palace'),
        neo4j.integer.toNumber(r.get('room_count')),
      ]),
    );

    return {
      palaces: int(palRes),
      rooms:   int(roomRes),
      drawers: int(drawRes),
      tunnels: int(tunRes),
      rooms_per_palace,
    };
  }

  static async closeDriver() {
    if (_driver) {
      await _driver.close();
      _driver = null;
    }
  }
}
