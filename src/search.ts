import type { DatabaseHandle } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('search');

const RRF_K = 60;

/**
 * Documentation gets a reduced weight but still shows up in the results.
 *
 * Measured on 520 questions from three third-party repositories: markdown was top-1
 * in 25 % of cases and the most frequent cause of a miss, because both the question
 * and the documentation are written in natural language, and a README chunk sits
 * closer to the question than the code does.
 * The weight of 0.9 is a tie-breaker, not a ban: it never pushes documentation below
 * an explicitly better match and does not change hit@1 on queries whose answer lives
 * in the documentation (checked separately, 8 such queries). Lower weights kept
 * improving the metric on a corpus where markdown is never the answer
 * (0 out of 520) while breaking those queries — that fits the prior
 * "documentation is never needed" instead of improving anything.
 */
const DOCUMENTATION_WEIGHT = 0.9;

/**
 * At most one chunk per file.
 *
 * The tool returns topK chunks, not topK files: a large file used to take two or
 * three slots with different chunks and push other candidates out — in 23.7 % of
 * questions the top-3 covered fewer than three unique files. Allowing duplicates
 * raised hit@3 from 0.467 to 0.508 without changing the ranking. For the details
 * inside a file the agent goes through get_file_outline and Read, which have their
 * own tools.
 */
const MAX_CHUNKS_PER_FILE = 1;

const isDocumentation = (language: string): boolean => language === 'markdown';

/** A candidate from one search branch, with its rank. */
interface RankedId {
  id: number;
  rank: number;
  distance?: number;
}

/**
 * No distance cutoff is applied. Measured on seven queries the top-1 distances were
 * 0.858 / 1.043 / 1.165 for relevant matches and
 * 1.200 / 1.247 / 1.249 / 1.313 for irrelevant ones — a 3% gap is too narrow.
 * A threshold of ~1.18 also cuts off the correct answer to a Russian query
 * ("how does a user log in", 1.201). Instead of cutting, the distance and a coarse
 * confidence estimate are handed to the model: the "trust or double-check" decision
 * stays with it.
 */
// Calibration on 17 benchmark queries (src/benchmark.ts):
//   positive top-1: 0.707 0.862 0.871 0.886 0.950 0.969 1.002 1.014
//                   1.047 1.056 1.096 1.134 1.146 1.179
//   negative:       1.089 1.226 1.288
// No threshold separates the two sets: 1.089 (negative) sits below 1.134 (positive).
// The thresholds are therefore shifted down and chosen asymmetrically: labelling a
// positive as "weak" is safe — the result is returned either way, only a warning is
// added — while dropping a negative is dangerous, because the model would take it
// for an answer.
const STRONG_DISTANCE = 0.95;
const MODERATE_DISTANCE = 1.10;

function confidenceOf(distance: number | null): Confidence {
  // A chunk found lexically has no distance, and nothing to judge it by.
  // The middle label is neutral: the result is still shown, but render.ts prints
  // neither distance nor confidence for it, so no false estimate leaks out.
  if (distance === null) return 'moderate';
  if (distance < STRONG_DISTANCE) return 'strong';
  if (distance < MODERATE_DISTANCE) return 'moderate';
  return 'weak';
}

export type SearchMode = 'hybrid' | 'semantic' | 'keyword';

export type SearchSource = 'vector' | 'keyword';

export type Confidence = 'strong' | 'moderate' | 'weak';

export interface SearchHit {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  entityName: string | null;
  language: string;
  text: string;
  score: number;
  /** Cosine distance to the query; null if the chunk was found by text alone. */
  distance: number | null;
  confidence: Confidence;
  sources: SearchSource[];
}

export interface SearchOutcome {
  hits: SearchHit[];
  vectorCandidates: number;
  keywordCandidates: number;
}

const toBlob = (vector: Float32Array): Buffer => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

/**
 * FTS5 treats quotes and operators as syntax, so a user query like `auth->login` or
 * `Foo::bar()` fails to parse. Every token is quoted, which turns them into literals.
 */
export function toFtsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 1)
    .slice(0, 24);

  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

function semanticCandidates(
  db: DatabaseHandle,
  vector: Float32Array,
  limit: number,
  language?: string,
): RankedId[] {
  const statement = language === undefined
    ? db.prepare('SELECT chunk_id AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?')
    : db.prepare('SELECT chunk_id AS id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ? AND language = ?');

  const rows = (language === undefined
    ? statement.all(toBlob(vector), limit)
    : statement.all(toBlob(vector), limit, language)) as Array<{ id: number; distance: number }>;
  return rows.map((row, index) => ({ id: row.id, rank: index + 1, distance: row.distance }));
}

