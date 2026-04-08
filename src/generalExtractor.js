/**
 * generalExtractor.js — Extract 5 types of memories from text.
 *
 * Types:
 *   1. DECISIONS    — "we went with X because Y", choices made
 *   2. PREFERENCES  — "always use X", "never do Y", "I prefer Z"
 *   3. MILESTONES   — breakthroughs, things that finally worked
 *   4. PROBLEMS     — what broke, what fixed it, root causes
 *   5. EMOTIONAL    — feelings, vulnerability, relationships
 *
 * No LLM required. Pure keyword/pattern heuristics.
 */

// =============================================================================
// MARKER SETS — One per memory type
// =============================================================================

const DECISION_MARKERS = [
  /\blet'?s (use|go with|try|pick|choose|switch to)\b/i,
  /\bwe (should|decided|chose|went with|picked|settled on)\b/i,
  /\bi'?m going (to|with)\b/i,
  /\bbetter (to|than|approach|option|choice)\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bthe reason (is|was|being)\b/i,
  /\bbecause\b/i,
  /\btrade-?off\b/i,
  /\bpros and cons\b/i,
  /\bover\b.*\bbecause\b/i,
  /\barchitecture\b/i,
  /\bapproach\b/i,
  /\bstrategy\b/i,
  /\bpattern\b/i,
  /\bstack\b/i,
  /\bframework\b/i,
  /\binfrastructure\b/i,
  /\bset (it |this )?to\b/i,
  /\bconfigure\b/i,
  /\bdefault\b/i,
];

const PREFERENCE_MARKERS = [
  /\bi prefer\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bdon'?t (ever |like to )?(use|do|mock|stub|import)\b/i,
  /\bi like (to|when|how)\b/i,
  /\bi hate (when|how|it when)\b/i,
  /\bplease (always|never|don'?t)\b/i,
  /\bmy (rule|preference|style|convention) is\b/i,
  /\bwe (always|never)\b/i,
  /\bfunctional\b.*\bstyle\b/i,
  /\bimperative\b/i,
  /\bsnake_?case\b/i,
  /\bcamel_?case\b/i,
  /\btabs\b.*\bspaces\b/i,
  /\bspaces\b.*\btabs\b/i,
  /\buse\b.*\binstead of\b/i,
];

const MILESTONE_MARKERS = [
  /\bit works\b/i,
  /\bit worked\b/i,
  /\bgot it working\b/i,
  /\bfixed\b/i,
  /\bsolved\b/i,
  /\bbreakthrough\b/i,
  /\bfigured (it )?out\b/i,
  /\bnailed it\b/i,
  /\bcracked (it|the)\b/i,
  /\bfinally\b/i,
  /\bfirst time\b/i,
  /\bfirst ever\b/i,
  /\bnever (done|been|had) before\b/i,
  /\bdiscovered\b/i,
  /\brealized\b/i,
  /\bfound (out|that)\b/i,
  /\bturns out\b/i,
  /\bthe key (is|was|insight)\b/i,
  /\bthe trick (is|was)\b/i,
  /\bnow i (understand|see|get it)\b/i,
  /\bbuilt\b/i,
  /\bcreated\b/i,
  /\bimplemented\b/i,
  /\bshipped\b/i,
  /\blaunched\b/i,
  /\bdeployed\b/i,
  /\breleased\b/i,
  /\bprototype\b/i,
  /\bproof of concept\b/i,
  /\bdemo\b/i,
  /\bversion \d/i,
  /\bv\d+\.\d+/i,
  /\d+x (compression|faster|slower|better|improvement|reduction)/i,
  /\d+% (reduction|improvement|faster|better|smaller)/i,
];

const PROBLEM_MARKERS = [
  /\b(bug|error|crash|fail|broke|broken|issue|problem)\b/i,
  /\bdoesn'?t work\b/i,
  /\bnot working\b/i,
  /\bwon'?t\b.*\bwork\b/i,
  /\bkeeps? (failing|crashing|breaking|erroring)\b/i,
  /\broot cause\b/i,
  /\bthe (problem|issue|bug) (is|was)\b/i,
  /\bturns out\b.*\b(was|because|due to)\b/i,
  /\bthe fix (is|was)\b/i,
  /\bworkaround\b/i,
  /\bthat'?s why\b/i,
  /\bthe reason it\b/i,
  /\bfixed (it |the |by )\b/i,
  /\bsolution (is|was)\b/i,
  /\bresolved\b/i,
  /\bpatched\b/i,
  /\bthe answer (is|was)\b/i,
  /\b(had|need) to\b.*\binstead\b/i,
];

const EMOTION_MARKERS = [
  /\blove\b/i,
  /\bscared\b/i,
  /\bafraid\b/i,
  /\bproud\b/i,
  /\bhurt\b/i,
  /\bhappy\b/i,
  /\bsad\b/i,
  /\bcry\b/i,
  /\bcrying\b/i,
  /\bmiss\b/i,
  /\bsorry\b/i,
  /\bgrateful\b/i,
  /\bangry\b/i,
  /\bworried\b/i,
  /\blonely\b/i,
  /\bbeautiful\b/i,
  /\bamazing\b/i,
  /\bwonderful\b/i,
  /i feel/i,
  /i'm scared/i,
  /i love you/i,
  /i'm sorry/i,
  /i can't/i,
  /i wish/i,
  /i miss/i,
  /i need/i,
  /never told anyone/i,
  /nobody knows/i,
  /\*[^*]+\*/,
];

const ALL_MARKERS = {
  decision: DECISION_MARKERS,
  preference: PREFERENCE_MARKERS,
  milestone: MILESTONE_MARKERS,
  problem: PROBLEM_MARKERS,
  emotional: EMOTION_MARKERS,
};

// =============================================================================
// SENTIMENT — for disambiguation
// =============================================================================

const POSITIVE_WORDS = new Set([
  'pride', 'proud', 'joy', 'happy', 'love', 'loving', 'beautiful',
  'amazing', 'wonderful', 'incredible', 'fantastic', 'brilliant',
  'perfect', 'excited', 'thrilled', 'grateful', 'warm', 'breakthrough',
  'success', 'works', 'working', 'solved', 'fixed', 'nailed',
  'heart', 'hug', 'precious', 'adore',
]);

const NEGATIVE_WORDS = new Set([
  'bug', 'error', 'crash', 'crashing', 'crashed', 'fail', 'failed',
  'failing', 'failure', 'broken', 'broke', 'breaking', 'breaks',
  'issue', 'problem', 'wrong', 'stuck', 'blocked', 'unable',
  'impossible', 'missing', 'terrible', 'horrible', 'awful', 'worse',
  'worst', 'panic', 'disaster', 'mess',
]);

function _getSentiment(text) {
  const words = new Set(text.toLowerCase().match(/\b\w+\b/g) || []);
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) pos++;
    if (NEGATIVE_WORDS.has(w)) neg++;
  }
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

