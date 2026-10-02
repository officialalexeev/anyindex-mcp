import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig, type ServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { Embedder } from './embedder.js';
import { embedMissing, saveCounters } from './index-service.js';
import { indexRepository } from './indexer.js';
import { readIndexState } from './index-service.js';
import { searchChunks } from './search.js';
import { createLogger } from './logger.js';

const log = createLogger('benchmark');

interface Question {
  query: string;
  language: 'en' | 'ru';
  kind: 'semantic' | 'symbol' | 'negative';
  /** File that should be found. null for negative. */
  expectFile: string | null;
  note?: string;
}

const FIXTURE_FILES: Record<string, string> = {
  'src/auth/login.ts': `import { db } from '../db'
import { createSession } from './session'

export async function loginUser(email: string, password: string): Promise<Session> {
  const user = await db.users.findByEmail(email)
  if (user === null) throw new AuthError('USER_NOT_FOUND')
  if (!verifyPassword(password, user.passwordHash)) {
    throw new AuthError('WRONG_PASSWORD')
  }
  return createSession(user.id)
}
`,

  'src/auth/errors.ts': `export class AuthError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'AuthError'
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError
}
`,

  'src/session/token.ts': `import { randomBytes } from 'node:crypto'

const TTL_MS = 3_600_000

export function createSession(userId: string): Session {
  const token = randomBytes(32).toString('base64url')
  store.set(token, { userId, expiresAt: Date.now() + TTL_MS })
  return { token, expiresAt: Date.now() + TTL_MS }
}

export function revokeSession(token: string): boolean {
  return store.delete(token)
}
`,

  'src/ratelimit/bucket.ts': `export interface BucketOptions {
  maxRequests: number
  windowMs: number
}

export function createBucket(options: BucketOptions): Bucket {
  const hits = new Map<string, number[]>()
  return {
    take(key: string): boolean {
      const now = Date.now()
      const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs)
      if (recent.length >= options.maxRequests) {
        hits.set(key, recent)
        return false
      }
      recent.push(now)
      hits.set(key, recent)
      return true
    },
  }
}
`,

  'src/format/bytes.ts': `export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

export function formatDuration(ms: number): string {
  return Math.round(ms / 1000) + 's'
}
`,

  'src/queue/worker.ts': `export class Worker {
  private running = false

  constructor(private readonly handler: (task: Task) => Promise<void>) {}

  async start(): Promise<void> {
    this.running = true
    while (this.running) {
      const task = await queue.next()
      if (task === null) break
      await this.handler(task)
    }
  }

  stop(): void {
    this.running = false
  }
}
`,

  'src/cache/lru.ts': `export class LruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done !== true) this.entries.delete(oldest.value)
    }
    this.entries.set(key, value)
  }
}
`,

  'src/http/router.ts': `type Handler = (req: Request) => Response | Promise<Response>

export function createRouter(): Router {
  const routes = new Map<string, Handler>()
  return {
    get(pattern, handler) { routes.set('GET ' + pattern, handler) },
    async handle(req: Request): Promise<Response> {
      const handler = routes.get(req.method + ' ' + new URL(req.url).pathname)
      if (handler === undefined) return new Response('not found', { status: 404 })
      return handler(req)
    },
  }
}
`,

  'src/validate/schema.ts': `export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(field + ' must be a string, got ' + typeof value)
  }
  if (value.length === 0) {
    throw new ValidationError(field + ' must not be empty')
  }
  return value
}
`,

  'src/log/logger.ts': `export type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export function createLogger(minimum: Level = 'info') {
  const floor = ORDER[minimum]
  return (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < floor) return
    process.stderr.write(JSON.stringify({ level, message, ...fields }) + '\n')
  }
}
`,

  'src/retry/backoff.ts': `export function backoffDelay(attempt: number, baseMs = 100, capMs = 30_000): number {
  const exponential = baseMs * 2 ** attempt
  const jitter = Math.random() * baseMs
  return Math.min(exponential + jitter, capMs)
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, backoffDelay(i)))
    }
  }
  throw lastError
}
`,

  'src/db/migrate.ts': `export interface Migration {
  version: number
  up: (db: Connection) => void
  down: (db: Connection) => void
}

export function applyPending(db: Connection, migrations: Migration[], current: number): number {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  let applied = current
  for (const migration of sorted) {
    if (migration.version <= current) continue
    db.transaction(() => migration.up(db))
    applied = migration.version
  }
  return applied
}
`,

  'src/parse/csv.ts': `export function parseCsvLine(line: string, separator = ','): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1 } else { quoted = !quoted }
    } else if (char === separator && !quoted) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current)
  return fields
}
`,

  'src/config/env.ts': `export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error('missing required environment variable: ' + name)
  }
  return value
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}
`,

  'src/queue/priority.ts': `export interface QueueItem<T> {
  value: T
  priority: number
  sequence: number
}

export class PriorityQueue<T> {
  private items: QueueItem<T>[] = []
  private sequence = 0

  push(value: T, priority: number): void {
    this.sequence += 1
    this.items.push({ value, priority, sequence: this.sequence })
    this.items.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence)
  }

  shift(): T | undefined {
    return this.items.shift()?.value
  }

  get size(): number { return this.items.length }
}
`,

  'docs/operations.md': `# Operations

Rate limiting is handled by ratelimit/bucket.ts, keyed by API token. The bucket
keeps a sliding window of timestamps per key and rejects once the window is full.

The worker in queue/worker.ts consumes tasks from the queue in priority order.
Tasks that fail are retried with exponential backoff and jitter, see
retry/backoff.ts for the delay schedule.

Configuration is read through config/env.ts. Required variables are validated on
startup so a missing secret fails immediately rather than at first request.
`,

  'docs/architecture.md': `# Architecture

The service is split into four modules: auth, session, ratelimit and queue.

Requests enter through the HTTP layer, which validates the rate limit bucket
before handing work to the worker queue. Authentication lives in auth/login.ts
and issues a session token; the token is validated on every subsequent call.

Session tokens expire after one hour. Expired tokens are removed lazily when a
request presents them.
`,
};

