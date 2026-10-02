# 09. Inventory: what is left

Date: **2026-10-01**, checkpoint `checkpoint-v0.1`.

Compiled by cross-checking the **code**, not the plan: every item was verified by searching the sources and running them, not taken from the documentation.

## 1. Closed in this pass

| Gap | Was | Became |
|---|---|---|
| ADR-009 was duplicated | Two blocks with the number 009 | One; the original is marked cancelled |
| ADR-016 was missing from the README | 16 lines out of 17 | 17 lines, reconciled by a script |
| The test database was getting into the package | `dist/.anyindex/index.db` 53 KB | Excluded via `.gitignore` + `prepack` |
| `docs/` was not in the package while the README linked to it | 15 relative links into a tarball that ships no `docs/` | The README links to the repository by absolute URL; the notes stay out of the tarball |
| No `LICENSE` file despite `license: MIT` | — | MIT added |
| `.map` files and tests in the published package | 39+ junk files | `strip-dev-artifacts.mjs`, 44 files, 62.9 kB |
| `stale` was always 0 | The field looked meaningful but meant nothing | Counted as "known unprocessed changes" — the watcher's queue. Details in `06-environment.md` §17 |
| `ANYINDEX_AUTOINDEX` did not work | Declared, not wired up | Indexing on startup, verified by running it |

The package after the fix: **44 files, 62.9 kB**, with no source maps, tests or third-party data. `npm pack --dry-run` prints these figures and `npm run verify:package` fails if junk appears in the tarball.

`repository`, `homepage` and `bugs` in `package.json` point to
`github.com/officialalexeev/anyindex-mcp`. The owner was filled in on 2026-10-01.

## 2. Left outside the agreed scope

This is what you excluded from the current pass:

| # | Item | Why it was not done | What it blocks |
|---|---|---|---|
| 1 | ✅ **Windows** — closed on 2026-09-30 | The owner's decision was against it (ADR-016), then reversed | — |
| 2 | **A large repository, many cores** | An index of 435 chunks is too small to estimate the ANN threshold | Scaling, the ANN threshold and behaviour at 50k+ chunks are untested |
| 3 | **macOS** | No machine | The claim "works on all operating systems" remains false |

### 2.1 Found and fixed on the first Windows run

| # | Defect | Why it was not caught earlier | Fix |
|---|---|---|---|
| 4 | **The watcher received not a single event.** `chokidar` emits `C:/dir/file`, `root` arrives as `C:\dir\file`, and the string comparison treated the root as an outside path | The separators match on Linux | `src/watcher.ts`: the root is checked via `path.relative` |
| 5 | **An unfinished index was reported as ready.** `ready` required `vectors > 0` rather than `vectors === chunks` | It takes an index interruption halfway through | `src/index-service.ts`; 208 out of 431 passed as `ready` |
| 6 | **Edits made during indexing were lost.** The batch was discarded in the expectation of a "next pass", which without new edits never comes | It takes a long index-job and an edit landing exactly in its window | `requestRerun()` in `src/job.ts`, 4 tests |
| 7 | **The AST/fallback counters were reset** by an incremental run with no changes | They were stored in `meta` as the result of the last pass | The strategy moved to the `chunks.strategy` column, migration v4 |
| 8 | **`reindex` did not rewrite the chunks** of unchanged files, so the fields of the new migrations stayed empty forever | It was never checked against an existing index | `src/indexer.ts`: the rebuild rewrites the chunks forcibly |

The second Windows run (2026-10-01) found three more: a broken launch of `probe`
and `benchmark` from the CLI, a false source tag in lexical mode, and headings
for markdown chunks taken from prose lines. Analysis — `06-environment.md` §17.

## 3. Left to do — functional gaps

