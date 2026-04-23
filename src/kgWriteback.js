import { KnowledgeGraph } from './knowledgeGraph.js';

const _kgs = new Map();

function getKg(palace) {
  if (!_kgs.has(palace)) {
    _kgs.set(palace, new KnowledgeGraph(palace));
  }
  return _kgs.get(palace);
}

function roundConfidence(value) {
  return Math.round(value * 1000) / 1000;
}

function isBefore(a, b) {
  return Boolean(a && b && a < b);
}

async function findMatchingFacts(kg, fact) {
  const outgoing = await kg.queryEntity(fact.subject, { direction: 'outgoing' });
  return outgoing.filter(
    (item) => item.predicate === fact.predicate && item.object === fact.object
  );
}

export async function writeExtractedKgFacts({ palace, drawerId, facts }) {
  const kg = getKg(palace);
  const written = [];

  for (const fact of facts || []) {
    const matches = await findMatchingFacts(kg, fact);
    const activeMatch = matches.find((item) => item.activeNow);

    if (fact.ended) {
      if (!activeMatch) {
        written.push({
          action: 'skip',
          reason: 'no_active_fact_to_invalidate',
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          ended: fact.ended,
          confidence: roundConfidence(fact.confidence),
        });
        continue;
      }

      if (isBefore(fact.ended, activeMatch.validFrom)) {
        written.push({
          action: 'skip',
          reason: 'temporal_conflict_end_before_start',
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          ended: fact.ended,
          active_valid_from: activeMatch.validFrom,
          confidence: roundConfidence(fact.confidence),
        });
        continue;
      }

      await kg.invalidate(fact.subject, fact.predicate, fact.object, fact.ended);
      written.push({
        action: 'invalidate',
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        ended: fact.ended,
        confidence: roundConfidence(fact.confidence),
      });
      continue;
    }

    const lastMatch = matches
      .filter((item) => item.validTo !== null)
      .sort((a, b) => String(b.validTo || '').localeCompare(String(a.validTo || '')))[0];

    if (lastMatch && isBefore(fact.validFrom, lastMatch.validTo)) {
      written.push({
        action: 'skip',
        reason: 'temporal_conflict_start_before_previous_end',
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        valid_from: fact.validFrom || null,
        previous_valid_to: lastMatch.validTo,
        confidence: roundConfidence(fact.confidence),
      });
      continue;
    }

    const tripleId = await kg.addTriple(fact.subject, fact.predicate, fact.object, {
      validFrom: fact.validFrom,
      sourceCloset: drawerId || null,
    });
    written.push({
      action: 'add',
      triple_id: tripleId,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      valid_from: fact.validFrom || null,
      confidence: roundConfidence(fact.confidence),
    });
  }

  return written;
}
