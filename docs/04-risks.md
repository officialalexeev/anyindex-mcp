# 04. Risks and decisions (ADR)

## Risk register

### R1. `code-chunk` pulls in 6 native tree-sitter modules — critical

**Fact:** `tree-sitter-{go,java,rust,python,javascript,typescript}` are built through node-gyp → V8 ABI lock-in. The package has no `engines` field at all, version `0.1.14` (pre-1.0).

**Consequence:** changing the Node major version, or an Alpine/musl/Nix build of Node → it falls over before the server starts. `node_modules` will have to be rebuilt natively.

**The target platform is Windows.** A native node-gyp build on Windows requires Visual Studio Build Tools (MSVC). That is a separate install on every machine, separate versions, separate failure points — exactly the class of problems that ruled out `mcp-vector-search` (§ `05-landscape.md` 2.1).

**Options:**

| | Pros | Cons |
|---|---|---|
| A. Native modules by default | Maximum speed | MSVC on every machine; ABI lock-in; regressions on updates |
| **B. `code-chunk/wasm` (WASM via `web-tree-sitter`)** | `npm i` and that's it; ABI-independent; cross-platform with no toolchain | Slower (expect 1.5–3×) |
| C. Own traversal via `web-tree-sitter` | Full control, any languages | More code |

**Decision: ❌ CANCELLED 2026-09-29, see `07-bun-vs-node.md` §3.**

The original ADR wording — "a one-line import swap" — is **factually wrong and disproved by actually running it**. `code-chunk/wasm`:
- exports neither `chunk` / `chunkStream` / `chunkBatch` — neither under Bun nor under Node;
- exports a different API: `createWasmParser`, `createChunker`;
- `createWasmParser()` fails with `this.config.treeSitter` undefined — it needs **explicit per-language configuration of the WASM binary**.

**What the WASM path requires, from the source `code-chunk/src/parser/wasm.ts`:**

```ts
type WasmConfig = { treeSitter: WasmBinary }   // Uint8Array | ArrayBuffer | Response | string(URL)
Parser.init({ locateFile: () => '', wasmBinary: wasmBinary.buffer })
// WasmGrammarError: 'No WASM binary provided for language: ${language}'
```

That means putting **two** sets of binaries into the package:
1. `tree-sitter.wasm` — the `web-tree-sitter` runtime core;
2. the grammars, separately, for each of the 6 languages.

`toUint8Array` accepts a URL string and pulls it down via `fetch` — so either we vendor the `.wasm` into the package or we stand up our own source. `locateFile: () => ''` shows that the path is resolved by hand.

**Current status: R1 is an open question, an unresolved risk.**

| | Native path | WASM path |
|---|---|---|
| Works | ✅ **verified**, AST extracts entities | ✅ works, but the API is different (`createWasmParser`) |
| Install on Windows | MSVC Build Tools | no toolchain |
| Vendoring binaries | zero | core + 6 grammars |
| Amount of work | zero | configuration, tests, a publishing pipeline for the binaries |

**What to do at stage 0.1:** check whether prebuilds of the native tree-sitter packages exist for the target Node version on Windows. If they do — **native path, WASM is postponed**. WASM only makes sense when a native build is impossible; then it is a separate task with binary vendoring, not a one-line swap.

**What definitely works (verified, `07-bun-vs-node.md` §2):** native `code-chunk` under Bun and Node correctly extracts entities via tree-sitter.

**Mitigation:** `optionalDependencies` for the native modules is impossible (these are runtime deps of the package). We keep a pinned `code-chunk` version in the lock file.

---

### R2. `better-sqlite3` is tied to the V8 ABI — medium

**Fact:** it compiles against `NODE_MODULE_VERSION`, and the shipped binary is pinned to the Node major version. The N-API request (`WiseLibs/better-sqlite3#271`) has been open since 2019 with no reply.

**Consequence:** changing the Node major → rebuild. On top of that the R1 problem is duplicated: two sources of native builds.

**Options:** `better-sqlite3` (verified, FTS5 out of the box) · `node:sqlite` built in (Node 22+, FTS5 depends on the SQLite build) · `libsql` on N-API (ABI-stable, but `sqlite-vec` does not work over the network — irrelevant for a local file).

