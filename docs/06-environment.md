# 06. Stage 0 results — environment check

Run date: **2026-09-29**. Command: `npm run probe`.

⚠️ **Run environment: Linux x64, Node v24.21.0, npm 11.19.0. The target platform is Windows. This run does NOT replace the check on Windows** (ADR-011, R10). Below, whatever needs re-checking is marked explicitly.

## 1. Summary

```
pass: 11, warn: 1, fail: 0
No blocking failures.
```

| # | Check | Status | Observation |
|---|---|---|---|
| 1 | `node version` | ✅ | `v24.21.0` — falls within `>=24.0.0` |
| 2 | `storage writable` | ✅ | the temp directory is created and removed |
| 3 | `sqlite-vec` | ✅ | `vec_version=v0.1.9`; KNN, metadata filter, auxiliary column all work |
| 4 | `code-chunk (native)` | ✅ | 1 chunk, entities `[db, UserService, getUser, helper]`, `contextualizedText` populated |
| 5 | `code-chunk (wasm)` | ⚠️ | different API (`createWasmParser`) — see R1, expected |
| 6 | `fast-glob` | ✅ | import succeeds |
| 7 | `ignore` | ✅ | import succeeds |
| 8 | `chokidar` | ✅ | import succeeds |
| 9 | `embeddings: dtype` | ✅ | jina → `[fp32, fp16, q8]` |
| 10 | `embeddings: run` | ✅ | `dims=[1,768]`, correct |
| 11 | `embeddings: throughput` | ✅ | 48 ms/chunk at batch size 16 |
| 12 | `embeddings: cache` | ✅ | `env.cacheDir` outside `node_modules`, 157 MB |

## 2. Performance

| Metric | Value |
|---|---|
| Model load (first) | 1 147 ms (repeat run 9 249 ms — spread from the download) |
| Inference | **48 ms/chunk** at batch size 16 |
| Extrapolation | 10 000 chunks ≈ **478 s ≈ 8 min** |
| Model size on disk | **157 MB** (`q8`) |

⚠️ The estimate was made on synthetic chunks. Real code yields longer sequences, and `code-chunk` with `contextMode:'full'` adds a scope chain and neighbour captions. **Recompute on the real repository** — this is part of the stage 4 criteria.

8 minutes for 10k chunks is acceptable for initial indexing. Incremental updates (ADR-005) should reindex single chunks, not the whole repository.

## 3. Three findings that changed the implementation

### 3.1 ⚠️ npm 11.19 blocks install scripts by default

```
npm warn install-scripts 9 packages have install scripts not yet covered by allowScripts:
npm warn install-scripts   onnxruntime-node@1.30.0 (postinstall: node ./script/install)
npm warn install-scripts   tree-sitter-{go,java,javascript,python,rust,typescript} (install: node-gyp-build)
npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
```

**It works anyway:** the prebuilds ship inside the packages, and `node-gyp-build` finds them without running the install script. On Linux. **Not verified on Windows** — `node-gyp-build` may have no ready-made `.node` binaries for the right platform there, and without the install script the build will not happen.

This is the same barrier as `bun pm trust` in Bun (`07-bun-vs-node.md` §4). **The conclusion has not changed:** you cannot choose a runtime on this ground — the restriction is present in both.

**Action:** record the `npm install-scripts approve <pkg>` command in the README, in case Windows has no prebuilds.

### 3.2 ❌ `code-chunk@0.1.14` has a broken `exports` for TypeScript

```json
"exports": {
  ".": {
    "types": "./src/index.ts",        ← resolved first, since types is part of the default conditions
    "bun": "./src/index.ts",
    "import": {
      "types": "./dist/index.d.ts",    ← correct but unreachable
      "default": "./dist/index.js"
    }
  }
}
```

`moduleResolution: NodeNext` matches `types` at the top level and gets the package's **raw TypeScript source** instead of the declarations. `skipLibCheck: true` does not help — it applies only to `.d.ts`.

Result: 20+ errors like

```
node_modules/code-chunk/src/index.ts(25,8): error TS2835:
  Relative import paths need explicit file extensions in ECMAScript imports
```

**Solution** — type mapping in `tsconfig.json`:

```json
"baseUrl": ".",
"paths": {
  "code-chunk": ["./node_modules/code-chunk/dist/index.d.ts"],
  "code-chunk/wasm": ["./node_modules/code-chunk/dist/wasm.d.ts"]
}
```

Types are taken from `dist/`, the runtime from `dist/` via the correct `import.default`. Settled.

⚠️ The mapping refers to an internal package path. When the `code-chunk` version changes, check that `dist/index.d.ts` is still in place. The alternative is to wait for `exports` to be fixed in `0.1.15+`.

### 3.3 ❌ `better-sqlite3` binds JS numbers as `REAL` — `vec0` rejects them

```js
db.prepare('SELECT typeof(?) AS t').get(1)   // → { t: 'real' }
db.prepare('SELECT typeof(?) AS t').get(vec) // → { t: 'blob' }
```

Inserting a JS number into an `INTEGER PRIMARY KEY` column of `vec0` fails:

```
SqliteError: Only integers are allows for primary key values on t
```

**Solution:** bind integers as `BigInt`.

```js
insert.run(BigInt(chunkId), vectorBlob, language, context)   // OK
```

Verified: insert, KNN without a filter (2 rows, correct order by distance), KNN with `language = 'ts'` (1 row), KNN with a non-existent value (0 rows). The `+ctx` auxiliary column is read straight from the KNN result, without a JOIN.

⚠️ Keep this in mind everywhere an id goes into `vec0`. An ordinary `chunks` table has no such restriction, but being consistent is useful.

## 4. Confirmed facts complementing `01-research.md`

| Fact | Source |
|---|---|
| `sqlite-vec` in the repository is **v0.1.9** (`package.json` declares `^0.1.7-alpha.2`) | `npm ls sqlite-vec` |
| `jinaai/jina-embeddings-v2-base-code` offers only `fp32`, `fp16`, `q8` | `ModelRegistry.get_available_dtypes()` |
| The `q8` model takes **157 MB** on disk | `du -sh` |
| Native `code-chunk` really does extract entities via tree-sitter | `probe`, chunks |
| `/wasm` requires manual configuration of the binaries | `code-chunk/src/parser/wasm.ts` |

