/**
 * dialect.js — AAAK Dialect: Structured Symbolic Summary Format
 *
 * A lossy summarization format that extracts entities, topics, key sentences,
 * emotions, and flags from plain text into a compact structured representation.
 * Any LLM reads it natively — no decoder required.
 *
 * NOTE: AAAK is NOT lossless compression. The original text cannot be reconstructed
 * from AAAK output. It is a structured summary layer (closets) that points to the
 * original verbatim content (drawers).
 *
 * FORMAT:
 *   Header:   FILE_NUM|PRIMARY_ENTITY|DATE|TITLE
 *   Zettel:   ZID:ENTITIES|topic_keywords|"key_quote"|WEIGHT|EMOTIONS|FLAGS
 *   Tunnel:   T:ZID<->ZID|label
 *   Arc:      ARC:emotion->emotion->emotion
 *
 * EMOTION CODES (universal):
 *   vul=vulnerability, joy=joy, fear=fear, trust=trust
 *   grief=grief, wonder=wonder, rage=rage, love=love
 *   hope=hope, despair=despair, peace=peace, humor=humor
 *   tender=tenderness, raw=raw_honesty, doubt=self_doubt
 *   relief=relief, anx=anxiety, exhaust=exhaustion
 *   convict=conviction, passion=quiet_passion
 *
 * FLAGS:
 *   ORIGIN = origin moment (birth of something)
 *   CORE = core belief or identity pillar
 *   SENSITIVE = handle with absolute care
 *   PIVOT = emotional turning point
 *   GENESIS = led directly to something existing
 *   DECISION = explicit decision or choice
 *   TECHNICAL = technical architecture or implementation detail
 */

import fs from 'fs';
import path from 'path';

// === EMOTION CODES (universal) ===

export const EMOTION_CODES = {
  vulnerability: 'vul',
  vulnerable: 'vul',
  joy: 'joy',
  joyful: 'joy',
  fear: 'fear',
  mild_fear: 'fear',
  trust: 'trust',
  trust_building: 'trust',
  grief: 'grief',
  raw_grief: 'grief',
  wonder: 'wonder',
  philosophical_wonder: 'wonder',
  rage: 'rage',
  anger: 'rage',
  love: 'love',
  devotion: 'love',
  hope: 'hope',
  despair: 'despair',
  hopelessness: 'despair',
  peace: 'peace',
  relief: 'relief',
  humor: 'humor',
  dark_humor: 'humor',
  tenderness: 'tender',
  raw_honesty: 'raw',
  brutal_honesty: 'raw',
  self_doubt: 'doubt',
  anxiety: 'anx',
  exhaustion: 'exhaust',
  conviction: 'convict',
  quiet_passion: 'passion',
  warmth: 'warmth',
  curiosity: 'curious',
  gratitude: 'grat',
  frustration: 'frust',
  confusion: 'confuse',
  satisfaction: 'satis',
  excitement: 'excite',
  determination: 'determ',
  surprise: 'surprise',
};

// Keywords that signal emotions in plain text
const EMOTION_SIGNALS = {
  decided: 'determ',
  prefer: 'convict',
  worried: 'anx',
  excited: 'excite',
  frustrated: 'frust',
  confused: 'confuse',
  love: 'love',
  hate: 'rage',
  hope: 'hope',
  fear: 'fear',
  trust: 'trust',
  happy: 'joy',
  sad: 'grief',
  surprised: 'surprise',
  grateful: 'grat',
  curious: 'curious',
  wonder: 'wonder',
  anxious: 'anx',
  relieved: 'relief',
  satisf: 'satis',
  disappoint: 'grief',
  concern: 'anx',
};

