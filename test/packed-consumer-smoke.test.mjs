// @ts-check

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { baselinePackageName } from "../deploy/package-registry.mjs";
import {
    REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION,
    renderNegativeProbeSource,
} from "../lib/negative-probes.mjs";
import {
    cleanupTempDirectories,
    createBaselinePackageTarball,
    createTempDirectory,
    loadActiveNegativeProbesFromRepo,
    readJsonFile,
    repoManifest,
    runNpm,
    runTsc,
    runTscExpectFailure,
    runTscStrada,
    runTscStradaExpectFailure,
    writeJsonFile,
    writeTextFile,
} from "./helpers.mjs";

/** @type {string[]} */
const tempDirectories = [];

test.afterEach(() => {
    cleanupTempDirectories(tempDirectories);
});

test("packed consumer smoke: npm-packed baseline package typechecks through compilerOptions.types", async () => {
    const tempDirectory = createTempDirectory(tempDirectories);
    const consumerDirectory = path.join(tempDirectory, "consumer");
    const tarballPath = process.env.BASELINE_PACKAGE_TARBALL
        ? path.resolve(process.env.BASELINE_PACKAGE_TARBALL)
        : (await createBaselinePackageTarball({ tempDirectories })).tarballPath;

    writeJsonFile(path.join(consumerDirectory, "package.json"), {
        name: "baseline-consumer-fixture",
        private: true,
    });
    writeJsonFile(path.join(consumerDirectory, "tsconfig.json"), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types: [baselinePackageName, `${baselinePackageName}/allow/promise-withresolvers`],
        },
        files: ["consumer-pass.ts"],
    });

    runNpm(["install", "--no-package-lock", "--no-save", tarballPath], { cwd: consumerDirectory });

    const installedPackageDirectory = path.join(consumerDirectory, "node_modules", baselinePackageName);
    const installedPackageJson = readJsonFile(path.join(installedPackageDirectory, "package.json"));
    assert.deepEqual(installedPackageJson.peerDependencies, {
        typescript: ">=6 <8",
    });
    assert.equal(
        readJsonFile(path.join(installedPackageDirectory, "snapshot.json")).baselineDate,
        repoManifest.snapshot.baselineDate,
    );

    writeTextFile(path.join(consumerDirectory, "consumer-pass.ts"), [
        "const reversed = [1, 2, 3].toReversed();",
        "const values = Intl.supportedValuesOf(\"currency\");",
        "const result = Promise.withResolvers<number>();",
        "function* iterate(): IterableIterator<number> { yield 1; }",
        "async function* iterateAsync(): AsyncIterableIterator<number> { yield 1; }",
        "function tag(strings: TemplateStringsArray): string { return strings.raw[0] ?? \"\"; }",
        "reversed.length + values.length;",
        "result.promise;",
        "iterate().next();",
        "iterateAsync()[Symbol.asyncIterator]();",
        "tag`baseline`;",
        REGEXP_LEGACY_STATIC_ABSENCE_ASSERTION,
        "",
    ].join("\n"));

    // Pin that the npm-packed artifact reads under both TypeScript 7 (tsgo)
    // and Strada (the 6.x series).
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.json")], { cwd: consumerDirectory });

    writeTextFile(path.join(consumerDirectory, "year-pass.ts"), [
        "Promise.withResolvers<number>();",
        "Array.fromAsync([1, 2, 3]);",
        "",
    ].join("\n"));
    writeJsonFile(path.join(consumerDirectory, "tsconfig.year.json"), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types: [`${baselinePackageName}/year/2024`],
        },
        files: ["year-pass.ts"],
    });
    runTsc(["-p", path.join(consumerDirectory, "tsconfig.year.json")], { cwd: consumerDirectory });
    runTscStrada(["-p", path.join(consumerDirectory, "tsconfig.year.json")], { cwd: consumerDirectory });

    // Derive the currently excluded probes from the checked-in classification
    // rather than a hard-coded excluded-API list (auto-follows Baseline promotion).
    const negativeProbes = loadActiveNegativeProbesFromRepo();
    writeTextFile(path.join(consumerDirectory, "consumer-fail.ts"), renderNegativeProbeSource(negativeProbes));
    writeJsonFile(path.join(consumerDirectory, "tsconfig.fail.json"), {
        compilerOptions: {
            noLib: true,
            strict: true,
            types: [baselinePackageName],
        },
        files: ["consumer-fail.ts"],
    });

    const failures = [
        runTscExpectFailure(["-p", path.join(consumerDirectory, "tsconfig.fail.json")], { cwd: consumerDirectory }),
        runTscStradaExpectFailure(["-p", path.join(consumerDirectory, "tsconfig.fail.json")], { cwd: consumerDirectory }),
    ];
    for (const failure of failures) {
        assert.equal(failure.ok, false);
        for (const probe of negativeProbes) {
            assert.match(failure.output, probe.errorPattern, `expected excluded probe ${probe.compatKey} to fail compilation`);
        }
    }
});
