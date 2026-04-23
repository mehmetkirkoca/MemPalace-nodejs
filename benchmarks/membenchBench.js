#!/usr/bin/env node
/**
 * MemPal × MemBench Benchmark
 * ============================
 *
 * MemBench (ACL 2025): https://aclanthology.org/2025.findings-acl.989/
 * Data: https://github.com/import-myself/Membench
 *
 * Pipeline:
 *   1. Load MemBench items from the FirstAgent directory
 *   2. Ingest ALL turns via pipelineSave (one collection)
 *   3. For each QA: pipelineSearch → retrieval recall
 *   4. Optionally feed retrieved context to Claude → multiple-choice accuracy
 *
 * Metrics:
 *   Retrieval Recall — target turn found in top-k results?
 *   LLM Accuracy     — exact multiple-choice letter match (A/B/C/D)
 *
 * Usage:
 *   node benchmarks/membenchBench.js /tmp/membench/MemData/FirstAgent
 *   node benchmarks/membenchBench.js /path/to/FirstAgent --category highlevel --limit 50 --no-llm
 *   node benchmarks/membenchBench.js /path/to/FirstAgent --top-k 10 --llm-key $KEY
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  createBenchStore,
  ingestCorpus,
  searchQuestion,
  llmAnswer,
  saveResults,
  printSummary,
  parseCommonArgs,
} from './lib.js';

// =============================================================================
// DATA LOADING
// =============================================================================

const CATEGORY_FILES = {
  simple: 'simple.json',
  highlevel: 'highlevel.json',
  knowledge_update: 'knowledge_update.json',
  comparative: 'comparative.json',
  conditional: 'conditional.json',
  noisy: 'noisy.json',
  aggregative: 'aggregative.json',
  highlevel_rec: 'highlevel_rec.json',
  lowlevel_rec: 'lowlevel_rec.json',
  RecMultiSession: 'RecMultiSession.json',
  post_processing: 'post_processing.json',
};

function _turnText(turn) {
  const user = turn.user || turn.user_message || '';
  const asst = turn.assistant || turn.assistant_message || '';
  const time = turn.time || '';
  let text = `[User] ${user} [Assistant] ${asst}`;
  if (time) text = `[${time}] ${text}`;
  return text;
}

function loadMembench(dataDir, categories = null, topic = 'movie', limit = 0) {
  if (!categories) categories = Object.keys(CATEGORY_FILES);
  const items = [];

  for (const cat of categories) {
    const fpath = join(dataDir, CATEGORY_FILES[cat]);
    if (!existsSync(fpath)) continue;
    const raw = JSON.parse(readFileSync(fpath, 'utf-8'));

    for (const [t, topicItems] of Object.entries(raw)) {
      if (topic && t !== topic && t !== 'roles' && t !== 'events') continue;
      for (const item of topicItems) {
        const turns = item.message_list || [];
        const qa = item.QA || {};
        if (!turns.length || !Object.keys(qa).length) continue;
        items.push({
          category: cat,
          topic: t,
          tid: item.tid || 0,
          turns,
          question: qa.question || '',
          choices: qa.choices || {},
          ground_truth: (qa.ground_truth || '').toUpperCase(),
          answer_text: qa.answer || '',
          target_step_ids: qa.target_step_id || [],
        });
      }
    }
  }

  return limit > 0 ? items.slice(0, limit) : items;
}

// =============================================================================
// CORPUS BUILDER
// =============================================================================

/**
 * Build flat corpus from all items.
 * corpusId = "${category}_${tid}_step_${stepIdx}"
 */
function buildCorpus(items) {
  const corpusItems = [];
  const seenIds = new Set();

  for (const item of items) {
    const turnsFlat = Array.isArray(item.turns[0]) ? item.turns.flat() : item.turns;
    for (let stepIdx = 0; stepIdx < turnsFlat.length; stepIdx++) {
      const turn = turnsFlat[stepIdx];
      if (typeof turn !== 'object' || turn === null) continue;
      const corpusId = `${item.category}_${item.tid}_step_${stepIdx}`;
      if (seenIds.has(corpusId)) continue;
      seenIds.add(corpusId);
      const content = _turnText(turn);
      if (content.trim()) corpusItems.push({ content, corpusId });
    }
  }

  return corpusItems;
}

// =============================================================================
// SCORING
// =============================================================================

function recallHit(retrievedIds, item) {
  if (!item.target_step_ids || item.target_step_ids.length === 0) return null;
  const targetKeys = new Set(
    item.target_step_ids.map((sid) => `${item.category}_${item.tid}_step_${sid}`)
  );
  return retrievedIds.some((id) => targetKeys.has(id));
}

