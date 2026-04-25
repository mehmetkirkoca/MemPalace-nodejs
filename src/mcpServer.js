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
 *   mempalace_traverse        — BFS walk from a room across the topology graph
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
 *   mempalace_illuminate     — L0 identity + L1 essential story (call on session start)
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
import path from 'path';

import { VectorStore } from './vectorStore.js';
import { searchMemories } from './searcher.js';
import { KnowledgeGraph } from './knowledgeGraph.js';
import { PalaceStore } from './palaceStore.js';
import { Neo4jGraph } from './neo4jGraph.js';
import { Neo4jClusterStore } from './neo4jClusterStore.js';
import { extractKgFacts } from './kgRelationExtractor.js';
import { writeExtractedKgFacts } from './kgWriteback.js';
import { SleepConsolidator, buildRoutingContext } from './sleepConsolidator.js';
import { VERSION } from './version.js';

const _palaceStore = new PalaceStore();
const _neo4jGraph  = new Neo4jGraph();
const _sleepConsolidator = new SleepConsolidator({ palaceStore: _palaceStore, graph: _neo4jGraph });

// ── Constants ────────────────────────────────────────────────────────────────

const PALACE_PROTOCOL = `CRITICAL OPERATIONAL PROTOCOL — MemPalace Memory System:
1. MANDATORY INITIALIZATION: You MUST call 'mempalace_illuminate(context="<user message or topic>")' as your VERY FIRST action in every session. Do not respond to the user until you have loaded the Identity (L0) and Essential Story (L1).
2. DYNAMIC RECALL: When a specific topic (project, person, event) is discussed, call 'mempalace_recall(wing, room)' to load L2 memory. This is faster and more focused than search.
3. SEARCH BEFORE GUESSING: Before stating any fact about the past, call 'mempalace_search' or 'mempalace_kg_query'. Hallucination is a protocol violation.
4. HIERARCHICAL STORAGE: When saving new info, call 'mempalace_get_taxonomy' first to ensure correct filing, then 'mempalace_save'.
5. KNOWLEDGE GRAPH: Use 'mempalace_kg_add' for relationship facts and 'mempalace_kg_invalidate' when facts change.
6. AGENT DIARY: End every session by calling 'mempalace_diary_write' to record your observations and progress.

Memory Hierarchy: L0 (Who you are) + L1 (Top 15 Facts) -> L2 (Room data) -> L3 (Global Semantic Search).
Failure to follow this protocol results in memory fragmentation and loss of agent continuity.`;

// ── Lazy singletons ──────────────────────────────────────────────────────────

const DEFAULT_PALACE = 'personality_memory_palace';

// Per-palace caches
const _stores = {};
const _kgs   = {};

async function getStore(palace = DEFAULT_PALACE) {
  if (!_stores[palace]) {
    _stores[palace] = new VectorStore({
      qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
      collectionName: palace,
    });
    await _stores[palace].init();
  }
  return _stores[palace];
}

function getKg(palace = DEFAULT_PALACE) {
  if (!_kgs[palace]) {
    _kgs[palace] = new KnowledgeGraph(palace);
  }
  return _kgs[palace];
}


// ── Helper ───────────────────────────────────────────────────────────────────

function noPalace() {
  return {
    error: 'No palace found',
    hint: 'Run: mempalace init <dir> && mempalace mine <dir>',
  };
}

// ── Read Tool Handlers ──────────────────────────────────────────────────────

