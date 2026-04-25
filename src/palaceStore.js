/**
 * palaceStore.js — Palace config storage in Qdrant (mempalace_palaces collection)
 *
 * Replaces palaceRegistry.js. Each palace is a Qdrant point:
 *   vector:   embedded scope text (for context-based routing)
 *   payload:  name, description, keywords, wing_focus, l0_body, is_default
 */

import { VectorStore } from './vectorStore.js';
import { getConfig } from './config.js';
import { normalizeText } from './textUtils.js';

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
    const existing = await this.getByName(name);
    const usageCount = existing?.usage_count ?? 0;
    const lastUsedAt = existing?.last_used_at ?? null;
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
        usage_count:  usageCount,
        last_used_at: lastUsedAt,
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

  async getByName(name) {
    try {
      await this.init();
      const result = await this._store.get({ where: { name }, limit: 1 });
      const palaces = _deserialize(result.documents || [], result.metadatas || []);
      return palaces[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Find the best-matching palace for a context string (semantic routing).
   * Returns the top palace object, or null if collection is empty.
   */
  async selectByContext(contextText) {
    const ranked = await this.rankByContext(contextText, 1);
    return ranked[0] || null;
  }

  /**
   * Rank palaces by semantic similarity to a context string.
   * Returns plain palace objects with a score field.
   */
  async rankByContext(contextText, limit = 5) {
    try {
      await this.init();
      const result = await this._store.query({ queryTexts: [contextText], nResults: limit });
      const docs = result.documents?.[0] || [];
      const metas = result.metadatas?.[0] || [];
      const semanticScores = result.distances?.[0] || [];
      return _deserialize(docs, metas)
        .map((palace, index) => {
          const semanticScore = semanticScores[index] ?? null;
          const usageCount = palace.usage_count ?? 0;
          const usageBoost = _usageBoost(usageCount);
          const fieldBoost = _fieldBoost(contextText, palace);
          return {
            ...palace,
            semantic_score: semanticScore,
            field_boost: fieldBoost,
            usage_boost: usageBoost,
            score: semanticScore === null ? null : semanticScore + fieldBoost + usageBoost,
          };
        })
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    } catch {
      return [];
    }
  }

  async recordUsage(name, timestamp = new Date().toISOString()) {
    const existing = await this.getByName(name);
    if (!existing) return null;

    await this.init();
    await this._store.add({
      ids: [name],
      documents: [existing.scope || existing.name],
      metadatas: [{
        name:        existing.name,
        description: existing.description || '',
        keywords:    JSON.stringify(existing.keywords || []),
        wing_focus:  existing.wing_focus || '',
        l0_body:     existing.l0_body || '',
        is_default:  existing.is_default ? 1 : 0,
        usage_count: (existing.usage_count ?? 0) + 1,
        last_used_at: timestamp,
      }],
    });

    return this.getByName(name);
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
    usage_count: Number(meta.usage_count || 0),
    last_used_at: meta.last_used_at || null,
    scope:       docs[i]          || null,
  }));
}

function _usageBoost(usageCount) {
  if (!usageCount || usageCount <= 0) return 0;
  return Math.min(0.12, Math.log1p(usageCount) * 0.02);
}

function _fieldBoost(contextText, palace) {
  const normalizedQuery = normalizeText(contextText);
  if (!normalizedQuery) return 0;

  const queryTokens = new Set(normalizedQuery.split(' ').filter(Boolean));
  const queryPhrases = _extractQueryPhrases(normalizedQuery);

  let score = 0;
  score += _weightedFieldMatch(queryTokens, queryPhrases, palace.name, 0.08);
  score += _weightedFieldMatch(queryTokens, queryPhrases, palace.description, 0.12);
  score += _weightedFieldMatch(queryTokens, queryPhrases, palace.scope, 0.16);
  score += _weightedFieldMatch(queryTokens, queryPhrases, palace.l0_body, 0.12);
  score += _keywordBoost(queryTokens, queryPhrases, palace.keywords || []);

  return Math.min(0.25, score);
}

function _weightedFieldMatch(queryTokens, queryPhrases, fieldValue, maxWeight) {
  const normalizedField = normalizeText(fieldValue);
  if (!normalizedField) return 0;

  const fieldTokens = new Set(normalizedField.split(' ').filter(Boolean));
  const tokenOverlap = _tokenOverlapRatio(queryTokens, fieldTokens);
  const phraseMatch = _phraseMatchScore(queryPhrases, normalizedField);

  return Math.min(maxWeight, (tokenOverlap * maxWeight * 0.6) + (phraseMatch * maxWeight * 0.4));
}

function _keywordBoost(queryTokens, queryPhrases, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return 0;

  let score = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) continue;

    if (queryPhrases.has(normalizedKeyword)) {
      score += 0.14;
      continue;
    }

    const keywordTokens = new Set(normalizedKeyword.split(' ').filter(Boolean));
    const overlap = _tokenOverlapRatio(queryTokens, keywordTokens);
    score += overlap * 0.08;
  }

  return Math.min(0.18, score);
}

function _tokenOverlapRatio(queryTokens, fieldTokens) {
  if (queryTokens.size === 0 || fieldTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function _phraseMatchScore(queryPhrases, normalizedField) {
  if (queryPhrases.size === 0 || !normalizedField) return 0;

  let matched = 0;
  for (const phrase of queryPhrases) {
    if (normalizedField.includes(phrase)) matched += 1;
  }
  return matched / queryPhrases.size;
}

function _extractQueryPhrases(normalizedQuery) {
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const phrases = new Set();

  if (tokens.length > 0) {
    phrases.add(tokens.join(' '));
  }

  for (let i = 0; i < tokens.length - 1; i += 1) {
    phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
  }

  return phrases;
}

