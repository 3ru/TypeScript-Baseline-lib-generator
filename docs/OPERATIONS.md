# Operations

How this repository is meant to run day to day. The design follows microsoft/TypeScript-DOM-lib-generator: the generator repo is the canonical source, generated artifacts are checked in and reviewed as diffs, upstream data lands through bot PRs, and distribution is staged separately from generation.

## Canonical inputs

The generator reads four inputs and nothing else:

1. The `lib/*.d.ts` files shipped by the installed `typescript` package (TypeScript 7 / tsgo). They live in a platform package (`@typescript/typescript-<os>-<arch>`), so the generator verifies their content hash against `libSource.libContentHash` in the manifest before reading them.
2. `data.json` from the installed `web-features` package.
3. `registry/compat-management.json`: the ledger of special-cased compat rows.
4. `manifests/baseline-js.json`: the pinned toolchain and dataset snapshot.

Parsing and self-checks run through `typescript-strada` (an npm alias for `typescript@6.x`, the frozen Strada line), because the TypeScript 7 JS API is different and the generator relies on the Strada compiler API.

## Determinism and fail-closed layers

Regeneration is deterministic: the same inputs produce byte-identical artifacts on any OS. Every layer fails closed rather than emitting a wrong `.d.ts`:

- Dataset: snapshot-name mismatch, duplicate compat keys, and unknown `web-features` statuses throw.
- Lib source: the installed platform lib package must match the pinned content hash and file count.
- Classification: unmanaged special keys, stale registry entries, and resolution-kind drift all throw. The compat-management registry is validated against a strict JSON Schema.
- Generation: excluded rows may not appear in the emitted lib (an invariant check), and the whole file is compiled once as a self-check.
- Packaging: consumer smokes install the staged and packed package and compile it under both TypeScript 7 and Strada.

## Toolchain pins

`manifests/baseline-js.json` carries three pins, all refreshed by `update:typescript-toolchain`:

- `libSource`: the platform lib package and a content hash verified identical across `linux-x64`, `darwin-arm64`, and `win32-x64`.
- `typescriptSource`: the frozen Strada tag and commit used by the Strada integration gate.
- `typescriptGoSource`: the typescript-go release tag (`typescript/vX.Y.Z`) and its `_submodules/TypeScript` commit.
