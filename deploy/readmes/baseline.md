# {{PACKAGE_NAME}}

This package contains generated `baseline` declarations for TypeScript.

The [`TypeScript-Baseline-lib-generator`](https://github.com/3ru/TypeScript-Baseline-lib-generator) repository produces this package. It combines TypeScript declarations for JavaScript features that are [Baseline Widely available](https://web.dev/baseline).

Current snapshot:

- Supported TypeScript versions: `{{TYPESCRIPT_PEER_DEPENDENCY_RANGE}}`
- Baseline date: `{{BASELINE_DATE}}`
- TypeScript package: `{{TYPESCRIPT_VERSION}}`
- web-features package: `{{WEB_FEATURES_VERSION}}`
- web-features gitHead: `{{WEB_FEATURES_GIT_HEAD}}`
- Included compat rows: `{{INCLUDED_COMPAT_COUNT}}`
- Selected declaration units: `{{SELECTED_UNIT_COUNT}}`
- Transformed units: `{{TRANSFORMED_UNIT_COUNT}}`

## Best-practice setup

TypeScript does not yet include `"baseline"` as a built-in `lib`. Install this package and the supported TypeScript major:

```sh
npm install --save-dev typescript@^7 {{PACKAGE_NAME}}
```

This package also supports TypeScript 6 within `{{TYPESCRIPT_PEER_DEPENDENCY_RANGE}}`. TypeScript is an optional peer dependency.

Tools can read the same snapshot facts from `{{PACKAGE_NAME}}/snapshot.json`.

Configure the package as the complete global lib:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["{{PACKAGE_NAME}}"]
  }
}
```

Run the compiler:

```sh
npx tsc --noEmit
```

With this configuration, TypeScript accepts supported JavaScript APIs that are Baseline Widely available. TypeScript reports APIs outside this target as errors.

This package replaces the default TypeScript libs. Do not set `compilerOptions.lib`. Do not combine this package with standard `es*` libs.

If your project needs other ambient type packages, add them to `types`. Some packages require runtime APIs outside the selected Baseline target.

The package preserves declarations that support TypeScript. These declarations do not represent runtime APIs.

The package does not expose unavailable runtime APIs to support third-party packages.

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
      "{{PACKAGE_NAME}}",
      "{{PACKAGE_NAME}}/allow/promise-withresolvers"
    ]
  }
}
```

Only audited entries are public. Published entry paths remain valid.

After all compat keys become Baseline Widely available, the entry refers to the base package.

The generator rejects features with `baselineStatus: false`.

## Target a Baseline year

Baseline year targets contain all JavaScript features that became Baseline Newly available by the end of a completed calendar year. For example, Baseline 2024 includes `Promise.withResolvers`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["{{PACKAGE_NAME}}/year/2024"]
  }
}
```

The generator creates year entry points from the `baselineLowDate` of each compat row. Each entry is a complete alternative to the rolling base.

The generator omits the current year until that year is complete. Targets before 2020 are not available because their declaration graphs require later symbols.

Do not combine a `year/*` entry point with the base package or an `allow/*` entry point. Each year file is a complete historical target.

An `allow/*` entry applies only to the current rolling base. `reports/generation.json` lists declaration-backed compat keys and managed upstream gaps.

The generator does not create declarations for behavior that TypeScript cannot model.

Year boundaries apply to runtime JavaScript APIs. The pinned TypeScript toolchain supplies helper declarations.

These helper declarations are not historical runtime features.

## Notes

- The base public surface is one `baseline` lib.
- Audited `allow/*` entry points add declarations for explicitly polyfilled APIs.
- Completed cumulative year entry points are complete alternatives to the base lib.
- The current scope includes `javascript.builtins.*` and the `arguments` object.
- The npm `typescript` package supplies the declarations. The package preserves the Microsoft license notice.