## 5. What still has to be checked on Windows

None of the items below is covered by this run:

1. `npm install` without MSVC — whether `tree-sitter-*` and `onnxruntime-node` have prebuilds for Windows.
2. `better-sqlite3@13.0.3` — whether there is a prebuild for Node 22.19/24 on Windows.
3. Whether `npm install-scripts approve` is needed for correct operation.
4. Path normalization: `fast-glob` versus `chokidar` on Windows (ADR-011, §3.2 of the architecture).
5. The real embedding speed on Windows and on live code instead of synthetic input.
6. The same `exports` defect in `code-chunk` under `moduleResolution: NodeNext` — the same, but confirm it with an actual install.

**Items 1–3 are blocking.** If there are no prebuilds, then either MSVC is required (a documented requirement), or a switch to the WASM path of `code-chunk` with vendored binaries — see R1 and ADR-009.

## 6. How to reproduce

```bash
npm install
npm run build
npm run probe
```

Exit code `1` means a blocking failure — the stack is re-reviewed before any code is written.
## 7. Stage 3 findings (chunking and storage)

### 7.1 `lineRange` in `code-chunk` is 0-based

```json
{ "lineRange": { "start": 0, "end": 12 } }   // 13 lines, indices 0..12
```

We hand out 1-based values (`toOneBased`); otherwise the model would be given "lines 0–12" and would cite them in its answer — the editor shows 1–13. A test in `src/db.test.ts` pins the invariant.

### 7.2 `code-chunk` crashes on markdown/yaml/json with a vague error

```
a.md    → FAIL: FiberFailureImpl
a.yaml  → FAIL: FiberFailureImpl
a.json  → FAIL: FiberFailureImpl
```

`FiberFailureImpl` is Effect's internal name for the error and carries no message. Exactly 6 languages from the README are supported.

**Configuration consequence:** the `indexedExtensions` list in `src/config.ts` included `.md`, `.json`, `.yaml`, `.yml`, `.toml`. Without the fallback path, indexing would crash on the very first such file.

**Decision:** a strategy registry in `src/chunker.ts`. AST for the 6 languages, a structural fallback for markdown (split on headings) and for flat config files (split on size). Every chunk is tagged `source: 'ast' | 'fallback'` and the counters land in the indexing result — this is ADR-010 in action: the failure is visible, not masked.

### 7.3 FTS5 with `content='chunks'` returns only the declared columns

```sql
SELECT file_path, line_start FROM chunks_fts
-- SqliteError: no such column: line_start
```

An external-content FTS5 table (`content='chunks', content_rowid='id'`) exposes only the columns declared in `chunks_fts` itself — `context`, `entity_name`, `file_path`. The rest comes from a JOIN against `chunks`. Synchronization is done by the `chunks_ai/ad/au` triggers, otherwise the external table desynchronizes on any change.

### 7.4 Lock files polluted the index

`package-lock.json` passed the `.json` extension check and produced **67 chunks** out of 289 — more than all of the TypeScript code in the repository. Worse, it won on bm25 for the words "version", "resolved", "integrity".

Added `DENYLISTED_BASENAMES`: npm/yarn/pnpm/bun/composer/cargo/poetry/uv/go lock files.

### 7.5 Incremental bug, caught by a test

`files.mtime_ms` was written as the constant `0` instead of the actual time. The comparison `previous.mtime_ms === file.mtimeMs` never held, so every run reindexed the whole repository. The test "a second run does not touch unchanged files" caught it: after the fix, 28 files → `unchanged: 28, chunksWritten: 0`.

### 7.6 Baseline index quality metric

Run on this repository (documentation-heavy — 9 markdown files against 8 TypeScript ones):

| Metric | Value |
|---|---|
| Files | 27 |
| Chunks total | 289 |
| AST chunks | 46 (16%) |
| Fallback chunks | 243 (84%) |
| markdown / typescript / yml / json / javascript | 239 / 45 / 2 / 2 / 1 |
| Empty `entity_name` | 17 (legitimate `NULL` for AST chunks with no named entity) |
| Time | ~1 s |

**This is expected for a documentation repository, but it pins the problem down:** 83% of the index is markdown windows of 1500 bytes each, which blur vector search. The share will be different for a code repository, but the problem itself does not go away.

**Action (not now):** result quality is measured in stage 6 on a control set of 20 questions. If markdown noise gets in the way — either `maxChunkSize` for the fallback goes up, or markdown moves behind a separate configuration flag. Changing this blind before the measurements is not an option.

## 8. Stage 4 findings (embeddings and search)

### 8.1 The worker's `resourceLimits` caused an OOM kill of the process

It set `maxOldGenerationSizeMb: 4096` "just in case the model turns out to be large". On a machine with 2 GB of RAM Node allocated a heap well past physical memory and the kernel killed the process — **the server died at about second ~100 of indexing**, reproducibly every time.

Decision: no limit is set. The model takes ~160 MB, Node's default is computed from available memory and is correct on any machine. The mistake was mine and had nothing to do with the model's memory.

### 8.2 Process leak: the server survived the connection drop

After `client.close()` the process stayed alive, holding the model and the worker (660 MB RSS observed on the orphaned server).

Two causes, both fixed:
1. `Embedder.close()` waited for the worker to reply, and the worker can take a minute on a single core. Added a 500 ms timeout followed by a forced `terminate()`.
2. By the MCP stdio transport contract the client closes stdin, and Node does not exit while handles and threads are still alive. Added handlers for `stdin: end/close`, `SIGINT`, `SIGTERM`, `SIGHUP`.

### 8.3 The speed measurement in the probe was 16 times more optimistic than reality

The first probe measured 16 synthetic chunks of ~60 characters and reported **48 ms/chunk**. On real chunks (~750 characters) it is really **4200 ms/chunk**.

Reason: transformers.js pads every element of a batch to the length of the longest string, and self-attention is quadratic in length. One long markdown chunk slowed the whole batch down.

Measured on one machine (1 core, 2 GB):

| Input | ms/chunk |
|---|---|
| 16 chunks of ~60 chars (as before) | 48 |
| 16 shortest real ones | 350 |
| 16 mixed real ones | 4200 |
| 1 long chunk | 3734 |

