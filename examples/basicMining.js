#!/usr/bin/env node
/**
 * Example: mine a project folder into the palace.
 *
 * Usage:
 *   node examples/basicMining.js [project_dir]
 */

const projectDir = process.argv[2] || '~/projects/my_app';

console.log('Step 1: Initialize rooms from folder structure');
console.log(`  mempalace init ${projectDir}`);
console.log();
console.log('Step 2: Mine everything');
console.log(`  mempalace mine ${projectDir}`);
console.log();
console.log('Step 3: Search');
console.log("  mempalace search 'why did we choose this approach'");