function keywordCandidates(db: DatabaseHandle, query: string, limit: number): RankedId[] {
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery === '') return [];

  try {
    const rows = db
      .prepare(`
        SELECT rowid AS id FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY bm25(chunks_fts)
        LIMIT ?
      `)
      .all(ftsQuery, limit) as Array<{ id: number }>;
    return rows.map((row, index) => ({ id: row.id, rank: index + 1 }));
  } catch (error) {
    // A query that fails to parse is no reason to take search down: the vector
    // branch keeps working and the failure goes to the log.
    log.warn('fts query failed', { query, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

interface FusedEntry {
  score: number;
  distance: number | null;
  sources: Set<SearchSource>;
}

interface RankedGroup {
  source: SearchSource;
  ranked: RankedId[];
}

interface ChunkRow {
  id: number;
  file_path: string;
  line_start: number;
  line_end: number;
  entity_name: string | null;
  language: string;
  text: string;
}

interface RankedChunk {
  row: ChunkRow;
  score: number;
  distance: number | null;
  sources: Set<SearchSource>;
}

/**
 * The source is set by the caller instead of derived from the group's position: in
 * keyword mode there is no vector group, and a label by index would call the lexical
 * matches vector ones.
 */
function fuse(groups: RankedGroup[], distances: Map<number, number>): Map<number, FusedEntry> {
  const fused = new Map<number, FusedEntry>();

  for (const { source, ranked } of groups) {
    for (const { id, rank } of ranked) {
      const existing = fused.get(id);
      const contribution = 1 / (RRF_K + rank);

      if (existing === undefined) {
        fused.set(id, { score: contribution, distance: distances.get(id) ?? null, sources: new Set([source]) });
      } else {
        existing.score += contribution;
        existing.sources.add(source);
      }
    }
  }

  return fused;
}

export function searchChunks(
  db: DatabaseHandle,
  query: string,
  vector: Float32Array | null,
  topK: number,
  mode: SearchMode = 'hybrid',
): SearchOutcome {
  const poolSize = Math.max(topK * 4, 20);
  const useVector = vector !== null && (mode === 'hybrid' || mode === 'semantic');
  const useKeyword = mode === 'hybrid' || mode === 'keyword';

  if (mode !== 'hybrid' && useVector === false && useKeyword === false) {
    return { hits: [], vectorCandidates: 0, keywordCandidates: 0 };
  }

  const vectorIds = useVector && vector !== null ? semanticCandidates(db, vector, poolSize) : [];
  const keywordIds = useKeyword ? keywordCandidates(db, query, poolSize) : [];

  if (vectorIds.length === 0 && keywordIds.length === 0) {
    return { hits: [], vectorCandidates: 0, keywordCandidates: 0 };
  }

  const groups: RankedGroup[] = [];
  if (vectorIds.length > 0) groups.push({ source: 'vector', ranked: vectorIds });
  if (keywordIds.length > 0) groups.push({ source: 'keyword', ranked: keywordIds });

  const distances = new Map<number, number>();
  for (const item of vectorIds) {
    if (item.distance !== undefined) distances.set(item.id, item.distance);
  }
  const fused = fuse(groups, distances);

  // More candidates than the results need: the one-chunk-per-file limit and the
  // documentation weight drop part of the sorted list, so slicing to topK before
  // filtering could come up short.
  const candidates = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, poolSize);
  if (candidates.length === 0) return { hits: [], vectorCandidates: 0, keywordCandidates: 0 };

  const placeholders = candidates.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT id, file_path, line_start, line_end, entity_name, language, text
      FROM chunks
      WHERE id IN (${placeholders})
    `)
    .all(...candidates.map(([id]) => id)) as ChunkRow[];

  const byId = new Map(rows.map((row) => [row.id, row]));

  // The weighted rank is computed after the rows are read: the chunk's language is
  // only known there. Sorting by raw RRF and reporting the weight in the score field
  // would not do: that makes the documentation penalty change only the number next
  // to the result, not the order, which is not what it is there for.
  const ranked: RankedChunk[] = [];
  for (const [id, entry] of candidates) {
    const row = byId.get(id);
    if (row === undefined) continue;
    ranked.push({
      row,
      score: isDocumentation(row.language) ? entry.score * DOCUMENTATION_WEIGHT : entry.score,
      distance: entry.distance,
      sources: entry.sources,
    });
  }
  ranked.sort((a, b) => b.score - a.score);

  const hits: SearchHit[] = [];
  const perFile = new Map<string, number>();
  for (const { row, score, distance, sources } of ranked) {
    if (hits.length >= topK) break;

    const used = perFile.get(row.file_path) ?? 0;
    if (used >= MAX_CHUNKS_PER_FILE) continue;
    perFile.set(row.file_path, used + 1);

    hits.push({
      filePath: row.file_path,
      lineStart: row.line_start,
      lineEnd: row.line_end,
      entityName: row.entity_name,
      language: row.language,
      text: row.text,
      // The ranking weight, not the raw RRF: it is what decided the position of the
      // result, and hiding it from the model would show a number that does not
      // explain the order of the results. The distance stays untouched — confidence
      // is computed from it, and the weight penalty must not pass documentation off
      // as a distant match.
      score: Number(score.toFixed(6)),
      distance: distance === null ? null : Number(distance.toFixed(4)),
      confidence: confidenceOf(distance),
      sources: [...sources],
    });
  }

  return { hits, vectorCandidates: vectorIds.length, keywordCandidates: keywordIds.length };
}
