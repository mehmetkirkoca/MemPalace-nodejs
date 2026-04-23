#!/usr/bin/env node
/**
 * MemPal x LongMemEval Benchmark
 * ================================
 *
 * Pipeline:
 *   1. Load all 500 entries from the LongMemEval JSON file
 *   2. Ingest ALL unique haystack sessions via pipelineSave (one collection)
 *   3. For each question: pipelineSearch → retrieval recall
 *   4. Optionally feed retrieved context to Claude → LLM answer accuracy
 *
 * Metrics:
 *   Retrieval Recall — answer session found in top-k results?
 *   LLM Accuracy     — substring match between LLM answer and ground truth
 *
 * Usage:
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --limit 20 --no-llm
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --top-k 5 --llm-key $KEY
 */

import fs from 'fs';
import path from 'path';
import {
  createBenchStore,
  ingestCorpus,
  searchQuestion,
  llmAnswer,
  substringMatch,
  saveResults,
  printSummary,
  parseCommonArgs,
} from './lib.js';

// =============================================================================
// CORPUS BUILDER
// =============================================================================

/**
 * Build flat corpus from all entries.
 * Returns [{ content, corpusId }] with session-level dedup.
 */
function buildCorpus(data, granularity) {
  const items = [];
  const seenSessIds = new Set();

  for (const entry of data) {
    const sessions = entry.haystack_sessions;
    const sessionIds = entry.haystack_session_ids;

    for (let i = 0; i < sessions.length; i++) {
      const sessId = sessionIds[i];

      if (granularity === 'session') {
        if (seenSessIds.has(sessId)) continue;
        seenSessIds.add(sessId);

        const userTurns = sessions[i]
          .filter((t) => t.role === 'user')
          .map((t) => t.content);
        if (userTurns.length > 0) {
          items.push({ content: userTurns.join('\n'), corpusId: sessId });
        }
      } else {
        // turn granularity
        let turnNum = 0;
        for (const turn of sessions[i]) {
          if (turn.role !== 'user') continue;
          const turnId = `${sessId}_turn_${turnNum}`;
          if (!seenSessIds.has(turnId)) {
            seenSessIds.add(turnId);
            items.push({ content: turn.content, corpusId: turnId });
          }
          turnNum++;
        }
      }
    }
  }

  return items;
}

// =============================================================================
// SCORING
// =============================================================================

function recallHit(retrievedIds, answerSessionIds, granularity) {
  const answerSet = new Set(answerSessionIds);
  for (const id of retrievedIds) {
    if (granularity === 'session') {
      if (answerSet.has(id)) return true;
    } else {
      for (const sessId of answerSet) {
        if (id.startsWith(sessId)) return true;
      }
    }
  }
  return false;
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  const args = parseCommonArgs(process.argv);

  // Dataset-specific args
  const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!positionals.length) {
    console.error('Usage: node benchmarks/longmemevalBench.js <data_file> [options]');
    console.error('Options: --granularity session|turn  --top-k N  --limit N  --llm-key K  --llm-model M  --out file  --no-llm');
    process.exit(1);
  }
  const dataFile = positionals[0];

  let granularity = 'session';
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--granularity') granularity = rawArgs[++i];
  }

  if (!args.noLlm && !args.llmKey) {
    console.error('ERROR: --llm-key or ANTHROPIC_API_KEY required. Use --no-llm to skip LLM.');
    process.exit(1);
  }

  // Timestamp for output filename
  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 13);
  const outFile = args.outFile || `benchmarks/results/lme_pipeline_${granularity}_top${args.topK}_${ts}.jsonl`;

  // Load data
  let data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  if (args.limit > 0) data = data.slice(0, args.limit);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal x LongMemEval — Pipeline Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data:        ${path.basename(dataFile)}`);
  console.log(`  Questions:   ${data.length}`);
  console.log(`  Granularity: ${granularity}`);
  console.log(`  Top-k:       ${args.topK}`);
  console.log(`  LLM:         ${args.noLlm ? 'disabled' : args.llmModel}`);
  console.log(`${'─'.repeat(60)}\n`);

  // Build corpus
  const corpusItems = buildCorpus(data, granularity);
  console.log(`  Corpus size: ${corpusItems.length} unique items`);

  // Ingest
  const { store } = await createBenchStore('longmemeval');
  try {
    console.log(`  Ingesting via pipelineSave...`);
    const textToId = await ingestCorpus(corpusItems, store, 'longmemeval', {
      onProgress: ({ ingested, skipped, total }) => {
        process.stdout.write(`\r    ${ingested}/${total} ingested  ${skipped} skipped  `);
      },
    });
    console.log(`\n  Ingestion complete. Unique stored: ${textToId.size}\n`);
    console.log(`${'─'.repeat(60)}`);

    // Question loop
    const log = [];
    const startTime = Date.now();

    for (let i = 0; i < data.length; i++) {
      const entry = data[i];
      const question = entry.question;

      // Search
      const searchResult = await searchQuestion(question, store, args.topK);
      const retrievedIds = (searchResult.results || [])
        .map((r) => textToId.get(r.text))
        .filter(Boolean);

      // Retrieval recall
      const hit = entry.answer_session_ids?.length
        ? recallHit(retrievedIds, entry.answer_session_ids, granularity)
        : null;

      // LLM answer
      let llmAns = null;
      let llmScore = null;
      if (!args.noLlm) {
        const topTexts = (searchResult.results || []).slice(0, args.topK).map((r) => r.text);
        llmAns = await llmAnswer(question, topTexts, args.llmKey, args.llmModel);
        if (llmAns !== null && entry.answer) {
          llmScore = substringMatch(llmAns, entry.answer) ? 1.0 : 0.0;
        }
      }

      log.push({
        question_id: entry.question_id,
        question_type: entry.question_type,
        question,
        answer: entry.answer,
        answer_session_ids: entry.answer_session_ids,
        retrieved_ids: retrievedIds,
        recall_hit: hit,
        room_filter_used: searchResult.room_filter_used ?? false,
        llm_answer: llmAns,
        llm_score: llmScore,
      });

      const status = hit === null ? 'skip' : hit ? 'HIT ' : 'miss';
      if ((i + 1) % 10 === 0 || i === data.length - 1) {
        const recallSoFar = log.filter((r) => r.recall_hit !== null);
        const recallPct = recallSoFar.length
          ? (recallSoFar.filter((r) => r.recall_hit).length / recallSoFar.length * 100).toFixed(1)
          : '—';
        console.log(
          `  [${String(i + 1).padStart(4)}/${data.length}]  ${status}  recall=${recallPct}%  ${entry.question_id?.slice(0, 20) ?? ''}`
        );
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  Done in ${elapsed}s`);

    printSummary(log, 'question_type', 'LongMemEval Pipeline Results');
    fs.mkdirSync('benchmarks/results', { recursive: true });
    saveResults(outFile, log);
  } finally {
    console.log(`\n  Collection: ${store._collectionName} (persists in Qdrant)`);
  }
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
