/**
 * entityRegistry.js — Persistent personal entity registry for MemPalace.
 *
 * Knows the difference between Riley (a person) and ever (an adverb).
 * Built from three sources, in priority order:
 *   1. Onboarding — what the user explicitly told us
 *   2. Learned — what we inferred from session history with high confidence
 *   3. Researched — what we looked up via Wikipedia for unknown words
 *
 * Usage:
 *   import { EntityRegistry } from './entityRegistry.js';
 *   const registry = EntityRegistry.load();
 *   const result = registry.lookup('Riley', 'I went with Riley today');
 *   // → { type: 'person', confidence: 1.0, source: 'onboarding' }
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// Common English words that could be confused with names
// These get flagged as AMBIGUOUS and require context disambiguation
// ─────────────────────────────────────────────────────────────────────────────

export const COMMON_ENGLISH_WORDS = new Set([
  // Words that are also common personal names
  'ever', 'grace', 'will', 'bill', 'mark', 'april', 'may', 'june',
  'joy', 'hope', 'faith', 'chance', 'chase', 'hunter', 'dash', 'flash',
  'star', 'sky', 'river', 'brook', 'lane', 'art', 'clay', 'gil', 'nat',
  'max', 'rex', 'ray', 'jay', 'rose', 'violet', 'lily', 'ivy', 'ash',
  'reed', 'sage',
  // Words that look like names at start of sentence
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'july', 'august', 'september', 'october',
  'november', 'december',
]);

// Context patterns that indicate a word is being used as a PERSON name
const PERSON_CONTEXT_PATTERNS = [
  '\\b{name}\\s+said\\b',
  '\\b{name}\\s+told\\b',
  '\\b{name}\\s+asked\\b',
  '\\b{name}\\s+laughed\\b',
  '\\b{name}\\s+smiled\\b',
  '\\b{name}\\s+was\\b',
  '\\b{name}\\s+is\\b',
  '\\b{name}\\s+called\\b',
  '\\b{name}\\s+texted\\b',
  '\\bwith\\s+{name}\\b',
  '\\bsaw\\s+{name}\\b',
  '\\bcalled\\s+{name}\\b',
  '\\btook\\s+{name}\\b',
  '\\bpicked\\s+up\\s+{name}\\b',
  '\\bdrop(?:ped)?\\s+(?:off\\s+)?{name}\\b',
  "\\b{name}(?:'s|s')\\b",
  '\\bhey\\s+{name}\\b',
  '\\bthanks?\\s+{name}\\b',
  '^{name}[:\\s]',
  '\\bmy\\s+(?:son|daughter|kid|child|brother|sister|friend|partner|colleague|coworker)\\s+{name}\\b',
];

// Context patterns that indicate a word is NOT being used as a name
const CONCEPT_CONTEXT_PATTERNS = [
  '\\bhave\\s+you\\s+{name}\\b',
  '\\bif\\s+you\\s+{name}\\b',
  '\\b{name}\\s+since\\b',
  '\\b{name}\\s+again\\b',
  '\\bnot\\s+{name}\\b',
  '\\b{name}\\s+more\\b',
  '\\bwould\\s+{name}\\b',
  '\\bcould\\s+{name}\\b',
  '\\bwill\\s+{name}\\b',
  '(?:the\\s+)?{name}\\s+(?:of|in|at|for|to)\\b',
];

// Phrases in Wikipedia summaries that indicate a personal name
const NAME_INDICATOR_PHRASES = [
  'given name', 'personal name', 'first name', 'forename',
  'masculine name', 'feminine name', "boy's name", "girl's name",
  'male name', 'female name', 'irish name', 'welsh name',
  'scottish name', 'gaelic name', 'hebrew name', 'arabic name',
  'norse name', 'old english name', 'is a name', 'as a name',
  'name meaning', 'name derived from', 'legendary irish',
  'legendary welsh', 'legendary scottish',
];

const PLACE_INDICATOR_PHRASES = [
  'city in', 'town in', 'village in', 'municipality',
  'capital of', 'district of', 'county', 'province',
  'region of', 'island of', 'mountain in', 'river in',
];


// ─────────────────────────────────────────────────────────────────────────────
// Wikipedia lookup for unknown words
// ─────────────────────────────────────────────────────────────────────────────

async function _wikipediaLookup(word) {
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MemPalace/1.0' },
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      if (resp.status === 404) {
        return {
          inferredType: 'person',
          confidence: 0.70,
          wikiSummary: null,
          wikiTitle: null,
          note: 'not found in Wikipedia — likely a proper noun or unusual name',
        };
      }
      return { inferredType: 'unknown', confidence: 0.0, wikiSummary: null };
    }

    const data = await resp.json();
    const pageType = data.type || '';
    const extract = (data.extract || '').toLowerCase();
    const title = data.title || word;

    // Disambiguation page
    if (pageType === 'disambiguation') {
      const desc = (data.description || '').toLowerCase();
      if (['name', 'given name'].some(p => desc.includes(p))) {
        return {
          inferredType: 'person',
          confidence: 0.65,
          wikiSummary: extract.slice(0, 200),
          wikiTitle: title,
          note: 'disambiguation page with name entries',
        };
      }
      return {
        inferredType: 'ambiguous',
        confidence: 0.4,
        wikiSummary: extract.slice(0, 200),
        wikiTitle: title,
      };
    }

    // Check for name indicators
    if (NAME_INDICATOR_PHRASES.some(phrase => extract.includes(phrase))) {
      const confidence =
        (extract.includes(`${word.toLowerCase()} is a`) || extract.includes(`${word.toLowerCase()} (name`))
          ? 0.90 : 0.80;
      return {
        inferredType: 'person',
        confidence,
        wikiSummary: extract.slice(0, 200),
        wikiTitle: title,
      };
    }

    // Check for place indicators
    if (PLACE_INDICATOR_PHRASES.some(phrase => extract.includes(phrase))) {
      return {
        inferredType: 'place',
        confidence: 0.80,
        wikiSummary: extract.slice(0, 200),
        wikiTitle: title,
      };
    }

    // Found but doesn't match name/place patterns
    return {
      inferredType: 'concept',
      confidence: 0.60,
      wikiSummary: extract.slice(0, 200),
      wikiTitle: title,
    };
  } catch {
    return { inferredType: 'unknown', confidence: 0.0, wikiSummary: null };
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Entity Registry
// ─────────────────────────────────────────────────────────────────────────────

export class EntityRegistry {
  /**
   * Persistent personal entity registry.
   *
   * Stored at ~/.mempalace/entity_registry.json
   * Schema:
   * {
   *   "mode": "personal",
   *   "version": 1,
   *   "people": { "Riley": { source, contexts, aliases, relationship, confidence } },
   *   "projects": ["MemPalace"],
   *   "ambiguous_flags": ["max"],
   *   "wiki_cache": {}
   * }
   */

  static DEFAULT_PATH = path.join(os.homedir(), '.mempalace', 'entity_registry.json');

  constructor(data, filePath) {
    this._data = data;
    this._path = filePath;
  }

  // ── Load / Save ──────────────────────────────────────────────────────────

  static load(configDir = null) {
    const filePath = configDir
      ? path.join(configDir, 'entity_registry.json')
      : EntityRegistry.DEFAULT_PATH;

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);
        return new EntityRegistry(data, filePath);
      } catch {
        // Corrupt file — start fresh
      }
    }
    return new EntityRegistry(EntityRegistry._empty(), filePath);
  }

  save() {
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2));
  }

  static _empty() {
    return {
      version: 1,
      mode: 'personal',
      people: {},
      projects: [],
      ambiguous_flags: [],
      wiki_cache: {},
    };
  }

  // ── Properties ─────────────────────────────────────────────────────────

  get mode() {
    return this._data.mode || 'personal';
  }

  get people() {
    return this._data.people || {};
  }

  get projects() {
    return this._data.projects || [];
  }

  get ambiguousFlags() {
    return this._data.ambiguous_flags || [];
  }

  // ── Seed from onboarding ───────────────────────────────────────────────

  seed(mode, people, projects, aliases = null) {
    /**
     * Seed the registry from onboarding data.
     *
     * @param {string} mode - 'personal' | 'work' | 'combo'
     * @param {Array<{name: string, relationship: string, context?: string}>} people
     * @param {string[]} projects
     * @param {Object} aliases - e.g. { Max: 'Maxwell' }
     */
    this._data.mode = mode;
    this._data.projects = [...projects];

    aliases = aliases || {};
    const reverseAliases = {};
    for (const [alias, canonical] of Object.entries(aliases)) {
      reverseAliases[canonical] = alias;
    }

    for (const entry of people) {
      const name = entry.name.trim();
      if (!name) continue;
      const context = entry.context || 'personal';
      const relationship = entry.relationship || '';

      this._data.people[name] = {
        source: 'onboarding',
        contexts: [context],
        aliases: reverseAliases[name] ? [reverseAliases[name]] : [],
        relationship,
        confidence: 1.0,
      };

      // Also register aliases
      if (reverseAliases[name]) {
        const alias = reverseAliases[name];
        this._data.people[alias] = {
          source: 'onboarding',
          contexts: [context],
          aliases: [name],
          relationship,
          confidence: 1.0,
          canonical: name,
        };
      }
    }

    // Flag ambiguous names (also common English words)
    const ambiguous = [];
    for (const name of Object.keys(this._data.people)) {
      if (COMMON_ENGLISH_WORDS.has(name.toLowerCase())) {
        ambiguous.push(name.toLowerCase());
      }
    }
    this._data.ambiguous_flags = ambiguous;

    this.save();
  }

  // ── Lookup ─────────────────────────────────────────────────────────────

  lookup(word, context = '') {
    /**
     * Look up a word. Returns entity classification.
     *
     * @param {string} word
     * @param {string} context - surrounding sentence for disambiguation
     * @returns {{ type: string, confidence: number, source: string, name: string, needsDisambiguation: boolean }}
     */

    // 1. Exact match in people registry
    for (const [canonical, info] of Object.entries(this.people)) {
      const aliases = (info.aliases || []).map(a => a.toLowerCase());
      if (word.toLowerCase() === canonical.toLowerCase() || aliases.includes(word.toLowerCase())) {
        // Check if this is an ambiguous word
        if (this.ambiguousFlags.includes(word.toLowerCase()) && context) {
          const resolved = this._disambiguate(word, context, info);
          if (resolved !== null) {
            return resolved;
          }
        }
        return {
          type: 'person',
          confidence: info.confidence,
          source: info.source,
          name: canonical,
          context: info.contexts || ['personal'],
          needsDisambiguation: false,
        };
      }
    }

    // 2. Project match
    for (const proj of this.projects) {
      if (word.toLowerCase() === proj.toLowerCase()) {
        return {
          type: 'project',
          confidence: 1.0,
          source: 'onboarding',
          name: proj,
          needsDisambiguation: false,
        };
      }
    }

    // 3. Wiki cache
    const cache = this._data.wiki_cache || {};
    for (const [cachedWord, cachedResult] of Object.entries(cache)) {
      if (word.toLowerCase() === cachedWord.toLowerCase() && cachedResult.confirmed) {
        return {
          type: cachedResult.inferredType,
          confidence: cachedResult.confidence,
          source: 'wiki',
          name: word,
          needsDisambiguation: false,
        };
      }
    }

    return {
      type: 'unknown',
      confidence: 0.0,
      source: 'none',
      name: word,
      needsDisambiguation: false,
    };
  }

  _disambiguate(word, context, personInfo) {
    /**
     * When a word is both a name and a common word, check context.
     * Returns person result if context suggests a name, null if ambiguous.
     */
    const nameLower = word.toLowerCase();
    const ctxLower = context.toLowerCase();
    const escaped = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Check person context patterns
    let personScore = 0;
    for (const pat of PERSON_CONTEXT_PATTERNS) {
      const regex = new RegExp(pat.replace(/{name}/g, escaped), 'i');
      if (regex.test(ctxLower)) {
        personScore++;
      }
    }

    // Check concept context patterns
    let conceptScore = 0;
    for (const pat of CONCEPT_CONTEXT_PATTERNS) {
      const regex = new RegExp(pat.replace(/{name}/g, escaped), 'i');
      if (regex.test(ctxLower)) {
        conceptScore++;
      }
    }

    if (personScore > conceptScore) {
      return {
        type: 'person',
        confidence: Math.min(0.95, 0.7 + personScore * 0.1),
        source: personInfo.source,
        name: word,
        context: personInfo.contexts || ['personal'],
        needsDisambiguation: false,
        disambiguatedBy: 'context_patterns',
      };
    } else if (conceptScore > personScore) {
      return {
        type: 'concept',
        confidence: Math.min(0.90, 0.7 + conceptScore * 0.1),
        source: 'context_disambiguated',
        name: word,
        needsDisambiguation: false,
        disambiguatedBy: 'context_patterns',
      };
    }

    // Truly ambiguous — return null to fall through to person (registered name)
    return null;
  }

  // ── Research unknown words ─────────────────────────────────────────────

  async research(word, autoConfirm = false) {
    /**
     * Research an unknown word via Wikipedia.
     * Caches result. If autoConfirm=false, marks as unconfirmed.
     */
    const cache = this._data.wiki_cache = this._data.wiki_cache || {};
    if (cache[word]) {
      return cache[word];
    }

    const result = await _wikipediaLookup(word);
    result.word = word;
    result.confirmed = autoConfirm;

    cache[word] = result;
    this.save();
    return result;
  }

  confirmResearch(word, entityType, relationship = '', context = 'personal') {
    /** Mark a researched word as confirmed and add to people registry. */
    const cache = this._data.wiki_cache || {};
    if (cache[word]) {
      cache[word].confirmed = true;
      cache[word].confirmedType = entityType;
    }

    if (entityType === 'person') {
      this._data.people[word] = {
        source: 'wiki',
        contexts: [context],
        aliases: [],
        relationship,
        confidence: 0.90,
      };
      if (COMMON_ENGLISH_WORDS.has(word.toLowerCase())) {
        const flags = this._data.ambiguous_flags = this._data.ambiguous_flags || [];
        if (!flags.includes(word.toLowerCase())) {
          flags.push(word.toLowerCase());
        }
      }
    }

    this.save();
  }

  // ── Learn from sessions ────────────────────────────────────────────────

  learnFromText(text, minConfidence = 0.75) {
    /**
     * Scan session text for new entity candidates.
     * Returns list of newly discovered candidates for review.
     */
    // Dynamic import to avoid circular dependency issues — uses entityDetector
    let extractCandidates, scoreEntity, classifyEntity;
    try {
      // We need to use a synchronous dynamic import pattern
      // entityDetector exports are imported at module level to keep it simple
      const detector = _getEntityDetector();
      extractCandidates = detector.extractCandidates;
      scoreEntity = detector.scoreEntity;
      classifyEntity = detector.classifyEntity;
    } catch {
      // entityDetector not available — return empty
      return [];
    }

    const lines = text.split('\n');
    const candidates = extractCandidates(text);
    const newCandidates = [];

    for (const [name, frequency] of Object.entries(candidates)) {
      // Skip if already known
      if (this.people[name] || this.projects.includes(name)) {
        continue;
      }

      const scores = scoreEntity(name, text, lines);
      const entity = classifyEntity(name, frequency, scores);

      if (entity.type === 'person' && entity.confidence >= minConfidence) {
        this._data.people[name] = {
          source: 'learned',
          contexts: [this.mode !== 'combo' ? this.mode : 'personal'],
          aliases: [],
          relationship: '',
          confidence: entity.confidence,
          seen_count: frequency,
        };
        if (COMMON_ENGLISH_WORDS.has(name.toLowerCase())) {
          const flags = this._data.ambiguous_flags = this._data.ambiguous_flags || [];
          if (!flags.includes(name.toLowerCase())) {
            flags.push(name.toLowerCase());
          }
        }
        newCandidates.push(entity);
      }
    }

    if (newCandidates.length > 0) {
      this.save();
    }

    return newCandidates;
  }

  // ── Query helpers for retrieval ────────────────────────────────────────

  extractPeopleFromQuery(query) {
    /**
     * Extract known person names from a query string.
     * Returns list of canonical names found.
     */
    const found = [];

    for (const [canonical, info] of Object.entries(this.people)) {
      const namesToCheck = [canonical, ...(info.aliases || [])];
      for (const name of namesToCheck) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escaped}\\b`, 'i');
        if (regex.test(query)) {
          // For ambiguous words, check context
          if (this.ambiguousFlags.includes(name.toLowerCase())) {
            const result = this._disambiguate(name, query, info);
            if (result && result.type === 'person') {
              if (!found.includes(canonical)) {
                found.push(canonical);
              }
            }
          } else {
            if (!found.includes(canonical)) {
              found.push(canonical);
            }
          }
        }
      }
    }

    return found;
  }

  extractUnknownCandidates(query) {
    /**
     * Find capitalized words in query that aren't in registry or common words.
     * These are candidates for Wikipedia research.
     */
    const matches = query.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
    const unique = [...new Set(matches)];
    const unknown = [];

    for (const word of unique) {
      if (COMMON_ENGLISH_WORDS.has(word.toLowerCase())) continue;
      const result = this.lookup(word);
      if (result.type === 'unknown') {
        unknown.push(word);
      }
    }

    return unknown;
  }

  // ── Summary ────────────────────────────────────────────────────────────

  summary() {
    const peopleNames = Object.keys(this.people);
    const peopleStr = peopleNames.slice(0, 8).join(', ') +
      (peopleNames.length > 8 ? '...' : '');
    const lines = [
      `Mode: ${this.mode}`,
      `People: ${peopleNames.length} (${peopleStr})`,
      `Projects: ${this.projects.join(', ') || '(none)'}`,
      `Ambiguous flags: ${this.ambiguousFlags.join(', ') || '(none)'}`,
      `Wiki cache: ${Object.keys(this._data.wiki_cache || {}).length} entries`,
    ];
    return lines.join('\n');
  }
}

// ── Lazy loader for entityDetector (avoids circular imports) ─────────────

let _detectorModule = null;

function _getEntityDetector() {
  if (!_detectorModule) {
    // This is a synchronous require — works because entityDetector is already loaded
    // In ESM we need to use a different approach
    throw new Error('entityDetector not loaded');
  }
  return _detectorModule;
}

/**
 * Initialize the entity detector reference.
 * Call this once at app startup if learnFromText is needed.
 */
export function initEntityDetector(detectorModule) {
  _detectorModule = detectorModule;
}
