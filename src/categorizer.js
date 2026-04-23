/**
 * categorizer.js — LLM-based content categorization
 *
 * Given content and the existing taxonomy, returns { wing, hall, room, closet }
 * using the configured LLM backend.
 *
 * CATEGORIZER_MODE env var:
 *   mcp        — caller (MCP-connected model) provides the path; this module is not called
 *   anthropic  — Anthropic API (claude-haiku-4-5-20251001)
 *   ollama     — local Ollama (http://localhost:11434)
 */

const MODE = process.env.CATEGORIZER_MODE || 'mcp';

const SYSTEM_PROMPT = `You are a memory palace librarian. Your job is to categorize content into a 4-level hierarchy:
- Wing: broad domain (e.g. "Technology", "Health", "Personal")
- Hall: sub-domain (e.g. "Programming", "Nutrition", "Family")
- Room: specific topic (e.g. "JavaScript", "Vitamins", "Parents")
- Closet: fine-grained sub-topic (e.g. "TypeScript", "Vitamin D", "Mom")

Rules:
- Use existing categories when the content fits. Prefer reuse over creating new ones.
- Create new categories only when nothing existing fits.
- Names must be short (1-3 words), title-case, in the same language as the content.
- Always return all 4 levels.`;

function buildPrompt(content, taxonomyText) {
  return `Current taxonomy:
${taxonomyText}

Content to categorize:
"""
${content}
"""

Return ONLY a JSON object with this exact shape:
{ "wing": "...", "hall": "...", "room": "...", "closet": "..." }`;
}

function parseResult(text) {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  for (const key of ['wing', 'hall', 'room', 'closet']) {
    if (!parsed[key] || typeof parsed[key] !== 'string') {
      throw new Error(`Missing or invalid field "${key}" in: ${JSON.stringify(parsed)}`);
    }
  }
  return {
    wing:   parsed.wing.trim(),
    hall:   parsed.hall.trim(),
    room:   parsed.room.trim(),
    closet: parsed.closet.trim(),
  };
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

async function categorizeAnthropic(content, taxonomyText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const model = process.env.CATEGORIZER_MODEL || 'claude-haiku-4-5-20251001';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(content, taxonomyText) }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return parseResult(data.content[0].text);
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function categorizeOllama(content, taxonomyText) {
  const base = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.CATEGORIZER_MODEL || 'llama3.2:3b';

  const prompt = `${SYSTEM_PROMPT}\n\n${buildPrompt(content, taxonomyText)}`;

  const resp = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Ollama error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  return parseResult(data.response);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Categorize content using the configured LLM backend.
 *
 * @param {string} content       — text to categorize
 * @param {string} taxonomyText  — output of ClusterStore.getTaxonomyText()
 * @returns {Promise<{ wing, hall, room, closet }>}
 */
export async function categorize(content, taxonomyText) {
  if (MODE === 'anthropic') return categorizeAnthropic(content, taxonomyText);
  if (MODE === 'ollama')    return categorizeOllama(content, taxonomyText);
  throw new Error(
    `CATEGORIZER_MODE="${MODE}": in MCP mode, wing/hall/room/closet must be provided by the caller.`
  );
}
