# 02. Architecture

## 1. System boundaries

**In scope:** repository scanning → AST chunking → offline embeddings → local storage → hybrid search → MCP tools.

**Out of scope (deliberately):** a call graph of our own, an LSP of our own, auto-injection into the system prompt, network calls, telemetry.

### Why MCP rather than a proprietary plugin

| | Proprietary plugin | MCP server |
|---|---|---|
| Portability | one host only | opencode, Claude Code, Cursor, any MCP client |
| API stability | host API is versioned with the host and can break | MCP is a stable specification |
| Dependencies | host SDK + framework | `zod` + SDK |
| Auto-injection into the prompt | possible | no (the `instructions` field from `initialize` — client support unverified) |
| Own `ctx.agentLoop`, `tools/pre-execute` hooks | possible | no |

We do not build an agent loop and we do not intercept prompts. Losing those two capabilities is immaterial for a task of "indexing + search".

---

## 2. Stack

| Layer | Package | Version |
|---|---|---|
| Protocol | `@modelcontextprotocol/sdk` | `1.31.0` |
| Schemas | `zod` | `^4` |
| Scanning | `fast-glob`, `ignore` | to verify |
| Chunking | `code-chunk` | `0.1.14` — **sub-export `/wasm`** (ADR-009) |
| Embeddings | `@huggingface/transformers` | `4.3.0` |
| Model | `jinaai/jina-embeddings-v2-base-code` | Apache-2.0, 768d |
| Storage | `better-sqlite3` + `sqlite-vec` + FTS5 | to verify on Windows |
| Filesystem watching | `chokidar` | `^4` |
| Graph (optional) | `tree-sitter-analyzer` (Python) | `2.2.0` |

Node `>=22.19`. **Windows is the first-class target platform** (ADR-011): installing dependencies without Visual Studio Build Tools is an acceptance criterion, not a recommendation.

---

## 3. Modules

```
src/
├── index.ts        entry point: server assembly, tool registration
├── config.ts       config loading and validation via zod
├── scanner.ts      filesystem traversal, ignore files, hashing, PATH NORMALIZATION
├── chunker.ts      wrapper over code-chunk + chunker registry
├── embedder.ts     worker client: request-response over postMessage
├── embedder.worker.ts  transformers.js pipeline, idle unload
├── db.ts           SQLite schema, migrations, vec0, FTS5
├── indexer.ts      orchestration: scan → chunk → embed → store
├── watcher.ts      chokidar, incremental updates, queue
├── search.ts       vector + BM25 + RRF (+ rerank, stage 7)
├── render.ts       text result format + token estimate
├── tools/          MCP tool registration
└── logger.ts       stderr logger (stdout is taken by JSON-RPC)
```

**Rule:** all logging goes to `stderr`. `stdout` belongs to the protocol. Violating this kills the server.

### 3.1 Embedding isolation in a worker

transformers.js inference is synchronous, CPU-bound code. While 32 embeddings are being computed, the event loop is blocked and an MCP client talking over a single stdio channel may decide the server has hung.

```
index.ts ──postMessage──▶ embedder.worker.ts
    │                          │  pipeline() cached
    ◀── Float32Array ──────────┘
```

Requirements:

- The worker is a **separate compiled JS file**. Node cannot load `.ts` into a worker the way Bun does via `import.meta.dir`.
- The worker path goes through `import.meta.url` → `fileURLToPath`, not through `__dirname` from CJS.
- The bridge is a `Map<id, {resolve, reject}>` keyed by `requestId`.
- All messages are serializable. A `Float32Array` over `postMessage` is copied, which is cheaper than encoding to base64.
- `warmModel()` at startup if the index already exists and is non-empty — otherwise the user's first query waits for the model to load.
- **Idle unload:** no queries for 5 minutes → `extractor = null`, `reranker = null`. A 161M-parameter model holds hundreds of megabytes and the server is long-lived. Forced GC is not needed — nulling the references is enough.

