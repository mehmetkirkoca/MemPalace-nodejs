/**
 * onboarding.js — MemPalace first-run setup.
 *
 * Asks the user:
 *   1. How they're using MemPalace (work / personal / combo)
 *   2. Who the people in their life are (names, nicknames, relationships)
 *   3. What their projects are
 *   4. What they want their wings called
 *
 * Seeds the entity_registry with confirmed data so MemPalace knows your world
 * from minute one — before a single session is indexed.
 *
 * Usage:
 *   import { runOnboarding, quickSetup } from './onboarding.js';
 *   const registry = await runOnboarding();
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline/promises';
import { EntityRegistry, COMMON_ENGLISH_WORDS } from './entityRegistry.js';
import { detectEntities, scanForDetection } from './entityDetector.js';

// ─────────────────────────────────────────────────────────────────────────────
// Default wing taxonomies by mode
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_WINGS = {
  work: ['projects', 'clients', 'team', 'decisions', 'research'],
  personal: ['family', 'health', 'creative', 'reflections', 'relationships'],
  combo: ['family', 'work', 'health', 'creative', 'projects', 'reflections'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _hr() {
  console.log(`\n${'─'.repeat(58)}`);
}

function _header(text) {
  console.log(`\n${'='.repeat(58)}`);
  console.log(`  ${text}`);
  console.log('='.repeat(58));
}

/**
 * Create a readline interface for interactive prompts.
 * @returns {readline.Interface}
 */
function _createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Ask a question with optional default value.
 * @param {readline.Interface} rl
 * @param {string} prompt
 * @param {string} [defaultVal]
 * @returns {Promise<string>}
 */
async function _ask(rl, prompt, defaultVal = null) {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  const answer = (await rl.question(`  ${prompt}${suffix}: `)).trim();
  return answer || defaultVal || '';
}

/**
 * Ask a yes/no question.
 * @param {readline.Interface} rl
 * @param {string} prompt
 * @param {string} [defaultVal='y']
 * @returns {Promise<boolean>}
 */
async function _yn(rl, prompt, defaultVal = 'y') {
  const hint = defaultVal === 'y' ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`  ${prompt} [${hint}]: `)).trim().toLowerCase();
  if (!answer) return defaultVal === 'y';
  return answer.startsWith('y');
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Mode selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {readline.Interface} rl
 * @returns {Promise<string>}
 */
