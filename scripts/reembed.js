/**
 * Re-embed all Qdrant collections with the current Embedder model.
 * Run after changing the embedding model to rebuild all vectors.
 *
 * Usage (inside dev container):
 *   node scripts/reembed.js
 */

import { QdrantClient } from '@qdrant/qdrant-js';
import { Embedder } from '../src/embedder.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const BATCH_SIZE = 10;
const SCROLL_LIMIT = 100;

const client = new QdrantClient({ url: QDRANT_URL });
const embedder = new Embedder();

async function listCollections() {
  const result = await client.getCollections();
  return result.collections.map((c) => c.name);
}

async function reembedCollection(collectionName) {
  console.log(`\n[${collectionName}] starting...`);

  let offset;
  let total = 0;
  let reembedded = 0;

  while (true) {
    const params = { limit: SCROLL_LIMIT, with_payload: true, with_vector: false };
    if (offset !== undefined) params.offset = offset;

    const page = await client.scroll(collectionName, params);
    const points = page.points;

    if (points.length === 0) break;

    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      const texts = batch.map((p) => p.payload.document || '');
      const vectors = await embedder.embedBatch(texts);

      const upsertPoints = batch.map((p, j) => ({
        id: p.id,
        vector: vectors[j],
        payload: p.payload,
      }));

      await client.upsert(collectionName, { points: upsertPoints });
      reembedded += batch.length;
      process.stdout.write(`\r[${collectionName}] ${reembedded} points re-embedded...`);
    }

    total += points.length;
    if (!page.next_page_offset) break;
    offset = page.next_page_offset;
  }

  console.log(`\r[${collectionName}] done — ${reembedded} points re-embedded.`);
  return reembedded;
}

async function main() {
  console.log('Connecting to Qdrant:', QDRANT_URL);
  const collections = await listCollections();
  console.log('Collections found:', collections);

  let grandTotal = 0;
  for (const name of collections) {
    const count = await reembedCollection(name);
    grandTotal += count;
  }

  console.log(`\nAll done. ${grandTotal} total points re-embedded across ${collections.length} collections.`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
