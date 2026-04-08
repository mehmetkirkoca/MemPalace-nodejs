#!/usr/bin/env node
/**
 * MemPal × MemBench Benchmark
 * ============================
 *
 * MemBench (ACL 2025): https://aclanthology.org/2025.findings-acl.989/
 * Data: https://github.com/import-myself/Membench
 *
 * MemBench tests memory across multi-turn conversations in multiple categories:
 *   - highlevel: inferences requiring aggregation across turns
 *   - lowlevel: single-turn fact recall
 *   - knowledge_update: facts that change over time
 *   - comparative: comparing two items mentioned across turns
 *   - conditional: conditional reasoning over remembered facts
 *   - noisy: distractors / irrelevant info mixed in
 *   - aggregative: combining info from multiple turns
 *   - RecMultiSession: recommendations across multiple topic sessions
 *
 * Each item has:
 *   - message_list[0]: list of turns [{user, assistant, time, place}]
 *   - QA: {question, answer, choices (A/B/C/D), ground_truth, target_step_id}
 *
 * We measure RETRIEVAL RECALL: is the answer-relevant turn in the top-K retrieved?
 *
 * Usage:
 *   node benchmarks/membenchBench.js /tmp/membench/MemData/FirstAgent
 *   node benchmarks/membenchBench.js /tmp/membench/MemData/FirstAgent --category highlevel
 *   node benchmarks/membenchBench.js /tmp/membench/MemData/FirstAgent --limit 50
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { parseArgs } from 'util';
import { VectorStore } from '../src/vectorStore.js';

// ── Stop words ──────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'how', 'which',
  'did', 'do', 'was', 'were', 'have', 'has', 'had',
  'is', 'are', 'the', 'a', 'an', 'my', 'me', 'i',
  'you', 'your', 'their', 'it', 'its',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'ago', 'last', 'that', 'this', 'there', 'about',
  'get', 'got', 'give', 'gave', 'buy', 'bought',
  'made', 'make', 'said', 'would', 'could', 'should',
  'might', 'can', 'will', 'shall',
  'kind', 'type', 'like', 'prefer', 'enjoy', 'think', 'feel',
]);

const NOT_NAMES = new Set([
  'What', 'When', 'Where', 'Who', 'How', 'Which',
  'Did', 'Do', 'Was', 'Were', 'Have', 'Has', 'Had',
  'Is', 'Are', 'The', 'My', 'Our', 'I', 'It', 'Its',
  'This', 'That', 'These', 'Those',
]);

// ── Keyword helpers ─────────────────────────────────────────────────────────

function _kw(text) {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  return words.filter((w) => !STOP_WORDS.has(w));
}

function _kwOverlap(queryKws, docText) {
  if (!queryKws.length) return 0.0;
  const docLower = docText.toLowerCase();
  const hits = queryKws.filter((kw) => docLower.includes(kw)).length;
  return hits / queryKws.length;
}

function _personNames(text) {
  const words = text.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
  return [...new Set(words.filter((w) => !NOT_NAMES.has(w)))];
}

// ── MemBench data loading ───────────────────────────────────────────────────

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

/**
 * Load MemBench questions from the FirstAgent directory.
 *
 * @param {string} dataDir - Path to MemBench data directory
 * @param {string[]|null} categories - Category filter (null = all)
 * @param {string} topic - Topic filter (e.g. "movie")
 * @param {number} limit - Max items (0 = all)
 * @returns {Array} items
 */
function loadMembench(dataDir, categories = null, topic = 'movie', limit = 0) {
  if (!categories) {
    categories = Object.keys(CATEGORY_FILES);
  }

  const items = [];
  for (const cat of categories) {
    const fname = CATEGORY_FILES[cat];
    if (!fname) continue;
    const fpath = join(dataDir, fname);
    if (!existsSync(fpath)) continue;

    const raw = JSON.parse(readFileSync(fpath, 'utf-8'));

    // Files have two formats:
    //   topic-keyed: {"movie": [...], "food": [...], "book": [...]}
    //   role-keyed:  {"roles": [...], "events": [...]}
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
          ground_truth: qa.ground_truth || '',
          answer_text: qa.answer || '',
          target_step_ids: qa.target_step_id || [],
        });
      }
    }
  }

  if (limit > 0) return items.slice(0, limit);
  return items;
}

// ── Indexing ────────────────────────────────────────────────────────────────

/**
 * Extract text from a turn regardless of field naming convention.
 */
function _turnText(turn) {
  const user = turn.user || turn.user_message || '';
  const asst = turn.assistant || turn.assistant_message || '';
  const time = turn.time || '';
  let text = `[User] ${user} [Assistant] ${asst}`;
  if (time) text = `[${time}] ${text}`;
  return text;
}

