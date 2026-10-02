// Separating the two causes that merged in §18: language and corpus size.
//
// flask (Python, 439 chunks) gives hit@3 0.711, gson (Java, 1628) — 0.473,
// fastify (JavaScript, 2574) — 0.328. The score scales with the number of chunks,
// while answer reachability is nearly the same across the corpora, so neither the
// "worse questions" nor the "worse chunks" explanation fits. Scale is left, but it
// can only be checked by a controlled experiment: trim Java down to the size of
// Python and see whether the quality grows.
//
// node scripts/scale-control.mjs
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db.js';
import { Embedder } from '../dist/embedder.js';
import { embedMissing } from '../dist/index-service.js';
import { indexRepository } from '../dist/indexer.js';
import { searchChunks } from '../dist/search.js';

const TMP = process.env.TEMP ?? '.';
const BASE = path.join(TMP, 'opencode', 'bench-corpus');
const MODELS = path.resolve('.anyindex/models');
const TARGET_CHUNKS = 450;

const log = (...p) => process.stderr.write(`${p.join(' ')}\n`);
const hit = (r, k) => r !== null && r < k;

/**
 * Picks whole directories until about TARGET_CHUNKS chunks are reached. By
 * directory and not file by file: picking individual files would break imports and
 * would look unnatural to the indexer.
 */
function pickSubset(sourceDb) {
  const perFile = sourceDb
    .prepare('SELECT file_path, COUNT(*) AS n FROM chunks GROUP BY file_path')
    .all();
  const counts = new Map(perFile.map((r) => [r.file_path, r.n]));

  // Grouping by the directory of the file and not by the first four path segments:
  // files in the root (`index.js`) fall into no depth-4 prefix at all, and the
  // subset came out empty.
  const byDir = new Map();
  for (const [file, n] of counts) {
    const dir = path.posix.dirname(file);
    byDir.set(dir, (byDir.get(dir) ?? 0) + n);
  }

  const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]);
  const chosenDirs = [];
  let total = 0;
  for (const [d, n] of dirs) {
    if (total >= TARGET_CHUNKS) break;
    chosenDirs.push(d);
    total += n;
  }

  const prefixes = chosenDirs
    .filter((d) => d !== '.')
    .map((d) => `${d}/`)
    .sort((a, b) => b.length - a.length);
  const inRoot = chosenDirs.includes('.');

  const files = [...counts.keys()]
    .filter((f) => {
      const dir = path.posix.dirname(f);
      if (dir === '.') return inRoot;
      return chosenDirs.includes(dir);
    })
    .sort();

  return { files, total, dirs: chosenDirs.length };
}

