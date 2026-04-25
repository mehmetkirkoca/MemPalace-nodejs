import { PalaceStore } from './palaceStore.js';
import { VectorStore } from './vectorStore.js';
import { Neo4jClusterStore } from './neo4jClusterStore.js';
import { Neo4jGraph } from './neo4jGraph.js';

const DEFAULT_MIN_SCORE = 0.05;
const DEFAULT_MIN_GAP = 0.02;
const DEFAULT_MATCH_THRESHOLD = 0.82;
const SLEEP_ACTION_DELETE = 'delete';

export function buildRoutingContext(content, metadata = {}) {
  const parts = [
    content,
    metadata.wing_name,
    metadata.hall_name,
    metadata.room_name,
    metadata.closet_name,
  ].filter(Boolean);
  return parts.join('\n');
}

export function decideAuditOutcome(currentPalace, candidates, options = {}) {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const minGap = options.minGap ?? DEFAULT_MIN_GAP;
  const ranked = Array.isArray(candidates) ? candidates : [];
  if (ranked.length === 0) {
    return {
      action: 'keep',
      reason: 'no_candidates',
      currentScore: null,
      bestScore: null,
      suggestedPalace: null,
    };
  }

  const best = ranked[0];
  const current = ranked.find((candidate) => candidate.name === currentPalace) || null;
  const currentScore = current?.score ?? 0;
  const bestScore = best.score ?? 0;

  if (best.name === currentPalace) {
    return {
      action: 'keep',
      reason: 'current_palace_best_match',
      currentScore,
      bestScore,
      suggestedPalace: currentPalace,
    };
  }

  if (bestScore < minScore) {
    return {
      action: 'keep',
      reason: 'best_score_below_threshold',
      currentScore,
      bestScore,
      suggestedPalace: best.name,
    };
  }

  if ((bestScore - currentScore) < minGap) {
    return {
      action: 'keep',
      reason: 'score_gap_too_small',
      currentScore,
      bestScore,
      suggestedPalace: best.name,
    };
  }

  return {
    action: 'move',
    reason: 'better_palace_match_found',
    currentScore,
    bestScore,
    suggestedPalace: best.name,
  };
}

function normalizePathMetadata(metadata = {}) {
  return {
    wing: metadata.wing,
    wing_name: metadata.wing_name || metadata.wing || 'Recovered Memory',
    hall: metadata.hall,
    hall_name: metadata.hall_name || metadata.hall || 'Sleep Refile',
    room: metadata.room,
    room_name: metadata.room_name || metadata.room || 'Unsorted',
    closet: metadata.closet,
    closet_name: metadata.closet_name || metadata.closet || 'Recovered',
  };
}

export function chooseTargetPath(currentMeta = {}, matchedResult = null) {
  if (
    matchedResult &&
    matchedResult.similarity !== undefined &&
    matchedResult.similarity >= DEFAULT_MATCH_THRESHOLD
  ) {
    return normalizePathMetadata(matchedResult);
  }

  return normalizePathMetadata(currentMeta);
}

function isPendingDelete(metadata = {}) {
  return metadata.sleep_action === SLEEP_ACTION_DELETE;
}

async function findSimilarPath(store, content) {
  const result = await store.query({ queryTexts: [content], nResults: 1 });
  const firstDoc = result.documents?.[0]?.[0];
  const firstMeta = result.metadatas?.[0]?.[0];
  const firstScore = result.distances?.[0]?.[0];
  if (!firstDoc || !firstMeta || firstScore === undefined) {
    return null;
  }

  return {
    ...firstMeta,
    text: firstDoc,
    similarity: firstScore,
  };
}

export class SleepConsolidator {
  constructor({
    palaceStore = new PalaceStore(),
    graph = new Neo4jGraph(),
    storeFactory = (palace) => new VectorStore({ collectionName: palace }),
  } = {}) {
    this._palaceStore = palaceStore;
    this._graph = graph;
    this._storeFactory = storeFactory;
    this._stores = new Map();
  }