/**
 * Index all turns from all sessions into the vector store.
 *
 * message_list can be:
 *   - Flat list of turns: [turn, turn, ...]
 *   - List of sessions: [[turn, turn], [turn, turn], ...]
 *
 * @param {VectorStore} store - VectorStore instance
 * @param {Array} messageList - Message list from MemBench item
 * @param {string} itemKey - Unique key prefix for document IDs
 * @returns {Promise<number>} Number of turns indexed
 */
async function indexTurns(store, messageList, itemKey) {
  const docs = [];
  const ids = [];
  const metas = [];

  // Normalize: flat list of dicts → wrap as one session
  let sessions;
  if (messageList.length && !Array.isArray(messageList[0])) {
    sessions = [messageList];
  } else {
    sessions = messageList;
  }

  let globalIdx = 0;
  for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
    const session = sessions[sIdx];
    if (!Array.isArray(session)) continue;

    for (let tIdx = 0; tIdx < session.length; tIdx++) {
      const turn = session[tIdx];
      if (typeof turn !== 'object' || turn === null) continue;

      const sid = turn.sid ?? turn.mid;
      const docId = `${itemKey}_g${globalIdx}`;
      const text = _turnText(turn);

      docs.push(text);
      ids.push(docId);
      metas.push({
        item_key: itemKey,
        sid: typeof sid === 'number' ? sid : globalIdx,
        s_idx: sIdx,
        t_idx: tIdx,
        global_idx: globalIdx,
      });
      globalIdx++;
    }
  }

  if (docs.length) {
    await store.add({ ids, documents: docs, metadatas: metas });
  }
  return docs.length;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * Run MemBench retrieval evaluation.
 *
 * @param {string} dataDir - Path to MemBench data directory
 * @param {Object} opts - Options
 * @param {string[]|null} opts.categories
 * @param {string} opts.topic
 * @param {number} opts.topK
 * @param {number} opts.limit
 * @param {string} opts.mode - "raw" or "hybrid"
 * @param {string|null} opts.outFile
 * @param {string} opts.qdrantUrl
 */
