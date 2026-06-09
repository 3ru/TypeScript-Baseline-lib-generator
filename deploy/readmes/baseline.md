# {{PACKAGE_NAME}}

Generated `baseline` declarations for TypeScript.

This package is produced by the [`TypeScript-Baseline-lib-generator`](https://github.com/3ru/TypeScript-Baseline-lib-generator) repo. It packages the JavaScript built-ins that are [Baseline widely available](https://web.dev/baseline) (`baselineStatus === "high"`) as a single global declaration bundle.

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
    "skipLibCheck": true,
    "types": ["{{PACKAGE_NAME}}"]
  }
}
```

Now only Baseline widely available built-ins type-check; APIs that haven't reached Baseline yet are reported as errors.

## Notes

- The public surface is a single `baseline` lib.
- The current scope is `javascript.builtins.*` only.
- The generated declarations are derived from the npm `typescript` package and preserve the upstream Microsoft license notice inside `baseline.d.ts`.
