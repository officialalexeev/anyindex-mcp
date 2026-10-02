import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
  blocking: boolean;
}

const results: CheckResult[] = [];

// Written straight to stderr rather than through the logger: ANYINDEX_LOG_LEVEL
// controls the server's diagnostics, and a probe run under `error` would then
// print its summary without saying which check failed — the one thing the command
// exists to report.
function record(name: string, status: CheckResult['status'], detail: string, blocking = false): void {
  results.push({ name, status, detail, blocking });
  const marker = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  process.stderr.write(`${marker}  ${name}: ${detail}\n`);
}

async function checkNodeVersion(): Promise<void> {
  const parts = process.versions.node.split('.').map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const ok = (major === 22 && minor >= 19) || major >= 24;
  record('node version', ok ? 'pass' : 'fail', `${process.version}${ok ? '' : ' — requires ^22.19.0 || >=24.0.0'}`, true);
}

async function checkSqliteStack(): Promise<void> {
  try {
    const [{ default: Database }, sqliteVec] = await Promise.all([
      import('better-sqlite3'),
      import('sqlite-vec'),
    ]);

    const db = new Database(':memory:');
    sqliteVec.load(db);
    const row = db.prepare('select vec_version() as v').get() as { v: string } | undefined;

    if (row?.v === undefined || row.v === null) {
      record('sqlite-vec', 'fail', 'extension loaded but vec_version() is unavailable', true);
      return;
    }

    db.exec('CREATE VIRTUAL TABLE t USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[4], language TEXT, +ctx TEXT)');
    const toVec = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
    const insert = db.prepare('INSERT INTO t(chunk_id, embedding, language, ctx) VALUES (?, ?, ?, ?)');

    insert.run(BigInt(1), toVec([1, 0, 0, 0]), 'ts', 'alpha');
    insert.run(BigInt(2), toVec([0, 1, 0, 0]), 'py', 'beta');

    const probe = toVec([1, 0, 0, 0]);
    const plain = db.prepare('SELECT chunk_id, distance, ctx FROM t WHERE embedding MATCH ? AND k = 5').all(probe) as Array<{ chunk_id: number }>;
    const filtered = db.prepare('SELECT chunk_id FROM t WHERE embedding MATCH ? AND k = 5 AND language = ?').all(probe, 'ts') as Array<{ chunk_id: number }>;
    const noMatch = db.prepare('SELECT chunk_id FROM t WHERE embedding MATCH ? AND k = 5 AND language = ?').all(probe, 'go') as Array<{ chunk_id: number }>;

    const ok = plain.length === 2 && plain[0]?.chunk_id === 1 && filtered.length === 1 && noMatch.length === 0;
    record(
      'sqlite-vec',
      ok ? 'pass' : 'fail',
      `vec_version=${row.v}; KNN=${plain.length}, metadata filter=${filtered.length}, empty=${noMatch.length}; ids must be BigInt (better-sqlite3 binds a JS number as REAL, which vec0 rejects)`,
      true,
    );
    db.close();
  } catch (error) {
    record('sqlite-vec', 'fail', describe(error), true);
  }
}

async function checkChunker(): Promise<void> {
  try {
    const mod = await import('code-chunk');
    const source = ['import { db } from "./db"', 'class UserService {', '  async getUser(id: string) {', '    return db.query(id)', '  }', '}', 'export function helper() { return 1 }'].join('\n');

    const chunks = await mod.chunk('probe.ts', source);
    const names = chunks.flatMap((c: { context: { entities: ReadonlyArray<{ name: string }> } }) =>
      c.context.entities.map((e) => e.name));
    const contextualized = chunks.every(
      (c: { contextualizedText: string }) => typeof c.contextualizedText === 'string' && c.contextualizedText.length > 0,
    );
    const astWorked = names.includes('UserService') && names.includes('getUser');

    record('code-chunk (native)', astWorked && contextualized ? 'pass' : 'fail',
      `chunks=${chunks.length}, entities=[${names.join(',')}], contextualizedText=${contextualized}`, true);
  } catch (error) {
    record('code-chunk (native)', 'fail', describe(error), true);
  }

  try {
    const wasm = await import('code-chunk/wasm');
    const hasChunk = typeof (wasm as Record<string, unknown>).chunk === 'function';
    record('code-chunk (wasm)', hasChunk ? 'pass' : 'warn',
      hasChunk ? 'WASM API matches native' : 'WASM API differs (createWasmParser), the binary needs manual configuration — see R1', false);
  } catch (error) {
    record('code-chunk (wasm)', 'warn', describe(error), false);
  }
}

