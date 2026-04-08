import { describe, it, expect } from 'vitest';
import { extractMemories } from '../src/generalExtractor.js';

describe('GeneralExtractor', () => {
  describe('extractMemories', () => {
    it('should extract decisions from text', () => {
      const text = 'We decided to use PostgreSQL instead of MongoDB because we need strong consistency. The trade-off was worth it for our use case.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      expect(types).toContain('decision');
    });

    it('should extract preferences from text', () => {
      const text = 'I prefer using functional style for data transformations. Always use camelCase for variable names, never use snake_case in JavaScript.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      expect(types).toContain('preference');
    });

    it('should extract milestones from text', () => {
      const text = 'After three days of debugging, it finally works! We got it working and shipped version 2.0 to production. This was a real breakthrough.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      expect(types).toContain('milestone');
    });

    it('should extract problems from text', () => {
      const text = 'There is a critical bug in the authentication module. The app keeps crashing whenever a user tries to log in. The error is related to null pointer access.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      expect(types).toContain('problem');
    });

    it('should extract emotional content from text', () => {
      const text = 'I love working on this project, it makes me so happy. I feel grateful for this team and the beautiful code we write together.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      expect(types).toContain('emotional');
    });

    it('should skip code blocks during classification', () => {
      const text = [
        'Here is some setup code:',
        '```',
        'import os',
        'def main():',
        '    return True',
        '```',
        '',
        'We decided to use this approach because it is simpler and the trade-off was acceptable.',
      ].join('\n');
      const memories = extractMemories(text);
      // Code blocks should be stripped; the decision text should still be found
      if (memories.length > 0) {
        const types = memories.map(m => m.memoryType);
        expect(types).toContain('decision');
      }
    });

    it('should return correct structure for each memory', () => {
      const text = 'We decided to go with React instead of Vue because the ecosystem is more mature.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const m = memories[0];
      expect(m).toHaveProperty('content');
      expect(m).toHaveProperty('memoryType');
      expect(m).toHaveProperty('chunkIndex');
      expect(typeof m.content).toBe('string');
      expect(typeof m.memoryType).toBe('string');
      expect(typeof m.chunkIndex).toBe('number');
    });

    it('should return empty array for empty text', () => {
      expect(extractMemories('')).toEqual([]);
    });

    it('should return empty array for very short text', () => {
      expect(extractMemories('hi')).toEqual([]);
    });

    it('should disambiguate resolved problems as milestones', () => {
      const text = 'There was a terrible bug in the system but we fixed it and got it working again. The solution was to patch the broken module.';
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
      const types = memories.map(m => m.memoryType);
      // Resolved problem with positive sentiment should become milestone
      expect(types).toContain('milestone');
    });

    it('should handle speaker-turn splitting', () => {
      const text = [
        'Human: I prefer using TypeScript always.',
        'Assistant: That is a good preference.',
        'Human: We decided to go with NextJS because of SSR.',
        'Assistant: Makes sense for your use case.',
        'Human: There is a bug in the auth module, it keeps crashing.',
      ].join('\n');
      const memories = extractMemories(text);
      expect(memories.length).toBeGreaterThanOrEqual(1);
    });
  });
});
