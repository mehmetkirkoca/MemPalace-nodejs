/**
 * benchmarks/lib.js — Shared benchmark utilities
 *
 * Used by all benchmark files. Provides:
 *  - createBenchStore     VectorStore init with timestamped collection name
 *  - ingestCorpus         bulk pipelineSave → returns Map<content, corpusId>
 *  - searchQuestion       pipelineSearch with auto room-routing
 *  - llmAnswer            Claude API call for answer generation
 *  - f1Score              token-level F1 (LoCoMo)
 *  - substringMatch       case-insensitive substring (LongMemEval, ConvoMem)
 *  - saveResults          JSONL write
 *  - printSummary         recall + LLM score summary with per-category breakdown
 *  - parseCommonArgs      shared CLI flag parser
 */

import fs from 'fs';
import crypto from 'crypto';
import { VectorStore } from '../src/vectorStore.js';
import { Neo4jClusterStore } from '../src/neo4jClusterStore.js';
import { searchMemories } from '../src/searcher.js';

// =============================================================================
// VECTOR STORE
// =============================================================================

/**
 * Create and initialise a VectorStore for a benchmark palace.
 * Uses a fixed collection name (bench_<name>) — data accumulates across runs.
 * Taxonomy lives in Neo4j under the same palace name.
 *
 * @param {string} name  short label, e.g. 'longmemeval'
 * @returns {Promise<{ store: VectorStore }>}
 */
export async function createBenchStore(name) {
  const collectionName = `bench_${name}`;
  const store = new VectorStore({ collectionName });
  await store.init();
  return { store };
}

// =============================================================================
// INGEST
// =============================================================================

/**
 * Bulk-ingest corpus items into a VectorStore via pipelineSave.
 * Returns a Map from content string → corpusId for later recall scoring.
 *
 * pipelineSave does not support custom metadata, so corpusId is tracked
 * in-memory only. The Map key is the exact content string that pipelineSave
 * stores as the Qdrant document, enabling exact-string lookup on retrieval.
 *
 * @param {Array<{content: string, corpusId: string}>} items
 * @param {VectorStore} store
 * @param {string} palaceName
 * @param {{ onProgress?: Function }} opts
 * @returns {Promise<Map<string, string>>}  Map<content, corpusId>
 */
export async function ingestCorpus(items, store, palaceName, { onProgress } = {}) {
  const textToId = new Map();
  let ingested = 0;
  let skipped = 0;

  const clusters = new Neo4jClusterStore(palaceName);

  for (const { content, wing, hall, room, closet, corpusId } of items) {
    if (!content || !content.trim()) {
      skipped++;
      continue;
    }
    if (textToId.has(content)) {
      skipped++;
      continue;
    }

    const { wingId, hallId, roomId, closetId } = await clusters.assign(wing, hall, room, closet);
    const hash = crypto.createHash('md5').update(content.slice(0, 100) + Date.now()).digest('hex').slice(0, 12);
    const drawerId = `dra_${hash}`;
    await store.add({
      ids: [drawerId],
      documents: [content],
      metadatas: [{ wing: wingId, wing_name: wing, hall: hallId, hall_name: hall, room: roomId, room_name: room, closet: closetId, closet_name: closet, palace: palaceName, added_by: 'benchmark', filed_at: new Date().toISOString() }],
    });
    textToId.set(content, corpusId);
    ingested++;

    if (onProgress && ingested % 100 === 0) {
      onProgress({ ingested, skipped, total: items.length });
    }
  }

  return textToId;
}

// =============================================================================
// SEARCH
// =============================================================================

/**
 * Search with full pipeline routing: auto-computes room slug and applies
 * room-filter first, falling back to global search if no filtered results.
 *
 * @param {string} question
 * @param {VectorStore} store
 * @param {number} topK
 * @returns {Promise<Object>}  pipelineSearch result
 */
export async function searchQuestion(question, store, topK = 10) {
  return searchMemories(question, store, { nResults: topK });
}

// =============================================================================
// LLM
// =============================================================================

/**
 * Generate an answer via the Claude API given retrieved context.
 *
 * @param {string} question
 * @param {string[]} contextTexts   top-k retrieved documents
 * @param {string} apiKey
 * @param {string} model
 * @returns {Promise<string|null>}  null on error
 */
export async function llmAnswer(
  question,
  contextTexts,
  apiKey,
  model = 'claude-haiku-4-5-20251001'
) {
  const numbered = contextTexts
    .map((t, i) => `[${i + 1}] ${t.trim()}`)
    .join('\n\n');

  const prompt =
    `You are a helpful assistant. Answer the question based ONLY on the context below.\n` +
    `Be concise. If the answer is not in the context, say "I don't know."\n\n` +
    `Context:\n${numbered}\n\nQuestion: ${question}\nAnswer:`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.content[0].text.trim();
  } catch (err) {
    process.stderr.write(`  [LLM error] ${err.message}\n`);
    return null;
  }
}

// =============================================================================
// SCORING
// =============================================================================