const QUESTIONS: Question[] = [
  // English, semantics
  { query: 'user signs in with email and password', language: 'en', kind: 'semantic', expectFile: 'src/auth/login.ts' },
  { query: 'creating a session token with random bytes', language: 'en', kind: 'semantic', expectFile: 'src/session/token.ts' },
  { query: 'limiting requests per key in a time window', language: 'en', kind: 'semantic', expectFile: 'src/ratelimit/bucket.ts' },
  { query: 'human readable file size formatting', language: 'en', kind: 'semantic', expectFile: 'src/format/bytes.ts' },
  { query: 'background loop that consumes tasks from a queue', language: 'en', kind: 'semantic', expectFile: 'src/queue/worker.ts' },

  // Russian, same semantics
  { query: 'вход пользователя по email и паролю', language: 'ru', kind: 'semantic', expectFile: 'src/auth/login.ts' },
  { query: 'создание токена сессии', language: 'ru', kind: 'semantic', expectFile: 'src/session/token.ts' },
  { query: 'ограничение количества запросов по ключу', language: 'ru', kind: 'semantic', expectFile: 'src/ratelimit/bucket.ts' },
  { query: 'форматирование размера файла в килобайты', language: 'ru', kind: 'semantic', expectFile: 'src/format/bytes.ts' },
  { query: 'обработка задач из очереди в фоне', language: 'ru', kind: 'semantic', expectFile: 'src/queue/worker.ts' },

  // Exact symbols — lexical path
  { query: 'verifyPassword', language: 'en', kind: 'symbol', expectFile: 'src/auth/login.ts' },
  { query: 'isAuthError', language: 'en', kind: 'symbol', expectFile: 'src/auth/errors.ts' },
  { query: 'revokeSession', language: 'en', kind: 'symbol', expectFile: 'src/session/token.ts' },
  { query: 'createBucket', language: 'en', kind: 'symbol', expectFile: 'src/ratelimit/bucket.ts' },

  // Distractors: on a larger corpus the topic is adjacent, the answer is not
  { query: 'cache with least recently used eviction', language: 'en', kind: 'semantic', expectFile: 'src/cache/lru.ts' },
  { query: 'reading a required environment variable', language: 'en', kind: 'semantic', expectFile: 'src/config/env.ts' },
  { query: 'exponential backoff with jitter between retries', language: 'en', kind: 'semantic', expectFile: 'src/retry/backoff.ts' },
  { query: 'priority ordering when several tasks are queued', language: 'en', kind: 'semantic', expectFile: 'src/queue/priority.ts' },
  { query: 'throwing when a required value has the wrong type', language: 'en', kind: 'semantic', expectFile: 'src/validate/schema.ts' },
  { query: 'кэш с вытесением наименее недавно использованного', language: 'ru', kind: 'semantic', expectFile: 'src/cache/lru.ts' },
  { query: 'повтор попытки с увеличивающейся задержкой', language: 'ru', kind: 'semantic', expectFile: 'src/retry/backoff.ts' },
  { query: 'разбор строки csv с кавычками', language: 'ru', kind: 'semantic', expectFile: 'src/parse/csv.ts' },
  { query: 'маршрутизация запросов по шаблону пути', language: 'ru', kind: 'semantic', expectFile: 'src/http/router.ts' },
  { query: 'чтение обязательной переменной окружения', language: 'ru', kind: 'semantic', expectFile: 'src/config/env.ts' },

  // Negative: no such code exists in the repository
  { query: 'react component rendering a table', language: 'en', kind: 'negative', expectFile: null },
  { query: 'настройка postgresql и миграции схемы', language: 'ru', kind: 'negative', expectFile: null },
  { query: 'grpc service implementation with protobuf definitions', language: 'en', kind: 'negative', expectFile: null },
];

