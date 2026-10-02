import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { loadConfig, type ServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { Embedder } from './embedder.js';
import { embedMissing, readIndexState, saveCounters, type EmbedOutcome } from './index-service.js';
import { indexRepository } from './indexer.js';
import { renderResults, renderStatus } from './render.js';
import { createIgnoreFilter } from './scanner.js';
import { findReferences } from './references.js';
import { searchChunks } from './search.js';
import { jobState, requestRerun, startJob, type JobPhase } from './job.js';
import { startWatcher, type RepositoryWatcher } from './watcher.js';
import { indexStatsSchema, log, type IndexStats } from './stats.js';

let shared: ServerConfig | null = null;
let embedder: Embedder | null = null;
let watcher: RepositoryWatcher | null = null;

function config(): ServerConfig {
  if (shared === null) shared = loadConfig();
  return shared;
}

function getEmbedder(): Embedder {
  if (embedder === null) embedder = new Embedder(config());
  return embedder;
}

/**
 * Starts watching files. Changes are not indexed immediately: events accumulate and
 * are handled by a background job, so editing one file does not trigger a full pass.
 */
export function pendingWatchEvents(): number {
  return watcher?.pending() ?? 0;
}

/**
 * Auto-indexing at startup. The ANYINDEX_AUTOINDEX flag exists so the first run does
 * not spend minutes on an empty index: without it the user calls index_update
 * themselves and sees the indexing under way.
 */
export function startAutoIndexIfEnabled(): void {
  const cfg = config();
  if (cfg.autoIndex !== true) return;

  const { started } = startJob((report) => runIndex(false, report));
  log.info('autoindex', { started });
}

export async function initWatcher(): Promise<void> {
  const cfg = config();
  if (watcher !== null || cfg.watch !== true) return;

  watcher = startWatcher({
    root: cfg.root,
    indexRoot: cfg.indexRoot,
    debounceMs: 500,
    isIgnored: createIgnoreFilter(cfg.root),
    onEvents: (files) => {
      if (jobState().running) {
        // The batch cannot simply be dropped: no new event may arrive to trigger
        // the next pass, and the index goes stale silently while index_status
        // reports stale=0.
        requestRerun();
        log.info('watch events while indexing, rerun queued', { files: files.size });
        return;
      }
      log.info('watch events', { files: [...files].slice(0, 5), total: files.size });
      startJob((report) => runIndex(false, report));
    },
  });

  log.info('watcher enabled', { root: cfg.root });
}

export async function shutdownWatcher(): Promise<void> {
  if (watcher === null) return;
  await watcher.close();
  watcher = null;
}

export async function shutdownEmbedder(): Promise<void> {
  if (embedder === null) return;
  const instance = embedder;
  embedder = null;
  await instance.close();
}

type Reporter = (phase: JobPhase, done: number, total: number) => void;

/**
 * Sends progress over the MCP protocol if the client asked for it.
 *
 * `progressToken` arrives in the request `_meta`, and without it the notification
 * would be noise in the channel. Client-side support has not been verified for any of
 * them, so the tool cannot rely on it: `index_status` stays the primary way to watch
 * the job, and progress is a supplement.
 */
interface ToolContext {
  _meta?: Record<string, unknown>;
  sendNotification?: (notification: unknown) => Promise<void>;
}

function progressSender(extra: ToolContext | undefined): Reporter {
  const token = extra?._meta?.progressToken;
  if (typeof token !== 'string' && typeof token !== 'number') return () => undefined;
  if (typeof extra?.sendNotification !== 'function') return () => undefined;

  let lastSent = 0;
  return (phase: JobPhase, done: number, total: number) => {
    // Notifications go out at most once every 500 ms: over hundreds of batches that
    // is noticeable traffic with nothing gained for the client.
    const now = Date.now();
    if (done !== total && now - lastSent < 500) return;
    lastSent = now;
    void extra?.sendNotification?.({
      method: 'notifications/progress',
      params: { progressToken: token, progress: done, total, message: phase },
    }).catch(() => undefined);
  };
}

async function runIndex(rebuild: boolean, report: Reporter): Promise<void> {
  const cfg = config();

  report('chunking', 0, 0);
  const textPass = await indexRepository(cfg, { resetVectors: rebuild });

  report('embedding', 0, textPass.chunksWritten);
  const { db } = openDatabase(cfg.dbPath);
  try {
    const embedResult: EmbedOutcome = await embedMissing(db, cfg, getEmbedder(), {
      rebuild,
      onProgress: (done, total) => report('embedding', done, total),
    });

    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    saveCounters(db, {
      chunks: chunks.n,
      skipped: textPass.failedFiles,
      embedded: embedResult.embedded,
      reused: embedResult.reused,
    });

    log.info('index pass', {
      added: textPass.added,
      updated: textPass.updated,
      unchanged: textPass.unchanged,
      removed: textPass.removed,
      chunks: textPass.chunksWritten,
      ast: textPass.astChunks,
      fallback: textPass.fallbackChunks,
      embedded: embedResult.embedded,
      reused: embedResult.reused,
      failed: embedResult.failed,
      durationMs: textPass.durationMs,
    });
  } finally {
    db.close();
  }
}

function renderJobHint(): string {
  const job = jobState();
  if (!job.running) return '';
  const percent = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  return `Indexing in progress: phase=${job.phase}, ${job.done}/${job.total || '?'} (${percent}%). Call index_status to check again.`;
}

type RegisterTool = McpServer['registerTool'];

function registerTool(name: string, toolConfig: unknown, handler: unknown): void {
  // registerTool is overloaded in the SDK; this is the single place for the
  // conversion instead of casts on every tool — otherwise schema checking is lost.
  (registerToolImpl as RegisterTool)(name, toolConfig as never, handler as never);
}

let registerToolImpl: McpServer['registerTool'];

export function initTools(server: McpServer): void {
  registerToolImpl = server.registerTool.bind(server) as McpServer['registerTool'];

  registerTool(
    'index_status',
    {
      description:
        'Reports whether the codebase index is ready to search, how many files and chunks it covers, and whether indexing is currently running. ' +
        'After calling index_update or index_rebuild, poll this to find out when the work finished. ' +
        'Also reports whether any subsystem failed, so you never rely on a silently broken index.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {},
      outputSchema: indexStatsSchema,
    },
    (async (_args: unknown, extra: ToolContext | undefined) => {
      const stats = readIndexState(config(), pendingWatchEvents());
      progressSender(extra)(stats.phase, stats.progress.done, stats.progress.total);
      return {
        content: [{ type: 'text' as const, text: renderStatus(stats) }],
        structuredContent: stats,
      };
    }),
  );

  registerTool(
    'anyindex_search',
    {
      description:
        'Semantic and keyword search over the ENTIRE locally indexed codebase. Every indexed file is already available to you — ' +
        'do not ask the user to paste code, and do not read files directory-by-directory looking for it. ' +
        'Use this when the answer is not in your current context, when you need to locate a function, class or feature by name or by meaning, ' +
        'or when you need to understand how parts of the project fit together. ' +
        'Skip it when the answer is already in context, or for general programming questions unrelated to this repository. ' +
        'Each result carries file path and line numbers. If no results come back, the code may not exist here — say so instead of inventing it.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        query: z.string().min(1).describe('Natural language query, or an exact symbol name'),
        topK: z.number().int().min(1).max(25).default(8)
          .describe('Maximum number of results. Counts files, not chunks: you get at most one chunk per file, so fewer results may come back. Use get_file_outline for the rest of a file.'),
        mode: z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
      },
      outputSchema: {
        hits: z.array(
          z.object({
            file: z.string(),
            lines: z.tuple([z.number(), z.number()]),
            entity: z.string().nullable(),
            language: z.string(),
            score: z.number(),
            distance: z.number().nullable(),
            confidence: z.enum(['strong', 'moderate', 'weak']),
          }),
        ),
        total: z.number().int(),
        index: indexStatsSchema,
      },
    },
    (async ({ query, topK, mode }: { query: string; topK: number; mode: 'hybrid' | 'semantic' | 'keyword' }) => {
      const cfg = config();
      const stats = readIndexState(cfg, pendingWatchEvents());

      if (!stats.ready) {
        return {
          content: [{ type: 'text' as const, text: renderStatus(stats) }],
          structuredContent: { hits: [], total: 0, index: stats },
          isError: true,
        };
      }

      let vector: Float32Array | null = null;
      if (mode === 'hybrid' || mode === 'semantic') {
        try {
          const [embedded] = await getEmbedder().embed([query]);
          vector = embedded ?? null;
        } catch (error) {
          log.warn('query embedding failed, falling back to keyword', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const { db } = openDatabase(cfg.dbPath);
      try {
        const outcome = searchChunks(db, query, vector, topK, mode);
        const payload = {
          hits: outcome.hits.map((hit) => ({
            file: hit.filePath,
            lines: [hit.lineStart, hit.lineEnd] as [number, number],
            entity: hit.entityName,
            language: hit.language,
            score: hit.score,
            distance: hit.distance,
            confidence: hit.confidence,
          })),
          total: outcome.hits.length,
          index: stats,
        };

        return {
          content: [{ type: 'text' as const, text: renderResults(query, outcome.hits, stats, mode) }],
          structuredContent: payload,
        };
      } finally {
        db.close();
      }
    }),
  );

  registerTool(
    'get_file_outline',
    {
      description:
        'Lists the symbols defined in one file — functions, classes, methods — with their line ranges and signatures. ' +
        'Cheaper than reading the file when you only need to know what it defines, or need to pick a line range to read. ' +
        'The index may be stale for very recent edits; verify with Read when exactness matters.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        file: z.string().min(1).describe('Path relative to the indexed project root, POSIX separators'),
      },
      outputSchema: {
        file: z.string(),
        language: z.string(),
        indexed: z.boolean(),
        entities: z.array(
          z.object({
            name: z.string(),
            kind: z.string(),
            signature: z.string().nullable(),
            lines: z.tuple([z.number(), z.number()]),
          }),
        ),
        note: z.string().optional(),
      },
    },
    (async ({ file }: { file: string }) => {
      const cfg = config();
      const { db } = openDatabase(cfg.dbPath);

      try {
        const rows = db
          .prepare('SELECT entities, language, line_start, line_end FROM chunks WHERE file_path = ? ORDER BY line_start')
          .all(file) as Array<{
          entities: string;
          language: string;
          line_start: number;
          line_end: number;
        }>;

        if (rows.length === 0) {
          const note = 'File not found in the index. It may not be indexed, or the path may be wrong.';
          return {
            content: [{ type: 'text' as const, text: `No indexed chunks for ${file}. ${note}` }],
            structuredContent: { file, language: 'unknown', indexed: false, entities: [], note },
            isError: true,
          };
        }

        // Entities from all chunks are merged into one list and sorted by line,
        // so the output does not depend on how code-chunk split the file.
        const seen = new Set<string>();
        const entities: Array<{
          name: string;
          kind: string;
          signature: string | null;
          lines: [number, number];
        }> = [];

        for (const row of rows) {
          let parsed: Array<{ name?: string; type?: string; signature?: string | null; lineStart?: number; lineEnd?: number }>;
          try {
            parsed = JSON.parse(row.entities) as typeof parsed;
          } catch {
            parsed = [];
          }

          for (const entity of parsed) {
            const name = entity.name ?? '';
            const lines: [number, number] = [entity.lineStart ?? row.line_start, entity.lineEnd ?? row.line_end];
            const key = `${name}:${lines[0]}`;
            if (name === '' || seen.has(key)) continue;
            seen.add(key);
            entities.push({ name, kind: entity.type ?? 'unknown', signature: entity.signature ?? null, lines });
          }
        }

        entities.sort((a, b) => a.lines[0] - b.lines[0]);

        const payload = {
          file,
          language: rows[0]?.language ?? 'unknown',
          indexed: true,
          entities,
        };

        const lines = [
          `${file} — ${entities.length} symbol(s), language ${payload.language}`,
          '',
          ...entities.map(
            (e, i) =>
              `${i + 1}. ${e.name}  [${e.kind}]  lines ${e.lines[0]}–${e.lines[1]}` +
              `${e.signature === null ? '' : `  ${e.signature}`}`,
          ),
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: payload,
        };
      } finally {
        db.close();
      }
    }) as never,
  );

  registerTool(
    'find_references',
    {
      description:
        'Finds where an identifier is defined and where it is used, as file and line numbers. ' +
        'Use it before editing a shared function or type, to see what depends on it, or when you know the name but not the file. ' +
        'These are LEXICAL matches: a same-named identifier in another class, a comment or a string counts as a match too. ' +
        'It is not a call graph — it does not resolve which `Charge` a given call site means. ' +
        'Prefer anyindex_search when you want code by meaning rather than by name.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        symbol: z.string().min(1).describe('Exact identifier to look for, e.g. startWatcher'),
        file: z.string().min(1).optional().describe('Restrict to one file, path relative to the indexed root'),
        includeDefinitions: z.boolean().default(true).describe('Include the sites where the identifier is declared'),
        maxResults: z.number().int().min(1).max(200).default(25),
      },
      outputSchema: {
        symbol: z.string(),
        definitions: z.array(
          z.object({
            file: z.string(),
            lines: z.tuple([z.number(), z.number()]),
            kind: z.string(),
            signature: z.string().nullable(),
          }),
        ),
        references: z.array(
          z.object({
            file: z.string(),
            lines: z.array(z.number()),
            snippet: z.string(),
          }),
        ),
        matchedChunks: z.number().int().nonnegative(),
        truncated: z.boolean(),
        otherFiles: z.number().int().nonnegative(),
        lexicalOnly: z.literal(true),
      },
    },
    (async ({ symbol, file, includeDefinitions, maxResults }: {
      symbol: string;
      file?: string;
      includeDefinitions: boolean;
      maxResults: number;
    }) => {
      const cfg = config();
      const { db } = openDatabase(cfg.dbPath);

      try {
        const outcome = findReferences(db, symbol, { file, includeDefinitions, maxResults });

        if (outcome.matchedChunks === 0) {
          const note = 'Symbol not found in the index. It may not be indexed, or it may be spelled differently.';
          return {
            content: [{ type: 'text' as const, text: `No indexed occurrences of "${outcome.symbol}". ${note}` }],
            structuredContent: {
              symbol: outcome.symbol,
              definitions: [],
              references: [],
              matchedChunks: 0,
              truncated: false,
              otherFiles: 0,
              lexicalOnly: true as const,
            },
            isError: true,
          };
        }

        const payload = {
          symbol: outcome.symbol,
          definitions: outcome.definitions.map((d) => ({
            file: d.filePath,
            lines: [d.lineStart, d.lineEnd] as [number, number],
            kind: d.kind,
            signature: d.signature,
          })),
          references: outcome.references.map((r) => ({
            file: r.filePath,
            lines: r.lines,
            snippet: r.snippet,
          })),
          matchedChunks: outcome.matchedChunks,
          truncated: outcome.truncated,
          otherFiles: outcome.otherFiles,
          lexicalOnly: true as const,
        };

        const lines = [
          `${outcome.symbol}: ${outcome.references.length} lexical reference(s) in ${new Set(outcome.references.map((r) => r.filePath)).size} file(s)`,
          ...(outcome.definitions.length === 0 ? [] : ['', 'declared at:']),
          ...outcome.definitions.map(
            (d) => `  ${d.filePath}:${d.lineStart}-${d.lineEnd}  [${d.kind}]${d.signature === null ? '' : `  ${d.signature}`}`,
          ),
          '',
          'used at:',
          ...outcome.references.map((r) => `  ${r.filePath}\n${r.snippet.split('\n').map((l) => `      ${l}`).join('\n')}`),
          '',
          'Lexical matches only: same-named identifiers, comments and strings are included. Not a call graph.',
        ];
        if (outcome.truncated) lines.push(`Truncated to ${outcome.references.length}; raise maxResults to see more.`);
        if (outcome.otherFiles > 0) lines.push(`${outcome.otherFiles} chunk(s) with this symbol were outside the requested file.`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: payload,
        };
      } finally {
        db.close();
      }
    }) as never,
  );

  registerTool(
    'index_update',
    {
      description:
        'Indexes files that changed since the last run and embeds the new chunks. Safe to call after edits; existing chunks are reused by content hash. ' +
        'Use it when the repository has been modified and the index is stale.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {},
      outputSchema: indexStatsSchema,
    },
    (async (_args: unknown, extra: ToolContext | undefined) => {
      const sender = progressSender(extra);
      // The closure outlives the tool call: the job runs in the
      // background and the notification channel is needed for its whole duration.
      const { started } = startJob(async (report) =>
        runIndex(false, (phase, done, total) => {
          sender(phase, done, total);
          report(phase, done, total);
        }),
      );
      void started;
      const stats = readIndexState(config(), pendingWatchEvents());
      return {
        content: [
          {
            type: 'text' as const,
            text: started
              ? 'Indexing started in the background. It takes time — call index_status until it reports ready.'
              : 'Indexing is already running. Call index_status to follow progress.',
          },
        ],
        structuredContent: stats,
      };
    }),
  );

  registerTool(
    'index_rebuild',
    {
      description:
        'Discards the whole index and rebuilds it from scratch, including recomputing every embedding. Slow — minutes on a large repository. ' +
        'Use only when index_status reports an incompatibility, or after changing the embedding model.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {},
      outputSchema: indexStatsSchema,
    },
    (async (_args: unknown, extra: ToolContext | undefined) => {
      const sender = progressSender(extra);
      // The closure outlives the tool call: the job runs in the
      // background and the notification channel is needed for its whole duration.
      const { started } = startJob(async (report) =>
        runIndex(true, (phase, done, total) => {
          sender(phase, done, total);
          report(phase, done, total);
        }),
      );
      void started;
      const stats = readIndexState(config(), pendingWatchEvents());
      return {
        content: [
          {
            type: 'text' as const,
            text: started
              ? 'Full rebuild started in the background. This recomputes every embedding — call index_status until it reports ready.'
              : 'An indexing job is already running. Call index_status to follow progress.',
          },
        ],
        structuredContent: stats,
      };
    }),
  );
}
