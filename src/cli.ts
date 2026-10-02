import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, nonCodeLanguages, readPackageVersion, type ServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { Embedder } from './embedder.js';
import { embedMissing, readIndexState, saveCounters } from './index-service.js';
import { indexRepository } from './indexer.js';
import { createLogger } from './logger.js';
import { searchChunks, type SearchMode } from './search.js';
import type { IndexStats } from './stats.js';

const log = createLogger('cli');

const MODES = ['hybrid', 'semantic', 'keyword'] as const;
const DTYPES = ['q8', 'fp16', 'fp32'] as const;

// Derived from the same list the chunker and index_status use, so the label
// cannot fall behind the languages it claims to cover.
const NON_CODE_LABEL = nonCodeLanguages.join('/');

interface ParsedArgs {
  command: string;
  overrides: Partial<ServerConfig>;
  query: string | undefined;
  topK: number;
  mode: SearchMode;
  modeError: string | undefined;
  dtypeError: string | undefined;
  json: boolean;
}

const USAGE = `anyindex-mcp <command> [path] [options]

Commands:
  reindex        rebuild the repository index (defaults to --rebuild)
  update         incrementally reindex what changed
  status         show the index state
  search <text>  query the index
  probe          check the environment and hardware
  benchmark      run the quality benchmark
  help           this help

[path] is the folder to index, the same as --root. It defaults to the working
directory. Stored paths are relative to the enclosing repository, so indexing a
subfolder and later the whole repository reuses the files already seen.

Options:
--root <path>       folder to index (defaults to cwd)
--index-root <path>  what stored paths are relative to (defaults to the repository)
--db <path>         index file
  --models <path>     model cache directory
  --model <id>        embedding model id
  --dtype <q8|fp16|fp32>  model quantization
  --offline           do not fetch the model over the network
  --topK <n>          number of results (defaults to 5)
  --mode <hybrid|semantic|keyword>  search mode
  --json              machine-readable output
  --version           print the package version
`;

function parseArgs(argv: string[]): ParsedArgs {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const number = (flag: string, fallback: number): number => {
    const raw = value(flag);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const modeRaw = value('--mode') ?? 'hybrid';
  // An invalid mode is not replaced with the default: a silently applied
  // hybrid instead of the requested keyword looks like "nothing found" even
  // though the lexical path would have searched.
  const modeKnown = (MODES as readonly string[]).includes(modeRaw);
  const mode = modeKnown ? (modeRaw as SearchMode) : 'hybrid';

  // Quantization is validated here rather than in transformers.js: a wrong value
  // would kill the command a minute later, after the model is already in memory.
  const dtypeRaw = value('--dtype');
  const dtypeKnown = dtypeRaw === undefined || (DTYPES as readonly string[]).includes(dtypeRaw);

  // The query is the positional argument right after the command. Flag values
  // must not leak into the query text: `search --root /tmp "session"` is a
  // search for "session", not for "--root".
  const FLAG_WITH_VALUE = new Set(['--root', '--index-root', '--db', '--models', '--model', '--dtype', '--topK', '--mode']);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    if (FLAG_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    positionals.push(token);
  }

  const command = positionals[0] ?? 'help';
  const rest = command === 'search' ? positionals[1] : undefined;
  // `reindex src/api` is the same as `--root src/api`. Search is excluded because
  // its positional is the query text.
  const positionalRoot = command === 'search' || command === 'help' ? undefined : positionals[1];

  return {
    command,
    query: rest,
    topK: number('--topK', 5),
    mode,
    modeError: modeKnown
      ? undefined
      : `Unknown search mode: ${modeRaw}. Allowed: ${MODES.join(', ')}.`,
    dtypeError: dtypeKnown
      ? undefined
      : `Unknown quantization: ${dtypeRaw}. Allowed: ${DTYPES.join(', ')}.`,
    json: argv.includes('--json'),
    overrides: {
      root: value('--root') ?? positionalRoot,
      indexRoot: value('--index-root'),
      dbPath: value('--db'),
      modelsDir: value('--models'),
      model: value('--model'),
      dtype: value('--dtype') as ServerConfig['dtype'] | undefined,
      offline: argv.includes('--offline') ? true : undefined,
    },
  };
}

/**
 * Path to the script that runs as a subprocess. The reference point is cli.js
 * itself, so the result does not depend on the current directory.
 */
export function subcommandEntry(command: 'probe' | 'benchmark'): string {
  const script = command === 'probe' ? 'probe.js' : 'benchmark.js';
  // fileURLToPath, not URL.pathname: pathname returns `/D:/dist/probe.js` and
  // Windows turns that into `D:\D:\dist\probe.js` — the module is not found.
  return fileURLToPath(new URL(script, import.meta.url));
}

async function runIndex(config: ServerConfig, rebuild: boolean): Promise<void> {
  const started = Date.now();
  const textPass = await indexRepository(config, { resetVectors: rebuild });
  process.stderr.write(
    `Files: +${textPass.added} new, ~${textPass.updated} changed, ` +
      `=${textPass.unchanged} unchanged, -${textPass.removed} removed\n`,
  );
  process.stderr.write(
    `Chunks: ${textPass.chunksWritten} (AST ${textPass.astChunks}, fallback path ${textPass.fallbackChunks})\n`,
  );

  const { db } = openDatabase(config.dbPath);
  let embedded = 0;
  let reused = 0;
  let failed = 0;
  try {
    const embedder = new Embedder(config);
    try {
      const result = await embedMissing(db, config, embedder, {
        rebuild,
        onProgress: (done, total) => {
          process.stderr.write(`\rVectorizing: ${done}/${total}`);
        },
      });
      embedded = result.embedded;
      reused = result.reused;
      failed = result.failed;
      process.stderr.write('\r');

      const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      saveCounters(db, {
        chunks: chunks.n,
        skipped: textPass.failedFiles,
        embedded: result.embedded,
        reused: result.reused,
      });
    } finally {
      await embedder.close();
    }
  } finally {
    db.close();
  }

  process.stderr.write(
    `Vectors: ${embedded} computed, ${reused} reused, ${failed} failed\n` +
      `Done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
  );
}

async function runSearch(config: ServerConfig, args: ParsedArgs): Promise<number> {
  if (args.query === undefined || args.query.trim() === '') {
    process.stderr.write('Empty query. Usage: search --root <path> <text>\n');
    return 1;
  }

  const stats = readIndexState(config);
  if (!stats.ready) {
    process.stderr.write(
      `Index is not ready: ${stats.reason ?? 'unknown reason'}\nRun reindex first.\n`,
    );
    return 1;
  }

  const embedder = new Embedder(config);
  const { db } = openDatabase(config.dbPath);

  try {
    const wantVector = args.mode !== 'keyword';
    const vector = wantVector ? ((await embedder.embed([args.query]))[0] ?? null) : null;
    const outcome = searchChunks(db, args.query, vector, args.topK, args.mode);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(outcome.hits, null, 2)}\n`);
      return 0;
    }

    if (outcome.hits.length === 0) {
      process.stdout.write('Nothing found.\n');
      return 0;
    }

    for (const [index, hit] of outcome.hits.entries()) {
      const distance = hit.distance === null ? '' : `  distance ${hit.distance.toFixed(3)} (${hit.confidence})`;
      process.stdout.write(
        `\n${index + 1}. ${hit.filePath}:${hit.lineStart}-${hit.lineEnd}` +
          `${hit.entityName === null ? '' : `  ${hit.entityName}`}${distance}\n`,
      );
      for (const line of hit.text.split('\n').slice(0, 12)) process.stdout.write(`   ${line}\n`);
    }
    process.stdout.write('\n');
    return 0;
  } finally {
    db.close();
    await embedder.close();
  }
}

