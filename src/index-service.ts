import path from 'node:path';

import { openDatabase, readMeta, type DatabaseHandle } from './db.js';
import { nonCodeLanguages, type ServerConfig } from './config.js';
import type { Embedder } from './embedder.js';
import { emptyBaseStats, type BaseStats, type IndexStats } from './stats.js';
import { createLogger } from './logger.js';
import { jobState } from './job.js';

const log = createLogger('index-service');

export interface EmbedOutcome {
  embedded: number;
  reused: number;
  failed: number;
  total: number;
}

/**
 * The chunking strategy counters are read from the table, not from meta: meta held
 * the result of the last run, which an incremental run with no changes reset to
 * zero. Chunks cut before the strategy migration are marked 'unknown' and land
 * in no counter at all — those need a rebuild.
 *
 * Fallback splits into two, because the two mean opposite things. Markdown, json,
 * yaml and toml have no tree-sitter grammar, so the chunker takes the structural
 * path on purpose and the counter would otherwise drown the one number that
 * matters: a fallback on a language a grammar exists for is a parser that failed,
 * and ADR-010 exists to make that visible.
 */
function countStrategies(db: DatabaseHandle): { ast: number; nonCode: number; failed: number } {
  const rows = db
    .prepare("SELECT strategy, language, COUNT(*) AS n FROM chunks WHERE strategy IN ('ast', 'fallback') GROUP BY strategy, language")
    .all() as Array<{ strategy: string; language: string; n: number }>;

  let ast = 0;
  let nonCode = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.strategy === 'ast') ast += row.n;
    else if (nonCodeLanguages.includes(row.language)) nonCode += row.n;
    else failed += row.n;
  }
  return { ast, nonCode, failed };
}

function withJob(stats: BaseStats): IndexStats {
  const job = jobState();
  return {
    ...stats,
    running: job.running,
    phase: job.phase,
    progress: { done: job.done, total: job.total },
  };
}

/**
 * Index readiness check. Any mismatch is returned as degraded with a reason instead
 * of being fixed quietly: vectors of different dimensions inside one vec0 compare
 * incorrectly, and the only way to notice is to look at the results.
 *
 * `pendingChanges` is the number of files whose changes have been detected but not
 * indexed yet. Without a running watcher this is zero NOT because the index is
 * fresh, but because nobody looked at the changes at all. The field is therefore read
 * as "known unprocessed changes", not as staleness.
 */
export function readIndexState(config: ServerConfig, pendingChanges = 0): IndexStats {
  const empty = (reason: string, vecVersion = '', degraded = true): IndexStats =>
    withJob(emptyBaseStats(reason, vecVersion === '' ? null : vecVersion, degraded));

  let db: DatabaseHandle;
  try {
    db = openDatabase(config.dbPath).db;
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }

  try {
    const vecTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'`)
      .get();
    const vecVersion = readMeta(db, 'vec_version') ?? '';

    if (vecTable === undefined) {
      // Nothing has been indexed yet, which is a state and not a fault.
      return empty('vector table is missing — index was never built', vecVersion, false);
    }

    const storedDimension = readMeta(db, 'dimension');
    if (storedDimension !== null && Number(storedDimension) !== config.dimension) {
      return empty(
        `dimension in the index (${storedDimension}) does not match the setting (${config.dimension}) — index_rebuild required`,
        vecVersion,
      );
    }

    // Every stored path is relative to the anchor the index was built with. Read
    // under a different one, "src/api/login.js" points at another file, and the
    // mismatch would not show up as an error anywhere.
    const storedIndexRoot = readMeta(db, 'index_root');
    if (storedIndexRoot !== null && path.resolve(storedIndexRoot) !== config.indexRoot) {
      return empty(
        `index was built with paths relative to ${storedIndexRoot}, but this run resolves them against ${config.indexRoot} — index_rebuild required`,
        vecVersion,
      );
    }

    const storedModel = readMeta(db, 'model_id');
    if (storedModel !== null && storedModel !== config.model) {
      return empty(
        `model in the index (${storedModel}) differs from the configured one (${config.model}) — index_rebuild required`,
        vecVersion,
      );
    }

    // Quantization changes the values in a vector but not its length: the same model
    // and the same dimension would pass the checks above, and the vec0 table would
    // end up mixing q8 and fp32 vectors. The results do not look broken — they are
    // just quietly worse, so the mismatch is rejected right here.
    const storedDtype = readMeta(db, 'dtype');
    if (storedDtype !== null && storedDtype !== config.dtype) {
      return empty(
        `quantization in the index (${storedDtype}) differs from the configured one (${config.dtype}) — index_rebuild required`,
        vecVersion,
      );
    }

    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    const files = db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number };
    const vectors = db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number };
    const strategies = countStrategies(db);

    // An unfinished index is broken too. A check for "no vectors at all" let through the
    // state where vectors exist for half the chunks: search over such data answers
    // in a way that looks correct but silently loses part of the corpus, so such an
    // index must not be declared ready.
    if (chunks.n > 0 && vectors.n < chunks.n) {
      return withJob({
        ready: false,
        degraded: true,
        files: files.n,
        chunks: chunks.n,
        stale: 0,
        skipped: Number(readMeta(db, 'skipped_files') ?? '0'),
astChunks: strategies.ast,
      fallbackChunks: strategies.nonCode + strategies.failed,
      nonCodeChunks: strategies.nonCode,
      embedded: vectors.n,
      reused: 0,
        lastUpdated: null,
        vecVersion,
        reason:
          vectors.n === 0
            ? 'vectors were not built — run index_update'
            : `vectors were built for only some chunks (${vectors.n} of ${chunks.n}) — indexing was interrupted, run index_update`,
      });
    }

    const lastIndexed = readMeta(db, 'last_indexed_at');

    return withJob({
      ready: chunks.n > 0 && vectors.n === chunks.n,
      degraded: false,
      files: files.n,
      chunks: chunks.n,
      stale: pendingChanges,
      skipped: Number(readMeta(db, 'skipped_files') ?? '0'),
      astChunks: strategies.ast,
      fallbackChunks: strategies.nonCode + strategies.failed,
      nonCodeChunks: strategies.nonCode,
      // vectors.n, not meta.embedded_total: that key holds the result of the LAST
      // pass, not the state of the index. An incremental run with no changes
      // computes no vectors at all, so the status used to report "vectors: 0" on an
      // index where every vector was in place. The same mistake would have come back
      // in the degraded branch, where the counter was already taken from vectors.n —
      // one field meaning two different things in two branches of one function.
      embedded: vectors.n,
      reused: Number(readMeta(db, 'reused_total') ?? '0'),
      lastUpdated: lastIndexed === null ? null : new Date(Number(lastIndexed)).toISOString(),
      vecVersion,
    });
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  } finally {
    db.close();
  }
}

