/**
 * searcher.js — Find anything. Exact words.
 *
 * Semantic search against the palace.
 * Returns verbatim text — the actual words, never summaries.
 */

import path from 'path';

export class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchError';
  }
}

/**
 * Build a where-filter from wing/room options.
 * Exported for unit testing.
 */
export function buildWhereFilter({ wing, room, hall, closet } = {}) {
  const conditions = [];
  if (wing)   conditions.push({ wing });
  if (hall)   conditions.push({ hall });
  if (room)   conditions.push({ room });
  if (closet) conditions.push({ closet });

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { $and: conditions };
}

/**
 * Search the palace — prints verbatim drawer content to console.
 *
 * @param {string} query - Search query text
 * @param {import('./vectorStore.js').VectorStore} store - VectorStore instance
 * @param {Object} [options]
 * @param {string} [options.wing] - Filter by wing name
 * @param {string} [options.room] - Filter by room name
 * @param {number} [options.nResults=5] - Max results
 */
export async function search(query, store, { wing, room, nResults = 5 } = {}) {
  const where = buildWhereFilter({ wing, room });

  const kwargs = {
    queryTexts: [query],
    nResults,
  };
  if (Object.keys(where).length > 0) {
    kwargs.where = where;
  }

  let results;
  try {
    results = await store.query(kwargs);
  } catch (err) {
    console.log(`\n  Search error: ${err.message}`);
    throw new SearchError(`Search error: ${err.message}`);
  }

  const docs = results.documents[0];
  const metas = results.metadatas[0];
  const dists = results.distances[0];

  if (!docs || docs.length === 0) {
    console.log(`\n  No results found for: "${query}"`);
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Results for: "${query}"`);
  if (wing) console.log(`  Wing: ${wing}`);
  if (room) console.log(`  Room: ${room}`);
  console.log(`${'='.repeat(60)}\n`);

  docs.forEach((doc, i) => {
    const meta = metas[i];
    const dist = dists[i];
    const similarity = Math.round((1 - dist) * 1000) / 1000;
    const source = path.basename(meta.source_file || '?');
    const wingName = meta.wing || '?';
    const roomName = meta.room || '?';

    console.log(`  [${i + 1}] ${wingName} / ${roomName}`);
    console.log(`      Source: ${source}`);
    console.log(`      Match:  ${similarity}`);
    console.log('');

    for (const line of doc.trim().split('\n')) {
      console.log(`      ${line}`);
    }
    console.log('');
    console.log(`  ${'─'.repeat(56)}`);
  });

  console.log('');
}

/**
 * Programmatic search — returns a dict instead of printing.
 * Used by the MCP server and other callers that need data.
 *
 * @param {string} query - Search query text
 * @param {import('./vectorStore.js').VectorStore} store - VectorStore instance
 * @param {Object} [options]
 * @param {string} [options.wing] - Filter by wing name
 * @param {string} [options.room] - Filter by room name
 * @param {number} [options.nResults=5] - Max results
 * @returns {Promise<Object>} Search results or error object
 */
export async function searchMemories(query, store, { wing, room, hall, closet, nResults = 5 } = {}) {
  const where = buildWhereFilter({ wing, room, hall, closet });

  const kwargs = { queryTexts: [query], nResults };
  if (Object.keys(where).length > 0) {
    kwargs.where = where;
  }

  let results;
  try {
    results = await store.query(kwargs);
  } catch (err) {
    return { error: `Search error: ${err.message}` };
  }

  const docs = results.documents[0];
  const metas = results.metadatas[0];
  const dists = results.distances[0];

  const hits = docs.map((doc, i) => ({
    text:         doc,
    wing:         metas[i].wing        || null,
    wing_name:    metas[i].wing_name   || null,
    hall:         metas[i].hall        || null,
    hall_name:    metas[i].hall_name   || null,
    room:         metas[i].room        || null,
    room_name:    metas[i].room_name   || null,
    closet:       metas[i].closet      || null,
    closet_name:  metas[i].closet_name || null,
    source_file:  path.basename(metas[i].source_file || '?'),
    similarity:   Math.round((1 - dists[i]) * 1000) / 1000,
  }));

  return {
    query,
    filters: { wing: wing || null, hall: hall || null, room: room || null, closet: closet || null },
    results: hits,
  };
}
