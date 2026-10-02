import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import BetterSqlite3 from 'better-sqlite3';
import {
  countChunks,
  createVectorTable,
  deleteChunksForFile,
  dropVectorTable,
  openDatabase,
  readMeta,
  SCHEMA_VERSION,
  vectorTableExists,
  writeMeta,
  type DatabaseHandle,
} from '../src/db.js';
import { indexFile, indexRepository, removeFile } from '../src/indexer.js';
import { readIndexState, saveCounters } from '../src/index-service.js';
import { chunkFile } from '../src/chunker.js';

let root = '';
let dbPath = '';

const config = () => loadConfig({ root, dbPath });

suite('chunkFile', () => {
  test('the AST chunker yields 1-based lines and entities', async () => {
    const source = [
      "import { db } from './db'",
      '',
      'export async function login(email: string) {',
      '  return db.users.findByEmail(email)',
      '}',
      '',
      'class UserService {',
      '  async getUser(id: string) {',
      '    return db.query(id)',
      '  }',
      '}',
    ].join('\n');

    const { chunks, strategy } = await chunkFile('src/auth/login.ts', source);

    assert.equal(strategy, 'ast');
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0]?.source, 'ast');
    assert.equal(chunks[0]?.lineStart, 1);
    assert.equal(chunks[0]?.contextualizedText.includes('# src/auth/login.ts'), true);
    assert.ok(['login', 'UserService'].includes(chunks[0]?.entityName ?? ''));
    assert.ok(chunks[0]?.imports.includes('./db'));
  });

  test('splits a large file without cutting entities', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push('', `export function handler${i}(x: number) {`, `  return x + ${i}`, '}');
    }
    const { chunks, strategy } = await chunkFile('big.ts', lines.join('\n'), 1500);

    assert.equal(strategy, 'ast');
    assert.ok(chunks.length > 1, 'the file should be split');

    for (let i = 1; i < chunks.length; i += 1) {
      assert.ok(
        (chunks[i]?.lineStart ?? 0) > (chunks[i - 1]?.lineEnd ?? 0),
        'chunks must not overlap in line numbers',
      );
    }
  });

  test('markdown goes through the fallback path instead of failing', async () => {
    const source = ['# Title', '', 'Intro text.', '', '## Section', '', 'Body of section.'].join('\n');
    const { chunks, strategy } = await chunkFile('README.md', source);

    assert.equal(strategy, 'fallback');
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0]?.source, 'fallback');
    assert.equal(chunks[0]?.language, 'markdown');
  });

  test('yaml and json also go through the fallback path', async () => {
    for (const [name, body] of [
      ['config.yaml', 'key: value\nother: 2\n'],
      ['data.json', '{"a":1}\n'],
    ] as const) {
      const { chunks, strategy } = await chunkFile(name, body);
      assert.equal(strategy, 'fallback', name);
      assert.ok(chunks.length >= 1, name);
    }
  });

  test('fallback always tags the chunk origin', async () => {
    const { chunks } = await chunkFile('notes.md', '# A\n\ntext\n\n## B\n\nmore\n');
    assert.ok(chunks.every((c) => c.source === 'fallback'));
  });
});

