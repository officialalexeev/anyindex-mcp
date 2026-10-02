import type { SearchHit } from './search.js';
import type { IndexStats } from './stats.js';

const MAX_LINES_PER_HIT = 40;
const MAX_CHARS_PER_HIT = 1600;

function truncateHit(text: string): { body: string; cut: boolean } {
  if (text.length <= MAX_CHARS_PER_HIT) return { body: text, cut: false };

  const lines = text.split('\n');
  if (lines.length <= MAX_LINES_PER_HIT) {
    return { body: text, cut: true };
  }

  const kept = lines.slice(0, MAX_LINES_PER_HIT).join('\n');
  return { body: `${kept}\n    … ${lines.length - MAX_LINES_PER_HIT} more lines`, cut: true };
}

export function renderStatus(stats: IndexStats): string {
  if (stats.running) {
    const percent = stats.progress.total > 0 ? Math.round((stats.progress.done / stats.progress.total) * 100) : 0;
    return [
      `Indexing in progress: phase=${stats.phase}, ${stats.progress.done}/${stats.progress.total} (${percent}%).`,
      'Search results may be incomplete or stale until this finishes.',
    ].join('\n');
  }

  if (stats.phase === 'failed') {
    return [
      'Anyindex index FAILED to build.',
      `Error: ${stats.reason ?? 'unknown'}`,
      'anyindex_search is disabled. Do not rely on it until index_update succeeds.',
    ].join('\n');
  }

  if (!stats.ready) {
    const lines = ['Anyindex index is NOT ready.'];
    if (stats.reason !== undefined) lines.push(`Reason: ${stats.reason}`);
    lines.push(
      'Searching now would return nothing or misleading results.',
      'Call index_update or index_rebuild before relying on anyindex_search.',
    );
    return lines.join('\n');
  }

  const parts = [
    `Index ready: ${stats.files} files, ${stats.chunks} chunks, ${stats.stale} stale.`,
  ];
  if (stats.nonCodeChunks < stats.fallbackChunks) {
    const failed = stats.fallbackChunks - stats.nonCodeChunks;
    parts.push(
      `WARNING: ${failed} chunk(s) fell back to structural splitting on a language tree-sitter can parse. ` +
        'Check the "ast chunking failed" lines in the log, then index_rebuild.',
    );
  }
  if (stats.degraded) {
    parts.push('WARNING: a subsystem failed. See the reason in the structured payload.');
  }
  if (stats.lastUpdated !== null) parts.push(`Last updated: ${stats.lastUpdated}.`);
  return parts.join('\n');
}

export function renderResults(
  query: string,
  hits: SearchHit[],
  stats: IndexStats,
  mode: string,
): string {
  const header = [
    `Found ${hits.length} relevant snippet${hits.length === 1 ? '' : 's'} (${mode} search; index: ${stats.files} files, ${stats.stale} stale).`,
  ];

  if (hits.length === 0) {
    return [
      ...header,
      '',
      'No matches in the indexed codebase.',
      `The index covers ${stats.files} files but contains nothing matching "${query}".`,
      'This code may not exist in this repository. Say so plainly rather than guessing',
      'or inventing an implementation.',
    ].join('\n');
  }

  const blocks = hits.map((hit, index) => {
    const { body } = truncateHit(hit.text);
    const label = hit.entityName === null ? hit.language : `${hit.language} · ${hit.entityName}`;
    const foundVia = hit.sources.length > 1 ? ' · semantic+keyword' : ` · ${hit.sources[0] ?? 'match'}`;
    // The distance is shown on purpose: there is no reliable relevance threshold, so
// the model has to see how close the match was before it treats this code as found.
    const proximity = hit.distance === null ? '' : ` · distance ${hit.distance.toFixed(3)} (${hit.confidence})`;

    return [
      `${index + 1}. ${hit.filePath} (lines ${hit.lineStart}–${hit.lineEnd}) · ${label}${foundVia}${proximity}`,
      '',
      body
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n'),
    ].join('\n');
  });

  const weak =
    hits.length > 0 && hits.every((hit) => hit.confidence === 'weak')
      ? [
          '',
          'Every match above is weakly related. Treat them as candidates, not as confirmed answers: re-read them against the question, and if none fits, say the code was not found rather than assuming the closest one is correct.',
        ]
      : [];

  return [...header, '', ...blocks, ...weak].join('\n');
}
