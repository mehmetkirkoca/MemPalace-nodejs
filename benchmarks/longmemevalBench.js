#!/usr/bin/env node
/**
 * MemPal x LongMemEval Benchmark (Node.js port)
 * ===============================================
 *
 * Evaluates MemPal's retrieval against the LongMemEval benchmark.
 *
 * For each of the 500 questions:
 * 1. Ingest all haystack sessions into a fresh MemPal palace
 * 2. Query the palace with the question
 * 3. Score retrieval against ground-truth answer sessions
 *
 * Outputs:
 * - Recall@k and NDCG@k at session and turn level
 * - Per-question-type breakdown
 * - JSONL log compatible with LongMemEval's evaluation scripts
 *
 * Modes:
 *   raw     - baseline: raw text into VectorStore (default)
 *   aaak    - AAAK dialect compression before ingestion
 *   rooms   - topic-based room detection + room-filtered search
 *   hybrid  - semantic + keyword overlap re-ranking
 *
 * Usage:
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --mode aaak
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --mode rooms
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --granularity turn
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --limit 20
 */

import fs from 'fs';
import path from 'path';
import { VectorStore } from '../src/vectorStore.js';
import { Embedder } from '../src/embedder.js';
import { Dialect } from '../src/dialect.js';

// =============================================================================
// METRICS
// =============================================================================

function dcg(relevances, k) {
  let score = 0.0;
  const limit = Math.min(relevances.length, k);
  for (let i = 0; i < limit; i++) {
    score += relevances[i] / Math.log2(i + 2);
  }
  return score;
}

function ndcg(rankings, correctIds, corpusIds, k) {
  const relevances = rankings.slice(0, k).map(
    (idx) => correctIds.has(corpusIds[idx]) ? 1.0 : 0.0
  );
  const ideal = [...relevances].sort((a, b) => b - a);
  const idcgVal = dcg(ideal, k);
  if (idcgVal === 0) return 0.0;
  return dcg(relevances, k) / idcgVal;
}

function evaluateRetrieval(rankings, correctIds, corpusIds, k) {
  const topKIds = new Set(rankings.slice(0, k).map((idx) => corpusIds[idx]));
  const recallAny = [...correctIds].some((cid) => topKIds.has(cid)) ? 1.0 : 0.0;
  const recallAll = [...correctIds].every((cid) => topKIds.has(cid)) ? 1.0 : 0.0;
  const ndcgScore = ndcg(rankings, correctIds, corpusIds, k);
  return { recallAny, recallAll, ndcgScore };
}

function sessionIdFromCorpusId(corpusId) {
  if (corpusId.includes('_turn_')) {
    return corpusId.split('_turn_')[0];
  }
  return corpusId;
}

// =============================================================================
// SHARED EMBEDDER & VECTOR STORE HELPERS
// =============================================================================

const _embedder = new Embedder();
let _collectionCounter = 0;

async function freshVectorStore(name) {
  const collectionName = name || `bench_${Date.now()}_${_collectionCounter++}`;
  const store = new VectorStore({ collectionName });
  await store.deleteCollection();
  await store.init();
  return store;
}

// =============================================================================
// CORPUS BUILDER
// =============================================================================

