# 10. MCP clients

The README covers the general case: launching over stdio, environment variables, and the configuration for both `.mcp.json` clients and opencode. This document covers only what the general case leaves out — the quirks of specific clients and the traps that come with them.

## 10.1 What all clients have in common

The server uses nothing but standard MCP capabilities: `tools/list`,
`tools/call` and `notifications/progress`. No vendor extensions, no methods
of its own, no non-standard headers. Connecting to any MCP client therefore
comes down to starting a process and exchanging messages over stdio.

Three things to know when connecting:

**The client timeout matters more than it looks.** The first `anyindex_search` on a warm model
takes seconds: the model loads into the worker. Measured on a warm index of
43 files and 423 chunks:

| Call | Time |
|---|---|
| First `anyindex_search` | 2745 ms |
| Second | 145 ms |
| Third | 119 ms |

The 20x difference is the cost of loading the model, not of running the search.
A client with a short timeout will drop out on the first call even though
everything works. opencode defaults to a 5000 ms timeout, Claude Desktop has
its own logic. Check your own client's value.

**Indexing is not bounded by the timeout.** `index_update` and `index_rebuild`
return a result immediately and work in the background. The client polls
`index_status` until `running` becomes `false`.

**Standard input and output are taken.** Only JSON-RPC goes to stdout, the whole log
goes to stderr. If a client merges the streams, the output will contain stray
lines; the default level is `info`, and it can be lowered with `ANYINDEX_LOG_LEVEL`.

## 10.2 opencode

The configuration is read once at startup and is not reloaded on the fly — after
an edit you need to restart opencode.

Project configuration: `./opencode.json`, `./opencode.jsonc` or `.opencode/opencode.json`
at the repository root. This lets you leave the global `~/.config/opencode/` alone:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "anyindex-mcp": {
      "type": "local",
      "command": ["node", "/path/to/repo/dist/index.js", "--root", "/path/to/repo"],
      "cwd": "/path/to/repo",
      "environment": { "ANYINDEX_LOG_LEVEL": "warn" },
      "enabled": true,
      "timeout": 120000
    }
  }
}
```

The schema is validated at startup and rejects unknown fields, so
`additionalProperties` tolerates no extras here. The `mcp.<name>.type` and
`command` fields are required; `command` is an array of strings, not a string.

If the working directory matches the root of the indexed project, `--root` can be
omitted: it defaults to the current directory.

The `.opencode/` directory holds machine-specific path-bound settings, so it is
listed in `.gitignore` together with `.anyindex/`.

## 10.3 Other MCP hosts

The server speaks plain MCP over stdio with no vendor extensions, so any host
that can spawn a process works — there is no host-specific wiring to document here.

There is a separate question of whether a given host exposes MCP resources to the
model. Item 8 of the inventory was closed by the decision not to implement them:
nobody has verified that `resources/list` is handed to the agent. Building against
an unconfirmed consumer would mean adding an unused surface.

**Other hosts were not verified.** No wiring beyond the SDK client and opencode
took place.

## 10.4 Clients with `.mcp.json`

Claude Code, Cursor, VS Code and others read `.mcp.json` at the project root.
The format is different — `command` is a string, arguments go in a separate `args`
array, variables in `env`. The block itself is in the README, under "Client
configuration".

**Not verified.** The structure of the file matches the specification, but none of
these clients was ever run.

## 10.5 What was actually verified

| Client | How it was verified |
|---|---|
| SDK client on `@modelcontextprotocol/sdk` | 53 tests, the full handshake and call cycle |
| opencode | `.opencode/opencode.json` reproduced verbatim, handshake 2176 ms, all 6 tools, real calls to `ping`, `index_status`, `anyindex_search` |
| `.mcp.json` clients | Not verified |

The opencode check did not go through opencode itself but through a script that read
the same configuration and started the process with the same command. This confirms
that the command in the configuration starts a working server, but not that opencode
displays it correctly. A full check requires restarting opencode in this repository
and calling the tools from a session.