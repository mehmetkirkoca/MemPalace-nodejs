/**
 * mcpServer.js — MemPalace MCP Server
 * ====================================
 *
 * 19 MCP tools for palace access.
 *
 * Tools (read):
 *   mempalace_status          — total drawers, wing/room breakdown
 *   mempalace_list_wings      — all wings with drawer counts
 *   mempalace_list_rooms      — rooms within a wing
 *   mempalace_get_taxonomy    — full wing → room → count tree
 *   mempalace_search          — semantic search, optional wing/room filter
 *   mempalace_check_duplicate — check if content already exists before filing
 *
 * Tools (write):
 *   mempalace_add_drawer      — file verbatim content into a wing/room
 *   mempalace_delete_drawer   — remove a drawer by ID
 *
 * Tools (KG):
 *   mempalace_kg_query        — entity relationships
 *   mempalace_kg_add          — add facts
 *   mempalace_kg_invalidate   — mark ended
 *   mempalace_kg_timeline     — chronological
 *   mempalace_kg_stats        — graph overview
 *
 * Tools (navigation):
 *   mempalace_traverse        — BFS walk
 *   mempalace_find_tunnels    — cross-wing rooms
 *   mempalace_graph_stats     — connectivity
 *
 * Tools (diary):
 *   mempalace_diary_write     — write a diary entry
 *   mempalace_diary_read      — recent entries
 *
 * Tools (guide):
 *   mempalace_guide           — recommend wing/room/hall/importance before filing
 *
 * Tools (memory stack):
 *   mempalace_wake_up         — L0 identity + L1 essential story (call on session start)
 *   mempalace_recall          — L2 on-demand retrieval by wing/room (no embedding)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';

import { VectorStore } from './vectorStore.js';
import { searchMemories } from './searcher.js';
import { KnowledgeGraph } from './knowledgeGraph.js';
import { traverse, findTunnels, graphStats } from './palaceGraph.js';
import { VERSION } from './version.js';

// ── Constants ────────────────────────────────────────────────────────────────

const PALACE_PROTOCOL = `IMPORTANT — MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_wake_up(context="<first user message or topic>") to auto-load the right agent identity (L0) and top memories (L1). Do this first, every session.
2. WHEN A TOPIC ARISES: Call mempalace_recall(wing, room) to load that room's contents (L2) — fast, no embedding.
3. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
4. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
5. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
6. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

Memory layers: L0 (identity) + L1 (top facts, always loaded) → L2 (room on-demand) → L3 (mempalace_search, semantic).
This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory.`;

// ── Guide Patterns (Strategy 1 — content-type classifier) ────────────────────

const GUIDE_PATTERNS = {
  decision: [
    /\blet'?s (use|go with|try|pick|choose|switch to)\b/i,
    /\bwe (decided|chose|went with|picked|settled on)\b/i,
    /\bwe should\b/i,
    /\bi'?m going (to|with)\b/i,
    /\btrade-?off\b/i,
    /\binstead of\b/i,
    /\brather than\b/i,
    /\bpros and cons\b/i,
    /\barchitecture\b/i,
    /\bapproach\b/i,
    /\bchose\b/i,
  ],
  preference: [
    /\bi prefer\b/i,
    /\balways use\b/i,
    /\bnever use\b/i,
    /\bdon'?t (ever )?(use|do|mock|stub)\b/i,
    /\bplease (always|never|don'?t)\b/i,
    /\bmy (rule|preference|style|convention) is\b/i,
    /\bwe (always|never)\b/i,
  ],
  milestone: [
    /\bit works\b/i,
    /\bit worked\b/i,
    /\bgot it working\b/i,
    /\bfixed\b/i,
    /\bsolved\b/i,
    /\bbreakthrough\b/i,
    /\bfigured (it )?out\b/i,
    /\bfinally\b/i,
    /\bshipped\b/i,
    /\bdeployed\b/i,
    /\breleased\b/i,
    /\bfirst time\b/i,
    /\bturns out\b/i,
  ],
  problem: [
    /\b(bug|error|crash|fail|broke|broken|issue|problem)\b/i,
    /\bdoesn'?t work\b/i,
    /\bnot working\b/i,
    /\broot cause\b/i,
    /\bthe (problem|issue|bug) (is|was)\b/i,
    /\bthe fix (is|was)\b/i,
    /\bworkaround\b/i,
    /\bresolved\b/i,
  ],
  emotion: [
    /\bi feel\b/i,
    /\bscared\b/i,
    /\bafraid\b/i,
    /\bproud\b/i,
    /\bhappy\b/i,
    /\bsad\b/i,
    /\bgrateful\b/i,
    /\bworried\b/i,
    /\blonely\b/i,
    /\bi love\b/i,
    /\bi miss\b/i,
    /\bi need\b/i,
    /\bi wish\b/i,
    /\*[^*]+\*/,
  ],
  advice: [
    /\byou should\b/i,
    /\bi recommend\b/i,
    /\bbest practice\b/i,
    /\balways\b.*\bwhen\b/i,
    /\bnever\b.*\bwhen\b/i,
    /\btip:/i,
    /\bprotip\b/i,
    /\blesson learned\b/i,
    /\bkey insight\b/i,
  ],
};

const WING_KEYWORDS = {
  wing_code: [
    /\b(code|function|class|api|endpoint|module|refactor|typescript|javascript|python|node|npm|import|export|async|await|promise|git|pull request|pr|merge|branch|deploy|ci|cd|docker|container|kubernetes|k8s|nginx|sql|query|database|schema|migration|test|spec|vitest|jest|lint)\b/i,
  ],
  wing_hardware: [
    /\b(gpu|cpu|ram|disk|ssd|nvme|pcie|server|machine|motherboard|bios|firmware|driver|hardware|monitor|display|cable|port|usb|ethernet|network|router|switch)\b/i,
  ],
  wing_ai_research: [
    /\b(llm|gpt|claude|gemini|embeddings?|vector|rag|fine-?tun|model|training|inference|prompt|context window|tokens?|attention|transformer|hugging ?face|ollama|lmstudio|benchmark|eval|agent|reinforcement)\b/i,
  ],
  wing_team: [
    /\b(team|colleague|coworker|manager|standup|sprint|meeting|review|feedback|hire|onboard|ticket|jira|slack|confluence|retro|roadmap)\b/i,
  ],
  wing_user: [
    /\b(personal|family|health|weekend|vacation|life|relationship|friend|mood|diary|journal)\b/i,
    /\*[^*]+\*/,
  ],
  wing_agent: [
    /\b(agent|memory palace|mempalace|drawer|wing|room|hall|palace protocol|knowledge graph)\b/i,
  ],
};

