#!/usr/bin/env node
/**
 * MemPal x ConvoMem Benchmark
 * ==============================
 *
 * ConvoMem data: https://huggingface.co/datasets/Salesforce/ConvoMem
 * 75,336 QA pairs across 6 evidence categories.
 *
 * Pipeline:
 *   1. Download/cache ConvoMem evidence items from HuggingFace
 *   2. Ingest ALL conversation messages via pipelineSave (one collection)
 *   3. For each question: pipelineSearch → retrieval recall (evidence message found?)
 *   4. Optionally feed retrieved context to Claude → answer accuracy
 *
 * Corpus structure:
 *   item.conversations[].messages[] → { speaker, text }
 *   item.message_evidences[]        → { speaker, text }  (ground truth)
 *
 * Metrics:
 *   Retrieval Recall — any evidence message text found (substring) in top-k results?
 *   LLM Accuracy     — substring match between LLM answer and item.answer
 *
 * Usage:
 *   node benchmarks/convomemBench.js
 *   node benchmarks/convomemBench.js --limit 50 --no-llm
 *   node benchmarks/convomemBench.js --category user_evidence --top-k 5 --llm-key $KEY
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
// CONSTANTS
// =============================================================================

const HF_BASE =
  'https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/main/core_benchmark/evidence_questions';

const CATEGORIES = {
  user_evidence: 'User Facts',
  assistant_facts_evidence: 'Assistant Facts',
  changing_evidence: 'Changing Facts',
  abstention_evidence: 'Abstention',
  preference_evidence: 'Preferences',
  implicit_connection_evidence: 'Implicit Connections',
};

// Known fallback file for categories where directory listing fails
const SAMPLE_FILES = {
  user_evidence: '1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
};

// =============================================================================
// DATA LOADING (HuggingFace download + local cache)
// =============================================================================

async function downloadFile(url, cachePath) {
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const text = await resp.text();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, text, 'utf-8');
  return JSON.parse(text);
}

async function discoverFiles(category, cacheDir) {
  const cachePath = path.join(cacheDir, `${category}_filelist.json`);
  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }
  const apiUrl = `https://huggingface.co/api/datasets/Salesforce/ConvoMem/tree/main/core_benchmark/evidence_questions/${category}/1_evidence`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const files = await resp.json();
    const paths = files
      .filter((f) => f.path.endsWith('.json'))
      .map((f) => f.path.split(`${category}/`)[1]);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(paths), 'utf-8');
    return paths;
  } catch (e) {
    console.log(`  Warning: could not list files for ${category}: ${e.message}`);
    return [];
  }
}

async function loadEvidenceItems(categories, limit, cacheDir) {
  const allItems = [];

  for (const category of categories) {
    let files = await discoverFiles(category, cacheDir);
    if (!files || files.length === 0) {
      const known = SAMPLE_FILES[category];
      if (known) {
        files = [known];
      } else {
        console.log(`  Skipping ${category} — no files found`);
        continue;
      }
    }

    const catItems = [];
    for (const fpath of files) {
      if (catItems.length >= limit) break;
      const url = `${HF_BASE}/${category}/${fpath}`;
      const cachePath = path.join(cacheDir, category, fpath.replace(/\//g, '_'));
      try {
        const data = await downloadFile(url, cachePath);
        if (data?.evidence_items) {
          for (const item of data.evidence_items) {
            item._category_key = category;
            catItems.push(item);
          }
        }
      } catch (e) {
        console.log(`  Download failed (${category}/${fpath}): ${e.message}`);
      }
    }

    const sliced = catItems.slice(0, limit);
    allItems.push(...sliced);
    console.log(`  ${CATEGORIES[category] || category}: ${sliced.length} items loaded`);
  }

  return allItems;
}

// =============================================================================
// CORPUS BUILDER
// =============================================================================

/**
 * Each message across all conversations in all items becomes a corpus doc.
 * corpusId = "${itemIdx}_conv${convIdx}_msg${msgIdx}"
 * Format: "Speaker: text"
 */
function buildCorpus(items) {
  const corpusItems = [];
  const seenContent = new Set();

  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    const item = items[itemIdx];
    const conversations = item.conversations || [];

    for (let convIdx = 0; convIdx < conversations.length; convIdx++) {
      const messages = conversations[convIdx].messages || [];

      for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
        const msg = messages[msgIdx];
        const text = (msg.text || '').trim();
        if (!text) continue;

        const content = `${msg.speaker || 'Unknown'}: ${text}`;
        if (seenContent.has(content)) continue;
        seenContent.add(content);

        const corpusId = `item${itemIdx}_conv${convIdx}_msg${msgIdx}`;
        corpusItems.push({ content, corpusId });
      }
    }
  }

  return corpusItems;
}