Fixes: sort the texts by length before splitting them into batches; the probe was switched to realistic chunks (~477 chars) and now reports 801 ms/chunk and an honest extrapolation of "10k chunks ≈ 134 min on a single core".

⚠️ **Performance is determined by the core count.** On 1 core jina (161M parameters) is impractical for large repositories. You need either a more powerful CPU or a smaller model.

### 8.4 The relevance threshold is not applied — and why

Measured on seven queries with 4 chunks in the index, cosine distance:

| Query | Type | top-1 | Rest |
|---|---|---|---|
| `session token creation` | relevant | **0.858** | 1.146 / 1.353 / 1.421 |
| `форматирование размера файла в килобайтах` | relevant | **1.043** | 1.218 / 1.323 / 1.381 |
| `как логинится пользователь` | relevant | **1.165** | 1.201 / 1.292 / 1.414 |
| `zzz qqq xxx` | irrelevant | 1.200 | 1.236 / 1.328 / 1.353 |
| `код которого нет в репозитории` | irrelevant | 1.247 | 1.254 / 1.274 / 1.278 |
| `как настроить kubernetes ingress` | irrelevant | 1.249 | 1.327 / 1.337 / 1.341 |
| `reactor reactor reactor` | irrelevant | 1.313 | 1.360 / 1.389 / 1.398 |

**The gap between the "last relevant" (1.165) and the "first irrelevant" (1.200) is 3%.** A threshold of ~1.18 would have cut off the right answer too: the Russian query puts the correct `auth.ts` at 1.201. No threshold was introduced.

**What was done instead:** the distance and a rough confidence rating (`strong` < 1.05, `moderate` < 1.2, `weak` ≥ 1.2) are passed to the model in the results text. If every match is `weak`, an explicit warning is added: treat them as candidates, re-check them, and say "not found" if none of them fits.

**Why this and not a hard threshold:** silent filtering is exactly the failure ADR-010 forbids. Erring in either direction (missing the right answer / letting junk through) is dangerous; explicitly passing the model's uncertainty along is not.

### 8.5 Russian queries search noticeably worse than English ones

The same question, two ways:

| Query | top-1 | Correct file |
|---|---|---|
| `session token signing` (English) | **0.808** | first place |
| `как происходит логин пользователя` (Russian) | 1.179 | **second** place |

`jina-embeddings-v2-base-code` is trained on English and 30 programming languages, but **not on Russian**. The Russian wording pushes the vector off target, and `session.ts` ends up closer than the `auth.ts` that contains `loginUser`.

**Not fixed.** Possible directions, none of them verified: a query-translation step before embedding, a model with multilingual instructions (`multilingual-e5-small`), or an explicit note in the tool description to prefer English terms when the query is ambiguous. This needs measurements on a real corpus — that is stage 6's job.

## 9. End-to-end run (tiny fixture, 3 files)

```
index_update returned in 89 ms (background job)
ready in ~6 s, status: 3 files, 3 chunks, 2 AST + 1 fallback, 3 vectors
anyindex_search: hybrid 232 ms, semantic 66 ms, keyword 15 ms
the process exits after client.close(), no leaks
```

## 10. Quality benchmark (stage 6)

`src/benchmark.ts` — a fixture of 7 files, 17 queries, automatic scoring. Run: `npm run benchmark`.

Fixture index: 7 chunks, 6 AST + 1 fallback, 7 vectors.

### 10.1 Result

| Group | top-1 | top-5 |
|---|---|---|
| English, semantic | 9/9 | 9/9 |
| **Russian, semantic** | **4/5** | **5/5** |
| Exact symbols | 4/4 | 4/4 |
| **Total positive** | **13/14** | **14/14** |
| Negatives filtered | — | 2/3 |

The acceptance threshold was `top5 ≥ 11 out of 14` — **actual 14/14**. The Russian query "обработка задач из очереди в фоне" found the right file in second position.

### 10.2 Russian is systematically weaker, not randomly so

top-1 distances, grouped by query language:

| | range | dominant rating |
|---|---|---|
| English (semantic) | 0.707 – 1.002 | `strong` |
| Russian (semantic) | 1.014 – 1.179 | `moderate` |

The gap between the languages is consistent: **Russian queries sit about +0.2 further away** at the same hit quality (top-1 4/5 against 4/4 for symbols). ADR-002 names the reason: `jina-embeddings-v2-base-code` is trained on English and 30 programming languages, and Russian is not in the training data.

**Practical consequence:** a threshold calibrated on English queries systematically understates confidence in Russian ones. Worth keeping in mind for any future tuning.

### 10.3 Relevance threshold: calibration and its limits

First calibration over 17 queries:

```
positive top-1: 0.707 0.862 0.871 0.886 0.950 0.969 1.002 1.014
                  1.047 1.056 1.096 1.134 1.146 1.179
negatives:        1.089 1.226 1.288
```

**There is no separating threshold:** the negative at 1.089 sits below the positives at 1.096 and 1.134. The thresholds were chosen asymmetrically — `strong < 0.95`, `moderate < 1.10` — favoring false warnings:

- marking a positive as `weak` is **safe**: the result is returned anyway, only a warning is added;
- missing a negative is **dangerous**: the model will take it for an answer and invent code that does not exist — exactly the failure ADR-010 forbids.

The price of that decision: 4 of 14 positives are marked `weak` despite hitting correctly. That is deliberate.

### 10.4 The second signal (gap between the leader and third place) does not work

Tested as a way to replace the absolute threshold. The result: it **does not separate either**:

| | gap values |
|---|---|
| Positives | −0.055, −0.079, −0.159, −0.167, −0.218, −0.237, −0.238, −0.244, −0.244, −0.245, −0.275, −0.337, −0.354, −0.435, −0.483, −0.511 |
| Negatives | −0.071, −0.074, **−0.119** |

The irrelevant query that slipped through has a gap of −0.119, **larger** in absolute value than that of two correctly found positives (−0.055, −0.079). The signal is not part of the result rating; it stays in the benchmark as a diagnostic for future calibration.

**Tightening the thresholds further on 17 examples is overfitting.** The negative queries stay at 2/3, and that is recorded as a known limitation rather than masked.