function parseMultipleChoice(text) {
  const m = (text || '').toUpperCase().match(/\b([ABCD])\b/);
  return m ? m[1] : null;
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  const args = parseCommonArgs(process.argv);

  const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!positionals.length) {
    console.error('Usage: node benchmarks/membenchBench.js <data_dir> [options]');
    console.error('Options: --category <name>  --topic <name>  --top-k N  --limit N  --llm-key K  --llm-model M  --out file  --no-llm');
    process.exit(1);
  }
  const dataDir = resolve(positionals[0]);

  let category = '';
  let topic = 'movie';
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--category') category = rawArgs[++i];
    if (rawArgs[i] === '--topic') topic = rawArgs[++i];
  }

  if (!args.noLlm && !args.llmKey) {
    console.error('ERROR: --llm-key or ANTHROPIC_API_KEY required. Use --no-llm to skip LLM.');
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 13);
  const catTag = category ? `_${category}` : '_all';
  const outFile = args.outFile || `benchmarks/results/membench_pipeline${catTag}_${topic}_top${args.topK}_${ts}.jsonl`;

  const cats = category ? [category] : null;
  const items = loadMembench(dataDir, cats, topic, args.limit);

  if (!items.length) {
    console.error(`No items found in ${dataDir}`);
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal × MemBench — Pipeline Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data dir:    ${dataDir}`);
  console.log(`  Categories:  ${(cats || ['all']).join(', ')}`);
  console.log(`  Topic:       ${topic}`);
  console.log(`  Items:       ${items.length}`);
  console.log(`  Top-k:       ${args.topK}`);
  console.log(`  LLM:         ${args.noLlm ? 'disabled' : args.llmModel}`);
  console.log(`${'─'.repeat(60)}\n`);

  const corpusItems = buildCorpus(items);
  console.log(`  Corpus size: ${corpusItems.length} unique turns`);

  const { store } = await createBenchStore('membench');
  try {
    console.log(`  Ingesting via pipelineSave...`);
    const textToId = await ingestCorpus(corpusItems, store, 'membench', {
      onProgress: ({ ingested, skipped, total }) => {
        process.stdout.write(`\r    ${ingested}/${total} ingested  ${skipped} skipped  `);
      },
    });
    console.log(`\n  Ingestion complete. Unique stored: ${textToId.size}\n`);
    console.log(`${'─'.repeat(60)}`);

    const log = [];
    const startTime = Date.now();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const choicesText = Object.entries(item.choices)
        .map(([k, v]) => `${k}. ${v}`)
        .join('\n');
      const fullQuestion = item.question + (choicesText ? `\n\nChoices:\n${choicesText}` : '');

      const searchResult = await searchQuestion(item.question, store, args.topK);
      const retrievedIds = (searchResult.results || [])
        .map((r) => textToId.get(r.text))
        .filter(Boolean);

      const hit = recallHit(retrievedIds, item);

      let llmAns = null;
      let llmChoice = null;
      let llmScore = null;
      if (!args.noLlm) {
        const topTexts = (searchResult.results || []).slice(0, args.topK).map((r) => r.text);
        const llmPromptQ = choicesText
          ? `${item.question}\n\nChoices:\n${choicesText}\n\nAnswer with the letter only (A, B, C, or D).`
          : item.question;
        llmAns = await llmAnswer(llmPromptQ, topTexts, args.llmKey, args.llmModel);
        if (llmAns !== null) {
          llmChoice = parseMultipleChoice(llmAns);
          llmScore = llmChoice === item.ground_truth ? 1.0 : 0.0;
        }
      }

      log.push({
        category: item.category,
        topic: item.topic,
        tid: item.tid,
        question: item.question,
        ground_truth: item.ground_truth,
        answer_text: item.answer_text,
        target_step_ids: item.target_step_ids,
        retrieved_ids: retrievedIds,
        recall_hit: hit,
        room_filter_used: searchResult.room_filter_used ?? false,
        llm_answer: llmAns,
        llm_choice: llmChoice,
        llm_score: llmScore,
      });

      const status = hit === null ? 'skip' : hit ? 'HIT ' : 'miss';
      if ((i + 1) % 50 === 0 || i === items.length - 1) {
        const recallItems = log.filter((r) => r.recall_hit !== null);
        const recallPct = recallItems.length
          ? (recallItems.filter((r) => r.recall_hit).length / recallItems.length * 100).toFixed(1)
          : '—';
        console.log(
          `  [${String(i + 1).padStart(4)}/${items.length}]  ${status}  recall=${recallPct}%`
        );
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  Done in ${elapsed}s`);

    printSummary(log, 'category', 'MemBench Pipeline Results');
    mkdirSync('benchmarks/results', { recursive: true });
    saveResults(outFile, log);
  } finally {
    console.log(`\n  Collection: ${store._collectionName} (persists in Qdrant)`);
  }
}

run().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
