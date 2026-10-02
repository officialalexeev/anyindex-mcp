// Breakdown of the quality loss by language: Python 0.711 → Java 0.473 → JavaScript 0.328.
//
// Two questions that have to be separated:
//   1. Is the answer reachable at all? A commit subject may describe a CHANGE
//      ("rename X to Y") rather than the state of the code — then the file holds none
//      of the words of the question and no search finds it: the ceiling on hit@k.
//   2. If it is reachable, is the problem in the ranking or in the embedding? hybrid,
//      keyword and semantic are compared on the same set.
//
// node scripts/language-diagnosis.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db.js';
import { Embedder } from '../dist/embedder.js';
import { searchChunks } from '../dist/search.js';

const TMP = process.env.TEMP ?? '.';
const BASE = path.join(TMP, 'opencode', 'bench-corpus');
const MODELS = path.resolve('.anyindex/models');

const CORPORA = [
  { name: 'flask', dir: 'flask', language: 'python' },
  { name: 'gson', dir: 'gson', language: 'java' },
  { name: 'fastify', dir: 'fastify', language: 'javascript' },
];

const log = (...p) => process.stderr.write(`${p.join(' ')}\n`);
const hit = (r, k) => r !== null && r < k;
const mrrOf = (r) => (r === null ? 0 : 1 / (r + 1));

