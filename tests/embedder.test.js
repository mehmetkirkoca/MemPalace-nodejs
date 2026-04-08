import { describe, it, expect } from 'vitest';
import { Embedder } from '../src/embedder.js';

describe('Embedder', () => {
  let embedder;

  it('should create embedder instance', () => {
    embedder = new Embedder();
    expect(embedder).toBeDefined();
  });

  it('should embed single text to 384-dim vector', async () => {
    embedder = new Embedder();
    const vector = await embedder.embed('Hello world');
    expect(vector).toHaveLength(384);
    expect(typeof vector[0]).toBe('number');
  }, 60000);

  it('should embed batch of texts', async () => {
    embedder = new Embedder();
    const vectors = await embedder.embedBatch(['Hello', 'World']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
  }, 60000);

  it('should return similar vectors for similar text', async () => {
    embedder = new Embedder();
    const v1 = await embedder.embed('The cat sat on the mat');
    const v2 = await embedder.embed('A cat is sitting on a mat');
    const v3 = await embedder.embed('Nuclear physics equation');
    const sim12 = cosineSim(v1, v2);
    const sim13 = cosineSim(v1, v3);
    expect(sim12).toBeGreaterThan(sim13);
  }, 60000);
});

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
