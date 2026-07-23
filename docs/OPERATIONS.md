# Operations

This document explains the daily operation of the repository. The design follows `microsoft/TypeScript-DOM-lib-generator`.

The generator repository is the canonical source. Git stores generated artifacts so that reviewers can examine each change.

Bot pull requests import upstream data. Release jobs stage distribution separately from generation.

## Canonical inputs

The generator reads only these four inputs:

1. The installed `typescript` package supplies the `lib/*.d.ts` files. TypeScript 7 stores these files in `@typescript/typescript-<os>-<arch>`.
2. The installed `web-features` package supplies `data.json`.
3. `registry/compat-management.json` supplies the ledger for special compat rows.
4. `manifests/baseline-js.json` supplies the pinned toolchain and dataset snapshot.

Before the generator reads the lib files, it compares their file count and content hash with `libSource` in the manifest.

`typescript-strada` parses declarations and performs compiler self-tests. It is an npm alias for the frozen TypeScript 6 Strada release.

The generator uses this package because the TypeScript 7 JavaScript API differs from the Strada compiler API.

## Determinism and fail-closed layers

Identical inputs produce byte-identical artifacts on each supported operating system. Each layer stops before it can emit an incorrect declaration file.

- The dataset layer rejects snapshot-name mismatches, duplicate compat keys, and unknown `web-features` statuses.
- The lib-source layer requires the pinned content hash and file count.
- The classification layer rejects unmanaged keys, stale registry entries, and resolution-kind changes. A strict JSON Schema validates the registry.
- The generation layer rejects excluded declarations in the output. It also compiles the complete output as a self-test.
- The packaging layer installs staged and packed packages. It compiles consumer fixtures with TypeScript 7 and Strada.

## Toolchain pins

`npm run update:typescript-toolchain` refreshes these three pins in `manifests/baseline-js.json`:

- `libSource` records the platform package and one content hash. The update requires identical files on Linux, macOS, and Windows.
- `typescriptSource` records the frozen Strada tag and commit for the Strada integration gate.
- `typescriptGoSource` records the `typescript/vX.Y.Z` tag and the `_submodules/TypeScript` commit.
