import { pipeline } from '@huggingface/transformers';

// Limit ONNX Runtime to 2 intra-op threads so concurrent callers
// don't saturate all CPU cores. Keeps the machine responsive.
const ONNX_THREADS = parseInt(process.env.ONNX_THREADS || '2', 10);

export class Embedder {
  constructor(modelName = 'Xenova/all-MiniLM-L6-v2') {
    this._modelName = modelName;
    this._pipe = null;
    // Serialization queue: ensures only one inference runs at a time
    // even when multiple async callers call embed() concurrently.
    this._queue = Promise.resolve();
  }

  async _getPipeline() {
    if (!this._pipe) {
      this._pipe = await pipeline('feature-extraction', this._modelName, {
        dtype: 'fp32',
        session_options: { intra_op_num_threads: ONNX_THREADS },
      });
    }
    return this._pipe;
  }

  // Schedule fn to run after all currently queued work completes.
  _enqueue(fn) {
    const result = this._queue.then(fn);
    // Swallow errors in the chain so a failure doesn't block the queue.
    this._queue = result.catch(() => {});
    return result;
  }

  async embed(text) {
    return this._enqueue(async () => {
      const pipe = await this._getPipeline();
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    });
  }

  async embedBatch(texts) {
    return this._enqueue(async () => {
      const pipe = await this._getPipeline();
      const results = [];
      for (const text of texts) {
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        results.push(Array.from(output.data));
      }
      return results;
    });
  }
}