**Decision: `better-sqlite3`.** FTS5 is guaranteed, RRF needs a lexical layer. `node:sqlite` is the fallback if R1 and R2 start to collide: it has no native build at all.

⚠️ **Windows:** unlike R1, the risk here is lower — `better-sqlite3` publishes prebuilt binaries for all platforms, and MSVC is only needed when they are missing. But it must be checked on Windows (stage 0.4): if there is no prebuild for the target Node version, we switch to `node:sqlite` automatically.

**Mitigation:** pin the Node major in `engines`, document it in the README.

---

### R3. `@huggingface/tokenizers` — native module — medium

**Fact:** runtime dep of `@huggingface/transformers@4.3.0` (`^0.2.0`). Alongside ours: `onnxruntime-node@1.30.0`. So there are **three** native trees in one project (R1 + R2 + R3).

⚠️ **Windows:** `onnxruntime-node` publishes prebuilt binaries, but `@huggingface/tokenizers` is a separate question. If it needs MSVC, then R1+R3 give two native requirements, and that is the same class of pain all over again. Checked first at stage 0.2.

**Decision:** check at stage 0.2 that the package installs and loads the model **on Windows without MSVC**. On an ABI conflict there is no way to keep `transformers.js`, but it is probably the riskiest component to replace: the alternative (Ollama/llama.cpp) breaks the "fully offline in a single process" requirement.

**Run on 2026-09-29 on Linux (`06-environment.md`):** ✅ `onnxruntime-node` and `@huggingface/tokenizers` work, the model loads and computes (48 ms/chunk), prebuilds are present. **Not verified on Windows.**

⚠️ **npm 11.19 blocks install scripts by default** — `onnxruntime-node` (postinstall) and all six `tree-sitter-*` (`node-gyp-build`). On Linux it works thanks to the ready-made prebuilds; on Windows, if there are no prebuilds for the required platform, the build will not happen without `npm install-scripts approve`. The same barrier as `bun pm trust` in Bun (`07-bun-vs-node.md` §4) — **you cannot choose a runtime on this basis, the block exists on both sides.**

**Mitigation:** treat R3 as potentially blocking on Windows. If it breaks, first check how ready `better-sqlite3` and `code-chunk` are for `node:sqlite` and WASM respectively (option B in R1, the fallback in R2).

---

### R4. The `jina` model has not been updated since January 2025 — low

**Fact:** `lastModified: 2025-01-06`, Apache-2.0, ungated, 139k downloads.

**Assessment:** for semantic search over 2023-era code the quality is sufficient. Stability is a plus: the pinned revision is reproducible.

**Mitigation:** `model_id` and `revision` in `meta`. Changing the model means rebuilding the index (checked in `db.ts`).

**Alternative, if something fresher is needed:** `onnx-community/*` actively publishes ONNX variants of current models; `ModelRegistry.get_available_dtypes()` lets you check readiness before choosing.

---

### R5. `sqlite-vec` — pre-v1 — low

**Fact:** the author writes "expect breaking changes".

**Mitigation:** isolation in `src/db.ts` + `schema_version` in `meta`. The schema is our SQL queries, not the extension's API. A migration touches one module.

---

### R6. Host wipes the env of MCP subprocesses — low

**Fact:** some MCP hosts scrub subprocess env by `/KEY|PASSWORD|SECRET|TOKEN/i`. An explicit `env:` block survives where the host merges it after the scrub.

**Mitigation:** our server **needs no secrets** — the model is ungated. There is no `*_TOKEN`/`*_KEY` in the configuration. The problem is resolved by construction.

**Residual:** some hosts normalize tool names — only `[a-z0-9_]`, shorter than 40 characters. Fix this in the naming convention and in the review checklist.

---

### R7. Retrieval accuracy on real code — medium

**Fact:** never measured. Everything in `01-research.md` is about which components exist, not about the quality of the results.

**Mitigation:** the metric is defined in advance — 20 typical questions, top-5 hit rate (stage 6). **If < 15/20 — we do not polish prompts, we go back to the model and `maxChunkSize`.** Retrieval is what this project should optimize first, not the instruction text.

