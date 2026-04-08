#!/usr/bin/env node
/**
 * MemPal x ConvoMem Benchmark
 * ==============================
 *
 * Evaluates MemPal's retrieval against the ConvoMem benchmark.
 * 75,336 QA pairs across 6 evidence categories.
 *
 * For each evidence item:
 * 1. Ingest all conversations into a fresh MemPal palace (one drawer per message)
 * 2. Query with the question
 * 3. Check if any retrieved message matches the evidence messages
 *
 * Since ConvoMem has 75K items across many files, we sample a subset for benchmarking.
 * Downloads evidence files from HuggingFace on first run.
 *
 * Usage:
 *     node benchmarks/convomemBench.js                                # sample 100 items
 *     node benchmarks/convomemBench.js --limit 500                    # sample 500 items
 *     node benchmarks/convomemBench.js --category user_evidence       # one category only
 *     node benchmarks/convomemBench.js --mode aaak                    # test AAAK compression
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';
import { VectorStore } from '../src/vectorStore.js';
import { Dialect } from '../src/dialect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const SAMPLE_FILES = {
  user_evidence: '1_evidence/0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer.json',
  assistant_facts_evidence: null,
  changing_evidence: null,
  abstention_evidence: null,
  preference_evidence: null,
  implicit_connection_evidence: null,
};

// =============================================================================
// DATA LOADING
// =============================================================================

async function downloadEvidenceFile(category, subpath, cacheDir) {
  const url = `${HF_BASE}/${category}/${subpath}`;
  const cachePath = path.join(cacheDir, category, subpath.replace(/\//g, '_'));
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }

  console.log(`    Downloading: ${category}/${subpath}...`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    fs.writeFileSync(cachePath, text, 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    console.log(`    Failed to download ${url}: ${e.message}`);
    return null;
  }
}

async function discoverFiles(category, cacheDir) {
  const apiUrl = `https://huggingface.co/api/datasets/Salesforce/ConvoMem/tree/main/core_benchmark/evidence_questions/${category}/1_evidence`;
  const cachePath = path.join(cacheDir, `${category}_filelist.json`);

  if (fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  }

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
    console.log(`    Failed to list files for ${category}: ${e.message}`);
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
        console.log(`  Skipping ${category} -- no files found`);
        continue;
      }
    }

    const itemsForCat = [];
    for (const fpath of files) {
      if (itemsForCat.length >= limit) break;
      const data = await downloadEvidenceFile(category, fpath, cacheDir);
      if (data && data.evidence_items) {
        for (const item of data.evidence_items) {
          item._category_key = category;
          itemsForCat.push(item);
        }
      }
    }

    const sliced = itemsForCat.slice(0, limit);
    allItems.push(...sliced);
    console.log(`  ${CATEGORIES[category] || category}: ${sliced.length} items loaded`);
  }

  return allItems;
}

// =============================================================================
// RETRIEVAL
// =============================================================================

async function retrieveForItem(item, topK = 10, mode = 'raw') {
  const conversations = item.conversations || [];
  const question = item.question;
  const evidenceMessages = item.message_evidences || [];
  const evidenceTexts = new Set(evidenceMessages.map((e) => e.text.trim().toLowerCase()));

  // Build corpus: one doc per message
  const corpus = [];
  const corpusSpeakers = [];
  for (const conv of conversations) {
    for (const msg of conv.messages || []) {
      corpus.push(msg.text);
      corpusSpeakers.push(msg.speaker);
    }
  }

  if (corpus.length === 0) {
    return [0.0, { error: 'empty corpus' }];
  }

  // Use a unique collection name per item to isolate data
  const collectionName = `convomem_bench_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const store = new VectorStore({ collectionName });

  try {
    await store.init();

    let docs;
    if (mode === 'aaak') {
      const dialect = new Dialect();
      docs = corpus.map((doc) => dialect.compress(doc));
    } else {
      docs = corpus;
    }

    await store.add({
      documents: docs,
      ids: corpus.map((_, i) => `msg_${i}`),
      metadatas: corpusSpeakers.map((s, i) => ({ speaker: s, idx: i })),
    });

    const results = await store.query({
      queryTexts: [question],
      nResults: Math.min(topK, corpus.length),
    });

    // Check if any retrieved message matches evidence
    const retrievedIndices = results.metadatas[0].map((m) => m.idx);
    const retrievedTexts = retrievedIndices.map((i) => corpus[i].trim().toLowerCase());

    let found = 0;
    for (const evText of evidenceTexts) {
      for (const retText of retrievedTexts) {
        if (evText.includes(retText) || retText.includes(evText)) {
          found++;
          break;
        }
      }
    }

    const recall = evidenceTexts.size > 0 ? found / evidenceTexts.size : 1.0;

    return [
      recall,
      {
        retrieved_count: retrievedIndices.length,
        evidence_count: evidenceTexts.size,
        found,
      },
    ];
  } finally {
    await store.deleteCollection();
  }
}

// =============================================================================
// BENCHMARK RUNNER
// =============================================================================

async function runBenchmark(categories, limitPerCat, topK, mode, cacheDir, outFile) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal x ConvoMem Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Categories:  ${categories.length}`);
  console.log(`  Limit/cat:   ${limitPerCat}`);
  console.log(`  Top-k:       ${topK}`);
  console.log(`  Mode:        ${mode}`);
  console.log(`${'─'.repeat(60)}`);
  console.log('\n  Loading data from HuggingFace...\n');

  const items = await loadEvidenceItems(categories, limitPerCat, cacheDir);

  console.log(`\n  Total items: ${items.length}`);
  console.log(`${'─'.repeat(60)}\n`);

  const allRecall = [];
  const perCategory = {};
  const resultsLog = [];
  const startTime = Date.now();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const question = item.question;
    const answer = item.answer || '';
    const catKey = item._category_key || 'unknown';

    const [recall, details] = await retrieveForItem(item, topK, mode);
    allRecall.push(recall);

    if (!perCategory[catKey]) perCategory[catKey] = [];
    perCategory[catKey].push(recall);

    resultsLog.push({
      question,
      answer,
      category: catKey,
      recall,
      details,
    });

    const status = recall >= 1.0 ? 'HIT' : recall > 0 ? 'part' : 'miss';
    if ((i + 1) % 20 === 0 || i === items.length - 1) {
      const avgSoFar = allRecall.reduce((a, b) => a + b, 0) / allRecall.length;
      console.log(
        `  [${String(i + 1).padStart(4)}/${items.length}] avg_recall=${avgSoFar.toFixed(3)}  last=${status}`
      );
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  const avgRecall = allRecall.length > 0 ? allRecall.reduce((a, b) => a + b, 0) / allRecall.length : 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS -- MemPal (${mode} mode, top-${topK})`);
  console.log(`${'='.repeat(60)}`);
  console.log(
    `  Time:        ${elapsed.toFixed(1)}s (${(elapsed / Math.max(items.length, 1)).toFixed(2)}s per item)`
  );
  console.log(`  Items:       ${items.length}`);
  console.log(`  Avg Recall:  ${avgRecall.toFixed(3)}`);

  console.log('\n  PER-CATEGORY RECALL:');
  for (const catKey of Object.keys(perCategory).sort()) {
    const vals = perCategory[catKey];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const name = CATEGORIES[catKey] || catKey;
    const perfect = vals.filter((v) => v >= 1.0).length;
    console.log(`    ${name.padEnd(25)} R=${avg.toFixed(3)}  perfect=${perfect}/${vals.length}`);
  }

  const perfectTotal = allRecall.filter((r) => r >= 1.0).length;
  const zeroTotal = allRecall.filter((r) => r === 0).length;
  console.log('\n  DISTRIBUTION:');
  console.log(
    `    Perfect (1.0):  ${String(perfectTotal).padStart(4)} (${((perfectTotal / allRecall.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    Zero (0.0):     ${String(zeroTotal).padStart(4)} (${((zeroTotal / allRecall.length) * 100).toFixed(1)}%)`
  );

  console.log(`\n${'='.repeat(60)}\n`);

  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(resultsLog, null, 2), 'utf-8');
    console.log(`  Results saved to: ${outFile}`);
  }
}

// =============================================================================
// CLI
// =============================================================================

const categoryChoices = [...Object.keys(CATEGORIES), 'all'];

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '100' },
    'top-k': { type: 'string', default: '10' },
    category: { type: 'string', default: 'all' },
    mode: { type: 'string', default: 'raw' },
    'cache-dir': { type: 'string', default: '/tmp/convomem_cache' },
    out: { type: 'string', default: '' },
  },
});

const limit = parseInt(args.limit, 10);
const topK = parseInt(args['top-k'], 10);
const mode = args.mode;
const cacheDir = args['cache-dir'];

if (!['raw', 'aaak'].includes(mode)) {
  console.error(`Invalid mode: ${mode}. Must be "raw" or "aaak".`);
  process.exit(1);
}

if (!categoryChoices.includes(args.category)) {
  console.error(`Invalid category: ${args.category}. Must be one of: ${categoryChoices.join(', ')}`);
  process.exit(1);
}

const categories =
  args.category === 'all' ? Object.keys(CATEGORIES) : [args.category];

const now = new Date();
const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

const outFile =
  args.out || `benchmarks/results_convomem_${mode}_top${topK}_${timestamp}.json`;

runBenchmark(categories, limit, topK, mode, cacheDir, outFile).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
