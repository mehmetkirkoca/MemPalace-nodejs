import { describe, it, expect } from 'vitest';
import { extractTemporalInfo } from '../src/kgTemporalExtractor.js';

describe('extractTemporalInfo', () => {
  it('extracts explicit ISO dates', () => {
    const result = extractTemporalInfo('Alice works on AuthService since 2025-01-01.');
    expect(result.validFrom).toBe('2025-01-01');
    expect(result.ended).toBeNull();
    expect(result.dates).toEqual(['2025-01-01']);
    expect(result.hasExplicitDate).toBe(true);
  });

  it('extracts start and end dates when two explicit dates are present', () => {
    const result = extractTemporalInfo('Alice worked on AuthService from 2025-01-01 to 2025-03-01.');
    expect(result.validFrom).toBe('2025-01-01');
    expect(result.ended).toBe('2025-03-01');
    expect(result.dates).toEqual(['2025-01-01', '2025-03-01']);
  });

  it('resolves English relative dates from reference date', () => {
    const result = extractTemporalInfo('Alice stopped working on AuthService yesterday.', null, {
      referenceDate: '2026-04-23',
    });
    expect(result.validFrom).toBe('2026-04-22');
    expect(result.dates).toEqual(['2026-04-22']);
  });

  it('resolves Turkish relative dates from reference date', () => {
    const result = extractTemporalInfo('Alice bugun AuthService uzerinde calisiyor.', null, {
      referenceDate: '2026-04-23',
    });
    expect(result.validFrom).toBe('2026-04-23');
    expect(result.dates).toEqual(['2026-04-23']);
  });

  it('resolves French relative dates from reference date', () => {
    const result = extractTemporalInfo('Alice travaille sur AuthService aujourd hui.', null, {
      referenceDate: '2026-04-23',
    });
    expect(result.validFrom).toBe('2026-04-23');
    expect(result.dates).toEqual(['2026-04-23']);
  });

  it('falls back to filed date when no explicit date exists', () => {
    const result = extractTemporalInfo('Alice prefers TypeScript.', '2026-04-23', {
      referenceDate: '2026-04-23',
    });
    expect(result.validFrom).toBe('2026-04-23');
    expect(result.ended).toBeNull();
  });
});