  async _getStore(palace) {
    if (!this._stores.has(palace)) {
      const store = this._storeFactory(palace);
      await store.init();
      this._stores.set(palace, store);
    }
    return this._stores.get(palace);
  }

  async auditPalace(palace, options = {}) {
    const limit = options.limit ?? 100;
    const palaces = await this._palaceStore.getAll();
    const sourceStore = await this._getStore(palace);
    const all = await sourceStore.get({ limit });
    const findings = [];

    for (let i = 0; i < all.ids.length; i++) {
      const drawerId = all.ids[i];
      const metadata = all.metadatas[i] || {};
      const content = all.documents[i] || '';

      if (isPendingDelete(metadata)) {
        findings.push({
          drawer_id: drawerId,
          current_palace: palace,
          current_path: normalizePathMetadata(metadata),
          current_routing_confidence: metadata.routing_confidence ?? null,
          needs_review: false,
          suggested_palace: null,
          action: 'delete',
          reason: metadata.sleep_reason || 'sleep_delete_queued',
          current_score: null,
          best_score: null,
          candidates: [],
          preview: content.length > 220 ? `${content.slice(0, 220)}...` : content,
          delete_requested_at: metadata.delete_requested_at ?? null,
        });
        continue;
      }

      const routingContext = buildRoutingContext(content, metadata);
      const candidates = await this._palaceStore.rankByContext(routingContext, palaces.length || 5);
      const outcome = decideAuditOutcome(palace, candidates, options);

      findings.push({
        drawer_id: drawerId,
        current_palace: palace,
        current_path: normalizePathMetadata(metadata),
        current_routing_confidence: metadata.routing_confidence ?? null,
        needs_review: metadata.needs_review === 1 || metadata.needs_review === true,
        suggested_palace: outcome.suggestedPalace,
        action: outcome.action,
        reason: outcome.reason,
        current_score: outcome.currentScore,
        best_score: outcome.bestScore,
        candidates,
        preview: content.length > 220 ? `${content.slice(0, 220)}...` : content,
      });
    }

    return {
      palace,
      total_scanned: all.ids.length,
      flagged: findings.filter((item) => item.action === 'move' || item.action === 'delete' || item.needs_review),
      findings,
    };
  }

  async queueDrawerDeletion({ drawerId, palace, reason = 'manual_delete', requestedAt = new Date().toISOString() }) {
    const store = await this._getStore(palace);
    const drawer = await store.get({ where: { original_id: drawerId }, limit: 1 });
    if (!drawer.ids.length) {
      return { success: false, error: `Drawer not found: ${drawerId}` };
    }

    const content = drawer.documents[0];
    const metadata = drawer.metadatas[0] || {};

    await store.add({
      ids: [drawerId],
      documents: [content],
      metadatas: [{
        ...metadata,
        sleep_action: SLEEP_ACTION_DELETE,
        sleep_reason: reason,
        delete_requested_at: requestedAt,
      }],
    });

    return {
      success: true,
      drawer_id: drawerId,
      palace,
      status: 'queued_for_sleep_deletion',
      delete_requested_at: requestedAt,
    };
  }

  async flushPendingDeletes(palace, options = {}) {
    const limit = options.limit ?? 100;
    const maxDeletes = options.maxDeletes ?? limit;
    const dryRun = options.dryRun === true;
    const store = await this._getStore(palace);
    const queued = await store.get({ where: { sleep_action: SLEEP_ACTION_DELETE }, limit });
    const selectedIds = queued.ids.slice(0, maxDeletes);
    const deleted = [];

    if (dryRun) {
      return {
        palace,
        dry_run: true,
        pending_delete_count: queued.ids.length,
        deletes_suggested: selectedIds,
      };
    }

    for (const drawerId of selectedIds) {
      await store.delete({ ids: [drawerId] });
      await this._graph.deleteDrawer(drawerId).catch(() => {});
      deleted.push(drawerId);
    }

    return {
      palace,
      dry_run: false,
      pending_delete_count: queued.ids.length,
      deletes_attempted: selectedIds.length,
      deletes_completed: deleted.length,
      deleted_drawer_ids: deleted,
    };
  }

