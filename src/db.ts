import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { createLogger } from './logger.js';

const log = createLogger('db');

export type DatabaseHandle = Database.Database;

export interface OpenResult {
  db: DatabaseHandle;
  vecVersion: string;
  created: boolean;
}

const MIGRATIONS: Array<{ version: number; name: string; up: (db: DatabaseHandle) => void }> = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE chunks (
          id           INTEGER PRIMARY KEY,
          file_path    TEXT NOT NULL,
          line_start   INTEGER NOT NULL,
          line_end     INTEGER NOT NULL,
          entity_name  TEXT,
          language     TEXT NOT NULL,
          scope_chain  TEXT,
          imports      TEXT,
          text         TEXT NOT NULL,
          context      TEXT NOT NULL,
          content_hash TEXT NOT NULL
        );
        CREATE INDEX idx_chunks_file   ON chunks(file_path);
        CREATE INDEX idx_chunks_hash   ON chunks(content_hash);
        CREATE INDEX idx_chunks_entity ON chunks(entity_name);

        CREATE TABLE files (
          path          TEXT PRIMARY KEY,
          mtime_ms      INTEGER NOT NULL,
          size          INTEGER NOT NULL,
          content_hash  TEXT NOT NULL,
          chunk_count   INTEGER NOT NULL,
          indexed_at    INTEGER NOT NULL
        );

        CREATE TABLE meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'fts5-full-text',
    up: (db) => {
      db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          context,
          entity_name,
          file_path,
          content='chunks',
          content_rowid='id',
          tokenize = "unicode61 remove_diacritics 2"
        );

        CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, context, entity_name, file_path)
          VALUES (new.id, new.context, new.entity_name, new.file_path);
        END;

        CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, context, entity_name, file_path)
          VALUES ('delete', old.id, old.context, old.entity_name, old.file_path);
        END;

        CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, context, entity_name, file_path)
          VALUES ('delete', old.id, old.context, old.entity_name, old.file_path);
          INSERT INTO chunks_fts(rowid, context, entity_name, file_path)
          VALUES (new.id, new.context, new.entity_name, new.file_path);
        END;

        -- An external-content FTS5 table knows nothing about rows that existed
        -- before the index was created. Without a rebuild the first UPDATE on
        -- chunks runs a 'delete' for a row that is not there, and SQLite
        -- considers the file corrupt: the external table declares rows
        -- (content='chunks') that the index does not have.
        INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
      `);
    },
  },
];

function applyPragmas(db: DatabaseHandle): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
}

/**
 * The entity list is stored separately from the single primary entity_name.
 * code-chunk reports every entity of a chunk (methods, classes, functions),
 * but until now only one was stored — the one that made it into the header.
 * So get_file_outline promised symbols and returned chunk line ranges.
 */
const MIGRATION_ENTITIES: { version: number; name: string; up: (db: DatabaseHandle) => void } = {
  version: 3,
  name: 'chunk-entities',
  up: (db) => {
    db.exec(`ALTER TABLE chunks ADD COLUMN entities TEXT NOT NULL DEFAULT '[]';`);
    // The shape has to match what the indexer writes: an array of objects. An
    // array of strings would be incompatible here — a consumer would expect
    // entity.name and get a string instead. Exact entity bounds are unknown
    // during the backfill, so the chunk bounds are used and the type is marked
    // unknown — that is the truth, not a guess.
    //
    // json_array(NULL) yields NULL and the column is NOT NULL, so chunks
    // without a named entity get an empty array.
    db.exec(`
      UPDATE chunks
      SET entities = CASE
        WHEN entity_name IS NULL THEN '[]'
        ELSE json_array(json_object(
          'name', entity_name,
          'type', 'unknown',
          'signature', NULL,
          'lineStart', line_start,
          'lineEnd', line_end))
      END;
    `);
  },
};

/**
 * The chunking strategy is stored on the chunk, not in meta.
 *
 * meta held the result of the last run, so an incremental run with no changes
 * zeroed the counters and status reported "AST 0" for an index chunked via
 * AST. Per column, the counters always match the table contents.
 *
 * DEFAULT 'unknown' is for indexes built before this migration: the strategy
 * was not stored then and cannot be recovered. Such chunks count towards
 * neither counter until the file is re-chunked, so an index created before the
 * update requires `reindex`.
 */
const MIGRATION_STRATEGY: { version: number; name: string; up: (db: DatabaseHandle) => void } = {
  version: 4,
  name: 'chunk-strategy',
  up: (db) => {
    db.exec(`ALTER TABLE chunks ADD COLUMN strategy TEXT NOT NULL DEFAULT 'unknown';`);
  },
};

const ALL_MIGRATIONS = [...MIGRATIONS, MIGRATION_ENTITIES, MIGRATION_STRATEGY];

/**
 * The schema version is the last applied migration, not a separate literal: a
 * mismatch with the number of migrations would surface only in a test, and
 * only after publication.
 */
export const SCHEMA_VERSION = ALL_MIGRATIONS.reduce((latest, migration) => Math.max(latest, migration.version), 0);

function currentVersion(db: DatabaseHandle): number {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get() as { name: string } | undefined;
  if (exists === undefined) return 0;

  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row === undefined ? 0 : Number(row.value);
}

function runMigrations(db: DatabaseHandle): boolean {
  const from = currentVersion(db);
  const pending = ALL_MIGRATIONS.filter((m) => m.version > from);
  if (pending.length === 0) return false;

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(migration.version),
      );
    });
    apply();
    log.info('migration applied', { version: migration.version, name: migration.name });
  }

  return true;
}

export function readVecVersion(db: DatabaseHandle): string {
  const row = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
  return row?.v ?? '';
}

export function openDatabase(dbPath: string): OpenResult {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  applyPragmas(db);

  sqliteVec.load(db);
  const vecVersion = readVecVersion(db);
  if (vecVersion === '') {
    db.close();
    throw new Error('sqlite-vec failed to load: vec_version() is unavailable');
  }

  const created = runMigrations(db);
  if (created) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('vec_version', vecVersion);
  }

  return { db, vecVersion, created };
}

/**
 * The dimensionality is fixed in the vec0 schema at CREATE time, so a
 * migration cannot change it — only recreating the table can. Hence the
 * separate function.
 */
export function createVectorTable(db: DatabaseHandle, dimension: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id   INTEGER PRIMARY KEY,
      embedding  FLOAT[${dimension}],
      language   TEXT,
      +context   TEXT
    );
  `);
}

export function dropVectorTable(db: DatabaseHandle): void {
  db.exec('DROP TABLE IF EXISTS chunks_vec;');
}

export function vectorTableExists(db: DatabaseHandle): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'`)
      .get() !== undefined
  );
}

export function readMeta(db: DatabaseHandle, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeMeta(db: DatabaseHandle, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteChunksForFile(db: DatabaseHandle, filePath: string): number {
  const ids = db
    .prepare('SELECT id FROM chunks WHERE file_path = ?')
    .all(filePath) as Array<{ id: number }>;

  const remove = db.transaction(() => {
    for (const { id } of ids) {
      db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(BigInt(id));
    }
    db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  });
  remove();

  return ids.length;
}

export function countChunks(db: DatabaseHandle): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
  return row.n;
}