⚠️ Verify in stage 4: `postMessage` with `Float32Array` inside Node's worker_threads (Bun behaves differently).

### 3.2 Path normalization — the single point

`chokidar` returns `C:/repo/src/a.ts`, `root` arrives native as `C:\repo`, `fast-glob` returns `src/a.ts`. The `src/a.ts` form (POSIX, `/`) is the only one written to the database, compared in `watcher.ts` and shown in results.

Separators do not match even within a single platform, so they cannot be compared as strings: on Windows the root looks like a path outside itself. The only form of comparison is `path.relative`, which brings the separators to a single kind.

```ts
// scanner.ts — the only place this rule lives
export const toPosix = (p: string) => p.split(sep).join('/')
```

Used when writing `files.file_path`, when comparing in the watcher, and when building the path in `render.ts`. Path normalization is global and unconditional — we should not have a gap here.

---

## 4. Database schema

One file `<root>/.anyindex/index.db`.

```sql
-- Chunk metadata
CREATE TABLE chunks (
  id            INTEGER PRIMARY KEY,
  file_path     TEXT NOT NULL,          -- always POSIX, with /
  line_start    INTEGER NOT NULL,
  line_end      INTEGER NOT NULL,
  entity_name   TEXT,
  language      TEXT NOT NULL,
  scope_chain   TEXT,                   -- JSON: [{name, type}]
  imports       TEXT,                   -- JSON: string[]
  text          TEXT NOT NULL,          -- chunk source code
  context       TEXT NOT NULL,          -- contextualizedText (what gets embedded)
  content_hash  TEXT NOT NULL,          -- sha1(text) — for incrementality
  vec_rowid     INTEGER                  -- correspondence to a row in chunks_vec
);
CREATE INDEX idx_chunks_file ON chunks(file_path);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);
CREATE INDEX idx_chunks_entity ON chunks(entity_name);

-- Vectors. Column types per site/features/vec0.md
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id          INTEGER PRIMARY KEY,
  embedding         FLOAT[768],          -- column name is arbitrary
  language          TEXT,                 -- metadata: filter applied in KNN
  +context          TEXT                  -- auxiliary: read without a JOIN
);

-- Full-text search (BM25). Built into SQLite, no external dependencies
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  context,
  entity_name,
  file_path,
  content='chunks', content_rowid='id',
  tokenize = "unicode61 remove_diacritics 2"
);

-- Indexing state
CREATE TABLE files (
  path          TEXT PRIMARY KEY,
  mtime_ms      INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  chunk_count   INTEGER NOT NULL,
  indexed_at    INTEGER NOT NULL
);

-- Journal
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

### 4.1 Schema decisions

**`language` as a metadata column in `vec0`, not `file_path`.** Metadata columns are applied while distances are computed, so a "TypeScript only" filter needs neither over-fetch nor post-filtering. We do not put `file_path` there: a text column with low cardinality slows down the full scan. The path and the rest of the metadata come from `chunks` via JOIN.

**`context` is duplicated in `chunks_vec` as `+context` (auxiliary).** An auxiliary column is not indexed but is read straight from the KNN result — up to 30 rows of results come back without a JOIN. Limit: 16 auxiliary columns, we use one.

**We do not use partition keys.** Sharding is justified when hundreds of vectors share a key value and that key is filtered on often. We have no directory filter, so a key would only slow queries down (the documentation warns about over-sharding outright). **Leave it as a lever in case stage 4 shows a slow full scan.**

**`vec_rowid` in `chunks` + `chunk_id` in `vec0`** — an unambiguous row correspondence between tables, so results do not depend on how the extension numbers rows.

### 4.2 Mandatory checks when opening the database

```ts
sqliteVec.load(db)
const { vec_version } = db.prepare('select vec_version() as v').get()
```

Missing `vec_version` = the extension did not load → **`anyindex_search` does not work**, `index_status` reports `degraded: true`. We do not silently fall back to FTS (ADR-010).

### 4.3 Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

Confirmed as working by a direct measurement on this machine.

### 4.4 Model metadata

`meta` stores `model_id`, `model_revision`, `dim`, `dtype`, `quantize_precision`, `chunker_version`, `schema_version`, `vec_version`.

**If `model_id`, `dim` or `vec_version` do not match, the index is declared incompatible.** Without this check, changing the model silently produces garbage results — vectors of different dimensionality in one `vec0` either compare incorrectly or the query fails.

---

## 5. Indexing pipeline

```
scan(root)
  → fast-glob by extension
  → filter: .git/info/exclude + nested .gitignore/.cursorignore + .anyindexignore
           (scopes by depth, nested overrides outer, same as git)
  → default exclusions: node_modules, .git, binary extensions, lock files
  → for each file: sha1(content)
  → diff against the files table
      ├─ new / hash changed  → queue for indexing
      └─ file gone           → delete its chunks + vectors + FTS
