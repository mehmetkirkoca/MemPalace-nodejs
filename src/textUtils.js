/**
 * Normalize text for fuzzy matching and semantic comparison.
 * Strips diacritics, lowercases, collapses whitespace.
 */
export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
