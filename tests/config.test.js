import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  MempalaceConfig,
  getConfig,
  resetConfig,
  DEFAULT_PALACE_PATH,
  DEFAULT_COLLECTION_NAME,
  DEFAULT_TOPIC_WINGS,
  DEFAULT_HALL_KEYWORDS,
} from '../src/config.js';

describe('MempalaceConfig', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mempalace-config-test-'));
    // Env var'ları temizle
    delete process.env.MEMPALACE_PALACE_PATH;
    delete process.env.MEMPAL_PALACE_PATH;
    delete process.env.QDRANT_URL;
    resetConfig();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    delete process.env.MEMPALACE_PALACE_PATH;
    delete process.env.MEMPAL_PALACE_PATH;
    delete process.env.QDRANT_URL;
    resetConfig();
  });

  describe('default values', () => {
    it('should use default values when no config file or env vars exist', () => {
      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe(DEFAULT_PALACE_PATH);
      expect(config.collectionName).toBe(DEFAULT_COLLECTION_NAME);
      expect(config.topicWings).toEqual(DEFAULT_TOPIC_WINGS);
      expect(config.hallKeywords).toEqual(DEFAULT_HALL_KEYWORDS);
      expect(config.peopleMap).toEqual({});
    });
  });

  describe('environment variables', () => {
    it('should respect MEMPALACE_PALACE_PATH env var', () => {
      process.env.MEMPALACE_PALACE_PATH = '/custom/palace/path';
      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe('/custom/palace/path');
    });

    it('should respect MEMPAL_PALACE_PATH as fallback', () => {
      process.env.MEMPAL_PALACE_PATH = '/fallback/palace/path';
      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe('/fallback/palace/path');
    });

    it('should prefer MEMPALACE_PALACE_PATH over MEMPAL_PALACE_PATH', () => {
      process.env.MEMPALACE_PALACE_PATH = '/primary/path';
      process.env.MEMPAL_PALACE_PATH = '/fallback/path';
      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe('/primary/path');
    });

    it('should support QDRANT_URL env var', () => {
      process.env.QDRANT_URL = 'http://custom-qdrant:6333';
      const config = new MempalaceConfig(tmpDir);

      expect(config.qdrantUrl).toBe('http://custom-qdrant:6333');
    });

    it('should use default qdrantUrl when env var is not set', () => {
      const config = new MempalaceConfig(tmpDir);

      expect(config.qdrantUrl).toBe('http://localhost:6333');
    });
  });

  describe('config file loading', () => {
    it('should load config from file', () => {
      const customConfig = {
        palace_path: '/from/file/path',
        collection_name: 'custom_collection',
        topic_wings: ['custom_wing'],
        hall_keywords: { custom_wing: ['keyword1'] },
      };
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify(customConfig, null, 2),
      );

      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe('/from/file/path');
      expect(config.collectionName).toBe('custom_collection');
      expect(config.topicWings).toEqual(['custom_wing']);
      expect(config.hallKeywords).toEqual({ custom_wing: ['keyword1'] });
    });

    it('should handle invalid JSON in config file gracefully', () => {
      fs.writeFileSync(path.join(tmpDir, 'config.json'), '{invalid json}');

      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe(DEFAULT_PALACE_PATH);
      expect(config.collectionName).toBe(DEFAULT_COLLECTION_NAME);
    });

    it('env vars should override config file values', () => {
      const customConfig = { palace_path: '/from/file' };
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify(customConfig),
      );
      process.env.MEMPALACE_PALACE_PATH = '/from/env';

      const config = new MempalaceConfig(tmpDir);

      expect(config.palacePath).toBe('/from/env');
    });
  });

  describe('init', () => {
    it('should create config directory and default config.json', () => {
      const configDir = path.join(tmpDir, 'new-config');
      const config = new MempalaceConfig(configDir);

      const result = config.init();

      expect(fs.existsSync(configDir)).toBe(true);
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
      expect(result).toBe(path.join(configDir, 'config.json'));

      const written = JSON.parse(
        fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'),
      );
      expect(written.palace_path).toBe(DEFAULT_PALACE_PATH);
      expect(written.collection_name).toBe(DEFAULT_COLLECTION_NAME);
      expect(written.topic_wings).toEqual(DEFAULT_TOPIC_WINGS);
      expect(written.hall_keywords).toEqual(DEFAULT_HALL_KEYWORDS);
    });

    it('should not overwrite existing config.json', () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      const existing = { palace_path: '/existing/path' };
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify(existing),
      );

      const config = new MempalaceConfig(tmpDir);
      config.init();

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'),
      );
      expect(content.palace_path).toBe('/existing/path');
    });
  });

  describe('people_map', () => {
    it('should save and load people_map from separate file', () => {
      const config = new MempalaceConfig(tmpDir);
      const peopleMap = { mehmet: 'Mehmet Bey', ali: 'Ali Bey' };

      const result = config.savePeopleMap(peopleMap);

      expect(result).toBe(path.join(tmpDir, 'people_map.json'));
      expect(fs.existsSync(path.join(tmpDir, 'people_map.json'))).toBe(true);

      // Yeniden yükle ve kontrol et
      const config2 = new MempalaceConfig(tmpDir);
      expect(config2.peopleMap).toEqual(peopleMap);
    });

    it('should prefer people_map.json over config file people_map', () => {
      // Config dosyasına people_map yaz
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({ people_map: { old: 'Old Name' } }),
      );
      // Ayrı dosyaya da yaz
      fs.writeFileSync(
        path.join(tmpDir, 'people_map.json'),
        JSON.stringify({ new: 'New Name' }),
      );

      const config = new MempalaceConfig(tmpDir);
      expect(config.peopleMap).toEqual({ new: 'New Name' });
    });

    it('should fallback to config file people_map when separate file does not exist', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'config.json'),
        JSON.stringify({ people_map: { fallback: 'Fallback Name' } }),
      );

      const config = new MempalaceConfig(tmpDir);
      expect(config.peopleMap).toEqual({ fallback: 'Fallback Name' });
    });
  });

  describe('derived paths', () => {
    it('identityPath should return correct path', () => {
      const config = new MempalaceConfig(tmpDir);
      const expected = path.join(config.palacePath, 'identity.json');
      expect(config.identityPath).toBe(expected);
    });

    it('kgPath should return correct path', () => {
      const config = new MempalaceConfig(tmpDir);
      const expected = path.join(config.palacePath, 'knowledge_graph.json');
      expect(config.kgPath).toBe(expected);
    });

    it('entityRegistryPath should return correct path', () => {
      const config = new MempalaceConfig(tmpDir);
      const expected = path.join(config.palacePath, 'entity_registry.json');
      expect(config.entityRegistryPath).toBe(expected);
    });
  });

  describe('singleton pattern', () => {
    it('getConfig should return the same instance', () => {
      const config1 = getConfig();
      const config2 = getConfig();
      expect(config1).toBe(config2);
    });

    it('resetConfig should clear the singleton', () => {
      const config1 = getConfig();
      resetConfig();
      const config2 = getConfig();
      expect(config1).not.toBe(config2);
    });
  });
});