chunk(file)
  → code-chunk.createChunker({ maxChunkSize, contextMode:'full',
                               siblingDetail:'signatures', concurrency })
embed(chunks)
  → transformers.js, in batches of 16–32
  → { pooling:'mean', normalize:true, quantize:true, precision:'int8' }
store(chunks)
  → INSERT into chunks, chunks_vec, chunks_fts — in one transaction per file
  → UPSERT into files
```

### Chunker registry

Idea taken from `cocoindex-code` (`ChunkerFn`): do not hard-bind `chunker.ts` to `code-chunk`, but keep a registry keyed by extension.

```
.chunker.ts        → code-chunk (6 languages)
.md                → section headings
. sh / .bash       → functions via tree-sitter-bash
{sql,yml,json,toml}→ one block per file
```

The point is not abstraction for its own sake: `code-chunk` supports exactly 6 languages (§ `01-research.md` 5), and repositories are mixed. The registry gives an attachment point when chunking without tree-sitter becomes necessary — without rewriting the pipeline.

We start with one chunker. The registry comes when a second one appears; building it in advance is YAGNI.

### Incrementality: a Merkle tree
Hashing a whole file on `sha1` catches any change, but editing one line in a 2000-line file reindexes the whole file.

**Plan:** store `content_hash` of the `text` of every stored chunk. When reindexing a file we compute hashes of the new chunks; matching ones reuse the old vector, changed and new ones are embedded again.

```
for each chunk:
  h = sha1(chunk text)
  if chunks.content_hash = h  → vector already exists, reuse
  else                        → embed
