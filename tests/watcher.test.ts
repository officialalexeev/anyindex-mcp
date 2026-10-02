import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, suite, test } from 'node:test';

import { startWatcher } from '../src/watcher.js';

suite('watcher', () => {
  let root = '';
  const batches: Array<string[]> = [];

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-watch-'));
    batches.length = 0;
    await mkdir(path.join(root, 'src'), { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('collects added files in batches and normalises the paths', async () => {
    const seen: Array<string[]> = [];
    const watcher = startWatcher({
      root,
      debounceMs: 150,
      onEvents: (files) => {
        seen.push([...files].sort());
      },
    });

    // Let chokidar reach ready, otherwise the files are dropped by the
    // ignoreInitial flag.
    await delay(600);

    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8');
    await writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2\n', 'utf8');
    await delay(900);

    await watcher.close();

    const all = seen.flat();
    assert.ok(all.includes('src/a.ts'), `expected src/a.ts, got ${JSON.stringify(all)}`);
    assert.ok(all.includes('src/b.ts'), `expected src/b.ts, got ${JSON.stringify(all)}`);
    assert.ok(
      all.every((p) => !p.includes('\\')),
      `paths should be POSIX, got ${JSON.stringify(all)}`,
    );
  });

  test('a deleted file also lands in the batch', async () => {
    const target = path.join(root, 'src', 'gone.ts');
    await writeFile(target, 'export const gone = 1\n', 'utf8');

    const seen: string[] = [];
    const watcher = startWatcher({
      root,
      debounceMs: 150,
      onEvents: (files) => {
        seen.push(...files);
      },
    });
    await delay(600);

    await rm(target);
    await delay(900);
    await watcher.close();

    assert.ok(seen.includes('src/gone.ts'), `expected src/gone.ts, got ${JSON.stringify(seen)}`);
  });

  test('ignores build and dependency directories', async () => {
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });

    const seen: string[] = [];
    const watcher = startWatcher({
      root,
      debounceMs: 150,
      onEvents: (files) => {
        seen.push(...files);
      },
    });
    await delay(600);

    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n', 'utf8');
    await writeFile(path.join(root, 'src', 'kept.ts'), 'export const kept = 1\n', 'utf8');
    await delay(900);
    await watcher.close();

    assert.ok(!seen.some((p) => p.includes('node_modules')), `node_modules should not be indexed: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('src/kept.ts'), `expected src/kept.ts, got ${JSON.stringify(seen)}`);
  });

  test('ignores directories from the list shared with the scanner', async () => {
    // The exclusion list is shared by the scanner and the watcher: while each
    // kept its own, a change under `vendor/` reached the full indexing pass
    // for nothing.
    await mkdir(path.join(root, 'vendor', 'dep'), { recursive: true });

    const seen: string[] = [];
    const watcher = startWatcher({
      root,
      debounceMs: 150,
      onEvents: (files) => {
        seen.push(...files);
      },
    });
    await delay(600);

    await writeFile(path.join(root, 'vendor', 'dep', 'index.ts'), 'export const v = 1\n', 'utf8');
    await writeFile(path.join(root, 'src', 'kept3.ts'), 'export const kept3 = 1\n', 'utf8');
    await delay(900);
    await watcher.close();

    assert.ok(!seen.some((p) => p.includes('vendor')), `vendor should not be indexed: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('src/kept3.ts'), `expected src/kept3.ts, got ${JSON.stringify(seen)}`);
  });

  test('isIgnored drops files before they are queued', async () => {
    const seen: string[] = [];
    const watcher = startWatcher({
      root,
      debounceMs: 150,
      isIgnored: (relPath) => relPath.endsWith('.md'),
      onEvents: (files) => {
        seen.push(...files);
      },
    });
    await delay(600);

    await writeFile(path.join(root, 'notes.md'), '# notes\n', 'utf8');
    await writeFile(path.join(root, 'src', 'code.ts'), 'export const code = 1\n', 'utf8');
    await delay(900);
    await watcher.close();

    assert.ok(!seen.some((p) => p.endsWith('.md')), `markdown should be dropped: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes('src/code.ts'));
  });

  test('the pending queue is visible from outside', async () => {
    // The debounce is deliberately longer than the check pause: the queue should
    // already be filled but not yet flushed. The ~800 ms window fits a local FS
    // event with room to spare, so the test does not flake.
    const watcher = startWatcher({
      root,
      debounceMs: 1500,
      onEvents: () => {},
    });
    await delay(600);

    await writeFile(path.join(root, 'src', 'queued.ts'), 'export const queued = 1\n', 'utf8');
    await delay(700);

    const pending = watcher.pending();
    await watcher.close();

    assert.equal(pending, 1, `src/queued.ts should be waiting in the queue, got ${pending}`);
  });
});