  async moveDrawer({ drawerId, fromPalace, toPalace, reason = 'sleep_consolidation' }) {
    const fromStore = await this._getStore(fromPalace);
    const toStore = await this._getStore(toPalace);
    const drawer = await fromStore.get({ where: { original_id: drawerId }, limit: 1 });
    if (!drawer.ids.length) {
      return { success: false, error: `Drawer not found: ${drawerId}` };
    }

    const content = drawer.documents[0];
    const metadata = drawer.metadatas[0] || {};
    const matchedPath = await findSimilarPath(toStore, content).catch(() => null);
    const targetPath = chooseTargetPath(metadata, matchedPath);
    const clusters = new Neo4jClusterStore(toPalace);
    const ids = await clusters.assign(
      targetPath.wing_name,
      targetPath.hall_name,
      targetPath.room_name,
      targetPath.closet_name,
    );

    const updatedMetadata = {
      ...metadata,
      wing: ids.wingId,
      wing_name: targetPath.wing_name,
      hall: ids.hallId,
      hall_name: targetPath.hall_name,
      room: ids.roomId,
      room_name: targetPath.room_name,
      closet: ids.closetId,
      closet_name: targetPath.closet_name,
      consolidated_from_palace: fromPalace,
      routing_reason: reason,
      routing_confidence: matchedPath?.similarity ?? metadata.routing_confidence ?? null,
      routing_best_palace: toPalace,
      needs_review: 0,
      reviewed_at: new Date().toISOString(),
    };

    await fromStore.delete({ ids: [drawerId] });
    await this._graph.deleteDrawer(drawerId).catch(() => {});

    await toStore.add({
      ids: [drawerId],
      documents: [content],
      metadatas: [updatedMetadata],
    });
    await this._graph.mergeDrawer(toPalace, targetPath.room_name, targetPath.hall_name, drawerId);

    return {
      success: true,
      drawer_id: drawerId,
      from_palace: fromPalace,
      to_palace: toPalace,
      target_path: {
        wing: targetPath.wing_name,
        hall: targetPath.hall_name,
        room: targetPath.room_name,
        closet: targetPath.closet_name,
      },
      matched_similarity: matchedPath?.similarity ?? null,
    };
  }

  async consolidatePalace(palace, options = {}) {
    const audit = await this.auditPalace(palace, options);
    const deleteQueue = audit.findings.filter((item) => item.action === 'delete');
    const flagged = audit.findings.filter((item) => item.action === 'move');
    const maxMoves = options.maxMoves ?? flagged.length;
    const maxDeletes = options.maxDeletes ?? deleteQueue.length;
    const selected = flagged.slice(0, maxMoves);

    if (options.dryRun) {
      return {
        palace,
        dry_run: true,
        scanned: audit.total_scanned,
        deletes_suggested: deleteQueue.slice(0, maxDeletes).map((item) => item.drawer_id),
        moves_suggested: selected.length,
        suggestions: selected,
      };
    }

    const deleteResults = await this.flushPendingDeletes(palace, {
      limit: options.limit,
      maxDeletes,
      dryRun: false,
    });
    const moves = [];
    for (const finding of selected) {
      moves.push(await this.moveDrawer({
        drawerId: finding.drawer_id,
        fromPalace: palace,
        toPalace: finding.suggested_palace,
        reason: finding.reason,
      }));
    }

    return {
      palace,
      dry_run: false,
      scanned: audit.total_scanned,
      deletes_attempted: deleteResults.deletes_attempted,
      deletes_completed: deleteResults.deletes_completed,
      deleted_drawer_ids: deleteResults.deleted_drawer_ids,
      moves_attempted: selected.length,
      moves_completed: moves.filter((item) => item.success).length,
      moves,
    };
  }
}
