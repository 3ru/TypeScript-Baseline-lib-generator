# TypeScript Baseline Lib Generator

Generates `baseline.d.ts`, a TypeScript lib for TypeScript-declarable JavaScript features that are [Baseline widely available](https://web.dev/baseline). It currently classifies `javascript.builtins.*` and the `arguments` object from `web-features`.

## Using the lib

Stock TypeScript doesn't treat `"baseline"` as a built-in `lib` yet, so install the package and list it under `compilerOptions.types`:

```sh
npm install --save-dev typescript-baseline-lib
```

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["typescript-baseline-lib"]
  }
}
```

Now only the supported Baseline widely available JavaScript surfaces type-check. APIs that haven't reached Baseline yet (`Promise.withResolvers`, `Array.fromAsync` until it promotes, and so on) are reported as errors. The end goal is first-class `--lib baseline` support upstream in TypeScript.

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

## Current contract

- Target is `baseline` only.
- Scope is TypeScript-declarable JavaScript surfaces: `javascript.builtins.*` plus the `arguments` object.
- DOM, Web Worker, syntax, grammar, statements, and operators are out of scope.
- Special compat rows are managed in `registry/compat-management.json` with a source URL for each.
- The checked-in dataset, derived, and generated artifacts are overwritten with the rolling latest; history lives in Git.
