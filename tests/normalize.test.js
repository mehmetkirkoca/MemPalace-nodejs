import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { normalize } from '../src/normalize.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'normalize-test-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(name, content) {
  const fp = path.join(tmpDir, name);
  fs.writeFileSync(fp, content, 'utf-8');
  return fp;
}

describe('normalize', () => {
  describe('plain text passthrough', () => {
    it('should pass through text with >= 3 ">" markers unchanged', () => {
      const text = '> hello\nassistant reply\n\n> second\nreply2\n\n> third\nreply3\n';
      const fp = writeTmp('plain.txt', text);
      expect(normalize(fp)).toBe(text);
    });

    it('should pass through plain text without markers unchanged', () => {
      const text = 'This is just a plain paragraph.\nWith some lines.\n';
      const fp = writeTmp('plain2.txt', text);
      expect(normalize(fp)).toBe(text);
    });
  });

  describe('empty/invalid files', () => {
    it('should handle empty file gracefully', () => {
      const fp = writeTmp('empty.txt', '');
      expect(normalize(fp)).toBe('');
    });

    it('should handle whitespace-only file', () => {
      const fp = writeTmp('whitespace.txt', '   \n  \n  ');
      expect(normalize(fp)).toBe('   \n  \n  ');
    });

    it('should throw on non-existent file', () => {
      expect(() => normalize('/tmp/nonexistent-file-xyz.txt')).toThrow();
    });
  });

  describe('Claude Code JSONL', () => {
    it('should normalize Claude Code JSONL format', () => {
      const lines = [
        JSON.stringify({ type: 'human', message: { content: 'Hello Claude' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Hi there!' } }),
        JSON.stringify({ type: 'human', message: { content: 'How are you?' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'I am fine.' } }),
      ];
      const fp = writeTmp('claude-code.jsonl', lines.join('\n'));
      const result = normalize(fp);
      expect(result).toContain('> Hello Claude');
      expect(result).toContain('Hi there!');
      expect(result).toContain('> How are you?');
      expect(result).toContain('I am fine.');
    });

    it('should handle "user" type as human', () => {
      const lines = [
        JSON.stringify({ type: 'user', message: { content: 'Test' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'Response' } }),
      ];
      const fp = writeTmp('claude-code2.jsonl', lines.join('\n'));
      const result = normalize(fp);
      expect(result).toContain('> Test');
      expect(result).toContain('Response');
    });
  });

  describe('ChatGPT JSON', () => {
    it('should normalize ChatGPT mapping tree format', () => {
      const data = {
        title: 'Test Conversation',
        mapping: {
          'root-id': {
            id: 'root-id',
            parent: null,
            message: null,
            children: ['msg-1'],
          },
          'msg-1': {
            id: 'msg-1',
            parent: 'root-id',
            message: {
              author: { role: 'user' },
              content: { parts: ['What is JS?'] },
            },
            children: ['msg-2'],
          },
          'msg-2': {
            id: 'msg-2',
            parent: 'msg-1',
            message: {
              author: { role: 'assistant' },
              content: { parts: ['JavaScript is a programming language.'] },
            },
            children: [],
          },
        },
      };
      const fp = writeTmp('chatgpt.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> What is JS?');
      expect(result).toContain('JavaScript is a programming language.');
    });

    it('should handle fallback root (root with message)', () => {
      const data = {
        mapping: {
          'root-id': {
            id: 'root-id',
            parent: null,
            message: { author: { role: 'system' }, content: { parts: ['sys'] } },
            children: ['msg-1'],
          },
          'msg-1': {
            id: 'msg-1',
            parent: 'root-id',
            message: { author: { role: 'user' }, content: { parts: ['hi'] } },
            children: ['msg-2'],
          },
          'msg-2': {
            id: 'msg-2',
            parent: 'msg-1',
            message: { author: { role: 'assistant' }, content: { parts: ['hello'] } },
            children: [],
          },
        },
      };
      const fp = writeTmp('chatgpt2.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> hi');
      expect(result).toContain('hello');
    });
  });

  describe('Claude.ai JSON', () => {
    it('should normalize flat messages array', () => {
      const data = [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ];
      const fp = writeTmp('claude-ai.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> Question');
      expect(result).toContain('Answer');
    });

    it('should normalize privacy export with chat_messages', () => {
      const data = [
        {
          chat_messages: [
            { role: 'human', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
          ],
        },
      ];
      const fp = writeTmp('claude-privacy.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> Hi');
      expect(result).toContain('Hello');
    });

    it('should handle content as list of blocks', () => {
      const data = [
        { role: 'user', content: [{ type: 'text', text: 'Block content' }] },
        { role: 'assistant', content: 'Reply' },
      ];
      const fp = writeTmp('claude-blocks.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> Block content');
    });
  });

  describe('Slack JSON', () => {
    it('should normalize Slack messages', () => {
      const data = [
        { type: 'message', user: 'U001', text: 'Hey team' },
        { type: 'message', user: 'U002', text: 'Hi there' },
        { type: 'message', user: 'U001', text: 'How goes?' },
        { type: 'message', user: 'U002', text: 'Good!' },
      ];
      const fp = writeTmp('slack.json', JSON.stringify(data));
      const result = normalize(fp);
      expect(result).toContain('> Hey team');
      expect(result).toContain('Hi there');
    });
  });

  describe('OpenAI Codex JSONL', () => {
    it('should normalize Codex JSONL with session_meta and event_msg', () => {
      const lines = [
        JSON.stringify({ type: 'session_meta', session_id: 'abc' }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Do something' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Done!' } }),
      ];
      const fp = writeTmp('codex.jsonl', lines.join('\n'));
      const result = normalize(fp);
      expect(result).toContain('> Do something');
      expect(result).toContain('Done!');
    });

    it('should require session_meta for Codex detection', () => {
      const lines = [
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Test' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Reply' } }),
      ];
      const fp = writeTmp('codex-no-meta.jsonl', lines.join('\n'));
      const result = normalize(fp);
      // Without session_meta, codex parser should NOT match
      expect(result).not.toContain('> Test');
    });
  });

  describe('format auto-detection', () => {
    it('should detect format by content, not just extension', () => {
      // Claude Code JSONL with .txt extension
      const lines = [
        JSON.stringify({ type: 'human', message: { content: 'Q1' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'A1' } }),
      ];
      const fp = writeTmp('mystery.txt', lines.join('\n'));
      const result = normalize(fp);
      // .txt but content starts with {, should try JSON normalization
      expect(result).toContain('> Q1');
      expect(result).toContain('A1');
    });

    it('should return less than 3 markers as JSONL if parseable', () => {
      // Only 1 ">" marker — not enough for passthrough, but valid JSONL
      const lines = [
        JSON.stringify({ type: 'human', message: { content: 'One question' } }),
        JSON.stringify({ type: 'assistant', message: { content: 'One answer' } }),
      ];
      const fp = writeTmp('few-markers.jsonl', lines.join('\n'));
      const result = normalize(fp);
      expect(result).toContain('> One question');
    });
  });
});