async function _askMode(rl) {
  _header('Welcome to MemPalace');
  console.log(`
  MemPalace is a personal memory system. To work well, it needs to know
  a little about your world — who the people are, what the projects
  are, and how you want your memory organized.

  This takes about 2 minutes. You can always update it later.
`);
  console.log('  How are you using MemPalace?');
  console.log();
  console.log('    [1]  Work     — notes, projects, clients, colleagues, decisions');
  console.log('    [2]  Personal — diary, family, health, relationships, reflections');
  console.log('    [3]  Both     — personal and professional mixed');
  console.log();

  while (true) {
    const choice = (await rl.question('  Your choice [1/2/3]: ')).trim();
    if (choice === '1') return 'work';
    if (choice === '2') return 'personal';
    if (choice === '3') return 'combo';
    console.log('  Please enter 1, 2, or 3.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: People
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {readline.Interface} rl
 * @param {string} mode
 * @returns {Promise<{people: Array, aliases: Object}>}
 */
async function _askPeople(rl, mode) {
  const people = [];
  const aliases = {}; // nickname → full name

  if (mode === 'personal' || mode === 'combo') {
    _hr();
    console.log(`
  Personal world — who are the important people in your life?

  Format: name, relationship (e.g. "Riley, daughter" or just "Devon")
  For nicknames, you'll be asked separately.
  Type 'done' when finished.
`);
    while (true) {
      const entry = (await rl.question('  Person: ')).trim();
      if (entry.toLowerCase() === 'done' || entry === '') break;
      const parts = entry.split(',', 2).map(p => p.trim());
      const name = parts[0];
      const relationship = parts[1] || '';
      if (name) {
        const nick = (await rl.question(`  Nickname for ${name}? (or enter to skip): `)).trim();
        if (nick) {
          aliases[nick] = name;
        }
        people.push({ name, relationship, context: 'personal' });
      }
    }
  }

  if (mode === 'work' || mode === 'combo') {
    _hr();
    console.log(`
  Work world — who are the colleagues, clients, or collaborators
  you'd want to find in your notes?

  Format: name, role (e.g. "Ben, co-founder" or just "Sarah")
  Type 'done' when finished.
`);
    while (true) {
      const entry = (await rl.question('  Person: ')).trim();
      if (entry.toLowerCase() === 'done' || entry === '') break;
      const parts = entry.split(',', 2).map(p => p.trim());
      const name = parts[0];
      const role = parts[1] || '';
      if (name) {
        people.push({ name, relationship: role, context: 'work' });
      }
    }
  }

  return { people, aliases };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: Projects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {readline.Interface} rl
 * @param {string} mode
 * @returns {Promise<string[]>}
 */
async function _askProjects(rl, mode) {
  if (mode === 'personal') return [];

  _hr();
  console.log(`
  What are your main projects? (These help MemPalace distinguish project
  names from person names — e.g. "Lantern" the project vs. "Lantern" the word.)

  Type 'done' when finished.
`);
  const projects = [];
  while (true) {
    const proj = (await rl.question('  Project: ')).trim();
    if (proj.toLowerCase() === 'done' || proj === '') break;
    if (proj) projects.push(proj);
  }
  return projects;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: Wings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {readline.Interface} rl
 * @param {string} mode
 * @returns {Promise<string[]>}
 */
async function _askWings(rl, mode) {
  const defaults = DEFAULT_WINGS[mode];
  _hr();
  console.log(`
  Wings are the top-level categories in your memory palace.

  Suggested wings for ${mode} mode:
    ${defaults.join(', ')}

  Press enter to keep these, or type your own comma-separated list.
`);
  const custom = (await rl.question('  Wings: ')).trim();
  if (custom) {
    return custom.split(',').map(w => w.trim()).filter(Boolean);
  }
  return defaults;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5: Auto-detect from files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan directory for additional entity candidates.
 * @param {string} directory
 * @param {Array} knownPeople
 * @returns {Array}
 */
function _autoDetect(directory, knownPeople) {
  const knownNames = new Set(knownPeople.map(p => p.name.toLowerCase()));

  try {
    const files = scanForDetection(directory);
    if (!files || files.length === 0) return [];
    const detected = detectEntities(files);
    return detected.people.filter(
      e => !knownNames.has(e.name.toLowerCase()) && e.confidence >= 0.7
    );
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6: Ambiguity warnings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flag names that are also common English words.
 * @param {Array} people
 * @returns {string[]}
 */
function _warnAmbiguous(people) {
  const ambiguous = [];
  for (const p of people) {
    if (COMMON_ENGLISH_WORDS.has(p.name.toLowerCase())) {
      ambiguous.push(p.name);
    }
  }
  return ambiguous;
}

// ─────────────────────────────────────────────────────────────────────────────
// AAAK bootstrap generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate AAAK entity registry + critical facts bootstrap from onboarding data.
 * @param {Array} people
 * @param {string[]} projects
 * @param {string[]} wings
 * @param {string} mode
 * @param {string} [configDir]
 */
function _generateAaakBootstrap(people, projects, wings, mode, configDir = null) {
  const mempalaceDir = configDir || path.join(os.homedir(), '.mempalace');
  fs.mkdirSync(mempalaceDir, { recursive: true });

  // Build AAAK entity codes (first 3 letters of name, uppercase)
  const entityCodes = {};
  for (const p of people) {
    const name = p.name;
    let code = name.slice(0, 3).toUpperCase();
    // Handle collisions
    while (Object.values(entityCodes).includes(code)) {
      code = name.slice(0, 4).toUpperCase();
    }
    entityCodes[name] = code;
  }

  // AAAK entity registry
  const registryLines = [
    '# AAAK Entity Registry',
    '# Auto-generated by mempalace init. Update as needed.',
    '',
    '## People',
  ];
  for (const p of people) {
    const name = p.name;
    const code = entityCodes[name];
    const rel = p.relationship || '';
    registryLines.push(rel ? `  ${code}=${name} (${rel})` : `  ${code}=${name}`);
  }

  if (projects.length > 0) {
    registryLines.push('', '## Projects');
    for (const proj of projects) {
      const code = proj.slice(0, 4).toUpperCase();
      registryLines.push(`  ${code}=${proj}`);
    }
  }

  registryLines.push(
    '',
    '## AAAK Quick Reference',
    '  Symbols: ♡=love ★=importance ⚠=warning →=relationship |=separator',
    '  Structure: KEY:value | GROUP(details) | entity.attribute',
    '  Read naturally — expand codes, treat *markers* as emotional context.',
  );

  fs.writeFileSync(path.join(mempalaceDir, 'aaak_entities.md'), registryLines.join('\n'));

  // Critical facts bootstrap
  const factsLines = [
    '# Critical Facts (bootstrap — will be enriched after mining)',
    '',
  ];

  const personalPeople = people.filter(p => p.context === 'personal');
  const workPeople = people.filter(p => p.context === 'work');

  if (personalPeople.length > 0) {
    factsLines.push('## People (personal)');
    for (const p of personalPeople) {
      const code = entityCodes[p.name];
      const rel = p.relationship || '';
      factsLines.push(rel ? `- **${p.name}** (${code}) — ${rel}` : `- **${p.name}** (${code})`);
    }
    factsLines.push('');
  }

  if (workPeople.length > 0) {
    factsLines.push('## People (work)');
    for (const p of workPeople) {
      const code = entityCodes[p.name];
      const rel = p.relationship || '';
      factsLines.push(rel ? `- **${p.name}** (${code}) — ${rel}` : `- **${p.name}** (${code})`);
    }
    factsLines.push('');
  }

  if (projects.length > 0) {
    factsLines.push('## Projects');
    for (const proj of projects) {
      factsLines.push(`- **${proj}**`);
    }
    factsLines.push('');
  }

  factsLines.push(
    '## Palace',
    `Wings: ${wings.join(', ')}`,
    `Mode: ${mode}`,
    '',
    '*This file will be enriched by palace_facts.js after mining.*',
  );

  fs.writeFileSync(path.join(mempalaceDir, 'critical_facts.md'), factsLines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main onboarding flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full interactive onboarding flow.
 *
 * @param {Object} [options]
 * @param {string} [options.directory='.'] - Directory to scan for entities
 * @param {string} [options.configDir] - Override config directory
 * @param {boolean} [options.autoDetect=true] - Whether to offer auto-detection
 * @returns {Promise<EntityRegistry>}
 */
export async function runOnboarding({
  directory = '.',
  configDir = null,
  autoDetect = true,
} = {}) {
  const rl = _createRl();

  try {
    // Step 1: Mode
    const mode = await _askMode(rl);

    // Step 2: People
    const { people, aliases } = await _askPeople(rl, mode);

    // Step 3: Projects
    const projects = await _askProjects(rl, mode);

    // Step 4: Wings
    const wings = await _askWings(rl, mode);

    // Step 5: Auto-detect additional people from files
    if (autoDetect && await _yn(rl, '\nScan your files for additional names we might have missed?')) {
      directory = await _ask(rl, 'Directory to scan', directory);
      const detected = _autoDetect(directory, people);
      if (detected.length > 0) {
        _hr();
        console.log(`\n  Found ${detected.length} additional name candidates:\n`);
        for (const e of detected) {
          const signalStr = (e.signals || []).slice(0, 1).join(', ');
          console.log(
            `    ${e.name.padEnd(20)} confidence=${(e.confidence * 100).toFixed(0)}%  (${signalStr})`
          );
        }
        console.log();
        if (await _yn(rl, '  Add any of these to your registry?')) {
          for (const e of detected) {
            const ans = (await rl.question(`    ${e.name} — (p)erson, (s)kip? `)).trim().toLowerCase();
            if (ans === 'p') {
              const rel = (await rl.question(`    Relationship/role for ${e.name}? `)).trim();
              let ctx;
              if (mode === 'personal') {
                ctx = 'personal';
              } else if (mode === 'work') {
                ctx = 'work';
              } else {
                const ctxInput = (await rl.question('    Context — (p)ersonal or (w)ork? ')).trim().toLowerCase();
                ctx = ctxInput.startsWith('w') ? 'work' : 'personal';
              }
              people.push({ name: e.name, relationship: rel, context: ctx });
            }
          }
        }
      }
    }

    // Step 6: Warn about ambiguous names
    const ambiguous = _warnAmbiguous(people);
    if (ambiguous.length > 0) {
      _hr();
      console.log(`
  Heads up — these names are also common English words:
    ${ambiguous.join(', ')}

  MemPalace will check the context before treating them as person names.
  For example: "I picked up Riley" → person.
               "Have you ever tried" → adverb.
`);
    }

    // Build and save registry
    const registry = EntityRegistry.load(configDir);
    registry.seed(mode, people, projects, aliases);

    // Generate AAAK entity registry + critical facts bootstrap
    _generateAaakBootstrap(people, projects, wings, mode, configDir);

    // Summary
    _header('Setup Complete');
    console.log();
    console.log(`  ${registry.summary()}`);
    console.log(`\n  Wings: ${wings.join(', ')}`);
    console.log(`\n  Registry saved to: ${registry._path}`);
    console.log('\n  AAAK entity registry: ~/.mempalace/aaak_entities.md');
    console.log('  Critical facts bootstrap: ~/.mempalace/critical_facts.md');
    console.log('\n  Your AI will know your world from the first session.');
    console.log();

    return registry;
  } finally {
    rl.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick setup (non-interactive, for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Programmatic setup without interactive prompts.
 * Used in tests and benchmark scripts.
 *
 * @param {Object} options
 * @param {string} options.mode - 'personal' | 'work' | 'combo'
 * @param {Array<{name: string, relationship: string, context?: string}>} options.people
 * @param {string[]} [options.projects=[]]
 * @param {Object} [options.aliases={}]
 * @param {string} [options.configDir]
 * @param {string[]} [options.wings] - Custom wings (defaults based on mode)
 * @returns {EntityRegistry}
 */
export function quickSetup({
  mode,
  people,
  projects = [],
  aliases = {},
  configDir = null,
  wings = null,
} = {}) {
  const registry = EntityRegistry.load(configDir);
  registry.seed(mode, people, projects, aliases);

  // Generate AAAK bootstrap if wings provided or use defaults
  const resolvedWings = wings || DEFAULT_WINGS[mode] || DEFAULT_WINGS.personal;
  _generateAaakBootstrap(people, projects, resolvedWings, mode, configDir);

  return registry;
}
