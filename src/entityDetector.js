/**
 * entityDetector.js — Auto-detect people and projects from file content.
 *
 * Two-pass approach:
 *   Pass 1: scan files, extract entity candidates with signal counts
 *   Pass 2: score and classify each candidate as person, project, or uncertain
 *
 * Used by mempalace init before mining begins.
 * The confirmed entity map feeds the miner as the taxonomy.
 */

import fs from 'fs';
import path from 'path';

// ==================== SIGNAL PATTERNS ====================

// Person signals — things people do
const PERSON_VERB_PATTERNS = [
  '\\b{name}\\s+said\\b',
  '\\b{name}\\s+asked\\b',
  '\\b{name}\\s+told\\b',
  '\\b{name}\\s+replied\\b',
  '\\b{name}\\s+laughed\\b',
  '\\b{name}\\s+smiled\\b',
  '\\b{name}\\s+cried\\b',
  '\\b{name}\\s+felt\\b',
  '\\b{name}\\s+thinks?\\b',
  '\\b{name}\\s+wants?\\b',
  '\\b{name}\\s+loves?\\b',
  '\\b{name}\\s+hates?\\b',
  '\\b{name}\\s+knows?\\b',
  '\\b{name}\\s+decided\\b',
  '\\b{name}\\s+pushed\\b',
  '\\b{name}\\s+wrote\\b',
  '\\bhey\\s+{name}\\b',
  '\\bthanks?\\s+{name}\\b',
  '\\bhi\\s+{name}\\b',
  '\\bdear\\s+{name}\\b',
];

// Person signals — pronouns resolving nearby
const PRONOUN_PATTERNS = [
  /\bshe\b/i,
  /\bher\b/i,
  /\bhers\b/i,
  /\bhe\b/i,
  /\bhim\b/i,
  /\bhis\b/i,
  /\bthey\b/i,
  /\bthem\b/i,
  /\btheir\b/i,
];

// Person signals — dialogue markers
const DIALOGUE_PATTERNS = [
  '^>\\s*{name}[:\\s]',   // > Speaker: ...
  '^{name}:\\s',           // Speaker: ...
  '^\\[{name}\\]',         // [Speaker]
  '"{name}\\s+said',
];

// Project signals — things projects have/do
const PROJECT_VERB_PATTERNS = [
  '\\bbuilding\\s+{name}\\b',
  '\\bbuilt\\s+{name}\\b',
  '\\bship(?:ping|ped)?\\s+{name}\\b',
  '\\blaunch(?:ing|ed)?\\s+{name}\\b',
  '\\bdeploy(?:ing|ed)?\\s+{name}\\b',
  '\\binstall(?:ing|ed)?\\s+{name}\\b',
  '\\bthe\\s+{name}\\s+architecture\\b',
  '\\bthe\\s+{name}\\s+pipeline\\b',
  '\\bthe\\s+{name}\\s+system\\b',
  '\\bthe\\s+{name}\\s+repo\\b',
  '\\b{name}\\s+v\\d+\\b',
  '\\b{name}\\.py\\b',
  '\\b{name}-core\\b',
  '\\b{name}-local\\b',
  '\\bimport\\s+{name}\\b',
  '\\bpip\\s+install\\s+{name}\\b',
];

