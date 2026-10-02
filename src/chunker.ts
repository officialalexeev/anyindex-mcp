import path from 'node:path';

import { NON_CODE_FILES } from './config.js';
import { createChunker, detectLanguage } from 'code-chunk';

import { createLogger } from './logger.js';

const log = createLogger('chunker');

export interface RawChunk {
  text: string;
  contextualizedText: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  entityName: string | null;
  scopeChain: Array<{ name: string; type: string }>;
  imports: string[];
  entities: Array<{ name: string; type: string; signature: string | null; lineStart: number; lineEnd: number }>;
  contentHash: string;
  source: 'ast' | 'fallback';
}

export interface ChunkOutcome {
  chunks: RawChunk[];
  strategy: 'ast' | 'fallback';
}

const hashOf = (value: string): string => {
  // No sha1 via dynamic import: incrementality compares text hashes, and
  // cryptographic strength buys nothing here.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** code-chunk returns 0-based ranges; what we hand out is 1-based, like in an editor. */
const toOneBased = (line: number): number => line + 1;

const astChunker = createChunker({
  maxChunkSize: 1500,
  contextMode: 'full',
  siblingDetail: 'signatures',
  overlapLines: 10,
});

const FALLBACK_EXTENSIONS = new Set(NON_CODE_FILES.map((file) => file.extension));

function primaryEntity(
  entities: ReadonlyArray<{ name: string; type: string }>,
  scope: ReadonlyArray<{ name: string }>,
): string | null {
  const defined = entities.filter((e) => e.type !== 'import');
  const named = defined.find((e) => e.type === 'function' || e.type === 'method' || e.type === 'class');
  if (named !== undefined) return named.name;
  if (defined.length > 0) return defined[0]?.name ?? null;
  return scope.length > 0 ? (scope[scope.length - 1]?.name ?? null) : null;
}

function chunkWithAst(relPath: string, content: string): Promise<RawChunk[]> {
  const language = detectLanguage(relPath);

  return astChunker.chunk(relPath, content).then((chunks) =>
    chunks.map((chunk) => {
      const { context } = chunk;
      return {
        text: chunk.text,
        contextualizedText: chunk.contextualizedText,
        lineStart: toOneBased(chunk.lineRange.start),
        lineEnd: toOneBased(chunk.lineRange.end),
        language: context.language ?? language ?? 'unknown',
        entityName: primaryEntity(context.entities, context.scope),
        scopeChain: context.scope.map((s) => ({ name: s.name, type: s.type })),
        imports: context.imports.map((i) => i.source),
        entities: context.entities
          .filter((e) => e.type !== 'import' && e.lineRange !== undefined)
          .map((e) => ({
            name: e.name,
            type: e.type,
            signature: e.signature ?? null,
            lineStart: toOneBased(e.lineRange?.start ?? 0),
            lineEnd: toOneBased(e.lineRange?.end ?? 0),
          })),
        contentHash: hashOf(chunk.text),
        source: 'ast' as const,
      };
    }),
  );
}

/**
 * Fallback path for extensions tree-sitter cannot parse. Cuts on structural
 * boundaries rather than at an arbitrary character count, and always records
 * where the chunk came from — per ADR-010 a call to this path has to be visible
 * in index_status instead of looking like a real indexing pass.
 */
function chunkWithFallback(relPath: string, content: string, maxBytes: number): RawChunk[] {
  const lines = content.split('\n');
  const isMarkdown = path.extname(relPath).toLowerCase() === '.md';
  const breakpoints: number[] = isMarkdown ? collectHeadingLines(lines) : [];
  const chunks: RawChunk[] = [];

  let buffer: string[] = [];
  let bufferBytes = 0;
  let startLine = 1;
  let lastHeading: string | null = null;

  const flush = (endLine: number) => {
    const text = buffer.join('\n');
    if (text.trim() === '') return;
    // A table of contents or a nested heading with no body: the chunk holds no
    // content and surfaces in results only as a section title line. The exception
    // is a file made of headings alone, where nothing would be left at all.
    if (!buffer.some(isBodyLine) && chunks.length > 0) return;
    // The section heading is taken from the start of the chunk only if a heading
    // really is there. A chunk that began because of the size limit sits in the
    // middle of a section, and without this check its "title" became a line of
    // prose or the body of a fenced block.
    const own = isMarkdown ? lines[startLine - 1]?.trim() : undefined;
    const heading = own !== undefined && HEADING_PATTERN.test(own) ? own : lastHeading;
    const sectionTitle = heading === undefined || heading === null ? null : heading.replace(/^#+\s*/, '');
    const contextHeader = [
      `# ${relPath}`,
      sectionTitle !== null ? `# Section: ${sectionTitle}` : null,
    ]
      .filter((v): v is string => v !== null)
      .join('\n');

    chunks.push({
      text,
      contextualizedText: `${contextHeader}\n\n${text}`,
      lineStart: startLine,
      lineEnd: endLine,
      language: isMarkdown ? 'markdown' : path.extname(relPath).slice(1).toLowerCase(),
      entityName: sectionTitle ?? path.basename(relPath),
      scopeChain: [],
      imports: [],
      entities: [
        {
          name: sectionTitle ?? path.basename(relPath),
          type: isMarkdown ? 'section' : 'block',
          signature: null,
          lineStart: startLine,
          lineEnd: endLine,
        },
      ],
      contentHash: hashOf(text),
      source: 'fallback',
    });

    buffer = [];
    bufferBytes = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineBytes = Buffer.byteLength(line) + 1;

    // A heading opens a chunk rather than closing the current one. Otherwise
    // nested headings with no body produce single-line chunks, and the next
    // section's heading is glued onto the end of the previous chunk.
    if (breakpoints.includes(i)) {
      if (buffer.some(isBodyLine)) flush(i);
      buffer = [line];
      bufferBytes = lineBytes;
      startLine = i + 1;
      lastHeading = line.trim();
      continue;
    }

    if (bufferBytes + lineBytes > maxBytes && buffer.length > 0) {
      flush(i);
      startLine = i + 1;
    } else if (buffer.length === 0) {
      startLine = i + 1;
    }

    buffer.push(line);
    bufferBytes += lineBytes;
  }
  flush(lines.length);

  return chunks;
}

const HEADING_PATTERN = /^#{1,6}\s+\S/;

function isBodyLine(line: string): boolean {
  return line.trim() !== '' && !HEADING_PATTERN.test(line);
}

function collectHeadingLines(lines: string[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    if (HEADING_PATTERN.test(lines[i] ?? '')) result.push(i);
  }
  return result;
}

export async function chunkFile(relPath: string, content: string, maxBytes = 1500): Promise<ChunkOutcome> {
  const extension = path.extname(relPath).toLowerCase();
  const astSupported = detectLanguage(relPath) !== null && !FALLBACK_EXTENSIONS.has(extension);

  if (astSupported) {
    try {
      const chunks = await chunkWithAst(relPath, content);
      if (chunks.length > 0) return { chunks, strategy: 'ast' };
      log.warn('ast chunking produced nothing', { relPath });
    } catch (error) {
      // code-chunk throws an Effect error named FiberFailureImpl, which says
      // nothing useful. This is where the silent refusal becomes visible: the
      // chunks are marked fallback and land in the index counters.
      log.warn('ast chunking failed, falling back', {
        relPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { chunks: chunkWithFallback(relPath, content, maxBytes), strategy: 'fallback' };
}
