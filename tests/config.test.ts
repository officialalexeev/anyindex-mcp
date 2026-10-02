import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, suite, test } from 'node:test';

import { INDEX_DIR_NAME, defaultModelsDir, loadConfig, resolveIndexRoot } from '../src/config.js';

const TMP: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aidx-cfg-'));
  TMP.push(dir);
  return dir;
}

// The child process reads process.env on its own, so the flag cannot be set from
// inside this one without leaking into every later assertion.
const watchUnderEnv = (value: string): boolean => {
  const previous = process.env.ANYINDEX_WATCH;
  try {
    process.env.ANYINDEX_WATCH = value;
    return loadConfig().watch;
  } finally {
    if (previous === undefined) delete process.env.ANYINDEX_WATCH;
    else process.env.ANYINDEX_WATCH = previous;
  }
};

function ancestorHasGit(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

after(async () => {
  for (const dir of TMP) await rm(dir, { recursive: true, force: true });
});

suite('config', () => {
  test('root resolution prefers the explicit override', async () => {
    const dir = await scratch();
    assert.equal(loadConfig({ root: dir }).root, path.resolve(dir));
  });

  test('the scanned folder defaults to the working directory, not the anchor', async () => {
    const top = await scratch();
    const inner = path.join(top, 'src', 'api');
    await mkdir(inner, { recursive: true });
    await mkdir(path.join(top, '.git'), { recursive: true });

    const fromInner = loadConfig({ root: inner });
    assert.equal(fromInner.root, path.resolve(inner), 'scans the folder it was given');
    assert.equal(fromInner.indexRoot, path.resolve(top), 'anchors on the repository');
    assert.equal(fromInner.dbPath, path.join(path.resolve(top), INDEX_DIR_NAME, 'index.db'));

    const fromTop = loadConfig({ root: top });
    assert.equal(fromTop.indexRoot, path.resolve(top));
    assert.equal(fromTop.dbPath, fromInner.dbPath, 'both reach the same database');
  });

  test('the anchor resolution finds the nearest enclosing repository', async () => {
    const top = await scratch();
    const inner = path.join(top, 'src', 'deep', 'deeper');
    await mkdir(inner, { recursive: true });
    await mkdir(path.join(top, '.git'), { recursive: true });

    assert.equal(resolveIndexRoot(inner), path.resolve(top));
    assert.equal(resolveIndexRoot(top), path.resolve(top));
  });

  test('the anchor resolution stops at the nearest repository', async () => {
    const top = await scratch();
    const inner = path.join(top, 'a');
    await mkdir(inner, { recursive: true });
    await mkdir(path.join(top, '.git'), { recursive: true });
    await mkdir(path.join(inner, '.git'), { recursive: true });

    assert.equal(resolveIndexRoot(inner), path.resolve(inner));
  });

  test('the anchor resolution falls back to the folder itself when nothing above is a repository', async (t) => {
    const dir = await scratch();
    if (ancestorHasGit(dir)) {
      t.skip('a parent of the temporary directory is a repository, so the fallback cannot be asserted');
      return;
    }
    assert.equal(resolveIndexRoot(dir), path.resolve(dir));
  });

  test('the index lives under the anchor while the model cache does not', async () => {
    const dir = await scratch();
    const config = loadConfig({ root: dir, indexRoot: dir });

    assert.equal(config.indexRoot, path.resolve(dir));
    assert.equal(config.dbPath, path.join(path.resolve(dir), INDEX_DIR_NAME, 'index.db'));
    assert.ok(!config.modelsDir.startsWith(config.dbPath), `models in the index dir: ${config.modelsDir}`);
    assert.ok(!config.modelsDir.startsWith(path.resolve(dir)), `models in the project: ${config.modelsDir}`);
  });

  test('the model cache is shared between projects', async () => {
    const one = await scratch();
    const two = await scratch();
    assert.equal(loadConfig({ root: one }).modelsDir, loadConfig({ root: two }).modelsDir);
  });

  test('the model cache follows XDG_CACHE_HOME when it is set', () => {
    const previous = process.env.XDG_CACHE_HOME;
    const base = path.join(tmpdir(), 'aidx-xdg');
    try {
      process.env.XDG_CACHE_HOME = base;
      assert.equal(defaultModelsDir(), path.join(base, 'anyindex-mcp', 'models'));
      assert.equal(loadConfig({ root: tmpdir() }).modelsDir, path.join(base, 'anyindex-mcp', 'models'));
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });

  test('an explicit models directory still wins', async () => {
    const dir = await scratch();
    const models = path.join(dir, 'somewhere');
    assert.equal(loadConfig({ root: dir, modelsDir: models }).modelsDir, path.resolve(models));
  });

  test('watching is reachable from the environment, not only from the flag', () => {
    assert.equal(watchUnderEnv('1'), true);
    assert.equal(watchUnderEnv('true'), true);

    // The usual spellings of "off" have to keep it off, or a client that strips
    // this variable would silently start a file watcher.
    for (const off of ['0', 'false', '']) {
      assert.equal(watchUnderEnv(off), false, `ANYINDEX_WATCH=${JSON.stringify(off)}`);
    }
  });
});