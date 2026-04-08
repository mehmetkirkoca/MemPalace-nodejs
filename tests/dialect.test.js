import { describe, it, expect } from 'vitest';
import { Dialect, EMOTION_CODES } from '../src/dialect.js';

describe('Dialect', () => {
  describe('encodeEntity', () => {
    it('should return 3-letter code for known entity', () => {
      const d = new Dialect({ Alice: 'ALC', Bob: 'BOB' });
      expect(d.encodeEntity('Alice')).toBe('ALC');
      expect(d.encodeEntity('Bob')).toBe('BOB');
    });

    it('should return 3-letter code case-insensitively', () => {
      const d = new Dialect({ Alice: 'ALC' });
      expect(d.encodeEntity('alice')).toBe('ALC');
    });

    it('should auto-code unknown entities from first 3 chars', () => {
      const d = new Dialect();
      expect(d.encodeEntity('Charlie')).toBe('CHA');
      expect(d.encodeEntity('Dr. Smith')).toBe('DR.');
    });

    it('should return null for skipped names', () => {
      const d = new Dialect({}, ['Gandalf']);
      expect(d.encodeEntity('Gandalf')).toBeNull();
    });

    it('should match partial entity names', () => {
      const d = new Dialect({ 'Dr. Chen': 'CHN' });
      expect(d.encodeEntity('Dr. Chen Wang')).toBe('CHN');
    });
  });

  describe('detectEmotions', () => {
    it('should detect emotions from text keywords', () => {
      const d = new Dialect();
      const emotions = d.detectEmotions('I was worried and excited about the future');
      expect(emotions).toContain('anx');
      expect(emotions).toContain('excite');
    });

    it('should return at most 3 emotions', () => {
      const d = new Dialect();
      const text = 'I was worried, excited, frustrated, confused, and surprised';
      const emotions = d.detectEmotions(text);
      expect(emotions.length).toBeLessThanOrEqual(3);
    });

    it('should return empty array for neutral text', () => {
      const d = new Dialect();
      const emotions = d.detectEmotions('The table has four legs');
      expect(emotions).toEqual([]);
    });

    it('should not return duplicate emotion codes', () => {
      const d = new Dialect();
      const emotions = d.detectEmotions('worried and anxious about everything');
      const unique = [...new Set(emotions)];
      expect(emotions.length).toBe(unique.length);
    });
  });

  describe('detectFlags', () => {
    it('should detect DECISION flag', () => {
      const d = new Dialect();
      const flags = d.detectFlags('We decided to use GraphQL instead of REST');
      expect(flags).toContain('DECISION');
    });

    it('should detect ORIGIN flag', () => {
      const d = new Dialect();
      const flags = d.detectFlags('The company was founded in 2020');
      expect(flags).toContain('ORIGIN');
    });

    it('should detect TECHNICAL flag', () => {
      const d = new Dialect();
      const flags = d.detectFlags('The database architecture needs redesign');
      expect(flags).toContain('TECHNICAL');
    });

    it('should detect PIVOT flag', () => {
      const d = new Dialect();
      const flags = d.detectFlags('That was the turning point when I realized');
      expect(flags).toContain('PIVOT');
    });

    it('should detect CORE flag', () => {
      const d = new Dialect();
      const flags = d.detectFlags('This is a fundamental principle we believe in');
      expect(flags).toContain('CORE');
    });

    it('should return at most 3 flags', () => {
      const d = new Dialect();
      const text = 'We decided to deploy the database architecture as a core fundamental turning point';
      const flags = d.detectFlags(text);
      expect(flags.length).toBeLessThanOrEqual(3);
    });
  });

  describe('extractTopics', () => {
    it('should extract key topic words', () => {
      const d = new Dialect();
      const topics = d.extractTopics('GraphQL provides better performance than REST API');
      expect(topics.length).toBeGreaterThan(0);
      expect(topics.length).toBeLessThanOrEqual(3);
    });

    it('should skip stop words', () => {
      const d = new Dialect();
      const topics = d.extractTopics('The quick brown fox jumps over the lazy dog');
      expect(topics).not.toContain('the');
      expect(topics).not.toContain('over');
    });

    it('should boost proper nouns and technical terms', () => {
      const d = new Dialect();
      const topics = d.extractTopics('Alice uses GraphQL for the project implementation');
      // GraphQL and Alice should be boosted due to capitalization
      expect(topics[0]).toMatch(/graphql|alice/i);
    });
  });

  describe('compress', () => {
    it('should produce AAAK formatted output', () => {
      const d = new Dialect({ Alice: 'ALC' });
      const text = 'Alice decided to use GraphQL instead of REST because it was better for the architecture';
      const result = d.compress(text);
      expect(result).toContain('|');
      expect(result).toContain('ALC');
    });

    it('should reduce text size', () => {
      const d = new Dialect();
      const text = 'We decided to use GraphQL instead of REST because it provides better performance for our use case. The architecture team reviewed several options and concluded that GraphQL would be the best fit.';
      const result = d.compress(text);
      expect(result.length).toBeLessThan(text.length);
    });

    it('should include header when metadata is provided', () => {
      const d = new Dialect();
      const text = 'Some important text about decisions';
      const result = d.compress(text, { wing: 'tech', room: 'api', date: '2024-01', source_file: 'notes.txt' });
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toContain('tech');
    });

    it('should work without metadata', () => {
      const d = new Dialect();
      const text = 'Simple text with no metadata';
      const result = d.compress(text);
      expect(result).toBeTruthy();
      expect(result).toContain('|');
    });
  });

  describe('compressionStats', () => {
    it('should return valid ratio', () => {
      const d = new Dialect();
      const original = 'We decided to use GraphQL instead of REST because it provides better performance for our use case. The architecture team reviewed several options.';
      const compressed = d.compress(original);
      const stats = d.compressionStats(original, compressed);

      expect(stats.original_tokens_est).toBeGreaterThan(0);
      expect(stats.summary_tokens_est).toBeGreaterThan(0);
      expect(stats.size_ratio).toBeGreaterThanOrEqual(1);
      expect(stats.original_chars).toBe(original.length);
      expect(stats.summary_chars).toBe(compressed.length);
      expect(stats.note).toBeTruthy();
    });

    it('should show compression ratio > 1 for reasonable text', () => {
      const d = new Dialect();
      const original = 'Alice and Bob decided to migrate the entire database infrastructure from MySQL to PostgreSQL. They realized that the performance characteristics of PostgreSQL would better serve their growing needs. This was a turning point for the team.';
      const compressed = d.compress(original);
      const stats = d.compressionStats(original, compressed);
      expect(stats.size_ratio).toBeGreaterThan(1);
    });
  });

  describe('countTokens', () => {
    it('should approximate token count', () => {
      const d = new Dialect();
      const text = 'hello world this is a test';
      const tokens = Dialect.countTokens(text);
      expect(tokens).toBeGreaterThan(0);
      // ~6 words * 1.3 ≈ 7-8
      expect(tokens).toBeGreaterThanOrEqual(6);
      expect(tokens).toBeLessThanOrEqual(10);
    });

    it('should return at least 1 for empty-ish text', () => {
      expect(Dialect.countTokens('')).toBe(1);
      expect(Dialect.countTokens('x')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('encodeEmotions', () => {
    it('should convert emotion names to codes', () => {
      const d = new Dialect();
      expect(d.encodeEmotions(['vulnerability', 'joy'])).toBe('vul+joy');
    });

    it('should limit to 3 emotions', () => {
      const d = new Dialect();
      const result = d.encodeEmotions(['joy', 'fear', 'trust', 'grief']);
      const parts = result.split('+');
      expect(parts.length).toBeLessThanOrEqual(3);
    });

    it('should deduplicate emotion codes', () => {
      const d = new Dialect();
      const result = d.encodeEmotions(['vulnerability', 'vulnerable']);
      expect(result).toBe('vul');
    });

    it('should use first 4 chars for unknown emotions', () => {
      const d = new Dialect();
      const result = d.encodeEmotions(['nostalgia']);
      expect(result).toBe('nost');
    });
  });

  describe('decode', () => {
    it('should parse AAAK dialect back into structured data', () => {
      const d = new Dialect();
      const aaak = '001|ALC+BOB|2024-01|test_file\nARC:joy->fear->hope\n0:ALC|topics|"key quote"|0.8|joy|DECISION\nT:01<->02|related';
      const result = d.decode(aaak);
      expect(result.header.file).toBe('001');
      expect(result.header.entities).toBe('ALC+BOB');
      expect(result.arc).toBe('joy->fear->hope');
      expect(result.zettels.length).toBe(1);
      expect(result.tunnels.length).toBe(1);
    });
  });

  describe('EMOTION_CODES', () => {
    it('should have 29 unique emotion codes', () => {
      const uniqueCodes = new Set(Object.values(EMOTION_CODES));
      expect(uniqueCodes.size).toBe(29);
    });
  });
});
