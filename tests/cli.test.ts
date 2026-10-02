import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, suite, test } from 'node:test';

import { subcommandEntry } from '../src/cli.js';
import { renderStrategies } from '../src/cli.js';

const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Read independently of src/config.ts on purpose: the test is about the manifest,
// and asking the code under test for the expected value proves nothing.
const packageVersion = (): string => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
};

const runEntry = (entry: string, args: string[]): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
};

const run = (args: string[]): { status: number; stdout: string; stderr: string } => runEntry(cliEntry, args);

let root = '';

suite('cli', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-cli-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('help prints the command list and exits with 0', () => {
    const { status, stdout } = run(['help']);
    assert.equal(status, 0);
    for (const command of ['reindex', 'update', 'status', 'search', 'probe', 'benchmark']) {
      assert.ok(stdout.includes(command), `command ${command} should appear in the help`);
    }
  });

  test('an unknown command is rejected', () => {
    const { status, stderr } = run(['nonsense']);
    assert.equal(status, 1);
    assert.match(stderr, /Unknown command/);
  });

  test('status on an empty index is honest and exits non-zero', () => {
    const { status, stdout } = run(['status', '--root', root, '--json']);
    const stats = JSON.parse(stdout) as { ready: boolean; reason?: string };

    assert.equal(stats.ready, false);
    assert.equal(status, 1, 'a not-ready index must exit non-zero');
  });

  test('status --json returns valid JSON', () => {
    const { stdout } = run(['status', '--root', root, '--json']);
    const stats = JSON.parse(stdout) as Record<string, unknown>;
    for (const key of ['ready', 'degraded', 'files', 'chunks', 'stale', 'astChunks', 'fallbackChunks', 'nonCodeChunks']) {
      assert.ok(key in stats, `status should carry the field ${key}`);
    }
  });

  test('search without a query is rejected', () => {
    const { status, stderr } = run(['search', '--root', root]);
    assert.equal(status, 1);
    assert.match(stderr, /Empty query/);
  });

  test('search on a not-ready index refuses instead of inventing a result', () => {
    const { status, stderr } = run(['search', 'что-нибудь', '--root', root]);
    assert.equal(status, 1);
    assert.match(stderr, /Index is not ready/);
    assert.match(stderr, /reindex/);
  });

  test('an unknown search mode is rejected instead of replaced by the default', () => {
    const { status, stderr } = run(['search', '--mode', 'лексика', 'что-нибудь', '--root', root]);
    assert.equal(status, 1);
    assert.match(stderr, /Unknown search mode/);
    assert.match(stderr, /hybrid, semantic, keyword/);
  });

  test('an unsupported quantization is rejected before the model is loaded', () => {
    for (const command of ['status', 'search', 'update']) {
      const { status, stderr } = run([command, '--dtype', 'q4', '--root', root]);
      assert.equal(status, 1, `${command}: exit code`);
      assert.match(stderr, /Unknown quantization/, `${command}: reason`);
      assert.match(stderr, /q8, fp16, fp32/, `${command}: allowed values`);
    }
  });

  test('the help lists only values the CLI actually accepts', () => {
    const { stdout } = run(['help']);

    assert.match(stdout, /--dtype <q8\|fp16\|fp32>/);
    assert.match(stdout, /--mode <hybrid\|semantic\|keyword>/);
    assert.ok(!stdout.includes('q4'), 'q4 is unsupported and must not be mentioned');

    // The advertised set has to equal the accepted set exactly: a mode alias
    // listed in the help but rejected by the parser is a documented lie.
    const advertised = stdout.match(/--mode <([^>]+)>/)?.[1]?.split('|').sort() ?? [];
    assert.deepEqual(advertised, ['hybrid', 'keyword', 'semantic'], 'the help advertises a mode the CLI rejects');
  });

  test('probe and benchmark resolve to existing paths on any OS', () => {
    const dir = path.dirname(cliEntry);

    for (const command of ['probe', 'benchmark'] as const) {
      const entry = subcommandEntry(command);
      assert.equal(entry, path.join(dir, `${command}.js`));
      assert.ok(existsSync(entry), `${command}: no file at ${entry}`);
    }
  });

  test('--version prints the manifest version instead of the help text', () => {
    for (const flag of ['--version', '-v']) {
      const { status, stdout } = run([flag]);
      assert.equal(status, 0, `${flag}: exit code`);
      assert.equal(stdout.trim(), packageVersion(), `${flag}: the manifest version is what the client sees`);
    }
  });

  // The compiled layout differs from the test layout — dist/config.js is one level
  // below the manifest, dist-test/src/config.js is two — so a lookup that only
  // works from here would ship broken and pass here.
  test('the published build reports the same version', () => {
    const built = path.resolve(path.dirname(cliEntry), '..', '..', 'dist', 'cli.js');
    assert.ok(existsSync(built), `no build to test at ${built}`);

    const { status, stdout } = runEntry(built, ['--version']);

    assert.equal(status, 0, 'the built CLI must start');
    assert.equal(stdout.trim(), packageVersion(), 'the build resolves package.json the same way');
  });

  test('a root that does not exist is an error, not an empty successful reindex', () => {
    const missing = path.join(root, 'no-such-folder');

    for (const command of ['reindex', 'update']) {
      const { status, stderr } = run([command, '--root', missing]);
      assert.equal(status, 1, `${command}: a mistyped --root must not report success`);
      assert.match(stderr, /Root does not exist/, `${command}: the reason`);
    }
  });

  test('the status line separates code from non-code instead of reporting one fallback total', () => {
    const { stdout } = run(['status', '--root', root]);

    assert.match(stdout, /Code: AST \d+/);
    assert.match(stdout, /Non-code: \d+ \(markdown\/json\/yaml\/yml\/toml\)/);
    assert.ok(!stdout.includes('fallback path'), `the old lumped label is back: ${stdout}`);
  });

  test('a fallback on a parsable language is called out separately', () => {
    const base = {
      astChunks: 10,
      nonCodeChunks: 20,
      fallbackChunks: 25,
    };

    assert.ok(!renderStrategies({ ...base, fallbackChunks: 20 } as never).includes('Fallback failures'),
      'no failures to report');
    assert.match(
      renderStrategies(base as never),
      /Fallback failures: 5 chunk\(s\)/,
      'five of the fallbacks are on languages tree-sitter can parse',
    );
  });
});
