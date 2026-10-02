# 01. Research results

Date: **2026-09-29**. Method: primary sources — npm registry API (`registry.npmjs.org/.../latest`), GitHub API/pages, Hugging Face API (`huggingface.co/api/models/...`), official docs.

Confidence levels:
- ✅ **CONFIRMED** — verified against the primary source, version pinned.
- ⚠️ **UNCONFIRMED** — the source is secondary, or it turned up only in passing mentions; needs local verification.
- ❌ **REFUTED** — the original claim is wrong.
- 🔍 **NOT FOUND** — the search returned nothing; neither existence nor absence is asserted.

---

## 1. MCP SDK

✅ `@modelcontextprotocol/sdk@1.31.0` · MIT · `engines.node >= 18`
Source: `registry.npmjs.org/@modelcontextprotocol/sdk/1.31.0`

- `zod` — range `^3.25 || ^4.0` (both as a dependency and as a peer). **Both versions are supported.**
- Peer dependency: `@cfworker/json-schema@^4.1.1`.
- Transports: `StdioServerTransport`, HTTP (Streamable HTTP). SSE is deprecated.

Confirmed API (SDK docs v1.29.0, `docs/server.md`, `packages/server/src/server/mcp.ts`):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: '...', version: '...' })

server.registerTool(
  'anyindex_search',
  {
    description: '...',
    inputSchema: { query: z.string(), topK: z.number().default(8) },
    outputSchema: { hits: z.array(z.object({ file: z.string() })) },
  },
  async ({ query, topK }) => {
    const hits = await doSearch(query, topK)
    return {
      content: [{ type: 'text', text: render(hits) }],
      structuredContent: { hits },   // required when outputSchema is declared
    }
  },
)

await server.connect(new StdioServerTransport())
```

⚠️ **Hard requirement:** if a tool declares an `outputSchema`, the SDK validates `structuredContent` and throws `ProtocolError` when it is missing. Returning only `content` without `structuredContent` while an `outputSchema` is declared is a protocol error.

⚠️ `McpServer.tool(name, schema, cb)` is the deprecated form. The current one is `registerTool` (supports `outputSchema` and progress notifications). **The variadic `.tool()` / `.prompt()` / `.resource()` were removed in v2** (`docs/migration/upgrade-to-v2.md`) — our style with an explicit config object is already v2-compatible.

Progress for long-running operations (`extra.sendNotification`) is available in v1; check `extra._meta?.progressToken` before sending. **Not verified whether a given client supports it.**

✅ **Tool annotations** (`packages/core/src/schemas.ts`, `ToolAnnotationsSchema`) — confirmed:

```ts
{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }
```

They are set in the `registerTool`/`tool` config. The ones that matter to us:

| Tool | Annotations |
|---|---|
| `anyindex_search` | `readOnlyHint: true, destructiveHint: false, idempotentHint: true` |
| `index_status` | `readOnlyHint: true, destructiveHint: false, idempotentHint: true` |
| `index_rebuild` | `readOnlyHint: false, destructiveHint: true` |
| `index_update` | `readOnlyHint: false, destructiveHint: false` |

`readOnlyHint: true` on search tools is not decoration: it tells the runtime the call is safe, and that feeds into the model's decision to call it.

✅ **`isError: true` is the documented way to report a recoverable error** (`docs/servers/errors.md`): the handler returns `{ content, isError: true }`, "so that the model can see it and recover". This confirms the schema in `02-architecture.md` §11.

✅ **Access to the low-level `Server`**: every `McpServer` owns an `mcp.server` through which handlers are registered without the high-level API (`mcp.server.setRequestHandler`). Needed only if a method shows up with no ready-made API — we do not use it in advance.

⚠️ **Versions:** `registry.npmjs.org/latest` = `1.31.0`. The docs contain `docs/migration/upgrade-to-v2.md` and a mention of a protocol revision dated 2026-07-28 with a `subscriptions/listen` stream for resource subscriptions. **v2 is not `latest`** — we stay on 1.x but do not use deprecated forms, so that a migration stays cheap.

---

## 2. `@huggingface/transformers`

✅ `@huggingface/transformers@4.3.0` · Apache-2.0
Source: `registry.npmjs.org/@huggingface/transformers/latest`

Runtime dependencies (exact string from the registry):

```
onnxruntime-node        1.30.0
onnxruntime-web         1.31.0-dev.20260914-8d85527a0
@huggingface/tokenizers ^0.2.0     ← native module (Rust)
@huggingface/jinja      ^0.5.10
sharp                   ^0.35.4
```

⚠️ **No GGUF support whatsoever.** `pipeline()` takes `subfolder: 'onnx'` by default. GGUF/llama.cpp is a separate path, not this one. The claim from the original brief about `dtype:'q8'` plus a GGUF repository is wrong (§4).

Confirmed signature (`src/pipelines.js`):

```js
pipeline(task, model = null, {
  progress_callback, config, cache_dir, local_files_only,
  revision = 'main', device, dtype, subfolder = 'onnx',
  use_external_data_format, model_file_name, session_options,
})
```

Supported `dtype`: `fp32`, `fp16`, `q8`, `int8`, `uint8`, `q4`, `bnb4`, `q4f16`.
Before v3 the option was called `quantized: true|false`; in v4 it is `dtype`.

Call options for `feature-extraction` (`src/pipelines/feature-extraction.js`):

```js
{ pooling = 'none', normalize = false, quantize = false, precision = 'binary' }
```

`pooling`: `'none' | 'mean' | 'first_token' | 'cls' | 'last_token' | 'eos'`. `cls` and `first_token` are synonyms, `eos` and `last_token` are synonyms.
Tokenization always runs with `padding: true, truncation: true`. Inference is deterministic.

Worth knowing: `quantize_embeddings` + `precision` (`'binary'|'int8'|'uint8'|'fp32'`) is **compression of already computed vectors before they go into the database**. It saves space with no loss of search accuracy.

Offline mode (`src/env.js`, `docs/source/tutorials/node.md`):

```js
env.allowRemoteModels = false   // true by default
env.cacheDir        = '...'     // on-disk cache
env.allowLocalModels            // true by default in Node
env.localModelPath  = '...'     // defaults to '/models/' — that one is for the BROWSER
```
Plus `local_files_only: true` in `pipeline()`.

⚠️ **The default `cacheDir` is `./node_modules/@huggingface/transformers/.cache/`.** A 161M-parameter model (~160 MB) ends up inside `node_modules`. A reinstall or an `npm ci` destroys the cache and forces a fresh download. **`env.cacheDir` must be set explicitly**, outside `node_modules` (for example `<dataDir>/models`).

❌ **`q4f16` crashes on Node.** `huggingface/transformers.js#1567`: `dtype:'q4f16'` → ONNX Runtime graph fusion error on Node, works in the browser. Do not use it.

