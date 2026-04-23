#!/usr/bin/env node
/**
 * MemPalace × LoCoMo Benchmark
 * ==============================
 *
 * Pipeline:
 *   1. Load all LoCoMo conversations from local JSON
 *   2. Ingest ALL sessions/dialogs via pipelineSave (one collection)
 *   3. For each QA pair: pipelineSearch → retrieval recall
 *   4. Optionally feed retrieved context to Claude → F1 answer accuracy
 *
 * Metrics:
 *   Retrieval Recall — evidence dialog/session found in top-k results?
 *   LLM Accuracy     — token F1 between LLM answer and ground truth
 *
 * Usage:
 *   node benchmarks/locomoBench.js /path/to/locomo10.json
 *   node benchmarks/locomoBench.js /path/to/locomo10.json --granularity dialog --limit 3 --no-llm
 *   node benchmarks/locomoBench.js /path/to/locomo10.json --top-k 10 --llm-key $KEY
 */

import fs from 'fs';
import { basename } from 'path';
import {
  createBenchStore,
  ingestCorpus,
  searchQuestion,
  llmAnswer,
  f1Score,
  saveResults,
  printSummary,
  parseCommonArgs,
} from './lib.js';

// =============================================================================
// CATEGORY LABELS
// =============================================================================

const CATEGORIES = {
  1: 'Single-hop',
  2: 'Temporal',
  3: 'Temporal-inference',
  4: 'Open-domain',
  5: 'Adversarial',
};

// =============================================================================
// DATA LOADING
// =============================================================================

function loadConversationSessions(conversation, sessionSummaries = {}) {
  const sessions = [];
  let num = 1;
  while (true) {
    const key = `session_${num}`;
    if (!(key in conversation)) break;
    sessions.push({
      sessionNum: num,
      date: conversation[`session_${num}_date_time`] || '',
      dialogs: conversation[key],
      summary: sessionSummaries[`session_${num}_summary`] || '',
    });
    num++;
  }
  return sessions;
}

// =============================================================================
// CORPUS BUILDER
// =============================================================================

/**
 * Build flat corpus from all conversations.
 * Returns [{ content, corpusId }] with ID-based dedup.
 */
function buildCorpus(data, granularity) {
  const items = [];
  const seenIds = new Set();

  for (const conv of data) {
    const sessions = loadConversationSessions(conv.conversation, conv.session_summary || {});

    for (const sess of sessions) {
      if (granularity === 'session') {
        const id = `session_${sess.sessionNum}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const content = sess.dialogs
          .map((d) => `${d.speaker || '?'} said, "${d.text || ''}"`)
          .join('\n');
        if (content.trim()) items.push({ content, corpusId: id });
      } else {
        for (const d of sess.dialogs) {
          const id = d.dia_id || `D${sess.sessionNum}:?`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          const content = `${d.speaker || '?'} said, "${d.text || ''}"`;
          if (content.trim()) items.push({ content, corpusId: id });
        }
      }
    }
  }

  return items;
}

// =============================================================================
// SCORING
// =============================================================================

function diaIdToSessionId(diaId) {
  const m = diaId.match(/^D(\d+):/);
  return m ? `session_${m[1]}` : diaId;
}

function recallHit(retrievedIds, evidence, granularity) {
  if (!evidence || evidence.length === 0) return null; // unanswerable

  if (granularity === 'dialog') {
    const evidenceSet = new Set(evidence);
    return retrievedIds.some((id) => evidenceSet.has(id));
  } else {
    const sessionEvidence = new Set(evidence.map(diaIdToSessionId));
    return retrievedIds.some((id) => sessionEvidence.has(id));
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  const args = parseCommonArgs(process.argv);

  const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!positionals.length) {
    console.error('Usage: node benchmarks/locomoBench.js <data_file> [options]');
    console.error('Options: --granularity dialog|session  --top-k N  --limit N  --llm-key K  --llm-model M  --out file  --no-llm');
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

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 13);
  const outFile = args.outFile || `benchmarks/results/locomo_pipeline_${granularity}_top${args.topK}_${ts}.jsonl`;

  let data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  if (args.limit > 0) data = data.slice(0, args.limit);

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPalace × LoCoMo — Pipeline Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data:          ${basename(dataFile)}`);
  console.log(`  Conversations: ${data.length}`);
  console.log(`  Granularity:   ${granularity}`);
  console.log(`  Top-k:         ${args.topK}`);
  console.log(`  LLM:           ${args.noLlm ? 'disabled' : args.llmModel}`);
  console.log(`${'─'.repeat(60)}\n`);

  const corpusItems = buildCorpus(data, granularity);
  console.log(`  Corpus size: ${corpusItems.length} unique items`);

  const { store } = await createBenchStore('locomo');
  try {
    console.log(`  Ingesting via pipelineSave...`);
    const textToId = await ingestCorpus(corpusItems, store, 'locomo', {
      onProgress: ({ ingested, skipped, total }) => {
        process.stdout.write(`\r    ${ingested}/${total} ingested  ${skipped} skipped  `);
      },
    });
    console.log(`\n  Ingestion complete. Unique stored: ${textToId.size}\n`);
    console.log(`${'─'.repeat(60)}`);

    const log = [];
    const startTime = Date.now();

    for (const conv of data) {
      const sampleId = conv.sample_id || 'unknown';
      const qaPairs = conv.qa || [];

      for (const qa of qaPairs) {
        const question = qa.question;

        const searchResult = await searchQuestion(question, store, args.topK);
        const retrievedIds = (searchResult.results || [])
          .map((r) => textToId.get(r.text))
          .filter(Boolean);

        const hit = recallHit(retrievedIds, qa.evidence, granularity);

        let llmAns = null;
        let llmScore = null;
        if (!args.noLlm) {
          const topTexts = (searchResult.results || []).slice(0, args.topK).map((r) => r.text);
          llmAns = await llmAnswer(question, topTexts, args.llmKey, args.llmModel);
          if (llmAns !== null && (qa.answer || qa.adversarial_answer)) {
            llmScore = f1Score(llmAns, qa.answer || qa.adversarial_answer || '');
          }
        }

        log.push({
          conv_id: sampleId,
          category: qa.category,
          category_name: CATEGORIES[qa.category] || `Cat-${qa.category}`,
          question,
          answer: qa.answer || qa.adversarial_answer || '',
          evidence: qa.evidence || [],
          retrieved_ids: retrievedIds,
          recall_hit: hit,
          room_filter_used: searchResult.room_filter_used ?? false,
          llm_answer: llmAns,
          llm_score: llmScore,
        });
      }

      const done = log.length;
      const recallItems = log.filter((r) => r.recall_hit !== null);
      const recallPct = recallItems.length
        ? (recallItems.filter((r) => r.recall_hit).length / recallItems.length * 100).toFixed(1)
        : '—';
      console.log(`  [conv ${sampleId}]  ${qaPairs.length} questions  recall=${recallPct}%  total_q=${done}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  Done in ${elapsed}s`);

    printSummary(log, 'category_name', 'LoCoMo Pipeline Results');
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
