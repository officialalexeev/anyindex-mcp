# 03. Implementation plan

Rule: **every stage ends with a working, verifiable artifact.** Nothing is written "for the future" — code that the nearest stage does not need is not written.

---

## Stage 0. Environment check (1 day)

**Verified on Windows, on a clean machine, without Visual Studio Build Tools.** This is an acceptance criterion, not a recommendation (ADR-011). All five items de-risk R1, R2, R3 **before** any code is written.

**0.1 `code-chunk` — both paths**

```bash
# default path (ADR-009)
npm i code-chunk@0.1.14
node -e "import('code-chunk/wasm').then(m => m.chunk('a.ts','export function f(){return 1}').then(c => console.log(c.length, !!c[0].context.scope)))"

# native path — measure the difference
npm i
node -e "import('code-chunk').then(m => m.chunk('a.ts','export function f(){return 1}').then(c => console.log(c.length)))"
```

Criterion: **the WASM path works on Windows without MSVC.** Measure the speed ratio of the two paths on identical input — that is the data for revisiting ADR-009 if the degradation is unacceptable.

**0.2 Model and `@huggingface/transformers` — R3, the riskiest one**

```bash
npm i @huggingface/transformers@4.3.0
node -e "import('@huggingface/transformers').then(async ({pipeline,ModelRegistry}) => {
  console.log(await ModelRegistry.get_available_dtypes('jinaai/jina-embeddings-v2-base-code'));
  const p = await pipeline('feature-extraction','jinaai/jina-embeddings-v2-base-code',{dtype:'q8'});
  const o = await p(['function login(){}'], {pooling:'mean', normalize:true});
  console.log(o.dims);
})"
```

Criterion: it installs and loads the model on Windows **without MSVC**; `q8` is in the list of available dtypes; `dims` = `[1, 768]`. **If MSVC is needed here — stop, the stack is reconsidered before any code is written.** That is R3, potentially blocking.

**0.3 Speed**

10 000 typical chunks. Record: chunks/sec (both chunker paths), peak RSS, first model load time.

**0.4 `sqlite-vec` + FTS5 + `better-sqlite3`**

Insert 1 000 vectors of 768d, search k=10, text search via `bm25()`. Check that a prebuilt binary exists for the target Node version on Windows. If not — switch to `node:sqlite` immediately (R2).

**0.5 `fast-glob`, `ignore`, `chokidar`**

Versions, absence of conflicts. Separately: the divergence between the path forms of `chokidar` vs `fast-glob` on Windows — this pins down the normalization implementation (§ `02-architecture.md` 10).

**Acceptance criterion:** all five items are reproducible on Windows without MSVC; the numbers are recorded in `docs/06-environment.md`. Any failure → an ADR in `04-risks.md` and a reconsideration of the stack **here**, not at stage 4.

---

## Stage 0.5. CI matrix (0.5 days) — ⏸ deferred per ADR-016

**A precondition without which the claim "works on all operating systems" is unprovable** (ADR-015).

The file `.github/workflows/ci.yml` is created. Four jobs:

| Job | Matrix | What it proves |
|---|---|---|
| `build` | windows/ubuntu/macos × Node 22.19, 24 | Build, types and tests on all target combinations |
| `probe` | windows/ubuntu/macos | The same set of environment checks; the log is attached as an artifact |
| `install-scripts` | windows/ubuntu/macos | The hypothetical "there are no prebuilds" scenario — `approve` + `npm rebuild` |
| `path-normalization` | windows/ubuntu/macos | Path behaviour on all platforms |

**The key check in `probe`:** `node -e "require('better-sqlite3'); require('onnxruntime-node')"`. This is a direct check of whether the prebuilds are available — exactly the question that blocks Windows.

`install-scripts` is marked `continue-on-error: true`: it checks the bypass route, not the main scenario, and must not fail the build.

**Acceptance:** a green run on all three operating systems; artifacts with probe logs attached. The first run on Windows closes the three blocking items from `06-environment.md` §5.

✅ The Git repository is initialized locally, the first commit is made. **CI will not start until the repository is pushed to GitHub.** A public repository is not required — Actions works on a private one too (2000 Linux-minutes/month free).

**Division of roles:** a local `npm run verify` on the developer's machine covers their OS; CI covers the rest. Details in `08-binary-distribution.md` §8.

---

## Stage 1. MCP server skeleton (0.5 days) — ✅ done

- `package.json` (ESM, `type: module`, `bin`), `tsconfig.json` (strict, `NodeNext`)
- `src/index.ts`: `McpServer` + `StdioServerTransport`
- `src/logger.ts`: stderr only
- One check tool `ping` → `pong`
- `tsc` build, launch, manual call via `npx @modelcontextprotocol/inspector`

