# TypeScript Baseline Lib Generator

Generates `baseline.d.ts`, a TypeScript lib for TypeScript-declarable JavaScript features that are [Baseline widely available](https://web.dev/baseline). It currently classifies `javascript.builtins.*` and the `arguments` object from `web-features`.

## Best-practice setup

Stock TypeScript doesn't treat `"baseline"` as a built-in `lib` yet. Install the current supported TypeScript major with this package:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Use the package as the complete global lib:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["typescript-baseline-lib"]
  }
}
```

```sh
npx tsc --noEmit
```

Now only the supported Baseline widely available JavaScript surfaces type-check. APIs that haven't reached Baseline yet (`Promise.withResolvers`, `Array.fromAsync` until it promotes, and so on) are reported as errors. The end goal is first-class `--lib baseline` support upstream in TypeScript.

This package replaces TypeScript's default libs; do not set `compilerOptions.lib` or combine it with the standard `es*` libs. Add other ambient type packages to `types` only when the project needs them. Those packages can require APIs that are intentionally outside the selected Baseline target. The generator preserves audited erased compiler-support declarations, but it does not add unavailable runtime APIs merely to satisfy a third-party package.

## Allow a polyfilled feature

When the runtime loads an audited polyfill, add its generated web-features entry after the base package. For example, core-js can provide `Promise.withResolvers` at runtime:

```ts
import "core-js/proposals/promise-with-resolvers";
```

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": [
      "typescript-baseline-lib",
      "typescript-baseline-lib/allow/promise-withresolvers"
    ]
  }
}
```

Only entries approved in `registry/allowlist.json` are public. The registry is a permanent path contract: after every registered compat key becomes Baseline widely available, the same entry remains as an alias to the base package. Limited availability features with `baselineStatus: false` are rejected.

## Target a Baseline year

Baseline year targets contain the cumulative JavaScript features that were Baseline newly available by the end of a completed calendar year. For example, Baseline 2024 includes `Promise.withResolvers`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["typescript-baseline-lib/year/2024"]
  }
}
```

Year entrypoints are generated from each compat row's `baselineLowDate`. They are independent alternatives to the widely available base entrypoint, not additions to it. The current year is omitted until it is complete. The package currently starts at 2020 because the generator cannot yet close the 2015-2019 TypeScript declaration graph without importing symbols from later years; this is an implementation limitation, not a Baseline specification boundary.

Do not combine a `year/*` entrypoint with the base package or an `allow/*` entrypoint. Each year file is a complete historical target, while `allow/*` additions are generated only for the current widely available base.

Each year contract reports declaration-backed compat keys and explicitly managed upstream gaps in `derived/current/generation.json`. The generator never fabricates declarations for behavior that TypeScript cannot model.

Year boundaries apply to runtime JavaScript APIs. Erased TypeScript helper types come from the pinned TypeScript toolchain and are not historical runtime features.

## Current contract

- Public targets are Baseline widely available, completed cumulative Baseline years from 2020 onward, and audited `allow/*` additions for explicitly polyfilled APIs.
- Scope is TypeScript-declarable JavaScript surfaces: `javascript.builtins.*` plus the `arguments` object.
- DOM, Web Worker, syntax, grammar, statements, and operators are out of scope.
- Special compat rows are managed in `registry/compat-management.json` with a source URL for each.
- The checked-in dataset, derived, and generated artifacts are overwritten with the rolling latest; history lives in Git.
