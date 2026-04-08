import { pipeline } from '@huggingface/transformers';

export class Embedder {
  constructor(modelName = 'Xenova/all-MiniLM-L6-v2') {
    this._modelName = modelName;
    this._pipe = null;
  }

  async _getPipeline() {
    if (!this._pipe) {
      this._pipe = await pipeline('feature-extraction', this._modelName, {
        dtype: 'fp32',
      });
    }
    return this._pipe;
  }

  async embed(text) {
    const pipe = await this._getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  async embedBatch(texts) {
    const pipe = await this._getPipeline();
    const results = [];
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data));
    }
    return results;
  }
}
