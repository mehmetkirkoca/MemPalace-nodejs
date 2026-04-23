const DATE_PATTERNS = [
  /\b(\d{4}-\d{2}-\d{2})\b/g,
  /\b(\d{4}\/\d{2}\/\d{2})\b/g,
];

const RELATIVE_LEXEMES = [
  { tokens: ['today'], offsetDays: 0 },
  { tokens: ['yesterday'], offsetDays: -1 },
  { tokens: ['tomorrow'], offsetDays: 1 },
  { tokens: ['bugun'], offsetDays: 0 },
  { tokens: ['dun'], offsetDays: -1 },
  { tokens: ['yarin'], offsetDays: 1 },
  { tokens: ['aujourdhui'], offsetDays: 0 },
  { tokens: ['aujourd', 'hui'], offsetDays: 0 },
  { tokens: ['hier'], offsetDays: -1 },
  { tokens: ['demain'], offsetDays: 1 },
  { tokens: ['hoy'], offsetDays: 0 },
  { tokens: ['ayer'], offsetDays: -1 },
  { tokens: ['manana'], offsetDays: 1 },
];

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(baseDate, offsetDays) {
  const copy = new Date(`${baseDate}T00:00:00.000Z`);
  copy.setUTCDate(copy.getUTCDate() + offsetDays);
  return formatDate(copy);
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(text) {
  const normalized = normalizeText(text);
  return normalized
    .replace(/['’`]/g, '')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesSequence(tokens, startIndex, sequence) {
  if (startIndex + sequence.length > tokens.length) return false;
  for (let i = 0; i < sequence.length; i++) {
    if (tokens[startIndex + i] !== sequence[i]) return false;
  }
  return true;
}

function extractRelativeDates(text, referenceDate) {
  if (!referenceDate) return [];

  const tokens = tokenize(text);
  const found = [];

  for (let i = 0; i < tokens.length; i++) {
    for (const lexeme of RELATIVE_LEXEMES) {
      if (!matchesSequence(tokens, i, lexeme.tokens)) continue;
      const value = shiftDate(referenceDate, lexeme.offsetDays);
      if (!found.includes(value)) found.push(value);
    }
  }

  return found;
}

export function extractTemporalInfo(text, fallbackDate = null, options = {}) {
  const normalized = String(text || '');
  const dates = [];
  const referenceDate = options.referenceDate || fallbackDate || null;
  let explicitDateCount = 0;

  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const value = match[1].replace(/\//g, '-');
      if (!dates.includes(value)) {
        dates.push(value);
        explicitDateCount++;
      }
    }
  }

  for (const value of extractRelativeDates(normalized, referenceDate)) {
    if (!dates.includes(value)) dates.push(value);
  }

  const validFrom = dates[0] || fallbackDate || null;
  const ended = dates.length > 1 ? dates[dates.length - 1] : null;

  return {
    dates,
    validFrom,
    ended,
    hasExplicitDate: explicitDateCount > 0,
    hasRelativeDate: dates.length > explicitDateCount,
  };
}