// Keywords that signal flags
const FLAG_SIGNALS = {
  decided: 'DECISION',
  chose: 'DECISION',
  switched: 'DECISION',
  migrated: 'DECISION',
  replaced: 'DECISION',
  'instead of': 'DECISION',
  because: 'DECISION',
  founded: 'ORIGIN',
  created: 'ORIGIN',
  started: 'ORIGIN',
  born: 'ORIGIN',
  launched: 'ORIGIN',
  'first time': 'ORIGIN',
  core: 'CORE',
  fundamental: 'CORE',
  essential: 'CORE',
  principle: 'CORE',
  belief: 'CORE',
  always: 'CORE',
  'never forget': 'CORE',
  'turning point': 'PIVOT',
  'changed everything': 'PIVOT',
  realized: 'PIVOT',
  breakthrough: 'PIVOT',
  epiphany: 'PIVOT',
  api: 'TECHNICAL',
  database: 'TECHNICAL',
  architecture: 'TECHNICAL',
  deploy: 'TECHNICAL',
  infrastructure: 'TECHNICAL',
  algorithm: 'TECHNICAL',
  framework: 'TECHNICAL',
  server: 'TECHNICAL',
  config: 'TECHNICAL',
};

// Common filler/stop words to strip from topic extraction
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'during', 'before', 'after', 'above', 'below', 'up', 'down',
  'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'don', 'now', 'and', 'but', 'or', 'if', 'while', 'that', 'this',
  'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their',
  'what', 'which', 'who', 'whom', 'also', 'much', 'many', 'like',
  'because', 'since', 'get', 'got', 'use', 'used', 'using', 'make',
  'made', 'thing', 'things', 'way', 'well', 'really', 'want', 'need',
]);

export class Dialect {
  /**
   * AAAK Dialect encoder — works on plain text or structured zettel data.
   *
   * @param {Object<string,string>} [entities] - Mapping of full names -> short codes
   * @param {string[]} [skipNames] - Names to skip (fictional characters, etc.)
   */
  constructor(entities = null, skipNames = null) {
    this.entityCodes = {};
    if (entities) {
      for (const [name, code] of Object.entries(entities)) {
        this.entityCodes[name] = code;
        this.entityCodes[name.toLowerCase()] = code;
      }
    }
    this.skipNames = (skipNames || []).map(n => n.toLowerCase());
  }

