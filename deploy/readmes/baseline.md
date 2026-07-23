# {{PACKAGE_NAME}}

Generated `baseline` declarations for TypeScript.

This package is produced by the [`TypeScript-Baseline-lib-generator`](https://github.com/3ru/TypeScript-Baseline-lib-generator) repo. It packages TypeScript-declarable JavaScript features that are [Baseline widely available](https://web.dev/baseline) as a single global declaration bundle.

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

Stock TypeScript doesn't treat `"baseline"` as a built-in `lib` yet. Install the current supported TypeScript major with this package:

```sh
npm install --save-dev typescript@^7 {{PACKAGE_NAME}}
```

The package also supports existing TypeScript 6.x projects within `{{TYPESCRIPT_PEER_DEPENDENCY_RANGE}}`. TypeScript remains an optional peer dependency.

The same snapshot facts are available to tools through `{{PACKAGE_NAME}}/snapshot.json`.

Use the package as the complete global lib:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["{{PACKAGE_NAME}}"]
  }
}
```

```sh
npx tsc --noEmit
```

Now only the supported Baseline widely available JavaScript surfaces type-check; APIs that haven't reached Baseline yet are reported as errors.

This package replaces TypeScript's default libs; do not set `compilerOptions.lib` or combine it with the standard `es*` libs. Add other ambient type packages to `types` only when the project needs them. Those packages can require runtime APIs outside the selected Baseline target. The package preserves erased declarations needed by TypeScript, but it does not expose unavailable APIs merely to satisfy a third-party package.

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
      "{{PACKAGE_NAME}}",
      "{{PACKAGE_NAME}}/allow/promise-withresolvers"
    ]
  }
}
```

Only explicitly audited entries are public. Published entry paths remain valid after all of their compat keys become Baseline widely available and move into the base package. Limited availability features with `baselineStatus: false` are rejected.

## Target a Baseline year

Baseline year targets contain the cumulative JavaScript features that were Baseline newly available by the end of a completed calendar year. For example, Baseline 2024 includes `Promise.withResolvers`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["{{PACKAGE_NAME}}/year/2024"]
  }
}
```

Year entrypoints are generated from each compat row's `baselineLowDate`. They are independent alternatives to the widely available base entrypoint, not additions to it. The current year is omitted until it is complete. Targets before 2020 remain an implementation limitation because their TypeScript declaration graph currently pulls symbols from later years.

Do not combine a `year/*` entrypoint with the base package or an `allow/*` entrypoint. Each year file is a complete historical target, while `allow/*` additions are generated only for the current widely available base.

Each year contract reports declaration-backed compat keys and explicitly managed upstream gaps in `reports/generation.json`. The generator never fabricates declarations for behavior that TypeScript cannot model.

Year boundaries apply to runtime JavaScript APIs. Erased TypeScript helper types come from the pinned TypeScript toolchain and are not historical runtime features.

## Notes

- The base public surface is a single `baseline` lib.
- Audited `allow/*` entrypoints are optional additions for explicitly polyfilled APIs.
- Completed cumulative Baseline year entrypoints are independent alternatives to the base lib.
- The current scope is `javascript.builtins.*` plus the `arguments` object.
- The generated declarations are derived from the npm `typescript` package and preserve the upstream Microsoft license notice.
