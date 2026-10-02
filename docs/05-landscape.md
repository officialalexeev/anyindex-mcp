# 05. Landscape of analogues

Date: **2026-09-29**. Search across GitHub/PyPI/npm plus reading the sources.

Method and limitations: **nothing was run.** Every claim about behaviour comes from READMEs, documentation, and reading the sources. Claims of "fully offline", "zero API calls", and any benchmarks in the tables below are self-reported and unverified. One project was checked empirically (see §1).

---

## 1. Screening: what drops out immediately

| Project | Reason for screening out |
|---|---|
| ❌ `zilliztech/claude-context` (12 575★, MIT) | Requires **two** daemons: Milvus + Ollama. Default embeddings are OpenAI. There is no configuration with no external service at all. Fully local only through Docker Compose. 40 open issues, among them #249 "Index not auto-loaded on MCP server restart" |
| ❌ `Veles` (MIT, Rust) | Dropped AST: it slices in 50-line units, and the code says `// TODO: Add tree-sitter-aware chunking`. 7★, last push 2026-05-11 |
| ❌ `Seroost` (MIT, Rust) | Not an MCP server at all — an HTTP server on `tiny_http`. TF-IDF with no vectors, no tree-sitter. Input: txt/PDF/XML, **not source code**. README: "THIS SOFTWARE IS UNFINISHED". Last commit 2023-04-03 |
| ❌ `ceaksan/mcp-code-search` | Technically close (jina-embeddings-v2-base-code, LanceDB, RRF, tree-sitter), but 0★, not on PyPI, last push 2026-03-09, v0.1.0. Immature |
| ❌ `semantic-code-search` (n1ra7) | Qdrant through Docker. AST chunking, hybrid and rerank are in a "Roadmap" section, that is, not implemented. 0★ |
| ❌ `duysolo/codebaxing` (TS) | ChromaDB in server mode at `localhost:8000`. External daemon |
| ❌ `CodeBendKit/codeseek` (Rust) | The install wizard requires an `api_token`; rerank goes through an OpenAI-compatible endpoint |
| ❌ `knitli/codeweaver` | README: "no longer maintained", 84 open issues |
| ❌ `molaco/rust-code-mcp` | **No license file** (`None`) — all rights reserved, legally unusable |
| ❌ `AperturePlus/augmented-codebase-indexer` | No license + external Qdrant |

---

## 2. The only project that covered the whole spec — and why it dropped out

### `mcp-vector-search` (bobmatnyc) — 56★, Python, **Elastic License 2.0**

Verified from the sources: RRF `k=60` (`mcp/hybrid_search_handler.py`), tree-sitter AST with a 3-level hierarchy, LanceDB + Kuzu, SHA-256 per chunk, a watcher built on watchdog, 17 MCP tools, stdio, zero external services and keys. Technically — an exact match to the spec.

**It drops out for three reasons:**

1. **License.** Elastic License 2.0 is source-available, not OSI. It forbids offering the functionality as a service. It does not get in the way of personal local use, but it blocks releasing your own project under MIT/Apache.
2. **Native extensions under Python.** The dependency tree includes `tree-sitter-language-pack`, `lancedb`, `sentence-transformers`, `kuzu`.
3. **Unproven operability.** See §2.1.

### 2.1 Empirical check — user report, 2026-09-29

> Не корректно работает на Windows + Python 3.12, и много других проблем.

This overrides everything else. It lines up with the open issues of that same project:

| Issue | Contents |
|---|---|
| #182 | **Tree-sitter parsing silently disabled** — incompatible API after the `tree-sitter-language-pack >= 1.0` rewrite. AST chunking does not work and does not report it |
| #178 | `ModuleNotFoundError: No module named 'resource'` on Windows. `resource` is a Unix-only module |
| #174 | The MCP server exits with code 1 while working perfectly |
| #175 | A binary installed via `uv` is not recognized by the client |
| #183 | Deprecated `sentence-transformers` API |

⚠️ #182 is the most dangerous of them: **AST chunking failing without an error.** Such a failure yields a working but garbage index, and the only way to notice is by result quality.

**Conclusion for this section:** the project drops out. Not because of the license — the license was solvable. Because of operability.

---

## 3. Remaining candidates

### `srclight` — MIT, Python, 57★

The most mature of what was found: 0 open issues, 118 commits in 30 days, a single SQLite file, SHA-256 incrementality, tree-sitter over 19 languages, an RRF hybrid, 43 MCP tools, a documented freshness contract `verified-fresh`/`stale` on every result, 2314 downloads a month from PyPI.

