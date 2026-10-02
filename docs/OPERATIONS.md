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

`typescript-strada` parses declarations and performs compiler self-tests. It is an npm alias for the frozen TypeScript 6 release because the native TypeScript package does not expose the same JavaScript compiler API.

## Determinism and fail-closed layers

Identical inputs produce byte-identical artifacts on each supported operating system. Each layer stops before it can emit an incorrect declaration file.

- The dataset layer rejects snapshot-name mismatches, duplicate compat keys, and unknown `web-features` statuses.
- The lib-source layer requires the pinned content hash and file count.
- The classification layer rejects unmanaged keys, stale registry entries, and resolution-kind changes. A strict JSON Schema validates the registry.
- The generation layer rejects excluded declarations in the output. It also compiles the complete output as a self-test.
- The packaging layer installs staged and packed packages. It compiles consumer fixtures with TypeScript 7 and TypeScript 6.

## Toolchain pins

`npm run update:typescript-toolchain` refreshes these two pins in `manifests/baseline-js.json`:

- `libSource` records the platform package and one content hash. The update requires identical files on Linux, macOS, and Windows.
- `typescriptSource` records the exact `microsoft/TypeScript` `main` commit used by proposal preparation and integration tests. Proposal artifacts are generated from that checkout's declaration corpus.

## Failed updates

Weekly data and TypeScript toolchain updates save an `update-diagnostics` workflow artifact, including command logs, `summary.md`, and `summary.json`. The job summary shows the failed step, candidate input pins, and added, removed, or changed compat keys. Reports use the input dataset even if generation fails; existing derived files are not evidence that the candidate passed.

For registry drift, inspect each named compat key and its upstream declaration before changing `registry/compat-management.json`. Keep missing declarations separate from newly implemented declarations. Do not relax the checks just to make an update pass.

For a TypeScript layout change, update the integration adapter and its fixtures. Keep proposal generation pinned to the recorded commit. Run `npm run validate`, then run `npm run test:typescript:gate` against that commit before retrying the toolchain workflow.

Failed update jobs do not create pull requests. Repair the cause and rerun the workflow. Diagnostic collection does not change the release gates or publish a package.