Known lever: `all-MiniLM-L6-v2` cuts at 256 tokens and silently mangles chunks of 1500 bytes. With jina (8192) this problem does not exist. If we roll back to MiniLM — `maxChunkSize` must be ≤ ~700 bytes.

---

### R8. Everything local — no independent way to learn that the index is current — low

**Mitigation:** `index_status` returns `stale`, `lastUpdated`, counters. The model sees the freshness in every result. `files.stale > 0` → an explicit warning in the response text.

---

### R9. Silent degradation — medium-high

**Fact:** issue #182 of the `mcp-vector-search` project: "Tree-sitter parsing **silently** disabled" — an incompatible API after the `tree-sitter-language-pack >= 1.0` rewrite. AST chunking is disabled, there is no error, the server runs, the index is created.

This is the worst class of failure in our system: it yields a **working but junk** index. It is detected only from the quality of the results, that is, when the user has already concluded that the tool is useless.

**Rules that follow from this case:**

1. Any degradation failure must be visible in `index_status`: `astChunks`, `fallbackChunks`, `skippedByLanguage`.
2. Any degradation failure must be printed to stderr immediately, not in the final report.
3. `index_status` shows `degraded: true` if AST chunking is disabled, and the MCP server **refuses** to serve `anyindex_search` in that state, offering `index_rebuild` instead.
4. Counters are compared against the expectation: if `chunks == files` for a repository containing functions — suspect a fallback to character-based splitting.
5. In tests — a check that the AST actually fired: a chunk must contain `context.scope` and `context.entities`, not just text.

**A broader rule:** "works" ≠ "works correctly". All index state metrics go in `index_status`, without exception.

---

### R10. Platform — Windows, both development and runtime — medium

**Fact:** the target platform was set by the user. The `mcp-vector-search` failure happened on exactly Windows + Python 3.12.

**What this changes in the project:**

- The minimum Node version is pinned in `engines`; checked at stage 0.
- Paths go through `node:path` everywhere, never string concatenation. The `/` separator in the MCP config works on Windows, but inside the code it does not.
- `chokidar` requires path normalization before comparison with database records. It hands back paths with forward slashes, while `root` arrives native, so a string comparison on Windows treats the root as a path outside itself. Otherwise incrementality would "not find" the file after a restart.
- A `.cmd` shim in `bin` for npm, if the server is launched as a command.
- CI on Windows — otherwise every check passes on Linux and breaks for the user.

**Check first at stage 0:** installation of all dependencies on a clean Windows machine **without Visual Studio Build Tools.** This is an acceptance criterion, not a recommendation.

---

## ADR

### ADR-001: MCP server instead of a proprietary plugin

**Context:** the original brief proposed a host plugin. A proprietary harness was evaluated as the host and rejected as the carrier: a plugin runs in one ecosystem only.

**Decision:** a standalone MCP server over stdio.

**Rationale:**
- Portability: opencode, Claude Code, Cursor — one artifact.
- Stability: MCP is a stable specification; a host plugin API ships with the host and can break.
- We need neither an agent loop, nor `tools/pre-execute`-style hooks, nor auto-injection into the prompt.
- No host framework dependency at all.

**Price:** no control over the system prompt; support for `instructions` from `initialize` has not been verified in any client. Compensated for by a good tool description (R7).

**Revisit if:** a confirmed need appears for auto-injecting chunks into the prompt.

---

### ADR-002: `jinaai/jina-embeddings-v2-base-code`

**Context:** we need a code-oriented model that runs offline in Node.

**Decision:** jina-embeddings-v2-base-code, `dtype:'q8'`, `{pooling:'mean', normalize:true}`.

**Rationale:** Apache-2.0 (commercially free — checked against the model card; the original framing did not mention the license), ungated, 768d, 30 languages, **8192 tokens** (ALiBi), the ONNX files are already in the repository, and there is an official JS example on the model card.

**Alternatives:** `all-MiniLM-L6-v2` (faster, but 256 tokens — conflicts with chunks of 1500 bytes) · `bge-small-en-v1.5` (requires `pooling:'cls'` and a query prefix) · external APIs (violate the offline requirement).

**Price:** 161 million parameters against 22 million for MiniLM; not updated since January 2025.

---