function _hasResolution(text) {
  const textLower = text.toLowerCase();
  const patterns = [
    /\bfixed\b/,
    /\bsolved\b/,
    /\bresolved\b/,
    /\bpatched\b/,
    /\bgot it working\b/,
    /\bit works\b/,
    /\bnailed it\b/,
    /\bfigured (it )?out\b/,
    /\bthe (fix|answer|solution)\b/,
  ];
  return patterns.some(p => p.test(textLower));
}

function _disambiguate(memoryType, text, scores) {
  const sentiment = _getSentiment(text);

  // Resolved problems are milestones
  if (memoryType === 'problem' && _hasResolution(text)) {
    if ((scores.emotional || 0) > 0 && sentiment === 'positive') {
      return 'emotional';
    }
    return 'milestone';
  }

  // Problem + positive sentiment => milestone or emotional
  if (memoryType === 'problem' && sentiment === 'positive') {
    if ((scores.milestone || 0) > 0) return 'milestone';
    if ((scores.emotional || 0) > 0) return 'emotional';
  }

  return memoryType;
}

// =============================================================================
// CODE LINE FILTERING
// =============================================================================

const _CODE_LINE_PATTERNS = [
  /^\s*[$#]\s/,
  /^\s*(cd|source|echo|export|pip|npm|git|python|bash|curl|wget|mkdir|rm|cp|mv|ls|cat|grep|find|chmod|sudo|brew|docker)\s/,
  /^\s*```/,
  /^\s*(import|from|def|class|function|const|let|var|return)\s/,
  /^\s*[A-Z_]{2,}=/,
  /^\s*\|/,
  /^\s*-{2,}/,
  /^\s*[{}\[\]]\s*$/,
  /^\s*(if|for|while|try|except|elif|else:)\b/,
  /^\s*\w+\.\w+\(/,
  /^\s*\w+ = \w+\.\w+/,
];

function _isCodeLine(line) {
  const stripped = line.trim();
  if (!stripped) return false;
  for (const pattern of _CODE_LINE_PATTERNS) {
    if (pattern.test(stripped)) return true;
  }
  const alphaCount = (stripped.match(/[a-zA-Z]/g) || []).length;
  const alphaRatio = alphaCount / Math.max(stripped.length, 1);
  if (alphaRatio < 0.4 && stripped.length > 10) return true;
  return false;
}

function _extractProse(text) {
  const lines = text.split('\n');
  const prose = [];
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (!_isCodeLine(line)) {
      prose.push(line);
    }
  }
  const result = prose.join('\n').trim();
  return result || text;
}

// =============================================================================
// SCORING
// =============================================================================

function _scoreMarkers(text, markers) {
  const textLower = text.toLowerCase();
  let score = 0;
  const keywords = [];
  for (const marker of markers) {
    // Create a global version of the regex for findAll
    const flags = marker.flags.includes('g') ? marker.flags : marker.flags + 'g';
    const globalMarker = new RegExp(marker.source, flags);
    const matches = [...textLower.matchAll(globalMarker)];
    if (matches.length > 0) {
      score += matches.length;
      for (const m of matches) {
        if (m[1]) {
          keywords.push(m[1]);
        } else {
          keywords.push(m[0]);
        }
      }
    }
  }
  return [score, [...new Set(keywords)]];
}

// =============================================================================
// SEGMENT SPLITTING
// =============================================================================

const _TURN_PATTERNS = [
  /^>\s/,
  /^(Human|User|Q)\s*:/i,
  /^(Assistant|AI|A|Claude|ChatGPT)\s*:/i,
];

function _splitByTurns(lines) {
  const segments = [];
  let current = [];

  for (const line of lines) {
    const stripped = line.trim();
    const isTurn = _TURN_PATTERNS.some(p => p.test(stripped));

    if (isTurn && current.length > 0) {
      segments.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    segments.push(current.join('\n'));
  }

  return segments;
}

function _splitIntoSegments(text) {
  const lines = text.split('\n');

  // Check for speaker-turn markers
  let turnCount = 0;
  for (const line of lines) {
    const stripped = line.trim();
    for (const pat of _TURN_PATTERNS) {
      if (pat.test(stripped)) {
        turnCount++;
        break;
      }
    }
  }

  // If enough turn markers, split by turns
  if (turnCount >= 3) {
    return _splitByTurns(lines);
  }

  // Fallback: paragraph splitting
  const paragraphs = text.split('\n\n')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // If single giant block, chunk by line groups
  if (paragraphs.length <= 1 && lines.length > 20) {
    const segments = [];
    for (let i = 0; i < lines.length; i += 25) {
      const group = lines.slice(i, i + 25).join('\n').trim();
      if (group) segments.push(group);
    }
    return segments;
  }

  return paragraphs;
}

// =============================================================================
// MAIN EXTRACTION
// =============================================================================

/**
 * Extract memories from a text string.
 *
 * @param {string} text - The text to extract from (any format).
 * @param {number} [minConfidence=0.3] - Minimum confidence threshold (0.0-1.0).
 * @returns {Array<{content: string, memoryType: string, chunkIndex: number}>}
 */
export function extractMemories(text, minConfidence = 0.3) {
  if (!text || typeof text !== 'string') return [];

  const paragraphs = _splitIntoSegments(text);
  const memories = [];

  for (const para of paragraphs) {
    if (para.trim().length < 20) continue;

    const prose = _extractProse(para);

    // Score against all types
    const scores = {};
    for (const [memType, markers] of Object.entries(ALL_MARKERS)) {
      const [score] = _scoreMarkers(prose, markers);
      if (score > 0) {
        scores[memType] = score;
      }
    }

    if (Object.keys(scores).length === 0) continue;

    // Length bonus
    let lengthBonus = 0;
    if (para.length > 500) lengthBonus = 2;
    else if (para.length > 200) lengthBonus = 1;

    // Find max scoring type
    let maxType = Object.entries(scores).reduce(
      (best, [type, score]) => score > best[1] ? [type, score] : best,
      ['', -1]
    )[0];
    const maxScore = scores[maxType] + lengthBonus;

    // Disambiguate
    maxType = _disambiguate(maxType, prose, scores);

    // Confidence
    const confidence = Math.min(1.0, maxScore / 5.0);
    if (confidence < minConfidence) continue;

    memories.push({
      content: para.trim(),
      memoryType: maxType,
      chunkIndex: memories.length,
    });
  }

  return memories;
}

// Named exports for testing internal functions if needed
export { _splitIntoSegments, _scoreMarkers, _disambiguate, _extractProse };