delete: chunks of the file that are not among the new ones
```

A Merkle tree gives the same at directory level; `zilliztech/claude-context` uses exactly that. **We start with per-chunk hashes** (simpler, covers 90% of the benefit), Merkle if speed on large repositories becomes necessary.

### Queue

We do not write incremental updates straight to the database — that races with parallel search. A cascaded queue: N workers read files, a single writer serializes transactions. Deduplication by `file_path`: while a file is queued, repeated events are ignored.

---

## 6. Search

### 6.1 Vector

```sql
SELECT chunk_id, distance, context
FROM chunks_vec
WHERE embedding MATCH ? AND k = ? AND language = ?
```

Metadata (`file_path`, lines, entity) — JOIN to `chunks` on `vec_rowid`. The `language` filter is applied inside the distance computation, so over-fetch is not needed.

`sqlite-vec` is brute-force exact KNN, without ANN. **Acceptability estimate:** 768 float32 = 3 KB per chunk. 20 000 chunks ≈ 60 MB for a full scan — tens of milliseconds. 200 000 chunks ≈ 600 MB — already noticeable. **Threshold ~50 000 chunks**, beyond that either a partition key by directory or an external ANN. Fixed by measurement in stage 4.

### 6.2 Lexical

FTS5 with `bm25()` — built into SQLite, requires no extensions. We search `context` (enriched text) and `entity_name`.

### 6.3 Merging — RRF

```ts
const K = 60
score(d) = Σ 1 / (K + rank_i(d))
```

RRF was chosen because it needs no calibration: raw vector distances and BM25 scores are not comparable, ranks are. `tree-sitter-analyzer` and `mcp-vector-search` use the same approach.

Order of execution: BM25 pre-filter (cheap) → top up to `k * 4` → vector search over those candidates → RRF. Or in parallel, if BM25 is not the bottleneck. **Decided by measurement.**

### 6.4 Rerank — cross-encoder (stage 7, optional)

RRF reliably collects candidates, but it does not distinguish "the topic is close" from "this is exactly it". A cross-encoder runs the pair "query ↔ document" directly and does distinguish.

```
query → RRF → top-30 → cross-encoder → top-K (5–10)
```

Model: `Xenova/bge-reranker-base` via `text-classification` with `text_pair`. Runs offline, same library.

**Why, if R7 accuracy is low.** If RRF finds the right chunk in 7th place, rerank will move it into the results. This is a cheap way to raise quality without changing the embedding model.

⚠️ Unverified: model quality on code. `bge-reranker-base` is trained on general-purpose text pairs. **Part of stage 6 — a measurement on the same 20 questions as for retrieval.**

⚠️ The cost: reranking top-30 on CPU is hundreds of milliseconds. Acceptable for stage 6, not used for auto-indexing.

⚠️ Do not copy hand-tuned coefficients such as `rerank*50 + hybrid*0.5` — rerank is a separate stage with its own weight, not a multiplier in someone else's formula.

---

## 7. Call graph: strategy

`tree-sitter-analyzer` already covers this need (8 tools, 22 languages, call graph, impact analysis). Building our own would be months of work with no added value.

**Three options, choose one in stage 5:**

| Option | Pros | Cons |
|---|---|---|
| A. A separate MCP server alongside | Zero code; any MCP client picks up both | Two processes; semantics split across servers |
| B. The agent calls both explicitly | Explicit control from the model | The model confuses the two sources |
| C. Proxy tool | Single entry point | Proxying a Python process from Node — complexity, latency |

**Recommendation: A.** Installed alongside, documented in the README, the LLM gets both sets of tools. Our server does not know about the graph at all. If merging is needed later — option C as a separate task.

Proxying `tsa` calls is **not necessary**: the agent can call several MCP servers on its own. This is the one place where I suggest not complicating things.

---

## 8. MCP tools

### 8.1 `anyindex_search` — the main one

```ts
server.registerTool('anyindex_search', {
  description: `...`,   // see §8.3
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  inputSchema: {
    query: z.string().describe('Natural query: by meaning or by name'),
    topK:   z.number().int().min(1).max(25).default(8),
    mode:   z.enum(['hybrid', 'semantic', 'keyword']).default('hybrid'),
  },
  outputSchema: {
    hits: z.array(z.object({
      file: z.string(),
      lines: z.tuple([z.number(), z.number()]),
      entity: z.string().nullable(),
      score: z.number(),
    })),
    total: z.number(),
    index: z.object({
      ready: z.boolean(),
      degraded: z.boolean(),
      files: z.number(),
      chunks: z.number(),
      stale: z.number(),
      lastUpdated: z.string().nullable(),
    }),
  },
}, async ({ query, topK, mode }) => { /* ... */ })
```

`structuredContent` is mandatory once `outputSchema` is declared — otherwise `ProtocolError`.

### 8.2 The other tools

| Tool | Annotations | Purpose |
|---|---|---|
| `index_status` | `readOnlyHint: true` | Index state: ready or not, how many files/chunks, what is stale, `degraded`. Takes no arguments |
| `index_rebuild` | `destructiveHint: true` | Full reindex. Slow — must send progress |
| `index_update` | `readOnlyHint: false` | Incremental pass over what changed |
| `get_file_outline` | `readOnlyHint: true` | Symbols of a file taken from already indexed chunks — without reading the file |

`readOnlyHint: true` on the search tools is a signal to the runtime that the call is safe; it influences the model's decision to call.

`index_rebuild` and `index_update` are side-effecting. We return errors as `{ content, isError: true }`: **the documented way to tell the model about a recoverable error after which it can continue working** (`docs/servers/errors.md`). Throwing is not allowed — the client would see a transport failure.

### 8.3 Tool description

The most important part. The model decides whether to call based on this text.

Structure:

1. What it does — one line, in the first sentence.
2. **USE WHEN** — 3–4 concrete triggers.
3. **DO NOT USE WHEN** — when the answer is already in context.
4. Result format: path, lines, entity.
5. What to do with an empty result: **say honestly that nothing was found, do not invent**.

Bad: `description: "Search codebase"`.

Points of reference: an LLM agent already knows `read` and `grep`. Our advantage is **finding by meaning what grep will not find**. That is what belongs in the description. The second advantage is coverage of the whole repository without reading directories.

### 8.4 Result format

An LLM reads text, it does not parse JSON. `content` is the ready-made text results, `structuredContent` is for programmatic processing.

```
Found 3 relevant snippets (hybrid search; index: 412 files, 3 stale, updated 2 min ago).