### ADR-003: `better-sqlite3` + `sqlite-vec` + FTS5

**Decision:** a single `.db` file, vec0 for vectors, FTS5 for BM25, RRF for merging.

**Rationale:** one artifact, no external service deployment, FTS5 built in — RRF works with no external dependencies. `tree-sitter-analyzer` uses the same combination (SQLite + FTS5), so the decisions converge.

**Alternatives:** LanceDB (`vectordb` — **not verified**, crossed out) · libSQL (ABI-stable, but `loadExtension` does not work over the network; for a local file — a plus with no downside, if it is ever needed) · pure memory (does not survive a restart).

**Price:** R2 (ABI), R5 (pre-v1), the absence of ANN — acceptable up to ~50k chunks, the threshold is measured at stage 4.

---

### ADR-004: Call graph — a separate server

**Decision:** `tree-sitter-analyzer@2.2.0` is installed alongside as a separate MCP server (option A). We do not build our own call graph.

**Rationale:** it already closes the task — 8 tools, a call graph with cross-file edge classification, impact analysis, 22 languages, SQLite+FTS5, MIT, local. Building our own would be months with no added value.

**Price:** two MCP processes; our server knows nothing about the graph; the LLM calls two different sources. Verified acceptable: `tsa` has a semantic `search action=chain` with cosine rerank, so the overlap with `anyindex_search` is partly justified.

**Revisit if:** a client cannot hold several MCP servers at once (then option C — a proxy).

---

### ADR-005: Incrementality via per-chunk hashes, not a Merkle tree

**Decision:** `content_hash` on every chunk; a match means the vector is reused.

**Rationale:** it covers ~90% of the benefit (fixing one function in a large file), it is trivial, and it requires no traversal of the directory tree. `zilliztech/claude-context` uses Merkle — we keep it as a known improvement should the measurements show a bottleneck.

**Price:** reindexing a file still requires chunking it in full (the AST works on the whole thing). Merkle at the file level fixes that; at the directory level it does not.

---

### ADR-006: `structuredContent` + textual `content` at the same time

**Decision:** return both machine-readable and textual.

**Rationale:** with a declared `outputSchema` the SDK **requires** `structuredContent` (otherwise `ProtocolError`). But the model reads text, it does not parse JSON. Neither one works without the other.

---

### ADR-007: Logging only to stderr

**Rationale:** stdout is the JSON-RPC channel. Any write to stdout breaks the transport. At stage 1 — a separate check.

---

### ADR-008: No secrets in the configuration

**Rationale:** some MCP hosts wipe env by `/KEY|PASSWORD|SECRET|TOKEN/i` (R6). The model is ungated — no key is needed. Risk removed by construction, not a workaround.

---

### ADR-009: `code-chunk/wasm` by default — CANCELLED, native path until Windows is confirmed

The original ADR wording (WASM by default, native path as an option) is **disproved by the empirical check** of 2026-09-29. The WASM path requires vendoring the `tree-sitter.wasm` core plus grammars for each of the 6 languages — that is not an import switch. Full details in `07-bun-vs-node.md` §3 and R1.

**Intermediate decision:** native path (verified working), WASM postponed as a separate task in case a native build on Windows is impossible. The final choice comes after stage 0.1.

**Return to the ADR if:** at stage 0.1 it turns out that prebuilds of `tree-sitter-*` for the target Node version on Windows are missing or fail to build.

---

### ADR-010: Silent degradation is forbidden

**Context:** `mcp-vector-search` #182 — AST chunking disabled without an error. The index looks working and is junk at the same time.

**Decision:** any disabling of functionality must be visible — in the `index_status` counters, in stderr immediately, and it must block `anyindex_search` when `degraded: true`. Tests must check that the AST fired, not merely that the server answered.

**Rationale:** an invisible failure is worse than a crash. A crash the user fixes; a silent failure they blame on the tool and delete.

**Generalization:** R7 + R9 — retrieval quality is optimized first, before the instruction text. "The model searches badly" and "the AST switched itself off" look identical from the outside.

---

---

### ADR-011: Windows — a first-class target platform

**Context:** the user works on Windows; the `mcp-vector-search` failure happened on Windows + Python 3.12.

