/**
 * mempalacePipeline.js — Pure routing and storage pipeline
 * =========================================================
 *
 * Stateless functions extracted from mcpServer.js so they can be
 * imported by benchmarks, tests, and other tooling without pulling
 * in the MCP server's singleton state (_activePalace, _stores, etc.).
 *
 * mcpServer.js imports everything it needs from here.
 *
 * Exports:
 *   HALL_DESCRIPTIONS  — hall id → description string
 *   IMPORTANCE_SIGNALS — tier → regex[] for importance scoring
 *   SLUG_STOP          — stop-word set for room slug generation
 *   dotProduct()       — cosine similarity on L2-normalised vectors
 *   getHallVectors()   — lazily embeds and caches hall descriptions
 *   slugifyRoom()      — top-k keyword room slug from text
 *   selectPalace()     — cosine sim palace selection → { name, similarity }
 *   selectHall()       — cosine sim hall selection → hall id string
 *   scoreImportance()  — regex-based importance score 1-5
 *   pipelineSave()     — embed + route + store one piece of content
 *   pipelineSearch()   — room-filtered search with full-search fallback
 */

import crypto from 'crypto';
import { Embedder } from './embedder.js';
import { searchMemories } from './searcher.js';

// ── Hall descriptions ─────────────────────────────────────────────────────────

export const HALL_DESCRIPTIONS = {
  hall_facts:       'facts decisions technical choices architecture context background what was decided and why reasons rationale',
  hall_events:      'milestones events deployments breakthroughs things that happened shipped released completed achieved finished',
  hall_preferences: 'preferences style habits rules conventions how to behave always do this never do that communication style',
  hall_discoveries: 'bugs problems root causes debugging errors crashes what went wrong investigation findings workarounds',
  hall_advice:      'advice best practices tips lessons learned recommendations what to do next time guidance key insights',
};

// ── Importance signals ────────────────────────────────────────────────────────

export const IMPORTANCE_SIGNALS = {
  high: [
    /\bcritical\b/i, /\bmust\b/i, /\bimportant\b/i, /\bnever forget\b/i,
    /\balways remember\b/i, /\bbreaking\b/i, /\bsecurity\b/i,
    /\bproduction\b/i, /\blive\b/i, /\bdeadline\b/i,
  ],
  medium_high: [
    /\bshipped\b/i, /\bdeployed\b/i, /\breleased\b/i, /\bbreakthrough\b/i,
    /\bfixed\b/i, /\bsolved\b/i, /\bfinally\b/i,
  ],
  medium_low: [
    /\btried\b/i, /\battempted\b/i, /\bworking on\b/i,
    /\bexploring\b/i, /\bconsidering\b/i,
  ],
  low: [
    /\bfyi\b/i, /\bjust a note\b/i, /\bminor\b/i, /\btrivial\b/i,
  ],
};

// ── Stop words for room slug generation ──────────────────────────────────────

export const SLUG_STOP = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','it','its',
  'i','we','you','he','she','they','me','him','her','us','them','my',
  'this','that','these','those','and','but','or','not','in','on','at',
  'to','of','for','with','as','by','from','into','about','so','if',
  'just','also','then','when','what','which','how','why','get','got',
  'use','used','using','make','made','can','now','let','very','really',
]);

// ── Hall vector cache ─────────────────────────────────────────────────────────

let _hallVectors = null;

/**
 * Lazily embeds HALL_DESCRIPTIONS and caches the result.
 * @returns {Promise<Object.<string, number[]>>}
 */
export async function getHallVectors() {
  if (_hallVectors) return _hallVectors;
  const embedder = new Embedder();
  const entries = Object.entries(HALL_DESCRIPTIONS);
  const vecs = await embedder.embedBatch(entries.map(([, desc]) => desc));
  _hallVectors = Object.fromEntries(entries.map(([hall], i) => [hall, vecs[i]]));
  return _hallVectors;
}

// ── Math ─────────────────────────────────────────────────────────────────────

/**
 * Dot product of two equal-length arrays.
 * For L2-normalised vectors this equals cosine similarity.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── Room slug ─────────────────────────────────────────────────────────────────

/**
 * Derive a room slug from text: top-k most frequent non-stop keywords,
 * returned in document order, joined with dashes.
 * @param {string} text
 * @param {number} maxWords
 * @returns {string}
 */
export function slugifyRoom(text, maxWords = 4) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !SLUG_STOP.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const ranked = new Set(
    Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, maxWords).map(([w]) => w)
  );
  const ordered = [];
  for (const w of words) {
    if (ranked.has(w) && !ordered.includes(w)) {
      ordered.push(w);
      if (ordered.length === maxWords) break;
    }
  }
  return ordered.join('-') || 'general';
}

// ── Palace selection ──────────────────────────────────────────────────────────

/**
 * Select the best palace for a content vector using cosine similarity
 * against each palace's scope_vector. Falls back to the default palace
 * if no palaces have scope vectors yet.
 *
 * @param {number[]} contentVector  — L2-normalised embedding
 * @param {Array}    palaces        — from PalaceRegistry.getAll()
 * @returns {{ name: string, similarity: number }}
 */