### 10.5 What actually protects against hallucinations

Since the threshold does not work, the protection is built in three layers, and all three are already in the code:

1. The **tool description** explicitly requires: when there are no results, say that the code is not there instead of making something up.
2. The **results text** shows the distance and the rating next to every match — the model can see that the match is weak.
3. A **warning** when all matches are weak: re-check them and say "not found" if none of them fits.

What does not protect: silent filtering by threshold. It was rejected deliberately (§10.3).

## 11. Comparing embedding models

Tested on the `src/benchmark.js` harness (7 files, 17 queries) with the `--model`, `--dimension`, `--dtype`, `--query-prefix`, `--doc-prefix` parameters.

### 11.1 Separation metric

The «negatives filtered» metric depends on calibrating the thresholds for a specific model, so for comparison a threshold-independent measure was introduced:

```
gap = (best negative) − (worst positive)
```

A positive gap would mean that a threshold exists. A negative one — that relevant and irrelevant overlap and there is nothing to filter out.

### 11.2 Results

| Model | dim | Parameters | top-1 | russian top-1 | separation gap |
|---|---|---|---|---|---|
| **`jinaai/jina-embeddings-v2-base-code`** | 768 | q8 | **13/14** | **4/5** | **−0.090** |
| `mixedbread-ai/mxbai-embed-xsmall-v1` | 384 | q8 | 10/14 | 1/5 | −0.115 |
| `Xenova/multilingual-e5-small` | 384 | q8, `query:`/`passage:` | 13/14 | 4/5 | −0.009 |

**No model has a positive gap.** A relevance threshold is impossible not because of jina's weakness — it is a property of the task itself on a small corpus. The decision not to introduce a threshold (ADR-010) stays correct regardless of the model chosen.

### 11.3 Decision: keep jina

Justification from the measured data:

1. **Best quality.** 13/14 top-1, on a par with the best, and 4/5 on Russian.
2. **Largest separation gap** (−0.090 against −0.115 and −0.009). The smaller it is in absolute value, the closer the model is to the possibility of filtering; jina is the furthest of them all.
3. **Apache-2.0, ungated.** `multilingual-e5-small` **declares no license** on Hugging Face — for an MIT project that rules the model out regardless of quality. The base `intfloat/multilingual-e5-small` is declared MIT, but the `Xenova/` mirror declares no license, and a guess cannot be relied on.
4. **Switching models would require a reindex** of the whole corpus (ADR: vectors are incomparable), and there is no gain in the measured metrics.

### 11.4 What `mxbai-embed-xsmall-v1` gives

Tested and **rejected**: 10/14 top-1 and 1/5 on Russian — the quality is noticeably lower.

But it is a useful fallback, and here is why it is not useless: 22 million parameters against 161 million, Apache-2.0, and a full set of quantizations **including `q4` and `bnb4`**. On a single core it is the only model of those considered that gives a meaningful speed.

**When to revisit:** if the hardware cannot run jina (it needs ≥ 4 cores), `mxbai` is a reasonable trade-off at the cost of three misses on quality. A reindex and a separate threshold calibration will be needed at that point too.

⚠️ `q4f16` must not be used: it crashes in Node because of an ONNX Runtime graph merge error (`transformers.js#1567`).

### 11.5 Not verified

- `onnx-community/bge-m3-ONNX` (MIT, 1024d, 100+ languages) — probably the best candidate on quality, but 568 million parameters make a run on a single core impractical. Not measured.
- `Qwen3-Embedding-8B` (Apache-2.0, the best multilingual MTEB) — 8 billion parameters, does not run on this machine.
- A corpus larger than 10 files: on 7 files (7 chunks) the gap may be different. Item 9 of the inventory remains open.

### 11.6 Conclusion on Russian

`multilingual-e5-small` gives the same 4/5 on Russian as jina, at half the dimensionality. That means **the problem is not the model but the task**: a Russian query about code has to be matched against English text inside a chunk, and the training of models on «Russian query → English code» is limited.

A possible direction, not verified: adding a translation or an English synonym of the query to the embed. It needs an external model — which violates the fully offline requirement — so the option is deferred.

## 12. Stage 6 findings (tooling rework)

### 12.1 `get_file_outline` promised symbols but returned chunk ranges

The tool description claimed «functions, classes, methods», but what it actually returned was a single chunk range with the name of one priority entity. For a file with five methods in one chunk the model saw one entry.

Cause: `code-chunk` returns **all** entities in `context.entities`, but on write only `entity_name` — a single element — was kept. Data was lost.

Fix: migration 3 adds a `chunks.entities` column holding the whole list. Actual output after the change:

```
src/service.ts — 5 symbol(s), language typescript

1. UserService   [class]    lines 3–13   class UserService
2. constructor   [method]   lines 4–4    constructor(private readonly repo: Repository)
3. getUser       [method]   lines 6–8    async getUser(id: string): Promise<User>
4. deleteUser    [method]   lines 10–12  async deleteUser(id: string): Promise<boolean>
5. createService [function] lines 15–17  function createService(repo: Repository): UserService
```

### 12.2 ❌ A real bug: the migration broke FTS5 external content

Found while testing the upgrade path from version 1. The first `UPDATE chunks` after creating `chunks_fts` produced:

```
SQLITE_CORRUPT_VTAB  database disk image is malformed
```

Cause: `chunks_fts` is declared as `content='chunks'`, that is, FTS5 assumes the external table holds all the rows. When upgrading an existing database the rows were already in `chunks`, but not in the FTS index. The `chunks_au` trigger ran a `'delete'` for a missing record, and SQLite considered the file corrupt.

**Reproduced** by running all DDL commands step by step: `fts5` ok, triggers ok, `alter` ok, `backfill` → **FAIL**.

**Fix:** after creating the FTS table the following runs

```sql
INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
```

For an empty database this is harmless, for a database with data it is necessary. **The upgrade path is now covered by a test** that builds the version 1 schema directly and checks that data, metadata and the backfill survive the upgrade.

⚠️ In practice a database without the FTS table never occurred: all three migrations are applied at creation. The defect was found only because the upgrade path was checked at all.

