// External quality benchmark on third-party repositories.
//
// The fixture benchmark of our own (src/benchmark.ts) answers the question "did
// anything break", but not the question "are we better than grep". There the
// expected answer is known in advance and sits next to the query in meaning, and
// the corpus fits into 17 files. Here the questions are mined from the commit
// history of third-party repositories: the commit subject is the query, the files
// it changed are the answer. Neither side helped write the key.
//
// The corpus and the pinned commits repeat denfry/codebase-index (Flask, Gson,
// Fastify), so their numbers can be put next to ours.
//
// node scripts/bench-external.mjs --corpus <flask|gson|fastify> [--limit N]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AutoTokenizer, env } from '@huggingface/transformers';

import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db.js';
import { Embedder } from '../dist/embedder.js';
import { embedMissing } from '../dist/index-service.js';
import { indexRepository } from '../dist/indexer.js';
import { searchChunks } from '../dist/search.js';

const INDEXED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.rs', '.go', '.java', '.md', '.json', '.yaml', '.yml', '.toml',
]);

const CORPORA = {
  flask: { dir: 'flask', pin: 'd318b683', pathspec: ['*.py', '*.pyi'] },
  gson: { dir: 'gson', pin: 'b3f4ca20', pathspec: ['*.java'] },
  fastify: { dir: 'fastify', pin: '15ebc8e2', pathspec: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.mts'] },
};

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const WINDOW_LINES = 80;
const TOP_K = 10;
const RESULTS_SHOWN = 3;

function argOf(flag, fallback) {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
}

const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

const TRIVIAL_SUBJECT = /^(fix(ed)?|bug|update[sd]?|wip|todo|cleanup|clean up|minor|misc|typo(s)?|doc(ument)?s?|test(s)?|bump(ed|s)?|release[sd]?|merge[sd]?|revert(ed)?|initial commit|add(ed|s)?|remove[sd]?|delete[sd]?|change[sd]?|rename[sd]?|move[sd]?|new)\b/i;

function toQuestion(subject) {
  return subject
    .trim()
    .replace(/^(feat|fix|docs|doc|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?(!?):\s*/i, '')
    .trim();
}

// The filter is declared up front and applied to every commit in turn, with no
// look at the results: otherwise the question selection would be tuned to the score.
function isUsableQuestion(question) {
  if (question.length < 12 || question.length > 120) return false;
  if (/^\d/.test(question)) return false;
  if (TRIVIAL_SUBJECT.test(question)) return false;
  // An issue number or an author mention makes the subject unreadable as a question.
  // The already cleaned subject is what's tested: otherwise the "fix:" prefix would
  // cut off the whole conventional-commit style, where the readable questions are.
  if (/(#\d+|\s@\w+)/.test(question)) return false;
  // "Bumped v6.0.0-alpha.2" reads as a question only out of naivety.
  if (/\bv?\d+\.\d+/.test(question)) return false;
  return /[a-zA-Z]{3,}/.test(question);
}

function mineQuestions(dir, pathspec) {
  // The format `%x01%H%x1f%s%x1e` puts the file list AFTER \x1e, so records are split
  // by the leading \x01, not by \x1e: the subject is the first line of the field after
  // \x1f, the files the rest of that field plus the tail of the record.
  const raw = git(dir, [
    'log', '--no-merges', '--format=%x01%H%x1f%s%x1e', '--name-only', '--', ...pathspec,
  ]);

  const rejected = {};
  const questions = [];
  const bump = (reason) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };

  for (const chunk of raw.split('\x01')) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;

    const lines = (trimmed.split('\x1f')[1] ?? '').split('\n');
    const query = toQuestion((lines[0] ?? '').replace(/\x1e/g, ''));
    if (!isUsableQuestion(query)) { bump('subject'); continue; }

    const files = lines
      .slice(1)
      .map((f) => f.trim())
      .filter((f) => f !== '' && INDEXED_EXTENSIONS.has(path.extname(f).toLowerCase()));
    if (files.length === 0) { bump('no indexable files'); continue; }
    // More than three files means an ambiguous answer: hitting any one of them does
    // not tell a successful search apart from a lucky guess.
    if (files.length > 3) { bump('more than three files'); continue; }
    if (files.some((f) => !existsSync(path.join(dir, f)))) { bump('file deleted later'); continue; }

    questions.push({ query, expectFiles: files });
  }
  return { questions, rejected, total: raw.split('\x01').length - 1 };
}

function queryTerms(query) {
  return query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 2);
}

// Files are read once per corpus, not once per question: otherwise the baseline
// does "questions × files" reads and on a fast repository runs into the disk harder
// than into the indexing itself.
function loadCorpus(dir, indexedFiles) {
  const cache = new Map();
  for (const rel of indexedFiles) {
    try {
      cache.set(rel, readFileSync(path.join(dir, rel), 'utf8').split('\n'));
    } catch {
      // An unreadable file simply does not take part in the baseline.
    }
  }
  return cache;
}

// The baseline repeats "rg + 80-line windows", but in plain Node: ripgrep may not be
// installed, and its version changes the output and makes runs incomparable.
// Terms are combined with OR — a generous reading for grep: plain rg looks for the
// literal phrase and finds nothing at all on a natural-language question.
function baselineSearch(cache, query, expectFiles) {
  const terms = queryTerms(query);
  if (terms.length === 0) return { rank: null, packets: [], files: [] };

  const expect = new Set(expectFiles);
  const scored = [];

  for (const [rel, lines] of cache) {

    const hitLines = [];
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      if (terms.some((t) => lower.includes(t))) hitLines.push(i);
    }
    if (hitLines.length === 0) continue;

    // A window of exactly WINDOW_LINES, anchored to the match. Merging neighbouring
    // matches into one cluster blew the window up to hundreds of lines and inflated
    // the cost of the baseline several times over — the comparison would come out
    // dishonest in our favour.
    const starts = new Set();
    for (const at of hitLines) starts.add(Math.max(0, Math.min(at - Math.floor(WINDOW_LINES / 2), lines.length - WINDOW_LINES)));

    for (const first of starts) {
      const last = Math.min(lines.length, first + WINDOW_LINES);
      let hits = 0;
      for (const at of hitLines) if (at >= first && at <= last) hits += 1;
      scored.push({
        file: rel,
        hits,
        firstLine: first,
        text: `${rel}\n${lines.slice(first, last).join('\n')}`,
        correct: expect.has(rel),
      });
    }
  }

  scored.sort((a, b) => b.hits - a.hits || a.firstLine - b.firstLine);

  // At most three windows per file: otherwise one large file takes the whole output
  // and the competitor gets an advantage it should not have.
  const perFile = new Map();
  const windows = [];
  for (const w of scored) {
    const seen = perFile.get(w.file) ?? 0;
    if (seen >= 3) continue;
    perFile.set(w.file, seen + 1);
    windows.push(w);
  }

  return {
    rank: windows.findIndex((w) => w.correct),
    packets: windows.slice(0, RESULTS_SHOWN).map((w) => w.text),
    files: windows.slice(0, RESULTS_SHOWN).map((w) => w.file),
  };
}

