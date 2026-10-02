# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release links for every version are at the bottom of this file.

## [Unreleased]

## [1.0.0] - 2026-10-02

First public release. Seven MCP tools, a command line with six subcommands, and a
local quality benchmark that ships with the repository.

### Added

- **`anyindex_search`** — hybrid search over the whole codebase: vector similarity
  fused with BM25 by reciprocal rank fusion. Returns file, line range, entity name
  and the match distance.
- **`find_references`** — where an identifier is declared and used. Lexical
  matches on whole tokens, explicitly *not* a call graph; the tool description and
  every response say so. `ADR-017` records why the boundary sits there.
- **`get_file_outline`** — the symbols one file defines, with line ranges.
- **`index_status`, `index_update`, `index_rebuild`, `ping`** — index lifecycle
  and liveness.
- **Command line** — `reindex`, `update`, `status`, `search`, `probe`,
  `benchmark`. Exit code `1` when the index is not ready, so a shell script can
  branch on it.
- **A refusal to search an unready index.** `anyindex_search` returns an error
  instead of plausible-looking results when `index_status` reports the index
  unready or degraded. A half-vectorized index counts as degraded.
- **`probe`** — checks the Node version, `sqlite-vec`, `code-chunk`, the embedding
  model and write permissions, then prints throughput. Exit code `1` on a blocking
  failure, so the stack can be reconsidered before code is written. The output no
  longer goes through `ANYINDEX_LOG_LEVEL`: run under `error`, the command used to
  print its summary without naming a single failed check.
- **`--version`** on the CLI, and `ANYINDEX_WATCH` alongside the existing
  `--watch` flag. Every other setting was reachable from both, these two were not.
- **A `.mcp.json` block in the README** for every supported client, each behind a
  collapsible heading: Claude Code, Cursor, VS Code, Claude Desktop, Zed, opencode.
  The client notes pointed at a config the README did not contain.
- **The launch command is `npx --package anyindex-mcp anyindex-mcp-server`.** The
  package ships two binaries, and `npx` resolves package names rather than binary
  names, so the shorter `npx -y anyindex-mcp-server` fails with `could not
  determine executable to run`.
- **A no-silent-degradation guarantee.** Chunking strategy is stored per chunk and
  counted in `index_status`; a tree-sitter failure falls back visibly instead of
  producing a working-looking index full of garbage. `ADR-010`.
- **An external quality benchmark** — 520 questions mined from the commit history
  of Flask, Gson and Fastify at pinned commits, scored against a `grep` + 80-line
  window baseline charged with the same tokenizer. Method, per-corpus numbers and
  the failure analysis are in [docs/06-environment.md](https://github.com/officialalexeev/anyindex-mcp/blob/main/docs/06-environment.md) §18.

### Fixed

- **`npm ci` failed on Windows with Node 22.19.** npm below 11.21 does not block
  dependency install scripts and synthesises `node-gyp rebuild` for any package
  that ships a `binding.gyp` without an install script, which `better-sqlite3` is.
  The rebuild needs MSVC, and the node-gyp inside npm 10 cannot even recognise
  the Visual Studio 18 installed on the runner. `engines` now requires
  `npm >= 11.21.0` and CI pins it, since Node bundles different npm per release.
  No install script is needed anywhere: every native dependency carries its
  binary in the tarball.
- **Two CI jobs never ran.** `probe` and `native-fallback` referenced
  `matrix.os` without declaring a matrix, so GitHub scheduled neither. The
  `probe` job is the only thing that checked the native stack loads without a
  toolchain, and it had never executed.

- **`reindex` and `update` exit `1` when `--root` does not exist.** A mistyped path
  scanned nothing, printed "Done in 0.4s" and exited `0` — indistinguishable from a
  finished reindex, and exactly the silent failure ADR-010 exists to prevent.
- **`status` separates code from non-code chunks.** Markdown, JSON, YAML and TOML
  have no tree-sitter grammar and always take the structural path, so in a
  documentation-heavy repository the `fallback` count was mostly expected work and
  read like a broken parser. It now reports `Code: AST n` and `Non-code: n`, and
  names a fallback on a parsable language as a failure on its own line.
- **An index that was never built reports `degraded: false`.** Nothing had failed;
  `degraded` now means a subsystem did, which is what the field claims to say.
- **`ANYINDEX_LOG_LEVEL` is case-insensitive and reports unknown values.** `WARN`
  used to read as `info`, handing back more output than was asked for, and a typo
  looked exactly like a logger that ignores configuration.
- **The README links to the repository instead of `docs/`.** The design notes are
  not shipped in the tarball, so fifteen relative links had nowhere to resolve on
  the package page.

### Changed

- **Documentation is weighted slightly below code.** Markdown was the top hit in
  25.2 % of external questions and the single most common cause of a miss, because
  a commit subject and a README section are both natural language. The weight is
  0.9, chosen as the highest value that leaves documentation-first queries working.
- **Search returns files, not chunks.** One file can no longer occupy several
  `topK` slots; in 23.7 % of external questions it did. Duplicate files in the top
  3 went from 123 to zero, and top-3 reached 0.531. `get_file_outline` covers the
  rest of a file.

### Measured limits

Published rather than hidden, because they are the reason to read the numbers:

- Quality falls as the corpus grows: top-3 is 0.711 on Flask, 0.473 on Gson, 0.328
  on Fastify. Not a language effect — the questions are equally answerable across
  the three and chunk sizes are near-identical — but confirmed scale dependence.
- Russian queries retrieve roughly 0.2 further than English ones. A multilingual
  model scores the same, so it is a property of matching Russian against English
  code.
- No relevance threshold exists: across three models the distance gap between the
  worst positive and best negative case is negative. Results carry a distance and a
  confidence label instead of being silently filtered.
- Verified on Linux x64, Windows x64 and macOS x64, on Node 22.19 and 24. The macOS
  claim is the one that was outstanding: it is now covered by CI, which runs the
  build, the type check and the test suite on all three platforms, plus `probe` on
  each.
- Embedding is the wall clock: about 1.2 s per chunk on 4 cores, which is minutes
  for a small repository and hours for a large one. `probe` reports an optimistic
  figure; plan against the real one.

[Unreleased]: https://github.com/officialalexeev/anyindex-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/officialalexeev/anyindex-mcp/releases/tag/v1.0.0