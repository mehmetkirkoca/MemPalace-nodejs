import { describe, it, expect } from 'vitest';
import { getToolDefinitions, TOOLS, PALACE_PROTOCOL } from '../src/mcpServer.js';

const EXPECTED_TOOL_NAMES = [
  'mempalace_status',
  'mempalace_list_wings',
  'mempalace_list_rooms',
  'mempalace_get_taxonomy',
  'mempalace_search',
  'mempalace_check_duplicate',
  'mempalace_add_drawer',
  'mempalace_delete_drawer',
  'mempalace_kg_query',
  'mempalace_kg_add',
  'mempalace_kg_invalidate',
  'mempalace_kg_timeline',
  'mempalace_kg_stats',
  'mempalace_traverse',
  'mempalace_find_tunnels',
  'mempalace_graph_stats',
  'mempalace_diary_write',
  'mempalace_diary_read',
  'mempalace_guide',
];

describe('getToolDefinitions', () => {
  it('returns 19 tool definitions', () => {
    const tools = getToolDefinitions();
    expect(tools).toHaveLength(19);
  });

  it('contains all expected tool names', () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('each tool has name, description and inputSchema', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
      expect(tool.inputSchema).toHaveProperty('properties');
    }
  });

  it('does not expose handler in public schema', () => {
    const tools = getToolDefinitions();
    for (const tool of tools) {
      expect(tool).not.toHaveProperty('handler');
    }
  });
});

describe('TOOLS internal', () => {
  it('each tool has a handler function', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('tools with required fields are correctly defined', () => {
    const toolMap = {};
    for (const t of TOOLS) toolMap[t.name] = t;

    // search: query required
    expect(toolMap.mempalace_search.inputSchema.required).toContain('query');

    // add_drawer: wing, room, content required
    expect(toolMap.mempalace_add_drawer.inputSchema.required).toEqual(
      expect.arrayContaining(['wing', 'room', 'content'])
    );

    // delete_drawer: drawer_id required
    expect(toolMap.mempalace_delete_drawer.inputSchema.required).toContain('drawer_id');

    // kg_query: entity required
    expect(toolMap.mempalace_kg_query.inputSchema.required).toContain('entity');

    // kg_add: subject, predicate, object required
    expect(toolMap.mempalace_kg_add.inputSchema.required).toEqual(
      expect.arrayContaining(['subject', 'predicate', 'object'])
    );

    // traverse: start_room required
    expect(toolMap.mempalace_traverse.inputSchema.required).toContain('start_room');

    // diary_write: agent_name, entry required
    expect(toolMap.mempalace_diary_write.inputSchema.required).toEqual(
      expect.arrayContaining(['agent_name', 'entry'])
    );

    // diary_read: agent_name required
    expect(toolMap.mempalace_diary_read.inputSchema.required).toContain('agent_name');

    // guide: content required, context and hint_wing optional
    expect(toolMap.mempalace_guide.inputSchema.required).toContain('content');
    expect(toolMap.mempalace_guide.inputSchema.required).not.toContain('context');
    expect(toolMap.mempalace_guide.inputSchema.required).not.toContain('hint_wing');
  });
});

describe('Constants', () => {
  it('PALACE_PROTOCOL is defined and non-empty', () => {
    expect(PALACE_PROTOCOL).toBeTruthy();
    expect(PALACE_PROTOCOL).toContain('MemPalace Memory Protocol');
  });
});