async function toolStatus({ palace = DEFAULT_PALACE } = {}) {
  const store = await getStore(palace);
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

async function toolListWings({ palace = DEFAULT_PALACE } = {}) {
  const store = await getStore(palace);
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

async function toolListRooms({ wing, palace = DEFAULT_PALACE } = {}) {
  const store = await getStore(palace);
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

async function toolGetTaxonomy({ palace = DEFAULT_PALACE } = {}) {
  const clusters = new Neo4jClusterStore(palace);
  const tree = await clusters.getTree();
  const text = await clusters.getTaxonomyText();
  return { taxonomy: tree, taxonomy_text: text };
}

async function toolSearch({ query, limit = 5, wing, room, palace }) {
  let activePalace = palace;

  // If no palace specified, try to semantically route based on the query
  if (!activePalace) {
    const matched = await _palaceStore.selectByContext(query);
    activePalace = matched?.name || DEFAULT_PALACE;
  }

  const store = await getStore(activePalace);
  const result = await searchMemories(query, store, { wing, room, nResults: limit });
  return { ...result, searched_palace: activePalace };
}

async function toolCheckDuplicate({ content, threshold = 0.9, palace = DEFAULT_PALACE }) {
  const store = await getStore(palace);
  const normalizedContent = content.trim();
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
            exact_match: doc.trim() === normalizedContent,
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

async function toolSave({ content, wing, hall, room, closet, added_by = 'mcp', palace }) {
  if (!content || !content.trim()) return { error: 'content is required' };
  if (!palace || !palace.trim()) {
    return {
      error: 'palace is required',
      hint: 'Call mempalace_list_identities first, then pass the target palace explicitly.',
    };
  }
  if (!wing || !hall || !room || !closet) {
    return {
      error: 'wing, hall, room, and closet are required',
      hint: 'Call mempalace_get_taxonomy first to see the existing hierarchy, then decide where this content belongs.',
    };
  }

  const dup = await toolCheckDuplicate({ content, threshold: 0.9, palace });
  if (dup.is_duplicate) {
    if (dup.matches.some((match) => match.exact_match)) {
      return { success: false, reason: 'duplicate', matches: dup.matches };
    }
  }

  // Auto-register palace in the palace store if it doesn't exist yet
  const existingPalaces = await _palaceStore.getAll();
  if (!existingPalaces.find((p) => p.name === palace)) {
    await _palaceStore.upsert({
      name: palace,
      description: `Auto-registered palace: ${palace}`,
      scope: palace.replace(/_/g, ' '),
      is_default: false,
    });
  }

  const clusters = new Neo4jClusterStore(palace);
  const { wingId, hallId, roomId, closetId } = await clusters.assign(wing, hall, room, closet);

  const result = await toolAddDrawer({
    wing, wing_id: wingId, wing_name: wing,
    hall, hall_id: hallId, hall_name: hall,
    room, room_id: roomId, room_name: room,
    closet, closet_id: closetId, closet_name: closet,
    content, added_by, palace,
  });

  return { ...result, filed_at: { wing, hall, room, closet } };
}

async function assessExplicitRouting(palace, content, path = {}) {
  const palaces = await _palaceStore.getAll();
  if (palaces.length === 0) {
    return {
      routing_confidence: null,
      routing_best_palace: palace,
      needs_review: 0,
      routing_reason: 'no_palace_registry',
    };
  }

  const ranked = await _palaceStore.rankByContext(buildRoutingContext(content, path), palaces.length);
  const best = ranked[0] || null;
  const current = ranked.find((candidate) => candidate.name === palace) || null;
  const currentScore = current?.score ?? null;
  const bestScore = best?.score ?? null;
  const scoreGap = bestScore !== null && currentScore !== null ? bestScore - currentScore : null;
  const needsReview = Boolean(
    best &&
    best.name !== palace &&
    bestScore !== null &&
    bestScore >= 0.05 &&
    scoreGap !== null &&
    scoreGap >= 0.02
  );

  return {
    routing_confidence: currentScore,
    routing_best_palace: best?.name || palace,
    needs_review: needsReview ? 1 : 0,
    routing_reason: needsReview
      ? 'explicit_palace_differs_from_semantic_best_match'
      : 'explicit_palace_confirmed',
  };
}

async function toolAddDrawer({ wing, wing_id, wing_name, hall, hall_id, hall_name, room, room_id, room_name, closet, closet_id, closet_name, content, source_file, added_by = 'mcp', palace = DEFAULT_PALACE }) {
  const store = await getStore(palace);
  const routing = await assessExplicitRouting(palace, content, {
    wing_name: wing_name || wing,
    hall_name: hall_name || hall,
    room_name: room_name || room,
    closet_name: closet_name || closet,
  });

  const hash = crypto
    .createHash('md5')
    .update(content.slice(0, 100) + new Date().toISOString())
    .digest('hex')
    .slice(0, 12);
  const drawerId = `dra_${hash}`;

  const payload = {
    ids: [drawerId],
    documents: [content],
    metadatas: [{
      wing:         wing_id    || wing    || 'unknown',
      wing_name:    wing_name  || wing    || 'unknown',
      hall:         hall_id    || hall    || 'unknown',
      hall_name:    hall_name  || hall    || 'unknown',
      room:         room_id    || room    || 'unknown',
      room_name:    room_name  || room    || 'unknown',
      closet:       closet_id  || closet  || 'unknown',
      closet_name:  closet_name || closet || 'unknown',
      source_file:  source_file || '',
      added_by,
      filed_at:     new Date().toISOString(),
      routing_confidence: routing.routing_confidence,
      routing_best_palace: routing.routing_best_palace,
      needs_review: routing.needs_review,
      routing_reason: routing.routing_reason,
    }],
  };

  try {
    await store.add(payload);
    _neo4jGraph.mergeDrawer(palace, room_name || room, hall_name || hall, drawerId).catch(() => {});
    let kgExtraction = null;
    try {
      const facts = await extractKgFacts(content, {
        palace,
        wing: wing_name || wing,
        hall: hall_name || hall,
        room: room_name || room,
        closet: closet_name || closet,
        filedAt: payload.metadatas[0].filed_at,
      });
      const writes = await writeExtractedKgFacts({ palace, drawerId, facts });
      kgExtraction = {
        candidates: facts.length,
        written: writes.length,
        facts: writes,
      };
    } catch (kgError) {
      kgExtraction = {
        candidates: 0,
        written: 0,
        error: kgError.message,
      };
    }
    return {
      success: true,
      drawer_id: drawerId,
      wing: wing_name || wing,
      hall: hall_name || hall,
      room: room_name || room,
      closet: closet_name || closet,
      kg_extraction: kgExtraction,
      routing,
    };
  } catch (e) {
    if (e.message?.includes('Not Found') || e.status === 404 || e.statusCode === 404) {
      delete _stores[palace];
      try {
        const freshStore = await getStore(palace);
        await freshStore.add(payload);
        _neo4jGraph.mergeDrawer(palace, room_name || room, hall_name || hall, drawerId).catch(() => {});
        let kgExtraction = null;
        try {
          const facts = await extractKgFacts(content, {
            palace,
            wing: wing_name || wing,
            hall: hall_name || hall,
            room: room_name || room,
            closet: closet_name || closet,
            filedAt: payload.metadatas[0].filed_at,
          });
          const writes = await writeExtractedKgFacts({ palace, drawerId, facts });
          kgExtraction = {
            candidates: facts.length,
            written: writes.length,
            facts: writes,
          };
        } catch (kgError) {
          kgExtraction = {
            candidates: 0,
            written: 0,
            error: kgError.message,
          };
        }
        return {
          success: true,
          drawer_id: drawerId,
          wing: wing_name || wing,
          hall: hall_name || hall,
          room: room_name || room,
          closet: closet_name || closet,
          kg_extraction: kgExtraction,
          routing,
        };
      } catch (e2) {
        return { success: false, error: e2.message };
      }
    }
    return { success: false, error: e.message };
  }
}

async function toolDeleteDrawer({ drawer_id, palace = DEFAULT_PALACE }) {
  // Closet node (taxonomy structural node in Neo4j) — not a vector store entry
  if (drawer_id.startsWith('clo_')) {
    try {
      const clusters = new Neo4jClusterStore(palace);
      const { deleted } = await clusters.deleteCloset(drawer_id);
      if (deleted === 0) {
        return { success: false, error: `Closet not found: ${drawer_id}` };
      }
      return { success: true, drawer_id };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  const store = await getStore(palace);
  try {
    // Try to get existing first
    const existing = await store.get({ where: { original_id: drawer_id }, limit: 1 });
    if (!existing.ids || existing.ids.length === 0) {
      return { success: false, error: `Drawer not found: ${drawer_id}` };
    }
    return await _sleepConsolidator.queueDrawerDeletion({
      drawerId: drawer_id,
      palace,
      reason: 'mcp_delete_drawer',
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── KG Tool Handlers ────────────────────────────────────────────────────────

async function toolKgQuery({ entity, as_of, direction = 'both', palace = DEFAULT_PALACE }) {
  const kg = getKg(palace);
  const results = await kg.queryEntity(entity, { asOf: as_of, direction });
  return { entity, as_of: as_of || null, facts: results, count: results.length };
}

async function toolKgAdd({ subject, predicate, object, valid_from, source_closet, palace = DEFAULT_PALACE }) {
  const kg = getKg(palace);
  const tripleId = await kg.addTriple(subject, predicate, object, {
    validFrom: valid_from,
    sourceCloset: source_closet,
  });
  return { success: true, triple_id: tripleId, fact: `${subject} → ${predicate} → ${object}` };
}

async function toolKgInvalidate({ subject, predicate, object, ended, palace = DEFAULT_PALACE }) {
  const kg = getKg(palace);
  await kg.invalidate(subject, predicate, object, ended);
  return {
    success: true,
    fact: `${subject} → ${predicate} → ${object}`,
    ended: ended || 'today',
  };
}

async function toolKgTimeline({ entity, palace = DEFAULT_PALACE } = {}) {
  const kg = getKg(palace);
  const results = await kg.timeline(entity);
  return { entity: entity || 'all', timeline: results, count: results.length };
}

async function toolKgStats({ palace = DEFAULT_PALACE } = {}) {
  const kg = getKg(palace);
  return await kg.stats();
}

async function toolAudit({ palace, limit = 100, min_score = 0.05, min_gap = 0.02 } = {}) {
  if (!palace || !palace.trim()) {
    return { error: 'palace is required' };
  }
  return _sleepConsolidator.auditPalace(palace, {
    limit,
    minScore: min_score,
    minGap: min_gap,
  });
}

async function toolConsolidate({
  palace,
  limit = 100,
  max_moves = 25,
  min_score = 0.05,
  min_gap = 0.02,
  dry_run = true,
} = {}) {
  if (!palace || !palace.trim()) {
    return { error: 'palace is required' };
  }
  return _sleepConsolidator.consolidatePalace(palace, {
    limit,
    maxMoves: max_moves,
    minScore: min_score,
    minGap: min_gap,
    dryRun: dry_run,
  });
}

// ── Navigation Tool Handlers ────────────────────────────────────────────────

async function toolTraverse({ start_room, max_hops = 2 }) {
  try {
    const results = await _neo4jGraph.traverse(start_room, max_hops);
    return { start_room, max_hops, connected: results, total: results.length };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFindTunnels({ palace_a, palace_b } = {}) {
  try {
    const tunnels = await _neo4jGraph.findTunnels(palace_a || null, palace_b || null);
    return { tunnels, total: tunnels.length };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolGraphStats() {
  try {
    return await _neo4jGraph.graphStats();
  } catch (e) {
    return { error: e.message };
  }
}

// ── Diary Tool Handlers ─────────────────────────────────────────────────────

async function toolDiaryWrite({ agent_name = 'agent', entry, topic = 'general', palace = DEFAULT_PALACE }) {
  const store = await getStore(palace);
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

async function toolDiaryRead({ agent_name = 'agent', last_n = 10, palace = DEFAULT_PALACE }) {
  const store = await getStore(palace);
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

const L1_MAX_DRAWERS = 15;
const L1_MAX_CHARS   = 3200;

async function _loadPalaces() {
  return _palaceStore.getAll();
}

export async function illuminateMemory({ wing, context } = {}) {
  // L0 — auto-select identity
  let l0 = '';
  let identitySelected = null;

  try {
    const palaces = await _loadPalaces();
    let selectedName;
    if (context) {
      const match = await _palaceStore.selectByContext(context);
      selectedName = match?.name || (palaces.find(p => p.is_default) || palaces[0])?.name || DEFAULT_PALACE;
    } else {
      selectedName = (palaces.find(p => p.is_default) || palaces[0])?.name || DEFAULT_PALACE;
    }
    const selected = palaces.find(p => p.name === selectedName) || palaces.find(p => p.is_default) || palaces[0];

    if (selected) {
      l0 = selected.l0_body || `## L0 — IDENTITY\n(${selected.name} — no body content)`;

      identitySelected = {
        name: selected.name,
        description: selected.description || null,
        wing_focus: selected.wing_focus || null,
        palace: selected.name,
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
  const activePalace = identitySelected?.palace || DEFAULT_PALACE;
  let l1 = '';
  try {
    const store = await getStore(activePalace);
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

async function toolRecall({ wing, room, limit = 10, palace = DEFAULT_PALACE } = {}) {
  const store = await getStore(palace);

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

async function toolListIdentities() {
  const palaces = await _loadPalaces();
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

  await _palaceStore.upsert({ name: palaceName, description, keywords, scope, wing_focus, l0_body, is_default: false });

  _neo4jGraph.mergePalace({ name: palaceName, description: description || '', scope: scope || '', is_default: false })
    .catch(() => {});

  // Pre-init Qdrant collection so it's ready to use
  await getStore(palaceName);

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
  const store = await getStore(DEFAULT_PALACE); // creates collection if missing
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
  await _palaceStore.upsert({
    name:        DEFAULT_PALACE,
    description: `${name}'s personal assistant`,
    keywords:    [],
    scope:       defaultScope,
    wing_focus:  null,
    l0_body:     l0Body,
    is_default:  true,
  });

  _neo4jGraph.mergePalace({ name: DEFAULT_PALACE, description: `${name}'s personal assistant`, scope: defaultScope, is_default: true })
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
      'Save content to a specific palace. You must provide palace and the categorization (wing, hall, room, closet). ' +
      'Call mempalace_get_taxonomy first to see the existing hierarchy and decide where this belongs. ' +
      'Deduplicates automatically and runs knowledge graph extraction/writeback on every successful save.',
    inputSchema: {
      type: 'object',
      properties: {
        palace:  { type: 'string',  description: 'Target palace name, required (e.g. "news_palace")' },
        content: { type: 'string',  description: 'Content to save — verbatim, never summarized' },
        wing:    { type: 'string',  description: 'Broad domain (e.g. "Technology", "Health", "Personal")' },
        hall:    { type: 'string',  description: 'Sub-domain (e.g. "Programming", "Nutrition")' },
        room:    { type: 'string',  description: 'Specific topic (e.g. "JavaScript", "Vitamins")' },
        closet:  { type: 'string',  description: 'Fine-grained sub-topic (e.g. "TypeScript", "Vitamin D")' },
        added_by:{ type: 'string',  description: 'Who is saving this (default: mcp)' },
      },
      required: ['palace', 'content', 'wing', 'hall', 'room', 'closet'],
    },
    handler: toolSave,
  },
  {
    name: 'mempalace_delete_drawer',
    description: 'Queue a drawer for sleep-time deletion by ID. Physical deletion happens during consolidation.',
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
    name: 'mempalace_audit',
    description: 'Sleep-style audit. Scan a palace for drawers that now look semantically closer to another palace.',
    inputSchema: {
      type: 'object',
      properties: {
        palace: { type: 'string', description: 'Palace to audit' },
        limit: { type: 'integer', description: 'Max drawers to scan (default 100)' },
        min_score: { type: 'number', description: 'Minimum best-match score before flagging (default 0.05)' },
        min_gap: { type: 'number', description: 'Minimum score gap versus current palace before flagging (default 0.02)' },
      },
      required: ['palace'],
    },
    handler: toolAudit,
  },
  {
    name: 'mempalace_consolidate',
    description: 'Sleep-style consolidation. Re-audit a palace and move flagged drawers to better-matching palaces while preserving drawer IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        palace: { type: 'string', description: 'Palace to consolidate' },
        limit: { type: 'integer', description: 'Max drawers to scan (default 100)' },
        max_moves: { type: 'integer', description: 'Max moves to apply (default 25)' },
        min_score: { type: 'number', description: 'Minimum best-match score before flagging (default 0.05)' },
        min_gap: { type: 'number', description: 'Minimum score gap versus current palace before flagging (default 0.02)' },
        dry_run: { type: 'boolean', description: 'When true, only report moves without applying them (default true)' },
      },
      required: ['palace'],
    },
    handler: toolConsolidate,
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
    name: 'mempalace_illuminate',
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
    handler: illuminateMemory,
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
      'List all configured palaces from the registry. ' +
      'Shows name, description, keywords, and wing_focus for each. ' +
      'Use this to see which palaces are available before calling mempalace_illuminate.',
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
      'Stores config in the palace registry (Qdrant). Run once to personalise the palace.',
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
