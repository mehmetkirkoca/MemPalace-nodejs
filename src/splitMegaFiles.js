/**
 * splitMegaFiles — Split concatenated transcript files into per-session files.
 *
 * Scans for .txt files containing multiple Claude Code sessions
 * (identified by "Claude Code v" headers). Splits each into individual files
 * named with: date, time, people detected, and subject from first prompt.
 *
 * Distinguishes true session starts from mid-session context restores
 * (which show "Ctrl+E to show X previous messages").
 *
 * Original files are renamed with .mega_backup extension (not deleted).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const KNOWN_NAMES_PATH = path.join(HOME, '.mempalace', 'known_names.json');
const FALLBACK_KNOWN_PEOPLE = ['Alice', 'Ben', 'Riley', 'Max', 'Sam', 'Devon', 'Jordan'];

let _knownNamesCache = null;

/**
 * Load and cache the optional known-names config file.
 * @param {boolean} [forceReload=false]
 * @returns {object|Array|null}
 */
function _loadKnownNamesConfig(forceReload = false) {
  if (forceReload) _knownNamesCache = null;
  if (_knownNamesCache !== null) return _knownNamesCache;

  try {
    if (fs.existsSync(KNOWN_NAMES_PATH)) {
      const data = JSON.parse(fs.readFileSync(KNOWN_NAMES_PATH, 'utf-8'));
      _knownNamesCache = data;
      return _knownNamesCache;
    }
  } catch {
    // JSON parse error or read error — fall through
  }

  _knownNamesCache = null;
  return null;
}

/**
 * Load known names from config file, falling back to a generic list.
 * @returns {string[]}
 */
function _loadKnownPeople() {
  const data = _loadKnownNamesConfig();
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.names)) return data.names;
  return [...FALLBACK_KNOWN_PEOPLE];
}

/**
 * Load username-to-name mapping from config file.
 * @returns {object}
 */
function _loadUsernameMap() {
  const data = _loadKnownNamesConfig();
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data.username_map || {};
  }
  return {};
}

/**
 * Check if a "Claude Code v" header at the given index is a true session start
 * (not a context restore with Ctrl+E/previous messages in the next 6 lines).
 * @param {string[]} lines
 * @param {number} idx
 * @returns {boolean}
 */
function isTrueSessionStart(lines, idx) {
  const nearby = lines.slice(idx, idx + 6).join('');
  return !nearby.includes('Ctrl+E') && !nearby.includes('previous messages');
}

/**
 * Return list of line indices where true new sessions begin.
 * @param {string[]} lines
 * @returns {number[]}
 */
export function findSessionBoundaries(lines) {
  const boundaries = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Claude Code v') && isTrueSessionStart(lines, i)) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

const MONTHS = {
  January: '01', February: '02', March: '03', April: '04',
  May: '05', June: '06', July: '07', August: '08',
  September: '09', October: '10', November: '11', December: '12',
};

const TS_PATTERN = /⏺\s+(\d{1,2}:\d{2}\s+[AP]M)\s+\w+,\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/;

/**
 * Find the first timestamp line: ⏺ H:MM AM/PM Weekday, Month DD, YYYY
 * @param {string[]} lines
 * @returns {[string|null, string|null]} [human, iso]
 */
export function extractTimestamp(lines) {
  const searchLines = lines.slice(0, 50);
  for (const line of searchLines) {
    const m = line.match(TS_PATTERN);
    if (m) {
      const [, timeStr, month, day, year] = m;
      const mon = MONTHS[month] || '00';
      const dayZ = day.padStart(2, '0');
      const timeSafe = timeStr.replace(/:/g, '').replace(/ /g, '');
      const iso = `${year}-${mon}-${dayZ}`;
      const human = `${year}-${mon}-${dayZ}_${timeSafe}`;
      return [human, iso];
    }
  }
  return [null, null];
}

/**
 * Detect people mentioned as speakers or by name in first 100 lines.
 * @param {string[]} lines
 * @param {string[]} [knownPeople] - Override known people list (for testing)
 * @param {object} [usernameMap] - Override username map (for testing)
 * @returns {string[]} Sorted list of detected names
 */
export function extractPeople(lines, knownPeople, usernameMap) {
  const people = knownPeople || _loadKnownPeople();
  const uMap = usernameMap || _loadUsernameMap();
  const found = new Set();
  const text = lines.slice(0, 100).join('');

  for (const person of people) {
    const re = new RegExp(`\\b${person}\\b`, 'i');
    if (re.test(text)) {
      found.add(person);
    }
  }

  // Working directory username hint
  const dirMatch = text.match(/\/Users\/(\w+)\//);
  if (dirMatch) {
    const username = dirMatch[1];
    if (uMap[username]) {
      found.add(uMap[username]);
    }
  }

  return [...found].sort();
}

const SKIP_PATTERNS = /^(\.\/|cd |ls |python|bash|git |cat |source |export |claude|\.\/activate)/;

/**
 * Find the first meaningful user prompt (> line that isn't a shell command).
 * @param {string[]} lines
 * @returns {string} Cleaned, filename-safe subject string
 */
export function extractSubject(lines) {
  for (const line of lines) {
    if (line.startsWith('> ')) {
      const prompt = line.slice(2).trim();
      if (prompt && !SKIP_PATTERNS.test(prompt) && prompt.length > 5) {
        let subject = prompt.replace(/[^\w\s-]/g, '');
        subject = subject.trim().replace(/\s+/g, '-');
        return subject.slice(0, 60);
      }
    }
  }
  return 'session';
}

/**
 * Split a single mega-file into per-session files.
 * @param {string} filePath - Path to the mega-file
 * @param {string} [outputDir] - Output directory (default: same dir as source)
 * @returns {string[]} List of output paths written
 */
export function splitMegaFile(filePath, outputDir) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/(?<=\n)/); // split keeping line endings

  const boundaries = findSessionBoundaries(lines);
  if (boundaries.length < 2) return [];

  // Add sentinel at end
  boundaries.push(lines.length);

  const outDir = outputDir || path.dirname(filePath);
  const written = [];

  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const chunk = lines.slice(start, end);

    if (chunk.length < 10) continue; // Skip tiny fragments

    const [tsHuman] = extractTimestamp(chunk);
    const people = extractPeople(chunk);
    const subject = extractSubject(chunk);

    // Build filename: SOURCESTEM__DATE_TIME_People_subject.txt
    const stem = path.basename(filePath, path.extname(filePath));
    const srcStem = stem.replace(/[^\w-]/g, '_').slice(0, 40);
    const tsPart = tsHuman || `part${String(i + 1).padStart(2, '0')}`;
    const peoplePart = people.length > 0 ? people.slice(0, 3).join('-') : 'unknown';

    let name = `${srcStem}__${tsPart}_${peoplePart}_${subject}.txt`;
    // Sanitize
    name = name.replace(/[^\w.\-]/g, '_');
    name = name.replace(/_+/g, '_');

    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, chunk.join(''), 'utf-8');
    written.push(outPath);
  }

  // Rename original to .mega_backup
  if (written.length > 0) {
    const ext = path.extname(filePath);
    const backupPath = filePath.replace(ext, '.mega_backup');
    fs.renameSync(filePath, backupPath);
  }

  return written;
}
