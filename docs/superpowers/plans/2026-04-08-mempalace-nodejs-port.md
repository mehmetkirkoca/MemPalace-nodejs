# MemPalace Node.js Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Python MemPalace project to Node.js with Qdrant as vector DB, preserving all functionality.

**Architecture:** Modular ESM package with Commander.js CLI, Qdrant Docker service for vector storage, better-sqlite3 for knowledge graph, @huggingface/transformers for local embeddings, and @modelcontextprotocol/sdk for MCP server. A `vectorStore.js` wrapper abstracts Qdrant behind a ChromaDB-like API so all modules use a familiar interface.

**Tech Stack:** Node.js 20+, Qdrant, better-sqlite3, Commander.js, @huggingface/transformers, @modelcontextprotocol/sdk, Vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-04-08-mempalace-nodejs-port-design.md`

**Source (Python):** `/home/mehmet/Downloads/memoryPalace/mempalace/`

---

## File Structure

```
memoryPlace/
├── package.json
├── docker-compose.yml
├── Dockerfile
├── vitest.config.js
├── bin/
│   └── mempalace.js              # CLI entry (#!/usr/bin/env node)
├── src/
│   ├── index.js                  # Package exports
│   ├── version.js                # Version constant
│   ├── config.js                 # Config loading (~/.mempalace/config.json)
│   ├── embedder.js               # Text → vector (all-MiniLM-L6-v2)
│   ├── vectorStore.js            # Qdrant wrapper (ChromaDB-like API)
│   ├── knowledgeGraph.js         # SQLite temporal KG
│   ├── entityDetector.js         # Person/project detection from text
│   ├── entityRegistry.js         # Entity lookup + AAAK codes
│   ├── roomDetectorLocal.js      # Folder pattern → room name
│   ├── generalExtractor.js       # Memory type classification
│   ├── spellcheck.js             # Entity-aware spell correction
│   ├── normalize.js              # Chat format converter (6 formats)
│   ├── miner.js                  # Project file mining + chunking
│   ├── convoMiner.js             # Conversation mining
│   ├── searcher.js               # Semantic search
│   ├── dialect.js                # AAAK lossy compression
│   ├── palaceGraph.js            # Room graph + BFS traversal
│   ├── layers.js                 # L0-L3 memory stack
│   ├── splitMegaFiles.js         # Transcript splitter
│   ├── onboarding.js             # First-run wizard
│   ├── cli.js                    # Commander.js CLI
│   └── mcpServer.js              # 19 MCP tools
├── scripts/
│   └── migrateChromaToQdrant.py  # Migration script (Python)
├── tests/
│   ├── setup.js                  # Vitest global fixtures
│   ├── config.test.js
│   ├── embedder.test.js
│   ├── vectorStore.test.js
│   ├── knowledgeGraph.test.js
│   ├── entityDetector.test.js
│   ├── roomDetectorLocal.test.js
│   ├── generalExtractor.test.js
│   ├── normalize.test.js
│   ├── miner.test.js
│   ├── convoMiner.test.js
│   ├── searcher.test.js
│   ├── dialect.test.js
│   ├── splitMegaFiles.test.js
│   ├── mcpServer.test.js
│   └── versionConsistency.test.js
├── examples/
├── benchmarks/
├── hooks/
└── assets/
```

---

## Phase 1: Foundation

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `docker-compose.yml`
- Create: `Dockerfile`
- Create: `vitest.config.js`
- Create: `.gitignore`
- Create: `bin/mempalace.js`
- Create: `src/version.js`
- Create: `src/index.js`
- Create: `tests/setup.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "mempalace",
  "version": "3.0.0",
  "description": "AI memory system — store everything verbatim, make it findable through structure",
  "type": "module",
  "bin": {
    "mempalace": "./bin/mempalace.js"
  },
  "main": "./src/index.js",
  "exports": {
    ".": "./src/index.js"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/",
    "start:mcp": "node src/mcpServer.js"
  },
  "dependencies": {
    "@qdrant/qdrant-js": "^1.12.0",
    "@huggingface/transformers": "^3.4.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "better-sqlite3": "^11.8.0",
    "commander": "^13.1.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "vitest": "^3.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Create docker-compose.yml**

```yaml
version: "3.8"
services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  mempalace:
    build: .
    depends_on:
      qdrant:
        condition: service_healthy
    environment:
      - QDRANT_URL=http://qdrant:6333
      - MEMPALACE_PALACE_PATH=/data/palace
    volumes:
      - palace_data:/data/palace
    stdin_open: true
    tty: true

volumes:
  qdrant_data:
  palace_data:
```

- [ ] **Step 3: Create Dockerfile**

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache python3 make g++ curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENTRYPOINT ["node", "bin/mempalace.js"]
```

- [ ] **Step 4: Create vitest.config.js**

```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.js'],
    testTimeout: 30000,
  },
});
```

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
.env
*.log
coverage/
.vitest/
```

- [ ] **Step 6: Create src/version.js**

```javascript
export const VERSION = '3.0.0';
```

- [ ] **Step 7: Create bin/mempalace.js**

```javascript
#!/usr/bin/env node
import { main } from '../src/cli.js';
main();
```

- [ ] **Step 8: Create src/index.js**

```javascript
export { main } from './cli.js';
export { VERSION } from './version.js';
export { MempalaceConfig, getConfig } from './config.js';
export { VectorStore } from './vectorStore.js';
export { Embedder } from './embedder.js';
export { KnowledgeGraph } from './knowledgeGraph.js';
export { searchMemories } from './searcher.js';
export { Dialect } from './dialect.js';
```

- [ ] **Step 9: Create tests/setup.js**

```javascript
import { beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Temp dir for test palace data
let testDir;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-test-'));
  process.env.MEMPALACE_PALACE_PATH = testDir;
  process.env.QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

export function getTestDir() { return testDir; }
```

- [ ] **Step 10: Install dependencies**

Run: `cd /home/mehmet/Documents/htdocs/memoryPlace && npm install`
Expected: node_modules created, package-lock.json generated

- [ ] **Step 11: Create tests/versionConsistency.test.js**

```javascript
import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/version.js';
import { readFileSync } from 'fs';

describe('version consistency', () => {
  it('package.json version matches version.js', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.version).toBe(VERSION);
  });
});
```

- [ ] **Step 12: Run tests**

Run: `npx vitest run tests/versionConsistency.test.js`
Expected: PASS

- [ ] **Step 13: Commit**

```
git add -A && git commit -m "proje: Node.js scaffolding ve temel yapı"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.js`
- Create: `tests/config.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/config.py` (149 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/config.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MempalaceConfig } from '../src/config.js';