async function checkEmbeddings(): Promise<void> {
  const config = loadConfig();
  try {
    const { ModelRegistry, env, pipeline } = await import('@huggingface/transformers');

    mkdirSync(config.modelsDir, { recursive: true });
    env.cacheDir = config.modelsDir;

    const dtypes = await ModelRegistry.get_available_dtypes(config.model);
    if (!dtypes.includes(config.dtype)) {
      record('embeddings: dtype', 'fail', `${config.dtype} is unavailable for ${config.model}; available: [${dtypes.join(',')}]`, true);
      return;
    }
    record('embeddings: dtype', 'pass', `${config.model} → [${dtypes.join(',')}]`, false);

    const started = Date.now();
    const extractor = await pipeline('feature-extraction', config.model, { dtype: config.dtype });
    const loadMs = Date.now() - started;

    const out = await extractor(['export function login(u: string) { return db.find(u) }'], {
      pooling: 'mean',
      normalize: true,
    });
    const dims = out.dims as number[];

    const correct = dims.length === 2 && dims[1] === config.dimension;
    record('embeddings: run', correct ? 'pass' : 'fail',
      `dims=[${dims.join(',')}], expected [,${config.dimension}], load ${loadMs}ms`, true);

    // Measuring on synthetic short lines gave 48 ms/chunk and was orders of
    // magnitude too optimistic: transformers.js pads a batch to its longest
    // string and attention is quadratic in length. So the measurement uses
    // texts of a realistic size.
    const realistic = Array.from({ length: 8 }, (_, i) =>
      [
        `# src/services/module${i}.ts`,
        '# Scope: Service' + i,
        '# Defines: async execute(input: string): Promise<Result>',
        '',
        'export class Service' + i + ' {',
        '  constructor(private readonly db: Database, private readonly log: Logger) {}',
        '  async execute(input: string): Promise<Result> {',
        '    const parsed = this.parser.parse(input)',
        '    if (!parsed.ok) throw new ValidationError(parsed.reason)',
        '    const rows = await this.db.query(parsed.value)',
        '    return this.mapper.toResult(rows, this.log.correlationId)',
        '  }',
        '}',
      ].join('\n'),
    );
    const realisticChars = realistic.reduce((sum, t) => sum + t.length, 0);

    const embedStarted = Date.now();
    await extractor(realistic, { pooling: 'mean', normalize: true });
    const perChunk = (Date.now() - embedStarted) / realistic.length;
    const cores = (await import('node:os')).cpus().length;

    record('embeddings: throughput', 'pass',
      `${perChunk.toFixed(0)} ms/chunk on realistic chunks of ~${Math.round(realisticChars / realistic.length)} chars, ` +
      `${cores} core(s) → 10k chunks ≈ ${Math.round(perChunk * 10000 / 60000)} min`, false);

    record('embeddings: cache', 'pass',
      `env.cacheDir=${config.modelsDir} (shared by every project; override with --models or ANYINDEX_MODELS)`, false);
  } catch (error) {
    record('embeddings', 'fail', describe(error), true);
  }
}

async function checkWatcherDeps(): Promise<void> {
  for (const name of ['fast-glob', 'ignore', 'chokidar'] as const) {
    try {
      await import(name);
      record(`dep: ${name}`, 'pass', 'import succeeded', false);
    } catch (error) {
      record(`dep: ${name}`, 'fail', describe(error), true);
    }
  }
}

async function checkHardware(): Promise<void> {
  const os = await import('node:os');
  const cores = os.cpus().length;
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);

  record('hardware: cores', cores >= 4 ? 'pass' : 'warn',
    `${cores} cores — ${cores >= 4 ? 'acceptable' : 'below the comfortable threshold (4)'}. ` +
    'Embedding speed grows almost linearly with the core count, so on a single core ' +
    'a full index of a large repository takes hours.', false);

  record('hardware: memory', totalMb >= 4096 ? 'pass' : 'warn',
    `${totalMb} MB — ${totalMb >= 4096 ? 'enough' : 'too little: the model takes ~160 MB, and by default the index and the model cache live in the process memory'}`, false);
}

async function checkStorageWritability(): Promise<void> {
  try {
    const dir = path.join(tmpdir(), `anyindex-probe-${createHash('sha1').update(String(process.pid)).digest('hex').slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    record('storage writable', 'pass', dir, false);
  } catch (error) {
    record('storage writable', 'fail', describe(error), true);
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function main(): Promise<void> {
  process.stderr.write(`node=${process.version} platform=${process.platform}-${process.arch}\n`);

  await checkNodeVersion();
  await checkHardware();
  await checkStorageWritability();
  await checkSqliteStack();
  await checkChunker();
  await checkWatcherDeps();
  await checkEmbeddings();

  const blocking = results.filter((r) => r.status === 'fail' && r.blocking);
  const warnings = results.filter((r) => r.status === 'warn');

  process.stderr.write('\n--- summary ---\n');
  process.stderr.write(`pass: ${results.filter((r) => r.status === 'pass').length}, warn: ${warnings.length}, fail: ${results.filter((r) => r.status === 'fail').length}\n`);

  for (const w of warnings) process.stderr.write(`WARN  ${w.name}: ${w.detail}\n`);

  if (blocking.length > 0) {
    process.stderr.write('\nBLOCKING FAILURES — re-evaluate the stack before writing code:\n');
    for (const b of blocking) process.stderr.write(`  - ${b.name}: ${b.detail}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write('\nAll blocking checks passed. Next: anyindex-mcp reindex --root <path>\n');
}

await main();