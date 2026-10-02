import {
  countChunks,
  createVectorTable,
  deleteChunksForFile,
  dropVectorTable,
  openDatabase,
  readMeta,
  vectorTableExists,
  writeMeta,
  type DatabaseHandle,
} from './db.js';
import { chunkFile, type RawChunk } from './chunker.js';
import { readIndexable, scanRepository, sha1 } from './scanner.js';
import type { ServerConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('indexer');

export interface IndexDelta {
  filePath: string;
  chunks: number;
  strategy: 'ast' | 'fallback';
  removed: number;
}

export interface IndexRunResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  chunksWritten: number;
  chunksRemoved: number;
  astChunks: number;
  fallbackChunks: number;
  failedFiles: number;
  durationMs: number;
}

interface FileRow {
  path: string;
  mtime_ms: number;
  size: number;
  content_hash: string;
  chunk_count: number;
}

const insertChunk = (db: DatabaseHandle) =>
  db.prepare(`
    INSERT INTO chunks (file_path, line_start, line_end, entity_name, language,
                       scope_chain, imports, text, context, content_hash, entities, strategy)
    VALUES (@filePath, @lineStart, @lineEnd, @entityName, @language,
            @scopeChain, @imports, @text, @context, @contentHash, @entities, @strategy)
  `);

const upsertFile = (db: DatabaseHandle) =>
  db.prepare(`
    INSERT INTO files (path, mtime_ms, size, content_hash, chunk_count, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size = excluded.size,
      content_hash = excluded.content_hash,
      chunk_count = excluded.chunk_count,
      indexed_at = excluded.indexed_at
  `);

