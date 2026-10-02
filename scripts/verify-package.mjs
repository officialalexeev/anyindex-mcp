// What a consumer actually gets.
//
// `npm pack` output is asserted against the manifest, the packed files are read
// for CRLF and for credentials, and the tarball is installed into an empty
// project where the two entry points are started and driven. A local build that
// passes is not evidence of any of that: it runs from this tree, with these
// devDependencies, against a dist/ that may hold more than the package carries.
//
// The CRLF check exists because `.gitattributes` `text=auto` can make a file with
// CRLF on disk report as clean in `git status`, and `npm pack` reads working-tree
// bytes rather than the index. A release shipped that way looks identical to a
// correct one in every diff.
//
//   node scripts/verify-package.mjs
//   node scripts/verify-package.mjs --from-registry --version=1.0.0
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = manifest.name;

const fromRegistry = process.argv.includes('--from-registry');
const versionArg = (() => {
  const at = process.argv.indexOf('--version');
  return at === -1 ? manifest.version : process.argv[at + 1];
})();

let failures = 0;
const log = (line = '') => process.stderr.write(`${line}\n`);

function check(name, fn) {
  try {
    const detail = fn();
    log(`  ok   ${name}${detail === undefined ? '' : `  ${detail}`}`);
  } catch (error) {
    failures += 1;
    log(`  FAIL ${name}: ${error.message}`);
  }
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    // Node refuses to spawn a .cmd without a shell (CVE-2024-27980), so on
    // Windows npm has to go through one. Every argument reaching that shell is
    // ours except the version flag, which is validated below.
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
    ...opts,
  });

// On Windows `npm` is a .cmd shim.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.argv.includes('--version') && !/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(versionArg)) {
  process.stderr.write(`refusing to pass an unvalidated --version to npm: ${versionArg}\n`);
  process.exit(2);
}

/** Every path in a tarball, `package/` stripped, sorted. */
function listTarball(tarball) {
  const out = run('tar', ['-tzf', tarball]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^package\//, ''));
}

// ---------------------------------------------------------------- the manifest

log(`\nmanifest`);

check('name and version are filled in', () => {
  if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('no name');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error(`version is not semver: ${manifest.version}`);
  }
  return `${NAME}@${manifest.version}`;
});

check('license is declared and a LICENSE file ships', () => {
  if (manifest.license !== 'MIT') throw new Error(`license is ${manifest.license}, expected MIT`);
  if (!readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').includes('MIT License')) {
    throw new Error('LICENSE does not read as MIT');
  }
  return 'MIT';
});

check('repository.url is a GitHub URL for this package', () => {
  const url = manifest.repository?.url;
  if (typeof url !== 'string') throw new Error('no repository.url');
  // npm matches the trusted publisher against this field and does not verify the
  // match until a publish fails inside Actions, where the message is a bare
  // E404. The repository name has to be the package name.
  const m = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  if (m === null) throw new Error(`not a GitHub URL: ${url}`);
  if (m[2] !== NAME) throw new Error(`${url} names "${m[2]}", package is "${NAME}"`);
  return `${m[1]}/${m[2]}`;
});

check('both entry points are declared', () => {
  const bins = Object.entries(manifest.bin ?? {});
  if (bins.length === 0) throw new Error('no bin');
  for (const [name, target] of bins) {
    if (!existsIn(target)) throw new Error(`${name} points at a missing file: ${target}`);
  }
  return bins.map(([n]) => n).join(', ');
});

