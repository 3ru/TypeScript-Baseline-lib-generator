# Usage Guide

Use `typescript-baseline-lib` to check JavaScript built-in APIs against your Baseline policy in the editor or CI. The examples below work with TypeScript 6 and 7; the install commands use TypeScript 7 unless noted.

## Before you choose a configuration

Choose one complete target: the rolling root package or one `year/*` entry. Set `noLib` to `true` so TypeScript uses that target instead of its standard libraries. Do not combine it with `lib` or standard `es*` declarations, and keep `skipLibCheck` disabled so declaration conflicts remain visible. If you extend another configuration, use the [separate CI gate](#i-want-a-separate-ci-gate) example to clear an inherited `lib` setting.

These declarations control which built-in APIs TypeScript knows about. The compiler's `target` option controls emitted JavaScript syntax; it does not make runtime APIs available. This package does not transform syntax, load polyfills, or filter DOM APIs.

## I want the current Baseline Widely available target

Install TypeScript and the generated lib:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Configure the package as the complete global JavaScript lib:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["typescript-baseline-lib"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

Run the compiler:

```sh
npx tsc -p tsconfig.json
```

Each package release contains a Baseline snapshot, so updating the package can change the APIs accepted by the rolling target. Use a year target for a fixed availability cutoff, and pin the package version and keep your lockfile for reproducible checks.

## I want a browser application with DOM types

Install the independent DOM declarations:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib @types/web
```

Configure both type packages:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["typescript-baseline-lib", "web"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

`@types/web` supplies `document`, `Window`, and other browser declarations. Those declarations are not filtered by this package: the Baseline check still applies only to the generated JavaScript built-ins. Keep your existing JSX settings if the project uses `.tsx` files.

## I want a separate CI gate

Keep the normal `tsconfig.json`. Create `tsconfig.baseline.json` for the Baseline gate:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": null,
    "noLib": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": ["typescript-baseline-lib"]
  },
  "include": ["src/**/*.ts"]
}
```

Add a package script:

```json
{
  "scripts": {
    "check:baseline": "tsc -p tsconfig.baseline.json"
  }
}
```

Run the gate:

```sh
npm run check:baseline
```

The child configuration replaces the inherited `types` and clears `lib` with `null`. Without that override, an inherited `lib` conflicts with `noLib` and TypeScript reports TS5053. Setting `skipLibCheck` to `false` also keeps declaration checking enabled when the parent configuration disables it. For browser source, install `@types/web` and use `"types": ["typescript-baseline-lib", "web"]`.

## I want a shared package for browsers and Node.js

Apply the Baseline gate only to platform-neutral source:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": null,
    "noLib": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": ["typescript-baseline-lib"]
  },
  "include": ["src/shared/**/*.ts"]
}
```

Keep browser and Node.js globals out of this shared-source check, and use separate configurations for platform-specific entry points. Node declarations can require APIs outside the selected Baseline target, such as `Disposable` and `Float16Array`. Baseline describes browser availability; it does not certify support in a particular Node.js version.

## I want a fixed Baseline year

Use one complete cumulative year entry to check APIs that became Baseline Newly available by the end of that year:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": ["typescript-baseline-lib/year/2024"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

The package supplies completed year targets from 2020. Each year entry replaces the rolling target, so do not combine it with the root package or an `allow/*` entry. The cutoff stays fixed, but later package releases can correct compatibility data or declarations; pin the package version when the exact output must stay unchanged.

## I polyfill one API outside the rolling target

Install the runtime polyfill as a production dependency:

```sh
npm install core-js
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Load the polyfill from the application entry point:

```ts
import "core-js/proposals/promise-try";

const result = Promise.try(() => 42);
```

Then add the matching declaration entry:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": [
      "typescript-baseline-lib",
      "typescript-baseline-lib/allow/promise-try"
    ],
    "noEmit": true
  }
}
```

An `allow/*` entry adds types to the rolling target; it does not install or load a polyfill. Your application must provide the API at runtime. Choose an entry from the [public allowlist](../registry/allowlist.json); those paths stay valid when an API later joins the rolling target.

## I want Vite to use the same policy

Current Vite releases use Baseline Widely available as the default production target. Set the target explicitly to show the policy:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "baseline-widely-available",
  },
});
```

Combine this setting with the browser TypeScript configuration. Vite's build target handles syntax; it does not add polyfills for calls such as `Promise.try`. Vite freezes its Baseline browser snapshot for each major release, while this package updates its root entry in separate releases. The policy names align, but the snapshots may differ.

## I want a Baseline policy in Browserslist

For a rolling target, add `.browserslistrc`:

```text
baseline widely available
```

Use it with `"types": ["typescript-baseline-lib"]`.

For a fixed year, use:

```text
baseline 2024
```

Use it with `"types": ["typescript-baseline-lib/year/2024"]`.

Browserslist selects browsers for compatible build and CSS tools, while this package selects JavaScript built-in declarations. Their data is updated separately, so a matching policy name does not guarantee an identical snapshot.

## I must use TypeScript 6

Install the supported TypeScript 6 compiler:

```sh
npm install --save-dev typescript@^6 typescript-baseline-lib
```

Use the same `noLib` and `types` values from the other configurations. This configuration supports tools that still require the TypeScript 6 programmatic API.

## I want ESLint to enforce the same Baseline

Use [`eslint-plugin-baseline-js`](https://github.com/3ru/eslint-plugin-baseline-js) for additional checks on syntax and Web APIs. It complements the built-in API checks provided by this package:

```sh
npm install --save-dev eslint eslint-plugin-baseline-js
```

Add the plugin to your ESLint flat configuration. This minimal example works for JavaScript; TypeScript files also need your usual TypeScript parser and file patterns. Keep that setup when adding these entries.

```js
// eslint.config.mjs
import baselineJs from "eslint-plugin-baseline-js";

export default [
  { plugins: { "baseline-js": baselineJs } },
  baselineJs.configs.recommended({
    available: "widely",
    level: "error",
  }),
];
```

For a matching year policy, set `available: 2024` and use `typescript-baseline-lib/year/2024`. The plugin and this package have separate data releases and coverage, so they may not report exactly the same features.

## I want to inspect the loaded TypeScript files

Run:

```sh
npx tsc -p tsconfig.baseline.json --explainFiles
```

The output should include `typescript-baseline-lib` and exclude standard TypeScript `lib.es*.d.ts` files. If a missing-API error suggests adding an `es*` library, that would broaden the declarations beyond your selected target. Choose an API within the target or provide a suitable polyfill and allow entry instead.

## References

- [TypeScript `noLib`](https://www.typescriptlang.org/tsconfig/noLib.html)
- [TypeScript `types`](https://www.typescriptlang.org/tsconfig/types)
- [TypeScript DOM declarations (`@types/web`)](https://github.com/microsoft/TypeScript-DOM-lib-generator)
- [TypeScript 7.0 and the TypeScript 6 transition](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Vite build targets](https://vite.dev/config/build-options.html#build-target)
- [Browserslist Baseline queries](https://github.com/browserslist/browserslist#queries)
- [Choosing a Baseline target](https://web.dev/articles/how-to-choose-your-baseline-target)
- [Baseline and polyfills](https://web.dev/articles/baseline-and-polyfills)
- [`Promise.try` in core-js](https://github.com/zloirock/core-js/blob/master/packages/core-js/proposals/promise-try.js)