async function runOne(name, sourceDir, corpusName, vectors) {
  const sourceDbPath = path.join(sourceDir, '.anyindex', 'bench.db');
  const sourceDb = openDatabase(sourceDbPath).db;
  const { files, total } = pickSubset(sourceDb);

  const json = JSON.parse(readFileSync(path.join(TMP, `bench-${corpusName}.json`), 'utf8'));

  // Questions whose expected answer lies entirely inside the subset: there is nothing
  // to measure otherwise, the answer is physically absent from the trimmed index.
  const keep = new Set(files);
  const questions = [];
  const vecs = [];
  json.perQuestion.forEach((q, i) => {
    if (q.expectFiles.every((f) => keep.has(f))) {
      questions.push(q);
      vecs.push(vectors[i] === null ? null : new Float32Array(vectors[i]));
    }
  });

  // THE SAME questions as on the full index. Otherwise different sets are compared,
  // and the gap in hit@3 is explained by the change of questions, not by the size.
  const score = (db) => {
    let h1 = 0, h3 = 0, h10 = 0;
    for (let i = 0; i < questions.length; i += 1) {
      const outcome = searchChunks(db, questions[i].query, vecs[i], 10, 'hybrid');
      const filesOut = outcome.hits.map((h) => h.filePath);
      const at = filesOut.findIndex((f) => questions[i].expectFiles.includes(f));
      const rank = at === -1 ? null : at;
      if (hit(rank, 1)) h1 += 1;
      if (hit(rank, 3)) h3 += 1;
      if (hit(rank, 10)) h10 += 1;
    }
    const n = questions.length;
    return { n, h1: h1 / n, h3: h3 / n, h10: h10 / n };
  };

  log(`${name}: ${files.length} files, ~${total} chunks, ${questions.length} questions`);

  const work = mkdtempSync(path.join(tmpdir(), `aidx-scale-${name}-`));
  let subsetChunks = 0;
  const onSubset = { n: 0, h1: 0, h3: 0, h10: 0 };
  const onFull = { n: 0, h1: 0, h3: 0, h10: 0 };
  const fullChunks = sourceDb.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  try {
    for (const rel of files) {
      const target = path.join(work, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(sourceDir, rel), target);
    }

    const config = loadConfig({ root: work, dbPath: path.join(work, '.anyindex', 'index.db'), modelsDir: MODELS });
    const embedder = new Embedder(config);
    try {
      const pass = await indexRepository(config);
      subsetChunks = pass.chunksWritten;

      const { db } = openDatabase(config.dbPath);
      await embedMissing(db, config, embedder, {});
      Object.assign(onSubset, score(db));
      db.close();
    } finally {
      await embedder.close();
    }

    // The same question on the full index — the base for the comparison.
    Object.assign(onFull, score(sourceDb));
  } finally {
    rmSync(work, { recursive: true, force: true });
    sourceDb.close();
  }

  return { name, chunks: subsetChunks, fullChunks, onSubset, onFull };
}

async function main() {
  const cachePath = path.join(TMP, 'bench-query-vectors.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  if (cache === null) {
    log('no vector cache: run bench-external first');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const [name, dir, corpus] of [
    ['gson', 'gson', 'gson'],
    ['fastify', 'fastify', 'fastify'],
  ]) {
    const sourceDir = path.resolve(BASE, dir);
    if (!existsSync(path.join(sourceDir, '.anyindex', 'bench.db'))) { log(`${name}: no index`); continue; }
    results.push(await runOne(name, sourceDir, corpus, cache[corpus] ?? []));
  }

  log('\n=== the same questions, two index sizes ===');
  log('corpus    index    chunks   questions  hit@1   hit@3   hit@10');
  for (const r of results) {
    if (r.onSubset.n === 0) { log(`${r.name}: subset not collected`); continue; }
    log(
      `${r.name.padEnd(9)}  full     ${String(r.fullChunks).padStart(6)}   ${String(r.onFull.n).padStart(8)}` +
      `  ${r.onFull.h1.toFixed(3)}   ${r.onFull.h3.toFixed(3)}   ${r.onFull.h10.toFixed(3)}`,
    );
    log(
      `${''.padEnd(9)}  trimmed  ${String(r.chunks).padStart(6)}   ${String(r.onSubset.n).padStart(8)}` +
      `  ${r.onSubset.h1.toFixed(3)}   ${r.onSubset.h3.toFixed(3)}   ${r.onSubset.h10.toFixed(3)}`,
    );
    log(`${''.padEnd(9)}  delta         ${String(r.chunks - r.fullChunks).padStart(6)}          ` +
      `  ${(r.onSubset.h1 - r.onFull.h1 >= 0 ? '+' : '')}${(r.onSubset.h1 - r.onFull.h1).toFixed(3)}` +
      `  ${(r.onSubset.h3 - r.onFull.h3 >= 0 ? '+' : '')}${(r.onSubset.h3 - r.onFull.h3).toFixed(3)}` +
      `   ${(r.onSubset.h10 - r.onFull.h10 >= 0 ? '+' : '')}${(r.onSubset.h10 - r.onFull.h10).toFixed(3)}`);
  }
  log('\nflask (Python, 439 chunks) — small-corpus reference:  hit@1 0.584  hit@3 0.711  hit@10 0.827');
}

await main();