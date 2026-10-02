import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { hardExcludedDirs, toPosix } from './scanner.js';
import { createLogger } from './logger.js';

const log = createLogger('watcher');

export type WatchEvent = 'added' | 'changed' | 'removed' | 'renamed';

export interface WatcherOptions {
  root: string;
  /** Paths in the callback are relative to this, matching how they are stored. */
  indexRoot?: string;
  debounceMs?: number;
  onEvents: (files: Set<string>) => Promise<void> | void;
  isIgnored?: (relPath: string) => boolean;
}

export interface RepositoryWatcher {
  close: () => Promise<void>;
  pending: () => number;
}

/**
 * chokidar events arrive in bursts: a single editor save produces add + change
 * for the same file. Without debouncing and deduplication every burst would
 * start a full reindex.
 */
export function startWatcher(options: WatcherOptions): RepositoryWatcher {
  const debounceMs = options.debounceMs ?? 500;
  const queue = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const flush = async (): Promise<void> => {
    timer = null;
    if (queue.size === 0) return;

    // A rerun started while a batch is in flight must not lose events: files
    // that arrive at this moment are handled by the next pass.
    if (running) {
      timer = setTimeout(() => void flush(), debounceMs);
      return;
    }

    const batch = [...queue].sort();
    queue.clear();
    running = true;

    try {
      log.info('batch', { files: batch.length, first: batch[0] });
      await options.onEvents(new Set(batch));
    } catch (error) {
      log.error('batch failed', { files: batch.length, error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
      if (queue.size > 0) timer = setTimeout(() => void flush(), debounceMs);
    }
  };

  // Ignore rules are written relative to the directory that holds them, which is
// the watched root, not the anchor. The queue holds anchor-relative paths because
// that is what the database stores, so the two forms are converted between.
const anchor = options.indexRoot ?? options.root;
const toScanned = (relPath: string): string =>
  toPosix(path.relative(options.root, path.resolve(anchor, relPath)));

const schedule = (relPath: string): void => {
    if (options.isIgnored?.(toScanned(relPath)) === true) return;
    queue.add(relPath);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  // Path separators in chokidar events do not match the separators in root, so
  // normalization is mandatory: without it events cannot be matched against
  // rows in files, and incrementality after a restart stops seeing changes
  // (ADR-011). Paths are taken relative to indexRoot, not to the watched root,
  // because that is the form they are stored under.
  const toRelative = (absolute: string): string => {
    const relative = path.relative(anchor, absolute);
    if (relative === '' || relative.startsWith('..')) return '';
    return toPosix(relative);
  };

  // Telling the watched root apart from a path outside it takes a separate
  // check: toRelative returns an empty string for both, and comparing the
  // strings does not work — on Windows chokidar reports `C:/dir/file` while root
  // arrives as `C:\dir\file`, so the root would be taken for an outside path:
  // ignored=true for the root, the traversal never starts, no events at all
  // (ADR-011). path.relative brings the separators to one form.
  const isRoot = (candidate: string): boolean => path.relative(options.root, candidate) === '';

  const watcher: FSWatcher = chokidar.watch(options.root, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignored: (candidate: string) => {
      const relative = toRelative(candidate);
      if (relative === '') return !isRoot(candidate);
      // Every segment is checked, not just the parent ones: chokidar also asks
      // about directories, and the scanner's rule rejects on the last segment's
      // name only when it starts with a dot — a file named `dist` would survive.
      return relative.split('/').some((segment) => hardExcludedDirs.has(segment));
    },
  });

  for (const event of ['add', 'change'] as const) {
    watcher.on(event, (absolute: string) => {
      const relative = toRelative(absolute);
      if (relative !== '') schedule(relative);
    });
  }

  for (const event of ['unlink', 'unlinkDir'] as const) {
    watcher.on(event, (absolute: string) => {
      const relative = toRelative(absolute);
      if (relative !== '') schedule(relative);
    });
  }

  watcher.on('error', (error: unknown) => {
    log.error('watcher error', { error: error instanceof Error ? error.message : String(error) });
  });

  watcher.on('ready', () => {
    log.info('watching', { root: options.root, debounceMs });
  });

  return {
    pending: () => queue.size,
    close: async () => {
      if (timer !== null) clearTimeout(timer);
      await watcher.close();
      log.info('watcher closed');
    },
  };
}
