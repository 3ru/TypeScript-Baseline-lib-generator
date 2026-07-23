# TypeScript Baseline Lib Generator

This project generates `baseline.d.ts`. This TypeScript lib contains declarations for JavaScript features that are [Baseline Widely available](https://web.dev/baseline).

The generator currently classifies `javascript.builtins.*` and the `arguments` object from `web-features`.

## Best-practice setup

TypeScript does not yet include `"baseline"` as a built-in `lib`. Install this package and the supported TypeScript major:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Configure the package as the complete global lib:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["typescript-baseline-lib"]
  }
}
```

Run the compiler:

```sh
npx tsc --noEmit
```

With this configuration, TypeScript accepts supported JavaScript APIs that are Baseline Widely available. TypeScript reports APIs outside this target as errors.

Examples include `Promise.withResolvers` and `Array.fromAsync` before they reach this Baseline status. The project goal is first-class `--lib baseline` support in TypeScript.

For more configurations, read the [Usage Guide](docs/USAGE.md).

This package replaces the default TypeScript libs. Do not set `compilerOptions.lib`. Do not combine this package with standard `es*` libs.

If your project needs other ambient type packages, add them to `types`. Some packages require runtime APIs outside the selected Baseline target.

The generator preserves audited declarations that support TypeScript. These declarations do not represent runtime APIs.

The generator does not add unavailable runtime APIs to support third-party packages.

## Allow a polyfilled feature

If the runtime loads an audited polyfill, add its generated `web-features` entry after the base package. For example, core-js can provide `Promise.withResolvers`:

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

Only entries in `registry/allowlist.json` are public. The registry defines permanent public paths.

Published entry paths remain valid. After all registered compat keys become Baseline Widely available, the entry refers to the base package.

The generator rejects features with `baselineStatus: false`.

## Target a Baseline year

Baseline year targets contain all JavaScript features that became Baseline Newly available by the end of a completed calendar year. For example, Baseline 2024 includes `Promise.withResolvers`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["typescript-baseline-lib/year/2024"]
  }
}
```

The generator creates year entry points from the `baselineLowDate` of each compat row. Each entry is a complete alternative to the rolling base.

The generator omits the current year until that year is complete. The first generated year is 2020.

The generator cannot close the TypeScript declaration graphs for 2015 through 2019. Those graphs require symbols from later years.

This limit belongs to the implementation, not the Baseline specification.

Do not combine a `year/*` entry point with the base package or an `allow/*` entry point. Each year file is a complete historical target.

An `allow/*` entry applies only to the current rolling base. The generation report lists declaration-backed compat keys and managed upstream gaps.

The report is in `derived/current/generation.json`. The generator does not create declarations for behavior that TypeScript cannot model.

Year boundaries apply to runtime JavaScript APIs. The pinned TypeScript toolchain supplies helper declarations.

These helper declarations are not historical runtime features.

## Current contract

- The public targets include the rolling base, completed cumulative years from 2020, and audited `allow/*` additions.
- The scope includes `javascript.builtins.*` and the `arguments` object.
- DOM, Web Worker, syntax, grammar, statements, and operators are outside the scope.
- `registry/compat-management.json` manages special compat rows and records a source URL for each row.
- The repository stores one rolling dataset and one set of derived artifacts. Git stores the history.