/**
 * Ceiling on reachable hit@k: does the expected file hold at least one significant
 * word of the question? Words shorter than three characters and the common ones do
 * not discriminate, so only content words are taken.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then',
  'use', 'using', 'used', 'not', 'but', 'all', 'any', 'out', 'off', 'own',
  'instead', 'rather', 'after', 'before', 'does', 'dont', 'should', 'would',
  'could', 'while', 'were', 'been', 'have', 'has', 'had', 'its', 'are',
  'add', 'added', 'fix', 'fixed', 'make', 'made', 'allow', 'allows', 'only',
  'same', 'more', 'most', 'such', 'than', 'them', 'they', 'can', 'will',
]);

function termsOf(query) {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function answerable(question, expectFiles, dir) {
  const terms = termsOf(question.query);
  if (terms.length === 0) return { answerable: false, matched: 0, terms: 0 };

  let matched = 0;
  for (const rel of expectFiles) {
    const abs = path.join(dir, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8').toLowerCase();
    if (terms.some((t) => text.includes(t))) matched += 1;
  }
  return { answerable: matched > 0, matched, terms: terms.length };
}

async function main() {
  const embedder = new Embedder(loadConfig({ modelsDir: MODELS }));
  const cachePath = path.join(TMP, 'bench-query-vectors.json');
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};

  const report = [];
  try {
    for (const corpus of CORPORA) {
      const jsonPath = path.join(TMP, `bench-${corpus.name}.json`);
      if (!existsSync(jsonPath)) { log(`${corpus.name}: no run`); continue; }
      const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
      const dir = path.resolve(BASE, corpus.dir);

      const config = loadConfig({
        root: dir,
        dbPath: path.join(dir, '.anyindex', 'bench.db'),
        modelsDir: MODELS,
      });
      const { db } = openDatabase(config.dbPath);

      const questions = json.perQuestion.map((r) => r.query);
      if (cache[corpus.name] === undefined) {
        const vecs = [];
        for (let i = 0; i < questions.length; i += 16) {
          const batch = await embedder.embed(questions.slice(i, i + 16));
          for (const v of batch) vecs.push(v === null ? null : Array.from(v));
        }
        cache[corpus.name] = vecs;
        writeFileSync(cachePath, JSON.stringify(cache));
      }
      const vecs = cache[corpus.name];

      const modes = { hybrid: [], keyword: [], semantic: [] };
      const reach = { top10: 0, pool: 0 };
      let answerableCount = 0;

      for (let i = 0; i < json.perQuestion.length; i += 1) {
        const r = json.perQuestion[i];
        const vector = vecs[i] === null ? null : new Float32Array(vecs[i]);

        for (const mode of Object.keys(modes)) {
          const useVector = mode === 'keyword' ? null : vector;
          const outcome = searchChunks(db, r.query, useVector, 10, mode);
          const files = outcome.hits.map((h) => h.filePath);
          const at = files.findIndex((f) => r.expectFiles.includes(f));
          modes[mode].push(at === -1 ? null : at);
        }

        // Reachability: a wide search over the files with no topK limit.
        const wide = searchChunks(db, r.query, vector, 10, 'keyword');
        const wideFiles = new Set(wide.hits.map((h) => h.filePath));
        if (r.expectFiles.some((f) => wideFiles.has(f))) reach.pool += 1;

        const a = answerable(r, r.expectFiles, dir);
        if (a.answerable) answerableCount += 1;
        r.answerable = a.answerable;
      }

      const n = json.perQuestion.length;
      const chunkStats = db.prepare(`
        SELECT language, strategy, COUNT(*) AS n, AVG(LENGTH(text)) AS avg
        FROM chunks GROUP BY language, strategy ORDER BY n DESC
      `).all();

      db.close();

      const m = (ranks) => ({
        h1: ranks.filter((r) => hit(r, 1)).length / n,
        h3: ranks.filter((r) => hit(r, 3)).length / n,
        h10: ranks.filter((r) => hit(r, 10)).length / n,
        mrr: ranks.reduce((s, r) => s + mrrOf(r), 0) / n,
      });

      report.push({
        corpus: corpus.name,
        language: corpus.language,
        n,
        answerable: answerableCount / n,
        reachPool: reach.pool / n,
        hybrid: m(modes.hybrid),
        keyword: m(modes.keyword),
        semantic: m(modes.semantic),
        chunks: chunkStats,
        perQuestion: json.perQuestion.map((q) => ({ q: q.query, a: q.answerable })),
      });
    }
  } finally {
    await embedder.close();
  }

  log('\n=== answer reachability vs found ===');
  log('corpus      language    n   reachable  hit@1   hit@3   hit@10   MRR');
  for (const r of report) {
    log(
      `${r.corpus.padEnd(11)} ${r.language.padEnd(11)} ${String(r.n).padEnd(4)} ${(r.answerable * 100).toFixed(1).padStart(8)}%` +
      `  ${r.hybrid.h1.toFixed(3)}   ${r.hybrid.h3.toFixed(3)}   ${r.hybrid.h10.toFixed(3)}    ${r.hybrid.mrr.toFixed(3)}`,
    );
  }

  log('\n=== hybrid vs keyword vs semantic (hit@3) ===');
  log('corpus      hybrid   keyword  semantic');
  for (const r of report) {
    log(
      `${r.corpus.padEnd(11)} ${r.hybrid.h3.toFixed(3)}    ${r.keyword.h3.toFixed(3)}    ${r.semantic.h3.toFixed(3)}`,
    );
  }

  log('\n=== chunks by corpus ===');
  for (const r of report) {
    const total = r.chunks.reduce((s, c) => s + c.n, 0);
    const code = r.chunks.filter((c) => c.strategy === 'ast');
    const avgCode = total === 0 ? 0 : code.reduce((s, c) => s + c.n * c.avg, 0) / Math.max(1, code.reduce((s, c) => s + c.n, 0));
    const fb = r.chunks.filter((c) => c.strategy === 'fallback').reduce((s, c) => s + c.n, 0);
    log(
      `${r.corpus.padEnd(11)} total ${String(total).padStart(5)}  AST ${String(code.reduce((s, c) => s + c.n, 0)).padStart(5)}` +
      `  fallback ${String(fb).padStart(4)}  mean AST chunk ${avgCode.toFixed(0)} chars.`,
    );
  }

  for (const r of report) {
    const un = r.perQuestion.filter((q) => !q.a).slice(0, 6);
    if (un.length > 0) {
      log(`\n=== ${r.corpus}: unreachable questions (no word of the query in the file) ===`);
      for (const q of un) log(`  "${q.q}"`);
    }
  }
}

await main();