function existsIn(rel) {
  try {
    statSync(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------- the packed tree

log(`\npacked bytes`);

let tarball;
let packed;

if (fromRegistry) {
  // Install the *published* artifact and pack that, rather than trusting this
  // checkout to be the same tree. `--version` exists so a release job can name
  // the version it just published.
  const staging = mkdtempSync(path.join(tmpdir(), 'aidx-registry-'));
  try {
    writeJson(path.join(staging, 'package.json'), { name: 'consumer', version: '1.0.0', type: 'module' });
    run(NPM, ['install', '--no-audit', '--no-fund', `${NAME}@${versionArg}`], { cwd: staging });
    const installed = path.join(staging, 'node_modules', NAME);
    packed = walkFiles(installed).map((p) => path.relative(installed, p).split(path.sep).join('/'));
    log(`  (driving ${NAME}@${versionArg} from the registry)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} else {
  tarball = path.join(ROOT, `${NAME}-${manifest.version}.tgz`);
  try { rmSync(tarball, { force: true }); } catch { /* first run */ }
  run(NPM, ['pack', '--silent'], { cwd: ROOT });
  packed = listTarball(tarball);
}

const packedSet = new Set(packed);

check('the compiled entry points ship', () => {
  for (const [, target] of Object.entries(manifest.bin ?? {})) {
    if (!packedSet.has(target)) throw new Error(`${target} is not in the package`);
  }
  return `${Object.keys(manifest.bin ?? {}).length} bin(s)`;
});

check('README and LICENSE ship', () => {
  for (const f of ['README.md', 'LICENSE']) {
    if (!packedSet.has(f)) throw new Error(`${f} is not in the package`);
  }
  if (manifest.files?.includes('CHANGELOG.md') && !packedSet.has('CHANGELOG.md')) {
    throw new Error('CHANGELOG.md is in `files` but not in the package');
  }
});

check('no test files, source maps or dev config ship', () => {
  // Tests live in tests/ and compile to dist-test/, so nothing test-related
  // should reach dist/ at all. The pattern is kept as a tripwire.
  const forbidden = packed.filter((f) =>
    /\.test\.js$/.test(f) || /\.map$/.test(f) || /^src\//.test(f) ||
    /^tests\//.test(f) || /^dist-test\//.test(f) || /^scripts\//.test(f) ||
    /^__tests__\//.test(f) || /(^|\/)\.npmrc$/.test(f) ||
    /\.(db|sqlite|onnx|log|tgz)$/.test(f));
  if (forbidden.length > 0) throw new Error(`unexpected: ${forbidden.slice(0, 8).join(', ')}`);
  return `${packed.length} file(s)`;
});

check('no packed file has CRLF line endings', () => {
  const root = fromRegistry ? null : ROOT;
  const offenders = [];
  for (const f of packed) {
    if (!/\.(js|ts|json|md|txt|yml|yaml|cjs|mjs)$/.test(f)) continue;
    const bytes = readFileSync(path.join(root, f));
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 10 && i > 0 && bytes[i - 1] === 13) { offenders.push(f); break; }
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join(', '));
  return `${packed.filter((f) => /\.(js|ts|json|md)$/.test(f)).length} text file(s)`;
});

// ------------------------------------------------------------------ the output

log(`\nsecret scan`);

check('no credential in the packed output', () => {
  // Placeholders that appear in prose are not credentials.
  const allow = [/^sk-your-/i, /<[^>]{1,40}>/];
  const patterns = [
    /gh[pousr]_[A-Za-z0-9]{30,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    /(?:token|password|secret)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/gi,
  ];
  const hits = [];
  for (const f of packed) {
    if (!/\.(js|ts|json|md)$/.test(f)) continue;
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const p of patterns) {
      for (const m of text.matchAll(p)) {
        if (allow.some((a) => a.test(m[0]))) continue;
        hits.push(`${f}: ${m[0].slice(0, 24)}`);
      }
    }
  }
  if (hits.length > 0) throw new Error(hits.slice(0, 3).join(' | '));
  return `${packed.length} file(s) scanned`;
});

check('the bins start with a node shebang', () => {
  for (const [, target] of Object.entries(manifest.bin ?? {})) {
    const first = readFileSync(path.join(ROOT, target), 'utf8').split('\n')[0];
    if (first !== '#!/usr/bin/env node') throw new Error(`${target} starts with "${first}"`);
  }
});

check('engines accepts the runner this job uses', () => {
  const e = manifest.engines?.node;
  if (typeof e !== 'string') throw new Error('no engines.node');
  return e;
});

// ------------------------------------------------------- the installed artifact

if (!fromRegistry) {
  log(`\ninstalled copy`);

  const consumer = mkdtempSync(path.join(tmpdir(), 'aidx-consumer-'));
  try {
    writeJson(path.join(consumer, 'package.json'), { name: 'consumer', version: '1.0.0', type: 'module' });
    run(NPM, ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer });

    const shim = path.join(consumer, 'node_modules', '.bin',
      process.platform === 'win32' ? 'anyindex-mcp.cmd' : 'anyindex-mcp');
    // The shim itself is a .cmd on Windows, which Node cannot spawn without a
    // shell. Execute the entry point it points at instead; the shim's presence
    // is asserted separately below.
    const cli = path.join(consumer, 'node_modules', NAME, manifest.bin['anyindex-mcp']);
    const cliRun = (args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: consumer, encoding: 'utf8',
    });

    check('the bin shim is installed', () => {
      if (!existsIn2(shim)) throw new Error(`no shim at ${shim}`);
      return path.relative(consumer, shim);
    });

    check('the bin prints usage', () => {
      const out = cliRun(['help']);
      if (out.status !== 0) throw new Error(`exit ${out.status}: ${(out.stderr ?? '').slice(0, 120)}`);
      if (!/reindex/.test(out.stdout)) throw new Error('usage text did not mention reindex');
      return `${out.stdout.split('\n').length} lines`;
    });

    check('status on an unbuilt index exits 1', () => {
      const out = cliRun(['status', '--root', consumer]);
      if (out.status !== 1) throw new Error(`expected exit 1, got ${out.status}`);
      return 'the documented not-ready contract holds';
    });

    check('the native stack loads with install scripts blocked', () => {
      const probe = path.join(consumer, 'probe-native.mjs');
      writeFileText(probe, `
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        // better-sqlite3 is CommonJS: module.exports *is* the constructor, so
        // .default is undefined depending on the interop path taken.
        const mod = require('better-sqlite3');
        const Database = mod.default ?? mod;
        const sqliteVec = require('sqlite-vec');
        const db = new Database(':memory:');
        sqliteVec.load(db);
        const v = db.prepare('select vec_version() as v').get();
        if (!v || !v.v) throw new Error('vec_version() unavailable');
        process.stdout.write('vec_version=' + v.v + '\\n');
      `);
      const out = spawnSync(process.execPath, [probe], { cwd: consumer, encoding: 'utf8' });
      if (out.status !== 0) throw new Error(`exit ${out.status}: ${(out.stderr ?? '').slice(0, 200)}`);
      return out.stdout.trim();
    });

    check('the MCP server starts and lists its tools', () => {
      const probe = path.join(consumer, 'probe-mcp.mjs');
      writeFileText(probe, `
        import { Client } from '@modelcontextprotocol/sdk/client/index.js';
        import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
        import path from 'node:path';
        const entry = path.join(process.cwd(), 'node_modules', '${NAME}', 'dist', 'index.js');
        const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--root', process.cwd()], cwd: process.cwd(), stderr: 'ignore' });
        const client = new Client({ name: 'verify-package', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const { tools } = await client.listTools();
        await client.close();
        const names = tools.map((t) => t.name).sort();
        const expected = ${JSON.stringify([
          'anyindex_search', 'find_references', 'get_file_outline',
          'index_rebuild', 'index_status', 'index_update', 'ping',
        ].sort())};
        const missing = expected.filter((n) => !names.includes(n));
        if (missing.length > 0) throw new Error('missing tools: ' + missing.join(', '));
        process.stdout.write(names.length + ' tools: ' + names.join(', ') + '\\n');
      `);
      const out = spawnSync(process.execPath, [probe], {
        cwd: consumer,
        encoding: 'utf8',
        env: { ...process.env, NODE_PATH: path.join(consumer, 'node_modules') },
      });
      if (out.status !== 0) throw new Error(`exit ${out.status}: ${(out.stderr ?? '').slice(0, 300)}`);
      return out.stdout.trim();
    });
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;

// ------------------------------------------------------------------- utilities

function walkFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.bin') continue;
    const full = path.join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function existsIn2(p) {
  try { statSync(p); return true; } catch { return false; }
}

function writeJson(p, value) {
  writeFileText(p, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileText(p, text) {
  // LF, no BOM: the same rule the tarball check enforces, applied to the files
  // this script writes, so a failure above can never be its own cause.
  writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8');
}