✅ **Check dtype availability before choosing** (`docs/source/guides/dtypes.md`):

```js
import { ModelRegistry } from '@huggingface/transformers'
const dtypes = await ModelRegistry.get_available_dtypes('jinaai/jina-embeddings-v2-base-code')
// for jina: [ 'fp32', 'fp16', 'q8' ]
```

⚠️ Verified in practice (`07-bun-vs-node.md` §2): `jinaai/jina-embeddings-v2-base-code` exposes only `fp32`, `fp16`, `q8`. No `int8`, no `uint8`, no `q4` — despite the 10 "quantizations" on the model card. Plan for `q8`.

---

## 3. Embedding models

### 3.1 `jinaai/jina-embeddings-v2-base-code` — the primary recommendation

✅ Confirmed via `huggingface.co/api/models/jinaai/jina-embeddings-v2-base-code`:

| Field | Value |
|---|---|
| `license` | **`apache-2.0`** |
| `gated` | `false` (available without a token) |
| `downloads` | 139 493 |
| `likes` | 145 |
| `lastModified` | `2025-01-06` |
| Files in `onnx/` | `model.onnx` (fp32), `model_fp16.onnx`, `model_quantized.onnx` (int8) |
| Files at the root | `tokenizer.json`, `config.json`, `special_tokens_map.json`, `vocab.json`, `1_Pooling/config.json` |

Model: 161M parameters, **768 dimensions**, JinaBert + symmetric ALiBi, 30 programming languages plus English.
**Sequences: trained on 512, extrapolates to 8192** thanks to ALiBi. The official code sample on the model card uses `pooling: 'mean'`; `normalize` is not specified, but `encode` in Python does L2 normalization.

⚠️ The model card gives a JS sample on the deprecated `@xenova/transformers` with a `quantized` option. That is **not** the current API. Correct for v4:

```js
const embedder = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code', { dtype: 'q8' })
const out = await embedder(texts, { pooling: 'mean', normalize: true })
```