**Decision:** installing dependencies on clean Windows **without MSVC** is a stage 0 acceptance criterion. CI includes Windows. Paths only through `node:path`; path normalization for `chokidar` is mandatory. In `bin` — a `.cmd` wrapper.

**Rationale:** a platform on which the project does not run is not "supported". It must be tested at stage 0, not at stage 6.

---

---

### ADR-012: Embeddings in a worker thread

**Context:** an MCP server over stdio talks to the client through a single channel. `pipeline()` from transformers.js is synchronous CPU-bound code.

**Decision:** inference moves into `embedder.worker.ts`. The bridge is `postMessage` + `Map<id, {resolve, reject}>`. `warmModel()` at startup, if the index is not empty. Model eviction after 5 idle minutes.

**Rationale:** without isolation, batch embedding of 32 chunks blocks the event loop — the client may decide the server has hung. For the stdio transport this is a timeout risk, and for HTTP an availability one.

**Price:** the worker requires a separately compiled JS file (Node does not load `.ts` in a worker), the path goes through `import.meta.url` → `fileURLToPath` rather than `import.meta.dir`. `Float32Array` is copied on transfer — acceptable, cheaper than base64.

**Do not copy:** `Bun.gc(true)`. Nulling out references and not forcing GC is enough.

---

### ADR-013: Cross-encoder rerank — a separate stage, enabled based on results

**Context:** RRF gathers candidates from two rankings but does not distinguish "the topic is close" from "this is exactly it". A cross-encoder applied to the top-15 after the hybrid step does distinguish them.

**Decision:** stage 7 (optional). `RRF → top-30 → cross-encoder → top-K`. Enabled **only** if stage 6 gives < 15/20 on the control set. If rerank did not improve the result — the stage is removed.

**Rationale:** a way to raise quality without changing the embedding model. RRF can put the right chunk in 7th place; rerank will move it into the results.

**Do not copy:** hand-tuned scoring coefficients of the kind `rerank*50 + hybrid*0.5` — rerank is a separate stage with its own weight, not a multiplier in someone else's formula. Hand-tuned coefficients are portable from nowhere (ADR-003).

⚠️ Not measured on this project: the resident memory a cross-encoder rerank model costs. That figure has to be taken on the target machine before the stage is enabled. Eviction on idle does not help — rerank is needed synchronously at query time, so when RAM is short the stage is switched off entirely.

⚠️ Not verified: the quality of `bge-reranker-base` specifically on code. The model is trained on general-purpose text pairs. Checked at stage 7 with the same set of 20 questions.

---

### ADR-014: Runtime — Node, not Bun

**Context:** the stack was verified empirically under Bun 1.4.2 (`07-bun-vs-node.md` §2). Working: `transformers.js@4.3.0` + jina q8 (768d), native `code-chunk` (AST extracts entities), `bun:sqlite` + `sqlite-vec` (loadExtension + vec0), `better-sqlite3` + `sqlite-vec` under Bun, MCP SDK 1.31.0 (`registerTool` + `outputSchema` + `structuredContent`). Not working: `code-chunk/wasm` — neither under Bun nor under Node.

**Decision:** Node.

**Rationale:**
1. **It was not verified where we deploy.** The tests ran on Linux; the target is Windows. Bun's advantages do not transfer automatically.
2. **The entry barrier.** `"command": "node"` works with any MCP client without setup. `"command": "bun"` requires the user to install the runtime separately — that narrows the portability for which ADR-001 was accepted.
3. **Bun's win is limited to one component** — `bun:sqlite` instead of `better-sqlite3`. It does not free us from R3 (`@huggingface/transformers` + onnxruntime): a native binary is still needed.
4. **The WASM path is broken under Bun**, so Bun does not save us from native modules — the R1 question is not closed in either direction.

**Price:** R2 (`better-sqlite3` V8 ABI) remains in force.

**Revisit if:** testing on Windows shows the absence of `better-sqlite3` or `onnxruntime-node` prebuilds for the target Node version. Then Bun stops being a preference and becomes a workaround — but not before that.

---

### R11. Packaging defect in `code-chunk` — broken `exports` for TypeScript — medium