--- src/auth/login.ts (24-58) · login ---
export async function login(email: string, password: string) {
  const user = await db.users.findByEmail(email)
  if (!user) throw new AuthError('USER_NOT_FOUND')
  ...
}

--- src/auth/session.ts (12-40) · createSession ---
export function createSession(user: User) {
  ...
}

--- src/middleware/requireAuth.ts (1-22) · requireAuth ---
...
```

An empty result — honest and explicit:

```
No matches for "rate limiter".
The index covers 412 files but contains nothing matching this query.
This code may not exist in this repository — say so rather than guessing.
```

The last line is not decoration: without it the model hallucinates an implementation.

### 8.5 The auto-injection hybrid

Not implemented. We have no access to the system prompt, and `instructions` from `initialize` is supported inconsistently across clients. Instead — a quality tool description and an explicit `index_status`.

---

## 9. Configuration

Through CLI arguments and env, not through a config file in the user's repository — so as not to litter other people's projects.

| Argument | Env | Default |
|---|---|---|
| `--root <path>` | `ANYINDEX_ROOT` | nearest repository root above the working directory, else `process.cwd()` |
| `--db <path>` | `ANYINDEX_DB` | `<root>/.anyindex/index.db` |
| `--model <id>` | `ANYINDEX_MODEL` | `jinaai/jina-embeddings-v2-base-code` |
| `--dtype <d>` | `ANYINDEX_DTYPE` | `q8` |
| `--offline` | `ANYINDEX_OFFLINE` | `false` |
| `--watch` | — | `false` |
| `--autoindex` | `ANYINDEX_AUTOINDEX` | `true` |

⚠️ No `*_TOKEN`/`*_KEY` in the configuration. The model is ungated — no key is needed. That also removes the env-scrub problem (§ R6).

Paths inside `anyindexignore` are relative to `--root`.

### Ignore files

Everything the user already has is read, plus our own:

```
.gitignore
.cursorignore
.anyindexignore
```

⚠️ The order of addition matters: our file is added **last**, so that the user's file cannot cancel our mandatory exclusions. The minimal set (`node_modules`, `.git`, `dist`) is added **first** and is cancelled by nothing.

Keep the `BINARY_EXTENSIONS` list and the default exclusions battle-tested: `.onnx`, `Thumbs.db`, `__pycache__` and the `!.env.example` exception all belong there.

---

## 10. Filesystem watching

`chokidar` in `watch` mode, only from the root, without `node_modules` and `.git`. `add`/`change`/`unlink` events go into the queue. Debounce 500 ms. Auto-indexing is switched on by `--autoindex` and is the default.

⚠️ **Path normalization is mandatory (ADR-011).** `chokidar` returns paths with forward slashes (`C:/repo/src/a.ts`), `root` arrives native (`C:\repo`), `fast-glob` in POSIX form (`src/a.ts`). Without reducing them to one form, incrementality after a restart stops finding files — silently, with no error. Normalization lives in one place, `src/scanner.ts`, and the same function is used when writing `files.file_path`. Separately from it, root verification in `watcher.ts`: comparison via `path.relative`, otherwise the root is treated as an outside path and traversal never starts at all.

chokidar's `ready` event → a full pass: some files may have changed while the watcher was initializing.

---

## 11. Error handling and the ban on silent degradation

A direct consequence of issue #182 in `mcp-vector-search`: disabling AST chunking without an error yields a working but garbage index. That is the worst class of failure in our system (R9, ADR-010).

### Failure matrix

| Situation | Behaviour | Visibility |
|---|---|---|
| Model unavailable (first run, offline) | Tools return `isError` with understandable text. The server does not crash | `index_status.model: 'unavailable'` |
| File unreadable / binary | Skip | `skipped` counter |
| Language not supported by `code-chunk` | Skip | `skippedByLanguage` |
| **AST chunking has dropped out** | **`anyindex_search` refuses to work**, suggests `index_rebuild` | `degraded: true` + stderr immediately |
| `structuredContent` fails validation | `isError` | stderr with a stack |
| Unknown `dim` in `meta` | Refuse to work | `isError` + a hint |
| Database is locked | SQLite busy timeout 5 s, then `isError` | stderr |
| `UnsupportedLanguageError` | Handle, do not propagate | `skippedByLanguage` |

### Mandatory counters in `index_status`

```
degraded          — bool, is AST chunking active?
astChunks         — chunks obtained via tree-sitter
fallbackChunks    — chunks obtained some other way (normally 0)
skipped           — files skipped entirely
skippedByLanguage — { ext: count }
files, chunks, stale, lastUpdated
```

**Rule:** `fallbackChunks > 0` is always an error, not a normal mode. We do not implement a fallback to character slicing: it is better not to index a file than to index it incorrectly and report that everything is fine.

**The wider rule:** "works" ≠ "works correctly". All index state metrics are exposed without exception. Optimize retrieval quality (R7) before the instruction text.

---

## 12. What we deliberately do not do

- Our own call graph — `tree-sitter-analyzer` exists.
- Auto-injection into the system prompt — no access, not universal.
- An LSP client of our own — enormous effort, not the core of the task.
- An ANN index below ~50 000 chunks — brute-force is faster and simpler.
- Compiling for multiple languages — tree-sitter WASM handles it (ADR-009).
- Network calls — contradicts the goal.
- **Fallback to character slicing when AST fails** — instead the failure is made visible (ADR-010).

---

## 13. Platform requirements

The target platform is **Windows** (ADR-011). Mandatory rules:

| Rule | Reason |
|---|---|
| Paths only through `node:path` | String concatenation breaks separators |
| Path normalization in `scanner.ts` | `chokidar` and `fast-glob` give different forms (see §10) |
| A `.cmd` wrapper in `bin` | npm on Windows launches through cmd |
| Installation without MSVC | Stage 0 acceptance criterion |
| CI on Windows | Otherwise every check is green on Linux and red for the user |
| The `/` separator in paths inside the database | Portability of the index between operating systems |

An index created on Windows must open on Linux/macOS and vice versa. This is verified in stage 6.

---

## 14. Related documents

- `01-research.md` — evidence base
- `03-roadmap.md` — stages
- `04-risks.md` — risks and decisions
- `05-landscape.md` — analogues and the decision on builds from scratch