⚠️ **`lastModified` = January 2025.** The model is not maintained. That is a plus (stability) and a minus (not newer than the competition). Record it in an ADR.

### 3.2 Fallback options

| Model | Dim | Size (q8) | When to take it |
|---|---|---|---|
| ✅ `Xenova/all-MiniLM-L6-v2` | 384 | ~23 MB | Maximum speed, weak CPU |
| ✅ `Xenova/bge-small-en-v1.5` | 384 | ~34 MB | Better than MiniLM at retrieval; requires `pooling:'cls'` and the query prefix `Represent this sentence for searching relevant passages:` |
| ✅ `Xenova/multilingual-e5-small` | 384 | ~34 MB | Non-English is needed |
| ⚠️ `nomic-ai/nomic-embed-text-v1.5` | 768 | — | Requires the prefixes `search_document:` / `search_query:` |

❌ **Critical limitation for MiniLM:** `all-MiniLM-L6-v2` handles at most **256 tokens**. At `maxChunkSize: 1500` bytes (the `code-chunk` default) the text is silently truncated — the embedding becomes meaningless. Either cut chunks down to ~700 bytes or take jina (8192). **This is not cosmetic; it breaks search quality.**

### 3.3 Dynamic quantization

If you need the savings: `quantize: true, precision: 'int8'` on the `feature-extraction` output compresses the vector after pooling. No model reload needed.

---

## 4. Refuted from the original brief

| Claim from the brief | Status | What is actually true |
|---|---|---|
| Model `gaianet/jina-embeddings-v2-base-code-GGUF` + `{dtype:'q8'}` | ❌ | transformers.js does not load GGUF. The official repository already ships `onnx/model_quantized.onnx` |
| "jina GGUF Q3_K_M ~160 MB" | ❌ | Wrong size and format; ONNX fp32/q8 |
| `nomic-embed-code` "~130 MB GGUF" | 🔍 | Not found |
| `osnova` — a call graph engine | 🔍 | Not found in npm or by web search |
| `devricky` — a language-agnostic engine | 🔍 | Not found |
| `pi-local-rag` | 🔍 | Not found |
| Proprietary host plugin API | 🔍 | Not adopted — the server needs no host SDK (ADR-001) |
| Host-specific plugin manifest | ⚠️ | Exists in the host ecosystem; not used — the server ships as a plain MCP process (ADR-001) |
| `import * as lancedb from 'vectordb'` | 🔍 | Unverified |
| `table.delete(\`file = '${path}'\`)` (LanceDB) | 🔍 | Unverified |
| code-chunk: the `filePath` parameter | ❌ | The real name is `filepath` |
| code-chunk: `maxChunkSize` as a "chunk" | ⚠️ | The unit is **bytes**, default `1500` |
| Proprietary harness — need to find out whether it exists (my initial doubt) | ❌ | It exists; evaluated as a plugin host in §8, rejected (ADR-001) |

---

## 5. `code-chunk`

✅ `code-chunk@0.1.14` · MIT · supermemoryai · 212 stars · last commit 17.04.2026
Source: `registry.npmjs.org/code-chunk/latest`, `github.com/supermemoryai/code-chunk`

⚠️ **Version 0.x.** The API can change without a major bump.

⚠️ **Native dependencies are the main risk:**

```
tree-sitter-go          ^0.25.0
tree-sitter-java        ^0.23.5
tree-sitter-rust        ^0.24.0
tree-sitter-python      ^0.25.0
tree-sitter-javascript  ^0.25.0
tree-sitter-typescript  ^0.23.2
web-tree-sitter         ^0.26.3   (WASM)
effect                  ^3.19.12
```

The six `tree-sitter-*` are node-gyp native modules → tied to the V8 ABI, rebuilt whenever Node's major version changes. `peerDependencies: { typescript: '>=4.5.0' }`. There is **no `engines` field at all**.

✅ **Escape-hatch path:** `exports` has a `./wasm` sub-export at `dist/wasm.js`, built on `web-tree-sitter` (WASM, no native compilation). Same result, zero native modules, paid for in speed. See `04-risks.md` R1.

✅ Bun-first: in `exports` the `"bun"` condition points at the raw `./src/index.ts`. Under Node `dist/index.js` is used. Under Bun — the TS sources. We write for Node.

❌ **The `exports` map is broken for TypeScript.** In `package.json@0.1.14`:

```json
"exports": { ".": {
  "types":  "./src/index.ts",     ← resolved first
  "bun":    "./src/index.ts",
  "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
}}
```

`moduleResolution: NodeNext` matches the top-level `types` (the `types` condition is in the default list) and picks up the package's **raw TS source**. `skipLibCheck` does not save you — it only applies to `.d.ts`. This leads to 20+ `TS2835` errors.

**Workaround (verified, `06-environment.md` §3.2):** a mapping in `tsconfig.json`:

```json
"baseUrl": ".",
"paths": {
  "code-chunk": ["./node_modules/code-chunk/dist/index.d.ts"],
  "code-chunk/wasm": ["./node_modules/code-chunk/dist/wasm.d.ts"]
}
```

⚠️ The mapping points at an internal package path — check that `dist/index.d.ts` exists on every version bump.

Confirmed API:

```ts
chunk(filepath, code, options?)                // Promise<Chunk[]>
chunkStream(filepath, code, options?)          // AsyncGenerator<Chunk>
createChunker(options?)                        // reusable instance
chunkBatch(files, options?)                    // Promise<BatchResult[]>
chunkBatchStream(files, options?)              // AsyncGenerator<BatchResult>
chunkStreamEffect / chunkBatchEffect / chunkBatchStreamEffect
formatChunkWithContext(text, context, overlapText?)
detectLanguage(filepath)                        // Language | null
```

`ChunkOptions` (confirmed):

| Option | Type | Default |
|---|---|---|
| `maxChunkSize` | number | `1500` (**bytes**) |
| `contextMode` | `'none'\|'minimal'\|'full'` | `'full'` |
| `siblingDetail` | `'none'\|'names'\|'signatures'` | `'signatures'` |
| `filterImports` | boolean | `false` |
| `language` | `Language` | auto from path |
| `overlapLines` | number | `10` |
| `concurrency` | number | `10` |
| `onProgress` | fn | — |

`BatchOptions` = `ChunkOptions` + `concurrency` + `onProgress`. `onProgress(completed, total, filepath, success)`.

`Chunk` fields: `text`, `contextualizedText`, `lineRange`, `context.scope[]`, `context.entities[]`, `context.siblings`, `context.imports`.
`BatchResult`: `{ filepath, chunks, error }`.
Errors: `ChunkingError`, `UnsupportedLanguageError` (both carry `_tag` for Effect).

Languages (confirmed): TypeScript `.ts .tsx .mts .cts` · JavaScript `.js .jsx .mjs .cjs` · Python `.py .pyi` · Rust `.rs` · Go `.go` · Java `.java`. **Exactly 6.**

⚠️ No C#, C/C++, PHP, Ruby, Swift, Kotlin, SQL, shell. If you need them — either your own traversal through `web-tree-sitter`, or a separate layer.

⚠️ In streaming mode `chunk.totalChunks === -1` (not known in advance).

---

## 6. Vector storage

### sqlite-vec

✅ `asg017/sqlite-vec` — a SQLite extension in pure C. The author ⚠️ writes in the README: *"`sqlite-vec` is a pre-v1, so expect breaking changes!"*

**Canonical loading in Node** (`site/using/js.md`) — confirmed from the primary source:

```ts
import * as sqliteVec from 'sqlite-vec'
import Database from 'better-sqlite3'

const db = new Database(':memory:')
sqliteVec.load(db)
const { vec_version } = db.prepare('select vec_version() as vec_version').get()
```

⚠️ The `vec_version()` check must be done **mandatory at startup**, not by trusting the absence of an exception. This is the direct answer to R9/ADR-010: a failure to load the extension has to be visible in `index_status`.

**`vec0`: three ways to store non-vector columns** (`site/features/vec0.md`) — confirmed:

```sql
create virtual table vec_chunks using vec0(
  chunk_id          integer primary key,
  contents_embedding float[768],
  language          text,      -- metadata: available in WHERE KNN
  file_id           integer partition key,
  +contents         text       -- auxiliary: not indexed, but readable without a JOIN
);
```

| Type | In `WHERE` KNN | Indexed | Limit | When |
|---|---|---|---|---|
| **Metadata** | ✅ yes | yes | — | high-selectivity filters; carefully — "may be slower on a full scan" |
| **Partition key** | ✅ yes, shards the index | shards | **4 columns** | when hundreds of vectors land on one value; resharding slows things down |
| **Auxiliary (`+`)** | ❌ **no** | no | **16 columns** | large texts you need in `SELECT` but not in a filter |

