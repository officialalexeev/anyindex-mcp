import type { DatabaseHandle } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('references');

/**
 * Lexical search for mentions of an identifier, NOT a call graph.
 *
 * There is no name resolution here: `Charge` in a foreign class or inside a string
 * ends up in the results just like a real call. That follows from `code-chunk`
 * exposing entities, scope and imports but not call edges, and building name
 * resolution is exactly the work ADR-004 handed to the external
 * `tree-sitter-analyzer`. The tool is therefore named `find_references` and not
 * `call_graph`, and every answer states plainly that the matches are lexical.
 */
export type ReferenceKind = 'reference' | 'definition';

export interface DefinitionHit {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  kind: string;
  signature: string | null;
}

export interface ReferenceHit {
  filePath: string;
  /** Lines inside the chunk where the identifier occurs, not the chunk boundaries. */
  lines: number[];
  snippet: string;
}

export interface ReferencesOutcome {
  symbol: string;
  definitions: DefinitionHit[];
  references: ReferenceHit[];
  /** Chunks where the identifier occurred, before the limit cut anything. */
  matchedChunks: number;
  truncated: boolean;
  /** Matches outside the requested file — useful to see that the filter hid something. */
  otherFiles: number;
}

export interface FindReferencesOptions {
  file?: string;
  includeDefinitions?: boolean;
  maxResults?: number;
}

interface EntityRow {
  name?: string;
  type?: string;
  signature?: string | null;
  lineStart?: number;
  lineEnd?: number;
}

const DEFAULT_LIMIT = 25;

/**
 * FTS5 treats quotes and operators as syntax, so user input like `a->b` fails to
 * parse. The identifier is quoted and becomes a literal.
 */
function toLiteralFtsQuery(symbol: string): string {
  return `"${symbol.replace(/"/g, '""')}"`;
}

/**
 * The identifier as a standalone token. `\b` in JavaScript does not work with
 * non-ASCII letters, and TypeScript and Python names are full of them, so the
 * boundaries are set explicitly.
 */
function identifierPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
}

export function findReferences(
  db: DatabaseHandle,
  symbol: string,
  options: FindReferencesOptions = {},
): ReferencesOutcome {
  const trimmed = symbol.trim();
  const limit = options.maxResults ?? DEFAULT_LIMIT;
  const includeDefinitions = options.includeDefinitions ?? true;
  const empty: ReferencesOutcome = {
    symbol: trimmed,
    definitions: [],
    references: [],
    matchedChunks: 0,
    truncated: false,
    otherFiles: 0,
  };

  if (trimmed === '') return empty;

  let rows: Array<{
    id: number;
    file_path: string;
    line_start: number;
    line_end: number;
    entity_name: string | null;
    entities: string;
    text: string;
  }>;
  try {
    rows = db
      .prepare(`
        SELECT c.id, c.file_path, c.line_start, c.line_end, c.entity_name, c.entities, c.text
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)
      `)
      .all(toLiteralFtsQuery(trimmed)) as typeof rows;
  } catch (error) {
    // A query that fails to parse must not take the tool down: the symbol may have
    // contained FTS5 syntax. An empty result is more honest than an error, but it
    // must not be silent.
    log.warn('reference query failed', {
      symbol: trimmed,
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }

  const pattern = identifierPattern(trimmed);
  const references: ReferenceHit[] = [];
  // Chunks overlap by 10 lines, so the same function lands in several chunks and
  // would be defined three times in a row without deduplication. The key is the file
  // plus the entity bounds: code-chunk overlaps on a shared boundary, so the ranges
  // match.
  const byDefinition = new Map<string, DefinitionHit>();
  let otherFiles = 0;

  for (const row of rows) {
    if (options.file !== undefined && row.file_path !== options.file) {
      otherFiles += 1;
      continue;
    }

    let entities: EntityRow[] = [];
    try {
      entities = JSON.parse(row.entities) as EntityRow[];
    } catch {
      entities = [];
    }

    // Declaration lines are cut out of the references: "where is X used" must not
    // answer "where X is declared" — that has its own section of the answer.
    const declarationLines = new Set<number>();
    for (const entity of entities) {
      if (entity.name !== trimmed) continue;
      const from = entity.lineStart ?? row.line_start;
      const to = entity.lineEnd ?? row.line_end;
      for (let n = from; n <= to; n += 1) declarationLines.add(n);

      const key = `${row.file_path}:${from}:${to}`;
      const existing = byDefinition.get(key);
      if (existing === undefined) {
        byDefinition.set(key, {
          filePath: row.file_path,
          lineStart: from,
          lineEnd: to,
          kind: entity.type ?? 'unknown',
          signature: entity.signature ?? null,
        });
      } else if (existing.signature === null && entity.signature != null) {
        // An overlapping chunk does not always carry the signature: the head of a
        // function has one, the tail may not. bm25 order does not guarantee that the
        // complete record arrives first, so the signature is written into the
        // accumulated entry instead of being dropped along with the duplicate.
        existing.signature = entity.signature;
        if (existing.kind === 'unknown') existing.kind = entity.type ?? 'unknown';
      }
    }

    // A chunk with a definition also lands in the references: a function may
    // contain recursive calls, and such a chunk cannot be dropped entirely.
    const lines = row.text.split('\n');
    const hitLines: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const n = row.line_start + i;
      if (declarationLines.has(n)) continue;
      if (pattern.test(lines[i] ?? '')) hitLines.push(n);
    }
    if (hitLines.length === 0) continue;

    const shown = hitLines.slice(0, 6);
    references.push({
      filePath: row.file_path,
      lines: hitLines.slice(0, 40),
      snippet: shown.map((n) => `${n}: ${(lines[n - row.line_start] ?? '').trim()}`).join('\n'),
    });
  }

  const truncated = references.length > limit;
  return {
    symbol: trimmed,
    definitions: includeDefinitions ? [...byDefinition.values()] : [],
    references: references.slice(0, limit),
    matchedChunks: rows.length,
    truncated,
    otherFiles,
  };
}