### 12.3 The backfill shape did not match the indexer's format

`json_array(entity_name)` yields `["name"]` — an array of strings, whereas the indexer writes an array of objects. A consumer expecting `entity.name` would have got a string.

Fixed: the backfill creates an object of the same shape (`name`, `type`, `signature`, `lineStart`, `lineEnd`), with `type` marked as `unknown` and the bounds taken from the chunk. That is the truth: the exact entity bounds are unknown at backfill time.

### 12.4 A model change was cut off, but not always

The first implementation checked for a model change after the dimension-change branch, so when the dimension was changed first and the model second, the second check never fired. The model check was moved earlier and now runs when vectors are present.

## 13. Verification on a larger corpus (inventory item 9)

The benchmark was expanded from 7 to **17 files** and from 17 to **27 queries**. Modules adjacent in topic were added (LRU cache, priority queue, exponential backoff, HTTP router, CSV parsing, reading env, applying migrations, validation, logging) — they create distractors that the seven-file version did not have.

Index: 17 chunks, 15 AST + 2 fallback, 17 vectors.

### 13.1 Result

| Group | top-1 | top-5 |
|---|---|---|
| English, semantic | 10/14 | 14/14 |
| **Russian, semantic** | **5/10** | **10/10** |
| Exact symbols | 4/4 | 4/4 |
| **Total positive** | **15/24** | **24/24** |
| Negatives filtered | — | 2/3 |

Acceptance threshold: top-5 ≥ 18 out of 24. **Actual: 24/24.**

### 13.2 What changed compared with the seven-file corpus

| Metric | 7 files | 17 files | Change |
|---|---|---|---|
| top-5 | 14/14 (100%) | 24/24 (100%) | unchanged |
| top-1 | 13/14 (93%) | 15/24 (62%) | **−31 pp.** |
| Separation gap | −0.090 | **−0.218** | worsened twofold |
| Negatives | 2/3 | 2/3 | unchanged |

**top-5 remains perfect.** The right file is in the top five in all 24 cases — so retrieval works on its own, and the information the model extracts is sufficient.

**top-1 degraded** from 93% to 62%: as the number of distractors grows, the probability of putting the right file first falls. That is normal dense-search behaviour, not a defect.

### 13.3 The separation gap worsened twofold

It was −0.090, now it is −0.218. The larger the corpus, the higher the chance that an irrelevant chunk ends up closer than a relevant one. This confirms the conclusion of §10.3 at a real scale: **a relevance threshold is impossible not because of the model's weakness but because of the nature of the task**, and tuning it on a larger corpus would only have increased the overfitting.

The same point explains why `anyindex_search` returns 5–10 results with distances rather than a single «best» one: a single answer on such a corpus is unreliable, whereas the first five are reliable.

### 13.4 Russian: 5/10

Of 10 Russian queries, five come from the first position. Given that the model is trained on English, that is higher than could have been expected. The «a multilingual model is needed» hypothesis did not hold: `multilingual-e5-small` gave the same 4/5 on a smaller corpus.

## 14. Full reindex does not complete on 2 GB RAM

### 14.1 What happened

Reindexing of this repository (45 files, 241 chunks) was launched through `index_rebuild` and stopped at **224/241 (93%)**. It did not crash, did not return an error — it simply stopped moving for 30+ minutes with the process still running.

| Metric | Value |
|---|---|
| Free RAM at the moment it stopped | **64 MB out of 1968 MB** |
| Swap | **3.9 GB out of 4 GB in use (97%)** |
| RSS of the MCP process | grew to 1293 MB, then dropped to 755 MB |
| CPU load | ~34% of one core |
| Position in the queue | 224/241, no movement |

### 14.2 This is not a code hang, it is thrashing

RSS fell from 1293 MB to 755 MB not because the process freed memory, but because the pages were pushed out to swap. With zero CPU and full swap the process physically cannot keep computing. This is confirmed by the fact that after the forced termination free memory went from 64 MB back to 1232 MB, and swap dropped from 3.9 GB to 1.95 GB.

The main loop in `index-service.ts:240-267` is put together correctly: embedding and writing alternate in batches, the vectors of the whole corpus do not accumulate in memory. The RSS growth comes from the ONNX runtime, not from our code.

### 14.3 What this means for the requirements

`probe` warned about 1 core and 1968 MB of RAM, but the wording was insufficient: it described the speed, not the impossibility of finishing. The actual threshold is **1.5 GB of free RAM before the start plus swap**. Below the threshold the job does not crash, it hangs, which is worse than an explicit error.

The requirements in the README have been updated: memory is named as the limiting factor, not CPU.

### 14.4 What could not be verified

On this index it was not verified whether search quality went up after the chunker fix — the rebuild did not complete. The fix was verified on 12 markdown files directly, without embeddings (§14.5), and by tests.

### 14.5 Chunker fix, verified without embeddings

Comparison of the old and the new chunker on 12 markdown files:

| Metric | Old | New |
|---|---|---|
| Chunks | 303 | 287 |
| Text characters | 173357 | 172853 |
| Bodyless chunks | **20** | **0** |

925 characters were dropped. All six examples examined are headings with no body: `## 5. code-chunk`, `### sqlite-vec`, `### 6.1 Векторный`, `# 02. Архитектура` with a nested `## 1. Границы системы`. The difference between 925 and 504 is explained by the fact that some of the headings went back to their sections. No content was lost, the navigation crumbs that surfaced in the results as a line with the section name were removed.

## 15. Ignore files were only read from the root

### 15.1 How it was found

A question about `.gitignore` led to a comparison of the scanner with `git check-ignore` on a prepared project of five files. The root `.gitignore` worked, but two of the four ignored files were making it into the index. These two did:

| File | What ignores it | Made it into the index |
|---|---|---|
| `root-ignored.ts` | root `.gitignore` | no |
| `secret-root.ts` | root `.gitignore` | no |
| `src/nested-ignored.ts` | nested `src/.gitignore` | **yes** |
| `info-ignored.ts` | `.git/info/exclude` | **yes** |

### 15.2 Cause

`buildIgnoreFilter` did `readFileSync(path.join(root, name))` — the root only. Nested ignore files and `.git/info/exclude` were not read at all.

### 15.3 Why this is serious