**Fact (verified, `06-environment.md` §3.2):** in `code-chunk@0.1.14` the `"types": "./src/index.ts"` condition sits at the top level of `exports` and overrides the correctly nested `import.types: "./dist/index.d.ts"`. Under `moduleResolution: NodeNext` TypeScript receives the package's raw TS source and emits 20+ `TS2835` errors.

**Workaround:** a `paths` mapping in `tsconfig.json` pointing at `dist/index.d.ts`. It works, runtime and types are consistent.

**Residual risk:** the mapping points at an internal package path. Changing the `code-chunk` version without checking `dist/index.d.ts` means the build breaks. This is a noticeable, but not silent, failure — `tsc` will not pass.

**Why it is not critical:** the failure is loud, not silent. Unlike R9/ADR-010, where the failure looks like success.

**Action:** check `dist/index.d.ts` whenever the dependency is updated. When a fix appears in `0.1.15+` — remove the mapping.

---

### R12. SQLite integer types differ from JS types — low, but a trap

**Fact (verified):** `better-sqlite3` binds JS numbers as `REAL`. `vec0` requires a strict `INTEGER` for the primary key and fails with `SqliteError: Only integers are allows for primary key values`.

**Decision:** `BigInt(id)` on insert into `chunks_vec`. Verified with an end-to-end test.

**Why it is in the register even though the cause is clear:** the error does not surface when the query is written, but on the first data insert — that is, at stage 4, 4 days into development. Cheaper to record now.

---

### ADR-015: Distribution via npm, not as a binary

**Context:** it was proposed to bundle everything into a single executable so that it would "work on all OSes". Checked by running it, `08-binary-distribution.md`.

**Decision:** publish as an ordinary npm package. Ensure portability through correct handling of native modules, a CI matrix and path normalization.

**Rationale:**
1. **`sharp` is a hard dependency of `@huggingface/transformers`** (v3.7.6 and v4.3.0), a static import at the top of the bundle, a platform-specific native module. `bun build --compile` produces a binary that crashes on startup.
2. **Workarounds break the point:** `--external sharp` requires `node_modules` at runtime; `--define` does not substitute static imports.
3. **Node SEA is incompatible with ESM** — the entry point is always CommonJS, while the project is `type: module`.
4. **A binary does not solve the target problem.** Native prebuilds per OS are solved by `optionalDependencies` — the standard npm mechanism. One binary per OS means 5–6 artifacts, each with its own CI runner, and `sharp` still does not fit.

**Confirmed working:** `bun build --compile` with a storage layer gives one file of 81 MB, `better-sqlite3` + `sqlite-vec` work (`vec_version=v0.1.9`). The only blocker is in the embedding layer.

**Price:** the user needs Node. Acceptable: an MCP client runs `command` itself, and for Node servers that is `command: node`.

**Condition for fulfilling the ADR:** the claim "works on all OSes" cannot be confirmed without CI on `windows-latest`, `ubuntu-latest`, `macos-latest`. A Linux run does not prove it. The three blocking items for Windows are listed in `06-environment.md` §5.

**Revisit if:** a maintained fork of `@huggingface/transformers` without the image dependency turns up — then the binary question returns.

---

### ADR-016: cross-platform testing deferred to stage 6

**Context:** the project started on 2026-09-29. The stack has been verified only on Linux x64, Node v24.21.0 (`06-environment.md`). The three blocking items for Windows are not closed.

**Decision:** development proceeds locally on Linux. GitHub Actions and testing on Windows/macOS are deferred to a later stage.

**Rationale:** the cross-platform testing infrastructure is created up front (`.github/workflows/ci.yml`) but is not run until there is functionality worth such a run. An early Windows run would only surface installation problems, not product problems.

**What this does NOT mean:** portability is not considered proven. The claim "works on all OSes" remains unconfirmed until a green CI run.

**Open items accumulated by the time the topic returns:**

| # | What to check | Why |
|---|---|---|
| 1 | Prebuilds of `tree-sitter-*` on Windows without MSVC | R1, blocks chunking |
| 2 | `better-sqlite3` prebuild on Windows | R2, blocks storage |
| 3 | Whether `npm install-scripts approve` is needed | `06-environment.md` §3.1 |
| 4 | Path divergence between `fast-glob` / `chokidar` | ADR-011, §3.2 of the architecture |
| 5 | Embedding speed on live code, not on synthetic data | `06-environment.md` §2 |

