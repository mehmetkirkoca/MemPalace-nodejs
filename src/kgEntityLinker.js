import { EntityRegistry } from './entityRegistry.js';

const PERSON_HINTS = new Set(['i', 'we', 'he', 'she', 'they', 'team']);
const TOOL_HINTS = new Set([
  'docker', 'neo4j', 'qdrant', 'postgresql', 'postgres', 'redis', 'sqlite',
  'typescript', 'javascript', 'node', 'nodejs', 'react', 'vite', 'vitest',
  'kubernetes', 'python', 'fastify', 'npm', 'git',
]);

const ORG_SUFFIXES = ['inc', 'llc', 'corp', 'gmbh', 'ltd', 'team'];

const TOKEN_PATTERN = /\b[\p{L}][\p{L}\p{N}_-]{1,63}\b/gu;
const QUOTED_PATTERN = /["“”'`][^"'`“”]{2,80}["“”'`]/g;

function titleCase(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferType(name, registryResult) {
  if (registryResult?.type && registryResult.type !== 'unknown') {
    return registryResult.type;
  }

  const lower = name.toLowerCase();
  if (TOOL_HINTS.has(lower)) return 'tool';
  if (ORG_SUFFIXES.some((suffix) => lower.endsWith(` ${suffix}`) || lower === suffix)) return 'org';
  if (/service|api|app|system|project|repo|platform|pipeline|stack/i.test(name)) return 'project';
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/.test(name) && name.split(/\s+/).length <= 3) return 'person';
  if (/^[a-z0-9_-]+$/.test(name) && TOOL_HINTS.has(lower)) return 'tool';
  return 'concept';
}

function collectQuotedPhrases(text) {
  const phrases = [];
  let match;
  while ((match = QUOTED_PATTERN.exec(text)) !== null) {
    const value = match[0].slice(1, -1).trim();
    if (value && !phrases.includes(value)) phrases.push(value);
  }
  return phrases;
}

function collectCandidateTokens(text) {
  const found = [];
  let match;
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    const token = match[0];
    if (token.length < 2) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

export function linkEntities(text, context = {}) {
  const registry = EntityRegistry.load();
  const candidates = new Map();
  const known = registry.findPeopleInText ? registry.findPeopleInText(text) : [];

  for (const name of known) {
    const lookup = registry.lookup(name, text);
    candidates.set(name.toLowerCase(), {
      name: lookup.name || name,
      type: lookup.type || 'person',
      confidence: Math.max(0.95, lookup.confidence || 0),
      source: 'registry',
    });
  }

  for (const phrase of collectQuotedPhrases(text)) {
    const lookup = registry.lookup(phrase, text);
    const canonical = lookup.name || phrase;
    const type = inferType(canonical, lookup);
    candidates.set(canonical.toLowerCase(), {
      name: canonical,
      type,
      confidence: Math.max(lookup.confidence || 0.45, 0.55),
      source: lookup.type === 'unknown' ? 'quoted' : 'registry',
    });
  }

  for (const token of collectCandidateTokens(text)) {
    if (PERSON_HINTS.has(token.toLowerCase())) continue;
    const lookup = registry.lookup(token, text);
    const canonical = lookup.name || token;
    const type = inferType(canonical, lookup);
    const confidenceBase = lookup.type === 'unknown' ? 0.35 : lookup.confidence || 0.8;
    const confidence =
      /[\p{Lu}]/u.test(token[0]) || TOOL_HINTS.has(token.toLowerCase())
        ? Math.max(confidenceBase, 0.45)
        : confidenceBase;
    if (confidence < 0.45) continue;
    candidates.set(canonical.toLowerCase(), {
      name: type === 'person' ? titleCase(canonical) : canonical,
      type,
      confidence,
      source: lookup.type === 'unknown' ? 'candidate' : 'registry',
    });
  }

  if (candidates.size < 2) {
    for (const value of [context.room, context.closet, context.hall]) {
      if (!value || candidates.has(String(value).toLowerCase())) continue;
      candidates.set(String(value).toLowerCase(), {
        name: String(value),
        type: inferType(String(value), null),
        confidence: 0.5,
        source: 'taxonomy',
      });
    }
  }

  return [...candidates.values()];
}