export function selectPalace(contentVector, palaces) {
  if (!palaces || palaces.length === 0) return { name: 'personality_memory_palace', similarity: 0 };

  const defaultPalace = palaces.find(p => p.is_default) || palaces[0];
  const vectored = palaces.filter(p => p.scope_vector);

  if (vectored.length > 0) {
    let best = defaultPalace;
    let bestSim = -1;
    for (const p of vectored) {
      const sim = dotProduct(contentVector, p.scope_vector);
      if (sim > bestSim) { bestSim = sim; best = p; }
    }
    return { name: best.name || defaultPalace.name, similarity: bestSim };
  }

  return { name: (defaultPalace && defaultPalace.name) || 'personality_memory_palace', similarity: 0 };
}

// ── Hall selection ────────────────────────────────────────────────────────────

/**
 * Select the best hall for a content vector using cosine similarity
 * against pre-embedded hall descriptions.
 *
 * @param {number[]} contentVector  — L2-normalised embedding
 * @param {Object}   hallVectors    — from getHallVectors()
 * @returns {string}  — hall id, e.g. 'hall_facts'
 */
export function selectHall(contentVector, hallVectors) {
  let best = 'hall_facts';
  let bestSim = -1;
  for (const [hall, vec] of Object.entries(hallVectors)) {
    const sim = dotProduct(contentVector, vec);
    if (sim > bestSim) { bestSim = sim; best = hall; }
  }
  return best;
}

// ── Importance scoring ────────────────────────────────────────────────────────

/**
 * Score content importance 1-5 based on signal keywords and length.
 * @param {string} content
 * @param {string} [context]
 * @returns {number}  — integer 1..5
 */
export function scoreImportance(content, context = '') {
  const combined = `${content}\n${context}`;
  let score = 2.0;
  for (const [tier, patterns] of Object.entries(IMPORTANCE_SIGNALS)) {
    const count = patterns.filter(re => re.test(combined)).length;
    if (tier === 'high')        score += Math.min(count * 1.0, 2.0);
    if (tier === 'medium_high') score += Math.min(count * 0.5, 1.0);
    if (tier === 'medium_low')  score -= Math.min(count * 0.25, 0.5);
    if (tier === 'low')         score -= Math.min(count * 0.5, 1.0);
  }
  if (combined.length > 800) score += 0.5;
  if (combined.length < 80)  score -= 0.5;
  return Math.min(5, Math.max(1, Math.round(score)));
}

// ── Pipeline save ─────────────────────────────────────────────────────────────

/**
 * Embed content, route to hall + room, and store in the given VectorStore.
 * Does NOT perform deduplication — caller is responsible if needed.
 *
 * @param {Object} opts
 * @param {string} opts.content
 * @param {string} [opts.context]
 * @param {string} opts.palaceName   — used as metadata field only
 * @param {Object} opts.store        — VectorStore instance (already init'd)
 * @param {string} [opts.addedBy]
 * @returns {Promise<{ drawerId, room, hall, palaceName, importance }>}
 */
export async function pipelineSave({ content, context = '', palaceName, store, addedBy = 'benchmark' }) {
  const embedder = new Embedder();
  const combined = `${content}\n${context}`;

  const [contentVector, hallVectors] = await Promise.all([
    embedder.embed(combined),
    getHallVectors(),
  ]);

  const hall = selectHall(contentVector, hallVectors);
  const room = slugifyRoom(combined);
  const importance = scoreImportance(content, context);

  const hash = crypto
    .createHash('md5')
    .update(content.slice(0, 100) + Date.now().toString())
    .digest('hex')
    .slice(0, 12);
  const drawerId = `drawer_${room}_${hash}`;

  await store.add({
    ids: [drawerId],
    documents: [content],
    metadatas: [{
      room,
      hall,
      palace: palaceName,
      importance,
      added_by: addedBy,
      filed_at: new Date().toISOString(),
    }],
  });

  return { drawerId, room, hall, palaceName, importance };
}

// ── Pipeline search ───────────────────────────────────────────────────────────

/**
 * Search a VectorStore with optional room filter, falling back to
 * unfiltered search if the filtered result is empty.
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {Object} opts.store         — VectorStore instance
 * @param {string} [opts.estimatedRoom] — room filter derived from question keywords
 * @param {number} [opts.nResults]
 * @returns {Promise<Object>}  — searchMemories() result shape
 */
export async function pipelineSearch({ query, store, estimatedRoom = null, nResults = 10 }) {
  if (estimatedRoom && estimatedRoom !== 'general') {
    const filtered = await searchMemories(query, store, { room: estimatedRoom, nResults });
    if (filtered.results && filtered.results.length > 0) {
      return { ...filtered, room_filter_used: true };
    }
  }
  const result = await searchMemories(query, store, { nResults });
  return { ...result, room_filter_used: false };
}
