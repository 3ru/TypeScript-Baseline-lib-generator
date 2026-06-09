# TypeScript Baseline Lib Generator

Generates `baseline.d.ts`, a TypeScript lib that contains only the JavaScript built-ins that are [Baseline widely available](https://web.dev/baseline). It classifies the `javascript.builtins.*` compat rows from `web-features` and emits the declarations whose `baselineStatus` is `"high"`.

## Using the lib

Stock TypeScript doesn't treat `"baseline"` as a built-in `lib` yet, so install the package and list it under `compilerOptions.types`:

```sh
npm install --save-dev typescript-baseline-lib
```

```json
{
  "compilerOptions": {
    "noLib": true,
    "skipLibCheck": true,
    "types": ["typescript-baseline-lib"]
  }
}
```

Now only Baseline widely available built-ins type-check. APIs that haven't reached Baseline yet (`Promise.withResolvers`, `Array.fromAsync` until it promotes, and so on) are reported as errors. The end goal is first-class `--lib baseline` support upstream in TypeScript.

## Current contract

- Target is `baseline` only.
- Scope is `javascript.builtins.*` only.
- DOM, Web Worker, syntax, grammar, statements, and operators are out of scope.
- Special compat rows are managed in `registry/compat-management.json` with a source URL for each.
- The checked-in dataset, derived, and generated artifacts are overwritten with the rolling latest; history lives in Git.