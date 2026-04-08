# MemPalace Node.js Port — Tasarım Dokümanı

> Tarih: 2026-04-08
> Kaynak: /home/mehmet/Downloads/memoryPalace (Python 3.9+, v3.0.0)
> Hedef: /home/mehmet/Documents/htdocs/memoryPlace (Node.js)

---

## 1. Amaç

Python tabanlı MemPalace projesinin birebir Node.js portasyonu. Aynı CLI komutları, aynı MCP tool'ları, aynı algoritmalar. %100'e yakın uyumluluk hedefi. Vektör DB olarak Qdrant kullanılacak (performans avantajı).

---

## 2. Teknoloji Seçimleri

| Katman | Python (mevcut) | Node.js (yeni) | Gerekçe |
|--------|-----------------|-----------------|---------|
| Vektör DB | chromadb (embedded) | **Qdrant (Docker)** + @qdrant/qdrant-js | Daha yüksek performans, Rust-based |
| Embedding | chromadb built-in (all-MiniLM-L6-v2) | **@huggingface/transformers** (all-MiniLM-L6-v2) | Aynı model, local, API key gereksiz. Not: eski adı @xenova/transformers |
| SQLite | sqlite3 (stdlib) | better-sqlite3 | En hızlı Node.js SQLite, senkron API |
| CLI | argparse | commander.js | En yaygın, stabil |
| MCP Server | mcp (python) | @modelcontextprotocol/sdk | Resmi SDK, protokol uyumlu |
| Config | pyyaml + json | js-yaml + json | YAML + JSON aynı kalır |
| Spellcheck | autocorrect | — (opsiyonel) | Sonra eklenebilir |
| Test | pytest | vitest | Hızlı, modern, ESM uyumlu |

---

## 3. Docker Compose

```yaml
version: "3.8"
services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"   # REST API
      - "6334:6334"   # gRPC
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
    # MCP server stdio mode veya CLI mode

volumes:
  qdrant_data:
  palace_data:
```

### Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
ENTRYPOINT ["node", "bin/mempalace.js"]
```

---

## 4. Dizin Yapısı

```
memoryPlace/
├── package.json
├── docker-compose.yml
├── Dockerfile
├── bin/
│   └── mempalace.js              # CLI entry point (#!/usr/bin/env node)
├── src/
│   ├── index.js                  # Package exports
│   ├── version.js                # __version__ = "3.0.0"
│   ├── cli.js                    # Commander.js — 8 subcommand
│   ├── config.js                 # ~/.mempalace/config.json + env vars
│   ├── vectorStore.js            # Qdrant wrapper (ChromaDB API uyumlu arayüz)
│   ├── embedder.js               # @huggingface/transformers embedding üretimi
│   ├── miner.js                  # Dosya tarama, chunking, Qdrant'a yazma
│   ├── convoMiner.js             # Konuşma mining (6 format)
│   ├── searcher.js               # Semantic search + wing/room filtre
│   ├── normalize.js              # Chat format dönüştürücü (6 format)
│   ├── dialect.js                # AAAK lossy compression
│   ├── knowledgeGraph.js         # SQLite temporal knowledge graph
│   ├── palaceGraph.js            # Room navigasyonu, BFS, tunnel detection
│   ├── layers.js                 # L0-L3 memory stack
│   ├── mcpServer.js              # 19 MCP tool
│   ├── onboarding.js             # İlk kurulum wizard
│   ├── entityDetector.js         # Pattern-based entity extraction
│   ├── entityRegistry.js         # Entity → AAAK code mapping
│   ├── generalExtractor.js       # decision/preference/milestone/problem/emotional
│   ├── roomDetectorLocal.js      # 70+ folder pattern → room name
│   ├── splitMegaFiles.js         # Transcript session splitter
│   └── spellcheck.js             # İsim-farkındalıklı düzeltme (opsiyonel)
├── scripts/
│   └── migrateChromaToQdrant.py  # Tek seferlik migration script
├── tests/
│   ├── setup.js                  # Vitest global fixtures (conftest.py karşılığı)
│   ├── config.test.js
│   ├── miner.test.js
│   ├── convoMiner.test.js
│   ├── dialect.test.js
│   ├── knowledgeGraph.test.js
│   ├── searcher.test.js
│   ├── normalize.test.js
│   ├── splitMegaFiles.test.js
│   ├── mcpServer.test.js
│   └── versionConsistency.test.js
├── examples/
│   ├── basicMining.js
│   ├── convoImport.js
│   ├── mcp_setup.md
│   ├── gemini_cli_setup.md
│   └── HOOKS_TUTORIAL.md
├── benchmarks/
│   ├── longmemevalBench.js
│   ├── locomoBench.js
│   ├── membenchBench.js
│   └── convomemBench.js
├── hooks/
│   ├── mempal_save_hook.sh
│   └── mempal_precompact_hook.sh
├── assets/
│   └── mempalace_logo.png
├── .gitignore
├── LICENSE
├── README.md
└── CONTRIBUTING.md
```

### Yeni Modüller (Python'da yok)

| Modül | Neden |
|-------|-------|
| `vectorStore.js` | Qdrant client'ını ChromaDB benzeri API ile sarmallar. `add()`, `query()`, `get()`, `delete()` — tüm modüller bu wrapper üzerinden çalışır. |
| `embedder.js` | `@huggingface/transformers` ile text → vector dönüşümü. ChromaDB'de built-in olan bu işlev artık ayrı modül. |
| `tests/setup.js` | Vitest global fixture'lar (Python conftest.py karşılığı). |

---

## 5. Modül Eşleme (Python → Node.js)

### 5.1 config.js (← config.py, 149 satır)

- Config yükleme: `~/.mempalace/config.json`
- Environment variable override: `MEMPALACE_PALACE_PATH` (fallback: `MEMPAL_PALACE_PATH`)
- Ek env var: `QDRANT_URL` (default: `http://localhost:6333`)
- Default değerler: `palace_path`, `collection_name`, `topic_wings`, `hall_keywords`, `people_map`
- Proje config: `mempalace.yaml` (js-yaml ile parse)

