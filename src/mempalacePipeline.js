/**
 * mempalacePipeline.js — Storage and search pipeline
 * ====================================================
 *
 * pipelineSave()   — categorize (LLM or caller) + embed + store
 * pipelineSearch() — pure semantic search (Qdrant handles ranking)
 */

import crypto from 'crypto';
import { Neo4jClusterStore } from './neo4jClusterStore.js';
import { categorize } from './categorizer.js';
import { searchMemories } from './searcher.js';

// ── Pipeline save ─────────────────────────────────────────────────────────────

/**
 * Categorize, embed, and store one piece of content.
 *
 * @param {Object} opts
 * @param {string}  opts.content
 * @param {string}  opts.palaceName
 * @param {Object}  opts.store        — VectorStore instance
 * @param {string}  [opts.addedBy]
 * @param {string}  [opts.wing]       — provided by caller, skips categorizer
 * @param {string}  [opts.hall]
 * @param {string}  [opts.room]
 * @param {string}  [opts.closet]
 * @returns {Promise<{ drawerId, wingId, hallId, roomId, closetId, wing, hall, room, closet }>}
 */
export async function pipelineSave({
  content,
  palaceName,
  store,
  addedBy = 'benchmark',
  wing,
  hall,
  room,
  closet,
}) {
  const clusters = new Neo4jClusterStore(palaceName);

  // ── Categorize if not provided by caller ─────────────────────────────────────
  if (!wing || !hall || !room || !closet) {
    const taxonomyText = await clusters.getTaxonomyText();
    const result = await categorize(content, taxonomyText);
    wing   = result.wing;
    hall   = result.hall;
    room   = result.room;
    closet = result.closet;
  }

  const { wingId, hallId, roomId, closetId } = await clusters.assign(wing, hall, room, closet);

  // ── Store ────────────────────────────────────────────────────────────────────
  const hash = crypto
    .createHash('md5')
    .update(content.slice(0, 100) + Date.now().toString())
    .digest('hex')
    .slice(0, 12);
  const drawerId = `dra_${hash}`;

  await store.add({
    ids: [drawerId],
    documents: [content],
    metadatas: [{
      wing:        wingId,
      wing_name:   wing,
      hall:        hallId,
      hall_name:   hall,
      room:        roomId,
      room_name:   room,
      closet:      closetId,
      closet_name: closet,
      palace:      palaceName,
      added_by:    addedBy,
      filed_at:    new Date().toISOString(),
    }],
  });

  return { drawerId, wingId, hallId, roomId, closetId, wing, hall, room, closet };
}

// ── Pipeline search ───────────────────────────────────────────────────────────

/**
 * Pure semantic search — Qdrant handles ranking by vector similarity.
 * Optional wing/hall/room filters narrow the search scope.
 *
 * @param {Object} opts
 * @param {string}  opts.query
 * @param {Object}  opts.store
 * @param {number}  [opts.nResults=10]
 * @param {string}  [opts.wing]   — filter by wing ID
 * @param {string}  [opts.hall]   — filter by hall ID
 * @param {string}  [opts.room]   — filter by room ID
 * @returns {Promise<Object>}
 */
export async function pipelineSearch({ query, store, nResults = 10, wing, hall, room }) {
  return searchMemories(query, store, { wing, hall, room, nResults });
}