const IMPORTANCE_SIGNALS = {
  high: [
    /\bcritical\b/i, /\bmust\b/i, /\bimportant\b/i, /\bnever forget\b/i,
    /\balways remember\b/i, /\bbreaking\b/i, /\bsecurity\b/i,
    /\bproduction\b/i, /\blive\b/i, /\bdeadline\b/i,
  ],
  medium_high: [
    /\bshipped\b/i, /\bdeployed\b/i, /\breleased\b/i, /\bbreakthrough\b/i,
    /\bfixed\b/i, /\bsolved\b/i, /\bfinally\b/i,
  ],
  medium_low: [
    /\btried\b/i, /\battempted\b/i, /\bworking on\b/i,
    /\bexploring\b/i, /\bconsidering\b/i,
  ],
  low: [
    /\bfyi\b/i, /\bjust a note\b/i, /\bminor\b/i, /\btrivial\b/i,
  ],
};

// ── Lazy singletons ──────────────────────────────────────────────────────────

const PALACE_BASE     = path.join(os.homedir(), '.mempalace');
const DEFAULT_PALACE  = 'personality_memory_palace';
const DEFAULT_KG_PATH = path.join(PALACE_BASE, 'knowledge_graph.sqlite3');

// Active palace state — set by toolWakeUp when an identity is selected
let _activePalace = DEFAULT_PALACE;
let _activeKgPath = DEFAULT_KG_PATH;

// Per-palace caches
const _stores = {};
const _kgs = {};

async function getStore() {
  if (!_stores[_activePalace]) {
    _stores[_activePalace] = new VectorStore({
      qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
      collectionName: _activePalace,
    });
    await _stores[_activePalace].init();
  }
  return _stores[_activePalace];
}

function getKg() {
  if (!_kgs[_activeKgPath]) {
    _kgs[_activeKgPath] = new KnowledgeGraph(_activeKgPath);
  }
  return _kgs[_activeKgPath];
}

// ── Helper ───────────────────────────────────────────────────────────────────

function noPalace() {
  return {
    error: 'No palace found',
    hint: 'Run: mempalace init <dir> && mempalace mine <dir>',
  };
}

// ── Guide Helpers ─────────────────────────────────────────────────────────────

function _guideScorePatterns(text, patterns) {
  let count = 0;
  const matched = [];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) { count++; matched.push(m[0].trim()); }
  }
  return { count, matched };
}

function _guideStrategy1(content, context) {
  const combined = `${content}\n${context || ''}`;
  const scores = {};
  const evidence = {};
  for (const [type, patterns] of Object.entries(GUIDE_PATTERNS)) {
    const { count, matched } = _guideScorePatterns(combined, patterns);
    scores[type] = count;
    evidence[type] = matched.slice(0, 3);
  }
  // Resolved problem → milestone
  const hasFix = /\b(fixed|solved|resolved|got it working|figured out|the fix)\b/i.test(combined);
  if (scores.problem > 0 && hasFix && scores.milestone === 0) {
    scores.milestone = scores.problem;
    scores.problem = 0;
  }
  const winner = Object.entries(scores).reduce(
    (best, [k, v]) => v > best[1] ? [k, v] : best,
    ['decision', 0]
  )[0];
  const HALL_MAP = {
    decision: 'hall_facts',
    preference: 'hall_preferences',
    milestone: 'hall_events',
    problem: 'hall_discoveries',
    emotion: 'hall_facts',
    advice: 'hall_advice',
  };
  const hall = HALL_MAP[winner] || 'hall_facts';
  const evidenceWords = (evidence[winner] || []).join(', ') || 'no strong signal';
  return { hall, type: winner, scores, reasoning: `${winner} — detected: ${evidenceWords}` };
}

function _guideSelectWing(content, context, hintWing, strategy1Type) {
  const VALID_WINGS = [
    'wing_user', 'wing_code', 'wing_team', 'wing_myproject',
    'wing_hardware', 'wing_ai_research', 'wing_agent',
  ];
  if (hintWing) {
    const normalised = hintWing.startsWith('wing_') ? hintWing : `wing_${hintWing}`;
    if (VALID_WINGS.includes(normalised)) return normalised;
  }
  if (strategy1Type === 'emotion') return 'wing_user';
  const combined = `${content}\n${context || ''}`;
  const wingScores = {};
  for (const [wing, patterns] of Object.entries(WING_KEYWORDS)) {
    const { count } = _guideScorePatterns(combined, patterns);
    if (count > 0) wingScores[wing] = count;
  }
  if (Object.keys(wingScores).length > 0) {
    return Object.entries(wingScores).reduce(
      (best, [k, v]) => v > best[1] ? [k, v] : best,
      ['wing_myproject', 0]
    )[0];
  }
  return 'wing_myproject';
}

const _SLUG_STOP = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','it','its',
  'i','we','you','he','she','they','me','him','her','us','them','my',
  'this','that','these','those','and','but','or','not','in','on','at',
  'to','of','for','with','as','by','from','into','about','so','if',
  'just','also','then','when','what','which','how','why','get','got',
  'use','used','using','make','made','can','now','let','very','really',
]);

function _guideSlugify(text, maxWords = 4) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !_SLUG_STOP.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const ranked = new Set(
    Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, maxWords).map(([w]) => w)
  );
  const ordered = [];
  for (const w of words) {
    if (ranked.has(w) && !ordered.includes(w)) {
      ordered.push(w);
      if (ordered.length === maxWords) break;
    }
  }
  return ordered.join('-') || 'general';
}

