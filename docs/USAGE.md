# Usage Guide

Copy-paste setups for common `typescript-baseline-lib` use cases.

Use TypeScript 7 for new projects. The package also supports TypeScript 6 for
frameworks and tools that still require its programmatic API.

## Before you choose a setup

- Set `noLib: true`. TypeScript ignores `lib` when `noLib` is enabled.
- Choose one complete target: the rolling root package or one `year/*` entry.
- Add `allow/*` entries only to the rolling root package and only when the
  runtime loads the matching polyfill.
- Keep `skipLibCheck` disabled. Hiding declaration conflicts weakens the gate.
- This package checks JavaScript built-in declarations. It does not transform
  syntax, install polyfills, or Baseline-filter DOM APIs.

## I want the current Baseline Widely Available target

Install TypeScript and the generated lib:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Use the package as the complete global JavaScript lib:

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

```sh
npx tsc -p tsconfig.json
```

The root entry represents the current rolling snapshot shipped by each package
release. Use a year target when your compatibility contract must not move.

## I want a browser app with DOM types

Install the independently published DOM declarations:

```sh
npm install --save-dev typescript@^7 typescript-baseline-lib @types/web
```

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

`@types/web` supplies `document`, `Window`, and other browser declarations.
Those DOM declarations are not filtered by this package. The Baseline gate
still applies only to the generated JavaScript built-ins.

## I want a CI gate without replacing my build config

Keep the project's normal `tsconfig.json` and add `tsconfig.baseline.json`:

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

Add a script:

```json
{
  "scripts": {
    "check:baseline": "tsc -p tsconfig.baseline.json"
  }
}
```

```sh
npm run check:baseline
```

The child config replaces the inherited ambient `types`, and `noLib` disables
any inherited standard `lib`. For browser source, use
`["typescript-baseline-lib", "web"]` and install `@types/web` as shown above.

## I want a shared package that runs in browsers and Node.js

Run the Baseline gate only over the platform-neutral source:

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

Do not add `dom`, `web`, or `node` globals to this shared-code gate. Keep
separate normal build configs for browser-only and Node-only entrypoints.

Directly combining the current `@types/node` package with the Baseline lib is
not a supported universal setup. Node declarations can require standard-library
surfaces such as `Disposable` or `Float16Array` before they enter the selected
Baseline target.

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

Do not combine a `year/*` entry with the root package or an `allow/*` entry.
The package currently publishes completed year targets from 2020 onward.

## I polyfill one API outside the rolling target

Install the runtime polyfill as a production dependency:

```sh
npm install core-js
npm install --save-dev typescript@^7 typescript-baseline-lib
```

Load the polyfill from the application entrypoint:

```ts
import "core-js/proposals/promise-with-resolvers";

const deferred = Promise.withResolvers<void>();
```

Then allow only its audited declaration entry:

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

An `allow/*` entry changes type availability only. It never installs or loads a
runtime polyfill. Public entries are restricted to the repository's permanent
allowlist.

## I want Vite to express the same policy

Current Vite releases use Baseline Widely Available as the production default.
Make the intent explicit when desired:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "baseline-widely-available",
  },
});
```

Use this with the browser TypeScript setup above. Vite transforms syntax but
does not generally polyfill JavaScript APIs. Also note that Vite freezes its
Baseline browser snapshot per major release, while this package's root entry
is refreshed through separate dataset updates and package releases.

## I want Browserslist and TypeScript to share a target

For a rolling target, add `.browserslistrc`:

```text
baseline widely available
```

Use it with `"types": ["typescript-baseline-lib"]`.

For a fixed year:

```text
baseline 2024
```

Use it with `"types": ["typescript-baseline-lib/year/2024"]`.

Browserslist configures compatible build and CSS tools. The TypeScript package
independently checks the JavaScript built-in declaration surface.

## I must stay on TypeScript 6

Install the supported 6.x compiler:

```sh
npm install --save-dev typescript@^6 typescript-baseline-lib
```

Use the same `noLib` and `types` settings from the recipes above. This is useful
while an editor, framework, or lint tool still depends on TypeScript 6's
programmatic API.

## I want ESLint to enforce the same Baseline

Add [`eslint-plugin-baseline-js`](https://github.com/3ru/eslint-plugin-baseline-js)
to cover JavaScript syntax and Web APIs that a TypeScript lib cannot model:

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

Use `available: 2024` with `typescript-baseline-lib/year/2024` when both tools
should enforce the same fixed year.

## I want to inspect what TypeScript loaded

```sh
npx tsc -p tsconfig.baseline.json --explainFiles
```

The output should include `typescript-baseline-lib` and should not include
TypeScript's standard `lib.es*.d.ts` files.

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