function buildCorpus(entry, granularity = 'session') {
  const corpus = [];
  const corpusIds = [];
  const corpusTimestamps = [];

  const sessions = entry.haystack_sessions;
  const sessionIds = entry.haystack_session_ids;
  const dates = entry.haystack_dates;

  for (let sessIdx = 0; sessIdx < sessions.length; sessIdx++) {
    const session = sessions[sessIdx];
    const sessId = sessionIds[sessIdx];
    const date = dates[sessIdx];

    if (granularity === 'session') {
      const userTurns = session
        .filter((t) => t.role === 'user')
        .map((t) => t.content);
      if (userTurns.length > 0) {
        corpus.push(userTurns.join('\n'));
        corpusIds.push(sessId);
        corpusTimestamps.push(date);
      }
    } else {
      let turnNum = 0;
      for (const turn of session) {
        if (turn.role === 'user') {
          corpus.push(turn.content);
          corpusIds.push(`${sessId}_turn_${turnNum}`);
          corpusTimestamps.push(date);
          turnNum++;
        }
      }
    }
  }

  return { corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// RAW MODE
// =============================================================================

async function buildPalaceAndRetrieve(entry, granularity = 'session', nResults = 50) {
  const { corpus, corpusIds, corpusTimestamps } = buildCorpus(entry, granularity);

  if (corpus.length === 0) {
    return { rankings: [], corpus, corpusIds, corpusTimestamps };
  }

  const store = await freshVectorStore();

  const ids = corpus.map((_, i) => `doc_${i}`);
  const metadatas = corpusIds.map((cid, i) => ({
    corpus_id: cid,
    timestamp: corpusTimestamps[i],
  }));

  await store.add({ ids, documents: corpus, metadatas });

  const query = entry.question;
  const results = await store.query({
    queryTexts: [query],
    nResults: Math.min(nResults, corpus.length),
  });

  const resultIds = results.ids[0];
  const docIdToIdx = new Map(corpus.map((_, i) => [`doc_${i}`, i]));
  const rankedIndices = resultIds.map((rid) => docIdToIdx.get(rid));

  // Fill missing indices
  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) {
      rankedIndices.push(i);
    }
  }

  await store.deleteCollection();
  return { rankings: rankedIndices, corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// AAAK MODE
// =============================================================================

async function buildPalaceAndRetrieveAaak(entry, granularity = 'session', nResults = 50) {
  const dialect = new Dialect();

  const corpus = [];
  const corpusCompressed = [];
  const corpusIds = [];
  const corpusTimestamps = [];

  const sessions = entry.haystack_sessions;
  const sessionIds = entry.haystack_session_ids;
  const dates = entry.haystack_dates;

  for (let sessIdx = 0; sessIdx < sessions.length; sessIdx++) {
    const session = sessions[sessIdx];
    const sessId = sessionIds[sessIdx];
    const date = dates[sessIdx];

    if (granularity === 'session') {
      const userTurns = session
        .filter((t) => t.role === 'user')
        .map((t) => t.content);
      if (userTurns.length > 0) {
        const doc = userTurns.join('\n');
        const compressed = dialect.compress(doc, { date });
        corpus.push(doc);
        corpusCompressed.push(compressed);
        corpusIds.push(sessId);
        corpusTimestamps.push(date);
      }
    } else {
      let turnNum = 0;
      for (const turn of session) {
        if (turn.role === 'user') {
          const compressed = dialect.compress(turn.content);
          corpus.push(turn.content);
          corpusCompressed.push(compressed);
          corpusIds.push(`${sessId}_turn_${turnNum}`);
          corpusTimestamps.push(date);
          turnNum++;
        }
      }
    }
  }

  if (corpus.length === 0) {
    return { rankings: [], corpus, corpusIds, corpusTimestamps };
  }

  const store = await freshVectorStore();

  const ids = corpusCompressed.map((_, i) => `doc_${i}`);
  const metadatas = corpusIds.map((cid, i) => ({
    corpus_id: cid,
    timestamp: corpusTimestamps[i],
  }));

  // Ingest compressed text
  await store.add({ ids, documents: corpusCompressed, metadatas });

  // Query with raw question
  const query = entry.question;
  const results = await store.query({
    queryTexts: [query],
    nResults: Math.min(nResults, corpus.length),
  });

  const resultIds = results.ids[0];
  const docIdToIdx = new Map(corpus.map((_, i) => [`doc_${i}`, i]));
  const rankedIndices = resultIds.map((rid) => docIdToIdx.get(rid));

  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) rankedIndices.push(i);
  }

  await store.deleteCollection();
  return { rankings: rankedIndices, corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// ROOMS MODE
// =============================================================================

const TOPIC_KEYWORDS = {
  technical: [
    'code', 'python', 'function', 'bug', 'error', 'api', 'database',
    'server', 'deploy', 'git', 'test', 'debug', 'refactor',
  ],
  planning: [
    'plan', 'roadmap', 'milestone', 'deadline', 'priority', 'sprint',
    'backlog', 'scope', 'requirement', 'spec',
  ],
  decisions: [
    'decided', 'chose', 'picked', 'switched', 'migrated', 'replaced',
    'trade-off', 'alternative', 'option', 'approach',
  ],
  personal: [
    'family', 'friend', 'birthday', 'vacation', 'hobby', 'health',
    'feeling', 'love', 'home', 'weekend',
  ],
  knowledge: [
    'learn', 'study', 'degree', 'school', 'university', 'course',
    'research', 'paper', 'book', 'reading',
  ],
};

function detectRoomForText(text) {
  const textLower = text.slice(0, 3000).toLowerCase();
  const scores = {};
  for (const [room, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const score = keywords.filter((kw) => textLower.includes(kw)).length;
    if (score > 0) scores[room] = score;
  }
  if (Object.keys(scores).length > 0) {
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }
  return 'general';
}

async function buildPalaceAndRetrieveRooms(entry, granularity = 'session', nResults = 50) {
  const corpus = [];
  const corpusIds = [];
  const corpusTimestamps = [];
  const corpusRooms = [];

  const sessions = entry.haystack_sessions;
  const sessionIds = entry.haystack_session_ids;
  const dates = entry.haystack_dates;

  for (let sessIdx = 0; sessIdx < sessions.length; sessIdx++) {
    const session = sessions[sessIdx];
    const sessId = sessionIds[sessIdx];
    const date = dates[sessIdx];

    if (granularity === 'session') {
      const userTurns = session
        .filter((t) => t.role === 'user')
        .map((t) => t.content);
      if (userTurns.length > 0) {
        const doc = userTurns.join('\n');
        const room = detectRoomForText(doc);
        corpus.push(doc);
        corpusIds.push(sessId);
        corpusTimestamps.push(date);
        corpusRooms.push(room);
      }
    } else {
      let turnNum = 0;
      for (const turn of session) {
        if (turn.role === 'user') {
          const room = detectRoomForText(turn.content);
          corpus.push(turn.content);
          corpusIds.push(`${sessId}_turn_${turnNum}`);
          corpusTimestamps.push(date);
          corpusRooms.push(room);
          turnNum++;
        }
      }
    }
  }

  if (corpus.length === 0) {
    return { rankings: [], corpus, corpusIds, corpusTimestamps };
  }

  const store = await freshVectorStore();

  const ids = corpus.map((_, i) => `doc_${i}`);
  const metadatas = corpusIds.map((cid, i) => ({
    corpus_id: cid,
    timestamp: corpusTimestamps[i],
    room: corpusRooms[i],
  }));

  await store.add({ ids, documents: corpus, metadatas });

  const query = entry.question;
  const queryRoom = detectRoomForText(query);

  const globalResults = await store.query({
    queryTexts: [query],
    nResults: Math.min(nResults, corpus.length),
  });

  // Rerank: boost results in matching room
  const docIdToIdx = new Map(corpus.map((_, i) => [`doc_${i}`, i]));
  const scored = [];

  for (let j = 0; j < globalResults.ids[0].length; j++) {
    const rid = globalResults.ids[0][j];
    const dist = globalResults.distances[0][j];
    const meta = globalResults.metadatas[0][j];
    const idx = docIdToIdx.get(rid);
    // Qdrant returns similarity scores (higher = better), not distances
    // For room boost: increase score by 20% if room matches
    const boostedDist = meta.room === queryRoom ? dist * 1.2 : dist;
    scored.push({ idx, dist: boostedDist });
  }

  // Sort by score descending (higher = more relevant for Qdrant cosine similarity)
  scored.sort((a, b) => b.dist - a.dist);
  const rankedIndices = scored.map((s) => s.idx);

  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) rankedIndices.push(i);
  }

  await store.deleteCollection();
  return { rankings: rankedIndices, corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// HYBRID MODE
// =============================================================================

const STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'how', 'which', 'did', 'do', 'was', 'were',
  'have', 'has', 'had', 'is', 'are', 'the', 'a', 'an', 'my', 'me', 'i', 'you',
  'your', 'their', 'it', 'its', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'ago', 'last', 'that', 'this', 'there', 'about', 'get', 'got',
  'give', 'gave', 'buy', 'bought', 'made', 'make',
]);

function extractKeywords(text) {
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  return words.filter((w) => !STOP_WORDS.has(w));
}

function keywordOverlap(queryKws, docText) {
  const docLower = docText.toLowerCase();
  if (queryKws.length === 0) return 0.0;
  const hits = queryKws.filter((kw) => docLower.includes(kw)).length;
  return hits / queryKws.length;
}

async function buildPalaceAndRetrieveHybrid(
  entry, granularity = 'session', nResults = 50, hybridWeight = 0.30
) {
  const { corpus, corpusIds, corpusTimestamps } = buildCorpus(entry, granularity);

  if (corpus.length === 0) {
    return { rankings: [], corpus, corpusIds, corpusTimestamps };
  }

  const store = await freshVectorStore();

  const ids = corpus.map((_, i) => `doc_${i}`);
  const metadatas = corpusIds.map((cid, i) => ({
    corpus_id: cid,
    timestamp: corpusTimestamps[i],
  }));

  await store.add({ ids, documents: corpus, metadatas });

  const query = entry.question;
  const results = await store.query({
    queryTexts: [query],
    nResults: Math.min(nResults, corpus.length),
  });

  const resultIds = results.ids[0];
  const distances = results.distances[0];
  const documents = results.documents[0];

  const docIdToIdx = new Map(corpus.map((_, i) => [`doc_${i}`, i]));
  const queryKeywords = extractKeywords(query);

  // Re-rank by fusing semantic score with keyword overlap
  const scored = [];
  for (let j = 0; j < resultIds.length; j++) {
    const idx = docIdToIdx.get(resultIds[j]);
    const dist = distances[j];
    const doc = documents[j];
    const overlap = keywordOverlap(queryKeywords, doc);
    // Qdrant returns cosine similarity (higher = better)
    // Boost score by keyword overlap
    const fusedScore = dist * (1.0 + hybridWeight * overlap);
    scored.push({ idx, score: fusedScore });
  }

  // Sort descending (higher similarity = more relevant)
  scored.sort((a, b) => b.score - a.score);
  const rankedIndices = scored.map((s) => s.idx);

  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) rankedIndices.push(i);
  }

  await store.deleteCollection();
  return { rankings: rankedIndices, corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// MAIN RUNNER
// =============================================================================

async function runBenchmark({
  dataFile,
  granularity = 'session',
  limit = 0,
  outFile = null,
  mode = 'raw',
  skip = 0,
  hybridWeight = 0.30,
}) {
  const rawData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

  let data = rawData;
  if (limit > 0) data = data.slice(0, limit);
  if (skip > 0) {
    console.log(`  Ilk ${skip} soru atlaniyor (resume modu)`);
    data = data.slice(skip);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal x LongMemEval Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data:        ${path.basename(dataFile)}`);
  console.log(`  Questions:   ${data.length}`);
  console.log(`  Granularity: ${granularity}`);
  console.log(`  Mode:        ${mode}`);
  console.log(`${'─'.repeat(60)}\n`);

  // Metric containers
  const ks = [1, 3, 5, 10, 30, 50];

  const metricsSession = {};
  const metricsTurn = {};
  for (const k of ks) {
    metricsSession[`recall_any@${k}`] = [];
    metricsSession[`recall_all@${k}`] = [];
    metricsSession[`ndcg_any@${k}`] = [];
    metricsTurn[`recall_any@${k}`] = [];
    metricsTurn[`recall_all@${k}`] = [];
    metricsTurn[`ndcg_any@${k}`] = [];
  }

  const perType = {};
  const resultsLog = [];
  const startTime = Date.now();

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const qid = entry.question_id;
    const qtype = entry.question_type;
    const question = entry.question;
    const answerSids = new Set(entry.answer_session_ids);

    let result;
    try {
      if (mode === 'aaak') {
        result = await buildPalaceAndRetrieveAaak(entry, granularity);
      } else if (mode === 'rooms') {
        result = await buildPalaceAndRetrieveRooms(entry, granularity);
      } else if (mode === 'hybrid') {
        result = await buildPalaceAndRetrieveHybrid(entry, granularity, 50, hybridWeight);
      } else {
        result = await buildPalaceAndRetrieve(entry, granularity);
      }
    } catch (err) {
      console.error(`  [${String(i + 1).padStart(4)}/${data.length}] ${qid.slice(0, 30).padEnd(30)} ERROR: ${err.message}`);
      continue;
    }

    const { rankings, corpus, corpusIds, corpusTimestamps } = result;

    if (rankings.length === 0) {
      console.log(`  [${String(i + 1).padStart(4)}/${data.length}] ${qid.slice(0, 30).padEnd(30)} SKIP (empty corpus)`);
      continue;
    }

    // Session-level IDs
    const sessionLevelIds = corpusIds.map(sessionIdFromCorpusId);
    const sessionCorrect = answerSids;

    // Turn-level correct
    const turnCorrect = new Set();
    for (const cid of corpusIds) {
      const sid = sessionIdFromCorpusId(cid);
      if (answerSids.has(sid)) turnCorrect.add(cid);
    }

    const entryMetrics = { session: {}, turn: {} };

    for (const k of ks) {
      // Session-level
      const { recallAny: ra, recallAll: rl, ndcgScore: nd } =
        evaluateRetrieval(rankings, sessionCorrect, sessionLevelIds, k);
      metricsSession[`recall_any@${k}`].push(ra);
      metricsSession[`recall_all@${k}`].push(rl);
      metricsSession[`ndcg_any@${k}`].push(nd);
      entryMetrics.session[`recall_any@${k}`] = ra;
      entryMetrics.session[`ndcg_any@${k}`] = nd;

      // Turn-level
      const { recallAny: raT, recallAll: rlT, ndcgScore: ndT } =
        evaluateRetrieval(rankings, turnCorrect, corpusIds, k);
      metricsTurn[`recall_any@${k}`].push(raT);
      metricsTurn[`recall_all@${k}`].push(rlT);
      metricsTurn[`ndcg_any@${k}`].push(ndT);
      entryMetrics.turn[`recall_any@${k}`] = raT;
    }

    // Per-type tracking
    if (!perType[qtype]) {
      perType[qtype] = { 'recall_any@5': [], 'recall_any@10': [], 'ndcg_any@10': [] };
    }
    perType[qtype]['recall_any@5'].push(
      metricsSession['recall_any@5'][metricsSession['recall_any@5'].length - 1]
    );
    perType[qtype]['recall_any@10'].push(
      metricsSession['recall_any@10'][metricsSession['recall_any@10'].length - 1]
    );
    perType[qtype]['ndcg_any@10'].push(
      metricsSession['ndcg_any@10'][metricsSession['ndcg_any@10'].length - 1]
    );

    // Log entry
    const rankedItems = rankings.slice(0, 50).map((idx) => ({
      corpus_id: corpusIds[idx],
      text: corpus[idx].slice(0, 500),
      timestamp: corpusTimestamps[idx],
    }));

    resultsLog.push({
      question_id: qid,
      question_type: qtype,
      question,
      answer: entry.answer,
      retrieval_results: {
        query: question,
        ranked_items: rankedItems,
        metrics: entryMetrics,
      },
    });

    // Progress
    const r5 = metricsSession['recall_any@5'][metricsSession['recall_any@5'].length - 1];
    const r10 = metricsSession['recall_any@10'][metricsSession['recall_any@10'].length - 1];
    const status = r5 > 0 ? 'HIT' : 'miss';
    console.log(
      `  [${String(i + 1).padStart(4)}/${data.length}] ${qid.slice(0, 30).padEnd(30)} R@5=${r5.toFixed(0)} R@10=${r10.toFixed(0)}  ${status}`
    );
  }

  const elapsed = (Date.now() - startTime) / 1000;

  // Print results
  const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS - MemPal (${mode} mode, ${granularity} granularity)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Time: ${elapsed.toFixed(1)}s (${(elapsed / data.length).toFixed(2)}s per question)\n`);

  console.log('  SESSION-LEVEL METRICS:');
  for (const k of ks) {
    const ra = avg(metricsSession[`recall_any@${k}`]);
    const nd = avg(metricsSession[`ndcg_any@${k}`]);
    console.log(`    Recall@${String(k).padStart(2)}: ${ra.toFixed(3)}    NDCG@${String(k).padStart(2)}: ${nd.toFixed(3)}`);
  }

  console.log('\n  TURN-LEVEL METRICS:');
  for (const k of ks) {
    const ra = avg(metricsTurn[`recall_any@${k}`]);
    const nd = avg(metricsTurn[`ndcg_any@${k}`]);
    console.log(`    Recall@${String(k).padStart(2)}: ${ra.toFixed(3)}    NDCG@${String(k).padStart(2)}: ${nd.toFixed(3)}`);
  }

  console.log('\n  PER-TYPE BREAKDOWN (session recall_any@10):');
  for (const qtype of Object.keys(perType).sort()) {
    const vals = perType[qtype];
    const r10 = avg(vals['recall_any@10']);
    const n = vals['recall_any@10'].length;
    console.log(`    ${qtype.padEnd(35)} R@10=${r10.toFixed(3)}  (n=${n})`);
  }

  console.log(`\n${'='.repeat(60)}\n`);

  // Save results
  if (outFile) {
    const lines = resultsLog.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(outFile, lines + '\n');
    console.log(`  Results saved to: ${outFile}`);
  }
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    dataFile: null,
    granularity: 'session',
    limit: 0,
    mode: 'raw',
    out: null,
    skip: 0,
    hybridWeight: 0.30,
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--granularity') {
      parsed.granularity = args[++i];
    } else if (arg === '--limit') {
      parsed.limit = parseInt(args[++i], 10);
    } else if (arg === '--mode') {
      parsed.mode = args[++i];
    } else if (arg === '--out') {
      parsed.out = args[++i];
    } else if (arg === '--skip') {
      parsed.skip = parseInt(args[++i], 10);
    } else if (arg === '--hybrid-weight') {
      parsed.hybridWeight = parseFloat(args[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node benchmarks/longmemevalBench.js <data_file> [options]

Options:
  --granularity <session|turn>  Retrieval granularity (default: session)
  --limit <N>                   Limit to N questions (0 = all)
  --mode <mode>                 raw, aaak, rooms, hybrid (default: raw)
  --out <file>                  Output JSONL file path
  --skip <N>                    Skip first N questions
  --hybrid-weight <float>       Keyword overlap weight for hybrid (default: 0.30)
  -h, --help                    Show help`);
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error('ERROR: data_file argument required. Run with --help for usage.');
    process.exit(1);
  }
  parsed.dataFile = positional[0];

  const validModes = ['raw', 'aaak', 'rooms', 'hybrid'];
  if (!validModes.includes(parsed.mode)) {
    console.error(`ERROR: invalid mode '${parsed.mode}'. Valid: ${validModes.join(', ')}`);
    process.exit(1);
  }

  const validGran = ['session', 'turn'];
  if (!validGran.includes(parsed.granularity)) {
    console.error(`ERROR: invalid granularity '${parsed.granularity}'. Valid: ${validGran.join(', ')}`);
    process.exit(1);
  }

  // Default output file
  if (!parsed.out) {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 13);
    parsed.out = `benchmarks/results_mempal_${parsed.mode}_${parsed.granularity}_${ts}.jsonl`;
  }

  return parsed;
}

// =============================================================================
// ENTRY POINT
// =============================================================================

const config = parseArgs();

runBenchmark({
  dataFile: config.dataFile,
  granularity: config.granularity,
  limit: config.limit,
  outFile: config.out,
  mode: config.mode,
  skip: config.skip,
  hybridWeight: config.hybridWeight,
}).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
