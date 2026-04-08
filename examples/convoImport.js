#!/usr/bin/env node
/**
 * Example: import Claude Code / ChatGPT conversations.
 *
 * Usage:
 *   node examples/convoImport.js
 */

console.log('Import Claude Code sessions:');
console.log('  mempalace mine ~/claude-sessions/ --mode convos --wing my_project');
console.log();
console.log('Import ChatGPT exports:');
console.log('  mempalace mine ~/chatgpt-exports/ --mode convos');
console.log();
console.log('Use general extractor for richer extraction:');
console.log('  mempalace mine ~/chats/ --mode convos --extract general');