export function saveCounters(
  db: DatabaseHandle,
  counters: {
    chunks: number;
    skipped: number;
    embedded: number;
    reused: number;
  },
): void {
  const put = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  put.run('last_indexed_at', String(Date.now()));
  put.run('chunks_total', String(counters.chunks));
  put.run('skipped_files', String(counters.skipped));
  put.run('embedded_total', String(counters.embedded));
  put.run('reused_total', String(counters.reused));
}

interface ChunkRow {
  id: number;
  context: string;
  content_hash: string;
  language: string;
}

/**
 * Attaches vectors to already stored chunks. Kept apart from text indexing:
 * embedding is the most expensive stage and has to be restartable without rebuilding
 * the chunks.
 *
 * Incrementality keyed on `content_hash` (ADR-005): if the index already holds an
 * embedded chunk with the same text hash, the vector is copied from it without
 * calling the model. The saving is most visible when a single file is edited —
 * neighbouring chunks are not recomputed.
 */
export async function embedMissing(
  db: DatabaseHandle,
  config: ServerConfig,
  embedder: Embedder,
  options: { rebuild?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<EmbedOutcome> {
  const rows = db
    .prepare('SELECT id, context, content_hash, language FROM chunks ORDER BY id')
    .all() as ChunkRow[];

  const embedded = new Map<number, { embedding: Buffer; context: string }>();
  for (const row of db.prepare('SELECT chunk_id AS id, embedding, context FROM chunks_vec').all() as Array<{
    id: number;
    embedding: Buffer;
    context: string;
  }>) {
    embedded.set(row.id, { embedding: row.embedding, context: row.context });
  }

  // Donor by hash: the first already embedded chunk with that text.
  const donorByHash = new Map<string, { id: number; embedding: Buffer }>();
  for (const row of rows) {
    const vector = embedded.get(row.id);
    if (vector === undefined) continue;
    if (!donorByHash.has(row.content_hash)) {
      donorByHash.set(row.content_hash, { id: row.id, embedding: vector.embedding });
    }
  }

  const missing = rows.filter((row) => options.rebuild === true || !embedded.has(row.id));
  const copied: ChunkRow[] = [];
  const toCompute: ChunkRow[] = [];

  for (const row of missing) {
    const donor = donorByHash.get(row.content_hash);
    if (donor !== undefined) copied.push(row);
    else toCompute.push(row);
  }

  log.info('embedding plan', {
    total: rows.length,
    compute: toCompute.length,
    copyByHash: copied.length,
    alreadyEmbedded: rows.length - missing.length,
  });

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding, language, context) VALUES (?, ?, ?, ?) ',
  );

  let written = 0;
  let failed = 0;
  let reused = rows.length - missing.length;

  const copyBatch = db.transaction(() => {
    for (const row of copied) {
      const donor = donorByHash.get(row.content_hash);
      if (donor === undefined) continue;
      upsert.run(BigInt(row.id), donor.embedding, row.language, row.context);
      written += 1;
      reused += 1;
    }
  });

  if (copied.length > 0) {
    try {
      copyBatch();
    } catch (error) {
      failed += copied.length;
      log.warn('hash copy failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Sorting by length is mandatory: transformers.js pads every item in the batch to
  // the longest string, and self-attention is quadratic in length. Without it a batch
  // with one long markdown chunk also slows down the short ones.
  // Measured on one core: 16 short — 350 ms/chunk, 16 mixed — 4200 ms.
  const ordered = [...toCompute].sort((a, b) => a.context.length - b.context.length);

  // Embedding and writing alternate batch by batch instead of "compute everything,
  // then write everything": otherwise progress stays at zero until the longest stage
  // is over, and memory grows by a full corpus of vectors.
  for (let start = 0; start < ordered.length; start += config.batchSize) {
    const batch = ordered.slice(start, Math.min(start + config.batchSize, ordered.length));
    const vectors = await embedder.embed(batch.map((row) => row.context));

    const write = db.transaction(() => {
      for (let offset = 0; offset < batch.length; offset += 1) {
        const row = batch[offset];
        const vector = vectors[offset];
        if (row === undefined || vector === undefined) continue;
        upsert.run(
          BigInt(row.id),
          Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
          row.language,
          row.context,
        );
        written += 1;
      }
    });

    try {
      write();
    } catch (error) {
      failed += batch.length;
      log.warn('batch write failed', { start, error: error instanceof Error ? error.message : String(error) });
    }

    options.onProgress?.(Math.min(start + config.batchSize, ordered.length), ordered.length);
  }

  return { embedded: written, reused, failed, total: rows.length };
}