⚠️ **It drops out for the same reason as `mcp-vector-search`:** Python. The user's problem is native extensions and Unix dependencies in Python, not any particular project. `srclight` sits in the same risk class.

⚠️ A separate gap: `embeddings.py` implements only HTTP providers (Ollama, OpenAI, Cohere, Voyage). There is no in-process ONNX path.

### `cocoindex-code` (`ccc`) — Apache-2.0, Python, 2726★

The only one with a pluggable chunker registry (`ChunkerFn`), a Rust engine with real incrementality ("one edit → one chunk re-embedded"), a bundled `cocoindex.db` + sqlite-vec, `ccc mcp` over stdio, installation via `pipx install 'cocoindex-code[full]'` with no key.

⚠️ It drops out: **only one MCP tool** (`search`), **vector-only — no BM25, no RRF**, a background daemon, anonymous telemetry (disabled with `COCOINDEX_DISABLE_USAGE_TRACKING=1`), 44 open issues. Python.

⚠️ `cocoindex` itself (11 630★, Apache-2.0) is **not an MCP server at all**: issue #160 is closed, and #2216 "drop MCP auto-registration" removed the MCP configuration in favour of a CLI.

### `Helweg/open-codebase-index` — MIT, TypeScript, 206★

The closest analogue by stack: TS, **native Rust parsers for 20+ languages**, SQLite + usearch + BM25, `fusionStrategy: "rrf"`, reuse by content hash, a watcher, catalogs per branch, one zero-star issue, 131 commits in 30 days. It exports tools **and prompts** (`register-prompts.ts`) — the only one found that ships prompts.

⚠️ The hybrid requires Ollama/OpenAI/Google — locally only `indexing.mode: "structural"` works. ⚠️ Native parsers on Windows are the same risk class as everywhere else.

⚠️ Unverified: I did not read the sources, only the README and GitHub metadata. **It needs a separate assessment before any decision.**

---

## 4. The market gap — put plainly

> Every project that does **real AST chunking + an RRF hybrid + local embeddings** either goes vector-only or requires a daemon. Every project free of daemons either drops AST, or is immature, or is unreliable on Windows/Python 3.12.

Additional observation: **the overwhelming majority of competitors are Python.** On Node/TypeScript the field is practically empty: `open-codebase-index` (206★, but native Rust parsers), `codebaxing` (external ChromaDB), `ctx-sys` (14★, FTS5 with no vectors).

⚠️ The search was bounded by the GitHub API rate limit — the long tail below ~5★ is not listed exhaustively. The list is sorted by stars and covers everything that surfaced above the threshold.

---

## 5. Decision

We build from scratch. The reasons, in order of weight:

1. **Empirical confirmation that the closest analogues are unreliable on the target platform** (Windows + Python 3.12) — §2.1.
2. **A risk class, not a particular project.** The Python ecosystem with its native extensions and Unix modules is the source of the problem. A Node stack sidesteps it entirely.
3. **A permissive license.** MIT/Apache on your own code, with no restriction on commercial use or redistribution.
4. **Control over result quality.** The one area where competitors are systematically weak: what exactly ends up in the model's context. That is the product.

**What we take from what was found — not code, but decisions:**

| Decision | From | Already in the plan |
|---|---|---|
| RRF `k=60` | `mcp-vector-search` | ✅ `02-architecture.md` §6.3 |
| AST chunking with `contextualizedText` | `code-chunk` | ✅ §5 |
| Freshness contract on every result | `srclight` | ✅ `index_status`, §8.4 |
| Incrementality by content hash | `srclight`, `mcp-vector-search` | ✅ ADR-005 |
| Public chunker registry | `cocoindex-code` | ✅ §5, deferred until the second chunker |
| **Never degrade silently** | issue #182 | ✅ R9 + ADR-010, §11 |

⚠️ The last row is a direct consequence of the empirical check. Silently disabling AST chunking produces an index that looks working and is garbage at the same time. In our code any disabling has to be visible: a counter in `index_status` and an explicit warning in the results text.

---

## 6. What I did not verify

- Not one project was run. Behaviour comes from the sources.
- `open-codebase-index` was assessed only from its README and metadata — the only Node analogue worth studying before the start.
- Competitor benchmarks were not reproduced; none publishes its methodology.
- The completeness of the list is bounded by the GitHub API rate limit.
- `mcp-vector-search` "many other problems" — was that ever spelled out beyond Windows/Python 3.12? It may well be grounds on its own, but the list would be useful.
