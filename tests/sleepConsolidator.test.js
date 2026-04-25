import { describe, it, expect } from 'vitest';
import {
  buildRoutingContext,
  decideAuditOutcome,
  chooseTargetPath,
  SleepConsolidator,
} from '../src/sleepConsolidator.js';

describe('sleepConsolidator helpers', () => {
  it('builds routing context from content and path names', () => {
    const text = buildRoutingContext('Laravel is a PHP framework.', {
      wing_name: 'Technology',
      hall_name: 'Programming',
      room_name: 'PHP',
      closet_name: 'Laravel',
    });

    expect(text).toContain('Laravel is a PHP framework.');
    expect(text).toContain('Technology');
    expect(text).toContain('Programming');
    expect(text).toContain('PHP');
    expect(text).toContain('Laravel');
  });

  it('flags a move when another palace is clearly stronger', () => {
    const decision = decideAuditOutcome('personality_memory_palace', [
      { name: 'news_palace', score: 0.81 },
      { name: 'personality_memory_palace', score: 0.41 },
    ]);

    expect(decision.action).toBe('move');
    expect(decision.suggestedPalace).toBe('news_palace');
  });

  it('keeps the drawer when the current palace still wins', () => {
    const decision = decideAuditOutcome('news_palace', [
      { name: 'news_palace', score: 0.79 },
      { name: 'finance_palace', score: 0.51 },
    ]);

    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('current_palace_best_match');
  });

  it('borrows a matched target path when similarity is high enough', () => {
    const path = chooseTargetPath(
      { wing_name: 'Technology', hall_name: 'Programming', room_name: 'PHP', closet_name: 'Laravel' },
      { wing_name: 'News', hall_name: 'Frameworks', room_name: 'Backend', closet_name: 'Laravel', similarity: 0.91 },
    );

    expect(path.wing_name).toBe('News');
    expect(path.hall_name).toBe('Frameworks');
  });

  it('falls back to the current path when no strong match exists', () => {
    const path = chooseTargetPath(
      { wing_name: 'Technology', hall_name: 'Programming', room_name: 'PHP', closet_name: 'Laravel' },
      { wing_name: 'News', hall_name: 'Frameworks', room_name: 'Backend', closet_name: 'Laravel', similarity: 0.6 },
    );

    expect(path.wing_name).toBe('Technology');
    expect(path.room_name).toBe('PHP');
  });

  it('queues manual deletion and reports it during sleep audit', async () => {
    const records = new Map([
      ['dra_1', {
        content: 'Legacy note',
        metadata: {
          wing_name: 'Technology',
          hall_name: 'Programming',
          room_name: 'PHP',
          closet_name: 'Laravel',
        },
      }],
    ]);

    const store = {
      async init() {},
      async get({ where, limit = 10 } = {}) {
        const entries = [...records.entries()]
          .filter(([id, value]) => !where || Object.entries(where).every(([key, expected]) => {
            if (key === 'original_id') return id === expected;
            return value.metadata[key] === expected;
          }))
          .slice(0, limit);

        return {
          ids: entries.map(([id]) => id),
          documents: entries.map(([, value]) => value.content),
          metadatas: entries.map(([, value]) => value.metadata),
        };
      },
      async add({ ids, documents, metadatas }) {
        ids.forEach((id, index) => {
          records.set(id, { content: documents[index], metadata: metadatas[index] });
        });
      },
      async delete({ ids }) {
        ids.forEach((id) => records.delete(id));
      },
      async query() {
        return { documents: [[]], metadatas: [[]], distances: [[]] };
      },
    };

    const graphDeletes = [];
    const consolidator = new SleepConsolidator({
      palaceStore: {
        async getAll() {
          return [{ name: 'personality_memory_palace' }];
        },
        async rankByContext() {
          return [{ name: 'personality_memory_palace', score: 0.9 }];
        },
      },
      graph: {
        async deleteDrawer(drawerId) {
          graphDeletes.push(drawerId);
        },
      },
      storeFactory: () => store,
    });

    const queued = await consolidator.queueDrawerDeletion({
      drawerId: 'dra_1',
      palace: 'personality_memory_palace',
      reason: 'manual_test',
      requestedAt: '2026-04-25T10:00:00.000Z',
    });

    expect(queued).toEqual(expect.objectContaining({
      success: true,
      status: 'queued_for_sleep_deletion',
    }));

    const audit = await consolidator.auditPalace('personality_memory_palace');
    expect(audit.flagged).toEqual([
      expect.objectContaining({
        drawer_id: 'dra_1',
        action: 'delete',
        reason: 'manual_test',
      }),
    ]);

    const consolidated = await consolidator.consolidatePalace('personality_memory_palace', {
      dryRun: false,
    });

    expect(consolidated.deleted_drawer_ids).toEqual(['dra_1']);
    expect(consolidated.deletes_completed).toBe(1);
    expect(graphDeletes).toEqual(['dra_1']);
    expect(records.has('dra_1')).toBe(false);
  });
});