function _guideImportance(content, context) {
  const combined = `${content}\n${context || ''}`;
  let score = 2.0;
  for (const [tier, patterns] of Object.entries(IMPORTANCE_SIGNALS)) {
    const { count } = _guideScorePatterns(combined, patterns);
    if (tier === 'high')        score += Math.min(count * 1.0, 2.0);
    if (tier === 'medium_high') score += Math.min(count * 0.5, 1.0);
    if (tier === 'medium_low')  score -= Math.min(count * 0.25, 0.5);
    if (tier === 'low')         score -= Math.min(count * 0.5, 1.0);
  }
  if (combined.length > 800) score += 0.5;
  if (combined.length < 80)  score -= 0.5;
  return Math.min(5, Math.max(1, Math.round(score)));
}

function _readYamlRooms(yamlPath) {
  try {
    if (!fs.existsSync(yamlPath)) return null;
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    const parsed = yaml.load(raw);
    if (!parsed || !parsed.rooms) return null;
    return parsed.rooms.map(r => ({ name: r.name || '', keywords: r.keywords || [r.name] }));
  } catch {
    return null;
  }
}

function _guidePreviewHint(wing, room, content, importance) {
  const wingTag = wing.replace('wing_', '').toUpperCase().slice(0, 5);
  const snippet = content.trim().replace(/\s+/g, ' ').slice(0, 55);
  const stars = '★'.repeat(importance);
  return `${wingTag}: ${room} → ${snippet}${snippet.length === 55 ? '…' : ''} ${stars}`;
}

// ── Read Tool Handlers ──────────────────────────────────────────────────────

async function toolStatus() {
  const store = await getStore();
  let count;
  try {
    count = await store.count();
  } catch {
    return noPalace();
  }

  const wings = {};
  const rooms = {};
  try {
    const all = await store.get({ limit: 10000 });
    for (const m of all.metadatas) {
      const w = m.wing || 'unknown';
      const r = m.room || 'unknown';
      wings[w] = (wings[w] || 0) + 1;
      rooms[r] = (rooms[r] || 0) + 1;
    }
  } catch {
    // ignore
  }

  return {
    total_drawers: count,
    wings,
    rooms,
    protocol: PALACE_PROTOCOL,
  };
}

async function toolListWings() {
  const store = await getStore();
  let allMeta;
  try {
    allMeta = await store.get({ limit: 10000 });
  } catch {
    return noPalace();
  }

  const wings = {};
  for (const m of allMeta.metadatas) {
    const w = m.wing || 'unknown';
    wings[w] = (wings[w] || 0) + 1;
  }
  return { wings };
}

async function toolListRooms({ wing } = {}) {
  const store = await getStore();
  const opts = { limit: 10000 };
  if (wing) {
    opts.where = { wing };
  }

  let allMeta;
  try {
    allMeta = await store.get(opts);
  } catch {
    return noPalace();
  }

  const rooms = {};
  for (const m of allMeta.metadatas) {
    const r = m.room || 'unknown';
    rooms[r] = (rooms[r] || 0) + 1;
  }
  return { wing: wing || 'all', rooms };
}

async function toolGetTaxonomy() {
  const store = await getStore();
  let allMeta;
  try {
    allMeta = await store.get({ limit: 10000 });
  } catch {
    return noPalace();
  }

  const taxonomy = {};
  for (const m of allMeta.metadatas) {
    const w = m.wing || 'unknown';
    const r = m.room || 'unknown';
    if (!taxonomy[w]) taxonomy[w] = {};
    taxonomy[w][r] = (taxonomy[w][r] || 0) + 1;
  }
  return { taxonomy };
}

async function toolSearch({ query, limit = 5, wing, room }) {
  const store = await getStore();
  return searchMemories(query, store, { wing, room, nResults: limit });
}