### 5.2 vectorStore.js (yeni modül)

ChromaDB API'sini Qdrant üzerine saran wrapper. Diğer modüller bu arayüzü kullanır:

```javascript
// ChromaDB benzeri API
await store.add({ ids, documents, metadatas });
await store.query({ queryTexts, nResults, where });
await store.get({ where, limit });
await store.delete({ ids });
await store.count();
```

İç yapısı:
- `add()` → embedder.embed(documents) → qdrant.upsert(points)
- `query()` → embedder.embed(queryTexts) → qdrant.search(vector, filter)
- `get()` → qdrant.scroll(filter, limit) — ChromaDB'nin `collection.get()` karşılığı. Qdrant'ın `scroll()` API'si pagination ile tüm point'leri getirir.
- `delete()` → qdrant.delete(pointIds)
- `count()` → qdrant.count(collectionName)
- `where` filtresi → Qdrant filter dönüşümü:
  - `{ wing: "x" }` → `{ must: [{ key: "wing", match: { value: "x" } }] }`
  - `{ $and: [{wing: "x"}, {room: "y"}] }` → `{ must: [{key: "wing", ...}, {key: "room", ...}] }`
  - Not: `$not` filtresi mevcut Python kodunda kullanılmıyor, gerektiğinde Qdrant `must_not` ile eklenebilir.

### 5.3 embedder.js (yeni modül)

```javascript
// @huggingface/transformers ile local embedding
// Model: all-MiniLM-L6-v2 (384 boyutlu vektör)
// ChromaDB'nin default modeli ile aynı — arama sonuçları uyumlu
await embedder.embed("search text");       // → Float32Array(384)
await embedder.embedBatch(["a", "b"]);     // → [Float32Array(384), ...]
```

Model ilk kullanımda indirilir (~80MB), sonraki kullanımlarda cache'ten yüklenir.

### 5.4 miner.js (← miner.py, 672 satır)

- Dizin tarama: `fs.readdirSync` + recursive walk
- `.gitignore` parsing: pattern matching mantığı birebir korunacak
- Chunking: 800 char, 100 overlap, paragraph → line → hard break
- Qdrant'a yazma: `vectorStore.add()` ile batch (500 item)
- Metadata: `{ wing, room, source_file, chunk_index, added_by, filed_at }`

### 5.5 convoMiner.js (← convo_miner.py, 404 satır)

- **6 format** desteği (normalize.js üzerinden)
- Q+A exchange pair chunking
- Room detection: keyword scoring
- General extraction: decision, preference, milestone, problem, emotional

### 5.6 searcher.js (← searcher.py, 152 satır)

- `vectorStore.query()` with optional wing/room filters
- Return: `{ text, wing, room, sourceFile, similarity }`

### 5.7 normalize.js (← normalize.py, 328 satır)

- Claude Code JSONL parser
- ChatGPT JSON parser
- Claude.ai JSON parser
- Slack JSON parser
- **OpenAI Codex CLI JSONL parser**
- Plain text parser
- Ortak çıktı formatı: `[{ role, content, timestamp? }]`

### 5.8 dialect.js (← dialect.py, 1075 satır)

