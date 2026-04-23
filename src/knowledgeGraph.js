/**
 * knowledgeGraph.js — Temporal Entity-Relationship Graph for MemPalace
 * =====================================================================
 *
 * Neo4j-backed knowledge graph with:
 *   - Entity nodes (people, projects, tools, concepts)
 *   - Typed relationship edges stored as :REL with predicate property
 *   - Temporal validity (valid_from -> valid_to)
 *   - Namespace isolation per palace/test instance
 */

import crypto from 'crypto';
import neo4j from 'neo4j-driver';
import { getConfig } from './config.js';

let _driver = null;
let _constraintsReady = false;

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

function toNumber(value) {
  return neo4j.isInt(value) ? neo4j.integer.toNumber(value) : value;
}

function normalizeProperties(value) {
  if (!value) return '{}';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isActiveAt(validFrom, validTo, asOf) {
  if (!asOf) return validTo === null;
  return (validFrom === null || validFrom <= asOf) && (validTo === null || validTo >= asOf);
}

export class KnowledgeGraph {
  constructor(namespace = 'default') {
    this.namespace = String(namespace || 'default')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'default';
  }

  async _ensureConstraints() {
    if (_constraintsReady) return;
    const session = getDriver().session();
    try {
      // Composite NODE KEY requires Enterprise — use a unique index instead
      await session.run(
        'CREATE INDEX entity_ns_id IF NOT EXISTS FOR (n:Entity) ON (n.namespace, n.id)'
      );
      await session.run(
        'CREATE CONSTRAINT IF NOT EXISTS FOR ()-[r:REL]-() REQUIRE r.id IS UNIQUE'
      );
      _constraintsReady = true;
    } finally {
      await session.close();
    }
  }

  _entityId(name) {
    return String(name).toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  }

  async _run(cypher, params = {}, accessMode = neo4j.session.READ) {
    await this._ensureConstraints();
    const session = getDriver().session({ defaultAccessMode: accessMode });
    try {
      return await session.run(cypher, { namespace: this.namespace, ...params });
    } finally {
      await session.close();
    }
  }

  async addEntity(name, entityType = 'unknown', properties = null) {
    const id = this._entityId(name);
    await this._run(
      `MERGE (e:Entity {namespace: $namespace, id: $id})
       ON CREATE SET e.name = $name, e.type = $type, e.properties = $properties, e.created_at = datetime()
       ON MATCH  SET e.name = $name, e.type = $type, e.properties = $properties`,
      { id, name, type: entityType, properties: normalizeProperties(properties) },
      neo4j.session.WRITE,
    );
    return id;
  }

  async getEntity(name) {
    const id = this._entityId(name);
    const result = await this._run(
      `MATCH (e:Entity {namespace: $namespace, id: $id})
       RETURN e.id AS id, e.name AS name, e.type AS type, e.properties AS properties`,
      { id },
    );
    if (!result.records.length) return null;
    const row = result.records[0];
    return {
      id: row.get('id'),
      name: row.get('name'),
      type: row.get('type'),
      properties: row.get('properties') || '{}',
    };
  }

  async addTriple(subject, predicate, obj, options = {}) {
    const {
      validFrom = null,
      validTo = null,
      confidence = 1.0,
      sourceCloset = null,
      sourceFile = null,
    } = options;

    const subjectId = this._entityId(subject);
    const objectId = this._entityId(obj);
    const pred = String(predicate).toLowerCase().replace(/ /g, '_');

    const existing = await this._run(
      `MATCH (:Entity {namespace: $namespace, id: $subjectId})-[r:REL {predicate: $predicate}]->
             (:Entity {namespace: $namespace, id: $objectId})
       WHERE r.valid_to IS NULL
       RETURN r.id AS id
       LIMIT 1`,
      { subjectId, objectId, predicate: pred },
    );
    if (existing.records.length > 0) {
      return existing.records[0].get('id');
    }

    const hash = crypto
      .createHash('md5')
      .update(`${this.namespace}:${subjectId}:${pred}:${objectId}:${validFrom || ''}:${new Date().toISOString()}`)
      .digest('hex')
      .slice(0, 12);
    const tripleId = `t_${subjectId}_${pred}_${objectId}_${hash}`;

    const result = await this._run(
      `MERGE (s:Entity {namespace: $namespace, id: $subjectId})
       ON CREATE SET s.name = $subject, s.type = 'unknown', s.properties = '{}', s.created_at = datetime()
       MERGE (o:Entity {namespace: $namespace, id: $objectId})
       ON CREATE SET o.name = $object, o.type = 'unknown', o.properties = '{}', o.created_at = datetime()
       MERGE (s)-[r:REL {id: $tripleId}]->(o)
       ON CREATE SET
         r.namespace = $namespace,
         r.predicate = $predicate,
         r.valid_from = $validFrom,
         r.valid_to = $validTo,
         r.confidence = $confidence,
         r.source_closet = $sourceCloset,
         r.source_file = $sourceFile,
         r.extracted_at = datetime()
       RETURN r.id AS id`,
      {
        subjectId,
        objectId,
        subject,
        object: obj,
        tripleId,
        predicate: pred,
        validFrom,
        validTo,
        confidence,
        sourceCloset,
        sourceFile,
      },
      neo4j.session.WRITE,
    );

    return result.records[0].get('id');
  }

  async invalidate(subject, predicate, obj, ended = null) {
    const subjectId = this._entityId(subject);
    const objectId = this._entityId(obj);
    const pred = String(predicate).toLowerCase().replace(/ /g, '_');
    const endDate = ended || new Date().toISOString().split('T')[0];

    await this._run(
      `MATCH (:Entity {namespace: $namespace, id: $subjectId})-[r:REL {predicate: $predicate}]->
             (:Entity {namespace: $namespace, id: $objectId})
       WHERE r.valid_to IS NULL
       SET r.valid_to = $endDate`,
      { subjectId, objectId, predicate: pred, endDate },
      neo4j.session.WRITE,
    );
  }

  async queryEntity(name, options = {}) {
    const { asOf = null, direction = 'outgoing' } = options;
    const id = this._entityId(name);
    const results = [];

    if (direction === 'outgoing' || direction === 'both') {
      const outgoing = await this._run(
        `MATCH (:Entity {namespace: $namespace, id: $id})-[r:REL]->(o:Entity {namespace: $namespace})
         WHERE $asOf IS NULL
           OR ((r.valid_from IS NULL OR r.valid_from <= $asOf)
           AND (r.valid_to IS NULL OR r.valid_to >= $asOf))
         RETURN o.name AS object, r.predicate AS predicate, r.valid_from AS validFrom,
                r.valid_to AS validTo, r.confidence AS confidence, r.source_closet AS sourceCloset
         ORDER BY r.valid_from ASC, r.predicate ASC, o.name ASC`,
        { id, asOf },
      );
      for (const row of outgoing.records) {
        const validFrom = row.get('validFrom');
        const validTo = row.get('validTo');
        results.push({
          direction: 'outgoing',
          subject: name,
          predicate: row.get('predicate'),
          object: row.get('object'),
          validFrom,
          validTo,
          confidence: row.get('confidence'),
          sourceCloset: row.get('sourceCloset'),
          activeNow: validTo === null,
          activeAsOf: isActiveAt(validFrom, validTo, asOf),
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const incoming = await this._run(
        `MATCH (s:Entity {namespace: $namespace})-[r:REL]->(:Entity {namespace: $namespace, id: $id})
         WHERE $asOf IS NULL
           OR ((r.valid_from IS NULL OR r.valid_from <= $asOf)
           AND (r.valid_to IS NULL OR r.valid_to >= $asOf))
         RETURN s.name AS subject, r.predicate AS predicate, r.valid_from AS validFrom,
                r.valid_to AS validTo, r.confidence AS confidence, r.source_closet AS sourceCloset
         ORDER BY r.valid_from ASC, r.predicate ASC, s.name ASC`,
        { id, asOf },
      );
      for (const row of incoming.records) {
        const validFrom = row.get('validFrom');
        const validTo = row.get('validTo');
        results.push({
          direction: 'incoming',
          subject: row.get('subject'),
          predicate: row.get('predicate'),
          object: name,
          validFrom,
          validTo,
          confidence: row.get('confidence'),
          sourceCloset: row.get('sourceCloset'),
          activeNow: validTo === null,
          activeAsOf: isActiveAt(validFrom, validTo, asOf),
        });
      }
    }

    return results;
  }

  async queryRelationship(predicate, asOf = null) {
    const pred = String(predicate).toLowerCase().replace(/ /g, '_');
    const result = await this._run(
      `MATCH (s:Entity {namespace: $namespace})-[r:REL {predicate: $predicate}]->(o:Entity {namespace: $namespace})
       WHERE $asOf IS NULL
         OR ((r.valid_from IS NULL OR r.valid_from <= $asOf)
         AND (r.valid_to IS NULL OR r.valid_to >= $asOf))
       RETURN s.name AS subject, o.name AS object, r.valid_from AS validFrom, r.valid_to AS validTo
       ORDER BY r.valid_from ASC, s.name ASC, o.name ASC`,
      { predicate: pred, asOf },
    );

    return result.records.map((row) => ({
      validFrom: row.get('validFrom'),
      validTo: row.get('validTo'),
      subject: row.get('subject'),
      predicate: pred,
      object: row.get('object'),
      activeNow: row.get('validTo') === null,
      activeAsOf: isActiveAt(row.get('validFrom'), row.get('validTo'), asOf),
    }));
  }

  async timeline(entityName = null) {
    const result = entityName
      ? await this._run(
          `MATCH (s:Entity {namespace: $namespace})-[r:REL]->(o:Entity {namespace: $namespace})
           WHERE s.id = $id OR o.id = $id
           RETURN s.name AS subject, r.predicate AS predicate, o.name AS object,
                  r.valid_from AS validFrom, r.valid_to AS validTo
           ORDER BY r.valid_from ASC, r.predicate ASC
           LIMIT 100`,
          { id: this._entityId(entityName) },
        )
      : await this._run(
          `MATCH (s:Entity {namespace: $namespace})-[r:REL]->(o:Entity {namespace: $namespace})
           RETURN s.name AS subject, r.predicate AS predicate, o.name AS object,
                  r.valid_from AS validFrom, r.valid_to AS validTo
           ORDER BY r.valid_from ASC, r.predicate ASC
           LIMIT 100`
        );

    return result.records.map((row) => ({
      validFrom: row.get('validFrom'),
      validTo: row.get('validTo'),
      subject: row.get('subject'),
      predicate: row.get('predicate'),
      object: row.get('object'),
      activeNow: row.get('validTo') === null,
    }));
  }

  async stats() {
    const [entitiesRes, triplesRes, currentFactsRes, expiredFactsRes, relTypesRes] = await Promise.all([
      this._run('MATCH (e:Entity {namespace: $namespace}) RETURN count(e) AS cnt'),
      this._run('MATCH (:Entity {namespace: $namespace})-[r:REL]->(:Entity {namespace: $namespace}) RETURN count(r) AS cnt'),
      this._run('MATCH (:Entity {namespace: $namespace})-[r:REL]->(:Entity {namespace: $namespace}) WHERE r.valid_to IS NULL RETURN count(r) AS cnt'),
      this._run('MATCH (:Entity {namespace: $namespace})-[r:REL]->(:Entity {namespace: $namespace}) WHERE r.valid_to IS NOT NULL RETURN count(r) AS cnt'),
      this._run(
        'MATCH (:Entity {namespace: $namespace})-[r:REL]->(:Entity {namespace: $namespace}) RETURN DISTINCT r.predicate AS predicate ORDER BY predicate'
      ),
    ]);

    return {
      entities: toNumber(entitiesRes.records[0]?.get('cnt') ?? 0),
      triples: toNumber(triplesRes.records[0]?.get('cnt') ?? 0),
      currentFacts: toNumber(currentFactsRes.records[0]?.get('cnt') ?? 0),
      expiredFacts: toNumber(expiredFactsRes.records[0]?.get('cnt') ?? 0),
      relationshipTypes: relTypesRes.records.map((row) => row.get('predicate')),
    };
  }

  async clear() {
    await this._run(
      `MATCH (e:Entity {namespace: $namespace})
       DETACH DELETE e`,
      {},
      neo4j.session.WRITE,
    );
  }

  async close() {}

  static async closeDriver() {
    if (_driver) {
      await _driver.close();
      _driver = null;
      _constraintsReady = false;
    }
  }
}