/**
 * AST and the fallback path are counted separately, but lumped into one "fallback"
 * number they read as a broken parser. In a documentation-heavy repository that
 * number is mostly markdown, which the chunker never attempts to parse with
 * tree-sitter — so a healthy index looks like a failing one.
 */
export function renderStrategies(stats: IndexStats): string {
  const failed = stats.fallbackChunks - stats.nonCodeChunks;
  const line = `Code: AST ${stats.astChunks}   Non-code: ${stats.nonCodeChunks} (${NON_CODE_LABEL})`;
  if (failed === 0) return line;
  return `${line}\nFallback failures: ${failed} chunk(s) on a language tree-sitter can parse`;
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  const args = parseArgs(argv);

  // Option values are validated before the command is parsed: a wrong
  // quantization or mode is dangerous for any command, not just search.
  const badOption = args.dtypeError ?? args.modeError;
  if (badOption !== undefined) {
    process.stderr.write(`${badOption}\n`);
    return 1;
  }

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;

    case 'reindex':
    case 'update': {
      const config = loadConfig(args.overrides);
      // Without this a mistyped --root scans nothing, reports "Done in 0.4s" and
      // exits 0 — indistinguishable from a finished reindex to any caller.
      if (!existsSync(config.root)) {
        process.stderr.write(`Root does not exist: ${config.root}\n`);
        return 1;
      }
      await runIndex(config, args.command === 'reindex');
      return 0;
    }

    case 'status': {
      const config = loadConfig(args.overrides);
      const stats = readIndexState(config);
      if (args.json) {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        return stats.ready ? 0 : 1;
      }
      process.stdout.write(
        `Ready: ${stats.ready ? 'yes' : 'no'}${stats.reason === undefined ? '' : ` (${stats.reason})`}\n` +
          `Files: ${stats.files}   chunks: ${stats.chunks}   stale: ${stats.stale}\n` +
          `${renderStrategies(stats)}\n` +
          `Vectors: ${stats.embedded} of ${stats.chunks} chunks   reused in the last run: ${stats.reused}\n` +
          `Updated: ${stats.lastUpdated ?? 'never'}\n`,
      );
      return stats.ready ? 0 : 1;
    }

    case 'search':
      return runSearch(loadConfig(args.overrides), args);

    case 'probe':
    case 'benchmark': {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.execPath, [subcommandEntry(args.command), ...argv.slice(1)], {
        stdio: 'inherit',
      });
      return result.status ?? 1;
    }

    default:
      process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
      return 1;
  }
}

if (process.argv[1]?.endsWith('cli.js')) {
  log.debug('cli start', { argv: process.argv.slice(2) });
  process.exitCode = await runCli(process.argv.slice(2));
}
