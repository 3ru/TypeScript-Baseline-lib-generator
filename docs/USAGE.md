# Usage Guide

Copy these configurations for common `typescript-baseline-lib` use cases.

Use TypeScript 7 for new projects. This package also supports TypeScript 6 for tools that require its programmatic API.

## Before you choose a configuration

- Set `noLib` to `true`. TypeScript then ignores `lib`.
- Choose one complete target. Use the rolling root package or one `year/*` entry.
- If the runtime loads the matching polyfill, add an `allow/*` entry to the rolling root package.
- Do not enable `skipLibCheck`. This option hides declaration conflicts and weakens the compatibility gate.
- This package filters JavaScript built-in declarations by Baseline status. It does not transform syntax, install polyfills, or filter DOM APIs.

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

Each package release contains one rolling snapshot. If your compatibility contract must remain fixed, select a year target.

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

`@types/web` supplies `document`, `Window`, and other browser declarations. This package does not filter those DOM declarations.

The Baseline gate applies only to the generated JavaScript built-ins.

## I want a separate CI gate

Keep the normal `tsconfig.json`. Create `tsconfig.baseline.json` for the Baseline gate:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noLib": true,
    "noEmit": true,
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

The child configuration replaces the inherited ambient `types`. The `noLib` option disables each inherited standard `lib`.

For browser source, install `@types/web`. Then use `"types": ["typescript-baseline-lib", "web"]`.

## I want a shared package for browsers and Node.js

Apply the Baseline gate only to platform-neutral source:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noLib": true,
    "noEmit": true,
    "types": ["typescript-baseline-lib"]
  },
  "include": ["src/shared/**/*.ts"]
}
```

Do not add `dom`, `web`, or `node` globals to this shared-source gate. Use separate build configurations for browser and Node.js entry points.

Do not add `@types/node` to this shared-source gate. Node declarations can require runtime surfaces before they reach the selected target.

Examples include `Disposable` and `Float16Array`.

## I want a fixed Baseline year

Use one complete cumulative year entry:

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

Do not combine a `year/*` entry with the root package or an `allow/*` entry. The package supplies completed year targets from 2020.

## I polyfill one API outside the rolling target

Install the runtime polyfill as a production dependency:

```sh
npm install core-js
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Load the polyfill from the application entry point:

```ts
import "core-js/proposals/promise-with-resolvers";

const deferred = Promise.withResolvers<void>();
```

Then add its audited declaration entry:

```json
{
  "compilerOptions": {
    "noLib": true,
    "strict": true,
    "types": [
      "typescript-baseline-lib",
      "typescript-baseline-lib/allow/promise-withresolvers"
    ],
    "noEmit": true
  }
}
```

An `allow/*` entry changes type availability only. It does not install or load a runtime polyfill.

The permanent allowlist in the repository defines the public entries.

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

Combine this setting with the browser TypeScript configuration. Vite transforms syntax, but it does not usually polyfill JavaScript APIs.

Vite freezes its Baseline browser snapshot for each major release. This package updates its root entry through separate dataset and package releases.

## I want Browserslist and TypeScript to use the same target

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

Browserslist supplies target data to compatible build and CSS tools. The TypeScript package separately limits the JavaScript built-in declaration surface.

## I must use TypeScript 6

Install the supported TypeScript 6 compiler:

```sh
npm install --save-dev typescript@^6 typescript-baseline-lib
```

Use the same `noLib` and `types` values from the other configurations. This configuration supports tools that still require the TypeScript 6 programmatic API.

## I want ESLint to enforce the same Baseline

Install [`eslint-plugin-baseline-js`](https://github.com/3ru/eslint-plugin-baseline-js). This plugin covers syntax and Web APIs that a TypeScript lib cannot model.

```sh
npm install --save-dev eslint eslint-plugin-baseline-js
```

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

For the same fixed year, set `available: 2024` and use `typescript-baseline-lib/year/2024`.

## I want to inspect the loaded TypeScript files

Run:

```sh
npx tsc -p tsconfig.baseline.json --explainFiles
```

The output must include `typescript-baseline-lib`. It must not include standard TypeScript `lib.es*.d.ts` files.

## References

- [TypeScript `noLib`](https://www.typescriptlang.org/tsconfig/noLib.html)
- [TypeScript `types`](https://www.typescriptlang.org/tsconfig/types)
- [TypeScript DOM declarations (`@types/web`)](https://github.com/microsoft/TypeScript-DOM-lib-generator)
- [TypeScript 7.0 and the TypeScript 6 transition](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
- [Vite build targets](https://vite.dev/config/build-options.html#build-target)
- [Browserslist Baseline queries](https://github.com/browserslist/browserslist#queries)
- [Choosing a Baseline target](https://web.dev/articles/how-to-choose-your-baseline-target)
- [Baseline and polyfills](https://web.dev/articles/baseline-and-polyfills)
- [`Promise.withResolvers` in core-js](https://core-js.io/docs/features/proposals/promise-withresolvers)
