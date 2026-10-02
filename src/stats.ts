import { z } from 'zod';

import { createLogger } from './logger.js';

export const log = createLogger('server');

/** Index state without the current background job. */
export const baseStatsSchema = z.object({
  ready: z.boolean(),
  degraded: z.boolean(),
  files: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  astChunks: z.number().int().nonnegative(),
  fallbackChunks: z.number().int().nonnegative(),
  nonCodeChunks: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
  lastUpdated: z.string().nullable(),
  vecVersion: z.string().nullable(),
  reason: z.string().optional(),
});

export type BaseStats = z.infer<typeof baseStatsSchema>;

/**
 * Full state: the index plus the progress of the current background job. Merged in
 * one place so the status cannot come back half populated.
 */
export const indexStatsSchema = baseStatsSchema.extend({
  running: z.boolean(),
  phase: z.enum(['idle', 'scanning', 'chunking', 'embedding', 'done', 'failed']),
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
});

export type IndexStats = z.infer<typeof indexStatsSchema>;

/**
 * `degraded` says a subsystem failed, not that there is nothing to search yet. An
 * index that was never built has to be reported as not ready, but nothing broke:
 * calling that a failure sends the reader looking for a fault that is not there.
 *
 * `nonCodeChunks` is the part of `fallbackChunks` that tree-sitter cannot parse by
 * design (markdown, json, yaml, toml). The remainder is a real fallback — a grammar
 * that failed or a language with no grammar at all — and that is what ADR-010 makes
 * visible, so it is reported on its own rather than folded into one number.
 */
export const emptyBaseStats = (
  reason: string,
  vecVersion: string | null = null,
  degraded = true,
): BaseStats => ({
  ready: false,
  degraded,
  files: 0,
  chunks: 0,
  stale: 0,
  skipped: 0,
  astChunks: 0,
  fallbackChunks: 0,
  nonCodeChunks: 0,
  embedded: 0,
  reused: 0,
  lastUpdated: null,
  vecVersion,
  reason,
});