**Acceptance:** the server starts, the inspector sees `ping`, stdout contains nothing but JSON-RPC.

---

## Stage 2. Scanner (0.5 days) — ✅

- `src/config.ts` — zod schema, `--root`/`--db`/env
- `src/scanner.ts` — `fast-glob` over the extensions from §3.1, `ignore` for `.gitignore` + `.anyindexignore`, default exclusions
- `sha1` of the content
- Symmetric paths, no `..`, no symlink escape beyond root

**Acceptance:** on a test repository it outputs N files; `node_modules`, `.git`, `dist`, `.anyindex` are excluded; a file from `.gitignore` does not get in; a repeat run is deterministic.

---

## Stage 3. Chunker + database (1 day) — ✅

- `src/chunker.ts` — `createChunker` once per process, `contextMode:'full'`, `siblingDetail:'signatures'`
- `src/db.ts` — schema from `02-architecture.md` §4, WAL, migrations via `meta.schema_version`
- Writing chunks into `chunks` + `chunks_fts` (vectors later)
- `indexer.ts`: traversal → chunk → write in one transaction per file

**Acceptance:** an index over 200 files; `contextualizedText` contains the scope chain; FTS5 finds a chunk by function name; a repeat run on an unchanged tree does not change the `id` of the chunks.

---

## Stage 4. Embeddings + vector search (1.5–2 days) — ✅

- `src/embedder.worker.ts` + `src/embedder.ts` — embeddings **in a worker thread** (§ `02-architecture.md` 3.1), `warmModel()` at startup, idle unload
- `dtype:'q8'`, `{pooling:'mean', normalize:true, quantize:true, precision:'int8'}`; batches of 16–32
- Writing into `chunks_vec`; `meta` = `model_id`, `revision`, `dim`, `dtype`
- `src/search.ts` — vector search + FTS5 + RRF
- `src/render.ts` — result format from §8.4 + token estimate
- Tools `anyindex_search`, `index_status`

**Acceptance:**
- `anyindex_search` in Russian («где логинится пользователь») finds `login`; in English («user authentication flow») too.
- Search by exact name (`UserService`) finds the right chunk.
- Empty query → honest text, not JSON.
- `index_status` returns real numbers, including `degraded`, `astChunks`, `fallbackChunks`.
- **AST really fired:** the chunk has `context.scope` and `context.entities`, `fallbackChunks == 0`.
- Change `model_id` in `meta` → the server refuses to search and suggests a rebuild.
- **Indexing does not block the MCP channel:** during `index_update` the `index_status` tool responds within normal latency.
- **The same set of checks on Windows.**

**Moment of truth:** measure the time to fully index a medium-sized repository (5–20k files). If > 30 min — reduce the volume (larger `maxChunkSize`, `contextMode:'minimal'`) or switch to ANN.

---

## Stage 5. Incrementality (1–1.5 days) — ✅

- `src/watcher.ts` — `chokidar`, debounce 500 ms, queue
- Per-chunk `content_hash`: a matching chunk reuses the vector
- Deletion of the chunks of files that disappeared
- `index_rebuild`, `index_update` with progress notifications
- State in `files`

**Acceptance:**
- Editing one line in a 2000-line file → < 5% of that file's chunks are re-embedded.
- Deleting a file → its chunks and vectors disappear from the database.
- Two processes: search during a reindex does not crash.
- `index_rebuild` over 1000 files sends progress.

---

## Stage 6. Polish (0.5 days) — ✅

- Tool descriptions per §8.3; results text polished
- Test: 20 typical questions about the repository → hit rate measurement
- README: installation, configuration, connecting to clients

**Acceptance:** ≥ 15/20 questions give a relevant result in the top-5; not a single case of hallucination when the code is absent from the index.

---

## Stage 7. Rerank cross-encoder (0.5–1 day, optional) — ⏸

The cheapest way to raise result quality, if stage 6 gave < 15/20 (§ `02-architecture.md` 6.4).

- `Xenova/bge-reranker-base` in the same worker as the embeddings
- `RRF → top-30 → rerank → top-K`
- A separate stage with its own weight, **not** a multiplier in someone else's formula

**Acceptance:** the same 20 questions. **Rerank must improve the result** — if it did not, the stage is removed rather than kept as "might come in handy". Plus a latency measurement: rerank top-30 on CPU.

---

## Stage 8. Second-client verification (0.5 days)

