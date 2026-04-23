/**
 * neo4jClusterStore.js — Taxonomy tree stored in Neo4j
 *
 * Replaces clusterStore.js (JSON file). Each palace has its own
 * subgraph of Wing → Hall → Room → Closet nodes in Neo4j.
 *
 * Graph schema:
 *   (:Wing   {id, name, palace, size})-[:HAS_HALL]->
 *   (:Hall   {id, name, palace, size})-[:HAS_ROOM]->
 *   (:Room   {id, name, palace, size})-[:HAS_CLOSET]->
 *   (:Closet {id, name, palace, size})
 *
 * Public API (matches ClusterStore):
 *   assign(wing, hall, room, closet)  → { wingId, hallId, roomId, closetId }
 *   getTaxonomyText()                 → string  (for LLM prompts)
 *   getTree()                         → { wings: [...] }
 *   close()                           → release driver
 */

import neo4j from 'neo4j-driver';
import crypto from 'crypto';
import { getConfig } from './config.js';

// Module-level singleton driver — shared across all Neo4jClusterStore instances.
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

function shortId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

export class Neo4jClusterStore {
  /**
   * @param {string} palace  Palace name — scopes the subgraph.
   */
  constructor(palace) {
    this._palace = palace;
  }

  // ── Constraints (call once on first use) ─────────────────────────────────

  async _ensureConstraints() {
    const driver = getDriver();
    const session = driver.session();
    try {
      for (const label of ['Wing', 'Hall', 'Room', 'Closet']) {
        await session.run(
          `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE (n.id) IS UNIQUE`
        );
      }
    } finally {
      await session.close();
    }
  }

  // ── assign ────────────────────────────────────────────────────────────────

  /**
   * MERGE wing → hall → room → closet nodes for this palace.
   * Returns their IDs (creating new ones as needed).
   *
   * @returns {{ wingId, hallId, roomId, closetId }}
   */
  async assign(wing, hall, room, closet) {
    const driver = getDriver();
    const session = driver.session();
    try {
      const result = await session.executeWrite(async (tx) => {
        // Wing
        const wRes = await tx.run(
          `MERGE (w:Wing {name: $name, palace: $palace})
           ON CREATE SET w.id = $id, w.size = 1, w.created_at = datetime()
           ON MATCH  SET w.size = w.size + 1, w.updated_at = datetime()
           RETURN w.id AS id`,
          { name: wing, palace: this._palace, id: shortId('win') }
        );
        const wingId = wRes.records[0].get('id');

        // Hall
        const hRes = await tx.run(
          `MATCH (w:Wing {id: $wingId})
           MERGE (h:Hall {name: $name, palace: $palace})
           ON CREATE SET h.id = $id, h.size = 1, h.created_at = datetime()
           ON MATCH  SET h.size = h.size + 1, h.updated_at = datetime()
           MERGE (w)-[:HAS_HALL]->(h)
           RETURN h.id AS id`,
          { wingId, name: hall, palace: this._palace, id: shortId('hal') }
        );
        const hallId = hRes.records[0].get('id');

        // Room
        const rRes = await tx.run(
          `MATCH (h:Hall {id: $hallId})
           MERGE (r:Room {name: $name, palace: $palace})
           ON CREATE SET r.id = $id, r.size = 1, r.created_at = datetime()
           ON MATCH  SET r.size = r.size + 1, r.updated_at = datetime()
           MERGE (h)-[:HAS_ROOM]->(r)
           RETURN r.id AS id`,
          { hallId, name: room, palace: this._palace, id: shortId('roo') }
        );
        const roomId = rRes.records[0].get('id');

        // Closet
        const cRes = await tx.run(
          `MATCH (r:Room {id: $roomId})
           MERGE (c:Closet {name: $name, palace: $palace})
           ON CREATE SET c.id = $id, c.size = 1, c.created_at = datetime()
           ON MATCH  SET c.size = c.size + 1, c.updated_at = datetime()
           MERGE (r)-[:HAS_CLOSET]->(c)
           RETURN c.id AS id`,
          { roomId, name: closet, palace: this._palace, id: shortId('clo') }
        );
        const closetId = cRes.records[0].get('id');

        return { wingId, hallId, roomId, closetId };
      });

      return result;
    } finally {
      await session.close();
    }
  }