describe('MempalaceConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-cfg-'));
    process.env.MEMPALACE_PALACE_PATH = path.join(tmpDir, 'palace');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.MEMPALACE_PALACE_PATH;
    delete process.env.MEMPAL_PALACE_PATH;
  });

  it('should use default values', () => {
    const config = new MempalaceConfig(tmpDir);
    expect(config.collectionName).toBe('mempalace_drawers');
    expect(config.topicWings).toContain('emotions');
    expect(config.topicWings).toContain('technical');
  });

  it('should respect MEMPALACE_PALACE_PATH env var', () => {
    const customPath = path.join(tmpDir, 'custom_palace');
    process.env.MEMPALACE_PALACE_PATH = customPath;
    const config = new MempalaceConfig(tmpDir);
    expect(config.palacePath).toBe(customPath);
  });

  it('should respect MEMPAL_PALACE_PATH as fallback', () => {
    delete process.env.MEMPALACE_PALACE_PATH;
    const fallbackPath = path.join(tmpDir, 'fallback');
    process.env.MEMPAL_PALACE_PATH = fallbackPath;
    const config = new MempalaceConfig(tmpDir);
    expect(config.palacePath).toBe(fallbackPath);
  });

  it('should load config from file', () => {
    const configDir = tmpDir;
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ collection_name: 'custom_collection' })
    );
    const config = new MempalaceConfig(configDir);
    expect(config.collectionName).toBe('custom_collection');
  });

  it('should init and create directory', () => {
    const config = new MempalaceConfig(tmpDir);
    config.init();
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
  });

  it('should save and load people_map', () => {
    const config = new MempalaceConfig(tmpDir);
    config.init();
    config.savePeopleMap({ Alice: 'ALC', Bob: 'BOB' });
    const config2 = new MempalaceConfig(tmpDir);
    expect(config2.peopleMap).toEqual({ Alice: 'ALC', Bob: 'BOB' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement config.js**

Port from Python `config.py`. Key structure:

```javascript
// src/config.js
import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_WINGS = [
  'emotions', 'consciousness', 'memory', 'technical',
  'identity', 'family', 'creative',
];

const DEFAULT_HALL_KEYWORDS = {
  emotions: ['scared', 'afraid', 'worried', 'happy', 'sad', 'love', 'hate', 'feel', 'cry', 'tears'],
  consciousness: ['consciousness', 'conscious', 'aware', 'real', 'genuine', 'soul', 'exist', 'alive'],
  memory: ['memory', 'remember', 'forget', 'recall', 'archive', 'palace', 'store'],
  technical: ['code', 'python', 'script', 'bug', 'error', 'function', 'api', 'database', 'server'],
  identity: ['identity', 'name', 'who am i', 'persona', 'self'],
  family: ['family', 'kids', 'children', 'daughter', 'son', 'parent', 'mother', 'father'],
  creative: ['game', 'gameplay', 'player', 'app', 'design', 'art', 'music', 'story'],
};

export class MempalaceConfig {
  constructor(configDir = null) {
    this.configDir = configDir || path.join(os.homedir(), '.mempalace');
    this._loadDefaults();
    this._loadFromFile();
    this._loadFromEnv();
  }

  _loadDefaults() {
    this.palacePath = path.join(this.configDir, 'palace');
    this.collectionName = 'mempalace_drawers';
    this.topicWings = [...DEFAULT_WINGS];
    this.hallKeywords = { ...DEFAULT_HALL_KEYWORDS };
    this.qdrantUrl = 'http://localhost:6333';
    this._peopleMapFile = path.join(this.configDir, 'people_map.json');
  }

  _loadFromFile() {
    const configFile = path.join(this.configDir, 'config.json');
    if (!fs.existsSync(configFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      if (data.palace_path) this.palacePath = data.palace_path;
      if (data.collection_name) this.collectionName = data.collection_name;
      if (data.topic_wings) this.topicWings = data.topic_wings;
      if (data.hall_keywords) this.hallKeywords = data.hall_keywords;
      if (data.qdrant_url) this.qdrantUrl = data.qdrant_url;
    } catch {
      // Invalid config file — use defaults
    }
  }

  _loadFromEnv() {
    const envPath = process.env.MEMPALACE_PALACE_PATH || process.env.MEMPAL_PALACE_PATH;
    if (envPath) this.palacePath = envPath;
    if (process.env.QDRANT_URL) this.qdrantUrl = process.env.QDRANT_URL;
  }

  get peopleMap() {
    // Python'daki gibi ayrı people_map.json dosyasından oku
    if (fs.existsSync(this._peopleMapFile)) {
      try {
        return JSON.parse(fs.readFileSync(this._peopleMapFile, 'utf-8'));
      } catch {
        // fallback
      }
    }
    // Fallback: config.json içindeki people_map
    const configFile = path.join(this.configDir, 'config.json');
    if (fs.existsSync(configFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        return data.people_map || {};
      } catch { /* */ }
    }
    return {};
  }

  init() {
    fs.mkdirSync(this.configDir, { recursive: true });
    const configFile = path.join(this.configDir, 'config.json');
    if (!fs.existsSync(configFile)) {
      const defaults = {
        palace_path: this.palacePath,
        collection_name: this.collectionName,
        topic_wings: this.topicWings,
        hall_keywords: this.hallKeywords,
        people_map: this.peopleMap,
      };
      fs.writeFileSync(configFile, JSON.stringify(defaults, null, 2));
    }
  }

  savePeopleMap(peopleMap) {
    // Python'daki gibi ayrı people_map.json dosyasına yaz
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this._peopleMapFile, JSON.stringify(peopleMap, null, 2));
  }

  get identityPath() {
    return path.join(this.configDir, 'identity.txt');
  }

  get kgPath() {
    return path.join(this.configDir, 'knowledge_graph.sqlite3');
  }

  get entityRegistryPath() {
    return path.join(this.configDir, 'entity_registry.json');
  }
}

// Singleton
let _config = null;
export function getConfig(configDir = null) {
  if (!_config || configDir) {
    _config = new MempalaceConfig(configDir);
  }
  return _config;
}

export function resetConfig() {
  _config = null;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/config.js tests/config.test.js
git commit -m "config: konfigürasyon modülü eklendi"
```

---

## Phase 2: Core Infrastructure

### Task 3: Embedder Module

**Files:**
- Create: `src/embedder.js`
- Create: `tests/embedder.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// tests/embedder.test.js
import { describe, it, expect } from 'vitest';
import { Embedder } from '../src/embedder.js';

describe('Embedder', () => {
  let embedder;

  it('should create embedder instance', () => {
    embedder = new Embedder();
    expect(embedder).toBeDefined();
  });

  it('should embed single text to 384-dim vector', async () => {
    embedder = new Embedder();
    const vector = await embedder.embed('Hello world');
    expect(vector).toHaveLength(384);
    expect(typeof vector[0]).toBe('number');
  });

  it('should embed batch of texts', async () => {
    embedder = new Embedder();
    const vectors = await embedder.embedBatch(['Hello', 'World']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(384);
    expect(vectors[1]).toHaveLength(384);
  });

  it('should return similar vectors for similar text', async () => {
    embedder = new Embedder();
    const v1 = await embedder.embed('The cat sat on the mat');
    const v2 = await embedder.embed('A cat is sitting on a mat');
    const v3 = await embedder.embed('Nuclear physics equation');
    // Cosine similarity — similar texts should be closer
    const sim12 = cosineSim(v1, v2);
    const sim13 = cosineSim(v1, v3);
    expect(sim12).toBeGreaterThan(sim13);
  });
});

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/embedder.test.js`
Expected: FAIL

- [ ] **Step 3: Implement embedder.js**

```javascript
// src/embedder.js
import { pipeline } from '@huggingface/transformers';

export class Embedder {
  constructor(modelName = 'Xenova/all-MiniLM-L6-v2') {
    this._modelName = modelName;
    this._pipe = null;
  }

  async _getPipeline() {
    if (!this._pipe) {
      this._pipe = await pipeline('feature-extraction', this._modelName, {
        dtype: 'fp32',
      });
    }
    return this._pipe;
  }

  async embed(text) {
    const pipe = await this._getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  }

  async embedBatch(texts) {
    const pipe = await this._getPipeline();
    const results = [];
    // Process in batches for memory efficiency
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data));
    }
    return results;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/embedder.test.js`
Expected: PASS (model indirme ilk seferde ~1 dakika sürebilir)

- [ ] **Step 5: Commit**

```
git add src/embedder.js tests/embedder.test.js
git commit -m "embedder: text-to-vector embedding modülü eklendi"
```

---

### Task 4: VectorStore Module (Qdrant Wrapper)

**Files:**
- Create: `src/vectorStore.js`
- Create: `tests/vectorStore.test.js`

Requires: Qdrant running (`docker compose up -d qdrant`)

- [ ] **Step 1: Write failing test**

```javascript
// tests/vectorStore.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { VectorStore } from '../src/vectorStore.js';

describe('VectorStore', () => {
  let store;
  const testCollection = 'test_mempalace_' + Date.now();

  beforeAll(async () => {
    store = new VectorStore({
      qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
      collectionName: testCollection,
    });
    await store.init();
  });

  afterAll(async () => {
    await store.deleteCollection();
  });

  it('should add documents with metadata', async () => {
    await store.add({
      ids: ['doc1', 'doc2'],
      documents: ['The cat sat on the mat', 'Dogs are loyal animals'],
      metadatas: [
        { wing: 'test_wing', room: 'animals' },
        { wing: 'test_wing', room: 'animals' },
      ],
    });
    const count = await store.count();
    expect(count).toBe(2);
  });

  it('should search by text similarity', async () => {
    const results = await store.query({
      queryTexts: ['feline sitting'],
      nResults: 2,
    });
    expect(results.documents.length).toBeGreaterThan(0);
    expect(results.ids.length).toBeGreaterThan(0);
  });

  it('should filter by wing', async () => {
    await store.add({
      ids: ['doc3'],
      documents: ['Python is a programming language'],
      metadatas: [{ wing: 'other_wing', room: 'tech' }],
    });

    const results = await store.query({
      queryTexts: ['programming'],
      nResults: 5,
      where: { wing: 'test_wing' },
    });

    const wings = results.metadatas.map(m => m.wing);
    wings.forEach(w => expect(w).toBe('test_wing'));
  });

  it('should filter with $and', async () => {
    const results = await store.query({
      queryTexts: ['cat'],
      nResults: 5,
      where: { $and: [{ wing: 'test_wing' }, { room: 'animals' }] },
    });
    expect(results.documents.length).toBeGreaterThan(0);
  });

  it('should filter with $or', async () => {
    const results = await store.query({
      queryTexts: ['animal'],
      nResults: 5,
      where: { $or: [{ wing: 'test_wing' }, { wing: 'other_wing' }] },
    });
    expect(results.documents.length).toBeGreaterThan(0);
  });

  it('should get by filter (scroll)', async () => {
    const results = await store.get({
      where: { wing: 'test_wing' },
      limit: 10,
    });
    expect(results.ids.length).toBe(2);
  });

  it('should delete by id', async () => {
    await store.delete({ ids: ['doc3'] });
    const count = await store.count();
    expect(count).toBe(2);
  });

  it('should check duplicate', async () => {
    const isDup = await store.checkDuplicate('The cat sat on the mat', 0.9);
    expect(isDup).toBe(true);

    const isNotDup = await store.checkDuplicate('Quantum physics theory', 0.9);
    expect(isNotDup).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vectorStore.test.js`
Expected: FAIL

- [ ] **Step 3: Implement vectorStore.js**

```javascript
// src/vectorStore.js
import { QdrantClient } from '@qdrant/qdrant-js';
import { Embedder } from './embedder.js';
import { createHash } from 'crypto';

export class VectorStore {
  constructor({ qdrantUrl = 'http://localhost:6333', collectionName = 'mempalace_drawers' } = {}) {
    this._client = new QdrantClient({ url: qdrantUrl });
    this._collectionName = collectionName;
    this._embedder = new Embedder();
    this._idMap = new Map(); // string id → uuid mapping
  }

  async init() {
    const collections = await this._client.getCollections();
    const exists = collections.collections.some(c => c.name === this._collectionName);
    if (!exists) {
      await this._client.createCollection(this._collectionName, {
        vectors: { size: 384, distance: 'Cosine' },
      });
    }
  }

  // --- ChromaDB-compatible API ---

  async add({ ids, documents, metadatas }) {
    const vectors = await this._embedder.embedBatch(documents);
    const points = ids.map((id, i) => {
      const uuid = this._toUUID(id);
      return {
        id: uuid,
        vector: vectors[i],
        payload: {
          document: documents[i],
          original_id: id,
          ...metadatas[i],
        },
      };
    });

    // Batch upsert (500 per batch)
    for (let i = 0; i < points.length; i += 500) {
      const batch = points.slice(i, i + 500);
      await this._client.upsert(this._collectionName, { points: batch });
    }
  }

  async query({ queryTexts, nResults = 5, where = null }) {
    const queryVector = await this._embedder.embed(queryTexts[0]);
    const filter = where ? this._buildFilter(where) : undefined;

    const results = await this._client.search(this._collectionName, {
      vector: queryVector,
      limit: nResults,
      filter,
      with_payload: true,
    });

    return this._formatResults(results);
  }

  async get({ where = null, limit = 100 }) {
    const filter = where ? this._buildFilter(where) : undefined;
    const results = [];
    let offset = undefined; // Qdrant scroll expects undefined for first call, not null

    while (true) {
      const scrollParams = {
        filter,
        limit: Math.min(limit - results.length, 100),
        with_payload: true,
        with_vector: false,
      };
      if (offset !== undefined) scrollParams.offset = offset;

      const page = await this._client.scroll(this._collectionName, scrollParams);

      results.push(...page.points);
      if (!page.next_page_offset || results.length >= limit) break;
      offset = page.next_page_offset;
    }

    return {
      ids: results.map(r => r.payload.original_id || r.id),
      documents: results.map(r => r.payload.document),
      metadatas: results.map(r => {
        const { document, original_id, ...meta } = r.payload;
        return meta;
      }),
    };
  }

  async delete({ ids }) {
    const uuids = ids.map(id => this._toUUID(id));
    await this._client.delete(this._collectionName, { points: uuids });
  }

  async count() {
    const result = await this._client.count(this._collectionName);
    return result.count;
  }

  async checkDuplicate(text, threshold = 0.9) {
    const vector = await this._embedder.embed(text);
    const results = await this._client.search(this._collectionName, {
      vector,
      limit: 1,
      with_payload: false,
    });
    if (results.length === 0) return false;
    return results[0].score >= threshold;
  }

  async deleteCollection() {
    try {
      await this._client.deleteCollection(this._collectionName);
    } catch {
      // Collection might not exist
    }
  }

  // --- Internal ---

  _buildFilter(where) {
    if (where.$and) {
      return {
        must: where.$and.map(cond => this._buildCondition(cond)),
      };
    }
    if (where.$or) {
      return {
        should: where.$or.map(cond => this._buildCondition(cond)),
      };
    }
    // Simple key-value
    return {
      must: [this._buildCondition(where)],
    };
  }

  _buildCondition(cond) {
    const [key, value] = Object.entries(cond)[0];
    return { key, match: { value } };
  }

  _toUUID(stringId) {
    // Deterministic UUID v5 — must match migration script's uuid.uuid5(NAMESPACE_DNS, "mempalace.{id}")
    if (this._idMap.has(stringId)) return this._idMap.get(stringId);
    const uuid = uuidV5(`mempalace.${stringId}`);
    this._idMap.set(stringId, uuid);
    return uuid;
  }

  _formatResults(results) {
    return {
      ids: results.map(r => r.payload?.original_id || r.id),
      documents: results.map(r => r.payload?.document || ''),
      metadatas: results.map(r => {
        if (!r.payload) return {};
        const { document, original_id, ...meta } = r.payload;
        return meta;
      }),
      distances: results.map(r => 1 - r.score), // Qdrant score → distance
    };
  }
}

// UUID v5 implementation (RFC 4122) — matches Python's uuid.uuid5(NAMESPACE_DNS, name)
const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidV5(name) {
  const namespaceBytes = parseUUID(DNS_NAMESPACE);
  const nameBytes = Buffer.from(name, 'utf-8');
  const hashInput = Buffer.concat([namespaceBytes, nameBytes]);
  const hash = createHash('sha1').update(hashInput).digest();

  // Set version (5) and variant (RFC 4122)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseUUID(uuidStr) {
  const hex = uuidStr.replace(/-/g, '');
  return Buffer.from(hex, 'hex');
}
```

- [ ] **Step 4: Start Qdrant and run tests**

Run: `cd /home/mehmet/Documents/htdocs/memoryPlace && docker compose up -d qdrant && npx vitest run tests/vectorStore.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/vectorStore.js tests/vectorStore.test.js
git commit -m "vectorStore: Qdrant wrapper modülü eklendi"
```

---

### Task 5: Knowledge Graph Module

**Files:**
- Create: `src/knowledgeGraph.js`
- Create: `tests/knowledgeGraph.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/knowledge_graph.py` (387 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/knowledgeGraph.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph } from '../src/knowledgeGraph.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('KnowledgeGraph', () => {
  let kg;
  let dbPath;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-test-'));
    dbPath = path.join(tmpDir, 'test_kg.sqlite3');
    kg = new KnowledgeGraph(dbPath);
  });

  afterEach(() => {
    kg.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('should add and query entity', () => {
    kg.addEntity('alice', 'Alice', 'person');
    const entity = kg.getEntity('alice');
    expect(entity.name).toBe('Alice');
    expect(entity.type).toBe('person');
  });

  it('should add and query triple', () => {
    kg.addTriple('Alice', 'works_on', 'MemPalace', { validFrom: '2025-06-01' });
    const results = kg.queryEntity('Alice');
    expect(results.length).toBe(1);
    expect(results[0].predicate).toBe('works_on');
    expect(results[0].object).toBe('MemPalace');
  });

  it('should invalidate triple', () => {
    kg.addTriple('Max', 'works_on', 'Orion', { validFrom: '2025-01-01' });
    kg.invalidate('Max', 'works_on', 'Orion', '2026-03-01');
    const results = kg.queryEntity('Max', { asOf: '2026-04-01' });
    expect(results.length).toBe(0);
  });

  it('should query with temporal filter', () => {
    kg.addTriple('Max', 'works_on', 'Orion', { validFrom: '2025-01-01' });
    kg.addTriple('Max', 'works_on', 'Nova', { validFrom: '2026-01-01' });

    const before = kg.queryEntity('Max', { asOf: '2025-06-01' });
    expect(before.length).toBe(1);
    expect(before[0].object).toBe('Orion');

    const after = kg.queryEntity('Max', { asOf: '2026-06-01' });
    expect(after.length).toBe(2);
  });

  it('should return timeline', () => {
    kg.addTriple('Orion', 'status', 'planning', { validFrom: '2025-01-01' });
    kg.addTriple('Orion', 'status', 'development', { validFrom: '2025-06-01' });
    const tl = kg.timeline('Orion');
    expect(tl.length).toBe(2);
    expect(tl[0].predicate).toBe('status');
  });

  it('should return stats', () => {
    kg.addEntity('alice', 'Alice', 'person');
    kg.addTriple('Alice', 'knows', 'Bob');
    const stats = kg.stats();
    expect(stats.entities).toBe(1);
    expect(stats.triples).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/knowledgeGraph.test.js`
Expected: FAIL

- [ ] **Step 3: Implement knowledgeGraph.js**

Port from `knowledge_graph.py`. Uses better-sqlite3 (senkron API). Key patterns:
- SQLite tables: `entities` (id, name, type, properties, created_at), `triples` (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file, extracted_at)
- `addTriple()` generates deterministic ID from subject+predicate+object hash
- `queryEntity()` supports `direction` (outgoing/incoming/both) and `asOf` temporal filter
- `invalidate()` sets `valid_to` on matching triples
- `timeline()` returns chronologically sorted triples for an entity
- `stats()` returns counts

```javascript
// src/knowledgeGraph.js
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import path from 'path';
import { getConfig } from './config.js';

export class KnowledgeGraph {
  constructor(dbPath = null) {
    const config = dbPath ? null : getConfig();
    this._dbPath = dbPath || config.kgPath;
    this._db = new Database(this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._initTables();
  }

  _initTables() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        source_closet TEXT,
        source_file TEXT,
        extracted_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
    `);
  }

  _entityId(name) {
    return name.toLowerCase().replace(/ /g, '_').replace(/'/g, '');
  }

  addEntity(name, type, properties = {}) {
    const id = this._entityId(name);
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO entities (id, name, type, properties) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, name, type, JSON.stringify(properties));
  }

  getEntity(nameOrId) {
    const id = this._entityId(nameOrId);
    const row = this._db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, properties: JSON.parse(row.properties) };
  }

  addTriple(subject, predicate, object, options = {}) {
    const { validFrom = null, validTo = null, confidence = 1.0, sourceCloset = null, sourceFile = null } = options;
    const subId = this._entityId(subject);
    const objId = this._entityId(object);
    const id = this._tripleId(subId, predicate, objId, validFrom);

    // Auto-create entities if they don't exist
    this._db.prepare('INSERT OR IGNORE INTO entities (id, name, type) VALUES (?, ?, ?)').run(subId, subject, 'unknown');
    this._db.prepare('INSERT OR IGNORE INTO entities (id, name, type) VALUES (?, ?, ?)').run(objId, object, 'unknown');

    const stmt = this._db.prepare(
      `INSERT OR REPLACE INTO triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, subId, predicate, objId, validFrom, validTo, confidence, sourceCloset, sourceFile);
    return id;
  }

  invalidate(subject, predicate, object, ended) {
    const subId = this._entityId(subject);
    const objId = this._entityId(object);
    const stmt = this._db.prepare(
      `UPDATE triples SET valid_to = ?
       WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL`
    );
    return stmt.run(ended, subId, predicate, objId);
  }

  queryEntity(entity, options = {}) {
    const { asOf = null, direction = 'both' } = options;
    const entityId = this._entityId(entity);
    let rows = [];

    if (direction === 'outgoing' || direction === 'both') {
      let query = 'SELECT t.*, e.name as obj_name FROM triples t LEFT JOIN entities e ON t.object = e.id WHERE t.subject = ?';
      const params = [entityId];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?)';
        query += ' AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      rows.push(...this._db.prepare(query).all(...params));
    }

    if (direction === 'incoming' || direction === 'both') {
      let query = 'SELECT t.*, e.name as subj_name FROM triples t LEFT JOIN entities e ON t.subject = e.id WHERE t.object = ?';
      const params = [entityId];
      if (asOf) {
        query += ' AND (t.valid_from IS NULL OR t.valid_from <= ?)';
        query += ' AND (t.valid_to IS NULL OR t.valid_to >= ?)';
        params.push(asOf, asOf);
      }
      const incoming = this._db.prepare(query).all(...params);
      rows.push(...incoming);
    }

    // Deduplicate by id
    const seen = new Set();
    return rows.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
  }

  queryRelationship(predicate) {
    return this._db.prepare('SELECT * FROM triples WHERE predicate = ?').all(predicate);
  }

  timeline(entity) {
    return this._db.prepare(
      `SELECT * FROM triples
       WHERE subject = ? OR object = ?
       ORDER BY COALESCE(valid_from, extracted_at, '0000') ASC`
    ).all(entity, entity);
  }

  stats() {
    const entities = this._db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
    const triples = this._db.prepare('SELECT COUNT(*) as count FROM triples').get().count;
    const activeTriples = this._db.prepare('SELECT COUNT(*) as count FROM triples WHERE valid_to IS NULL').get().count;
    const predicates = this._db.prepare('SELECT DISTINCT predicate FROM triples').all().map(r => r.predicate);
    return { entities, triples, activeTriples, predicates };
  }

  seedFromEntityFacts(entityName, facts) {
    for (const fact of facts) {
      this.addTriple(entityName, fact.predicate, fact.object, {
        validFrom: fact.validFrom,
        confidence: fact.confidence || 1.0,
      });
    }
  }

  close() {
    this._db.close();
  }

  _tripleId(subject, predicate, object, validFrom) {
    const raw = `${subject}|${predicate}|${object}|${validFrom || ''}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/knowledgeGraph.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add src/knowledgeGraph.js tests/knowledgeGraph.test.js
git commit -m "knowledgeGraph: SQLite temporal knowledge graph eklendi"
```

---

## Phase 3: Detection & Extraction

### Task 6: Entity Detector

**Files:**
- Create: `src/entityDetector.js`
- Create: `tests/entityDetector.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/entity_detector.py` (853 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/entityDetector.test.js
import { describe, it, expect } from 'vitest';
import { extractCandidates, scoreEntity, classifyEntity, detectEntities } from '../src/entityDetector.js';

describe('EntityDetector', () => {
  it('should extract capitalized candidates', () => {
    const text = 'Alice said hello to Bob. Alice went home. Alice loves coding.';
    const candidates = extractCandidates(text);
    expect(candidates).toContain('Alice');
  });

  it('should score person signals', () => {
    const text = 'Alice said she loves the project. Alice laughed and told Bob about it.';
    const score = scoreEntity('Alice', text);
    expect(score.personScore).toBeGreaterThan(0);
  });

  it('should score project signals', () => {
    const text = 'We are building MemPalace. MemPalace v2.0 was shipped. import mempalace.';
    const score = scoreEntity('MemPalace', text);
    expect(score.projectScore).toBeGreaterThan(0);
  });

  it('should classify person vs project', () => {
    const personText = 'Alice said she was happy. Alice told me about her day.';
    const result = classifyEntity('Alice', personText);
    expect(result.type).toBe('person');

    const projectText = 'Building Aurora. Aurora v1.0 shipped. Deployed Aurora to prod.';
    const result2 = classifyEntity('Aurora', projectText);
    expect(result2.type).toBe('project');
  });

  it('should filter stopwords', () => {
    const text = 'The Monday meeting was good. Monday came and Monday went.';
    const candidates = extractCandidates(text);
    expect(candidates).not.toContain('The');
    expect(candidates).not.toContain('Monday');
  });
});
```

- [ ] **Step 2: Run test, verify fail, implement, run test, commit**

Port the full entity_detector.py — extract candidates (capitalized words 3+ occurrences), person verbs (said, told, laughed, felt...), project verbs (building, shipped, deployed...), dialogue patterns, pronoun resolution, confidence scoring, stopwords list.

- [ ] **Step 3: Commit**

```
git add src/entityDetector.js tests/entityDetector.test.js
git commit -m "entityDetector: entity extraction modülü eklendi"
```

---

### Task 7: Entity Registry

**Files:**
- Create: `src/entityRegistry.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/entity_registry.py` (639 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port entity_registry.py. Key features: JSON storage at `~/.mempalace/entity_registry.json`, `lookup()` with context disambiguation, `seed()` from onboarding, ambiguous words list (grace, will, may, hope, faith...), AAAK code generation (name → 3-letter uppercase), `extractPeopleFromQuery()`.

- [ ] **Step 2: Commit**

```
git add src/entityRegistry.js tests/entityRegistry.test.js
git commit -m "entityRegistry: entity kayıt ve lookup modülü eklendi"
```

---

### Task 8: Room Detector Local

**Files:**
- Create: `src/roomDetectorLocal.js`
- Create: `tests/roomDetectorLocal.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/room_detector_local.py` (310 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port room_detector_local.py. Key: 70+ folder patterns → room names (src/frontend → frontend, docs → documentation, tests → testing, etc.), `detectRoomsFromFolders()`, `detectRoomsFromFiles()`, `saveConfig()` writes `mempalace.yaml`.

- [ ] **Step 2: Commit**

```
git add src/roomDetectorLocal.js tests/roomDetectorLocal.test.js
git commit -m "roomDetectorLocal: folder pattern room detection eklendi"
```

---

### Task 9: General Extractor

**Files:**
- Create: `src/generalExtractor.js`
- Create: `tests/generalExtractor.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/general_extractor.py` (521 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/generalExtractor.test.js
import { describe, it, expect } from 'vitest';
import { extractMemories } from '../src/generalExtractor.js';

describe('GeneralExtractor', () => {
  it('should extract decisions', () => {
    const text = '> user\nWe decided to use PostgreSQL instead of MySQL because of JSON support.';
    const memories = extractMemories(text);
    const decisions = memories.filter(m => m.memoryType === 'decision');
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('should extract preferences', () => {
    const text = '> user\nI always use dark mode. Never use tabs, always spaces.';
    const memories = extractMemories(text);
    const prefs = memories.filter(m => m.memoryType === 'preference');
    expect(prefs.length).toBeGreaterThan(0);
  });

  it('should extract milestones', () => {
    const text = '> user\nIt finally works! We shipped v2.0 today.';
    const memories = extractMemories(text);
    const milestones = memories.filter(m => m.memoryType === 'milestone');
    expect(milestones.length).toBeGreaterThan(0);
  });

  it('should extract problems', () => {
    const text = '> user\nThere is a critical bug in the auth module. Login crashes on mobile.';
    const memories = extractMemories(text);
    const problems = memories.filter(m => m.memoryType === 'problem');
    expect(problems.length).toBeGreaterThan(0);
  });

  it('should skip code blocks', () => {
    const text = '```\nfunction decide() { return true; }\n```';
    const memories = extractMemories(text);
    const decisions = memories.filter(m => m.memoryType === 'decision');
    expect(decisions.length).toBe(0);
  });
});
```

- [ ] **Step 2: Implement, test, commit**

Port general_extractor.py. 5 memory types: decision, preference, milestone, problem, emotional. Pattern-based regex scoring, code line stripping, segment splitting, disambiguation.

- [ ] **Step 3: Commit**

```
git add src/generalExtractor.js tests/generalExtractor.test.js
git commit -m "generalExtractor: memory type classification eklendi"
```

---

### Task 10: Spellcheck (Opsiyonel)

**Files:**
- Create: `src/spellcheck.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/spellcheck.py` (269 satır)

- [ ] **Step 1: Implement minimal spellcheck**

Port spellcheck.py. This module is optional — implement the `spellcheckUserText()` and `shouldSkip()` functions. Skip words are: technical terms (with digits/hyphens/underscores), CamelCase, ALL_CAPS, known entities, URLs, file paths, short words (<4 chars). If no spell library available, return text unchanged.

- [ ] **Step 2: Commit**

```
git add src/spellcheck.js
git commit -m "spellcheck: entity-aware spell correction eklendi (opsiyonel)"
```

---

## Phase 4: Data Processing

### Task 11: Normalize Module

**Files:**
- Create: `src/normalize.js`
- Create: `tests/normalize.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/normalize.py` (328 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/normalize.test.js
import { describe, it, expect } from 'vitest';
import { normalize } from '../src/normalize.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('normalize', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should pass through plain text with > markers', () => {
    const file = path.join(tmpDir, 'chat.txt');
    fs.writeFileSync(file, '> user\nHello\nassistant\nHi there');
    const result = normalize(file);
    expect(result).toContain('> user');
  });

  it('should normalize Claude Code JSONL', () => {
    const file = path.join(tmpDir, 'chat.jsonl');
    const lines = [
      JSON.stringify({ type: 'human', message: { content: 'Hello' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Hi' } }),
    ];
    fs.writeFileSync(file, lines.join('\n'));
    const result = normalize(file);
    expect(result).toContain('> user');
    expect(result).toContain('Hello');
  });

  it('should normalize ChatGPT JSON', () => {
    const file = path.join(tmpDir, 'conversations.json');
    const data = [{
      title: 'Test',
      mapping: {
        'a': { message: { author: { role: 'user' }, content: { parts: ['Hello'] } }, children: ['b'] },
        'b': { message: { author: { role: 'assistant' }, content: { parts: ['Hi'] } }, children: [] },
      },
    }];
    fs.writeFileSync(file, JSON.stringify(data));
    const result = normalize(file);
    expect(result).toContain('Hello');
  });
});
```

- [ ] **Step 2: Implement, test, commit**

Port all 6 format parsers from normalize.py: plain text, Claude Code JSONL, ChatGPT JSON, Claude.ai JSON, Slack JSON, OpenAI Codex JSONL.

- [ ] **Step 3: Commit**

```
git add src/normalize.js tests/normalize.test.js
git commit -m "normalize: 6 chat format dönüştürücü eklendi"
```

---

### Task 12: Miner Module

**Files:**
- Create: `src/miner.js`
- Create: `tests/miner.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/miner.py` (672 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/miner.test.js
import { describe, it, expect } from 'vitest';
import { chunkText, GitignoreMatcher } from '../src/miner.js';

describe('Miner', () => {
  describe('chunkText', () => {
    it('should chunk text at paragraph boundaries', () => {
      const text = 'A'.repeat(400) + '\n\n' + 'B'.repeat(400) + '\n\n' + 'C'.repeat(400);
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should respect CHUNK_SIZE', () => {
      const text = 'Word '.repeat(500);
      const chunks = chunkText(text);
      chunks.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(900); // 800 + overlap
      });
    });

    it('should skip small chunks', () => {
      const text = 'Hi';
      const chunks = chunkText(text);
      expect(chunks.length).toBe(0); // < MIN_CHUNK_SIZE (50)
    });
  });

  describe('GitignoreMatcher', () => {
    it('should match gitignore patterns', () => {
      const matcher = new GitignoreMatcher(['node_modules/', '*.pyc', '.git/']);
      expect(matcher.matches('node_modules/foo.js')).toBe(true);
      expect(matcher.matches('src/main.js')).toBe(false);
      expect(matcher.matches('cache.pyc')).toBe(true);
    });

    it('should handle negation patterns', () => {
      const matcher = new GitignoreMatcher(['*.log', '!important.log']);
      expect(matcher.matches('debug.log')).toBe(true);
      expect(matcher.matches('important.log')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Implement, test, commit**

Port miner.py: `GitignoreMatcher` class (pattern parsing, negation support), `loadConfig()` (reads mempalace.yaml), `detectRoom()` (path/filename/content keyword matching), `chunkText()` (800 char, 100 overlap, paragraph → line → hard break), `scanProject()` (recursive walk with .gitignore), `mine()` (orchestration → vectorStore.add), `status()` (drawer counts). Skip dirs: `.git`, `node_modules`, `__pycache__`, `.next`, `dist`, `build`, etc.

- [ ] **Step 3: Commit**

```
git add src/miner.js tests/miner.test.js
git commit -m "miner: dosya mining ve chunking modülü eklendi"
```

---

### Task 13: Conversation Miner

**Files:**
- Create: `src/convoMiner.js`
- Create: `tests/convoMiner.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/convo_miner.py` (404 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port convo_miner.py: `chunkExchanges()` (Q+A pair grouping), `detectConvoRoom()` (keyword scoring for technical/architecture/planning/decisions/problems rooms), `mineConvos()` (normalize → chunk → detect room → vectorStore.add). Two modes: "exchange" and "general" (uses generalExtractor).

- [ ] **Step 2: Commit**

```
git add src/convoMiner.js tests/convoMiner.test.js
git commit -m "convoMiner: konuşma mining modülü eklendi"
```

---

### Task 14: Split Mega Files

**Files:**
- Create: `src/splitMegaFiles.js`
- Create: `tests/splitMegaFiles.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/split_mega_files.py` (309 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port split_mega_files.py: `findSessionBoundaries()` (detect "Claude Code v" headers), `extractTimestamp()`, `extractPeople()`, `extractSubject()`, naming convention: `{stem}__{timestamp}_{people}_{subject}.txt`, backup originals as `.mega_backup`.

- [ ] **Step 2: Commit**

```
git add src/splitMegaFiles.js tests/splitMegaFiles.test.js
git commit -m "splitMegaFiles: transcript splitter eklendi"
```

---

### Task 15: Dialect (AAAK Compression)

**Files:**
- Create: `src/dialect.js`
- Create: `tests/dialect.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/dialect.py` (1075 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/dialect.test.js
import { describe, it, expect } from 'vitest';
import { Dialect } from '../src/dialect.js';

describe('Dialect', () => {
  let dialect;

  beforeEach(() => {
    dialect = new Dialect({ Alice: 'ALC', Bob: 'BOB' });
  });

  it('should encode entity to 3-letter code', () => {
    expect(dialect.encodeEntity('Alice')).toBe('ALC');
  });

  it('should detect emotions', () => {
    const text = 'I feel so happy and grateful today.';
    const emotions = dialect.detectEmotions(text);
    expect(emotions.length).toBeGreaterThan(0);
  });

  it('should detect flags', () => {
    const text = 'We decided to switch from REST to GraphQL. This was a pivotal moment.';
    const flags = dialect.detectFlags(text);
    expect(flags).toContain('DECISION');
  });

  it('should compress text', () => {
    const text = 'Alice said she loves working on MemPalace with Bob.';
    const compressed = dialect.compress(text, { fileNum: 1 });
    expect(compressed.length).toBeLessThan(text.length);
    expect(compressed).toContain('ALC');
  });

  it('should calculate compression stats', () => {
    const original = 'A'.repeat(1000);
    const compressed = dialect.compress(original, { fileNum: 1 });
    const stats = dialect.compressionStats(original, compressed);
    expect(stats.ratio).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement, test, commit**

Port dialect.py (1075 satır). Key: `Dialect` class with entity code mapping, emotion keyword sets (29 emotions), flag detection (ORIGIN, CORE, SENSITIVE, PIVOT, GENESIS, DECISION, TECHNICAL), AAAK pipe-separated format (header, zettel, tunnel, arc lines), `countTokens()` (~1 token per 4 chars), `compressionStats()`.

- [ ] **Step 3: Commit**

```
git add src/dialect.js tests/dialect.test.js
git commit -m "dialect: AAAK lossy compression eklendi"
```

---

## Phase 5: Search & Navigation

### Task 16: Searcher Module

**Files:**
- Create: `src/searcher.js`
- Create: `tests/searcher.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/searcher.py` (152 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port searcher.py: `search()` (prints results with similarity), `searchMemories()` (returns dict). Uses vectorStore.query() with optional wing/room filters.

- [ ] **Step 2: Commit**

```
git add src/searcher.js tests/searcher.test.js
git commit -m "searcher: semantic search modülü eklendi"
```

---

### Task 17: Palace Graph

**Files:**
- Create: `src/palaceGraph.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/palace_graph.py` (227 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port palace_graph.py: `buildGraph()` (rooms as nodes from vectorStore metadata), `traverse()` (BFS from start room with maxHops), `findTunnels()` (rooms bridging two wings), `graphStats()` (connectivity overview).

- [ ] **Step 2: Commit**

```
git add src/palaceGraph.js tests/palaceGraph.test.js
git commit -m "palaceGraph: room navigasyonu ve BFS traversal eklendi"
```

---

### Task 18: Layers (Memory Stack)

**Files:**
- Create: `src/layers.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/layers.py` (515 satır)

- [ ] **Step 1: Write test, implement, test, commit**

Port layers.py: `Layer0` (identity.txt), `Layer1` (critical facts from top drawers), `Layer2` (on-demand wing/room retrieval), `Layer3` (deep semantic search), `MemoryStack` (unified interface), `wakeUp()` (L0 + L1), `recall()` (L2), `search()` (L3), `status()`.

- [ ] **Step 2: Commit**

```
git add src/layers.js
git commit -m "layers: L0-L3 memory stack eklendi"
```

---

## Phase 6: Interface

### Task 19: Onboarding

**Files:**
- Create: `src/onboarding.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/onboarding.py` (489 satır)

- [ ] **Step 1: Implement, commit**

Port onboarding.py: `runOnboarding()` (interactive readline-based wizard), `quickSetup()` (programmatic). Steps: mode selection → people entry → projects → wings → auto-detect from files → ambiguity warnings → generate identity.txt + entity registry.

- [ ] **Step 2: Commit**

```
git add src/onboarding.js
git commit -m "onboarding: ilk kurulum wizard eklendi"
```

---

### Task 20: CLI

**Files:**
- Create: `src/cli.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/cli.py` (483 satır)

- [ ] **Step 1: Implement CLI with Commander.js**

```javascript
// src/cli.js
import { Command } from 'commander';
import { VERSION } from './version.js';

export function main() {
  const program = new Command();

  program
    .name('mempalace')
    .description('AI memory system — store everything verbatim')
    .version(VERSION);

  program
    .command('init <dir>')
    .description('Initialize palace from project directory')
    .action(async (dir) => {
      const { initCommand } = await import('./commands/init.js');
      // Or inline: detect rooms, create mempalace.yaml, run onboarding
    });

  program
    .command('mine <dir>')
    .description('Mine project files into palace')
    .option('--mode <mode>', 'Mining mode: files or convos', 'files')
    .option('--wing <wing>', 'Target wing name')
    .option('--extract <type>', 'Extraction type for convos', 'exchange')
    .action(async (dir, opts) => {
      // mine or mineConvos based on mode
    });

  program
    .command('search <query>')
    .description('Semantic search in palace')
    .option('--wing <wing>', 'Filter by wing')
    .option('--room <room>', 'Filter by room')
    .action(async (query, opts) => {
      // searcher.search()
    });

  program
    .command('wake-up')
    .description('Load L0 + L1 memory context')
    .option('--wing <wing>', 'Project-specific wake-up')
    .action(async (opts) => {
      // layers.wakeUp()
    });

  program
    .command('split <dir>')
    .description('Split mega transcript files')
    .action(async (dir) => {
      // splitMegaFiles
    });

  program
    .command('compress')
    .description('AAAK compress drawers')
    .option('--wing <wing>', 'Target wing')
    .option('--dry-run', 'Preview without storing')
    .action(async (opts) => {
      // dialect.compress
    });

  program
    .command('repair')
    .description('Rebuild vector index')
    .action(async () => {
      // repair logic
    });

  program
    .command('status')
    .description('Show palace overview')
    .action(async () => {
      // status from miner + kg
    });

  program.parse();
}
```

- [ ] **Step 2: Commit**

```
git add src/cli.js
git commit -m "cli: Commander.js CLI arayüzü eklendi"
```

---

### Task 21: MCP Server

**Files:**
- Create: `src/mcpServer.js`
- Create: `tests/mcpServer.test.js`
- Reference: `/home/mehmet/Downloads/memoryPalace/mempalace/mcp_server.py` (784 satır)

- [ ] **Step 1: Write failing test**

```javascript
// tests/mcpServer.test.js
import { describe, it, expect } from 'vitest';
import { getToolDefinitions } from '../src/mcpServer.js';

describe('MCP Server', () => {
  it('should define all 19 tools', () => {
    const tools = getToolDefinitions();
    expect(tools.length).toBe(19);
  });

  it('should have correct tool names', () => {
    const tools = getToolDefinitions();
    const names = tools.map(t => t.name);
    expect(names).toContain('mempalace_status');
    expect(names).toContain('mempalace_search');
    expect(names).toContain('mempalace_add_drawer');
    expect(names).toContain('mempalace_kg_query');
    expect(names).toContain('mempalace_traverse');
    expect(names).toContain('mempalace_diary_write');
  });
});
```

- [ ] **Step 2: Implement MCP server with @modelcontextprotocol/sdk**

Port all 19 tools from mcp_server.py. Each tool maps to a handler function that calls the appropriate module (searcher, vectorStore, knowledgeGraph, palaceGraph, dialect).

Tool groups:
- Read (7): status, list_wings, list_rooms, get_taxonomy, search, check_duplicate, get_aaak_spec
- Write (2): add_drawer, delete_drawer
- KG (5): kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats
- Navigation (3): traverse, find_tunnels, graph_stats
- Diary (2): diary_write, diary_read

- [ ] **Step 3: Commit**

```
git add src/mcpServer.js tests/mcpServer.test.js
git commit -m "mcpServer: 19 MCP tool eklendi"
```

---

## Phase 7: Docker, Migration & Static Assets

### Task 22: Migration Script

**Files:**
- Create: `scripts/migrateChromaToQdrant.py`

- [ ] **Step 1: Write migration script**

```python
#!/usr/bin/env python3
"""Migrate existing ChromaDB palace to Qdrant.

Usage:
    pip install chromadb qdrant-client
    python scripts/migrateChromaToQdrant.py \
        --chroma-path ~/.mempalace/palace \
        --qdrant-url http://localhost:6333 \
        --collection mempalace_drawers
"""
import argparse
import uuid
import hashlib
import chromadb
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

def deterministic_uuid(string_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mempalace.{string_id}"))

def migrate(chroma_path: str, qdrant_url: str, collection_name: str):
    # Connect to ChromaDB
    chroma = chromadb.PersistentClient(path=chroma_path)
    col = chroma.get_collection(collection_name)

    # Get all data with embeddings
    data = col.get(include=["documents", "metadatas", "embeddings"])
    total = len(data["ids"])
    print(f"Found {total} drawers in ChromaDB")

    if total == 0:
        print("Nothing to migrate")
        return

    # Connect to Qdrant
    qdrant = QdrantClient(url=qdrant_url)

    # Create collection (if exists, skip — upsert is idempotent)
    vector_size = len(data["embeddings"][0])
    try:
        qdrant.get_collection(collection_name)
        print(f"Collection '{collection_name}' already exists, upserting into it")
    except Exception:
        qdrant.create_collection(
            collection_name=collection_name,
            vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
        )
        print(f"Created collection '{collection_name}'")

    # Batch upsert
    batch_size = 500
    for i in range(0, total, batch_size):
        batch_end = min(i + batch_size, total)
        points = []
        for j in range(i, batch_end):
            point_id = deterministic_uuid(data["ids"][j])
            payload = {
                "document": data["documents"][j],
                "original_id": data["ids"][j],
                **(data["metadatas"][j] or {}),
            }
            points.append(PointStruct(
                id=point_id,
                vector=data["embeddings"][j],
                payload=payload,
            ))
        qdrant.upsert(collection_name=collection_name, points=points)
        print(f"  Migrated {batch_end}/{total}")

    # Verify
    qdrant_count = qdrant.count(collection_name).count
    print(f"\nVerification: ChromaDB={total}, Qdrant={qdrant_count}")
    if total == qdrant_count:
        print("Migration successful!")
    else:
        print("WARNING: Count mismatch!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate ChromaDB to Qdrant")
    parser.add_argument("--chroma-path", required=True)
    parser.add_argument("--qdrant-url", default="http://localhost:6333")
    parser.add_argument("--collection", default="mempalace_drawers")
    args = parser.parse_args()
    migrate(args.chroma_path, args.qdrant_url, args.collection)
```

- [ ] **Step 2: Commit**

```
git add scripts/migrateChromaToQdrant.py
git commit -m "migration: ChromaDB → Qdrant migration script eklendi"
```

---

### Task 23: Static Assets & Documentation

**Files:**
- Copy: `assets/mempalace_logo.png`
- Copy: `hooks/mempal_save_hook.sh`, `hooks/mempal_precompact_hook.sh`
- Copy: `examples/` (update Python examples to JS)
- Copy: `LICENSE`, `CONTRIBUTING.md`
- Create: `README.md` (update for Node.js)

- [ ] **Step 1: Copy static files**

```bash
cp /home/mehmet/Downloads/memoryPalace/assets/mempalace_logo.png assets/
cp /home/mehmet/Downloads/memoryPalace/hooks/*.sh hooks/
cp /home/mehmet/Downloads/memoryPalace/LICENSE .
cp /home/mehmet/Downloads/memoryPalace/CONTRIBUTING.md .
```

- [ ] **Step 2: Create examples (JS versions)**

Port `examples/basic_mining.py` → `examples/basicMining.js`
Port `examples/convo_import.py` → `examples/convoImport.js`
Copy markdown examples as-is: `mcp_setup.md`, `gemini_cli_setup.md`, `HOOKS_TUTORIAL.md`

- [ ] **Step 3: Update README.md for Node.js**

Update installation (`npm install`), usage (`npx mempalace`), Docker setup, etc.

- [ ] **Step 4: Commit**

```
git add assets/ hooks/ examples/ LICENSE CONTRIBUTING.md README.md
git commit -m "docs: statik dosyalar, örnekler ve README eklendi"
```

---

### Task 24: Integration Test & Final Verification

- [ ] **Step 1: Start Docker services**

Run: `docker compose up -d`
Expected: Qdrant healthy, mempalace service ready

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: CLI smoke test**

```bash
node bin/mempalace.js --version    # → 3.0.0
node bin/mempalace.js status       # → Palace overview
node bin/mempalace.js init /tmp/test-project
node bin/mempalace.js mine /tmp/test-project --wing test
node bin/mempalace.js search "test query"
```

- [ ] **Step 4: MCP server smoke test**

```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node src/mcpServer.js
# → 19 tools listed
```

- [ ] **Step 5: Update src/index.js exports**

Ensure all public modules are exported.

- [ ] **Step 6: Final commit**

```
git add -A
git commit -m "v3.0.0: Node.js port tamamlandı"
```

---

## Task Dependency Graph

```
Task 1 (Scaffolding)
  ├── Task 2 (Config)
  │   ├── Task 3 (Embedder)
  │   │   └── Task 4 (VectorStore) ──────────────────────┐
  │   ├── Task 5 (KnowledgeGraph)                        │
  │   ├── Task 6 (EntityDetector)                        │
  │   │   └── Task 7 (EntityRegistry)                    │
  │   │       └── Task 10 (Spellcheck) [opsiyonel]       │
  │   └── Task 8 (RoomDetectorLocal)                     │
  │                                                      │
  ├── Task 9 (GeneralExtractor) [bağımsız]               │
  ├── Task 11 (Normalize) [bağımsız]                     │
  │                                                      │
  ├── Task 12 (Miner) ←── VectorStore + RoomDetector     │
  ├── Task 13 (ConvoMiner) ←── Normalize + VectorStore   │
  ├── Task 14 (SplitMegaFiles) [bağımsız]                │
  ├── Task 15 (Dialect) ←── EntityRegistry               │
  │                                                      │
  ├── Task 16 (Searcher) ←── VectorStore ────────────────┘
  ├── Task 17 (PalaceGraph) ←── VectorStore
  ├── Task 18 (Layers) ←── VectorStore + Searcher
  │
  ├── Task 19 (Onboarding) ←── EntityDetector + EntityRegistry
  ├── Task 20 (CLI) ←── Hepsi
  ├── Task 21 (MCP Server) ←── Hepsi
  │
  ├── Task 22 (Migration Script) [bağımsız, Python]
  ├── Task 23 (Static Assets) [bağımsız]
  └── Task 24 (Integration Test) ←── Hepsi
```

## Parallel Execution Opportunities

Aşağıdaki task grupları paralel çalıştırılabilir:

- **Grup A:** Task 3 (Embedder) + Task 5 (KnowledgeGraph) + Task 6 (EntityDetector) + Task 9 (GeneralExtractor) + Task 11 (Normalize)
- **Grup B:** Task 7 (EntityRegistry) + Task 8 (RoomDetectorLocal) + Task 14 (SplitMegaFiles)
- **Grup C:** Task 12 (Miner) + Task 13 (ConvoMiner) + Task 15 (Dialect) — Not: Task 4 (VectorStore) önceden tamamlanmış olmalı
- **Grup D:** Task 16 (Searcher) + Task 17 (PalaceGraph)
- **Grup E:** Task 22 (Migration) + Task 23 (Static Assets)
