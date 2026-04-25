import { VectorStore } from './vectorStore.js';
import { getConfig } from './config.js';
import { normalizeText } from './textUtils.js';

const ROUTING_COLLECTION = 'mempalace_routing_memory';

export class RoutingMemoryStore {
  constructor() {
    const cfg = getConfig();
    this._store = new VectorStore({
      qdrantUrl: cfg.qdrantUrl,
      collectionName: ROUTING_COLLECTION,
    });
    this._ready = false;
  }

  async init() {
    if (!this._ready) {
      await this._store.init();
      this._ready = true;
    }
  }

  async getExact(query) {
    const normalizedQuery = normalizeRoutingQuery(query);
    if (!normalizedQuery) return null;

    try {
      await this.init();
      const result = await this._store.get({ where: { normalized_query: normalizedQuery }, limit: 1 });
      const entries = _deserialize(result.documents || [], result.metadatas || []);
      return entries[0] || null;
    } catch {
      return null;
    }
  }

  async remember({ query, palace, source = 'direct_hit', timestamp = new Date().toISOString() }) {
    const normalizedQuery = normalizeRoutingQuery(query);
    if (!normalizedQuery || !palace) return null;

    const existing = await this.getExact(normalizedQuery);
    const hitCount = (existing?.hit_count ?? 0) + 1;

    await this.init();
    await this._store.add({
      ids: [normalizedQuery],
      documents: [normalizedQuery],
      metadatas: [{
        normalized_query: normalizedQuery,
        palace,
        source,
        hit_count: hitCount,
        last_used_at: timestamp,
      }],
    });

    return this.getExact(normalizedQuery);
  }
}

export function normalizeRoutingQuery(query) {
  return normalizeText(query);
}

function _deserialize(docs, metas) {
  return metas.map((meta, index) => ({
    normalized_query: meta.normalized_query || docs[index] || null,
    palace: meta.palace || null,
    source: meta.source || null,
    hit_count: Number(meta.hit_count || 0),
    last_used_at: meta.last_used_at || null,
  }));
}
