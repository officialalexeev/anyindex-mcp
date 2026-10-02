import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { createIgnoreFilter, readIndexable, scanRepository, sha1, toPosix } from '../src/scanner.js';

let root = '';
let config: ReturnType<typeof loadConfig> | undefined;

const cfg = (): ReturnType<typeof loadConfig> => {
  if (config === undefined) throw new Error('config not initialised');
  return config;
};

const scan = async (): Promise<string[]> => {
  const result = await scanRepository(cfg());
  return result.files.map((f) => f.relPath);
};

const write = async (relPath: string, content: string): Promise<void> => {
  const target = path.join(root, relPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
};

suite('toPosix', () => {
  test('converts native separators to slashes', () => {
    assert.equal(toPosix(path.join('src', 'auth', 'login.ts')), 'src/auth/login.ts');
  });

  test('is idempotent for an already-POSIX path', () => {
    assert.equal(toPosix('src/auth/login.ts'), 'src/auth/login.ts');
  });
});

suite('sha1', () => {
  test('is deterministic and distinguishes content', () => {
    assert.equal(sha1('abc'), sha1('abc'));
    assert.notEqual(sha1('abc'), sha1('abd'));
    assert.equal(sha1('abc').length, 40);
  });
});

suite('scanRepository', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'anyindex-scanner-'));
    config = loadConfig({ root });

    await write('src/index.ts', 'export const a = 1\n');
    await write('src/auth/login.ts', 'export function login() {}\n');
    await write('src/auth/session.ts', 'export function createSession() {}\n');
    await write('lib/util.py', 'def util():\n    pass\n');
    await write('README.md', '# Project\n');
    await write('config.yaml', 'key: value\n');
    await write('.gitignore', 'build/\n*.generated.ts\n');
    await write('build/output.ts', 'export const built = 1\n');
    await write('src/thing.generated.ts', 'export const gen = 1\n');
    await write('node_modules/pkg/index.js', 'module.exports = 1\n');
    await write('assets/logo.png', 'not a real png');
    await write('docs/guide.md', '# Guide\n');
    await write('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('indexes only the target extensions', async () => {
    const files = await scan();
    assert.ok(files.includes('src/index.ts'));
    assert.ok(files.includes('lib/util.py'));
    assert.ok(files.includes('config.yaml'));
    assert.ok(!files.includes('node_modules/pkg/index.js'));
  });

  test('honours .gitignore', async () => {
    const files = await scan();
    assert.ok(!files.includes('build/output.ts'), 'a directory from .gitignore must be excluded');
    assert.ok(!files.includes('src/thing.generated.ts'), 'a glob from .gitignore must apply');
  });

  test('honours a nested .gitignore', async () => {
    await write('src/auth/.gitignore', 'session.ts\n');
    const files = await scan();
    assert.ok(!files.includes('src/auth/session.ts'), 'the nested rule must apply');
    assert.ok(files.includes('src/auth/login.ts'), 'sibling files stay');
  });

  test('a nested .gitignore overrides the root rule', async () => {
    await write('src/.gitignore', '!index.ts\n');
    await write('.gitignore', 'src/index.ts\n');
    const files = await scan();
    assert.ok(files.includes('src/index.ts'), 'the nested rule should win the re-inclusion');
  });

  test('honours .git/info/exclude', async () => {
    await write('secret/local.ts', 'export const token = 1\n');
    await mkdir(path.join(root, '.git', 'info'), { recursive: true });
    await write('.git/info/exclude', 'secret/\n');
    const files = await scan();
    assert.ok(!files.includes('secret/local.ts'), '.git/info/exclude must apply');
  });

  test('our ignore file wins over .gitignore', async () => {
    await write('.anyindexignore', 'README.md\n');
    const files = await scan();
    assert.ok(!files.includes('README.md'), '.anyindexignore overrides .gitignore');
    assert.ok(files.includes('docs/guide.md'), 'files outside the rules stay');
  });

  test('excludes lock files by name', async () => {
    const files = await scan();
    assert.ok(!files.includes('package-lock.json'));
  });

  test('excludes binary extensions', async () => {
    const files = await scan();
    assert.ok(!files.includes('assets/logo.png'));
  });

  test('excludes node_modules regardless of the ignore files', async () => {
    const files = await scan();
    assert.ok(!files.some((f) => f.includes('node_modules')));
  });

  test('does not index empty files', async () => {
    await write('empty.ts', '');
    const files = await scan();
    assert.ok(!files.includes('empty.ts'));
  });

  test('skips files larger than maxFileBytes', async () => {
    const permissive = loadConfig({ root });
    const strict = loadConfig({ root, maxFileBytes: 10 });
    assert.ok((await scanRepository(permissive)).files.length > 0);
    assert.equal((await scanRepository(strict)).files.filter((f) => f.size > 10).length, 0);
  });

  test('the order is deterministic between runs', async () => {
    const first = await scan();
    const second = await scan();
    assert.deepEqual(first, second);
    assert.deepEqual([...first].sort(), first, 'the result should be sorted');
  });

  test('reads content by relative path', async () => {
    assert.equal(await readIndexable(root, 'src/index.ts'), 'export const a = 1\n');
  });

  test('returns null instead of throwing on an unreadable file', async () => {
    assert.equal(await readIndexable(root, 'does/not/exist.ts'), null);
  });
});

suite('createIgnoreFilter', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'anyindex-ignore-'));
    config = loadConfig({ root });

    await write('.gitignore', 'build/\n*.generated.ts\n');
    await write('build/output.ts', 'export const built = 1\n');
    await write('src/index.ts', 'export const a = 1\n');
    await write('src/auth/.gitignore', 'session.ts\n');
    await write('src/auth/session.ts', 'export const s = 1\n');
    await write('src/auth/login.ts', 'export function login() {}\n');
    await write('src/thing.generated.ts', 'export const gen = 1\n');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reproduces the scanner's decisions without a full walk", async () => {
    const isIgnored = createIgnoreFilter(root);
    const files = (await scanRepository(cfg())).files.map((f) => f.relPath);

    for (const relPath of files) {
      assert.equal(isIgnored(relPath), false, `${relPath}: the scanner took the file, the predicate rejected it`);
    }
    for (const relPath of ['build/output.ts', 'src/auth/session.ts', 'src/thing.generated.ts']) {
      assert.equal(isIgnored(relPath), true, `${relPath}: the scanner rejected the file, the predicate let it through`);
    }
  });
});

suite('traversal safety', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'anyindex-symlink-'));
    config = loadConfig({ root });
    await write('src/real.ts', 'export const real = 1\n');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('does not follow symlinks out of the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'anyindex-outside-'));
    await writeFile(path.join(outside, 'secret.ts'), 'export const secret = 1\n', 'utf8');

    try {
      await symlink(outside, path.join(root, 'linked'), 'dir');
    } catch {
      return; // symlink unavailable - skip
    }

    const files = await scan();
    assert.ok(!files.some((f) => f.startsWith('linked/')), 'a symlink out of the root must not be indexed');
  });
});
