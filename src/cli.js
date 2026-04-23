#!/usr/bin/env node
/**
 * cli.js — Commander.js CLI for MemPalace.
 *
 * Commands:
 *   mempalace init <dir>                  Detect rooms from folder structure
 *   mempalace mine <dir>                  Mine project files
 *   mempalace mine <dir> --mode convos    Mine conversation exports
 *   mempalace search "query"              Find anything, exact words
 *   mempalace illuminate                  Show L0 + L1 wake-up context
 *   mempalace split <dir>                 Split concatenated mega-files
 *   mempalace repair                      Rebuild palace vector index
 *   mempalace status                      Show what's been filed
 */

import { Command } from 'commander';
import { VERSION } from './version.js';

/**
 * Create and configure the Commander program.
 * @returns {Command}
 */
function createProgram() {
  const program = new Command();

  program
    .name('mempalace')
    .description('MemPalace — Give your AI a memory. No API key required.')
    .version(VERSION);

  // ── init ────────────────────────────────────────────────────────────────────
  program
    .command('init')
    .description('Detect rooms from your folder structure')
    .argument('<dir>', 'Project directory to set up')
    .option('--yes', 'Auto-accept all detected entities (non-interactive)')
    .action(async (dir, opts) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const { scanForDetection, detectEntities } = await import('./entityDetector.js');
        const { detectRoomsLocal } = await import('./roomDetectorLocal.js');
        const { MempalaceConfig } = await import('./config.js');

        // Pass 1: auto-detect people and projects from file content
        console.log(`\n  Scanning for entities in: ${dir}`);
        const files = scanForDetection(dir);
        if (files.length > 0) {
          console.log(`  Reading ${files.length} files...`);
          const detected = detectEntities(files);
          const total =
            (detected.people?.length || 0) +
            (detected.projects?.length || 0) +
            (detected.uncertain?.length || 0);
          if (total > 0) {
            // Save detected entities to <project>/entities.json
            const resolvedDir = path.default.resolve(dir);
            const entitiesPath = path.default.join(resolvedDir, 'entities.json');
            fs.default.writeFileSync(entitiesPath, JSON.stringify(detected, null, 2));
            console.log(`  Entities saved: ${entitiesPath}`);
          } else {
            console.log('  No entities detected — proceeding with directory-based rooms.');
          }
        }

        // Pass 2: detect rooms from folder structure
        detectRoomsLocal(dir);
        const config = new MempalaceConfig();
        config.init();
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── mine ────────────────────────────────────────────────────────────────────
  program
    .command('mine')
    .description('Mine files into the palace')
    .argument('<dir>', 'Directory to mine')
    .option('--mode <mode>', "Ingest mode: 'files' or 'convos'", 'files')
    .option('--wing <wing>', 'Wing name (default: directory name)')
    .option('--no-gitignore', "Don't respect .gitignore files")
    .option(
      '--include-ignored <paths...>',
      'Always scan these paths even if ignored (comma-separated)'
    )
    .option('--agent <name>', 'Your name — recorded on every drawer', 'mempalace')
    .option('--limit <n>', 'Max files to process (0 = all)', '0')
    .option('--dry-run', 'Show what would be filed without filing')
    .option(
      '--extract <strategy>',
      "Extraction strategy for convos mode: 'exchange' or 'general'",
      'exchange'
    )
    .action(async (dir, opts) => {
      try {
        const { getConfig } = await import('./config.js');
        const { VectorStore } = await import('./vectorStore.js');

        const config = getConfig();
        const includeIgnored = [];
        if (opts.includeIgnored) {
          for (const raw of opts.includeIgnored) {
            includeIgnored.push(...raw.split(',').map((s) => s.trim()).filter(Boolean));
          }
        }

        if (opts.mode === 'convos') {
          const { mineConvos } = await import('./convoMiner.js');
          await mineConvos(dir, opts.wing, {
            agent: opts.agent,
            limit: parseInt(opts.limit, 10),
            dryRun: opts.dryRun || false,
            extractMode: opts.extract,
          });
        } else {
          const { mine } = await import('./miner.js');
          const store = new VectorStore(config);
          await store.init();
          await mine(dir, store, {
            wingOverride: opts.wing,
            agent: opts.agent,
            limit: parseInt(opts.limit, 10),
            dryRun: opts.dryRun || false,
            respectGitignore: opts.gitignore !== false,
            includeIgnored: includeIgnored.length > 0 ? includeIgnored : null,
          });
        }
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── search ──────────────────────────────────────────────────────────────────
  program
    .command('search')
    .description('Find anything, exact words')
    .argument('<query>', 'What to search for')
    .option('--wing <wing>', 'Limit to one project')
    .option('--room <room>', 'Limit to one room')
    .option('-n, --results <n>', 'Number of results', '5')
    .action(async (query, opts) => {
      try {
        const { search, SearchError } = await import('./searcher.js');
        const { getConfig } = await import('./config.js');
        const { VectorStore } = await import('./vectorStore.js');

        const config = getConfig();
        const store = new VectorStore(config);
        await store.init();

        await search(query, store, {
          wing: opts.wing,
          room: opts.room,
          nResults: parseInt(opts.results, 10),
        });
      } catch (err) {
        if (err.name === 'SearchError') {
          process.exit(1);
        }
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  async function runIlluminate(opts) {
    try {
      const { illuminateMemory } = await import('./mcpServer.js');
      const result = await illuminateMemory({ wing: opts.wing, context: opts.context });
      const text = [
        result.l0_identity,
        '',
        result.l1_essential,
        '',
        result.note,
      ].filter(Boolean).join('\n');
      const tokens = Math.floor(text.length / 4);
      console.log(`Illuminate text (~${tokens} tokens):`);
      console.log('='.repeat(50));
      console.log(text);
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  }

  // ── illuminate ──────────────────────────────────────────────────────────────
  program
    .command('illuminate')
    .description('Show L0 + L1 illuminate context (~600-900 tokens)')
    .option('--wing <wing>', 'Illuminate for a specific project/wing')
    .option('--context <text>', 'Context used to auto-select the right palace')
    .action(runIlluminate);

  // Backwards-compatible alias for the old command name.
  program
    .command('wake-up')
    .description('Alias for illuminate')
    .option('--wing <wing>', 'Illuminate for a specific project/wing')
    .option('--context <text>', 'Context used to auto-select the right palace')
    .action(runIlluminate);

  // ── split ───────────────────────────────────────────────────────────────────
  program
    .command('split')
    .description('Split concatenated transcript mega-files into per-session files')
    .argument('<dir>', 'Directory containing transcript files')
    .option('--output-dir <dir>', 'Write split files here (default: same as source)')
    .option('--dry-run', 'Show what would be split without writing files')
    .option('--min-sessions <n>', 'Only split files with at least N sessions', '2')
    .action(async (dir, opts) => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const { splitMegaFile } = await import('./splitMegaFiles.js');

        const resolvedDir = path.default.resolve(dir);
        const files = fs.default
          .readdirSync(resolvedDir)
          .filter((f) => f.endsWith('.txt') && !f.endsWith('.mega_backup'))
          .map((f) => path.default.join(resolvedDir, f));

        const minSessions = parseInt(opts.minSessions, 10);
        let totalSplit = 0;

        for (const filePath of files) {
          const outputDir = opts.outputDir || path.default.dirname(filePath);

          if (opts.dryRun) {
            const content = fs.default.readFileSync(filePath, 'utf-8');
            const { findSessionBoundaries } = await import('./splitMegaFiles.js');
            const lines = content.split(/(?<=\n)/);
            const boundaries = findSessionBoundaries(lines);
            if (boundaries.length >= minSessions) {
              console.log(`  ${path.default.basename(filePath)}: ${boundaries.length} sessions`);
              totalSplit++;
            }
          } else {
            const written = splitMegaFile(filePath, outputDir);
            if (written.length >= minSessions) {
              console.log(
                `  Split ${path.default.basename(filePath)} → ${written.length} files`
              );
              totalSplit++;
            }
          }
        }

        if (totalSplit === 0) {
          console.log('  No files needed splitting.');
        } else {
          console.log(`\n  ${totalSplit} file(s) processed.`);
        }
        if (opts.dryRun) {
          console.log('  (dry run — nothing written)');
        }
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── repair ──────────────────────────────────────────────────────────────────
  program
    .command('repair')
    .description('Rebuild palace vector index from stored data (fixes corruption)')
    .action(async () => {
      try {
        const { getConfig } = await import('./config.js');
        const { VectorStore } = await import('./vectorStore.js');

        const config = getConfig();
        const store = new VectorStore(config);
        await store.init();

        console.log(`\n${'='.repeat(55)}`);
        console.log('  MemPalace Repair');
        console.log(`${'='.repeat(55)}\n`);

        // Extract all drawers
        console.log('  Extracting drawers...');
        let result;
        try {
          result = await store.get({ limit: 10000, include: ['documents', 'metadatas'] });
        } catch (err) {
          console.log(`  Error reading palace: ${err.message}`);
          console.log('  Cannot recover — palace may need to be re-mined from source files.');
          return;
        }

        const allIds = result.ids || [];
        const allDocs = result.documents || [];
        const allMetas = result.metadatas || [];

        if (allIds.length === 0) {
          console.log('  Nothing to repair.');
          return;
        }

        console.log(`  Extracted ${allIds.length} drawers`);
        console.log('  Rebuilding collection...');

        // Delete and re-add all drawers
        await store.deleteAll();
        let filed = 0;
        const batchSize = 500;
        for (let i = 0; i < allIds.length; i += batchSize) {
          const batchIds = allIds.slice(i, i + batchSize);
          const batchDocs = allDocs.slice(i, i + batchSize);
          const batchMetas = allMetas.slice(i, i + batchSize);
          await store.addBatch({
            ids: batchIds,
            documents: batchDocs,
            metadatas: batchMetas,
          });
          filed += batchIds.length;
          console.log(`  Re-filed ${filed}/${allIds.length} drawers...`);
        }

        console.log(`\n  Repair complete. ${filed} drawers rebuilt.`);
        console.log(`\n${'='.repeat(55)}\n`);
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  // ── status ──────────────────────────────────────────────────────────────────
  program
    .command('status')
    .description("Show what's been filed")
    .action(async () => {
      try {
        const { status } = await import('./miner.js');
        const { getConfig } = await import('./config.js');
        const { VectorStore } = await import('./vectorStore.js');

        const config = getConfig();
        const store = new VectorStore(config);
        await store.init();
        await status(store);
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        process.exit(1);
      }
    });

  return program;
}

/**
 * Main entry point — create program and parse argv.
 */
export async function main() {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
