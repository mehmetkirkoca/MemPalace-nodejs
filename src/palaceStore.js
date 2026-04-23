/**
 * palaceStore.js — Palace config storage in Qdrant (mempalace_palaces collection)
 *
 * Replaces palaceRegistry.js. Each palace is a Qdrant point:
 *   vector:   embedded scope text (for context-based routing)
 *   payload:  name, description, keywords, wing_focus, l0_body, is_default
 */

import { VectorStore } from './vectorStore.js';
import { getConfig } from './config.js';

const PALACE_COLLECTION = 'mempalace_palaces';

export class PalaceStore {
  constructor() {
    const cfg = getConfig();
    this._store = new VectorStore({
      qdrantUrl: cfg.qdrantUrl,
      collectionName: PALACE_COLLECTION,
    });
    this._ready = false;
  }

  async init() {
    if (!this._ready) {
      await this._store.init();
      this._ready = true;
    }
  }

  /**
   * Upsert a palace. scope is embedded as the document vector for routing.
   */
  async upsert({ name, description, keywords = [], scope, wing_focus, l0_body, is_default = false }) {
    await this.init();
    const document = scope || name;
    await this._store.add({
      ids: [name],
      documents: [document],
      metadatas: [{
        name,
        description:  description  || '',
        keywords:     JSON.stringify(keywords),
        wing_focus:   wing_focus   || '',
        l0_body:      l0_body      || '',
        is_default:   is_default   ? 1 : 0,
      }],
    });
  }

  /**
   * Return all palaces as plain objects.
   */
  async getAll() {
    try {
      await this.init();
      const result = await this._store.get({});
      return _deserialize(result.documents || [], result.metadatas || []);
    } catch {
      return [];
    }
  }

  /**
   * Find the best-matching palace for a context string (semantic routing).
   * Returns the top palace object, or null if collection is empty.
   */
  async selectByContext(contextText) {
    try {
      await this.init();
      const result = await this._store.query({ queryTexts: [contextText], nResults: 1 });
      const docs  = result.documents?.[0] || [];
      const metas = result.metadatas?.[0] || [];
      if (!docs.length) return null;
      return _deserialize(docs, metas)[0];
    } catch {
      return null;
    }
  }

  /**
   * Delete a palace by name.
   */
  async delete(name) {
    await this.init();
    await this._store.deleteByFilter({ name });
  }
}

function _deserialize(docs, metas) {
  return metas.map((meta, i) => ({
    name:        meta.name,
    description: meta.description || null,
    keywords:    JSON.parse(meta.keywords || '[]'),
    wing_focus:  meta.wing_focus  || null,
    l0_body:     meta.l0_body     || null,
    is_default:  meta.is_default  === 1,
    scope:       docs[i]          || null,
  }));
}
