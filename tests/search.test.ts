import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { createVectorTable, openDatabase, type DatabaseHandle } from '../src/db.js';
import { searchChunks } from '../src/search.js';

const DIMENSION = 768;

let root = '';
let dbPath = '';

function seed(db: DatabaseHandle): void {
  const insert = db.prepare(`
    INSERT INTO chunks (file_path, line_start, line_end, entity_name, language, text, context, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insert.run(
    'src/billing.ts',
    1,
    8,
    'chargeCard',
    'typescript',
    'export function chargeCard(amount: number) { return amount }\n',
    'export function chargeCard(amount: number) { return amount }',
    'h1',
  );
  insert.run(
    'src/render.ts',
    1,
    4,
    'formatSize',
    'typescript',
    'export function formatSize(bytes: number) { return String(bytes) }\n',
    'export function formatSize(bytes: number) { return String(bytes) }',
    'h2',
  );
}

suite('search: match sources', () => {
  let db: DatabaseHandle;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-search-'));
    dbPath = path.join(root, '.anyindex', 'index.db');
    const config = loadConfig({ root, dbPath });

    db = openDatabase(config.dbPath).db;
    seed(db);
    createVectorTable(db, config.dimension);
  });

  after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test('keyword mode honestly labels the source keyword', () => {
    const outcome = searchChunks(db, 'chargeCard', null, 5, 'keyword');

    assert.ok(outcome.hits.length > 0, 'the keyword search should find something');
    for (const hit of outcome.hits) {
      assert.deepEqual(hit.sources, ['keyword'], `source ${JSON.stringify(hit.sources)} is labelled vector`);
      assert.equal(hit.distance, null, 'a keyword match carries no distance');
    }
  });

  test('hybrid without a vector produces no vector labels', () => {
    const outcome = searchChunks(db, 'chargeCard', null, 5, 'hybrid');

    assert.ok(outcome.hits.length > 0);
    for (const hit of outcome.hits) {
      assert.ok(!hit.sources.includes('vector'), 'the vector branch did not run - a vector label would be a lie');
    }
  });

  test('hybrid with a vector labels both sources where both found the chunk', () => {
    const vector = new Float32Array(DIMENSION);
    vector[0] = 1;

    db.prepare('INSERT INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?, ?, ?, ?)').run(
      BigInt(1),
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      'typescript',
      'export function chargeCard(amount: number) { return amount }',
    );

    const outcome = searchChunks(db, 'chargeCard', vector, 5, 'hybrid');
    const both = outcome.hits.find((hit) => hit.filePath === 'src/billing.ts');

    assert.ok(both !== undefined, 'src/billing.ts should appear in the result');
    assert.ok(both.sources.includes('vector'), `expected the vector source, got ${JSON.stringify(both.sources)}`);
    assert.ok(both.distance !== null, 'a vector match must carry a distance');
  });
});

suite('search: result selection', () => {
  let db: DatabaseHandle;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-rank-'));
    dbPath = path.join(root, '.anyindex', 'index.db');
    const config = loadConfig({ root, dbPath });

    db = openDatabase(config.dbPath).db;
    createVectorTable(db, config.dimension);

    // Five chunks across two files plus documentation. Without the per-file
    // chunk limit src/billing.ts would take three of the five positions.
    const insert = db.prepare(`
      INSERT INTO chunks (file_path, line_start, line_end, entity_name, language, text, context, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const vectors = db.prepare(
      'INSERT INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?, ?, ?, ?)',
    );

    const files: Array<[string, string, number]> = [
      ['src/billing.ts', 'typescript', 1],
      ['src/billing.ts', 'typescript', 2],
      ['src/billing.ts', 'typescript', 3],
      ['src/render.ts', 'typescript', 4],
      ['README.md', 'markdown', 5],
    ];

    files.forEach(([filePath, language, id], index) => {
      const context = `context of ${filePath} #${id}`;
      insert.run(filePath, id, id, `entity${id}`, language, context, context, `h${id}`);
      vectors.run(BigInt(id), Buffer.alloc(DIMENSION * 4), language, context);
    });
    void vectors;
  });

  after(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  test('the result contains no two chunks from one file', () => {
    const outcome = searchChunks(db, 'context', null, 5, 'keyword');
    const files = outcome.hits.map((hit) => hit.filePath);

    assert.equal(new Set(files).size, files.length, `file repeated in the result: ${files.join(', ')}`);
  });

  test('topK is limited by unique files, not by chunks', () => {
    const outcome = searchChunks(db, 'context', null, 3, 'keyword');

    assert.equal(outcome.hits.length, 3, 'three files - three results');
    assert.equal(new Set(outcome.hits.map((h) => h.filePath)).size, 3);
  });

  test('documentation does not displace code at equal rank', () => {
    // The key check: the weight has to change the ORDER, not just the number in
    // the score field. The first version discounted the score but walked the
    // candidates in raw RRF order, so the discount did not achieve what it was
    // introduced for and the metrics were identical at any weight.
    const rows = db
      .prepare('SELECT id, file_path, language FROM chunks ORDER BY id')
      .all() as Array<{ id: number; file_path: string; language: string }>;
    const markdownId = rows.find((r) => r.language === 'markdown')?.id;
    assert.ok(markdownId !== undefined, 'the fixture must contain a markdown chunk');

    // Rival: code and documentation at the same raw rank. FTS5 ranks them by
    // bm25, so identical text is enough for an equal rank.
    db.prepare(
      `INSERT INTO chunks (file_path, line_start, line_end, entity_name, language, text, context, content_hash)
       VALUES ('src/rival.ts', 99, 99, 'rival', 'typescript', ?, ?, 'hrival')`,
    ).run('context of README.md #5', 'context of README.md #5');

    const outcome = searchChunks(db, 'context of README.md', null, 5, 'keyword');
    const code = outcome.hits.find((h) => h.filePath === 'src/rival.ts');
    const doc = outcome.hits.find((h) => h.language === 'markdown');

    assert.ok(code !== undefined, 'the code rival should appear in the result');
    assert.ok(doc !== undefined, 'the documentation should stay in the result instead of vanishing');
    const codeAt = outcome.hits.indexOf(code);
    const docAt = outcome.hits.indexOf(doc);
    assert.ok(
      codeAt < docAt,
      `at equal raw rank the code (position ${codeAt + 1}) must rank above the documentation (position ${docAt + 1})`,
    );
  });

  test('documentation confidence is computed from the distance, not from a downweight', () => {
    const outcome = searchChunks(db, 'context', null, 5, 'keyword');
    for (const hit of outcome.hits) {
      assert.equal(hit.confidence, 'moderate', 'a keyword match has no distance to judge');
    }
  });
});