// =============================================================================
// SCORING
// =============================================================================

function recallHit(retrievedTexts, item) {
  const evidenceTexts = (item.message_evidences || []).map((e) => (e.text || '').toLowerCase());
  if (evidenceTexts.length === 0) return null;

  return retrievedTexts.some((retrieved) => {
    const r = retrieved.toLowerCase();
    return evidenceTexts.some((ev) => r.includes(ev) || ev.includes(r));
  });
}

// =============================================================================
// MAIN
// =============================================================================

async function run() {
  const args = parseCommonArgs(process.argv);

  // Dataset-specific args
  let category = 'all';
  let cacheDir = '/tmp/convomem_cache';
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--category') category = rawArgs[++i];
    if (rawArgs[i] === '--cache-dir') cacheDir = rawArgs[++i];
    if (rawArgs[i] === '--help' || rawArgs[i] === '-h') {
      console.log(`Usage: node benchmarks/convomemBench.js [options]

Options:
  --category <cat>     Category or "all" (default: all)
  --cache-dir <dir>    HuggingFace cache dir (default: /tmp/convomem_cache)
  --top-k <n>          default 10
  --limit <n>          items per category (default: 100)
  --llm-key <key>      or ANTHROPIC_API_KEY env
  --llm-model <m>      default claude-haiku-4-5-20251001
  --out <file>         output JSONL
  --no-llm             skip LLM evaluation`);
      process.exit(0);
    }
  }

  const validCategories = [...Object.keys(CATEGORIES), 'all'];
  if (!validCategories.includes(category)) {
    console.error(`Invalid category: ${category}. Valid: ${validCategories.join(', ')}`);
    process.exit(1);
  }

  if (!args.noLlm && !args.llmKey) {
    console.error('ERROR: --llm-key or ANTHROPIC_API_KEY required. Use --no-llm to skip LLM.');
    process.exit(1);
  }

  const limit = args.limit || 100;
  const categories = category === 'all' ? Object.keys(CATEGORIES) : [category];

  const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 13);
  const catTag = category === 'all' ? 'all' : category;
  const outFile = args.outFile || `benchmarks/results/convomem_pipeline_${catTag}_top${args.topK}_${ts}.jsonl`;

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal x ConvoMem — Pipeline Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Categories:  ${categories.length}`);
  console.log(`  Limit/cat:   ${limit}`);
  console.log(`  Top-k:       ${args.topK}`);
  console.log(`  LLM:         ${args.noLlm ? 'disabled' : args.llmModel}`);
  console.log(`${'─'.repeat(60)}`);
  console.log('\n  Loading data from HuggingFace...\n');

  const items = await loadEvidenceItems(categories, limit, cacheDir);
  if (!items.length) {
    console.error('No items loaded. Check network/cache.');
    process.exit(1);
  }
  console.log(`\n  Total items: ${items.length}`);

  const corpusItems = buildCorpus(items);
  console.log(`  Corpus size: ${corpusItems.length} unique messages\n`);

  const { store } = await createBenchStore('convomem');
  try {
    console.log(`  Ingesting via pipelineSave...`);
    const textToId = await ingestCorpus(corpusItems, store, 'convomem', {
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

      const searchResult = await searchQuestion(item.question, store, args.topK);
      const retrievedTexts = (searchResult.results || []).map((r) => r.text);

      const hit = recallHit(retrievedTexts, item);

      let llmAns = null;
      let llmScore = null;
      if (!args.noLlm) {
        llmAns = await llmAnswer(item.question, retrievedTexts.slice(0, args.topK), args.llmKey, args.llmModel);
        if (llmAns !== null && item.answer) {
          llmScore = substringMatch(llmAns, item.answer) ? 1.0 : 0.0;
        }
      }

      log.push({
        category: item._category_key,
        category_name: CATEGORIES[item._category_key] || item._category_key,
        question: item.question,
        answer: item.answer,
        evidence_count: item.message_evidences?.length || 0,
        recall_hit: hit,
        room_filter_used: searchResult.room_filter_used ?? false,
        llm_answer: llmAns,
        llm_score: llmScore,
      });

      const status = hit === null ? 'skip' : hit ? 'HIT ' : 'miss';
      if ((i + 1) % 20 === 0 || i === items.length - 1) {
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

    printSummary(log, 'category_name', 'ConvoMem Pipeline Results');
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
