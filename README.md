# anyindex-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24.0.0-lightgreen.svg)](https://nodejs.org)

Fully local MCP server for indexing a codebase and answering semantic search queries about it. No external API calls, no telemetry, no server process to run.

- **AST-aware chunking** via tree-sitter — chunks follow function and class boundaries, never cut mid-statement
- **Offline embeddings** via ONNX in-process; after the first download the model works with no network
- **Hybrid search** — vector + BM25 fused with RRF
- **One SQLite file** in the project, plus an FTS5 index
- **Works on Windows without Visual Studio Build Tools** — see [Platform](#platform)

## Quickstart

```bash
npm install
npm run build
npm run probe                                    # environment check, prints ms/chunk
anyindex-mcp reindex --root /path/to/project    # build the index once
anyindex-mcp search --root /path/to/project "user authentication flow"
```

A second `reindex` only touches changed files. Keep the MCP server with `--watch` to stay fresh while you work.

## Requirements

Node `^22.19.0 || >=24.0.0`. Node 23.x does not qualify at any patch level.

Embedding dominates the wall clock: plan against ~1 s/chunk on 4 cores, not the optimistic `probe` figure. If a run stalls, it is memory pressure — free RAM and retry. Measured numbers in [docs/06-environment.md](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/06-environment.md) §14.

## Install

```bash
npm install
npm run build
```

Verify the environment before going further:

```bash
npm run probe
```

`probe` checks Node version, `sqlite-vec`, `code-chunk`, the embedding model, and write permissions, and prints throughput numbers. Exit code `1` means a blocking failure — the stack should be reconsidered before writing code.

The package also installs as a dependency and puts both executables on your path.
Checked from a tarball into an empty project, with npm's install scripts blocked:

```bash
npm install ./anyindex-mcp-1.0.0.tgz
npx anyindex-mcp help
```

### Global install

Install it once and use it from any project. Both commands land on your `PATH`:

```bash
npm install -g anyindex-mcp
```

`npm install -g` needs elevated rights on some Windows setups; `npx anyindex-mcp`
without a global install works everywhere and is otherwise identical.

## Usage

Search output looks like this:

```
1. src/auth/login.ts:14-24  loginUser  distance 0.957 (moderate)
   export async function loginUser(email: string, password: string) {
     const row = await db.query('select * from users where email = ?', [email])
     ...
```

## Running as an MCP server

```bash
anyindex-mcp-server
```

Speaks MCP over stdio. Nothing is written to stdout except JSON-RPC framing; all diagnostics go to stderr. Wire it into a client as described below.

## Command-line reference

```bash
anyindex-mcp reindex --root /path/to/project   # build the index
anyindex-mcp update  --root /path/to/project   # incremental
anyindex-mcp status  --root /path/to/project   # state, --json for machine output
anyindex-mcp search  --root /path/to/project "user authentication flow"
anyindex-mcp probe                           # environment and hardware
anyindex-mcp benchmark                        # quality benchmark
anyindex-mcp --version                        # package version
anyindex-mcp help                            # same as --help
```

`reindex` and `update` exit `1` if `--root` does not exist. Without that check a
mistyped path scans nothing and reports a finished reindex.

`search` supports `--mode semantic|keyword|hybrid`, `--topK`, and `--json`; `--help` prints usage. Exit code is `1` when the index is not ready, so shell scripts can branch on it. Search refuses to run against an unready index rather than returning plausible-looking results.

`topK` counts files, not chunks: one file never takes two slots, so you may get
fewer results than you asked for.

## Client configuration

The server speaks MCP over stdio. Installed globally, the config is one line —
there is nothing to point at and nothing to set:

```json
{
  "mcpServers": {
    "anyindex-mcp": { "command": "anyindex-mcp-server" }
  }
}
```

**No project path in the config.** The working folder is taken from wherever the
agent was started, resolved up to the nearest enclosing repository root. Start the
agent in `~/work/myrepo/src/api` and it indexes `~/work/myrepo`, not the
subdirectory. Outside a repository it uses the working directory as it stands.

That also means the server has to be started *from* the project. A client that
spawns MCP servers from its own config directory rather than the project would
resolve the wrong root; `ping` reports the `root` it actually chose, so this is
one call to check:

```json
{ "echo": "pong", "root": "/home/you/work/myrepo", "model": "jinaai/jina-embeddings-v2-base-code",
  "node": "v24.21.0", "index": "/home/you/work/myrepo/.anyindex/index.db",
  "models": "/home/you/.cache/anyindex-mcp/models" }
```

Two clients spell the same thing differently.

**`.mcp.json` at the project root** — Claude Code, Cursor, VS Code. `command` is a
string, arguments go in `args`, variables in `env`:

```json
{
  "mcpServers": {
    "anyindex-mcp": {
      "command": "anyindex-mcp-server",
      "env": { "ANYINDEX_LOG_LEVEL": "warn" }
    }
  }
}
```

**opencode** wants `mcp.<name>.command` as an **array**, and takes a `cwd`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "anyindex-mcp": {
      "type": "local",
      "command": ["anyindex-mcp-server"],
      "cwd": ".",
      "environment": { "ANYINDEX_LOG_LEVEL": "warn" },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

The timeout matters: the first `anyindex_search` loads the model into a worker
and took 2745 ms on a warm index, against 145 ms for the next call. opencode
defaults to 5000 ms, which is enough — but a client with a shorter timeout will
drop the first call while everything is actually working. Per-client notes are in
[docs/10-clients.md](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/10-clients.md).

**Before the first search, build the index once:**

```bash
anyindex-mcp reindex --root .
```

A fresh install has no index. Until `reindex` runs, `anyindex_search` refuses to
answer rather than returning plausible-looking results, and `index_status` says
so.

## Configuration

All settings are optional. The server reads flags first, then environment variables, then defaults.

| Flag | Environment variable | Default |
|---|---|---|
| `--root <path>` | `ANYINDEX_ROOT` | nearest repository root above the working directory, else the working directory |
| `--index-root <path>` | `ANYINDEX_INDEX_ROOT` | nearest repository root above `--root`, else `--root` |
| `--db <path>` | `ANYINDEX_DB` | `<root>/.anyindex/index.db` |
| `--models <path>` | `ANYINDEX_MODELS` | user cache: `$XDG_CACHE_HOME`/`%LOCALAPPDATA%`/`~/.cache` + `anyindex-mcp/models` |
| `--model <id>` | `ANYINDEX_MODEL` | `jinaai/jina-embeddings-v2-base-code` |
| `--dtype <d>` | `ANYINDEX_DTYPE` | `q8` |
| `--offline` | `ANYINDEX_OFFLINE` | `false` |
| `--watch` | `ANYINDEX_WATCH` | `false` |
| — | `ANYINDEX_AUTOINDEX` | `false` |
| — | `ANYINDEX_LOG_LEVEL` | `info` |

Chunking and batching internals (`chunkSizeBytes`, `maxFileBytes`, `batchSize`) are fixed in `src/config.ts` and intentionally not exposed as flags or environment variables.

Only the index goes into the project: `.anyindex/` holds the database and nothing
else. The model is ~157 MB, identical for every project on the machine, so it is
downloaded once into the user cache — `<root>` stays clean, and deleting
`node_modules` does not throw it away. Point `--models` elsewhere to share one
cache between accounts or to keep it on a different volume.

No API keys. The embedding model is Apache-2.0 and ungated, so nothing secret is ever configured — which also means there are no `*_TOKEN`-style variables for MCP clients to strip from subprocess environments.

The model is fetched from Hugging Face on first use, not by `npm install`, and lands in the user cache. After that first download nothing reaches the network, so `--offline` works from a warm cache and fails with a clear error from a cold one.

### Ignored files

Ignore rules follow git's own precedence, verified against `git check-ignore`:

| Source | Scope | Precedence |
|---|---|---|
| `.git/info/exclude` | repository | lowest |
| `.gitignore`, `.cursorignore` | directory containing the file | per directory |
| `.anyindexignore` | `--root` only | highest |

Nested ignore files are honoured: `src/.gitignore` applies to `src/`, and a deeper
file overrides a shallower one, including re-including a path with `!`. `node_modules/`
and `.git/` are excluded programmatically and cannot be re-enabled by any rule.
Paths are relative to `--root`.

## Tools

| Tool | Annotations | Description |
|---|---|---|
| `anyindex_search` | read-only | Semantic + keyword search over the whole index. Returns file, lines, entity, and the match distance |
| `find_references` | read-only | Where an identifier is declared and used. Lexical matches, **not** a call graph |
| `get_file_outline` | read-only | Entities defined in one file, with line ranges. Cheaper than reading the file |
| `index_status` | read-only | Readiness, counts, staleness, and progress of a running index job |
| `index_update` | writes | Incremental reindex and embed. Runs in the background |
| `index_rebuild` | destructive | Full rebuild, recomputing every embedding |
| `ping` | read-only | Liveness probe returning the resolved configuration |

Parameters:

| Tool | Parameters |
|---|---|
| `anyindex_search` | `query` (required), `topK`, `mode` (`semantic` \| `keyword` \| `hybrid`) |
| `find_references` | `symbol` (required), `file`, `includeDefinitions`, `maxResults` |
| `get_file_outline` | `file` (required) — path relative to the indexed root, POSIX separators |
| `index_status` | none |
| `index_update` | none |
| `index_rebuild` | none |
| `ping` | none |

`index_update` and `index_rebuild` return immediately and work in the background, so
the client's request timeout does not limit indexing. Poll `index_status` until
`running` is false.

The timeout does matter for `anyindex_search`: the first call loads the model and
takes seconds. Measured 2745 ms on a warm model, then 145 ms and 119 ms.

`anyindex_search` refuses to run when `index_status` reports the index unready or
`degraded`, rather than returning weaker results that look normal. A half-vectorized
index counts as degraded: `index_rebuild` is the fix. Per-client wiring and timeouts
are in [the client notes](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/10-clients.md); see ADR-010 for why the refusal
exists.

## Measured quality

The indexer, hybrid search and watcher work end to end. 118 tests pass. Verified on
Linux x64 and Windows x64; **macOS is unverified**, so "works on all platforms" is
not yet true.

Retrieval quality was measured on 520 questions mined from commit history in Flask,
Gson and Fastify, against a `grep` baseline charged with the same tokenizer: the
correct file reaches the top 3 in **0.531** of cases versus **0.110** for grep, at
**1080** context tokens per question versus **3800**.

Two limits are measured and unfixed:

- Russian queries retrieve roughly 0.2 further than English ones. A multilingual
  model scores the same, so this is a property of matching Russian against English
  code, not of the model.
- No relevance threshold exists — across three models the distance gap between the
  worst positive and best negative case is negative. Results carry a distance and a
  confidence label instead of being silently filtered.

Quality also falls as the corpus grows, which is currently the largest measured
limit: top-3 is 0.711 on Flask, 0.473 on Gson, 0.328 on Fastify. Benchmark,
per-language numbers and the failure analysis are in
[docs/06-environment.md](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/06-environment.md) §18.

## Platform

Target platform is Windows (ADR-011). Rules that follow from it:

- Native modules are prebuilt where possible; no Visual Studio Build Tools are needed
- Paths are normalized to POSIX separators before storage, so an index built on Windows opens on Linux and back
- A `.cmd` wrapper is installed alongside the POSIX entry point
- `chokidar` reports paths with forward slashes while `root` arrives with backslashes, so anything comparing them must go through `path.relative`. A plain string comparison makes the watch root look like a path outside itself, and the watcher then reports nothing without any error

npm blocks install scripts by default, and none of them are needed here. Every native
dependency ships a prebuilt Windows binary inside its package, so `onnxruntime-node`,
`better-sqlite3` and the six `tree-sitter-*` grammars all load without
`npm install-scripts approve`. Verified on npm 12.1.0.

## Development

```bash
npm run build       # compile TypeScript and prepare bin entries
npm run typecheck   # type check without emitting
npm test            # integration tests against a real stdio server
npm run probe       # environment verification
```

External quality benchmark. Mines questions from commit history in Flask, Gson and
Fastify at pinned commits and compares against a grep baseline. Clones the three
repositories (~46 MB) and needs several hours for the first index of each; later
runs reuse the index and take minutes.

```bash
node scripts/bench-external.mjs --corpus flask     # also: gson, fastify
```

The scripts behind the analysis in `docs/06-environment.md` §18 live next to it:
`rank-sweep.mjs` compares ranking strategies on built indexes, `doc-regression.mjs`
checks that documentation queries keep working, `language-diagnosis.mjs` measures
how answerable the questions are, and `scale-control.mjs` re-measures the same
questions on a smaller index.

## Documentation

These are the design notes behind the release — measurements, decisions and the
open items. They are not shipped in the npm package, so the links point at the
repository.

| File | Contents |
|---|---|
| [00-README](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/00-README.md) | Index and decisions summary |
| [01-research](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/01-research.md) | Verified facts about every dependency, with sources |
| [02-architecture](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/02-architecture.md) | Components, schema, tool design |
| [03-roadmap](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/03-roadmap.md) | Implementation stages with acceptance criteria |
| [04-risks](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/04-risks.md) | Risk register and decision log (17 ADR) |
| [05-landscape](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/05-landscape.md) | Survey of existing tools and why they were rejected |
| [06-environment](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/06-environment.md) | Environment measurements, per platform |
| [07-bun-vs-node](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/07-bun-vs-node.md) | Bun/Node comparison, measured |
| [08-binary-distribution](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/08-binary-distribution.md) | Why there is no standalone binary |
| [09-gaps](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/09-gaps.md) | Inventory of what is still missing |
| [10-clients](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/10-clients.md) | Per-client configuration and timeouts |

## License

MIT