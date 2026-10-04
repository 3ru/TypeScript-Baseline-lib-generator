# {{PACKAGE_NAME}}

Catch JavaScript API calls that are too new for your Baseline target. This package gives your editor and TypeScript compiler a set of built-in types selected by [Baseline](https://web.dev/baseline) browser support data.

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
npm install --save-dev typescript@^7 {{PACKAGE_NAME}}
```

For JavaScript built-ins without browser or Node.js globals, start with this `tsconfig.json`:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "noEmit": true,
    "types": ["{{PACKAGE_NAME}}"]
  }
}
```

Run the check:

```sh
npx tsc
```

This package replaces TypeScript's standard JavaScript libs. Do not combine it with `lib` or standard `es*` declarations. For browser globals, an existing tsconfig, or a separate CI check, follow the [Usage Guide](https://github.com/3ru/TypeScript-Baseline-lib-generator/blob/main/docs/USAGE.md).

## Choose a target

| Target | Use it when |
| --- | --- |
| `{{PACKAGE_NAME}}` | You want the Widely available snapshot in the installed package. |
| `{{PACKAGE_NAME}}/year/2024` | You want APIs that became Newly available by the end of 2024. |
| `{{PACKAGE_NAME}}/allow/promise-try` | You load a suitable polyfill and need its types alongside the root target. |

Year targets are complete alternatives to the root target. Choose one completed year from 2020 onward; do not combine it with the root or an `allow/*` entry. A year fixes the cutoff, while the installed package fixes the declaration snapshot. Pin the package version and commit your lockfile for repeatable checks.

An `allow/*` entry adds types only. Load the matching polyfill before using the API. The [allowlist](https://github.com/3ru/TypeScript-Baseline-lib-generator/blob/main/registry/allowlist.json) defines the public entries, and their paths remain valid after an API becomes Widely available. See the [polyfill example](https://github.com/3ru/TypeScript-Baseline-lib-generator/blob/main/docs/USAGE.md#i-polyfill-one-api-outside-the-rolling-target) for setup.

## Scope

The package covers JavaScript built-ins and the `arguments` object. It does not filter DOM or Worker APIs, check syntax support, or prove that code will run in every browser. Additional ambient declarations can expose APIs outside the selected target.

The generator can only select APIs modeled by TypeScript declarations. The package's `reports/generation.json` records declaration coverage and known gaps. Helper types needed by TypeScript are kept separately from runtime API availability.

For syntax and Web API checks, use [eslint-plugin-baseline-js](https://github.com/3ru/eslint-plugin-baseline-js) alongside this package.

## Snapshot

- Supported TypeScript versions: `{{TYPESCRIPT_PEER_DEPENDENCY_RANGE}}`
- Baseline date: `{{BASELINE_DATE}}`
- TypeScript declarations: `{{TYPESCRIPT_VERSION}}`
- web-features package: `{{WEB_FEATURES_VERSION}}`
- Included compat rows: `{{INCLUDED_COMPAT_COUNT}}`

Snapshot data and the web-features source revision are also available in `{{PACKAGE_NAME}}/snapshot.json`. TypeScript is an optional peer dependency.

The [generator repository](https://github.com/3ru/TypeScript-Baseline-lib-generator) contains the source and contribution guide. Declarations come from TypeScript, and the package preserves Microsoft's license notice.
