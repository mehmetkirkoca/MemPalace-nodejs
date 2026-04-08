import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';
import { readFileSync } from 'fs';

describe('version consistency', () => {
  it('package.json version matches version.js', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.version).toBe(VERSION);
  });
});
