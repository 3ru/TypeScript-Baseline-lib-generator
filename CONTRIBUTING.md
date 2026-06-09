# Contributing

Thanks for your interest in improving this project.

## Getting started

```sh
npm install
npm run validate
```

`npm run validate` runs the type checks, the registry schema check, a regeneration, and the test suite. It should pass before you open a pull request.

Requirements: Node.js per the `engines` field, on macOS, Linux, or WSL. The TypeScript 7 integration gate additionally needs the Go toolchain.

## How the generator works

The pipeline is deterministic: the same pinned inputs always produce the same `generated/current/baseline.d.ts`. Regenerate with:

```sh
npm run generate
```

The checked-in artifacts under `derived/current/` and `generated/current/` are part of the repo. If your change affects the output, commit the regenerated files too, since CI fails if they drift.

## Changing the compat-management registry

`registry/compat-management.json` is the ledger of special compat rows. The generator is fail-closed: when a feature reaches Baseline widely available but has no matching TypeScript lib surface, generation stops and asks for a registry entry rather than emitting something wrong.

Every entry needs a reason, at least one source URL, and a typed upstream action. Validate the registry with:

```sh
npm run validate:registry
```

## Tests

Run the full suite with `npm test`. There are no aliases for individual test files; use `node --test <path>` when you want to run one.

Add or extend tests for behavior you change. Tests should make the output safer for consumers, not just pass.
