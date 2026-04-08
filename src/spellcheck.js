/**
 * spellcheck.js — Spell-correct user messages before palace filing.
 *
 * Preserves:
 *   - Technical terms (words with digits, hyphens, underscores)
 *   - CamelCase and ALL_CAPS identifiers
 *   - Known entity names (from EntityRegistry if available)
 *   - URLs and file paths
 *   - Words shorter than 4 chars (common abbreviations, pronouns, etc.)
 *   - Proper nouns already capitalized in context
 *
 * Corrects:
 *   - Genuine typos in lowercase, flowing text (when a spell library is installed)
 *
 * NOTE: Node.js has no direct equivalent of Python's `autocorrect` library.
 *       The `_shouldSkip` logic is fully implemented.  `spellcheckUserText`
 *       currently returns text unchanged — plug in a spell library (e.g.
 *       nspell, nodehun, typo-js) to enable actual corrections.
 *
 * Usage:
 *   const { spellcheckUserText } = require('./spellcheck');
 *   const corrected = spellcheckUserText("lsresdy knoe the question befor");
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Patterns that mark a token as "don't touch this"
// ─────────────────────────────────────────────────────────────────────────────

// Matches any token with a digit anywhere in it: 3am, bge-large-v1.5, top-10
const _HAS_DIGIT = /\d/;

// CamelCase: ChromaDB, MemPalace, LongMemEval
const _IS_CAMEL = /[A-Z][a-z]+[A-Z]/;

// ALL_CAPS or all-caps with underscores: NDCG, R@5, MAX_RESULTS
const _IS_ALLCAPS = /^[A-Z_@#$%^&*()+=[\]{}|<>?.:/\\]+$/;

// Technical token: contains hyphens or underscores (bge-large, train_test)
const _IS_TECHNICAL = /[-_]/;

// URL-like or file-path-like
const _IS_URL = /https?:\/\/|www\.|\/Users\/|~\/|\.[a-z]{2,4}$/i;

// Code fences, markdown, or emoji-heavy
const _IS_CODE_OR_EMOJI = /[`*_#{}[\]\\]/;

// Very short tokens — skip (I, a, ok, my, etc.)
const _MIN_LENGTH = 4;

// Tokeniser: split on word boundaries but keep punctuation attached
const _TOKEN_RE = /(\S+)/g;

// ─────────────────────────────────────────────────────────────────────────────
// Should-skip logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return true if this token should be left as-is (not spell-corrected).
 *
 * Skips:
 *   - Short words (< 4 chars)
 *   - Words with digits
 *   - CamelCase words
 *   - ALL_CAPS words
 *   - Technical terms (hyphens / underscores)
 *   - URLs and file paths
 *   - Code / markdown tokens
 *   - Known entity names
 *
 * @param {string} token  - single whitespace-delimited token
 * @param {Set<string>} knownNames - lowercase entity names to preserve
 * @returns {boolean}
 */
function _shouldSkip(token, knownNames) {
  if (token.length < _MIN_LENGTH) return true;
  if (_HAS_DIGIT.test(token)) return true;
  if (_IS_CAMEL.test(token)) return true;
  if (_IS_ALLCAPS.test(token)) return true;
  if (_IS_TECHNICAL.test(token)) return true;
  if (_IS_URL.test(token)) return true;
  if (_IS_CODE_OR_EMOJI.test(token)) return true;

  // Known proper names (entity registry)
  if (knownNames && knownNames.has(token.toLowerCase())) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load known entity names from registry (optional, best-effort)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull all registered names from EntityRegistry. Returns empty Set on failure.
 * @returns {Set<string>}
 */
function _loadKnownNames() {
  try {
    const { EntityRegistry } = require("./entityRegistry");
    const reg = EntityRegistry.load();
    const names = new Set();
    const entities = (reg._data && reg._data.entities) || {};
    for (const entity of Object.values(entities)) {
      if (entity.canonical) names.add(entity.canonical.toLowerCase());
      if (Array.isArray(entity.aliases)) {
        for (const alias of entity.aliases) {
          names.add(alias.toLowerCase());
        }
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit distance — useful when a spell library is plugged in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Levenshtein distance between two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _editDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr.push(
        Math.min(
          prev[j + 1] + 1,
          curr[j] + 1,
          prev[j] + (a[i] !== b[j] ? 1 : 0)
        )
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core correction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spell-correct a user message.
 *
 * NOTE: Actual spell correction is a no-op until a spell library is integrated.
 *       The _shouldSkip guard logic is fully functional so that plugging in a
 *       library (e.g. nspell, nodehun, typo-js) only requires adding the
 *       correction call inside the token replacement callback below.
 *
 * @param {string} text - raw user message text
 * @param {Set<string>|null} [knownNames=null] - lowercase names/terms to preserve.
 *        If null, attempts to load from EntityRegistry automatically.
 * @returns {string} corrected text (currently returns original unchanged)
 */
function spellcheckUserText(text, knownNames = null) {
  // TODO: Integrate a Node.js spell-check library (nspell, nodehun, typo-js)
  //       and apply corrections here, similar to the Python autocorrect flow.
  //       The _shouldSkip logic and _editDistance guard are ready to use.

  if (knownNames === null) {
    knownNames = _loadKnownNames();
  }

  // Without a spell library we return text unchanged.
  // When a library is added, uncomment and adapt the token-replacement below:
  //
  // return text.replace(_TOKEN_RE, (token) => {
  //   const stripped = token.replace(/[.,!?;:'")\]]+$/, '');
  //   const punct = token.slice(stripped.length);
  //   if (!stripped || _shouldSkip(stripped, knownNames)) return token;
  //   if (stripped[0] === stripped[0].toUpperCase() && stripped[0] !== stripped[0].toLowerCase()) return token;
  //   const corrected = speller(stripped);  // ← plug spell library here
  //   if (corrected !== stripped) {
  //     const dist = _editDistance(stripped, corrected);
  //     const maxEdits = stripped.length <= 7 ? 2 : 3;
  //     if (dist > maxEdits) return token;
  //   }
  //   return corrected + punct;
  // });

  return text;
}

/**
 * Spell-correct a single transcript line.
 * Only touches lines that start with '>' (user turns).
 * Assistant turns are never modified.
 *
 * @param {string} line
 * @param {Set<string>|null} [knownNames=null]
 * @returns {string}
 */
function spellcheckTranscriptLine(line, knownNames = null) {
  const stripped = line.trimStart();
  if (!stripped.startsWith(">")) return line;

  // '> actual message here'
  const prefixLen = line.length - stripped.length + 2; // '> '
  const message = line.slice(prefixLen);
  if (!message.trim()) return line;

  const corrected = spellcheckUserText(message, knownNames);
  return line.slice(0, prefixLen) + corrected;
}

/**
 * Spell-correct all user turns in a full transcript.
 * Only lines starting with '>' are touched.
 *
 * @param {string} content - full transcript content
 * @param {Set<string>|null} [knownNames=null]
 * @returns {string}
 */
function spellcheckTranscript(content, knownNames = null) {
  const lines = content.split("\n");
  return lines
    .map((line) => spellcheckTranscriptLine(line, knownNames))
    .join("\n");
}

module.exports = {
  spellcheckUserText,
  spellcheckTranscript,
  spellcheckTranscriptLine,
  _shouldSkip,
  _editDistance,
  _loadKnownNames,
};
