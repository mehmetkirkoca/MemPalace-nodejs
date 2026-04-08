/**
 * normalize.js — Convert any chat export format to MemPalace transcript format.
 *
 * Supported:
 *   - Plain text with > markers (pass through)
 *   - Claude Code JSONL
 *   - OpenAI Codex CLI JSONL
 *   - Claude.ai JSON export
 *   - ChatGPT conversations.json
 *   - Slack JSON export
 *   - Plain text (pass through for paragraph chunking)
 */

import fs from 'fs';
import path from 'path';

/**
 * Load a file and normalize to transcript format if it's a chat export.
 * Plain text files pass through unchanged.
 * @param {string} filePath
 * @returns {string}
 */
export function normalize(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new Error(`Could not read ${filePath}: ${e.message}`);
  }

  if (!content.trim()) {
    return content;
  }

  // Already has >= 3 ">" markers — pass through
  const lines = content.split('\n');
  const markerCount = lines.filter(l => l.trim().startsWith('>')).length;
  if (markerCount >= 3) {
    return content;
  }

  // Try JSON normalization
  const ext = path.extname(filePath).toLowerCase();
  const firstChar = content.trim()[0];
  if (['.json', '.jsonl'].includes(ext) || firstChar === '{' || firstChar === '[') {
    const normalized = _tryNormalizeJson(content);
    if (normalized) return normalized;
  }

  return content;
}

/**
 * Try all known JSON chat schemas.
 * @param {string} content
 * @returns {string|null}
 */
function _tryNormalizeJson(content) {
  // JSONL formats first
  let normalized = _tryClaudeCodeJsonl(content);
  if (normalized) return normalized;

  normalized = _tryCodexJsonl(content);
  if (normalized) return normalized;

  // Full JSON formats
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }

  for (const parser of [_tryClaudeAiJson, _tryChatgptJson, _trySlackJson]) {
    normalized = parser(data);
    if (normalized) return normalized;
  }

  return null;
}

/**
 * Claude Code JSONL sessions.
 */
function _tryClaudeCodeJsonl(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const messages = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

    const msgType = entry.type || '';
    const message = entry.message || {};

    if (msgType === 'human' || msgType === 'user') {
      const text = _extractContent(message.content);
      if (text) messages.push({ role: 'user', content: text });
    } else if (msgType === 'assistant') {
      const text = _extractContent(message.content);
      if (text) messages.push({ role: 'assistant', content: text });
    }
  }

  if (messages.length >= 2) return _messagesToTranscript(messages);
  return null;
}

/**
 * OpenAI Codex CLI sessions.
 * Uses only event_msg entries (user_message / agent_message).
 */
function _tryCodexJsonl(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  const messages = [];
  let hasSessionMeta = false;

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

    const entryType = entry.type || '';

    if (entryType === 'session_meta') {
      hasSessionMeta = true;
      continue;
    }

    if (entryType !== 'event_msg') continue;

    const payload = entry.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;

    const payloadType = payload.type || '';
    const msg = payload.message;
    if (typeof msg !== 'string') continue;
    const text = msg.trim();
    if (!text) continue;

    if (payloadType === 'user_message') {
      messages.push({ role: 'user', content: text });
    } else if (payloadType === 'agent_message') {
      messages.push({ role: 'assistant', content: text });
    }
  }

  if (messages.length >= 2 && hasSessionMeta) return _messagesToTranscript(messages);
  return null;
}

/**
 * Claude.ai JSON export: flat messages list or privacy export with chat_messages.
 */
