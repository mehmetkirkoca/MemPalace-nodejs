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
 *   raw     - baseline: raw text into VectorStore, no routing (default)
 *   rooms   - topic-based room detection + room-filtered search
 *   hybrid  - semantic + keyword overlap re-ranking
 *   system  - full MemPalace pipeline: pipelineSave + room-filtered pipelineSearch
 *
 * Flags:
 *   --multi-palace   (system mode only) split sessions into personal/general palaces
 *
 * Usage:
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --mode system
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --mode system --multi-palace
 *   node benchmarks/longmemevalBench.js data/longmemeval_s_cleaned.json --limit 20
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { VectorStore } from '../src/vectorStore.js';
import { Embedder } from '../src/embedder.js';
import {
  slugifyRoom,
  selectPalace,
  selectHall,
  getHallVectors,
  scoreImportance,
} from '../src/mempalacePipeline.js';

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
// MCP CLIENT HELPER
// =============================================================================

/**
 * Minimal MCP HTTP client.
 * Maintains a single session against a running mempalace MCP server.
 */
class McpClient {
  constructor(url = 'http://localhost:3100/mcp') {
    this._url = url;
    this._sessionId = null;
  }

  async connect() {
    const res = await fetch(this._url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'lme-benchmark', version: '1.0' },
        },
      }),
    });
    this._sessionId = res.headers.get('mcp-session-id');
    const body = await res.json();
    if (body.error) throw new Error(`MCP init error: ${body.error.message}`);
    return body.result;
  }

  async call(toolName, args) {
    const res = await fetch(this._url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(this._sessionId ? { 'mcp-session-id': this._sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: Date.now(),
        params: { name: toolName, arguments: args },
      }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP tool error (${toolName}): ${body.error.message}`);
    const text = body.result?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  async save(content, context = '') {
    return this.call('mempalace_save', { content, context });
  }

  async search(query, nResults = 50) {
    return this.call('mempalace_search', { query, n_results: nResults });
  }
}

// =============================================================================
// MCP MODE — build phase: ingest all haystack sessions via real mempalace_save
// =============================================================================

async function mcpBuild(data, granularity, mcpUrl, concurrency = 4, statusInterval = 50) {
  // Collect all unique sessions across all entries
  const seen = new Set();
  const items = [];
  for (const entry of data) {
    const { corpus, corpusIds } = buildCorpus(entry, granularity);
    for (let i = 0; i < corpus.length; i++) {
      const key = corpusIds[i];
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ content: corpus[i], context: corpusIds[i] });
      }
    }
  }

  console.log(`\n  Building palace: ${items.length} unique sessions to save (concurrency=${concurrency})...`);

  // One persistent MCP client per worker slot
  const clients = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const c = new McpClient(mcpUrl);
      await c.connect();
      return c;
    })
  );

  let total = 0;
  let saved = 0;
  let skipped = 0;
  let idx = 0;

  // Worker: pulls items off the queue until exhausted, retries once on error
  async function worker(client) {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const { content, context } = items[i];
      let result = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = await client.save(content, context);
          break;
        } catch (err) {
          if (attempt === 0) {
            // Brief back-off then retry with a fresh connection
            await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
            try { await client.connect(); } catch { /* ignore reconnect error */ }
          } else {
            process.stderr.write(`\n  [${i + 1}/${items.length}] SAVE ERROR: ${err.message}\n`);
          }
        }
      }
      if (result?.success === false && result?.reason === 'duplicate') {
        skipped++;
      } else if (result) {
        saved++;
      }
      total++;
      if (total % statusInterval === 0 || total === items.length) {
        process.stdout.write(`\r  Progress: ${total}/${items.length}  saved=${saved}  skipped(dup)=${skipped}  `);
      }
    }
  }

  await Promise.all(clients.map((c) => worker(c)));
  console.log('\n  Build complete.');
  return { total, saved, skipped };
}

// =============================================================================
// MCP MODE — query phase: search via real mempalace_search (no save, no delete)
// =============================================================================

async function mcpSearch(entry, granularity, nResults, client) {
  const { corpus, corpusIds, corpusTimestamps } = buildCorpus(entry, granularity);
  if (corpus.length === 0) return { rankings: [], corpus, corpusIds, corpusTimestamps };

  const result = await client.search(entry.question, nResults);

  // result.results is array of { text, room, similarity, ... }
  const hits = result?.results || [];

  // Map returned texts back to corpus indices
  const docTextToIdx = new Map();
  for (let i = corpus.length - 1; i >= 0; i--) {
    docTextToIdx.set(corpus[i], i);
  }

  const rankedIndices = [];
  for (const hit of hits) {
    const idx = docTextToIdx.get(hit.text);
    if (idx !== undefined && !rankedIndices.includes(idx)) {
      rankedIndices.push(idx);
    }
  }

  // Fill in anything the search missed (unranked items go to the end)
  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) rankedIndices.push(i);
  }

  return { rankings: rankedIndices, corpus, corpusIds, corpusTimestamps };
}

// =============================================================================
// SYSTEM MODE
// =============================================================================

/**
 * Full MemPalace pipeline: pipelineSave → room-filtered pipelineSearch.
 * With --multi-palace: two palaces (personal / general), content auto-routed.
 */
async function buildAndRetrieveSystem(entry, granularity = 'session', nResults = 50, multiPalace = false) {
  const { corpus, corpusIds, corpusTimestamps } = buildCorpus(entry, granularity);

  if (corpus.length === 0) {
    return { rankings: [], corpus, corpusIds, corpusTimestamps, routingLog: [], roomFilterUsed: false };
  }

  // --- Palace setup ---
  let palaces, stores;
  if (multiPalace) {
    const personalVec = await _embedder.embed(
      'personal life family health emotions relationships hobbies feelings diary weekend home'
    );
    const generalVec = await _embedder.embed(
      'work technical decisions projects knowledge research facts architecture code'
    );
    palaces = [
      { name: 'bench_personal', scope_vector: personalVec, is_default: false },
      { name: 'bench_general',  scope_vector: generalVec,  is_default: true  },
    ];
    stores = {
      bench_personal: await freshVectorStore('bench_personal'),
      bench_general:  await freshVectorStore('bench_general'),
    };
  } else {
    palaces = [{ name: 'bench_single', scope_vector: null, is_default: true }];
    stores  = { bench_single: await freshVectorStore('bench_single') };
  }

  // --- Ingest: embed once per item, reuse vector for palace + hall + Qdrant ---
  const hallVectors = await getHallVectors();
  const routingLog = [];
  for (let i = 0; i < corpus.length; i++) {
    const vec = await _embedder.embed(corpus[i]);
    const { name: palaceName } = selectPalace(vec, palaces);
    const hall = selectHall(vec, hallVectors);
    const room = slugifyRoom(corpus[i] + '\n' + corpusIds[i]);
    const importance = scoreImportance(corpus[i], corpusIds[i]);
    const hash = crypto
      .createHash('md5')
      .update(corpus[i].slice(0, 100) + i.toString())
      .digest('hex')
      .slice(0, 12);
    const drawerId = `drawer_${room}_${hash}`;

    await stores[palaceName].addWithVectors({
      ids: [drawerId],
      documents: [corpus[i]],
      vectors: [vec],
      metadatas: [{ room, hall, palace: palaceName, importance, corpus_id: corpusIds[i], added_by: 'benchmark' }],
    });
    routingLog.push({ corpusIdx: i, corpusId: corpusIds[i], palaceName, room, hall });
  }

  // --- Search: embed question once, reuse for palace + Qdrant query ---
  const qVec = await _embedder.embed(entry.question);
  const { name: qPalace } = selectPalace(qVec, palaces);
  const estimatedRoom = slugifyRoom(entry.question);
  const nRes = Math.min(nResults, corpus.length);

  // Room-filtered search first, fall back to unfiltered
  let rawResults = null;
  let roomFilterUsed = false;
  if (estimatedRoom && estimatedRoom !== 'general') {
    const filtered = await stores[qPalace].queryWithVector({
      queryVector: qVec,
      nResults: nRes,
      where: { room: estimatedRoom },
    });
    if (filtered.ids[0].length > 0) {
      rawResults = filtered;
      roomFilterUsed = true;
    }
  }
  if (!rawResults) {
    rawResults = await stores[qPalace].queryWithVector({ queryVector: qVec, nResults: nRes });
  }

  // Map search results back to corpus indices by matching document text
  const docTextToIdx = new Map();
  for (let i = corpus.length - 1; i >= 0; i--) {
    docTextToIdx.set(corpus[i], i);  // earlier index wins (preserve order)
  }

  const rankedIndices = [];
  const resultDocs = rawResults.documents[0] || [];
  for (const doc of resultDocs) {
    const idx = docTextToIdx.get(doc);
    if (idx !== undefined && !rankedIndices.includes(idx)) {
      rankedIndices.push(idx);
    }
  }

  // Fill in anything the search missed
  const seen = new Set(rankedIndices);
  for (let i = 0; i < corpus.length; i++) {
    if (!seen.has(i)) rankedIndices.push(i);
  }

  // Cleanup
  for (const store of Object.values(stores)) await store.deleteCollection();

  return {
    rankings: rankedIndices,
    corpus,
    corpusIds,
    corpusTimestamps,
    routingLog,
    roomFilterUsed,
    qPalace,
  };
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
  multiPalace = false,
  build = false,
  mcpUrl = 'http://localhost:3100/mcp',
  concurrency = 4,
}) {
  const rawData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));

  // MCP build phase: ingest all sessions into real palace, then exit
  if (mode === 'mcp' && build) {
    const allData = limit > 0 ? rawData.slice(0, limit) : rawData;
    console.log(`\n${'='.repeat(60)}`);
    console.log('  MemPal x LongMemEval — MCP Build Phase');
    console.log(`${'='.repeat(60)}`);
    console.log(`  Data:        ${path.basename(dataFile)}`);
    console.log(`  Entries:     ${allData.length}`);
    console.log(`  Granularity: ${granularity}`);
    console.log(`  MCP Server:  ${mcpUrl}`);
    console.log(`${'─'.repeat(60)}`);
    const startTime = Date.now();
    const stats = await mcpBuild(allData, granularity, mcpUrl, concurrency);
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\n  Done in ${elapsed.toFixed(1)}s`);
    console.log(`  Total:   ${stats.total}`);
    console.log(`  Saved:   ${stats.saved}`);
    console.log(`  Skipped: ${stats.skipped} (duplicates)`);
    console.log(`\n${'='.repeat(60)}\n`);
    return;
  }

  let data = rawData;
  if (limit > 0) data = data.slice(0, limit);
  if (skip > 0) {
    console.log(`  Skipping first ${skip} questions (resume mode)`);
    data = data.slice(skip);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPal x LongMemEval Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data:        ${path.basename(dataFile)}`);
  console.log(`  Questions:   ${data.length}`);
  console.log(`  Granularity: ${granularity}`);
  console.log(`  Mode:        ${mode}${mode === 'system' && multiPalace ? ' (multi-palace)' : ''}${mode === 'mcp' ? ` (${mcpUrl})` : ''}`);
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

  // MCP mode: single persistent client for all queries
  let mcpClient = null;
  if (mode === 'mcp') {
    mcpClient = new McpClient(mcpUrl);
    await mcpClient.connect();
  }

  // System mode pipeline stats
  const sysStats = {
    palaceRouting: {},
    roomFilterHits: 0,
    roomFilterMisses: 0,
    hallDist: {},
    totalItems: 0,
  };

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    const qid = entry.question_id;
    const qtype = entry.question_type;
    const question = entry.question;
    const answerSids = new Set(entry.answer_session_ids);

    let result;
    try {
      if (mode === 'rooms') {
        result = await buildPalaceAndRetrieveRooms(entry, granularity);
      } else if (mode === 'hybrid') {
        result = await buildPalaceAndRetrieveHybrid(entry, granularity, 50, hybridWeight);
      } else if (mode === 'system') {
        result = await buildAndRetrieveSystem(entry, granularity, 50, multiPalace);
      } else if (mode === 'mcp') {
        result = await mcpSearch(entry, granularity, 50, mcpClient);
      } else {
        result = await buildPalaceAndRetrieve(entry, granularity);
      }
    } catch (err) {
      console.error(`  [${String(i + 1).padStart(4)}/${data.length}] ${qid.slice(0, 30).padEnd(30)} ERROR: ${err.message}`);
      continue;
    }

    const { rankings, corpus, corpusIds, corpusTimestamps, routingLog, roomFilterUsed } = result;

    // Accumulate system pipeline stats
    if (mode === 'system' && routingLog) {
      sysStats.totalItems += routingLog.length;
      for (const log of routingLog) {
        sysStats.palaceRouting[log.palaceName] = (sysStats.palaceRouting[log.palaceName] || 0) + 1;
        if (log.hall) sysStats.hallDist[log.hall] = (sysStats.hallDist[log.hall] || 0) + 1;
      }
      if (roomFilterUsed) sysStats.roomFilterHits++;
      else sysStats.roomFilterMisses++;
    }

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

  if (mode === 'system' && sysStats.totalItems > 0) {
    const total = sysStats.totalItems;
    const filterTotal = sysStats.roomFilterHits + sysStats.roomFilterMisses;
    console.log('\n  SYSTEM PIPELINE STATS:');
    console.log(`    Items ingested:      ${total}`);
    console.log(`    Room filter hits:    ${sysStats.roomFilterHits}/${filterTotal} (${(sysStats.roomFilterHits / filterTotal * 100).toFixed(1)}%)`);
    if (Object.keys(sysStats.palaceRouting).length > 1) {
      console.log('    Palace routing:');
      for (const [name, count] of Object.entries(sysStats.palaceRouting).sort()) {
        console.log(`      ${name.padEnd(20)} ${count} (${(count / total * 100).toFixed(1)}%)`);
      }
    }
    console.log('    Hall distribution:');
    for (const [hall, count] of Object.entries(sysStats.hallDist).sort()) {
      console.log(`      ${hall.padEnd(20)} ${count} (${(count / total * 100).toFixed(1)}%)`);
    }
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
    multiPalace: false,
    build: false,
    mcpUrl: 'http://localhost:3100/mcp',
    concurrency: 4,
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
    } else if (arg === '--multi-palace') {
      parsed.multiPalace = true;
    } else if (arg === '--build') {
      parsed.build = true;
    } else if (arg === '--mcp-url') {
      parsed.mcpUrl = args[++i];
    } else if (arg === '--concurrency') {
      parsed.concurrency = parseInt(args[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node benchmarks/longmemevalBench.js <data_file> [options]

Options:
  --granularity <session|turn>  Retrieval granularity (default: session)
  --limit <N>                   Limit to N questions (0 = all)
  --mode <mode>                 raw, rooms, hybrid, system (default: raw)
  --out <file>                  Output JSONL file path
  --skip <N>                    Skip first N questions
  --hybrid-weight <float>       Keyword overlap weight for hybrid (default: 0.30)
  --multi-palace                (system mode) split into personal/general palaces
  --build                       (mcp mode) ingest all sessions into palace, then exit
  --mcp-url <url>               MCP server URL (default: http://localhost:3100/mcp)
  --concurrency <N>             (mcp build) parallel save workers (default: 8)
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

  const validModes = ['raw', 'rooms', 'hybrid', 'system', 'mcp'];
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
  multiPalace: config.multiPalace,
  build: config.build,
  mcpUrl: config.mcpUrl,
  concurrency: config.concurrency,
}).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
