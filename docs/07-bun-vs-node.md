# 07. Bun versus Node — an empirical check

Date: **2026-09-29**. Environment: **Linux x64, Bun 1.4.2, Node (system)**.

⚠️ **Tested on Linux, but the target platform is Windows.** These data do not support any conclusion about Windows: native binaries, `bun:sqlite` and prebuilds behave differently. Re-testing on Windows is mandatory for any decision in favour of Bun.

## 1. What was installed

```bash
bun 1.4.2 → ~/.bun/bin/bun
mkdir /tmp/opencode/buntest && cd /tmp/opencode/buntest
bun add @huggingface/transformers@4.3.0
bun add code-chunk@0.1.14
bun add better-sqlite3@13.0.3 sqlite-vec@0.1.7-alpha.2
bun add @modelcontextprotocol/sdk@1.31.0 zod
```

## 2. Results matrix

| Component | Under Bun 1.4.2 | Details |
|---|---|---|
| `@huggingface/transformers@4.3.0` | ✅ **WORKS** | `dtypes: [fp32, fp16, q8]`, jina q8 → `dims: [1, 768]`, `len: 768`. The model loads and computes |
| `code-chunk` (native path) | ✅ **WORKS** | The AST is real: from `class S { async get() }` the entities `db, UserService, getUser, helper` are extracted |
| **`code-chunk/wasm`** | ❌ **DOES NOT WORK** | see §3 — **breaks ADR-009** |
| `bun:sqlite` + `sqlite-vec` | ✅ **WORKS** | `loadExtension()` passes, `CREATE VIRTUAL TABLE ... USING vec0` created |
| `better-sqlite3` + `sqlite-vec` | ✅ **WORKS** | Under Bun too: the prebuild loads, `sqliteVec.load(db)` passes |
| `@modelcontextprotocol/sdk@1.31.0` | ✅ **WORKS** | `registerTool` + `outputSchema` + `structuredContent` — full cycle: the client saw the tool, got `content: "ok:hello"` and `structuredContent: {"hits":["hello"]}` |

**Conclusion: Bun is compatible with the stack.** No component is broken by the runtime, apart from the `code-chunk` WASM path.

## 3. ❌ The error in ADR-009 — `code-chunk/wasm` is not a replacement

In `04-risks.md` R1 and ADR-009 I claimed that the WASM path was "a one-line import change". **That is wrong.** Verified in both runtimes.

**Under Bun:**
```
bun run t4.ts → TypeError: m.chunk is not a function
bun run t6.ts → TypeError: undefined is not an object
                (evaluating 'this.config.treeSitter')
                at init (node_modules/code-chunk/src/parser/wasm.ts:63:46)
```

**Under Node (the same sub-export):**
```
node → m.chunk is not a function
```

**The actual `/wasm` export:**

```
LANGUAGE_EXTENSIONS, UnsupportedLanguageError, WasmChunkingError, WasmGrammarError,
WasmParser, WasmParserError, createChunker, createWasmParser,
detectLanguage, formatChunkWithContext
```

**What is missing:** `chunk`, `chunkStream`, `chunkBatch`, `chunkBatchStream`.

**Why it is so:** in the package `exports` the `"bun"` condition redirects `./wasm` too, onto `./src/wasm.ts` — the source, not a build. Inside `createWasmParser(config)` requires `config.treeSitter` — **an explicit path to the WASM binary for every language**, which has to be configured by hand. That is a separate configuration layer, not an import switch.

**What this changes:**

| In the plan | Became |
|---|---|
| `code-chunk/wasm` as a ready escape-hatch | Requires manual configuration of the WASM binaries for each of the 6 languages |
| The expectation of "0 native modules out of the box" | Not confirmed; needs a separate task with a measurement |
| R1 as "a risk whose fix is one line" | R1 as an **open question**, decided at stage 0 |

**What to do:** stage 0 now has to check **both** paths and compare not only speed but also the amount of work to set up WASM. If manual configuration of 6 languages is more expensive than MSVC on Windows — reconsider ADR-009 towards the native path, with an honest MSVC requirement.

## 4. ⚠️ Friction: `bun pm trust`

```
$ bun add @huggingface/transformers@4.3.0
Blocked 2 postinstalls.
$ bun pm untrusted
./node_modules/onnxruntime-node @1.30.0
 » [postinstall]: node ./script/install
./node_modules/protobufjs @7.6.6
 » [postinstall]: node scripts/postinstall
```

`onnxruntime-node` downloads a native binary in postinstall, and Bun blocks that by default. Without `bun pm trust onnxruntime-node` the model will not load.

**For an MCP server this is a README instruction the user must carry out.** If they forget it — a failure at the first model load. Not a catastrophe, but an extra step that `npm install` does not have.

## 5. Pros and cons of Bun for our stack

**For:**
- `bun:sqlite` works with `sqlite-vec` — **no native `better-sqlite3` build**. It removes R2 completely.
- The built-in test runner (`bun test`, Jest-compatible API) — no need for vitest.
- `transformers.js` v4 + jina work without code changes.
- The native `code-chunk` works, the WASM path is broken under Bun too — parity with Node.
- Fast start, `bun run` with no TS build.

**Against:**
- `bun pm trust` for `onnxruntime-node` — an extra installation step (but that is about **Bun's trust infrastructure**, not about SQLite).
- MCP configuration requires `command: "bun"` instead of the default `"node"`.
- A dual runtime in a bundle with a Node-based host: the host is a Node process, our server is a Bun process.
- **Not tested on Windows** — the target platform.

## 6. Changing the distribution approach

With `command: "node"` the MCP client runs `node dist/index.js` — the user only needs `npm i -g`.

With `command: "bun"` you need `curl -fsSL https://bun.sh/install | bash`. That changes the barrier to entry: **our server becomes a dependency on a separate runtime rather than on Node, which the user almost certainly already has.**

⚠️ Not checked: how exactly Cursor, VS Code and opencode handle `command: "bun"`. This needs checking at stage 8.

## 7. Recommendation

**Stay on Node.** Reasons in descending order of weight:

1. **We tested where we do not deploy.** Linux ≠ Windows. None of Bun's advantages here transfer to the target automatically.
2. **`command: "node"` works with every MCP client with no configuration.** ADR-001 promised portability — Bun narrows it, requiring a separate runtime on the user's side.
3. **Bun's win is limited to one component** (`bun:sqlite` instead of `better-sqlite3`). `better-sqlite3` works under Bun too, and under Node it is the standard path with prebuilds.
4. **Bun's main argument — `bun:sqlite` — is devalued by the fact that the `code-chunk` WASM path is broken under Bun.** That means native modules cannot be avoided after all, and R1 is closed in neither direction.

Bun remains **an acceptable option**: the stack works, `bun:sqlite` really does remove R2. The decision is worth revisiting only if the Windows check shows that the native `better-sqlite3`/`onnxruntime-node` prebuilds are missing there or do not build. Then Bun stops being a preference and becomes a workaround.

## 8. What was revised in the plan

| What | How |
|---|---|
| ADR-009 "`/wasm` = a one-line change" | ❌ **Disproved.** Requires WASM binary configuration. R1 → open question |
| Stage 0 item 0.1 | Extended: compare not the speed but the **configuration effort** of both paths |
| ADR-013 (rerank) | ⚠️ Correction: **~1 GB RSS**, not a "cheap stage". The decision is taken consciously |
| R1 | Remains **critical and unresolved** until stage 0 |
| R2 (`better-sqlite3` ABI) | Still relevant for Node; removed if Bun is chosen |