**KNN with metadata right in the query:**

```sql
select chunk_id, distance from vec_chunks
where contents_embedding match '[...]'
  and k = 8
  and language = 'typescript';
```

`vec0` recognizes such constraints and applies them **while it computes distances** — the result is guaranteed to match the filter.

⚠️ **Without `vec0` a manual brute force is possible:** `vec_distance_L2()`, `vec_distance_L1()`, `vec_distance_cosine()` + `ORDER BY`. We do not use it — `vec0` is more efficient and simpler.

⚠️ **Search is brute-force exact KNN**, there is no ANN index. Estimate: 768 float32 = 3 KB per chunk; 20 000 chunks ≈ 60 MB for a full scan. The threshold for moving to sharding/ANN gets pinned by measurement at stage 4.

❌ **`vec0` rejects an id that is not passed as INTEGER.** `better-sqlite3` binds JS numbers as `REAL` (`SELECT typeof(?)` → `real`), while `vec0` demands a strict INTEGER:

```
SqliteError: Only integers are allows for primary key values on t
```

**Solution:** `insert.run(BigInt(chunkId), ...)`. Verified by an end-to-end test (`06-environment.md` §3.3): insert, KNN with a metadata filter, and reading an auxiliary column all work.

⚠️ The installed version is **v0.1.9** (`package.json` declares the range `^0.1.7-alpha.2`). The author's "pre-v1, expect breaking changes" verdict stands.

### better-sqlite3 ↔ libSQL

⚠️ **Critical in operation.** `better-sqlite3` is compiled against the V8 ABI (`NODE_MODULE_VERSION`), so the prebuilt binary is pinned to a Node major version. The N-API request (`WiseLibs/better-sqlite3#271`) has been **open since 2019 and remains unanswered** — no fix is foreseeable.

`libsql` (napi-rs) ships ABI-stable prebuilt binaries across all major versions. Documented in `arabold/docs-mcp-server#435` as a solution to the same problem.

sqlite-vec adds a limitation from that same issue: `loadExtension` does not work over the network, so `vec0` cannot be applied to a remote `sqld`/Turso. For a local file — irrelevant.

### Choice

**`better-sqlite3` + `sqlite-vec` + FTS5**, one `.db` file. FTS5 is built into SQLite, gives BM25 for free, and is needed for the RRF hybrid. The ABI risk is recorded in R2.

⚠️ `LanceDB`/`vectordb` is **unverified**. Keep it out of the plan until it is verified separately.

---

## 7. Call graph: we do NOT build one from scratch

✅ **`tree-sitter-analyzer@2.2.0`** · MIT · Python ≥3.10 · released 18.09.2026 · `aimasteracc`
Source: `pypi.org/project/tree-sitter-analyzer/`

**This is already a finished MCP server for code intelligence.** 8 tools, local, no telemetry:

| Tool | Actions |
|---|---|
| `nav` | `navigate` (definition, references, call hierarchy), `impact` (transitive dependencies + a risk verdict), `callers`, `callees`, `lineage` |
| `search` | `symbol` (relevance, **FTS5 + BM25**), `chain` (semantic, BM25 prefilter + cosine rerank) |
| `structure` | `explore`, `class_tree` |
| `index` | `status`, `auto`, `full`, `sync` |
| `health` | `project` (A–F grade), `file`, `matrix` (module coupling), `dead`, `heatmap` |
| `edit` | `safe`, `guard`, `constraints`, `impact`, `pr` |
| `viz` | `similarity` (AST clone detection), `graph`, `uml` |
| `project` | `smart`, `journal` |

Storage: **SQLite + FTS5** in `<project>/.ast-cache/index.db`. The file is safe to delete — it gets rebuilt.

Languages: 22 plugins. `pipeline_registered` (13): C, C++, C#, Go, Java, JavaScript, Kotlin, PHP, Python, Ruby, Rust, Swift, TypeScript. `index_admitted` (3): Bash, Lua, Scala. `data_markup` (5): CSS, HTML, Markdown, SQL, YAML. `scaffold` (1): JSON.

Running it as an MCP server:

```bash
claude mcp add tree-sitter-analyzer \
  --env TREE_SITTER_PROJECT_ROOT="$PWD" \
  -- uvx --from "tree-sitter-analyzer[mcp]" tree-sitter-analyzer-mcp
```