A file hidden by a rule in a nested `.gitignore` made it into the index, and its text into the embeddings, that is, into the vector store on disk. For files holding secrets this leaks content beyond the expected scope. The root `.gitignore` covered that case, and on projects without nested ignore files the defect went unnoticed.

### 15.4 Fix

The filter was rewritten in terms of scopes: every directory that has an ignore file has its own scope, and a nested one overrides the outer one. The named export `Ignore.test()` returns `ignored` and `unignored` separately, so a `!` rule in a nested file correctly revives a path excluded by the root one. The priorities inside the root: `.git/info/exclude` → `.gitignore` / `.cursorignore` → `.anyindexignore`.

Three tests in `src/scanner.test.ts`: a nested rule, revival from a nested rule, `.git/info/exclude`. It was checked that they catch the old defect — on the previous code all three fail.

## 16. Windows x64, first run

Date: **2026-09-30**. Node v22.23.2, npm 12.1.0, win32-x64, 4 logical cores,
16 GB RAM. Every number below was obtained by running on this machine, not by
carrying over the linux measurements.

### 16.1 Installation: npm scripts are not needed

npm 12.1.0 blocked 10 install scripts — `better-sqlite3`,
`onnxruntime-node`, `protobufjs` and six `tree-sitter-*`. `npm install-scripts
approve` was not needed: the prebuilds live inside the packages.

| Package | What is needed on Windows | Result |
|---|---|---|
| `better-sqlite3` 13.0.3 | `prebuilds/win32-x64.node` | `vec_version=v0.1.9`, KNN and the metadata filter work |
| `onnxruntime-node` 1.30.0 | `bin/napi-v6/win32/x64/onnxruntime_binding.node` | 768-dimensional inference |
| `tree-sitter-*` × 6 | `prebuilds/win32-x64/*.node` | `code-chunk` works natively |

The README instruction about `npm install-scripts approve onnxruntime-node` was
unfounded and has been removed.

### 16.2 Embedding speed: `probe` underestimates by 4-6 times

`probe` measures on synthetic text of ~477 characters, real chunks are up to
1500 bytes, and they go in batches of 16. Attention is quadratic in length, so
the contribution of short synthetic texts does not carry over.

| Conditions | ms/chunk | Estimate for 10k chunks |
|---|---|---|
| `probe`, synthetic 477 chars., batch 8 | 521 | 87 min |
| Real chunks, batch 16 | ~2900 | ~480 min |

A full rebuild of the index of this repository (46 files, 435 chunks) took
**831 s**. The previous README estimate of "~11 min for 45 files on a single
core" did not hold on this machine — it underestimates the cost of long chunks.

### 16.3 A defect that exists only on Windows

`chokidar` hands over paths with forward slashes (`C:/dir/file`), whereas `root`
arrives native (`C:\dir\file`). In `startWatcher` the root comparison was done
by string, so the root looked like a path outside itself:

```
ignored(candidate) → path.relative(root, candidate) === ''  // this is the root
                   → candidate !== root                     // but the strings differ
                   → true, the root is marked as ignored
```

The traversal never started, the `watcher` received not a single event, and
there were no errors. The four tests in `src/watcher.test.ts` failed with empty
batches — this cannot be reproduced on Linux, there the separators match.

A second Windows-only defect: `readIndexState` declared the index ready at
`vectors > 0`, so 208 vectors out of 431 passed as `ready: true,
degraded: false`. This cannot be reproduced on Linux either — there the
interruption goes through differently.

### 16.4 What remains unverified

- macOS: never run. The claim "works on all operating systems" is wrong.
- CI on three operating systems (`.github/workflows/ci.yml`) was never run.
- Switching the model and the dimensionality under Windows was not tested — the
  path is shared with Linux, but `sqlite-vec` behaves differently on macOS.

## 17. Re-verification on Windows x64

Date: **2026-10-01**. The same machine and the same Node version as in §16. The
goal was not new measurements but an exhaustive run of all MCP tools and all CLI
commands after the code changes.

### 17.1 What matched the previous run

| Check | Result |
|---|---|
| `npm run typecheck` / `build` | clean |
| `npm test` | 82/82 (was 64) |
| `probe` through the CLI | 13 pass / 1 warn / 0 fail |
| Index of this repository | 48 files, 460 chunks (AST 142, fallback path 318), 460 vectors |
| Full indexing from scratch | 758 s on 4 cores, cold model 48 s |
| Incremental pass after editing 7 files | 113 computed, 347 reused by hash, 184 s |
| Repeated `index_update` with no changes | 0 computed, 460 reused, 0.5 s |
| Quality benchmark | top-1 15/24, top-5 24/24, gap −0.218, negatives 2/3 |

The §13 measurement reproduced down to the digit: the benchmark gives the same 15/24 and 24/24 as recorded in the
documentation. The model on this run was taken from the warm model cache, so `probe` showed 420 ms/chunk against
521 in §16 — that is a consequence of the warm cache and not of a divergence in methodology: the length of the synthetic
texts is the same, ~477 characters.

### 17.2 Defects found by the exhaustive run

All three reproduced on Windows and should have been caught earlier.

**`anyindex-mcp probe` and `benchmark` did not run at all.** The subcommand
built the path as `new URL(script, import.meta.url).pathname`, and that is
`/D:/dist/probe.js`; Windows builds `D:\D:\dist\probe.js` out of it, and `node`
answered `Cannot find module`. CI did not see this: there `probe` is launched as
`node dist/probe.js`, bypassing the CLI. Fixed on `fileURLToPath`, and in the
tests `subcommandEntry()` checks the path against the file on disk.

**Lexical search labelled itself as vector.** The source label was derived from the
group position in RRF: the vector branch has index 0, and in `keyword` mode there is
only one group, and it was called `vector`. What went out was `sources: ["vector"]` with
`distance: null` — that is, the results claimed that the vector had been computed while
it was not. The label is now set by the caller.

**The title of a markdown chunk was taken from an arbitrary line.** A chunk that began
because of the size limit sits inside a section, and it was named by the first line of
prose that came along or the content of a fenced block: in `README.md` two of the sixteen
"sections" were called `ANYINDEX_ROOT: /absolute/path/to/your/project` and `index counts as
degraded: ...`. The title is now taken only if it really is a heading, otherwise it is
inherited from the last one seen.

