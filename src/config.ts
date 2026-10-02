import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEX_DIR_NAME = '.anyindex';
export const IGNORE_FILE = '.anyindexignore';

const DEFAULTS = {
  model: 'jinaai/jina-embeddings-v2-base-code',
  dtype: 'q8',
  chunkSizeBytes: 1500,
  maxFileBytes: 1024 * 1024,
  batchSize: 16,
} as const;

export type EmbeddingDtype = 'q8' | 'fp16' | 'fp32';

export interface ServerConfig {
  /** What to scan. Defaults to the working directory the agent was started in. */
  root: string;
  /**
   * What stored file paths are relative to, and where the database lives. A git
   * repository anchors it, so scanning `src/api` and later `src` shares one index
   * instead of building a second one and re-embedding files already seen.
   */
  indexRoot: string;
  dbPath: string;
  modelsDir: string;
  model: string;
  dtype: EmbeddingDtype;
  dimension: number;
  offline: boolean;
  watch: boolean;
  autoIndex: boolean;
  chunkSizeBytes: number;
  maxFileBytes: number;
  batchSize: number;
}

export const defaultDimension = 768;

const INDEXED_EXTENSIONS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi',
  '.rs',
  '.go',
  '.java',
  '.md',
  '.json', '.yaml', '.yml', '.toml',
] as const;

export const indexedExtensions: readonly string[] = INDEXED_EXTENSIONS;

/**
 * Indexed files that hold prose or data rather than code. tree-sitter has no
 * grammar for any of them, so the chunker always takes the structural fallback
 * path for these extensions.
 *
 * The language is what `chunks.language` stores, and it is not always the
 * extension: a `.md` file is chunked as `markdown`. The counters in index_status
 * are grouped by language, so both spellings have to live in one place —
 * otherwise a fallback chunk could be counted as a parsing failure.
 */
export const NON_CODE_FILES: ReadonlyArray<{ extension: string; language: string }> = [
  { extension: '.md', language: 'markdown' },
  { extension: '.json', language: 'json' },
  { extension: '.yaml', language: 'yaml' },
  { extension: '.yml', language: 'yml' },
  { extension: '.toml', language: 'toml' },
];

export const nonCodeLanguages: readonly string[] = NON_CODE_FILES.map((file) => file.language);

/**
 * The manifest is not a fixed number of hops from this module: it sits at
 * dist/config.js in the build and at dist-test/src/config.js in the test build.
 * The name is checked as well, so a project that installs anyindex-mcp as a
 * dependency cannot make the server announce the host project's version.
 */
export function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === 'anyindex-mcp' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // No readable manifest here; keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

function firstArg(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

// An agent is usually started somewhere inside the repository, not at its top.
// Resolving to the working directory alone would index that subdirectory and
// leave the database in src/.anyindex/, so walk up to the repository root.
export function resolveIndexRoot(from: string): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

// The model is ~157 MB and identical for every project on the machine, so it
// belongs in the user cache. Keeping it under the indexed root would drop that
// much untracked weight into someone else's working tree, where their
// .gitignore has no rule for it.
export function defaultModelsDir(): string {
  if (process.env.XDG_CACHE_HOME !== undefined && process.env.XDG_CACHE_HOME !== '') {
    return path.join(process.env.XDG_CACHE_HOME, 'anyindex-mcp', 'models');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local !== undefined && local !== '') return path.join(local, 'anyindex-mcp', 'models');
  }
  return path.join(os.homedir(), '.cache', 'anyindex-mcp', 'models');
}

function envFlag(...names: string[]): boolean {
  return names.some((name) => {
    const raw = process.env[name];
    return raw !== undefined && raw !== 'false' && raw !== '0' && raw !== '';
  });
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const root = path.resolve(
    overrides.root ?? firstArg('--root') ?? process.env.ANYINDEX_ROOT ?? process.cwd(),
  );
  const indexRoot = path.resolve(
    overrides.indexRoot ?? firstArg('--index-root') ?? process.env.ANYINDEX_INDEX_ROOT ?? resolveIndexRoot(root),
  );
  const indexDir = path.join(indexRoot, INDEX_DIR_NAME);
  const dbPath = path.resolve(overrides.dbPath ?? firstArg('--db') ?? process.env.ANYINDEX_DB ?? path.join(indexDir, 'index.db'));

  return {
    root,
    indexRoot,
    dbPath,
    modelsDir: path.resolve(overrides.modelsDir ?? process.env.ANYINDEX_MODELS ?? defaultModelsDir()),
    model: overrides.model ?? process.env.ANYINDEX_MODEL ?? DEFAULTS.model,
    dtype: (overrides.dtype ?? process.env.ANYINDEX_DTYPE ?? DEFAULTS.dtype) as EmbeddingDtype,
    dimension: overrides.dimension ?? defaultDimension,
    offline: overrides.offline ?? envFlag('--offline', 'ANYINDEX_OFFLINE'),
    watch: overrides.watch ?? envFlag('--watch', 'ANYINDEX_WATCH'),
    autoIndex: overrides.autoIndex ?? envFlag('ANYINDEX_AUTOINDEX'),
    chunkSizeBytes: overrides.chunkSizeBytes ?? DEFAULTS.chunkSizeBytes,
    maxFileBytes: overrides.maxFileBytes ?? DEFAULTS.maxFileBytes,
    batchSize: overrides.batchSize ?? DEFAULTS.batchSize,
  };
}