const hitAt = (rank, k) => rank !== null && rank < k;
const mrr = (rank) => (rank === null ? 0 : 1 / (rank + 1));
const mean = (v) => (v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length);

/**
 * Paired bootstrap: both sides are measured on the same list of queries, so the
 * samples are not independent and the difference of means is computed pairwise. An
 * independent bootstrap would overstate the confidence.
 */
function pairedBootstrap(a, b, iterations = 10000) {
  if (a.length !== b.length || a.length === 0) return null;
  const deltas = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < a.length; j += 1) {
      const idx = Math.floor(Math.random() * a.length);
      sum += a[idx] - b[idx];
    }
    deltas.push(sum / a.length);
  }
  deltas.sort((x, y) => x - y);
  const at = (q) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(q * deltas.length)))];
  const p = (2 * Math.min(
    deltas.filter((d) => d <= 0).length,
    deltas.filter((d) => d >= 0).length,
  )) / deltas.length;
  return { mean: mean(deltas), lo: at(0.025), hi: at(0.975), p: Math.min(1, p) };
}

function summarize(label, ranks, tokensPerQuestion) {
  const n = ranks.length;
  return {
    label,
    n,
    hit1: ranks.filter((r) => hitAt(r, 1)).length / n,
    hit3: ranks.filter((r) => hitAt(r, 3)).length / n,
    hit5: ranks.filter((r) => hitAt(r, 5)).length / n,
    hit10: ranks.filter((r) => hitAt(r, 10)).length / n,
    mrr: mean(ranks.map(mrr)),
    tokens: tokensPerQuestion,
  };
}