interface Outcome {
  question: Question;
  files: string[];
  distance: number | null;
  /** Gap between the first and the third position: how clearly the leader stands out. */
  margin: number | null;
  confidence: string;
  rank: number | null;
  top1: boolean;
  top5: boolean;
  negativeOk: boolean;
}

async function buildFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aidx-bench-'));
  for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  }
  return root;
}

async function evaluate(
  root: string,
  config: ServerConfig,
  options: Partial<BenchmarkOptions> = {},
): Promise<Outcome[]> {
  const documentPrefix = options.documentPrefix ?? '';
  const queryPrefix = options.queryPrefix ?? '';
  const textPass = await indexRepository(config);
  const { db } = openDatabase(config.dbPath);
  const embedder = new Embedder(config);

  try {
    // Asymmetric models need a different prefix for the document and the query,
    // so document vectors are built here rather than through embedMissing.
    const withPrefix = (texts: string[], prefix: string): string[] =>
      prefix === '' ? texts : texts.map((t) => `${prefix}${t}`);

    const chunkRows = db.prepare('SELECT id, context, content_hash, language FROM chunks ORDER BY id').all() as Array<{
      id: number; context: string; content_hash: string; language: string;
    }>;
    const docVectors = await embedder.embedBatched(withPrefix(chunkRows.map((r) => r.context), documentPrefix));
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?, ?, ?, ?)',
    );
    const writeVectors = db.transaction(() => {
      for (let i = 0; i < chunkRows.length; i += 1) {
        const row = chunkRows[i];
        const vector = docVectors[i];
        if (row === undefined || vector === undefined) continue;
        upsert.run(BigInt(row.id), Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), row.language, row.context);
      }
    });
    writeVectors();

    const embedResult = { embedded: chunkRows.length, reused: 0, failed: 0, total: chunkRows.length };

    const stored = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    saveCounters(db, {
      chunks: stored.n,
      skipped: textPass.failedFiles,
      embedded: embedResult.embedded,
      reused: embedResult.reused,
    });

    log.info('fixture indexed', {
      files: Object.keys(FIXTURE_FILES).length,
      chunks: textPass.chunksWritten,
      ast: textPass.astChunks,
      fallback: textPass.fallbackChunks,
      embedded: embedResult.embedded,
    });

    const results: Outcome[] = [];

    for (const question of QUESTIONS) {
      const vector = (await embedder.embed(withPrefix([question.query], queryPrefix)))[0] ?? null;
      const outcome = searchChunks(db, question.query, vector, 5, 'hybrid');
      const files = outcome.hits.map((h) => h.filePath);
      const rank = question.expectFile === null ? null : files.indexOf(question.expectFile);

      const d0 = outcome.hits[0]?.distance ?? null;
      const d2 = outcome.hits[2]?.distance ?? null;
      results.push({
        question,
        files,
        distance: d0,
        margin: d0 === null || d2 === null ? null : Number((d0 - d2).toFixed(3)),
        confidence: outcome.hits[0]?.confidence ?? 'none',
        rank: rank === -1 ? null : rank,
        top1: rank === 0,
        top5: rank !== null && rank < 5,
        // For a negative query it is acceptable either to find nothing or to have
        // every match marked weak: in the second case the model gets an explicit
        // warning and will re-check the result.
        negativeOk: question.kind !== 'negative' || outcome.hits.every((h) => h.confidence === 'weak'),
      });
    }

    return results;
  } finally {
    await embedder.close();
    db.close();
  }
}