- AAAK pipe-separated format
- Entity code generation (3 uppercase letters)
- Emotion markers: `*warm*`, `*fierce*`, `*raw*`, `*bloom*`
- Flags: ORIGIN, CORE, SENSITIVE, PIVOT, GENESIS, DECISION, TECHNICAL
- Zettel, Tunnel, Arc yapıları

### 5.9 knowledgeGraph.js (← knowledge_graph.py, 387 satır)

- better-sqlite3 ile SQLite (senkron API)
- `entities` tablosu: id, name, type, properties (JSON), created_at
- `triples` tablosu: id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file, extracted_at
- API: `addTriple()`, `queryEntity()`, `invalidate()`, `timeline()`
- Temporal filtering: `as_of` parametresi

### 5.10 palaceGraph.js (← palace_graph.py, 227 satır)

- Qdrant metadata'dan graf oluşturma (`vectorStore.get()` üzerinden)
- Node = room, Edge = shared rooms across wings
- BFS traversal: `traverse(startRoom, maxHops)`
- Tunnel detection: `findTunnels(wingA, wingB)`
- `graphStats()`: bağlantı özeti

### 5.11 layers.js (← layers.py, 515 satır)

- L0: Identity (identity.txt, ~100 token)
- L1: Critical facts (~500-800 token)
- L2: On-demand wing/room retrieval (~200-500 token)
- L3: Deep semantic search (unlimited)
- `wakeUp()`: L0 + L1 render
- `wakeUp(wing)`: Proje-spesifik

### 5.12 mcpServer.js (← mcp_server.py, 784 satır)

19 tool — aynı isimler, aynı parametreler:

**Read (7):** mempalace_status, mempalace_list_wings, mempalace_list_rooms, mempalace_get_taxonomy, mempalace_search, mempalace_check_duplicate, mempalace_get_aaak_spec

**Write (2):** mempalace_add_drawer, mempalace_delete_drawer

**KG (5):** mempalace_kg_query, mempalace_kg_add, mempalace_kg_invalidate, mempalace_kg_timeline, mempalace_kg_stats

**Navigation (3):** mempalace_traverse, mempalace_find_tunnels, mempalace_graph_stats

**Diary (2):** mempalace_diary_write, mempalace_diary_read

### 5.13 cli.js (← cli.py, 483 satır)

Commander.js subcommands:

```
mempalace init <dir>
mempalace mine <dir> [--mode convos] [--wing X] [--extract general]
mempalace search <query> [--wing X] [--room Y]
mempalace split <dir>
mempalace compress [--wing X] [--dry-run]
mempalace wake-up [--wing X]
mempalace repair
mempalace status
```

### 5.14 Diğer Modüller

| Modül | Gerçek satır (Python) | Açıklama |
|-------|----------------------|----------|
| onboarding.js | 489 | Guided setup: mode → people → projects → wings |
| entityDetector.js | 853 | Person/project verb patterns, dialogue markers |
| entityRegistry.js | 639 | Name → AAAK code, ambiguity resolution |
| generalExtractor.js | 521 | 5-type classification (decision, preference, milestone, problem, emotional) |
| roomDetectorLocal.js | 310 | 70+ folder → room mapping |
| splitMegaFiles.js | 309 | Session boundary detection, timestamp extraction |
| spellcheck.js | 269 | Entity-aware correction (opsiyonel, autocorrect yerine nspell veya benzeri) |

---

## 6. Async/Sync Stratejisi

### Senkron Modüller (better-sqlite3 doğal olarak senkron)
- `knowledgeGraph.js` — SQLite sorgularının tamamı senkron
- `config.js` — Dosya okuma (fs.readFileSync), uygulama başlangıcında bir kez çalışır
- `roomDetectorLocal.js` — Pure logic, I/O yok
- `entityDetector.js` — Pure logic
- `entityRegistry.js` — Pure logic
- `generalExtractor.js` — Pure logic
- `dialect.js` — Pure logic

### Async Modüller (Qdrant HTTP + embedding async)
- `vectorStore.js` — Qdrant client async
- `embedder.js` — Transformer model inference async
- `miner.js` — Dosya okuma + Qdrant yazma
- `convoMiner.js` — Dosya okuma + Qdrant yazma
- `searcher.js` — Qdrant query
- `palaceGraph.js` — Qdrant'tan metadata okuma
- `layers.js` — Qdrant'tan search
- `mcpServer.js` — MCP SDK async handler'lar
- `cli.js` — Async komut handler'lar
- `onboarding.js` — readline + Qdrant

---

## 7. Qdrant Veri Yapısı

### Collection: `mempalace_drawers`

