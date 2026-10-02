import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';
import ignore, { type Ignore } from 'ignore';

import { IGNORE_FILE, indexedExtensions, type ServerConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('scanner');

/**
 * The one place where the path conversion rule lives: everything that goes into
 * the database, is returned to the MCP client and compared in the watcher is POSIX.
 */
export const toPosix = (p: string): string => p.split(path.sep).join('/');

/**
 * Paths an ignore file cannot opt out of. Applied programmatically rather than
 * through `ignore`, because gitignore semantics ("last rule wins") would let a
 * user index node_modules by accident.
 *
 * The list is shared by the scanner and the watcher: each used to keep its own,
 * so a fix in one place never reached the other — an event in `vendor/` started a
 * full indexing pass that dropped the file anyway.
 */
export const hardExcludedDirs = new Set([
  '.git',
  'node_modules',
  '.anyindex',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'vendor',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

/**
 * Extensions with no point in indexing. Such lists have been through real
 * repositories already and are not worth rebuilding from scratch.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.class', '.jar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.flac', '.ogg', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.pyc', '.pyo', '.wasm', '.bin', '.onnx', '.pt', '.pth', '.safetensors',
  '.db', '.sqlite', '.sqlite3', '.node',
]);

/**
 * Files that pass the extension check but carry no signal for code search. A
 * 3000-line lock file yields dozens of chunks while scoring high BM25 hits on
 * words like "version" and "resolved".
 */
const DENYLISTED_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  'uv.lock',
]);

const IGNORE_FILES = ['.gitignore', '.cursorignore'] as const;

export interface ScannedFile {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface ScanResult {
  files: ScannedFile[];
  scannedDirectories: number;
  skippedByExtension: number;
  skippedBinary: number;
  skippedTooLarge: number;
  skippedUnreadable: number;
  skippedDenylisted: number;
  durationMs: number;
}

export function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function isHardExcluded(relPath: string): boolean {
  const segments = relPath.split('/');
  return segments.some((segment, index) =>
    hardExcludedDirs.has(segment) && (index < segments.length - 1 || segment.startsWith('.'))
  );
}

/**
 * Scope of an ignore file: rules from `dir` apply to paths under it, and a
 * nested scope overrides the outer one — same as in git.
 */
interface IgnoreScope {
  dir: string;
  depth: number;
  filter: Ignore;
}

function readIgnoreFile(root: string, relPath: string): string | null {
  try {
    return readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

function buildIgnoreScopes(root: string, entries: readonly string[]): IgnoreScope[] {
  const scopes: IgnoreScope[] = [];

  // The order mirrors git's priorities: info/exclude is weaker than .gitignore,
  // our file is stronger than the user's, and within one ignore file the last
  // matching rule wins.
  const rootFilter = ignore();
  for (const relPath of [`.git/info/exclude`, ...IGNORE_FILES, IGNORE_FILE]) {
    const content = readIgnoreFile(root, relPath);
    if (content !== null) rootFilter.add(content);
  }
  scopes.push({ dir: '', depth: 0, filter: rootFilter });

  // Nested ignore files: each one scopes to its own directory. Without this,
  // secrets hidden by a rule in `src/.gitignore` would reach both the index and
  // the embeddings.
  const ignoreNames = new Set<string>(IGNORE_FILES);
  const seenDirs = new Set<string>();
  for (const entry of entries) {
    if (!ignoreNames.has(path.posix.basename(entry))) continue;
    const dir = path.posix.dirname(entry);
    if (dir === '.' || seenDirs.has(dir)) continue;
    const content = readIgnoreFile(root, entry);
    if (content === null) continue;
    seenDirs.add(dir);
    const filter = ignore().add(content);
    scopes.push({ dir, depth: dir.split('/').length, filter });
  }

  return scopes.sort((a, b) => a.depth - b.depth);
}

function isIgnored(relPath: string, scopes: readonly IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    if (scope.dir !== '' && !relPath.startsWith(`${scope.dir}/`)) continue;
    const relative = scope.dir === '' ? relPath : relPath.slice(scope.dir.length + 1);
    const verdict = scope.filter.test(relative);
    if (verdict.ignored) ignored = true;
    else if (verdict.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Predicate for the watcher, with the same rules the scanner uses. Ignore files
 * are found with a narrow glob rather than a full scan: without it a full scan
 * runs on every edit, and an edit to a file the scanner drops anyway triggers a
 * full indexing pass for nothing.
 */
export function createIgnoreFilter(root: string): (relPath: string) => boolean {
  const entries = fg.sync(`**/{${IGNORE_FILES.join(',')}}`, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    ignore: ['**/.git/**', '**/node_modules/**', `**/${IGNORE_FILE}`],
  });
  const scopes = buildIgnoreScopes(root, entries);
  return (relPath: string) => isIgnored(relPath, scopes);
}

export async function scanRepository(config: ServerConfig): Promise<ScanResult> {
  const started = Date.now();
  const extensions = new Set(indexedExtensions);

  const entries = await fg('**/*', {
    cwd: config.root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
    ignore: ['**/.git/**', '**/node_modules/**', `**/${IGNORE_FILE}`],
  });

  const ignoreScopes = buildIgnoreScopes(config.root, entries);

  const result: ScanResult = {
    files: [],
    scannedDirectories: 0,
    skippedByExtension: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
    skippedDenylisted: 0,
    durationMs: 0,
  };

  const directories = new Set<string>();

  for (const entry of entries) {
    // Ignore rules and stat() work on paths relative to what is being scanned.
    // The key stored in the database is relative to indexRoot instead, so that a
    // file indexed from src/api and the same file indexed from src come out as
    // one entry rather than two.
    const scanned = toPosix(entry);
    const relPath = toPosix(path.relative(config.indexRoot, path.resolve(config.root, entry)));
    const baseName = path.posix.basename(scanned);
    const extension = path.extname(scanned).toLowerCase();

    if (isHardExcluded(relPath)) continue;
    if (isIgnored(scanned, ignoreScopes)) continue;
    if (DENYLISTED_BASENAMES.has(baseName)) {
      result.skippedDenylisted += 1;
      continue;
    }

    if (BINARY_EXTENSIONS.has(extension)) {
      result.skippedBinary += 1;
      continue;
    }

    if (!extensions.has(extension)) {
      result.skippedByExtension += 1;
      continue;
    }

    try {
      const stats = await stat(path.join(config.root, scanned));
      if (stats.size > config.maxFileBytes) {
        result.skippedTooLarge += 1;
        continue;
      }
      if (stats.size === 0) continue;

      const parent = path.posix.dirname(relPath);
      if (parent !== '.') directories.add(parent);

      result.files.push({ relPath, size: stats.size, mtimeMs: Math.floor(stats.mtimeMs) });
    } catch (error) {
      result.skippedUnreadable += 1;
      log.debug('stat failed', { relPath, error });
    }
  }

  result.scannedDirectories = directories.size;
  // Deterministic order: paths are compared between runs, and iterating the Map
  // fast-glob builds from its patterns does not guarantee a stable order.
  result.files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  result.durationMs = Date.now() - started;

  log.info('scan complete', {
    root: config.root,
    files: result.files.length,
    skippedBinary: result.skippedBinary,
    skippedByExtension: result.skippedByExtension,
    skippedTooLarge: result.skippedTooLarge,
    skippedUnreadable: result.skippedUnreadable,
    skippedDenylisted: result.skippedDenylisted,
    durationMs: result.durationMs,
  });

  return result;
}

export async function readIndexable(root: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, relPath), 'utf8');
  } catch (error) {
    log.debug('read failed', { relPath, error });
    return null;
  }
}
