// Check that lowering the documentation weight does not break the queries whose
// answer lives in the documentation.
//
// A sweep over the three corpora cannot show that: there the correct answer is
// markdown in 0 questions out of 520, so the metric improved monotonically as the
// weight fell and would have tuned the "documentation is never needed" prior. That
// prior makes no sense, so this is an independent set: questions the README
// answers directly.
//
// node scripts/doc-regression.mjs
import path from 'node:path';

import { loadConfig } from '../dist/config.js';
import { openDatabase } from '../dist/db.js';
import { Embedder } from '../dist/embedder.js';
import { searchChunks } from '../dist/search.js';

const ROOT = path.resolve('.');
const TMP = process.env.TEMP ?? '.';

// Questions in this repository that the documentation answers, not the code.
const DOC_QUESTIONS = [
  { q: 'how does the ignore file precedence work', doc: 'README.md' },
  { q: 'what are the node version requirements', doc: 'README.md' },
  { q: 'how do I configure an MCP client', doc: 'README.md' },
  { q: 'which CLI commands are available', doc: 'README.md' },
  { q: 'what environment variables can be set', doc: 'README.md' },
  { q: 'what does the benchmark measure and what are its limits', doc: 'docs/06-environment.md' },
  { q: 'why was the decision made to build from scratch', doc: 'docs/05-landscape.md' },
  { q: 'what is still missing from the project', doc: 'docs/09-gaps.md' },
];

const isDoc = (p) => /\.(md|markdown)$/i.test(p);

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

const log = (...p) => process.stderr.write(`${p.join(' ')}\n`);

async function main() {
  const config = loadConfig({ root: ROOT, dbPath: path.join(ROOT, '.anyindex', 'index.db') });
  const { db } = openDatabase(config.dbPath);
  const embedder = new Embedder(config);

  const rows = [];
  try {
    for (const { q, doc } of DOC_QUESTIONS) {
      const vector = (await embedder.embed([q]))[0] ?? null;
      const pool = searchChunks(db, q, vector, 40, 'hybrid').hits;
      rows.push({ q, doc, pool });
    }
  } finally {
    await embedder.close();
    db.close();
  }

  const variants = [
    { name: 'as is', cap: Infinity, docWeight: 1.0 },
    { name: 'dedup 1', cap: 1, docWeight: 1.0 },
    { name: 'dedup 1 + doc 0.95', cap: 1, docWeight: 0.95 },
    { name: 'dedup 1 + doc 0.9', cap: 1, docWeight: 0.9 },
    { name: 'dedup 1 + doc 0.8', cap: 1, docWeight: 0.8 },
    { name: 'dedup 1 + doc 0.7', cap: 1, docWeight: 0.7 },
  ];

  log('\n=== documentation rank on doc queries (position of the answering document) ===');
  log('variant              doc@1  doc@3  mean rank');
  for (const v of variants) {
    const ranks = [];
    for (const r of rows) {
      const files = select(r.pool, 5, v).map((h) => h.filePath);
      const at = files.indexOf(r.doc);
      ranks.push(at === -1 ? null : at);
    }
    const d1 = ranks.filter((r) => r === 0).length;
    const d3 = ranks.filter((r) => r !== null && r < 3).length;
    const found = ranks.filter((r) => r !== null);
    const avg = found.length === 0 ? '-' : (found.reduce((s, r) => s + r, 0) / found.length).toFixed(2);
    log(`${v.name.padEnd(20)} ${d1}/${rows.length}    ${d3}/${rows.length}    ${avg}`);
  }

  log('\n=== per question at doc 0.8 ===');
  const v = variants.find((x) => x.docWeight === 0.8);
  for (const r of rows) {
    const files = select(r.pool, 5, v).map((h) => h.filePath);
    log(`  ${files.indexOf(r.doc) === -1 ? 'none' : `#${files.indexOf(r.doc) + 1} `} "${r.q}" → ${files[0]}`);
  }
  void TMP;
}

await main();