async function runMembench(dataDir, opts = {}) {
  const {
    categories = null,
    topic = 'movie',
    topK = 5,
    limit = 0,
    mode = 'hybrid',
    outFile = null,
    qdrantUrl = 'http://localhost:6333',
  } = opts;

  const items = loadMembench(dataDir, categories, topic, limit);
  if (!items.length) {
    console.log(`No items found in ${dataDir}`);
    return;
  }

  const sep = '='.repeat(58);
  const dash = '─'.repeat(58);
  console.log(`\n${sep}`);
  console.log('  MemPal × MemBench');
  console.log(sep);
  console.log(`  Data dir:    ${dataDir}`);
  console.log(`  Categories:  ${(categories || ['all']).join(', ')}`);
  console.log(`  Topic:       ${topic || 'all'}`);
  console.log(`  Items:       ${items.length}`);
  console.log(`  Top-k:       ${topK}`);
  console.log(`  Mode:        ${mode}`);
  console.log(`${dash}\n`);

  const results = [];
  const byCat = {};
  let totalHit = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const itemNum = idx + 1;
    const itemKey = `${item.category}_${item.topic}_${itemNum}`;

    // Create a fresh collection per item
    const collectionName = `membench_${itemNum}_${Date.now()}`;
    const store = new VectorStore({ qdrantUrl, collectionName });
    await store.init();

    try {
      // Index all turns from all sessions
      const nIndexed = await indexTurns(store, item.turns, itemKey);
      if (nIndexed < 1) continue;

      const question = item.question;
      const nRetrieve = Math.min(
        mode === 'hybrid' ? topK * 3 : topK,
        nIndexed,
      );
      if (nRetrieve < 1) continue;

      // Retrieve — VectorStore returns cosine similarity (higher = better)
      const res = await store.query({
        queryTexts: [question],
        nResults: nRetrieve,
      });
      let retrievedSids = res.metadatas[0].map((m) => m.sid);
      let retrievedGlobal = res.metadatas[0].map((m) => m.global_idx);
      const retrievedDocs = res.documents[0];
      const rawScores = res.distances[0];

      // Hybrid re-scoring: predicate keywords (person names excluded)
      if (mode === 'hybrid') {
        const names = _personNames(question);
        const nameWords = new Set(names.map((n) => n.toLowerCase()));
        const allKws = _kw(question);
        const predicateKws = allKws.filter((w) => !nameWords.has(w));

        const scored = [];
        for (let i = 0; i < rawScores.length; i++) {
          const score = rawScores[i];
          const sid = retrievedSids[i];
          const gidx = retrievedGlobal[i];
          const doc = retrievedDocs[i];
          const predOverlap = _kwOverlap(predicateKws, doc);
          // VectorStore uses cosine similarity (higher = better),
          // so we BOOST score with keyword overlap
          const fused = score * (1.0 + 0.50 * predOverlap);
          scored.push({ fused, sid, gidx, doc });
        }
        // Sort descending (higher similarity = better)
        scored.sort((a, b) => b.fused - a.fused);
        retrievedSids = scored.slice(0, topK).map((x) => x.sid);
        retrievedGlobal = scored.slice(0, topK).map((x) => x.gidx);
      } else {
        retrievedSids = retrievedSids.slice(0, topK);
        retrievedGlobal = retrievedGlobal.slice(0, topK);
      }

      // Check if any target turn is retrieved
      const targetSids = new Set();
      for (const step of item.target_step_ids) {
        if (Array.isArray(step) && step.length >= 1) {
          targetSids.add(step[0]);
        }
      }

      const hit =
        [...targetSids].some((s) => retrievedSids.includes(s)) ||
        [...targetSids].some((s) => retrievedGlobal.includes(s));

      if (hit) {
        totalHit++;
        if (!byCat[item.category]) byCat[item.category] = { hit_at_k: 0, total: 0 };
        byCat[item.category].hit_at_k++;
      }
      if (!byCat[item.category]) byCat[item.category] = { hit_at_k: 0, total: 0 };
      byCat[item.category].total++;

      results.push({
        category: item.category,
        topic: item.topic,
        tid: item.tid,
        question,
        ground_truth: item.ground_truth,
        answer_text: item.answer_text,
        target_sids: [...targetSids],
        retrieved_sids: retrievedSids,
        retrieved_global: retrievedGlobal,
        hit_at_k: hit,
      });

      if (itemNum % 50 === 0) {
        const runningPct = ((totalHit / itemNum) * 100).toFixed(1);
        console.log(`  [${String(itemNum).padStart(4)}/${items.length}]  running R@${topK}: ${runningPct}%`);
      }
    } finally {
      // Clean up the per-item collection
      await store.deleteCollection();
    }
  }

  // Final results
  const overall = items.length ? ((totalHit / items.length) * 100).toFixed(1) : '0.0';
  console.log(`\n${sep}`);
  console.log(`  RESULTS — MemPal on MemBench (${mode} mode, top-${topK})`);
  console.log(sep);
  console.log(`\n  Overall R@${topK}: ${overall}%  (${totalHit}/${items.length})\n`);
  console.log('  By category:');
  for (const cat of Object.keys(byCat).sort()) {
    const v = byCat[cat];
    const pct = v.total ? ((v.hit_at_k / v.total) * 100).toFixed(1) : '0.0';
    console.log(`    ${cat.padEnd(20)} ${pct.padStart(5)}%  (${v.hit_at_k}/${v.total})`);
  }
  console.log(`\n${sep}\n`);

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`  Results saved to: ${outFile}`);
  }

  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const validCategories = Object.keys(CATEGORY_FILES);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    category: { type: 'string', default: '' },
    topic: { type: 'string', default: 'movie' },
    'top-k': { type: 'string', default: '5' },
    limit: { type: 'string', default: '0' },
    mode: { type: 'string', default: 'hybrid' },
    out: { type: 'string', default: '' },
    'qdrant-url': { type: 'string', default: 'http://localhost:6333' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !positionals.length) {
  console.log(`
Usage: node benchmarks/membenchBench.js <data_dir> [options]

Arguments:
  data_dir                     Path to MemBench FirstAgent directory

Options:
  --category <name>            Run a single category (default: all)
                               Valid: ${validCategories.join(', ')}
  --topic <name>               Topic filter: movie, food, book (default: movie)
  --top-k <n>                  Retrieval top-k (default: 5)
  --limit <n>                  Limit items, 0 = all (default: 0)
  --mode <raw|hybrid>          Retrieval mode (default: hybrid)
  --out <file>                 Output JSON file (default: auto-named)
  --qdrant-url <url>           Qdrant URL (default: http://localhost:6333)
  --help                       Show this help
`);
  process.exit(positionals.length ? 0 : 1);
}

const dataDir = resolve(positionals[0]);
const category = values.category;
const topK = parseInt(values['top-k'], 10);
const limitVal = parseInt(values.limit, 10);
const modeVal = values.mode;

if (category && !validCategories.includes(category)) {
  console.error(`Invalid category: ${category}\nValid: ${validCategories.join(', ')}`);
  process.exit(1);
}

if (modeVal !== 'raw' && modeVal !== 'hybrid') {
  console.error(`Invalid mode: ${modeVal} (must be "raw" or "hybrid")`);
  process.exit(1);
}

let outFile = values.out;
if (!outFile) {
  const catTag = category ? `_${category}` : '_all';
  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '_',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
  ].join('');
  outFile = `benchmarks/results_membench_${modeVal}${catTag}_${values.topic}_top${topK}_${ts}.json`;
}

const cats = category ? [category] : null;
runMembench(dataDir, {
  categories: cats,
  topic: values.topic,
  topK,
  limit: limitVal,
  mode: modeVal,
  outFile,
  qdrantUrl: values['qdrant-url'],
}).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