async function toolCheckDuplicate({ content, threshold = 0.9 }) {
  const store = await getStore();
  try {
    const results = await store.query({
      queryTexts: [content],
      nResults: 5,
    });

    const duplicates = [];
    if (results.ids && results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const dist = results.distances[0][i];
        // Qdrant cosine score is similarity directly (not distance)
        const similarity = Math.round(dist * 1000) / 1000;
        if (similarity >= threshold) {
          const meta = results.metadatas[0][i];
          const doc = results.documents[0][i];
          duplicates.push({
            id: results.ids[0][i],
            wing: meta.wing || '?',
            room: meta.room || '?',
            similarity,
            content: doc.length > 200 ? doc.slice(0, 200) + '...' : doc,
          });
        }
      }
    }

    return {
      is_duplicate: duplicates.length > 0,
      matches: duplicates,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Write Tool Handlers ─────────────────────────────────────────────────────

async function toolAddDrawer({ wing, room, content, hall, importance = 3, source_file, added_by = 'mcp' }) {
  const store = await getStore();

  // Duplicate check
  const dup = await toolCheckDuplicate({ content, threshold: 0.9 });
  if (dup.is_duplicate) {
    return {
      success: false,
      reason: 'duplicate',
      matches: dup.matches,
    };
  }

  const hash = crypto
    .createHash('md5')
    .update(content.slice(0, 100) + new Date().toISOString())
    .digest('hex')
    .slice(0, 16);
  const drawerId = `drawer_${wing}_${room}_${hash}`;

  try {
    await store.add({
      ids: [drawerId],
      documents: [content],
      metadatas: [
        {
          wing,
          room,
          hall: hall || 'hall_facts',
          importance,
          source_file: source_file || '',
          chunk_index: 0,
          added_by,
          filed_at: new Date().toISOString(),
        },
      ],
    });
    return { success: true, drawer_id: drawerId, wing, room };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function toolDeleteDrawer({ drawer_id }) {
  const store = await getStore();
  try {
    // Try to get existing first
    const existing = await store.get({ where: { original_id: drawer_id }, limit: 1 });
    if (!existing.ids || existing.ids.length === 0) {
      return { success: false, error: `Drawer not found: ${drawer_id}` };
    }
    await store.delete({ ids: [drawer_id] });
    return { success: true, drawer_id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── KG Tool Handlers ────────────────────────────────────────────────────────

function toolKgQuery({ entity, as_of, direction = 'both' }) {
  const kg = getKg();
  const results = kg.queryEntity(entity, { asOf: as_of, direction });
  return { entity, as_of: as_of || null, facts: results, count: results.length };
}

function toolKgAdd({ subject, predicate, object, valid_from, source_closet }) {
  const kg = getKg();
  const tripleId = kg.addTriple(subject, predicate, object, {
    validFrom: valid_from,
    sourceCloset: source_closet,
  });
  return { success: true, triple_id: tripleId, fact: `${subject} → ${predicate} → ${object}` };
}

function toolKgInvalidate({ subject, predicate, object, ended }) {
  const kg = getKg();
  kg.invalidate(subject, predicate, object, ended);
  return {
    success: true,
    fact: `${subject} → ${predicate} → ${object}`,
    ended: ended || 'today',
  };
}

function toolKgTimeline({ entity } = {}) {
  const kg = getKg();
  const results = kg.timeline(entity);
  return { entity: entity || 'all', timeline: results, count: results.length };
}

function toolKgStats() {
  const kg = getKg();
  return kg.stats();
}

// ── Navigation Tool Handlers ────────────────────────────────────────────────

async function toolTraverse({ start_room, max_hops = 2 }) {
  const store = await getStore();
  try {
    return await traverse(start_room, store, max_hops);
  } catch {
    return noPalace();
  }
}

async function toolFindTunnels({ wing_a, wing_b } = {}) {
  const store = await getStore();
  try {
    return await findTunnels(store, wing_a, wing_b);
  } catch {
    return noPalace();
  }
}

async function toolGraphStats() {
  const store = await getStore();
  try {
    return await graphStats(store);
  } catch {
    return noPalace();
  }
}

// ── Diary Tool Handlers ─────────────────────────────────────────────────────

async function toolDiaryWrite({ agent_name = 'agent', entry, topic = 'general' }) {
  const store = await getStore();
  const wing = `wing_${agent_name.toLowerCase().replace(/ /g, '_')}`;
  const room = 'diary';
  const now = new Date();

  const hash = crypto
    .createHash('md5')
    .update(entry.slice(0, 50))
    .digest('hex')
    .slice(0, 8);
  const entryId = `diary_${wing}_${now.toISOString().replace(/[-:T]/g, '').slice(0, 15)}_${hash}`;

  try {
    await store.add({
      ids: [entryId],
      documents: [entry],
      metadatas: [
        {
          wing,
          room,
          hall: 'hall_diary',
          topic,
          type: 'diary_entry',
          agent: agent_name,
          filed_at: now.toISOString(),
          date: now.toISOString().split('T')[0],
        },
      ],
    });
    return {
      success: true,
      entry_id: entryId,
      agent: agent_name,
      topic,
      timestamp: now.toISOString(),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function toolDiaryRead({ agent_name = 'agent', last_n = 10 }) {
  const store = await getStore();
  const wing = `wing_${agent_name.toLowerCase().replace(/ /g, '_')}`;

  try {
    const results = await store.get({
      where: { $and: [{ wing }, { room: 'diary' }] },
      limit: 10000,
    });

    if (!results.ids || results.ids.length === 0) {
      return { agent: agent_name, entries: [], message: 'No diary entries yet.' };
    }

    const entries = [];
    for (let i = 0; i < results.documents.length; i++) {
      const doc = results.documents[i];
      const meta = results.metadatas[i];
      entries.push({
        date: meta.date || '',
        timestamp: meta.filed_at || '',
        topic: meta.topic || '',
        content: doc,
      });
    }

    entries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const sliced = entries.slice(0, last_n);

    return {
      agent: agent_name,
      entries: sliced,
      total: results.ids.length,
      showing: sliced.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Guide Tool Handler ────────────────────────────────────────────────────────

async function toolGuide({ content, context, hint_wing } = {}) {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { error: 'content is required and must be a non-empty string' };
  }

  // Strategy 1: content-type classifier
  const s1 = _guideStrategy1(content, context);

  // Strategy 2: existing taxonomy awareness
  let s2Room = null;
  let s2Wing = null;
  let s2Reasoning = 'taxonomy query failed';

  try {
    const store = await getStore();
    const allMeta = await store.get({ limit: 10000 });
    const taxonomy = {};
    for (const m of allMeta.metadatas) {
      const w = m.wing || 'unknown';
      const r = m.room || 'unknown';
      if (!taxonomy[w]) taxonomy[w] = new Set();
      taxonomy[w].add(r);
    }
    const candidateSlug = _guideSlugify(`${content}\n${context || ''}`);
    let bestMatch = null;
    let bestMatchWing = null;
    for (const [w, rooms] of Object.entries(taxonomy)) {
      for (const r of rooms) {
        if (candidateSlug === r || content.toLowerCase().includes(r.replace(/-/g, ' '))) {
          bestMatch = r;
          bestMatchWing = w;
          break;
        }
      }
      if (bestMatch) break;
    }
    if (!bestMatch) {
      const slugTokens = new Set(candidateSlug.split('-'));
      let highestOverlap = 0;
      for (const [w, rooms] of Object.entries(taxonomy)) {
        for (const r of rooms) {
          const overlap = r.split('-').filter(t => slugTokens.has(t)).length;
          if (overlap > highestOverlap) {
            highestOverlap = overlap;
            bestMatch = r;
            bestMatchWing = w;
          }
        }
      }
      if (highestOverlap === 0) { bestMatch = null; bestMatchWing = null; }
    }
    if (bestMatch) {
      s2Room = bestMatch;
      s2Wing = bestMatchWing;
      s2Reasoning = `room '${bestMatch}' already exists in ${bestMatchWing}`;
    } else {
      s2Room = candidateSlug;
      s2Reasoning = `no matching room found — suggested new slug '${candidateSlug}'`;
    }
  } catch (e) {
    s2Reasoning = `taxonomy query error: ${e.message}`;
    s2Room = _guideSlugify(`${content}\n${context || ''}`);
  }

  // Strategy 3: mempalace.yaml
  const YAML_PATH = path.join(process.cwd(), 'mempalace.yaml');
  const yamlRooms = _readYamlRooms(YAML_PATH);
  let s3Room = null;
  let s3Reasoning = 'mempalace.yaml not found, skipped';

  if (yamlRooms) {
    const combined = `${content}\n${context || ''}`.toLowerCase();
    let bestScore = 0;
    for (const r of yamlRooms) {
      let score = 0;
      for (const kw of r.keywords || [r.name]) {
        if (combined.includes(kw.toLowerCase())) score++;
      }
      if (score > bestScore) { bestScore = score; s3Room = r.name; }
    }
    s3Reasoning = s3Room
      ? `mempalace.yaml matched room '${s3Room}' (score ${bestScore})`
      : 'mempalace.yaml present but no keyword match';
  }

  // Combine strategies
  const finalWing = _guideSelectWing(content, context, hint_wing, s1.type) || s2Wing || 'wing_myproject';
  const finalRoom = s3Room || s2Room || _guideSlugify(`${content}\n${context || ''}`);
  const finalHall = s1.hall;
  const finalImportance = _guideImportance(content, context);

  return {
    recommended: { wing: finalWing, room: finalRoom, hall: finalHall, importance: finalImportance },
    reasoning: {
      strategy1_content_type: s1.reasoning,
      strategy2_taxonomy: s2Reasoning,
      strategy3_yaml: s3Reasoning,
    },
    preview_hint: _guidePreviewHint(finalWing, finalRoom, content, finalImportance),
  };
}

// ── Memory Stack Tool Handlers ────────────────────────────────────────────────

const IDENTITY_PATH  = process.env.PALACE_IDENTITY_PATH || '/root/.mempalace/identity.txt';
const IDENTITY_DIR   = process.env.PALACE_IDENTITY_DIR  || '/root/.mempalace/identities';
const L1_MAX_DRAWERS = 15;
const L1_MAX_CHARS   = 3200;

// ── Identity Helpers ──────────────────────────────────────────────────────────

function _parseIdentityFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const FENCE = /^---\s*$/m;
  const parts = raw.split(FENCE);

  let meta = { name: null, description: null, keywords: [], wing_focus: null, palace: null };
  let body = raw.trim();

  // Expect: ['', frontmatter, body] when file starts with ---
  if (parts.length >= 3 && raw.trimStart().startsWith('---')) {
    try {
      const parsed = yaml.load(parts[1]) || {};
      meta.name        = parsed.name        || null;
      meta.description = parsed.description || null;
      meta.keywords    = Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [];
      meta.wing_focus  = parsed.wing_focus  || null;
      meta.palace      = parsed.palace      || null;
      body = parts.slice(2).join('---').trim();
    } catch {
      // malformed frontmatter — treat whole file as body
    }
  }

  if (!meta.name) {
    meta.name = path.basename(filePath, '.txt');
  }

  return { ...meta, body, file: filePath };
}

function _loadIdentities() {
  // Prefer identities/ directory
  if (fs.existsSync(IDENTITY_DIR)) {
    try {
      const files = fs.readdirSync(IDENTITY_DIR).filter(f => f.endsWith('.txt')).sort();
      return files.map(f => _parseIdentityFile(path.join(IDENTITY_DIR, f)));
    } catch {
      // fall through to single-file fallback
    }
  }
  // Backward compat: single identity.txt
  if (fs.existsSync(IDENTITY_PATH)) {
    return [_parseIdentityFile(IDENTITY_PATH)];
  }
  return [];
}

function _selectIdentity(context, identities) {
  if (!identities || identities.length === 0) return null;
  if (identities.length === 1) {
    return { identity: identities[0], score: 0, matched_keywords: [] };
  }

  const defaultId = identities.find(i => i.name === 'default');

  if (!context || !context.trim()) {
    return { identity: defaultId || identities[0], score: 0, matched_keywords: [] };
  }

  const ctx = context.toLowerCase();
  let best = null;
  let bestScore = -1;
  let bestMatched = [];

  for (const id of identities) {
    const matched = id.keywords.filter(kw => ctx.includes(kw.toLowerCase()));
    const score = matched.length;
    if (score > bestScore || (score === bestScore && id.name === 'default')) {
      best = id;
      bestScore = score;
      bestMatched = matched;
    }
  }

  // If no keyword matched at all, fall back to default
  if (bestScore === 0 && defaultId) {
    return { identity: defaultId, score: 0, matched_keywords: [] };
  }

  return { identity: best, score: bestScore, matched_keywords: bestMatched };
}

async function toolWakeUp({ wing, context } = {}) {
  // L0 — auto-select identity
  let l0 = '';
  let identitySelected = null;

  try {
    const identities = _loadIdentities();
    const result = _selectIdentity(context, identities);

    if (result) {
      const id = result.identity;
      l0 = id.body || `## L0 — IDENTITY\n(${id.name} — no body content)`;

      // Activate the identity's palace
      _activePalace = id.palace || DEFAULT_PALACE;
      _activeKgPath = id.palace
        ? path.join(PALACE_BASE, `kg_${id.palace}.sqlite3`)
        : DEFAULT_KG_PATH;

      identitySelected = {
        name: id.name,
        description: id.description || null,
        wing_focus: id.wing_focus || null,
        palace: _activePalace,
        reason: result.score > 0
          ? `keyword match (${result.matched_keywords.join(', ')})`
          : 'default fallback',
      };
    } else {
      l0 = `## L0 — IDENTITY\nNo identity configured. Create ${IDENTITY_DIR}/default.txt to get started.`;
    }
  } catch (e) {
    l0 = `## L0 — IDENTITY\nCould not load identities: ${e.message}`;
  }

  // Determine L1 wing filter: explicit param > identity's wing_focus > none
  const l1Wing = wing || (identitySelected && identitySelected.wing_focus) || null;

  // L1 — essential story: top drawers by importance
  let l1 = '';
  try {
    const store = await getStore();
    const opts = { limit: 10000 };
    if (l1Wing) opts.where = { wing: l1Wing };
    const all = await store.get(opts);

    if (!all.ids || all.ids.length === 0) {
      l1 = '## L1 — ESSENTIAL STORY\nNo memories yet. Start filing with mempalace_add_drawer.';
    } else {
      // Score by importance field
      const scored = [];
      for (let i = 0; i < all.documents.length; i++) {
        const doc = all.documents[i];
        const meta = all.metadatas[i];
        const imp = parseFloat(meta.importance ?? meta.emotional_weight ?? meta.weight ?? 3);
        scored.push({ imp: isNaN(imp) ? 3 : imp, meta, doc });
      }
      scored.sort((a, b) => b.imp - a.imp);
      const top = scored.slice(0, L1_MAX_DRAWERS);

      // Group by room
      const byRoom = {};
      for (const { imp, meta, doc } of top) {
        const room = meta.room || 'general';
        if (!byRoom[room]) byRoom[room] = [];
        byRoom[room].push({ imp, meta, doc });
      }

      const lines = ['## L1 — ESSENTIAL STORY'];
      let totalLen = 0;
      for (const [room, entries] of Object.entries(byRoom).sort()) {
        const roomLine = `\n[${room}]`;
        lines.push(roomLine);
        totalLen += roomLine.length;
        for (const { meta, doc } of entries) {
          const src = meta.source_file ? ` (${path.basename(meta.source_file)})` : '';
          const snippet = doc.trim().replace(/\s+/g, ' ');
          const truncated = snippet.length > 200 ? snippet.slice(0, 197) + '...' : snippet;
          const line = `  - ${truncated}${src}`;
          if (totalLen + line.length > L1_MAX_CHARS) {
            lines.push('  ... (more available via mempalace_search)');
            break;
          }
          lines.push(line);
          totalLen += line.length;
        }
      }
      l1 = lines.join('\n');
    }
  } catch (e) {
    l1 = `## L1 — ESSENTIAL STORY\nCould not load memories: ${e.message}`;
  }

  return {
    identity_selected: identitySelected,
    l0_identity: l0,
    l1_essential: l1,
    note: 'L2: use mempalace_recall(wing, room) for on-demand room loading. L3: use mempalace_search for semantic queries.',
  };
}

async function toolRecall({ wing, room, limit = 10 } = {}) {
  const store = await getStore();

  let where;
  if (wing && room) where = { $and: [{ wing }, { room }] };
  else if (wing)    where = { wing };
  else if (room)    where = { room };

  try {
    const results = await store.get({ where, limit });
    const docs = results.documents || [];
    const metas = results.metadatas || [];

    if (docs.length === 0) {
      const label = [wing, room].filter(Boolean).join('/') || 'palace';
      return { label, entries: [], message: `No drawers found for ${label}.` };
    }

    const entries = docs.map((doc, i) => {
      const meta = metas[i] || {};
      const snippet = doc.trim().replace(/\s+/g, ' ');
      return {
        room: meta.room || '?',
        wing: meta.wing || '?',
        hall: meta.hall || '?',
        importance: meta.importance ?? 3,
        filed_at: meta.filed_at || '',
        content: snippet.length > 300 ? snippet.slice(0, 297) + '...' : snippet,
      };
    });

    return {
      wing: wing || 'any',
      room: room || 'any',
      entries,
      total: entries.length,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function toolListIdentities() {
  const identities = _loadIdentities();
  if (identities.length === 0) {
    return {
      identities: [],
      hint: `No identities found. Create .txt files in ${IDENTITY_DIR}/ with optional YAML frontmatter (name, description, keywords, wing_focus).`,
    };
  }
  return {
    identities: identities.map(({ name, description, keywords, wing_focus, palace, file }) => ({
      name,
      description: description || null,
      keywords,
      wing_focus: wing_focus || null,
      palace: palace || DEFAULT_PALACE,
      file,
    })),
    total: identities.length,
  };
}

async function toolSetup({ name, about, preferences = [], rules = [], language = 'English' } = {}) {
  if (!name || !name.trim()) {
    return { error: 'name is required' };
  }

  // Force re-init: delete cached store so init() runs fresh (handles DB wipe recovery)
  delete _stores[DEFAULT_PALACE];
  _activePalace = DEFAULT_PALACE;
  _activeKgPath = DEFAULT_KG_PATH;

  const store = await getStore(); // creates collection if missing
  const results = [];

  // Helper: add a drawer to personality_memory_palace
  async function addProfileDrawer(content, hall, room, importance) {
    const hash = crypto.createHash('md5')
      .update(content.slice(0, 80) + room)
      .digest('hex').slice(0, 12);
    const id = `setup_${room}_${hash}`;
    await store.add({
      ids: [id],
      documents: [content],
      metadatas: [{ wing: 'wing_user', room, hall, importance, added_by: 'setup', filed_at: new Date().toISOString() }],
    });
    results.push({ room, hall, importance });
  }

  // 1. User profile (about)
  if (about && about.trim()) {
    await addProfileDrawer(
      `User: ${name}\n${about.trim()}`,
      'hall_facts', 'identity', 5
    );
  } else {
    await addProfileDrawer(`User: ${name}`, 'hall_facts', 'identity', 5);
  }

  // 2. Preferences (how to communicate)
  if (preferences.length > 0) {
    const prefText = `Communication preferences for ${name}:\n${preferences.map(p => `- ${p}`).join('\n')}`;
    await addProfileDrawer(prefText, 'hall_preferences', 'communication-style', 5);
  }

  // 3. Rules (hard constraints)
  if (rules.length > 0) {
    const rulesText = `Rules the AI must always follow for ${name}:\n${rules.map(r => `- ${r}`).join('\n')}`;
    await addProfileDrawer(rulesText, 'hall_advice', 'ai-rules', 5);
  }

  // 4. Create / overwrite default identity file
  const identityBody = [
    `## L0 — IDENTITY`,
    `Name: ${name}`,
    language !== 'English' ? `Language: ${language}` : null,
    about ? `About: ${about.trim()}` : null,
    preferences.length > 0 ? `\nPreferences:\n${preferences.map(p => `- ${p}`).join('\n')}` : null,
    rules.length > 0 ? `\nRules:\n${rules.map(r => `- ${r}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');

  const frontmatter = yaml.dump({
    name: 'default',
    description: `${name}'s personal assistant`,
    keywords: [],
    palace: DEFAULT_PALACE,
  }).trim();

  const identityContent = `---\n${frontmatter}\n---\n${identityBody}`;

  try {
    if (!fs.existsSync(IDENTITY_DIR)) {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(IDENTITY_DIR, 'default.txt'), identityContent, 'utf-8');
  } catch (e) {
    return { error: `Could not write identity file: ${e.message}`, drawers_created: results };
  }

  return {
    success: true,
    palace: DEFAULT_PALACE,
    identity_file: path.join(IDENTITY_DIR, 'default.txt'),
    drawers_created: results,
    message: `Setup complete. ${name}'s personality is stored in '${DEFAULT_PALACE}'. This palace loads automatically when no specific identity matches your conversation.`,
  };
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'mempalace_status',
    description: 'Palace overview — total drawers, wing and room counts',
    inputSchema: { type: 'object', properties: {} },
    handler: toolStatus,
  },
  {
    name: 'mempalace_list_wings',
    description: 'List all wings with drawer counts',
    inputSchema: { type: 'object', properties: {} },
    handler: toolListWings,
  },
  {
    name: 'mempalace_list_rooms',
    description: 'List rooms within a wing (or all rooms if no wing given)',
    inputSchema: {
      type: 'object',
      properties: {
        wing: { type: 'string', description: 'Wing to list rooms for (optional)' },
      },
    },
    handler: toolListRooms,
  },
  {
    name: 'mempalace_get_taxonomy',
    description: 'Full taxonomy: wing → room → drawer count',
    inputSchema: { type: 'object', properties: {} },
    handler: toolGetTaxonomy,
  },
  {
    name: 'mempalace_search',
    description: 'Semantic search. Returns verbatim drawer content with similarity scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'integer', description: 'Max results (default 5)' },
        wing: { type: 'string', description: 'Filter by wing (optional)' },
        room: { type: 'string', description: 'Filter by room (optional)' },
      },
      required: ['query'],
    },
    handler: toolSearch,
  },
  {
    name: 'mempalace_check_duplicate',
    description: 'Check if content already exists in the palace before filing',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to check' },
        threshold: { type: 'number', description: 'Similarity threshold 0-1 (default 0.9)' },
      },
      required: ['content'],
    },
    handler: toolCheckDuplicate,
  },
  {
    name: 'mempalace_add_drawer',
    description: 'File verbatim content into the palace. Checks for duplicates first.',
    inputSchema: {
      type: 'object',
      properties: {
        wing: { type: 'string', description: 'Wing (project name)' },
        room: { type: 'string', description: 'Room (aspect: backend, decisions, meetings...)' },
        content: { type: 'string', description: 'Verbatim content to store — exact words, never summarized' },
        hall: { type: 'string', description: 'Memory type: hall_facts, hall_events, hall_discoveries, hall_preferences, hall_advice (default: hall_facts)' },
        importance: { type: 'integer', description: 'Importance score 1-5 (default: 3). Used by L1 wake-up to surface critical memories.' },
        source_file: { type: 'string', description: 'Where this came from (optional)' },
        added_by: { type: 'string', description: 'Who is filing this (default: mcp)' },
      },
      required: ['wing', 'room', 'content'],
    },
    handler: toolAddDrawer,
  },
  {
    name: 'mempalace_delete_drawer',
    description: 'Delete a drawer by ID. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        drawer_id: { type: 'string', description: 'ID of the drawer to delete' },
      },
      required: ['drawer_id'],
    },
    handler: toolDeleteDrawer,
  },
  {
    name: 'mempalace_kg_query',
    description: "Query the knowledge graph for an entity's relationships. Returns typed facts with temporal validity.",
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: "Entity to query (e.g. 'Max', 'MyProject', 'Alice')" },
        as_of: { type: 'string', description: 'Date filter — only facts valid at this date (YYYY-MM-DD, optional)' },
        direction: { type: 'string', description: 'outgoing, incoming, or both (default: both)' },
      },
      required: ['entity'],
    },
    handler: toolKgQuery,
  },
  {
    name: 'mempalace_kg_add',
    description: 'Add a fact to the knowledge graph. Subject → predicate → object with optional time window.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The entity doing/being something' },
        predicate: { type: 'string', description: "The relationship type (e.g. 'loves', 'works_on')" },
        object: { type: 'string', description: 'The entity being connected to' },
        valid_from: { type: 'string', description: 'When this became true (YYYY-MM-DD, optional)' },
        source_closet: { type: 'string', description: 'Closet ID where this fact appears (optional)' },
      },
      required: ['subject', 'predicate', 'object'],
    },
    handler: toolKgAdd,
  },
  {
    name: 'mempalace_kg_invalidate',
    description: 'Mark a fact as no longer true. E.g. ankle injury resolved, job ended, moved house.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Entity' },
        predicate: { type: 'string', description: 'Relationship' },
        object: { type: 'string', description: 'Connected entity' },
        ended: { type: 'string', description: 'When it stopped being true (YYYY-MM-DD, default: today)' },
      },
      required: ['subject', 'predicate', 'object'],
    },
    handler: toolKgInvalidate,
  },
  {
    name: 'mempalace_kg_timeline',
    description: 'Chronological timeline of facts. Shows the story of an entity (or everything) in order.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity to get timeline for (optional — omit for full timeline)' },
      },
    },
    handler: toolKgTimeline,
  },
  {
    name: 'mempalace_kg_stats',
    description: 'Knowledge graph overview: entities, triples, current vs expired facts, relationship types.',
    inputSchema: { type: 'object', properties: {} },
    handler: toolKgStats,
  },
  {
    name: 'mempalace_traverse',
    description: 'Walk the palace graph from a room. Shows connected ideas across wings — the tunnels.',
    inputSchema: {
      type: 'object',
      properties: {
        start_room: { type: 'string', description: "Room to start from (e.g. 'chromadb-setup')" },
        max_hops: { type: 'integer', description: 'How many connections to follow (default: 2)' },
      },
      required: ['start_room'],
    },
    handler: toolTraverse,
  },
  {
    name: 'mempalace_find_tunnels',
    description: 'Find rooms that bridge two wings — the hallways connecting different domains.',
    inputSchema: {
      type: 'object',
      properties: {
        wing_a: { type: 'string', description: 'First wing (optional)' },
        wing_b: { type: 'string', description: 'Second wing (optional)' },
      },
    },
    handler: toolFindTunnels,
  },
  {
    name: 'mempalace_graph_stats',
    description: 'Palace graph overview: total rooms, tunnel connections, edges between wings.',
    inputSchema: { type: 'object', properties: {} },
    handler: toolGraphStats,
  },
  {
    name: 'mempalace_diary_write',
    description: 'Write to your personal agent diary. Your observations, thoughts, what you worked on.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Your name — each agent gets their own diary wing' },
        entry: { type: 'string', description: 'Your diary entry (plain text)' },
        topic: { type: 'string', description: 'Topic tag (optional, default: general)' },
      },
      required: ['agent_name', 'entry'],
    },
    handler: toolDiaryWrite,
  },
  {
    name: 'mempalace_diary_read',
    description: 'Read your recent diary entries. See what past versions of yourself recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Your name — each agent gets their own diary wing' },
        last_n: { type: 'integer', description: 'Number of recent entries to read (default: 10)' },
      },
      required: ['agent_name'],
    },
    handler: toolDiaryRead,
  },
  {
    name: 'mempalace_guide',
    description:
      'Analyse content and recommend wing/room/hall/importance before filing. ' +
      'Runs three strategies: content-type classifier, existing taxonomy match, and mempalace.yaml. ' +
      'Call this BEFORE mempalace_add_drawer when unsure where to file.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The text to be stored — the actual content to analyse',
        },
        context: {
          type: 'string',
          description: 'What the conversation/situation is about (e.g. "debugging docker setup"). Optional but improves accuracy.',
        },
        hint_wing: {
          type: 'string',
          description: 'Optional wing hint (e.g. "wing_code" or just "code"). Overrides auto-detection if valid.',
        },
      },
      required: ['content'],
    },
    handler: toolGuide,
  },
  {
    name: 'mempalace_wake_up',
    description:
      'Load L0 identity + L1 essential story. Call this at the start of every session to restore context. ' +
      'Pass context (first user message or topic) to auto-select the right agent identity. ' +
      'L1 returns the top 15 highest-importance drawers grouped by room (max 3200 chars), ' +
      'filtered by the selected identity\'s wing_focus unless wing is explicitly provided.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'First user message or topic — used to auto-select agent identity (optional)' },
        wing: { type: 'string', description: 'Override L1 wing filter — ignores identity wing_focus (optional)' },
      },
    },
    handler: toolWakeUp,
  },
  {
    name: 'mempalace_recall',
    description:
      'L2 on-demand retrieval — fetch drawers from a specific wing/room without semantic search. ' +
      'Faster than mempalace_search. Use when a topic arises and you want all memories for that room.',
    inputSchema: {
      type: 'object',
      properties: {
        wing: { type: 'string', description: 'Wing to filter by (optional)' },
        room: { type: 'string', description: 'Room to filter by (optional)' },
        limit: { type: 'integer', description: 'Max entries to return (default: 10)' },
      },
    },
    handler: toolRecall,
  },
  {
    name: 'mempalace_list_identities',
    description:
      'List all available agent identities from the identities/ directory. ' +
      'Shows name, description, keywords, and wing_focus for each. ' +
      'Use this to see which identities are available before calling mempalace_wake_up.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: toolListIdentities,
  },
  {
    name: 'mempalace_setup',
    description:
      'First-time setup wizard. Stores user name, about, preferences, and hard rules into ' +
      'personality_memory_palace — the fallback palace used when no specific identity matches. ' +
      'Also creates/overwrites the default identity file. Run once to personalise the palace.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'User\'s name (required)' },
        about:       { type: 'string',  description: 'Who the user is — role, context, background (optional)' },
        preferences: { type: 'array',  items: { type: 'string' }, description: 'Communication preferences, e.g. ["respond in Turkish", "be concise"] (optional)' },
        rules:       { type: 'array',  items: { type: 'string' }, description: 'Hard rules the AI must always follow, e.g. ["never commit without testing"] (optional)' },
        language:    { type: 'string',  description: 'Preferred response language (default: English)' },
      },
      required: ['name'],
    },
    handler: toolSetup,
  },
];