suite('database', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'anyindex-db-'));
    dbPath = path.join(root, '.anyindex', 'index.db');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('opens, applies migrations and loads sqlite-vec', () => {
    const { db, vecVersion, created } = openDatabase(dbPath);
    try {
      assert.equal(created, true);
      assert.notEqual(vecVersion, '');
      assert.equal(readMeta(db, 'schema_version'), String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  test('reopening does not re-run the migrations', () => {
    openDatabase(dbPath).db.close();
    const second = openDatabase(dbPath);
    try {
      assert.equal(second.created, false);
    } finally {
      second.db.close();
    }
  });

  test('creates and drops the vector table', () => {
    const { db } = openDatabase(dbPath);
    try {
      createVectorTable(db, 768);
      assert.equal(vectorTableExists(db), true);
      dropVectorTable(db);
      assert.equal(vectorTableExists(db), false);
    } finally {
      db.close();
    }
  });

  test('the pragmas are applied', () => {
    const { db } = openDatabase(dbPath);
    try {
      assert.equal((db.pragma('journal_mode', { simple: true }) as string).toLowerCase(), 'wal');
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    } finally {
      db.close();
    }
  });

  test('meta is overwritten, not duplicated', () => {
    const { db } = openDatabase(dbPath);
    try {
      writeMeta(db, 'model_id', 'first');
      writeMeta(db, 'model_id', 'second');
      assert.equal(readMeta(db, 'model_id'), 'second');
    } finally {
      db.close();
    }
  });
});

suite('indexer', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'anyindex-idx-'));
    dbPath = path.join(root, '.anyindex', 'index.db');

    const write = async (relPath: string, content: string) => {
      const target = path.join(root, relPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    };

    await write(
      'src/auth/login.ts',
      [
        "import { db } from '../db'",
        '',
        'export async function login(email: string) {',
        '  return db.users.findByEmail(email)',
        '}',
        '',
        'export class UserService {',
        '  async getUser(id: string) {',
        '    return db.query(id)',
        '  }',
        '}',
      ].join('\n'),
    );
    await write('README.md', '# Test project\n\nDocumentation.\n');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('indexes the repository and counts the strategies separately', async () => {
    const result = await indexRepository(config());

    assert.equal(result.failedFiles, 0);
    assert.ok(result.added > 0, 'files should be added');
    assert.ok(result.astChunks > 0, 'AST chunks should appear');
    assert.ok(result.chunksWritten > 0);
  });

  test('FTS5 finds the chunk by function name', async () => {
    const { db } = openDatabase(dbPath);
    try {
      const row = db
        .prepare(`
          SELECT c.file_path AS filePath, c.line_start AS lineStart
          FROM chunks_fts f
          JOIN chunks c ON c.id = f.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts)
          LIMIT 1
        `)
        .get('UserService') as { filePath: string; lineStart: number } | undefined;

      assert.notEqual(row, undefined, 'FTS5 should find a chunk');
      assert.equal(row?.filePath, 'src/auth/login.ts');
      assert.ok((row?.lineStart ?? 0) >= 1, 'lines are 1-based');
    } finally {
      db.close();
    }
  });

  test('a second run leaves unchanged files alone', async () => {
    const second = await indexRepository(config());
    assert.equal(second.unchanged > 0, true, 'unchanged files should be skipped');
    assert.equal(second.chunksWritten, 0, 'a rewrite should not happen');
  });

  test('removing a file drops its chunks', async () => {
    const { db } = openDatabase(dbPath);
    try {
      const before = countChunks(db);
      assert.ok(before > 0);
      const removed = removeFile(db, 'src/auth/login.ts');
      assert.ok(removed > 0);
      assert.equal(countChunks(db), before - removed);
    } finally {
      db.close();
    }
  });

  test('reindexing a file leaves no duplicates', async () => {
    const { db } = openDatabase(dbPath);
    try {
      const source = 'export function alpha() { return 1 }\n';
      const stats = { mtimeMs: 1, size: source.length };
      await indexFile(db, config(), 'src/dup.ts', source, stats);
      const once = countChunks(db);
      await indexFile(db, config(), 'src/dup.ts', source, stats);
      assert.equal(countChunks(db), once, 'a repeated replace must not accumulate chunks');
    } finally {
      db.close();
    }
  });

  test('deleting a file\'s chunks resyncs FTS5', async () => {
    const { db } = openDatabase(dbPath);
    try {
      await indexFile(db, config(), 'src/temp.ts', 'export function temporarySymbol() { return 1 }\n', {
        mtimeMs: 1,
        size: 48,
      });

      const found = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?`).get('temporarySymbol') as { n: number };
      assert.ok(found.n > 0, 'the symbol should be found before deletion');

      deleteChunksForFile(db, 'src/temp.ts');

      const afterDelete = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?`).get('temporarySymbol') as { n: number };
      assert.equal(afterDelete.n, 0, 'after the delete the symbol should not be found');
    } finally {
      db.close();
    }
  });

  // Regression: status printed "Vectors: 0" on a fully counted index.
  // embedded was taken from meta.embedded_total — the result of the last pass —
  // while an incremental run with no changes computes no vectors at all.
  test('embedded reflects the vectors in the index, not the result of the last pass', () => {
    const seeded = path.join(root, 'embedded-counter.db');
    const { db } = openDatabase(seeded);
    try {
      createVectorTable(db, 768);
      writeMeta(db, 'model_id', 'jinaai/jina-embeddings-v2-base-code');
      writeMeta(db, 'dimension', '768');
      writeMeta(db, 'dtype', 'q8');

      const seededChunks = [
        { id: 1, file: 'src/a.ts', hash: 'h0' },
        { id: 2, file: 'src/b.ts', hash: 'h1' },
      ];
      for (const chunk of seededChunks) {
        db.prepare('INSERT INTO chunks (file_path, line_start, line_end, language, text, context, content_hash) VALUES (?,?,?,?,?,?,?)')
          .run(chunk.file, 1, 2, 'ts', chunk.file, chunk.file, chunk.hash);
        db.prepare('INSERT INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?,?,?,?)')
          .run(BigInt(chunk.id), Buffer.alloc(768 * 4), 'ts', chunk.file);
      }

      // State after an incremental run with no changes: the vectors are in
      // place, but the per-pass counters were reset.
      saveCounters(db, { chunks: 2, skipped: 0, embedded: 0, reused: 2 });

      const stats = readIndexState(loadConfig({ root, dbPath: seeded }));
      assert.equal(stats.ready, true, 'an index with full vector coverage must be ready');
      assert.equal(stats.embedded, 2, 'embedded must count the vectors in the index, not the last pass');
      assert.equal(stats.embedded, stats.chunks, 'a ready index is vectorised completely');
    } finally {
      db.close();
    }
  });
});

