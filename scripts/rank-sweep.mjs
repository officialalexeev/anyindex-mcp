// Sweep of ranking strategies over the already built indexes of three corpora.
//
// Both changes (the markdown weight, per-file deduplication) live in the ranking
// layer, not in the embedding, so they are checked on the already built indexes
// without recomputing any vectors: the same 520 questions as scripts/bench-external.mjs.
//
// node scripts/rank-sweep.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db.js';
import { Embedder } from '../dist/embedder.js';
import { searchChunks } from '../dist/search.js';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const POOL = 40;
const TMP = process.env.TEMP ?? '.';
const BASE = path.join(TMP, 'opencode', 'bench-corpus');
const CORPORA = { flask: 'flask', gson: 'gson', fastify: 'fastify' };

const log = (...p) => process.stderr.write(`${p.join(' ')}\n`);

// Markdown chunks are cut at headings and in natural language sit closer to a
// natural-language question than code does. That is a prior, not a truth: the
// behaviour changes at other weights, so sweep them.
const isDoc = (filePath) => /\.(md|markdown)$/i.test(filePath);

function select(hits, k, { cap, docWeight }) {
  const scored = hits
    .map((h) => ({ ...h, weighted: h.score * (isDoc(h.filePath) ? docWeight : 1) }))
    .sort((a, b) => b.weighted - a.weighted);

  const out = [];
  const perFile = new Map();
  for (const h of scored) {
    if (out.length >= k) break;
    const used = perFile.get(h.filePath) ?? 0;
    if (used >= cap) continue;
    perFile.set(h.filePath, used + 1);
    out.push(h);
  }
  return out;
}

const hitAt = (rank, k) => rank !== null && rank !== -1 && rank < k;
const mrrOf = (rank) => (rank === null || rank === -1 ? 0 : 1 / (rank + 1));

function evaluate(rows, variant) {
  let h1 = 0, h3 = 0, h5 = 0, mrr = 0;
  for (const r of rows) {
    const files = select(r.pool, 5, variant).map((h) => h.filePath);
    const at = files.findIndex((f) => r.expectFiles.includes(f));
    const rank = at === -1 ? null : at;
    if (rank === 0) h1 += 1;
    if (hitAt(rank, 3)) h3 += 1;
    if (hitAt(rank, 5)) h5 += 1;
    mrr += mrrOf(rank);
  }
  const n = rows.length;
  return { hit1: h1 / n, hit3: h3 / n, hit5: h5 / n, mrr: mrr / n };
}

const VECTORS_CACHE = path.join(TMP, 'bench-query-vectors.json');

async function main() {
  const embedder = new Embedder(loadConfig({
    modelsDir: argOfModels(),
  }));

  let cache;
  if (existsSync(VECTORS_CACHE)) cache = JSON.parse(readFileSync(VECTORS_CACHE, 'utf8'));

  const rows = [];
  try {
    for (const [name, dir] of Object.entries(CORPORA)) {
      const jsonPath = path.join(TMP, `bench-${name}.json`);
      if (!existsSync(jsonPath)) { log(`${name}: no run, skipping`); continue; }
      const json = JSON.parse(readFileSync(jsonPath, 'utf8'));

      const config = loadConfig({
        root: path.resolve(BASE, dir),
        dbPath: path.resolve(BASE, dir, '.anyindex', 'bench.db'),
        modelsDir: argOfModels(),
      });
      const { db } = openDatabase(config.dbPath);

      const questions = json.perQuestion.map((r) => r.query);
      cache ??= {};
      if (cache[name] === undefined) {
        log(`${name}: computing query vectors (${questions.length})...`);
        const vecs = [];
        for (let i = 0; i < questions.length; i += 16) {
          const batch = await embedder.embed(questions.slice(i, i + 16));
          for (const v of batch) vecs.push(v === null ? null : Array.from(v));
        }
        cache[name] = vecs;
        writeFileSync(VECTORS_CACHE, JSON.stringify(cache));
      }
      const vecs = cache[name];

      for (let i = 0; i < json.perQuestion.length; i += 1) {
        const r = json.perQuestion[i];
        const vector = vecs[i] === null ? null : new Float32Array(vecs[i]);
        const outcome = searchChunks(db, r.query, vector, POOL, 'hybrid');
        rows.push({ corpus: name, expectFiles: r.expectFiles, pool: outcome.hits });
      }
      db.close();
      log(`${name}: candidates collected`);
    }
  } finally {
    await embedder.close();
  }

  const variants = [
    { name: 'as is', cap: Infinity, docWeight: 1.0 },
    { name: 'dedup 1', cap: 1, docWeight: 1.0 },
    { name: 'dedup 1 + doc 0.95', cap: 1, docWeight: 0.95 },
    { name: 'dedup 1 + doc 0.9', cap: 1, docWeight: 0.9 },
    { name: 'dedup 1 + doc 0.8', cap: 1, docWeight: 0.8 },
    { name: 'dedup 1 + doc 0.7', cap: 1, docWeight: 0.7 },
    { name: 'dedup 2 + doc 0.9', cap: 2, docWeight: 0.9 },
    { name: 'dedup 2 + doc 0.8', cap: 2, docWeight: 0.8 },
    { name: 'doc 0.8 (no dedup)', cap: Infinity, docWeight: 0.8 },
  ];

  log(`\n=== pool of ${rows.length} questions, 3 corpora ===`);
  log('variant              hit@1   hit@3   hit@5   MRR');

  const results = variants.map((v) => ({ v, m: evaluate(rows, v) }));

  // A control: the metric cannot exceed 1, and hit@k has to grow with k. An early
  // run counted misses as hits (findIndex returns -1, and -1 < 3) and printed
  // hit@3 = 0.944 against a real 0.473 — the figure looked plausible but was
  // meaningless.
  for (const { v, m } of results) {
    const sane = m.hit1 <= m.hit3 && m.hit3 <= m.hit5 && m.mrr <= 1 && m.hit3 >= 0 && m.hit3 <= 1;
    if (!sane) throw new Error(`metric for "${v.name}" is contradictory: ${JSON.stringify(m)}`);
  }

  for (const { v, m } of results) {
    log(
      `${v.name.padEnd(20)} ${m.hit1.toFixed(3)}   ${m.hit3.toFixed(3)}   ${m.hit5.toFixed(3)}    ${m.mrr.toFixed(3)}`,
    );
  }

  log('\n=== by corpus (hit@3) ===');
  log('variant              flask    gson    fastify');
  for (const v of variants) {
    const cells = Object.keys(CORPORA).map((c) => {
      const sub = rows.filter((r) => r.corpus === c);
      return sub.length === 0 ? '   -  ' : evaluate(sub, v).hit3.toFixed(3).padStart(6);
    });
    log(`${v.name.padEnd(20)} ${cells.join('   ')}`);
  }

  // How many questions expect documentation at all: if there are none, any markdown
  // weight is being measured blind on this corpus.
  const docExpected = rows.filter((r) => r.expectFiles.some(isDoc)).length;
  log(`\nquestions where the correct answer is markdown: ${docExpected} of ${rows.length}`);
}

function argOfModels() {
  const at = process.argv.indexOf('--models');
  return at === -1 ? path.resolve('.anyindex/models') : process.argv[at + 1];
}

await main();