# Contributing

Thank you for your interest in this project.

## Getting started

Before you open a pull request, run these commands:

```sh
npm install
npm run validate
```

`npm run validate` performs the type analysis and registry schema validation. It also regenerates artifacts and runs the test suite.

The command must pass before you open a pull request.

Use the Node.js version in the `engines` field. The project supports macOS, Linux, and WSL.

If you run the TypeScript 7 integration gate, install the Go toolchain.

## How the generator works

The pipeline is deterministic. The same pinned inputs always produce the same `generated/current/baseline.d.ts` file.

To regenerate the artifacts, run:

```sh
npm run generate
```

Git tracks the artifacts in `derived/current/` and `generated/current/`. If your change modifies the output, commit the regenerated files.

If the tracked artifacts differ from the generated artifacts, CI fails.

## Change the compat-management registry

`registry/compat-management.json` is the ledger for special compat rows. The generator uses a fail-closed policy.

If a Widely available feature has no matching TypeScript lib surface, the generator stops. It does not emit an unsupported declaration.

Each entry must include a reason, a source URL, and a typed upstream action.

Run the registry validation:

```sh
npm run validate:registry
```

## Tests

Run the full test suite:

```sh
npm test
```

To run one test file, use `node --test <path>`. The project does not define aliases for individual test files.

If your change modifies behavior, add or extend a test. Each test must protect consumer output or generator safety.
