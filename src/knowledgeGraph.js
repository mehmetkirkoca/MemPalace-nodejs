/**
 * knowledgeGraph.js — Temporal Entity-Relationship Graph for MemPalace
 * =====================================================================
 *
 * Real knowledge graph with:
 *   - Entity nodes (people, projects, tools, concepts)
 *   - Typed relationship edges (daughter_of, does, loves, works_on, etc.)
 *   - Temporal validity (valid_from -> valid_to — knows WHEN facts are true)
 *   - Closet references (links back to the verbatim memory)
 *
 * Storage: SQLite via better-sqlite3 (local, no dependencies, no subscriptions)
 * Query: entity-first traversal with time filtering
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_KG_PATH = path.join(os.homedir(), '.mempalace', 'knowledge_graph.sqlite3');

export class KnowledgeGraph {
  constructor(dbPath = null) {
    this.dbPath = dbPath || DEFAULT_KG_PATH;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this._initDb();
  }

  _initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'unknown',
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        source_closet TEXT,
        source_file TEXT,
        extracted_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (subject) REFERENCES entities(id),
        FOREIGN KEY (object) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
    `);
  }

  _entityId(name) {
    return name.toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  }

  // ── Write operations ──────────────────────────────────────────────────

  addEntity(name, entityType = 'unknown', properties = null) {
    const eid = this._entityId(name);
    const props = JSON.stringify(properties || {});
    this.db.prepare(
      'INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)'
    ).run(eid, name, entityType, props);
    return eid;
  }

  getEntity(name) {
    const eid = this._entityId(name);
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(eid) || null;
  }

  addTriple(subject, predicate, obj, options = {}) {
    const {
      validFrom = null,
      validTo = null,
      confidence = 1.0,
      sourceCloset = null,
      sourceFile = null,
    } = options;

    const subId = this._entityId(subject);
    const objId = this._entityId(obj);
    const pred = predicate.toLowerCase().replace(/ /g, '_');

    // Auto-create entities if they don't exist
    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(subId, subject);
    this.db.prepare('INSERT OR IGNORE INTO entities (id, name) VALUES (?, ?)').run(objId, obj);

    // Check for existing identical triple
    const existing = this.db.prepare(
      'SELECT id FROM triples WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).get(subId, pred, objId);

    if (existing) {
      return existing.id;
    }

    const hash = crypto
      .createHash('md5')
      .update(`${validFrom}${new Date().toISOString()}`)
      .digest('hex')
      .slice(0, 8);
    const tripleId = `t_${subId}_${pred}_${objId}_${hash}`;

    this.db.prepare(
      `INSERT INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tripleId, subId, pred, objId, validFrom, validTo, confidence, sourceCloset, sourceFile);

    return tripleId;
  }

  invalidate(subject, predicate, obj, ended = null) {
    const subId = this._entityId(subject);
    const objId = this._entityId(obj);
    const pred = predicate.toLowerCase().replace(/ /g, '_');
    const endDate = ended || new Date().toISOString().split('T')[0];

    this.db.prepare(
      'UPDATE triples SET valid_to=? WHERE subject=? AND predicate=? AND object=? AND valid_to IS NULL'
    ).run(endDate, subId, pred, objId);
  }

  // ── Query operations ──────────────────────────────────────────────────

  queryEntity(name, options = {}) {
    const { asOf = null, direction = 'outgoing' } = options;
    const eid = this._entityId(name);
    const results = [];

    if (direction === 'outgoing' || direction === 'both') {
      let query = 'SELECT t.*, e.name as obj_name FROM triples t JOIN entities e ON t.object = e.id WHERE t.subject = ?';
      const params = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params);
      for (const row of rows) {
        results.push({
          direction: 'outgoing',
          subject: name,
          predicate: row.predicate,
          object: row.obj_name,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          confidence: row.confidence,
          sourceCloset: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      let query = 'SELECT t.*, e.name as sub_name FROM triples t JOIN entities e ON t.subject = e.id WHERE t.object = ?';
      const params = [eid];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const rows = this.db.prepare(query).all(...params);
      for (const row of rows) {
        results.push({
          direction: 'incoming',
          subject: row.sub_name,
          predicate: row.predicate,
          object: name,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          confidence: row.confidence,
          sourceCloset: row.source_closet,
          current: row.valid_to === null,
        });
      }
    }

    return results;
  }

  queryRelationship(predicate, asOf = null) {
    const pred = predicate.toLowerCase().replace(/ /g, '_');
    let query = `
      SELECT t.*, s.name as sub_name, o.name as obj_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params = [pred];
    if (asOf) {
      query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)';
      params.push(asOf, asOf);
    }

    return this.db.prepare(query).all(...params).map(row => ({
      subject: row.sub_name,
      predicate: pred,
      object: row.obj_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      current: row.valid_to === null,
    }));
  }

  timeline(entityName = null) {
    let query;
    let params = [];

    if (entityName) {
      const eid = this._entityId(entityName);
      query = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        WHERE (t.subject = ? OR t.object = ?)
        ORDER BY t.valid_from ASC NULLS LAST
        LIMIT 100
      `;
      params = [eid, eid];
    } else {
      query = `
        SELECT t.*, s.name as sub_name, o.name as obj_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        ORDER BY t.valid_from ASC NULLS LAST
        LIMIT 100
      `;
    }

    return this.db.prepare(query).all(...params).map(row => ({
      subject: row.sub_name,
      predicate: row.predicate,
      object: row.obj_name,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      current: row.valid_to === null,
    }));
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  stats() {
    const entities = this.db.prepare('SELECT COUNT(*) as cnt FROM entities').get().cnt;
    const triples = this.db.prepare('SELECT COUNT(*) as cnt FROM triples').get().cnt;
    const current = this.db.prepare('SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL').get().cnt;
    const expired = triples - current;
    const predicates = this.db.prepare(
      'SELECT DISTINCT predicate FROM triples ORDER BY predicate'
    ).all().map(r => r.predicate);

    return {
      entities,
      triples,
      currentFacts: current,
      expiredFacts: expired,
      relationshipTypes: predicates,
    };
  }

  // ── Seed from known facts ─────────────────────────────────────────────

  seedFromEntityFacts(entityFacts) {
    for (const [key, facts] of Object.entries(entityFacts)) {
      const name = facts.full_name || key.charAt(0).toUpperCase() + key.slice(1);
      const etype = facts.type || 'person';
      this.addEntity(name, etype, {
        gender: facts.gender || '',
        birthday: facts.birthday || '',
      });

      // Relationships
      if (facts.parent) {
        const parent = facts.parent.charAt(0).toUpperCase() + facts.parent.slice(1);
        this.addTriple(name, 'child_of', parent, { validFrom: facts.birthday });
      }

      if (facts.partner) {
        const partner = facts.partner.charAt(0).toUpperCase() + facts.partner.slice(1);
        this.addTriple(name, 'married_to', partner);
      }

      const relationship = facts.relationship || '';
      if (relationship === 'daughter') {
        const parent = (facts.parent || '').charAt(0).toUpperCase() + (facts.parent || '').slice(1) || name;
        this.addTriple(name, 'is_child_of', parent, { validFrom: facts.birthday });
      } else if (relationship === 'husband') {
        const partner = (facts.partner || name).charAt(0).toUpperCase() + (facts.partner || name).slice(1);
        this.addTriple(name, 'is_partner_of', partner);
      } else if (relationship === 'brother') {
        const sibling = (facts.sibling || name).charAt(0).toUpperCase() + (facts.sibling || name).slice(1);
        this.addTriple(name, 'is_sibling_of', sibling);
      } else if (relationship === 'dog') {
        const owner = (facts.owner || name).charAt(0).toUpperCase() + (facts.owner || name).slice(1);
        this.addTriple(name, 'is_pet_of', owner);
        this.addEntity(name, 'animal');
      }

      // Interests
      for (const interest of (facts.interests || [])) {
        const capitalized = interest.charAt(0).toUpperCase() + interest.slice(1);
        this.addTriple(name, 'loves', capitalized, { validFrom: '2025-01-01' });
      }
    }
  }

  close() {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }
}
