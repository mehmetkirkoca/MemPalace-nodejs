import { Embedder } from './embedder.js';
import { KG_PREDICATES, predicateAllowsTypes } from './kgOntology.js';
import { linkEntities } from './kgEntityLinker.js';
import { extractTemporalInfo } from './kgTemporalExtractor.js';

const _embedder = new Embedder();
let _prototypeCache = null;

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function splitSegments(text) {
  return String(text || '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 12);
}

function pairKey(subject, predicate, object, ended) {
  return `${subject}::${predicate}::${object}::${ended || ''}`;
}

async function getPrototypeCache() {
  if (_prototypeCache) return _prototypeCache;

  const texts = [];
  for (const predicate of KG_PREDICATES) {
    for (const text of predicate.prototypes) {
      texts.push({ predicate: predicate.id, mode: 'active', text });
    }
    for (const text of predicate.endPrototypes || []) {
      texts.push({ predicate: predicate.id, mode: 'ended', text });
    }
  }

  const vectors = await _embedder.embedBatch(texts.map((item) => item.text));
  _prototypeCache = texts.map((item, index) => ({ ...item, vector: vectors[index] }));
  return _prototypeCache;
}

function scoreTypeCompatibility(subject, object, predicate) {
  if (predicateAllowsTypes(predicate, subject.type, object.type)) return 1;
  if (subject.type === 'unknown' || object.type === 'unknown') return 0.82;
  return 0.35;
}

function chooseEntityPairs(entities) {
  const pairs = [];
  for (let i = 0; i < entities.length; i++) {
    for (let j = 0; j < entities.length; j++) {
      if (i === j) continue;
      pairs.push([entities[i], entities[j]]);
    }
  }
  return pairs;
}

export async function extractKgFacts(text, context = {}) {
  const segments = splitSegments(text);
  const prototypeCache = await getPrototypeCache();
  const facts = [];
  const seen = new Set();

  for (const segment of segments) {
    const entities = linkEntities(segment, context)
      .filter((entity) => entity.confidence >= 0.45)
      .slice(0, 6);
    if (entities.length < 2) continue;

    const segmentVector = await _embedder.embed(segment);
    const fallbackDate = context.filedAt?.slice(0, 10) || null;
    const temporal = extractTemporalInfo(segment, fallbackDate, {
      referenceDate: fallbackDate,
    });

    let best = null;
    for (const [subject, object] of chooseEntityPairs(entities)) {
      for (const predicate of KG_PREDICATES) {
        const typeScore = scoreTypeCompatibility(subject, object, predicate);
        if (typeScore < 0.5) continue;

        let bestActive = 0;
        let bestEnded = 0;
        for (const proto of prototypeCache) {
          if (proto.predicate !== predicate.id) continue;
          const score = cosineSimilarity(segmentVector, proto.vector);
          if (proto.mode === 'active' && score > bestActive) bestActive = score;
          if (proto.mode === 'ended' && score > bestEnded) bestEnded = score;
        }

        const semanticScore = Math.max(bestActive, bestEnded);
        const entityScore = (subject.confidence + object.confidence) / 2;
        const finalScore = semanticScore * 0.7 + typeScore * 0.2 + entityScore * 0.1;
        const ended = bestEnded > bestActive + 0.03 ? (temporal.ended || temporal.validFrom) : null;

        if (!best || finalScore > best.confidence) {
          best = {
            subject: subject.name,
            subjectType: subject.type,
            predicate: predicate.id,
            object: object.name,
            objectType: object.type,
            confidence: finalScore,
            semanticScore,
            typeScore,
            validFrom: ended ? null : temporal.validFrom,
            ended,
            segment,
          };
        }
      }
    }

    if (!best || best.confidence < 0.72) continue;
    const key = pairKey(best.subject, best.predicate, best.object, best.ended);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(best);
  }

  return facts;
}