```javascript
// Collection config
{
  vectors: {
    size: 384,           // all-MiniLM-L6-v2 output boyutu
    distance: "Cosine"   // ChromaDB default ile aynı
  }
}

// Point yapısı
{
  id: "uuid-v4",                    // ChromaDB string ID → UUID
  vector: [0.1, 0.2, ...],         // 384-dim embedding
  payload: {
    document: "verbatim content",   // Orijinal metin
    wing: "wing_myproject",
    room: "auth-migration",
    source_file: "/path/to/source.md",
    chunk_index: 0,
    added_by: "mempalace",
    filed_at: "2026-04-08T12:34:56",
    original_id: "drawer_wing_room_hash16"  // ChromaDB ID korunur (migration için)
  }
}
```

### Filter Dönüşüm Tablosu

| ChromaDB where | Qdrant filter |
|----------------|---------------|
| `{ wing: "x" }` | `{ must: [{ key: "wing", match: { value: "x" } }] }` |
| `{ $and: [{wing: "x"}, {room: "y"}] }` | `{ must: [{ key: "wing", match: { value: "x" } }, { key: "room", match: { value: "y" } }] }` |
| `{ $or: [{wing: "x"}, {wing: "y"}] }` | `{ should: [{ key: "wing", match: { value: "x" } }, { key: "wing", match: { value: "y" } }] }` |

---

## 8. Migration Script

### scripts/migrateChromaToQdrant.py

Tek seferlik Python script — mevcut ChromaDB palace'ını Qdrant'a taşır.

```
Gereksinimler: pip install chromadb qdrant-client

Kullanım: python scripts/migrateChromaToQdrant.py \
            --chroma-path ~/.mempalace/chroma \
            --qdrant-url http://localhost:6333 \
            --collection mempalace_drawers

Akış:
1. ChromaDB PersistentClient ile bağlan
2. collection.get() ile TÜM drawer'ları oku (documents + embeddings + metadatas + ids)
3. Qdrant'ta collection oluştur (vector_size=384, distance=Cosine)
4. Her drawer için:
   - ChromaDB ID → UUID dönüşümü (deterministic UUID v5)
   - original_id payload'a eklenir
   - document payload'a taşınır
   - embedding vector olarak atanır
5. 500'lük batch'ler halinde qdrant.upsert()
6. Doğrulama: kaynak ve hedef sayıları karşılaştır

Notlar:
- Embedding'ler ChromaDB'den birebir kopyalanır, RE-GENERATE EDİLMEZ (model farklılık riski)
- UUID v5 deterministik olduğu için script tekrar çalıştırılabilir (upsert güvenli)
- Migration başarısız olursa aynı script güvenle tekrar çalıştırılabilir
- Script bağımsız çalışır: `pip install chromadb qdrant-client` gerektirir, Node.js ortamı gerekmez
```

---

## 9. package.json Yapısı

```json
{
  "name": "mempalace",
  "version": "3.0.0",
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
    "@qdrant/qdrant-js": "^1.x",
    "@huggingface/transformers": "^3.x",
    "@modelcontextprotocol/sdk": "^1.x",
    "better-sqlite3": "^11.x",
    "commander": "^12.x",
    "js-yaml": "^4.x"
  },
  "devDependencies": {
    "vitest": "^2.x",
    "eslint": "^9.x"
  }
}
```

---

## 10. Veri Uyumluluğu

### Qdrant ↔ ChromaDB
- Aynı embedding model (all-MiniLM-L6-v2) → aynı arama sonuçları
- Aynı metadata key'leri korunur (wing, room, source_file, chunk_index, added_by, filed_at)
- Migration script ile mevcut palace verileri taşınabilir
- `original_id` payload'da ChromaDB ID'si saklanır (geriye dönük referans)

### SQLite (Knowledge Graph)
- Aynı tablo şeması, aynı SQL sorguları
- Mevcut KG dosyaları doğrudan kullanılabilir

### Config
- `~/.mempalace/config.json` — aynı format
- `mempalace.yaml` — aynı format
- `~/.mempalace/identity.txt` — düz metin, değişiklik yok

---

## 11. Naming Convention

- Python `snake_case` fonksiyonlar → JS `camelCase`
- Python `snake_case` dosyalar → JS `camelCase` (ör: `convo_miner.py` → `convoMiner.js`)
- Qdrant payload key'leri → `snake_case` korunur (veri uyumluluğu)
- CLI komut isimleri **değişmez**
- MCP tool isimleri **değişmez**

---

## 12. Kapsam Dışı

- Yeni özellik eklenmeyecek
- UI/web arayüzü eklenmeyecek
- spellcheck modülü opsiyonel — ilk sürümde atlanabilir
- ChromaDB embedded mode desteği yok (Qdrant Docker servis olarak çalışır)
