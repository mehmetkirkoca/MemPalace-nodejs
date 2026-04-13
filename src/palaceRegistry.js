/**
 * palaceRegistry.js — Central Palace Configuration Registry
 * ==========================================================
 *
 * Stores palace definitions (name, keywords, scope, wing_focus, l0_body)
 * in a single SQLite database. Replaces the identities/*.txt file approach.
 *
 * Each palace maps to a Qdrant collection. The registry tells the system
 * what kind of content belongs in each palace, enabling auto-routing in
 * mempalace_save without requiring a prior wake_up call.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REGISTRY_PATH = process.env.PALACE_REGISTRY_PATH
  || path.join(os.homedir(), '.mempalace', 'palace_registry.sqlite3');

export class PalaceRegistry {
  constructor(dbPath = REGISTRY_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS palaces (
        name        TEXT PRIMARY KEY,
        description TEXT,
        keywords    TEXT DEFAULT '[]',
        scope       TEXT,
        wing_focus  TEXT,
        l0_body     TEXT,
        is_default  INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now')),
        scope_vector TEXT
      );
    `);
    // Migration: add column if upgrading from older schema
    try { this.db.exec('ALTER TABLE palaces ADD COLUMN scope_vector TEXT'); } catch {}
  }

  upsert({ name, description, keywords = [], scope, wing_focus, l0_body, is_default = 0 }) {
    this.db.prepare(`
      INSERT INTO palaces (name, description, keywords, scope, wing_focus, l0_body, is_default, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        keywords    = excluded.keywords,
        scope       = excluded.scope,
        wing_focus  = excluded.wing_focus,
        l0_body     = excluded.l0_body,
        is_default  = excluded.is_default,
        updated_at  = datetime('now')
    `).run(
      name,
      description || null,
      JSON.stringify(keywords),
      scope || null,
      wing_focus || null,
      l0_body || null,
      is_default ? 1 : 0
    );
  }

  setVector(name, vector) {
    this.db.prepare('UPDATE palaces SET scope_vector = ? WHERE name = ?')
      .run(JSON.stringify(vector), name);
  }

  getAll() {
    return this.db.prepare('SELECT * FROM palaces ORDER BY is_default DESC, name ASC').all()
      .map(row => ({
        ...row,
        keywords: JSON.parse(row.keywords || '[]'),
        scope_vector: row.scope_vector ? JSON.parse(row.scope_vector) : null,
        is_default: row.is_default === 1,
      }));
  }

  getDefault() {
    const row = this.db.prepare('SELECT * FROM palaces WHERE is_default = 1 LIMIT 1').get()
      || this.db.prepare('SELECT * FROM palaces LIMIT 1').get();
    if (!row) return null;
    return {
      ...row,
      keywords: JSON.parse(row.keywords || '[]'),
      scope_vector: row.scope_vector ? JSON.parse(row.scope_vector) : null,
      is_default: row.is_default === 1,
    };
  }

  delete(name) {
    this.db.prepare('DELETE FROM palaces WHERE name = ?').run(name);
  }
}