suite('model and dimension consistency', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-model-'));
    dbPath = path.join(root, '.anyindex', 'index.db');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Every test gets its own database: a shared file would survive the first
  // assertion and then fail on the UNIQUE constraint on the second insert.
  let seedCounter = 0;
  const seed = async (model: string, dimension: number, dtype = 'q8'): Promise<string> => {
    seedCounter += 1;
    const path_ = path.join(root, `.anyindex-${seedCounter}.db`);
    const { db } = openDatabase(path_);
    try {
      createVectorTable(db, dimension);
      writeMeta(db, 'model_id', model);
      writeMeta(db, 'dimension', String(dimension));
      writeMeta(db, 'dtype', dtype);
      db.prepare('INSERT INTO chunks (file_path, line_start, line_end, language, text, context, content_hash) VALUES (?,?,?,?,?,?,?)')
        .run('src/a.ts', 1, 2, 'ts', 'x', 'x', 'h');
      db.prepare('INSERT INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?,?,?,?)')
        .run(BigInt(1), Buffer.alloc(dimension * 4), 'ts', 'x');
    } finally {
      db.close();
    }
    return path_;
  };

  test('a model change on a ready index is rejected', async () => {
    const path_ = await seed('jinaai/jina-embeddings-v2-base-code', 768);
    const other = loadConfig({ root, dbPath: path_, model: 'Xenova/all-MiniLM-L6-v2', dimension: 768 });

    await assert.rejects(
      () => indexRepository(other),
      /not comparable|different models/i,
      'a model change must fail rather than silently compare vectors',
    );
  });

  test('a quantization change on a ready index is rejected', async () => {
    const path_ = await seed('jinaai/jina-embeddings-v2-base-code', 768, 'q8');
    const other = loadConfig({ root, dbPath: path_, dtype: 'fp32' });

    // Model and dimension match, so quantization is what has to be rejected:
    // otherwise a single vec0 table ends up holding both q8 and fp32 vectors.
    await assert.rejects(() => indexRepository(other), /quantization/i);

    const stats = readIndexState(other);
    assert.equal(stats.ready, false, 'an index with a changed quantization must not be considered ready');
    assert.equal(stats.degraded, true, 'a quantization mismatch is a fault, not an unbuilt index');
    assert.match(stats.reason ?? '', /index_rebuild/);
  });

  test('the same model with the same dimension passes', async () => {
    const path_ = await seed('jinaai/jina-embeddings-v2-base-code', 768);
    const same = loadConfig({ root, dbPath: path_ });
    const result = await indexRepository(same);
    assert.equal(result.failedFiles, 0);
  });
});

