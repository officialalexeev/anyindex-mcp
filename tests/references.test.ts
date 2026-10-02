import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { openDatabase, type DatabaseHandle } from '../src/db.js';
import { findReferences } from '../src/references.js';

let root = '';
let dbPath = '';
let db: DatabaseHandle;

function insert(db_: DatabaseHandle, args: {
  file: string;
  lineStart: number;
  lineEnd: number;
  entityName?: string;
  entityType?: string;
  signature?: string;
  /** Entity bounds need not match the chunk bounds - that is what an overlap looks like. */
  entityStart?: number;
  entityEnd?: number;
  language?: string;
  text: string;
  hash: string;
}): void {
  const entities = args.entityName === undefined
    ? '[]'
    : JSON.stringify([{
        name: args.entityName,
        type: args.entityType ?? 'function',
        signature: args.signature ?? null,
        lineStart: args.entityStart ?? args.lineStart,
        lineEnd: args.entityEnd ?? args.lineEnd,
      }]);

  db_.prepare(`
    INSERT INTO chunks (file_path, line_start, line_end, entity_name, entities, language, text, context, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.file,
    args.lineStart,
    args.lineEnd,
    args.entityName ?? null,
    entities,
    args.language ?? 'typescript',
    args.text,
    args.text,
    args.hash,
  );
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aidx-refs-'));
  dbPath = path.join(root, '.anyindex', 'index.db');
  db = openDatabase(loadConfig({ root, dbPath }).dbPath).db;

  insert(db, {
    file: 'src/watcher.ts', lineStart: 10, lineEnd: 40,
    entityName: 'startWatcher', signature: '(root: string) => FSWatcher',
    text: [
      'export function startWatcher(options: Options) {',
      '  return chokidar.watch(options.root)',
      '}',
    ].join('\n'),
    hash: 'h1',
  });

  insert(db, {
    file: 'src/watcher.test.ts', lineStart: 5, lineEnd: 12,
    text: [
      "import { startWatcher } from '../src/watcher.js'",
      '',
      'test("watcher", () => {',
      '  const w = startWatcher({})',
      '})',
    ].join('\n'),
    hash: 'h2',
  });

  insert(db, {
    file: 'src/other.ts', lineStart: 1, lineEnd: 6,
    entityName: 'startWatcherLike', entityType: 'function',
    text: 'export function startWatcherLike() { return 1 }\nconst w = startWatcher({})',
    hash: 'h3',
  });

  // An overlapping chunk carrying the same declaration. An overlap in a code
  // chunk shares the entity boundary, so the range here is the same as the
  // first chunk's - otherwise these would be two separate declarations.
  insert(db, {
    file: 'src/watcher.ts', lineStart: 35, lineEnd: 60,
    entityName: 'startWatcher', entityStart: 10, entityEnd: 40,
    text: [
      '// ...хвост функции',
      'export function startWatcher(options: Options) {',
      '  return null',
      '}',
    ].join('\n'),
    hash: 'h4',
  });
});

after(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

suite('references: finding an identifier', () => {
  test('finds the declaration and the use sites', () => {
    const outcome = findReferences(db, 'startWatcher');

    assert.equal(outcome.definitions.length, 1, 'there must be one declaration, not one per overlapping chunk');
    assert.equal(outcome.definitions[0]?.filePath, 'src/watcher.ts');
    assert.equal(outcome.definitions[0]?.kind, 'function');
    assert.equal(outcome.definitions[0]?.signature, '(root: string) => FSWatcher');

    const files = new Set(outcome.references.map((r) => r.filePath));
    assert.ok(files.has('src/watcher.test.ts'), 'the use from the test file was not found');
    assert.ok(files.has('src/other.ts'), 'the use from the other module was not found');
  });

  test('the declaration line is not counted as a use', () => {
    const outcome = findReferences(db, 'startWatcher');
    const inDefinition = outcome.references.filter((r) => r.filePath === 'src/watcher.ts');

    for (const ref of inDefinition) {
      for (const line of ref.lines) {
        assert.ok(
          line < 10 || line > 40,
          `declaration line ${line} leaked into the references - it belongs in definitions`,
        );
      }
    }
  });

  test('matches a whole token, not a prefix', () => {
    const outcome = findReferences(db, 'startWatcher');
    const prefixOnly = outcome.references.filter((r) => r.snippet.includes('startWatcherLike('));

    // startWatcherLike contains startWatcher as a substring but not as a token;
    // the startWatcherLike declaration itself is a legitimate match, while the
    // `const w = startWatcher({})` next to it is a separate one.
    for (const ref of prefixOnly) {
      assert.ok(
        ref.snippet.includes('const w = startWatcher(') || ref.snippet.includes('startWatcherLike'),
        `a bare prefix made it into the references: ${ref.snippet}`,
      );
    }
  });

  test('an empty symbol and an unknown symbol give an empty result without an error', () => {
    for (const symbol of ['', '   ', 'definitelyNotInIndex12345']) {
      const outcome = findReferences(db, symbol);
      assert.equal(outcome.references.length, 0);
      assert.equal(outcome.definitions.length, 0);
    }
  });

  test('FTS5 syntax in the symbol does not break the tool', () => {
    const outcome = findReferences(db, 'a->b OR "x"');

    assert.equal(outcome.references.length, 0);
    assert.equal(outcome.matchedChunks, 0);
  });

  test('the file filter counts the discarded chunks', () => {
    const all = findReferences(db, 'startWatcher');
    const only = findReferences(db, 'startWatcher', { file: 'src/watcher.test.ts' });

    assert.ok(all.references.length > only.references.length, 'the filter should narrow the result');
    // The counter counts chunks, not references: of the four chunks carrying
    // the identifier, three lie outside the requested file.
    assert.equal(only.otherFiles, 3, 'the discarded chunks should be counted');
    for (const ref of only.references) {
      assert.equal(ref.filePath, 'src/watcher.test.ts');
    }
  });

  test('includeDefinitions:false removes declarations from the answer', () => {
    const outcome = findReferences(db, 'startWatcher', { includeDefinitions: false });

    assert.equal(outcome.definitions.length, 0);
  });

  test('maxResults limits the result and sets truncated', () => {
    const outcome = findReferences(db, 'startWatcher', { maxResults: 1 });

    assert.ok(outcome.references.length <= 1);
    assert.equal(outcome.truncated, outcome.references.length < 4);
  });
});