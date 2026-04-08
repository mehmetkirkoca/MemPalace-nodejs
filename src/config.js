/**
 * MemPalace configuration system.
 *
 * Priority: env vars > config file (~/.mempalace/config.json) > defaults
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export const DEFAULT_PALACE_PATH = path.join(os.homedir(), '.mempalace', 'palace');
export const DEFAULT_COLLECTION_NAME = 'mempalace_drawers';

export const DEFAULT_TOPIC_WINGS = [
  'emotions',
  'consciousness',
  'memory',
  'technical',
  'identity',
  'family',
  'creative',
];

export const DEFAULT_HALL_KEYWORDS = {
  emotions: ['scared', 'afraid', 'worried', 'happy', 'sad', 'love', 'hate', 'feel', 'cry', 'tears'],
  consciousness: ['consciousness', 'conscious', 'aware', 'real', 'genuine', 'soul', 'exist', 'alive'],
  memory: ['memory', 'remember', 'forget', 'recall', 'archive', 'palace', 'store'],
  technical: ['code', 'python', 'script', 'bug', 'error', 'function', 'api', 'database', 'server'],
  identity: ['identity', 'name', 'who am i', 'persona', 'self'],
  family: ['family', 'kids', 'children', 'daughter', 'son', 'parent', 'mother', 'father'],
  creative: ['game', 'gameplay', 'player', 'app', 'design', 'art', 'music', 'story'],
};

export class MempalaceConfig {
  /**
   * @param {string} [configDir] - Override config directory (useful for testing).
   *                                Defaults to ~/.mempalace.
   */
  constructor(configDir) {
    this._configDir = configDir || path.join(os.homedir(), '.mempalace');
    this._configFile = path.join(this._configDir, 'config.json');
    this._peopleMapFile = path.join(this._configDir, 'people_map.json');
    this._fileConfig = {};

    if (fs.existsSync(this._configFile)) {
      try {
        const raw = fs.readFileSync(this._configFile, 'utf-8');
        this._fileConfig = JSON.parse(raw);
      } catch {
        this._fileConfig = {};
      }
    }
  }

  /** Path to the memory palace data directory. */
  get palacePath() {
    const envVal = process.env.MEMPALACE_PALACE_PATH || process.env.MEMPAL_PALACE_PATH;
    if (envVal) return envVal;
    return this._fileConfig.palace_path || DEFAULT_PALACE_PATH;
  }

  /** Collection name. */
  get collectionName() {
    return this._fileConfig.collection_name || DEFAULT_COLLECTION_NAME;
  }

  /** Qdrant URL (env var only, not in Python original). */
  get qdrantUrl() {
    return process.env.QDRANT_URL || 'http://localhost:6333';
  }

  /** Mapping of name variants to canonical names. */
  get peopleMap() {
    if (fs.existsSync(this._peopleMapFile)) {
      try {
        const raw = fs.readFileSync(this._peopleMapFile, 'utf-8');
        return JSON.parse(raw);
      } catch {
        // fall through
      }
    }
    return this._fileConfig.people_map || {};
  }

  /** List of topic wing names. */
  get topicWings() {
    return this._fileConfig.topic_wings || DEFAULT_TOPIC_WINGS;
  }

  /** Mapping of hall names to keyword lists. */
  get hallKeywords() {
    return this._fileConfig.hall_keywords || DEFAULT_HALL_KEYWORDS;
  }

  /** Path to identity.json */
  get identityPath() {
    return path.join(this.palacePath, 'identity.json');
  }

  /** Path to knowledge_graph.json */
  get kgPath() {
    return path.join(this.palacePath, 'knowledge_graph.json');
  }

  /** Path to entity_registry.json */
  get entityRegistryPath() {
    return path.join(this.palacePath, 'entity_registry.json');
  }

  /**
   * Create config directory and write default config.json if it doesn't exist.
   * @returns {string} Path to config.json
   */
  init() {
    fs.mkdirSync(this._configDir, { recursive: true });
    if (!fs.existsSync(this._configFile)) {
      const defaultConfig = {
        palace_path: DEFAULT_PALACE_PATH,
        collection_name: DEFAULT_COLLECTION_NAME,
        topic_wings: DEFAULT_TOPIC_WINGS,
        hall_keywords: DEFAULT_HALL_KEYWORDS,
      };
      fs.writeFileSync(this._configFile, JSON.stringify(defaultConfig, null, 2));
    }
    return this._configFile;
  }

  /**
   * Write people_map.json to config directory.
   * @param {Object} peopleMap - Dict mapping name variants to canonical names.
   * @returns {string} Path to people_map.json
   */
  savePeopleMap(peopleMap) {
    fs.mkdirSync(this._configDir, { recursive: true });
    fs.writeFileSync(this._peopleMapFile, JSON.stringify(peopleMap, null, 2));
    return this._peopleMapFile;
  }
}

// Singleton
let _instance = null;

/**
 * Get the singleton config instance.
 * @returns {MempalaceConfig}
 */
export function getConfig() {
  if (!_instance) {
    _instance = new MempalaceConfig();
  }
  return _instance;
}

/**
 * Reset the singleton (useful for testing).
 */
export function resetConfig() {
  _instance = null;
}