**When to come back:** when `anyindex_search` works and the quality of the results has been calibrated (stage 6). Then a run on three OSes tests the product, not the installation.

---

### ADR-016, correction 2026-09-30: the decision is reversed, Windows is verified

The previous decision of the owner is cancelled. Windows is confirmed as a working
platform; macOS is not verified, CI on three OSes has not been run.

Measurements on win32-x64, Node v22.23.2, 4 cores / 16 GB, npm 12.1.0.

| # | What we checked | Result |
|---|---|---|
| 1 | Prebuilds of `tree-sitter-*` without MSVC | Closed. All six grammars ship `prebuilds/win32-x64`, the build was never triggered, `code-chunk` runs natively |
| 2 | `better-sqlite3` prebuild | Closed. `prebuilds/win32-x64.node`, `vec_version=v0.1.9`, KNN and the metadata filter work |
| 3 | Whether `npm install-scripts approve` is needed | **Not needed.** npm blocked 10 install scripts, and everything worked without them: the prebuilds are already unpacked in the packages |
| 4 | Path divergence between `fast-glob` / `chokidar` | Confirmed and turned out to be the only blocker of the watcher. chokidar hands back `C:/dir/file`, `root` arrives as `C:\dir\file`; the string comparison considered the root an external path, the traversal never started, and not a single event arrived. Fixed in `src/watcher.ts` |
| 5 | Embedding speed on live code | 521 ms/chunk on synthetic `probe` against ~2.9 s/chunk on real chunks: batches of 16 long texts give a quadratic attention contribution. The README estimate for 1 core is optimistic |

Two defects were found and fixed along the way, present in neither the tests nor the
inventory:

- **An unfinished index reported itself as ready.** `ready` only required
  `vectors > 0`, so an index with vectors for half the chunks passed as
  `ready: true, degraded: false`. Now `vectors === chunks` is required.
- **Edits arriving in the middle of indexing were lost.** A batch of events
  was dropped on the assumption of a "next pass", which could not happen without
  new edits. Now the pass is queued and runs right after.

The install scripts that the README describes as mandatory were not needed in
practice — the prebuilds are enough. The instruction should be removed.

**What this does NOT mean:** macOS is still unverified. The claim "works
on all OSes" remains false — only win32-x64 is confirmed.
### ADR-017: `find_references` — lexical search for mentions, not a call graph

**Date:** 2026-10-01.

**The problem.** We have six tools, and none of them answers "where is this used". `denfry/codebase-index` has `find_refs`, `Helweg/open-codebase-index` has `call_graph` and `pr_impact`, `srclight` has impact analysis. An agent editing a shared function is forced to search by hand.

**What held it back.** ADR-004 handed the call graph to the external `tree-sitter-analyzer`, and repeating the same work here was not wanted: name resolution is the most expensive and the most frequent source of quiet errors. It is verified that `code-chunk` hands back entities, scope and imports, but does **not** hand back call edges, so there is no ready data for an honest call graph.

**Decision.** `find_references` was added — lexical search of the identifier via FTS5 with exact token matching. There is no name resolution: a same-named identifier in another class, in a comment and in a string all count as a match. Therefore the tool is named `find_references` and not `call_graph`, its description says "lexical", the response field is `lexicalOnly: true`, and every textual response repeats it.

**Why this does not violate ADR-004.** ADR-004 said not to build our own call graph. A call graph has not been built and there is no pretending that one exists. `tree-sitter-analyzer` remains the only source of resolved calls, and both tools can work side by side: ours answers "where does the name occur at all", `tsa` answers "who exactly calls this function".

**Boundaries fixed immediately.** `code-chunk` does not count `const` arrows and local variables as entities, so the declaration for them is not found — the mentions are found, the declaration is not. A word match inside a string or comment cannot be told apart from a call match, and the tool does not pretend otherwise. There is no real-graph verification here, and pretending there is one would be wrong.

**Verified.** 8 tests, including the case on which the tool would look broken: FTS5 syntax inside a symbol name (`a->b OR "x"`) must return an empty result rather than take the server down.

---
