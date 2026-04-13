#!/usr/bin/env node
/**
 * MemPalace × LoCoMo Benchmark
 * ==============================
 *
 * Measures MemPalace retrieval on the LoCoMo benchmark.
 * 10 conversations, 5 categories, ~200 QA pairs.
 *
 * Modes:
 *   raw     - flat VectorStore + cosine search (baseline)
 *   hybrid  - semantic + keyword/name/quoted-phrase re-rank
 *   rooms   - two-stage: keyword-select rooms, then hybrid within rooms
 *   palace  - LLM-assigned rooms + hybrid re-rank (requires API key)
 *   system  - full MemPalace pipeline: pipelineSave + room-filtered pipelineSearch
 *
 * Flags:
 *   --multi-palace   (system mode only) split into personal/general palaces
 *
 * Usage:
 *   node benchmarks/locomoBench.js /path/to/locomo10.json
 *   node benchmarks/locomoBench.js /path/to/locomo10.json --top-k 10
 *   node benchmarks/locomoBench.js /path/to/locomo10.json --mode system
 *   node benchmarks/locomoBench.js /path/to/locomo10.json --mode system --multi-palace
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename, join, dirname } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { VectorStore } from '../src/vectorStore.js';
import { Embedder } from '../src/embedder.js';
import {
  slugifyRoom,
  selectPalace,
  selectHall,
  getHallVectors,
  scoreImportance,
} from '../src/mempalacePipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Category labels ──────────────────────────────────────────────────────────

const CATEGORIES = {
  1: 'Single-hop',
  2: 'Temporal',
  3: 'Temporal-inference',
  4: 'Open-domain',
  5: 'Adversarial',
};

// ─── Metrics (adapted from LoCoMo evaluation.py) ──────────────────────────────

const PUNCTUATION = new Set(
  '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split('')
);

function normalizeAnswer(s) {
  s = s.replace(/,/g, '');
  s = s.replace(/\b(a|an|the|and)\b/g, ' ');
  s = s.split(/\s+/).join(' ');
  s = s
    .split('')
    .filter((ch) => !PUNCTUATION.has(ch))
    .join('');
  return s.toLowerCase().trim();
}

function f1Score(prediction, groundTruth) {
  const predTokens = normalizeAnswer(prediction).split(/\s+/).filter(Boolean);
  const truthTokens = normalizeAnswer(groundTruth).split(/\s+/).filter(Boolean);

  if (!predTokens.length || !truthTokens.length) {
    return predTokens.length === truthTokens.length ? 1.0 : 0.0;
  }

  const predCounts = _counter(predTokens);
  const truthCounts = _counter(truthTokens);
  let numSame = 0;
  for (const [token, count] of predCounts) {
    numSame += Math.min(count, truthCounts.get(token) || 0);
  }

  if (numSame === 0) return 0.0;
  const precision = numSame / predTokens.length;
  const recall = numSame / truthTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function _counter(arr) {
  const map = new Map();
  for (const item of arr) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadConversationSessions(conversation, sessionSummaries = null) {
  const sessions = [];
  let sessionNum = 1;
  while (true) {
    const key = `session_${sessionNum}`;
    const dateKey = `session_${sessionNum}_date_time`;
    if (!(key in conversation)) break;

    const dialogs = conversation[key];
    const date = conversation[dateKey] || '';
    let summary = '';
    if (sessionSummaries) {
      summary = sessionSummaries[`session_${sessionNum}_summary`] || '';
    }
    sessions.push({ sessionNum, date, dialogs, summary });
    sessionNum++;
  }
  return sessions;
}

function buildCorpusFromSessions(sessions, granularity = 'dialog') {
  const corpus = [];
  const corpusIds = [];
  const corpusTimestamps = [];

  for (const sess of sessions) {
    if (granularity === 'session' || granularity === 'rooms') {
      let doc;
      if (granularity === 'rooms' && sess.summary) {
        doc = sess.summary;
      } else {
        const texts = sess.dialogs.map((d) => {
          const speaker = d.speaker || '?';
          const text = d.text || '';
          return `${speaker} said, "${text}"`;
        });
        doc = texts.join('\n');
      }
      corpus.push(doc);
      corpusIds.push(`session_${sess.sessionNum}`);
      corpusTimestamps.push(sess.date);
    } else {
      // dialog granularity
      for (const d of sess.dialogs) {
        const diaId = d.dia_id || `D${sess.sessionNum}:?`;
        const speaker = d.speaker || '?';
        const text = d.text || '';
        const doc = `${speaker} said, "${text}"`;
        corpus.push(doc);
        corpusIds.push(diaId);
        corpusTimestamps.push(sess.date);
      }
    }
  }

  return { corpus, corpusIds, corpusTimestamps };
}

// ─── Hybrid scoring helpers ───────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'how', 'which', 'did', 'do',
  'was', 'were', 'have', 'has', 'had', 'is', 'are', 'the', 'a', 'an',
  'my', 'me', 'i', 'you', 'your', 'their', 'it', 'its',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'ago', 'last', 'that', 'this', 'there', 'about',
  'get', 'got', 'give', 'gave', 'buy', 'bought', 'made', 'make', 'said',
]);

const NOT_NAMES = new Set([
  'What', 'When', 'Where', 'Who', 'How', 'Which',
  'Did', 'Do', 'Was', 'Were', 'Have', 'Has', 'Had', 'Is', 'Are',
  'The', 'My', 'Our', 'Their', 'Can', 'Could', 'Would', 'Should',
  'Will', 'Shall', 'May', 'Might',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'In', 'On', 'At', 'For', 'To', 'Of', 'With', 'By', 'From',
  'And', 'But', 'I', 'It', 'Its', 'This', 'That', 'These', 'Those',
  'Previously', 'Recently', 'Also', 'Just', 'Very', 'More',
  'Said', 'Speaker', 'Person', 'Time', 'Date', 'Year', 'Day',
]);

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

function _quotedPhrases(text) {
  const phrases = [];
  for (const pat of [/'([^']{3,60})'/g, /"([^"]{3,60})"/g]) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const p = m[1].trim();
      if (p.length >= 3) phrases.push(p);
    }
  }
  return phrases;
}

function _quotedBoost(phrases, docText) {
  if (!phrases.length) return 0.0;
  const docLower = docText.toLowerCase();
  const hits = phrases.filter((p) => docLower.includes(p.toLowerCase())).length;
  return Math.min(hits / phrases.length, 1.0);
}

function _personNames(text) {
  const words = text.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
  return [...new Set(words.filter((w) => !NOT_NAMES.has(w)))];
}

function _nameBoost(names, docText) {
  if (!names.length) return 0.0;
  const docLower = docText.toLowerCase();
  const hits = names.filter((n) => docLower.includes(n.toLowerCase())).length;
  return Math.min(hits / names.length, 1.0);
}

// ─── Palace rooms (for LLM-mode) ─────────────────────────────────────────────

const PALACE_ROOMS = [
  'identity_sexuality',
  'career_education',
  'relationships_romance',
  'family_children',
  'health_wellness',
  'hobbies_creativity',
  'social_community',
  'home_living',
  'travel_places',
  'food_cooking',
  'money_finance',
  'emotions_mood',
  'media_entertainment',
  'general',
];

const _PALACE_ROOM_LIST = PALACE_ROOMS.map((r) => `  - ${r}`).join('\n');

// ─── LLM helpers (palace mode) ───────────────────────────────────────────────

async function _llmCall(prompt, apiKey, model = 'claude-haiku-4-5-20251001', maxTokens = 32) {
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: payload,
      signal: AbortSignal.timeout(20_000),
    });
    const result = await resp.json();
    return (result.content?.[0]?.text || '').trim();
  } catch {
    return '';
  }
}

async function _assignRoom(sessionText, apiKey, model = 'claude-haiku-4-5-20251001') {
  const snippet = sessionText.slice(0, 600).replace(/\n/g, ' ');
  const prompt =
    `Read this conversation and assign it to exactly one room from the list below.\n` +
    `Reply with ONLY the room name, nothing else.\n\n` +
    `Rooms:\n${_PALACE_ROOM_LIST}\n\n` +
    `Conversation:\n${snippet}`;

  const raw = await _llmCall(prompt, apiKey, model, 20);
  const rawLower = raw.toLowerCase().trim();

  for (const room of PALACE_ROOMS) {
    if (rawLower.includes(room) || room.includes(rawLower)) return room;
  }
  const firstWord = rawLower.split(/[_\s]/)[0] || '';
  for (const room of PALACE_ROOMS) {
    if (firstWord && room.includes(firstWord)) return room;
  }
  return 'general';
}

async function palaceAssignRooms(sessions, sampleId, apiKey, cache, model = 'claude-haiku-4-5-20251001') {
  const assignments = {};
  for (const sess of sessions) {
    const sessKey = `${sampleId}_session_${sess.sessionNum}`;
    if (sessKey in cache) {
      assignments[`session_${sess.sessionNum}`] = cache[sessKey];
      continue;
    }

    const texts = sess.dialogs.map((d) => `${d.speaker || '?'}: ${d.text || ''}`);
    const sessionText = texts.join('\n');
    const llmInput = sess.summary || sessionText;

    const room = await _assignRoom(llmInput, apiKey, model);
    assignments[`session_${sess.sessionNum}`] = room;
    cache[sessKey] = room;
  }
  return assignments;
}

// ─── LLM re-rank ─────────────────────────────────────────────────────────────

async function llmRerankLocomo(question, retrievedIds, retrievedDocs, apiKey, topK = 10, model = 'claude-sonnet-4-6') {
  const candidates = retrievedIds.slice(0, topK);
  const candidateDocs = retrievedDocs.slice(0, topK);

  if (candidates.length <= 1) return retrievedIds;

  const lines = candidates.map((cid, i) => {
    const snippet = candidateDocs[i].slice(0, 300).replace(/\n/g, ' ');
    return `${i + 1}. [${cid}] ${snippet}`;
  });

  const prompt =
    `Question: ${question}\n\n` +
    `Which of the following passages most directly answers this question? ` +
    `Reply with just the number (1-${candidates.length}).\n\n` +
    lines.join('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await _llmCall(prompt, apiKey, model, 8);
      const m = raw.match(/\b(\d+)\b/);
      if (m) {
        const pick = parseInt(m[1], 10);
        if (pick >= 1 && pick <= candidates.length) {
          const chosenId = candidates[pick - 1];
          return [chosenId, ...retrievedIds.filter((cid) => cid !== chosenId)];
        }
      }
      break;
    } catch (err) {
      if (err.name === 'TimeoutError' && attempt < 2) {
        await new Promise((r) => setTimeout(r, 3000));
      } else {
        break;
      }
    }
  }
  return retrievedIds;
}

// ─── API key helper ──────────────────────────────────────────────────────────

function _loadApiKey(keyArg) {
  if (keyArg) return keyArg;
  return process.env.ANTHROPIC_API_KEY || '';
}

// ─── Retrieval helpers ────────────────────────────────────────────────────────

function computeRetrievalRecall(retrievedIds, evidenceIds) {
  if (!evidenceIds.size) return 1.0;
  let found = 0;
  for (const eid of evidenceIds) {
    if (retrievedIds.includes(eid)) found++;
  }
  return found / evidenceIds.size;
}

function evidenceToDialogIds(evidence) {
  return new Set(evidence);
}

function evidenceToSessionIds(evidence) {
  const sessions = new Set();
  for (const eid of evidence) {
    const m = eid.match(/^D(\d+):/);
    if (m) sessions.add(`session_${m[1]}`);
  }
  return sessions;
}

// ─── Hybrid rerank helper ─────────────────────────────────────────────────────

function hybridRerank(rawIds, rawDistances, rawDocs, predicateKws, quoted, names, topK) {
  const scored = [];
  for (let i = 0; i < rawIds.length; i++) {
    const cid = rawIds[i];
    const dist = rawDistances[i];
    const doc = rawDocs[i];

    const predOverlap = _kwOverlap(predicateKws, doc);
    let fused = dist * (1.0 - 0.50 * predOverlap);

    const qBoost = _quotedBoost(quoted, doc);
    if (qBoost > 0) fused *= 1.0 - 0.60 * qBoost;

    const nBoost = _nameBoost(names, doc);
    if (nBoost > 0) fused *= 1.0 - 0.20 * nBoost;

    scored.push({ cid, dist, doc, fused });
  }
  scored.sort((a, b) => a.fused - b.fused);
  return scored.slice(0, topK);
}

// ─── System mode: shared embedder ────────────────────────────────────────────

const _embedder = new Embedder();

async function freshVectorStore(name) {
  const store = new VectorStore({ collectionName: name });
  await store.deleteCollection();
  await store.init();
  return store;
}

// ─── System mode: ingest + search for one conversation ───────────────────────

async function systemIngestAndSearch(sessions, questions, granularity, topK, multiPalace) {
  const { corpus, corpusIds } = buildCorpusFromSessions(sessions, granularity);

  if (corpus.length === 0) {
    return questions.map(() => ({ retrievedIds: [], roomFilterUsed: false, palaceName: 'none' }));
  }

  // Set up palaces
  let palaces, stores;
  if (multiPalace) {
    const personalVec = await _embedder.embed(
      'personal life family health emotions relationships hobbies feelings diary weekend home'
    );
    const generalVec = await _embedder.embed(
      'work technical decisions projects knowledge research facts architecture code'
    );
    palaces = [
      { name: 'sys_personal', scope_vector: personalVec, is_default: false },
      { name: 'sys_general',  scope_vector: generalVec,  is_default: true  },
    ];
    stores = {
      sys_personal: await freshVectorStore(`sys_personal_${Date.now()}`),
      sys_general:  await freshVectorStore(`sys_general_${Date.now()}`),
    };
  } else {
    palaces = [{ name: 'sys_single', scope_vector: null, is_default: true }];
    stores = { sys_single: await freshVectorStore(`sys_single_${Date.now()}`) };
  }

  // Ingest: embed once per item, reuse vector for palace + hall + Qdrant
  const hallVectors = await getHallVectors();
  const docTextToCorpusId = new Map();
  for (let i = 0; i < corpus.length; i++) {
    const vec = await _embedder.embed(corpus[i]);
    const { name: palaceName } = selectPalace(vec, palaces);
    const hall = selectHall(vec, hallVectors);
    const room = slugifyRoom(corpus[i] + '\n' + corpusIds[i]);
    const importance = scoreImportance(corpus[i], corpusIds[i]);
    const hash = createHash('md5')
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
    if (!docTextToCorpusId.has(corpus[i])) {
      docTextToCorpusId.set(corpus[i], corpusIds[i]);
    }
  }

  // Search each question: embed once, reuse for palace selection + Qdrant query
  const results = [];
  for (const question of questions) {
    const qVec = await _embedder.embed(question);
    const { name: qPalace } = selectPalace(qVec, palaces);
    const estimatedRoom = slugifyRoom(question);
    const nRes = Math.min(topK * 2, corpus.length);

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

    const retrievedIds = (rawResults.documents[0] || [])
      .map((doc) => docTextToCorpusId.get(doc))
      .filter(Boolean)
      .slice(0, topK);

    results.push({
      retrievedIds,
      roomFilterUsed,
      palaceName: qPalace,
    });
  }

  // Cleanup
  for (const store of Object.values(stores)) {
    try { await store.deleteCollection(); } catch { /* ignore */ }
  }

  return results;
}