Three more findings did not reproduce as "broken" but did not match the code: `shutdown`
never reached the worker (`send()` rejected everything after `closing = true`, and the
error was swallowed); the watcher had its own list of excluded directories of seven
entries against twenty-two in the scanner, and it knew nothing about `.gitignore`;
`SCHEMA_VERSION` in `db.ts` was 1 while the actual schema version was 4.

The fourth finding came out of the fixes themselves: a change of quantization was not rejected.
The model and the dimensionality match in that case, so `q8` and `fp32` vectors ended up in the
same `vec0` table, and `meta.dtype` was silently overwritten with the new value. The index looked
healthy and simply returned slightly worse results. Now both `readIndexState` and
`indexRepository` reject a change of quantization the same way they reject a change of model.

### 17.3 What remains unverified

- macOS — there is still no machine.
- CI on three operating systems was never run: every number here was obtained manually on Windows.
- A full rebuild of the index under macOS and under Node 24 was not tested.

---

## 18. External benchmark: third-party repositories and a grep baseline

Date: **2026-10-01**. Windows x64, 4 cores, Node v22.23.2.
Benchmark: `scripts/bench-external.mjs` (`node scripts/bench-external.mjs --corpus <name>`).

### 18.1 Why it is needed

The fixture benchmark (§13) answers the question «did anything break», but not
the question «are we better than plain grep». There the expected answer is known
in advance and sits next to the query in meaning, and the corpus — 17 files.

Here the questions are taken from the commit history of third-party repositories:
the commit subject — the query, the files it changed — the answer. Neither side
helped write the key. The corpus and the pinned commits mirror
`denfry/codebase-index` (Flask, Gson, Fastify) so their numbers can be put next to ours.

### 18.2 Question selection

The filter is declared up front and applied to every commit in turn, with no
look at the results, or the selection would end up tuned to the score. Dropped:
subjects under 12 characters, conventional-commit noise («update», «fix typos»,
«bumped v6.0.0»), subjects with an issue number or an author mention, commits
touching more than three indexable files, and commits whose files were later deleted.

| Corpus | Commits | Rejected by subject | >3 files | File deleted | Questions |
|---|---:|---:|---:|---:|---:|
| Flask | 1998 | 1242 | 89 | 470 | 197 |
| Gson | 1402 | 990 | 87 | 118 | 207 |
| Fastify | 2220 | 1979 | 26 | 99 | 116 |

### 18.3 Results

Tokens are counted with the same model tokenizer on both sides and one text per
call: a batch needs padding, and PAD tokens land in the count and inflate the cost.

| Corpus | Language | n | | hit@1 | hit@3 | hit@5 | hit@10 | MRR | tokens |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Flask | Python | 197 | anyindex | 0.584 | 0.711 | 0.777 | 0.827 | 0.663 | 1178 |
| | | | grep-80 | 0.198 | 0.203 | 0.284 | 0.411 | 0.255 | 2155 |
| Gson | Java | 207 | anyindex | 0.304 | 0.473 | 0.531 | 0.604 | 0.395 | 1071 |
| | | | grep-80 | 0.053 | 0.058 | 0.130 | 0.208 | 0.101 | 2697 |
| Fastify | JavaScript | 116 | anyindex | 0.233 | 0.328 | 0.457 | 0.500 | 0.309 | 992 |
| | | | grep-80 | 0.043 | 0.043 | 0.060 | 0.147 | 0.073 | 6491 |
| **Total** | | **520** | **anyindex** | 0.394 | **0.531** | 0.608 | 0.644 | 0.477 | 1080 |
| | | | **grep-80** | 0.098 | 0.110 | 0.163 | 0.258 | 0.153 | 3800 |

Paired bootstrap over the questions, 10000 iterations: both sides are measured on
the same list of queries, so the difference of means is computed pairwise — an
independent bootstrap would overstate the confidence.

| Comparison | Difference | 95% CI | p |
|---|---|---|---|
| hit@3 | +0.421 | [+0.364, +0.481] | <0.001 |
| MRR | +0.324 | [+0.268, +0.381] | <0.001 |

Conclusion: against plain grep the tool wins on all three corpora, and it wins
on both quality and token count at once.

### 18.4 Cannot be compared directly against `denfry/codebase-index`

Their hit@3 = 0.547 on 450 questions, ours is 0.531 on 520. The numbers are close,
but there is no direct comparison: their corpus is different, and above all their
vectors are optional and the main path is path/symbol/FTS retrievers. We are
measuring a different architecture on the same corpus, not our own version of
their benchmark. Setting these two numbers side by side as «better/worse» — incorrect.

⚠️ Their corpus is the same three repositories at the same commits, so we have an
identical input. Their 0.547 against our 0.531 — the only honest comparison in
this niche, and the 0.016 gap falls inside the noise at n = 450–520 without a
pairwise test by their methodology. Neither «we are on par» nor «we are worse»
can be claimed on the strength of that number.

### 18.5 Documentation was crowding out code

The first version of the benchmark showed: markdown was top-1 in **25.2 %** of
cases, in top-3 — in 36.2 %, and of all the wrong top-3 hits 316 were markdown.
This is the most common cause of a miss: the commit subject is written in
natural language, and the README chunk sits closer to it than the code does.

The document weight is cut by 10 % (`DOCUMENTATION_WEIGHT` in `src/search.ts`).
After that markdown was top-1 in **13.8 %** of cases — half as often.

The weight was picked by exhaustive search rather than by eye, and the upper bound was chosen deliberately:

| Weight | hit@3 on corpora | Documentation in top-1 (8 doc queries) |
|---|---|---|
| 1.0 (no weight) | 0.517 | 3/8 |
| **0.9** | **0.531** | **3/8** |
| 0.8 | — | 1/8 |
| 0.7 | — | 0/8 |

Below 0.9 the corpus metric kept rising, but the queries whose answer lives in
the documentation started to break. That fits the prior «documentation is never
needed»: across the 520 questions of the three corpora markdown is not the answer
once, so such a weight optimizes exactly the property the set does not have. It
was checked separately that on the eight documentation queries the README stays
the first result.

