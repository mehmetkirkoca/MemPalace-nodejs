#!/usr/bin/env node
/**
 * systemTest.js — Observe system behavior
 *
 * Tests the new LLM-categorized taxonomy architecture.
 * No API key needed: wing/hall/room/closet provided directly (simulates MCP mode).
 *
 * Scenarios:
 *   A — Taxonomy building: insert items, show named tree (Neo4j)
 *   B — Search: query and see what comes back (Qdrant)
 *
 * Usage:
 *   node benchmarks/systemTest.js
 *   node benchmarks/systemTest.js --scenario A
 *   node benchmarks/systemTest.js --scenario B
 */

import { Neo4jClusterStore } from '../src/neo4jClusterStore.js';
import { VectorStore } from '../src/vectorStore.js';
import { pipelineSave, pipelineSearch } from '../src/mempalacePipeline.js';

const PALACE = 'bench_system';

// Items with explicit categories (simulates what LLM would decide in MCP mode)
const ITEMS = [
  { content: 'I love cooking pasta with tomato sauce and fresh basil.',
    wing: 'Food & Cooking', hall: 'Italian Cuisine', room: 'Pasta', closet: 'Recipes' },
  { content: 'The best pizza has a thin crust with mozzarella cheese.',
    wing: 'Food & Cooking', hall: 'Italian Cuisine', room: 'Pizza', closet: 'Recipes' },
  { content: 'Sushi is made from vinegared rice and fresh fish.',
    wing: 'Food & Cooking', hall: 'Japanese Cuisine', room: 'Sushi', closet: 'Recipes' },
  { content: 'The basketball game was intense, final score 98-94.',
    wing: 'Sports', hall: 'Team Sports', room: 'Basketball', closet: 'Game Results' },
  { content: 'She scored a goal in the last minute of the soccer match.',
    wing: 'Sports', hall: 'Team Sports', room: 'Soccer', closet: 'Game Results' },
  { content: 'Swimming laps every morning is great cardio exercise.',
    wing: 'Sports', hall: 'Individual Sports', room: 'Swimming', closet: 'Training' },
  { content: 'Neural networks learn by adjusting weights through backpropagation.',
    wing: 'Technology', hall: 'Artificial Intelligence', room: 'Machine Learning', closet: 'Fundamentals' },
  { content: 'TypeScript adds static typing on top of JavaScript.',
    wing: 'Technology', hall: 'Programming', room: 'JavaScript', closet: 'TypeScript' },
  { content: 'React components re-render when state or props change.',
    wing: 'Technology', hall: 'Programming', room: 'JavaScript', closet: 'React' },
  { content: 'The database query took 200ms due to missing index.',
    wing: 'Technology', hall: 'Programming', room: 'Databases', closet: 'Performance' },
];

const QUERIES = [
  { q: "What's a good recipe for pasta?",         expect: 'Food & Cooking' },
  { q: 'Who scored in the soccer match?',          expect: 'Sports' },
  { q: 'How does TypeScript improve JavaScript?',  expect: 'Technology' },
  { q: 'What is backpropagation?',                 expect: 'Technology / AI' },
];

// =============================================================================
// Scenario A — Taxonomy Building (Neo4j)
// =============================================================================

async function scenarioA() {
  const clusters = new Neo4jClusterStore(PALACE);

  console.log('=== Scenario A: Taxonomy Building (Neo4j) ===\n');

  for (const item of ITEMS) {
    const { wingId, hallId, roomId, closetId } = await clusters.assign(
      item.wing, item.hall, item.room, item.closet
    );
    console.log(`  "${item.content.slice(0, 50)}"`);
    console.log(`    → ${item.wing} / ${item.hall} / ${item.room} / ${item.closet}`);
    console.log(`    → ids: ${wingId} / ${hallId} / ${roomId} / ${closetId}`);
    console.log();
  }

  console.log('─'.repeat(60));
  console.log('Taxonomy tree:\n');
  console.log(await clusters.getTaxonomyText());
  console.log();

  const tree = await clusters.getTree();
  const wings = tree.wings.length;
  const halls = tree.wings.reduce((s, w) => s + w.halls.length, 0);
  const rooms = tree.wings.reduce((s, w) => s + w.halls.reduce((hs, h) => hs + h.rooms.length, 0), 0);
  console.log(`Totals: ${wings} wings  ${halls} halls  ${rooms} rooms`);
  console.log();
}

// =============================================================================
// Scenario B — Search (Qdrant)
// =============================================================================

async function scenarioB() {
  const store = new VectorStore({ collectionName: PALACE });
  await store.init();

  console.log('=== Scenario B: Search ===\n');
  console.log('Ingesting 10 items...');

  for (const item of ITEMS) {
    await pipelineSave({
      content:    item.content,
      palaceName: PALACE,
      store,
      addedBy:    'test',
      wing:       item.wing,
      hall:       item.hall,
      room:       item.room,
      closet:     item.closet,
    });
    process.stdout.write('.');
  }
  console.log(' done\n');

  for (const { q, expect } of QUERIES) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`Query:  "${q}"`);
    console.log(`Expect: ${expect}\n`);

    const result = await pipelineSearch({ query: q, store, nResults: 3 });

    for (const r of result.results || []) {
      const sim = (1 - r.similarity).toFixed(3);
      console.log(`  [score=${sim}]  ${r.text.slice(0, 60)}`);
      console.log(`           wing_name=${r.wing_name || '?'}  room_name=${r.room_name || '?'}`);
    }
    console.log();
  }

  console.log(`\n  Collection: ${store._collectionName} (persists in Qdrant)`);
}

// =============================================================================
// Main
// =============================================================================

const idx = process.argv.indexOf('--scenario');
const scenario = idx !== -1 ? process.argv[idx + 1] : 'all';

if (scenario === 'A' || scenario === 'all') await scenarioA();
if (scenario === 'B' || scenario === 'all') await scenarioB();
