/**
 * mcpServer.js — MemPalace MCP Server
 * ====================================
 *
 * 22 MCP tools for palace access.
 *
 * Tools (read):
 *   mempalace_status          — total drawers, wing/room breakdown
 *   mempalace_list_wings      — all wings with drawer counts
 *   mempalace_list_rooms      — rooms within a wing
 *   mempalace_get_taxonomy    — full wing → room → count tree
 *   mempalace_search          — semantic search, optional wing/room filter
 *
 * Tools (write):
 *   mempalace_save            — auto-route and file content (dedup + add in one call)
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
 *   mempalace_traverse        — BFS walk from a room across the Kuzu graph
 *   mempalace_find_tunnels    — cross-palace rooms (shared topic nodes)
 *   mempalace_graph_stats     — palace/room/drawer/tunnel counts
 *
 * Tools (diary):
 *   mempalace_diary_write     — write a diary entry
 *   mempalace_diary_read      — recent entries
 *
 * Tools (identity / setup):
 *   mempalace_list_identities — list all configured palaces
 *   mempalace_palace_create   — create a new palace with routing config
 *   mempalace_setup           — first-time setup (name, preferences, rules)
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
import { Embedder } from './embedder.js';
import { searchMemories } from './searcher.js';
import { KnowledgeGraph } from './knowledgeGraph.js';
import { PalaceRegistry } from './palaceRegistry.js';
import { KuzuGraph } from './kuzuGraph.js';
import {
  HALL_DESCRIPTIONS,
  IMPORTANCE_SIGNALS,
  SLUG_STOP,
  getHallVectors,
  dotProduct,
  slugifyRoom,
  selectPalace,
  selectHall,
  scoreImportance,
} from './mempalacePipeline.js';
import { VERSION } from './version.js';

const _registry = new PalaceRegistry();
const _kuzu = new KuzuGraph(path.join(os.homedir(), '.mempalace', 'palace_graph.kuzu'));

// ── Constants ────────────────────────────────────────────────────────────────

const PALACE_PROTOCOL = `IMPORTANT — MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_wake_up(context="<first user message or topic>") to auto-load the right agent identity (L0) and top memories (L1). Do this first, every session.
2. WHEN A TOPIC ARISES: Call mempalace_recall(wing, room) to load that room's contents (L2) — fast, no embedding.
3. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
4. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
5. WHEN STORING ANYTHING: call mempalace_save(content, context) — it auto-routes, deduplicates, and files. Never pick wing/room yourself.
6. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
7. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

Memory layers: L0 (identity) + L1 (top facts, always loaded) → L2 (room on-demand) → L3 (mempalace_search, semantic).
This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory.`;

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
    // Collection doesn't exist yet — not a duplicate
    return { is_duplicate: false, matches: [] };
  }
}

// ── Write Tool Handlers ─────────────────────────────────────────────────────

async function toolSave({ content, context, added_by = 'mcp' }) {
  if (!content || !content.trim()) {
    return { error: 'content is required' };
  }

  // Embed once — reuse for hall classification + palace routing
  const combined = `${content}\n${context || ''}`;
  const embedder = new Embedder();
  const contentVector = await embedder.embed(combined);

  // Hall via embedding
  const hallVectors = await getHallVectors();
  const hall = selectHall(contentVector, hallVectors);

  // Palace via embedding
  const palaces = _loadPalaces();
  const { name: palaceToUse, similarity: palaceSim } = selectPalace(contentVector, palaces);
  const palace = palaces.find(p => p.name === palaceToUse);

  // Wing from palace config; room from content keywords
  const wing = palace?.wing_focus || 'wing_myproject';
  const room = slugifyRoom(combined);
  const importance = scoreImportance(content, context);

  // Similarity < 0.35 means no palace is a good fit — suggest creating one
  const weakMatch = palaceSim < 0.35;

  const prevPalace = _activePalace;
  _activePalace = palaceToUse;

  try {
    // Dedup in the correct palace
    const dup = await toolCheckDuplicate({ content, threshold: 0.9 });
    if (dup.is_duplicate) {
      return { success: false, reason: 'duplicate', matches: dup.matches };
    }

    // File it
    const result = await toolAddDrawer({ wing, room, content, hall, importance, added_by });

    const isGenericWing = wing === 'wing_myproject';
    const isGenericRoom = room === 'general';
    const confidence = (!isGenericWing && !isGenericRoom) ? 'high'
      : (isGenericWing && isGenericRoom) ? 'low' : 'medium';

    const response = { ...result, routed_to: { wing, room, hall, importance }, palace: palaceToUse, confidence };

    if (weakMatch) {
      response.suggest_palace_create = true;
      response.suggestion = `Content matched existing palaces weakly (similarity: ${palaceSim.toFixed(2)}). Consider creating a new palace for this type of content. Use mempalace_palace_create with: name, scope (what content belongs here), and keywords.`;
    } else if (confidence === 'low') {
      response.note = `Filed to ${wing}/${room} — routing uncertain. Pass 'context' for better accuracy.`;
    }

    return response;
  } finally {
    _activePalace = prevPalace;
  }
}

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

  const payload = {
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
  };

  try {
    await store.add(payload);
    // Update Kuzu graph topology (fire-and-forget — don't block save)
    _kuzu.mergeDrawer(_activePalace, room, hall || 'hall_facts', drawerId, importance)
      .catch(() => {});
    return { success: true, drawer_id: drawerId, wing, room };
  } catch (e) {
    // Collection was deleted externally — recreate and retry once
    if (e.message?.includes('Not Found') || e.status === 404 || e.statusCode === 404) {
      delete _stores[_activePalace];
      try {
        const freshStore = await getStore();
        await freshStore.add(payload);
        _kuzu.mergeDrawer(_activePalace, room, hall || 'hall_facts', drawerId, importance)
          .catch(() => {});
        return { success: true, drawer_id: drawerId, wing, room };
      } catch (e2) {
        return { success: false, error: e2.message };
      }
    }
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
    _kuzu.deleteDrawer(drawer_id).catch(() => {});
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
  try {
    const results = await _kuzu.traverse(start_room, max_hops);
    return { start_room, max_hops, connected: results, total: results.length };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFindTunnels({ palace_a, palace_b } = {}) {
  try {
    const tunnels = await _kuzu.findTunnels(palace_a || null, palace_b || null);
    return { tunnels, total: tunnels.length };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolGraphStats() {
  try {
    return await _kuzu.graphStats();
  } catch (e) {
    return { error: e.message };
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
      meta.scope       = parsed.scope       || null;
      body = parts.slice(2).join('---').trim();
    } catch {
      // malformed frontmatter — treat whole file as body
    }
  }

  if (!meta.name) {
    meta.name = path.basename(filePath, '.txt');
  }

  return { ...meta, scope: meta.scope || null, body, file: filePath };
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


// _loadPalaces: reads from registry, migrates from txt files on first run.
// Also triggers async background embedding for any palace missing scope_vector.
function _loadPalaces() {
  let palaces = _registry.getAll();
  if (palaces.length === 0) {
    // Backward compat: migrate from identities/*.txt
    const txtIdentities = _loadIdentities();
    for (const id of txtIdentities) {
      _registry.upsert({
        name:        id.palace || DEFAULT_PALACE,
        description: id.description || null,
        keywords:    id.keywords || [],
        scope:       id.scope || null,
        wing_focus:  id.wing_focus || null,
        l0_body:     id.body || null,
        is_default:  id.name === 'default' ? 1 : 0,
      });
    }
    palaces = _registry.getAll();
  }

  // Background: embed scope for any palace that is missing scope_vector
  for (const p of palaces) {
    if (p.scope && !p.scope_vector) {
      new Embedder().embed(p.scope)
        .then(v => _registry.setVector(p.name, v))
        .catch(() => {});
    }
  }

  return palaces;
}

async function toolWakeUp({ wing, context } = {}) {
  // L0 — auto-select identity
  let l0 = '';
  let identitySelected = null;

  try {
    const palaces = _loadPalaces();
    let selectedName;
    if (context) {
      const ctxVector = await new Embedder().embed(context);
      selectedName = selectPalace(ctxVector, palaces).name;
    } else {
      selectedName = (palaces.find(p => p.is_default) || palaces[0])?.name || DEFAULT_PALACE;
    }
    const selected = palaces.find(p => p.name === selectedName) || palaces.find(p => p.is_default) || palaces[0];

    if (selected) {
      l0 = selected.l0_body || `## L0 — IDENTITY\n(${selected.name} — no body content)`;

      // Activate the selected palace
      _activePalace = selected.name;
      _activeKgPath = path.join(PALACE_BASE, `kg_${selected.name}.sqlite3`);

      identitySelected = {
        name: selected.name,
        description: selected.description || null,
        wing_focus: selected.wing_focus || null,
        palace: _activePalace,
        reason: selected.is_default ? 'default fallback' : 'scope/keyword match',
      };
    } else {
      l0 = '## L0 — IDENTITY\nNo palace configured. Run mempalace_setup to get started.';
    }
  } catch (e) {
    l0 = `## L0 — IDENTITY\nCould not load palaces: ${e.message}`;
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
  const palaces = _loadPalaces();
  if (palaces.length === 0) {
    return {
      palaces: [],
      hint: 'No palaces configured. Run mempalace_setup to create the default palace, or mempalace_palace_create to add more.',
    };
  }
  return {
    palaces: palaces.map(({ name, description, keywords, wing_focus, scope, is_default }) => ({
      name,
      description: description || null,
      keywords,
      wing_focus: wing_focus || null,
      scope: scope || null,
      is_default,
    })),
    total: palaces.length,
  };
}

async function toolPalaceCreate({ name, description, keywords = [], scope, wing_focus, l0_body } = {}) {
  if (!name || !name.trim()) {
    return { error: 'name is required' };
  }
  const palaceName = name.trim().toLowerCase().replace(/\s+/g, '_');

  _registry.upsert({ name: palaceName, description, keywords, scope, wing_focus, l0_body, is_default: 0 });

  // Embed scope vector for routing
  if (scope) {
    new Embedder().embed(scope)
      .then(v => _registry.setVector(palaceName, v))
      .catch(() => {});
  }

  // Register in Kuzu graph
  _kuzu.mergePalace({ name: palaceName, description: description || '', scope: scope || '', is_default: false })
    .catch(() => {});

  // Pre-init Qdrant collection so it's ready to use
  const prev = _activePalace;
  _activePalace = palaceName;
  try {
    await getStore();
  } finally {
    _activePalace = prev;
  }

  return {
    success: true,
    palace: palaceName,
    message: `Palace '${palaceName}' created and registered. Use mempalace_save with relevant content to start filing.`,
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

  // 4. Store palace config in registry
  const l0Body = [
    `## L0 — IDENTITY`,
    `Name: ${name}`,
    language !== 'English' ? `Language: ${language}` : null,
    about ? `About: ${about.trim()}` : null,
    preferences.length > 0 ? `\nPreferences:\n${preferences.map(p => `- ${p}`).join('\n')}` : null,
    rules.length > 0 ? `\nRules:\n${rules.map(r => `- ${r}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');

  const defaultScope = 'Personal preferences, user identity, communication style, rules for the AI, life events, emotions, general notes.';
  _registry.upsert({
    name: DEFAULT_PALACE,
    description: `${name}'s personal assistant`,
    keywords: [],
    scope: defaultScope,
    wing_focus: null,
    l0_body: l0Body,
    is_default: 1,
  });

  // Embed scope vector for routing
  new Embedder().embed(defaultScope)
    .then(v => _registry.setVector(DEFAULT_PALACE, v))
    .catch(() => {});

  // Register in Kuzu graph
  _kuzu.mergePalace({ name: DEFAULT_PALACE, description: `${name}'s personal assistant`, scope: defaultScope, is_default: true })
    .catch(() => {});

  return {
    success: true,
    palace: DEFAULT_PALACE,
    drawers_created: results,
    message: `Setup complete. ${name}'s personality is stored in '${DEFAULT_PALACE}'. This palace loads automatically when no specific palace matches.`,
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
    name: 'mempalace_save',
    description:
      'Save content to the palace. Auto-detects wing, room, hall, and importance — no need to specify them. ' +
      'Deduplicates automatically. Pass context for better routing accuracy. ' +
      'Returns where the content was filed and confidence level.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to save — verbatim, never summarized' },
        context: { type: 'string', description: 'What this is about — improves routing accuracy (optional)' },
        added_by: { type: 'string', description: 'Who is saving this (default: mcp)' },
      },
      required: ['content'],
    },
    handler: toolSave,
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
    description: 'Walk the palace graph from a room. Shows connected ideas across rooms and palaces — follows cross-palace tunnels.',
    inputSchema: {
      type: 'object',
      properties: {
        start_room: { type: 'string', description: "Room to start from (e.g. 'authentication')" },
        max_hops: { type: 'integer', description: 'How many connections to follow (default: 2)' },
      },
      required: ['start_room'],
    },
    handler: toolTraverse,
  },
  {
    name: 'mempalace_find_tunnels',
    description: 'Find rooms that are shared across two palaces — cross-domain tunnels connecting different memory spaces.',
    inputSchema: {
      type: 'object',
      properties: {
        palace_a: { type: 'string', description: 'First palace name (optional — omit for all tunnels)' },
        palace_b: { type: 'string', description: 'Second palace name (optional)' },
      },
    },
    handler: toolFindTunnels,
  },
  {
    name: 'mempalace_graph_stats',
    description: 'Palace graph overview: total palaces, rooms, drawers, and cross-palace tunnel count.',
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
  {
    name: 'mempalace_palace_create',
    description:
      'Create a new palace (Qdrant collection) with its routing config. ' +
      'Define name, scope, and keywords so mempalace_save can auto-route content to it. ' +
      'Each palace is a separate memory space for a different topic domain.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'Palace name — used as Qdrant collection name (e.g. "research_palace")' },
        description: { type: 'string',  description: 'Short description of this palace (optional)' },
        keywords:    { type: 'array',   items: { type: 'string' }, description: 'Keywords that trigger routing to this palace (optional)' },
        scope:       { type: 'string',  description: 'Plain text description of what content belongs here — used for auto-routing (optional)' },
        wing_focus:  { type: 'string',  description: 'Default wing filter for L1 wake-up (e.g. "wing_code") (optional)' },
        l0_body:     { type: 'string',  description: 'Identity text loaded on wake-up when this palace is selected (optional)' },
      },
      required: ['name'],
    },
    handler: toolPalaceCreate,
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
