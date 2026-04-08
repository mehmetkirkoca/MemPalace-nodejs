/**
 * layers.js — 4-Layer Memory Stack for mempalace
 * ===================================================
 *
 * Load only what you need, when you need it.
 *
 *   Layer 0: Identity       (~100 tokens)   — Always loaded. "Who am I?"
 *   Layer 1: Essential Story (~500-800)      — Always loaded. Top moments from the palace.
 *   Layer 2: On-Demand      (~200-500 each)  — Loaded when a topic/wing comes up.
 *   Layer 3: Deep Search    (unlimited)      — Full semantic search via Qdrant.
 *
 * Wake-up cost: ~600-900 tokens (L0+L1). Leaves 95%+ of context free.
 *
 * Reads from Qdrant (mempalace_drawers) and ~/.mempalace/identity.txt.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { VectorStore } from './vectorStore.js';
import { getConfig } from './config.js';

// ---------------------------------------------------------------------------
// Layer 0 — Identity
// ---------------------------------------------------------------------------

export class Layer0 {
  /**
   * ~100 tokens. Always loaded.
   * Reads from ~/.mempalace/identity.txt — a plain-text file the user writes.
   *
   * @param {string} [identityPath] - Override identity file path.
   */
  constructor(identityPath) {
    this.path = identityPath || path.join(os.homedir(), '.mempalace', 'identity.txt');
    this._text = null;
  }

  /**
   * Return the identity text, or a sensible default.
   * @returns {string}
   */
  render() {
    if (this._text !== null) {
      return this._text;
    }

    if (fs.existsSync(this.path)) {
      this._text = fs.readFileSync(this.path, 'utf-8').trim();
    } else {
      this._text = '## L0 — IDENTITY\nNo identity configured. Create ~/.mempalace/identity.txt';
    }

    return this._text;
  }

  /**
   * Rough token estimate (~4 chars per token).
   * @returns {number}
   */
  tokenEstimate() {
    return Math.floor(this.render().length / 4);
  }
}

// ---------------------------------------------------------------------------
// Layer 1 — Essential Story (auto-generated from palace)
// ---------------------------------------------------------------------------

export class Layer1 {
  /**
   * ~500-800 tokens. Always loaded.
   * Auto-generated from the highest-weight / most-recent drawers in the palace.
   *
   * @param {Object} [options]
   * @param {VectorStore} [options.store] - VectorStore instance
   * @param {string} [options.wing] - Optional wing filter
   */

  static MAX_DRAWERS = 15;
  static MAX_CHARS = 3200;

  constructor({ store, wing } = {}) {
    this.store = store;
    this.wing = wing || null;
  }

  /**
   * Pull top drawers from Qdrant and format as compact L1 text.
   * @returns {Promise<string>}
   */
  async generate() {
    if (!this.store) {
      return '## L1 — No palace found. Run: mempalace mine <dir>';
    }

    let docs, metas;
    try {
      const where = this.wing ? { wing: this.wing } : undefined;
      // Fetch drawers in batches to respect Qdrant limits
      const BATCH = 500;
      docs = [];
      metas = [];
      let fetched = 0;

      while (true) {
        let batch;
        try {
          batch = await this.store.get({ where, limit: BATCH });
        } catch {
          break;
        }

        const batchDocs = batch.documents || [];
        const batchMetas = batch.metadatas || [];
        if (batchDocs.length === 0) break;

        docs.push(...batchDocs);
        metas.push(...batchMetas);
        fetched += batchDocs.length;
        if (batchDocs.length < BATCH) break;
        // VectorStore.get() does not support offset-based pagination in the
        // same way as the Python code.  For the first release we fetch one
        // batch; this is sufficient for most palaces (500 drawers).
        break;
      }
    } catch {
      return '## L1 — No palace found. Run: mempalace mine <dir>';
    }

    if (docs.length === 0) {
      return '## L1 — No memories yet.';
    }

    // Score each drawer: prefer high importance, recent filing
    const scored = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const meta = metas[i];
      let importance = 3;
      for (const key of ['importance', 'emotional_weight', 'weight']) {
        const val = meta[key];
        if (val !== undefined && val !== null) {
          const parsed = Number(val);
          if (!Number.isNaN(parsed)) {
            importance = parsed;
          }
          break;
        }
      }
      scored.push({ importance, meta, doc });
    }

    // Sort by importance descending, take top N
    scored.sort((a, b) => b.importance - a.importance);
    const top = scored.slice(0, Layer1.MAX_DRAWERS);

    // Group by room for readability
    const byRoom = new Map();
    for (const { importance, meta, doc } of top) {
      const room = meta.room || 'general';
      if (!byRoom.has(room)) {
        byRoom.set(room, []);
      }
      byRoom.get(room).push({ importance, meta, doc });
    }