// Words that are almost certainly NOT entities
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'our', 'you', 'your', 'i', 'my', 'me', 'he', 'she', 'his', 'her',
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'if', 'then', 'so', 'not', 'no', 'yes', 'ok', 'okay',
  'just', 'very', 'really', 'also', 'already', 'still', 'even', 'only',
  'here', 'there', 'now', 'too', 'up', 'out', 'about',
  'like', 'use', 'get', 'got', 'make', 'made', 'take', 'put', 'come', 'go',
  'see', 'know', 'think', 'true', 'false', 'none', 'null', 'new', 'old',
  'all', 'any', 'some', 'return', 'print', 'def', 'class', 'import',
  // Common capitalized words in prose that aren't entities
  'step', 'usage', 'run', 'check', 'find', 'add', 'get', 'set', 'list',
  'args', 'dict', 'str', 'int', 'bool', 'path', 'file', 'type', 'name',
  'note', 'example', 'option', 'result', 'error', 'warning', 'info',
  'every', 'each', 'more', 'less', 'next', 'last', 'first', 'second',
  'stack', 'layer', 'mode', 'test', 'stop', 'start', 'copy', 'move',
  'source', 'target', 'output', 'input', 'data', 'item', 'key', 'value',
  'returns', 'raises', 'yields', 'self', 'cls', 'kwargs',
  // Common sentence-starting / abstract words
  'world', 'well', 'want', 'topic', 'choose', 'social', 'cars', 'phones',
  'healthcare', 'ex', 'machina', 'deus', 'human', 'humans', 'people',
  'things', 'something', 'nothing', 'everything', 'anything',
  'someone', 'everyone', 'anyone',
  'way', 'time', 'day', 'life', 'place', 'thing', 'part', 'kind', 'sort',
  'case', 'point', 'idea', 'fact', 'sense', 'question', 'answer', 'reason',
  'number', 'version', 'system',
  // Greetings and filler
  'hey', 'hi', 'hello', 'thanks', 'thank', 'right', 'let', 'ok',
  // UI/action words
  'click', 'hit', 'press', 'tap', 'drag', 'drop', 'open', 'close',
  'save', 'load', 'launch', 'install', 'download', 'upload', 'scroll',
  'select', 'enter', 'submit', 'cancel', 'confirm', 'delete', 'copy',
  'paste', 'type', 'write', 'read', 'search', 'find', 'show', 'hide',
  // Common filesystem/technical
  'desktop', 'documents', 'downloads', 'users', 'home', 'library',
  'applications', 'system', 'preferences', 'settings', 'terminal',
  // Abstract/topic words
  'actor', 'vector', 'remote', 'control', 'duration', 'fetch',
  // Abstract concepts
  'agents', 'tools', 'others', 'guards', 'ethics', 'regulation',
  'learning', 'thinking', 'memory', 'language', 'intelligence',
  'technology', 'society', 'culture', 'future', 'history', 'science',
  'model', 'models', 'network', 'networks', 'training', 'inference',
]);

// For entity detection — prose only, no code files
const PROSE_EXTENSIONS = new Set(['.txt', '.md', '.rst', '.csv']);

const READABLE_EXTENSIONS = new Set([
  '.txt', '.md', '.py', '.js', '.ts', '.json', '.yaml', '.yml',
  '.csv', '.rst', '.toml', '.sh', '.rb', '.go', '.rs',
]);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.next', 'coverage', '.mempalace',
]);


// ==================== CANDIDATE EXTRACTION ====================

/**
 * Extract all capitalized proper noun candidates from text.
 * Returns {name: frequency} for names appearing 3+ times.
 */
