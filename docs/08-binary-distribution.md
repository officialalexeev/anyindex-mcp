# 08. One binary — testing the hypothesis

Date: **2026-09-29**. Question: if everything is bundled into a single executable file, will the MCP work on all operating systems?

**Short answer: no.** Verified by running it, not by reading the documentation.

## 1. What was checked

| Approach | `better-sqlite3` + `sqlite-vec` | `@huggingface/transformers` + onnx | ESM project | Single file |
|---|---|---|---|---|
| `bun run`, no build | ✅ | ✅ | ✅ | ❌ `node_modules` required |
| `bun build --compile` | ✅ **81 MB, works** | ❌ **`sharp`** | ✅ | ✅ but breaks on sharp |
| `bun build --compile --external sharp` | — | ❌ `node_modules` needed at runtime | — | ❌ |
| `bun build --compile --define sharp=stub` | — | ❌ the substitution does not take | — | ❌ |
| Node SEA | — | — | ❌ **entry point is CJS only** | ✅ but incompatible with ESM |

## 2. Blocker #1 — `sharp`

```
error: Could not load the "sharp" module using the linux-x64 runtime
Possible solutions:
    npm install --include=optional sharp
    npm install --os=linux --cpu=x64 sharp
```

`sharp` — a **hard dependency** of `@huggingface/transformers`, not an `optionalDependencies` one:

```
@huggingface/transformers@4.3.0 dependencies:
{ "sharp": "^0.35.4", "onnxruntime-web": "1.31.0-dev...", "onnxruntime-node": "1.30.0",
  "@huggingface/jinja": "^0.5.10", "@huggingface/tokenizers": "^0.2.0" }
```

It is imported **statically at the top** of the bundle:

```
node_modules/@huggingface/transformers/dist/transformers.node.mjs:18832
  import sharp from "sharp";
```

Three consequences follow:

1. **Falling back to v3 does not help.** `@huggingface/transformers@3.7.6` contains `sharp` too (`^0.34.1`). Checked against the npm registry.
2. **There is no lazy import** — the module is loaded even when we never touch images.
3. **`sharp` is a platform-specific native module.** Exactly what a binary is meant to remove.

### Why the workarounds did not work

| Attempt | Result |
|---|---|
| `--external sharp` | `error: Cannot find package 'sharp' from '/$bunfs/root/ml-bin-ext'` — the binary needs `node_modules` again |
| `--define sharp=./stubs/sharp.js` | `--define` substitutes values, not imports; the static `import sharp from "sharp"` stayed |
| Stub via alias | The same dead end: the substitution requires a runtime patch |

The only "clean" route is not to use `@huggingface/transformers` at all (Ollama, llama.cpp, a separate service). But then the requirement of "one local application with no daemons" is lost, and an external process comes back.

## 3. Blocker #2 — Node SEA does not understand ESM

```
Warning: Failed to load the ES module: ml.mjs.
SyntaxError: Cannot use import statement outside a module
    at embedderRunCjs (node:internal/main/embedding:63:7)
```

Both `.js` (with `"type": "module"` in `package.json`) and `.mjs` with `useSnapshot: false` were tried — the result is the same. The SEA entry point always executes as CommonJS.

Our project is ESM (`"type": "module"`, `module: NodeNext`). So SEA would have required either a CommonJS wrapper or dropping ESM syntax across the whole project.

As a side effect: the SEA binary came out at **121 MB** — that is `node` (~110 MB) plus a 545-byte blob with our code. The whole JS bundle takes a fraction of a megabyte.

## 4. What worked

`bun build --compile` with a storage layer — **a fully working single file**:

```
 [25ms]  bundle  17 modules
[593ms] compile
-rwxr-xr-x  81M  probe-bin
$ ./probe-bin
sqlite-vec OK: v0.1.9
```

`better-sqlite3` and `sqlite-vec` compile and work. The problem is only in the embedding layer.

## 5. Why the binary does not solve the real task

The actual portability problem is not "the user has no Node", but this:

| Problem | Solved by the binary? | What actually solves it |
|---|---|---|
| No native prebuilds for a specific OS | ❌ the binary is platform-specific too | `optionalDependencies` in npm — the standard mechanism |
| `npm install` blocks install scripts | ❌ bypasses the problem but does not solve it | `npm install-scripts approve <pkg>` |
| Windows path separators | ❌ | Normalization in code (ADR-011) |
| `sharp` in the binary | ❌ only removes the Node-specific part | — |