export function writeFileChunks(db: DatabaseHandle, relPath: string, chunks: RawChunk[]): number {
  const insert = insertChunk(db);

  const replace = db.transaction(() => {
    for (const chunk of chunks) {
      insert.run({
        filePath: relPath,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        entityName: chunk.entityName,
        language: chunk.language,
        scopeChain: JSON.stringify(chunk.scopeChain),
        imports: JSON.stringify(chunk.imports),
        text: chunk.text,
        context: chunk.contextualizedText,
        contentHash: chunk.contentHash,
        entities: JSON.stringify(chunk.entities),
        strategy: chunk.source,
      });
    }
  });

  replace();
  return chunks.length;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export async function indexFile(
  db: DatabaseHandle,
  config: ServerConfig,
  relPath: string,
  content: string,
  stats: FileStat,
): Promise<IndexDelta> {
  const { chunks, strategy } = await chunkFile(relPath, content, config.chunkSizeBytes);
  const removed = deleteChunksForFile(db, relPath);
  const written = writeFileChunks(db, relPath, chunks);

  upsertFile(db).run(relPath, stats.mtimeMs, stats.size, sha1(content), written, Date.now());

  return { filePath: relPath, chunks: written, strategy, removed };
}

export function removeFile(db: DatabaseHandle, relPath: string): number {
  const removed = deleteChunksForFile(db, relPath);
  db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
  return removed;
}

export interface IndexOptions {
  resetVectors?: boolean;
}

export async function indexRepository(config: ServerConfig, options: IndexOptions = {}): Promise<IndexRunResult> {
  const started = Date.now();
  const { db } = openDatabase(config.dbPath);

  try {
    // The dimension is fixed in the vec0 schema, so it cannot be changed by
    // migration — on a setting change the table is recreated, and every vector
    // of the incompatible dimension disappears with it.
    if (options.resetVectors === true) dropVectorTable(db);
    createVectorTable(db, config.dimension);
    if (vectorTableExists(db) === false) throw new Error('chunks_vec was not created');

    // Model metadata is written BEFORE embedding, so a dimension mismatch has to
    // be rejected here: otherwise vectors of different lengths end up in one
    // vec0 table, the comparison becomes meaningless, and the only symptom is
    // the quality of the results.
    const storedModel = readMeta(db, 'model_id');
    const storedDtype = readMeta(db, 'dtype');
    const storedDimension = readMeta(db, 'dimension');
    const hasVectors = (db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n > 0;

    // Check order matters. A model change is rejected first and unconditionally:
    // vectors computed by another model are meaningless even when the dimension
    // matches, and trying to compare them returns garbage without any error.
    if (hasVectors && storedModel !== null && storedModel !== config.model) {
      throw new Error(
        `index was built with model ${storedModel}, but ${config.model} is configured. ` +
          'Vectors from different models are not comparable — rebuild the index with index_rebuild.',
      );
    }

    // Quantization changes the values in a vector without changing its length, so
    // the checks above pass and vec0 ends up holding two precisions at once —
    // which from the outside looks like a working index: same model, dimension.
    if (hasVectors && storedDtype !== null && storedDtype !== config.dtype) {
      throw new Error(
        `index was built with quantization ${storedDtype}, but ${config.dtype} is configured. ` +
          'Vectors of different precision cannot be mixed — rebuild the index with index_rebuild.',
      );
    }

    // The dimension is fixed in the vec0 table DDL, so changing it means
    // recreating the table along with its vectors. That is impossible for a
    // single model, so the branch is defensive.
    if (hasVectors && storedDimension !== null && Number(storedDimension) !== config.dimension) {
      log.warn('dimension changed, recreating vector table', {
        from: storedDimension,
        to: String(config.dimension),
        model: config.model,
      });
      dropVectorTable(db);
      createVectorTable(db, config.dimension);
    }

    writeMeta(db, 'model_id', config.model);
    writeMeta(db, 'dtype', config.dtype);
    writeMeta(db, 'dimension', String(config.dimension));
    // Stored paths are relative to this, so an index opened with a different
    // anchor is reading keys that mean something else.
    writeMeta(db, 'index_root', config.indexRoot);
    writeMeta(db, 'last_scan_root', config.root);

    const scan = await scanRepository(config);
    const seen = new Set<string>();

    const result: IndexRunResult = {
      added: 0, updated: 0, removed: 0, unchanged: 0,
      chunksWritten: 0, chunksRemoved: 0,
      astChunks: 0, fallbackChunks: 0, failedFiles: 0,
      durationMs: 0,
    };

    const knownRows = db.prepare('SELECT path, mtime_ms, size, content_hash, chunk_count FROM files').all() as FileRow[];
    const known = new Map(knownRows.map((row) => [row.path, row]));

    for (const file of scan.files) {
      seen.add(file.relPath);
      const previous = known.get(file.relPath);

      // A rebuild has to rewrite the chunks too, not just the vectors. Otherwise
      // columns added by a migration after the first pass would stay empty
      // forever: a file with a matching mtime and size counts as unchanged and
      // is never chunked again.
      const unchanged =
        options.resetVectors !== true &&
        previous !== undefined &&
        previous.mtime_ms === file.mtimeMs &&
        previous.size === file.size;

      if (unchanged) {
        result.unchanged += 1;
        continue;
      }

      const content = await readIndexable(config.indexRoot, file.relPath);
      if (content === null) {
        result.failedFiles += 1;
        continue;
      }

      const delta = await indexFile(db, config, file.relPath, content, {
        mtimeMs: file.mtimeMs,
        size: file.size,
      });
      if (previous === undefined) result.added += 1;
      else result.updated += 1;

      result.chunksWritten += delta.chunks;
      result.chunksRemoved += delta.removed;
      if (delta.strategy === 'ast') result.astChunks += delta.chunks;
      else result.fallbackChunks += delta.chunks;
    }

    for (const stalePath of known.keys()) {
      if (seen.has(stalePath)) continue;
      result.chunksRemoved += removeFile(db, stalePath);
      result.removed += 1;
    }

    result.durationMs = Date.now() - started;
    writeMeta(db, 'last_indexed_at', String(Date.now()));
    writeMeta(db, 'chunks_total', String(countChunks(db)));

    log.info('index complete', { ...result, files: countChunks(db) });
    return result;
  } finally {
    db.close();
  }
}