⚠️ `TREE_SITTER_PROJECT_ROOT` must be **absolute**.

⚠️ No benchmarks are claimed — the author runs "Quantitative claim governance" and publishes numbers only with E4 provenance. Performance is unconfirmed.

⚠️ Admitted by the author himself: `pipeline_registered` is not proof of cross-file connectivity; `database is locked` under concurrent access to `.ast-cache/index.db`; semantic queries need a known embedding model with a matching dimensionality; on Windows the snapshot-quantization path is unvetted.

**Conclusion:** do not build the call graph ourselves. The strategy is in `02-architecture.md` §7.

### Other references

✅ `zilliztech/claude-context` (GitHub, open source) — an MCP server for semantic code search: `index_codebase` + `search_code`, tree-sitter over 14 languages, **incremental updates via a Merkle tree**, a BM25+dense hybrid, vectors in Milvus. It needs an external Milvus — which does not fit our "no external services" task, but **the Merkle approach to incrementality is worth adopting**. Worth reading before stage 5.

---

## 8. Proprietary harness (evaluated as a plugin host, rejected)

A proprietary harness was evaluated as a plugin host and rejected in favour of a
standalone MCP server (ADR-001): a host plugin runs in one ecosystem only, while
MCP over stdio works with any client. Host-specific wiring notes were removed —
the server targets every MCP client, not one host.

Two findings from the evaluation survived as generic constraints:

1. Some hosts scrub subprocess env by `/KEY|PASSWORD|SECRET|TOKEN/i`. Our server
   needs no secrets (ADR-008), so there is nothing to scrub.
2. Some hosts normalize tool names, mangling anything outside a narrow charset.
   Server and tool names stay within `[a-z0-9_]`, shorter than 40 characters, so
   host-side normalization cannot break them.

---

## 9. Dependency summary

| Package | Version | License | Status | Risk |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `1.31.0` | MIT | ✅ | low |
| `zod` | `^3.25 \|\| ^4.0` | MIT | ✅ | low |
| `@huggingface/transformers` | `4.3.0` | Apache-2.0 | ✅ | native `@huggingface/tokenizers` |
| `jinaai/jina-embeddings-v2-base-code` | revision `main` from 2025-01-06 | **Apache-2.0** | ✅, not gated | 161M parameters |
| `code-chunk` | `0.1.14` | MIT | ✅ | 6 native tree-sitter, version 0.x |
| `better-sqlite3` | — | MIT | ⚠️ | V8 ABI lock |
| `sqlite-vec` | — | MIT/Apache | ✅, **pre-v1** | breaking changes |
| `fast-glob` | — | MIT | ⚠️ | unverified |
| `ignore` | — | MIT | ⚠️ | unverified |
| `chokidar` | `^4` | MIT | ⚠️ | unverified |
| `tree-sitter-analyzer` | `2.2.0` | MIT | ✅ | Python, not Node |

⚠️ The last three were not checked — they are so standard that the risk is minimal, but formally they are unverified. Check them at stage 0.

---

## 10. Gaps in this research

What I did **not** verify, and what has to be checked locally at stage 0 (**on Windows, without MSVC** — ADR-011):

1. An actual run of `code-chunk` on Node, **both paths**: native (`code-chunk`) and WASM (`code-chunk/wasm`). The first requires MSVC on Windows — it may turn out to be unavailable outright.
2. An actual run of `jinaai/jina-embeddings-v2-base-code` through `@huggingface/transformers@4.3.0` — whether `dtype:'q8'` maps to `onnx/model_quantized.onnx`, and whether mean-pooling is correct. **R3, potentially blocking:** if `@huggingface/tokenizers` requires MSVC, the stack gets reconsidered before any code is written.
3. Embedding speed on a real codebase — this decides whether indexing finishes in reasonable time.
4. `fast-glob`, `ignore`, `chokidar` — versions and compatibility. Separately: how `chokidar` and `fast-glob` path forms diverge on Windows.
5. Support for `instructions` from `initialize` and for progress notifications in specific MCP clients.
6. How `@huggingface/tokenizers` behaves across a Node major version change.
7. `tree-sitter-analyzer` performance on a large repository (the author publishes no benchmarks).

**Stages 0–2 in `03-roadmap.md` exist precisely to verify items 1–3 before any code is built on them.**

⚠️ Separately: none of the analogues found was ever run; every claim about them comes from READMEs and reading the sources. See `05-landscape.md` §6.