export function extractCandidates(text) {
  const counts = new Map();

  // Find all capitalized words
  const rawRegex = /\b([A-Z][a-z]{1,19})\b/g;
  let match;
  while ((match = rawRegex.exec(text)) !== null) {
    const word = match[1];
    if (!STOPWORDS.has(word.toLowerCase()) && word.length > 1) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }

  // Also find multi-word proper nouns (e.g. "Memory Palace", "Claude Code")
  const multiRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  while ((match = multiRegex.exec(text)) !== null) {
    const phrase = match[1];
    const words = phrase.split(/\s+/);
    if (!words.some(w => STOPWORDS.has(w.toLowerCase()))) {
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }

  // Filter: must appear at least 3 times
  const result = {};
  for (const [name, count] of counts) {
    if (count >= 3) {
      result[name] = count;
    }
  }
  return result;
}


// ==================== SIGNAL SCORING ====================

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pre-compile all regex patterns for a single entity name.
 */
function _buildPatterns(name) {
  const n = escapeRegExp(name);

  return {
    dialogue: DIALOGUE_PATTERNS.map(
      p => new RegExp(p.replace(/\{name\}/g, n), 'gmi')
    ),
    person_verbs: PERSON_VERB_PATTERNS.map(
      p => new RegExp(p.replace(/\{name\}/g, n), 'gi')
    ),
    project_verbs: PROJECT_VERB_PATTERNS.map(
      p => new RegExp(p.replace(/\{name\}/g, n), 'gi')
    ),
    direct: new RegExp(`\\bhey\\s+${n}\\b|\\bthanks?\\s+${n}\\b|\\bhi\\s+${n}\\b`, 'gi'),
    versioned: new RegExp(`\\b${n}[-v]\\w+`, 'gi'),
    code_ref: new RegExp(`\\b${n}\\.(py|js|ts|yaml|yml|json|sh)\\b`, 'gi'),
  };
}

/**
 * Score a candidate entity as person vs project.
 * Returns scores and the signals that fired.
 */
export function scoreEntity(name, text, lines) {
  const patterns = _buildPatterns(name);
  let person_score = 0;
  let project_score = 0;
  const person_signals = [];
  const project_signals = [];

  // --- Person signals ---

  // Dialogue markers (strong signal)
  for (const rx of patterns.dialogue) {
    rx.lastIndex = 0;
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      person_score += matches * 3;
      person_signals.push(`dialogue marker (${matches}x)`);
    }
  }

  // Person verbs
  for (const rx of patterns.person_verbs) {
    rx.lastIndex = 0;
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      person_score += matches * 2;
      person_signals.push(`'${name} ...' action (${matches}x)`);
    }
  }

  // Pronoun proximity — pronouns within 3 lines of the name
  const nameLower = name.toLowerCase();
  const nameLineIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(nameLower)) {
      nameLineIndices.push(i);
    }
  }

  let pronounHits = 0;
  for (const idx of nameLineIndices) {
    const windowStart = Math.max(0, idx - 2);
    const windowEnd = Math.min(lines.length, idx + 3);
    const windowText = lines.slice(windowStart, windowEnd).join(' ').toLowerCase();
    for (const pronounPattern of PRONOUN_PATTERNS) {
      if (pronounPattern.test(windowText)) {
        pronounHits++;
        break;
      }
    }
  }
  if (pronounHits > 0) {
    person_score += pronounHits * 2;
    person_signals.push(`pronoun nearby (${pronounHits}x)`);
  }

  // Direct address
  patterns.direct.lastIndex = 0;
  const direct = (text.match(patterns.direct) || []).length;
  if (direct > 0) {
    person_score += direct * 4;
    person_signals.push(`addressed directly (${direct}x)`);
  }

  // --- Project signals ---

  for (const rx of patterns.project_verbs) {
    rx.lastIndex = 0;
    const matches = (text.match(rx) || []).length;
    if (matches > 0) {
      project_score += matches * 2;
      project_signals.push(`project verb (${matches}x)`);
    }
  }

  patterns.versioned.lastIndex = 0;
  const versioned = (text.match(patterns.versioned) || []).length;
  if (versioned > 0) {
    project_score += versioned * 3;
    project_signals.push(`versioned/hyphenated (${versioned}x)`);
  }

  patterns.code_ref.lastIndex = 0;
  const codeRef = (text.match(patterns.code_ref) || []).length;
  if (codeRef > 0) {
    project_score += codeRef * 3;
    project_signals.push(`code file reference (${codeRef}x)`);
  }

  return {
    person_score,
    project_score,
    person_signals: person_signals.slice(0, 3),
    project_signals: project_signals.slice(0, 3),
  };
}


// ==================== CLASSIFY ====================

/**
 * Given scores, classify as person / project / uncertain.
 * Returns entity dict with confidence.
 */