Separately worth noting: the weight acts as a tie-breaker, not a ban: the mean
rank of markdown in the results barely moves (1.94 → 1.93) — close cases get
flipped, not documentation as a whole.

### 18.6 topK was being spent on duplicate files

In **23.7 %** of questions the top-3 held fewer than three unique files: one file
took two or three slots with different chunks. The tool returned topK **chunks**,
not topK files, and one big file crowded out the rest of the candidates.

The limit is one chunk per file (`MAX_CHUNKS_PER_FILE`). After the change such
questions are **0**, hit@3 grew from 0.467 to 0.508 with not a single change to
the ranking. For detail inside a file the agent goes through `get_file_outline` and
`Read`, for which there are separate tools.

Measured separately: topK in the code and topK in the results now mean different
things: the chunks asked for as `topK = 5` turn into at most 5 unique files, so
there may be fewer results than were requested.

### 18.7 Corpus cost

Indexing on 4 cores, q8 embedding, real chunks:

| Corpus | Files | Chunks (AST / fallback) | Vectorizing |
|---|---:|---|---:|
| Flask | 101 | 439 (407 / 32) | ~9 min |
| Gson | 289 | 1628 (1416 / 212) | ~35 min |
| Fastify | 378 | 2574 (1605 / 969) | ~70 min |

Embedding stays the bottleneck, and on the corpus with a lot of documentation
(fastify: 969 fallback chunks out of 2574) it eats into the quality as well.

### 18.8 What this benchmark does not check

- **Russian.** All three corpora are English. The Russian-query problem from §13
  is not measured here and stays open.
- **Real usefulness for an agent.** The metric — a file landing in the results,
  not «whether the agent could solve the task». Nothing was checked at task level.
- **Ranking regressions between runs.** Every run measures afresh; there is no
  automatic «did it get worse» control.
- **macOS and Linux.** The numbers were taken on Windows x64.

### 18.10 Why quality drops as the corpus grows

hit@3 by corpus: 0.711 (flask) → 0.473 (gson) → 0.328 (fastify). The first guess
is the language: Python against Java and JavaScript. The check did not confirm it.

**The questions are equally reachable in all three corpora.** An answer counts as
reachable if the expected file holds at least one significant word of the query:

| Corpus | Questions | Reachable | hit@3 | Gap |
|---|---:|---:|---:|---:|
| Flask | 197 | 89.3 % | 0.711 | 0.18 |
| Gson | 207 | 91.8 % | 0.473 | 0.44 |
| Fastify | 116 | 94.0 % | 0.328 | 0.61 |

Reachability in the «bad» corpora is higher than in the good one, so «worse
questions» and «worse code» are both ruled out. The mean chunk size is almost the
same too: 1539 / 1483 / 1375 characters.

**Corpus scale confirmed by a controlled experiment.** The same 102 gson questions
were measured on two indexes — the full one and one trimmed down to a subset of
directories:

| Index | Chunks | hit@1 | hit@3 | hit@10 |
|---|---:|---:|---:|---:|
| gson full | 1628 | 0.176 | 0.373 | 0.510 |
| gson trimmed | 564 | 0.265 | 0.422 | 0.755 |
| delta | −1064 | +0.088 | +0.049 | **+0.245** |

Shrinking the index 2.9 times raises hit@10 by a quarter. The questions here are
literally the same — otherwise different sets would be compared and the gap would
be explained by the change of questions, not by the index size.

**What stayed unresolved.** The trimmed gson gives hit@3 0.422 against 0.711 for
flask, but these are different question sets, so the residual «language» effect is
plausible and unproven. It can only be separated out with a Java corpus of Python
size and comparable question difficulty — the set has no such thing.

**Checked and discarded:** truncation of the result list. At `topK = 10` all three
corpora return the full 10 results (minimum 9, queries falling short — 2 %), so
hit@10 is not an artifact of the candidate pool.

**Merging the branches.** RRF against pure lexical and pure semantic:

| Corpus | hybrid | keyword | semantic |
|---|---:|---:|---:|
| Flask | 0.711 | 0.635 | 0.701 |
| Gson | 0.473 | 0.377 | 0.411 |
| Fastify | 0.328 | 0.302 | 0.345 |

On gson the hybrid gives +0.062 over semantic — that is about 13 questions, a
significant difference. On fastify semantic is formally higher by 0.017, but that
is two questions out of 116, i.e. noise; merging cannot be said to hurt there.

**Practical conclusion.** The bottleneck is not the cost of vector search: at 2574
chunks, up to the ANN threshold from §4 (50 000), the distance range is three
orders of magnitude, while the quality has already halved. What hurts is the
ability to tell candidates apart inside a corpus, not the speed of searching it.
So §4's measurement and the real quality limit are different problems, and mixing them up is unwise.

### 18.9 Result of the two ranking changes

Both measures from §18.5 and §18.6 are applied together. The question pool and the corpora are the same — 520.

| Metric | Before | After | Gain |
|---|---:|---:|---:|
| hit@1 | 0.369 | 0.394 | +0.025 |
| hit@3 | 0.473 | **0.531** | +0.058 |
| hit@5 | 0.531 | 0.608 | +0.077 |
| MRR | 0.437 | 0.477 | +0.040 |
| markdown in top-1 | 25.2 % | 13.8 % | −11.4 pp |
| questions with duplicates in top-3 | 123 | 0 | — |

The fixture benchmark (§13) with the same changes: top-1 **15/24 → 18/24**, top-5
unchanged (24/24). Russian 5/10 → 6/10, English 10/14 → 12/14.

Contributions separately, with dedup on: dedup takes hit@3 0.467 → 0.517, the
documentation weight 0.517 → 0.531. The weight helps most on fastify (+0.034) —
that is where the documentation is thickest (969 fallback chunks out of 2574).

⚠️ The first version of the downweighting changed only the `score` field and left
the order by raw RRF. On the measurement it looked like «the weight does nothing»:
hit@3 matched to the third decimal at 1.0 and 0.9. The discrepancy surfaced only
because the change was first checked by exhaustive search and then separately on
the real code — the search counted the weight in the sort, the implementation did
not. A test on the order was added in `src/search.test.ts`.