**One binary per operating system means 5–6 artifacts**: linux-x64, linux-arm64, macos-x64, macos-arm64, win-x64, win-arm64. Each needs its own CI runner, because `better-sqlite3` and `onnxruntime-node` are practically not cross-compilable. And `sharp` still does not fit inside.

## 6. Decision

**Do not build the binary.** Reasons in order of weight:

1. **Technically impossible** with the current stack: `sharp` is a hard dependency, a static import, a platform-specific native module.
2. **ESM is incompatible with SEA** — and switching to CommonJS just to package means losing Node compatibility and `verbatimModuleSyntax`.
3. **It does not solve the target problem.** Per-OS native modules are solved by `optionalDependencies`, not by packaging.
4. **The CI cost** is incommensurable with the gain for an audience that has Node anyway: the MCP client runs `command` itself, and for Node servers that is `"command": "node"`.

### What to do instead for "works on all operating systems"

| Measure | What it gives |
|---|---|
| `engines.node: "^22.19.0 || >=24.0.0"` | Cutoff of unsuitable versions at install time |
| Pinning versions of native packages | Predictability between updates |
| `npm install-scripts approve` in the README | A working workaround when there are no prebuilds (ADR-011) |
| **CI matrix** `windows-latest` / `ubuntu-latest` / `macos-latest` × Node 22.19 and 24 | **The only way to prove it works on all operating systems** |
| `npm run probe` in CI | The same set of checks on every platform |
| Path normalization (ADR-011) | Index portability between operating systems |
| Capability probe in `index_status` (ADR-010) | Failure is visible, not silent |

⚠️ **The CI item is not an option, it is a condition.** The claim "works on all operating systems" cannot be confirmed without a run on all three. It does not follow from the Linux run: `sharp` has already shown that platform-specific native modules behave differently. `docs/06-environment.md` §5 lists three blocking items that can only be closed on Windows.

## 7. What remains open

1. **Is `sharp` always needed?** Maybe transformers has a flag that turns the loading off. Not verified — and in any case it is a fragile support.
2. **Is there a fork without `sharp`?** I did not look. If a maintained fork of `@huggingface/transformers` without the image dependency turns up, the binary becomes discussable again. But that is a change of stack, not of build.
3. **Behaviour on macOS arm64 and Windows arm64** was not checked at all.
## 8. How to check portability: locally or through CI

**A public repository is not required.** GitHub Actions works on private ones.

| | Public | Private (Free) |
|---|---|---|
| Actions | free, no limit | **2000 min/month**, 500 MB of artifacts |
| macOS | free | billed |

⚠️ Minutes are counted in **Linux units**: a Windows minute costs **2**, a macOS minute costs **10**. A full matrix run (6 build jobs + 3 probe + 3 fallback) ≈ **39 Linux-minutes**. That fits the Free limit with room to spare; with frequent pushes the macOS part eats the budget first.

### What each method covers

| Method | Windows | Linux | macOS |
|---|---|---|---|
| Locally on your own machine | ✅ if you are on Windows | ✅ | ❌ |
| `act` (Docker) | ❌ Linux containers only | ✅ | ❌ |
| GitHub Actions, private repo | ✅ | ✅ | ✅ |

⚠️ **`act` does not check Windows and macOS.** It runs only Ubuntu containers; for windows/macOS you need the flag `-P windows-latest=-self-hosted`, that is, actually running on the host. That gives nothing beyond an ordinary local run.

### A practical scheme

**You work on Windows** — which means your machine is the Windows check. Locally:

```bash
npm run verify
```

That is `typecheck` + `build` + `test` + `probe`. It is precisely what closes the three blocking items from `06-environment.md` §5 — the prebuilds of `tree-sitter-*`, `better-sqlite3` and `npm install-scripts approve`.

**GitHub Actions is needed only for Linux and macOS.** A private repository is enough; a public one only lifts the minutes limit.

### What a local run does not prove

1. That native binaries build/load on macOS arm64 — often a separate build.
2. That path behaviour matches on all three operating systems at the same time.
3. That `npm ci` with install-script blocking behaves identically.

Conclusion: "works on all operating systems" is a claim about a **CI run**, not about a local check. Locally you check one platform.
