# {{PACKAGE_NAME}}

Generated `baseline` declarations for TypeScript.

This package is produced by the [`TypeScript-Baseline-lib-generator`](https://github.com/3ru/TypeScript-Baseline-lib-generator) repo. It packages TypeScript-declarable JavaScript features that are [Baseline widely available](https://web.dev/baseline) as a single global declaration bundle.

Current snapshot:

- Baseline date: `{{BASELINE_DATE}}`
- TypeScript package: `{{TYPESCRIPT_VERSION}}`
- web-features package: `{{WEB_FEATURES_VERSION}}`
- web-features gitHead: `{{WEB_FEATURES_GIT_HEAD}}`
- Included compat rows: `{{INCLUDED_COMPAT_COUNT}}`
- Selected declaration units: `{{SELECTED_UNIT_COUNT}}`
- Transformed units: `{{TRANSFORMED_UNIT_COUNT}}`

## Usage

Stock TypeScript doesn't treat `"baseline"` as a built-in `lib` yet, so install the package and list it under `compilerOptions.types`:

```sh
npm install --save-dev {{PACKAGE_NAME}}
```

```json
{
  "compilerOptions": {
    "noLib": true,
    "types": ["{{PACKAGE_NAME}}"]
  }
}
```

Now only the supported Baseline widely available JavaScript surfaces type-check; APIs that haven't reached Baseline yet are reported as errors.

## Notes

- The public surface is a single `baseline` lib.
- The current scope is `javascript.builtins.*` plus the `arguments` object.
- The generated declarations are derived from the npm `typescript` package and preserve the upstream Microsoft license notice inside `baseline.d.ts`.