    // Build compact text
    const lines = ['## L1 — ESSENTIAL STORY'];
    let totalLen = 0;

    const sortedRooms = [...byRoom.keys()].sort();
    for (const room of sortedRooms) {
      const entries = byRoom.get(room);
      const roomLine = `\n[${room}]`;
      lines.push(roomLine);
      totalLen += roomLine.length;

      for (const { meta, doc } of entries) {
        const sourceFile = meta.source_file || '';
        const source = sourceFile ? path.basename(sourceFile) : '';

        // Truncate doc to keep L1 compact
        let snippet = doc.trim().replace(/\n/g, ' ');
        if (snippet.length > 200) {
          snippet = snippet.slice(0, 197) + '...';
        }

        let entryLine = `  - ${snippet}`;
        if (source) {
          entryLine += `  (${source})`;
        }

        if (totalLen + entryLine.length > Layer1.MAX_CHARS) {
          lines.push('  ... (more in L3 search)');
          return lines.join('\n');
        }

        lines.push(entryLine);
        totalLen += entryLine.length;
      }
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — On-Demand (wing/room filtered retrieval)
// ---------------------------------------------------------------------------

export class Layer2 {
  /**
   * ~200-500 tokens per retrieval.
   * Loaded when a specific topic or wing comes up in conversation.
   *
   * @param {Object} [options]
   * @param {VectorStore} [options.store] - VectorStore instance
   */
  constructor({ store } = {}) {
    this.store = store;
  }

  /**
   * Retrieve drawers filtered by wing and/or room.
   * @param {Object} [options]
   * @param {string} [options.wing]
   * @param {string} [options.room]
   * @param {number} [options.nResults=10]
   * @returns {Promise<string>}
   */
  async retrieve({ wing, room, nResults = 10 } = {}) {
    if (!this.store) {
      return 'No palace found.';
    }

    let where;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    let results;
    try {
      results = await this.store.get({ where, limit: nResults });
    } catch (err) {
      return `Retrieval error: ${err.message}`;
    }

    const docs = results.documents || [];
    const metas = results.metadatas || [];

    if (docs.length === 0) {
      let label = wing ? `wing=${wing}` : '';
      if (room) {
        label += label ? ` room=${room}` : `room=${room}`;
      }
      return `No drawers found for ${label}.`;
    }

    const lines = [`## L2 — ON-DEMAND (${docs.length} drawers)`];
    const limit = Math.min(docs.length, nResults);
    for (let i = 0; i < limit; i++) {
      const doc = docs[i];
      const meta = metas[i];
      const roomName = meta.room || '?';
      const sourceFile = meta.source_file || '';
      const source = sourceFile ? path.basename(sourceFile) : '';

      let snippet = doc.trim().replace(/\n/g, ' ');
      if (snippet.length > 300) {
        snippet = snippet.slice(0, 297) + '...';
      }

      let entry = `  [${roomName}] ${snippet}`;
      if (source) {
        entry += `  (${source})`;
      }
      lines.push(entry);
    }

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Layer 3 — Deep Search (full semantic search via Qdrant)
// ---------------------------------------------------------------------------

export class Layer3 {
  /**
   * Unlimited depth. Semantic search against the full palace.
   *
   * @param {Object} [options]
   * @param {VectorStore} [options.store] - VectorStore instance
   */
  constructor({ store } = {}) {
    this.store = store;
  }

  /**
   * Semantic search, returns compact result text.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.wing]
   * @param {string} [options.room]
   * @param {number} [options.nResults=5]
   * @returns {Promise<string>}
   */
  async search(query, { wing, room, nResults = 5 } = {}) {
    if (!this.store) {
      return 'No palace found.';
    }

    let where;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    const kwargs = {
      queryTexts: [query],
      nResults,
    };
    if (where) {
      kwargs.where = where;
    }

    let results;
    try {
      results = await this.store.query(kwargs);
    } catch (err) {
      return `Search error: ${err.message}`;
    }

    const docs = results.documents[0];
    const metas = results.metadatas[0];
    const dists = results.distances[0];

    if (!docs || docs.length === 0) {
      return 'No results found.';
    }

    const lines = [`## L3 — SEARCH RESULTS for "${query}"`];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const meta = metas[i];
      const dist = dists[i];
      const similarity = Math.round((1 - dist) * 1000) / 1000;
      const wingName = meta.wing || '?';
      const roomName = meta.room || '?';
      const sourceFile = meta.source_file || '';
      const source = sourceFile ? path.basename(sourceFile) : '';

      let snippet = doc.trim().replace(/\n/g, ' ');
      if (snippet.length > 300) {
        snippet = snippet.slice(0, 297) + '...';
      }

      lines.push(`  [${i + 1}] ${wingName}/${roomName} (sim=${similarity})`);
      lines.push(`      ${snippet}`);
      if (source) {
        lines.push(`      src: ${source}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Return raw objects instead of formatted text.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.wing]
   * @param {string} [options.room]
   * @param {number} [options.nResults=5]
   * @returns {Promise<Array>}
   */
  async searchRaw(query, { wing, room, nResults = 5 } = {}) {
    if (!this.store) {
      return [];
    }

    let where;
    if (wing && room) {
      where = { $and: [{ wing }, { room }] };
    } else if (wing) {
      where = { wing };
    } else if (room) {
      where = { room };
    }

    const kwargs = {
      queryTexts: [query],
      nResults,
    };
    if (where) {
      kwargs.where = where;
    }

    let results;
    try {
      results = await this.store.query(kwargs);
    } catch {
      return [];
    }

    const docs = results.documents[0];
    const metas = results.metadatas[0];
    const dists = results.distances[0];

    const hits = [];
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const meta = metas[i];
      const dist = dists[i];
      hits.push({
        text: doc,
        wing: meta.wing || 'unknown',
        room: meta.room || 'unknown',
        source_file: path.basename(meta.source_file || '?'),
        similarity: Math.round((1 - dist) * 1000) / 1000,
        metadata: meta,
      });
    }

    return hits;
  }
}

// ---------------------------------------------------------------------------
// MemoryStack — unified interface
// ---------------------------------------------------------------------------

export class MemoryStack {
  /**
   * The full 4-layer stack. One class, one palace, everything works.
   *
   *   const stack = new MemoryStack();
   *   await stack.init();
   *   console.log(await stack.wakeUp());              // L0 + L1 (~600-900 tokens)
   *   console.log(await stack.recall({ wing: 'my_app' }));  // L2 on-demand
   *   console.log(await stack.search('pricing change'));     // L3 deep search
   *
   * @param {Object} [options]
   * @param {string} [options.identityPath] - Override identity file path
   * @param {VectorStore} [options.store] - Inject a VectorStore (for testing)
   */
  constructor({ identityPath, store } = {}) {
    const cfg = getConfig();

    this.identityPath = identityPath || path.join(os.homedir(), '.mempalace', 'identity.txt');
    this.store = store || new VectorStore({ qdrantUrl: cfg.qdrantUrl, collectionName: cfg.collectionName });

    this.l0 = new Layer0(this.identityPath);
    this.l1 = new Layer1({ store: this.store });
    this.l2 = new Layer2({ store: this.store });
    this.l3 = new Layer3({ store: this.store });
  }

  /**
   * Initialize the vector store connection. Call once before using async methods.
   */
  async init() {
    await this.store.init();
  }

  /**
   * Generate wake-up text: L0 (identity) + L1 (essential story).
   * Typically ~600-900 tokens. Inject into system prompt or first message.
   *
   * @param {Object} [options]
   * @param {string} [options.wing] - Optional wing filter for L1 (project-specific wake-up)
   * @returns {Promise<string>}
   */
  async wakeUp({ wing } = {}) {
    const parts = [];

    // L0: Identity
    parts.push(this.l0.render());
    parts.push('');

    // L1: Essential Story
    if (wing) {
      this.l1.wing = wing;
    }
    parts.push(await this.l1.generate());

    return parts.join('\n');
  }

  /**
   * On-demand L2 retrieval filtered by wing/room.
   * @param {Object} [options]
   * @param {string} [options.wing]
   * @param {string} [options.room]
   * @param {number} [options.nResults=10]
   * @returns {Promise<string>}
   */
  async recall({ wing, room, nResults = 10 } = {}) {
    return this.l2.retrieve({ wing, room, nResults });
  }

  /**
   * Deep L3 semantic search.
   * @param {string} query
   * @param {Object} [options]
   * @param {string} [options.wing]
   * @param {string} [options.room]
   * @param {number} [options.nResults=5]
   * @returns {Promise<string>}
   */
  async search(query, { wing, room, nResults = 5 } = {}) {
    return this.l3.search(query, { wing, room, nResults });
  }

  /**
   * Status of all layers.
   * @returns {Promise<Object>}
   */
  async status() {
    const result = {
      L0_identity: {
        path: this.identityPath,
        exists: fs.existsSync(this.identityPath),
        tokens: this.l0.tokenEstimate(),
      },
      L1_essential: {
        description: 'Auto-generated from top palace drawers',
      },
      L2_on_demand: {
        description: 'Wing/room filtered retrieval',
      },
      L3_deep_search: {
        description: 'Full semantic search via Qdrant',
      },
    };

    // Count drawers
    try {
      const count = await this.store.count();
      result.total_drawers = count;
    } catch {
      result.total_drawers = 0;
    }

    return result;
  }
}
