import { beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let testDir;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-test-'));
  process.env.MEMPALACE_PALACE_PATH = testDir;
  process.env.QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
});

afterAll(() => {
  if (testDir) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

export function getTestDir() { return testDir; }