export function classifyEntity(name, frequency, scores) {
  const ps = scores.person_score;
  const prs = scores.project_score;
  const total = ps + prs;

  if (total === 0) {
    // No strong signals — frequency-only candidate, uncertain
    const confidence = Math.min(0.4, frequency / 50);
    return {
      name,
      type: 'uncertain',
      confidence: Math.round(confidence * 100) / 100,
      frequency,
      signals: [`appears ${frequency}x, no strong type signals`],
    };
  }

  const personRatio = total > 0 ? ps / total : 0;

  // Require TWO different signal categories to confidently classify as a person.
  const signalCategories = new Set();
  for (const s of scores.person_signals) {
    if (s.includes('dialogue')) signalCategories.add('dialogue');
    else if (s.includes('action')) signalCategories.add('action');
    else if (s.includes('pronoun')) signalCategories.add('pronoun');
    else if (s.includes('addressed')) signalCategories.add('addressed');
  }

  const hasTwoSignalTypes = signalCategories.size >= 2;

  let entityType, confidence, signals;

  if (personRatio >= 0.7 && hasTwoSignalTypes && ps >= 5) {
    entityType = 'person';
    confidence = Math.min(0.99, 0.5 + personRatio * 0.5);
    signals = scores.person_signals.length > 0
      ? scores.person_signals
      : [`appears ${frequency}x`];
  } else if (personRatio >= 0.7 && (!hasTwoSignalTypes || ps < 5)) {
    // Pronoun-only match — downgrade to uncertain
    entityType = 'uncertain';
    confidence = 0.4;
    signals = [...scores.person_signals, `appears ${frequency}x — pronoun-only match`];
  } else if (personRatio <= 0.3) {
    entityType = 'project';
    confidence = Math.min(0.99, 0.5 + (1 - personRatio) * 0.5);
    signals = scores.project_signals.length > 0
      ? scores.project_signals
      : [`appears ${frequency}x`];
  } else {
    entityType = 'uncertain';
    confidence = 0.5;
    signals = [...scores.person_signals, ...scores.project_signals].slice(0, 3);
    signals.push('mixed signals — needs review');
  }

  return {
    name,
    type: entityType,
    confidence: Math.round(confidence * 100) / 100,
    frequency,
    signals,
  };
}


// ==================== MAIN DETECT ====================

const MAX_BYTES_PER_FILE = 5000;

/**
 * Scan files and detect entity candidates.
 *
 * @param {string[]} filePaths - List of file paths to scan
 * @param {number} maxFiles - Max files to read (for speed)
 * @returns {{ people: object[], projects: object[], uncertain: object[] }}
 */
export function detectEntities(filePaths, maxFiles = 10) {
  const allText = [];
  const allLines = [];
  let filesRead = 0;

  for (const filepath of filePaths) {
    if (filesRead >= maxFiles) break;
    try {
      const fd = fs.openSync(filepath, 'r');
      const buf = Buffer.alloc(MAX_BYTES_PER_FILE);
      const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES_PER_FILE, 0);
      fs.closeSync(fd);
      const content = buf.slice(0, bytesRead).toString('utf-8');
      allText.push(content);
      allLines.push(...content.split('\n'));
      filesRead++;
    } catch {
      continue;
    }
  }

  const combinedText = allText.join('\n');
  const candidates = extractCandidates(combinedText);

  if (Object.keys(candidates).length === 0) {
    return { people: [], projects: [], uncertain: [] };
  }

  const people = [];
  const projects = [];
  const uncertain = [];

  // Sort by frequency descending
  const sorted = Object.entries(candidates).sort((a, b) => b[1] - a[1]);

  for (const [name, frequency] of sorted) {
    const scores = scoreEntity(name, combinedText, allLines);
    const entity = classifyEntity(name, frequency, scores);

    if (entity.type === 'person') {
      people.push(entity);
    } else if (entity.type === 'project') {
      projects.push(entity);
    } else {
      uncertain.push(entity);
    }
  }

  // Sort by confidence descending
  people.sort((a, b) => b.confidence - a.confidence);
  projects.sort((a, b) => b.confidence - a.confidence);
  uncertain.sort((a, b) => b.frequency - a.frequency);

  return {
    people: people.slice(0, 15),
    projects: projects.slice(0, 10),
    uncertain: uncertain.slice(0, 8),
  };
}


// ==================== SCAN HELPER ====================

/**
 * Collect prose file paths for entity detection.
 * Prose only (.txt, .md, .rst, .csv) — code files produce too many false positives.
 * Falls back to all readable files if no prose found.
 */
export function scanForDetection(projectDir, maxFiles = 10) {
  const resolvedDir = path.resolve(projectDir);
  const proseFiles = [];
  const allFiles = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (PROSE_EXTENSIONS.has(ext)) {
          proseFiles.push(fullPath);
        } else if (READABLE_EXTENSIONS.has(ext)) {
          allFiles.push(fullPath);
        }
      }
    }
  }

  walk(resolvedDir);

  // Prefer prose files — fall back to all readable if too few prose files
  const files = proseFiles.length >= 3
    ? proseFiles
    : [...proseFiles, ...allFiles];

  return files.slice(0, maxFiles);
}