function _tryClaudeAiJson(data) {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    data = data.messages || data.chat_messages || [];
  }
  if (!Array.isArray(data)) return null;

  // Privacy export: array of conversation objects with chat_messages
  if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'chat_messages' in data[0]) {
    const allMessages = [];
    for (const convo of data) {
      if (typeof convo !== 'object' || convo === null) continue;
      const chatMsgs = convo.chat_messages || [];
      for (const item of chatMsgs) {
        if (typeof item !== 'object' || item === null) continue;
        const role = item.role || '';
        const text = _extractContent(item.content);
        if ((role === 'user' || role === 'human') && text) {
          allMessages.push({ role: 'user', content: text });
        } else if ((role === 'assistant' || role === 'ai') && text) {
          allMessages.push({ role: 'assistant', content: text });
        }
      }
    }
    if (allMessages.length >= 2) return _messagesToTranscript(allMessages);
    return null;
  }

  // Flat messages list
  const messages = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const role = item.role || '';
    const text = _extractContent(item.content);
    if ((role === 'user' || role === 'human') && text) {
      messages.push({ role: 'user', content: text });
    } else if ((role === 'assistant' || role === 'ai') && text) {
      messages.push({ role: 'assistant', content: text });
    }
  }
  if (messages.length >= 2) return _messagesToTranscript(messages);
  return null;
}

/**
 * ChatGPT conversations.json with mapping tree.
 */
function _tryChatgptJson(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('mapping' in data)) {
    return null;
  }

  const mapping = data.mapping;
  const messages = [];

  // Find root: prefer node with parent=null AND no message
  let rootId = null;
  let fallbackRoot = null;
  for (const [nodeId, node] of Object.entries(mapping)) {
    if (node.parent === null || node.parent === undefined) {
      if (!node.message) {
        rootId = nodeId;
        break;
      } else if (fallbackRoot === null) {
        fallbackRoot = nodeId;
      }
    }
  }
  if (!rootId) rootId = fallbackRoot;

  if (rootId) {
    let currentId = rootId;
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const node = mapping[currentId] || {};
      const msg = node.message;
      if (msg) {
        const role = (msg.author || {}).role || '';
        const contentObj = msg.content || {};
        const parts = (typeof contentObj === 'object' && !Array.isArray(contentObj))
          ? (contentObj.parts || [])
          : [];
        const text = parts
          .filter(p => typeof p === 'string' && p)
          .join(' ')
          .trim();
        if (role === 'user' && text) {
          messages.push({ role: 'user', content: text });
        } else if (role === 'assistant' && text) {
          messages.push({ role: 'assistant', content: text });
        }
      }
      const children = node.children || [];
      currentId = children.length > 0 ? children[0] : null;
    }
  }

  if (messages.length >= 2) return _messagesToTranscript(messages);
  return null;
}

/**
 * Slack channel export.
 * Alternating speakers are labeled user/assistant to preserve exchange structure.
 */
function _trySlackJson(data) {
  if (!Array.isArray(data)) return null;

  const messages = [];
  const seenUsers = {};
  let lastRole = null;

  for (const item of data) {
    if (typeof item !== 'object' || item === null || item.type !== 'message') continue;
    const userId = item.user || item.username || '';
    const text = (item.text || '').trim();
    if (!text || !userId) continue;

    if (!(userId in seenUsers)) {
      if (Object.keys(seenUsers).length === 0) {
        seenUsers[userId] = 'user';
      } else if (lastRole === 'user') {
        seenUsers[userId] = 'assistant';
      } else {
        seenUsers[userId] = 'user';
      }
    }
    lastRole = seenUsers[userId];
    messages.push({ role: seenUsers[userId], content: text });
  }

  if (messages.length >= 2) return _messagesToTranscript(messages);
  return null;
}

/**
 * Pull text from content — handles string, list of blocks, or dict.
 */
function _extractContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (typeof item === 'object' && item !== null && item.type === 'text') {
        parts.push(item.text || '');
      }
    }
    return parts.join(' ').trim();
  }
  if (typeof content === 'object' && content !== null) {
    return (content.text || '').trim();
  }
  return '';
}

/**
 * Convert [{role, content}, ...] to transcript format with > markers.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
export function _messagesToTranscript(messages) {
  const lines = [];
  let i = 0;
  while (i < messages.length) {
    const { role, content } = messages[i];
    if (role === 'user') {
      lines.push(`> ${content}`);
      if (i + 1 < messages.length && messages[i + 1].role === 'assistant') {
        lines.push(messages[i + 1].content);
        i += 2;
      } else {
        i += 1;
      }
    } else {
      lines.push(content);
      i += 1;
    }
    lines.push('');
  }
  return lines.join('\n');
}