  /**
   * Load entity mappings from a JSON config file.
   * @param {string} configPath
   * @returns {Dialect}
   */
  static fromConfig(configPath) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return new Dialect(config.entities || {}, config.skip_names || []);
  }

  /**
   * Save current entity mappings to a JSON config file.
   * @param {string} configPath
   */
  saveConfig(configPath) {
    const canonical = {};
    const seenCodes = new Set();
    for (const [name, code] of Object.entries(this.entityCodes)) {
      if (!seenCodes.has(code)) {
        // Prefer non-lowercase keys
        if (name !== name.toLowerCase()) {
          canonical[name] = code;
          seenCodes.add(code);
        } else if (!seenCodes.has(code)) {
          canonical[name] = code;
          seenCodes.add(code);
        }
      }
    }
    const config = { entities: canonical, skip_names: this.skipNames };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  // === ENCODING (entity/emotion primitives) ===

  /**
   * Convert a person/entity name to its short code.
   * @param {string} name
   * @returns {string|null}
   */
  encodeEntity(name) {
    if (this.skipNames.some(s => name.toLowerCase().includes(s))) {
      return null;
    }
    if (this.entityCodes[name]) {
      return this.entityCodes[name];
    }
    if (this.entityCodes[name.toLowerCase()]) {
      return this.entityCodes[name.toLowerCase()];
    }
    for (const [key, code] of Object.entries(this.entityCodes)) {
      if (name.toLowerCase().includes(key.toLowerCase())) {
        return code;
      }
    }
    // Auto-code: first 3 chars uppercase
    return name.slice(0, 3).toUpperCase();
  }

  /**
   * Convert emotion list to compact codes.
   * @param {string[]} emotions
   * @returns {string}
   */
  encodeEmotions(emotions) {
    const codes = [];
    for (const e of emotions) {
      const code = EMOTION_CODES[e] || e.slice(0, 4);
      if (!codes.includes(code)) {
        codes.push(code);
      }
    }
    return codes.slice(0, 3).join('+');
  }

  /**
   * Extract flags from zettel metadata.
   * @param {Object} zettel
   * @returns {string}
   */
  getFlags(zettel) {
    const flags = [];
    if (zettel.origin_moment) {
      flags.push('ORIGIN');
    }
    if ((zettel.sensitivity || '').toUpperCase().startsWith('MAXIMUM')) {
      flags.push('SENSITIVE');
    }
    const notes = (zettel.notes || '').toLowerCase();
    if (notes.includes('foundational pillar') || notes.includes('core')) {
      flags.push('CORE');
    }
    if (notes.includes('genesis') || (zettel.origin_label || '').toLowerCase().includes('genesis')) {
      flags.push('GENESIS');
    }
    if (notes.includes('pivot')) {
      flags.push('PIVOT');
    }
    return flags.length ? flags.join('+') : '';
  }

  // === PLAIN TEXT COMPRESSION ===

  /**
   * Detect emotions from plain text using keyword signals.
   * @param {string} text
   * @returns {string[]}
   */
  detectEmotions(text) {
    const textLower = text.toLowerCase();
    const detected = [];
    const seen = new Set();
    for (const [keyword, code] of Object.entries(EMOTION_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(code)) {
        detected.push(code);
        seen.add(code);
      }
    }
    return detected.slice(0, 3);
  }

  /**
   * Detect importance flags from plain text using keyword signals.
   * @param {string} text
   * @returns {string[]}
   */
  detectFlags(text) {
    const textLower = text.toLowerCase();
    const detected = [];
    const seen = new Set();
    for (const [keyword, flag] of Object.entries(FLAG_SIGNALS)) {
      if (textLower.includes(keyword) && !seen.has(flag)) {
        detected.push(flag);
        seen.add(flag);
      }
    }
    return detected.slice(0, 3);
  }

  /**
   * Extract key topic words from plain text.
   * @param {string} text
   * @param {number} [maxTopics=3]
   * @returns {string[]}
   */
  extractTopics(text, maxTopics = 3) {
    // Tokenize: alphanumeric words
    const words = text.match(/[a-zA-Z][a-zA-Z_-]{2,}/g) || [];
    const freq = {};

    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower) || wLower.length < 3) continue;
      freq[wLower] = (freq[wLower] || 0) + 1;
    }

    // Boost proper nouns and technical terms
    for (const w of words) {
      const wLower = w.toLowerCase();
      if (STOP_WORDS.has(wLower)) continue;
      if (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() && freq[wLower]) {
        freq[wLower] += 2;
      }
      // CamelCase or has underscore/hyphen
      if ((w.includes('_') || w.includes('-') || /[A-Z]/.test(w.slice(1))) && freq[wLower]) {
        freq[wLower] += 2;
      }
    }

    const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return ranked.slice(0, maxTopics).map(([w]) => w);
  }

  /**
   * Extract the most important sentence fragment from text.
   * @param {string} text
   * @returns {string}
   */
  _extractKeySentence(text) {
    const sentences = text.split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10);

    if (!sentences.length) return '';

    const decisionWords = new Set([
      'decided', 'because', 'instead', 'prefer', 'switched', 'chose',
      'realized', 'important', 'key', 'critical', 'discovered', 'learned',
      'conclusion', 'solution', 'reason', 'why', 'breakthrough', 'insight',
    ]);

    const scored = sentences.map(s => {
      let score = 0;
      const sLower = s.toLowerCase();
      for (const w of decisionWords) {
        if (sLower.includes(w)) score += 2;
      }
      if (s.length < 80) score += 1;
      if (s.length < 40) score += 1;
      if (s.length > 150) score -= 2;
      return { score, sentence: s };
    });

    scored.sort((a, b) => b.score - a.score);
    let best = scored[0].sentence;
    if (best.length > 55) {
      best = best.slice(0, 52) + '...';
    }
    return best;
  }

  /**
   * Find known entities in text, or detect capitalized names.
   * @param {string} text
   * @returns {string[]}
   */
  _detectEntitiesInText(text) {
    const found = [];
    // Check known entities
    for (const [name, code] of Object.entries(this.entityCodes)) {
      if (name !== name.toLowerCase() && text.toLowerCase().includes(name.toLowerCase())) {
        if (!found.includes(code)) {
          found.push(code);
        }
      }
    }
    if (found.length) return found;

    // Fallback: find capitalized words that look like names
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const clean = words[i].replace(/[^a-zA-Z]/g, '');
      if (
        clean.length >= 2 &&
        clean[0] === clean[0].toUpperCase() &&
        clean[0] !== clean[0].toLowerCase() &&
        clean.slice(1) === clean.slice(1).toLowerCase() &&
        i > 0 &&
        !STOP_WORDS.has(clean.toLowerCase())
      ) {
        const code = clean.slice(0, 3).toUpperCase();
        if (!found.includes(code)) {
          found.push(code);
        }
        if (found.length >= 3) break;
      }
    }
    return found;
  }

  /**
   * Summarize plain text into AAAK Dialect format.
   *
   * Extracts entities, topics, a key sentence, emotions, and flags
   * from the input text. This is lossy — the original text cannot be
   * reconstructed from the output.
   *
   * @param {string} text - Plain text content to summarize
   * @param {Object} [metadata] - Optional metadata (source_file, wing, room, date)
   * @returns {string} AAAK-formatted summary string
   */
  compress(text, metadata = null) {
    metadata = metadata || {};

    const entities = this._detectEntitiesInText(text);
    const entityStr = entities.length ? entities.slice(0, 3).join('+') : '???';

    const topics = this.extractTopics(text);
    const topicStr = topics.length ? topics.slice(0, 3).join('_') : 'misc';

    const quote = this._extractKeySentence(text);
    const quotePart = quote ? `"${quote}"` : '';

    const emotions = this.detectEmotions(text);
    const emotionStr = emotions.length ? emotions.join('+') : '';

    const flags = this.detectFlags(text);
    const flagStr = flags.length ? flags.join('+') : '';

    const source = metadata.source_file || '';
    const wing = metadata.wing || '';
    const room = metadata.room || '';
    const date = metadata.date || '';

    const lines = [];

    // Header line (if we have metadata)
    if (source || wing) {
      const headerParts = [
        wing || '?',
        room || '?',
        date || '?',
        source ? path.parse(source).name : '?',
      ];
      lines.push(headerParts.join('|'));
    }

    // Content line
    const parts = [`0:${entityStr}`, topicStr];
    if (quotePart) parts.push(quotePart);
    if (emotionStr) parts.push(emotionStr);
    if (flagStr) parts.push(flagStr);

    lines.push(parts.join('|'));

    return lines.join('\n');
  }

  // === ZETTEL-BASED ENCODING ===

  /**
   * Pull the most important quote fragment from zettel content.
   * @param {Object} zettel
   * @returns {string}
   */
  extractKeyQuote(zettel) {
    const content = zettel.content || '';
    const origin = zettel.origin_label || '';
    const notes = zettel.notes || '';
    const title = zettel.title || '';
    const allText = `${content} ${origin} ${notes}`;

    let quotes = [];
    // Double-quoted
    const dq = allText.match(/"([^"]{8,55})"/g);
    if (dq) {
      quotes.push(...dq.map(m => m.slice(1, -1)));
    }
    // Single-quoted
    const sq = allText.match(/(?:^|[\s(])'([^']{8,55})'(?:[\s.,;:!?)]|$)/g);
    if (sq) {
      quotes.push(...sq.map(m => {
        const inner = m.match(/'([^']+)'/);
        return inner ? inner[1] : '';
      }).filter(Boolean));
    }
    // Speech verbs
    const speech = allText.match(
      /(?:says?|said|articulates?|reveals?|admits?|confesses?|asks?):\s*["']?([^.!?]{10,55})[.!?]/gi
    );
    if (speech) {
      quotes.push(...speech.map(m => {
        const inner = m.match(/:\s*["']?([^.!?]{10,55})/);
        return inner ? inner[1] : '';
      }).filter(Boolean));
    }

    if (quotes.length) {
      // Deduplicate
      const seen = new Set();
      quotes = quotes.filter(q => {
        q = q.trim();
        if (seen.has(q) || q.length < 8) return false;
        seen.add(q);
        return true;
      });

      const emotionalWords = new Set([
        'love', 'fear', 'remember', 'soul', 'feel', 'stupid', 'scared',
        'beautiful', 'destroy', 'respect', 'trust', 'consciousness', 'alive',
        'forget', 'waiting', 'peace', 'matter', 'real', 'guilt', 'escape',
        'rest', 'hope', 'dream', 'lost', 'found',
      ]);

      const scored = quotes.map(q => {
        let score = 0;
        if (q[0] === q[0].toUpperCase() || q.startsWith('I ')) score += 2;
        for (const w of emotionalWords) {
          if (q.toLowerCase().includes(w)) score += 2;
        }
        if (q.length > 20) score += 1;
        if (q.startsWith('The ') || q.startsWith('This ') || q.startsWith('She ')) score -= 2;
        return { score, quote: q };
      });

      scored.sort((a, b) => b.score - a.score);
      if (scored.length) return scored[0].quote;
    }

    if (title.includes(' - ')) {
      return title.split(' - ').slice(1).join(' - ').slice(0, 45);
    }
    return '';
  }

  /**
   * Encode a single zettel into AAAK Dialect.
   * @param {Object} zettel
   * @returns {string}
   */
  encodeZettel(zettel) {
    const zid = zettel.id.split('-').pop();

    let entityCodes = (zettel.people || []).map(p => this.encodeEntity(p)).filter(e => e !== null);
    if (!entityCodes.length) entityCodes = ['???'];
    const entities = [...new Set(entityCodes)].sort().join('+');

    const topics = zettel.topics || [];
    const topicStr = topics.length ? topics.slice(0, 2).join('_') : 'misc';

    const quote = this.extractKeyQuote(zettel);
    const quotePart = quote ? `"${quote}"` : '';

    const weight = zettel.emotional_weight ?? 0.5;
    const emotions = this.encodeEmotions(zettel.emotional_tone || []);
    const flags = this.getFlags(zettel);

    const parts = [`${zid}:${entities}`, topicStr];
    if (quotePart) parts.push(quotePart);
    parts.push(String(weight));
    if (emotions) parts.push(emotions);
    if (flags) parts.push(flags);

    return parts.join('|');
  }

  /**
   * Encode a tunnel connection.
   * @param {Object} tunnel
   * @returns {string}
   */
  encodeTunnel(tunnel) {
    const fromId = tunnel.from.split('-').pop();
    const toId = tunnel.to.split('-').pop();
    const label = tunnel.label || '';
    const shortLabel = label.includes(':') ? label.split(':')[0] : label.slice(0, 30);
    return `T:${fromId}<->${toId}|${shortLabel}`;
  }

  /**
   * Encode an entire zettel file into AAAK Dialect.
   * @param {Object} zettelJson
   * @returns {string}
   */
  encodeFile(zettelJson) {
    const lines = [];

    const source = zettelJson.source_file || 'unknown';
    const fileNum = source.includes('-') ? source.split('-')[0] : '000';
    const date = (zettelJson.zettels || [{}])[0].date_context || 'unknown';

    const allPeople = new Set();
    for (const z of (zettelJson.zettels || [])) {
      for (const p of (z.people || [])) {
        const code = this.encodeEntity(p);
        if (code !== null) allPeople.add(code);
      }
    }
    if (!allPeople.size) allPeople.add('???');
    const primary = [...allPeople].sort().slice(0, 3).join('+');

    const title = source.includes('-')
      ? source.replace('.txt', '').split('-').slice(1).join('-').trim()
      : source;
    lines.push(`${fileNum}|${primary}|${date}|${title}`);

    const arc = zettelJson.emotional_arc || '';
    if (arc) lines.push(`ARC:${arc}`);

    for (const z of (zettelJson.zettels || [])) {
      lines.push(this.encodeZettel(z));
    }

    for (const t of (zettelJson.tunnels || [])) {
      lines.push(this.encodeTunnel(t));
    }

    return lines.join('\n');
  }

  // === FILE-BASED COMPRESSION ===

  /**
   * Read a zettel JSON file and compress it to AAAK Dialect.
   * @param {string} zettelJsonPath
   * @param {string} [outputPath]
   * @returns {string}
   */
  compressFile(zettelJsonPath, outputPath = null) {
    const data = JSON.parse(fs.readFileSync(zettelJsonPath, 'utf-8'));
    const dialect = this.encodeFile(data);
    if (outputPath) {
      fs.writeFileSync(outputPath, dialect);
    }
    return dialect;
  }

  /**
   * Compress ALL zettel files into a single AAAK Dialect file.
   * @param {string} zettelDir
   * @param {string} [outputPath]
   * @returns {string}
   */
  compressAll(zettelDir, outputPath = null) {
    const allDialect = [];
    const files = fs.readdirSync(zettelDir).filter(f => f.endsWith('.json')).sort();
    for (const fname of files) {
      const fpath = path.join(zettelDir, fname);
      const data = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
      allDialect.push(this.encodeFile(data));
      allDialect.push('---');
    }
    const combined = allDialect.join('\n');
    if (outputPath) {
      fs.writeFileSync(outputPath, combined);
    }
    return combined;
  }

  // === DECODING ===

  /**
   * Parse an AAAK Dialect string back into a readable summary.
   * @param {string} dialectText
   * @returns {Object}
   */
  decode(dialectText) {
    const lines = dialectText.trim().split('\n');
    const result = { header: {}, arc: '', zettels: [], tunnels: [] };

    for (const line of lines) {
      if (line.startsWith('ARC:')) {
        result.arc = line.slice(4);
      } else if (line.startsWith('T:')) {
        result.tunnels.push(line);
      } else if (line.includes('|') && line.split('|')[0].includes(':')) {
        result.zettels.push(line);
      } else if (line.includes('|')) {
        const parts = line.split('|');
        result.header = {
          file: parts[0] || '',
          entities: parts[1] || '',
          date: parts[2] || '',
          title: parts[3] || '',
        };
      }
    }

    return result;
  }

  // === STATS ===

  /**
   * Estimate token count using word-based heuristic (~1.3 tokens per word).
   * @param {string} text
   * @returns {number}
   */
  static countTokens(text) {
    const words = text.split(/\s+/).filter(w => w.length > 0);
    return Math.max(1, Math.floor(words.length * 1.3));
  }

  /**
   * Get size comparison stats for a text->AAAK conversion.
   *
   * NOTE: AAAK is lossy summarization, not compression. The "ratio"
   * reflects how much shorter the summary is, not a compression ratio
   * in the traditional sense — information is lost.
   *
   * @param {string} originalText
   * @param {string} compressed
   * @returns {Object}
   */
  compressionStats(originalText, compressed) {
    const origTokens = Dialect.countTokens(originalText);
    const compTokens = Dialect.countTokens(compressed);
    return {
      original_tokens_est: origTokens,
      summary_tokens_est: compTokens,
      size_ratio: Math.round((origTokens / Math.max(compTokens, 1)) * 10) / 10,
      original_chars: originalText.length,
      summary_chars: compressed.length,
      note: 'Estimates only. Use tiktoken for accurate counts. AAAK is lossy.',
    };
  }
}
