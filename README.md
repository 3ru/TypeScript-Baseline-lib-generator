# TypeScript Baseline Lib Generator

Catch JavaScript API calls that are too new for your Baseline target. `typescript-baseline-lib` gives your editor and TypeScript compiler a set of built-in types selected by [Baseline](https://web.dev/baseline) browser support data.

TypeScript's `ESNext` lib can accept APIs that your supported browsers cannot run. This package selects declarations from TypeScript using per-API data from `web-features`. By default, it includes Baseline Widely available APIs: those supported across the Baseline core browsers for at least 30 months.

In the October 2026 snapshot, TypeScript accepts `.at()` but reports an error for `Promise.try()`:

```ts
["a", "b"].at(-1);
Promise.try(() => 42);
```

Use it to check browser code or shared JavaScript modules before shipping. It checks API types; it does not transform syntax or load polyfills.

## Get started

The package supports TypeScript 6 and 7. Install it with TypeScript:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib
```

For JavaScript built-ins without browser or Node.js globals, start with this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "noEmit": true,
    "types": ["typescript-baseline-lib"]
  }
}
```

Run the check:

```sh
npx tsc
```

This package replaces TypeScript's standard JavaScript libs. Do not combine it with `lib` or standard `es*` declarations. For browser globals, an existing tsconfig, or a separate CI check, follow the [Usage Guide](docs/USAGE.md).

## Choose a target

| Target | Use it when |
| --- | --- |
| `typescript-baseline-lib` | You want the Widely available snapshot in the installed package. |
| `typescript-baseline-lib/year/2024` | You want APIs that became Newly available by the end of 2024. |
| `typescript-baseline-lib/allow/promise-try` | You load a suitable polyfill and need its types alongside the root target. |

Year targets are complete alternatives to the root target. Choose one completed year from 2020 onward; do not combine it with the root or an `allow/*` entry. A year fixes the cutoff, while the installed package fixes the declaration snapshot. Pin the package version and commit your lockfile for repeatable checks.

An `allow/*` entry adds types only. Load the matching polyfill before using the API. The [allowlist](registry/allowlist.json) defines the public entries, and their paths remain valid after an API becomes Widely available. See the [polyfill example](docs/USAGE.md#i-polyfill-one-api-outside-the-rolling-target) for setup.

## Scope

The package covers JavaScript built-ins and the `arguments` object. It does not filter DOM or Worker APIs, check syntax support, or prove that code will run in every browser. Additional ambient declarations can expose APIs outside the selected target.

The generator can only select APIs modeled by TypeScript declarations. Its [generation report](derived/current/generation.json) records declaration coverage and known gaps. Helper types needed by TypeScript are kept separately from runtime API availability.

For syntax and Web API checks, use [eslint-plugin-baseline-js](https://github.com/3ru/eslint-plugin-baseline-js) alongside this package.

## Work on the generator

This repository generates the npm package from pinned TypeScript and `web-features` inputs. The same inputs produce the same declarations, and the tests check both supported TypeScript majors and integration with the pinned upstream compiler.

The long-term goal is native `--lib baseline` support in TypeScript. For the current package, use the configuration above. See [Contributing](CONTRIBUTING.md) to run the generator and tests, or [Operations](docs/OPERATIONS.md) to update its inputs.