suite('migrations', () => {
  test('a fresh database gets every migration, an old one is upgraded without data loss', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aidx-migrate-'));
    try {
      const fresh = path.join(dir, 'fresh.db');
      const freshOpened = openDatabase(fresh);
      freshOpened.db
        .prepare("INSERT INTO chunks (file_path, line_start, line_end, entity_name, language, text, context, content_hash) VALUES ('a.ts',1,2,'loginUser','ts','x','x','h')")
        .run();
      freshOpened.db
        .prepare("INSERT INTO chunks (file_path, line_start, line_end, language, text, context, content_hash) VALUES ('b.ts',1,2,'ts','x','x','h2')")
        .run();
      assert.equal(readMeta(freshOpened.db, 'schema_version'), String(SCHEMA_VERSION));

      const freshRows = freshOpened.db.prepare('SELECT file_path, entities FROM chunks ORDER BY id').all() as Array<{
        file_path: string; entities: string;
      }>;
      // In a fresh database the rows appear after the migrations, so the
      // backfill does not apply to them and the default stays. Real entities are
      // written by the indexer through writeFileChunks.
      for (const row of freshRows) {
        assert.deepEqual(JSON.parse(row.entities), [],
          'fresh database: entities is empty until the indexer writes, not NULL — the column is NOT NULL');
      }
      freshOpened.db.close();

      // The upgrade path of an old database. A version 1 schema is created
      // directly, without openDatabase: otherwise migrations 2 and 3 would
      // already have been applied and there would be nothing to upgrade.
      // Faking an old database by dropping tables on top of a full schema
      // corrupts the FTS5 index.
      const legacy = path.join(dir, 'legacy.db');
      const raw = new BetterSqlite3(legacy);
      raw.pragma('journal_mode = WAL');
      raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      raw.exec(`CREATE TABLE chunks (
        id INTEGER PRIMARY KEY,
        file_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        entity_name TEXT,
        language TEXT NOT NULL,
        scope_chain TEXT,
        imports TEXT,
        text TEXT NOT NULL,
        context TEXT NOT NULL,
        content_hash TEXT NOT NULL);`);
      raw.exec(`CREATE TABLE files (
        path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        content_hash TEXT NOT NULL, chunk_count INTEGER NOT NULL, indexed_at INTEGER NOT NULL);`);
      raw.exec(`INSERT INTO chunks (file_path, line_start, line_end, entity_name, language, text, context, content_hash)
                VALUES ('src/old.ts', 1, 5, 'legacyName', 'ts', 'x', 'x', 'h')`);
      raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '1');
      raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('dimension', '768');
      // The WAL must be flushed into the main file before closing: otherwise a
      // reopen sees an inconsistent state in sqlite-vec and FTS5.
      raw.pragma('wal_checkpoint(TRUNCATE)');
      raw.close();

      const reopened = openDatabase(legacy);
      try {
        assert.equal(readMeta(reopened.db, 'schema_version'), String(SCHEMA_VERSION), 'all migrations applied');
        assert.equal(readMeta(reopened.db, 'dimension'), '768', 'unrelated metadata is preserved');

        const row = reopened.db.prepare('SELECT file_path, entity_name, entities FROM chunks').get() as {
          file_path: string; entity_name: string; entities: string;
        };
        assert.equal(row.file_path, 'src/old.ts');
        const backfilled = JSON.parse(row.entities) as Array<Record<string, unknown>>;
        assert.equal(backfilled.length, 1, 'the backfill creates one entity');
        assert.equal(backfilled[0]?.name, 'legacyName', 'the name is carried over from entity_name');
        assert.equal(backfilled[0]?.type, 'unknown', 'the backfilled type is unknown and marked as such');
        assert.equal(backfilled[0]?.lineStart, 1, 'the backfilled bounds are the chunk bounds');
        for (const key of ['name', 'type', 'signature', 'lineStart', 'lineEnd']) {
          assert.ok(key in (backfilled[0] ?? {}), `the backfill shape must match the indexer's: missing ${key}`);
        }
      } finally {
        reopened.db.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