/**
 * Token-level F1 score, case-insensitive, punctuation-stripped.
 * @param {string} pred
 * @param {string} truth
 * @returns {number}  0.0 – 1.0
 */
export function f1Score(pred, truth) {
  const tokenize = (s) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const predToks = tokenize(pred);
  const truthToks = tokenize(truth);
  if (!predToks.length || !truthToks.length) return 0;

  const predMap = new Map();
  for (const t of predToks) predMap.set(t, (predMap.get(t) || 0) + 1);
  const truthMap = new Map();
  for (const t of truthToks) truthMap.set(t, (truthMap.get(t) || 0) + 1);

  let common = 0;
  for (const [tok, cnt] of predMap) {
    if (truthMap.has(tok)) common += Math.min(cnt, truthMap.get(tok));
  }
  if (common === 0) return 0;

  const precision = common / predToks.length;
  const recall = common / truthToks.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Case-insensitive substring match in either direction.
 * @param {string} pred
 * @param {string} truth
 * @returns {boolean}
 */
export function substringMatch(pred, truth) {
  const p = pred.toLowerCase();
  const t = truth.toLowerCase();
  return p.includes(t) || t.includes(p);
}

// =============================================================================
// OUTPUT
// =============================================================================

/**
 * Write result log as JSONL.
 * @param {string} outFile
 * @param {Object[]} log
 */
export function saveResults(outFile, log) {
  const dir = path.dirname(outFile);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outFile, log.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  console.log(`  Results saved to: ${outFile}`);
}

/**
 * Print a benchmark summary: overall recall, LLM accuracy, per-category breakdown.
 *
 * @param {Object[]} log          array of result objects (one per question)
 * @param {string|null} categoryField   key in each log entry to group by, e.g. 'category'
 * @param {string} label          benchmark label for the header
 */
export function printSummary(log, categoryField = null, label = '') {
  const withRecall = log.filter((r) => r.recall_hit !== null);
  const recallHits = withRecall.filter((r) => r.recall_hit).length;
  const recall = withRecall.length ? recallHits / withRecall.length : 0;

  const withLlm = log.filter((r) => r.llm_score !== null && r.llm_score !== undefined);
  const avgLlm = withLlm.length
    ? withLlm.reduce((s, r) => s + r.llm_score, 0) / withLlm.length
    : null;

  const sep = '='.repeat(60);
  const dash = '─'.repeat(60);
  console.log(`\n${sep}`);
  if (label) console.log(`  ${label}`);
  console.log(`${sep}`);
  console.log(`  Questions:         ${log.length}`);
  console.log(
    `  Retrieval Recall:  ${(recall * 100).toFixed(1)}%  (${recallHits}/${withRecall.length})`
  );
  if (avgLlm !== null) {
    console.log(`  LLM Accuracy:      ${(avgLlm * 100).toFixed(1)}%  (n=${withLlm.length})`);
  }

  if (categoryField && log.length > 0) {
    const cats = {};
    for (const r of log) {
      const cat = r[categoryField] ?? 'unknown';
      if (!cats[cat]) cats[cat] = { recallHits: 0, recallTotal: 0, llmSum: 0, llmN: 0 };
      if (r.recall_hit !== null) {
        cats[cat].recallTotal++;
        if (r.recall_hit) cats[cat].recallHits++;
      }
      if (r.llm_score !== null && r.llm_score !== undefined) {
        cats[cat].llmSum += r.llm_score;
        cats[cat].llmN++;
      }
    }
    console.log(`\n  Per-category breakdown:`);
    console.log(`${dash}`);
    for (const [cat, v] of Object.entries(cats).sort()) {
      const r = v.recallTotal ? `${(v.recallHits / v.recallTotal * 100).toFixed(1)}%` : 'n/a';
      const l = v.llmN ? `${(v.llmSum / v.llmN * 100).toFixed(1)}%` : 'n/a';
      console.log(`    ${String(cat).padEnd(28)}  recall=${r.padStart(6)}  llm=${l.padStart(6)}`);
    }
  }

  console.log(`${sep}\n`);
}

// =============================================================================
// CLI
// =============================================================================

/**
 * Parse common CLI flags shared across all benchmarks.
 * Dataset-specific positionals/flags should be parsed separately.
 *
 * @param {string[]} argv   typically process.argv
 * @returns {{ topK, limit, llmKey, llmModel, outFile, noLlm }}
 */
export function parseCommonArgs(argv) {
  const result = {
    topK: 10,
    limit: 0,
    llmKey: process.env.ANTHROPIC_API_KEY || null,
    llmModel: 'claude-haiku-4-5-20251001',
    outFile: null,
    noLlm: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--top-k')     { result.topK = parseInt(args[++i], 10); }
    if (a === '--limit')     { result.limit = parseInt(args[++i], 10); }
    if (a === '--llm-key')   { result.llmKey = args[++i]; }
    if (a === '--llm-model') { result.llmModel = args[++i]; }
    if (a === '--out')       { result.outFile = args[++i]; }
    if (a === '--no-llm')    { result.noLlm = true; }
  }

  return result;
}