- Connect the server to a second MCP client over stdio
- Check name normalization: server `index`, tools only `[a-z0-9_]`, shorter than 40 characters
- Check that stdout does not leak into the host log

**Acceptance:** `anyindex_search` is available in the second client, `index_status` shows a non-empty index; tool names are not mangled by a hash.

---

## Stage 9 (optional). Call graph (0.5 days) — ⏸

- Install `tree-sitter-analyzer` as a separate MCP server (option A from `02-architecture.md` §7)
- Verify: `--full-index` on a test repository, `callers`/`callees` return meaningful results
- Document joint usage in the README

**Acceptance:** both servers work in one client; the agent gets answers from both semantic search and the graph.

---

## Order and dependencies

```
0 ──► 0.5 ──► 1 ──► 2 ──► 3 ──► 4 ──► 5 ──► 6 ──► 7 ──► 8
                   ▲                            │
                   └── 9 ───────────────────────┘   (independent, after 4)
```

Stages 0 and 1 are blocking. Stage 4 is the main one: if the model or the speed does not fit, the stack has to be reconsidered **before** stage 5. Stage 7 is enabled **only** on the basis of the results of stage 6: if rerank does not improve anything, it is removed.

---

## Summary

| Stage | Duration | Artifact |
|---|---|---|
| 0 Environment check | 1 d | `docs/06-environment.md` with the numbers — ✅ Linux |
| 0.5 CI matrix | 0.5 d | Workflow created, the run deferred to stage 6 (ADR-016) |
| 1 MCP skeleton | 0.5 d | A server with `ping` |
| 2 Scanner | 0.5 d | List of indexed files |
| 3 Chunker + database | 1 d | Database with chunks and FTS5 |
| 4 Embeddings + search | 1.5–2 d | A working `anyindex_search` |
| 5 Incrementality | 1–1.5 d | Watcher and queue |
| 6 Polish | 0.5 d | README, result quality, index portability between operating systems |
| 7 Rerank (opt.) | 0.5–1 d | Quality improvement — or removal of the stage |
| 8 second client | 0.5 d | Verification against a second MCP client |
| 9 Graph (opt.) | 0.5 d | Joint work with tsa |

Total: **7.5–9 days** for the core (0–6, 8), **+1–1.5 days** if 7 and 9 are needed.

---

## Actual state as of now

| Stage | Status | Comment |
|---|---|---|
| 0 Environment check | ✅ | Linux; Windows not verified (ADR-016) |
| 0.5 CI matrix | ⏸ | Workflow created, run deferred (ADR-016) |
| 1 MCP skeleton | ✅ | 5 tools, annotations, outputSchema |
| 2 Scanner | ✅ | 5 tests, POSIX paths, deny-list of lock files |
| 3 Chunker + database | ✅ | Migrations, FTS5 with triggers, vec0, strategy registry |
| 4 Embeddings + search | ✅ | Worker isolation, RRF, background indexing |
| 5 Incrementality | ✅ | Chokidar, debounce, hash-based reuse |
| 6 Polish and quality | ✅ | Benchmark of 17 queries, README |
| 7 Rerank | ⏸ | Not enabled: it would not give an improvement — the bottleneck is in the distances, not in the ranking |
| 8 second client | ⏳ | Verification against a second client pending |
| 9 Call graph | ⏸ | A separate `tree-sitter-analyzer` server, ours does not involve it |

### Deviations from the plan, found along the way

| Planned | Done differently | Why |
|---|---|---|
| `index_update` waits for completion | A background job + polling `index_status` | The MCP request timeout is 60 s, indexing takes minutes |
| `code-chunk/wasm` as an escape hatch | Native path, WASM deferred | Requires vendoring the core and grammars for 6 languages |
| One chunker | Strategy registry | `code-chunk` fails on `.md`/`.yaml`/`.json` |
| A relevance threshold was not planned | Introduced, calibrated, found not to work for some cases | The measurement showed overlapping distributions |
| `get_file_outline` in stage 4 | Added later, when checking against reality | The data was already in the index |
| `resourceLimits` of the worker at 4 GB | Not set | It led to an OOM death at 2 GB |

### What remains unresolved

1. **Windows and macOS are not verified** — five accumulated items in ADR-016.
2. **The Russian language** — works, but with systematically worse confidence (§10.2 `06-environment.md`).
3. **Negative queries 2/3** — neither distance nor gap separates them.
4. **Performance on weak hardware** — 1 core gives ~780 ms/chunk; large repositories are impractical.
5. ~~`get_file_outline` without a test~~ — closed: `src/outline.test.ts`, including the error contract for an unknown file.
