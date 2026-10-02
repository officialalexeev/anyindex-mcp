# Local MCP server for codebase indexing

Goal: an MCP server that indexes a local repository (AST chunks + offline embeddings + hybrid search) and returns results to the LLM through MCP tools. No external APIs.

## Documents

| File | Contents |
|---|---|
| `01-research.md` | Verified facts about every dependency. What is confirmed, what is refuted, what was NOT found. **Read first.** |
| `02-architecture.md` | Technical design: components, database schema, MCP tool shapes. |
| `03-roadmap.md` | Implementation stages with acceptance criteria. |
| `04-risks.md` | Risk registers and decisions (ADR). |
| `05-landscape.md` | Analysis of the alternatives and the decision to build from scratch. |
| `06-environment.md` | Stage 0 numbers and measurements on real hardware, including the failures. |
| `07-bun-vs-node.md` | Empirical comparison of Bun against Node. Results matrix. |
| `08-binary-distribution.md` | Why a single binary is impossible and what to do instead. |
| `09-gaps.md` | **Inventory of what is still open: what remains and why.** |
| `10-clients.md` | Quirks of specific MCP clients: timeouts, what is verified and what is not. |

## Verification status

Date: **2026-09-29**. Package and model versions were checked against primary sources (npm registry API, GitHub, Hugging Face API, official docs). Sources are cited line by line. None of the alternatives was run — see `05-landscape.md`.

## Decisions made before the work started

| ADR | Decision |
|---|---|
| 001 | MCP server, not a proprietary plugin — portability to any client |
| 002 | `jina-embeddings-v2-base-code` — Apache-2.0, ungated, 768d, 8192 tokens |
| 003 | `better-sqlite3` + `sqlite-vec` + FTS5, RRF for fusion |
| 004 | Call graph — the separate `tree-sitter-analyzer` server, not our own |
| 005 | Incrementality by per-chunk hashes, not by a Merkle tree |
| 006 | `structuredContent` + textual `content` at the same time |
| 007 | Logs to stderr only — stdout belongs to JSON-RPC |
| 008 | No secrets in configuration — the model is ungated |
| 009 | ~~`code-chunk/wasm` by default~~ — ❌ **REFUTED** empirically: it requires WASM binaries to be configured. R1 → open question |
| 010 | **Silent degradation is forbidden** — an AST fallback must be visible |
| 011 | **Windows — a first-class target platform** |
| 012 | **Embeddings in a worker thread + offload when idle** — otherwise the MCP channel gets CPU-blocked |
| 013 | **Cross-encoder rerank — stage 7**, only if the measurements justify it. ⚠️ Memory cost was not measured on this project |
| 014 | **Runtime — Node, not Bun.** The stack works under both; Node does not require a separate runtime on the user's machine |
| 015 | **No binary distribution.** `sharp` is a hard transformers dependency and blocks `bun build --compile`; SEA does not understand ESM |
| 016 | **Cross-platform verification deferred** to stage 6. Development is local; 5 open items have piled up. ⚠️ Later reverted by an owner decision: Windows is verified, macOS is not |
| 017 | **`find_references` — lexical search for mentions, not a call graph.** ADR-004 stands: `tree-sitter-analyzer` remains the only source of resolved calls |

## Four main conclusions

1. **We build from scratch.** The nearest alternatives are out: `mcp-vector-search` does not work on Windows + Python 3.12 (confirmed by a user), `srclight` and `cocoindex-code` carry the same class of risk on Python. Details in `05-landscape.md`.

2. **The market gap is confirmed:** every project that does AST chunking + RRF hybrid + local embeddings either requires a daemon, or is vector-only, or drops AST. On Node that field is empty.

3. **Three native trees in one project** — R1 (`code-chunk`), R2 (`better-sqlite3`), R3 (`@huggingface/tokenizers`). ADR-009 plus a fallback takes two of the three away.

4. **The worst failure is not a crash but silent degradation.** In the alternatives AST chunking switches off without an error: the index looks healthy and is full of garbage. ADR-010 forbids this by construction.