async function main() {
  const corpusName = argOf('--corpus');
  const corpus = corpusName === undefined ? undefined : CORPORA[corpusName];
  if (corpus === undefined) {
    log(`--corpus is required. Available: ${Object.keys(CORPORA).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const baseDir = argOf('--corpus-dir', path.join(process.env.TEMP ?? '.', 'opencode', 'bench-corpus'));
  const dir = path.resolve(baseDir, corpus.dir);
  if (!existsSync(dir)) {
    log(`corpus not found: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  if (!head.startsWith(corpus.pin)) {
    log(`WARNING: HEAD=${head.slice(0, 8)}, expected ${corpus.pin} — the run is not reproducible`);
  }

  const { questions, rejected, total } = mineQuestions(dir, corpus.pathspec);
  const limit = Number(argOf('--limit', '0'));
  const asked = limit > 0 ? questions.slice(0, limit) : questions;
  log(`corpus ${corpusName} @ ${head.slice(0, 8)}`);
  log(`questions: ${asked.length} of ${questions.length} usable (${total} commits scanned)`);
  log(`dropped: ${JSON.stringify(rejected)}`);

  env.cacheDir = argOf('--models', path.resolve('.anyindex/models'));
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);

  const config = loadConfig({
    root: dir,
    dbPath: path.join(dir, '.anyindex', 'bench.db'),
    // The same model for every corpus: its own cache in the corpus directory would
    // force a fresh download on every run.
    modelsDir: argOf('--models', path.resolve('.anyindex/models')),
  });

  log('indexing...');
  const startedIndex = Date.now();
  const textPass = await indexRepository(config);
  const { db } = openDatabase(config.dbPath);
  const embedder = new Embedder(config);

  const rows = [];
  try {
    const embed = await embedMissing(db, config, embedder, {});
    log(
      `index ready: ${textPass.chunksWritten} chunks (AST ${textPass.astChunks}, fallback ${textPass.fallbackChunks}), ` +
      `vectors ${embed.embedded}, ${((Date.now() - startedIndex) / 1000).toFixed(0)} s`,
    );

    const indexedFiles = db.prepare('SELECT DISTINCT file_path FROM chunks').all().map((r) => r.file_path);
    const corpusFiles = loadCorpus(dir, indexedFiles);
    log(`baseline: ${corpusFiles.size} files in the cache`);

    // Query vectors are computed in batches: 500 single worker calls carry a
    // noticeable overhead each.
    const queryVectors = [];
    for (let i = 0; i < asked.length; i += 16) {
      const batch = asked.slice(i, i + 16);
      const vecs = await embedder.embed(batch.map((q) => q.query));
      for (let k = 0; k < batch.length; k += 1) queryVectors.push(vecs[k] ?? null);
    }

    for (let i = 0; i < asked.length; i += 1) {
      const q = asked[i];
      const outcome = searchChunks(db, q.query, queryVectors[i], TOP_K, 'hybrid');
      const files = outcome.hits.map((h) => h.filePath);
      const rank = files.findIndex((f) => q.expectFiles.includes(f));

      const base = baselineSearch(corpusFiles, q.query, q.expectFiles);

      rows.push({
        query: q.query,
        expectFiles: q.expectFiles,
        indexRank: rank === -1 ? null : rank,
        indexFiles: files.slice(0, 5),
        indexPackets: outcome.hits.slice(0, RESULTS_SHOWN).map((h) => `${h.filePath}\n${h.text}`),
        baseRank: base.rank === -1 ? null : base.rank,
        baseFiles: base.files,
        basePackets: base.packets,
      });
    }
  } finally {
    await embedder.close();
    db.close();
  }

  // Both sides are billed with the same tokenizer of the model: a "cheaper than
  // grep" comparison is meaningless if the two sides have different units.
  //
  // One text at a time, not in batches: a batch needs padding, and the PAD tokens
  // land in the count and inflate the cost. For a single input dims = [1, length].
  const tokenize = async (packets) => {
    let total = 0;
    for (const text of packets) {
      const enc = await tokenizer(text);
      total += enc.input_ids?.dims?.[1] ?? 0;
    }
    return total;
  };
  const indexTokens = await tokenize(rows.flatMap((r) => r.indexPackets));
  const baseTokens = await tokenize(rows.flatMap((r) => r.basePackets));
  const perQuestion = (total, r) => Math.round(total / rows.length);

  const ours = summarize('anyindex', rows.map((r) => r.indexRank), perQuestion(indexTokens));
  const base = summarize('grep-80', rows.map((r) => r.baseRank), perQuestion(baseTokens));

  log(`\n=== ${corpusName} @ ${corpus.pin} — ${rows.length} questions ===`);
  log('method        n     hit@1   hit@3   hit@5   hit@10   MRR     tokens/q');
  for (const r of [ours, base]) {
    log(
      `${r.label.padEnd(12)} ${String(r.n).padEnd(5)} ${r.hit1.toFixed(3)}   ${r.hit3.toFixed(3)}   ` +
      `${r.hit5.toFixed(3)}   ${r.hit10.toFixed(3)}    ${r.mrr.toFixed(3)}   ${r.tokens}`,
    );
  }

  const idx = rows.map((r) => r.indexRank);
  const bse = rows.map((r) => r.baseRank);
  const boot = {
    hit3: pairedBootstrap(idx.map((r) => (hitAt(r, 3) ? 1 : 0)), bse.map((r) => (hitAt(r, 3) ? 1 : 0))),
    mrr: pairedBootstrap(idx.map(mrr), bse.map(mrr)),
  };
  const fmt = (b) => (b === null
    ? '-'
    : `${b.mean >= 0 ? '+' : ''}${b.mean.toFixed(3)}  95% CI [${b.lo.toFixed(3)}, ${b.hi.toFixed(3)}]  p=${b.p < 0.001 ? '<0.001' : b.p.toFixed(3)}`);

  log(`\nhit@3 difference  ${fmt(boot.hit3)}`);
  log(`MRR difference    ${fmt(boot.mrr)}`);
  log(`token difference ${ours.tokens - base.tokens >= 0 ? '+' : ''}${ours.tokens - base.tokens} per question`);

  const outPath = argOf('--out', path.join(process.env.TEMP ?? '.', `bench-${corpusName}.json`));
  writeFileSync(outPath, JSON.stringify({
    corpus: corpusName, pin: corpus.pin, head, questions: rows.length,
    rejected, anyindex: ours, baseline: base, bootstrap: boot,
    perQuestion: rows.map(({ indexPackets, basePackets, ...rest }) => rest),
  }, null, 2));
  log(`detailed log: ${outPath}`);
}

await main();