import { describe, it, expect } from 'vitest';
import { chunkExchanges, detectConvoRoom } from '../src/convoMiner.js';

describe('ConvoMiner', () => {
  describe('chunkExchanges', () => {
    it('should group Q+A exchange pairs when > markers exist', () => {
      const transcript = [
        '> How do I connect to the database?',
        'You can use the pg library to connect to PostgreSQL.',
        'Here is an example of how to set up the connection pool.',
        '',
        '> What about error handling?',
        'You should wrap all database calls in try-catch blocks.',
        'This ensures errors are properly caught and logged.',
      ].join('\n');

      const chunks = chunkExchanges(transcript);
      expect(chunks.length).toBe(2);
      expect(chunks[0].content).toContain('How do I connect to the database');
      expect(chunks[0].content).toContain('pg library');
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[1].content).toContain('error handling');
      expect(chunks[1].chunkIndex).toBe(1);
    });

    it('should fall back to paragraph chunking when no > markers', () => {
      const transcript = [
        'This is the first paragraph about setting up the project.',
        'It contains important configuration details for the system.',
        '',
        '',
        'This is the second paragraph about deployment steps.',
        'It describes how to deploy the application to production.',
      ].join('\n');

      const chunks = chunkExchanges(transcript);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      chunks.forEach(chunk => {
        expect(chunk).toHaveProperty('content');
        expect(chunk).toHaveProperty('chunkIndex');
      });
    });

    it('should respect minimum chunk size and skip short content', () => {
      const transcript = [
        '> Hi',
        'Hello',
        '',
        '> What is the best approach for implementing a distributed caching system?',
        'You should consider using Redis with a write-through strategy for consistency.',
        'This approach works well for read-heavy workloads with moderate write patterns.',
      ].join('\n');

      const chunks = chunkExchanges(transcript);
      // The first exchange "Hi\nHello" is too short (< 30 chars), should be skipped
      // The second exchange is long enough
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toContain('distributed caching');
    });

    it('should limit AI response lines to 8', () => {
      const lines = [
        '> First question about something interesting?',
        'Short answer here.',
        '> Second question about another topic?',
        'Another short answer.',
        '> Tell me about JavaScript in great detail please?',
      ];
      for (let i = 0; i < 15; i++) {
        lines.push(`This is response line number ${i + 1} with enough content to be meaningful.`);
      }
      const transcript = lines.join('\n');

      const chunks = chunkExchanges(transcript);
      // Find the chunk about JavaScript
      const jsChunk = chunks.find(c => c.content.includes('JavaScript'));
      expect(jsChunk).toBeDefined();
      // Should only include up to 8 AI response lines
      expect(jsChunk.content).not.toContain('line number 9');
    });
  });

  describe('detectConvoRoom', () => {
    it('should classify technical content correctly', () => {
      const text = 'We found a bug in the api code. The function was throwing an error when the database connection failed.';
      expect(detectConvoRoom(text)).toBe('technical');
    });

    it('should classify architecture content correctly', () => {
      const text = 'The design pattern uses a module component with a clean interface. The schema follows the layered architecture approach.';
      expect(detectConvoRoom(text)).toBe('architecture');
    });

    it('should classify planning content correctly', () => {
      const text = 'According to the roadmap, the next milestone is the sprint deadline. We need to plan the backlog for the next requirement spec.';
      expect(detectConvoRoom(text)).toBe('planning');
    });

    it('should classify decisions content correctly', () => {
      const text = 'We decided to switch the approach. We chose this alternative after evaluating the trade-off. We picked option B and migrated the old code.';
      expect(detectConvoRoom(text)).toBe('decisions');
    });

    it('should classify problems content correctly', () => {
      const text = 'There is a problem with the broken build. The crash issue is not resolved yet. We are stuck and need a workaround or a fix.';
      expect(detectConvoRoom(text)).toBe('problems');
    });

    it('should return general for unclassifiable content', () => {
      const text = 'The weather is nice today. I had coffee this morning.';
      expect(detectConvoRoom(text)).toBe('general');
    });

    it('should only consider first 3000 characters', () => {
      const padding = 'a '.repeat(2000);
      const text = padding + 'bug error code api function database';
      // The keywords are beyond 3000 chars
      expect(detectConvoRoom(text)).toBe('general');
    });
  });
});
