import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { scanRepository } from '../src/scanner.js';

const TMP: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aidx-anchor-'));
  TMP.push(dir);
  return dir;
}

after(async () => {
  for (const dir of TMP) await rm(dir, { recursive: true, force: true });
});

suite('stored paths are anchored, not relative to the scanned folder', () => {
  test('the same file keys identically whether scanned from inside or from above', async () => {
    const top = await scratch();
    const api = path.join(top, 'src', 'api');
    const lib = path.join(top, 'lib');
    await mkdir(api, { recursive: true });
    await mkdir(lib, { recursive: true });
    await writeFile(path.join(api, 'login.js'), 'export function login() {}\n', 'utf8');
    await writeFile(path.join(lib, 'util.js'), 'export const u = 1;\n', 'utf8');

    const fromApi = await scanRepository(loadConfig({ root: api, indexRoot: top }));
    const fromTop = await scanRepository(loadConfig({ root: top, indexRoot: top }));

    assert.deepEqual(fromApi.files.map((f) => f.relPath), ['src/api/login.js']);
    assert.deepEqual(
      fromTop.files.map((f) => f.relPath).sort(),
      ['lib/util.js', 'src/api/login.js'],
    );

    // The whole point: a later wider scan recognises the earlier entry instead of
    // adding a second copy of the same file.
    const alreadyIndexed = new Set(fromApi.files.map((f) => f.relPath));
    const duplicates = fromTop.files.filter((f) => alreadyIndexed.has(f.relPath));
    assert.equal(duplicates.length, 1, 'the file indexed from src/api is recognised, not duplicated');
    assert.equal(duplicates[0]?.relPath, 'src/api/login.js');
  });

  test('ignore rules still read relative to the scanned folder', async () => {
    const top = await scratch();
    const api = path.join(top, 'src', 'api');
    await mkdir(api, { recursive: true });
    await writeFile(path.join(api, 'kept.js'), 'export const a = 1;\n', 'utf8');
    await writeFile(path.join(api, 'skipped.js'), 'export const b = 2;\n', 'utf8');
    await writeFile(path.join(api, '.anyindexignore'), 'skipped.js\n', 'utf8');

    const result = await scanRepository(loadConfig({ root: api, indexRoot: top }));
    assert.deepEqual(result.files.map((f) => f.relPath), ['src/api/kept.js']);
  });

  test('an absent anchor falls back to the scanned folder', async () => {
    const dir = await scratch();
    const config = loadConfig({ root: dir, indexRoot: dir });
    await writeFile(path.join(dir, 'a.js'), 'export const a = 1;\n', 'utf8');

    const result = await scanRepository(config);
    assert.deepEqual(result.files.map((f) => f.relPath), ['a.js']);
  });
});