| # | Gap | Where | Assessment |
|---|---|---|---|
| 3 | ✅ **MCP progress notifications** — closed | `src/tools.ts`: `progressSender` sends `notifications/progress` if the client supplied a token. 2 tests. `index_status` remains the main way: client support is unverified |
| 4 | ✅ **CLI** — closed | `src/cli.ts`: reindex, update, status, search, probe, benchmark. Meaningful exit codes, wrong `--mode` and `--dtype` are rejected. 11 tests |
| 5 | **Token economy in the results** | `src/render.ts` | The model does not see the cost of the answer, only `topK`. An external benchmark: we are about 3.7 times cheaper than grep (`06-environment.md` §18.3), but that is a consequence of chunk brevity, not a separate mechanism |
| 6 | ✅ **`get_file_outline` returned chunks, not symbols** — closed | A new `chunks.entities` column and migration v3: `code-chunk` returns the full `context.entities`, and now they are stored. Verified on `src/db.ts` — 14 symbols with exact line ranges |
| 7 | ✅ **Changing the model/dimensionality** — closed | `src/indexer.ts`: a model change is rejected before any action, a dimensionality change recreates the table. 2 tests in `src/db.test.ts` |
| 8 | ✅ **The MCP `index://` resource and the prompts** | — | The resource is not implemented. The prompts are still not exported: `open-codebase-index` provides them, we have only tools |
| 12 | ✅ **`find_references`** — closed | `src/references.ts`, the seventh tool. A lexical search for the identifier with an exact token match: declarations and usages. Not a call graph — ADR-004 stands, ADR-017. 8 tests |
| 9 | ✅ **recall@5 on a larger corpus** — closed | An external benchmark over three third-party repositories: 520 questions taken from the commit history, a grep baseline, a paired bootstrap. `06-environment.md` §18 |
| 10 | ✅ **Documentation displaces code** — closed | `src/search.ts`: `DOCUMENTATION_WEIGHT = 0.9`. Markdown in top-1 25.2 % → 13.8 %, hit@3 0.517 → 0.531. The 0.9 weight is the upper bound: below it the queries whose answer is in the documentation break. §18.5, §18.9 |
| 11 | ✅ **Deduplication of results per file** — closed | `src/search.ts`: `MAX_CHUNKS_PER_FILE = 1`. Duplicates in top-3 123 → 0, hit@3 0.467 → 0.517. Side effect: `topK` is now an upper bound on the number of files, so there may be fewer results. §18.6, §18.9 |

## 4. Left to decide — open questions

| # | Question | Status |
|---|---|---|
| 10 | **The Russian language** — partially closed | Changing the model does not help: `multilingual-e5-small` gives the same 4/5. The problem is the task, not the model. Directions untested: query translation, a hint in the description |
| 11 | **Negative queries 2/3** | Neither distance nor the gap separates them. Tuning thresholds on 17 examples is overfitting |
| 12 | ✅ **A smaller model** — closed by measurement | 3 models compared: jina stays, `mxbai` is the fallback for weak hardware. `06-environment.md` §11 |
| 13 | **The rerank stage** | Deferred: the bottleneck is in the distances, not in the ranking. Return to it once #10/11 is decided |
| 14 | **ANN instead of brute-force** | The threshold is fixed (~50k chunks) and **measured**: 6 / 47 / 228 ms for 1k / 10k / 50k chunks. Nowhere faster to go — the question is closed. ⚠️ Important: this threshold and the quality limit solve different problems. At 2574 chunks quality has already halved, and there are still three orders of magnitude before ANN. §18.10 |
| 15 | **Quality degradation as the corpus grows** | `src/search.ts` | hit@3 0.711 → 0.473 → 0.328 at 439 / 1628 / 2574 chunks. The scale is confirmed by a controlled experiment: the same 102 gson questions on a truncated index give +0.049 hit@3 and +0.245 hit@10. The linguistic residue is plausible but not proven. §18.10 |

## 5. What can be closed quickly

No open items are left from section 3. Next by usefulness come **8** (the
`index://` resource and the prompts) and **15** (quality degradation as the corpus
grows — the largest measured limitation of the results).

## 6. What not to do

- **Binary build** — forbidden by ADR-015, `sharp` makes it impossible.
- **Our own call graph** — ADR-004, handed to the external `tree-sitter-analyzer`.
- **Our own LSP** — out of scope.
- **ANN below 50k chunks** — brute-force is faster and simpler, the threshold is measured (§18.10).

## 7. How to check the state

```bash
npm run verify      # build + tests + probe
npm run typecheck   # type check without emitting
npm run benchmark   # quality benchmark, 27 queries
npm run probe       # check the environment and hardware
```

118 tests. Windows-specific defects are only caught by a run on Windows:
the watcher is checked in `tests/watcher.test.ts`, the unfinished index in
`src/index-service.ts` via `readIndexState`, event loss in
`tests/job.test.ts`, the `probe`/`benchmark` launch path in `tests/cli.test.ts`
via `subcommandEntry()`.
