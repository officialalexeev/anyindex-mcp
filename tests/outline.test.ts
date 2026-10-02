import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { indexRepository } from '../src/indexer.js';
import { openDatabase, createVectorTable, writeMeta } from '../src/db.js';
import { writeFileChunks } from '../src/indexer.js';
import { chunkFile } from '../src/chunker.js';

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let root = '';

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--root', root],
    env: { ...process.env, ANYINDEX_LOG_LEVEL: 'error' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'outline-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

suite('get_file_outline', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-outline-'));
    const target = path.join(root, 'src/auth.ts');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      [
        'import { db } from "../db"',
        '',
        'export async function loginUser(email: string) {',
        '  return db.users.findByEmail(email)',
        '}',
        '',
        'export class AuthError extends Error {}',
        '',
      ].join('\n'),
      'utf8',
    );

    // The tool reads the index rather than scanning the repository, so a single
    // indexing pass without embeddings is enough.
    const config = loadConfig({ root });
    await indexRepository(config, { resetVectors: true });

    const { db } = openDatabase(config.dbPath);
    try {
      const source = await readAll();
      const { chunks } = await chunkFile('src/auth.ts', source);
      writeFileChunks(db, 'src/auth.ts', chunks);
      createVectorTable(db, config.dimension);
      writeMeta(db, 'dimension', String(config.dimension));
      writeMeta(db, 'model_id', config.model);
    } finally {
      db.close();
    }
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const readAll = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile(path.join(root, 'src/auth.ts'), 'utf8');
  };

  test('returns the entities of a file with their line ranges', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'get_file_outline',
        arguments: { file: 'src/auth.ts' },
      });
      const payload = result.structuredContent as {
        file: string;
        language: string;
        indexed: boolean;
        entities: Array<{ name: string; kind: string; signature: string | null; lines: [number, number] }>;
      };

      assert.equal(payload.indexed, true);
      assert.equal(payload.file, 'src/auth.ts');
      assert.equal(payload.language, 'typescript');
      // The tool promises symbols, not chunk ranges: a single chunk can hold
      // several entities, and all of them have to be visible.
      assert.ok(payload.entities.length >= 2, `expected at least two symbols, got ${payload.entities.length}`);

      const names = payload.entities.map((e) => e.name);
      assert.ok(names.includes('loginUser') || names.includes('AuthError'), `expected entities, got ${JSON.stringify(names)}`);

      // The lines belong to the entity itself, not to the chunk: for the first
      // declaration in a file this need not be 1.
      for (const entity of payload.entities) {
        assert.ok(entity.name.length > 0, 'an entity must have a name');
        assert.ok(entity.kind.length > 0, 'an entity must have a kind');
        assert.ok(entity.lines[0] >= 1, `lines should be 1-based, got ${entity.lines[0]}`);
        assert.ok(entity.lines[1] >= entity.lines[0]);
      }

      const sorted = [...payload.entities].sort((a, b) => a.lines[0] - b.lines[0]);
      assert.deepEqual(payload.entities, sorted, 'the result should be sorted by line');
    } finally {
      await client.close();
    }
  });

  test('an unknown file returns isError with a reason instead of an empty list', async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: 'get_file_outline',
        arguments: { file: 'src/does-not-exist.ts' },
      });

      assert.equal(result.isError, true);
      const payload = result.structuredContent as { indexed: boolean; note?: string; entities: unknown[] };
      assert.equal(payload.indexed, false);
      assert.equal(payload.entities.length, 0);
      assert.ok((payload.note ?? '').length > 0, 'the reason must be named');
    } finally {
      await client.close();
    }
  });
});
