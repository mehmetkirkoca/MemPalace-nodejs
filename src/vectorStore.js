import { QdrantClient } from '@qdrant/qdrant-js';
import { createHash } from 'crypto';
import { Embedder } from './embedder.js';

// Module-level singleton: all VectorStore instances share one Embedder
// so the ONNX model is loaded only once per process.
const _sharedEmbedder = new Embedder();

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(name) {
  const namespaceBytes = Buffer.from(DNS_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toQdrantId(id) {
  return uuidV5(`mempalace.${id}`);
}

function convertFilter(where) {
  if (!where) return undefined;

  if (where.$and) {
    const conditions = where.$and.flatMap((condition) => {
      const converted = convertFilter(condition);
      return converted.must || [converted.should ? { nested: converted } : converted];
    });
    return { must: conditions };
  }

  if (where.$or) {
    const conditions = where.$or.flatMap((condition) => {
      const converted = convertFilter(condition);
      return converted.must || [converted];
    });
    return { should: conditions };
  }

  // Simple key-value filter
  const must = Object.entries(where).map(([key, value]) => ({
    key,
    match: { value },
  }));
  return { must };
}

export class VectorStore {
  constructor({
    qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName = 'mempalace_drawers',
  } = {}) {
    this._qdrantUrl = qdrantUrl;
    this._collectionName = collectionName;
    this._client = new QdrantClient({ url: qdrantUrl });
    this._embedder = _sharedEmbedder;
  }

  async init() {
    try {
      await this._client.getCollection(this._collectionName);
    } catch {
      await this._client.createCollection(this._collectionName, {
        vectors: {
          size: 384,
          distance: 'Cosine',
        },
      });
    }
  }

  async add({ ids, documents, metadatas, id, content, metadata }) {
    // Support single-item format: add({ id, content, metadata })
    if (id && content) {
      ids = [id];
      documents = [content];
      metadatas = [metadata || {}];
    }
    const BATCH_SIZE = 10;

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const batchDocs = documents.slice(i, i + BATCH_SIZE);
      const batchMeta = metadatas.slice(i, i + BATCH_SIZE);

      // Embed only this batch to avoid large intermediate tensors
      const batchVectors = await this._embedder.embedBatch(batchDocs);

      const points = batchIds.map((id, j) => ({
        id: toQdrantId(id),
        vector: batchVectors[j],
        payload: {
          document: batchDocs[j],
          original_id: id,
          ...batchMeta[j],
        },
      }));

      await this._client.upsert(this._collectionName, { points });
    }
  }

  /**
   * Upsert documents with pre-computed vectors — no re-embedding.
   * vectors must be an array of float[] matching documents length.
   */
  async addWithVectors({ ids, documents, vectors, metadatas }) {
    const BATCH_SIZE = 10;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batchIds = ids.slice(i, i + BATCH_SIZE);
      const batchVectors = vectors.slice(i, i + BATCH_SIZE);
      const batchDocs = documents.slice(i, i + BATCH_SIZE);
      const batchMeta = (metadatas || []).slice(i, i + BATCH_SIZE);

      const points = batchIds.map((id, j) => ({
        id: toQdrantId(id),
        vector: batchVectors[j],
        payload: {
          document: batchDocs[j],
          original_id: id,
          ...(batchMeta[j] || {}),
        },
      }));

      await this._client.upsert(this._collectionName, { points });
    }
  }

  /**
   * Search with a pre-computed query vector — no re-embedding.
   * Returns the same shape as query().
   */
  async queryWithVector({ queryVector, nResults = 10, where }) {
    const filter = convertFilter(where);

    const results = await this._client.search(this._collectionName, {
      vector: queryVector,
      limit: nResults,
      with_payload: true,
      filter,
    });

    const ids = results.map((r) => r.payload.original_id);
    const documents = results.map((r) => r.payload.document);
    const metadatas = results.map((r) => {
      const { document, original_id, ...rest } = r.payload;
      return rest;
    });
    const distances = results.map((r) => r.score);

    return {
      ids: [ids],
      documents: [documents],
      metadatas: [metadatas],
      distances: [distances],
    };
  }

  async query({ queryTexts, nResults = 10, where }) {
    const queryVector = await this._embedder.embed(queryTexts[0]);
    const filter = convertFilter(where);

    const results = await this._client.search(this._collectionName, {
      vector: queryVector,
      limit: nResults,
      with_payload: true,
      filter,
    });

    const ids = results.map((r) => r.payload.original_id);
    const documents = results.map((r) => r.payload.document);
    const metadatas = results.map((r) => {
      const { document, original_id, ...rest } = r.payload;
      return rest;
    });
    const distances = results.map((r) => r.score);

    return {
      ids: [ids],
      documents: [documents],
      metadatas: [metadatas],
      distances: [distances],
    };
  }

  async get({ where, limit = 10 }) {
    const filter = convertFilter(where);
    const ids = [];
    const documents = [];
    const metadatas = [];
    let offset;

    while (true) {
      const scrollParams = {
        limit: Math.min(limit - ids.length, 100),
        with_payload: true,
        filter,
      };
      if (offset !== undefined) {
        scrollParams.offset = offset;
      }

      const page = await this._client.scroll(this._collectionName, scrollParams);

      for (const point of page.points) {
        ids.push(point.payload.original_id);
        documents.push(point.payload.document);
        const { document, original_id, ...rest } = point.payload;
        metadatas.push(rest);
      }

      if (!page.next_page_offset || ids.length >= limit) break;
      offset = page.next_page_offset;
    }

    return { ids, documents, metadatas };
  }

  async delete({ ids }) {
    const qdrantIds = ids.map((id) => toQdrantId(id));
    await this._client.delete(this._collectionName, {
      points: qdrantIds,
    });
  }

  async deleteByFilter(match) {
    // match is a flat key→value object, e.g. { name: 'my_palace' }
    const must = Object.entries(match).map(([key, value]) => ({
      key,
      match: { value },
    }));
    await this._client.delete(this._collectionName, {
      filter: { must },
    });
  }

  async count() {
    const result = await this._client.count(this._collectionName);
    return result.count;
  }

  async checkDuplicate(text, threshold = 0.95) {
    const vector = await this._embedder.embed(text);
    const results = await this._client.search(this._collectionName, {
      vector,
      limit: 1,
      with_payload: false,
    });

    if (results.length === 0) return false;
    return results[0].score >= threshold;
  }

  async deleteCollection() {
    try {
      await this._client.deleteCollection(this._collectionName);
    } catch {
      // Collection may not exist
    }
  }
}
