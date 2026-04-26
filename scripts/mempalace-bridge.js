#!/usr/bin/env node
/**
 * mempalace-bridge.js — Stop hook ingestor (zero LLM cost, zero embedder)
 *
 * Reads staged JSON files from ~/.claude/mempalace-staging/
 * Each fact includes a pre-computed vector (embedded by the MCP server in Docker).
 * This script only does raw HTTP upserts to Qdrant — no model loading needed.
 *
 * Triggered by Claude Code Stop hook:
 *   ~/.claude/settings.json → hooks.Stop
 *
 * Exits silently on any error so it never blocks Claude Code.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

const STAGING_DIR = path.join(os.homedir(), '.claude', 'mempalace-staging');
const META_PATH   = path.join(STAGING_DIR, '.last-save.json');

// uuidV5 — same logic as vectorStore.js so IDs are consistent
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
function uuidV5(name) {
  const { createHash } = crypto;
  const namespaceBytes = Buffer.from(DNS_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf-8');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
function toQdrantId(id) { return uuidV5(`mempalace.${id}`); }

async function upsertPoint(qdrantUrl, collectionName, id, vector, payload) {
  const url = `${qdrantUrl}/collections/${collectionName}/points?wait=false`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points: [{
        id: toQdrantId(id),
        vector,
        payload: { document: payload.document, original_id: id, ...payload },
      }],
    }),
  });
  if (!res.ok) throw new Error(`Qdrant upsert failed: ${res.status}`);
}

async function ensureCollection(qdrantUrl, collectionName) {
  const checkRes = await fetch(`${qdrantUrl}/collections/${collectionName}`);
  if (checkRes.ok) return;
  await fetch(`${qdrantUrl}/collections/${collectionName}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vectors: { size: 384, distance: 'Cosine' } }),
  });
}

async function main() {
  if (!fs.existsSync(STAGING_DIR)) return;

  const files = fs.readdirSync(STAGING_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (files.length === 0) return;

  const savedItems = [];

  for (const file of files) {
    const filePath = path.join(STAGING_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // corrupt file — skip
    }

    // Use QDRANT_URL from env, then from staging file, then default
    const qdrantUrl = process.env.QDRANT_URL || data.qdrant_url || 'http://localhost:6333';
    let fileFullyIngested = true;

    for (const fact of (data.facts || [])) {
      if (!fact.content || !fact.palace || !fact.vector) {
        // No pre-computed vector → skip (will not re-embed on host)
        if (!fact.vector) fileFullyIngested = false;
        continue;
      }

      try {
        const collectionName = fact.palace;
        await ensureCollection(qdrantUrl, collectionName);

        const id = `bridge_${crypto.randomBytes(8).toString('hex')}`;
        await upsertPoint(qdrantUrl, collectionName, id, fact.vector, {
          document:     fact.content,
          wing:         fact.wing         || 'win_general',
          hall:         fact.hall         || 'hal_general',
          room:         fact.room         || 'roo_general',
          closet:       fact.closet       || 'clo_general',
          topic:        fact.topic        || 'session',
          importance:   Number(fact.importance) || 3,
          project:      fact.project      || '',
          tags:         Array.isArray(fact.tags) ? fact.tags.join(',') : (fact.tags || ''),
          source:       'session',
          session_date: data.staged_at?.split('T')[0] || new Date().toISOString().split('T')[0],
          filed_at:     new Date().toISOString(),
          added_by:     'bridge',
        });

        savedItems.push({ topic: fact.topic, palace: fact.palace });
      } catch {
        fileFullyIngested = false;
      }
    }

    if (fileFullyIngested) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }

  if (savedItems.length === 0) return;

  // Write session summary diary entry to sessions palace
  // Vector is pre-computed by MCP server (toolSessionSummary); bridge has no embedder
  try {
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';

    // Collect diary entries from all staging files (already parsed above)
    const diaryEntries = [];
    for (const file of files) {
      const filePath = path.join(STAGING_DIR, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (data.diary_entry?.content) diaryEntries.push(data.diary_entry);
    }

    for (const de of diaryEntries) {
      const vector = de.vector || new Array(384).fill(0);
      const id = `diary_bridge_${crypto.randomBytes(6).toString('hex')}`;
      await ensureCollection(qdrantUrl, 'sessions');
      await upsertPoint(qdrantUrl, 'sessions', id, vector, {
        document:   de.content,
        wing:       'wing_claude',
        hall:       'hall_diary',
        room:       'diary',
        closet:     'clo_general',
        type:       'diary_entry',
        source:     'bridge',
        topic:      'session-summary',
        importance: 2,
        agent:      'claude',
        filed_at:   new Date().toISOString(),
        date:       new Date().toISOString().split('T')[0],
        added_by:   'bridge',
      });
    }
  } catch {}

  // Write meta file for illuminate's l1_recent_saves
  try {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    fs.writeFileSync(META_PATH, JSON.stringify({
      last_save_date: new Date().toISOString().split('T')[0],
      items_saved:    savedItems.length,
      topics:         [...new Set(savedItems.map(i => i.topic))],
    }, null, 2));
  } catch {}
}

main().catch(() => {});