// ── Exported for testing ────────────────────────────────────────────────────

export function getToolDefinitions() {
  return TOOLS.map(({ handler, ...rest }) => rest);
}

// ── Internal: expose for testing ────────────────────────────────────────────

export { TOOLS, PALACE_PROTOCOL };

// ── MCP Server Setup ────────────────────────────────────────────────────────

export function createServer() {
  const server = new Server(
    { name: 'mempalace', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: PALACE_PROTOCOL,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    // Coerce argument types based on inputSchema
    const schemaProps = tool.inputSchema.properties || {};
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schemaProps[key];
      if (!propSchema) continue;
      if (propSchema.type === 'integer' && typeof value !== 'number') {
        args[key] = parseInt(value, 10);
      } else if (propSchema.type === 'number' && typeof value !== 'number') {
        args[key] = parseFloat(value);
      }
    }

    try {
      const result = await tool.handler(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MemPalace MCP Server (stdio) starting...');
}

async function startHTTP() {
  const http = await import('http');

  const transports = {};

  function getOrCreateTransport(sessionId) {
    if (sessionId && transports[sessionId]) {
      return transports[sessionId];
    }
    return null;
  }

  async function createNewSession() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) delete transports[sid];
    };

    const server = createServer();
    await server.connect(transport);

    return transport;
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url.pathname === '/mcp') {
      try {
        const sessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const parsed = JSON.parse(body);

          let transport = getOrCreateTransport(sessionId);

          if (!transport) {
            if (isInitializeRequest(parsed)) {
              transport = await createNewSession();
              await transport.handleRequest(req, res, parsed);
              if (transport.sessionId) {
                transports[transport.sessionId] = transport;
              }
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session. Send initialize first.' },
                id: null,
              }));
            }
            return;
          }

          await transport.handleRequest(req, res, parsed);
        } else if (req.method === 'GET' || req.method === 'DELETE') {
          const transport = getOrCreateTransport(sessionId);
          if (transport) {
            await transport.handleRequest(req, res);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing or invalid session' }));
          }
        } else {
          res.writeHead(405);
          res.end();
        }
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const port = parseInt(process.env.MCP_PORT || '3100', 10);
  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`MemPalace MCP Server (http) listening on port ${port}`);
  });
}

export async function main() {
  if (process.env.MCP_TRANSPORT === 'http') {
    await startHTTP();
  } else {
    await startStdio();
  }
}

// Run if executed directly
const isMain = process.argv[1] &&
  (process.argv[1].endsWith('/mcpServer.js') || process.argv[1].endsWith('\\mcpServer.js'));

if (isMain) {
  main().catch((err) => {
    console.error('MCP Server error:', err);
    process.exit(1);
  });
}