// ─── Main benchmark loop ─────────────────────────────────────────────────────

async function runBenchmark({
  dataFile,
  topK = 10,
  mode = 'raw',
  limit = 0,
  granularity = 'dialog',
  outFile = null,
  llmRerankEnabled = false,
  llmKey = '',
  llmModel = 'claude-sonnet-4-6',
  hybridWeight = 0.30,
  palaceCacheFile = null,
  palaceModel = 'claude-haiku-4-5-20251001',
  multiPalace = false,
}) {
  let data = JSON.parse(readFileSync(dataFile, 'utf-8'));

  if (limit > 0) data = data.slice(0, limit);

  let apiKey = '';
  if (llmRerankEnabled || mode === 'palace') {
    apiKey = _loadApiKey(llmKey);
    if (!apiKey) {
      console.error(`ERROR: --mode ${mode} requires an API key (--llm-key or ANTHROPIC_API_KEY).`);
      process.exit(1);
    }
  }

  // Palace mode: room assignment cache
  let palaceCache = {};
  let palaceCachePath = null;
  if (mode === 'palace') {
    palaceCachePath = palaceCacheFile || join(__dirname, 'palace_cache_locomo.json');
    if (existsSync(palaceCachePath)) {
      palaceCache = JSON.parse(readFileSync(palaceCachePath, 'utf-8'));
      console.log(`  Palace cache: ${Object.keys(palaceCache).length} room assignments loaded`);
    }
  }

  const rerankLabel = llmRerankEnabled ? ` + LLM re-rank (${llmModel.split('-')[1]})` : '';

  console.log(`\n${'='.repeat(60)}`);
  console.log('  MemPalace × LoCoMo Benchmark');
  console.log(`${'='.repeat(60)}`);
  console.log(`  Data:          ${basename(dataFile)}`);
  console.log(`  Conversations: ${data.length}`);
  console.log(`  Top-k:         ${topK}`);
  console.log(`  Mode:          ${mode}${mode === 'system' && multiPalace ? ' (multi-palace)' : ''}${rerankLabel}`);
  console.log(`  Granularity:   ${granularity}`);
  console.log(`${'─'.repeat(60)}\n`);

  const allRecall = [];
  const perCategory = {};
  const resultsLog = [];
  let totalQa = 0;

  // System mode pipeline stats
  const sysStats = {
    roomFilterHits: 0,
    roomFilterMisses: 0,
    totalItems: 0,
  };

  const startTime = Date.now();

  for (let convIdx = 0; convIdx < data.length; convIdx++) {
    const sample = data[convIdx];
    const sampleId = sample.sample_id || `conv-${convIdx}`;
    const conversation = sample.conversation;
    const qaPairs = sample.qa;

    const sessionSummaries = sample.session_summary || {};
    const sessions = loadConversationSessions(conversation, sessionSummaries);
    const { corpus, corpusIds, corpusTimestamps } = buildCorpusFromSessions(sessions, granularity);

    if (mode === 'system') {
      // ── System mode: batch ingest then search all questions ──────────
      console.log(
        `  [${convIdx + 1}/${data.length}] ${sampleId}: ` +
        `${sessions.length} sessions, ${corpus.length} docs, ${qaPairs.length} questions`
      );

      const questions = qaPairs.map((qa) => qa.question);
      const systemResults = await systemIngestAndSearch(
        sessions, questions, granularity, topK, multiPalace
      );
      sysStats.totalItems += corpus.length;

      for (let qi = 0; qi < qaPairs.length; qi++) {
        const qa = qaPairs[qi];
        const { retrievedIds, roomFilterUsed } = systemResults[qi];

        if (roomFilterUsed) sysStats.roomFilterHits++;
        else sysStats.roomFilterMisses++;

        const evidenceSet = granularity === 'dialog'
          ? evidenceToDialogIds(qa.evidence || [])
          : evidenceToSessionIds(qa.evidence || []);

        const recall = computeRetrievalRecall(retrievedIds, evidenceSet);
        allRecall.push(recall);
        const cat = qa.category;
        if (!perCategory[cat]) perCategory[cat] = [];
        perCategory[cat].push(recall);
        totalQa++;

        resultsLog.push({
          sample_id: sampleId,
          question: qa.question,
          answer: qa.answer || qa.adversarial_answer || '',
          category: cat,
          evidence: qa.evidence || [],
          retrieved_ids: retrievedIds,
          recall,
        });
      }
      continue;
    }

    // ── Non-system modes ──────────────────────────────────────────────
    let roomAssignments = {};
    if (mode === 'palace') {
      roomAssignments = await palaceAssignRooms(sessions, sampleId, apiKey, palaceCache, palaceModel);
      if (palaceCachePath) {
        writeFileSync(palaceCachePath, JSON.stringify(palaceCache, null, 2));
      }
      const roomsSummary = {};
      for (const [, room] of Object.entries(roomAssignments)) {
        roomsSummary[room] = (roomsSummary[room] || 0) + 1;
      }
      console.log(
        `  [${convIdx + 1}/${data.length}] ${sampleId}: ` +
        `${sessions.length} sessions → ${Object.keys(roomsSummary).length} rooms, ${qaPairs.length} questions`
      );
      const sorted = Object.entries(roomsSummary).sort((a, b) => b[1] - a[1]);
      console.log(`    Rooms: ${JSON.stringify(Object.fromEntries(sorted))}`);
    } else {
      console.log(
        `  [${convIdx + 1}/${data.length}] ${sampleId}: ` +
        `${sessions.length} sessions, ${corpus.length} docs, ${qaPairs.length} questions`
      );
    }

    const collectionName = `locomo_bench_${sampleId}_${Date.now()}`;
    const store = new VectorStore({ collectionName });

    try {
      await store.init();

      const metadatas = corpusIds.map((cid, i) => ({
        corpus_id: cid,
        timestamp: corpusTimestamps[i],
        room: roomAssignments[cid] || 'general',
      }));

      await store.add({
        ids: corpusIds.map((_, i) => `doc_${i}`),
        documents: corpus,
        metadatas,
      });

      for (const qa of qaPairs) {
        const question = qa.question;
        const answer = qa.answer || qa.adversarial_answer || '';
        const category = qa.category;
        const evidence = qa.evidence || [];

        const useHybrid = ['hybrid', 'rooms', 'palace'].includes(mode);
        const names = useHybrid ? _personNames(question) : [];
        const nameWords = new Set(names.map((n) => n.toLowerCase()));
        const allKws = useHybrid ? _kw(question) : [];
        const predicateKws = allKws.filter((w) => !nameWords.has(w));
        const quoted = useHybrid ? _quotedPhrases(question) : [];

        let retrievedIds;
        let retrievedDocs;

        if (mode === 'palace') {
          const roomSummaries = {};
          for (const sess of sessions) {
            const sessId = `session_${sess.sessionNum}`;
            const room = roomAssignments[sessId] || 'general';
            if (!roomSummaries[room]) roomSummaries[room] = [];
            if (sess.summary) roomSummaries[room].push(sess.summary);
          }

          const roomKwScores = [];
          for (const [room, summaries] of Object.entries(roomSummaries)) {
            const aggText = summaries.join(' ');
            const overlap = predicateKws.length ? _kwOverlap(predicateKws, aggText) : 0.0;
            roomKwScores.push({ overlap, room });
          }
          roomKwScores.sort((a, b) => b.overlap - a.overlap);

          let nRoomsToSearch = 3;
          if (roomKwScores.length && roomKwScores[0].overlap === 0.0) {
            nRoomsToSearch = roomKwScores.length;
          }
          const targetRooms = roomKwScores.slice(0, nRoomsToSearch).map((r) => r.room);

          let whereFilter = null;
          if (targetRooms.length < Object.keys(roomSummaries).length) {
            whereFilter = { room: { $in: targetRooms } };
          }

          const sessionsInRooms = whereFilter
            ? corpusIds.filter((cid) => targetRooms.includes(roomAssignments[cid] || 'general')).length
            : corpus.length;
          const nRetrieve = Math.max(topK, Math.min(sessionsInRooms, corpus.length));

          const resultsP = await store.query({
            queryTexts: [question],
            nResults: nRetrieve,
            where: whereFilter,
          });
          const rawIds = resultsP.metadatas[0].map((m) => m.corpus_id);
          const rawDistances = resultsP.distances[0];
          const rawDocs = resultsP.documents[0];

          const scored = hybridRerank(rawIds, rawDistances, rawDocs, predicateKws, quoted, names, topK);
          retrievedIds = scored.map((s) => s.cid);
          retrievedDocs = scored.map((s) => s.doc);

        } else if (mode === 'rooms') {
          const nRooms = Math.max(topK, Math.floor(sessions.length / 3));
          const roomScores = sessions.map((sess) => {
            const summary = sess.summary || '';
            const overlap = summary && predicateKws.length ? _kwOverlap(predicateKws, summary) : 0.0;
            return { overlap, sessId: `session_${sess.sessionNum}` };
          });
          roomScores.sort((a, b) => b.overlap - a.overlap);
          const topRoomIds = roomScores.slice(0, nRooms).map((r) => r.sessId);

          const nInRooms = Math.min(topK * 2, topRoomIds.length);
          const whereFilter = topRoomIds.length > 1
            ? { corpus_id: { $in: topRoomIds } }
            : null;

          const resultsR = await store.query({
            queryTexts: [question],
            nResults: nInRooms,
            where: whereFilter,
          });
          const rawIds = resultsR.metadatas[0].map((m) => m.corpus_id);
          const rawDistances = resultsR.distances[0];
          const rawDocs = resultsR.documents[0];

          const scored = hybridRerank(rawIds, rawDistances, rawDocs, predicateKws, quoted, names, topK);
          retrievedIds = scored.map((s) => s.cid);
          retrievedDocs = scored.map((s) => s.doc);

        } else {
          const nRetrieve = Math.min(
            mode === 'hybrid' ? topK * 3 : topK,
            corpus.length
          );
          const results = await store.query({
            queryTexts: [question],
            nResults: nRetrieve,
          });
          const rawIds = results.metadatas[0].map((m) => m.corpus_id);
          const rawDistances = results.distances[0];
          const rawDocs = results.documents[0];

          if (mode === 'hybrid') {
            const scored = hybridRerank(rawIds, rawDistances, rawDocs, predicateKws, quoted, names, topK);
            retrievedIds = scored.map((s) => s.cid);
            retrievedDocs = scored.map((s) => s.doc);
          } else {
            retrievedIds = rawIds.slice(0, topK);
            retrievedDocs = rawDocs.slice(0, topK);
          }
        }

        // Optional LLM rerank
        if (llmRerankEnabled && apiKey) {
          const rerankPool = Math.min(10, retrievedIds.length);
          retrievedIds = await llmRerankLocomo(
            question, retrievedIds, retrievedDocs, apiKey, rerankPool, llmModel
          );
        }

        const evidenceSet = granularity === 'dialog'
          ? evidenceToDialogIds(evidence)
          : evidenceToSessionIds(evidence);

        const recall = computeRetrievalRecall(retrievedIds, evidenceSet);
        allRecall.push(recall);
        if (!perCategory[category]) perCategory[category] = [];
        perCategory[category].push(recall);
        totalQa++;

        resultsLog.push({
          sample_id: sampleId,
          question,
          answer,
          category,
          evidence,
          retrieved_ids: retrievedIds,
          recall,
        });
      }
    } finally {
      try {
        await store._client.deleteCollection(collectionName);
      } catch { /* ignore */ }
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  const avgRecall = allRecall.length ? allRecall.reduce((a, b) => a + b, 0) / allRecall.length : 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  RESULTS — MemPalace (${mode}${rerankLabel}, ${granularity}, top-${topK})`);
  console.log(`${'='.repeat(60)}`);
  console.log(`  Time:          ${elapsed.toFixed(1)}s (${(elapsed / Math.max(totalQa, 1)).toFixed(2)}s/question)`);
  console.log(`  Questions:     ${totalQa}`);
  console.log(`  Avg Recall:    ${avgRecall.toFixed(3)}`);

  console.log('\n  PER-CATEGORY RECALL:');
  for (const cat of Object.keys(perCategory).sort()) {
    const vals = perCategory[cat];
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const name = CATEGORIES[cat] || `Cat-${cat}`;
    console.log(`    ${name.padEnd(25)} R=${avg.toFixed(3)}  (n=${vals.length})`);
  }

  const perfect = allRecall.filter((r) => r >= 1.0).length;
  const partial = allRecall.filter((r) => r > 0 && r < 1.0).length;
  const zero = allRecall.filter((r) => r === 0).length;
  console.log('\n  RECALL DISTRIBUTION:');
  console.log(`    Perfect (1.0):  ${String(perfect).padStart(4)} (${(perfect / allRecall.length * 100).toFixed(1)}%)`);
  console.log(`    Partial (0-1):  ${String(partial).padStart(4)} (${(partial / allRecall.length * 100).toFixed(1)}%)`);
  console.log(`    Zero (0.0):     ${String(zero).padStart(4)} (${(zero / allRecall.length * 100).toFixed(1)}%)`);

  if (mode === 'system' && sysStats.totalItems > 0) {
    const filterTotal = sysStats.roomFilterHits + sysStats.roomFilterMisses;
    console.log('\n  SYSTEM PIPELINE STATS:');
    console.log(`    Items ingested:   ${sysStats.totalItems}`);
    console.log(`    Room filter hits: ${sysStats.roomFilterHits}/${filterTotal} (${(sysStats.roomFilterHits / filterTotal * 100).toFixed(1)}%)`);
  }

  console.log(`\n${'='.repeat(60)}\n`);

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(resultsLog, null, 2));
    console.log(`  Results saved: ${outFile}`);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'top-k': { type: 'string', default: '50' },
    mode: { type: 'string', default: 'raw' },
    'palace-cache': { type: 'string' },
    'palace-model': { type: 'string', default: 'claude-haiku-4-5-20251001' },
    granularity: { type: 'string', default: 'session' },
    limit: { type: 'string', default: '0' },
    out: { type: 'string' },
    'llm-rerank': { type: 'boolean', default: false },
    'llm-model': { type: 'string', default: 'claude-sonnet-4-6' },
    'llm-key': { type: 'string', default: '' },
    'hybrid-weight': { type: 'string', default: '0.30' },
    'multi-palace': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !positionals.length) {
  console.log(`Usage: node benchmarks/locomoBench.js <data_file> [options]

Options:
  --top-k <n>          Top-k retrieval (default: 50)
  --mode <mode>        raw | hybrid | rooms | palace | system (default: raw)
  --granularity <g>    dialog | session (default: session)
  --limit <n>          Limit to first N conversations
  --out <file>         Output JSON file path
  --llm-rerank         Enable LLM re-ranking
  --llm-model <model>  LLM re-rank model (default: claude-sonnet-4-6)
  --llm-key <key>      API key (or set ANTHROPIC_API_KEY)
  --palace-cache <f>   Palace room assignment cache file
  --palace-model <m>   Palace room assignment model
  --hybrid-weight <w>  Hybrid keyword weight (default: 0.30)
  --multi-palace       (system mode) split into personal/general palaces
  -h, --help           Show this help`);
  process.exit(0);
}

const dataFile = positionals[0];
const topK = parseInt(values['top-k'], 10);
const granularity = values.granularity;
const mode = values.mode;
const limitVal = parseInt(values.limit, 10);

const validModes = ['raw', 'hybrid', 'rooms', 'palace', 'system'];
if (!validModes.includes(mode)) {
  console.error(`ERROR: invalid mode '${mode}'. Valid: ${validModes.join(', ')}`);
  process.exit(1);
}

let outFile = values.out;
if (!outFile) {
  const rerankTag = values['llm-rerank'] ? '_llmrerank' : '';
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  outFile = `benchmarks/results_locomo_${mode}${rerankTag}_${granularity}_top${topK}_${ts}.json`;
}

runBenchmark({
  dataFile,
  topK,
  mode,
  limit: limitVal,
  granularity,
  outFile,
  llmRerankEnabled: values['llm-rerank'],
  llmKey: values['llm-key'],
  llmModel: values['llm-model'],
  hybridWeight: parseFloat(values['hybrid-weight']),
  palaceCacheFile: values['palace-cache'],
  palaceModel: values['palace-model'],
  multiPalace: values['multi-palace'],
}).catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