function report(results: Outcome[], config: ServerConfig, options: Partial<BenchmarkOptions> = {}): void {
  const byLang = (lang: Question['language']) => results.filter((r) => r.question.language === lang && r.question.kind !== 'negative');
  const negatives = results.filter((r) => r.question.kind === 'negative');

  const line = (label: string, items: Outcome[]): void => {
    if (items.length === 0) return;
    const top1 = items.filter((r) => r.top1).length;
    const top5 = items.filter((r) => r.top5).length;
    process.stderr.write(`  ${label.padEnd(22)} top1 ${top1}/${items.length}   top5 ${top5}/${items.length}\n`);
  };

  process.stderr.write(
    `\n=== Search quality: ${config.model} (${config.dtype}, ${config.dimension}d` +
      `${options.queryPrefix === undefined ? '' : `, q="${options.queryPrefix}"`}) ===\n`,
  );
  line('english', byLang('en'));
  line('russian', byLang('ru'));
  line('exact symbols', results.filter((r) => r.question.kind === 'symbol'));

  const pos = results.filter((r) => r.question.kind !== 'negative');
  const top1 = pos.filter((r) => r.top1).length;
  const top5 = pos.filter((r) => r.top5).length;
  const negOk = negatives.filter((r) => r.negativeOk).length;

  // The separation figure does not depend on threshold calibration: it compares
  // the worst positive case with the best negative one. The wider the gap, the
  // more reliably the model tells relevant from irrelevant.
  const posDistances = pos.map((r) => r.distance).filter((d): d is number => d !== null);
  const negDistances = negatives.map((r) => r.distance).filter((d): d is number => d !== null);
  const worstPositive = posDistances.length > 0 ? Math.max(...posDistances) : null;
  const bestNegative = negDistances.length > 0 ? Math.min(...negDistances) : null;
  const gap = worstPositive !== null && bestNegative !== null ? bestNegative - worstPositive : null;

  process.stderr.write(
    `\n  separation: worst positive ${worstPositive?.toFixed(3) ?? '-'} vs best negative ${bestNegative?.toFixed(3) ?? '-'}` +
      `  →  gap ${gap === null ? '-' : gap.toFixed(3)}${gap !== null && gap > 0 ? '  (threshold possible)' : '  (threshold impossible)'}\n`,
  );

  process.stderr.write(
    `  ${'TOTAL (positive)'.padEnd(22)} top1 ${top1}/${pos.length}   top5 ${top5}/${pos.length}\n`,
  );
  process.stderr.write(`  ${'negatives filtered'.padEnd(22)} ${negOk}/${negatives.length}\n`);

  process.stderr.write('\n=== Per query ===\n');
  for (const r of results) {
    const mark = r.question.kind === 'negative' ? (r.negativeOk ? ' ok ' : ' !! ') : r.top1 ? ' ok ' : r.top5 ? ' ~  ' : ' !! ';
    const pos = r.rank === null ? '-' : `#${r.rank + 1}`;
    const dist = r.distance === null ? '  -   ' : r.distance.toFixed(3);
    const marg = r.margin === null ? '  -  ' : r.margin.toFixed(3);
    process.stderr.write(
      `${mark} [${r.question.language}] ${r.question.kind.padEnd(8)} d=${dist} margin=${marg} ${r.confidence.padEnd(8)} ${pos.padEnd(4)} ${r.question.query}\n`,
    );
  }

  const state = readIndexState(config);
  process.stderr.write(
    `\nindex: ${state.files} files, ${state.chunks} chunks, AST ${state.astChunks}, fallback ${state.fallbackChunks}, vectors ${state.embedded}\n`,
  );
}

export interface BenchmarkOptions {
  model: string;
  dtype: string;
  dimension: number;
  /** Asymmetric learning prefixes: query and document are encoded differently. */
  queryPrefix?: string;
  documentPrefix?: string;
}

export async function runBenchmark(options: Partial<BenchmarkOptions> = {}): Promise<void> {
  const root = await buildFixture();
  const config = loadConfig({
    root,
    model: options.model ?? 'jinaai/jina-embeddings-v2-base-code',
    dtype: (options.dtype ?? 'q8') as never,
    dimension: options.dimension ?? 768,
  });

  try {
    const results = await evaluate(root, config, options);
    report(results, config, options);

    const positive = results.filter((r) => r.question.kind !== 'negative');
    const top5 = positive.filter((r) => r.top5).length;
    const top1 = positive.filter((r) => r.top1).length;

    process.stderr.write(`\nstage 6 acceptance threshold: top5 >= ${Math.ceil(positive.length * 0.75)} of ${positive.length}\n`);
    process.stderr.write(`actual: top5 = ${top5}, top1 = ${top1}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function argOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

if (process.argv[1]?.endsWith('benchmark.js')) {
  const model = argOf('--model') ?? 'jinaai/jina-embeddings-v2-base-code';
  const dimension = Number(argOf('--dimension') ?? (model.includes('MiniLM') || model.includes('e5-small') || model.includes('xsmall') ? 384 : 768));
  await runBenchmark({
    model,
    dtype: argOf('--dtype') ?? 'q8',
    dimension,
    queryPrefix: argOf('--query-prefix'),
    documentPrefix: argOf('--doc-prefix'),
  });
}