  // ── getTree ───────────────────────────────────────────────────────────────

  /**
   * Return the full taxonomy as a nested object.
   * Shape: { wings: [{ id, name, halls: [{ id, name, rooms: [{ id, name, closets: [{ id, name }] }] }] }] }
   */
  async getTree() {
    const driver = getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (w:Wing {palace: $palace})-[:HAS_HALL]->(h:Hall)-[:HAS_ROOM]->(r:Room)-[:HAS_CLOSET]->(c:Closet)
         RETURN w.id AS wId, w.name AS wName,
                h.id AS hId, h.name AS hName,
                r.id AS rId, r.name AS rName,
                c.id AS cId, c.name AS cName
         ORDER BY wName, hName, rName, cName`,
        { palace: this._palace }
      );

      // Build nested structure
      const wingMap = new Map();
      for (const rec of result.records) {
        const wId = rec.get('wId'), wName = rec.get('wName');
        const hId = rec.get('hId'), hName = rec.get('hName');
        const rId = rec.get('rId'), rName = rec.get('rName');
        const cId = rec.get('cId'), cName = rec.get('cName');

        if (!wingMap.has(wId)) wingMap.set(wId, { id: wId, name: wName, halls: new Map() });
        const wing = wingMap.get(wId);

        if (!wing.halls.has(hId)) wing.halls.set(hId, { id: hId, name: hName, rooms: new Map() });
        const hall = wing.halls.get(hId);

        if (!hall.rooms.has(rId)) hall.rooms.set(rId, { id: rId, name: rName, closets: [] });
        const room = hall.rooms.get(rId);

        room.closets.push({ id: cId, name: cName });
      }

      const wings = [...wingMap.values()].map((w) => ({
        id: w.id, name: w.name,
        halls: [...w.halls.values()].map((h) => ({
          id: h.id, name: h.name,
          rooms: [...h.rooms.values()].map((r) => ({
            id: r.id, name: r.name,
            closets: r.closets,
          })),
        })),
      }));

      return { wings };
    } finally {
      await session.close();
    }
  }

  // ── getTaxonomyText ───────────────────────────────────────────────────────

  /**
   * Compact text representation for LLM prompts.
   * Example:
   *   Technology
   *     Programming
   *       JavaScript
   *         TypeScript
   */
  async getTaxonomyText() {
    const tree = await this.getTree();
    if (!tree.wings.length) return '(empty — no categories yet)';

    const lines = [];
    for (const w of tree.wings) {
      lines.push(w.name);
      for (const h of w.halls) {
        lines.push(`  ${h.name}`);
        for (const r of h.rooms) {
          lines.push(`    ${r.name}`);
          for (const c of r.closets) {
            lines.push(`      ${c.name}`);
          }
        }
      }
    }
    return lines.join('\n');
  }

  // ── deleteCloset ──────────────────────────────────────────────────────────

  /**
   * Delete a Closet node (and its HAS_CLOSET relationship) by ID.
   * Returns { deleted: 1 } on success, { deleted: 0 } if not found.
   */
  async deleteCloset(closetId) {
    const driver = getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (c:Closet {id: $closetId})
         DETACH DELETE c
         RETURN count(c) AS deleted`,
        { closetId }
      );
      const deleted = result.records[0]?.get('deleted')?.toNumber() ?? 0;
      return { deleted };
    } finally {
      await session.close();
    }
  }

  // ── close ─────────────────────────────────────────────────────────────────

  static async closeDriver() {
    if (_driver) {
      await _driver.close();
      _driver = null;
    }
  }
}
